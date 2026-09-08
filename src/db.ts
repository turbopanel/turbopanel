import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Context } from 'hono'
import postgres from 'postgres'
import type { DaemonCellRegistry } from './daemon/cell/contracts.ts'
import type { ServerMetricsStore } from './daemon/metrics/types.ts'
import type { ExecutionLogStore } from './lib/execution-logs/types.ts'
import type { QueryCache } from './query-cache/contracts.ts'
import { getDatabaseUrl, resolvePostgresConnection } from './db-url.ts'
import * as schema from './lib/db/schema.ts'

export type Db = PostgresJsDatabase<typeof schema>

/** Minimal Hyperdrive surface used by `createWorkersDb` (Workers runtime). */
export type HyperdriveBinding = {
  connectionString: string
}

/** Hyperdrive — `max: 1` connection per client (one client is created **per request**, not per isolate — see below). `prepare: true` enables protocol-level prepared statements, which Hyperdrive requires to cache parameterized `SELECT` queries on the `HYPERDRIVE_CACHED` binding. Hyperdrive manages prepared-statement lifecycle across its connection pool, so session-scoped state is not a concern here. */
const PG_OPTS_WORKERS = { prepare: true as const, max: 1 }

/**
 * Default connect/statement bounds for the Workers/Hyperdrive path. A stalled
 * connect or query must never hang indefinitely — an open outbound connection
 * (or an unsettled promise awaiting one) prevents Durable Object hibernation and
 * bills the object for the entire WebSocket lifetime. See the 71-minute
 * billable-duration incident in `src/daemon/cell/do.ts` (Daemon Cell).
 */
const DEFAULT_WORKERS_CONNECT_TIMEOUT_S = 15
const DEFAULT_WORKERS_STATEMENT_TIMEOUT_MS = 30_000

export type WorkersDbOptions = {
  /** Abort the TCP/connect phase after this many seconds (postgres.js `connect_timeout`). */
  connectTimeoutSeconds?: number
  /** Server-side per-statement cap (Postgres `statement_timeout` GUC, milliseconds). */
  statementTimeoutMs?: number
  /** Release idle pooled connections (postgres.js `idle_timeout`, seconds). Omit on long-lived request isolates. */
  idleTimeoutSeconds?: number
}

/** `prepare` is intentionally a separate decision for the Deno/self-hosted path (direct Postgres, no Hyperdrive). */
/**
 * Self-hosted Deno: up to 10 concurrent connections.
 * No idle_timeout — let connections live for the process lifetime so postgres.js
 * never has to recreate them mid-request. systemd restarts the process anyway.
 * backoff: () => 0 — disable exponential reconnect delay; options.shared.retries
 * can accumulate to 6+ on any connection error and the default backoff(6)*1000 ≈
 * 7300ms, causing the entire pool to pause for ~7s waiting to reconnect. With a
 * zero delay, reconnect is immediate after any close event regardless of retry
 * count. (Runtime also accepts a bare `0`, but postgres.js types only allow
 * boolean | (attempt) => number.)
 */
const PG_OPTS_DENO = {
  prepare: false as const,
  max: 10,
  backoff: () => 0,
}

/**
 * Build a Workers/Hyperdrive postgres.js client.
 *
 * ⛔ Call this (via `resolveWorkersDb` / `openWorkersRequestDb`) **once per
 * request/invocation** — never cache the returned client in module/global/
 * isolate scope and reuse it on a later request. On Workers a DB client/socket
 * is an I/O object bound to the request that created it; reusing it across
 * requests throws "Cannot perform I/O on behalf of a different request" and
 * 500s (this caused a production outage). Hyperdrive pools server-side, so
 * per-request creation is free — but **always** `endDbConnection` /
 * `closeWorkersRequestDb` when the invocation finishes so postgres.js pools
 * do not stack to the 128 MB isolate memory limit.
 * See `AGENTS.md` → Workers Hyperdrive (HARD RULE) and
 * https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/
 */
export function createWorkersDb(hyperdrive: HyperdriveBinding, options: WorkersDbOptions = {}): Db {
  const client = postgres(hyperdrive.connectionString, {
    ...PG_OPTS_WORKERS,
    connect_timeout: options.connectTimeoutSeconds ?? DEFAULT_WORKERS_CONNECT_TIMEOUT_S,
    // Only bound idle connections when asked. `resolveWorkersDb` creates a fresh
    // client per request (Workers cannot reuse a DB socket across requests); the
    // Durable Object projection opens a short-lived client and closes per call.
    ...(options.idleTimeoutSeconds !== undefined
      ? { idle_timeout: options.idleTimeoutSeconds }
      : {}),
    connection: {
      statement_timeout: options.statementTimeoutMs ?? DEFAULT_WORKERS_STATEMENT_TIMEOUT_MS,
    },
  })
  return drizzle(client, { schema })
}

const DATABASE_URL_REQUIRED = 'TURBOPANEL_DATABASE_URL is required'

