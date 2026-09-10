import { ADMIN_API_PREFIX } from '../../surfaces.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

/**
 * Tier catalogue paths. Hosted (Workers) only: the routes are not mounted on
 * self-hosted Deno, so the shared admin spec omits them.
 */
export const TIER_PATHS = {
  [`${ADMIN_API_PREFIX}/tiers`]: {
    get: {
      tags: ['Tiers'],
      summary: 'List every tier row, active and inactive, with the ladder',
      description:
        'Rank order. Each row carries the provider product it bills against, ' +
        'the cached display price, the ladder entitlements for its label and ' +
        'its reference counts (seats and assigned servers). `ladder` lists ' +
        'every label with the row bound to it, so the console can show what ' +
        'is still unmapped.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Every tier row, and the ladder' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Superadmin access required' },
        '503': {
          description: 'Database unavailable, or billing is not configured',
        },
      },
    },
    post: {
      tags: ['Tiers'],
      summary: 'Bind a ladder label to a provider product',
      description:
        'Body `{ label, providerProductId? }`. The label must be on the ' +
        'ladder; `SX` takes no product, every other label needs one. The ' +
        'product is fetched from the provider with its default price and ' +
        'verified (active, recurring monthly, per-unit, usd, and a tax ' +
        'behaviour resolvable from the price or the account\'s Tax ' +
        'settings default) before the row is written — a wrong product is silent ' +
        'downstream, because the projection skips items whose product maps ' +
        'to no tier. `rank` and `isCustom` come from the ladder, never the body.',
      security: [...cookieSecurity],
      responses: {
        '201': { description: 'Created, with the verification result' },
        '400': {
          description:
            '`tier_invalid`, `product_verification_failed` (with `message`), or `product_lookup_failed`',
        },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Superadmin access required' },
        '409': {
          description: '`tier_exists`: that label, or that product, already has a row',
        },
        '503': {
          description: 'Database unavailable, or billing is not configured',
        },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/tiers/products`]: {
    get: {
      tags: ['Tiers'],
      summary: "The provider's active products — the dropdown",
      description:
        'Every active product with its default price expanded, a pass/fail ' +
        'verification with the reasons, the ladder label it names in ' +
        '`metadata.turbopanel_tier` (when valid) as `suggestedLabel`, and the ' +
        'tier row already bound to it, if any, plus `taxDefaults` — the ' +
        'account\'s Stripe Tax default, which is what lets a price left at ' +
        '"Use default" verify. One provider list call, and a second for ' +
        'those defaults only when some price needs them; nothing is written.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ provider, taxDefaults, products }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Superadmin access required' },
        '502': { description: '`product_lookup_failed`: the provider could not be listed' },
        '503': {
          description: 'Database unavailable, or billing is not configured',
        },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/tiers/verify`]: {
    post: {
      tags: ['Tiers'],
      summary: 'Re-verify every priced row and refresh its cached price',
      description:
        'The "Verify all" button. One product fetch per priced row; the ' +
        'only write is the row\'s cached display price.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'One verification result per priced row' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Superadmin access required' },
        '503': {
          description: 'Database unavailable, or billing is not configured',
        },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/tiers/{id}`]: {
    patch: {
      tags: ['Tiers'],
      summary: 'Change one tier row',
      description:
        'Body `{ providerProductId?, isActive? }`. `label` and `rank` are ' +
        'identity and never patchable — a re-label is a new row. The product ' +
        'is re-verified only when it actually changed.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'The updated row' },
        '400': { description: '`tier_invalid`, or the product failed verification' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Superadmin access required' },
        '404': { description: 'No such tier' },
        '409': { description: '`tier_exists`: another row already bills against that product' },
        '503': {
          description: 'Database unavailable, or billing is not configured',
        },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/tiers/{id}/deactivate`]: {
    post: {
      tags: ['Tiers'],
      summary: 'Retire a tier row',
      description:
        'Tiers are deactivated, never deleted: an inactive row cannot be ' +
        'bought into but stays readable for the seats that still count ' +
        'against it.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'The deactivated row' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Superadmin access required' },
        '404': { description: 'No such tier' },
        '503': {
          description: 'Database unavailable, or billing is not configured',
        },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/tiers/{id}/verify`]: {
    post: {
      tags: ['Tiers'],
      summary: 'Verify one row\'s provider product and refresh its cached price',
      description: 'A custom row has no product to verify and answers 400 `tier_has_no_product`.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'The verification result and the refreshed row' },
        '400': { description: 'Verification failed, or the row has no product' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Superadmin access required' },
        '404': { description: 'No such tier' },
        '503': {
          description: 'Database unavailable, or billing is not configured',
        },
      },
    },
  },
}
