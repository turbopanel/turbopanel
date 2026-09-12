#!/bin/sh
# Run Vitest (workers pool, Istanbul coverage) + Deno suites (V8 coverage),
# then merge into coverage/lcov.info for SonarCloud.
#
# Vitest runs under @cloudflare/vitest-pool-workers, which has no
# `node:inspector` (so the default `v8` coverage provider cannot run inside
# workerd) — but the pool *does* bridge Istanbul's instrumented counters back
# out to the Node.js process (see `test.coverage` in vitest.config.ts), so
# `--coverage` there produces a real, non-zero LCOV report for the
# Durable-Object / Workers-only code that only these suites exercise (daemon
# cell, admin routes, etc). That report is entirely separate from — and
# covers largely different files than — the Deno LCOV below, so both paths
# are merged into coverage/lcov.info for `sonar.javascript.lcov.reportPaths` in
# sonar-project.properties (single repo-relative report — SonarCloud was only
# reflecting Deno hits when two comma-separated paths were used).
#
# Merge rule (smart): per SF, the report with more covered lines (LH) is
# primary. Secondary may only max shared hits or add *executed* lines — never
# zero-hit V8 transitive rows that dilute Workers/DO Istanbul. Previously a
# hard Vitest-wins drop discarded real Deno unit hits for modules Vitest only
# imported (false 0% on db-url, allocate-containers, …).
#
# Usage: sh scripts/test-coverage.sh
# Output: coverage/lcov.info (Vitest + Deno merged for SonarCloud), plus
# coverage/vitest/lcov.info and coverage/deno.lcov for debugging.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Wrangler/vitest-pool-workers writes under $XDG_CONFIG_HOME/.wrangler.
# Guest `/home/vagrant/.config` is root-owned; isolate so coverage fails on
# tests, not mkdir EACCES.
if [ -z "${XDG_CONFIG_HOME:-}" ]; then
  XDG_CONFIG_HOME=$(mktemp -d "${TMPDIR:-/tmp}/tp-wrangler-xdg.XXXXXX")
  export XDG_CONFIG_HOME
  trap 'rm -rf "$XDG_CONFIG_HOME"' EXIT
fi

rm -rf coverage
mkdir -p coverage

echo "==> Vitest (workers pool, Istanbul coverage)"
pnpm exec vitest run --config vitest.config.ts --coverage

if ! grep -q '^SF:' coverage/vitest/lcov.info; then
  echo "Vitest LCOV expected at least one SF: entry" >&2
  exit 1
fi

workspace="${GITHUB_WORKSPACE:-$ROOT}"
workspace="${workspace%/}"

echo "==> Normalize Vitest LCOV SF paths"
export LCOV_FILE=coverage/vitest/lcov.info
export LCOV_WORKSPACE="$workspace"
python3 - <<'PY'
from pathlib import Path
import os

path = Path(os.environ["LCOV_FILE"])
text = path.read_text()
workspace = os.environ["LCOV_WORKSPACE"].rstrip("/")
for prefix in (f"file://{workspace}/", f"{workspace}/"):
    text = text.replace(f"SF:{prefix}", "SF:")
path.write_text(text)
PY

if bad="$(grep -E '^SF:(/|file:)' coverage/vitest/lcov.info || true)" && [ -n "$bad" ]; then
  echo "Vitest LCOV SF paths must be repo-relative after normalization" >&2
  printf '%s\n' "$bad" | head -n 20
  exit 1
fi

echo "==> Assert Workers/DO coverage in Vitest LCOV"
python3 - <<'PY'
import re
import sys
from pathlib import Path

text = Path("coverage/vitest/lcov.info").read_text()
checks = (
    (r"SF:src/daemon/cell/do\.ts\n(?:.*\n)*?LH:(\d+)", 50, "do.ts"),
    (r"SF:src/daemon/cell/do-registry\.ts\n(?:.*\n)*?LH:(\d+)", 80, "do-registry.ts"),
    (r"SF:src/daemon/workers-ws\.ts\n(?:.*\n)*?LH:(\d+)", 10, "workers-ws.ts"),
)
for pattern, minimum, label in checks:
    match = re.search(pattern, text)
    hits = int(match.group(1)) if match else 0
    if hits < minimum:
        print(
            f"Vitest LCOV missing expected {label} coverage (LH:{hits}, need >={minimum})",
            file=sys.stderr,
        )
        sys.exit(1)
PY

