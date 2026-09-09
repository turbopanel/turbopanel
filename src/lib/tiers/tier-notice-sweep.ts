/**
 * Hosted daily nag: classify servers whose license rank sits below the
 * recommended placement (unwatched devices) or materially above it
 * (overprovisioned), then email org owners through the injected queue.
 *
 * Hosted only. Self-hosted short-circuits. Throttle lives on
 * `server.metadata.tierNotice` (system-owned bag — never `server.options`).
 */
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { grant, license, server, setting, tier, user } from "../db/schema.ts";
import type { EmailQueue } from "../email/types.ts";
import type { MetricsDeploymentKind } from "../../daemon/metrics/capability-plan.ts";
import {
  loadServerLicenseTierJoins,
  parseTopologySnapshot,
  placementFromJoinRow,
  type ServerLicenseTierJoinRow,
  type TierPlacementEvaluation,
  type TierUnwatchedIds,
} from "./tier-enforcement.ts";
import { getLatestTopologyGenerations } from "../../client/servers/server-topology-records.ts";

export const TIER_NOTICE_SWEEP_LIMIT = 100;
export const TIER_NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000;
const DENO_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Durable `setting.key` for the wrap-around eligible-server cursor. */
export const TIER_NOTICE_SWEEP_CURSOR_KEY = "TIER_NOTICE_SWEEP_CURSOR";

export type TierNoticeKind = "exceeds" | "overprovisioned";

export type TierNoticeMarker = {
  kind: TierNoticeKind;
  digest: string;
  lastNotifiedAt: string;
};

let lastElapsedGateAtMs = 0;

export function resetTierNoticeSweepGateForTests(): void {
  lastElapsedGateAtMs = 0;
}

export function classifyTierNotice(
  placement: TierPlacementEvaluation,
): TierNoticeKind | null {
  if (placement.licenseRank == null) return null;
  if (placement.licenseRank < placement.recommendedRank) return "exceeds";
  if (placement.recommendedRank < placement.licenseRank) {
    return "overprovisioned";
  }
  return null;
}

export function tierNoticeDigest(
  kind: TierNoticeKind,
  placement: Pick<
    TierPlacementEvaluation,
    "requiredLabel" | "recommendedLabel" | "unwatched"
  >,
): string {
  const unwatched = placement.unwatched;
  return [
    kind,
    placement.requiredLabel,
    placement.recommendedLabel,
    unwatched.nics.join(","),
    unwatched.drives.join(","),
    unwatched.gpus.join(","),
  ].join("|");
}

export function parseTierNoticeMarker(
  metadata: unknown,
): TierNoticeMarker | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  if (Array.isArray(metadata)) return undefined;
  const raw = (metadata as Record<string, unknown>).tierNotice;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== "exceeds" && record.kind !== "overprovisioned") {
    return undefined;
  }
  if (typeof record.digest !== "string" || record.digest.length === 0) {
    return undefined;
  }
  if (
    typeof record.lastNotifiedAt !== "string" ||
    record.lastNotifiedAt.length === 0
  ) {
    return undefined;
  }
  return {
    kind: record.kind,
    digest: record.digest,
    lastNotifiedAt: record.lastNotifiedAt,
  };
}

export function shouldSendTierNotice(input: {
  kind: TierNoticeKind;
  digest: string;
  marker: TierNoticeMarker | undefined;
  nowMs: number;
}): boolean {
  if (!input.marker) return true;
  if (input.marker.digest !== input.digest) return true;
  const last = Date.parse(input.marker.lastNotifiedAt);
  if (!Number.isFinite(last)) return true;
  return input.nowMs - last >= TIER_NOTICE_THROTTLE_MS;
}

function consoleUrlFor(
  baseUrl: string | undefined,
  organizationId: string,
  serverId: string,
): string {
  const base = (baseUrl ?? "").replace(/\/$/, "");
  if (!base) return `/${organizationId}/servers/${serverId}`;
  return `${base}/${organizationId}/servers/${serverId}`;
}

