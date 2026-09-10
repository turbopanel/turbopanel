import type { ServerReportedIp } from "../../server-addresses.ts";
import type {
  ServerDockerMetadata,
  ServerHardwareProfile,
  ServerHostResources,
  ServerOsMetadata,
  ServerTimeSync,
} from "../../lib/db/server-metadata.ts";
import type { MetricsCapabilityPlan } from "../metrics/capability-plan.ts";
import {
  isValidWireguardEndpoint,
  isValidWireguardPublicKey,
} from "../../lib/fabric/wg.ts";

export type DaemonBuildInfo = {
  commit: string;
  buildId: string;
  builtAt?: string;
  channel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseDaemonBuildInfo(
  value: unknown,
): DaemonBuildInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (!isString(value.commit) || value.commit.length === 0) return undefined;
  if (!isString(value.buildId) || value.buildId.length === 0) return undefined;
  const daemonBuild: DaemonBuildInfo = {
    commit: value.commit,
    buildId: value.buildId,
  };
  if (isString(value.builtAt)) daemonBuild.builtAt = value.builtAt;
  if (isString(value.channel)) daemonBuild.channel = value.channel;
  return daemonBuild;
}

export type FabricPathPeerHealth = "healthy" | "stale" | "never";

export type FabricPathWireCandidate = {
  publicKey: string;
  endpoints: string[];
};

export type FabricPathWireObservation = {
  publicKey: string;
  endpoint?: string;
  lastHandshakeAt?: string;
  health: FabricPathPeerHealth;
  latencyMs?: number;
};

/**
 * Hardware profile (sensor/NIC slots, topology device/filesystem ids,
 * hosting path, drivetemp opt-in, generation) pushed to the daemon. Full
 * replacement semantics: an absent field clears that setting on the daemon,
 * so the persisted `server.metadata.hardwareProfile` copy stays the source
 * of truth. Carries `generation` so the daemon can stamp subsequent samples
 * with `hardwareProfileGeneration`.
 */
export type TopologyOverridesUpdatePayload = ServerHardwareProfile;

/**
 * Capability plan pushed to the daemon so it can truncate the metrics sample
 * before POST. Full replacement of the persisted plan+generation pair.
 */
export type CapabilityPlanUpdatePayload = MetricsCapabilityPlan;

