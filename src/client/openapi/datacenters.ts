import { clientErrorJson } from './shared.ts'

export const datacenterSchemas = {
  DatacenterSubnetRow: {
    type: "object",
    required: ["id", "cidr", "version", "memberCount"],
    properties: {
      id: { type: "string", format: "uuid" },
      cidr: { type: "string" },
      version: { type: "integer", enum: [4, 6] },
      name: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      memberCount: { type: "integer", minimum: 0 },
    },
  },
  DatacenterRow: {
    type: "object",
    required: ["id", "organizationId", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      organizationId: { type: "string", format: "uuid" },
      name: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
      options: {
        type: ["object", "null"],
        description:
          "Optional `defaultServerTimezone`, `enforceServerTimezone`, `addressPreference` (`ipv4` | `ipv6`; omitted defaults to ipv6), `sshPort`, `ntp`, `priority` (integer 0–1000, lower wins; omitted defaults to 100), and `trusted` (boolean; omitted defaults to true). SSH port and NTP cascade to member servers unless a server override is set.",
      },
      privateCidrs: {
        type: "array",
        items: { type: "string" },
        description:
          "CIDRs from `network(kind='datacenter')` rows for this datacenter (one or more subnets). Prerequisite for private/replica placement (server-to-server datacenter transport).",
      },
      priority: {
        type: "integer",
        minimum: 0,
        maximum: 1000,
        description:
          "Effective routing-ladder rank (`options.priority` with the default `100` applied). Lower wins.",
      },
      trusted: {
        type: "boolean",
        description:
          "Effective trust flag (`options.trusted` with the default `true` applied). `false` means the datacenter's L2 is not under the operator's control.",
      },
      subnets: {
        type: "array",
        items: { $ref: "#/components/schemas/DatacenterSubnetRow" },
        description:
          "Site subnets with member counts. Present on detail (`GET /datacenters/{id}`) only; list responses omit this field.",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  DatacentersResponse: {
    type: "object",
    required: ["datacenters"],
    properties: {
      datacenters: {
        type: "array",
        items: { $ref: "#/components/schemas/DatacenterRow" },
      },
    },
  },
  DatacenterMember: {
    type: "object",
    required: ["serverId", "address", "ipId", "networkId", "stale"],
    properties: {
      serverId: { type: "string", format: "uuid" },
      address: { type: "string" },
      ipId: { type: "string", format: "uuid" },
      networkId: { type: ["string", "null"], format: "uuid" },
      stale: {
        type: "boolean",
        description:
          "True when the daemon stopped reporting this pin's address and the automatic repin found no unambiguous replacement (`ip.metadata.stale`). The pin still names the last known address; re-pin manually or wait for the host to report a usable address.",
      },
    },
  },
  DatacenterResponse: {
    type: "object",
    required: ["datacenter"],
    properties: {
      datacenter: { $ref: "#/components/schemas/DatacenterRow" },
      members: {
        type: "array",
        description: "Membership pins in this datacenter (`GET /datacenters/{id}` only).",
        items: { $ref: "#/components/schemas/DatacenterMember" },
      },
    },
  },
  CreateDatacenterRequest: {
    type: "object",
    required: ["members"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      metadata: { type: "object" },
      options: { type: "object" },
      cidr: {
        type: "string",
        description:
          "Ignored when present. Each member's site CIDR is auto-derived from that address's daemon-reported `ips[].cidr` when present, otherwise a typical LAN (`/24` IPv4, `/64` IPv6). Identical aligned CIDRs collapse into one `network(kind='datacenter')` subnet.",
      },
      members: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          required: ["serverId", "address"],
          properties: {
            serverId: { type: "string", format: "uuid" },
            address: {
              type: "string",
              description:
                "Daemon-reported private address. The site subnet for this pin is auto-derived from matching `ips[].cidr` when present, otherwise a typical LAN prefix. The same server may appear more than once with different addresses; addresses need not share one CIDR.",
            },
          },
        },
      },
      sourceServerId: {
        type: "string",
        format: "uuid",
        description:
          "When `name` is omitted, seed the datacenter name and metadata.geo from this member (defaults to members[0])",
      },
    },
  },
  PatchDatacenterRequest: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      metadata: { type: ["object", "null"] },
      options: {
        type: ["object", "null"],
        description:
          "Replace-all datacenter options; `null` clears the stored blob so the documented defaults apply again. `addressPreference` is `'ipv4'` or `'ipv6'`; `priority` is an integer 0–1000 (lower wins); `trusted` is a boolean.",
      },
    },
  },
  CreateDatacenterSubnetRequest: {
    type: "object",
    required: ["cidr"],
    properties: {
      cidr: { type: "string" },
      name: { type: "string" },
      description: {
        type: "string",
        description:
          "Accepted for request validation only. Site networks have no description column; the label is stored in the `name` column.",
      },
    },
  },
  PatchDatacenterSubnetRequest: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: {
        type: "string",
        description:
          "Accepted for request validation only. CIDR cannot be patched.",
      },
    },
  },
  DatacenterNameSuggestion: {
    type: "object",
    required: [
      "name",
      "serverCount",
      "serverIds",
      "serverLabels",
      "geo",
    ],
    properties: {
      name: { type: "string" },
      serverCount: { type: "integer", minimum: 1 },
      serverIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
      serverLabels: {
        type: "array",
        items: { type: "string" },
      },
      geo: { type: "object" },
    },
  },
  DatacenterNameSuggestionsResponse: {
    type: "object",
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        items: { $ref: "#/components/schemas/DatacenterNameSuggestion" },
      },
    },
  },
};

