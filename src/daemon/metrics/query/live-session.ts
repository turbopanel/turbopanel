/**
 * Live-session marker + short-lived live-sample buffer.
 *
 * Built on {@link MetricsChartCache} (Workers Cache API / bounded Deno Map,
 * fail-open). The marker tracks **per-lease ids** so concurrent viewers share
 * one ingest buffer: a single stop must not resume durable 10 s writes while
 * another lease is still active. Live samples are cached here during an
 * active lease and never written to Analytics Engine or DuckDB; query routes
 * overlay the buffered point on a now-tailed live-range read, and only while
 * the marker still has an unexpired lease.
 */
import type { MetricsSample } from "../contract.ts";
import {
  HOST_METRICS_METRIC_DESCRIPTORS,
  type MetricEntityScope,
} from "../metric-descriptors.ts";
import {
  type AuthenticatedMetricsSample,
  type EntitySeriesPoint,
  type EntitySeriesResult,
  type HostSeriesPoint,
  type HostSeriesResult,
  type HostSummaryResult,
  METRICS_LIVE_INTERVAL_SECONDS,
  type PerEntityHostedFamily,
} from "../types.ts";
import { bucketFloor } from "./buckets.ts";
import {
  METRICS_LIVE_10S_CACHE_TTL_SECONDS,
  METRICS_LIVE_SAMPLE_CACHE_PREFIX,
  METRICS_LIVE_SESSION_CACHE_PREFIX,
  type MetricsChartCache,
} from "./cache.ts";

type LiveSessionLease = { id: string; expiresAtMs: number };
type LiveSessionMarker = { leases: LiveSessionLease[] };

/**
 * A few seconds past the 10 s live cadence — the same 5 s discipline as
 * {@link METRICS_LIVE_10S_CACHE_TTL_SECONDS}.
 */
export const LIVE_SAMPLE_CACHE_TTL_SECONDS = METRICS_LIVE_INTERVAL_SECONDS +
  METRICS_LIVE_10S_CACHE_TTL_SECONDS;

function liveSessionKey(serverId: string): string {
  return `${METRICS_LIVE_SESSION_CACHE_PREFIX}${serverId}`;
}

function liveSampleKey(serverId: string): string {
  return `${METRICS_LIVE_SAMPLE_CACHE_PREFIX}${serverId}`;
}

function parseLeases(value: unknown, nowMs: number): LiveSessionLease[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as LiveSessionMarker).leases;
  if (!Array.isArray(raw)) return [];
  const leases: LiveSessionLease[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = (entry as { id?: unknown }).id;
    const expiresAtMs = (entry as { expiresAtMs?: unknown }).expiresAtMs;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) {
      continue;
    }
    if (expiresAtMs > nowMs) leases.push({ id, expiresAtMs });
  }
  return leases;
}

function ttlSecondsFor(leases: LiveSessionLease[], nowMs: number): number {
  const latest = Math.max(...leases.map((lease) => lease.expiresAtMs));
  return Math.max(1, Math.ceil((latest - nowMs) / 1000));
}

async function readActiveLeases(
  cache: MetricsChartCache,
  serverId: string,
  nowMs: number,
): Promise<LiveSessionLease[]> {
  const marker = await cache.get<LiveSessionMarker>(liveSessionKey(serverId));
  return parseLeases(marker, nowMs);
}

async function writeLeases(
  cache: MetricsChartCache,
  serverId: string,
  leases: LiveSessionLease[],
  nowMs: number,
): Promise<void> {
  if (leases.length === 0) {
    await cache.delete(liveSessionKey(serverId));
    await cache.delete(liveSampleKey(serverId));
    return;
  }
  await cache.set<LiveSessionMarker>(
    liveSessionKey(serverId),
    { leases },
    ttlSecondsFor(leases, nowMs),
  );
}

export async function markServerLiveSessionActive(
  cache: MetricsChartCache,
  serverId: string,
  leaseId: string,
  ttlSeconds: number,
): Promise<void> {
  const nowMs = Date.now();
  const leases = (await readActiveLeases(cache, serverId, nowMs)).filter(
    (lease) => lease.id !== leaseId,
  );
  leases.push({
    id: leaseId,
    expiresAtMs: nowMs + Math.max(0, ttlSeconds) * 1000,
  });
  await writeLeases(cache, serverId, leases, nowMs);
}

