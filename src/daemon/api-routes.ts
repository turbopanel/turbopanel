import { Hono } from "hono";
import type { Context, Env, Next } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { isInstanceInstalled } from "../client/authn/install-state.ts";
import { lookupActiveLicense } from "../client/authn/license.ts";
import { organization, server } from "../lib/db/schema.ts";
import type {
  DerivedSecretsConfig,
  SecretsConfig,
} from "../client/authn/secrets.ts";
import type { DaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { buildJwksDocument } from "./authn/daemon-jwt-keyring.ts";
import {
  decryptSecretForDaemon,
  isDaemonSealedEnvelope,
  parseDaemonSecretEnvelope,
} from "../client/authn/data-encryption.ts";
import type { Db } from "../db.ts";
import {
  getDaemonCellRegistry,
  getDb,
  getExecutionLogStore,
  getServerMetricsStore,
} from "../db.ts";
import {
  contentLengthExceeds,
  readBodyWithByteLimit,
} from "../lib/http/bounded-body.ts";
import {
  MAX_METRICS_PAYLOAD_BYTES,
  metricsPayloadByteLength,
  rateLimitedMetricsLog,
  validateMetricsSample,
} from "./metrics/validation.ts";
import {
  isServerMachineClass,
  isUnmarkedLiveCadenceInterval,
  type MetricsCapabilityPlan,
  type MetricsDeploymentKind,
  metricsDeploymentKindForRuntime,
  resolveDefaultMetricsCapabilityPlan,
  resolveServerMachineClass,
  truncateSampleToCapabilityPlan,
} from "./metrics/capability-plan.ts";
import { DisabledServerMetricsStore } from "./metrics/disabled-store.ts";
import { createMetricsChartCache } from "./metrics/query/cache.ts";
import {
  cacheLiveSample,
  isServerLiveSessionActive,
} from "./metrics/query/live-session.ts";
import type { AuthenticatedMetricsSample } from "./metrics/types.ts";
import {
  type OrganizationOptions,
  parseOrganizationOptions,
} from "../lib/organization-options.ts";
import {
  parseServerHardwareProfile,
  parseServerHostResources,
  parseServerOptions,
  resolveEffectiveMetricsCapabilityPlan,
} from "../lib/db/server-metadata.ts";
import { metricsCapabilityTierEntitlementsForRank } from "../lib/tiers/tier-entitlements.ts";
import { recomputeAssignmentsForServer } from "../lib/tiers/assignment-records.ts";
import {
  syncSelfHostedGrantForLicense,
  syncSelfHostedGrantForServer,
} from "../lib/tiers/self-hosted-grant-records.ts";
import {
  evaluateHostedEnrollmentTier,
  evaluateTierFloor,
  LICENSE_TIER_BELOW_REQUIRED_ERROR,
  loadServerLicenseTierJoin,
} from "../lib/tiers/tier-enforcement.ts";
import {
  getLatestTopologyGeneration,
  getTopologyGeneration,
  markTopologyResyncRequested,
} from "../client/servers/server-topology-records.ts";
import { recordCapabilityPlanGenerationIfChanged } from "../client/servers/capability-plan-records.ts";
import { enqueueCapabilityPlanUpdate } from "../client/servers/capability-plan-push.ts";
import { computeSlotMapping } from "../client/servers/topology-slot-mapping.ts";
import {
  EMPTY_TOPOLOGY_OVERRIDES,
  type SlotMapping,
  type TopologyOverrides,
  type TopologySnapshot,
} from "../client/servers/topology-types.ts";
import {
  createStatelessChallengeStore,
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
} from "./cell/stateless-challenge.ts";
import { getDaemonOpenApiSpec } from "./openapi/index.ts";
import { buildDeploymentSecretsRehydrate } from "./rehydrate-secrets.ts";
import { buildDaemonScalarHtml } from "../scalar-html.ts";
import { resolveInstanceTlsCaServePath } from "../server-paths.ts";
import { DAEMON_API_PREFIX } from "../surfaces.ts";
import { normalizeMachineKey } from "../lib/machine-key.ts";
import {
  type FabricMembershipDeps,
  getServerLicenseBinding,
  resolveServerId,
  touchServerMetadata,
} from "../server-registry.ts";
import { getCommandQueue } from "../lib/commands/queue.ts";
import {
  loadExecutionLogCommandTarget,
  MAX_EXECUTION_LOG_CHUNK_BODY_BYTES,
  parseExecutionLogChunkBody,
} from "./execution-log-ingest.ts";
import {
  ExecutionLogGapError,
  ExecutionLogSealedError,
} from "../lib/execution-logs/types.ts";
import { sealExecutionLogOnTerminal } from "../lib/execution-logs/seal-on-terminal.ts";
import { isNoopCommandQueue } from "../lib/commands/noop-command-queue.ts";
import { verifyDaemonLicense } from "./authn/license.ts";
import { issueDaemonJwt, verifyDaemonJwt } from "./authn/daemon-jwt.ts";
import type { ServerDaemonStateWithMetadata } from "./authn/server-identity-db.ts";
import {
  attachDaemonStateToServer,
  getServerDaemonStateByFingerprint,
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
  touchDaemonKeyLastUsed,
} from "./authn/server-identity-db.ts";
import {
  buildAuthPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
  verifyDaemonSignature,
} from "./authn/server-key.ts";
import type { RateLimiter } from "./rate-limit/contracts.ts";
import { createNoopRateLimiter } from "./rate-limit/contracts.ts";
import {
  daemonEnrollChallengeRateLimitKey,
  daemonMetricsRateLimitKey,
  daemonRestRateLimitKey,
  type DaemonRestRateLimitRoute,
} from "./rate-limit/keys.ts";

function normalizeRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a request body while enforcing a hard byte budget, aborting the stream
 * as soon as the budget is exceeded so an oversized upload is never fully
 * buffered. Returns `{ ok: false }` when the limit is exceeded.
 *
 * Thin text-decoding wrapper over the shared streaming reader in
 * `src/lib/http/bounded-body.ts` — every surface that reads an unauthenticated
 * body (this module, the webhook gate, public auth routes) shares one tested
 * implementation.
 */
async function readRequestBodyWithLimit(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const bodyRead = await readBodyWithByteLimit(c, maxBytes);
  if (!bodyRead.ok) return { ok: false };
  return { ok: true, text: new TextDecoder().decode(bodyRead.bytes) };
}

/** Maximum number of ciphertexts accepted per `/secrets/decrypt` request. */
export const MAX_SECRETS_DECRYPT_BATCH = 100;

/**
 * Per-ciphertext character budget. A daemon envelope carrying a single TLS
 * private key base64url-encodes to a few KiB; 16 KiB leaves generous headroom
 * while rejecting pathological inputs.
 */
export const MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS = 16 * 1024;

/**
 * Whole-request byte budget, read (and aborted) before JSON parsing. Sized as
 * the batch cap × per-ciphertext cap plus JSON array/quoting overhead.
 */
export const MAX_SECRETS_DECRYPT_BODY_BYTES = 2 * 1024 * 1024;

/** `POST /auth/challenge` — optional serverId/keyId only. */
export const MAX_AUTH_CHALLENGE_BODY_BYTES = 4 * 1024;

/** `POST /enroll` — includes publicJwk + license fields. */
export const MAX_ENROLL_BODY_BYTES = 32 * 1024;

/** `POST /auth/session` — signed session proof fields. */
export const MAX_AUTH_SESSION_BODY_BYTES = 8 * 1024;

/**
 * Reject when `Content-Length` declares a body larger than `maxBytes`.
 * Returns a 413 response, or `null` when the header is absent/ok.
 */
function rejectIfContentLengthTooLarge(
  c: Context,
  maxBytes: number,
): Response | null {
  if (!contentLengthExceeds(c, maxBytes)) return null;
  return c.json({ ok: false, error: "request body too large" }, 413);
}

/**
 * Content-Length precheck + streaming byte budget. Returns the body text or a
 * 413 Response when the upload exceeds `maxBytes`.
 */
async function readBoundedJsonBody(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const tooLarge = rejectIfContentLengthTooLarge(c, maxBytes);
  if (tooLarge) return { ok: false, response: tooLarge };
  const bodyRead = await readRequestBodyWithLimit(c, maxBytes);
  if (!bodyRead.ok) {
    return {
      ok: false,
      response: c.json({ ok: false, error: "request body too large" }, 413),
    };
  }
  return { ok: true, text: bodyRead.text };
}

/**
 * Decrypt a single recipient-bound daemon envelope. Returns the plaintext, or
 * `null` when the value is not a daemon envelope, is not addressed to this
 * recipient, or fails to decrypt. Never throws.
 */
async function decryptDaemonCiphertext(
  secretsConfig: SecretsConfig,
  recipient: { serverId: string; keyId: string },
  ciphertext: string,
): Promise<string | null> {
  try {
    if (!isDaemonSealedEnvelope(ciphertext)) {
      return null;
    }
    const parsed = parseDaemonSecretEnvelope(ciphertext);
    if (!parsed) {
      return null;
    }
    if (
      parsed.serverId !== recipient.serverId || parsed.keyId !== recipient.keyId
    ) {
      return null;
    }
    return await decryptSecretForDaemon(secretsConfig, recipient, ciphertext);
  } catch {
    return null;
  }
}

function challengeExpiresAt(at: string, ttlMs: number): string {
  const atMs = new Date(at).getTime();
  if (!Number.isFinite(atMs)) {
    return new Date(Date.now() + ttlMs).toISOString();
  }
  return new Date(atMs + ttlMs).toISOString();
}

/** Shared shape for helpers that either succeed with a value or fail with an HTTP status + message. */
type FieldResult<T> = { ok: true; value: T } | {
  ok: false;
  status: 400 | 401;
  error: string;
};

/** Normalizes `body.machineKey`, distinguishing "absent" from "present but invalid". */
function parseOptionalMachineKey(
  machineKeyRaw: string | null,
): FieldResult<string | undefined> {
  if (machineKeyRaw === null) {
    return { ok: true, value: undefined };
  }
  const machineKey = normalizeMachineKey(machineKeyRaw);
  if (machineKey === undefined) {
    return { ok: false, status: 400, error: "Invalid machineKey" };
  }
  return { ok: true, value: machineKey };
}

type EnrollFields = {
  licenseId: string;
  licenseToken: string;
  hostname: string;
  challengeId: string;
  signature: string;
  publicJwk: JsonWebKey;
  machineKey: string | undefined;
  serverIdBody: string | undefined;
};

/** Parses and validates the `POST /enroll` body, keeping every field check in one place. */
function parseEnrollFields(
  body: Record<string, unknown>,
): FieldResult<EnrollFields> {
  const licenseId = normalizeRequiredString(body.licenseId);
  const licenseToken = normalizeRequiredString(body.licenseToken);
  const machineKeyRaw = normalizeRequiredString(body.machineKey);
  const hostname = normalizeRequiredString(body.hostname);
  const challengeId = normalizeRequiredString(body.challengeId);
  const signature = normalizeRequiredString(body.signature);
  const publicJwk = isObjectRecord(body.publicJwk)
    ? (body.publicJwk as JsonWebKey)
    : null;

  // Keep malformed or omitted auth credentials on the same unauthorized path.
  if (!licenseId || !licenseToken) {
    return { ok: false, status: 401, error: "Invalid license" };
  }
  if (!hostname || !challengeId || !signature || !publicJwk) {
    return { ok: false, status: 400, error: "Missing required enroll fields" };
  }
  const machineKeyResult = parseOptionalMachineKey(machineKeyRaw);
  if (!machineKeyResult.ok) return machineKeyResult;

  return {
    ok: true,
    value: {
      licenseId,
      licenseToken,
      hostname,
      challengeId,
      signature,
      publicJwk,
      machineKey: machineKeyResult.value,
      serverIdBody: normalizeRequiredString(body.serverId) ?? undefined,
    },
  };
}

/**
 * Resolves the server row, guards against a fingerprint collision, and attaches
 * the daemon key — the final leg of `POST /enroll` once the signature is verified.
 */
async function finalizeDaemonEnrollment(
  db: Db,
  params: {
    serverIdBody: string | undefined;
    machineKey: string | undefined;
    hostname: string;
    licenseId: string;
    licenseToken: string;
    fingerprint: string;
    publicJwk: JsonWebKey;
    fabricDeps?: FabricMembershipDeps;
  },
): Promise<
  | { ok: true; serverId: string; keyId: string }
  | { ok: false; status: 400 | 409 | 500; error: string }
> {
  const {
    serverIdBody,
    machineKey,
    hostname,
    licenseId,
    licenseToken,
    fingerprint,
    publicJwk,
    fabricDeps,
  } = params;

  const serverId = await resolveServerId(
    db,
    {
      serverId: serverIdBody,
      machineKey,
      hostname,
      licenseId,
      licenseToken,
    },
    fabricDeps,
  );
  if (!serverId) {
    return {
      ok: false,
      status: 400,
      error: "License already consumed or invalid",
    };
  }

  const existing = await getServerDaemonStateByFingerprint(db, fingerprint);
  if (existing && existing.serverId !== serverId) {
    return { ok: false, status: 409, error: "Fingerprint already exists" };
  }

  try {
    const result = await attachDaemonStateToServer(db, serverId, {
      publicJwk,
      fingerprint,
      hostname,
      machineKey,
    });
    return { ok: true, serverId, keyId: result.keyId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }
}

function enrollFabricDepsFromContext(
  c: Context,
): FabricMembershipDeps | undefined {
  const commandQueue = getCommandQueue(c);
  if (!commandQueue || isNoopCommandQueue(commandQueue)) return undefined;
  const secretsConfig = c.get("secretsConfig");
  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  return {
    commandQueue,
    ...(secretsConfig ? { secretsConfig } : {}),
    ...(dataEncryptionSecrets ? { dataEncryptionSecrets } : {}),
  };
}

type AuthSessionFields = {
  serverId: string;
  keyId: string;
  challengeId: string;
  signature: string;
  hostname: string;
  machineKey: string | undefined;
};

/** Parses and validates the `POST /auth/session` body, keeping every field check in one place. */
function parseAuthSessionFields(
  body: Record<string, unknown>,
): FieldResult<AuthSessionFields> {
  const serverId = normalizeRequiredString(body.serverId);
  const keyId = normalizeRequiredString(body.keyId);
  const challengeId = normalizeRequiredString(body.challengeId);
  const signature = normalizeRequiredString(body.signature);
  const hostname = normalizeRequiredString(body.hostname);
  const machineKeyRaw = normalizeRequiredString(body.machineKey);

  if (!serverId || !keyId || !challengeId || !signature || !hostname) {
    return {
      ok: false,
      status: 400,
      error: "Missing required session fields",
    };
  }
  const machineKeyResult = parseOptionalMachineKey(machineKeyRaw);
  if (!machineKeyResult.ok) return machineKeyResult;

  return {
    ok: true,
    value: {
      serverId,
      keyId,
      challengeId,
      signature,
      hostname,
      machineKey: machineKeyResult.value,
    },
  };
}

/** Loads the server's daemon key and confirms it matches `keyId` and is active. */
async function loadActiveDaemonKeyState(
  db: Db,
  serverId: string,
  keyId: string,
): Promise<
  | { ok: true; daemonState: ServerDaemonStateWithMetadata }
  | { ok: false; status: 400 | 404; error: string }
> {
  const daemonState = await getServerDaemonStateByServerId(db, serverId);
  if (!daemonState) {
    return { ok: false, status: 404, error: "Server key not found" };
  }
  if (daemonState.key.id !== keyId) {
    return { ok: false, status: 400, error: "Server key mismatch" };
  }
  if (!isDaemonKeyActive(daemonState.key)) {
    return { ok: false, status: 400, error: "Server key is inactive" };
  }
  return { ok: true, daemonState };
}

/**
 * Confirms the server's bound license (if any) is still active and that an
 * entitled tier covers it. The assignment is derived
 * (`assignment-records.ts`); a licensed server assigned nothing gets one
 * recompute here — the hardware report and the projection may have raced
 * this session — and is refused only when it still ends uncovered. The
 * error string is byte-identical to the daemon's permanent-auth list.
 *
 * **The same check runs on both runtimes.** Self-hosted is not exempted;
 * it is entitled instead, by the grant (`self-hosted-grant.ts`) that is
 * brought in line here before anything is read. Reconnecting is therefore
 * also the backfill path for an organization licensed before the grant
 * existed, and for one whose control plane has just moved from Deno to
 * Workers — the grant it left behind is what keeps its daemons connected.
 */
async function checkServerLicenseEntitlement(
  db: Db,
  serverId: string,
  deployment: MetricsDeploymentKind,
): Promise<{ ok: true } | { ok: false; status: 400; error: string }> {
  const binding = await getServerLicenseBinding(db, serverId);
  if (binding?.licenseId) {
    const activeLicense = await lookupActiveLicense(db, binding.licenseId);
    if (!activeLicense) {
      return { ok: false, status: 400, error: "License is inactive" };
    }
    // Deliberately unguarded, like the recompute below: this decides the
    // daemon's fate, so a database error must surface as a 500 the daemon
    // retries rather than as a permanent refusal.
    await syncSelfHostedGrantForServer(db, serverId, deployment);
  }

  let row = await loadServerLicenseTierJoin(db, serverId);
  if (row?.licenseId && !row.assignedTierId) {
    // Deliberately unguarded: this decides the daemon's fate. A refusal here
    // is a 400, which the daemon treats as permanent and parks on, so a
    // transient database error must surface as a 500 (transient, retried)
    // rather than be swallowed into "still unassigned, refuse permanently".
    await recomputeAssignmentsForServer(db, serverId);
    row = await loadServerLicenseTierJoin(db, serverId);
  }
  if (row?.licenseId && !row.assignedTierId) {
    return { ok: false, status: 400, error: LICENSE_TIER_BELOW_REQUIRED_ERROR };
  }
  if (row?.assignedTierId && row.tierRank != null) {
    const metadata = isPlainObject(row.serverMetadata)
      ? row.serverMetadata
      : undefined;
    const resources = parseServerHostResources(metadata?.resources);
    const floor = evaluateTierFloor({
      resources,
      tierRank: row.tierRank,
    });
    if (!floor.satisfied) {
      return {
        ok: false,
        status: 400,
        error: LICENSE_TIER_BELOW_REQUIRED_ERROR,
      };
    }
  }
  return { ok: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/**
 * A snapshot is only usable for slot mapping once it carries every array
 * `computeSlotMapping` reads. `resolveServerMachineClass` only ever
 * needs `hardwareSignals`, so some recorded/test snapshots are intentionally
 * that minimal — treat those the same as "no snapshot" here rather than
 * letting `computeSlotMapping` throw on a missing array.
 */
function isSlotMappableTopologySnapshot(
  value: Record<string, unknown>,
): value is TopologySnapshot {
  return (
    Array.isArray(value.networks) &&
    Array.isArray(value.filesystems) &&
    Array.isArray(value.blockDevices) &&
    Array.isArray(value.gpus) &&
    Array.isArray(value.hardwareSignals)
  );
}

/**
 * Resolve the {@link SlotMapping} for a sample's own
 * `metadata.topologyGeneration`, given that exact generation's snapshot (not
 * the latest one — reinterpreting a sample under a different generation's
 * layout is exactly what a `SlotMapping` must never do) and the operator's
 * `hardwareProfile` overrides. `undefined` when the snapshot is missing/not a
 * plausible topology report (unknown generation) or resolution otherwise
 * fails — callers must fall back to topology-agnostic packing in that case
 * (see `field-map.ts`).
 */
function resolveSlotMappingForIngest(
  serverId: string,
  topologySnapshot: unknown,
  serverMetadata: unknown,
): SlotMapping | undefined {
  if (!isPlainObject(topologySnapshot)) return undefined;
  if (!isSlotMappableTopologySnapshot(topologySnapshot)) return undefined;
  try {
    const hardwareProfile = parseServerHardwareProfile(
      isPlainObject(serverMetadata)
        ? serverMetadata.hardwareProfile
        : undefined,
    );
    const overrides: TopologyOverrides = {
      ...EMPTY_TOPOLOGY_OVERRIDES,
      nicSlotDeviceIds: hardwareProfile?.nicSlotDeviceIds ?? [],
      hostingFilesystemId: hardwareProfile?.hostingFilesystemId ?? null,
      drivetempEnabled: hardwareProfile?.drivetempEnabled ?? false,
    };
    return computeSlotMapping(topologySnapshot, overrides);
  } catch (err) {
    rateLimitedMetricsLog(serverId, "slot_mapping_resolve_failed", () => {
      console.warn(
        `metrics slot mapping resolution failed for ${serverId}: ${
          String(err)
        }`,
      );
    });
    return undefined;
  }
}

type IngestPlanAndTopology = {
  plan: MetricsCapabilityPlan;
  slotMapping: SlotMapping | undefined;
  generation?: number;
  planChanged?: boolean;
};

type IngestServerPlanRow = {
  serverOptions: unknown;
  orgOptions: unknown;
  serverMetadata: unknown;
  machineClass: unknown;
};

/**
 * Load the reporting server's options plus, on the hosted path only, the
 * bound license's `tier` entitlement columns. Self-hosted never joins
 * `license`/`tier` and always resolves uncapped.
 */
async function loadIngestServerPlanRow(
  db: Db,
  serverId: string,
  deployment: MetricsDeploymentKind,
): Promise<
  | (IngestServerPlanRow & {
    tier: ReturnType<typeof metricsCapabilityTierEntitlementsForRank>;
  })
  | undefined
> {
  if (deployment === "self-hosted") {
    const rows = await db
      .select({
        serverOptions: server.options,
        orgOptions: organization.options,
        serverMetadata: server.metadata,
        machineClass: server.machineClass,
      })
      .from(server)
      .leftJoin(organization, eq(organization.id, server.organizationId))
      .where(eq(server.id, serverId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return { ...row, tier: undefined };
  }

  const joined = await loadServerLicenseTierJoin(db, serverId);
  if (!joined) return undefined;
  return {
    serverOptions: joined.serverOptions,
    orgOptions: joined.orgOptions,
    serverMetadata: joined.serverMetadata,
    machineClass: joined.machineClass,
    tier: metricsCapabilityTierEntitlementsForRank(joined.tierRank),
  };
}

/**
 * Ingest-time capability-plan resolution + topology reconciliation for
 * `POST /api/daemon/v1/metrics`. Resolves the effective v5 metrics
 * capability plan from persisted server/org state (replacing the
 * conservative default-only resolution) and, alongside it, checks whether
 * the sample's `metadata.topologyGeneration` has ever been recorded via
 * `recordTopologyGeneration` — an unknown generation stamps
 * `markTopologyResyncRequested` (fire-and-forget; never blocks ingestion,
 * never reaches the daemon cell directly — see that function's doc comment)
 * — and resolves the sample's {@link SlotMapping} (see
 * {@link resolveSlotMappingForIngest}) for the store's `writeSample` call.
 *
 * Every DB read/write here is best-effort: a failure logs and falls back to
 * {@link resolveDefaultMetricsCapabilityPlan} plus no slot mapping, rather
 * than rejecting an otherwise-valid sample or blocking the fire-and-forget
 * write path.
 */
async function resolveIngestPlanAndReconcileTopology(
  db: Db,
  serverId: string,
  sample: AuthenticatedMetricsSample,
  deployment: MetricsDeploymentKind,
): Promise<IngestPlanAndTopology> {
  try {
    const [topologyMatch, latestTopology, planRow] = await Promise.all([
      getTopologyGeneration(db, serverId, sample.metadata.topologyGeneration),
      getLatestTopologyGeneration(db, serverId),
      loadIngestServerPlanRow(db, serverId, deployment),
    ]);

    const topologyKnown = topologyMatch !== undefined;
    if (!topologyKnown) {
      markTopologyResyncRequested(db, serverId).catch((err) => {
        rateLimitedMetricsLog(serverId, "topology_resync_mark_failed", () => {
          console.warn(
            `metrics topology resync marker failed for ${serverId}: ${
              String(err)
            }`,
          );
        });
      });
    }

    const snapshotForClass = topologyMatch?.snapshot ??
      latestTopology?.snapshot;
    const machineClass = resolveServerMachineClass(
      planRow?.machineClass,
      snapshotForClass,
      sample.hardwareSignals.length,
    );
    if (
      planRow !== undefined &&
      !isServerMachineClass(planRow.machineClass) &&
      machineClass === "physical"
    ) {
      // Persist the inference only when it is proof (sensors discovered) and
      // only while the column is still undeclared, so an operator edit that
      // races this guess wins. `'virtual'` is never written back: it is only
      // absence of proof, and pinning it would stop a sensor found by a later
      // topology generation from promoting the host. Fire-and-forget, like
      // `markTopologyResyncRequested` above.
      db.update(server)
        .set({ machineClass: "physical" })
        .where(and(eq(server.id, serverId), isNull(server.machineClass)))
        .catch((err) => {
          rateLimitedMetricsLog(serverId, "machine_class_record_failed", () => {
            console.warn(
              `metrics machine class record failed for ${serverId}: ${
                String(err)
              }`,
            );
          });
        });
    }

    const serverOptions = parseServerOptions(planRow?.serverOptions) ??
      undefined;
    const orgOptions: OrganizationOptions = parseOrganizationOptions(
      planRow?.orgOptions,
    );

    const plan = resolveEffectiveMetricsCapabilityPlan(
      machineClass,
      orgOptions,
      serverOptions,
      deployment,
      planRow?.tier,
    );

    const slotMapping = resolveSlotMappingForIngest(
      serverId,
      topologyMatch?.snapshot,
      planRow?.serverMetadata,
    );

    let generation: number | undefined;
    let planChanged = false;
    // Self-hosted ingest writes the operator's own disk uncapped — never
    // persist or push a finite plan the daemon would then truncate against.
    if (deployment !== "self-hosted") {
      try {
        const recorded = await recordCapabilityPlanGenerationIfChanged(
          db,
          serverId,
          plan,
        );
        generation = recorded.generation;
        planChanged = recorded.changed;
      } catch (err) {
        rateLimitedMetricsLog(serverId, "capability_plan_record_failed", () => {
          console.warn(
            `metrics capability plan record failed for ${serverId}: ${
              String(err)
            }`,
          );
        });
      }
    }

    return { plan, slotMapping, generation, planChanged };
  } catch (err) {
    rateLimitedMetricsLog(serverId, "capability_plan_resolve_failed", () => {
      console.warn(
        `metrics capability plan resolution failed for ${serverId}: ${
          String(err)
        }`,
      );
    });
    return {
      plan: resolveDefaultMetricsCapabilityPlan(deployment),
      slotMapping: undefined,
    };
  }
}

/**
 * Enroll-time outbox prime: record generation 0 (or the current plan) and
 * enqueue `capability-plan-update` for the next attach. Skipped for
 * self-hosted — those daemons must keep sending the full sample. Fire-and-
 * forget: enroll still returns `{ serverId, keyId }` if this fails.
 */
async function primeCapabilityPlanAfterEnroll(
  db: Db,
  registry: ReturnType<typeof getDaemonCellRegistry>,
  serverId: string,
  deployment: MetricsDeploymentKind,
): Promise<void> {
  if (deployment === "self-hosted") return;
  try {
    // The server just bound a license: place it before reading its plan.
    await recomputeAssignmentsForServer(db, serverId);
    const planRow = await loadIngestServerPlanRow(db, serverId, deployment);
    const machineClass = resolveServerMachineClass(
      planRow?.machineClass,
      undefined,
      0,
    );
    const plan = resolveEffectiveMetricsCapabilityPlan(
      machineClass,
      parseOrganizationOptions(planRow?.orgOptions),
      parseServerOptions(planRow?.serverOptions) ?? undefined,
      deployment,
      planRow?.tier,
    );
    const recorded = await recordCapabilityPlanGenerationIfChanged(
      db,
      serverId,
      plan,
    );
    await enqueueCapabilityPlanUpdate(
      registry,
      serverId,
      plan,
      recorded.generation,
    );
  } catch (err) {
    console.warn(
      `capability plan enroll prime failed for ${serverId}: ${String(err)}`,
    );
  }
}

/**
 * Daemon-facing surface: endpoints remote daemons and the node installer call.
 * Mounted under {@link DAEMON_API_PREFIX} (`/api/daemon/v1`).
 */
/**
 * Variables published by the daemon JWT middleware chain. Declared here (not in
 * `AppEnv`) because only the daemon surface sets them — `requireDaemonJwt` runs
 * before every route that reads them, so they are non-optional for handlers.
 */
type DaemonApiEnv = {
  Variables: {
    daemonServerId: string;
    daemonKeyId: string;
    daemonTokenId: string;
  };
};

export function registerDaemonApiRoutes<E extends Env>(
  app: Hono<E>,
  options: {
    secrets?: DaemonJwtKeyring;
    challengeSigningSecrets?: DerivedSecretsConfig;
    secretsConfig?: SecretsConfig;
    restLimiter?: RateLimiter;
    metricsLimiter?: RateLimiter;
    /**
     * Which runtime hosts this instance — decides the metrics capability
     * plan's deployment defaults (`metricsDeploymentKindForRuntime`: a
     * self-hosted Deno instance is not NIC-metered). Defaults to the hosted
     * (`'workers'`) behavior so a caller that doesn't say never silently
     * unlocks the self-hosted ceiling — production registrars pass it
     * explicitly.
     */
    runtime?: "workers" | "deno";
  } = {},
) {
  const daemon = new Hono<DaemonApiEnv>();
  const { secrets, challengeSigningSecrets, secretsConfig } = options;
  const runtime = options.runtime ?? "workers";
  const deployment = metricsDeploymentKindForRuntime(runtime);
  const metricsChartCache = createMetricsChartCache(runtime);
  const restLimiter = options.restLimiter ?? createNoopRateLimiter();
  const metricsLimiter = options.metricsLimiter ?? createNoopRateLimiter();
  const enrollStore = challengeSigningSecrets
    ? createStatelessChallengeStore(
      challengeSigningSecrets,
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    )
    : null;
  const authStore = challengeSigningSecrets
    ? createStatelessChallengeStore(
      challengeSigningSecrets,
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    )
    : null;

  async function enforceDaemonRestLimit(
    c: Context,
    key: string,
  ): Promise<Response | null> {
    const { success } = await restLimiter.limit({ key });
    if (!success) {
      return c.json({ ok: false, error: "rate_limited" }, 429);
    }
    return null;
  }

  async function enforceDaemonMetricsLimit(
    c: Context,
    serverId: string,
  ): Promise<Response | null> {
    const { success } = await metricsLimiter.limit({
      key: daemonMetricsRateLimitKey(serverId),
    });
    if (!success) {
      return c.json({ ok: false, error: "rate_limited" }, 429);
    }
    return null;
  }

  /** Auth-challenge path when the daemon already has serverId + keyId. */
  async function issueServerKeyAuthChallenge(
    c: Context,
    serverIdRaw: string | undefined,
    keyIdRaw: string | undefined,
  ): Promise<Response> {
    const serverId = serverIdRaw?.trim();
    const keyId = keyIdRaw?.trim();
    if (!serverId || !keyId) {
      return c.json({ ok: false, error: "Missing serverId or keyId" }, 400);
    }

    const limited = await enforceDaemonRestLimit(
      c,
      daemonRestRateLimitKey(serverId, "auth-challenge"),
    );
    if (limited) return limited;

    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const keyState = await loadActiveDaemonKeyState(db, serverId, keyId);
    if (!keyState.ok) {
      return c.json({ ok: false, error: keyState.error }, keyState.status);
    }

    if (!authStore) {
      return c.json({ ok: false, error: "Challenge unavailable" }, 503);
    }
    const challenge = await authStore.issue({ serverId, keyId });
    return c.json(
      {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        at: challenge.at,
        expiresAt: challengeExpiresAt(challenge.at, authStore.ttlMs),
      },
      200,
    );
  }

  const requireDaemonJwt = async (c: Context<DaemonApiEnv>, next: Next) => {
    if (!secrets) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!token) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    const payload = await verifyDaemonJwt(token, secrets);
    if (!payload) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    c.set("daemonServerId", payload.sub);
    c.set("daemonKeyId", payload.kid);
    c.set("daemonTokenId", payload.jti);
    return next();
  };

  /**
   * Reject JWTs whose sub/kid no longer match an active daemon key (e.g. after
   * license invalidation). Applied to cost-sensitive routes after JWT verify
   * and rate limiting so limiter tests can still exercise 429 without a DB.
   * When no DB is bound (unit tests), JWT signature/expiry alone gate the route.
   */
  const requireActiveDaemonKey = async (
    c: Context<DaemonApiEnv>,
    next: Next,
  ) => {
    const db = getDb(c);
    if (db === undefined) {
      return next();
    }
    const serverId = c.get("daemonServerId");
    const keyId = c.get("daemonKeyId");
    const keyState = await loadActiveDaemonKeyState(db, serverId, keyId);
    if (!keyState.ok) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    return next();
  };

  // Co-located self-hosted daemons poll this before opening the daemon WS.
  // Returns 503 until the install wizard has created org + superadmin.
  daemon.get("/readiness", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const installed = await isInstanceInstalled(db);
    if (!installed) {
      return c.json({ ok: true, ready: false, needsInstall: true }, 503);
    }

    return c.json({ ok: true, ready: true });
  });

  // Platform CA PEM — daemons add this to their trust store before dialing in.
  daemon.get("/instance/ca", async (c) => {
    // The Workers runtime has no `Deno` global and no filesystem, so it cannot
    // read the CA from disk. In co-located Workers dev the platform CA PEM is
    // injected (base64) into the Worker env; production Workers use publicly
    // trusted certs and have no platform CA to serve.
    if (typeof Deno === "undefined") {
      const env = c.env as { TURBOPANEL_TLS_CA_PEM_B64?: string } | undefined;
      const b64 = env?.TURBOPANEL_TLS_CA_PEM_B64?.trim();
      if (!b64) {
        return c.json({ error: "platform CA not configured" }, 404);
      }
      try {
        const pem = atob(b64);
        return c.body(pem, 200, { "content-type": "application/x-pem-file" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
    }
    try {
      const cert = await Deno.readTextFile(resolveInstanceTlsCaServePath());
      return c.body(cert, 200, { "content-type": "application/x-pem-file" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  daemon.get("/jwks.json", (c) => {
    if (!secrets) {
      return c.json({ ok: false, error: "jwks unavailable" }, 503);
    }
    return c.json(buildJwksDocument(secrets), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  daemon.get("/openapi.json", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(getDaemonOpenApiSpec(origin));
  });

  daemon.get("/reference", (c) => {
    return c.html(buildDaemonScalarHtml("/api/daemon/v1/openapi.json"));
  });

  daemon.post("/auth/challenge", async (c) => {
    const lengthReject = rejectIfContentLengthTooLarge(
      c,
      MAX_AUTH_CHALLENGE_BODY_BYTES,
    );
    if (lengthReject) return lengthReject;

    // Anonymous enrollment challenges have empty/near-empty bodies — rate-limit
    // before reading so an oversized flood still hits the enroll-challenge bucket.
    const declaredLength = Number(c.req.header("content-length") ?? "");
    const bodyAbsent = !c.req.raw.body;
    const looksAnonymous = bodyAbsent ||
      (Number.isFinite(declaredLength) && declaredLength <= 2);
    if (looksAnonymous) {
      const enrollChallengeLimited = await enforceDaemonRestLimit(
        c,
        daemonEnrollChallengeRateLimitKey(),
      );
      if (enrollChallengeLimited) return enrollChallengeLimited;
    }

    const bodyRead = await readBoundedJsonBody(
      c,
      MAX_AUTH_CHALLENGE_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;

    let body: { serverId?: string; keyId?: string } = {};
    if (bodyRead.text.trim()) {
      try {
        body = JSON.parse(bodyRead.text) as {
          serverId?: string;
          keyId?: string;
        };
      } catch {
        body = {};
      }
    }

    if (body.keyId || body.serverId) {
      return issueServerKeyAuthChallenge(c, body.serverId, body.keyId);
    }

    if (!looksAnonymous) {
      const enrollChallengeLimited = await enforceDaemonRestLimit(
        c,
        daemonEnrollChallengeRateLimitKey(),
      );
      if (enrollChallengeLimited) return enrollChallengeLimited;
    }

    if (!enrollStore) {
      return c.json({ ok: false, error: "Challenge unavailable" }, 503);
    }
    const challenge = await enrollStore.issue();
    return c.json(
      {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        at: challenge.at,
        expiresAt: challengeExpiresAt(challenge.at, enrollStore.ttlMs),
      },
      200,
    );
  });

  daemon.post("/enroll", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const bodyRead = await readBoundedJsonBody(c, MAX_ENROLL_BODY_BYTES);
    if (!bodyRead.ok) return bodyRead.response;

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(bodyRead.text || "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    const parsedFields = parseEnrollFields(body);
    if (!parsedFields.ok) {
      return c.json(
        { ok: false, error: parsedFields.error },
        parsedFields.status,
      );
    }
    const {
      licenseId,
      licenseToken,
      hostname,
      challengeId,
      signature,
      publicJwk,
      machineKey,
      serverIdBody,
    } = parsedFields.value;

    const enrollLimited = await enforceDaemonRestLimit(
      c,
      daemonRestRateLimitKey(licenseId, "enroll"),
    );
    if (enrollLimited) return enrollLimited;

    if (!enrollStore) {
      return c.json({ ok: false, error: "Challenge unavailable" }, 503);
    }
    const challenge = await enrollStore.consume({ challengeId });
    if (!challenge) {
      return c.json({ ok: false, error: "Invalid or expired challenge" }, 400);
    }

    const verifiedLicense = await verifyDaemonLicense(
      db,
      licenseId,
      licenseToken,
    );
    if (!verifiedLicense) {
      return c.json({ ok: false, error: "Invalid license" }, 401);
    }

    const fingerprint = await computePublicKeyFingerprint(publicJwk);
    const payload = buildEnrollmentPayload({
      challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineKey: machineKey ?? "",
      hostname,
      publicKeyFingerprint: fingerprint,
    });
    const verified = await verifyDaemonSignature(publicJwk, payload, signature);
    if (!verified) {
      return c.json({ ok: false, error: "Invalid signature" }, 403);
    }

    // Same gate on both runtimes. Self-hosted grants itself the coverage
    // first (`self-hosted-grant.ts`), so the check passes there by being
    // entitled rather than by being skipped — and the row it writes is what
    // still covers this server after a switch to the hosted runtime.
    if (deployment === "self-hosted") {
      await syncSelfHostedGrantForLicense(db, licenseId);
    }
    const tierGate = await evaluateHostedEnrollmentTier(db, licenseId);
    if (!tierGate.ok) {
      return c.json({ ok: false, error: tierGate.error }, 400);
    }

    const fabricDeps = enrollFabricDepsFromContext(c);
    const enrolled = await finalizeDaemonEnrollment(db, {
      serverIdBody,
      machineKey,
      hostname,
      licenseId,
      licenseToken,
      fingerprint,
      publicJwk,
      ...(fabricDeps ? { fabricDeps } : {}),
    });
    if (!enrolled.ok) {
      return c.json({ ok: false, error: enrolled.error }, enrolled.status);
    }

    void primeCapabilityPlanAfterEnroll(
      db,
      getDaemonCellRegistry(c),
      enrolled.serverId,
      deployment,
    );

    return c.json({ serverId: enrolled.serverId, keyId: enrolled.keyId }, 200);
  });

  daemon.post("/auth/session", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    if (!secrets) {
      return c.json({ ok: false, error: "Daemon auth unavailable" }, 503);
    }

    const bodyRead = await readBoundedJsonBody(c, MAX_AUTH_SESSION_BODY_BYTES);
    if (!bodyRead.ok) return bodyRead.response;

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(bodyRead.text || "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    const parsedFields = parseAuthSessionFields(body);
    if (!parsedFields.ok) {
      return c.json(
        { ok: false, error: parsedFields.error },
        parsedFields.status,
      );
    }
    const { serverId, keyId, challengeId, signature, hostname, machineKey } =
      parsedFields.value;

    const sessionLimited = await enforceDaemonRestLimit(
      c,
      daemonRestRateLimitKey(serverId, "auth-session"),
    );
    if (sessionLimited) return sessionLimited;

    const keyState = await loadActiveDaemonKeyState(db, serverId, keyId);
    if (!keyState.ok) {
      return c.json({ ok: false, error: keyState.error }, keyState.status);
    }

    const licenseState = await checkServerLicenseEntitlement(
      db,
      serverId,
      deployment,
    );
    if (!licenseState.ok) {
      return c.json(
        { ok: false, error: licenseState.error },
        licenseState.status,
      );
    }

    if (!authStore) {
      return c.json({ ok: false, error: "Challenge unavailable" }, 503);
    }
    const challenge = await authStore.consume({
      challengeId,
      serverId,
      keyId,
    });
    if (!challenge) {
      return c.json({ ok: false, error: "Invalid or expired challenge" }, 400);
    }

    const payload = buildAuthPayload({
      challengeId,
      nonce: challenge.nonce,
      serverId,
      keyId,
      machineKey: machineKey ?? "",
      hostname,
    });
    const verified = await verifyDaemonSignature(
      keyState.daemonState.key.publicJwk,
      payload,
      signature,
    );
    if (!verified) {
      return c.json({ ok: false, error: "Invalid signature" }, 403);
    }

    await touchDaemonKeyLastUsed(db, serverId);
    await touchServerMetadata(db, serverId, { machineKey, hostname });

    const issued = await issueDaemonJwt({ sub: serverId, kid: keyId }, secrets);
    return c.json(
      {
        token: issued.token,
        expiresAt: issued.expiresAt,
      },
      200,
    );
  });

  const enforceJwtRestLimit =
    (route: DaemonRestRateLimitRoute) =>
    async (c: Context<DaemonApiEnv>, next: Next) => {
      const daemonServerId = c.get("daemonServerId");
      const limited = await enforceDaemonRestLimit(
        c,
        daemonRestRateLimitKey(daemonServerId, route),
      );
      if (limited) return limited;
      return next();
    };

  const enforceJwtMetricsLimit = async (
    c: Context<DaemonApiEnv>,
    next: Next,
  ) => {
    const daemonServerId = c.get("daemonServerId");
    const limited = await enforceDaemonMetricsLimit(c, daemonServerId);
    if (limited) return limited;
    return next();
  };

  daemon.post(
    "/commands/lease",
    requireDaemonJwt,
    enforceJwtRestLimit("commands-lease"),
    (c) => {
      return c.json({ commands: [] }, 200);
    },
  );

  /**
   * Command transcript ingest. The daemon streams stdout/stderr here in
   * `(seq, base64 bytes)` chunks while a command runs; the store compacts them
   * into one gzipped object when the command reaches a terminal status.
   *
   * Shares `DAEMON_REST_RATE_LIMITER` (per-server scoped) with the other JWT
   * REST routes — transcripts are bursty but always attributable to one server.
   */
  daemon.post(
    "/commands/:commandId/log",
    requireDaemonJwt,
    enforceJwtRestLimit("commands-log"),
    requireActiveDaemonKey,
    async (c) => {
      const daemonServerId = c.get("daemonServerId");
      const commandId = normalizeRequiredString(c.req.param("commandId"));
      if (!commandId) {
        return c.json({ ok: false, error: "Missing commandId" }, 400);
      }

      const store = getExecutionLogStore(c);
      if (!store) {
        return c.json({ ok: false, error: "execution logs unavailable" }, 503);
      }

      const db = getDb(c);
      if (db === undefined) {
        return c.json({ ok: false, error: "Database unavailable" }, 503);
      }

      const target = await loadExecutionLogCommandTarget(db, commandId);
      // 403 (not 404) for both unknown and foreign commands: a daemon must not
      // be able to probe which command ids exist on other servers.
      if (target?.serverId !== daemonServerId) {
        return c.json({ ok: false, error: "forbidden" }, 403);
      }

      const bodyRead = await readBoundedJsonBody(
        c,
        MAX_EXECUTION_LOG_CHUNK_BODY_BYTES,
      );
      if (!bodyRead.ok) return bodyRead.response;

      let body: unknown;
      try {
        body = JSON.parse(bodyRead.text);
      } catch {
        return c.json({ ok: false, error: "invalid json" }, 400);
      }

      const parsed = parseExecutionLogChunkBody(body);
      if (!parsed.ok) {
        return c.json({ ok: false, error: parsed.error }, 400);
      }

      try {
        // A terminal-but-unsealed command still accepts the final chunk it
        // raced with; the store's sealed check is the real gate.
        const result = await store.appendChunk(commandId, {
          seq: parsed.seq,
          bytes: parsed.bytes,
        });
        if (target.terminal) {
          // The transition already ran `sealExecutionLogOnTerminal()`, which
          // no-ops when no index exists yet. A chunk that lands afterwards
          // would otherwise stay unsealed forever, so compact it here —
          // best effort, exactly like the transition path: a storage failure
          // must not reject an accepted chunk.
          await sealExecutionLogOnTerminal(commandId, store);
        }
        return c.json({ ok: true, nextSeq: result.nextSeq }, 202);
      } catch (err) {
        if (err instanceof ExecutionLogGapError) {
          return c.json(
            {
              ok: false,
              error: "seq gap",
              nextSeq: err.expectedSeq,
            },
            409,
          );
        }
        if (err instanceof ExecutionLogSealedError) {
          return c.json({ ok: false, error: "log sealed" }, 409);
        }
        throw err;
      }
    },
  );

  // Must never call env.DAEMON_CELL.getByName or touch the Durable Object —
  // metrics writes go straight to the Analytics Engine / DuckDB store.
  daemon.post(
    "/metrics",
    requireDaemonJwt,
    enforceJwtMetricsLimit,
    requireActiveDaemonKey,
    async (c) => {
      const serverId = c.get("daemonServerId");

      const lengthReject = rejectIfContentLengthTooLarge(
        c,
        MAX_METRICS_PAYLOAD_BYTES,
      );
      if (lengthReject) return lengthReject;

      const bodyRead = await readRequestBodyWithLimit(
        c,
        MAX_METRICS_PAYLOAD_BYTES,
      );
      if (!bodyRead.ok) {
        return c.json({ ok: false, error: "request body too large" }, 413);
      }
      const raw = bodyRead.text;
      const payloadBytes = metricsPayloadByteLength(raw);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        rateLimitedMetricsLog(serverId, "invalid metrics payload", (reason) => {
          console.warn(
            `metrics ignored invalid sample from ${serverId}: ${reason}`,
          );
        });
        return c.json({ ok: false, error: "invalid metrics payload" }, 400);
      }

      const result = validateMetricsSample(parsed, {
        serverId,
        receivedAt: new Date().toISOString(),
        payloadBytes,
      });
      if (!result.ok) {
        rateLimitedMetricsLog(serverId, result.reason, (reason) => {
          console.warn(
            `metrics ignored invalid sample from ${serverId}: ${reason}`,
          );
        });
        return c.json({ ok: false, error: result.reason }, 400);
      }

      // Resolve the effective capability plan from persisted server/org
      // state and reconcile the reported topology generation against
      // history — both best-effort: a DB error here must never turn a
      // validated sample into a 500, so ingestion always falls back to the
      // conservative platform-default plan (see
      // `resolveIngestPlanAndReconcileTopology`).
      const db = getDb(c);
      const { plan, slotMapping, generation, planChanged } = db
        ? await resolveIngestPlanAndReconcileTopology(
          db,
          serverId,
          result.sample,
          deployment,
        )
        : {
          plan: resolveDefaultMetricsCapabilityPlan(deployment),
          slotMapping: undefined,
        };

      if (planChanged && generation !== undefined) {
        void enqueueCapabilityPlanUpdate(
          getDaemonCellRegistry(c),
          serverId,
          plan,
          generation,
        );
      }

      // Hosted ingest truncates to the capability plan; self-hosted writes
      // the operator's own disk uncapped. Topology `slotMapping` is still
      // resolved above for identity-addressed packing.
      const prepared = deployment === "self-hosted"
        ? result.sample
        : truncateSampleToCapabilityPlan(result.sample, plan, slotMapping);
      const sample = {
        ...prepared,
        serverId,
        receivedAt: result.sample.receivedAt,
        ...(generation === undefined
          ? {}
          : { capabilityPlanGeneration: generation }),
      };

      const store = getServerMetricsStore(c) ??
        new DisabledServerMetricsStore();
      const logWriteFailed = (err: unknown) => {
        rateLimitedMetricsLog(serverId, "write_failed", () => {
          console.warn(`metrics write failed for ${serverId}: ${String(err)}`);
        });
      };

      const liveSessionActive = await isServerLiveSessionActive(
        metricsChartCache,
        serverId,
      );
      if (liveSessionActive) {
        await cacheLiveSample(metricsChartCache, sample);
        return c.json({ ok: true }, 202);
      }

      // Backstop: a 10 s live sample whose marker expired/raced must not
      // land in AE/DuckDB. Priming (~2 s) and baseline (60 s ± jitter) still
      // write. Fail open to a no-op, same discipline as `logWriteFailed`.
      if (isUnmarkedLiveCadenceInterval(sample.metadata.intervalSeconds)) {
        rateLimitedMetricsLog(serverId, "live_sample_unmarked", () => {
          console.warn(
            `metrics skipped durable write for ${serverId}: interval ${sample.metadata.intervalSeconds}s below baseline without an active live session`,
          );
        });
        return c.json({ ok: true }, 202);
      }

      // Fire-and-forget per `ServerMetricsStore`'s contract (types.ts) —
      // callers must never await a write into the request path. Only a
      // synchronous throw needs its own catch; an async rejection is
      // handled by `.catch` on the returned promise.
      try {
        Promise.resolve(store.writeSample(sample, slotMapping)).catch(
          logWriteFailed,
        );
      } catch (err) {
        logWriteFailed(err);
      }

      return c.json({ ok: true }, 202);
    },
  );

  // Recipient-bound daemon envelopes only — JWT sub/kid must match envelope metadata.
  daemon.post(
    "/secrets/decrypt",
    requireDaemonJwt,
    enforceJwtRestLimit("secrets-decrypt"),
    requireActiveDaemonKey,
    async (c) => {
      if (!secretsConfig) {
        return c.json({ ok: false, error: "decryption unavailable" }, 503);
      }

      const daemonServerId = c.get("daemonServerId");
      const daemonKeyId = c.get("daemonKeyId");

      const bodyRead = await readBoundedJsonBody(
        c,
        MAX_SECRETS_DECRYPT_BODY_BYTES,
      );
      if (!bodyRead.ok) return bodyRead.response;

      let body: { ciphertexts?: unknown };
      try {
        body = JSON.parse(bodyRead.text) as { ciphertexts?: unknown };
      } catch {
        return c.json({ ok: false, error: "invalid json" }, 400);
      }

      if (!Array.isArray(body.ciphertexts)) {
        return c.json(
          { ok: false, error: "ciphertexts must be an array" },
          400,
        );
      }
      if (
        body.ciphertexts.length === 0 ||
        body.ciphertexts.length > MAX_SECRETS_DECRYPT_BATCH
      ) {
        return c.json(
          {
            ok: false,
            error: `ciphertexts length must be 1-${MAX_SECRETS_DECRYPT_BATCH}`,
          },
          400,
        );
      }
      for (const entry of body.ciphertexts) {
        if (typeof entry !== "string") {
          return c.json(
            { ok: false, error: "ciphertexts must be strings" },
            400,
          );
        }
        if (entry.length > MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS) {
          return c.json(
            {
              ok: false,
              error:
                `ciphertext exceeds ${MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS} chars`,
            },
            400,
          );
        }
      }

      const recipient = { serverId: daemonServerId, keyId: daemonKeyId };

      // Sequential decryption — bounded work, no unbounded parallelism over the
      // whole batch (each entry does an AES-GCM decrypt of daemon key material).
      const plaintexts: (string | null)[] = [];
      for (const ciphertext of body.ciphertexts as string[]) {
        plaintexts.push(
          await decryptDaemonCiphertext(secretsConfig, recipient, ciphertext),
        );
      }

      return c.json({ plaintexts }, 200);
    },
  );

  daemon.post(
    "/deployments/secrets/rehydrate",
    requireDaemonJwt,
    enforceJwtRestLimit("secrets-rehydrate"),
    requireActiveDaemonKey,
    async (c) => {
      const db = getDb(c);
      if (!db) {
        return c.json({ ok: false, error: "database unavailable" }, 503);
      }
      const bodyRead = await readBoundedJsonBody(
        c,
        MAX_SECRETS_DECRYPT_BODY_BYTES,
      );
      if (!bodyRead.ok) return bodyRead.response;
      let body: unknown;
      try {
        body = JSON.parse(bodyRead.text) as unknown;
      } catch {
        return c.json({ ok: false, error: "invalid json" }, 400);
      }
      const result = await buildDeploymentSecretsRehydrate(c, db, body);
      if (result instanceof Response) return result;
      return c.json({ ok: true, ...result }, 200);
    },
  );

  app.route(DAEMON_API_PREFIX, daemon);
  return app;
}
