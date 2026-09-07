import { assertEquals, assertStringIncludes } from '@std/assert'
import { METRIC_EVENT_KINDS_V5, METRICS_SCHEMA_VERSION_V5 } from '../metrics/contract-v5.ts'
import {
  HOST_METRICS_METRIC_DESCRIPTORS_V5,
  type MetricEntityScopeV5,
} from '../metrics/metric-descriptors-v5.ts'
import { metricsPaths, metricsSchemas } from './metrics.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type PropertySchema = {
  required?: string[]
  properties: Record<string, { const?: unknown; enum?: unknown[] }>
  additionalProperties?: boolean
}

type SampleSchema = {
  required: string[]
  properties: {
    type: { const: string }
    metadata: PropertySchema
    host: PropertySchema & {
      properties: Record<string, { properties: Record<string, unknown> }>
    }
    networks: { items: PropertySchema }
    filesystems: { items: PropertySchema }
    blockDevices: { items: PropertySchema }
    gpus: { items: PropertySchema }
    hardwareSignals: { items: PropertySchema }
    ingressSources: { items: PropertySchema }
    databaseProxies: { items: PropertySchema }
    events: { items: { $ref: string } }
    cpuDetail: PropertySchema & {
      properties: { hotspots: { items: PropertySchema } }
    }
    memoryDetail: PropertySchema
    cpuCoreLive: { items: PropertySchema }
  }
}

const sample = metricsSchemas.DaemonMetricsSampleV5 as unknown as SampleSchema
const event = metricsSchemas.DaemonMetricEventV5 as unknown as PropertySchema

function fieldNamesForScope(scope: MetricEntityScopeV5): string[] {
  return Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V5)
    .filter((descriptor) => descriptor.entityScope === scope)
    .map((descriptor) => descriptor.fieldName)
    .sort()
}

test('DaemonMetricsSampleV5 documents the v5 wire version and required top-level fields', () => {
  assertEquals(METRICS_SCHEMA_VERSION_V5, 5)
  assertEquals(sample.properties.type.const, 'metrics')
  assertEquals(sample.properties.metadata.properties.version!.const, METRICS_SCHEMA_VERSION_V5)
  assertEquals(sample.required.includes('metadata'), true)
  assertEquals(sample.required.includes('host'), true)
  assertEquals(
    [
      'networks',
      'filesystems',
      'blockDevices',
      'gpus',
      'hardwareSignals',
      'ingressSources',
      'databaseProxies',
      'events',
    ].every((field) => sample.required.includes(field)),
    true
  )
  // Never a v3-shaped field.
  assertEquals('parts' in sample.properties, false)
  assertEquals('dimensions' in sample.properties, false)
})

test('DaemonMetricsSampleV5 host groups match the v5 entity-scope descriptor set exactly', () => {
  const groups: Record<string, MetricEntityScopeV5> = {
    cpu: 'host.cpu',
    kernel: 'host.kernel',
    memory: 'host.memory',
    storage: 'host.storage',
    network: 'host.network',
  }
  for (const [group, scope] of Object.entries(groups)) {
    assertEquals(
      Object.keys(sample.properties.host.properties[group]!.properties).sort(),
      fieldNamesForScope(scope)
    )
  }
})

test('ingressSources / databaseProxies entities are keyed by sourceId, not sourceKind', () => {
  assertEquals(sample.properties.ingressSources.items.required, ['sourceId', 'sourceKind'])
  assertEquals(sample.properties.databaseProxies.items.required, ['sourceId', 'sourceKind'])
  assertEquals(
    Object.keys(sample.properties.ingressSources.items.properties).sort(),
    ['sourceId', 'sourceKind', ...fieldNamesForScope('ingress')].sort()
  )
  assertEquals(
    Object.keys(sample.properties.databaseProxies.items.properties).sort(),
    ['sourceId', 'sourceKind', ...fieldNamesForScope('databaseProxy')].sort()
  )
})

test('per-entity array items match their v5 entity-scope descriptor set exactly', () => {
  const cases: [keyof SampleSchema['properties'], string[], MetricEntityScopeV5][] = [
    ['networks', ['deviceId'], 'network'],
    ['filesystems', ['filesystemId'], 'filesystem'],
    ['blockDevices', ['deviceId'], 'block'],
    ['gpus', ['gpuId'], 'gpu'],
    ['hardwareSignals', ['signalId', 'kind'], 'hardwareSignal'],
  ]
  for (const [field, idFields, scope] of cases) {
    const items = (sample.properties[field] as { items: PropertySchema }).items
    assertEquals([...items.required!].sort(), [...idFields].sort())
    assertEquals(
      Object.keys(items.properties).sort(),
      [...idFields, ...fieldNamesForScope(scope)].sort()
    )
  }
})

test('events reference DaemonMetricEventV5, which documents every MetricEventKindV5', () => {
  assertEquals(sample.properties.events.items.$ref, '#/components/schemas/DaemonMetricEventV5')
  assertEquals(event.required, ['eventId', 'at', 'kind', 'severity'])
  assertEquals([...event.properties.kind!.enum!].sort(), [...METRIC_EVENT_KINDS_V5].sort())
  assertEquals(event.properties.severity!.enum, ['info', 'warning', 'critical'])
})

test('metrics path describes the v5 entity-scoped ingest sample', () => {
  const path = metricsPaths['/api/daemon/v1/metrics'] as {
    post: { description: string }
  }
  assertStringIncludes(path.post.description, 'v5 entity-scoped metrics sample')
})