async function loadOrgOwnerEmails(
  db: Db,
  organizationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byOrg = new Map<string, string[]>();
  if (organizationIds.length === 0) return byOrg;
  const rows = await db
    .select({
      organizationId: grant.entityId,
      email: user.email,
    })
    .from(grant)
    .innerJoin(user, eq(user.id, grant.actorId))
    .where(and(
      eq(grant.entityType, "organization"),
      eq(grant.actorType, "user"),
      eq(grant.permission, "organization:own"),
      inArray(grant.entityId, [...organizationIds]),
      eq(user.isEmailVerified, true),
    ));
  for (const row of rows) {
    const list = byOrg.get(row.organizationId) ?? [];
    list.push(row.email);
    byOrg.set(row.organizationId, list);
  }
  return byOrg;
}

async function writeTierNoticeMarker(
  db: Db,
  serverId: string,
  marker: TierNoticeMarker | null,
): Promise<void> {
  if (marker === null) {
    await db
      .update(server)
      .set({
        metadata:
          sql`(COALESCE(${server.metadata}, '{}'::jsonb) - 'tierNotice')`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(server.id, serverId));
    return;
  }
  await db
    .update(server)
    .set({
      metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
        JSON.stringify({ tierNotice: marker })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(server.id, serverId));
}

function parseTierNoticeSweepCursor(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const afterId = (value as Record<string, unknown>).afterId;
  if (typeof afterId !== "string" || afterId.length === 0) return null;
  return afterId;
}

async function readTierNoticeSweepCursor(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, TIER_NOTICE_SWEEP_CURSOR_KEY))
    .limit(1);
  return parseTierNoticeSweepCursor(row?.value);
}

async function writeTierNoticeSweepCursor(
  db: Db,
  afterId: string | null,
): Promise<void> {
  const value = { afterId };
  await db
    .insert(setting)
    .values({
      key: TIER_NOTICE_SWEEP_CURSOR_KEY,
      value,
    })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value,
        updatedAt: new Date().toISOString(),
      },
    });
}

async function selectEligibleServersAfter(
  db: Db,
  afterId: string | null,
  limit: number,
): Promise<{ id: string }[]> {
  const query = db
    .select({ id: server.id })
    .from(server)
    .innerJoin(
      license,
      and(eq(license.serverId, server.id), isNull(license.revokedAt)),
    )
    .innerJoin(tier, eq(tier.id, server.assignedTierId));
  const filtered = afterId ? query.where(gt(server.id, afterId)) : query;
  return await filtered.orderBy(server.id).limit(limit);
}

/**
 * Next wrap-around page of eligible server ids. Persists the last id as the
 * cursor so later maintenance ticks continue past the first page.
 */
export async function takeTierNoticeSweepBatch(
  db: Db,
  limit: number,
): Promise<string[]> {
  const afterId = await readTierNoticeSweepCursor(db);
  let rows = await selectEligibleServersAfter(db, afterId, limit);
  if (rows.length === 0 && afterId) {
    rows = await selectEligibleServersAfter(db, null, limit);
  }
  const nextAfterId = rows.at(-1)?.id ?? null;
  await writeTierNoticeSweepCursor(db, nextAfterId);
  return rows.map((row) => row.id);
}

export type SweepTierNoticesOpts = {
  db: Db;
  emailQueue: EmailQueue;
  deployment: MetricsDeploymentKind;
  nowMs?: number;
  /**
   * Workers already gates on `shouldSweepTierNotices` (hourly). Deno's 60 s
   * tick must not rescan every minute — the module elapsed-time gate covers
   * that unless this is set.
   */
  ignoreElapsedGate?: boolean;
  consoleBaseUrl?: string;
  fromAddress?: string;
  limit?: number;
};

export type SweepTierNoticesResult = {
  considered: number;
  sent: number;
};

async function notifyOwners(input: {
  emailQueue: EmailQueue;
  emails: readonly string[];
  fromAddress: string;
  row: ServerLicenseTierJoinRow;
  kind: TierNoticeKind;
  placement: TierPlacementEvaluation;
  unwatched: TierUnwatchedIds;
  consoleUrl: string;
}): Promise<number> {
  let sent = 0;
  for (const to of input.emails) {
    await input.emailQueue.enqueue({
      type: "server-tier-notice",
      to,
      from: input.fromAddress,
      kind: input.kind,
      serverName: input.row.serverName ?? "Server",
      organizationName: input.row.organizationName ?? "Organization",
      licenseTierLabel: input.placement.licenseLabel ?? "unassigned",
      requiredTierLabel: input.placement.requiredLabel,
      recommendedTierLabel: input.placement.recommendedLabel,
      unwatched: input.unwatched,
      consoleUrl: input.consoleUrl,
    });
    sent += 1;
  }
  return sent;
}

