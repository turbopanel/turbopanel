import {
  parseDefaultEnvironmentNameInput,
  parseMaxServersInput,
  parseTemperatureUnitInput,
  type TemperatureUnit,
} from "../../lib/organization-options.ts";
import { DISPLAY_NAME_MAX_LENGTH } from "../../lib/display-name-format.ts";
import { isAllowedTimezone } from "../../lib/timezones.ts";
import type { OrganizationSummary } from "../org-context.ts";
import { BadRequestError, parseName } from "../shared.ts";
import {
  type NtpDefaults,
  parseDefaultFabricEnabledInput,
  parseNtpDefaultsInput,
  parseSshPortInput,
} from "../../lib/host-defaults.ts";
import {
  type ManagedIngressPortsPatch,
  type ManagedOrganizationDefaults,
  parseManagedIngressPortsInput,
  parseManagedSslModeInput,
  validateManagedOrganizationDefaults,
} from "../../lib/managed/org-defaults.ts";
import {
  type ManagedIngressPortRejection,
  resolveManagedIngressPorts,
} from "../../lib/managed/ingress-ports.ts";
import {
  type ManagedSslMode,
  resolveManagedSslMode,
} from "../../lib/managed/ssl.ts";
import {
  type DockerAddressingRejection,
  DOCKER_ADDRESS_POOLS_MAX,
  isValidDefaultBridgeCidr,
  type OrganizationDockerNetworking,
  validateDockerAddressPools,
} from "../../lib/docker-address-pools.ts";

/** Matches {@link NEW_ORGANIZATION_NAME} in authn/install-state.ts. */
const NEW_ORGANIZATION_DISPLAY_NAME = "New Organization";

export type OrganizationRouteValidationError = {
  ok: false;
  error: string;
  status: 400;
};

export type DefaultTimezonePatch = {
  defaultServerTimezone?: string | null;
  enforceServerTimezone?: boolean;
};

export type TemperatureUnitPatch = {
  temperatureUnit: TemperatureUnit;
};

export type HostDefaultsPatch = {
  sshPort?: number | null;
  ntp?: NtpDefaults | null;
  defaultFabricEnabled?: boolean | null;
};

/** `null` clears a key so inheriting services fall back to the platform value. */
export type ManagedDefaultsPatch = {
  sslMode?: ManagedSslMode | null;
  ports?: ManagedIngressPortsPatch | null;
};

const PORT_REJECTION_MESSAGE: Record<ManagedIngressPortRejection, string> = {
  out_of_range: "must be an integer between 1024 and 65535",
  reserved_admin: "is reserved for the ProxySQL admin interface",
  reserved_private_range:
    "is reserved for managed member private listeners (45000-45999)",
  collision: "must differ from the other protocol family's listener port",
};

