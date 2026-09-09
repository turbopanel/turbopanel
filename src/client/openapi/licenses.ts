export function buildLicenseSchemas(installCommandDescription: string) {
  return {
    LicenseRecord: {
      type: 'object',
      required: ['id', 'name', 'createdAt', 'revocable', 'boundServer'],
      properties: {
        id: { type: 'string' },
        name: { type: ['string', 'null'] },
        createdAt: { type: 'string', format: 'date-time' },
        revocable: {
          type: 'boolean',
          description:
            'When false, this license is for the co-located control plane daemon and cannot be invalidated.',
        },
        boundServer: {
          oneOf: [
            {
              type: 'object',
              required: ['id', 'name', 'connected'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: ['string', 'null'] },
                connected: { type: 'boolean' },
              },
            },
            { type: 'null' },
          ],
          description:
            'Bound server when exactly one server in the org references this license; null when unbound or ambiguously bound.',
        },
      },
    },
    LicensesResponse: {
      type: 'object',
      required: ['licenses'],
      properties: {
        licenses: {
          type: 'array',
          items: { $ref: '#/components/schemas/LicenseRecord' },
        },
      },
    },
    CreateLicenseRequest: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        installBaseUrl: {
          type: 'string',
          description:
            'Development only: public http(s) URL for install command --host and download paths.',
        },
      },
    },
    CreateLicenseResponse: {
      type: 'object',
      required: ['licenseId', 'licenseToken', 'installCommand'],
      properties: {
        licenseId: { type: 'string' },
        licenseToken: {
          type: 'string',
          description: 'Shown once at creation; not stored in plaintext.',
        },
        installCommand: {
          type: 'string',
          description: installCommandDescription,
        },
      },
    },
    InvalidateOkResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: true },
      },
    },
    LicenseHasAttachedServerError: {
      type: 'object',
      required: ['error', 'server'],
      properties: {
        error: { type: 'string', const: 'license_has_attached_server' },
        server: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            name: { type: ['string', 'null'] },
          },
        },
      },
    },
  }
}

export function buildLicensePaths(_installCommandDescription: string): Record<string, unknown> {
  return {
    '/api/client/v1/licenses': {
      get: {
        tags: ['Licenses'],
        summary: 'List active licenses for org',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'Active licenses for the signed-in organization',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LicensesResponse' },
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
      post: {
        tags: ['Licenses'],
        summary: 'Create a license',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateLicenseRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'License created; token shown once',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateLicenseResponse' },
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
          '409': {
            description:
              'Organization server seat capacity exceeded (maxServers). Enrolled servers and unconsumed keys both count.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'error',
                    'maxServers',
                    'usedSeats',
                    'serverCount',
                    'reservedSeatCount',
                  ],
                  properties: {
                    error: { type: 'string', const: 'server_capacity_exceeded' },
                    maxServers: { type: ['integer', 'null'] },
                    usedSeats: { type: 'integer' },
                    serverCount: { type: 'integer' },
                    reservedSeatCount: { type: 'integer' },
                  },
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
    '/api/client/v1/licenses/{id}': {
      delete: {
        tags: ['Licenses'],
        summary: 'Invalidate a license',
        description:
          'Soft-invalidates the license (sets revoked_at) when no live server is attached. A bound server must be deleted first (409). Force-revoke of daemon keys happens only on the colocated rotation path.',
        security: [{ cookieAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'License invalidated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InvalidateOkResponse' },
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
            description: 'Co-located control plane license cannot be invalidated',
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
            description: 'License not found or already invalidated',
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
            description:
              'License is still attached to a server — delete the server first',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/LicenseHasAttachedServerError',
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
  }
}
