import { describe, expect, it } from 'vitest'
import { METRICS_SCHEMA_VERSION } from './contract.ts'
import { MAX_METRICS_PAYLOAD_BYTES, validateMetricsSample } from './validation.ts'

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

describe('validateMetricsSample', () => {
  it('accepts a minimal valid sample', () => {
    const result = validateMetricsSample(validRaw(), ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sample.serverId).toBe('srv-1')
    expect(result.sample.host.cpu.busyPercent).toBeNull()
    expect(result.sample.gpus).toEqual([])
    expect(result.sample.events).toEqual([])
  })

  it('rejects a non-object payload', () => {
    const result = validateMetricsSample(null, ctx())
    expect(result.ok).toBe(false)
  })

  it('rejects the wrong envelope type', () => {
    const result = validateMetricsSample(validRaw({ type: 'not-metrics' }), ctx())
    expect(result.ok).toBe(false)
  })

  it('rejects a payload with no metadata', () => {
    const result = validateMetricsSample({ type: 'metrics' }, ctx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('metadata')
  })

  it('rejects an unrecognized top-level field', () => {
    const result = validateMetricsSample(validRaw({ serverId: 'attacker' }), ctx())
    expect(result.ok).toBe(false)
  })

  it('rejects oversized payloads via payloadBytes', () => {
    const result = validateMetricsSample(
      validRaw(),
      ctx({ payloadBytes: MAX_METRICS_PAYLOAD_BYTES + 1 })
    )
    expect(result.ok).toBe(false)
  })

  describe('metadata', () => {
    it('rejects a wrong schema version', () => {
      const result = validateMetricsSample(validRaw({ metadata: { version: 99 } }), ctx())
      expect(result.ok).toBe(false)
    })

    it('rejects sampledAt outside the allowed skew window', () => {
      const result = validateMetricsSample(
        validRaw({
          metadata: { sampledAt: '2000-01-01T00:00:00.000Z' },
        }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects intervalSeconds out of range', () => {
      const result = validateMetricsSample(
        validRaw({ metadata: { intervalSeconds: 0 } }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects a negative sequence/topologyGeneration/bootGeneration', () => {
      expect(validateMetricsSample(validRaw({ metadata: { sequence: -1 } }), ctx()).ok).toBe(
        false
      )
      expect(
        validateMetricsSample(validRaw({ metadata: { topologyGeneration: -1 } }), ctx()).ok
      ).toBe(false)
      expect(
        validateMetricsSample(validRaw({ metadata: { bootGeneration: -1 } }), ctx()).ok
      ).toBe(false)
    })

    it('rejects the removed collectionMode metadata field', () => {
      const result = validateMetricsSample(
        validRaw({ metadata: { collectionMode: 'baseline' } }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized metadata field', () => {
      const result = validateMetricsSample(validRaw({ metadata: { extra: 'nope' } }), ctx())
      expect(result.ok).toBe(false)
    })
  })

  describe('host', () => {
    it('rejects an unrecognized host group', () => {
      const result = validateMetricsSample(
        validRaw({ host: { ...emptyHost(), extra: {} } }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized field within host.cpu', () => {
      const result = validateMetricsSample(
        validRaw({
          host: { ...emptyHost(), cpu: { notAField: 1 } },
        }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('clamps an out-of-range percent field instead of rejecting', () => {
      const result = validateMetricsSample(
        validRaw({
          host: { ...emptyHost(), cpu: { busyPercent: 150 } },
        }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.host.cpu.busyPercent).toBe(100)
    })

    it('rejects a non-numeric host field value', () => {
      const result = validateMetricsSample(
        validRaw({
          host: { ...emptyHost(), memory: { usedBytes: 'nope' } },
        }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('accepts a non-empty current-shape host sample using collector-emitted v6 fields', () => {
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
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.host.cpu.saturatedCoreCount).toBe(2)
      expect(result.sample.host.memory.usedBytes).toBe(1_000_000)
      expect(result.sample.host.memory.cachedFilesBytes).toBe(250_000)
      expect(result.sample.host.storage.diskLatencyMs).toBe(1.8)
    })
  })

  describe('entity arrays', () => {
    it('rejects a networks array exceeding the entity cap', () => {
      const networks = Array.from({ length: 65 }, () => ({}))
      const result = validateMetricsSample(validRaw({ networks }), ctx())
      expect(result.ok).toBe(false)
    })

    it('rejects an entity entry missing its id field', () => {
      const result = validateMetricsSample(
        validRaw({ gpus: [{ utilizationPercent: 10 }] }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized field on an entity entry', () => {
      const result = validateMetricsSample(
        validRaw({ gpus: [{ gpuId: 'gpu0', notAField: 1 }] }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('treats an absent numeric field as null', () => {
      const result = validateMetricsSample(validRaw({ gpus: [{ gpuId: 'gpu0' }] }), ctx())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.gpus[0]?.utilizationPercent).toBeNull()
    })

    it('clamps an out-of-range entity field via its descriptor', () => {
      const result = validateMetricsSample(
        validRaw({
          gpus: [{ gpuId: 'gpu0', utilizationPercent: 150 }],
        }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.gpus[0]?.utilizationPercent).toBe(100)
    })

    it("requires a hardwareSignal's kind discriminator", () => {
      const result = validateMetricsSample(
        validRaw({ hardwareSignals: [{ signalId: 'sig0' }] }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects the removed numaNodes top-level field', () => {
      const result = validateMetricsSample(
        validRaw({
          numaNodes: [{ nodeId: 'node0', freeBytes: 100 }],
        }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('omits diagnostics entirely when absent from the wire payload', () => {
      const result = validateMetricsSample(validRaw(), ctx())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.diagnostics).toBeUndefined()
    })

    it('parses both nested diagnostics halves', () => {
      const result = validateMetricsSample(
        validRaw({
          diagnostics: {
            cpu: { averageFrequencyMHz: 2400, cpuIrqPercent: 150 },
            memory: { memoryFreeBytes: 4096 },
          },
        }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.diagnostics?.cpu.averageFrequencyMHz).toBe(2400)
      // Clamped by the descriptor's percent bounds.
      expect(result.sample.diagnostics?.cpu.cpuIrqPercent).toBe(100)
      expect(result.sample.diagnostics?.memory.memoryFreeBytes).toBe(4096)
      // A field absent from the payload is null, never 0.
      expect(result.sample.diagnostics?.memory.dirtyBytes).toBeNull()
    })

    it('rejects an unknown key inside a diagnostics half', () => {
      const result = validateMetricsSample(
        validRaw({ diagnostics: { cpu: { nope: 1 }, memory: {} } }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })

    it('rejects a diagnostics block missing either half', () => {
      for (const partial of [{ cpu: {} }, { memory: {} }]) {
        const result = validateMetricsSample(validRaw({ diagnostics: partial }), ctx())
        expect(result.ok).toBe(false)
      }
    })

    it('rejects an unknown diagnostics group', () => {
      const result = validateMetricsSample(
        validRaw({ diagnostics: { cpu: {}, memory: {}, disk: {} } }),
        ctx()
      )
      expect(result.ok).toBe(false)
    })
  })

  describe('router', () => {
    it('omits router entirely when absent from the wire payload', () => {
      const result = validateMetricsSample(validRaw(), ctx())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.router).toBeUndefined()
    })

    it('parses the flat router block, nulling fields the payload omitted', () => {
      const result = validateMetricsSample(
        validRaw({ router: { backendsUp: 2, backendsTotal: 3, tlsCertSoonestExpiryDays: 45 } }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.router?.backendsUp).toBe(2)
      expect(result.sample.router?.backendsTotal).toBe(3)
      expect(result.sample.router?.tlsCertSoonestExpiryDays).toBe(45)
      // A field absent from the payload is null, never 0.
      expect(result.sample.router?.configReloads).toBeNull()
    })

    it('rejects an unknown key inside the router block', () => {
      const result = validateMetricsSample(validRaw({ router: { nope: 1 } }), ctx())
      expect(result.ok).toBe(false)
    })

    it('rejects a non-object router block and a non-numeric router field', () => {
      expect(validateMetricsSample(validRaw({ router: 1 }), ctx()).ok).toBe(false)
      expect(validateMetricsSample(validRaw({ router: { backendsUp: 'x' } }), ctx()).ok).toBe(
        false
      )
    })
  })

  describe('storage / dockerUsage', () => {
    const emptyEngine = {
      instancesRunning: null,
      instancesHealthy: null,
      connectionsUsed: null,
      connectionsMax: null,
    }

    it('omits both blocks entirely when absent from the wire payload', () => {
      const result = validateMetricsSample(validRaw(), ctx())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.storage).toBeUndefined()
      expect(result.sample.dockerUsage).toBeUndefined()
    })

    it('parses a storage block with its three nested engine groups', () => {
      const result = validateMetricsSample(
        validRaw({
          storage: {
            hostingUsedBytes: 4096,
            postgres: { instancesRunning: 2 },
            mysql: emptyEngine,
            mariadb: emptyEngine,
          },
        }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.storage?.hostingUsedBytes).toBe(4096)
      expect(result.sample.storage?.postgres.instancesRunning).toBe(2)
      // Fields absent from the payload are null, never 0 — at both levels.
      expect(result.sample.storage?.logsFreeBytes).toBeNull()
      expect(result.sample.storage?.postgres.connectionsMax).toBeNull()
    })

    it('rejects unknown keys at either storage level', () => {
      expect(validateMetricsSample(validRaw({ storage: { nope: 1 } }), ctx()).ok).toBe(false)
      expect(
        validateMetricsSample(
          validRaw({
            storage: { postgres: { nope: 1 }, mysql: emptyEngine, mariadb: emptyEngine },
          }),
          ctx()
        ).ok
      ).toBe(false)
    })

    it('rejects a non-object storage block and a non-numeric storage field', () => {
      expect(validateMetricsSample(validRaw({ storage: 1 }), ctx()).ok).toBe(false)
      expect(
        validateMetricsSample(validRaw({ storage: { hostingUsedBytes: 'x' } }), ctx()).ok
      ).toBe(false)
    })

    it('parses the flat dockerUsage block, nulling fields the payload omitted', () => {
      const result = validateMetricsSample(
        validRaw({ dockerUsage: { layersBytes: 6000, imagesCount: 4 } }),
        ctx()
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.dockerUsage?.layersBytes).toBe(6000)
      expect(result.sample.dockerUsage?.buildCacheReclaimableBytes).toBeNull()
    })

    it('rejects an unknown key inside the dockerUsage block', () => {
      expect(validateMetricsSample(validRaw({ dockerUsage: { nope: 1 } }), ctx()).ok).toBe(false)
      expect(validateMetricsSample(validRaw({ dockerUsage: 1 }), ctx()).ok).toBe(false)
    })
  })

  describe('events', () => {
    it('rejects an events array exceeding the cap', () => {
      const events = Array.from({ length: 129 }, () => ({}))
      const result = validateMetricsSample(validRaw({ events }), ctx())
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized event kind', () => {
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
      expect(result.ok).toBe(false)
    })

    it('rejects an unrecognized event severity', () => {
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
      expect(result.ok).toBe(false)
    })

    it('does not apply the metadata skew window to event.at', () => {
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
      expect(result.ok).toBe(true)
    })

    it('rejects a payload record exceeding the key cap', () => {
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
      expect(result.ok).toBe(false)
    })

    it('accepts a valid event with entityId/source/payload', () => {
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
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sample.events).toHaveLength(1)
      expect(result.sample.events[0]?.entityId).toBe('eth0')
      expect(result.sample.events[0]?.payload?.retries).toBe(3)
    })
  })
})
