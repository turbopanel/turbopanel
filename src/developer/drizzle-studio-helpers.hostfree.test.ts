import { assertEquals } from '@std/assert'
import { DRIZZLE_STUDIO_PORT } from '../drizzle-studio-probe.ts'
import {
  childErrorDetail,
  drizzleKitBinPath,
  studioStartWhenDatabaseMissing,
  studioStartWhenNotReady,
  studioStatusWhenBindFails,
  waitForStudioPort,
} from './drizzle-studio-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('drizzleKitBinPath joins repo root with drizzle-kit bin', () => {
  assertEquals(
    drizzleKitBinPath('/opt/instance'),
    '/opt/instance/node_modules/drizzle-kit/bin.cjs',
  )
})

test('studioStatusWhenBindFails returns localhost browser URL', () => {
  const status = studioStatusWhenBindFails('host must be loopback')
  assertEquals(status.running, false)
  assertEquals(status.port, DRIZZLE_STUDIO_PORT)
  assertEquals(status.error, 'host must be loopback')
  assertEquals(status.browserUrl.includes(String(DRIZZLE_STUDIO_PORT)), true)
})

test('studioStartWhenDatabaseMissing and studioStartWhenNotReady messages', () => {
  assertEquals(studioStartWhenDatabaseMissing(), {
    ok: false,
    error: 'postgres is not configured (missing TURBOPANEL_DATABASE_URL)',
  })
  assertEquals(studioStartWhenNotReady(undefined), {
    ok: false,
    error: 'drizzle studio did not become ready in time',
  })
  assertEquals(studioStartWhenNotReady('exit 1'), {
    ok: false,
    error: 'exit 1',
  })
})

test('childErrorDetail returns undefined for null child', async () => {
  assertEquals(await childErrorDetail(null), undefined)
})

test('childErrorDetail waits for a failed child or times out a hanging one', async () => {
  const failed = {
    status: Promise.resolve({ success: false, code: 7 }),
  } as unknown as Deno.ChildProcess
  assertEquals(await childErrorDetail(failed), 'drizzle studio exited (code 7)')

  const ok = {
    status: Promise.resolve({ success: true, code: 0 }),
  } as unknown as Deno.ChildProcess
  assertEquals(await childErrorDetail(ok), undefined)

  const hanging = {
    status: new Promise<{ success: boolean; code: number }>(() => {}),
  } as unknown as Deno.ChildProcess
  assertEquals(await childErrorDetail(hanging), undefined)
})

test('waitForStudioPort resolves when probe succeeds', async () => {
  let calls = 0
  const ready = await waitForStudioPort(async () => {
    calls += 1
    return calls >= 2
  }, '127.0.0.1', 1_000)
  assertEquals(ready, true)
  assertEquals(calls >= 2, true)
})

test('waitForStudioPort times out when probe never succeeds', async () => {
  const ready = await waitForStudioPort(async () => false, '127.0.0.1', 250)
  assertEquals(ready, false)
})
