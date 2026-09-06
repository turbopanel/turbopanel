import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { METRICS_SCHEMA_VERSION_V4 } from './contract-v4.ts'
import { MAX_METRICS_PAYLOAD_BYTES_V4, validateMetricsSampleV4 } from './validation-v4.ts'

/**
 * Deno twin of validation-v4.test.ts (Vitest) so Sonar LCOV attributes
 * validateMetricsSampleV4 coverage from the Deno coverage profile.
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

function validRawV4(
  overrides: Record<string, unknown> & { metadata?: Record<string, unknown> } = {}
) {
  const { metadata, ...top } = overrides
  return {
    type: 'metrics',
    metadata: {
      version: METRICS_SCHEMA_VERSION_V4,
      sampledAt: new Date().toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      collectionMode: 'baseline',
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

function legacyV3Raw() {
  return {
    type: 'metrics',
    version: 3,
    at: new Date().toISOString(),
    intervalSeconds: 60,
    sequence: 1,
    parts: ['core', 'extended'],
    metrics: {},
    dimensions: {
      schemaVersion: 3,
      collectionMode: 'baseline',
      hardwareProfileGeneration: 1,
      trafficSources: { caddy: false, proxysql: false },
    },
  }
}

it('validateMetricsSampleV4 accepts a minimal valid sample', () => {
  const result = validateMetricsSampleV4(validRawV4(), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.serverId, 'srv-1')
  assertEquals(result.sample.host.cpu.busyPercent, null)
  assertEquals(result.sample.gpus, [])
  assertEquals(result.sample.events, [])
})

it('validateMetricsSampleV4 rejects a non-object payload', () => {
  const result = validateMetricsSampleV4(null, ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects the wrong envelope type', () => {
  const result = validateMetricsSampleV4(validRawV4({ type: 'not-metrics' }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects a retired v3-shaped payload with a clear reason', () => {
  const result = validateMetricsSampleV4(legacyV3Raw(), ctx())
  assertEquals(result.ok, false)
  if (result.ok) return
  assertEquals(result.reason.includes('retired schema v3'), true)
})

it('validateMetricsSampleV4 rejects a payload with no metadata and no v3 markers with a generic reason', () => {
  const result = validateMetricsSampleV4({ type: 'metrics' }, ctx())
  assertEquals(result.ok, false)
  if (result.ok) return
  assertEquals(result.reason.includes('retired schema v3'), false)
})

it('validateMetricsSampleV4 rejects an unrecognized top-level field', () => {
  const result = validateMetricsSampleV4(validRawV4({ serverId: 'attacker' }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects oversized payloads via payloadBytes', () => {
  const result = validateMetricsSampleV4(
    validRawV4(),
    ctx({ payloadBytes: MAX_METRICS_PAYLOAD_BYTES_V4 + 1 })
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects a wrong metadata schema version', () => {
  const result = validateMetricsSampleV4(validRawV4({ metadata: { version: 99 } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects sampledAt outside the allowed skew window', () => {
  const result = validateMetricsSampleV4(
    validRawV4({ metadata: { sampledAt: '2000-01-01T00:00:00.000Z' } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects intervalSeconds out of range', () => {
  const result = validateMetricsSampleV4(validRawV4({ metadata: { intervalSeconds: 0 } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects a negative sequence/topologyGeneration/bootGeneration', () => {
  assertEquals(validateMetricsSampleV4(validRawV4({ metadata: { sequence: -1 } }), ctx()).ok, false)
  assertEquals(
    validateMetricsSampleV4(validRawV4({ metadata: { topologyGeneration: -1 } }), ctx()).ok,
    false
  )
  assertEquals(
    validateMetricsSampleV4(validRawV4({ metadata: { bootGeneration: -1 } }), ctx()).ok,
    false
  )
})

it('validateMetricsSampleV4 rejects an invalid collectionMode', () => {
  const result = validateMetricsSampleV4(
    validRawV4({ metadata: { collectionMode: 'turbo' } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects an unrecognized metadata field', () => {
  const result = validateMetricsSampleV4(validRawV4({ metadata: { extra: 'nope' } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects an unrecognized host group', () => {
  const result = validateMetricsSampleV4(validRawV4({ host: { ...emptyHost(), extra: {} } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects an unrecognized field within host.cpu', () => {
  const result = validateMetricsSampleV4(
    validRawV4({ host: { ...emptyHost(), cpu: { notAField: 1 } } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 clamps an out-of-range percent field instead of rejecting', () => {
  const result = validateMetricsSampleV4(
    validRawV4({ host: { ...emptyHost(), cpu: { busyPercent: 150 } } }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.host.cpu.busyPercent, 100)
})

it('validateMetricsSampleV4 rejects a non-numeric host field value', () => {
  const result = validateMetricsSampleV4(
    validRawV4({
      host: { ...emptyHost(), memory: { availableBytes: 'nope' } },
    }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects a networks array exceeding the entity cap', () => {
  const networks = Array.from({ length: 65 }, () => ({}))
  const result = validateMetricsSampleV4(validRawV4({ networks }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects an entity entry missing its id field', () => {
  const result = validateMetricsSampleV4(validRawV4({ gpus: [{ utilizationPercent: 10 }] }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects an unrecognized field on an entity entry', () => {
  const result = validateMetricsSampleV4(
    validRawV4({ gpus: [{ gpuId: 'gpu0', notAField: 1 }] }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 treats an absent numeric field as null', () => {
  const result = validateMetricsSampleV4(validRawV4({ gpus: [{ gpuId: 'gpu0' }] }), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.gpus[0]?.utilizationPercent, null)
})

it('validateMetricsSampleV4 clamps an out-of-range entity field via its descriptor', () => {
  const result = validateMetricsSampleV4(
    validRawV4({ gpus: [{ gpuId: 'gpu0', utilizationPercent: 150 }] }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.gpus[0]?.utilizationPercent, 100)
})

it("validateMetricsSampleV4 requires a hardwareSignal's kind discriminator", () => {
  const result = validateMetricsSampleV4(
    validRawV4({ hardwareSignals: [{ signalId: 'sig0' }] }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 accepts a numaNodes entry without a descriptor entry', () => {
  const result = validateMetricsSampleV4(
    validRawV4({ numaNodes: [{ nodeId: 'node0', freeBytes: 100 }] }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.numaNodes?.[0]?.freeBytes, 100)
})

it('validateMetricsSampleV4 omits numaNodes entirely when absent from the wire payload', () => {
  const result = validateMetricsSampleV4(validRawV4(), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.numaNodes, undefined)
})

it('validateMetricsSampleV4 rejects an events array exceeding the cap', () => {
  const events = Array.from({ length: 129 }, () => ({}))
  const result = validateMetricsSampleV4(validRawV4({ events }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV4 rejects an unrecognized event kind', () => {
  const result = validateMetricsSampleV4(
    validRawV4({
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

it('validateMetricsSampleV4 rejects an unrecognized event severity', () => {
  const result = validateMetricsSampleV4(
    validRawV4({
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

it('validateMetricsSampleV4 does not apply the metadata skew window to event.at', () => {
  const result = validateMetricsSampleV4(
    validRawV4({
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

it('validateMetricsSampleV4 rejects a payload record exceeding the key cap', () => {
  const payload: Record<string, number> = {}
  for (let i = 0; i < 33; i++) payload[`k${i}`] = i
  const result = validateMetricsSampleV4(
    validRawV4({
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

it('validateMetricsSampleV4 accepts a valid event with entityId/source/payload', () => {
  const result = validateMetricsSampleV4(
    validRawV4({
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
