/**
 * Host-free coverage for server metrics route pure helpers (no Postgres).
 */

import { assertAlmostEquals, assertEquals } from '@std/assert'
import { CloudflareAnalyticsEngineServerMetricsStore } from '../../daemon/metrics/backends/cloudflare/store.ts'
import { DisabledServerMetricsStore } from '../../daemon/metrics/disabled-store.ts'
import type {
  EntitySeriesPoint,
  EntitySeriesQuery,
  EntitySeriesResult,
  HostSeriesQuery,
  HostSeriesResult,
  ServerMetricsStore,
  StatusHistoryResult,
} from '../../daemon/metrics/types.ts'
import {
  buildConnectionHistoryPayload,
  buildCpuLimitsEnvelope,
  buildFleetLatestPayload,
  buildHostSummaryPayload,
  buildSeriesRouteResponse,
  buildTopologyContext,
  connectionHistoryHasCacheableData,
  defaultHostCanonicalNames,
  EMPTY_HOST_CAPACITIES,
  fabricNetworkSelectionError,
  findFabricNetworkEntityId,
  findInvalidTopologyIdField,
  findUnmonitorableNicSlotId,
  FLEET_HOST_METRICS,
  fleetHostCapacitiesFromSnapshot,
  hardwareProfileUpdateNeedsTopologyValidation,
  machineClassFromTopologySnapshot,
  metricsBackendUnavailableResponse,
  metricsQueryErrorMessage,
  nicSlotLimitViolation,
  parseHardwareProfileBody,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  parseSeriesMetricSelectors,
  querySeriesResults,
  resolveStoreBackendKind,
  seriesCacheMetricsList,
  type TopologyIdValidationSnapshot,
  topologyOverridesFromHardwareProfile,
  withIngressDerivedValues,
} from './metrics-routes-helpers.ts'
import { MAX_NIC_SLOTS } from './topology-types.ts'
import type { TopologyInventory } from './topology-inventory.ts'

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
  assertEquals(nicSlotLimitViolation({ nicSlotDeviceIds: ['mac:a', 'mac:b'] }, 2), null)
  assertEquals(
    typeof nicSlotLimitViolation({ nicSlotDeviceIds: ['mac:a', 'mac:b'] }, 1),
    'string'
  )
  assertEquals(machineClassFromTopologySnapshot(undefined), 'virtual')
  assertEquals(machineClassFromTopologySnapshot({ hardwareSignals: [] }), 'virtual')
  assertEquals(machineClassFromTopologySnapshot({ hardwareSignals: [{}] }), 'physical')
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

test('resolveStoreBackendKind covers store types and runtime fallbacks', () => {
  assertEquals(resolveStoreBackendKind(undefined, 'deno'), 'disabled')
  assertEquals(resolveStoreBackendKind(new DisabledServerMetricsStore(), 'workers'), 'disabled')
  assertEquals(
    resolveStoreBackendKind(
      Object.create(CloudflareAnalyticsEngineServerMetricsStore.prototype),
      'deno'
    ),
    'analytics-engine'
  )
  const unknownStore = { writeSample() {}, writeStatusEvent() {} }
  assertEquals(resolveStoreBackendKind(unknownStore, 'workers'), 'analytics-engine')
  assertEquals(resolveStoreBackendKind(unknownStore, 'deno'), 'duckdb')
})

test('defaultHostCanonicalNames covers only queryable host.* scopes, never diagnostics/router', () => {
  const names = defaultHostCanonicalNames()
  assertEquals(names.includes('host.cpu.busyPercent'), true)
  assertEquals(names.includes('host.memory.usedBytes'), true)
  assertEquals(
    names.every((name) => name.startsWith('host.')),
    true
  )
  assertEquals(
    names.some((name) => name.startsWith('diagnostics.')),
    false
  )
  assertEquals(
    names.some((name) => name.startsWith('router.')),
    false
  )
})

test('parseSeriesMetricSelectors defaults to every queryable host.* canonical name when absent or blank', () => {
  const absent = parseSeriesMetricSelectors(undefined)
  if (!absent.ok) throw new TypeError('expected ok')
  assertEquals(absent.value.hostCanonicalNames, defaultHostCanonicalNames())
  assertEquals(absent.value.entityFamilies.size, 0)

  const blank = parseSeriesMetricSelectors('   ')
  if (!blank.ok) throw new TypeError('expected ok')
  assertEquals(blank.value.hostCanonicalNames, defaultHostCanonicalNames())
})