export function parseManagedDefaultsPatch(
  body: Record<string, unknown>,
):
  | { ok: true; patch: ManagedDefaultsPatch }
  | OrganizationRouteValidationError {
  const patch: ManagedDefaultsPatch = {};

  if ("sslMode" in body) {
    const parsed = parseManagedSslModeInput(body.sslMode);
    if (!parsed.ok) {
      return { ok: false, error: "Invalid sslMode", status: 400 };
    }
    patch.sslMode = parsed.value;
  }

  if ("ports" in body) {
    const parsed = parseManagedIngressPortsInput(body.ports);
    if (!parsed.ok) {
      const detail = parsed.field && parsed.reason
        ? `ports.${parsed.field} ${PORT_REJECTION_MESSAGE[parsed.reason]}`
        : "Invalid ports";
      return { ok: false, error: detail, status: 400 };
    }
    patch.ports = parsed.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  return { ok: true, patch };
}

/**
 * Merge a patch into the stored defaults **in application code**: the jsonb
 * `||` operator is a shallow merge, so writing `{ managedDatabase: patch }`
 * would drop sibling keys an operator did not touch.
 */
export function applyManagedDefaultsPatch(
  current: ManagedOrganizationDefaults,
  patch: ManagedDefaultsPatch,
): ManagedOrganizationDefaults {
  const next: ManagedOrganizationDefaults = { ...current };
  if ("sslMode" in patch) {
    if (patch.sslMode === null || patch.sslMode === undefined) {
      delete next.sslMode;
    } else {
      next.sslMode = patch.sslMode;
    }
  }
  if ("ports" in patch) {
    const merged = mergeIngressPortsPatch(current.ports, patch.ports);
    if (merged) next.ports = merged;
    else delete next.ports;
  }
  return next;
}

/** Per-family merge; a family set to `null` (or the whole object) is cleared. */
function mergeIngressPortsPatch(
  current: ManagedOrganizationDefaults["ports"],
  patch: ManagedIngressPortsPatch | null | undefined,
): ManagedOrganizationDefaults["ports"] {
  if (patch === null || patch === undefined) return undefined;
  const next = { ...current };
  for (const field of ["postgres", "mysqlFamily"] as const) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null) delete next[field];
    else next[field] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Reject a merged defaults object the individual field parsers cannot judge —
 * today only a listener-port collision between the two protocol families.
 */
export function validateManagedDefaults(
  defaults: ManagedOrganizationDefaults,
): OrganizationRouteValidationError | null {
  const check = validateManagedOrganizationDefaults(defaults);
  if (check.ok) return null;
  return {
    ok: false,
    error: `${check.field} ${PORT_REJECTION_MESSAGE[check.reason]}`,
    status: 400,
  };
}

export function managedDefaultsGetResponse(
  defaults: ManagedOrganizationDefaults,
) {
  return {
    /** Configured org default; `null` = inheriting the platform value. */
    sslMode: defaults.sslMode ?? null,
    /** What an inheriting managed service resolves to today. */
    effectiveSslMode: resolveManagedSslMode(undefined, defaults.sslMode),
    /** Configured overrides only; `null` per family = inheriting. */
    ports: {
      postgres: defaults.ports?.postgres ?? null,
      mysqlFamily: defaults.ports?.mysqlFamily ?? null,
    },
    /** Ports clients actually dial today, after platform fallback. */
    effectivePorts: resolveManagedIngressPorts(defaults.ports),
  };
}

export function managedDefaultsPutResponse(
  defaults: ManagedOrganizationDefaults,
) {
  return {
    ok: true as const,
    ...managedDefaultsGetResponse(defaults),
  };
}

const DOCKER_ADDRESSING_MESSAGE: Record<DockerAddressingRejection, string> = {
  address_pools_invalid: "Invalid addressPools",
  address_pools_too_many:
    `addressPools may hold at most ${DOCKER_ADDRESS_POOLS_MAX} entries`,
  address_pool_base_invalid: "Invalid addressPools base",
  address_pool_size_invalid:
    "Invalid addressPools size (integer between the base prefix and /30)",
  address_pools_overlap: "addressPools entries overlap each other",
  default_bridge_cidr_invalid:
    "Invalid defaultBridgeCidr (host address with prefix, e.g. 172.17.0.1/16)",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a `PUT /organizations/:id/docker-networking` body. The whole `docker`
 * object is replaced — `addressPools` is a list, so replace-all is the only
 * sane semantics. `null` on a key (or an empty list) clears it; when nothing
 * is left the stored key is removed (`value: null`). Invalid input is
 * rejected, never dropped: a silently ignored pool would report success while
 * dockerd keeps its built-in ranges.
 */
export function parseDockerNetworkingPatch(
  body: unknown,
):
  | { ok: true; value: OrganizationDockerNetworking | null }
  | OrganizationRouteValidationError {
  if (!isRecord(body)) return { ok: false, error: "Invalid request", status: 400 };
  if (!("addressPools" in body) && !("defaultBridgeCidr" in body)) {
    return { ok: false, error: "Invalid request", status: 400 };
  }
  const value: OrganizationDockerNetworking = {};
  const pools = parseDockerAddressPoolsField(body.addressPools);
  if (!pools.ok) return pools;
  if (pools.value) value.addressPools = pools.value;
  const bridge = parseDefaultBridgeCidrField(body.defaultBridgeCidr);
  if (!bridge.ok) return bridge;
  if (bridge.value) value.defaultBridgeCidr = bridge.value;
  return { ok: true, value: Object.keys(value).length > 0 ? value : null };
}

/** `addressPools` field: absent/`null`/empty list → `null` (cleared). */
function parseDockerAddressPoolsField(
  raw: unknown,
):
  | { ok: true; value: OrganizationDockerNetworking["addressPools"] | null }
  | OrganizationRouteValidationError {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const pools = validateDockerAddressPools(raw);
  if (!pools.ok) {
    const suffix = pools.index === undefined ? "" : ` (entry ${pools.index})`;
    return {
      ok: false,
      error: `${DOCKER_ADDRESSING_MESSAGE[pools.reason]}${suffix}`,
      status: 400,
    };
  }
  return { ok: true, value: pools.pools.length > 0 ? pools.pools : null };
}

/** `defaultBridgeCidr` field: absent/`null` → `null` (cleared). */
function parseDefaultBridgeCidrField(
  raw: unknown,
): { ok: true; value: string | null } | OrganizationRouteValidationError {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!isValidDefaultBridgeCidr(raw)) {
    return {
      ok: false,
      error: DOCKER_ADDRESSING_MESSAGE.default_bridge_cidr_invalid,
      status: 400,
    };
  }
  return { ok: true, value: raw.trim() };
}

export function dockerNetworkingGetResponse(
  docker: OrganizationDockerNetworking,
) {
  return {
    /** Configured dockerd `default-address-pools`; empty = Docker built-ins. */
    addressPools: (docker.addressPools ?? []).map((pool) => ({ ...pool })),
    /** Configured dockerd `bip`; `null` = Docker's built-in bridge. */
    defaultBridgeCidr: docker.defaultBridgeCidr ?? null,
  };
}

export function dockerNetworkingPutResponse(
  docker: OrganizationDockerNetworking,
) {
  return {
    ok: true as const,
    ...dockerNetworkingGetResponse(docker),
  };
}

export function parseDefaultTimezonePatch(
  body: Record<string, unknown>,
):
  | { ok: true; patch: DefaultTimezonePatch }
  | OrganizationRouteValidationError {
  const patch: DefaultTimezonePatch = {};

  if ("defaultServerTimezone" in body) {
    if (body.defaultServerTimezone === null) {
      patch.defaultServerTimezone = null;
    } else if (
      typeof body.defaultServerTimezone === "string" &&
      isAllowedTimezone(body.defaultServerTimezone)
    ) {
      patch.defaultServerTimezone = body.defaultServerTimezone;
    } else {
      return { ok: false, error: "Invalid defaultServerTimezone", status: 400 };
    }
  }

  if ("enforceServerTimezone" in body) {
    if (typeof body.enforceServerTimezone !== "boolean") {
      return { ok: false, error: "Invalid enforceServerTimezone", status: 400 };
    }
    patch.enforceServerTimezone = body.enforceServerTimezone;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  return { ok: true, patch };
}

/** `temperatureUnit` is required — unlike timezone, there is no clear-to-null case. */
export function parseTemperatureUnitPatch(
  body: Record<string, unknown>,
):
  | { ok: true; patch: TemperatureUnitPatch }
  | OrganizationRouteValidationError {
  if (!("temperatureUnit" in body)) {
    return { ok: false, error: "Invalid request", status: 400 };
  }
  const parsed = parseTemperatureUnitInput(body.temperatureUnit);
  if (!parsed.ok) {
    return { ok: false, error: "Invalid temperatureUnit", status: 400 };
  }
  return { ok: true, patch: { temperatureUnit: parsed.value } };
}

export function parseHostDefaultsPatch(
  body: Record<string, unknown>,
):
  | { ok: true; patch: HostDefaultsPatch }
  | OrganizationRouteValidationError {
  const patch: HostDefaultsPatch = {};

  if ("sshPort" in body) {
    const parsed = parseSshPortInput(body.sshPort);
    if (!parsed.ok) {
      return { ok: false, error: "Invalid sshPort", status: 400 };
    }
    patch.sshPort = parsed.value;
  }

  if ("ntp" in body) {
    const parsed = parseNtpDefaultsInput(body.ntp);
    if (!parsed.ok) {
      return { ok: false, error: "Invalid ntp", status: 400 };
    }
    patch.ntp = parsed.value;
  }

  if ("defaultFabricEnabled" in body) {
    const parsed = parseDefaultFabricEnabledInput(body.defaultFabricEnabled);
    if (!parsed.ok) {
      return { ok: false, error: "Invalid defaultFabricEnabled", status: 400 };
    }
    patch.defaultFabricEnabled = parsed.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  return { ok: true, patch };
}

export function parseDefaultEnvironmentPutBody(
  body: Record<string, unknown>,
):
  | { ok: true; defaultEnvironmentName: string | null }
  | OrganizationRouteValidationError {
  if (!("defaultEnvironmentName" in body)) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  const parsed = parseDefaultEnvironmentNameInput(body.defaultEnvironmentName);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        `defaultEnvironmentName must be null or a non-empty name of at most ${
          String(DISPLAY_NAME_MAX_LENGTH)
        } characters with no control characters`,
      status: 400,
    };
  }

  return { ok: true, defaultEnvironmentName: parsed.value };
}

export function parseServerCapacityPutBody(
  body: Record<string, unknown>,
):
  | { ok: true; maxServers: number | null }
  | OrganizationRouteValidationError {
  if (!("maxServers" in body)) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  const parsed = parseMaxServersInput(body.maxServers);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "maxServers must be a non-negative integer or null",
      status: 400,
    };
  }

  return { ok: true, maxServers: parsed.value };
}

