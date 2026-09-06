# Execution logs (command transcripts)

Append-only storage for the stdout/stderr a daemon produces while running a
command, addressed by `commandId`. Contract in `types.ts`; every driver
implements the same `ExecutionLogStore` interface and is exercised by the same
conformance suite (`execution-log-store.conformance.ts`).

## Why keyed objects, not an analytics table

A transcript is only ever read **whole, or resumed from an offset, for one
command id**. Nothing queries across commands, aggregates over transcripts, or
filters by their content — the questions an Iceberg/columnar layout exists to
answer are questions nobody asks of execution logs. A keyed object plus a small
per-command index answers the only real query in one GET, with no table to
maintain, no schema migration, and no scan cost.

This is the opposite of host metrics (`src/daemon/metrics/AGENTS.md`), which
*are* queried across servers and time and therefore *do* live in Analytics
Engine / DuckDB. Do not "unify" the two.

## Layout

Bytes are date-partitioned so retention is a prefix delete. The index is **flat
and date-free** so a read never has to guess (or scan) the partition — the index
carries the partition forward instead.

```
execution-logs/index/<commandId>.json              per-command index (flat)
execution-logs/data/<yyyy>/<mm>/<dd>/<commandId>/<seq>.part   live chunks
execution-logs/data/<yyyy>/<mm>/<dd>/<commandId>.log.gz       sealed transcript
```

Partitions are **UTC** (`executionLogDatePartition`) so they never drift with the
host timezone. Part keys are zero-padded to 9 digits so a lexical listing is
also a sequence-ordered listing.

The index records, per chunk, the byte `offset` and `length` it occupies in the
concatenated transcript. That is what makes `readFrom(fromSeq, maxBytes)` a
slice rather than a re-scan, on both the live and the sealed representation.

## Semantics (identical on every driver)

- `appendChunk` is idempotent on `(commandId, seq)`. A replayed `seq` is a no-op
  returning the current `nextSeq`; a **gap** throws `ExecutionLogGapError`
  carrying the expected seq (the route maps this to `409` with `nextSeq` so the
  daemon resends from the right place).
- Appending after `seal()` throws `ExecutionLogSealedError` → `409`.
- `readFrom` returns `null` when **no transcript exists at all**, distinct from
  an empty read. `null` is the "not started" state; an empty `bytes` with
  `exists: true` is "running, no output yet". Neither is a 404.
- `nextSeq` advances only past chunks returned **in full**, so a resumed read
  never re-emits a partial chunk's tail nor skips its remainder. A chunk larger
  than the caller's budget yields a partial slice with `nextSeq` unchanged, so a
  reader always makes progress.
- Caps live in `types.ts`: `MAX_EXECUTION_LOG_CHUNK_BYTES` (256 KiB per chunk)
  and `MAX_EXECUTION_LOG_TOTAL_BYTES` (8 MiB per transcript). Past the total cap
  an append becomes a no-op that flips `truncated` and writes
  `EXECUTION_LOG_TRUNCATION_MARKER` **once**, as a real part — so a reader sees
  *why* the transcript stops instead of getting a silently short tail. The
  overflow append still advances `nextSeq` so a runaway command finishes
  normally instead of retrying forever.

The shared decision logic (`planExecutionLogAppend`, `applyExecutionLog*`,
`resolveExecutionLogReadWindow` in `index-model.ts`) is pure and driver-free, so
these semantics cannot drift between backends.

## Drivers

| Runtime | Driver | Selected when |
| --- | --- | --- |
| Workers | `R2ExecutionLogStore` | the `EXECUTION_LOGS` R2 binding is present |
| Deno | `FilesystemExecutionLogStore` | default |
| Deno | `S3ExecutionLogStore` | `TURBOPANEL_EXECUTION_LOG_DRIVER=s3` **and** a complete config |
| either | `DisabledExecutionLogStore` | backend config incomplete |

`resolveExecutionLogStore` (`store-selection.ts`) mirrors
`resolveServerMetricsStore` exactly: runtime-branch, `warnOnce`, and a no-op
store rather than a throw so a half-converged deployment still serves commands —
it just does not retain their transcripts. Every method on the disabled store is
safe, so **callers never branch on availability**.

