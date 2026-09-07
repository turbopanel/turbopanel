import { describe, expect, it } from 'vitest'
import { METRICS_SCHEMA_VERSION_V5 } from './contract-v5.ts'
import { MAX_METRICS_PAYLOAD_BYTES_V5, validateMetricsSampleV5 } from './validation-v5.ts'

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

/** Minimal valid v5 frame — every entity array/optional empty, every host field absent (→ null). */
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

describe('validateMetricsSampleV5', () => {
  it('accepts a minimal valid sample', () => {
    const result = validateMetricsSampleV5(validRawV5(), ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sample.serverId).toBe('srv-1')
    expect(result.sample.host.cpu.busyPercent).toBeNull()
    expect(result.sample.gpus).toEqual([])
    expect(result.sample.events).toEqual([])
  })

  it('rejects a non-object payload', () => {
    const result = validateMetricsSampleV5(null, ctx())
    expect(result.ok).toBe(false)
  })

  it('rejects the wrong envelope type', () => {
    const result = validateMetricsSampleV5(validRawV5({ type: 'not-metrics' }), ctx())
    expect(result.ok).toBe(false)
  })

  it('rejects a payload with no metadata', () => {
    const result = validateMetricsSampleV5({ type: 'metrics' }, ctx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('metadata')
  })

  it('rejects an unrecognized top-level field', () => {
    const result = validateMetricsSampleV5(validRawV5({ serverId: 'attacker' }), ctx())
    expect(result.ok).toBe(false)
  })

  it('rejects oversized payloads via payloadBytes', () => {
    const result = validateMetricsSampleV5(
      validRawV5(),
      ctx({ payloadBytes: MAX_METRICS_PAYLOAD_BYTES_V5 + 1 })
    )
    expect(result.ok).toBe(false)
  })

  describe('metadata', () => {
    it('rejects a wrong schema version', () => {
      const result = validateMetricsSampleV5(validRawV5({ metadata: { version: 99 } }), ctx())
      expect(result.ok).toBe(false)
    })

    it('rejects sampledAt outside the allowed skew window', () => {
      const result = validateMetricsSampleV5(
        validRawV5({
          metadata: { sampledAt: '2000-01-01T00:00:00.000Z' },
        }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects intervalSeconds out of range', () => {
      const result = validateMetricsSampleV5(
        validRawV5({ metadata: { intervalSeconds: 0 } }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects a negative sequence/topologyGeneration/bootGeneration', () => {
      expect(validateMetricsSampleV5(validRawV5({ metadata: { sequence: -1 } }), ctx()).ok).toBe(
        false
      )
      expect(
        validateMetricsSampleV5(validRawV5({ metadata: { topologyGeneration: -1 } }), ctx()).ok
      ).toBe(false)
      expect(
        validateMetricsSampleV5(validRawV5({ metadata: { bootGeneration: -1 } }), ctx()).ok
      ).toBe(false)
    })

    it('rejects an invalid collectionMode', () => {
      const result = validateMetricsSampleV5(
        validRawV5({ metadata: { collectionMode: 'turbo' } }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized metadata field', () => {
      const result = validateMetricsSampleV5(validRawV5({ metadata: { extra: 'nope' } }), ctx())
      expect(result.ok).toBe(false)
    })
  })

  describe('host', () => {
    it('rejects an unrecognized host group', () => {
      const result = validateMetricsSampleV5(
        validRawV5({ host: { ...emptyHost(), extra: {} } }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized field within host.cpu', () => {
      const result = validateMetricsSampleV5(
        validRawV5({
          host: { ...emptyHost(), cpu: { notAField: 1 } },
        }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('clamps an out-of-range percent field instead of rejecting', () => {
      const result = validateMetricsSampleV5(
        validRawV5({
          host: { ...emptyHost(), cpu: { busyPercent: 150 } },
        }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.host.cpu.busyPercent).toBe(100)
    })

    it('rejects a non-numeric host field value', () => {
      const result = validateMetricsSampleV5(
        validRawV5({
          host: { ...emptyHost(), memory: { availableBytes: 'nope' } },
        }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })
  })

  describe('entity arrays', () => {
    it('rejects a networks array exceeding the entity cap', () => {
      const networks = Array.from({ length: 65 }, () => ({}))
      const result = validateMetricsSampleV5(validRawV5({ networks }), ctx())
      expect(result.ok).toBe(false)
    })

    it('rejects an entity entry missing its id field', () => {
      const result = validateMetricsSampleV5(
        validRawV5({ gpus: [{ utilizationPercent: 10 }] }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized field on an entity entry', () => {
      const result = validateMetricsSampleV5(
        validRawV5({ gpus: [{ gpuId: 'gpu0', notAField: 1 }] }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('treats an absent numeric field as null', () => {
      const result = validateMetricsSampleV5(validRawV5({ gpus: [{ gpuId: 'gpu0' }] }), ctx())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.gpus[0]?.utilizationPercent).toBeNull()
    })

    it('clamps an out-of-range entity field via its descriptor', () => {
      const result = validateMetricsSampleV5(
        validRawV5({
          gpus: [{ gpuId: 'gpu0', utilizationPercent: 150 }],
        }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.gpus[0]?.utilizationPercent).toBe(100)
    })

    it("requires a hardwareSignal's kind discriminator", () => {
      const result = validateMetricsSampleV5(
        validRawV5({ hardwareSignals: [{ signalId: 'sig0' }] }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('accepts a numaNodes entry without a descriptor entry', () => {
      const result = validateMetricsSampleV5(
        validRawV5({
          numaNodes: [{ nodeId: 'node0', freeBytes: 100 }],
        }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.numaNodes?.[0]?.freeBytes).toBe(100)
    })

    it('omits numaNodes entirely when absent from the wire payload', () => {
      const result = validateMetricsSampleV5(validRawV5(), ctx())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.numaNodes).toBeUndefined()
    })
  })

  describe('events', () => {
    it('rejects an events array exceeding the cap', () => {
      const events = Array.from({ length: 129 }, () => ({}))
      const result = validateMetricsSampleV5(validRawV5({ events }), ctx())
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized event kind', () => {
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
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized event severity', () => {
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
      expect(result.ok).toBe(false)
    })

    it('does not apply the metadata skew window to event.at', () => {
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
      expect(result.ok).toBe(true)
    })

    it('rejects a payload record exceeding the key cap', () => {
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
      expect(result.ok).toBe(false)
    })

    it('accepts a valid event with entityId/source/payload', () => {
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
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.events).toHaveLength(1)
      expect(result.sample.events[0]?.entityId).toBe('eth0')
      expect(result.sample.events[0]?.payload?.retries).toBe(3)
    })
  })
})