/** JSON messages exchanged between the instance and daemon over /ws. */
export type DaemonMessage =
  | {
    type: "hello";
    at: string;
    daemonBuild: DaemonBuildInfo;
    hostname?: string;
    machineKey?: string;
    /** Host OS from `/etc/os-release` (+ Deno build); persisted to `server.os_*` columns. */
    os?: ServerOsMetadata;
    /**
     * Host capacity (cpu / RAM / swap totals) plus `ips` from `/proc` /
     * `Deno.networkInterfaces`; persisted to `server.metadata.resources`.
     */
    resources?: ServerHostResources;
    /** Host timezone + NTP state; persisted to timezone / NTP columns. */
    timeSync?: ServerTimeSync;
    /**
     * Docker CLI / Compose plugin versions; persisted to `server.metadata.docker`.
     * Omit when Docker is not installed.
     */
    docker?: ServerDockerMetadata;
  }
  | {
    type: "heartbeat";
    at: string;
    daemonBuild?: DaemonBuildInfo;
    /** Change-detected time-sync facts; persisted to timezone / NTP columns. */
    timeSync?: ServerTimeSync;
    /**
     * Change-detected host resources (typically `{ ips }`); persisted to
     * `server.metadata.resources`.
     */
    resources?: ServerHostResources;
    /**
     * Change-detected Docker facts; persisted to `server.metadata.docker`.
     * Omit when Docker is not installed.
     */
    docker?: ServerDockerMetadata;
  }
  | { type: "echo"; payload: unknown; at: string }
  | { type: "version"; commit: string; branch: string; at: string }
  | { type: "addresses-request"; id: string; at: string }
  | {
    type: "addresses-result";
    id: string;
    ips: ServerReportedIp[];
    at: string;
  }
  | {
    type: "managed-logs-request";
    id: string;
    managedId: string;
    tail: number;
    at: string;
  }
  | {
    type: "managed-logs-result";
    id: string;
    logs: string;
    error?: string;
    at: string;
  }
  | {
    type: "container-logs-request";
    id: string;
    containerId: string;
    tail: number;
    at: string;
  }
  | {
    type: "container-logs-result";
    id: string;
    logs: string;
    error?: string;
    at: string;
  }
  | {
    type: "repo-read-request";
    id: string;
    cloneUrl: string;
    ref: string;
    paths: string[];
    listPath?: string;
    maxBytesPerFile: number;
    credential?: string;
    credentialKind?: string;
    credentialUsername?: string;
    at: string;
  }
  | {
    type: "repo-read-result";
    id: string;
    ok: boolean;
    commitSha?: string;
    files?: {
      path: string;
      found: boolean;
      content?: string;
      bytes?: number;
      reason?: string;
    }[];
    entries?: { path: string; kind: string; bytes?: number }[];
    error?: string;
    at: string;
  }
  | {
    type: "repo-default-branch-request";
    id: string;
    /** Anonymous only — the control plane never sends a credential here. */
    cloneUrl: string;
    at: string;
  }
  | {
    type: "repo-default-branch-result";
    id: string;
    ok: boolean;
    /** `null` when the remote answered but named no branch (an empty repo). */
    defaultBranch?: string | null;
    error?: string;
    at: string;
  }
  | {
    type: "metrics-live-start";
    id: string;
    leaseId: string;
    intervalSeconds: number;
    expiresAt: string;
    at: string;
  }
  | {
    type: "metrics-live-start-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "metrics-live-stop"; id: string; leaseId: string; at: string }
  | {
    type: "metrics-live-stop-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "topology-overrides-update";
    id: string;
    overrides: TopologyOverridesUpdatePayload;
    at: string;
  }
  | {
    type: "topology-overrides-update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "capability-plan-update";
    id: string;
    plan: CapabilityPlanUpdatePayload;
    generation: number;
    at: string;
  }
  | {
    type: "capability-plan-update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "capability-plan-clear";
    id: string;
    at: string;
  }
  | {
    type: "capability-plan-clear-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "managed-ha-event";
    managedId: string;
    sourceMemberId?: string;
    at: string;
  }
  | {
    /**
     * Daemon-initiated, fire-and-forget (no correlated request/result, same
     * shape as `managed-ha-event`): the daemon's `topology/` module reporting
     * a new topology generation (stable device/filesystem/GPU/signal
     * identity). Server identity comes from the authenticated connection, not
     * a wire field — see `managed-ha-event`'s precedent.
     */
    type: "topology-report";
    generation: number;
    bootGeneration: number;
    snapshot: unknown;
    at: string;
  }
  | {
    type: "fabric-paths-request";
    id: string;
    fabricId: string;
    probeMs: number;
    candidates: FabricPathWireCandidate[];
    at: string;
  }
  | {
    type: "fabric-paths-result";
    id: string;
    paths: FabricPathWireObservation[];
    error?: string;
    at: string;
  }
  | {
    type: "dev-sync-begin";
    id: string;
    totalChunks: number;
    totalBytes: number;
    at: string;
  }
  | {
    type: "dev-sync-chunk";
    id: string;
    index: number;
    data: string;
    at: string;
  }
  | { type: "dev-sync-end"; id: string; at: string }
  | {
    type: "dev-sync-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "tunnel-token"; id: string; token: string; at: string }
  | {
    type: "tunnel-token-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "public-urls-update"; id: string; urls: string[]; at: string }
  | {
    type: "public-urls-update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "update";
    id: string;
    channel?: string;
    updateUrl?: string;
    updateSha256?: string;
    at: string;
  }
  | {
    type: "update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "command-dispatch";
    id: string;
    commandId: string;
    commandType: string;
    payload: unknown;
    at: string;
  }
  | {
    type: "command-ack";
    id: string;
    at: string;
    daemonReceivedAt: string;
  }
  | {
    type: "command-outcome";
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    at: string;
    daemonReceivedAt?: string;
    daemonRespondedAt?: string;
  };

/** Read-time stale window when no inbound traffic is recorded on the cell. */
export const DAEMON_STALE_MS = 60_000;
/** Background sweep threshold for marking connected cells offline (DO alarm + Redis maintain). */
export const DAEMON_OFFLINE_SWEEP_MS = 150_000;
/** Redis cell registry maintenance interval (prune); not used for liveness. */
export const DAEMON_CELL_MAINTAIN_MS = 60_000;

/** Message types accepted from daemons after authentication succeeds. */
export const DAEMON_INBOUND_ALLOWED = new Set(
  [
    "hello",
    "heartbeat",
    "addresses-result",
    "managed-logs-result",
    "container-logs-result",
    "metrics-live-start-result",
    "metrics-live-stop-result",
    "topology-overrides-update-result",
    "capability-plan-update-result",
    "capability-plan-clear-result",
    "repo-read-result",
    "repo-default-branch-result",
    "managed-ha-event",
    "topology-report",
    "fabric-paths-result",
    "dev-sync-result",
    "tunnel-token-result",
    "public-urls-update-result",
    "update-result",
    "command-ack",
    "command-outcome",
  ] as const,
);

/** Hard cap on a single inbound WebSocket text/binary frame (UTF-8 bytes). */
export const MAX_DAEMON_WS_FRAME_BYTES = 256 * 1024;

/** Max characters for correlation / delivery identifiers (`id`, `requestId`). */
export const MAX_DAEMON_WS_ID_CHARS = 128;

/** Max characters for daemon-reported error strings. */
export const MAX_DAEMON_WS_ERROR_CHARS = 4 * 1024;

/** Max characters for `managed-logs-result` / `container-logs-result.logs`. */
export const MAX_DAEMON_WS_LOGS_CHARS = 200 * 1024;

/**
 * Max UTF-8 bytes across every file in one `repo-read-result`.
 *
 * Comfortably under {@link MAX_DAEMON_WS_FRAME_BYTES} so a legitimate read
 * cannot be mistaken for a framing violation, and small enough that a
 * misbehaving daemon cannot push a repository through this channel.
 */
export const MAX_DAEMON_WS_REPO_READ_BYTES = 128 * 1024;

/** Max directory entries in one `repo-read-result`. */
export const MAX_DAEMON_WS_REPO_READ_ENTRIES = 256;

/** Max characters for `repo-default-branch-result.defaultBranch`. */
export const MAX_DAEMON_WS_DEFAULT_BRANCH_CHARS = 255;

/** Max paths one `repo-read-request` may ask for. */
export const MAX_DAEMON_WS_REPO_READ_PATHS = 16;

/** Max `fabric-paths-request.candidates` / `fabric-paths-result.paths` entries. */
export const MAX_DAEMON_WS_FABRIC_PATH_ENTRIES = 256;

/** Max candidate endpoints per `fabric-paths-request` entry. */
export const MAX_DAEMON_WS_FABRIC_PATH_CANDIDATES = 8;

const FABRIC_PEER_HEALTH = new Set(["healthy", "stale", "never"]);

/** Max UTF-8 bytes for JSON-serialized `command-outcome.result`. */
export const MAX_DAEMON_WS_RESULT_JSON_BYTES = 64 * 1024;

/** Max UTF-8 bytes for JSON-serialized `topology-report.snapshot`. */
export const MAX_DAEMON_WS_TOPOLOGY_REPORT_JSON_BYTES = 64 * 1024;

/** Max characters for optional hostname / machineKey fields on hello. */
export const MAX_DAEMON_WS_HOST_FIELD_CHARS = 255;

/** WebSocket close code for policy / size violations (RFC 6455). */
export const DAEMON_WS_POLICY_VIOLATION_CLOSE = 1008;

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    ISO_TIMESTAMP_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_DAEMON_WS_ID_CHARS;
}

function validateOptionalError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return "error must be a string";
  if (value.length > MAX_DAEMON_WS_ERROR_CHARS) {
    return "error exceeds max length";
  }
  return null;
}

function validateBoundedJson(
  value: unknown,
  maxBytes: number,
  label: string,
): string | null {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return `${label} is not JSON-serializable`;
    if (utf8ByteLength(encoded) > maxBytes) {
      return `${label} exceeds max size`;
    }
  } catch {
    return `${label} is not JSON-serializable`;
  }
  return null;
}

