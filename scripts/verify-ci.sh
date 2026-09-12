#!/bin/sh
# Mirrors .github/workflows/build.yml job "sonarqube" minus the Sonar scan.
# Postgres suites in test-coverage.sh skip when TURBOPANEL_DATABASE_URL is unset;
# CI always sets it. This script loads the co-located instance URL from the
# running instance process environ (runtime.env does not carry it).
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Wrangler (bundle check + vitest workers pool) writes under $XDG_CONFIG_HOME/.wrangler.
# The guest vagrant home `.config` is not always writable; isolate so we fail on
# bundle/test errors, not mkdir EACCES.
if [ -z "${XDG_CONFIG_HOME:-}" ]; then
  XDG_CONFIG_HOME=$(mktemp -d "${TMPDIR:-/tmp}/tp-wrangler-xdg.XXXXXX")
  export XDG_CONFIG_HOME
  trap 'rm -rf "$XDG_CONFIG_HOME"' EXIT
fi

# Load TURBOPANEL_DATABASE_URL so migrate + postgres Deno suites run, matching
# CI build.yml. Never print the value.
if [ -z "${TURBOPANEL_DATABASE_URL:-}" ] && [ -z "${DATABASE_URL:-}" ]; then
  INSTANCE_ENV=/etc/turbopanel/instance/runtime.env
  if [ -r "$INSTANCE_ENV" ]; then
    TURBOPANEL_DATABASE_URL=$(sed -n 's/^TURBOPANEL_DATABASE_URL=//p' "$INSTANCE_ENV" | tail -n 1)
  fi
  if [ -z "${TURBOPANEL_DATABASE_URL:-}" ] && command -v systemctl >/dev/null 2>&1; then
    _pid=$(systemctl show turbopanel-instance -p MainPID --value 2>/dev/null || true)
    case "$_pid" in
      '' | 0) ;;
      *)
        if [ -r "/proc/${_pid}/environ" ]; then
          TURBOPANEL_DATABASE_URL=$(
            tr '\0' '\n' < "/proc/${_pid}/environ" |
              sed -n 's/^TURBOPANEL_DATABASE_URL=//p' |
              tail -n 1
          )
        fi
        ;;
    esac
  fi
  if [ -n "${TURBOPANEL_DATABASE_URL:-}" ]; then
    export TURBOPANEL_DATABASE_URL
    echo "==> Loaded TURBOPANEL_DATABASE_URL from the instance process (postgres suites enabled)"
  fi
fi

if [ -n "${TURBOPANEL_DATABASE_URL:-}" ] || [ -n "${DATABASE_URL:-}" ]; then
  echo "==> Apply database migrations"
  pnpm migrate
else
  echo "verify-ci: TURBOPANEL_DATABASE_URL unset; skipping migrate (postgres suites skip)" >&2
fi

echo "==> Durable Object hibernation guard"
pnpm run check:do-hibernation

echo "==> Workers bundle check"
pnpm run check:workers-bundle

echo "==> Check vocabulary"
pnpm run check:vocabulary

echo "==> Check test inventory (every suite runs somewhere)"
pnpm run check:test-inventory

echo "==> Check third-party notices"
pnpm run notices:check

echo "==> Check CA boundary"
pnpm run check:ca-boundary

echo "==> Test with coverage (Vitest Istanbul + Deno V8 → coverage/lcov.info)"
pnpm test:coverage
