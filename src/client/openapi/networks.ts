import { clientErrorJson } from './shared.ts'

export const networkSchemas = {
  NetworkRow: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      organizationId: { type: 'string', format: 'uuid' },
      datacenterId: { type: ['string', 'null'], format: 'uuid' },
      serverId: { type: ['string', 'null'], format: 'uuid' },
      kind: {
        type: 'string',
        enum: ['datacenter', 'docker', 'managed', 'reserved'],
      },
      cidr: { type: ['string', 'null'] },
      name: { type: ['string', 'null'] },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  NetworksResponse: {
    type: 'object',
    required: ['networks'],
    properties: {
      networks: {
        type: 'array',
        items: { $ref: '#/components/schemas/NetworkRow' },
      },
    },
  },
  NetworkResponse: {
    type: 'object',
    required: ['network'],
    properties: {
      network: { $ref: '#/components/schemas/NetworkRow' },
    },
  },
  CidrCollisionError: {
    type: 'object',
    required: ['error', 'cidr', 'conflictingCidr'],
    description:
      'Every CIDR write goes through one collision authority (`src/lib/net/cidr-collisions.ts`). Each pair is a hard **409**: `cidr_overlaps_fabric` (the org TurboFabric `tp0` range), `cidr_overlaps_fabric_pool` (`fabric.options.containerPool`, default `10.192.0.0/12`), `subnet_overlaps` (a site subnet anywhere in the organization — the org-wide default), `cidr_overlaps_gateway_advertised` (a site subnet in another datacenter when both datacenters have a gateway-role relay — the case that breaks WireGuard `AllowedIPs`), `cidr_overlaps_reserved` (an operator-reserved range), `cidr_overlaps_docker_network` (a docker/managed registration carrying a CIDR).',
    properties: {
      error: {
        type: 'string',
        enum: [
          'cidr_overlaps_fabric',
          'cidr_overlaps_fabric_pool',
          'subnet_overlaps',
          'cidr_overlaps_gateway_advertised',
          'cidr_overlaps_reserved',
          'cidr_overlaps_docker_network',
        ],
      },
      cidr: { type: 'string', description: 'The candidate CIDR that was refused.' },
      conflictingCidr: {
        type: 'string',
        description: 'The existing range the candidate overlaps.',
      },
      networkId: {
        type: 'string',
        format: 'uuid',
        description: '`network.id` of the conflicting registry row, when there is one.',
      },
      datacenterId: {
        type: 'string',
        format: 'uuid',
        description: 'Owning datacenter of the conflicting site subnet, when it is one.',
      },
    },
  },
  DockerNetworkOptions: {
    type: 'object',
    required: ['dockerNetworkName'],
    properties: {
      dockerNetworkName: {
        type: 'string',
        description:
          'Host Docker network name matching compose networks.*.external name (or mapping key). Required when kind is docker.',
        pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
      },
      subnet: {
        type: 'string',
        description:
          'Network CIDR handed to `docker network create --subnet` when the daemon first creates the network. Mirrored into the top-level `cidr` column (the registry-visible range): send either `options.subnet` or `cidr` and the other is derived; a pair that disagrees is 400 `docker_network_subnet_mismatch`. Docker cannot re-range an existing network — a later change only warns on the host.',
      },
      ipRange: {
        type: 'string',
        description:
          'Optional `--ip-range` — the slice of `subnet` containers are assigned from. Must sit inside `subnet` (400 `docker_network_ip_range_invalid`); requires `subnet`.',
      },
      gateway: {
        type: 'string',
        description:
          'Optional `--gateway` — a bare address inside `subnet` (400 `docker_network_gateway_invalid`); requires `subnet`.',
      },
      mtu: {
        type: 'integer',
        minimum: 1280,
        maximum: 9000,
        description:
          'Optional bridge MTU (`--opt com.docker.network.driver.mtu`). Same bounds as the TurboFabric bridge MTU (400 `docker_network_mtu_invalid`).',
      },
    },
    additionalProperties: true,
  },
  CreateNetworkRequest: {
    type: 'object',
    required: ['organizationId', 'kind'],
    properties: {
      organizationId: { type: 'string', format: 'uuid' },
      kind: {
        type: 'string',
        enum: ['datacenter', 'docker', 'reserved'],
        description:
          'Scope pairing: datacenter requires datacenterId (no serverId) — a datacenter may own multiple CIDR rows (one `network(kind=\'datacenter\')` per subnet); docker may optionally pin serverId for a host-local external network and must not set datacenterId; reserved is org-only (neither datacenterId nor serverId) and requires `cidr` — it declares a range TurboPanel must never allocate from or accept elsewhere, e.g. "Corp VPN — Chicago branch" (network_scope_required / network_single_scope_conflict / network_cidr_required on 400). The `compose` and `managed` kinds are platform-allocated and rejected here with `Invalid request`.',
      },
      datacenterId: { type: ['string', 'null'], format: 'uuid' },
      serverId: { type: ['string', 'null'], format: 'uuid' },
      cidr: { type: 'string' },
      name: { type: 'string' },
      metadata: { type: 'object' },
      options: {
        description:
          'For kind=docker, must include dockerNetworkName (long-lived external Docker network).',
        oneOf: [
          { $ref: '#/components/schemas/DockerNetworkOptions' },
          { type: 'object' },
        ],
      },
    },
  },
  PatchNetworkRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      cidr: {
        type: ['string', 'null'],
        description:
          'Re-range the row. `null` clears the CIDR on kind=docker only — kind=datacenter and kind=reserved rows exist because of their CIDR (`network_cidr_required` on 400); on kind=docker it also drops `options.subnet` and is refused (400 `docker_network_subnet_required`) while `options.ipRange` / `options.gateway` remain. A new CIDR goes through the collision authority with the row itself excluded, and on kind=docker is mirrored into `options.subnet`.',
      },
      metadata: { type: ['object', 'null'] },
      options: {
        description:
          'When patching a kind=docker network, options must include a valid dockerNetworkName.',
        oneOf: [
          { $ref: '#/components/schemas/DockerNetworkOptions' },
          { type: 'object' },
          { type: 'null' },
        ],
      },
    },
  },
  CreateNetworkResponse: {
    type: 'object',
    required: ['ok', 'id'],
    properties: {
      ok: { type: 'boolean', const: true },
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const networkPaths: Record<string, unknown> = {
  '/api/client/v1/networks': {
    get: {
      tags: ['Networks'],
      summary: 'List networks',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'organizationId',
          in: 'query',
          description: 'Active organization (also accepted via X-Turbopanel-Organization-Id header)',
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'datacenterId',
          in: 'query',
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'serverId',
          in: 'query',
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'kind',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['datacenter', 'docker', 'managed', 'reserved'],
          },
        },
      ],
      responses: {
        '200': {
          description: 'Networks in the session organization',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NetworksResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid filter',
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
        '404': {
          description: 'Filter target not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
    post: {
      tags: ['Networks'],
      summary: 'Create a network',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateNetworkRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Network created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateNetworkResponse' },
            },
          },
        },
        '400': {
          description:
            'Invalid request — `docker_network_name_required` when kind=docker; `network_scope_required` when datacenter lacks datacenterId; `network_single_scope_conflict` when both scope ids are set, datacenter carries serverId, docker carries datacenterId, or reserved carries either; `network_cidr_required` when datacenter or reserved lacks `cidr`.',
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
        '404': {
          description: 'Scope entity not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '409': {
          description:
            'The CIDR collides with a range the organization already holds — see `CidrCollisionError` for every code.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CidrCollisionError' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/networks/{id}': {
    get: {
      tags: ['Networks'],
      summary: 'Get a network',
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
          description: 'Network',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NetworkResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '403': {
          description: 'Forbidden',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '404': {
          description: 'Network not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
    patch: {
      tags: ['Networks'],
      summary: 'Update a network',
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
            schema: { $ref: '#/components/schemas/PatchNetworkRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Network updated',
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
          description:
            'Invalid request — `docker_network_name_required` when patching options on a kind=docker network; `network_cidr_required` when clearing `cidr` on a kind=datacenter or kind=reserved row; `managed_network_immutable` for any patch of the platform-allocated kind=managed network, which is read-only (kind=reserved rows are operator data and stay editable).',
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
        '404': {
          description: 'Network not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '409': {
          description:
            'The new CIDR collides with a range the organization already holds (the row itself is excluded) — see `CidrCollisionError`.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CidrCollisionError' },
            },
          },
        },
      },
    },
    delete: {
      tags: ['Networks'],
      summary: 'Delete a network',
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
          description: 'Network deleted',
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
          description:
            '`managed_network_immutable` — the platform-allocated kind=managed network cannot be deleted by an operator.',
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
        '404': {
          description: 'Network not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
}