function validateCommandResult(value: unknown): string | null {
  return validateBoundedJson(value, MAX_DAEMON_WS_RESULT_JSON_BYTES, "result");
}

function validateTopologyReportSnapshot(value: unknown): string | null {
  return validateBoundedJson(
    value,
    MAX_DAEMON_WS_TOPOLOGY_REPORT_JSON_BYTES,
    "snapshot",
  );
}

function validatePresenceFields(
  record: Record<string, unknown>,
): string | null {
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  if (
    record.hostname !== undefined &&
    (typeof record.hostname !== "string" ||
      record.hostname.length > MAX_DAEMON_WS_HOST_FIELD_CHARS)
  ) {
    return "invalid hostname";
  }
  if (
    record.machineKey !== undefined &&
    (typeof record.machineKey !== "string" ||
      record.machineKey.length > MAX_DAEMON_WS_HOST_FIELD_CHARS)
  ) {
    return "invalid machineKey";
  }
  if (
    record.daemonBuild !== undefined &&
    !parseDaemonBuildInfo(record.daemonBuild)
  ) {
    return "invalid daemonBuild";
  }
  return null;
}

function validateResultEnvelopeFields(
  record: Record<string, unknown>,
): string | null {
  if (!isBoundedId(record.id)) return "invalid id";
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  const errorIssue = validateOptionalError(record.error);
  if (errorIssue) return errorIssue;
  return null;
}

function validateOptionalIsoTimestamp(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined) return null;
  if (!isIsoTimestamp(value)) return `invalid ${field}`;
  return null;
}

function validateHelloFields(record: Record<string, unknown>): string | null {
  if (!parseDaemonBuildInfo(record.daemonBuild)) return "invalid daemonBuild";
  return validatePresenceFields(record);
}

function validateAddressesResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (!Array.isArray(record.ips)) return "invalid ips";
  return null;
}

function validateManagedLogsResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (typeof record.logs !== "string") return "invalid logs";
  if (record.logs.length > MAX_DAEMON_WS_LOGS_CHARS) {
    return "logs exceed max length";
  }
  return null;
}

/**
 * The `files[]` array: per-entry shape and the cumulative content budget.
 *
 * The byte total is checked here as well as in the envelope validator: this
 * runs on the raw frame, before anything is handed onward.
 */
