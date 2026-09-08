export const serverSchemas = {
  ServerOsMetadata: {
    type: 'object',
    description:
      'Host OS reported by the daemon from /etc/os-release (plus Deno build arch/family).',
    properties: {
      family: {
        type: 'string',
        enum: ['linux', 'windows', 'freebsd', 'darwin'],
      },
      id: {
        type: 'string',
        description: 'Distro id from os-release ID= (e.g. debian, raspbian).',
      },
      variant: {
        type: 'string',
        enum: ['raspberry-pi-os'],
        description:
          'Set when the host is Raspberry Pi OS (including 64-bit images that still report ID=debian).',
      },
      version: {
        type: 'string',
        description:
          'Point release when available (e.g. 13.5 from DEBIAN_VERSION_FULL), else VERSION_ID.',
      },
      codename: {
        type: 'string',
        description: 'VERSION_CODENAME (e.g. trixie).',
      },
      prettyName: {
        type: 'string',
        description: 'Raw PRETTY_NAME from os-release.',
      },
      architecture: {
        type: 'string',
        description: 'CPU arch (e.g. aarch64, x86_64).',
      },
    },
  },
  ServerCpuSocket: {
    type: 'object',
    description:
      'One physical CPU socket. resources.cpus is ordered 0, 1, … by physical id.',
    properties: {
      vendorId: {
        type: 'string',
        description:
          'cpuinfo vendor_id (e.g. GenuineIntel) or ARM CPU implementer (e.g. 0x41).',
      },
      name: {
        type: 'string',
        description: 'cpuinfo model name (or ARM Hardware / Processor).',
      },
      architecture: { type: 'string' },
      cores: {
        type: 'object',
        required: ['total'],
        properties: {
          total: {
            type: 'integer',
            minimum: 1,
            description: 'Physical cores on this socket.',
          },
          p: {
            type: 'integer',
            minimum: 1,
            description: 'Performance / P-cores (Intel) or big cores.',
          },
          e: {
            type: 'integer',
            minimum: 1,
            description: 'Efficiency / E-cores (Intel) or little cores.',
          },
        },
      },
      threads: {
        type: 'object',
        required: ['total'],
        properties: {
          total: {
            type: 'integer',
            minimum: 1,
            description: 'Logical CPUs / threads on this socket (load bars).',
          },
          p: { type: 'integer', minimum: 1 },
          e: { type: 'integer', minimum: 1 },
        },
      },
      cache: {
        type: 'object',
        description:
          'Cache sizes in bytes (per-core L1/L2; shared L3 when present).',
        properties: {
          l1: { type: 'integer', minimum: 1 },
          l1d: { type: 'integer', minimum: 1 },
          l1i: { type: 'integer', minimum: 1 },
          l2: { type: 'integer', minimum: 1 },
          l3: { type: 'integer', minimum: 1 },
          l4: { type: 'integer', minimum: 1 },
        },
      },
      speedMhz: {
        type: 'integer',
        minimum: 1,
        description:
          'Advertised base clock (base_frequency or model-name @ GHz).',
      },
      turboMhz: {
        type: 'integer',
        minimum: 1,
        description: 'Max turbo (cpuinfo_max_freq).',
      },
    },
  },
  ServerGpu: {
    type: 'object',
    description: 'One GPU from DRM cardN (ordered 0, 1, …).',
    properties: {
      vendorId: {
        type: 'string',
        description: 'PCI vendor id from sysfs (e.g. 0x10de).',
      },
      name: { type: 'string' },
      memoryBytes: { type: 'integer', minimum: 1 },
      driver: { type: 'string' },
      pciId: {
        type: 'string',
        description: 'vendor:device without 0x (e.g. 10de:2d04).',
      },
      pciSlot: {
        type: 'string',
        description: 'sysfs PCI_SLOT_NAME (e.g. 0000:01:00.0).',
      },
    },
  },
  ServerHostResources: {
    type: 'object',
    description:
      'Static host capacity from daemon hello (/proc/cpuinfo, /proc/stat, /proc/meminfo, DRM).',
    properties: {
      cpus: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerCpuSocket' },
        description:
          'Physical CPU sockets in physical-id order.',
      },
      gpus: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerGpu' },
      },
      memory: {
        type: 'object',
        properties: {
          totalBytes: {
            type: 'integer',
            minimum: 1,
            description: 'MemTotal from /proc/meminfo in bytes.',
          },
        },
      },
      swap: {
        type: 'object',
        properties: {
          totalBytes: {
            type: 'integer',
            minimum: 0,
            description:
              'SwapTotal from /proc/meminfo in bytes (0 when swap is disabled).',
          },
        },
      },
      ips: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerReportedIp' },
        description:
          'Host interface addresses nested on resources (hello / change-detected heartbeat).',
      },
    },
  },
  ServerTimeSync: {
    type: 'object',
    description:
      'Host timezone + NTP state composed from server.timezone / is_time_sync_enabled / ntp_servers / ntp_last_synced_at.',
    properties: {
      timezone: { type: 'string' },
      ntpEnabled: { type: 'boolean' },
      ntpSynced: { type: 'boolean' },
      ntpServers: { type: 'array', items: { type: 'string' } },
      fallbackNtpServers: { type: 'array', items: { type: 'string' } },
      lastSyncedAt: { type: 'string', format: 'date-time' },
    },
  },
  ServerDockerMetadata: {
    type: 'object',
    description:
      'Docker CLI / Compose plugin versions from daemon hello / change-detected heartbeat. Omitted from server.metadata when Docker is not installed; the API returns null in that case.',
    properties: {
      version: {
        type: 'string',
        description: 'Docker CLI version (docker --version), e.g. 28.3.3.',
      },
      composeVersion: {
        type: 'string',
        description:
          'Docker Compose plugin version (docker compose version), e.g. 2.39.1.',
      },
    },
  },
  ServerReportedIp: {
    type: 'object',
    description: 'One daemon-reported host interface address.',
    required: ['address', 'version', 'scope'],
    properties: {
      address: { type: 'string' },
      version: { type: 'integer', enum: [4, 6] },
      scope: { type: 'string', enum: ['private', 'public'] },
      cidr: {
        type: 'string',
        description:
          'Aligned interface network CIDR when known. Required to create a datacenter from a private address.',
      },
      interface: {
        type: 'string',
        description: 'Host interface name (e.g. eth0, enp1s0).',
      },
    },
  },
  ServerTierPlacement: {
    type: 'object',
    required: ['licenseTier', 'requiredTier', 'recommendedTier', 'unwatched'],
    properties: {
      licenseTier: {
        type: ['string', 'null'],
        description:
          'Bound license `tier.label`, or null when unassigned / self-hosted.',
      },
      requiredTier: {
        type: 'string',
        description: 'Hard floor from CPU cores + RAM (rank label, e.g. S2).',
      },
      recommendedTier: {
        type: 'string',
        description:
          'Harder of required and discovered NIC / drive / GPU counts.',
      },
      unwatched: {
        type: 'object',
        required: ['nics', 'drives', 'gpus'],
        description:
          'Devices (detail: ids) or counts (list) beyond the effective plan slot counts.',
        properties: {
          nics: {
            oneOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'integer', minimum: 0 },
            ],
          },
          drives: {
            oneOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'integer', minimum: 0 },
            ],
          },
          gpus: {
            oneOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'integer', minimum: 0 },
            ],
          },
        },
      },
    },
  },
  ServerRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: ['string', 'null'] },
      organizationId: { type: ['string', 'null'] },
      licenseId: { type: ['string', 'null'] },
      tierPlacement: {
        oneOf: [
          { $ref: '#/components/schemas/ServerTierPlacement' },
          { type: 'null' },
        ],
        description:
          'License vs required/recommended hardware placement. List responses use unwatched counts; detail uses device ids.',
      },
      options: { type: ['object', 'null'], additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
      connected: {
        type: 'boolean',
        description:
          'Live presence from the promoted `server.is_connected` column (not `daemon.status`).',
      },
      hostname: {
        type: ['string', 'null'],
        description:
          'Daemon-reported hostname from the promoted `server.hostname` column (not `metadata.hostname`).',
      },
      machineClass: {
        type: ['string', 'null'],
        enum: ['physical', 'virtual', null],
        description:
          'Declared `server.machine_class` for metrics capability-plan resolution. Null until pinned via PATCH or inferred `physical` at ingest (sensors discovered, or the daemon\'s own verdict on its topology snapshot); never inferred `virtual`.',
      },
      layoutPaths: {
        type: ['object', 'null'],
        description:
          'Host layout paths the daemon reports on its latest topology snapshot: where managed-engine backups land (`TURBOPANEL_BACKUP_DIR`, `/backup` by default) and its log directory. Read-only — set by the daemon\'s environment on the host, not by this API. Null until a v6 daemon has reported topology.',
        properties: {
          backup: { type: 'string' },
          logs: { type: 'string' },
        },
        required: ['backup', 'logs'],
      },
      remoteAddress: {
        type: ['string', 'null'],
        description:
          'Raw peer address as seen by the instance (CF-Connecting-IP through a trusted Cloudflare Tunnel, else X-Real-IP from Caddy). Diagnostic — prefer `address`. Null when offline or co-located on a Unix socket.',
      },
      address: {
        type: ['string', 'null'],
        description:
          'Best-known network address for this host. The observed peer address when it is routable and agrees with the daemon, otherwise the daemon-reported interface address — the observed one is the proxy or forwarded port on co-located and development installs. Null when unknown or co-located.',
      },
      addressSource: {
        type: ['string', 'null'],
        enum: ['observed', 'interface', 'local', null],
        description:
          'Which fact `address` came from: `observed` (peer address on the wire, incl. CF-Connecting-IP through a Cloudflare Tunnel), `interface` (daemon-reported host interface), `local` (co-located Unix socket).',
      },
      addressScope: {
        type: ['string', 'null'],
        enum: ['public', 'private', null],
      },
      addressInterface: {
        type: ['string', 'null'],
        description: 'Host interface `address` belongs to, when known.',
      },
      lastInboundAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Last inbound WebSocket activity from a live cell snapshot (admin/diagnostics only). Null on the default Postgres status path — there is no `last_inbound_at` column.',
      },
      connectedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Last status transition (`server.status_changed_at`) while connected. Null when offline. There is no `connected_at` column.',
      },
      statusChangedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Last online/offline transition (`server.status_changed_at`). Set for both connected and offline rows.',
      },
      geo: {
        type: ['object', 'null'],
        additionalProperties: true,
        description:
          'Connecting-IP geolocation from server.metadata.geo when available.',
      },
      os: {
        oneOf: [
          { $ref: '#/components/schemas/ServerOsMetadata' },
          { type: 'null' },
        ],
        description:
          'Host OS from server.os_* columns (daemon hello). Null until the daemon has reported it.',
      },
      osDisplay: {
        type: ['string', 'null'],
        description:
          'Formatted OS label for UI, e.g. "Debian 13.5 (Trixie)". Null when os is unknown.',
      },
      osLogo: {
        type: ['string', 'null'],
        enum: ['debian', 'raspberry-pi-os', null],
        description: 'Logo key for the UI OS column.',
      },
      resources: {
        oneOf: [
          { $ref: '#/components/schemas/ServerHostResources' },
          { type: 'null' },
        ],
        description:
          'Host capacity (cpu / RAM / swap totals) plus ips from server.metadata.resources. Null until the daemon hello reports it.',
      },
      ips: {
        oneOf: [
          {
            type: 'array',
            items: { $ref: '#/components/schemas/ServerReportedIp' },
          },
          { type: 'null' },
        ],
        description:
          'Host addresses from server.metadata.resources.ips (also nested on resources). Null until reported.',
      },
      timeSync: {
        oneOf: [
          { $ref: '#/components/schemas/ServerTimeSync' },
          { type: 'null' },
        ],
        description:
          'Host time-sync composed from server timezone / NTP columns. Null until reported.',
      },
      docker: {
        oneOf: [
          { $ref: '#/components/schemas/ServerDockerMetadata' },
          { type: 'null' },
        ],
        description:
          'Docker CLI / Compose plugin versions from server.metadata.docker. Null when Docker is not installed or has not been reported.',
      },
      timezone: {
        type: ['string', 'null'],
        description:
          'Effective timezone: datacenter enforce, else org enforce, else server.options.timezone, else daemon-reported server.timezone.',
      },
      timezoneSource: {
        type: ['string', 'null'],
        enum: ['server', 'organization', 'datacenter', null],
        description:
          'Which configured layer supplied timezone (null when only the daemon-reported zone is shown).',
      },
      sshPort: {
        type: 'integer',
        minimum: 1,
        maximum: 65535,
        description:
          'Effective SSH listen port: server.options.sshPort, else datacenter, else organization, else 22.',
      },
      sshPortSource: {
        type: ['string', 'null'],
        enum: ['server', 'organization', 'datacenter', null],
        description:
          'Which configured layer supplied sshPort (null when the platform default 22 is used).',
      },
      ntpDefaults: {
        type: ['object', 'null'],
        description:
          'Effective desired NTP settings from the host-defaults cascade. Observed host NTP stays on timeSync.',
        properties: {
          enabled: { type: 'boolean' },
          servers: { type: 'array', items: { type: 'string' } },
          fallbackServers: { type: 'array', items: { type: 'string' } },
        },
      },
      ntpDefaultsSource: {
        type: ['string', 'null'],
        enum: ['server', 'organization', 'datacenter', null],
        description:
          'Which configured layer supplied ntpDefaults (null when none are set).',
      },
      colocatedWithInstance: {
        type: 'boolean',
        description:
          'True when this server is the daemon co-located on the same host as this control plane instance.',
      },
      datacenters: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: ['string', 'null'] },
          },
        },
        description:
          'Datacenter membership pins (`ip` rows with scope=datacenter). A server may belong to many sites.',
      },
    },
  },
  ServerLabel: {
    type: 'object',
    required: ['key', 'value'],
    properties: {
      key: {
        type: 'string',
        description:
          'Docker engine-label charset: starts with alphanumeric, then alphanumerics / `.` / `_` / `-`, 1–255 chars.',
      },
      value: {
        type: 'string',
        description:
          'Label value, at most 255 characters (empty string allowed).',
      },
    },
  },
  ServerLabelsResponse: {
    type: 'object',
    required: ['ok', 'labels'],
    properties: {
      ok: { type: 'boolean', const: true },
      labels: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerLabel' },
      },
    },
  },
  ServerLabelsPutRequest: {
    type: 'object',
    required: ['labels'],
    properties: {
      labels: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Replace-all map of label key to value (max 64 entries). Empty object clears all labels.',
      },
    },
  },
  PatchServerRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      machineClass: {
        type: ['string', 'null'],
        enum: ['physical', 'virtual', null],
        description:
          'Pins `server.machine_class` for metrics capability-plan resolution: `physical` unlocks hardware-sensor slots, `virtual` suppresses them, null clears the pin so ingest infers the class from topology again.',
      },
      options: {
        type: 'object',
        description:
          'Merged into server.options. sshPort (1–65535 or null to inherit) and ntp (object or null to inherit) participate in the host-defaults cascade.',
        properties: {
          sshPort: { type: ['integer', 'null'], minimum: 1, maximum: 65535 },
          ntp: { type: ['object', 'null'] },
          hosting: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } },
          },
        },
      },
    },
  },
  ServerDetailResponse: {
    type: 'object',
    required: ['ok', 'server'],
    properties: {
      ok: { type: 'boolean', const: true },
      server: {
        allOf: [
          { $ref: '#/components/schemas/ServerRow' },
          {
            type: 'object',
            properties: {
              orgDefaultTimezone: { type: ['string', 'null'] },
              enforceServerTimezone: { type: 'boolean' },
              datacenterDefaultTimezone: { type: ['string', 'null'] },
              datacenterEnforceServerTimezone: { type: 'boolean' },
              labels: {
                type: 'array',
                items: { $ref: '#/components/schemas/ServerLabel' },
                description:
                  'Server labels from the primary connection (not the cached detail row). Source for placement.constraints node.labels.*.',
              },
            },
          },
        ],
      },
    },
  },
  CommandEnqueueResponse: {
    type: 'object',
    required: ['ok', 'commandId', 'status'],
    properties: {
      ok: { type: 'boolean', const: true },
      commandId: { type: 'string', format: 'uuid' },
      status: { type: 'string', const: 'queued' },
    },
  },
  TimezoneSetRequest: {
    type: 'object',
    required: ['timezone'],
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone (must be in GET /timezones).',
      },
    },
  },
  NtpSetRequest: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      servers: { type: 'array', items: { type: 'string' }, minItems: 1 },
      fallbackServers: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
      },
    },
  },
  FetchServerCellResponse: {
    type: 'object',
    required: ['ok', 'snapshot'],
    properties: {
      ok: { type: 'boolean', const: true },
      snapshot: { type: 'object', additionalProperties: true },
    },
  },
  ServerStatusResponse: {
    type: 'object',
    required: [
      'serverId',
      'connected',
      'daemonStatus',
      'connectedAt',
      'statusChangedAt',
    ],
    description:
      'Postgres-backed status row for `GET /servers/{id}/status` (`ServerStatusRecord`).',
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      connected: { type: 'boolean' },
      daemonStatus: {
        type: ['string', 'null'],
        enum: ['online', 'offline', 'unknown', null],
        description:
          'Derived from `connected` + `statusChangedAt` — not stored.',
      },
      connectedAt: { type: ['string', 'null'], format: 'date-time' },
      statusChangedAt: { type: ['string', 'null'], format: 'date-time' },
      hostname: { type: ['string', 'null'] },
      remoteAddress: { type: ['string', 'null'] },
      address: {
        type: ['string', 'null'],
        description:
          'Best-known network address for this host. The observed peer address when it is routable and agrees with the daemon, otherwise the daemon-reported interface address — the observed one is the proxy or forwarded port on co-located and development installs. Null when unknown or co-located.',
      },
      addressSource: {
        type: ['string', 'null'],
        enum: ['observed', 'interface', 'local', null],
        description:
          'Which fact `address` came from: `observed` (peer address on the wire, incl. CF-Connecting-IP through a Cloudflare Tunnel), `interface` (daemon-reported host interface), `local` (co-located Unix socket).',
      },
      addressScope: {
        type: ['string', 'null'],
        enum: ['public', 'private', null],
      },
      addressInterface: {
        type: ['string', 'null'],
        description: 'Host interface `address` belongs to, when known.',
      },
      geo: { type: ['object', 'null'], additionalProperties: true },
      colocatedWithInstance: { type: 'boolean' },
    },
  },
  ServersResponse: {
    type: 'object',
    required: ['servers'],
    properties: {
      servers: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerRow' },
      },
    },
  },
  ServerUpdateCurrent: {
    type: 'object',
    properties: {
      commit: { type: 'string' },
      buildId: { type: 'string' },
      builtAt: { type: 'string' },
    },
  },
  ServerUpdateTarget: {
    type: 'object',
    properties: {
      commit: { type: 'string' },
      buildId: { type: 'string' },
      manifestUrl: { type: 'string' },
    },
  },
  ServerUpdateStatusResponse: {
    type: 'object',
    required: ['ok', 'serverId', 'channel', 'updateAvailable', 'status'],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string' },
      channel: { type: 'string' },
      current: {
        oneOf: [
          { $ref: '#/components/schemas/ServerUpdateCurrent' },
          { type: 'null' },
        ],
      },
      target: {
        oneOf: [
          { $ref: '#/components/schemas/ServerUpdateTarget' },
          { type: 'null' },
        ],
      },
      updateAvailable: { type: 'boolean' },
      colocatedWithInstance: {
        type: 'boolean',
        description:
          'True when this server is the daemon co-located on the same host as this control plane instance.',
      },
      updateBlocked: {
        type: 'boolean',
        description:
          'True when the co-located development daemon cannot be updated remotely.',
      },
      updateBlockedReason: {
        type: 'string',
        description:
          'Human-readable reason remote updates are blocked for this server.',
      },
      lastUpdateError: {
        type: 'string',
        description:
          'Error from the most recent terminal update attempt, when present.',
      },
      status: { type: 'string' },
    },
  },
  TriggerServerUpdateResponse: {
    type: 'object',
    required: ['ok', 'queued', 'status'],
    properties: {
      ok: { type: 'boolean', const: true },
      queued: { type: 'boolean', const: true },
      status: { type: 'string' },
    },
  },
  DeleteServerResponse: {
    type: 'object',
    required: ['ok', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string', format: 'uuid' },
    },
  },
  DeleteServerPartialFailure: {
    type: 'object',
    required: ['ok', 'serverId', 'deleted', 'error'],
    properties: {
      ok: { type: 'boolean', const: false },
      serverId: { type: 'string', format: 'uuid' },
      deleted: { type: 'boolean', const: true },
      error: {
        type: 'string',
        description:
          'The Postgres row was deleted but daemon cell purge did not complete.',
      },
    },
  },
  HierarchyDeleteConflict: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'string',
        const: 'Cannot delete while child resources exist',
      },
    },
  },
  ServerDeleteBlockersConflict: {
    type: 'object',
    required: ['error', 'code', 'blockers'],
    properties: {
      error: {
        type: 'string',
        const:
          'Cannot delete this server while dependent resources still exist',
      },
      code: { type: 'string', const: 'server_has_blockers' },
      blockers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'count'],
          properties: {
            kind: { type: 'string', enum: ['network', 'container'] },
            count: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
}

export const serverPaths: Record<string, unknown> = {
  '/api/client/v1/servers': {
    get: {
      tags: ['Servers'],
      summary: 'List servers for the signed-in organization',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Organization servers with live connection state',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServersResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/status': {
    get: {
      tags: ['Servers'],
      summary: 'Get Postgres-backed connection status for a visible server',
      description:
        'Returns `ServerStatusRecord` (connected, daemonStatus, connectedAt, statusChangedAt, …). Prefer this over the admin/debug cell snapshot.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Server status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServerStatusResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/cell': {
    get: {
      tags: ['Servers'],
      summary: 'Fetch daemon cell snapshot for a visible server',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Daemon cell data',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/FetchServerCellResponse' },
            },
          },
        },
        '403': {
          description:
            'Forbidden, or update blocked for the co-located development daemon',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/update': {
    get: {
      tags: ['Servers'],
      summary: 'Read daemon update status for a visible server',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Current daemon build vs trunk manifest target',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ServerUpdateStatusResponse',
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ['Servers'],
      summary: 'Trigger a trunk daemon update on a connected server',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Update queued on the daemon',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/TriggerServerUpdateResponse',
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description:
            'Forbidden, or update blocked for the co-located development daemon',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Daemon not connected',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Daemon cell registry unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '504': {
          description: 'Timeout waiting for daemon acknowledgement',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'error'],
                properties: {
                  ok: { type: 'boolean', const: false },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/update/reset': {
    post: {
      tags: ['Servers'],
      summary: 'Clear stale daemon update status after a manual node update',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Terminal update request history cleared',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/ServerUpdateStatusResponse' },
                  {
                    type: 'object',
                    required: ['cleared'],
                    properties: {
                      cleared: { type: 'integer', minimum: 0 },
                    },
                  },
                ],
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '409': {
          description: 'Update in progress',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'error'],
                properties: {
                  ok: { type: 'boolean', const: false },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
        '503': {
          description: 'Daemon cell registry unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}': {
    get: {
      tags: ['Servers'],
      summary: 'Get a single server detail row',
      description:
        'Returns display fields plus live presence (addresses, timeSync, effective timezone). Uses the server-detail cached read model for the row SELECT; presence enrichment is primary-DB only.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Server detail',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServerDetailResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    patch: {
      tags: ['Servers'],
      summary: 'Update server display name or datacenter pin',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/PatchServerRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok'],
                properties: { ok: { type: 'boolean', const: true } },
              },
            },
          },
        },
        '400': {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    delete: {
      tags: ['Servers'],
      summary: 'Delete a server and purge its daemon cell',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Server deleted and daemon cell purged',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeleteServerResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '409': {
          description: 'Dependent resources block deletion',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ServerDeleteBlockersConflict' },
                  { $ref: '#/components/schemas/HierarchyDeleteConflict' },
                ],
              },
            },
          },
        },
        '503': {
          description: 'Database or daemon cell registry unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '500': {
          description:
            'Server row deleted but daemon cell purge failed; cleanup is incomplete',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/DeleteServerPartialFailure',
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/timezone': {
    post: {
      tags: ['Servers'],
      summary: 'Set server timezone',
      description:
        'Persists server.options.timezone and enqueues server.timezone.set. Manage-gated; poll via GET /servers/{id}/commands/{commandId}.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/TimezoneSetRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Command queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CommandEnqueueResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid timezone',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/ntp': {
    post: {
      tags: ['Servers'],
      summary: 'Configure server NTP',
      description:
        'Enqueues server.ntp.set. Manage-gated; poll via GET /servers/{id}/commands/{commandId}.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/NtpSetRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Command queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CommandEnqueueResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid NTP payload',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/labels': {
    get: {
      tags: ['Servers'],
      summary: 'List server labels',
      description:
        'Returns the replace-all label set for placement.constraints (`node.labels.*`). Read-gated so the same viewers who can see the server detail projection can read its labels.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Label list',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServerLabelsResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    put: {
      tags: ['Servers'],
      summary: 'Replace server labels',
      description:
        'Replace-all write of the server label set (no per-key DELETE). Manage-gated. Body is `{ labels: { key: value } }`; empty object clears all labels.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ServerLabelsPutRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated label list',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServerLabelsResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid label payload',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
}