test('parseSeriesMetricSelectors groups per-entity selectors by family, unioning ids and fields', () => {
  const result = parseSeriesMetricSelectors(
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

test('parseSeriesMetricSelectors rejects an unparseable id, an unknown field, and too many selectors', () => {
  assertEquals(parseSeriesMetricSelectors('not-a-real-metric').ok, false)
  // `diagnostics` is a queryable scope (explicit-only), so these fail on the
  // field half: `coreCount`/`slabBytes` aren't real diagnostics field names.
  assertEquals(parseSeriesMetricSelectors('diagnostics.coreCount').ok, false)
  assertEquals(parseSeriesMetricSelectors('diagnostics.slabBytes').ok, false)

  const tooMany = Array.from({ length: 129 }, () => 'host.cpu.busyPercent').join(',')
  assertEquals(parseSeriesMetricSelectors(tooMany).ok, false)
})

test('parseSeriesMetricSelectors accepts explicit diagnostics singleton selectors from both halves', () => {
  const result = parseSeriesMetricSelectors(
    ['diagnostics.averageFrequencyMHz', 'diagnostics.dirtyBytes'].join(',')
  )
  if (!result.ok) throw new TypeError('expected ok')
  assertEquals([...result.value.hostCanonicalNames].sort(), [
    'diagnostics.averageFrequencyMHz',
    'diagnostics.dirtyBytes',
  ])
})

test('parseSeriesMetricSelectors accepts explicit router singleton selectors as host canonical names', () => {
  const result = parseSeriesMetricSelectors(
    ['router.backendsUp', 'router.configReloads', 'router.tlsCertSoonestExpiryDays'].join(',')
  )
  if (!result.ok) throw new TypeError('expected ok')
  assertEquals([...result.value.hostCanonicalNames].sort(), [
    'router.backendsUp',
    'router.configReloads',
    'router.tlsCertSoonestExpiryDays',
  ])
  // `managed.router` is host-wide and singleton — it must never open a
  // per-entity family request the way `ingress:`/`databaseProxy:` do.
  assertEquals(result.value.entityFamilies.size, 0)
})

test('parseSeriesMetricSelectors rejects an unknown router field and a router id carrying an entity', () => {
  assertEquals(parseSeriesMetricSelectors('router.notAField').ok, false)
  assertEquals(parseSeriesMetricSelectors('router:traefik-1.backendsUp').ok, false)
})

function inventoryWithNetworks(networks: TopologyInventory['networks']): TopologyInventory {
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
  ] as unknown as TopologyInventory['networks'])

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

test('seriesCacheMetricsList concatenates host names and family:entity.field tokens', () => {
  const parsed = parseSeriesMetricSelectors(
    'host.cpu.busyPercent,network:eth0.receiveBytesPerSecond,filesystem:root.availableBytes'
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  assertEquals(
    seriesCacheMetricsList(parsed.value).sort((a, b) => a.localeCompare(b)),
    ['filesystem:root.availableBytes', 'host.cpu.busyPercent', 'network:eth0.receiveBytesPerSecond']
  )
})

test('fabricNetworkSelectionError rejects only a fabric network selector', () => {
  const inventory = inventoryWithNetworks([
    {
      deviceId: 'eth0',
      name: 'eth0',
      kind: 'ethernet',
      role: 'nic',
      slot: 1,
    },
    { deviceId: 'fab0', name: 'fab0', kind: 'ethernet', role: 'fabric' },
  ] as unknown as TopologyInventory['networks'])
  const hostOnly = parseSeriesMetricSelectors('host.cpu.busyPercent')
  if (!hostOnly.ok) {
    throw new TypeError('expected host-only selectors to parse')
  }
  assertEquals(fabricNetworkSelectionError(hostOnly.value, inventory), null)

  const nic = parseSeriesMetricSelectors('network:eth0.receiveBytesPerSecond')
  if (!nic.ok) throw new TypeError('expected nic selectors to parse')
  assertEquals(fabricNetworkSelectionError(nic.value, inventory), null)

  const fabric = parseSeriesMetricSelectors('network:fab0.receiveBytesPerSecond')
  if (!fabric.ok) throw new TypeError('expected fabric selectors to parse')
  assertEquals(
    fabricNetworkSelectionError(fabric.value, inventory),
    'network device "fab0" is a fabric mesh interface per the current topology ' +
      'and cannot be queried as a standalone entity'
  )
  assertEquals(fabricNetworkSelectionError(fabric.value, null), null)
})

function fakeStore(handlers: {
  queryHostSeries?: ServerMetricsStore['queryHostSeries']
  queryEntitySeries?: ServerMetricsStore['queryEntitySeries']
}): ServerMetricsStore {
  return {
    writeSample() {},
    writeStatusEvent() {},
    ...handlers,
  }
}

function requireSeriesQueryOk(outcome: Awaited<ReturnType<typeof querySeriesResults>>): {
  hostResult: HostSeriesResult | null
  entityResults: EntitySeriesResult[]
} {
  if (!outcome.ok) throw new TypeError('expected series query to succeed')
  return outcome
}

test('querySeriesResults returns null host result when no host metrics are requested', async () => {
  const outcome = await querySeriesResults({
    store: undefined,
    backend: 'disabled',
    serverId: 'srv-1',
    selectors: { hostCanonicalNames: [], entityFamilies: new Map() },
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContext(undefined, undefined),
  })
  const { hostResult, entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(hostResult, null)
  assertEquals(entityResults, [])
})

test('querySeriesResults synthesizes unavailable host/entity results when the store has no query methods', async () => {
  const parsed = parseSeriesMetricSelectors(
    'host.cpu.busyPercent,network:eth0.receiveBytesPerSecond'
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResults({
    store: new DisabledServerMetricsStore(),
    backend: 'disabled',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContext(undefined, undefined),
  })
  const { hostResult, entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(hostResult?.available, false)
  assertEquals(hostResult?.kind, 'disabled')
  assertEquals(entityResults.length, 1)
  assertEquals(entityResults[0]?.available, false)
  assertEquals(entityResults[0]?.family, 'network')
})

test('querySeriesResults returns ok:false when queryHostSeries throws', async () => {
  const parsed = parseSeriesMetricSelectors('host.cpu.busyPercent')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResults({
    store: fakeStore({
      queryHostSeries: () => Promise.reject(new Error('AE SQL unavailable')),
    }),
    backend: 'analytics-engine',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContext(undefined, undefined),
  })
  assertEquals(outcome, { ok: false })
})

test('querySeriesResults returns ok:false when queryEntitySeries throws', async () => {
  const parsed = parseSeriesMetricSelectors('network:eth0.receiveBytesPerSecond')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResults({
    store: fakeStore({
      queryEntitySeries: () => Promise.reject(new Error('AE SQL unavailable')),
    }),
    backend: 'analytics-engine',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContext(undefined, undefined),
  })
  assertEquals(outcome, { ok: false })
})

test('querySeriesResults forwards slotMapping/topologyGeneration for the network family', async () => {
  let seen: EntitySeriesQuery | undefined
  const parsed = parseSeriesMetricSelectors('network:eth0.receiveBytesPerSecond')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const context = buildTopologyContext(
    { generation: 5, snapshot: minimalTopologySnapshot() },
    undefined
  )
  const outcome = await querySeriesResults({
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

test('querySeriesResults invokes class-instance series methods with this bound', async () => {
  class ThisSensitiveStore {
    writeSample(): void {}
    writeStatusEvent(): void {}
    flushWrites(): void {
      if (this == null) throw new TypeError('flushWrites this unbound')
    }
    queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult> {
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
    queryEntitySeries(input: EntitySeriesQuery): Promise<EntitySeriesResult> {
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
  const parsed = parseSeriesMetricSelectors(
    'host.cpu.busyPercent,network:eth0.receiveBytesPerSecond'
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResults({
    store: new ThisSensitiveStore() as ServerMetricsStore,
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContext(undefined, undefined),
  })
  const { hostResult, entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(hostResult?.available, true)
  assertEquals(hostResult?.sampleCount, 1)
  assertEquals(entityResults[0]?.available, true)
  assertEquals(entityResults[0]?.family, 'network')
})

test('querySeriesResults returns the host series from the store', async () => {
  const parsed = parseSeriesMetricSelectors('host.cpu.busyPercent')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const hostResult: HostSeriesResult = {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    metrics: ['host.cpu.busyPercent'],
    points: [],
    resolutionSeconds: 60,
    gapCount: 0,
    sampleCount: 3,
  }
  const outcome = await querySeriesResults({
    store: fakeStore({
      queryHostSeries: () => Promise.resolve(hostResult),
    }),
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContext(undefined, undefined),
  })
  assertEquals(requireSeriesQueryOk(outcome).hostResult, hostResult)
})

test('querySeriesResults sends router selectors through the host series query', async () => {
  let seen: HostSeriesQuery | undefined
  const parsed = parseSeriesMetricSelectors('host.cpu.busyPercent,router.backendsUp')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResults({
    store: fakeStore({
      queryHostSeries: (input) => {
        seen = input
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
      },
    }),
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContext(undefined, undefined),
  })
  const { entityResults } = requireSeriesQueryOk(outcome)
  assertEquals([...(seen?.metrics ?? [])].sort(), ['host.cpu.busyPercent', 'router.backendsUp'])
  assertEquals(entityResults, [])
})

/**
 * One `managed.ingress` bucket with the full derivation input set: 100
 * requests, 10 of them errors, 12.5s of total request duration, and the six
 * cumulative `le` counters. Every expected figure below is hand-computed from
 * these numbers, never read back from the implementation.
 */
const INGRESS_POINT_VALUES: Record<string, number> = {
  requests: 100,
  responses4xx: 5,
  responses5xx: 5,
  requestDurationSecondsSum: 12.5,
  bucket10ms: 10,
  bucket50ms: 50,
  bucket100ms: 80,
  bucket500ms: 95,
  bucket1s: 99,
  bucket5s: 100,
}

function ingressSeriesResult(): EntitySeriesResult {
  return {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    family: 'managed.ingress',
    metrics: Object.keys(INGRESS_POINT_VALUES),
    resolutionSeconds: 60,
    entities: [
      {
        entityId: 'caddy-1',
        points: [{ at: FROM, values: { ...INGRESS_POINT_VALUES }, sampleCount: 6 }],
        sampleCount: 6,
        gapCount: 0,
      },
    ],
  }
}

function assertIngressDerived(point: EntitySeriesPoint | undefined) {
  const derived = point?.derived
  if (!derived) throw new TypeError('expected ingress derived values on the point')
  // (5 + 5) / 100 x 100
  assertEquals(derived.errorRatePercent, 10)
  // 12.5s / 100 requests, in ms
  assertEquals(derived.averageLatencyMs, 125)
  // rank 50 lands exactly on the 50ms bucket's upper edge (cumulative 50)
  assertEquals(derived.p50LatencyMs, 50)
  // rank 90 falls inside the 100ms->500ms bucket: 100 + (90-80)/15 x 400
  assertAlmostEquals(derived.p90LatencyMs!, 366.6666666666667, 1e-9)
  // rank 99 lands exactly on the 1s bucket's upper edge (cumulative 99)
  assertEquals(derived.p99LatencyMs, 1000)
}

test('withIngressDerivedValues attaches mean/p50/p90/p99 latency and error rate to every ingress point', () => {
  const result = withIngressDerivedValues(ingressSeriesResult())
  assertIngressDerived(result.entities[0]?.points[0])
  // Raw counters survive alongside the derivations.
  assertEquals(result.entities[0]?.points[0]?.values.requests, 100)
})

test('withIngressDerivedValues nulls a derivation whose input field was not requested', () => {
  const partial = ingressSeriesResult()
  partial.entities[0]!.points[0]!.values = { requests: 100, responses4xx: 5, responses5xx: 5 }
  const derived = withIngressDerivedValues(partial).entities[0]?.points[0]?.derived
  if (!derived) throw new TypeError('expected ingress derived values on the point')
  assertEquals(derived.errorRatePercent, 10)
  assertEquals(derived.averageLatencyMs, null)
  assertEquals(derived.p50LatencyMs, null)
  assertEquals(derived.p90LatencyMs, null)
  assertEquals(derived.p99LatencyMs, null)
})

test('withIngressDerivedValues leaves a non-ingress family untouched', () => {
  const network: EntitySeriesResult = {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    family: 'network',
    metrics: ['receiveBytesPerSecond'],
    resolutionSeconds: 60,
    entities: [
      {
        entityId: 'eth0',
        points: [{ at: FROM, values: { receiveBytesPerSecond: 1234 }, sampleCount: 6 }],
        sampleCount: 6,
        gapCount: 0,
      },
    ],
  }
  const result = withIngressDerivedValues(network)
  assertEquals(result, network)
  assertEquals(result.entities[0]?.points[0]?.derived, undefined)
})

test('querySeriesResults returns managed.ingress points carrying the server-computed latency derivations', async () => {
  const parsed = parseSeriesMetricSelectors(
    Object.keys(INGRESS_POINT_VALUES)
      .map((field) => `ingress:caddy-1.${field}`)
      .join(',')
  )
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const outcome = await querySeriesResults({
    store: fakeStore({
      queryEntitySeries: () => Promise.resolve(ingressSeriesResult()),
    }),
    backend: 'duckdb',
    serverId: 'srv-1',
    selectors: parsed.value,
    fromIso: FROM,
    toIso: TO,
    resolutionSeconds: 60,
    context: buildTopologyContext(undefined, undefined),
  })
  const { entityResults } = requireSeriesQueryOk(outcome)
  assertEquals(entityResults[0]?.family, 'managed.ingress')
  assertIngressDerived(entityResults[0]?.entities[0]?.points[0])
})

test('querySeriesResults does not attach slotMapping for a non-network family', async () => {
  let seen: EntitySeriesQuery | undefined
  const parsed = parseSeriesMetricSelectors('hardware:psu1.value')
  if (!parsed.ok) throw new TypeError('expected selectors to parse')
  const context = buildTopologyContext(
    { generation: 5, snapshot: minimalTopologySnapshot() },
    undefined
  )
  const outcome = await querySeriesResults({
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

test('buildTopologyContext returns an empty-but-present context when there is no recorded generation', () => {
  const context = buildTopologyContext(undefined, undefined)
  assertEquals(context.topologyGeneration, null)
  assertEquals(context.slotMapping, null)
  assertEquals(context.inventory, null)
  assertEquals(context.capacities, EMPTY_HOST_CAPACITIES)
})

test('buildTopologyContext returns an empty-but-present context for a not-yet-slot-mappable snapshot', () => {
  const context = buildTopologyContext(
    { generation: 3, snapshot: { hardwareSignals: [] } },
    undefined
  )
  assertEquals(context.topologyGeneration, 3)
  assertEquals(context.slotMapping, null)
  assertEquals(context.inventory, null)
})

test('buildTopologyContext builds inventory/slotMapping/capacities from a usable snapshot', () => {
  const context = buildTopologyContext(
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

test('buildSeriesRouteResponse is unavailable only when host or some requested entity family is unavailable', () => {
  const envelope = {
    cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' as const },
    temperatureUnit: 'celsius' as const,
    nicSlotLimit: 2,
  }
  const context = buildTopologyContext(undefined, undefined)

  const noHostRequested = buildSeriesRouteResponse({
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

  const unavailableEntity: EntitySeriesResult = {
    kind: 'duckdb',
    available: false,
    serverId: 'srv-1',
    family: 'network',
    metrics: ['receiveBytesPerSecond'],
    resolutionSeconds: null,
    entities: [],
  }
  const withUnavailableEntity = buildSeriesRouteResponse({
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

test('fleetHostCapacitiesFromSnapshot reads memory/swap totals only, never rootFilesystemTotalBytes', () => {
  assertEquals(fleetHostCapacitiesFromSnapshot(undefined), EMPTY_HOST_CAPACITIES)
  assertEquals(fleetHostCapacitiesFromSnapshot(null), EMPTY_HOST_CAPACITIES)
  assertEquals(
    fleetHostCapacitiesFromSnapshot({
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

test('buildFleetLatestPayload attaches per-server derived values from the batched capacity map', () => {
  const payload = buildFleetLatestPayload({
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:10:00.000Z',
    backend: 'duckdb',
    available: true,
    metrics: FLEET_HOST_METRICS,
    servers: [
      {
        serverId: 'srv-1',
        latestAt: '2026-01-01T00:09:00.000Z',
        sampleCount: 5,
        values: {
          'host.cpu.busyPercent': 42,
          'host.memory.usedBytes': 12_000_000_000,
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
