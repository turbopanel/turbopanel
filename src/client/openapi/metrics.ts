import {
  HARDWARE_PROFILE_NIC_KEYS,
  HARDWARE_PROFILE_NIC_SLOT_LIST_KEY,
  HARDWARE_PROFILE_SENSOR_SLOT_KEYS,
  HARDWARE_PROFILE_TOPOLOGY_ID_KEYS,
} from '../../lib/db/server-metadata.ts'
import { MAX_NIC_SLOTS } from '../servers/topology-types.ts'
import { clientErrorJson } from './shared.ts'

const sensorSlotOrNullSchema = {
  oneOf: [
    { $ref: '#/components/schemas/ServerSensorSlotAssignment' },
    {
      type: 'null',
    },
  ],
  description:
    'Assignment pins the sensor identity; `null` marks it explicitly unassigned; omit to leave untouched.',
}

const nicOrNullSchema = {
  type: ['string', 'null'],
  description: 'Network interface name; `null` unassigns; omit to leave untouched.',
}

const topologyIdOrNullSchema = {
  type: ['string', 'null'],
  description:
    'Opaque, daemon-derived stable topology device/filesystem id (never a raw interface name or path); `null` unassigns; omit to leave untouched. Validated against the server’s last recorded topology generation before it is saved.',
}

const nicSlotLimitSchema = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_NIC_SLOTS,
  description:
    'How many network interfaces this server may monitor (its effective capability plan’s NIC-slot count — 2 by default on the hosted platform, up to 8 self-hosted). The hardware-profile PUT rejects a longer nicSlotDeviceIds list.',
}

const sensorSlotProperties = Object.fromEntries(
  HARDWARE_PROFILE_SENSOR_SLOT_KEYS.map((key) => [key, sensorSlotOrNullSchema])
)

const nicProperties = Object.fromEntries(
  HARDWARE_PROFILE_NIC_KEYS.map((key) => [key, nicOrNullSchema])
)

const topologyIdProperties = Object.fromEntries(
  HARDWARE_PROFILE_TOPOLOGY_ID_KEYS.map((key) => [key, topologyIdOrNullSchema])
)

const nicSlotListSchema = {
  type: 'array',
  items: { type: 'string' },
  maxItems: MAX_NIC_SLOTS,
  description:
    'Monitored network interfaces in slot order (slot 1 first): opaque, daemon-derived topology device ids of physical uplinks (never interface names). Absent/empty means auto — only the default-route uplink is monitored.',
}

const nicSlotListOrNullSchema = {
  ...nicSlotListSchema,
  type: ['array', 'null'],
  description: `${nicSlotListSchema.description} Full replacement; \`null\` (or \`[]\`) returns the server to auto selection; omit to leave untouched. Every id must be an \`uplink\` in the server’s last recorded topology generation, and the list must fit the server’s effective NIC-slot limit (\`nicSlotLimit\` on /series and /summary).`,
}

/**
 * Fields {@link ServerHardwareProfile} carries once persisted — same slot/NIC/
 * topology-id shape as the update request, plus generation bookkeeping and
 * the daemon-detected `cpuModel` (never accepted through the PUT body).
 */
const hardwareProfileProperties = {
  ...sensorSlotProperties,
  ...nicProperties,
  ...topologyIdProperties,
  [HARDWARE_PROFILE_NIC_SLOT_LIST_KEY]: nicSlotListSchema,
  hostingPath: { type: 'string' },
  drivetempEnabled: { type: 'boolean' },
  generation: {
    type: 'integer',
    description: 'Monotonically increasing; bumps only when a sensor/NIC identity changes.',
  },
  generationAppliedAt: { type: 'string', format: 'date-time' },
  cpuModel: {
    type: 'string',
    description:
      'Detected CPU model reported by the daemon’s host-facts projection — read-only, never accepted via PUT.',
  },
  cpuTdpWattsOverride: { type: ['number', 'null'] },
  cpuTjMaxCelsiusOverride: { type: ['number', 'null'] },
}

