/**
 * Hosted (Workers) admin OpenAPI — the tier catalogue.
 *
 * Imported only from `src/workers.ts`. The shared {@link getAdminOpenApiSpec}
 * stays billing-free so the self-hosted Deno graph never carries Stripe
 * documentation.
 */
import { getAdminOpenApiSpec } from './index.ts'
import { TIER_PATHS } from './tiers.ts'

const TIERS_TAG = {
  name: 'Tiers',
  description:
    'The billing tier catalogue (hosted only). Superadmin only, and 503 ' +
    'when billing is off. Nothing seeds these rows: the owner creates the ' +
    'Product and Price in the Stripe Dashboard and a superadmin enters the ' +
    'row here, which is verified against Stripe before it is written.',
} as const

type AdminSpec = {
  tags: { name: string; description?: string }[]
  'x-tagGroups': { name: string; tags: string[] }[]
  paths: Record<string, unknown>
}

export function getWorkersAdminOpenApiSpec(
  serverUrl: string,
  opts?: { devSurface?: boolean; runtime?: 'deno' | 'workers' },
): object {
  const spec = getAdminOpenApiSpec(serverUrl, {
    ...(opts?.devSurface === undefined ? {} : { devSurface: opts.devSurface }),
  }) as AdminSpec
  if (!spec.tags.some((tag) => tag.name === 'Tiers')) {
    spec.tags.push(TIERS_TAG)
  }
  if (!spec['x-tagGroups'].some((group) => group.name === 'Billing')) {
    spec['x-tagGroups'].push({ name: 'Billing', tags: ['Tiers'] })
  }
  Object.assign(spec.paths, TIER_PATHS)
  return spec
}
