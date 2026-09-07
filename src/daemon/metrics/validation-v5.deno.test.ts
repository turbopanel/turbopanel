import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { METRICS_SCHEMA_VERSION_V5 } from './contract-v5.ts'
import { MAX_METRICS_PAYLOAD_BYTES_V5, validateMetricsSampleV5 } from './validation-v5.ts'

/**
 * Deno twin of validation-v5.test.ts (Vitest) so Sonar LCOV attributes
 * validateMetricsSampleV5 coverage from the Deno coverage profile.
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

function validRawV5(
  overrides: Record<string, unknown> & { metadata?: Record<string, unknown> } = {}
) {
  const { metadata, ...top } = overrides
  return {
    type: 'metrics',
    metadata: {
      version: METRICS_SCHEMA_VERSION_V5,
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

it('validateMetricsSampleV5 accepts a minimal valid sample', () => {
  const result = validateMetricsSampleV5(validRawV5(), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.serverId, 'srv-1')
  assertEquals(result.sample.host.cpu.busyPercent, null)
  assertEquals(result.sample.gpus, [])
  assertEquals(result.sample.events, [])
})

it('validateMetricsSampleV5 rejects a non-object payload', () => {
  const result = validateMetricsSampleV5(null, ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects the wrong envelope type', () => {
  const result = validateMetricsSampleV5(validRawV5({ type: 'not-metrics' }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects a payload with no metadata', () => {
  const result = validateMetricsSampleV5({ type: 'metrics' }, ctx())
  assertEquals(result.ok, false)
  if (result.ok) return
  assertEquals(result.reason.includes('metadata'), true)
})

it('validateMetricsSampleV5 rejects an unrecognized top-level field', () => {
  const result = validateMetricsSampleV5(validRawV5({ serverId: 'attacker' }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects oversized payloads via payloadBytes', () => {
  const result = validateMetricsSampleV5(
    validRawV5(),
    ctx({ payloadBytes: MAX_METRICS_PAYLOAD_BYTES_V5 + 1 })
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects a wrong metadata schema version', () => {
  const result = validateMetricsSampleV5(validRawV5({ metadata: { version: 99 } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects sampledAt outside the allowed skew window', () => {
  const result = validateMetricsSampleV5(
    validRawV5({ metadata: { sampledAt: '2000-01-01T00:00:00.000Z' } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects intervalSeconds out of range', () => {
  const result = validateMetricsSampleV5(validRawV5({ metadata: { intervalSeconds: 0 } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects a negative sequence/topologyGeneration/bootGeneration', () => {
  assertEquals(validateMetricsSampleV5(validRawV5({ metadata: { sequence: -1 } }), ctx()).ok, false)
  assertEquals(
    validateMetricsSampleV5(validRawV5({ metadata: { topologyGeneration: -1 } }), ctx()).ok,
    false
  )
  assertEquals(
    validateMetricsSampleV5(validRawV5({ metadata: { bootGeneration: -1 } }), ctx()).ok,
    false
  )
})

it('validateMetricsSampleV5 rejects an invalid collectionMode', () => {
  const result = validateMetricsSampleV5(
    validRawV5({ metadata: { collectionMode: 'turbo' } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects an unrecognized metadata field', () => {
  const result = validateMetricsSampleV5(validRawV5({ metadata: { extra: 'nope' } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects an unrecognized host group', () => {
  const result = validateMetricsSampleV5(validRawV5({ host: { ...emptyHost(), extra: {} } }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects an unrecognized field within host.cpu', () => {
  const result = validateMetricsSampleV5(
    validRawV5({ host: { ...emptyHost(), cpu: { notAField: 1 } } }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 clamps an out-of-range percent field instead of rejecting', () => {
  const result = validateMetricsSampleV5(
    validRawV5({ host: { ...emptyHost(), cpu: { busyPercent: 150 } } }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.host.cpu.busyPercent, 100)
})

it('validateMetricsSampleV5 rejects a non-numeric host field value', () => {
  const result = validateMetricsSampleV5(
    validRawV5({
      host: { ...emptyHost(), memory: { availableBytes: 'nope' } },
    }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects a networks array exceeding the entity cap', () => {
  const networks = Array.from({ length: 65 }, () => ({}))
  const result = validateMetricsSampleV5(validRawV5({ networks }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects an entity entry missing its id field', () => {
  const result = validateMetricsSampleV5(validRawV5({ gpus: [{ utilizationPercent: 10 }] }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects an unrecognized field on an entity entry', () => {
  const result = validateMetricsSampleV5(
    validRawV5({ gpus: [{ gpuId: 'gpu0', notAField: 1 }] }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 treats an absent numeric field as null', () => {
  const result = validateMetricsSampleV5(validRawV5({ gpus: [{ gpuId: 'gpu0' }] }), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.gpus[0]?.utilizationPercent, null)
})

it('validateMetricsSampleV5 clamps an out-of-range entity field via its descriptor', () => {
  const result = validateMetricsSampleV5(
    validRawV5({ gpus: [{ gpuId: 'gpu0', utilizationPercent: 150 }] }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.gpus[0]?.utilizationPercent, 100)
})

it("validateMetricsSampleV5 requires a hardwareSignal's kind discriminator", () => {
  const result = validateMetricsSampleV5(
    validRawV5({ hardwareSignals: [{ signalId: 'sig0' }] }),
    ctx()
  )
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 accepts a numaNodes entry without a descriptor entry', () => {
  const result = validateMetricsSampleV5(
    validRawV5({ numaNodes: [{ nodeId: 'node0', freeBytes: 100 }] }),
    ctx()
  )
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.numaNodes?.[0]?.freeBytes, 100)
})

it('validateMetricsSampleV5 omits numaNodes entirely when absent from the wire payload', () => {
  const result = validateMetricsSampleV5(validRawV5(), ctx())
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.sample.numaNodes, undefined)
})

it('validateMetricsSampleV5 rejects an events array exceeding the cap', () => {
  const events = Array.from({ length: 129 }, () => ({}))
  const result = validateMetricsSampleV5(validRawV5({ events }), ctx())
  assertEquals(result.ok, false)
})

it('validateMetricsSampleV5 rejects an unrecognized event kind', () => {
  const result = validateMetricsSampleV5(
    validRawV5({
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

it('validateMetricsSampleV5 rejects an unrecognized event severity', () => {
  const result = validateMetricsSampleV5(
    validRawV5({
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

it('validateMetricsSampleV5 does not apply the metadata skew window to event.at', () => {
  const result = validateMetricsSampleV5(
    validRawV5({
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

it('validateMetricsSampleV5 rejects a payload record exceeding the key cap', () => {
  const payload: Record<string, number> = {}
  for (let i = 0; i < 33; i++) payload[`k${i}`] = i
  const result = validateMetricsSampleV5(
    validRawV5({
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

it('validateMetricsSampleV5 accepts a valid event with entityId/source/payload', () => {
  const result = validateMetricsSampleV5(
    validRawV5({
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
