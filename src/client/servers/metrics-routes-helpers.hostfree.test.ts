/**
 * Host-free coverage for server metrics route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { CloudflareAnalyticsEngineServerMetricsStoreV5 } from '../../daemon/metrics/backends/cloudflare/store-v5.ts'
import { DisabledServerMetricsStoreV5 } from '../../daemon/metrics/disabled-store-v5.ts'
import type {
  EntitySeriesQueryV5,
  EntitySeriesResultV5,
  HostSeriesQueryV5,
  HostSeriesResultV5,
  ServerMetricsStoreV5,
  StatusHistoryResult,
} from '../../daemon/metrics/types-v5.ts'
import {
  buildConnectionHistoryPayload,
  buildCpuLimitsEnvelope,
  buildFleetLatestPayloadV5,
  buildHostSummaryPayload,
  buildSeriesRouteResponseV5,
  buildTopologyContextV5,
  connectionHistoryHasCacheableData,
  defaultHostCanonicalNamesV5,
  EMPTY_HOST_CAPACITIES_V5,
  fabricNetworkSelectionErrorV5,
  findFabricNetworkEntityId,
  findInvalidTopologyIdField,
  findUnmonitorableNicSlotId,
  FLEET_HOST_METRICS_V5,
  fleetHostCapacitiesFromSnapshotV5,
  hardwareProfileUpdateNeedsTopologyValidation,
  machineClassFromTopologySnapshotV5,
  metricsBackendUnavailableResponse,
  metricsQueryErrorMessage,
  nicSlotLimitViolationV5,
  parseHardwareProfileBody,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  parseSeriesMetricSelectorsV5,
  querySeriesResultsV5,
  resolveStoreBackendKindV5,
  seriesCacheMetricsListV5,
  type TopologyIdValidationSnapshot,
  topologyOverridesFromHardwareProfile,
} from './metrics-routes-helpers.ts'
import { MAX_NIC_SLOTS } from './topology-types.ts'
import type { TopologyInventoryV5 } from './topology-inventory.ts'

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
        nicSlotLimit: 2,
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
      nicSlotLimit: 2,
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
      },
      8
    ),
    {
      cpuLimits: { tdpWatts: 280, tjMaxCelsius: 95, source: 'catalog-exact' },
      temperatureUnit: 'fahrenheit',
      nicSlotLimit: 8,
    }
  )
})

test('buildCpuLimitsEnvelope falls back cleanly when nothing is resolved', () => {
  assertEquals(buildCpuLimitsEnvelope(undefined, undefined, 2), {
    cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' },
    temperatureUnit: 'celsius',
    nicSlotLimit: 2,
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

test('parseHardwareProfileBody accepts stable topology-id pins and the monitored-NIC list, and null clears them', () => {
  const accepted = parseHardwareProfileBody({
    nicSlotDeviceIds: ['mac:aa:bb:cc:dd:ee:ff', ' pci:0000:01:00.0 ', 'mac:aa:bb:cc:dd:ee:ff'],
    hostingFilesystemId: 'fs:dev:/dev/sdb1',
  })
  assertEquals(accepted, {
    ok: true,
    update: {
      nicSlotDeviceIds: ['mac:aa:bb:cc:dd:ee:ff', 'pci:0000:01:00.0'],
      hostingFilesystemId: 'fs:dev:/dev/sdb1',
    },
  })

  const cleared = parseHardwareProfileBody({
    nicSlotDeviceIds: null,
    hostingFilesystemId: null,
  })
  assertEquals(cleared, {
    ok: true,
    update: {
      nicSlotDeviceIds: null,
      hostingFilesystemId: null,
    },
  })
  assertEquals(parseHardwareProfileBody({ nicSlotDeviceIds: [] }), {
    ok: true,
    update: { nicSlotDeviceIds: [] },
  })
})

test('parseHardwareProfileBody rejects a blank or non-string topology-id pin, a malformed NIC list, and a list over MAX_NIC_SLOTS', () => {
  assertEquals(parseHardwareProfileBody({ hostingFilesystemId: '   ' }).ok, false)
  assertEquals(parseHardwareProfileBody({ hostingFilesystemId: 42 }).ok, false)
  assertEquals(parseHardwareProfileBody({ nicSlotDeviceIds: 'mac:a' }).ok, false)
  assertEquals(parseHardwareProfileBody({ nicSlotDeviceIds: ['mac:a', null] }).ok, false)
  assertEquals(parseHardwareProfileBody({ nicSlotDeviceIds: ['mac:a', '  '] }).ok, false)
  assertEquals(
    parseHardwareProfileBody({
      nicSlotDeviceIds: Array.from({ length: MAX_NIC_SLOTS + 1 }, (_, i) => `mac:${i}`),
    }).ok,
    false
  )
  // The pre-list keys are no longer accepted through the PUT body.
  assertEquals(parseHardwareProfileBody({ nicSlot1DeviceId: 'mac:a' }).ok, false)
})

test('hardwareProfileUpdateNeedsTopologyValidation only fires for topology-id assignments', () => {
  assertEquals(hardwareProfileUpdateNeedsTopologyValidation({}), false)
  assertEquals(hardwareProfileUpdateNeedsTopologyValidation({ nic1: 'eth0' }), false)
  assertEquals(hardwareProfileUpdateNeedsTopologyValidation({ nicSlotDeviceIds: null }), false)
  assertEquals(hardwareProfileUpdateNeedsTopologyValidation({ nicSlotDeviceIds: [] }), false)
  assertEquals(
    hardwareProfileUpdateNeedsTopologyValidation({
      nicSlotDeviceIds: ['mac:a'],
    }),
    true
  )
  assertEquals(
    hardwareProfileUpdateNeedsTopologyValidation({
      hostingFilesystemId: 'fs:dev:/dev/sda1',
    }),
    true
  )
})

test('findInvalidTopologyIdField matches assigned ids against the recorded topology, and NIC slots must be uplinks', () => {
  const snapshot = {
    networks: [
      { deviceId: 'mac:a', kind: 'uplink' },
      { deviceId: 'mac:b', kind: 'uplink' },
      { deviceId: 'mac:port', kind: 'member' },
      { deviceId: 'virtual:vlan', kind: 'virtual' },
    ],
    filesystems: [{ filesystemId: 'fs:dev:/dev/sda1' }],
  } as unknown as TopologyIdValidationSnapshot

  assertEquals(findInvalidTopologyIdField({}, snapshot), null)
  assertEquals(findInvalidTopologyIdField({ nicSlotDeviceIds: ['mac:a', 'mac:b'] }, snapshot), null)
  assertEquals(
    findInvalidTopologyIdField({ nicSlotDeviceIds: ['mac:a', 'mac:stale'] }, snapshot),
    'nicSlotDeviceIds'
  )
  assertEquals(
    findInvalidTopologyIdField({ nicSlotDeviceIds: ['mac:port'] }, snapshot),
    'nicSlotDeviceIds'
  )
  assertEquals(
    findInvalidTopologyIdField({ nicSlotDeviceIds: ['virtual:vlan'] }, snapshot),
    'nicSlotDeviceIds'
  )
  assertEquals(findUnmonitorableNicSlotId(['mac:a', 'mac:port'], snapshot), 'mac:port')
  assertEquals(nicSlotLimitViolationV5({ nicSlotDeviceIds: ['mac:a', 'mac:b'] }, 2), null)
  assertEquals(
    typeof nicSlotLimitViolationV5({ nicSlotDeviceIds: ['mac:a', 'mac:b'] }, 1),
    'string'
  )
  assertEquals(machineClassFromTopologySnapshotV5(undefined), 'virtual')
  assertEquals(machineClassFromTopologySnapshotV5({ hardwareSignals: [] }), 'virtual')
  assertEquals(machineClassFromTopologySnapshotV5({ hardwareSignals: [{}] }), 'physical')
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
    findInvalidTopologyIdField({ nicSlotDeviceIds: ['mac:a'] }, undefined),
    'nicSlotDeviceIds'
  )
})

// ---------------------------------------------------------------------------
// v5 entity-metric selector parsing, topology context, and fleet/series
// response shaping.
// ---------------------------------------------------------------------------

test('resolveStoreBackendKindV5 covers store types and runtime fallbacks', () => {
  assertEquals(resolveStoreBackendKindV5(undefined, 'deno'), 'disabled')
  assertEquals(resolveStoreBackendKindV5(new DisabledServerMetricsStoreV5(), 'workers'), 'disabled')
  assertEquals(
    resolveStoreBackendKindV5(
      Object.create(CloudflareAnalyticsEngineServerMetricsStoreV5.prototype),
      'deno'
    ),
    'analytics-engine'
  )
  const unknownStore = { writeSample() {}, writeStatusEvent() {} }
  assertEquals(resolveStoreBackendKindV5(unknownStore, 'workers'), 'analytics-engine')
  assertEquals(resolveStoreBackendKindV5(unknownStore, 'deno'), 'duckdb')
})

test('defaultHostCanonicalNamesV5 covers only queryable host.* scopes, never cpuDetail/memoryDetail', () => {
  const names = defaultHostCanonicalNamesV5()
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

test('parseSeriesMetricSelectorsV5 defaults to every queryable host.* canonical name when absent or blank', () => {
  const absent = parseSeriesMetricSelectorsV5(undefined)
  if (!absent.ok) throw new TypeError('expected ok')
  assertEquals(absent.value.hostCanonicalNames, defaultHostCanonicalNamesV5())
  assertEquals(absent.value.entityFamilies.size, 0)

  const blank = parseSeriesMetricSelectorsV5('   ')
  if (!blank.ok) throw new TypeError('expected ok')
  assertEquals(blank.value.hostCanonicalNames, defaultHostCanonicalNamesV5())
})

test('parseSeriesMetricSelectorsV5 groups per-entity selectors by family, unioning ids and fields', () => {
  const result = parseSeriesMetricSelectorsV5(
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

test('parseSeriesMetricSelectorsV5 rejects an unparseable id, an unknown field, and too many selectors', () => {
  assertEquals(parseSeriesMetricSelectorsV5('not-a-real-metric').ok, false)
  // Not reserved scopes anymore (cpuDetail/memoryDetail are explicit-only queryable)
  // — these still fail because `coreCount`/`slabBytes` aren't real §38/§40 field names.
  assertEquals(parseSeriesMetricSelectorsV5('cpuDetail.coreCount').ok, false)
  assertEquals(parseSeriesMetricSelectorsV5('memoryDetail.slabBytes').ok, false)

  const tooMany = Array.from({ length: 129 }, () => 'host.cpu.busyPercent').join(',')
  assertEquals(parseSeriesMetricSelectorsV5(tooMany).ok, false)
})

test('parseSeriesMetricSelectorsV5 accepts explicit cpuDetail/memoryDetail singleton and cpuCore entity selectors', () => {
  const result = parseSeriesMetricSelectorsV5(
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
})

function inventoryWithNetworks(networks: TopologyInventoryV5['networks']): TopologyInventoryV5 {
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
      role: 'nic',
      slot: 1,
    },
    {
      deviceId: 'eth1',
      name: 'eth1',
      kind: 'ethernet',
      role: 'nic',
      slot: 2,
    },
    { deviceId: 'fab0', name: 'fab0', kind: 'ethernet', role: 'fabric' },
    { deviceId: 'eth2', name: 'eth2', kind: 'ethernet', role: 'other' },
  ] as unknown as TopologyInventoryV5['networks'])

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

test('seriesCacheMetricsListV5 concatenates host names and family:entity.field tokens', () => {
  const parsed = parseSeriesMetricSelectorsV5(
    'host.cpu.busyPercent,network:eth0.receiveBytesPerSecond,filesystem:root.availableBytes'
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  assertEquals(
    seriesCacheMetricsListV5(parsed.value).sort((a, b) => a.localeCompare(b)),
    ['filesystem:root.availableBytes', 'host.cpu.busyPercent', 'network:eth0.receiveBytesPerSecond']
  )
})

test('fabricNetworkSelectionErrorV5 rejects only a fabric network selector', () => {
  const inventory = inventoryWithNetworks([
    {
      deviceId: 'eth0',
      name: 'eth0',
      kind: 'ethernet',
      role: 'nic',
      slot: 1,
    },
    { deviceId: 'fab0', name: 'fab0', kind: 'ethernet', role: 'fabric' },
  ] as unknown as TopologyInventoryV5['networks'])
  const hostOnly = parseSeriesMetricSelectorsV5('host.cpu.busyPercent')
  if (!hostOnly.ok) {
    throw new TypeError('expected host-only selectors to parse')
  }
  assertEquals(fabricNetworkSelectionErrorV5(hostOnly.value, inventory), null)

  const nic = parseSeriesMetricSelectorsV5('network:eth0.receiveBytesPerSecond')
  if (!nic.ok) throw new TypeError('expected nic selectors to parse')
  assertEquals(fabricNetworkSelectionErrorV5(nic.value, inventory), null)

  const fabric = parseSeriesMetricSelectorsV5('network:fab0.receiveBytesPerSecond')
  if (!fabric.ok) throw new TypeError('expected fabric selectors to parse')
  assertEquals(
    fabricNetworkSelectionErrorV5(fabric.value, inventory),
    'network device "fab0" is a fabric mesh interface per the current topology ' +
      'and cannot be queried as a standalone entity'
  )
  assertEquals(fabricNetworkSelectionErrorV5(fabric.value, null), null)
})

function fakeStore(handlers: {
  queryHostSeries?: ServerMetricsStoreV5['queryHostSeries']
  queryEntitySeries?: ServerMetricsStoreV5['queryEntitySeries']
}): ServerMetricsStoreV5 {
  return {
    writeSample() {},
    writeStatusEvent() {},
    ...handlers,
  }
}

function requireSeriesQueryOk(outcome: Awaited<ReturnType<typeof querySeriesResultsV5>>): {
  hostResult: HostSeriesResultV5 | null
  entityResults: EntitySeriesResultV5[]
} {
  if (!outcome.ok) throw new TypeError('expected series query to succeed')
  return outcome
}

test('querySeriesResultsV5 returns null host result when no host metrics are requested', async () => {
  const outcome = await querySeriesResultsV5({
    store: undefined,
    backend: 'disabled',
    serverId: 'srv-1',
    selectors: { hostCanonicalNames: [], entityFamilies: new Map() },
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV5(undefined, undefined),
  })
  const { hostResult, entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(hostResult, null)
  assertEquals(entityResults, [])
})

test('querySeriesResultsV5 synthesizes unavailable host/entity results when the store has no query methods', async () => {
  const parsed = parseSeriesMetricSelectorsV5(
    'host.cpu.busyPercent,network:eth0.receiveBytesPerSecond'
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResultsV5({
    store: new DisabledServerMetricsStoreV5(),
    backend: 'disabled',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV5(undefined, undefined),
  })
  const { hostResult, entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(hostResult?.available, false)
  assertEquals(hostResult?.kind, 'disabled')
  assertEquals(entityResults.length, 1)
  assertEquals(entityResults[0]?.available, false)
  assertEquals(entityResults[0]?.family, 'network')
})

test('querySeriesResultsV5 returns ok:false when queryHostSeries throws', async () => {
  const parsed = parseSeriesMetricSelectorsV5('host.cpu.busyPercent')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResultsV5({
    store: fakeStore({
      queryHostSeries: () => Promise.reject(new Error('AE SQL unavailable')),
    }),
    backend: 'analytics-engine',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV5(undefined, undefined),
  })
  assertEquals(outcome, { ok: false })
})

test('querySeriesResultsV5 returns ok:false when queryEntitySeries throws', async () => {
  const parsed = parseSeriesMetricSelectorsV5('network:eth0.receiveBytesPerSecond')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResultsV5({
    store: fakeStore({
      queryEntitySeries: () => Promise.reject(new Error('AE SQL unavailable')),
    }),
    backend: 'analytics-engine',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV5(undefined, undefined),
  })
  assertEquals(outcome, { ok: false })
})

test('querySeriesResultsV5 forwards slotMapping/topologyGeneration for the network family', async () => {
  let seen: EntitySeriesQueryV5 | undefined
  const parsed = parseSeriesMetricSelectorsV5('network:eth0.receiveBytesPerSecond')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const context = buildTopologyContextV5(
    { generation: 5, snapshot: minimalTopologySnapshot() },
    undefined
  )
  const outcome = await querySeriesResultsV5({
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
  assertEquals(seen?.slotMapping?.normalNicSlots, ['eth0'])
  assertEquals(seen?.topologyGeneration, 5)
})

test('querySeriesResultsV5 invokes class-instance series methods with this bound', async () => {
  class ThisSensitiveStore {
    writeSample(): void {}
    writeStatusEvent(): void {}
    flushWrites(): void {
      if (this == null) throw new TypeError('flushWrites this unbound')
    }
    queryHostSeries(input: HostSeriesQueryV5): Promise<HostSeriesResultV5> {
      this.flushWrites()
      return Promise.resolve({
        kind: 'duckdb',
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [],
        resolutionSeconds: 60,
        gapCount: 0,
        sampleCount: 1,
      })
    }
    queryEntitySeries(input: EntitySeriesQueryV5): Promise<EntitySeriesResultV5> {
      this.flushWrites()
      return Promise.resolve({
        kind: 'duckdb',
        available: true,
        serverId: input.serverId,
        family: input.family,
        metrics: input.metrics,
        resolutionSeconds: 60,
        entities: [],
      })
    }
  }
  const parsed = parseSeriesMetricSelectorsV5(
    'host.cpu.busyPercent,network:eth0.receiveBytesPerSecond'
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResultsV5({
    store: new ThisSensitiveStore() as ServerMetricsStoreV5,
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV5(undefined, undefined),
  })
  const { hostResult, entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(hostResult?.available, true)
  assertEquals(hostResult?.sampleCount, 1)
  assertEquals(entityResults[0]?.available, true)
  assertEquals(entityResults[0]?.family, 'network')
})

test('querySeriesResultsV5 returns the host series from the store', async () => {
  const parsed = parseSeriesMetricSelectorsV5('host.cpu.busyPercent')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const hostResult: HostSeriesResultV5 = {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    metrics: ['host.cpu.busyPercent'],
    points: [],
    resolutionSeconds: 60,
    gapCount: 0,
    sampleCount: 3,
  }
  const outcome = await querySeriesResultsV5({
    store: fakeStore({
      queryHostSeries: () => Promise.resolve(hostResult),
    }),
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContextV5(undefined, undefined),
  })
  assertEquals(requireSeriesQueryOk(outcome).hostResult, hostResult)
})

test('querySeriesResultsV5 does not attach slotMapping for a non-network family', async () => {
  let seen: EntitySeriesQueryV5 | undefined
  const parsed = parseSeriesMetricSelectorsV5('hardware:psu1.value')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const context = buildTopologyContextV5(
    { generation: 5, snapshot: minimalTopologySnapshot() },
    undefined
  )
  const outcome = await querySeriesResultsV5({
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
  assertEquals(empty.nicSlotDeviceIds, [])
  assertEquals(empty.hostingFilesystemId, null)
  assertEquals(empty.drivetempEnabled, false)

  const assigned = topologyOverridesFromHardwareProfile({
    nicSlotDeviceIds: ['mac:a'],
    hostingFilesystemId: 'fs:dev:/dev/sda1',
    drivetempEnabled: true,
  })
  assertEquals(assigned.nicSlotDeviceIds, ['mac:a'])
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

test('buildTopologyContextV5 returns an empty-but-present context when there is no recorded generation', () => {
  const context = buildTopologyContextV5(undefined, undefined)
  assertEquals(context.topologyGeneration, null)
  assertEquals(context.slotMapping, null)
  assertEquals(context.inventory, null)
  assertEquals(context.capacities, EMPTY_HOST_CAPACITIES_V5)
})

test('buildTopologyContextV5 returns an empty-but-present context for a not-yet-slot-mappable snapshot', () => {
  const context = buildTopologyContextV5(
    { generation: 3, snapshot: { hardwareSignals: [] } },
    undefined
  )
  assertEquals(context.topologyGeneration, 3)
  assertEquals(context.slotMapping, null)
  assertEquals(context.inventory, null)
})

test('buildTopologyContextV5 builds inventory/slotMapping/capacities from a usable snapshot', () => {
  const context = buildTopologyContextV5(
    { generation: 5, snapshot: minimalTopologySnapshot() },
    undefined
  )
  assertEquals(context.topologyGeneration, 5)
  assertEquals(context.slotMapping?.normalNicSlots, ['eth0'])
  assertEquals(context.inventory?.networks[0]?.role, 'nic')
  assertEquals(context.inventory?.networks[0]?.slot, 1)
  assertEquals(context.capacities.memoryTotalBytes, 16_000_000_000)
  assertEquals(context.capacities.swapTotalBytes, 2_000_000_000)
  assertEquals(context.capacities.rootFilesystemTotalBytes, 100_000_000_000)
})

test('buildSeriesRouteResponseV5 is unavailable only when host or some requested entity family is unavailable', () => {
  const envelope = {
    cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' as const },
    temperatureUnit: 'celsius' as const,
    nicSlotLimit: 2,
  }
  const context = buildTopologyContextV5(undefined, undefined)

  const noHostRequested = buildSeriesRouteResponseV5({
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

  const unavailableEntity: EntitySeriesResultV5 = {
    kind: 'duckdb',
    available: false,
    serverId: 'srv-1',
    family: 'network',
    metrics: ['receiveBytesPerSecond'],
    resolutionSeconds: null,
    entities: [],
  }
  const withUnavailableEntity = buildSeriesRouteResponseV5({
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

test('fleetHostCapacitiesFromSnapshotV5 reads memory/swap totals only, never rootFilesystemTotalBytes', () => {
  assertEquals(fleetHostCapacitiesFromSnapshotV5(undefined), EMPTY_HOST_CAPACITIES_V5)
  assertEquals(fleetHostCapacitiesFromSnapshotV5(null), EMPTY_HOST_CAPACITIES_V5)
  assertEquals(
    fleetHostCapacitiesFromSnapshotV5({
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

test('buildFleetLatestPayloadV5 attaches per-server derived values from the batched capacity map', () => {
  const payload = buildFleetLatestPayloadV5({
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:10:00.000Z',
    backend: 'duckdb',
    available: true,
    metrics: FLEET_HOST_METRICS_V5,
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