function elapsedGateBlocksSweep(
  ignoreElapsedGate: boolean | undefined,
  nowMs: number,
): boolean {
  if (ignoreElapsedGate) return false;
  if (
    lastElapsedGateAtMs > 0 &&
    nowMs - lastElapsedGateAtMs < DENO_SWEEP_INTERVAL_MS
  ) {
    return true;
  }
  lastElapsedGateAtMs = nowMs;
  return false;
}

async function applyTierNoticeForRow(input: {
  db: Db;
  emailQueue: EmailQueue;
  row: ServerLicenseTierJoinRow;
  snapshot: ReturnType<typeof parseTopologySnapshot>;
  deployment: MetricsDeploymentKind;
  owners: Map<string, string[]>;
  fromAddress: string;
  consoleBaseUrl: string | undefined;
  nowMs: number;
  nowIso: string;
}): Promise<number> {
  const placement = placementFromJoinRow(
    input.row,
    input.snapshot,
    input.deployment,
  );
  const kind = classifyTierNotice(placement);
  const marker = parseTierNoticeMarker(input.row.serverMetadata);

  if (!kind) {
    if (marker) await writeTierNoticeMarker(input.db, input.row.serverId, null);
    return 0;
  }

  const digest = tierNoticeDigest(kind, placement);
  if (!shouldSendTierNotice({ kind, digest, marker, nowMs: input.nowMs })) {
    return 0;
  }

  const emails = input.owners.get(input.row.organizationId) ?? [];
  if (emails.length === 0) return 0;

  const sent = await notifyOwners({
    emailQueue: input.emailQueue,
    emails,
    fromAddress: input.fromAddress,
    row: input.row,
    kind,
    placement,
    unwatched: placement.unwatched,
    consoleUrl: consoleUrlFor(
      input.consoleBaseUrl,
      input.row.organizationId,
      input.row.serverId,
    ),
  });
  await writeTierNoticeMarker(input.db, input.row.serverId, {
    kind,
    digest,
    lastNotifiedAt: input.nowIso,
  });
  return sent;
}

export async function sweepTierNotices(
  opts: SweepTierNoticesOpts,
): Promise<SweepTierNoticesResult> {
  if (opts.deployment === "self-hosted") {
    return { considered: 0, sent: 0 };
  }
  const nowMs = opts.nowMs ?? Date.now();
  if (elapsedGateBlocksSweep(opts.ignoreElapsedGate, nowMs)) {
    return { considered: 0, sent: 0 };
  }

  const limit = opts.limit ?? TIER_NOTICE_SWEEP_LIMIT;
  const serverIds = await takeTierNoticeSweepBatch(opts.db, limit);
  if (serverIds.length === 0) return { considered: 0, sent: 0 };

  const joins = await loadServerLicenseTierJoins(opts.db, serverIds);
  const eligible = serverIds.flatMap((id) => {
    const row = joins.get(id);
    return row ? [row] : [];
  });
  if (eligible.length === 0) return { considered: 0, sent: 0 };

  const topologyByServer = await getLatestTopologyGenerations(
    opts.db,
    eligible.map((row) => row.serverId),
  );
  const owners = await loadOrgOwnerEmails(
    opts.db,
    [...new Set(eligible.map((row) => row.organizationId))],
  );

  const fromAddress = opts.fromAddress ?? "noreply@turbopanel";
  const nowIso = new Date(nowMs).toISOString();
  let sent = 0;

  for (const row of eligible) {
    sent += await applyTierNoticeForRow({
      db: opts.db,
      emailQueue: opts.emailQueue,
      row,
      snapshot: parseTopologySnapshot(
        topologyByServer.get(row.serverId)?.snapshot,
      ),
      deployment: opts.deployment,
      owners,
      fromAddress,
      consoleBaseUrl: opts.consoleBaseUrl,
      nowMs,
      nowIso,
    });
  }

  return { considered: eligible.length, sent };
}
