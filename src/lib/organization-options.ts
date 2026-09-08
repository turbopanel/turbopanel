/**
 * Defensive parsers for `organization.options` jsonb fields used by the
 * client timezone, host-defaults, server-capacity, and default-environment APIs.
 */

import {
  isValidDisplayName,
  normalizeDisplayName,
} from "./display-name-format.ts";
import {
  type NtpDefaults,
  parseNtpDefaults,
  parseSshPort,
} from "./host-defaults.ts";
import {
  type ManagedOrganizationDefaults,
  parseManagedOrganizationDefaults,
} from "./managed/org-defaults.ts";
import {
  type MetricsCapabilityPlanOverride,
  parseMetricsCapabilityPlanOverride,
} from "../daemon/metrics/capability-plan.ts";

/** Platform fallback when `defaultEnvironmentName` is unset. */
export const DEFAULT_ENVIRONMENT_NAME = "Production";

/** Display unit for temperature metrics (chart axes, tooltips, thresholds). */
export type TemperatureUnit = "celsius" | "fahrenheit";

const TEMPERATURE_UNITS = new Set<TemperatureUnit>(["celsius", "fahrenheit"]);

/** Platform fallback when `temperatureUnit` is unset. */
export const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = "celsius";

export type OrganizationOptions = {
  /** Org-wide default timezone applied when a server has no override. */
  defaultServerTimezone?: string;
  /**
   * When true, the org default wins over any per-server `options.timezone`
   * override.
   */
  enforceServerTimezone?: boolean;
  /**
   * Cap on enrolled servers + unconsumed registration keys for this org.
   * Omitted or `null` = unlimited (self-hosted default). Workers/Stripe billing
   * will set a concrete cap later; self-hosted operators may set one on the
   * control plane.
   */
  maxServers?: number | null;
  /**
   * Org-wide name used for the environment scaffolded with every new project.
   * Platform fallback is {@link DEFAULT_ENVIRONMENT_NAME} (`Production`).
   */
  defaultEnvironmentName?: string;
  /**
   * Desired SSH listen port for fleet hosts that do not set a datacenter or
   * server override. Omitted → inherit platform default 22.
   */
  sshPort?: number;
  /** Desired NTP client settings inherited by datacenters and servers. */
  ntp?: NtpDefaults;
  /**
   * Preferred TurboFabric state for this organization. Does not create or tear
   * down the mesh — `PUT /organizations/:id/fabric` remains the enable path.
   */
  defaultFabricEnabled?: boolean;
  /**
   * Org-wide managed-database defaults inherited by services that set no
   * override. See `managed/org-defaults.ts`.
   */
  managedDatabase?: ManagedOrganizationDefaults;
  /**
   * When on (the default — preferred for security), every newly created
   * principal's applied login (Linux account / database role) is the short
   * `username` plus a random `_<11 chars>` suffix. Off = applied login equals
   * the short name. Decided per principal at create; toggling never renames
   * existing principals. Managed root logins are always suffixed regardless.
   */
  randomizedPrincipalUsernames?: boolean;
  /**
   * Display unit for temperature metrics (chart axes, tooltips, thresholds).
   * Platform fallback is {@link DEFAULT_TEMPERATURE_UNIT} (`celsius`).
   */
  temperatureUnit?: TemperatureUnit;
  /**
   * Org-wide default overrides for the v5 metrics capability plan (see
   * `../daemon/metrics/capability-plan.ts`). Layered under any per-server
   * `server.options.metricsCapabilityPlan` override by
   * `resolveEffectiveMetricsCapabilityPlan` (`db/server-metadata.ts`), on
   * top of a license-tier base when one is bound.
   */
  metricsCapabilityPlan?: MetricsCapabilityPlanOverride;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when no finite server seat cap is configured. */
export function isUnlimitedMaxServers(
  maxServers: number | null | undefined,
): boolean {
  return maxServers === null || maxServers === undefined;
}

/**
 * Parse a maxServers value from JSON. Returns `{ ok: true, value }` where
 * `value` is a non-negative integer, or `null` for unlimited. Invalid input
 * returns `{ ok: false }`.
 */
export function parseMaxServersInput(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Parse a defaultEnvironmentName PUT body value.
 * `null` → `{ ok: true, value: null }` (reset to platform default). Empty /
 * whitespace-only strings, non-strings, names longer than the display-name
 * cap, or names with control characters → `{ ok: false }`.
 */
export function parseDefaultEnvironmentNameInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const normalized = normalizeDisplayName(value);
  if (!isValidDisplayName(normalized)) {
    return { ok: false };
  }
  return { ok: true, value: normalized };
}

/** Resolved scaffold name: option when set, else platform fallback. */
export function resolveDefaultEnvironmentName(
  options: OrganizationOptions,
): string {
  return options.defaultEnvironmentName ?? DEFAULT_ENVIRONMENT_NAME;
}

function assignTrimmedOption(
  options: OrganizationOptions,
  key: "defaultServerTimezone" | "defaultEnvironmentName",
  value: unknown,
): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length > 0) options[key] = trimmed;
}