/** Open a postgres.js client from a URL that may be TCP or Unix-socket form. */
function createPostgresJsClient(
  url: string,
  options: typeof PG_OPTS_DENO
): ReturnType<typeof postgres> {
  const connection = resolvePostgresConnection(url)
  if (typeof connection === 'string') {
    return postgres(connection, options)
  }
  return postgres({ ...connection, ...options })
}

export function createDenoDb(): Db {
  const url = getDatabaseUrl()
  if (!url) {
    throw new Error(DATABASE_URL_REQUIRED)
  }
  const client = createPostgresJsClient(url, PG_OPTS_DENO)
  return drizzle(client, { schema })
}

/** Node/drizzle-kit migration repair — requires `TURBOPANEL_DATABASE_URL`. */
export function createToolingDb(): Db {
  return createDenoDb()
}

type PostgresJsClient = ReturnType<typeof postgres>

/** Close a drizzle postgres.js pool (no-op for mock/test clients without `$client`). */
export async function endDbConnection(db: Db): Promise<void> {
  const client = (db as Db & { $client?: PostgresJsClient }).$client
  if (client?.end) {
    await client.end({ timeout: 5 })
  }
}

/** Hard client-side deadline for a single Durable Object projection operation. */
export const DB_OP_TIMEOUT_MS = 8_000

export class DbOperationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`database operation exceeded ${timeoutMs}ms timeout`)
    this.name = 'DbOperationTimeoutError'
  }
}

/**
 * Bound an in-flight DB operation with a hard client-side deadline. Used by the
 * Durable Object presence projection so a stalled Hyperdrive/Postgres connect or
 * query can never hold the object non-hibernatable for the whole WebSocket
 * lifetime (the 71-minute, 547 GB-s billable-duration incident). Driver-level
 * `connect_timeout` / `statement_timeout` are defence-in-depth, but a hung
 * Hyperdrive round-trip can slip past both — this timer is the guarantee.
 *
 * The timer lives here (not in `do.ts`) and is always cleared before returning,
 * so it never outlives the awaited operation and cannot keep a Durable Object
 * awake at idle — the `do.ts` hibernation source-scan (no `setTimeout`) stays
 * satisfied. On timeout the caller must still close the pool so the wedged
 * connection is torn down.
 */
export async function runWithDbTimeout<T>(
  db: Db,
  fn: (db: Db) => Promise<T>,
  timeoutMs: number = DB_OP_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = fn(db)
  // The losing side of the race settles later; swallow it so a post-timeout
  // rejection never surfaces as an unhandled rejection.
  work.catch(() => {})
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DbOperationTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Generic (non-DB) hard timeout race, for background/foreground work in a
 * Durable Object handler that isn't a Postgres/Hyperdrive call (e.g. JWT
 * keyring derivation, outbox pump). Same shape as `runWithDbTimeout` above —
 * the timer is always cleared before returning, and the losing side of the
 * race is swallowed so a post-timeout rejection never surfaces as an
 * unhandled rejection.
 *
 * Lives here (not in `do.ts`) for the same reason `runWithDbTimeout` does:
 * the `do.ts` hibernation source-scan (`ws-handlers.test.ts`) asserts there
 * is no literal `setTimeout`/`setInterval` in that file, because a Durable
 * Object must never hold itself awake with a live timer at idle. A timer
 * that only exists to *bound* an in-flight await (and is always cleared
 * before this function returns) is safe to import from elsewhere — it can
 * never itself keep the object non-hibernatable.
 */
export async function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  work.catch(() => {})
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Run tooling DB work and close the postgres.js pool so short-lived scripts can exit. */
export async function withToolingDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const url = getDatabaseUrl()
  if (!url) {
    throw new Error(DATABASE_URL_REQUIRED)
  }
  const client = createPostgresJsClient(url, PG_OPTS_DENO)
  const db = drizzle(client, { schema })
  try {
    return await fn(db)
  } finally {
    await client.end({ timeout: 5 })
  }
}

export function getDb(c: Context): Db | undefined {
  return c.get('db')
}

export function getDaemonCellRegistry(c: Context): DaemonCellRegistry | undefined {
  return c.get('daemonCellRegistry')
}

export function getQueryCache(c: Context): QueryCache | undefined {
  return c.get('queryCache')
}

/**
 * v5 metrics store for the current request, wired by `createApp` (see
 * `app.ts`) from its `serverMetricsStore` option. On Deno this is the
 * `DuckDbParquetServerMetricsStore` instance; on Workers, the entrypoint
 * passes a real `CloudflareAnalyticsEngineServerMetricsStore` bound to
 * `SERVER_METRICS` (or `DisabledServerMetricsStore` when that binding is
 * unconfigured).
 */
export function getServerMetricsStore(c: Context): ServerMetricsStore | undefined {
  return c.get('serverMetricsStore')
}

/**
 * Command transcript store for the current request. Stateless per call on every
 * driver (R2 / filesystem / S3 hold no connection), so — unlike a DB client —
 * one resolved instance is safe to share across requests.
 */
export function getExecutionLogStore(c: Context): ExecutionLogStore | undefined {
  return c.get('executionLogStore')
}
