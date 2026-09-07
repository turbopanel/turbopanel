import { assertEquals, assertExists } from '@std/assert'
import type { ServerHardwareProfileUpdate } from '../../lib/db/server-metadata.ts'
import { metricsPaths, metricsSchemas } from './metrics.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type SchemaObject = {
  properties?: Record<string, unknown>
  required?: string[]
  enum?: string[]
  const?: unknown
  additionalProperties?: unknown
  oneOf?: unknown[]
  $ref?: string
}

/**
 * Every field `parseHardwareProfileBody` accepts as a PUT update, mirrored
 * here so `satisfies` fails to compile when `ServerHardwareProfileUpdate`
 * gains or loses a field — the request schema below cannot drift silently.
 *
 * `nicSlotDeviceIds` / `hostingFilesystemId` are included here: unlike
 * `cpuModel` (a detected fact, never operator-set),
 * these stable topology-id pins ARE accepted through this operator PUT
 * body, validated against the server's last recorded topology generation
 * before `mergeServerHardwareProfile` persists them (see
 * `validateHardwareProfileTopologyIds` in `../servers/metrics-routes.ts`).
 */
const HARDWARE_PROFILE_UPDATE_KEYS = {
  cpuTemperature: true,
  cpuPower: true,
  gpuDevice: true,
  gpuFan: true,
  disk1Temperature: true,
  disk2Temperature: true,
  ambient1Temperature: true,
  ambient2Temperature: true,
  boardTemperature: true,
  cpuFan: true,
  systemFan1: true,
  systemFan2: true,
  nic1: true,
  nic2: true,
  nicSlotDeviceIds: true,
  hostingFilesystemId: true,
  hostingPath: true,
  drivetempEnabled: true,
  cpuTdpWattsOverride: true,
  cpuTjMaxCelsiusOverride: true,
} as const satisfies Record<keyof ServerHardwareProfileUpdate, true>

test('metricsPaths documents the client query surface under the client API prefix', () => {
  assertEquals(
    Object.keys(metricsPaths).sort((a, b) => a.localeCompare(b)),
    [
      '/api/client/v1/servers/{id}/metrics/connection',
      '/api/client/v1/servers/{id}/metrics/hardware-profile',
      '/api/client/v1/servers/{id}/metrics/series',
      '/api/client/v1/servers/{id}/metrics/summary',
      '/api/client/v1/servers/metrics/latest',
    ]
  )
})

test('metrics query routes use cookieAuth, never bearerAuth', () => {
  for (const [path, methods] of Object.entries(metricsPaths)) {
    for (const [method, op] of Object.entries(methods as Record<string, { security?: unknown }>)) {
      assertEquals(
        op.security,
        [{ cookieAuth: [] }],
        `${method.toUpperCase()} ${path} should require cookieAuth`
      )
    }
  }
})

test('HostMetricValues is an open string-keyed map of number|null — never a closed v3 enum', () => {
  const schema = metricsSchemas.HostMetricValues as SchemaObject
  assertEquals(schema.properties, undefined)
  assertEquals(schema.additionalProperties, { type: ['number', 'null'] })
})

test('HostSeriesChartPointDerived requires exactly the v5 derived-value set (no v3 storage/http/thermal breakdown)', () => {
  const schema = metricsSchemas.HostSeriesChartPointDerived as SchemaObject
  assertEquals(schema.required, [
    'cpuUsagePercent',
    'memoryUsedBytes',
    'memoryUsedPercent',
    'swapUsedPercent',
    'rootFilesystemUsedBytes',
    'rootFilesystemUsedPercent',
  ])
  assertEquals(Object.keys(schema.properties!).sort(), [...schema.required!].sort())
})

test('HostSeriesChartPoint documents topologyGeneration, never the retired hardwareProfileGeneration', () => {
  const schema = metricsSchemas.HostSeriesChartPoint as SchemaObject
  assertExists(schema.properties?.topologyGeneration)
  assertEquals('hardwareProfileGeneration' in (schema.properties ?? {}), false)
  assertEquals('partsPresent' in (schema.properties ?? {}), false)
})

test('HostSeriesChartPoint documents the optional cpuHotspots payload returned with cpuDetail.* series buckets', () => {
  const schema = metricsSchemas.HostSeriesChartPoint as SchemaObject
  const cpuHotspots = schema.properties?.cpuHotspots as
    { type?: string; items?: { $ref?: string } } | undefined
  assertExists(cpuHotspots)
  assertEquals(cpuHotspots.type, 'array')
  assertEquals(cpuHotspots.items?.$ref, '#/components/schemas/HostSeriesCpuHotspotPoint')
  // Optional — a request with no cpuDetail.* selector never sees this field.
  assertEquals(schema.required?.includes('cpuHotspots'), false)
})

test('HostSeriesCpuHotspotPoint requires coreId (nullable) and values', () => {
  const schema = metricsSchemas.HostSeriesCpuHotspotPoint as SchemaObject
  assertEquals(schema.required, ['coreId', 'values'])
  const coreId = schema.properties?.coreId as { type?: string[] } | undefined
  assertEquals(coreId?.type, ['string', 'null'])
  const values = schema.properties?.values as { $ref?: string } | undefined
  assertEquals(values?.$ref, '#/components/schemas/HostMetricValues')
})