R2 and S3 share `ObjectExecutionLogStore`; each supplies only
`get`/`put`/`delete`/`list`. The filesystem driver keeps a single growing file
per command instead of one object per chunk (appends are cheap on a filesystem,
and the index's offsets already make an arbitrary read positional), files and
directories are `0600`/`0700`, and it lives under the **state** tree
(`resolveExecutionLogDir`, default `/var/lib/turbopanel/execution-logs`) — these
are durable product data, not rotatable process logs.

The S3 driver hand-rolls SigV4 (`s3-sigv4.ts`, WebCrypto only) rather than
adding an AWS SDK, matching the repo's narrow-HTTP-client precedent.
It deletes one key per request
because `DeleteObjects` requires a Content-MD5 neither runtime can produce.

## Lifecycle

1. **Ingest** — `POST /api/daemon/v1/commands/:commandId/log` (daemon JWT).
   Verifies the JWT `sub` owns the command; unknown and foreign command ids both
   return `403` so a daemon cannot probe other servers' ids. Rate-limited on the
   shared `DAEMON_REST_RATE_LIMITER` via the `commands-log` route key.
2. **Read** — `GET /api/client/v1/servers/:id/commands/:commandId/log?from&max`
   (session + `assertCanReadOr403('server', id)`). Decodes to UTF-8 server-side.
3. **Seal** — on the command's terminal transition, `transitionCommand` calls
   `sealExecutionLogOnTerminal`, which compacts the parts into one gzipped
   object. Best effort **by contract**: sealing must never fail an otherwise
   successful (or failed) command transition, matching
   `finalizeCommandDispatch`. An unsealed transcript is still readable and still
   reachable by the sweep.
4. **Retention** — `sweepExpired` rides the **existing** once-a-minute
   maintenance tick (`offline-sweep.ts` on Workers cron, `DAEMON_CELL_MAINTAIN_MS`
   on Deno) alongside `sweepExpiredCommandDispatch`. No new timer, no new
   connection. Default `EXECUTION_LOG_RETENTION_DAYS` = 90, bounded per tick by
   `EXECUTION_LOG_SWEEP_LIMIT` = 200, probing a bounded run of date partitions so
   one tick's list volume stays constant.

Terminal transitions fire from runtimes with no shared Hono context (Workers
queue consumer, Durable Object, cron isolate, Deno AMQP consumer), so the seal
path uses a module-scoped sink (`seal-on-terminal.ts`) registered at isolate/
process init — the same pattern, and for the same reason, as
`setServerStatusEventSink`.

## Postgres holds nothing

There is **no execution-log column or table**. `hasLog` on the batched status
response is resolved store-side via `ExecutionLogStore.exists`, fanned out per
id under the existing 100-id batch cap. Do not add a column to "cache" it.

## Configuration

| Variable | Applies to | Default |
| --- | --- | --- |
| `TURBOPANEL_EXECUTION_LOG_DIR` | Deno filesystem | `<stateDir>/execution-logs` |
| `TURBOPANEL_EXECUTION_LOG_DRIVER` | Deno | `filesystem` (or `s3`) |
| `TURBOPANEL_EXECUTION_LOG_RETENTION_DAYS` | Deno + Workers | `90` |
| `TURBOPANEL_EXECUTION_LOG_S3_ENDPOINT` / `_BUCKET` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | Deno s3 | — (all required) |
| `TURBOPANEL_EXECUTION_LOG_S3_FORCE_PATH_STYLE` | Deno s3 | `1` (path-style) |

Workers reads `TURBOPANEL_EXECUTION_LOG_RETENTION_DAYS` from `vars` in
`wrangler.jsonc` (parsed by `parseExecutionLogRetentionDays`, same as the Deno
path) and uses the `EXECUTION_LOGS` R2 binding declared per-env there. **R2 buckets are not auto-created** — run
`wrangler r2 bucket create <name>` for each env before its first deploy, and
`pnpm cf-typegen` after changing the binding so `worker-configuration.d.ts`
picks it up.

## Testing

`execution-log-store.conformance.ts` is the contract. Every driver runs the
same cases; a new driver is done when it passes them unmodified. The R2 store
runs the suite **twice** — under Deno for coverage, and under workerd
(`r2-store.workers.test.ts`, registered in `vitest.config.ts`) because `seal()`
depends on the runtime's `CompressionStream`/`DecompressionStream`. Deno suites
must be listed in `scripts/test-coverage.sh` or they never reach the LCOV
report. After adding a `*.test.ts`, run `pnpm check:test-inventory` (root
`AGENTS.md` → **Adding tests**).
