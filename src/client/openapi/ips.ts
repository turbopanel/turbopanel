import { clientErrorJson } from "./shared.ts";

export const ipSchemas = {
  IpRow: {
    type: "object",
    required: [
      "id",
      "organizationId",
      "address",
      "version",
      "allocation",
      "scope",
      "createdAt",
      "updatedAt",
      "stale",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      organizationId: { type: "string", format: "uuid" },
      datacenterId: { type: ["string", "null"], format: "uuid" },
      networkId: { type: ["string", "null"], format: "uuid" },
      serverId: { type: ["string", "null"], format: "uuid" },
      address: { type: "string" },
      version: {
        type: "integer",
        enum: [4, 6],
        description:
          "Derived from `address`, read-only. Do not send on create.",
      },
      allocation: { type: "string", enum: ["dedicated", "shared"] },
      scope: { type: "string", enum: ["public", "datacenter"] },
      description: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
      options: { type: ["object", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      stale: {
        type: "boolean",
        description:
          "Membership pins only: true when the daemon stopped reporting this address and no unambiguous replacement was found, so the pin no longer reflects a live host address. Derived from `metadata.stale`, read-only.",
      },
      staleSince: { type: ["string", "null"], format: "date-time" },
      staleReason: {
        type: ["string", "null"],
        enum: ["address_gone_no_candidate", "address_gone_ambiguous", null],
      },
    },
  },
  IpsResponse: {
    type: "object",
    required: ["ips"],
    properties: {
      ips: { type: "array", items: { $ref: "#/components/schemas/IpRow" } },
    },
  },
  IpResponse: {
    type: "object",
    required: ["ip"],
    properties: {
      ip: { $ref: "#/components/schemas/IpRow" },
    },
  },
  CreateIpRequest: {
    type: "object",
    required: ["address", "allocation", "scope"],
    description:
      "Do not send `version` (server returns 400 when present). `scope=datacenter` requires `datacenterId`. Free pool: datacenterId only. Membership pin: datacenterId + serverId + networkId (site subnet of that datacenter; address must fall in that subnet).",
    properties: {
      address: { type: "string" },
      allocation: { type: "string", enum: ["dedicated", "shared"] },
      scope: { type: "string", enum: ["public", "datacenter"] },
      description: { type: "string" },
      datacenterId: { type: ["string", "null"], format: "uuid" },
      networkId: { type: ["string", "null"], format: "uuid" },
      serverId: { type: ["string", "null"], format: "uuid" },
      metadata: { type: "object" },
      options: { type: "object" },
    },
  },
  PatchIpRequest: {
    type: "object",
    properties: {
      description: { type: "string" },
      datacenterId: { type: ["string", "null"], format: "uuid" },
      networkId: { type: ["string", "null"], format: "uuid" },
      serverId: { type: ["string", "null"], format: "uuid" },
      metadata: { type: ["object", "null"] },
      options: { type: ["object", "null"] },
    },
  },
};

export const ipPaths: Record<string, unknown> = {
  "/api/client/v1/ips": {
    get: {
      tags: ["IPs"],
      summary: "List IP addresses",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "datacenterId",
          in: "query",
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "serverId",
          in: "query",
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "networkId",
          in: "query",
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "scope",
          in: "query",
          schema: { type: "string", enum: ["public", "datacenter"] },
        },
        {
          name: "allocation",
          in: "query",
          schema: { type: "string", enum: ["dedicated", "shared"] },
        },
      ],
      responses: {
        "200": {
          description: "IPs",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/IpsResponse" },
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
    post: {
      tags: ["IPs"],
      summary: "Create an IP address",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateIpRequest" },
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
            "Invalid request — includes client-supplied `version`, invalid address/scope FKs, missing `datacenterId` when `scope=datacenter`, membership pins missing `networkId`, a `networkId` that is not a site subnet of that datacenter, `address_not_in_any_subnet`, or free-pool rows that also set networkId.",
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
        "409": {
          description:
            "Conflict — `ip_address_in_use` when the address is already registered.",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
  },
  "/api/client/v1/ips/{id}": {
    get: {
      tags: ["IPs"],
      summary: "Get an IP address",
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
          description: "IP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/IpResponse" },
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
      tags: ["IPs"],
      summary: "Update an IP address",
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
            schema: { $ref: "#/components/schemas/PatchIpRequest" },
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
          description:
            "Invalid request — includes immutable field patches, invalid scope FKs, membership pins missing `networkId`, a `networkId` that is not a site subnet of that datacenter, or `address_not_in_any_subnet`.",
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
      tags: ["IPs"],
      summary: "Delete an IP address",
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
            "Conflict — `ip_in_use` when the address is pinned to a hosting.",
          content: { "application/json": { schema: clientErrorJson } },
        },
      },
    },
  },
};
