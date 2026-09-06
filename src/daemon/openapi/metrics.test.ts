import { assertEquals, assertStringIncludes } from '@std/assert'
import { METRIC_EVENT_KINDS_V4, METRICS_SCHEMA_VERSION_V4 } from '../metrics/contract-v4.ts'
import {
  HOST_METRICS_METRIC_DESCRIPTORS_V4,
  type MetricEntityScopeV4,
} from '../metrics/metric-descriptors-v4.ts'
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

const sample = metricsSchemas.DaemonMetricsSampleV4 as unknown as SampleSchema
const event = metricsSchemas.DaemonMetricEventV4 as unknown as PropertySchema

function fieldNamesForScope(scope: MetricEntityScopeV4): string[] {
  return Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V4)
    .filter((descriptor) => descriptor.entityScope === scope)
    .map((descriptor) => descriptor.fieldName)
    .sort()
}

test('DaemonMetricsSampleV4 documents the v4 wire version and required top-level fields', () => {
  assertEquals(METRICS_SCHEMA_VERSION_V4, 4)
  assertEquals(sample.properties.type.const, 'metrics')
  assertEquals(sample.properties.metadata.properties.version!.const, METRICS_SCHEMA_VERSION_V4)
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

test('DaemonMetricsSampleV4 host groups match the v4 entity-scope descriptor set exactly', () => {
  const groups: Record<string, MetricEntityScopeV4> = {
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

test('per-entity array items match their v4 entity-scope descriptor set exactly', () => {
  const cases: [keyof SampleSchema['properties'], string[], MetricEntityScopeV4][] = [
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

test('events reference DaemonMetricEventV4, which documents every MetricEventKindV4', () => {
  assertEquals(sample.properties.events.items.$ref, '#/components/schemas/DaemonMetricEventV4')
  assertEquals(event.required, ['eventId', 'at', 'kind', 'severity'])
  assertEquals([...event.properties.kind!.enum!].sort(), [...METRIC_EVENT_KINDS_V4].sort())
  assertEquals(event.properties.severity!.enum, ['info', 'warning', 'critical'])
})

test('cpuDetail documents its scalar fields plus a required hotspots array scoped to cpuHotspot', () => {
  assertEquals(sample.properties.cpuDetail.required, ['hotspots'])
  assertEquals(
    Object.keys(sample.properties.cpuDetail.properties).sort(),
    ['hotspots', ...fieldNamesForScope('cpuDetail')].sort()
  )
  const hotspotItems = sample.properties.cpuDetail.properties.hotspots.items
  assertEquals(hotspotItems.required, ['coreId'])
  assertEquals(
    Object.keys(hotspotItems.properties).sort(),
    ['coreId', ...fieldNamesForScope('cpuHotspot')].sort()
  )
})

test('memoryDetail documents exactly its flat scalar field set (no entity id — host-singleton)', () => {
  assertEquals(
    Object.keys(sample.properties.memoryDetail.properties).sort(),
    fieldNamesForScope('memoryDetail')
  )
})

test('cpuCoreLive documents one entry per online logical core, scoped to cpuCore', () => {
  const items = sample.properties.cpuCoreLive.items
  assertEquals(items.required, ['coreId'])
  assertEquals(
    Object.keys(items.properties).sort(),
    ['coreId', ...fieldNamesForScope('cpuCore')].sort()
  )
})

test('metrics path describes the v4 entity-scoped ingest sample', () => {
  const path = metricsPaths['/api/daemon/v1/metrics'] as {
    post: { description: string }
  }
  assertStringIncludes(path.post.description, 'v4 entity-scoped metrics sample')
})