echo "==> Deno coverage profile"
# Deno V8 coverage for Sonar LCOV (Vitest/workerd covers Workers/DO-only code).
# Two tiers:
#   - Host-free unit suites (always run; no Postgres/Redis).
#   - Postgres integration suites (need TURBOPANEL_DATABASE_URL; skip gracefully
#     when unset locally — CI build.yml starts Postgres and sets the URL).
# Omit: redis-cell / ws-handlers (Redis),
# Vitest-only Workers suites (workers-ws, durable-object, routes-core, …).
# CI uses -A so every suite shares one profile dir (mirrors the daemon repo's
# test:coverage grant).
deno test -A --coverage=coverage/deno-profile \
  --no-check \
  src/admin/openapi/index.test.ts \
  src/admin/public-urls.deno.test.ts \
  src/admin/public-urls.hostfree.test.ts \
  src/admin/reencrypt-secrets.test.ts \
  src/admin/reencrypt-secrets.hostfree.test.ts \
  src/admin/routes-helpers.hostfree.test.ts \
  src/admin/routes.hostfree.test.ts \
  src/admin/tls-trust-reconcile.hostfree.test.ts \
  src/admin/tier-routes-helpers.hostfree.test.ts \
  src/admin/tier-routes.hostfree.test.ts \
  src/admin/routes.test.ts \
  src/app.test.ts \
  src/client/authn/auth-rate-limit-http.test.ts \
  src/client/authn/auth-rate-limit.test.ts \
  src/client/authn/browser-write-protection.test.ts \
  src/client/authn/credentials-pam.test.ts \
  src/client/authn/credentials.test.ts \
  src/client/authn/crypto.test.ts \
  src/client/authn/data-encryption.deno.test.ts \
  src/client/authn/envelope.deno.test.ts \
  src/client/authn/email-otp.deno.test.ts \
  src/client/authn/email-otp.test.ts \
  src/client/authn/email-verification.test.ts \
  src/client/authn/http-helpers.test.ts \
  src/client/authn/install-state.test.ts \
  src/client/authn/install-validation.deno.test.ts \
  src/client/authn/invitation-grants.test.ts \
  src/client/authn/license.test.ts \
  src/client/authn/middleware.test.ts \
  src/client/authn/otp-reset-password.test.ts \
  src/client/authn/otp-http.hostfree.test.ts \
  src/client/authn/password.deno.test.ts \
  src/client/authn/secrets.deno.test.ts \
  src/client/authn/session-store.test.ts \
  src/client/authn/signup-validation.deno.test.ts \
  src/client/authn/verification-dev-logging.deno.test.ts \
  src/client/authn/workers-onboarding.test.ts \
  src/client/authz/ \
  src/client/bindings/materialize.test.ts \
  src/client/bindings/materialize.hostfree.test.ts \
  src/client/bindings/resolve-endpoint.test.ts \
  src/client/bindings/resolve-endpoint.hostfree.test.ts \
  src/client/bindings/routes-helpers.test.ts \
  src/client/bindings/routes-helpers.hostfree.test.ts \
  src/client/bindings/routes.test.ts \
  src/client/bindings/routes.hostfree.test.ts \
  src/client/bindings/impact.test.ts \
  src/client/display-name-uniqueness.test.ts \
  src/client/docker-run/routes-helpers.hostfree.test.ts \
  src/client/docker-run/routes.hostfree.test.ts \
  src/client/environments/deploy-prepare.test.ts \
  src/client/environments/deploy-layers.test.ts \
  src/client/environments/merge-deploy-principal-runtimes.test.ts \
  src/client/environments/deploy-routes.test.ts \
  src/client/environments/deploy-routes.hostfree.test.ts \
  src/client/environments/deploy-sources.hostfree.test.ts \
  src/client/environments/release-routes.hostfree.test.ts \
  src/client/environments/deployment-history-routes.hostfree.test.ts \
  src/client/environments/php-availability.test.ts \
  src/client/environments/register-compose-volumes.test.ts \
  src/client/environments/register-compose-volumes.hostfree.test.ts \
  src/client/environments/register-compose-mounts.hostfree.test.ts \
  src/client/environments/teardown.hostfree.test.ts \
  src/client/environments/site-releases.hostfree.test.ts \
  src/client/environments/reconcile-services.test.ts \
  src/client/environments/reconcile-services.hostfree.test.ts \
  src/client/environments/reconcile-hostings.hostfree.test.ts \
  src/client/environments/allocate-containers.test.ts \
  src/client/environments/routes.test.ts \
  src/client/environments/tcp-udp-ingress.test.ts \
  src/client/environments/validate-docker-external-networks.test.ts \
  src/client/hierarchy-delete.test.ts \
  src/client/managed/allocate-managed-container.test.ts \
  src/client/managed/apply-prepare-enqueue.test.ts \
  src/client/managed/apply-prepare-preflight.test.ts \
  src/client/managed/apply-prepare-pure.test.ts \
  src/client/managed/apply-prepare-bind.hostfree.test.ts \
  src/client/managed/apply-prepare.test.ts \
  src/client/managed/access-address.hostfree.test.ts \
  src/client/managed/ha-authority.hostfree.test.ts \
  src/client/managed/ha-desired.hostfree.test.ts \
  src/client/managed/ha-event.hostfree.test.ts \
  src/client/managed/ha-recovery.hostfree.test.ts \
  src/client/managed/ha-recovery-pure.test.ts \
  src/client/managed/ingress-desired.test.ts \
  src/client/managed/ingress-desired.hostfree.test.ts \
  src/client/managed/ingress-desired-pure.hostfree.test.ts \
  src/client/managed/ingress-attachments.hostfree.test.ts \
  src/client/managed/last-error.hostfree.test.ts \
  src/client/managed/routes-helpers.hostfree.test.ts \
  src/client/managed/routes.hostfree.test.ts \
  src/client/managed/backups.test.ts \
  src/client/managed/context.test.ts \
  src/client/managed/destroy-fanout.hostfree.test.ts \
  src/client/managed/host-exposure.hostfree.test.ts \
  src/client/managed/logs.test.ts \
  src/client/managed/members.hostfree.test.ts \
  src/client/managed/monitor-credential.hostfree.test.ts \
  src/client/managed/options.test.ts \
  src/client/managed/routes-helpers.test.ts \
  src/client/managed/routes-helpers.promote.test.ts \
  src/client/managed/routes.test.ts \
  src/client/managed/serialize.test.ts \
  src/client/openapi/hostings.test.ts \
  src/client/openapi/index.test.ts \
  src/client/openapi/shared.test.ts \
  src/client/openapi/licenses.test.ts \
  src/client/openapi/metrics.test.ts \
  src/client/openapi/servers.test.ts \
  src/client/openapi/system.test.ts \
  src/client/org-context-parse.test.ts \
  src/client/org-context.test.ts \
  src/client/org-context.hostfree.test.ts \
  src/client/principals/tenancies.test.ts \
  src/client/principals/routes.test.ts \
  src/client/principals/serialize.test.ts \
  src/client/principals/store.test.ts \
  src/client/principals/ssh-keys.hostfree.test.ts \
  src/client/principals/store.hostfree.test.ts \
  src/client/principals/reconcile.hostfree.test.ts \
  src/client/principals/routes-helpers.hostfree.test.ts \
  src/client/projects/catalog/catalog.test.ts \
  src/client/projects/catalog/scaffold.test.ts \
  src/client/projects/empty-setup.test.ts \
  src/client/projects/routes.test.ts \
  src/client/servers/commands-routes.test.ts \
  src/client/servers/commands-routes-helpers.hostfree.test.ts \
  src/client/servers/commands-ping-latency.test.ts \
  src/client/servers/command-dispatch.test.ts \
  src/client/servers/command-dispatch-helpers.hostfree.test.ts \
  src/client/servers/capability-plan-records.test.ts \
  src/client/servers/capability-plan-push.test.ts \
  src/client/servers/colocated.test.ts \
  src/client/servers/delete-guards.test.ts \
  src/client/servers/metrics-routes.test.ts \
  src/client/servers/metrics-routes-helpers.hostfree.test.ts \
  src/client/servers/routes.test.ts \
  src/client/servers/routes.hostfree.test.ts \
  src/client/servers/routes-helpers.hostfree.test.ts \
  src/client/servers/server-topology-records.test.ts \
  src/client/servers/topology-inventory.test.ts \
  src/client/servers/topology-slot-mapping.test.ts \
  src/client/servers/update-status.test.ts \
  src/client/shared.test.ts \
  src/client/shared-authz-guards.test.ts \
  src/client/repositories/inspect.hostfree.test.ts \
  src/client/repositories/read-repository.hostfree.test.ts \
  src/client/repositories/provider-install-state.hostfree.test.ts \
  src/client/forges/routes-helpers.hostfree.test.ts \
  src/client/forges/handlers.hostfree.test.ts \
  src/client/forges/routes.hostfree.test.ts \
  src/client/repositories/routes-helpers.hostfree.test.ts \
  src/client/repositories/routes.hostfree.test.ts \
  src/client/repositories/webhook-trigger.hostfree.test.ts \
  src/webhook/gate.hostfree.test.ts \
  src/webhook/git/github.hostfree.test.ts \
  src/webhook/git/gitlab.hostfree.test.ts \
  src/webhook/billing/stripe.hostfree.test.ts \
  src/webhook/billing/stripe-projection.hostfree.test.ts \
  src/client/billing/mutations.hostfree.test.ts \
  src/lib/billing/pending-checkout.hostfree.test.ts \
  src/lib/billing/seat-increase.hostfree.test.ts \
  src/client/storage/serialize.test.ts \
  src/client/storage/routes-helpers.test.ts \
  src/client/storage/routes.test.ts \
  src/client/storage/routes.hostfree.test.ts \
  src/client/storage/routes-helpers.hostfree.test.ts \
  src/client/system/hierarchy.test.ts \
  src/client/system/hierarchy.hostfree.test.ts \
  src/client/system/operate.test.ts \
  src/client/system/operate.hostfree.test.ts \
  src/client/system/reconcile.test.ts \
  src/client/system/reconcile.hostfree.test.ts \
  src/client/system/routes.test.ts \
  src/client/system/routes-helpers.hostfree.test.ts \
  src/client/teams/routes-helpers.hostfree.test.ts \
  src/client/teams/routes.test.ts \
  src/client/tags/routes-helpers.hostfree.test.ts \
  src/client/tags/routes.hostfree.test.ts \
  src/client/tasks/routes-helpers.hostfree.test.ts \
  src/client/tasks/routes.hostfree.test.ts \
  src/client/variables/resolve-inherited.test.ts \
  src/client/variables/resolve-inherited.hostfree.test.ts \
  src/client/variables/routes-helpers.test.ts \
  src/client/variables/routes-helpers.hostfree.test.ts \
  src/cors.test.ts \
  src/daemon/authn/challenge.test.ts \
  src/daemon/authn/daemon-jwt.test.ts \
  src/daemon/authn/daemon-jwt-keyring.test.ts \
  src/daemon/authn/daemon-state.test.ts \
  src/daemon/authn/license.hostfree.test.ts \
  src/daemon/authn/server-identity-db.hostfree.test.ts \
  src/daemon/authn/server-key.test.ts \
  src/daemon/api-routes.test.ts \
  src/daemon/api-routes.hostfree.test.ts \
  src/daemon/rehydrate-secrets.hostfree.test.ts \
  src/daemon/execution-log-ingest.hostfree.test.ts \
  src/daemon/execution-log-ingest-route.hostfree.test.ts \
  src/lib/peer-address.hostfree.test.ts \
  src/lib/http/bounded-body.test.ts \
  src/daemon/cell/contracts.test.ts \
  src/daemon/cell/do-storage-classify.test.ts \
  src/daemon/deno-ws.test.ts \
  src/daemon/cell/control-plane-monitor.test.ts \
  src/daemon/cell/fleet-diagnostics.test.ts \
  src/daemon/cell/fleet-presence.test.ts \
  src/daemon/cell/location.test.ts \
  src/daemon/cell/snapshot-merge.test.ts \
  src/daemon/cell/offline-sweep.test.ts \
  src/daemon/cell/deno-maintenance.test.ts \
  src/daemon/cell/postgres-projection.test.ts \
  src/daemon/cell/inbound-outcome.hostfree.test.ts \
  src/daemon/cell/protocol.test.ts \
  src/daemon/cell/redis/cell.test.ts \
  src/daemon/cell/redis/client.hostfree.test.ts \
  src/daemon/cell/redis/keys.test.ts \
  src/daemon/cell/redis/lua.test.ts \
  src/daemon/cell/redis/registry.test.ts \
  src/daemon/cell/socket-health.test.ts \
  src/daemon/cell/server-diagnostics.test.ts \
  src/daemon/cell/stateless-challenge.test.ts \
  src/daemon/metrics/backends/cloudflare/cross-backend-parity.test.ts \
  src/daemon/metrics/backends/cloudflare/field-map.test.ts \
  src/daemon/metrics/backends/cloudflare/representative-row-counts.test.ts \
  src/daemon/metrics/backends/cloudflare/sql-api.test.ts \
  src/daemon/metrics/backends/cloudflare/store.test.ts \
  src/daemon/metrics/backends/duckdb/database.test.ts \
  src/daemon/metrics/backends/duckdb/no-sentinel.test.ts \
  src/daemon/metrics/backends/duckdb/parquet.test.ts \
  src/daemon/metrics/backends/duckdb/schema.test.ts \
  src/daemon/metrics/backends/duckdb/store.test.ts \
  src/daemon/metrics/active-store.test.ts \
  src/daemon/metrics/capability-plan.test.ts \
  src/daemon/metrics/contract.test.ts \
  src/daemon/metrics/counter-reset-end-to-end.test.ts \
  src/daemon/metrics/disabled-store.test.ts \
  src/daemon/metrics/entity-metric-id.test.ts \
  src/daemon/metrics/metric-descriptors.test.ts \
  src/daemon/metrics/orphan-row-semantics.test.ts \
  src/daemon/metrics/status-events.test.ts \
  src/daemon/metrics/topology-generation-guard.test.ts \
  src/daemon/metrics/query/cache.test.ts \
  src/daemon/metrics/query/derived-metrics.test.ts \
  src/daemon/metrics/query/live-session.test.ts \
  src/daemon/metrics/query/resolution.test.ts \
  src/daemon/metrics/query/series-response.test.ts \
  src/daemon/metrics/query/uptime.test.ts \
  src/daemon/metrics/store-selection.test.ts \
  src/daemon/metrics/validation.deno.test.ts \
  src/daemon/openapi/ca.test.ts \
  src/daemon/openapi/index.test.ts \
  src/daemon/openapi/metrics.test.ts \
  src/daemon/openapi/readiness.test.ts \
  src/daemon/openapi/version.test.ts \
  src/daemon/version.hostfree.test.ts \
  src/daemon/rate-limit/contracts.test.ts \
  src/daemon/rate-limit/inbound-window.test.ts \
  src/daemon/rate-limit/keys.test.ts \
  src/daemon/rate-limit/redis-rate-limiter.test.ts \
  src/daemon/rate-limit/workers-rate-limiter.hostfree.test.ts \
  src/db-timeout.test.ts \
  src/db-url.test.ts \
  src/db.test.ts \
  src/db.hostfree.test.ts \
  src/deno-compile-permissions.test.ts \
  src/deno-production-entry.test.ts \
  src/dev-mode.deno.test.ts \
  src/developer/database-routes-helpers.hostfree.test.ts \
  src/developer/database-routes.test.ts \
  src/developer/database-routes-shared.test.ts \
  src/developer/database-studio-routes.hostfree.test.ts \
  src/developer/drizzle-studio.test.ts \
  src/developer/drizzle-studio-spawn.test.ts \
  src/developer/dev-sync-archive.deno.test.ts \
  src/developer/dev-sync.hostfree.test.ts \
  src/developer/drizzle-studio-bind.test.ts \
  src/developer/drizzle-studio-helpers.hostfree.test.ts \
  src/developer/local-console-auth.test.ts \
  src/developer/metrics-duckdb-ui-routes.hostfree.test.ts \
  src/developer/routes-core-helpers.hostfree.test.ts \
  src/developer/routes.hostfree.test.ts \
  src/developer/system-routes.hostfree.test.ts \
  src/developer/system-routes.test.ts \
  src/developer/tunnel-routes.hostfree.test.ts \
  src/developer/update-routes.hostfree.test.ts \
  src/developer/dev-update-overlay.hostfree.test.ts \
  src/drizzle-kit-config.test.ts \
  src/drizzle-studio-probe.test.ts \
  src/lib/amqp-default-url.test.ts \
  src/lib/commands/command-amqp-topology.test.ts \
  src/lib/commands/context.test.ts \
  src/lib/commands/consumer.test.ts \
  src/lib/commands/consumer.hostfree.test.ts \
  src/lib/commands/deno-amqp-queue.test.ts \
  src/lib/commands/deno-consumer.hostfree.test.ts \
  src/lib/commands/deploy-validation.test.ts \
  src/lib/commands/envelope.test.ts \
  src/lib/commands/hostname.test.ts \
  src/lib/commands/ids.test.ts \
  src/lib/commands/noop-command-queue.test.ts \
  src/lib/commands/queue.test.ts \
  src/lib/commands/schemas.test.ts \
  src/lib/commands/schemas-parsers.hostfree.test.ts \
  src/lib/commands/stale-sweep.hostfree.test.ts \
  src/lib/commands/types.test.ts \
  src/lib/commands/workers-queue.test.ts \
  src/lib/compose/ \
  src/lib/schedule/ \
  src/lib/fabric/ \
  src/lib/datacenter-metadata.test.ts \
  src/lib/datacenter-name-suggestions.test.ts \
  src/lib/datacenter-options.test.ts \
  src/lib/cron.test.ts \
  src/lib/daemon-install-command.deno.test.ts \
  src/lib/install-tls.deno.test.ts \
  src/lib/execution-logs/disabled-store.test.ts \
  src/lib/execution-logs/index-model.test.ts \
  src/lib/execution-logs/store-selection.test.ts \
  src/lib/execution-logs/types.test.ts \
  src/lib/execution-logs/seal-on-terminal.test.ts \
  src/lib/execution-logs/s3-sigv4.test.ts \
  src/lib/execution-logs/s3-store.deno.test.ts \
  src/lib/execution-logs/object-store.hostfree.test.ts \
  src/lib/execution-logs/r2-store.deno.test.ts \
  src/lib/execution-logs/filesystem-store.deno.test.ts \
  src/lib/db/command-records.test.ts \
  src/lib/db/command-records.hostfree.test.ts \
  src/lib/db/container-records.test.ts \
  src/lib/db/container-records.hostfree.test.ts \
  src/lib/db/deployment-records.hostfree.test.ts \
  src/lib/db/deployment-history.hostfree.test.ts \
  src/lib/db/environment-generation.hostfree.test.ts \
  src/lib/db/fabric-records.hostfree.test.ts \
  src/lib/db/fabric-records-lifecycle.hostfree.test.ts \
  src/lib/db/fabric-records-managed.hostfree.test.ts \
  src/lib/db/fabric-records-reconcile.hostfree.test.ts \
  src/lib/db/label-records.hostfree.test.ts \
  src/lib/db/net-types.test.ts \
  src/lib/db/project-delete.test.ts \
  src/lib/db/project-delete.hostfree.test.ts \
  src/lib/db/recovery-records.hostfree.test.ts \
  src/lib/db/releases.hostfree.test.ts \
  src/lib/db/server-metadata.test.ts \
  src/lib/db/repository-records.hostfree.test.ts \
  src/lib/db/storage-records.hostfree.test.ts \
  src/lib/db/tag-records.hostfree.test.ts \
  src/lib/db/task-records.hostfree.test.ts \
  src/lib/db/webhook-delivery-records.hostfree.test.ts \
  src/lib/db/billing-records.hostfree.test.ts \
  src/lib/db/billing-records.test.ts \
  src/lib/db/tier-records.hostfree.test.ts \
  src/lib/db/table-naming.test.ts \
  src/lib/db/boolean-column-naming.test.ts \
  src/lib/db/primary-key.test.ts \
  src/lib/db/tls-leaf-indexes.test.ts \
  src/lib/db/slot-records.hostfree.test.ts \
  src/lib/db/workspace-kind.test.ts \
  src/lib/db/principal-alias-records.test.ts \
  src/lib/docker-address-pools.test.ts \
  src/lib/docker-network-name.test.ts \
  src/lib/docker-run/import.test.ts \
  src/lib/docker-run/lexer.test.ts \
  src/lib/docker-run/option-registry.test.ts \
  src/lib/docker-run/parse.test.ts \
  src/lib/docker-run/to-compose.test.ts \
  src/lib/email/mailgun/deno-mailgun-queue.test.ts \
  src/lib/email/mailgun/send.test.ts \
  src/lib/email/mailgun/workers-queue.test.ts \
  src/lib/email/mailpit/send.test.ts \
  src/lib/email/noop-queue.test.ts \
  src/lib/email/smtp/amqp-topology.test.ts \
  src/lib/email/smtp/deno-amqp-queue.test.ts \
  src/lib/email/smtp/smtp-resolve.test.ts \
  src/lib/email/smtp/workers-shims.test.ts \
  src/lib/email/templates.test.ts \
  src/lib/email/validate-address.test.ts \
  mailer/db.test.ts \
  mailer/mailgun-sender.test.ts \
  mailer/mailpit-sender.test.ts \
  mailer/smtp-sender.test.ts \
  src/lib/geo/server-geo.test.ts \
  src/lib/geo/self-hosted-geo-provider.test.ts \
  src/lib/git/ \
  src/lib/billing/ \
  src/lib/hardware/cpu-catalog.test.ts \
  src/lib/hosting-compose-owner.test.ts \
  src/lib/hosting-options.test.ts \
  src/lib/hosting-web-env.test.ts \
  src/lib/install/parse-body.test.ts \
  src/lib/install/routes.hostfree.test.ts \
  src/lib/ip-address.test.ts \
  src/lib/machine-key.test.ts \
  src/lib/managed/ \
  src/lib/net/cidr-collisions.hostfree.test.ts \
  src/lib/net/datacenter-membership.hostfree.test.ts \
  src/lib/net/datacenter-networks.pure.test.ts \
  src/lib/net/private-endpoint.pure.test.ts \
  src/lib/net/repin.hostfree.test.ts \
  src/lib/net/repin-apply.hostfree.test.ts \
  src/lib/naming.test.ts \
  src/lib/notices.test.ts \
  src/build-info.test.ts \
  scripts/generate-notices.test.ts \
  src/lib/display-name-format.test.ts \
  src/lib/organization-options.test.ts \
  src/lib/host-defaults.test.ts \
  src/lib/optional-fields.test.ts \
  src/lib/php-settings.test.ts \
  src/lib/principal-access.test.ts \
  src/lib/principal-options.test.ts \
  src/lib/sha512-crypt.test.ts \
  src/lib/project-compose-source.test.ts \
  src/lib/project-options.test.ts \
  src/lib/resolve-public-base-url.test.ts \
  src/lib/resource-limits.test.ts \
  src/lib/runtime-registry.test.ts \
  src/lib/server-capacity.test.ts \
  src/lib/service-options-instances.test.ts \
  src/lib/ssh-public-key.test.ts \
  src/lib/settings/email-settings.deno.test.ts \
  src/lib/settings/resolver.deno.test.ts \
  src/lib/settings/resolver.hostfree.test.ts \
  src/lib/settings/server-metrics-settings.hostfree.test.ts \
  src/lib/timezones.test.ts \
  src/lib/tls/ \
  src/lib/tiers/ \
  src/lib/update/manifest.test.ts \
  src/lib/update/constants.test.ts \
  src/lib/update/prepare.test.ts \
  src/log-compat.test.ts \
  src/node-path.test.ts \
  src/query-cache/cached-query.test.ts \
  src/query-cache/keys.test.ts \
  src/query-cache/passthrough-query-cache.test.ts \
  src/query-cache/read-models/server-detail.test.ts \
  src/query-cache/read-models/servers-list.test.ts \
  src/query-cache/redis-query-cache.test.ts \
  src/query-cache/hyperdrive-query-cache.test.ts \
  src/runtime-paths.test.ts \
  src/scalar-html.test.ts \
  src/server-paths.deno.test.ts \
  src/server-addresses-deno.hostfree.test.ts \
  src/server-registry-metadata.test.ts \
  src/server-registry.test.ts \
  src/server-registry.hostfree.test.ts \
  src/surfaces.test.ts \
  src/client/access/routes.test.ts \
  src/client/access/routes-helpers.test.ts \
  src/client/access/routes-helpers.hostfree.test.ts \
  src/client/access/routes.hostfree.test.ts \
  src/client/containers/routes.test.ts \
  src/client/containers/routes-helpers.hostfree.test.ts \
  src/client/containers/routes.hostfree.test.ts \
  src/client/containers/logs.test.ts \
  src/client/datacenters/routes.test.ts \
  src/client/datacenters/routes-pure.test.ts \
  src/client/datacenters/routes.hostfree.test.ts \
  src/client/datacenters/repin-fanout.hostfree.test.ts \
  src/client/environments/routes-helpers.hostfree.test.ts \
  src/client/environments/routes.hostfree.test.ts \
  src/client/environments/deploy-routes-helpers.hostfree.test.ts \
  src/client/environments/deploy-routes-authz.hostfree.test.ts \
  src/client/environments/deploy-routes.hostfree.test.ts \
  src/client/environments/release-routes.hostfree.test.ts \
  src/client/environments/deployment-history-routes.hostfree.test.ts \
  src/client/hostings/routes.test.ts \
  src/client/hostings/routes-helpers.hostfree.test.ts \
  src/client/hostings/routes.hostfree.test.ts \
  src/client/ips/routes.test.ts \
  src/client/ips/routes-pure.test.ts \
  src/client/ips/routes.hostfree.test.ts \
  src/client/billing/routes.hostfree.test.ts \
  src/client/licenses/routes.hostfree.test.ts \
  src/client/licenses/routes.test.ts \
  src/client/licenses/routes-helpers.test.ts \
  src/client/licenses/routes-helpers.hostfree.test.ts \
  src/client/networks/routes.test.ts \
  src/client/networks/routes-pure.test.ts \
  src/client/networks/routes.hostfree.test.ts \
  src/client/organizations/routes.test.ts \
  src/client/organizations/routes.hostfree.test.ts \
  src/client/organizations/routes-helpers.hostfree.test.ts \
  src/client/organizations/fabric-routes.hostfree.test.ts \
  src/client/organizations/fabric-routes-authz.hostfree.test.ts \
  src/client/projects/routes-helpers.hostfree.test.ts \
  src/client/projects/routes.hostfree.test.ts \
  src/client/services/routes.test.ts \
  src/client/services/routes-helpers.hostfree.test.ts \
  src/client/services/routes.hostfree.test.ts \
  src/client/tls/routes.test.ts \
  src/client/tls/routes.hostfree.test.ts \
  src/client/tls/routes-helpers.test.ts \
  src/client/tls/routes-helpers.hostfree.test.ts \
  src/client/tls/organization-ca.hostfree.test.ts \
  src/client/tls/changeover-fanout.hostfree.test.ts \
  src/client/tls/changeover-lease.hostfree.test.ts \
  src/client/tls/leaf-tracking.hostfree.test.ts \
  src/client/tls/leaf-renewal-sweep.hostfree.test.ts \
  src/client/variables/routes.test.ts \
  src/client/workspaces/routes.test.ts \
  src/client/workspaces/routes-helpers.hostfree.test.ts

