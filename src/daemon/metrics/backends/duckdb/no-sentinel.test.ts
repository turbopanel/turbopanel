/**
 * DuckDB never leaks the Cloudflare Analytics Engine v5 missing-metric
 * sentinel (`AE_MISSING_METRIC_SENTINEL`, `-1e308`) through its query
 * surface — a value absent from a written sample must come back as a real
 * SQL `NULL` (JS `null`), never AE's positional-packing placeholder. DuckDB
 * has no positional slot layout at all (`schema.ts`'s doc comment), so this
 * is a pure regression guard against ever importing AE's sentinel discipline
 * into the DuckDB write/read path.
 *
 * `store.test.ts` already asserts this at the raw-SQL level for one sample
 * (`"writeSample persists the host row and every entity row with real
 * NULLs, never the AE sentinel"`); this file broadens the same invariant
 * across several representative-machine shapes and the full query surface
 * (`queryHostSeries` / `queryEntitySeries`), not just a raw `SELECT`.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSample } from '../../contract.ts'
import { truncateSampleToCapabilityPlan } from '../../capability-plan.ts'
import type { AuthenticatedMetricsSample } from '../../types.ts'
import { representativeMachineFixtures } from '../../testing/representative-machines.ts'
import {
  AE_MISSING_METRIC_SENTINEL,
  PER_ENTITY_FIELD_ORDER,
  SINGLE_ROW_FIELD_ORDER,
} from '../cloudflare/field-map.ts'
import { ROUTER_FIELD_NAMES } from '../../metric-descriptors.ts'
import { HOST_METRIC_FIELD_REFS } from './schema.ts'
import { DuckDbParquetServerMetricsStore } from './store.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const FROM_MS = Date.UTC(2026, 5, 2)
const TO_MS = FROM_MS + 3_600_000

const HOST_CANONICAL_METRICS = HOST_METRIC_FIELD_REFS.map((ref) => `host.${ref.group}.${ref.field}`)

async function withStore(
  run: (store: DuckDbParquetServerMetricsStore) => Promise<void>
): Promise<void> {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-no-sentinel-',
  })
  const store = new DuckDbParquetServerMetricsStore(
    { metricsDir },
    {
      writeBatchMaxRows: 1,
    }
  )
  try {
    await run(store)
  } finally {
    await store.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
}

function authenticate(
  built: ReturnType<typeof buildMetricsSample>,
  atMs: number
): AuthenticatedMetricsSample {
  return {
    ...built,
    serverId: SERVER_ID,
    receivedAt: new Date(atMs).toISOString(),
  }
}

function assertNoSentinel(value: unknown, label: string): void {
  assertEquals(value === AE_MISSING_METRIC_SENTINEL, false, label)
}

// A handful of shapes covering every per-entity family plus a fixture with
// genuinely-absent metrics (host fields intentionally left `null`).
const FIXTURES_TO_CHECK = [
  '1-gpu-vm',
  '4-nic',
  'bare-metal-low-signals',
  '12-extra-filesystems',
  '24-block-devices',
  'web-vm',
  'db-proxysql-vm',
] as const

for (const name of FIXTURES_TO_CHECK) {
  const fixture = representativeMachineFixtures().find((f) => f.name === name)!

  it(`no-sentinel: "${fixture.name}" host series + entity series never surface AE_MISSING_METRIC_SENTINEL`, async () => {
    await withStore(async (store) => {
      const built = buildMetricsSample(fixture.input)
      const truncated = truncateSampleToCapabilityPlan(built, fixture.plan)
      await store.writeSample(authenticate(truncated, FROM_MS + 60_000))

      const hostResult = await store.queryHostSeries({
        serverId: SERVER_ID,
        metrics: HOST_CANONICAL_METRICS,
        from: new Date(FROM_MS).toISOString(),
        to: new Date(TO_MS).toISOString(),
        resolutionSeconds: 3600,
      })
      for (const point of hostResult.points) {
        for (const [key, value] of Object.entries(point.values)) {
          assertNoSentinel(value, `${fixture.name}: host.${key}`)
        }
      }

      for (const family of [
        'gpu',
        'network',
        'filesystem',
        'block',
        'hardware.physical',
      ] as const) {
        const entityIds = entityIdsForFamily(truncated, family)
        if (entityIds.length === 0) continue
        const entityResult = await store.queryEntitySeries({
          serverId: SERVER_ID,
          family,
          entityIds,
          metrics: PER_ENTITY_FIELD_ORDER[family],
          from: new Date(FROM_MS).toISOString(),
          to: new Date(TO_MS).toISOString(),
          resolutionSeconds: 3600,
        })
        for (const entity of entityResult.entities) {
          for (const point of entity.points) {
            for (const [key, value] of Object.entries(point.values)) {
              assertNoSentinel(value, `${fixture.name}: ${family}.${key}`)
            }
          }
        }
      }

      if (truncated.router) {
        const routerResult = await store.queryHostSeries({
          serverId: SERVER_ID,
          metrics: ROUTER_FIELD_NAMES.map((field) => `router.${field}`),
          from: new Date(FROM_MS).toISOString(),
          to: new Date(TO_MS).toISOString(),
          resolutionSeconds: 3600,
        })
        for (const point of routerResult.points) {
          for (const [key, value] of Object.entries(point.values)) {
            assertNoSentinel(value, `${fixture.name}: ${key}`)
          }
        }
      }

      for (const family of ['managed.ingress', 'managed.database_proxy'] as const) {
        const entityIds =
          family === 'managed.ingress'
            ? truncated.ingressSources.map((s) => s.sourceId)
            : truncated.databaseProxies.map((s) => s.sourceId)
        if (entityIds.length === 0) continue
        const entityResult = await store.queryEntitySeries({
          serverId: SERVER_ID,
          family,
          entityIds,
          // Spares (`null` slots) are reserved layout, not queryable fields.
          metrics: SINGLE_ROW_FIELD_ORDER[family].filter(
            (field): field is string => field !== null
          ),
          from: new Date(FROM_MS).toISOString(),
          to: new Date(TO_MS).toISOString(),
          resolutionSeconds: 3600,
        })
        for (const entity of entityResult.entities) {
          for (const point of entity.points) {
            for (const [key, value] of Object.entries(point.values)) {
              assertNoSentinel(value, `${fixture.name}: ${family}.${key}`)
            }
          }
        }
      }
    })
  })
}

function entityIdsForFamily(
  sample: ReturnType<typeof buildMetricsSample>,
  family: 'gpu' | 'network' | 'filesystem' | 'block' | 'hardware.physical'
): string[] {
  switch (family) {
    case 'gpu':
      return sample.gpus.map((g) => g.gpuId)
    case 'network':
      return sample.networks.map((n) => n.deviceId)
    case 'filesystem':
      return sample.filesystems.map((f) => f.filesystemId)
    case 'block':
      return sample.blockDevices.map((d) => d.deviceId)
    case 'hardware.physical':
      return sample.hardwareSignals.map((s) => s.signalId)
  }
}

it('no-sentinel: a sample with every host metric explicitly null never surfaces the sentinel through queryHostSeries', async () => {
  await withStore(async (store) => {
    const nullHost = {
      cpu: {
        busyPercent: null,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        saturatedCoreCount: null,
        procsRunning: null,
        procsBlocked: null,
        processCount: null,
      },
      kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
      memory: {
        usedBytes: null,
        cachedFilesBytes: null,
        swapUsedBytes: null,
        pressureSomePercent: null,
        pressureFullPercent: null,
        swapInBytesPerSecond: null,
        swapOutBytesPerSecond: null,
        majorPageFaultsPerSecond: null,
      },
      storage: {
        ioPressureSomePercent: null,
        ioPressureFullPercent: null,
        diskReadBytesPerSecond: null,
        diskWriteBytesPerSecond: null,
        diskLatencyMs: null,
        rootFilesystemAvailableBytes: null,
        rootFilesystemFreeInodes: null,
      },
      network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
    }
    const built = buildMetricsSample({
      metadata: {
        version: 6,
        sampledAt: new Date(FROM_MS + 60_000).toISOString(),
        intervalSeconds: 60,
        sequence: 1,
        topologyGeneration: 1,
        bootGeneration: 1,
      },
      host: nullHost,
      networks: [],
      filesystems: [],
      blockDevices: [],
      gpus: [],
      hardwareSignals: [],
      ingressSources: [],
      databaseProxies: [],
      events: [],
    })
    await store.writeSample(authenticate(built, FROM_MS + 60_000))

    const result = await store.queryHostSeries({
      serverId: SERVER_ID,
      metrics: HOST_CANONICAL_METRICS,
      from: new Date(FROM_MS).toISOString(),
      to: new Date(TO_MS).toISOString(),
      resolutionSeconds: 3600,
    })
    assertEquals(result.points.length, 1)
    for (const [key, value] of Object.entries(result.points[0]!.values)) {
      assertEquals(value, null, `expected real NULL for ${key}`)
      assertNoSentinel(value, key)
    }
  })
})
