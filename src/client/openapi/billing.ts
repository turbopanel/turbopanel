const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
} as const

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorSchema } },
})

const notConfigured = errorResponse(
  'Billing is not configured on this instance (`billing_not_configured`); self-hosted has no billing surface.',
)
const unauthorized = errorResponse('Unauthorized')
const forbidden = errorResponse('Forbidden (owner-only)')

export const billingSchemas = {
  BillingTier: {
    type: 'object',
    required: ['id', 'label', 'generation', 'rank', 'priceCents', 'isCustom', 'entitlements'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      label: { type: 'string', description: '`S1`…`S7`, `SX`.' },
      generation: { type: 'integer' },
      rank: { type: 'integer' },
      priceCents: { type: ['integer', 'null'], description: 'Null for negotiated (custom) offerings.' },
      isCustom: { type: 'boolean' },
      entitlements: {
        type: 'object',
        required: ['maxCores', 'maxMemoryBytes', 'nicSlots', 'driveSlots', 'gpuSlots', 'filesystemSlots'],
        properties: {
          maxCores: { type: 'integer' },
          maxMemoryBytes: { type: 'integer' },
          nicSlots: { type: 'integer' },
          driveSlots: { type: 'integer' },
          gpuSlots: { type: 'integer' },
          filesystemSlots: { type: 'integer' },
        },
      },
    },
  },
  BillingCatalogResponse: {
    type: 'object',
    required: ['tiers'],
    properties: { tiers: { type: 'array', items: { $ref: '#/components/schemas/BillingTier' } } },
  },
  BillingTierSeats: {
    type: 'object',
    required: ['tierId', 'label', 'seats', 'licensesUsed', 'licensesBound', 'licensesFree'],
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      label: { type: 'string' },
      seats: { type: 'integer', description: 'Committed provider quantity at this tier.' },
      licensesUsed: { type: 'integer', description: 'Active licenses at this tier.' },
      licensesBound: { type: 'integer', description: 'The subset bound to a server.' },
      licensesFree: {
        type: 'integer',
        description: 'Seats a new key can be minted against, net of outstanding seat releases.',
      },
    },
  },
  BillingPendingChange: {
    type: 'object',
    required: ['id', 'kind', 'licenseId', 'fromTierId', 'toTierId', 'createdAt', 'expiresAt'],
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', enum: ['upgrade', 'downgrade', 'release-seat'] },
      licenseId: { type: ['string', 'null'], format: 'uuid' },
      fromTierId: { type: 'string', format: 'uuid' },
      toTierId: { type: ['string', 'null'], format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'Set on upgrades (24 h); null on deferred changes, which live until the period boundary.',
      },
    },
  },
  BillingSubscriptionResponse: {
    type: 'object',
    required: ['payer', 'subscription', 'tiers', 'pendingChanges'],
    properties: {
      payer: {
        oneOf: [
          { type: 'object', required: ['taxId'], properties: { taxId: { type: ['string', 'null'] } } },
          { type: 'null' },
        ],
      },
      subscription: {
        oneOf: [
          {
            type: 'object',
            required: ['status', 'currentPeriodEnd', 'pastDueSince', 'graceExpiresAt', 'scheduleAttached'],
            properties: {
              status: { type: 'string', description: 'Provider status verbatim (`active`, `past_due`, …).' },
              currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
              pastDueSince: { type: ['string', 'null'], format: 'date-time' },
              graceExpiresAt: {
                type: ['string', 'null'],
                format: 'date-time',
                description: 'Entitlement survives until this moment while past due; the grace clock cancels after it.',
              },
              scheduleAttached: {
                type: 'boolean',
                description: 'A deferred change (downgrade / seat release) is parked on a subscription schedule.',
              },
            },
          },
          { type: 'null' },
        ],
      },
      tiers: { type: 'array', items: { $ref: '#/components/schemas/BillingTierSeats' } },
      pendingChanges: { type: 'array', items: { $ref: '#/components/schemas/BillingPendingChange' } },
    },
  },
  BillingCheckoutRequest: {
    type: 'object',
    required: ['tierId'],
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      quantity: { type: 'integer', minimum: 1, default: 1 },
    },
  },
  BillingRedirectResponse: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', description: 'Hosted Stripe page to redirect the browser to.' },
      sessionId: { type: 'string' },
    },
  },
  BillingPreviewRequest: {
    type: 'object',
    description:
      'Either a quantity change (`tierId` + `delta`) or a tier move for one license (`licenseId` + `targetTierId`).',
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      delta: { type: 'integer' },
      licenseId: { type: 'string', format: 'uuid' },
      targetTierId: { type: 'string', format: 'uuid' },
    },
  },
  BillingPreviewResponse: {
    type: 'object',
    required: ['prorationDate', 'currency', 'subtotal', 'tax', 'total', 'amountDue', 'lines'],
    properties: {
      prorationDate: {
        type: 'integer',
        description: 'Unix seconds. Pass back verbatim on apply so the invoice matches the quote.',
      },
      currency: { type: ['string', 'null'] },
      subtotal: { type: ['integer', 'null'] },
      tax: { type: ['integer', 'null'] },
      total: { type: ['integer', 'null'] },
      amountDue: { type: ['integer', 'null'] },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          required: ['description', 'amount', 'proration'],
          properties: {
            description: { type: ['string', 'null'] },
            amount: { type: 'integer' },
            proration: { type: 'boolean' },
          },
        },
      },
    },
  },
  BillingSeatsRequest: {
    type: 'object',
    required: ['tierId', 'delta'],
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      delta: { type: 'integer', description: 'Positive: immediate, invoiced now. Negative: deferred to the period boundary.' },
      prorationDate: { type: 'integer', description: 'From the preview; increases only.' },
    },
  },
  BillingTierMoveRequest: {
    type: 'object',
    required: ['licenseId', 'targetTierId'],
    properties: {
      licenseId: { type: 'string', format: 'uuid' },
      targetTierId: { type: 'string', format: 'uuid' },
      prorationDate: { type: 'integer', description: 'From the preview; upgrades only.' },
    },
  },
  BillingMutationResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
      pending: {
        type: 'boolean',
        description:
          'The immediate charge failed and Stripe parked the change; entitlement is unchanged until it applies.',
      },
      deferred: { type: 'boolean', description: 'Parked on a schedule for the period boundary.' },
      intentId: { type: 'string' },
      scheduleId: { type: ['string', 'null'] },
    },
  },
} as const

