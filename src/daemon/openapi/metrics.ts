import {
  HOST_METRICS_METRIC_DESCRIPTORS_V4,
  type MetricEntityScopeV4,
} from '../metrics/metric-descriptors-v4.ts'
import { METRIC_EVENT_KINDS_V4, METRICS_SCHEMA_VERSION_V4 } from '../metrics/contract-v4.ts'

/** Every descriptor-backed numeric field for `scope`, keyed by `fieldName` — the same grouping `field-map-v4.ts` uses to pack physical storage. */
function numericPropertiesForScope(
  scope: MetricEntityScopeV4
): Record<string, { type: readonly ['number', 'null'] }> {
  const properties: Record<string, { type: readonly ['number', 'null'] }> = {}
  for (const descriptor of Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V4)) {
    if (descriptor.entityScope === scope) {
      properties[descriptor.fieldName] = { type: ['number', 'null'] as const }
    }
  }
  return properties
}

function hostGroupSchema(scope: MetricEntityScopeV4) {
  return {
    type: 'object',
    properties: numericPropertiesForScope(scope),
    additionalProperties: false,
  }
}

/**
 * `cpuDetail`'s schema: its 7 host-wide scalar fields plus the required
 * `hotspots` array (the daemon's up-to-4 busiest logical cores this
 * interval) — unlike `memoryDetail`, `cpuDetail` isn't a flat
 * {@link hostGroupSchema} because `hotspots` isn't itself a numeric
 * descriptor field.
 */
function cpuDetailSchema() {
  return {
    type: 'object',
    required: ['hotspots'],
    properties: {
      ...numericPropertiesForScope('cpuDetail'),
      hotspots: {
        type: 'array',
        description: "The daemon's up-to-4 busiest logical cores this interval.",
        items: entityArraySchema('cpuHotspot', ['coreId']),
      },
    },
    additionalProperties: false,
  }
}

/** A per-entity array item schema: `idFields` (string identity/discriminator columns) plus every descriptor-backed numeric field for `scope`. */
function entityArraySchema(scope: MetricEntityScopeV4, idFields: readonly string[]) {
  const idProperties = Object.fromEntries(
    idFields.map((field) => [field, { type: 'string' as const }])
  )
  return {
    type: 'object',
    required: [...idFields],
    properties: { ...idProperties, ...numericPropertiesForScope(scope) },
    additionalProperties: false,
  }
}