export async function isServerLiveSessionActive(
  cache: MetricsChartCache,
  serverId: string,
): Promise<boolean> {
  const leases = await readActiveLeases(cache, serverId, Date.now());
  return leases.length > 0;
}

export async function clearServerLiveSession(
  cache: MetricsChartCache,
  serverId: string,
  leaseId: string,
): Promise<void> {
  const nowMs = Date.now();
  const remaining = (await readActiveLeases(cache, serverId, nowMs)).filter(
    (lease) => lease.id !== leaseId,
  );
  await writeLeases(cache, serverId, remaining, nowMs);
}

export async function cacheLiveSample(
  cache: MetricsChartCache,
  sample: AuthenticatedMetricsSample,
): Promise<void> {
  await cache.set(
    liveSampleKey(sample.serverId),
    sample,
    LIVE_SAMPLE_CACHE_TTL_SECONDS,
  );
}

export async function readLiveSample(
  cache: MetricsChartCache,
  serverId: string,
): Promise<AuthenticatedMetricsSample | null> {
  if (!await isServerLiveSessionActive(cache, serverId)) return null;
  return await cache.get<AuthenticatedMetricsSample>(liveSampleKey(serverId));
}

/**
 * True when a query range's `to` is "now" — the live-session poll, not a
 * historical window.
 */
export function metricsRangeTailIsNow(
  toMs: number,
  nowMs = Date.now(),
  resolutionSeconds = METRICS_LIVE_INTERVAL_SECONDS,
): boolean {
  const windowMs = Math.max(resolutionSeconds, METRICS_LIVE_INTERVAL_SECONDS) *
    1000;
  return toMs >= nowMs - windowMs;
}

function asFieldRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function hostGroupForScope(
  sample: MetricsSample,
  entityScope: MetricEntityScope,
): Record<string, unknown> | undefined {
  switch (entityScope) {
    case "host.cpu":
      return asFieldRecord(sample.host.cpu);
    case "host.kernel":
      return asFieldRecord(sample.host.kernel);
    case "host.memory":
      return asFieldRecord(sample.host.memory);
    case "host.storage":
      return asFieldRecord(sample.host.storage);
    case "host.network":
      return asFieldRecord(sample.host.network);
    case "diagnostics":
      return sample.diagnostics ? asFieldRecord(sample.diagnostics) : undefined;
    case "router":
      return sample.router ? asFieldRecord(sample.router) : undefined;
    case "storage":
      return sample.storage ? asFieldRecord(sample.storage) : undefined;
    case "dockerUsage":
      return sample.dockerUsage ? asFieldRecord(sample.dockerUsage) : undefined;
    default:
      return undefined;
  }
}

function readNumericField(
  record: Record<string, unknown>,
  fieldName: string,
): number | null {
  const value = record[fieldName];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function hostValuesFromSample(
  sample: MetricsSample,
  metrics: readonly string[],
): Partial<Record<string, number | null>> {
  const values: Partial<Record<string, number | null>> = {};
  for (const name of metrics) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[name];
    if (!descriptor) continue;
    const group = hostGroupForScope(sample, descriptor.entityScope);
    if (!group) {
      values[name] = null;
      continue;
    }
    values[name] = readNumericField(group, descriptor.fieldName);
  }
  return values;
}

type SampleEntity = { id: string; record: Record<string, unknown> };

function sampleEntitiesForFamily(
  sample: MetricsSample,
  family: PerEntityHostedFamily,
): SampleEntity[] {
  switch (family) {
    case "gpu":
      return sample.gpus.map((gpu) => ({
        id: gpu.gpuId,
        record: asFieldRecord(gpu),
      }));
    case "network":
      return sample.networks.map((device) => ({
        id: device.deviceId,
        record: asFieldRecord(device),
      }));
    case "filesystem":
      return sample.filesystems.map((fs) => ({
        id: fs.filesystemId,
        record: asFieldRecord(fs),
      }));
    case "block":
      return sample.blockDevices.map((device) => ({
        id: device.deviceId,
        record: asFieldRecord(device),
      }));
    case "hardware.physical":
      return sample.hardwareSignals.map((signal) => ({
        id: signal.signalId,
        record: asFieldRecord(signal),
      }));
    case "managed.ingress":
      return sample.ingressSources.map((source) => ({
        id: source.sourceId,
        record: asFieldRecord(source),
      }));
    case "managed.database_proxy":
      return sample.databaseProxies.map((source) => ({
        id: source.sourceId,
        record: asFieldRecord(source),
      }));
  }
}

