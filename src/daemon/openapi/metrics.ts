import {
  DIAGNOSTICS_CPU_FIELD_NAMES,
  DIAGNOSTICS_MEMORY_FIELD_NAMES,
  HOST_METRICS_METRIC_DESCRIPTORS,
  type MetricEntityScope,
} from '../metrics/metric-descriptors.ts'
import { METRIC_EVENT_KINDS, METRICS_SCHEMA_VERSION } from '../metrics/contract.ts'

/** Every descriptor-backed numeric field for `scope`, keyed by `fieldName` — the same grouping `field-map.ts` uses to pack physical storage. */
function numericPropertiesForScope(
  scope: MetricEntityScope
): Record<string, { type: readonly ['number', 'null'] }> {
  const properties: Record<string, { type: readonly ['number', 'null'] }> = {}
  for (const descriptor of Object.values(HOST_METRICS_METRIC_DESCRIPTORS)) {
    if (descriptor.entityScope === scope) {
      properties[descriptor.fieldName] = { type: ['number', 'null'] as const }
    }
  }
  return properties
}

function hostGroupSchema(scope: MetricEntityScope) {
  return {
    type: 'object',
    properties: numericPropertiesForScope(scope),
    additionalProperties: false,
  }
}

/** A nullable-number property map for an explicit `fieldName` subset of one scope. */
function numericPropertiesForFields(fields: readonly string[]) {
  return Object.fromEntries(
    fields.map((field) => [field, { type: ['number', 'null'] as const }])
  )
}

/** One half of the nested `diagnostics` object — `cpu` or `memory`. */
function diagnosticsHalfSchema(fields: readonly string[]) {
  return {
    type: 'object',
    properties: numericPropertiesForFields(fields),
    additionalProperties: false,
  }
}

/** A per-entity array item schema: `idFields` (string identity/discriminator columns) plus every descriptor-backed numeric field for `scope`. */
function entityArraySchema(scope: MetricEntityScope, idFields: readonly string[]) {
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
  DaemonMetricsSample: {
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
          'topologyGeneration',
          'bootGeneration',
        ],
        properties: {
          version: { type: 'integer', const: METRICS_SCHEMA_VERSION },
          sampledAt: { type: 'string', format: 'date-time' },
          intervalSeconds: { type: 'number' },
          sequence: { type: 'integer' },
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
          'Conservative physical sensor readings — dynamic count per host. Covers CPU package temp/power, raw storage-probe temps, board temps, the synthetic hottest-core/thermal-throttled CPU signals, and the entity-joined signals: per-GPU temperature, GPU memory temperature and GPU power, plus one temperature per service drive. Every physical reading rides this array: GPU temp/power and drive temp are `hardwareSignals`, never `gpus`/`blockDevices` fields. Never fan RPM — fan tachometers have no sampled-telemetry family at all (fan fault/alarm still arrives via `events`).',
        items: entityArraySchema('hardwareSignal', ['signalId', 'kind']),
      },
      ingressSources: {
        type: 'array',
        description:
          'One entry per distinct ingress-adapter source instance, keyed by `sourceId` — two sources sharing the same `sourceKind` (e.g. two Caddy instances) are still distinct entities. Latency is reported as a raw per-interval duration sum plus six cumulative-`le` bucket counters (`bucket10ms`..`bucket5s`, each counting every request at or under its bound); averages and percentiles are derived from those at read time and never sent pre-computed, because neither aggregates across time windows. The shared-hosting router reports separately as `router`, not as an entry here.',
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
        items: { $ref: '#/components/schemas/DaemonMetricEvent' },
      },
      diagnostics: {
        type: 'object',
        description:
          'Merged always-on depth family: host-wide CPU frequency/scheduling counters and the memory-subsystem meminfo/vmstat breakdown. Optional only because a non-Linux or degraded collector may not produce it.',
        required: ['cpu', 'memory'],
        properties: {
          cpu: diagnosticsHalfSchema(DIAGNOSTICS_CPU_FIELD_NAMES),
          memory: diagnosticsHalfSchema(DIAGNOSTICS_MEMORY_FIELD_NAMES),
        },
        additionalProperties: false,
      },
      router: {
        type: 'object',
        description:
          "The host's one shared HTTP ingress router (Traefik) — host-wide and singleton, so it carries no entity id, unlike `ingressSources`. Optional: absent entirely when no router is reporting this tick, never an all-`null` placeholder.",
        properties: numericPropertiesForScope('router'),
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  DaemonMetricEvent: {
    type: 'object',
    required: ['eventId', 'at', 'kind', 'severity'],
    properties: {
      eventId: { type: 'string' },
      at: { type: 'string', format: 'date-time' },
      kind: { type: 'string', enum: [...METRIC_EVENT_KINDS] },
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
        'Authenticated daemon posts a v6 entity-scoped metrics sample. ' +
        'serverId is taken from the JWT `sub` — never from the body. ' +
        'Writes are fire-and-forget to Analytics Engine / DuckDB; ' +
        'never wakes the Durable Object.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/DaemonMetricsSample' },
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