function validateRepoReadFiles(value: unknown): string | null {
  if (!Array.isArray(value)) return "invalid files";
  if (value.length > MAX_DAEMON_WS_REPO_READ_PATHS) {
    return "files exceed max entries";
  }
  let bytes = 0;
  for (const file of value) {
    if (typeof file !== "object" || file === null) return "invalid file entry";
    const entry = file as Record<string, unknown>;
    if (typeof entry.path !== "string") return "invalid file path";
    if (typeof entry.found !== "boolean") return "invalid file found";
    if (entry.content === undefined) continue;
    if (typeof entry.content !== "string") return "invalid file content";
    bytes += utf8ByteLength(entry.content);
    if (bytes > MAX_DAEMON_WS_REPO_READ_BYTES) {
      return "repo read exceeds max bytes";
    }
  }
  return null;
}

/** The `entries[]` array — a listing, so only its size is bounded here. */
function validateRepoReadEntries(value: unknown): string | null {
  if (!Array.isArray(value)) return "invalid entries";
  if (value.length > MAX_DAEMON_WS_REPO_READ_ENTRIES) {
    return "entries exceed max";
  }
  return null;
}

function validateRepoReadResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (typeof record.ok !== "boolean") return "invalid ok";
  if (record.files !== undefined) {
    const issue = validateRepoReadFiles(record.files);
    if (issue) return issue;
  }
  if (record.entries !== undefined) {
    const issue = validateRepoReadEntries(record.entries);
    if (issue) return issue;
  }
  return null;
}

function validateRepoDefaultBranchResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (typeof record.ok !== "boolean") return "invalid ok";
  if (record.defaultBranch === undefined || record.defaultBranch === null) {
    return null;
  }
  if (typeof record.defaultBranch !== "string") return "invalid defaultBranch";
  if (record.defaultBranch.length > MAX_DAEMON_WS_DEFAULT_BRANCH_CHARS) {
    return "defaultBranch exceeds max length";
  }
  return null;
}

const MANAGED_HA_EVENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateManagedHaEventFields(
  record: Record<string, unknown>,
): string | null {
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  if (
    typeof record.managedId !== "string" ||
    !MANAGED_HA_EVENT_ID_RE.test(record.managedId)
  ) {
    return "invalid managedId";
  }
  if (
    record.sourceMemberId !== undefined &&
    (typeof record.sourceMemberId !== "string" ||
      !MANAGED_HA_EVENT_ID_RE.test(record.sourceMemberId))
  ) {
    return "invalid sourceMemberId";
  }
  return null;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateTopologyReportFields(
  record: Record<string, unknown>,
): string | null {
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  if (!isNonNegativeInt(record.generation)) return "invalid generation";
  if (!isNonNegativeInt(record.bootGeneration)) {
    return "invalid bootGeneration";
  }
  return validateTopologyReportSnapshot(record.snapshot);
}

function isFabricPeerHealth(value: unknown): value is FabricPathPeerHealth {
  return typeof value === "string" && FABRIC_PEER_HEALTH.has(value);
}

function validateFabricPathObservation(value: unknown): string | null {
  if (!isRecord(value)) return "invalid path entry";
  if (!isValidWireguardPublicKey(value.publicKey)) {
    return "invalid path publicKey";
  }
  if (!isFabricPeerHealth(value.health)) return "invalid path health";
  if (
    value.endpoint !== undefined && !isValidWireguardEndpoint(value.endpoint)
  ) {
    return "invalid path endpoint";
  }
  const handshakeIssue = validateOptionalIsoTimestamp(
    value.lastHandshakeAt,
    "path lastHandshakeAt",
  );
  if (handshakeIssue) return handshakeIssue;
  if (value.latencyMs !== undefined) {
    if (
      typeof value.latencyMs !== "number" ||
      !Number.isFinite(value.latencyMs) ||
      value.latencyMs < 0
    ) {
      return "invalid path latencyMs";
    }
  }
  return null;
}

function validateFabricPathsResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (!Array.isArray(record.paths)) return "invalid paths";
  if (record.paths.length > MAX_DAEMON_WS_FABRIC_PATH_ENTRIES) {
    return "paths exceed max entries";
  }
  for (const entry of record.paths) {
    const issue = validateFabricPathObservation(entry);
    if (issue) return issue;
  }
  return null;
}

function validateOkResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (typeof record.ok !== "boolean") return "invalid ok";
  return null;
}

function validateCommandAckFields(
  record: Record<string, unknown>,
): string | null {
  if (!isBoundedId(record.id)) return "invalid id";
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  if (!isIsoTimestamp(record.daemonReceivedAt)) {
    return "invalid daemonReceivedAt";
  }
  return null;
}