test('HostSeriesChartResponse bundles host/entities/inventory/topologyGeneration and drops every v3-only field', () => {
  const schema = metricsSchemas.HostSeriesChartResponse as SchemaObject
  assertEquals(schema.required, [
    'ok',
    'serverId',
    'from',
    'to',
    'backend',
    'available',
    'resolutionSeconds',
    'host',
    'entities',
    'inventory',
    'topologyGeneration',
    'cpuLimits',
    'temperatureUnit',
    'nicSlotLimit',
  ])
  assertEquals('sensorsAvailable' in (schema.properties ?? {}), false)
  assertEquals('generationBreaks' in (schema.properties ?? {}), false)
  assertEquals('hardwareProfileGenerations' in (schema.properties ?? {}), false)
  assertEquals('metrics' in (schema.properties ?? {}), false)
  assertEquals('points' in (schema.properties ?? {}), false)
  assertEquals((schema.properties!.backend as SchemaObject).enum, [
    'disabled',
    'analytics-engine',
    'duckdb',
  ])
  assertEquals(
    (schema.properties!.host as SchemaObject).oneOf?.length,
    2,
    'host must be nullable — omitted from the request’s metrics selector'
  )
})

test('EntitySeriesResult documents every PerEntityHostedFamilyV5', () => {
  const schema = metricsSchemas.EntitySeriesResult as SchemaObject
  const familySchema = schema.properties!.family as SchemaObject
  assertEquals(familySchema.enum, [
    'gpu',
    'network',
    'filesystem',
    'block',
    'hardware.physical',
    'managed.ingress',
    'managed.database_proxy',
    'cpu.core.live',
  ])
})

test('TopologyInventory documents every entity family except the presence-only managed families', () => {
  const schema = metricsSchemas.TopologyInventory as SchemaObject
  assertEquals(schema.required, [
    'networks',
    'filesystems',
    'blockDevices',
    'gpus',
    'hardwareSignals',
  ])
})

test('HostSummaryChartResponse carries the envelope but not host-series-only fields', () => {
  const schema = metricsSchemas.HostSummaryChartResponse as SchemaObject
  assertEquals(schema.required?.includes('cpuLimits'), true)
  assertEquals(schema.required?.includes('temperatureUnit'), true)
  assertEquals('sensorsAvailable' in (schema.properties ?? {}), false)
  assertEquals('host' in (schema.properties ?? {}), false)
  assertEquals('entities' in (schema.properties ?? {}), false)
})

test('FleetHostSnapshotResponse documents the fixed v5 fleet metric set and per-server derived values, never per-server cpuLimits', () => {
  const schema = metricsSchemas.FleetHostSnapshotResponse as SchemaObject
  assertEquals(schema.required, ['ok', 'from', 'to', 'backend', 'available', 'metrics', 'servers'])
  assertEquals('cpuLimits' in (schema.properties ?? {}), false)

  const server = metricsSchemas.FleetServerUsageRecord as SchemaObject
  assertEquals(server.required, ['serverId', 'latestAt', 'values', 'sampleCount', 'derived'])
  assertEquals(
    (server.properties!.derived as SchemaObject).$ref,
    ['#/components/schemas/HostSeriesChartPointDerived'][0]
  )
})

test('/servers/metrics/latest documents 200/401/503 and no per-server serverId parameter', () => {
  const get = (
    metricsPaths['/api/client/v1/servers/metrics/latest'] as {
      get: {
        parameters: Array<{ name: string }>
        responses: Record<string, unknown>
      }
    }
  ).get
  assertEquals(
    get.parameters.some((p) => p.name === 'id'),
    false
  )
  assertEquals(Object.keys(get.responses).sort(), ['200', '401', '503'])
})

test('ConnectionHistoryChartResponse carries no cpuLimits/temperatureUnit envelope', () => {
  const schema = metricsSchemas.ConnectionHistoryChartResponse as SchemaObject
  assertEquals('cpuLimits' in (schema.properties ?? {}), false)
  assertEquals('temperatureUnit' in (schema.properties ?? {}), false)
})

test('EffectiveCpuThermalLimits documents the resolution-source enum', () => {
  const schema = metricsSchemas.EffectiveCpuThermalLimits as SchemaObject
  assertEquals((schema.properties!.source as SchemaObject).enum, [
    'override',
    'catalog-exact',
    'catalog-family',
    'none',
  ])
})

test('ServerHardwareProfileUpdateRequest documents exactly the parser-accepted fields and rejects unknowns', () => {
  const schema = metricsSchemas.ServerHardwareProfileUpdateRequest as SchemaObject
  assertEquals(
    Object.keys(schema.properties!).sort(),
    Object.keys(HARDWARE_PROFILE_UPDATE_KEYS).sort()
  )
  assertEquals(schema.additionalProperties, false)
  // cpuModel is a detected fact, never accepted through the PUT body.
  assertEquals('cpuModel' in schema.properties!, false)
})

test('ServerHardwareProfile response schema includes the read-only cpuModel field', () => {
  const schema = metricsSchemas.ServerHardwareProfile as SchemaObject
  assertExists(schema.properties?.cpuModel)
  assertExists(schema.properties?.cpuTdpWattsOverride)
  assertExists(schema.properties?.cpuTjMaxCelsiusOverride)
})

test('hardware-profile PUT documents 200/400/401/403/404/503 and the update/response schemas', () => {
  const put = (
    metricsPaths['/api/client/v1/servers/{id}/metrics/hardware-profile'] as {
      put: {
        requestBody: {
          content: { 'application/json': { schema: SchemaObject } }
        }
        responses: Record<string, unknown>
      }
    }
  ).put
  assertEquals(
    put.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/ServerHardwareProfileUpdateRequest'
  )
  assertEquals(Object.keys(put.responses).sort(), ['200', '400', '401', '403', '404', '503'])
})