echo "==> Deno LCOV"
deno coverage coverage/deno-profile --lcov --output=coverage/deno.lcov

# Deno on Linux CI often emits absolute SF: paths; Sonar needs repo-relative.
# Co-located suites can dynamically import a sibling checkout (e.g.
# ../turbopaneld/src/metrics/contract.ts); Deno coverage then emits that file as
# an absolute SF: outside this repo. Drop those records — they are not this
# project's sources, and leaving them would make SonarCloud drop the report.
echo "==> Normalize Deno LCOV SF paths"
export LCOV_FILE=coverage/deno.lcov
export LCOV_WORKSPACE="$workspace"
python3 - <<'PY'
from pathlib import Path
import os

path = Path(os.environ["LCOV_FILE"])
text = path.read_text()
workspace = os.environ["LCOV_WORKSPACE"].rstrip("/")
for prefix in (f"file://{workspace}/", f"{workspace}/"):
    text = text.replace(f"SF:{prefix}", "SF:")

parts = text.split("end_of_record")
kept = []
dropped = 0
for part in parts:
    sf = next((line[3:] for line in part.split("\n") if line.startswith("SF:")), None)
    if sf is not None and (sf.startswith("/") or sf.startswith("file:")):
        dropped += 1
        continue
    kept.append(part)
