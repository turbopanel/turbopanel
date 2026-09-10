/**
 * Hosted (Workers) client OpenAPI — billing tags, paths, and schemas.
 *
 * Imported only from `src/workers.ts`. The shared {@link getClientOpenApiSpec}
 * stays billing-free so the self-hosted Deno graph never carries Stripe
 * documentation.
 */
import { billingPaths, billingSchemas } from './billing.ts'
import { getClientOpenApiSpec } from './index.ts'

const BILLING_TAG = {
  name: 'Billing',
  description:
    'Hosted billing: catalogue, projected subscription, Checkout, Customer Portal, seat and tier changes. Hosted (Workers) only; absent on self-hosted. `503 billing_not_configured` until Stripe is configured.',
} as const

type ClientSpec = {
  tags: { name: string; description?: string }[]
  'x-tagGroups': { name: string; tags: string[] }[]
  components: { schemas: Record<string, unknown> }
  paths: Record<string, unknown>
}

export function getWorkersClientOpenApiSpec(serverUrl: string): object {
  const spec = getClientOpenApiSpec(serverUrl, { runtime: 'workers' }) as ClientSpec
  const licensesIndex = spec.tags.findIndex((tag) => tag.name === 'Licenses')
  if (licensesIndex === -1) {
    spec.tags.push(BILLING_TAG)
  } else {
    spec.tags.splice(licensesIndex + 1, 0, BILLING_TAG)
  }
  const infrastructure = spec['x-tagGroups'].find((group) =>
    group.name === 'Infrastructure'
  )
  if (infrastructure && !infrastructure.tags.includes('Billing')) {
    infrastructure.tags.push('Billing')
  }
  Object.assign(spec.components.schemas, billingSchemas)
  Object.assign(spec.paths, billingPaths)
  return spec
}