export function parseOrganizationCreateDisplayName(
  body: Record<string, unknown>,
): { ok: true; name: string } | OrganizationRouteValidationError {
  try {
    const hasName = body.name !== undefined;
    if (!hasName) {
      return { ok: true, name: NEW_ORGANIZATION_DISPLAY_NAME };
    }
    const parsed = parseName(body);
    return { ok: true, name: parsed ?? NEW_ORGANIZATION_DISPLAY_NAME };
  } catch (error) {
    if (error instanceof BadRequestError) {
      return { ok: false, error: "Invalid request", status: 400 };
    }
    throw error;
  }
}

/** PATCH requires a non-empty name; it cannot be cleared. */
export function parseOrganizationPatchDisplayName(
  body: Record<string, unknown>,
): { ok: true; name: string } | OrganizationRouteValidationError {
  if (!("name" in body)) {
    return { ok: false, error: "Invalid request", status: 400 };
  }
  try {
    const parsed = parseName(body);
    if (parsed === null) {
      return { ok: false, error: "Invalid request", status: 400 };
    }
    return { ok: true, name: parsed };
  } catch (error) {
    if (error instanceof BadRequestError) {
      return { ok: false, error: "Invalid request", status: 400 };
    }
    throw error;
  }
}

export function toOrganizationRecord(row: {
  id: string;
  name: string | null;
  createdAt: string;
}): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
  };
}

