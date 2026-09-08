/**
 * Run work after the response has been sent.
 *
 * Runtime-aware on purpose: on Workers the only way to outlive the response
 * is `executionCtx.waitUntil`; on Deno a promise simply keeps running. The
 * task's failure is logged and never propagates — there is no caller left to
 * propagate to.
 *
 * **The task must not use `c.get('db')` on Workers.** `src/workers.ts`
 * closes the per-request client in its own `waitUntil`, and a second
 * `waitUntil` that keeps using it races that close and dies with
 * `write CONNECTION_ENDED`. A deferred task opens its own short-lived client
 * and closes it in `finally` — see `src/webhook/billing/stripe.ts`.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { logError } from '../../logger.ts'

export type AfterResponseScheduler = (task: () => Promise<void>) => void

export function runAfterResponse(
  c: Context<AppEnv>,
  logScope: string,
  task: () => Promise<void>,
): void {
  const run = (): Promise<void> =>
    task().catch((err: unknown) => {
      logError(logScope, 'deferred task failed', err)
    })
  if (c.get('runtime') === 'workers') {
    // Hono's getter throws when no ExecutionContext was handed to `fetch`
    // (unit tests drive the app with `app.request`); fall through then.
    try {
      c.executionCtx.waitUntil(run())
      return
    } catch {
      // no execution context — fire and forget below
    }
  }
  void run()
}
