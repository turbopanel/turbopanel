export const hostSchemas = {
  DaemonHostDockerNetworking: {
    type: "object",
    required: ["ok", "addressPools", "defaultBridgeCidr"],
    properties: {
      ok: { type: "boolean", const: true },
      addressPools: {
        type: "array",
        description:
          "Organization dockerd default-address-pools (`{ base, size }`); empty when the organization has not configured any, in which case the host keeps Docker's built-in pools.",
        items: {
          type: "object",
          required: ["base", "size"],
          properties: {
            base: { type: "string", description: "Pool network CIDR." },
            size: {
              type: "integer",
              description: "Prefix length of each network carved from base.",
            },
          },
        },
      },
      defaultBridgeCidr: {
        type: ["string", "null"],
        description:
          "Organization dockerd bip (bridge host address with prefix), or null for Docker's built-in bridge.",
      },
    },
  },
};

export const hostPaths: Record<string, unknown> = {
  "/api/daemon/v1/host/docker-networking": {
    get: {
      tags: ["Daemon"],
      summary: "Docker host addressing for the calling server's organization",
      description:
        "Org-wide dockerd default-address-pools and bip the daemon merges into /etc/docker/daemon.json (docker Ansible role). Fetched once per daemon session — not carried on environment.deploy, because the pools must reach hosts that never deploy a tenant workload and applying them restarts dockerd. Existing networks and containers keep their addresses; pools only affect networks created afterwards.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Docker host addressing",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/DaemonHostDockerNetworking",
              },
            },
          },
        },
        "404": {
          description: "Calling server has no owner organization",
        },
      },
    },
  },
};
