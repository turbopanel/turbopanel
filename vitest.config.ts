import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { applyWranglerHyperdriveLocalEnv } from './scripts/resolve-wrangler-hyperdrive-env.mjs'

applyWranglerHyperdriveLocalEnv()

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.vitest.jsonc' },
      main: './src/workers-vitest.ts',
      miniflare: {
        isolatedStorage: false,
        bindings: {
          TURBOPANEL_SECRETS: '1:aa_daemon_cell_vitest_secret_value_aaaa_b_pad_abcdefghij0',
          // Construct-time DO binding — runtime `env.TURBOPANEL_DAEMON_DEBUG = …`
          // in tests does not update the Durable Object's env snapshot.
          TURBOPANEL_DAEMON_DEBUG: '1',
          // Same construct-time pattern for inbound flood-cap tests.
          TURBOPANEL_DAEMON_WS_INBOUND_LIMIT: '120',
          TURBOPANEL_DAEMON_WS_INBOUND_WINDOW_MS: '60000',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@turbopanel/email/smtp-sender': path.resolve(
        rootDir,
        './src/lib/email/smtp/smtp-sender-shim.ts'
      ),
    },
  },
  test: {
    include: [
      'src/daemon/workers-ws.test.ts',
      'src/daemon/cell/do-registry.test.ts',
      'src/daemon/durable-object.test.ts',
      'src/developer/routes-core.test.ts',
      'src/developer/dev-sync-archive.test.ts',
      'src/admin/public-urls.test.ts',
      'src/lib/settings/email-settings.test.ts',
      'src/client/authn/signup-validation.test.ts',
      'src/client/authn/data-encryption.test.ts',
      'src/client/authn/password.test.ts',
      'src/daemon/metrics/validation-v5.test.ts',
      'mailer/rate-limiter.test.ts',
      // Hyperdrive fresh-per-request / close guards (Istanbul covers workers-bindings.ts).
      // Keep out of scripts/test-coverage.sh Deno LCOV — Workers-pool only.
      'src/workers-bindings.test.ts',
      'src/workers.entry.test.ts',
      'src/wrangler-hyperdrive-bindings.test.ts',
      'src/lib/machine-key.workers.test.ts',
      // Execution-log conformance under workerd — exercises workerd's
      // CompressionStream/DecompressionStream, which the Deno run cannot.
      'src/lib/execution-logs/r2-store.workers.test.ts',
    ],
    coverage: {
      // Istanbul instruments source at build time, so — unlike the default
      // `v8` provider — it works inside workerd (no `node:inspector`). This
      // pool bridges the instrumented counters back out to the Node.js
      // process via a loopback request after each test file finishes, so a
      // plain `lcov` reporter here is a real, non-zero report. Left disabled
      // by default (no `enabled: true`) so `pnpm test:do` stays fast; `pnpm
      // test:coverage` (scripts/test-coverage.sh) turns it on with `--coverage`.
      provider: 'istanbul',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage/vitest',
      // Coverage attribution note: this `include` list above is exhaustive,
      // not a glob — a new Workers/DO test file must be added there (and,
      // separately, to scripts/test-coverage.sh for Deno suites) or it will
      // never contribute to this report.
    },
  },
})
