import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerDockerRunRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('registerDockerRunRoutes requires session secrets', () => {
  const router = new Hono<AppEnv>()
  let thrown = false
  try {
    registerDockerRunRoutes(router, {} as AuthRouteOpts)
  } catch (err) {
    thrown = err instanceof TypeError &&
      err.message === 'session secrets are required for docker-run routes'
  }
  assertEquals(thrown, true)
})

test('registerDockerRunRoutes mounts the import path when secrets are present', async () => {
  const router = new Hono<AppEnv>()
  registerDockerRunRoutes(router, {
    secrets: await deriveSecretsConfig(
      parseTestSecretsConfig(),
      'session-signing',
    ),
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  const paths = router.routes.map((route) => route.path)
  assertEquals(paths.includes('/docker-run/import'), true)
})
