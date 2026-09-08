import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { METRICS_SCHEMA_VERSION } from './contract.ts'
import { MAX_METRICS_PAYLOAD_BYTES, validateMetricsSample } from './validation.ts'

/**
 * Deno twin of validation.test.ts (Vitest) so Sonar LCOV attributes
 * validateMetricsSample coverage from the Deno coverage profile.
 */

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    serverId: 'srv-1',
    receivedAt: new Date().toISOString(),
    ...overrides,
  }
}

function emptyHost() {
  return { cpu: {}, kernel: {}, memory: {}, storage: {}, network: {} }
}

function validRaw(
  overrides: Record<string, unknown> & { metadata?: Record<string, unknown> } = {}
) {
  const { metadata, ...top } = overrides
  return {
    type: 'metrics',
    metadata: {
      version: METRICS_SCHEMA_VERSION,
      sampledAt: new Date().toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 0,
      bootGeneration: 0,
      ...metadata,
    },
    host: emptyHost(),
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
    ...top,
  }
}

it('validateMetricsSample accepts a minimal valid sample', () => {
  const result = validateMetricsSample(validRaw(), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.serverId, 'srv-1')
  assertEquals(result.sample.host.cpu.busyPercent, null)
  assertEquals(result.sample.gpus, [])
  assertEquals(result.sample.events, [])
})