export const metricsSchemas = {
  DaemonMetricsSampleV4: {
    type: 'object',
    required: [
      'type',
      'metadata',
      'host',
      'networks',
      'filesystems',
      'blockDevices',
      'gpus',
      'hardwareSignals',
      'ingressSources',
      'databaseProxies',
      'events',
    ],
    properties: {
      type: { type: 'string', const: 'metrics' },
      metadata: {
        type: 'object',
        required: [
          'version',
          'sampledAt',
          'intervalSeconds',
          'sequence',
          'collectionMode',
          'topologyGeneration',
          'bootGeneration',
        ],
        properties: {
          version: { type: 'integer', const: METRICS_SCHEMA_VERSION_V4 },
          sampledAt: { type: 'string', format: 'date-time' },
          intervalSeconds: { type: 'number' },
          sequence: { type: 'integer' },
          collectionMode: { type: 'string', enum: ['baseline', 'live'] },
          topologyGeneration: {
            type: 'integer',
            description:
              'Topology (sensor/NIC/slot layout) generation this sample was collected under.',
          },
          bootGeneration: {
            type: 'integer',
            description: 'Host boot generation this sample was collected under.',
          },
        },
        additionalProperties: false,
      },
      host: {
        type: 'object',
        description:
          'Host-singleton metrics (no entity id — exactly one value per sample), grouped by subsystem.',
        required: ['cpu', 'kernel', 'memory', 'storage', 'network'],
        properties: {
          cpu: hostGroupSchema('host.cpu'),
          kernel: hostGroupSchema('host.kernel'),
          memory: hostGroupSchema('host.memory'),
          storage: hostGroupSchema('host.storage'),
          network: hostGroupSchema('host.network'),
        },
        additionalProperties: false,
      },
      networks: {
        type: 'array',
        items: entityArraySchema('network', ['deviceId']),
      },
      filesystems: {
        type: 'array',
        items: entityArraySchema('filesystem', ['filesystemId']),
      },
      blockDevices: {
        type: 'array',
        items: entityArraySchema('block', ['deviceId']),
      },
      gpus: {
        type: 'array',
        items: entityArraySchema('gpu', ['gpuId']),
      },
      hardwareSignals: {
        type: 'array',
        description:
          'Conservative physical sensor readings (CPU package temp/power, storage temp, board temps, plus synthetic hottest-core/thermal-throttled CPU signals) — dynamic count per host, never fan RPM or GPU temp/power (GPU rides `gpus` instead).',
        items: entityArraySchema('hardwareSignal', ['signalId', 'kind']),
      },
      ingressSources: {
        type: 'array',
        description:
          'One entry per distinct ingress-adapter source instance, keyed by `sourceId` — two sources sharing the same `sourceKind` (e.g. two Caddy instances) are still distinct entities.',
        items: entityArraySchema('ingress', ['sourceId', 'sourceKind']),
      },
      databaseProxies: {
        type: 'array',
        description:
          'One entry per distinct database-proxy source instance, keyed by `sourceId` — same identity rule as `ingressSources`.',
        items: entityArraySchema('databaseProxy', ['sourceId', 'sourceKind']),
      },
      events: {
        type: 'array',
        description:
          'Discrete state-change/fault signals distinct from the continuous numeric metrics above.',
        items: { $ref: '#/components/schemas/DaemonMetricEventV4' },
      },
      cpuDetail: cpuDetailSchema(),
      memoryDetail: hostGroupSchema('memoryDetail'),
      cpuCoreLive: {
        type: 'array',
        description:
          'Per-core live breakdown (live sessions only) — one entry per online logical core.',
        items: entityArraySchema('cpuCore', ['coreId']),
      },
      numaNodes: {
        type: 'array',
        description: 'Reserved conceptual family — not yet populated by any collector.',
        items: {
          type: 'object',
          required: ['nodeId'],
          properties: {
            nodeId: { type: 'string' },
            freeBytes: { type: ['number', 'null'] },
            totalBytes: { type: ['number', 'null'] },
            localAllocationsPerSecond: { type: ['number', 'null'] },
            foreignAllocationsPerSecond: { type: ['number', 'null'] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  DaemonMetricEventV4: {
    type: 'object',
    required: ['eventId', 'at', 'kind', 'severity'],
    properties: {
      eventId: { type: 'string' },
      at: { type: 'string', format: 'date-time' },
      kind: { type: 'string', enum: [...METRIC_EVENT_KINDS_V4] },
      severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
      entityId: { type: 'string' },
      source: { type: 'string' },
      payload: {
        type: 'object',
        description: 'Small event-specific detail bag — string/number/boolean/null leaves only.',
      },
    },
    additionalProperties: false,
  },
  DaemonMetricsAcceptedResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
    },
  },
}

export const metricsPaths: Record<string, unknown> = {
  '/api/daemon/v1/metrics': {
    post: {
      tags: ['Daemon'],
      summary: 'Ingest host metrics sample',
      description:
        'Authenticated daemon posts a v4 entity-scoped metrics sample. ' +
        'serverId is taken from the JWT `sub` — never from the body. ' +
        'Writes are fire-and-forget to Analytics Engine / DuckDB; ' +
        'never wakes the Durable Object.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/DaemonMetricsSampleV4' },
          },
        },
      },
      responses: {
        '202': {
          description: 'Metrics sample accepted',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/DaemonMetricsAcceptedResponse',
              },
            },
          },
        },
        '400': {
          description: 'Invalid metrics payload',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DaemonErrorResponse' },
            },
          },
        },
        '401': {
          description: 'Missing or invalid daemon JWT',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DaemonErrorResponse' },
            },
          },
        },
        '429': {
          description: 'Rate limited',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'error'],
                properties: {
                  ok: { type: 'boolean', const: false },
                  error: { type: 'string', const: 'rate_limited' },
                },
              },
            },
          },
        },
      },
    },
  },
}
