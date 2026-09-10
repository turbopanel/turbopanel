import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import {
  registerAuthnRoutes,
  registerAuthRoutes,
  type AuthRouteOpts,
} from './authn/http.ts'
import {
  getClientPublicStatus,
  resolveSignupEnvOverrideFromContext,
} from './authn/install-state.ts'
import { getDb } from '../db.ts'
import { registerAccessRoutes } from './access/routes.ts'
import {
  registerEnvironmentDeployPreviewRoutes,
  registerEnvironmentDeployRoutes,
  registerEnvironmentLifecycleRoutes,
  registerEnvironmentStopRoutes,
} from './environments/deploy-routes.ts'
import { registerEnvironmentDeploymentHistoryRoutes } from './environments/deployment-history-routes.ts'
import { registerEnvironmentReleaseRoutes } from './environments/release-routes.ts'
import { registerManagedRoutes } from './managed/routes.ts'
import { registerEnvironmentRoutes } from './environments/routes.ts'
import { registerVariableRoutes } from './variables/routes.ts'
import { registerTagRoutes } from './tags/routes.ts'
import { registerTaskRoutes } from './tasks/routes.ts'
import { registerBindingRoutes } from './bindings/routes.ts'
import { registerContainerRoutes } from './containers/routes.ts'
import { registerDockerRunRoutes } from './docker-run/routes.ts'
import { registerHostingRoutes } from './hostings/routes.ts'
import { registerTlsRoutes } from './tls/routes.ts'
import { registerLicenseRoutes } from './licenses/routes.ts'
import {
  registerOrganizationLimitsRoutes,
  registerProjectPrincipalRoutes,
  registerServerLimitsRoutes,
} from './principals/routes.ts'
import { registerStorageRoutes } from './storage/routes.ts'
import { registerRepositoryRoutes } from './repositories/routes.ts'
import { registerForgeRoutes } from './forges/routes.ts'
import { registerNetworkRoutes } from './networks/routes.ts'
import { registerDatacenterRoutes } from './datacenters/routes.ts'
import { registerIpRoutes } from './ips/routes.ts'
import { registerProjectRoutes } from './projects/routes.ts'
import { registerServerRoutes } from './servers/routes.ts'
import { registerSystemRoutes } from './system/routes.ts'
import { registerServiceRoutes } from './services/routes.ts'
import { registerTeamRoutes } from './teams/routes.ts'
import { registerOrganizationRoutes } from './organizations/routes.ts'
import { registerWorkspaceRoutes } from './workspaces/routes.ts'
import {
  type ClientOpenApiOptions,
  getClientOpenApiSpec,
} from './openapi/index.ts'
import { buildClientScalarHtml } from '../scalar-html.ts'
import { CLIENT_API_PREFIX } from '../surfaces.ts'

/**
 * Workers-only billing and OpenAPI hooks. Passed from `src/workers.ts` so
 * the shared registrar never statically imports Stripe.
 */
export type ClientRouteOpts = AuthRouteOpts & {
  registerBilling?: (client: Hono<AppEnv>, opts: AuthRouteOpts) => void
  getOpenApiSpec?: (
    serverUrl: string,
    options?: ClientOpenApiOptions,
  ) => object
}

/**
 * Client (end-user UI) surface. Auth routes plus org-scoped resources for the
 * signed-in user (e.g. servers assigned to their organization).
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */
export function registerClientRoutes(app: Hono<AppEnv>, opts: ClientRouteOpts) {
  const client = new Hono<AppEnv>()

  registerAuthRoutes(client, opts)
  registerAuthnRoutes(client, opts)

  client.get('/status', async (c) => {
    const db = getDb(c)
    const platformEnv = c.get('platformEnv')
    // Effective signup flag is resolved inside getClientPublicStatus via
    // resolveEffectiveSignupEnabled — same helper as sign-up / OTP auto-reg.
    // Prefer per-request platformEnv so dashboard force overrides apply without
    // an isolate recycle (do not rely on createApp()-captured signupEnvOverride).
    const payload = await getClientPublicStatus(
      db,
      opts.runtime,
      resolveSignupEnvOverrideFromContext(platformEnv, opts.signupEnvOverride),
      platformEnv,
      // Presence of the config *is* billing enabled; the key never leaves here.
      c.get('billingConfig') !== undefined,
    )
    if (payload === null) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }
    return c.json(payload)
  })

  registerServerRoutes(client, opts)
  registerSystemRoutes(client, opts)
  registerNetworkRoutes(client, opts)
  registerDatacenterRoutes(client, opts)
  registerIpRoutes(client, opts)
  registerLicenseRoutes(client, opts)
  opts.registerBilling?.(client, opts)
  registerOrganizationRoutes(client, opts)
  registerAccessRoutes(client, opts)
  registerWorkspaceRoutes(client, opts)
  registerEnvironmentRoutes(client, opts)
  registerEnvironmentDeployPreviewRoutes(client, opts)
  registerEnvironmentDeployRoutes(client, opts)
  registerEnvironmentDeploymentHistoryRoutes(client, opts)
  registerEnvironmentReleaseRoutes(client, opts)
  registerEnvironmentStopRoutes(client, opts)
  registerEnvironmentLifecycleRoutes(client, opts)
  registerManagedRoutes(client, opts)
  registerVariableRoutes(client, opts)
  registerTagRoutes(client, opts)
  registerTaskRoutes(client, opts)
  registerBindingRoutes(client, opts)
  registerProjectRoutes(client, opts)
  registerServiceRoutes(client, opts)
  registerHostingRoutes(client, opts)
  registerContainerRoutes(client, opts)
  registerDockerRunRoutes(client, opts)
  registerStorageRoutes(client, opts)
  registerRepositoryRoutes(client, opts)
  registerForgeRoutes(client, opts)
  registerProjectPrincipalRoutes(client, opts)
  registerOrganizationLimitsRoutes(client, opts)
  registerServerLimitsRoutes(client, opts)
  registerTlsRoutes(client, opts)
  registerTeamRoutes(client, opts)

  client.get('/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin
    const spec = (opts.getOpenApiSpec ?? getClientOpenApiSpec)(origin, {
      runtime: opts.runtime,
    })
    return c.json(spec)
  })

  client.get('/reference', (c) => {
    const origin = new URL(c.req.url).origin
    return c.html(buildClientScalarHtml('/api/client/v1/openapi.json', origin))
  })

  app.route(CLIENT_API_PREFIX, client)
  return app
}