function assignMaxServers(
  options: OrganizationOptions,
  value: Record<string, unknown>,
): void {
  if (!("maxServers" in value)) return;
  const parsed = parseMaxServersInput(value.maxServers);
  if (parsed.ok) options.maxServers = parsed.value;
}

function assignManagedDatabase(
  options: OrganizationOptions,
  value: Record<string, unknown>,
): void {
  if (!("managedDatabase" in value)) return;
  const managedDatabase = parseManagedOrganizationDefaults(
    value.managedDatabase,
  );
  if (Object.keys(managedDatabase).length > 0) {
    options.managedDatabase = managedDatabase;
  }
}

function assignMetricsCapabilityPlan(
  options: OrganizationOptions,
  value: Record<string, unknown>,
): void {
  if (!("metricsCapabilityPlan" in value)) return;
  const metricsCapabilityPlan = parseMetricsCapabilityPlanOverride(
    value.metricsCapabilityPlan,
  );
  if (Object.keys(metricsCapabilityPlan).length > 0) {
    options.metricsCapabilityPlan = metricsCapabilityPlan;
  }
}

/** Parse organization.options jsonb (missing/invalid keys → omitted). */
export function parseOrganizationOptions(value: unknown): OrganizationOptions {
  if (!isRecord(value)) return {};
  const options: OrganizationOptions = {};
  assignTrimmedOption(
    options,
    "defaultServerTimezone",
    value.defaultServerTimezone,
  );
  if (typeof value.enforceServerTimezone === "boolean") {
    options.enforceServerTimezone = value.enforceServerTimezone;
  }
  assignMaxServers(options, value);
  assignTrimmedOption(
    options,
    "defaultEnvironmentName",
    value.defaultEnvironmentName,
  );
  const sshPort = parseSshPort(value.sshPort);
  if (sshPort !== undefined) options.sshPort = sshPort;
  const ntp = parseNtpDefaults(value.ntp);
  if (ntp) options.ntp = ntp;
  if (typeof value.defaultFabricEnabled === "boolean") {
    options.defaultFabricEnabled = value.defaultFabricEnabled;
  }
  assignManagedDatabase(options, value);
  if (typeof value.randomizedPrincipalUsernames === "boolean") {
    options.randomizedPrincipalUsernames = value.randomizedPrincipalUsernames;
  }
  if (
    typeof value.temperatureUnit === "string" &&
    TEMPERATURE_UNITS.has(value.temperatureUnit as TemperatureUnit)
  ) {
    options.temperatureUnit = value.temperatureUnit as TemperatureUnit;
  }
  assignMetricsCapabilityPlan(options, value);
  return options;
}

/** Effective randomized-usernames default: on unless the org opted out. */
export function resolveRandomizedPrincipalUsernames(
  options: OrganizationOptions,
): boolean {
  return options.randomizedPrincipalUsernames ?? true;
}

/** Resolved display unit: option when set, else platform fallback (celsius). */
export function resolveTemperatureUnit(
  options: OrganizationOptions,
): TemperatureUnit {
  return options.temperatureUnit ?? DEFAULT_TEMPERATURE_UNIT;
}

/**
 * Parse a temperatureUnit PUT body value.
 * Anything other than `"celsius"` or `"fahrenheit"` → `{ ok: false }` (there
 * is no reset-to-default sentinel — the platform fallback already applies
 * whenever the option is unset).
 */
export function parseTemperatureUnitInput(
  value: unknown,
): { ok: true; value: TemperatureUnit } | { ok: false } {
  if (
    typeof value === "string" && TEMPERATURE_UNITS.has(value as TemperatureUnit)
  ) {
    return { ok: true, value: value as TemperatureUnit };
  }
  return { ok: false };
}