function validateCommandOutcomeFields(
  record: Record<string, unknown>,
): string | null {
  if (!isBoundedId(record.id)) return "invalid id";
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  if (typeof record.ok !== "boolean") return "invalid ok";
  const errorIssue = validateOptionalError(record.error);
  if (errorIssue) return errorIssue;
  const resultIssue = validateCommandResult(record.result);
  if (resultIssue) return resultIssue;
  return (
    validateOptionalIsoTimestamp(record.daemonReceivedAt, "daemonReceivedAt") ??
      validateOptionalIsoTimestamp(
        record.daemonRespondedAt,
        "daemonRespondedAt",
      )
  );
}

/**
 * Strict inbound WebSocket frame validator. Checks frame size, message type,
 * required fields, timestamp format, identifier lengths, and per-field caps
 * before any cell storage / rate-limit bookkeeping runs.
 */
export function validateDaemonInboundFrame(
  raw: string,
): { ok: true; message: DaemonMessage } | { ok: false; reason: string } {
  if (utf8ByteLength(raw) > MAX_DAEMON_WS_FRAME_BYTES) {
    return { ok: false, reason: "frame exceeds max size" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid json" };
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return { ok: false, reason: "invalid message shape" };
  }

  if (!(DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has(parsed.type)) {
    return { ok: false, reason: `disallowed type ${parsed.type}` };
  }

  const typeIssue = validateInboundMessageFields(parsed);
  if (typeIssue) return { ok: false, reason: typeIssue };

  return { ok: true, message: parsed as DaemonMessage };
}

function validateInboundMessageFields(
  record: Record<string, unknown>,
): string | null {
  switch (record.type) {
    case "hello":
      return validateHelloFields(record);
    case "heartbeat":
      return validatePresenceFields(record);
    case "addresses-result":
      return validateAddressesResultFields(record);
    case "managed-logs-result":
    case "container-logs-result":
      return validateManagedLogsResultFields(record);
    case "repo-read-result":
      return validateRepoReadResultFields(record);
    case "repo-default-branch-result":
      return validateRepoDefaultBranchResultFields(record);
    case "managed-ha-event":
      return validateManagedHaEventFields(record);
    case "topology-report":
      return validateTopologyReportFields(record);
    case "fabric-paths-result":
      return validateFabricPathsResultFields(record);
    case "dev-sync-result":
    case "tunnel-token-result":
    case "public-urls-update-result":
    case "update-result":
    case "metrics-live-start-result":
    case "metrics-live-stop-result":
    case "topology-overrides-update-result":
    case "capability-plan-update-result":
    case "capability-plan-clear-result":
      return validateOkResultFields(record);
    case "command-ack":
      return validateCommandAckFields(record);
    case "command-outcome":
      return validateCommandOutcomeFields(record);
    default:
      return `disallowed type ${String(record.type)}`;
  }
}

function validateManagedLogsEnvelope(
  inbound: Extract<
    DaemonInboundEnvelope,
    { kind: "managed-logs-result" | "container-logs-result" }
  >,
): string | null {
  if (inbound.logs.length > MAX_DAEMON_WS_LOGS_CHARS) {
    return "logs exceed max length";
  }
  return validateOptionalError(inbound.error);
}

/**
 * Size-check a repo read before it is handed to the caller.
 *
 * The cap is on the **total** across files, not per file: eight files just
 * under a per-file limit would still be a frame nobody asked for.
 */
function validateRepoReadEnvelope(
  inbound: Extract<DaemonInboundEnvelope, { kind: "repo-read-result" }>,
): string | null {
  let bytes = 0;
  for (const file of inbound.files ?? []) {
    bytes += utf8ByteLength(file.content ?? "");
    if (bytes > MAX_DAEMON_WS_REPO_READ_BYTES) {
      return "repo read exceeds max bytes";
    }
  }
  if ((inbound.entries ?? []).length > MAX_DAEMON_WS_REPO_READ_ENTRIES) {
    return "repo read entries exceed max";
  }
  return validateOptionalError(inbound.error);
}

function validateFabricPathsEnvelope(
  inbound: Extract<DaemonInboundEnvelope, { kind: "fabric-paths-result" }>,
): string | null {
  if (inbound.paths.length > MAX_DAEMON_WS_FABRIC_PATH_ENTRIES) {
    return "paths exceed max entries";
  }
  for (const entry of inbound.paths) {
    const issue = validateFabricPathObservation(entry);
    if (issue) return issue;
  }
  return validateOptionalError(inbound.error);
}

function validateCommandAckEnvelope(
  inbound: Extract<DaemonInboundEnvelope, { kind: "command-ack" }>,
): string | null {
  if (!isIsoTimestamp(inbound.daemonReceivedAt)) {
    return "invalid daemonReceivedAt";
  }
  return null;
}

function validateInboundEnvelopeKind(
  inbound: DaemonInboundEnvelope,
): string | null {
  switch (inbound.kind) {
    case "managed-logs-result":
    case "container-logs-result":
      return validateManagedLogsEnvelope(inbound);
    case "repo-read-result":
      return validateRepoReadEnvelope(inbound);
    case "repo-default-branch-result":
      return validateOptionalError(inbound.error);
    case "fabric-paths-result":
      return validateFabricPathsEnvelope(inbound);
    case "command-outcome":
      return validateOptionalError(inbound.error) ??
        validateCommandResult(inbound.result);
    case "dev-sync-result":
    case "tunnel-token-result":
    case "public-urls-update-result":
    case "update-result":
    case "metrics-live-start-result":
    case "metrics-live-stop-result":
    case "topology-overrides-update-result":
    case "capability-plan-update-result":
      return validateOptionalError(inbound.error);
    case "command-ack":
      return validateCommandAckEnvelope(inbound);
    case "addresses-result":
      return null;
    default:
      return "unknown envelope kind";
  }
}

/**
 * Re-check normalized inbound envelope field sizes before Redis/DO persistence.
 * Callers that already ran {@link validateDaemonInboundFrame} still pass this
 * cheap guard so a forged envelope cannot bypass wire validation.
 */
export function validateDaemonInboundEnvelope(
  inbound: DaemonInboundEnvelope,
): { ok: true } | { ok: false; reason: string } {
  if (!isBoundedId(inbound.requestId)) {
    return { ok: false, reason: "invalid requestId" };
  }
  if (!isIsoTimestamp(inbound.at)) {
    return { ok: false, reason: "invalid at timestamp" };
  }
  const kindIssue = validateInboundEnvelopeKind(inbound);
  if (kindIssue) return { ok: false, reason: kindIssue };
  return { ok: true };
}

/** Auto-response ping/pong pair — handled by the runtime without waking the DO. */
export const DAEMON_CELL_PING = '{"type":"ping"}';
export const DAEMON_CELL_PONG = '{"type":"pong"}';

/** Per-outbox-entry identity for queue send/ack/resend semantics. */
export type OutboxDeliveryId = string; // NOSONAR typescript:S6564 — semantic alias for delivery queue keys

/** Correlation/idempotency key shared by all frames in a multi-message request. */
export type OutboundRequestId = string; // NOSONAR typescript:S6564 — semantic alias for request correlation

type OutboundEnvelopeBase = {
  /** Unique outbox entry key; distinct for every queued delivery. */
  deliveryId: OutboxDeliveryId;
  /** Correlates multi-frame requests (e.g. dev-sync chunks) and inbound acks. */
  requestId: OutboundRequestId;
  at: string;
};

/** Cell-internal outbound envelope (normalized form, distinct from wire `DaemonMessage`). */
export type DaemonOutboundEnvelope =
  | (OutboundEnvelopeBase & { kind: "addresses-request" })
  | (OutboundEnvelopeBase & {
    kind: "managed-logs-request";
    managedId: string;
    tail: number;
  })
  | (OutboundEnvelopeBase & {
    kind: "container-logs-request";
    containerId: string;
    tail: number;
  })
  | (OutboundEnvelopeBase & {
    kind: "repo-read-request";
    cloneUrl: string;
    ref: string;
    paths: string[];
    listPath?: string;
    maxBytesPerFile: number;
    /** `tpdaemon.…` sealed clone secret, or absent for a public repo. */
    credential?: string;
    credentialKind?: string;
    credentialUsername?: string;
  })
  | (OutboundEnvelopeBase & {
    kind: "repo-default-branch-request";
    /** Anonymous only — no credential field, unlike `repo-read-request`. */
    cloneUrl: string;
  })
  | (OutboundEnvelopeBase & {
    kind: "fabric-paths-request";
    fabricId: string;
    probeMs: number;
    candidates: FabricPathWireCandidate[];
  })
  | (OutboundEnvelopeBase & {
    kind: "dev-sync";
    phase: "begin";
    totalChunks: number;
    totalBytes: number;
  })
  | (OutboundEnvelopeBase & {
    kind: "dev-sync";
    phase: "chunk";
    index: number;
    data: string;
  })
  | (OutboundEnvelopeBase & { kind: "dev-sync"; phase: "end" })
  | (OutboundEnvelopeBase & { kind: "tunnel-token"; token: string })
  | (OutboundEnvelopeBase & { kind: "public-urls-update"; urls: string[] })
  | (OutboundEnvelopeBase & {
    kind: "metrics-live-start";
    leaseId: string;
    intervalSeconds: number;
    expiresAt: string;
  })
  | (OutboundEnvelopeBase & { kind: "metrics-live-stop"; leaseId: string })
  | (OutboundEnvelopeBase & {
    kind: "topology-overrides-update";
    overrides: TopologyOverridesUpdatePayload;
  })
  | (OutboundEnvelopeBase & {
    kind: "capability-plan-update";
    plan: CapabilityPlanUpdatePayload;
    generation: number;
  })
  | (OutboundEnvelopeBase & { kind: "capability-plan-clear" })
  | (OutboundEnvelopeBase & {
    kind: "update";
    channel?: string;
    updateUrl?: string;
    updateSha256?: string;
  })
  | (OutboundEnvelopeBase & { kind: "echo"; payload: unknown })
  | (OutboundEnvelopeBase & {
    kind: "command-dispatch";
    commandId: string;
    commandType: string;
    payload: unknown;
  });

/** Cell-internal inbound envelope (normalized form, distinct from wire `DaemonMessage`). */
export type DaemonInboundEnvelope =
  | {
    kind: "addresses-result";
    requestId: string;
    at: string;
    ips: ServerReportedIp[];
  }
  | {
    kind: "managed-logs-result";
    requestId: string;
    at: string;
    logs: string;
    error?: string;
  }
  | {
    kind: "container-logs-result";
    requestId: string;
    at: string;
    logs: string;
    error?: string;
  }
  | {
    kind: "repo-read-result";
    requestId: string;
    at: string;
    ok: boolean;
    commitSha?: string;
    files?: {
      path: string;
      found: boolean;
      content?: string;
      bytes?: number;
      reason?: string;
    }[];
    entries?: { path: string; kind: string; bytes?: number }[];
    error?: string;
  }
  | {
    kind: "repo-default-branch-result";
    requestId: string;
    at: string;
    ok: boolean;
    defaultBranch?: string | null;
    error?: string;
  }
  | {
    kind: "fabric-paths-result";
    requestId: string;
    at: string;
    paths: FabricPathWireObservation[];
    error?: string;
  }
  | {
    kind: "dev-sync-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "tunnel-token-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "public-urls-update-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "metrics-live-start-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "metrics-live-stop-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "topology-overrides-update-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "capability-plan-update-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "capability-plan-clear-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "update-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "command-ack";
    requestId: string;
    at: string;
    daemonReceivedAt: string;
  }
  | {
    kind: "command-outcome";
    requestId: string;
    at: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    daemonReceivedAt?: string;
    daemonRespondedAt?: string;
  };

export function parseDaemonMessage(raw: string): DaemonMessage | null {
  try {
    return JSON.parse(raw) as DaemonMessage;
  } catch {
    return null;
  }
}

export function wireMessageToInboundEnvelope(
  msg: DaemonMessage,
): DaemonInboundEnvelope | null {
  switch (msg.type) {
    case "hello":
    case "heartbeat":
    case "managed-ha-event":
    case "topology-report":
      return null;

    case "addresses-result":
      return {
        kind: "addresses-result",
        requestId: msg.id,
        at: msg.at,
        ips: msg.ips,
      };
    case "managed-logs-result":
      return {
        kind: "managed-logs-result",
        requestId: msg.id,
        at: msg.at,
        logs: msg.logs,
        error: msg.error,
      };
    case "container-logs-result":
      return {
        kind: "container-logs-result",
        requestId: msg.id,
        at: msg.at,
        logs: msg.logs,
        error: msg.error,
      };
    case "repo-read-result":
      return {
        kind: "repo-read-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        commitSha: msg.commitSha,
        files: msg.files,
        entries: msg.entries,
        error: msg.error,
      };
    case "repo-default-branch-result":
      return {
        kind: "repo-default-branch-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        defaultBranch: msg.defaultBranch,
        error: msg.error,
      };
    case "fabric-paths-result":
      return {
        kind: "fabric-paths-result",
        requestId: msg.id,
        at: msg.at,
        paths: msg.paths,
        error: msg.error,
      };
    case "dev-sync-result":
      return {
        kind: "dev-sync-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "tunnel-token-result":
      return {
        kind: "tunnel-token-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "public-urls-update-result":
      return {
        kind: "public-urls-update-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "metrics-live-start-result":
      return {
        kind: "metrics-live-start-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "metrics-live-stop-result":
      return {
        kind: "metrics-live-stop-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "topology-overrides-update-result":
      return {
        kind: "topology-overrides-update-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "capability-plan-update-result":
      return {
        kind: "capability-plan-update-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "capability-plan-clear-result":
      return {
        kind: "capability-plan-clear-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "update-result":
      return {
        kind: "update-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "command-ack":
      return {
        kind: "command-ack",
        requestId: msg.id,
        at: msg.at,
        daemonReceivedAt: msg.daemonReceivedAt,
      };
    case "command-outcome":
      return {
        kind: "command-outcome",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        result: msg.result,
        error: msg.error,
        daemonReceivedAt: msg.daemonReceivedAt,
        daemonRespondedAt: msg.daemonRespondedAt,
      };
    default:
      return null;
  }
}

/** One envelope variant, addressed by its `kind`. */
type OutboundEnvelopeOf<K extends DaemonOutboundEnvelope["kind"]> = Extract<
  DaemonOutboundEnvelope,
  { kind: K }
>;

/**
 * The credential fields ride along only when the source has one — a `null` or
 * an empty string would read as "clone anonymously", which is a different
 * request.
 */
function repoReadRequestMessage(
  env: OutboundEnvelopeOf<"repo-read-request">,
): DaemonMessage {
  return {
    type: "repo-read-request",
    id: env.requestId,
    cloneUrl: env.cloneUrl,
    ref: env.ref,
    paths: env.paths.slice(0, MAX_DAEMON_WS_REPO_READ_PATHS),
    ...(env.listPath === undefined ? {} : { listPath: env.listPath }),
    maxBytesPerFile: env.maxBytesPerFile,
    ...(env.credential === undefined ? {} : { credential: env.credential }),
    ...(env.credentialKind === undefined
      ? {}
      : { credentialKind: env.credentialKind }),
    ...(env.credentialUsername === undefined
      ? {}
      : { credentialUsername: env.credentialUsername }),
    at: env.at,
  };
}

/** One dev-sync envelope carries the phase; the wire has a type per phase. */
function devSyncMessage(env: OutboundEnvelopeOf<"dev-sync">): DaemonMessage {
  if (env.phase === "begin") {
    return {
      type: "dev-sync-begin",
      id: env.requestId,
      totalChunks: env.totalChunks,
      totalBytes: env.totalBytes,
      at: env.at,
    };
  }
  if (env.phase === "chunk") {
    return {
      type: "dev-sync-chunk",
      id: env.requestId,
      index: env.index,
      data: env.data,
      at: env.at,
    };
  }
  return { type: "dev-sync-end", id: env.requestId, at: env.at };
}

/** An absent field means "keep what you have", not "clear it". */
function updateMessage(env: OutboundEnvelopeOf<"update">): DaemonMessage {
  return {
    type: "update",
    id: env.requestId,
    at: env.at,
    ...(env.channel !== undefined ? { channel: env.channel } : {}),
    ...(env.updateUrl !== undefined ? { updateUrl: env.updateUrl } : {}),
    ...(env.updateSha256 !== undefined
      ? { updateSha256: env.updateSha256 }
      : {}),
  };
}

export function outboundEnvelopeToWireMessage(
  env: DaemonOutboundEnvelope,
): DaemonMessage {
  switch (env.kind) {
    case "addresses-request":
      return { type: "addresses-request", id: env.requestId, at: env.at };
    case "managed-logs-request":
      return {
        type: "managed-logs-request",
        id: env.requestId,
        managedId: env.managedId,
        tail: env.tail,
        at: env.at,
      };
    case "container-logs-request":
      return {
        type: "container-logs-request",
        id: env.requestId,
        containerId: env.containerId,
        tail: env.tail,
        at: env.at,
      };
    case "repo-read-request":
      return repoReadRequestMessage(env);
    case "repo-default-branch-request":
      return {
        type: "repo-default-branch-request",
        id: env.requestId,
        cloneUrl: env.cloneUrl,
        at: env.at,
      };
    case "fabric-paths-request":
      return {
        type: "fabric-paths-request",
        id: env.requestId,
        fabricId: env.fabricId,
        probeMs: env.probeMs,
        candidates: env.candidates.slice(0, MAX_DAEMON_WS_FABRIC_PATH_ENTRIES)
          .map((candidate) => ({
            publicKey: candidate.publicKey,
            endpoints: candidate.endpoints.slice(
              0,
              MAX_DAEMON_WS_FABRIC_PATH_CANDIDATES,
            ),
          })),
        at: env.at,
      };
    case "dev-sync":
      return devSyncMessage(env);
    case "tunnel-token":
      return {
        type: "tunnel-token",
        id: env.requestId,
        token: env.token,
        at: env.at,
      };
    case "public-urls-update":
      return {
        type: "public-urls-update",
        id: env.requestId,
        urls: env.urls,
        at: env.at,
      };
    case "metrics-live-start":
      return {
        type: "metrics-live-start",
        id: env.requestId,
        leaseId: env.leaseId,
        intervalSeconds: env.intervalSeconds,
        expiresAt: env.expiresAt,
        at: env.at,
      };
    case "metrics-live-stop":
      return {
        type: "metrics-live-stop",
        id: env.requestId,
        leaseId: env.leaseId,
        at: env.at,
      };
    case "topology-overrides-update":
      return {
        type: "topology-overrides-update",
        id: env.requestId,
        overrides: env.overrides,
        at: env.at,
      };
    case "capability-plan-update":
      return {
        type: "capability-plan-update",
        id: env.requestId,
        plan: env.plan,
        generation: env.generation,
        at: env.at,
      };
    case "capability-plan-clear":
      return {
        type: "capability-plan-clear",
        id: env.requestId,
        at: env.at,
      };
    case "update":
      return updateMessage(env);
    case "echo":
      return { type: "echo", payload: env.payload, at: env.at };
    case "command-dispatch":
      return {
        type: "command-dispatch",
        id: env.requestId,
        commandId: env.commandId,
        commandType: env.commandType,
        payload: env.payload,
        at: env.at,
      };
  }
}

export function generateRequestId(): OutboundRequestId {
  return crypto.randomUUID();
}

export function generateDeliveryId(): OutboxDeliveryId {
  return crypto.randomUUID();
}