text = "end_of_record".join(kept)
if dropped:
    print(f"Dropped {dropped} out-of-repo SF record(s) from {path}")
path.write_text(text)
PY

if ! grep -q '^SF:src/' coverage/deno.lcov; then
  echo "Deno LCOV expected at least one SF:src/ entry" >&2
  exit 1
fi

if bad="$(grep -E '^SF:(/|file:)' coverage/deno.lcov || true)" && [ -n "$bad" ]; then
  echo "Deno LCOV SF paths must be repo-relative after normalization" >&2
  printf '%s\n' "$bad" | head -n 20
  exit 1
fi

# Merge lives in scripts/merge-lcov.py (not an embedded heredoc) so concurrent
# edits to this file's Deno test list cannot tear the merge Python mid-run.
echo "==> Merge Vitest + Deno LCOV for SonarCloud"
python3 scripts/merge-lcov.py \
  --vitest coverage/vitest/lcov.info \
  --deno coverage/deno.lcov \
  --out coverage/lcov.info

if ! grep -q '^SF:src/daemon/cell/do.ts' coverage/lcov.info; then
  echo "Merged LCOV expected SF:src/daemon/cell/do.ts" >&2
  exit 1
fi

# Smart merge: Workers/DO floors must still clear after Deno hits are folded in
# (guards against reintroducing zero-hit dilution for files Istanbul measured).
echo "==> Assert Workers/DO coverage in merged LCOV"
python3 - <<'PY'
import re
import sys
from pathlib import Path

text = Path("coverage/lcov.info").read_text()
checks = (
    (r"SF:src/daemon/cell/do\.ts\n(?:.*\n)*?LH:(\d+)", 50, "do.ts"),
    (r"SF:src/daemon/cell/do-registry\.ts\n(?:.*\n)*?LH:(\d+)", 80, "do-registry.ts"),
    (r"SF:src/daemon/workers-ws\.ts\n(?:.*\n)*?LH:(\d+)", 10, "workers-ws.ts"),
)
for pattern, minimum, label in checks:
    match = re.search(pattern, text)
    hits = int(match.group(1)) if match else 0
    if hits < minimum:
        print(
            f"Merged LCOV missing expected {label} coverage (LH:{hits}, need >={minimum})",
            file=sys.stderr,
        )
        sys.exit(1)
PY

if bad="$(grep -E '^SF:(/|file:)' coverage/lcov.info || true)" && [ -n "$bad" ]; then
  echo "Merged LCOV SF paths must be repo-relative" >&2
  printf '%s\n' "$bad" | head -n 20
  exit 1
fi

echo "Coverage LCOV ready: coverage/lcov.info (+ coverage/vitest/lcov.info, coverage/deno.lcov)"