const conflict = (codes: string) =>
  errorResponse(`Conflict — \`error\` is one of ${codes}.`)

const CLIENT_PREFIX = '/api/client/v1'

function mutationPath(summary: string, requestSchema: string, extraConflicts: string) {
  return {
    post: {
      tags: ['Billing'],
      summary,
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${requestSchema}` } } },
      },
      responses: {
        '200': {
          description: 'Applied or parked',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingMutationResponse' } } },
        },
        '400': errorResponse('Invalid request, `tier_not_purchasable`, `not_an_upgrade` / `not_a_downgrade`'),
        '401': unauthorized,
        '403': forbidden,
        '404': errorResponse('Unknown license'),
        '409': conflict(`\`billing_mutation_in_progress\`, ${extraConflicts}`),
        '502': errorResponse('Stripe refused the request (`stripe_error`, permanent)'),
        '503': errorResponse('`billing_not_configured`, or Stripe was unreachable (`stripe_error`, transient)'),
      },
    },
  }
}

export const billingPaths: Record<string, unknown> = {
  [`${CLIENT_PREFIX}/billing/catalog`]: {
    get: {
      tags: ['Billing'],
      summary: 'Active tiers with price and entitlement columns',
      description: 'Postgres only — no Stripe call.',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Catalogue in `(generation, rank)` order',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingCatalogResponse' } } },
        },
        '401': unauthorized,
        '403': forbidden,
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/subscription`]: {
    get: {
      tags: ['Billing'],
      summary: 'Projection summary for the organization',
      description: 'Status, period end, per-tier seats vs licenses, grace clock, schedule flag and outstanding deferred changes. Postgres only.',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Summary',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingSubscriptionResponse' } } },
        },
        '401': unauthorized,
        '403': forbidden,
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/checkout`]: {
    post: {
      tags: ['Billing'],
      summary: 'First purchase → hosted Checkout URL',
      description: 'Refused with `subscription_exists` once a live subscription is projected; later changes use `/billing/seats`, `/billing/upgrade`, `/billing/downgrade`.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingCheckoutRequest' } } },
      },
      responses: {
        '200': {
          description: 'Redirect target',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingRedirectResponse' } } },
        },
        '400': errorResponse('Invalid request or `tier_not_purchasable`'),
        '401': unauthorized,
        '403': forbidden,
        '409': conflict('`subscription_exists`, `billing_mutation_in_progress`'),
        '502': errorResponse('`stripe_error`'),
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/portal`]: {
    post: {
      tags: ['Billing'],
      summary: 'Customer Portal session URL (invoices and payment methods only)',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Redirect target',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingRedirectResponse' } } },
        },
        '401': unauthorized,
        '403': forbidden,
        '404': errorResponse('No provider customer yet'),
        '502': errorResponse('`stripe_error`'),
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/preview`]: {
    post: {
      tags: ['Billing'],
      summary: 'Proration quote for a quantity or tier change',
      description: 'Returns Stripe\'s amounts and the pinned `prorationDate` verbatim; pass it back on apply.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingPreviewRequest' } } },
      },
      responses: {
        '200': {
          description: 'Quote',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingPreviewResponse' } } },
        },
        '400': errorResponse('Invalid request or `tier_not_purchasable`'),
        '401': unauthorized,
        '403': forbidden,
        '404': errorResponse('Unknown license'),
        '409': conflict('`subscription_past_due`, `no_subscription`'),
        '502': errorResponse('`stripe_error`'),
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/seats`]: mutationPath(
    'Change the seat quantity at one tier',
    'BillingSeatsRequest',
    '`subscription_past_due`, `no_subscription`, `seats_in_use`',
  ),
  [`${CLIENT_PREFIX}/billing/upgrade`]: mutationPath(
    'Move one license to a higher tier, invoiced now',
    'BillingTierMoveRequest',
    '`subscription_past_due`, `no_subscription`, `license_has_pending_change`',
  ),
  [`${CLIENT_PREFIX}/billing/downgrade`]: mutationPath(
    'Move one license to a lower tier at the period boundary',
    'BillingTierMoveRequest',
    '`no_subscription`, `license_has_pending_change`',
  ),
}