export function defaultTimezoneGetResponse(options: {
  defaultServerTimezone?: string | null;
  enforceServerTimezone?: boolean | null;
}) {
  return {
    defaultServerTimezone: options.defaultServerTimezone ?? null,
    enforceServerTimezone: options.enforceServerTimezone ?? false,
  };
}

export function defaultEnvironmentGetResponse(options: {
  defaultEnvironmentName?: string | null;
}) {
  return {
    defaultEnvironmentName: options.defaultEnvironmentName ?? null,
  };
}

export function defaultTimezonePutResponse(options: {
  defaultServerTimezone?: string | null;
  enforceServerTimezone?: boolean | null;
}) {
  return {
    ok: true as const,
    ...defaultTimezoneGetResponse(options),
  };
}

export function temperatureUnitGetResponse(options: {
  temperatureUnit?: TemperatureUnit | null;
}) {
  return {
    temperatureUnit: options.temperatureUnit ?? "celsius",
  };
}

export function temperatureUnitPutResponse(options: {
  temperatureUnit?: TemperatureUnit | null;
}) {
  return {
    ok: true as const,
    ...temperatureUnitGetResponse(options),
  };
}

export function hostDefaultsGetResponse(options: {
  sshPort?: number;
  ntp?: NtpDefaults;
  defaultFabricEnabled?: boolean;
}) {
  return {
    sshPort: options.sshPort ?? null,
    ntp: options.ntp ?? null,
    defaultFabricEnabled: options.defaultFabricEnabled ?? false,
  };
}

export function hostDefaultsPutResponse(options: {
  sshPort?: number;
  ntp?: NtpDefaults;
  defaultFabricEnabled?: boolean;
}) {
  return {
    ok: true as const,
    ...hostDefaultsGetResponse(options),
  };
}

export function defaultEnvironmentPutResponse(options: {
  defaultEnvironmentName?: string | null;
}) {
  return {
    ok: true as const,
    ...defaultEnvironmentGetResponse(options),
  };
}