export const datacenterPaths: Record<string, unknown> = {
  "/api/client/v1/datacenters/name-suggestions": {
    get: {
      tags: ["Datacenters"],
      summary: "Suggest datacenter names from server geolocation and ASN",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "unassignedOnly",
          in: "query",
          schema: { type: "string", enum: ["0", "1"] },
          description:
            "When omitted or not `0`, only unassigned servers are considered",
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 0, maximum: 32 },
        },
      ],
      responses: {
        "200": {
          description: "Grouped name suggestions",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/DatacenterNameSuggestionsResponse",
              },
            },
          },
        },
        "400": {
          description: "Invalid request",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
  },
  "/api/client/v1/datacenters": {
    get: {
      tags: ["Datacenters"],
      summary: "List datacenters",
      security: [{ cookieAuth: [] }],
      responses: {
        "200": {
          description: "Datacenters in the session organization",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DatacentersResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
    post: {
      tags: ["Datacenters"],
      summary: "Create a datacenter",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateDatacenterRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "id"],
                properties: {
                  ok: { type: "boolean", const: true },
                  id: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
        "400": {
          description:
            "`address_cidr_unreported` when a member address is not a reported private IP; `address_not_reported` / `address_not_in_cidr` for member pins; otherwise invalid request",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "A requested source or member server is not visible",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "409": {
          description:
            "`address_in_use` when a pin address is already allocated in the organization; otherwise a `CidrCollisionError` when a derived site CIDR collides with the fabric, a reserved range, a docker registration or any site subnet in the organization (`subnet_overlaps`, also for two derived CIDRs in one request)",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  clientErrorJson,
                  { $ref: "#/components/schemas/CidrCollisionError" },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/datacenters/{id}": {
    get: {
      tags: ["Datacenters"],
      summary: "Get a datacenter",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Datacenter",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DatacenterResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "Not found",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
    patch: {
      tags: ["Datacenters"],
      summary: "Update a datacenter",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PatchDatacenterRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", const: true } },
              },
            },
          },
        },
        "400": {
          description: "Invalid request",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "Not found",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
    delete: {
      tags: ["Datacenters"],
      summary: "Delete a datacenter",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", const: true } },
              },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "Not found",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "409": {
          description:
            "`datacenter_has_members` — unassign every server first. `datacenter_has_networks` if a non-site network is still scoped to the datacenter.",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
  },
  "/api/client/v1/datacenters/{id}/members": {
    post: {
      tags: ["Datacenters"],
      summary: "Add datacenter members",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                members: {
                  type: "array",
                  minItems: 1,
                  maxItems: 64,
                  items: {
                    type: "object",
                    required: ["serverId", "address"],
                    properties: {
                      serverId: { type: "string", format: "uuid" },
                      address: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Members pinned",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", const: true } },
              },
            },
          },
        },
        "400": {
          description:
            "`address_cidr_unreported` when a new-subnet pin is not a reported private IP; `address_not_reported` / `address_not_in_cidr` / `address_not_in_any_subnet` for existing-subnet pins; otherwise invalid request",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "Datacenter or member server not found",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "409": {
          description:
            "`address_in_use` when a pin address is already allocated in the organization; otherwise a `CidrCollisionError` when a newly derived site CIDR collides (`subnet_overlaps` for any site subnet in the organization, `cidr_overlaps_gateway_advertised` when the other datacenter and this one both have a gateway relay, `cidr_overlaps_reserved`, `cidr_overlaps_docker_network`, `cidr_overlaps_fabric`, `cidr_overlaps_fabric_pool`)",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  clientErrorJson,
                  { $ref: "#/components/schemas/CidrCollisionError" },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/datacenters/{id}/members/{serverId}": {
    delete: {
      tags: ["Datacenters"],
      summary: "Remove a server from a datacenter",
      description:
        "Removes every membership pin held by that server in this datacenter.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "serverId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Pins removed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "removed"],
                properties: {
                  ok: { type: "boolean", const: true },
                  removed: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "Datacenter or membership not found",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
  },
  "/api/client/v1/datacenters/{id}/subnets": {
    post: {
      tags: ["Datacenters"],
      summary: "Add a datacenter subnet",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateDatacenterSubnetRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Subnet created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "id"],
                properties: {
                  ok: { type: "boolean", const: true },
                  id: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
        "400": {
          description: "`invalid_cidr` or invalid request",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "Datacenter not found",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "409": {
          description:
            "`CidrCollisionError` — `subnet_overlaps` when the CIDR overlaps any site subnet in this organization, `cidr_overlaps_gateway_advertised` when that subnet is in another datacenter and both datacenters have a gateway relay, or `cidr_overlaps_reserved` / `cidr_overlaps_docker_network` / `cidr_overlaps_fabric` / `cidr_overlaps_fabric_pool`",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CidrCollisionError" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/datacenters/{id}/subnets/{networkId}": {
    patch: {
      tags: ["Datacenters"],
      summary: "Rename a datacenter subnet",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "networkId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PatchDatacenterSubnetRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", const: true } },
              },
            },
          },
        },
        "400": {
          description: "Invalid request (including an attempt to patch `cidr`)",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "Datacenter or subnet not found",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
    delete: {
      tags: ["Datacenters"],
      summary: "Delete a datacenter subnet",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "networkId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", const: true } },
              },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "404": {
          description: "Datacenter or subnet not found",
          content: { "application/json": { schema: clientErrorJson } },
        },
        "409": {
          description: "`subnet_has_members` while any IP row references this subnet",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
  },
};