function entityValuesFromRecord(
  record: Record<string, unknown>,
  fields: readonly string[],
): Partial<Record<string, number | null>> {
  const values: Partial<Record<string, number | null>> = {};
  for (const field of fields) {
    values[field] = readNumericField(record, field);
  }
  return values;
}

function mergeTopologyGenerations(
  existing: readonly number[] | undefined,
  generation: number,
): number[] | undefined {
  const merged = new Set(existing ?? []);
  merged.add(generation);
  return [...merged].sort((a, b) => a - b);
}

function overlayPoint<P extends { at: string }>(
  points: P[],
  next: P,
  bucketMs: number,
): { points: P[]; appended: boolean } {
  const last = points.at(-1);
  const lastMs = last ? Date.parse(last.at) : Number.NEGATIVE_INFINITY;
  if (last && lastMs === bucketMs) {
    const nextPoints = [...points];
    nextPoints[nextPoints.length - 1] = next;
    return { points: nextPoints, appended: false };
  }
  if (!Number.isFinite(lastMs) || bucketMs > lastMs) {
    return { points: [...points, next], appended: true };
  }
  return { points, appended: false };
}

export function mergeLiveSampleIntoHostSeries(
  result: HostSeriesResult,
  sample: AuthenticatedMetricsSample,
  resolutionSeconds: number,
): HostSeriesResult {
  const atMs = Date.parse(sample.metadata.sampledAt);
  if (!Number.isFinite(atMs) || result.metrics.length === 0) return result;
  const bucketMs = bucketFloor(atMs, resolutionSeconds);
  const point: HostSeriesPoint = {
    at: new Date(bucketMs).toISOString(),
    values: hostValuesFromSample(sample, result.metrics),
    sampleCount: 1,
    expectedSampleCount: 1,
    topologyGeneration: sample.metadata.topologyGeneration,
  };
  const overlay = overlayPoint(result.points, point, bucketMs);
  if (overlay.points === result.points) return result;
  return {
    ...result,
    points: overlay.points,
    sampleCount: result.sampleCount + (overlay.appended ? 1 : 0),
    topologyGenerations: mergeTopologyGenerations(
      result.topologyGenerations,
      sample.metadata.topologyGeneration,
    ),
  };
}

export function mergeLiveSampleIntoEntitySeries(
  result: EntitySeriesResult,
  sample: AuthenticatedMetricsSample,
  resolutionSeconds: number,
): EntitySeriesResult {
  const atMs = Date.parse(sample.metadata.sampledAt);
  if (!Number.isFinite(atMs)) return result;
  const bucketMs = bucketFloor(atMs, resolutionSeconds);
  const at = new Date(bucketMs).toISOString();
  const liveById = new Map(
    sampleEntitiesForFamily(sample, result.family).map((
      entity,
    ) => [entity.id, entity.record]),
  );
  let changed = false;
  const entities = result.entities.map((entity) => {
    const record = liveById.get(entity.entityId);
    if (!record) return entity;
    const point: EntitySeriesPoint = {
      at,
      values: entityValuesFromRecord(record, result.metrics),
      sampleCount: 1,
      expectedSampleCount: 1,
    };
    const overlay = overlayPoint(entity.points, point, bucketMs);
    if (overlay.points === entity.points) return entity;
    changed = true;
    return {
      ...entity,
      points: overlay.points,
      sampleCount: entity.sampleCount + (overlay.appended ? 1 : 0),
    };
  });
  if (!changed) return result;
  return { ...result, entities };
}

export function mergeLiveSampleIntoHostSummary(
  result: HostSummaryResult,
  sample: AuthenticatedMetricsSample,
): HostSummaryResult {
  const liveAt = sample.metadata.sampledAt;
  const liveMs = Date.parse(liveAt);
  if (!Number.isFinite(liveMs)) return result;
  const latestMs = result.latestAt
    ? Date.parse(result.latestAt)
    : Number.NEGATIVE_INFINITY;
  if (Number.isFinite(latestMs) && liveMs <= latestMs) return result;
  return {
    ...result,
    latestAt: liveAt,
    sampleCount: result.sampleCount + 1,
  };
}
