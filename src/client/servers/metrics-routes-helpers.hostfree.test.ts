/**
 * Host-free coverage for server metrics route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { CloudflareAnalyticsEngineServerMetricsStoreV4 } from '../../daemon/metrics/backends/cloudflare/store-v4.ts'
import { DisabledServerMetricsStoreV4 } from '../../daemon/metrics/disabled-store-v4.ts'
import type {
  EntitySeriesQueryV4,
  EntitySeriesResultV4,
  HostSeriesResultV4,
  ServerMetricsStoreV4,
  StatusHistoryResult,
} from '../../daemon/metrics/types-v4.ts'
import {
  buildConnectionHistoryPayload,
  buildCpuLimitsEnvelope,
  buildFleetLatestPayloadV4,
  buildHostSummaryPayload,
  buildSeriesRouteResponseV4,
  buildTopologyContextV4,
  connectionHistoryHasCacheableData,
  defaultHostCanonicalNamesV4,
  EMPTY_HOST_CAPACITIES_V4,
  fabricNetworkSelectionErrorV4,
  findFabricNetworkEntityId,
  findInvalidTopologyIdField,
  FLEET_HOST_METRICS_V4,
  fleetHostCapacitiesFromSnapshotV4,
  hardwareProfileUpdateNeedsTopologyValidation,
  metricsBackendUnavailableResponse,
  metricsQueryErrorMessage,
  parseHardwareProfileBody,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  parseSeriesMetricSelectorsV4,
  querySeriesResultsV4,
  resolveStoreBackendKindV4,
  seriesCacheMetricsListV4,
  type TopologyIdValidationSnapshot,
  topologyOverridesFromHardwareProfile,
} from './metrics-routes-helpers.ts'
import type { TopologyInventoryV4 } from './topology-inventory.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const FROM = '2026-01-01T00:00:00.000Z'
const TO = '2026-01-01T01:00:00.000Z'

test('parseIsoTimestampQuery requires valid ISO timestamps', () => {
  assertEquals(parseIsoTimestampQuery(undefined, 'from'), {
    ok: false,
    message: 'from is required',
  })
  assertEquals(parseIsoTimestampQuery('   ', 'to'), {
    ok: false,
    message: 'to is required',
  })
  assertEquals(parseIsoTimestampQuery('not-iso', 'from'), {
    ok: false,
    message: 'from must be a valid ISO timestamp',
  })
  const ok = parseIsoTimestampQuery(FROM, 'from')
  if (!ok.ok) throw new TypeError('expected valid from timestamp')
  assertEquals(ok.iso, FROM)
  assertEquals(ok.ms, Date.parse(FROM))
})

test('parseOptionalResolution ignores blanks and non-finite values', () => {
  assertEquals(parseOptionalResolution(undefined), undefined)
  assertEquals(parseOptionalResolution(''), undefined)
  assertEquals(parseOptionalResolution('  '), undefined)
  assertEquals(parseOptionalResolution('nope'), undefined)
  assertEquals(parseOptionalResolution('60'), 60)
})

test('metricsBackendUnavailableResponse is stable', () => {
  assertEquals(metricsBackendUnavailableResponse('duckdb'), {
    ok: false,
    error: 'metrics_backend_unavailable',
    backend: 'duckdb',
  })
})

test('connection history payload and cacheability', () => {
  const empty: StatusHistoryResult = {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    initialConnected: null,
    uptimeSeconds: 0,
    downtimeSeconds: 0,
    unknownSeconds: 0,
    uptimePercent: null,
    truncated: false,
    events: [],
  }
  assertEquals(connectionHistoryHasCacheableData(empty), false)

  const withUptime = { ...empty, uptimeSeconds: 10 }
  assertEquals(connectionHistoryHasCacheableData(withUptime), true)

  const withEvents = {
    ...empty,
    events: [{ at: FROM, connected: true, reason: 'connect' as const }],
  }
  assertEquals(connectionHistoryHasCacheableData(withEvents), true)

  assertEquals(
    buildConnectionHistoryPayload({
      serverId: 'srv-1',
      from: FROM,
      to: TO,
      result: withUptime,
    }),
    {
      ok: true,
      serverId: 'srv-1',
      from: FROM,
      to: TO,
      backend: 'duckdb',
      available: true,
      initialConnected: null,
      uptimeSeconds: 10,
      downtimeSeconds: 0,
      unknownSeconds: 0,
      uptimePercent: null,
      truncated: false,
      events: [],
    }
  )
})

test('buildHostSummaryPayload and metricsQueryErrorMessage', () => {
  assertEquals(
    buildHostSummaryPayload({
      serverId: 'srv-1',
      from: FROM,
      to: TO,
      result: {
        kind: 'disabled',
        available: false,
        sampleCount: 0,
        latestAt: null,
      },
      envelope: {
        cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' },
        temperatureUnit: 'celsius',
      },
    }),
    {
      ok: true,
      serverId: 'srv-1',
      from: FROM,
      to: TO,
      backend: 'disabled',
      available: false,
      sampleCount: 0,
      latestAt: null,
      cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' },
      temperatureUnit: 'celsius',
    }
  )
  assertEquals(metricsQueryErrorMessage(new Error('down')), 'down')
  assertEquals(metricsQueryErrorMessage('oops'), 'oops')
})

test('buildCpuLimitsEnvelope resolves thermal limits and temperature unit from resolved inputs', () => {
  assertEquals(
    buildCpuLimitsEnvelope(
      { cpuModel: 'AMD EPYC 7763' },
      {
        temperatureUnit: 'fahrenheit',
      }
    ),
    {
      cpuLimits: { tdpWatts: 280, tjMaxCelsius: 95, source: 'catalog-exact' },
      temperatureUnit: 'fahrenheit',
    }
  )
})

test('buildCpuLimitsEnvelope falls back cleanly when nothing is resolved', () => {
  assertEquals(buildCpuLimitsEnvelope(undefined, undefined), {
    cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' },
    temperatureUnit: 'celsius',
  })
})

test('parseHardwareProfileBody accepts cpu override fields in range, and null clears', () => {
  const accepted = parseHardwareProfileBody({
    cpuTdpWattsOverride: 240,
    cpuTjMaxCelsiusOverride: 95,
  })
  assertEquals(accepted, {
    ok: true,
    update: { cpuTdpWattsOverride: 240, cpuTjMaxCelsiusOverride: 95 },
  })

  const cleared = parseHardwareProfileBody({
    cpuTdpWattsOverride: null,
    cpuTjMaxCelsiusOverride: null,
  })
  assertEquals(cleared, {
    ok: true,
    update: { cpuTdpWattsOverride: null, cpuTjMaxCelsiusOverride: null },
  })
})

test('parseHardwareProfileBody rejects cpuTdpWattsOverride out of range or non-finite', () => {
  assertEquals(parseHardwareProfileBody({ cpuTdpWattsOverride: 0 }).ok, false)
  assertEquals(parseHardwareProfileBody({ cpuTdpWattsOverride: -10 }).ok, false)
  assertEquals(parseHardwareProfileBody({ cpuTdpWattsOverride: 1001 }).ok, false)
  assertEquals(parseHardwareProfileBody({ cpuTdpWattsOverride: Number.NaN }).ok, false)
  assertEquals(parseHardwareProfileBody({ cpuTdpWattsOverride: '200' }).ok, false)
})

test('parseHardwareProfileBody rejects cpuTjMaxCelsiusOverride out of the plausible silicon range', () => {
  assertEquals(parseHardwareProfileBody({ cpuTjMaxCelsiusOverride: 39 }).ok, false)
  assertEquals(parseHardwareProfileBody({ cpuTjMaxCelsiusOverride: 131 }).ok, false)
  assertEquals(parseHardwareProfileBody({ cpuTjMaxCelsiusOverride: 40 }), {
    ok: true,
    update: { cpuTjMaxCelsiusOverride: 40 },
  })
  assertEquals(parseHardwareProfileBody({ cpuTjMaxCelsiusOverride: 130 }), {
    ok: true,
    update: { cpuTjMaxCelsiusOverride: 130 },
  })
})

test('parseHardwareProfileBody accepts stable topology-id pins, and null clears them', () => {
  const accepted = parseHardwareProfileBody({
    nicSlot1DeviceId: 'mac:aa:bb:cc:dd:ee:ff',
    nicSlot2DeviceId: 'pci:0000:01:00.0',
    hostingFilesystemId: 'fs:dev:/dev/sdb1',
  })
  assertEquals(accepted, {
    ok: true,
    update: {
      nicSlot1DeviceId: 'mac:aa:bb:cc:dd:ee:ff',
      nicSlot2DeviceId: 'pci:0000:01:00.0',
      hostingFilesystemId: 'fs:dev:/dev/sdb1',
    },
  })

  const cleared = parseHardwareProfileBody({
    nicSlot1DeviceId: null,
    nicSlot2DeviceId: null,
    hostingFilesystemId: null,
  })
  assertEquals(cleared, {
    ok: true,
    update: {
      nicSlot1DeviceId: null,
      nicSlot2DeviceId: null,
      hostingFilesystemId: null,
    },
  })
})

test('parseHardwareProfileBody rejects a blank or non-string topology-id pin', () => {
  assertEquals(parseHardwareProfileBody({ nicSlot1DeviceId: '   ' }).ok, false)
  assertEquals(parseHardwareProfileBody({ hostingFilesystemId: 42 }).ok, false)
})

test('hardwareProfileUpdateNeedsTopologyValidation only fires for topology-id assignments', () => {
  assertEquals(hardwareProfileUpdateNeedsTopologyValidation({}), false)
  assertEquals(hardwareProfileUpdateNeedsTopologyValidation({ nic1: 'eth0' }), false)
  assertEquals(hardwareProfileUpdateNeedsTopologyValidation({ nicSlot1DeviceId: null }), false)
  assertEquals(hardwareProfileUpdateNeedsTopologyValidation({ nicSlot1DeviceId: 'mac:a' }), true)
  assertEquals(
    hardwareProfileUpdateNeedsTopologyValidation({
      hostingFilesystemId: 'fs:dev:/dev/sda1',
    }),
    true
  )
})

test('findInvalidTopologyIdField matches assigned ids against the recorded topology', () => {
  const snapshot = {
    networks: [{ deviceId: 'mac:a' }, { deviceId: 'mac:b' }],
    filesystems: [{ filesystemId: 'fs:dev:/dev/sda1' }],
  } as unknown as TopologyIdValidationSnapshot

  assertEquals(findInvalidTopologyIdField({}, snapshot), null)
  assertEquals(findInvalidTopologyIdField({ nicSlot1DeviceId: 'mac:a' }, snapshot), null)
  assertEquals(
    findInvalidTopologyIdField({ nicSlot1DeviceId: 'mac:stale' }, snapshot),
    'nicSlot1DeviceId'
  )
  assertEquals(
    findInvalidTopologyIdField({ nicSlot2DeviceId: 'mac:stale' }, snapshot),
    'nicSlot2DeviceId'
  )
  assertEquals(
    findInvalidTopologyIdField({ hostingFilesystemId: 'fs:dev:/dev/sdb1' }, snapshot),
    'hostingFilesystemId'
  )
  assertEquals(
    findInvalidTopologyIdField({ hostingFilesystemId: 'fs:dev:/dev/sda1' }, snapshot),
    null
  )
  // No recorded topology yet — every assignment is stale.
  assertEquals(
    findInvalidTopologyIdField({ nicSlot1DeviceId: 'mac:a' }, undefined),
    'nicSlot1DeviceId'
  )
})

// ---------------------------------------------------------------------------
// v4 entity-metric selector parsing, topology context, and fleet/series
// response shaping.
// ---------------------------------------------------------------------------

test('resolveStoreBackendKindV4 covers store types and runtime fallbacks', () => {
  assertEquals(resolveStoreBackendKindV4(undefined, 'deno'), 'disabled')
  assertEquals(resolveStoreBackendKindV4(new DisabledServerMetricsStoreV4(), 'workers'), 'disabled')
  assertEquals(
    resolveStoreBackendKindV4(
      Object.create(CloudflareAnalyticsEngineServerMetricsStoreV4.prototype),
      'deno'
    ),
    'analytics-engine'
  )
  const unknownStore = { writeSample() {}, writeStatusEvent() {} }
  assertEquals(resolveStoreBackendKindV4(unknownStore, 'workers'), 'analytics-engine')
  assertEquals(resolveStoreBackendKindV4(unknownStore, 'deno'), 'duckdb')
})

test('defaultHostCanonicalNamesV4 covers only queryable host.* scopes, never cpuDetail/memoryDetail', () => {
  const names = defaultHostCanonicalNamesV4()
  assertEquals(names.includes('host.cpu.busyPercent'), true)
  assertEquals(names.includes('host.memory.availableBytes'), true)
  assertEquals(
    names.every((name) => name.startsWith('host.')),
    true
  )
  assertEquals(
    names.some((name) => name.startsWith('cpuDetail.') || name.startsWith('memoryDetail.')),
    false
  )
})

test('parseSeriesMetricSelectorsV4 defaults to every queryable host.* canonical name when absent or blank', () => {
  const absent = parseSeriesMetricSelectorsV4(undefined)
  if (!absent.ok) throw new TypeError('expected ok')
  assertEquals(absent.value.hostCanonicalNames, defaultHostCanonicalNamesV4())
  assertEquals(absent.value.entityFamilies.size, 0)

  const blank = parseSeriesMetricSelectorsV4('   ')
  if (!blank.ok) throw new TypeError('expected ok')
  assertEquals(blank.value.hostCanonicalNames, defaultHostCanonicalNamesV4())
})

test('parseSeriesMetricSelectorsV4 groups per-entity selectors by family, unioning ids and fields', () => {
  const result = parseSeriesMetricSelectorsV4(
    [
      'host.cpu.busyPercent',
      'network:eth0.receiveBytesPerSecond',
      'network:eth1.transmitBytesPerSecond',
      'hardware:psu1.value',
      'ingress:caddy-1.requests',
    ].join(',')
  )
  if (!result.ok) throw new TypeError('expected ok')
  assertEquals(result.value.hostCanonicalNames, ['host.cpu.busyPercent'])

  const network = result.value.entityFamilies.get('network')!
  assertEquals([...network.entityIds].sort(), ['eth0', 'eth1'])
  assertEquals([...network.fields].sort(), ['receiveBytesPerSecond', 'transmitBytesPerSecond'])

  const hardware = result.value.entityFamilies.get('hardware.physical')!
  assertEquals([...hardware.entityIds], ['psu1'])
  assertEquals([...hardware.fields], ['value'])

  const ingress = result.value.entityFamilies.get('managed.ingress')!
  assertEquals([...ingress.entityIds], ['caddy-1'])
  assertEquals([...ingress.fields], ['requests'])
})

test('parseSeriesMetricSelectorsV4 rejects an unparseable id, an unknown field, and too many selectors', () => {
  assertEquals(parseSeriesMetricSelectorsV4('not-a-real-metric').ok, false)
  // Not reserved scopes anymore (cpuDetail/memoryDetail are explicit-only queryable)
  // — these still fail because `coreCount`/`slabBytes` aren't real §38/§40 field names.
  assertEquals(parseSeriesMetricSelectorsV4('cpuDetail.coreCount').ok, false)
  assertEquals(parseSeriesMetricSelectorsV4('memoryDetail.slabBytes').ok, false)

  const tooMany = Array.from({ length: 129 }, () => 'host.cpu.busyPercent').join(',')
  assertEquals(parseSeriesMetricSelectorsV4(tooMany).ok, false)
})

test('parseSeriesMetricSelectorsV4 accepts explicit cpuDetail/memoryDetail singleton and cpuCore entity selectors', () => {
  const result = parseSeriesMetricSelectorsV4(
    [
      'cpuDetail.averageFrequencyMHz',
      'memoryDetail.dirtyBytes',
      'cpuCore:cpu0.busyPercent',
      'cpuCore:cpu1.busyPercent',
    ].join(',')
  )
  if (!result.ok) throw new TypeError('expected ok')
  assertEquals([...result.value.hostCanonicalNames].sort(), [
    'cpuDetail.averageFrequencyMHz',
    'memoryDetail.dirtyBytes',
  ])

  const cpuCore = result.value.entityFamilies.get('cpu.core.live')!
  assertEquals([...cpuCore.entityIds].sort(), ['cpu0', 'cpu1'])
  assertEquals([...cpuCore.fields], ['busyPercent'])
})

function inventoryWithNetworks(networks: TopologyInventoryV4['networks']): TopologyInventoryV4 {
  return {
    networks,
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
  }
}

test('findFabricNetworkEntityId rejects only a fabric device — a slot-mapped NIC and a standalone device both pass, and everything passes without an inventory', () => {
  const inventory = inventoryWithNetworks([
    {
      deviceId: 'eth0',
      name: 'eth0',
      kind: 'ethernet',
      role: 'normalNicSlot1',
    },
    {
      deviceId: 'eth1',
      name: 'eth1',
      kind: 'ethernet',
      role: 'normalNicSlot2',
    },
    { deviceId: 'fab0', name: 'fab0', kind: 'ethernet', role: 'fabric' },
    { deviceId: 'eth2', name: 'eth2', kind: 'ethernet', role: 'other' },
  ] as unknown as TopologyInventoryV4['networks'])

  // Slot-mapped NICs are queryable now (Cloudflare reconstructs them from
  // host.io, DuckDB already stored the full row) — never rejected here.
  assertEquals(findFabricNetworkEntityId(['eth0'], inventory), null)
  assertEquals(findFabricNetworkEntityId(['eth1'], inventory), null)
  assertEquals(findFabricNetworkEntityId(['fab0'], inventory), 'fab0')
  assertEquals(findFabricNetworkEntityId(['eth2'], inventory), null)
  assertEquals(findFabricNetworkEntityId(['eth2', 'eth1', 'fab0'], inventory), 'fab0')
  // No inventory yet — nothing to reject against.
  assertEquals(findFabricNetworkEntityId(['fab0'], null), null)
})

test('seriesCacheMetricsListV4 concatenates host names and family:entity.field tokens', () => {
  const parsed = parseSeriesMetricSelectorsV4(
    'host.cpu.busyPercent,network:eth0.receiveBytesPerSecond,filesystem:root.availableBytes'
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  assertEquals(
    seriesCacheMetricsListV4(parsed.value).sort((a, b) => a.localeCompare(b)),
    ['filesystem:root.availableBytes', 'host.cpu.busyPercent', 'network:eth0.receiveBytesPerSecond']
  )
})

test('fabricNetworkSelectionErrorV4 rejects only a fabric network selector', () => {
  const inventory = inventoryWithNetworks([
    {
      deviceId: 'eth0',
      name: 'eth0',
      kind: 'ethernet',
      role: 'normalNicSlot1',
    },
    { deviceId: 'fab0', name: 'fab0', kind: 'ethernet', role: 'fabric' },
  ] as unknown as TopologyInventoryV4['networks'])
  const hostOnly = parseSeriesMetricSelectorsV4('host.cpu.busyPercent')
  if (!hostOnly.ok) {
    throw new TypeError('expected host-only selectors to parse')
  }
  assertEquals(fabricNetworkSelectionErrorV4(hostOnly.value, inventory), null)

  const nic = parseSeriesMetricSelectorsV4('network:eth0.receiveBytesPerSecond')
  if (!nic.ok) throw new TypeError('expected nic selectors to parse')
  assertEquals(fabricNetworkSelectionErrorV4(nic.value, inventory), null)

  const fabric = parseSeriesMetricSelectorsV4('network:fab0.receiveBytesPerSecond')
  if (!fabric.ok) throw new TypeError('expected fabric selectors to parse')
  assertEquals(
    fabricNetworkSelectionErrorV4(fabric.value, inventory),
    'network device "fab0" is a fabric mesh interface per the current topology ' +
      'and cannot be queried as a standalone entity'
  )
  assertEquals(fabricNetworkSelectionErrorV4(fabric.value, null), null)
})

function fakeStore(handlers: {
  queryHostSeries?: ServerMetricsStoreV4['queryHostSeries']
  queryEntitySeries?: ServerMetricsStoreV4['queryEntitySeries']
}): ServerMetricsStoreV4 {
  return {
    writeSample() {},
    writeStatusEvent() {},
    ...handlers,
  }
}

function requireSeriesQueryOk(outcome: Awaited<ReturnType<typeof querySeriesResultsV4>>): {
  hostResult: HostSeriesResultV4 | null
  entityResults: EntitySeriesResultV4[]
} {
  if (!outcome.ok) throw new TypeError('expected series query to succeed')
  return outcome
}

test('querySeriesResultsV4 returns null host result when no host metrics are requested', async () => {
  const outcome = await querySeriesResultsV4({
    store: undefined,
    backend: 'disabled',
    serverId: 'srv-1',
    selectors: { hostCanonicalNames: [], entityFamilies: new Map() },
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV4(undefined, undefined),
  })
  const { hostResult, entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(hostResult, null)
  assertEquals(entityResults, [])
})

test('querySeriesResultsV4 synthesizes unavailable host/entity results when the store has no query methods', async () => {
  const parsed = parseSeriesMetricSelectorsV4(
    'host.cpu.busyPercent,network:eth0.receiveBytesPerSecond'
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResultsV4({
    store: new DisabledServerMetricsStoreV4(),
    backend: 'disabled',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV4(undefined, undefined),
  })
  const { hostResult, entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(hostResult?.available, false)
  assertEquals(hostResult?.kind, 'disabled')
  assertEquals(entityResults.length, 1)
  assertEquals(entityResults[0]?.available, false)
  assertEquals(entityResults[0]?.family, 'network')
})

test('querySeriesResultsV4 returns ok:false when queryHostSeries throws', async () => {
  const parsed = parseSeriesMetricSelectorsV4('host.cpu.busyPercent')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResultsV4({
    store: fakeStore({
      queryHostSeries: () => Promise.reject(new Error('AE SQL unavailable')),
    }),
    backend: 'analytics-engine',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV4(undefined, undefined),
  })
  assertEquals(outcome, { ok: false })
})

test('querySeriesResultsV4 returns ok:false when queryEntitySeries throws', async () => {
  const parsed = parseSeriesMetricSelectorsV4('network:eth0.receiveBytesPerSecond')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResultsV4({
    store: fakeStore({
      queryEntitySeries: () => Promise.reject(new Error('AE SQL unavailable')),
    }),
    backend: 'analytics-engine',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV4(undefined, undefined),
  })
  assertEquals(outcome, { ok: false })
})

test('querySeriesResultsV4 forwards slotMapping/topologyGeneration for the network family', async () => {
  let seen: EntitySeriesQueryV4 | undefined
  const parsed = parseSeriesMetricSelectorsV4('network:eth0.receiveBytesPerSecond')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const context = buildTopologyContextV4(
    { generation: 5, snapshot: minimalTopologySnapshot() },
    undefined
  )
  const outcome = await querySeriesResultsV4({
    store: fakeStore({
      queryEntitySeries: (input) => {
        seen = input
        return Promise.resolve({
          kind: 'duckdb',
          available: true,
          serverId: input.serverId,
          family: input.family,
          metrics: input.metrics,
          resolutionSeconds: 60,
          entities: [],
        })
      },
    }),
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context,
  })
  requireSeriesQueryOk(outcome)
  assertEquals(seen?.family, 'network')
  assertEquals(seen?.slotMapping?.normalNicSlot1, 'eth0')
  assertEquals(seen?.topologyGeneration, 5)
})

test('querySeriesResultsV4 returns the host series from the store', async () => {
  const parsed = parseSeriesMetricSelectorsV4('host.cpu.busyPercent')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const hostResult: HostSeriesResultV4 = {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    metrics: ['host.cpu.busyPercent'],
    points: [],
    resolutionSeconds: 60,
    gapCount: 0,
    sampleCount: 3,
  }
  const outcome = await querySeriesResultsV4({
    store: fakeStore({
      queryHostSeries: () => Promise.resolve(hostResult),
    }),
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV4(undefined, undefined),
  })
  assertEquals(requireSeriesQueryOk(outcome).hostResult, hostResult)
})

test('querySeriesResultsV4 does not attach slotMapping for a non-network family', async () => {
  let seen: EntitySeriesQueryV4 | undefined
  const parsed = parseSeriesMetricSelectorsV4('hardware:psu1.value')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const context = buildTopologyContextV4(
    { generation: 5, snapshot: minimalTopologySnapshot() },
    undefined
  )
  const outcome = await querySeriesResultsV4({
    store: fakeStore({
      queryEntitySeries: (input) => {
        seen = input
        return Promise.resolve({
          kind: 'duckdb',
          available: true,
          serverId: input.serverId,
          family: input.family,
          metrics: input.metrics,
          resolutionSeconds: 60,
          entities: [],
        })
      },
    }),
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context,
  })
  requireSeriesQueryOk(outcome)
  assertEquals(seen?.family, 'hardware.physical')
  assertEquals(seen?.slotMapping, undefined)
  assertEquals(seen?.topologyGeneration, undefined)
})

test('topologyOverridesFromHardwareProfile: unset profile fields default null/false, set fields pass through', () => {
  const empty = topologyOverridesFromHardwareProfile(undefined)
  assertEquals(empty.nicSlot1DeviceId, null)
  assertEquals(empty.nicSlot2DeviceId, null)
  assertEquals(empty.hostingFilesystemId, null)
  assertEquals(empty.drivetempEnabled, false)

  const assigned = topologyOverridesFromHardwareProfile({
    nicSlot1DeviceId: 'mac:a',
    hostingFilesystemId: 'fs:dev:/dev/sda1',
    drivetempEnabled: true,
  })
  assertEquals(assigned.nicSlot1DeviceId, 'mac:a')
  assertEquals(assigned.nicSlot2DeviceId, null)
  assertEquals(assigned.hostingFilesystemId, 'fs:dev:/dev/sda1')
  assertEquals(assigned.drivetempEnabled, true)
})

function minimalTopologySnapshot(): {
  networks: unknown[]
  filesystems: unknown[]
  blockDevices: unknown[]
  gpus: unknown[]
  hardwareSignals: unknown[]
  cpu: unknown
  numaNodes: unknown[]
  memoryTotalBytes: number | null
  swapTotalBytes: number | null
} {
  return {
    networks: [
      {
        deviceId: 'eth0',
        kind: 'uplink',
        name: 'eth0',
        identity: {},
      },
    ],
    filesystems: [
      {
        filesystemId: 'fs:dev:/dev/sda1',
        mountpoint: '/',
        fsType: 'ext4',
        sourceDevice: '/dev/sda1',
        totalBytes: 100_000_000_000,
        totalInodes: 1000,
        roles: ['root'],
      },
    ],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    cpu: { sockets: 1, coresPerSocket: 4, threadsPerSocket: 8, model: null },
    numaNodes: [],
    memoryTotalBytes: 16_000_000_000,
    swapTotalBytes: 2_000_000_000,
  }
}

test('buildTopologyContextV4 returns an empty-but-present context when there is no recorded generation', () => {
  const context = buildTopologyContextV4(undefined, undefined)
  assertEquals(context.topologyGeneration, null)
  assertEquals(context.slotMapping, null)
  assertEquals(context.inventory, null)
  assertEquals(context.capacities, EMPTY_HOST_CAPACITIES_V4)
})

test('buildTopologyContextV4 returns an empty-but-present context for a not-yet-slot-mappable snapshot', () => {
  const context = buildTopologyContextV4(
    { generation: 3, snapshot: { hardwareSignals: [] } },
    undefined
  )
  assertEquals(context.topologyGeneration, 3)
  assertEquals(context.slotMapping, null)
  assertEquals(context.inventory, null)
})

test('buildTopologyContextV4 builds inventory/slotMapping/capacities from a usable snapshot', () => {
  const context = buildTopologyContextV4(
    { generation: 5, snapshot: minimalTopologySnapshot() },
    undefined
  )
  assertEquals(context.topologyGeneration, 5)
  assertEquals(context.slotMapping?.normalNicSlot1, 'eth0')
  assertEquals(context.inventory?.networks[0]?.role, 'normalNicSlot1')
  assertEquals(context.capacities.memoryTotalBytes, 16_000_000_000)
  assertEquals(context.capacities.swapTotalBytes, 2_000_000_000)
  assertEquals(context.capacities.rootFilesystemTotalBytes, 100_000_000_000)
})

test('buildSeriesRouteResponseV4 is unavailable only when host or some requested entity family is unavailable', () => {
  const envelope = {
    cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' as const },
    temperatureUnit: 'celsius' as const,
  }
  const context = buildTopologyContextV4(undefined, undefined)

  const noHostRequested = buildSeriesRouteResponseV4({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T01:00:00.000Z',
    backend: 'duckdb',
    resolutionSeconds: 60,
    host: null,
    entities: [],
    context,
    envelope,
  })
  assertEquals(noHostRequested.available, true)
  assertEquals(noHostRequested.inventory, null)
  assertEquals(noHostRequested.topologyGeneration, null)

  const unavailableEntity: EntitySeriesResultV4 = {
    kind: 'duckdb',
    available: false,
    serverId: 'srv-1',
    family: 'network',
    metrics: ['receiveBytesPerSecond'],
    resolutionSeconds: null,
    entities: [],
  }
  const withUnavailableEntity = buildSeriesRouteResponseV4({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T01:00:00.000Z',
    backend: 'duckdb',
    resolutionSeconds: 60,
    host: null,
    entities: [unavailableEntity],
    context,
    envelope,
  })
  assertEquals(withUnavailableEntity.available, false)
})

test('fleetHostCapacitiesFromSnapshotV4 reads memory/swap totals only, never rootFilesystemTotalBytes', () => {
  assertEquals(fleetHostCapacitiesFromSnapshotV4(undefined), EMPTY_HOST_CAPACITIES_V4)
  assertEquals(fleetHostCapacitiesFromSnapshotV4(null), EMPTY_HOST_CAPACITIES_V4)
  assertEquals(
    fleetHostCapacitiesFromSnapshotV4({
      memoryTotalBytes: 8_000_000_000,
      swapTotalBytes: 1_000_000_000,
    }),
    {
      memoryTotalBytes: 8_000_000_000,
      swapTotalBytes: 1_000_000_000,
      rootFilesystemTotalBytes: null,
    }
  )
})

test('buildFleetLatestPayloadV4 attaches per-server derived values from the batched capacity map', () => {
  const payload = buildFleetLatestPayloadV4({
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:10:00.000Z',
    backend: 'duckdb',
    available: true,
    metrics: FLEET_HOST_METRICS_V4,
    servers: [
      {
        serverId: 'srv-1',
        latestAt: '2026-01-01T00:09:00.000Z',
        sampleCount: 5,
        values: {
          'host.cpu.busyPercent': 42,
          'host.memory.availableBytes': 4_000_000_000,
        },
      },
      {
        // No recorded topology generation for this server.
        serverId: 'srv-2',
        latestAt: null,
        sampleCount: 0,
        values: {},
      },
    ],
    capacitiesByServer: new Map([
      [
        'srv-1',
        {
          memoryTotalBytes: 16_000_000_000,
          swapTotalBytes: null,
          rootFilesystemTotalBytes: null,
        },
      ],
    ]),
  })

  const srv1 = payload.servers.find((row) => row.serverId === 'srv-1')!
  assertEquals(srv1.derived.cpuUsagePercent, 42)
  assertEquals(srv1.derived.memoryUsedPercent, 75)

  const srv2 = payload.servers.find((row) => row.serverId === 'srv-2')!
  assertEquals(srv2.derived.memoryUsedPercent, null)
})