it('validateMetricsSample rejects a non-object payload', () => {
  const result = validateMetricsSample(null, ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects the wrong envelope type', () => {
  const result = validateMetricsSample(validRaw({ type: 'not-metrics' }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects a payload with no metadata', () => {
  const result = validateMetricsSample({ type: 'metrics' }, ctx())
  assertEquals(result.ok, false)
  if (result.ok) return
  assertEquals(result.reason.includes('metadata'), true)
})

it('validateMetricsSample rejects an unrecognized top-level field', () => {
  const result = validateMetricsSample(validRaw({ serverId: 'attacker' }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects oversized payloads via payloadBytes', () => {
  const result = validateMetricsSample(
    validRaw(),
    ctx({ payloadBytes: MAX_METRICS_PAYLOAD_BYTES + 1 })
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects a wrong metadata schema version', () => {
  const result = validateMetricsSample(validRaw({ metadata: { version: 99 } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects sampledAt outside the allowed skew window', () => {
  const result = validateMetricsSample(
    validRaw({ metadata: { sampledAt: '2000-01-01T00:00:00.000Z' } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects intervalSeconds out of range', () => {
  const result = validateMetricsSample(validRaw({ metadata: { intervalSeconds: 0 } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects a negative sequence/topologyGeneration/bootGeneration', () => {
  assertEquals(validateMetricsSample(validRaw({ metadata: { sequence: -1 } }), ctx()).ok, false)
  assertEquals(
    validateMetricsSample(validRaw({ metadata: { topologyGeneration: -1 } }), ctx()).ok,
    false
  )
  assertEquals(
    validateMetricsSample(validRaw({ metadata: { bootGeneration: -1 } }), ctx()).ok,
    false
  )
})

it('validateMetricsSample rejects the removed collectionMode metadata field', () => {
  const result = validateMetricsSample(
    validRaw({ metadata: { collectionMode: 'baseline' } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects an unrecognized metadata field', () => {
  const result = validateMetricsSample(validRaw({ metadata: { extra: 'nope' } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects an unrecognized host group', () => {
  const result = validateMetricsSample(validRaw({ host: { ...emptyHost(), extra: {} } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects an unrecognized field within host.cpu', () => {
  const result = validateMetricsSample(
    validRaw({ host: { ...emptyHost(), cpu: { notAField: 1 } } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample clamps an out-of-range percent field instead of rejecting', () => {
  const result = validateMetricsSample(
    validRaw({ host: { ...emptyHost(), cpu: { busyPercent: 150 } } }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.host.cpu.busyPercent, 100)
})

it('validateMetricsSample rejects a non-numeric host field value', () => {
  const result = validateMetricsSample(
    validRaw({
      host: { ...emptyHost(), memory: { usedBytes: 'nope' } },
    }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample accepts a non-empty current-shape host sample using collector-emitted v6 fields', () => {
  const result = validateMetricsSample(
    validRaw({
      host: {
        ...emptyHost(),
        cpu: { saturatedCoreCount: 2 },
        memory: { usedBytes: 1_000_000, cachedFilesBytes: 250_000 },
        storage: { diskLatencyMs: 1.8 },
      },
    }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.host.cpu.saturatedCoreCount, 2)
  assertEquals(result.sample.host.memory.usedBytes, 1_000_000)
  assertEquals(result.sample.host.memory.cachedFilesBytes, 250_000)
  assertEquals(result.sample.host.storage.diskLatencyMs, 1.8)
})

it('validateMetricsSample rejects a networks array exceeding the entity cap', () => {
  const networks = Array.from({ length: 65 }, () => ({}))
  const result = validateMetricsSample(validRaw({ networks }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects an entity entry missing its id field', () => {
  const result = validateMetricsSample(validRaw({ gpus: [{ utilizationPercent: 10 }] }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects an unrecognized field on an entity entry', () => {
  const result = validateMetricsSample(
    validRaw({ gpus: [{ gpuId: 'gpu0', notAField: 1 }] }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample treats an absent numeric field as null', () => {
  const result = validateMetricsSample(validRaw({ gpus: [{ gpuId: 'gpu0' }] }), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.gpus[0]?.utilizationPercent, null)
})

it('validateMetricsSample clamps an out-of-range entity field via its descriptor', () => {
  const result = validateMetricsSample(
    validRaw({ gpus: [{ gpuId: 'gpu0', utilizationPercent: 150 }] }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.gpus[0]?.utilizationPercent, 100)
})

it("validateMetricsSample requires a hardwareSignal's kind discriminator", () => {
  const result = validateMetricsSample(
    validRaw({ hardwareSignals: [{ signalId: 'sig0' }] }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects the removed numaNodes top-level field', () => {
  const result = validateMetricsSample(
    validRaw({ numaNodes: [{ nodeId: 'node0', freeBytes: 100 }] }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample omits diagnostics entirely when absent from the wire payload', () => {
  const result = validateMetricsSample(validRaw(), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.diagnostics, undefined)
})

it('validateMetricsSample parses both nested diagnostics halves', () => {
  const result = validateMetricsSample(
    validRaw({
      diagnostics: {
        cpu: { averageFrequencyMHz: 2400, cpuIrqPercent: 150 },
        memory: { memoryFreeBytes: 4096 },
      },
    }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.diagnostics?.cpu.averageFrequencyMHz, 2400)
  // Clamped by the descriptor's percent bounds.
  assertEquals(result.sample.diagnostics?.cpu.cpuIrqPercent, 100)
  assertEquals(result.sample.diagnostics?.memory.memoryFreeBytes, 4096)
  // A field absent from the payload is null, never 0.
  assertEquals(result.sample.diagnostics?.memory.dirtyBytes, null)
})

// ---------------------------------------------------------------------------
// router — the v6 host-wide singleton family. These run on the ingest gate
// itself (`validateMetricsSample`), not just the constructor: a daemon that
// sends `router` would be rejected outright with "router is not a recognized
// field" if the envelope allowlist or `parseRouter` were wrong, so this path
// needs its own coverage rather than inheriting `buildMetricsSample`'s.
// ---------------------------------------------------------------------------

it('validateMetricsSample omits router entirely when absent from the wire payload', () => {
  const result = validateMetricsSample(validRaw(), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.router, undefined)
})

it('validateMetricsSample parses a flat router block, nulling omitted fields', () => {
  const result = validateMetricsSample(
    validRaw({
      router: { backendsUp: 2, backendsTotal: 3, tlsCertSoonestExpiryDays: 45 },
    }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.router?.backendsUp, 2)
  assertEquals(result.sample.router?.backendsTotal, 3)
  assertEquals(result.sample.router?.tlsCertSoonestExpiryDays, 45)
  // A field absent from the payload is null, never 0.
  assertEquals(result.sample.router?.configReloads, null)
})

it('validateMetricsSample rejects an unknown key inside the router block', () => {
  assertEquals(validateMetricsSample(validRaw({ router: { nope: 1 } }), ctx()).ok, false)
})

it('validateMetricsSample rejects a non-object router block and a non-numeric router field', () => {
  assertEquals(validateMetricsSample(validRaw({ router: 1 }), ctx()).ok, false)
  assertEquals(
    validateMetricsSample(validRaw({ router: { backendsUp: 'x' } }), ctx()).ok,
    false
  )
})

// ---------------------------------------------------------------------------
// storage / dockerUsage — the two v6 host-wide storage singletons. Same
// reasoning as `router` above: the envelope allowlist and the nested
// per-engine parse are only exercised through the ingest gate.
// ---------------------------------------------------------------------------

const EMPTY_STORAGE_ENGINE = {
  instancesRunning: null,
  instancesHealthy: null,
  connectionsUsed: null,
  connectionsMax: null,
}

it('validateMetricsSample omits storage and dockerUsage when absent from the wire payload', () => {
  const result = validateMetricsSample(validRaw(), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.storage, undefined)
  assertEquals(result.sample.dockerUsage, undefined)
})

it('validateMetricsSample parses a storage block with its three nested engine groups', () => {
  const result = validateMetricsSample(
    validRaw({
      storage: {
        hostingUsedBytes: 4096,
        backupUsedBytes: 2048,
        postgres: { instancesRunning: 2, instancesHealthy: 2 },
        mysql: EMPTY_STORAGE_ENGINE,
        mariadb: EMPTY_STORAGE_ENGINE,
      },
    }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.storage?.hostingUsedBytes, 4096)
  assertEquals(result.sample.storage?.backupUsedBytes, 2048)
  assertEquals(result.sample.storage?.postgres.instancesRunning, 2)
  // Fields absent from the payload are null, never 0 — at both levels.
  assertEquals(result.sample.storage?.logsFreeBytes, null)
  assertEquals(result.sample.storage?.postgres.connectionsMax, null)
  assertEquals(result.sample.storage?.mariadb.instancesRunning, null)
})

it('validateMetricsSample rejects unknown keys at either storage level', () => {
  assertEquals(validateMetricsSample(validRaw({ storage: { nope: 1 } }), ctx()).ok, false)
  assertEquals(
    validateMetricsSample(
      validRaw({
        storage: {
          postgres: { nope: 1 },
          mysql: EMPTY_STORAGE_ENGINE,
          mariadb: EMPTY_STORAGE_ENGINE,
        },
      }),
      ctx()
    ).ok,
    false
  )
})

it('validateMetricsSample rejects a non-object storage block and a non-numeric storage field', () => {
  assertEquals(validateMetricsSample(validRaw({ storage: 1 }), ctx()).ok, false)
  assertEquals(
    validateMetricsSample(validRaw({ storage: { hostingUsedBytes: 'x' } }), ctx()).ok,
    false
  )
  assertEquals(
    validateMetricsSample(
      validRaw({
        storage: {
          postgres: { instancesRunning: 'x' },
          mysql: EMPTY_STORAGE_ENGINE,
          mariadb: EMPTY_STORAGE_ENGINE,
        },
      }),
      ctx()
    ).ok,
    false
  )
})

it('validateMetricsSample parses a flat dockerUsage block, nulling omitted fields', () => {
  const result = validateMetricsSample(
    validRaw({ dockerUsage: { layersBytes: 6000, imagesCount: 4 } }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.dockerUsage?.layersBytes, 6000)
  assertEquals(result.sample.dockerUsage?.imagesCount, 4)
  assertEquals(result.sample.dockerUsage?.buildCacheReclaimableBytes, null)
})

it('validateMetricsSample rejects an unknown key inside the dockerUsage block', () => {
  assertEquals(validateMetricsSample(validRaw({ dockerUsage: { nope: 1 } }), ctx()).ok, false)
  assertEquals(validateMetricsSample(validRaw({ dockerUsage: 1 }), ctx()).ok, false)
})

it('validateMetricsSample rejects an unknown key inside a diagnostics half', () => {
  const result = validateMetricsSample(
    validRaw({ diagnostics: { cpu: { nope: 1 }, memory: {} } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects a diagnostics block missing either half', () => {
  for (const partial of [{ cpu: {} }, { memory: {} }]) {
    const result = validateMetricsSample(validRaw({ diagnostics: partial }), ctx())
    assertEquals(result.ok, false)
  }
})

it('validateMetricsSample rejects an unknown diagnostics group', () => {
  const result = validateMetricsSample(
    validRaw({ diagnostics: { cpu: {}, memory: {}, disk: {} } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects an events array exceeding the cap', () => {
  const events = Array.from({ length: 129 }, () => ({}))
  const result = validateMetricsSample(validRaw({ events }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects an unrecognized event kind', () => {
  const result = validateMetricsSample(
    validRaw({
      events: [
        {
          eventId: 'e1',
          at: new Date().toISOString(),
          kind: 'not_a_kind',
          severity: 'info',
        },
      ],
    }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample rejects an unrecognized event severity', () => {
  const result = validateMetricsSample(
    validRaw({
      events: [
        {
          eventId: 'e1',
          at: new Date().toISOString(),
          kind: 'oom_kill',
          severity: 'catastrophic',
        },
      ],
    }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample does not apply the metadata skew window to event.at', () => {
  const result = validateMetricsSample(
    validRaw({
      events: [
        {
          eventId: 'e1',
          at: '2000-01-01T00:00:00.000Z',
          kind: 'oom_kill',
          severity: 'critical',
        },
      ],
    }),
    ctx()
  )
  assertEquals(result.ok, true)
})

it('validateMetricsSample rejects a payload record exceeding the key cap', () => {
  const payload: Record<string, number> = {}
  for (let i = 0; i < 33; i++) payload[`k${i}`] = i
  const result = validateMetricsSample(
    validRaw({
      events: [
        {
          eventId: 'e1',
          at: new Date().toISOString(),
          kind: 'oom_kill',
          severity: 'critical',
          payload,
        },
      ],
    }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSample accepts a valid event with entityId/source/payload', () => {
  const result = validateMetricsSample(
    validRaw({
      events: [
        {
          eventId: 'e1',
          at: new Date().toISOString(),
          kind: 'nic_link_down',
          severity: 'warning',
          entityId: 'eth0',
          source: 'daemon',
          payload: { reason: 'carrier lost', retries: 3, fatal: false },
        },
      ],
    }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.events.length, 1)
  assertEquals(result.sample.events[0]?.entityId, 'eth0')
  assertEquals(result.sample.events[0]?.payload?.retries, 3)
})
