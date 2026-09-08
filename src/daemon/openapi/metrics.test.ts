import { assertEquals, assertStringIncludes } from '@std/assert'
import { METRIC_EVENT_KINDS, METRICS_SCHEMA_VERSION } from '../metrics/contract.ts'
import {
  HOST_METRICS_METRIC_DESCRIPTORS,
  type MetricEntityScope,
} from '../metrics/metric-descriptors.ts'
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
    hardwareSignals: { description: string; items: PropertySchema }
    ingressSources: { items: PropertySchema }
    databaseProxies: { items: PropertySchema }
    events: { items: { $ref: string } }
    diagnostics: PropertySchema & { properties: Record<string, PropertySchema> }
    router: PropertySchema
  }
}

const sample = metricsSchemas.DaemonMetricsSample as unknown as SampleSchema
const event = metricsSchemas.DaemonMetricEvent as unknown as PropertySchema

function fieldNamesForScope(scope: MetricEntityScope): string[] {
  return Object.values(HOST_METRICS_METRIC_DESCRIPTORS)
    .filter((descriptor) => descriptor.entityScope === scope)
    .map((descriptor) => descriptor.fieldName)
    .sort()
}

test('DaemonMetricsSample documents the v6 wire version and required top-level fields', () => {
  assertEquals(METRICS_SCHEMA_VERSION, 6)
  assertEquals(sample.properties.type.const, 'metrics')
  assertEquals(sample.properties.metadata.properties.version!.const, METRICS_SCHEMA_VERSION)
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

test('DaemonMetricsSample host groups match the v6 entity-scope descriptor set exactly', () => {
  const groups: Record<string, MetricEntityScope> = {
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

test('per-entity array items match their v6 entity-scope descriptor set exactly', () => {
  const cases: [keyof SampleSchema['properties'], string[], MetricEntityScope][] = [
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

test('hardwareSignals documents the A2 contract: GPU + drive readings in, fan RPM out', () => {
  const description = sample.properties.hardwareSignals.description
  // GPU temperature / memory temperature / power and per-drive temperature
  // moved off `gpus` / `blockDevices` and onto this array — the prose has to
  // say so, or external daemon consumers are documented against the
  // pre-A2 contract.
  assertStringIncludes(description, 'GPU temperature')
  assertStringIncludes(description, 'GPU memory temperature')
  assertStringIncludes(description, 'GPU power')
  assertStringIncludes(description, 'one temperature per service drive')
  // Fan RPM is the one physical reading that stays out entirely.
  assertStringIncludes(description, 'Never fan RPM')
  // The pre-A2 claim, pinned negatively so a future contract move cannot
  // leave this sentence behind again.
  assertEquals(description.includes('GPU rides `gpus`'), false)
  assertEquals(description.includes('never fan RPM or GPU temp/power'), false)
})

test('router is an optional flat numeric object covering the whole router scope', () => {
  // Host-wide and singleton like `diagnostics` — never a required top-level
  // field, and never an array (unlike `ingressSources`, it has no entity id).
  assertEquals(sample.required.includes('router'), false)
  assertEquals('items' in sample.properties.router, false)
  assertEquals(
    Object.keys(sample.properties.router.properties!).sort(),
    fieldNamesForScope('router')
  )
})

test('ingressSources documents the bucket/duration-sum latency shape, not a stored average', () => {
  const ingressFields = Object.keys(sample.properties.ingressSources.items.properties!)
  assertEquals(ingressFields.includes('requestDurationSecondsSum'), true)
  assertEquals(ingressFields.includes('requestDurationSecondsAvg'), false)
  for (const bucket of ['bucket10ms', 'bucket50ms', 'bucket100ms', 'bucket500ms', 'bucket1s', 'bucket5s']) {
    assertEquals(ingressFields.includes(bucket), true, bucket)
  }
  for (const dropped of ['requestsUnder100ms', 'requestsUnder500ms', 'requestsUnder1s', 'requestsUnder5s']) {
    assertEquals(ingressFields.includes(dropped), false, dropped)
  }
})

test('events reference DaemonMetricEvent, which documents every MetricEventKind', () => {
  assertEquals(sample.properties.events.items.$ref, '#/components/schemas/DaemonMetricEvent')
  assertEquals(event.required, ['eventId', 'at', 'kind', 'severity'])
  assertEquals([...event.properties.kind!.enum!].sort(), [...METRIC_EVENT_KINDS].sort())
  assertEquals(event.properties.severity!.enum, ['info', 'warning', 'critical'])
})

test('diagnostics nests two flat numeric halves that together cover the whole scope', () => {
  assertEquals('cpuDetail' in sample.properties, false)
  assertEquals('memoryDetail' in sample.properties, false)
  assertEquals('cpuCoreLive' in sample.properties, false)
  assertEquals(sample.properties.diagnostics.required, ['cpu', 'memory'])

  const cpu = sample.properties.diagnostics.properties.cpu!
  const memory = sample.properties.diagnostics.properties.memory!
  assertEquals('hotspots' in cpu.properties, false)
  assertEquals(
    [...Object.keys(cpu.properties), ...Object.keys(memory.properties)].sort(),
    fieldNamesForScope('diagnostics').sort()
  )
  // The seven meminfo gauges v6 dropped are gone from the wire schema too.
  for (
    const dropped of [
      'pageTablesBytes',
      'kernelStackBytes',
      'commitLimitBytes',
      'activeAnonBytes',
      'inactiveAnonBytes',
      'activeFileBytes',
      'inactiveFileBytes',
    ]
  ) {
    assertEquals(dropped in memory.properties, false, dropped)
  }
})

test('metrics path describes the v6 entity-scoped ingest sample', () => {
  const path = metricsPaths['/api/daemon/v1/metrics'] as {
    post: { description: string }
  }
  assertStringIncludes(path.post.description, 'v6 entity-scoped metrics sample')
})
