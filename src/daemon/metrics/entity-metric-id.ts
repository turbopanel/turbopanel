/**
 * Wire-facing identity for a single v5 metric on a single entity instance —
 * the string queries/routes use to name "this field, on this entity" without
 * re-deriving `MetricEntityScopeV5` plumbing at every call site.
 *
 * Host-singleton scopes (`host.cpu`, `host.kernel`, `host.memory`,
 * `host.storage`, `host.network`, `cpuDetail`, `memoryDetail`) have exactly
 * one instance per server, so their identity is just the descriptor's own
 * `canonicalName` (e.g. `host.cpu.busyPercent`) — no entity id.
 *
 * Per-entity scopes (`network`, `filesystem`, `block`, `gpu`,
 * `hardwareSignal`, `ingress`, `databaseProxy`) can have many
 * instances per server, so their identity prefixes an alias + entity id ahead
 * of the bare field name: `network:eth0.receiveBytesPerSecond`,
 * `hardware:psu1.value`. `hardwareSignal` uses
 * the short alias `hardware` for wire brevity; every other scope's alias
 * matches its scope name.
 *
 * `cpuHotspot` is deliberately NOT a per-entity scope here even though it is
 * an array in the wire contract (`CpuDetailSampleV5.hotspots`) — its 4 slots
 * are embedded fields of the singleton `cpuDetail` family, not independently
 * queryable entities under any id of their own. The `/metrics/series` route
 * surfaces hotspot values as part of the `cpuDetail` singleton response
 * payload instead — see `HostSeriesPointV5.cpuHotspots`.
 *
 * `host.io`'s embedded NIC slots are a related but distinct case: unlike
 * `cpuHotspot`, a slot-mapped NIC keeps its own `network`-scope entity id
 * (`network:<deviceId>.<field>`) and is queryable through the ordinary
 * per-entity path — `EntitySeriesQueryV5.slotMapping` lets the Cloudflare
 * backend reconstruct its `receiveBytesPerSecond`/`transmitBytesPerSecond`
 * from `host.io`'s own rows (see `types-v5.ts`'s `EntitySeriesQueryV5` doc
 * comment). No new scope or alias is needed for that — the id format is
 * identical to any other `network` entity.
 */

import {
  HOST_METRICS_METRIC_DESCRIPTORS_V5,
  type MetricEntityScopeV5,
} from './metric-descriptors-v5.ts'

export type EntityMetricSelector = {
  scope: MetricEntityScopeV5
  entityId?: string
  field: string
}

const SINGLETON_SCOPES: ReadonlySet<MetricEntityScopeV5> = new Set([
  'host.cpu',
  'host.kernel',
  'host.memory',
  'host.storage',
  'host.network',
  'cpuDetail',
  'memoryDetail',
])

/** Per-entity scope -> wire alias. Only `hardwareSignal` differs from its scope name. */
const SCOPE_TO_ALIAS: Partial<Record<MetricEntityScopeV5, string>> = {
  network: 'network',
  filesystem: 'filesystem',
  block: 'block',
  gpu: 'gpu',
  hardwareSignal: 'hardware',
  ingress: 'ingress',
  databaseProxy: 'databaseProxy',
}

const ALIAS_TO_SCOPE: Record<string, MetricEntityScopeV5> = Object.fromEntries(
  Object.entries(SCOPE_TO_ALIAS).map(([scope, alias]) => [alias!, scope as MetricEntityScopeV5])
)

function descriptorFor(scope: MetricEntityScopeV5, field: string): { canonicalName: string } {
  const canonicalName = `${scope}.${field}`
  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V5[canonicalName]
  if (!descriptor) {
    throw new TypeError(`unknown v5 metric field "${field}" for entity scope "${scope}"`)
  }
  return descriptor
}

/** Builds the wire identity for a metric selector, validating it against the descriptor map. */
export function formatEntityMetricId(selector: EntityMetricSelector): string {
  const { canonicalName } = descriptorFor(selector.scope, selector.field)

  if (SINGLETON_SCOPES.has(selector.scope)) {
    if (selector.entityId !== undefined) {
      throw new TypeError(
        `entity scope "${selector.scope}" is host-singleton and takes no entityId`
      )
    }
    return canonicalName
  }

  const alias = SCOPE_TO_ALIAS[selector.scope]
  if (!alias) {
    throw new TypeError(`entity scope "${selector.scope}" has no per-entity identity encoding`)
  }
  if (!selector.entityId) {
    throw new TypeError(`entity scope "${selector.scope}" requires a non-empty entityId`)
  }
  return `${alias}:${selector.entityId}.${selector.field}`
}

/** Parses a wire identity back into a validated selector. Throws on any unknown scope/alias/field. */
export function parseEntityMetricId(id: string): EntityMetricSelector {
  const colonIndex = id.indexOf(':')

  if (colonIndex === -1) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V5[id]
    if (!descriptor || !SINGLETON_SCOPES.has(descriptor.entityScope)) {
      throw new TypeError(`invalid entity metric id "${id}"`)
    }
    return { scope: descriptor.entityScope, field: descriptor.fieldName }
  }

  const alias = id.slice(0, colonIndex)
  const scope = ALIAS_TO_SCOPE[alias]
  if (!scope) {
    throw new TypeError(`unknown entity metric scope alias "${alias}"`)
  }

  const rest = id.slice(colonIndex + 1)
  const dotIndex = rest.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === rest.length - 1) {
    throw new TypeError(`invalid entity metric id "${id}"`)
  }
  const entityId = rest.slice(0, dotIndex)
  const field = rest.slice(dotIndex + 1)

  descriptorFor(scope, field)
  return { scope, entityId, field }
}
