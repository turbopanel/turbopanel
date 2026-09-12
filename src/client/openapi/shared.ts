export const clientErrorJson = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
}

export const sharedSchemas = {
  UpdateEntityRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
    },
  },
}

export function resourceErrorResponses(options?: {
  badRequest?: boolean
  forbidden?: boolean
  notFound?: boolean
}) {
  const responses: Record<string, unknown> = {
    '401': {
      description: 'Unauthorized',
      content: { 'application/json': { schema: clientErrorJson } },
    },
    '503': {
      description: 'Database unavailable',
      content: { 'application/json': { schema: clientErrorJson } },
    },
  }
  if (options?.badRequest) {
    responses['400'] = {
      description: 'Invalid request',
      content: { 'application/json': { schema: clientErrorJson } },
    }
  }
  if (options?.forbidden !== false) {
    responses['403'] = {
      description: 'Forbidden',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    }
  }
  if (options?.notFound) {
    responses['404'] = {
      description: 'Not found',
      content: { 'application/json': { schema: clientErrorJson } },
    }
  }
  return responses
}

export type ResourceCrudConfig = {
  plural: string
  singular: string
  listSchema: string
  rowSchema: string
  createSchema: string
  patchSchema?: string
  createBodyRequired?: boolean
  parentQuery?: { name: string; description: string }
  tag?: string
  /** Extra top-level properties on the `GET /{id}` response beside the row. */
  detailExtraProperties?: Record<string, unknown>
}

function defaultResourceTag(plural: string): string {
  return plural.charAt(0).toUpperCase() + plural.slice(1)
}

export function buildResourceCrudPaths(config: ResourceCrudConfig): Record<string, unknown> {
  const base = `/api/client/v1/${config.plural}`
  const idPath = `${base}/{id}`
  const security = [{ cookieAuth: [] }]
  const tag = config.tag ?? defaultResourceTag(config.plural)
  const singleEntitySchema = {
    type: 'object',
    required: [config.singular],
    properties: {
      [config.singular]: { $ref: `#/components/schemas/${config.rowSchema}` },
      ...config.detailExtraProperties,
    },
  }

  const listGet: Record<string, unknown> = {
    tags: [tag],
    summary: `List ${config.plural}`,
    security,
    responses: {
      '200': {
        description: `Visible ${config.plural} for the signed-in organization`,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${config.listSchema}` },
          },
        },
      },
      ...resourceErrorResponses({ forbidden: false }),
    },
  }

  if (config.parentQuery) {
    listGet.parameters = [
      {
        name: config.parentQuery.name,
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: config.parentQuery.description,
      },
    ]
  }

  return {
    [base]: {
      get: listGet,
      post: {
        tags: [tag],
        summary: `Create ${config.singular}`,
        security,
        requestBody: {
          required: config.createBodyRequired ?? true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${config.createSchema}` },
            },
          },
        },
        responses: {
          '200': {
            description: `${config.singular} created`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ badRequest: true, notFound: true }),
        },
      },
    },
    [idPath]: {
      get: {
        tags: [tag],
        summary: `Get ${config.singular}`,
        security,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: `${config.singular} details`,
            content: {
              'application/json': { schema: singleEntitySchema },
            },
          },
          ...resourceErrorResponses({ notFound: true }),
        },
      },
      patch: {
        tags: [tag],
        summary: `Update ${config.singular}`,
        security,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: `#/components/schemas/${config.patchSchema ?? 'UpdateEntityRequest'}`,
              },
            },
          },
        },
        responses: {
          '200': {
            description: `${config.singular} updated`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ badRequest: true, notFound: true }),
        },
      },
      delete: {
        tags: [tag],
        summary: `Delete ${config.singular}`,
        security,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: `${config.singular} deleted`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ notFound: true }),
        },
      },
    },
  }
}