const backendEnumSchema = {
  type: 'string',
  enum: ['disabled', 'analytics-engine', 'duckdb'],
}

export const metricsSchemas = {
  ServerSensorSlotAssignment: {
    type: 'object',
    required: ['chip', 'label'],
    properties: {
      chip: { type: 'string' },
      label: { type: 'string' },
    },
  },
  HostMetricValues: {
    type: 'object',
    description:
      'Per-metric values keyed by requested canonical name (`host.cpu.busyPercent`) or bare entity field name (for a `network:eth0.receiveBytesPerSecond`-style entity selector, the entity-scoped result keys by the bare field name, e.g. `receiveBytesPerSecond`) — see the `metrics` query parameter grammar on `/series`. Only requested/collected keys are guaranteed present.',
    additionalProperties: { type: ['number', 'null'] },
  },
  HostSeriesChartPointDerived: {
    type: 'object',
    description:
      'Server-computed presentation values so the UI never reimplements v5’s used-from-available/used-percent math. A value is `null` whenever an input it needs is missing — in particular, `memoryUsedPercent`/`swapUsedPercent`/`rootFilesystemUsedPercent` are `null` until the server’s topology has reported the matching total (memory/swap totals, or the root filesystem’s `totalBytes`).',
    required: [
      'cpuUsagePercent',
      'memoryUsedBytes',
      'memoryUsedPercent',
      'swapUsedPercent',
      'rootFilesystemUsedBytes',
      'rootFilesystemUsedPercent',
    ],
    properties: {
      cpuUsagePercent: {
        type: ['number', 'null'],
        description:
          'Direct passthrough of `host.cpu.busyPercent` — unlike v3’s `cpuIdlePercent`, v5 already reports the "used" semantic, no `100 − idle` inversion.',
      },
      memoryUsedBytes: { type: ['number', 'null'] },
      memoryUsedPercent: { type: ['number', 'null'] },
      swapUsedPercent: { type: ['number', 'null'] },
      rootFilesystemUsedBytes: { type: ['number', 'null'] },
      rootFilesystemUsedPercent: { type: ['number', 'null'] },
    },
  },
  HostSeriesCpuHotspotPoint: {
    type: 'object',
    description: 'One `cpu.detail` embedded hotspot slot’s last-observed values within a bucket.',
    required: ['coreId', 'values'],
    properties: {
      coreId: {
        type: ['string', 'null'],
        description:
          'The core this slot was reporting for at the last-observed sample in the bucket — can legitimately change bucket-to-bucket (the daemon re-selects the busiest cores every interval). `null` means the slot had no hotspot at that observation.',
      },
      values: { $ref: '#/components/schemas/HostMetricValues' },
    },
  },
  HostSeriesChartPoint: {
    type: 'object',
    required: ['at', 'values', 'derived', 'sampleCount'],
    properties: {
      at: { type: 'string', format: 'date-time' },
      values: { $ref: '#/components/schemas/HostMetricValues' },
      derived: { $ref: '#/components/schemas/HostSeriesChartPointDerived' },
      sampleCount: { type: 'integer' },
      expectedSampleCount: { type: 'integer' },
      topologyGeneration: {
        type: ['integer', 'null'],
        description:
          'Topology generation shared by every contributing sample in this bucket — `null` means unknown or the bucket spans a topology reassignment (mixed generations). Omitted when the backend doesn’t track generations.',
      },
      cpuHotspots: {
        type: 'array',
        items: { $ref: '#/components/schemas/HostSeriesCpuHotspotPoint' },
        description:
          '`cpu.detail`’s up-to-4 embedded busiest-core hotspot slots for this bucket — present only when the request’s `metrics` selector included a `cpuDetail.*` id and a `cpu.detail` row exists in this bucket.',
      },
    },
  },
  EffectiveCpuThermalLimits: {
    type: 'object',
    required: ['tdpWatts', 'tjMaxCelsius', 'source'],
    properties: {
      tdpWatts: { type: ['number', 'null'] },
      tjMaxCelsius: { type: ['number', 'null'] },
      source: {
        type: 'string',
        enum: ['override', 'catalog-exact', 'catalog-family', 'none'],
        description:
          'Where the limits came from: an operator override, an exact/family CPU-catalog match, or none resolved.',
      },
    },
  },
  HostSeriesResult: {
    type: 'object',
    description:
      'Host-singleton series (`host.*` metrics) — present only when the request’s `metrics` selector included at least one `host.*` id.',
    required: ['metrics', 'sampleCount', 'gapCount', 'points', 'topologyGenerationBreaks'],
    properties: {
      metrics: { type: 'array', items: { type: 'string' } },
      sampleCount: { type: 'integer' },
      gapCount: { type: 'integer' },
      points: {
        type: 'array',
        items: { $ref: '#/components/schemas/HostSeriesChartPoint' },
      },
      topologyGenerationBreaks: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'Point indices where `topologyGeneration` differs from the previous known generation — a chart-continuity boundary marker (v5 analogue of v3’s `generationBreaks`).',
      },
      topologyGenerations: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'Distinct topology generations observed anywhere in the queried range. Omitted when the backend doesn’t track generations.',
      },
    },
  },
  EntitySeriesPoint: {
    type: 'object',
    required: ['at', 'values', 'sampleCount'],
    properties: {
      at: { type: 'string', format: 'date-time' },
      values: { $ref: '#/components/schemas/HostMetricValues' },
      sampleCount: { type: 'integer' },
      expectedSampleCount: { type: 'integer' },
    },
  },
  EntitySeriesEntity: {
    type: 'object',
    required: ['entityId', 'points', 'sampleCount', 'gapCount'],
    properties: {
      entityId: {
        type: 'string',
        description:
          'The contract entity id for this family — `deviceId`/`filesystemId`/`gpuId`/`signalId`, `coreId` for `cpu.core.live`, or `sourceId` for `managed.ingress`/`managed.database_proxy` (distinct source instances stay distinct entities even when they share a `sourceKind`).',
      },
      points: {
        type: 'array',
        items: { $ref: '#/components/schemas/EntitySeriesPoint' },
      },
      sampleCount: { type: 'integer' },
      gapCount: { type: 'integer' },
    },
  },
  EntitySeriesResult: {
    type: 'object',
    description: 'One requested per-entity family’s series — one entry per family in `metrics`.',
    required: ['family', 'metrics', 'available', 'entities'],
    properties: {
      family: {
        type: 'string',
        enum: [
          'gpu',
          'network',
          'filesystem',
          'block',
          'hardware.physical',
          'managed.ingress',
          'managed.database_proxy',
          'cpu.core.live',
        ],
      },
      metrics: { type: 'array', items: { type: 'string' } },
      available: { type: 'boolean' },
      resolutionSeconds: { type: ['integer', 'null'] },
      entities: {
        type: 'array',
        items: { $ref: '#/components/schemas/EntitySeriesEntity' },
      },
    },
  },
  TopologyInventory: {
    type: 'object',
    description:
      'Entity label/role metadata from the server’s latest recorded topology, attached so an entity series never has to show a bare device id with no name/role context. `managed.ingress`/`managed.database_proxy` have no topology concept — presence-only, discovered from the queried range itself, never listed here.',
    required: ['networks', 'filesystems', 'blockDevices', 'gpus', 'hardwareSignals'],
    properties: {
      networks: {
        type: 'array',
        items: { type: 'object' },
        description:
          '`{deviceId, name, kind, role, slot?, speedMbps?, mtu?, defaultRoute?}[]` — `kind` is the daemon’s classification (`uplink`/`member`/`virtual`/`fabric`/`container-bridge`/`loopback`; only `uplink`s can be monitored), `role` is `nic` (a monitored slot — its 1-based `slot` rides alongside; slots 1/2 embed in host metrics, 3+ page as standalone `network` rows), `fabric` (embedded, never queryable as an entity), or `other` (enumerated but not sampled). `defaultRoute` marks the gateway uplink auto selection picks.',
      },
      filesystems: {
        type: 'array',
        items: { type: 'object' },
        description: '`{filesystemId, mountpoint, roles, totalBytes, isRoot}[]`.',
      },
      blockDevices: {
        type: 'array',
        items: { type: 'object' },
        description: '`{deviceId, kernelName, model?, deviceType, isServiceDevice}[]`.',
      },
      gpus: {
        type: 'array',
        items: { type: 'object' },
        description: '`{gpuId, kind, vendor, chip}[]`.',
      },
      hardwareSignals: {
        type: 'array',
        items: { type: 'object' },
        description: '`{signalId, kind, unit, label, thresholds?}[]`.',
      },
    },
  },
  HostSeriesChartResponse: {
    type: 'object',
    required: [
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
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string', format: 'uuid' },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      backend: backendEnumSchema,
      available: { type: 'boolean' },
      resolutionSeconds: { type: ['integer', 'null'] },
      host: {
        oneOf: [
          { $ref: '#/components/schemas/HostSeriesResult' },
          {
            type: 'null',
          },
        ],
        description: '`null` when the request’s `metrics` selector had no `host.*` id.',
      },
      entities: {
        type: 'array',
        items: { $ref: '#/components/schemas/EntitySeriesResult' },
      },
      inventory: {
        oneOf: [
          { $ref: '#/components/schemas/TopologyInventory' },
          {
            type: 'null',
          },
        ],
        description: '`null` when the server has not reported a usable topology generation yet.',
      },
      topologyGeneration: {
        type: ['integer', 'null'],
        description: 'The server’s latest recorded topology generation, or `null` if none yet.',
      },
      cpuLimits: { $ref: '#/components/schemas/EffectiveCpuThermalLimits' },
      temperatureUnit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      nicSlotLimit: nicSlotLimitSchema,
    },
  },
  HostSummaryChartResponse: {
    type: 'object',
    required: [
      'ok',
      'serverId',
      'from',
      'to',
      'backend',
      'available',
      'sampleCount',
      'latestAt',
      'cpuLimits',
      'temperatureUnit',
      'nicSlotLimit',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string', format: 'uuid' },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      backend: backendEnumSchema,
      available: { type: 'boolean' },
      sampleCount: { type: 'integer' },
      latestAt: { type: ['string', 'null'], format: 'date-time' },
      cpuLimits: { $ref: '#/components/schemas/EffectiveCpuThermalLimits' },
      temperatureUnit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      nicSlotLimit: nicSlotLimitSchema,
    },
  },
  FleetServerUsageRecord: {
    type: 'object',
    required: ['serverId', 'latestAt', 'values', 'sampleCount', 'derived'],
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      latestAt: { type: ['string', 'null'], format: 'date-time' },
      values: { $ref: '#/components/schemas/HostMetricValues' },
      sampleCount: { type: 'integer' },
      topologyGeneration: {
        type: ['integer', 'null'],
        description:
          'Topology generation shared by every contributing sample in the queried window, or `null` when unknown/mixed. Omitted when the backend doesn’t track generations.',
      },
      derived: { $ref: '#/components/schemas/HostSeriesChartPointDerived' },
    },
  },
  FleetHostSnapshotResponse: {
    type: 'object',
    required: ['ok', 'from', 'to', 'backend', 'available', 'metrics', 'servers'],
    properties: {
      ok: { type: 'boolean', const: true },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      backend: backendEnumSchema,
      available: { type: 'boolean' },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The fixed v5 fleet host metric set (CPU stack + memory/swap) — never per-request. v3’s load-average fields (`load1`/`load5`/`load15`) have no v5 analogue and are not present.',
      },
      servers: {
        type: 'array',
        items: { $ref: '#/components/schemas/FleetServerUsageRecord' },
      },
    },
  },
  StatusHistoryEvent: {
    type: 'object',
    required: ['at', 'connected', 'reason'],
    properties: {
      at: { type: 'string', format: 'date-time' },
      connected: { type: 'boolean' },
      reason: {
        type: 'string',
        enum: ['connect', 'disconnect', 'sweep_stale', 'self_heal'],
      },
    },
  },
  ConnectionHistoryChartResponse: {
    type: 'object',
    required: [
      'ok',
      'serverId',
      'from',
      'to',
      'backend',
      'available',
      'initialConnected',
      'uptimeSeconds',
      'downtimeSeconds',
      'unknownSeconds',
      'uptimePercent',
      'truncated',
      'events',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string', format: 'uuid' },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      backend: backendEnumSchema,
      available: { type: 'boolean' },
      initialConnected: {
        type: ['boolean', 'null'],
        description: '`null` means the connection state before `from` is unknown.',
      },
      uptimeSeconds: { type: 'number' },
      downtimeSeconds: { type: 'number' },
      unknownSeconds: { type: 'number' },
      uptimePercent: { type: ['number', 'null'] },
      truncated: { type: 'boolean' },
      events: {
        type: 'array',
        items: { $ref: '#/components/schemas/StatusHistoryEvent' },
      },
    },
  },
  MetricsBackendUnavailableResponse: {
    type: 'object',
    required: ['ok', 'error', 'backend'],
    properties: {
      ok: { type: 'boolean', const: false },
      error: { type: 'string', const: 'metrics_backend_unavailable' },
      backend: backendEnumSchema,
    },
  },
  ServerHardwareProfileUpdateRequest: {
    type: 'object',
    description:
      'PUT body for the operator-assigned hardware profile. Per field: an assignment pins it, `null` clears/unassigns it, an absent field leaves it untouched. Unknown fields (including `cpuModel`, which is detected, not operator-set) are rejected.',
    properties: {
      ...sensorSlotProperties,
      ...nicProperties,
      ...topologyIdProperties,
      [HARDWARE_PROFILE_NIC_SLOT_LIST_KEY]: nicSlotListOrNullSchema,
      hostingPath: {
        type: ['string', 'null'],
        description: 'Absolute path without whitespace; `null` clears it.',
      },
      drivetempEnabled: { type: ['boolean', 'null'] },
      cpuTdpWattsOverride: {
        type: ['number', 'null'],
        description: 'Greater than 0 and at most 1000; `null` clears the override.',
      },
      cpuTjMaxCelsiusOverride: {
        type: ['number', 'null'],
        description: 'Between 40 and 130; `null` clears the override.',
      },
    },
    additionalProperties: false,
  },
  ServerHardwareProfile: {
    type: 'object',
    properties: hardwareProfileProperties,
  },
  ServerHardwareProfileUpdateResponse: {
    type: 'object',
    required: ['ok', 'profile', 'pushed'],
    properties: {
      ok: { type: 'boolean', const: true },
      profile: { $ref: '#/components/schemas/ServerHardwareProfile' },
      pushed: {
        type: 'boolean',
        description:
          'Whether the profile was pushed to a connected daemon (best-effort — false when the daemon is offline or the registry is unavailable).',
      },
    },
  },
}

const serverIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
}

const fromToParams = [
  {
    name: 'from',
    in: 'query',
    required: true,
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to',
    in: 'query',
    required: true,
    schema: { type: 'string', format: 'date-time' },
  },
]

const metricsQueryErrorResponses = {
  '400': {
    description: 'Invalid from/to range, metrics list, or maxPoints',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '401': {
    description: 'Unauthorized',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '403': {
    description: 'Forbidden',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '503': {
    description: 'Database or metrics backend unavailable',
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/MetricsBackendUnavailableResponse',
        },
      },
    },
  },
}

export const metricsPaths: Record<string, unknown> = {
  '/api/client/v1/servers/{id}/metrics/series': {
    get: {
      tags: ['Servers'],
      summary: 'Get charted host and entity metrics series for a visible server',
      description:
        'Bucketed series with derived presentation values and CPU thermal/power headroom, resolved from the server’s hardware profile, plus per-entity-family series and the topology inventory used to label them.',
      security: [{ cookieAuth: [] }],
      parameters: [
        serverIdParam,
        ...fromToParams,
        {
          name: 'metrics',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description:
            'Comma-separated entity-metric-id list — a host-singleton canonical name (`host.cpu.busyPercent`) or an entity-scoped id (`<family alias>:<entityId>.<field>`, e.g. `network:eth0.receiveBytesPerSecond`, `hardware:psu1.value`, `ingress:caddy-1.requests`). Omit for every `host.*` canonical metric. A `network` entity id that is a TurboFabric mesh device per the current topology is rejected with 400 — see `inventory`. A NIC in a normal slot is queryable like any other `network` entity, but only `receiveBytesPerSecond`/`transmitBytesPerSecond` resolve on the Cloudflare backend; every other `network` field is `null` for it there (DuckDB always resolves the full field set).',
        },
        {
          name: 'resolution',
          in: 'query',
          required: false,
          schema: { type: 'integer' },
          description: 'Bucket width in seconds; omit to auto-select from the range and maxPoints.',
        },
        {
          name: 'maxPoints',
          in: 'query',
          required: false,
          schema: { type: 'integer' },
        },
      ],
      responses: {
        '200': {
          description: 'Host and entity metrics series',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HostSeriesChartResponse' },
            },
          },
        },
        ...metricsQueryErrorResponses,
      },
    },
  },
  '/api/client/v1/servers/{id}/metrics/summary': {
    get: {
      tags: ['Servers'],
      summary: 'Get host-metrics summary (sample count, latest sample) for a visible server',
      security: [{ cookieAuth: [] }],
      parameters: [serverIdParam, ...fromToParams],
      responses: {
        '200': {
          description: 'Host metrics summary',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HostSummaryChartResponse' },
            },
          },
        },
        ...metricsQueryErrorResponses,
      },
    },
  },
  '/api/client/v1/servers/metrics/latest': {
    get: {
      tags: ['Servers'],
      summary: 'Get one fleet-wide host usage snapshot for the org servers overview',
      description:
        'CPU stack + memory/swap for every server visible to the caller, in one query — never N per-server calls. Authorization is server-side via listVisible; no serverIds are ever accepted from the client. Carries no per-server cpuLimits (unlike /series and /summary) — see FLEET_HOST_METRICS_V5’s doc comment.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'organizationId',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Fleet host usage snapshot',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/FleetHostSnapshotResponse',
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '503': {
          description: 'Database or metrics backend unavailable',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/MetricsBackendUnavailableResponse',
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/metrics/connection': {
    get: {
      tags: ['Servers'],
      summary: 'Get connection uptime/downtime history for a visible server',
      security: [{ cookieAuth: [] }],
      parameters: [serverIdParam, ...fromToParams],
      responses: {
        '200': {
          description: 'Connection history and uptime totals',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ConnectionHistoryChartResponse',
              },
            },
          },
        },
        ...metricsQueryErrorResponses,
      },
    },
  },
  '/api/client/v1/servers/{id}/metrics/hardware-profile': {
    put: {
      tags: ['Servers'],
      summary: 'Set the operator-assigned hardware profile for a server',
      description:
        'Persists sensor-slot/NIC assignments, the monitored-NIC list (nicSlotDeviceIds), stable topology-id pins, hosting path, drivetemp opt-in, and CPU TDP/Tjmax overrides. Assigning a topology-id pin (hostingFilesystemId) or a monitored-NIC list is validated against the server’s last recorded topology generation — every listed device must be a physical uplink, and the list must fit the server’s effective NIC-slot limit — and does not require the daemon to be connected; sensor/NIC slot assignments and all other fields are persisted without validation.',
      security: [{ cookieAuth: [] }],
      parameters: [serverIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ServerHardwareProfileUpdateRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Hardware profile saved',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ServerHardwareProfileUpdateResponse',
              },
            },
          },
        },
        '400': {
          description: 'Invalid body, unknown field, or a stale topology-id override',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '401': {
          description: 'Unauthorized',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '403': {
          description: 'Forbidden — requires organization:manage',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '404': {
          description: 'Server not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '503': {
          description: 'Database unavailable',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
}
