# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and
**Deno**.

## Project metadata / public naming

| Public name              | GitHub                                                            | Internal term (this repo)              |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------- |
| TurboPanel Control Plane | [TurboPanel/turbopanel](https://github.com/TurboPanel/turbopanel) | `instance` (runtime/architecture only) |

- **License:** AGPL-3.0-only ([`LICENSE`](./LICENSE), `package.json` /
  `deno.json`). Trademarks are not granted by the software license
  ([`TRADEMARKS.md`](./TRADEMARKS.md)). Third-party components keep their own
  licenses ([`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md));
  `pnpm notices:generate` / `notices:check` enumerate the pnpm graph **and**
  the Deno `jsr` + `npm` graphs in `deno.lock` (Deno-only npm entries are
  merged in; peer-suffixed lock ids are parsed as `name@version`).
  `GET /api/health` reports `{ license, revision: { commit, sourceUrl } }` so a
  network user can identify Corresponding Source for the **exact** revision
  (not `trunk`). `createApp()` injects `platformEnv` / `getPlatformEnv`
  **before** the health route; the Deno entry point passes
  `getPlatformEnv: () => Deno.env.toObject()` so systemd
  `TURBOPANEL_REVISION` is never observed as `unknown`. Published story: `../website` `/open-source` and
  `docs/getting-started/licensing.mdx`. Contributions require the
  [CLA](https://github.com/TurboPanel/.github/blob/trunk/CLA.md).
- **Maturity label:** **Private alpha** (README, roadmap, site banner — keep
  identical).
- **README** is product-facing; **AGENTS.md** is maintainer-facing. Do not use
  `turbopanel/instance` as a public repo slug.

## Speed doctrine (turbo)

TurboPanel is named for speed; keep it fast on every path.

- **Cache runtimes & deps.** Deno/Node/Caddy live under
  `/opt/turbopanel/vendor/<tool>/current`; install only when the pinned version
  is missing. Don't re-download or re-`pnpm install` when nothing changed. Caddy
  follows the same `vendor/caddy/<version>/caddy` + `current` layout (no
  `versions/` subdir); `scripts/download-caddy.mjs` and the `caddy` Ansible role
  are aligned.
- **Idempotent fast-paths.** Bootstrap/install steps must short-circuit when
  already satisfied (the Ansible roles do; mirror that in scripts).
- **Avoid redundant work.** No polling loops or periodic git/`systemctl` forks
  unless essential (the version watcher and auto-update poll were removed for
  this reason).
- **Parallelize** independent I/O (e.g. `Promise.all` for per-daemon fan-out, as
  in the admin routes).
- **Push, don't poll** for cross-process signals where practical (WS messages
  over fallback timers).

## Platform model: Ansible owns installs

The **daemon is the constant** installed on every TurboPanel-managed host and is
the only party that runs Ansible to install/update everything else (runtimes,
users, the instance, UI, Caddy). The instance does not install itself. In
co-located dev the daemon runs the `instance-dev-install` playbook (see
`../turbopaneld/AGENTS.md`) when `TURBOPANEL_DEV_INSTANCE=1`. Nothing auto-updates —
updates are operator-driven (admin **Upgrade System** button or **Sync Dev
Build**).

## Users, group & socket permissions

**Development (co-located):** a **single dev user** runs everything — no `tp`,
`tpctrl`, or `tpcache` service accounts are created. Source repos live under
`$HOME` (`~/turbopaneld`, `~/turbopanel`, `~/ui`, `~/website`) and are owned by the dev
user. Mutable data (`/etc/turbopanel`, `/var/lib/turbopanel`,
`/var/log/turbopanel`, `/run/turbopanel`) is dev-user-owned. Per-service runtime
state may still live in gitignored checkout dirs (`instance/.local`,
`ui/.local`, `ui/.expo`, `.config` trees). `/run/turbopanel` is owned by the dev
user; the instance hardens its socket to **`0660`** owned by the dev user so the
co-located daemon can connect.

**Production:** dedicated service users — `tp` (daemon + Ansible), `tpctrl`
(instance, UI, website, mailer, dbstudio), `tpcache` (Redis), `tpdata`
(Postgres), `tpqueue` (RabbitMQ), `tpcaddy`
(control-plane Caddy). See `../turbopaneld/AGENTS.md` (Filesystem layout), the
allocation table below, and the systemd table for ownership, ACLs, and
`/run/turbopanel` **`2770 tp:tp`** (setgid).

### Production UID/GID allocation

| User / group | UID/GID | Runs                                                           |
| ------------ | ------- | -------------------------------------------------------------- |
| `tp`         | 9999    | daemon (`turbopaneld`) + Ansible + shared group everyone joins |
| `tpctrl`     | 9998    | instance, UI, website, mailer, dbstudio                        |
| `tpcache`    | 9997    | Redis (+ `redis.sock` access group)                            |
| `tpdata`     | 9996    | Postgres                                                       |
| `tpqueue`    | 9995    | RabbitMQ                                                       |
| `tpcaddy`    | 9993    | control-plane Caddy                                            |
| `tpnginx`    | 9992    | nginx (optional, `web-service-user`)                           |
| `tpapache`   | 9991    | Apache (optional)                                              |
| `tpols`      | 9990    | OpenLiteSpeed (optional)                                       |
| `tplsws`     | 9989    | LiteSpeed Enterprise (reserved)                                |
| `tpnodeapp`  | 9988    | group only — read+traverse on the vendored tenant Node tree    |

`tpnodeapp` is a **group with no user**: tenant principals join it when their
first native (`serviceKind: node`) app deploys, and it means only "may execute
`/opt/turbopanel/vendor/node-app/<series>/current/bin/node`". Principals are
deliberately never added to `tp`, and `/opt/turbopanel` + `vendor/` stay
`tp:tp 0750` — the group reaches the tree through a traverse-only POSIX ACL on
those two directories (`node-app-runtime` role), never through world bits.

**Application logins are unchanged** — `postgres_user`/`postgres_db` =
`turbopanel`, RabbitMQ user = `turbopanel`, Docker
network/volumes = `turbopanel*`.

## Documentation discipline

**Keep this file current.** When you learn something durable about how
TurboPanel works — architecture, env vars, gotchas, cross-repo contracts,
operational steps — add or update a note here in the same PR/session as the code
change. Future agents read `AGENTS.md` first.

- Prefer extending an existing section over appending orphan bullets.
- Record **why** when the reason is non-obvious (e.g. a missing Debian package
  that breaks Ansible).
- If a fact belongs in another repo (`daemon`, `ui`), put the canonical detail
  there and add a short cross-reference here when the instance is involved.
- Do not record secrets, tokens, or machine-specific credentials.
- Remove or correct notes that prove wrong.

### SonarQube (CI-based analysis)

CI analysis config, the Vitest+Deno LCOV coverage merge, analysis-scope /
exclusion rules, and the coverage-attribution traps moved to
[`scripts/AGENTS.md`](./scripts/AGENTS.md). Read it before touching
`scripts/test-coverage.sh`, `sonar-project.properties`, the SonarQube CI job,
or when SonarCloud shows suspicious 0% coverage. Style rules Sonar enforces on
everyday code stay below (**TypeScript style**).

### Type-checking

- `deno task check:types` type-checks the Deno surface **including the test
  files**. The `deno task test:*` tasks all run `--no-check`, so without it
  nothing catches type drift in tests. It runs first in `pnpm test:hook`.
- Two kinds of test file are excluded from it, both owned by the Workers
  toolchain (`pnpm test:do`): anything importing `vitest` / `cloudflare:test`,
  and anything tagged **`@needs-workers-globals`** in its header — a file that
  reaches a module typed against Workers ambient globals (`CloudflareBindings`,
  `DurableObjectStub`, …).
- **Do not try to give Deno those globals.** `@cloudflare/workers-types`
  redeclares `Request` / `Response` / `fetch` and collides with `lib.deno.ns`;
  hand-declaring the names instead collides with the real workers-types in the
  editor, because `DurableObjectStub` is a **type alias** there and
  `DurableObjectNamespace` is a **class** — neither merges with a local
  interface, and augmenting `Response.webSocket` trips "identical modifiers".
- The supported way to keep a shared module inside the Deno check is the
  narrowing pattern: a local structural type (`HyperdriveBinding`,
  `R2BucketLike`, `CommandQueueBinding`) instead of the Workers global. Prefer
  that over widening the exclusion list.

### Deno lint

- `require-await` is excluded in `deno.json`. Async-without-await is
  load-bearing across this codebase: interface implementations
  (`fake-redis-cell-client.ts`, the noop email/command queues, rate-limit
  contracts, query caches) and object-literal test doubles must return a
  Promise to satisfy their contract, so dropping `async` breaks callers at
  runtime rather than tidying them. Do not re-enable it.
- Import `@std/*` by the **bare specifier** mapped in `deno.json` imports
  (`from '@std/assert'`), never an inline `jsr:` / `npm:` URL — inline
  specifiers trip `no-import-prefix` and `no-unversioned-import`.

### TypeScript style (SonarQube)

- Prefer **`String#replaceAll()`** over **`String#replace()` with a global
  regex** when replacing every occurrence of a substring (`typescript:S7781`).
- Use **`String.raw`** for string literals that contain backslashes so escapes
  stay readable and correct (`typescript:S7780`).
- Prefer **optional chaining** (`obj?.prop`) over `!obj || obj.prop`
  (`typescript:S6582`).
- Use **`new TypeError()`** for type/shape assertions in tests
  (`typescript:S7786`).
- Avoid **nested ternaries** — use `if`/`switch` or helpers
  (`typescript:S3358`).
- Extract helpers when **cognitive complexity** exceeds 15 (`typescript:S3776`).
- Sort strings with **`.sort((a, b) => a.localeCompare(b))`**
  (`typescript:S2871`).
- Mark React component props **`Readonly<{…}>`** (`typescript:S6759`).
- Omit optional parameters instead of passing redundant **`undefined`**
  (`typescript:S4623`).
- Prefer **`String#codePointAt()`** over **`charCodeAt()`** when decoding byte
  strings (`typescript:S7758`).
- Use **`RegExp.exec()`** instead of `String.match()` for single-match
  extraction (`typescript:S6594`).
- Do not leave **`TODO`** in code — use `Future:` in a normal comment
  (`typescript:S1135`).
- Use **RFC 5737 TEST-NET** addresses (e.g. `203.0.113.x`) in tests, not
  arbitrary public IPs (`typescript:S1313`).
- Add **`// NOSONAR rule-key — reason`** when a semantic type alias or path
  check is intentional (`typescript:S6564`, `typescript:S5443`).
- Deno tests: Sonar `typescript:S2187` only recognizes `test()` / `it()` /
  `describe()`, not `Deno.test`. **Every `*.test.ts` file that would otherwise
  call `Deno.test(...)` MUST** either use BDD
  (`import { describe, it } from '@std/testing/bdd'`) or alias `Deno.test` —
  never leave a bare `Deno.test(` in a test file. The canonical alias (same
  pattern as `../turbopaneld`, applied to all existing Deno test files) is placed
  once, right after the imports:

  ```ts
  /**
   * Jest/Mocha-shaped alias for {@link Deno.test}.
   *
   * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
   * reports Deno suites as empty; keep this alias so analysis sees real tests.
   */
  const test = Deno.test.bind(Deno);
  ```

  Then call `test('...', () => { … })` (or the object form `test({ name, fn })`)
  instead of `Deno.test(...)`. When adding a new Deno test file, add this alias
  from the start **and claim the file in the test inventory** (next section).

### Adding tests (inventory)

This repo does **not** glob `*.test.ts`. A new suite that is not claimed by a
runner never executes in CI and never appears in `coverage/lcov.info`, so it
reads as tested in review while contributing **0%** to the Sonar new-code
coverage gate. After adding, renaming, or deleting a `*.test.ts`, run
**`pnpm check:test-inventory`** (`scripts/check-test-inventory.mjs`) — it is
wired into `pnpm test:hook` and CI `build.yml`. Claim each file in **exactly
one** bucket:

| Suite kind | Claim it in |
| ---------- | ----------- |
| Deno (`@std/assert`, `const test = Deno.test.bind(Deno)`, `@std/testing/bdd`) | the `deno test` file list in `scripts/test-coverage.sh` (host-free unit tests, plus Postgres suites — CI starts Postgres; they skip locally when `TURBOPANEL_DATABASE_URL` is unset) |
| Workers / Durable Object (`vitest`, `cloudflare:test`, `@needs-workers-globals`) | `test.include` in `vitest.config.ts` (explicit file list, not a glob) |
| Needs a service CI does not start (Redis, …) | `SERVICE_DEPENDENT` in `scripts/check-test-inventory.mjs` **with a reason** — the only sanctioned way to leave a suite out of both runners |

Do not add the same file to both lists. Coverage-attribution traps and the
LCOV merge live in [`scripts/AGENTS.md`](./scripts/AGENTS.md).

### Workers-reachable imports

Modules imported (transitively) from `src/workers.ts` must bundle under
Wrangler/esbuild. **Do not** use Deno import-map-only specifiers there —
`@std/*`, bare `jsr:…`, or other Deno-only APIs — unless there is a matching
`wrangler.jsonc` `alias` (see the SMTP shims). Prefer Web Crypto and small local
helpers (e.g. hex in `src/lib/machine-key.ts` /
`src/daemon/authn/server-key.ts`). **Do not** call `crypto.getRandomValues`,
`crypto.subtle.*`, `fetch`, or `setTimeout` at module load — Cloudflare
startup validation fails with error 10021 (`Disallowed operation called
within global scope`); mint keys and do I/O inside a handler. Deno-only
entrypoints (`src/deno.ts`, developer drizzle studio, Redis cell) may keep
`@std/*`. Guard: `pnpm check:workers-bundle`.

### Ansible style (SonarQube)

- Prefer **`mode: "0640"`** / **`0750"`** with explicit **`owner`** /
  **`group`** over world-readable modes (`ansible:S2612`).

`README.md` is for humans getting started; `AGENTS.md` is for agents maintaining
the system.

Unit tests use non-production secrets from `src/test-fixtures/secrets.ts`
(`TEST_ONLY_TURBOPANEL_SECRET`). Vitest Workers config uses the same naming
convention in `wrangler.vitest.jsonc`. The secret scanner allowlists only exact
fixture lines in `.secretscan-allowlist` — do not add broad exclusions.

**Where to run tests:** host VirtFS checkouts lack a usable Node/pnpm/Deno
tree. Run suites **inside the Vagrant guest** from the host `dev` checkout
(`../dev/AGENTS.md` → Testing). Do not run `pnpm test` / `pnpm test:do` /
`deno task test` on the host:

```bash
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/turbopanel && pnpm test:do'
```

A new `*.test.ts` is not done until `pnpm check:test-inventory` passes (see
**Adding tests** above). `pnpm test:hook` includes that guard; `pnpm test:do`
alone does not.

## Setup

- **Deno** — <https://docs.deno.com/runtime/getting_started/installation/>
- **pnpm** — <https://pnpm.io/installation>
- **Node.js** and **openssl** — required for cert generation (`scripts/*.mjs`);
  Node.js also used for Caddy download
- Run `./console` from the
  [TurboPanel Development Environment](https://github.com/TurboPanel/dev)
  checkout. The console installs Deno, clones the daemon, and drives the full
  dev stack via `scripts/bootstrap-orchestration.ts` +
  `scripts/install-daemon-systemd.sh` (shared orchestration under
  `/opt/turbopanel/vendor/` — not `orchestration/runtime/venv`).
- Managed/co-located installs: secret-bearing runtime env lives in the instance
  config dir (`runtime.env`, `runtime.dev-vars`) — **never** in the git checkout
  root. Beside those env files, Ansible holds `.instance_secrets` (versioned
  keyring, `root:<turbopanel_group>` `0640`, ordered `<version>:<value>`, first
  entry current); it is injected into `runtime.dev-vars` as `TURBOPANEL_SECRETS`
  (the optional rotation keyring; `TURBOPANEL_SECRET` is the normal single secret),
  and rotation is gated by the `turbopanel_instance_secret_rotate` extra-var.
  Semantics:
  `src/client/authn/AGENTS.md`. Standalone scripts
  (`scripts/generate-self-signed-cert.mjs`, `scripts/workers-serve.sh`,
  `scripts/drizzle-studio-serve.sh`) default to the FHS location
  **`/etc/turbopanel/instance/runtime.env`** when
  `TURBOPANEL_INSTANCE_RUNTIME_ENV` is unset. Both managed and co-located dev
  use **`/etc/turbopanel/instance/`** (dev-user-owned in development). The unit
  injects `TURBOPANEL_INSTANCE_RUNTIME_ENV` accordingly.
  `scripts/generate-self-signed-cert.mjs` and daemon `public-urls-apply`
  read/write `runtime.env` there. Do not reintroduce checkout-root `.env` /
  `.dev.vars` generation.
- `pnpm install` — installs Hono and Wrangler into `node_modules/` for Workers
  bundling
- Local Wrangler secrets come from Ansible-generated
  `/etc/turbopanel/instance/runtime.dev-vars` (`TURBOPANEL_SECRETS`), symlinked
  into the checkout as `.dev.vars` by `scripts/workers-serve.sh`; that path is
  separate from managed Ansible installs above.
- `pnpm dev` (wrangler) still runs the **Cloudflare Workers** path for
  full-stack testing — unchanged. **`wrangler.jsonc` `dev.ip` is `0.0.0.0`** so
  Docker Caddy (`host.docker.internal`) can reach the dev server; default
  localhost-only bind causes Caddy **502**s.
- **`pnpm deploy`** — applies pending migrations (`TURBOPANEL_DATABASE_URL` or
  `DATABASE_URL` required for tooling) then deploys to Cloudflare Workers
  (`CLOUDFLARE_ENV` required, e.g. `live` or `testing`). Works from any
  environment with internet access to the database — self-hosted dev, CI, or
  production. Requires **Node** only (`pnpm migrate` runs `drizzle-kit migrate`;
  no Deno prerequisite). Equivalent to
  `pnpm migrate && wrangler deploy --env $CLOUDFLARE_ENV --minify --var TURBOPANEL_REVISION:$(git rev-parse HEAD)`.
  Do not commit `TURBOPANEL_REVISION` in `wrangler.jsonc` — that would freeze a SHA.
  Self-hosted instance-launch writes it into `runtime.env` / `runtime.dev-vars`
  from `git rev-parse HEAD` in the instance checkout. `GET /api/health` reports
  `{ license, revision: { commit, sourceUrl } }` so a network user can identify
  Corresponding Source.
- **`pnpm notices:generate` / `notices:check`** — `THIRD_PARTY_NOTICES.md` from
  `pnpm-lock.yaml` plus the JSR/npm graph in `deno.lock`. Wired into `test:hook`
  and CI `build.yml`.
- **`pnpm check:workers-bundle`** — `wrangler deploy --dry-run` of
  `src/workers.ts` (no upload). Catches unresolved imports the Workers bundler
  cannot resolve (e.g. `@std/*` / `jsr:`). Wired into `.githooks/pre-commit`.
  **`pnpm test:do` is not enough** — vitest bundles `src/workers-vitest.ts` with
  a narrow include list and can tree-shake away modules only the full deploy
  graph pulls in.
- **`pnpm check:ca-boundary`** — Organization CA sources (`src/lib/tls/`,
  `src/client/tls/`) must not reference Platform CA paths. See
  `src/lib/tls/AGENTS.md`. Wired into `test:hook` and CI `build.yml`.
- `pnpm cf-typegen` — regenerate `worker-configuration.d.ts`. Keep the
  `Cloudflare.Env` / global `Env` aliases that extend `CloudflareBindings`
  (vitest `cloudflare:test` `env` is typed as `Cloudflare.Env`, not the
  retired `ProvidedEnv`).
- The Ansible `instance-certs` / `caddy` / `node-runtime` roles supersede the
  standalone `pnpm cert:generate` / `pnpm caddy:install` scripts for managed
  hosts (the scripts remain for manual use).

### Systemd (dev services run as the dev user; production uses dedicated users)

Installed and managed by the daemon via the `instance-launch` Ansible role:

| Unit                          | User (dev)       | User (production) | Notes                                                            |
| ----------------------------- | ---------------- | ----------------- | ---------------------------------------------------------------- |
| `turbopanel-instance.service` | current dev user | `tpctrl:tp`       | Deno instance on the Unix socket                                 |
| `turbopanel-caddy.service`    | current dev user | `tpcaddy:tp`      | TLS + reverse proxy on `:8443` (`GOMAXPROCS=1`, `CPUQuota=100%`) |
| `turbopanel-ui.service`       | current dev user | `tpctrl:tp`       | Expo web dev server (`:8081`, dev only)                          |
| `turbopaneld.service`         | current dev user | `tp:tp`           | runs Ansible; has sudo (production only)                         |

- `systemd/turbopanel-instance.service` was removed — the canonical unit is
  templated by the `instance-launch` role in `../turbopaneld`.
- Logs:
  `journalctl -u turbopanel-instance -u turbopanel-caddy -u turbopanel-ui -f`
- Co-located daemon: `../turbopaneld/scripts/install-daemon-systemd.sh`

## Unix domain sockets

In Deno mode (development and production), the Hono instance listens on a **Unix
domain socket** instead of a TCP port. Caddy terminates TLS and proxies `/api/*`
and `/ws/*` to that socket.

### Directory layout

All TurboPanel runtime sockets live under **`/run/turbopanel/`** (on Linux,
`/var/run` symlinks to `/run`). In **development** the directory is owned by the
dev user. In **production** it is **`2770 tp:tp`** (setgid) so the
`tpctrl`/`tpcaddy` users (in group `tp`) can bind:

| Socket file                              | Service                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `/run/turbopanel/instance.sock`          | Hono instance (dev: mode `0660`, dev user; prod: mode `0660`, group `tp`) |
| `/run/turbopanel/postgres/.s.PGSQL.5432` | PostgreSQL 18 (Docker bind-mount)                                         |
| `/run/turbopanel/<name>.sock`            | Reserved for future services                                              |

### Environment variables

| Variable                    | Default                        | Purpose                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURBOPANEL_SOCKET`         | —                              | Full socket path override                                                                                                                                                                                                                                                                                                       |
| `TURBOPANEL_SOCKET_DIR`     | `/run/turbopanel`              | Directory when using the default filename                                                                                                                                                                                                                                                                                       |
| `TURBOPANEL_SOCKET_DIAL`    | `run/turbopanel/instance.sock` | Caddy `unix//` dial path (no leading slash)                                                                                                                                                                                                                                                                                     |
| `TURBOPANEL_UI_MODE`        | `static`                       | Instance/developer-surface gate (`dev` enables Expo UI unit + developer API on co-located hosts); production Caddy always serves static UI                                                                                                                                                                                      |
| `TURBOPANEL_UI_ROOT`        | `/opt/turbopanel/share/ui`     | Directory of `expo export --platform web` output (local manual dev typically sets `../ui/dist`)                                                                                                                                                                                                                                 |
| `TURBOPANEL_UI_SERVICE`     | `turbopanel-ui`                | Name of the Expo systemd unit on managed hosts (injected for orchestration; no instance API surface today)                                                                                                                                                                                                                      |
| `CADDY_PORT`                | `8443`                         | HTTPS listen port                                                                                                                                                                                                                                                                                                               |
| `CADDY_TLS_CERT`            | `./certs/self-signed.crt`      | Server leaf certificate (signed by the **Platform CA**; stays under the instance `certs/` dir)                                                                                                                                                                  |
| `CADDY_TLS_KEY`             | `./certs/self-signed.key`      | Server leaf private key                                                                                                                                                                                                                                                                                                         |
| `TURBOPANEL_TLS_CA`         | `/var/lib/turbopanel/tls/ca.crt` | Durable **Platform CA** (override; default is `${TURBOPANEL_STATE_DIR}/tls/ca.crt`)                                                                                                                                                                            |
| `TURBOPANEL_TLS_CA_KEY`     | `/var/lib/turbopanel/tls/ca.key` | Durable **Platform CA** private key                                                                                                                                                                                                                           |
| `TURBOPANEL_TLS_CA_BUNDLE`  | `/var/lib/turbopanel/tls/ca-bundle.pem` | Current+retired **Platform CA** PEM bundle served at `GET /api/daemon/v1/instance/ca`                                                                                                                                                                      |
| `TURBOPANEL_TLS_EXTRA_SANS` | —                              | Comma-separated DNS names for the server cert (e.g. `turbopanel.lan`)                                                                                                                                                                                                                                                           |
| `TURBOPANEL_TRUSTED_PROXY_CIDRS` | `127.0.0.0/8,::1/128`     | Peer addresses whose `CF-Connecting-IP` / `X-Forwarded-For` the instance believes. Set it when a Cloudflare Tunnel connector or other reverse proxy runs on a **different host** than the instance. **Replaces** the loopback default — include loopback explicitly if Caddy is still co-located. See **Caddy (production) → Server addresses**. |
| `TURBOPANEL_PUBLIC_URLS`    | —                              | Comma-separated list of URLs/hosts this control plane is reachable at (e.g. `https://panel.example.com,https://huey.lan:8443`). Persisted in the `setting` table by the admin API; read by `generate-self-signed-cert.mjs` to derive cert SANs. Also consulted by `resolvePublicBaseUrl` as the preferred install-command host. |

Path resolution lives in `src/server-paths.ts`. It ships **FHS defaults** —
config `/etc/turbopanel`, state `/var/lib/turbopanel`, logs
`/var/log/turbopanel`, runtime `/run/turbopanel`, static UI
`/opt/turbopanel/share/ui` — and every path is env-overridable
(`TURBOPANEL_CONFIG_DIR`, `TURBOPANEL_STATE_DIR`, `TURBOPANEL_LOG_DIR`,
`TURBOPANEL_RUN_DIR`, `TURBOPANEL_UI_ROOT`, `TURBOPANEL_SOCKET(_DIR)`,
`TURBOPANEL_TLS_CA`, `TURBOPANEL_TLS_CA_KEY`, `TURBOPANEL_TLS_CA_BUNDLE`).
Co-located dev uses the same FHS mutable paths by default, all
**dev-user-owned**; source repos live under `$HOME` (`~/turbopaneld`, `~/turbopanel`,
`~/ui`, `~/website`). The module has no separate dev-mode branch — Ansible
(`instance-launch`) and manual commands may override individual paths via env
when needed. `resolveInstanceRuntimeConfigPaths` composes
`<configDir>/instance/runtime.env` (+ `runtime.dev-vars`). Managed production
installs also run the daemon as **`turbopaneld.service`** — native
`/opt/turbopanel/bin/turbopaneld`, or `turbopaneld.js` via vendored Deno on
hosts where that binary cannot load (see `../turbopaneld/AGENTS.md` → Filesystem
layout & path model). Defaults and overrides are pinned by
`src/server-paths.deno.test.ts` (`deno task test:paths`).

## Database (Drizzle + Postgres.js)

The instance uses **Drizzle ORM** over **postgres.js**. The Workers/Hyperdrive
client uses `prepare: true` (see Workers Hyperdrive below); the Deno client uses
`prepare: false` (direct Postgres, no Hyperdrive). Connection factories live in
`src/db.ts`; schema in `src/lib/db/schema.ts`; drizzle-kit config in
`drizzle.config.ts`. **Read `src/lib/db/AGENTS.md` before touching schema or the
database.** Schema changes are versioned in `migrations/`; `pnpm migrate`
applies pending SQL during Workers deploy (after a preflight that requires
PostgreSQL 18+ / built-in `uuidv7()` — `scripts/check-postgres-compat.mjs`).
Applied versions are recorded in `public.migration`.

**Multi-node model:** "multi-node PostgreSQL" means primary/standby
replication with exactly one writable primary (streaming replication for
HA/failover; logical replication for read replicas/DR). UUIDv7 primary keys
remove sequence coordination across writers and failovers — they are **not**
distributed-SQL readiness, and sharded/distributed SQL (Citus, CockroachDB,
YugabyteDB, …) is out of scope for this schema. See `src/lib/db/AGENTS.md`
(Multi-node PostgreSQL model) before changing key strategy or targeting a
distributed engine.

| Runtime            | Factory                                                                      | When connected                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers | `createWorkersDb(env.HYPERDRIVE)` or `createWorkersDb({ connectionString })` | `HYPERDRIVE` binding in `wrangler.jsonc` (all named envs including `testing`); **`wrangler dev`** may fall back to `TURBOPANEL_DATABASE_URL` when Hyperdrive is absent |
| Deno (self-hosted) | `createDenoDb()`                                                             | `TURBOPANEL_DATABASE_URL` set by `instance-launch`                                                                                                                     |

Route handlers read the per-request client via `getDb(c)` (set by
`createApp({ db })`). **Deno boot requires `TURBOPANEL_DATABASE_URL`:**
`createDenoDb()` throws before `createApp()` when the variable is missing or
blank, so the process exits instead of serving without a database.

| Variable                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURBOPANEL_DATABASE_URL` | Full postgres connection URL. **Deno mode:** required at boot — `createDenoDb()` throws immediately when missing or blank (self-hosted instance will not start). Passed directly to postgres.js (supports Unix socket URLs via libpq `?host=` / directory form, e.g. host `/var/run/turbopanel/postgres` or `/run/turbopanel/postgres`). **Workers runtime:** prefers the `HYPERDRIVE` binding; `src/workers.ts` falls back to this env var when Hyperdrive is unset (local `wrangler dev` without a binding). When the URL uses `?host=` for a Unix socket, ensure Deno has read access to that directory (`/run/turbopanel` covers the default Docker bind-mount path). |
| `DATABASE_URL`            | **Tooling only** (drizzle-kit, `pnpm migrate`, `dev/scripts/introspect.sh` / `dev/scripts/sync.sh` overrides). Accepted as a fallback when `TURBOPANEL_DATABASE_URL` is unset — common in CI and Cloudflare dashboard deploy workflows. Not read by the Deno instance or Workers runtime at request time.                                                                                                                                                                                                                                                                                                                                                                 |

### Workers Hyperdrive

`wrangler.jsonc` declares a `HYPERDRIVE` binding stub (replace the placeholder
id before deploy). Types: `worker-configuration.d.ts`
(`HYPERDRIVE?: Hyperdrive`). Regenerate with `pnpm cf-typegen` after changing
bindings.

**Local dev (`wrangler dev`):** do not commit `localConnectionString` in
`wrangler.jsonc`. The daemon's `instance-launch` Ansible role writes
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` into
`/etc/turbopanel/instance/runtime.env` (from the converge-generated Postgres
credentials), and `scripts/workers-serve.sh` symlinks it into the checkout as
`.env`. Wrangler loads `.env` into `process.env` before applying Hyperdrive
bindings — the Worker connects directly to local Postgres (no Hyperdrive
pooling/caching in this mode). **`TURBOPANEL_DATABASE_URL`** (or **`DATABASE_URL`** for tooling) in the
same file is for migrations/Drizzle/sync and may use different credentials than
the Hyperdrive runtime user in production.

The Workers DB client uses `prepare: true` on postgres.js. Hyperdrive has
supported named prepared statements since June 2024 and manages their lifecycle
across its internal connection pool — per-session state is not a concern.
Setting `prepare: true` is **required** for Hyperdrive to cache parameterized
`SELECT` queries on the `HYPERDRIVE_CACHED` binding; with `prepare: false`,
Hyperdrive sends every query as a simple (unprepared) query and marks all
parameterized reads as uncacheable.

#### ⛔ HARD RULE: one Hyperdrive/postgres.js client per request — NEVER cache a DB client across requests

> **This rule is non-negotiable. Violating it took production down** (redeploy
> that cached the client → every DB call after the first in an isolate threw
> `HTTP 500` on sign-in/session, causing a sign-in↔welcome redirect loop). Do
> **not** "optimize" DB client management by reusing a client across requests.
> If you think reuse saves a connection, you are wrong — Hyperdrive already
> pools connections server-side, so per-request creation has **zero**
> connection-startup cost.

**On Cloudflare Workers, a database client and its underlying socket are I/O
objects bound to the request (invocation) that created them.** A single V8
isolate serves many `fetch` / `queue` / cron invocations. If you store a
`postgres(...)` client in module/global scope or an isolate-level cache and
reuse it on a later invocation, Cloudflare throws and the request 500s:

- `Cannot perform I/O on behalf of a different request. I/O objects ... created in the context of one request handler cannot be accessed from a different request's handler.`
- postgres.js: `write CONNECTION_ENDED` / `write CONNECTION_DESTROYED` /
  `write CONNECTION_CLOSED`
- Creating the client in global scope instead throws
  `Disallowed operation called within global scope`.

Cloudflare's own fix (Hyperdrive troubleshooting → **Stale connection and I/O
context errors**): _"Create a new database client on every request instead of
caching it in a global variable. Hyperdrive's connection pooling already
eliminates the connection startup overhead."_ —
<https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/>
(see also
<https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/>).

**The contract in this repo:**

- `resolveWorkersDb` / `resolveWorkersCachedDb` / `openWorkersRequestDb`
  (`src/workers-bindings.ts`) **create a fresh client per call**. `workers.ts`
  `fetch()` / `queue()` and the offline-sweep cron each resolve their own
  client(s) for that one invocation. Do **not** add a
  `Map`/`WeakMap`/module-level singleton that returns the same client on a later
  invocation.
- **Always close** those clients when the invocation finishes:
  `closeWorkersRequestDb` via `ctx.waitUntil` on `fetch`, `endDbConnection` in
  `finally` on `queue` and `runOfflineSweep`. Leaving postgres.js pools open
  stacks memory until the isolate hits the **128 MB** limit and Cloudflare
  recycles it (sawtooth memory charts). Hyperdrive still pools server-side —
  closing only releases the Worker-side client.
- Isolate/global scope is fine for **stateless** things (derived secrets,
  rate-limiter adapters, the compiled Hono app) — never for anything holding a
  socket/stream (DB clients, in-flight request/response bodies).

**Durable Objects are a different isolate with different rules — do not conflate
them.** A DO is its own long-lived object; its Postgres projection
(`src/daemon/cell/do.ts`) opens a **short-lived** client via `createWorkersDb`
and **must** `endDbConnection` it in `finally`, because an open outbound DB
socket keeps the DO awake (non-hibernatable) and bills GB-s for the entire
WebSocket lifetime (the 71-minute / ~547 GB-s incident). So: request Worker
isolate → fresh-per-request **and** close; Durable Object → fresh-per-op, always
close. Never reuse a request-path client inside a DO or vice-versa. DO/cost
rules: `src/daemon/cell/AGENTS.md`.

**Regression guard:** `src/workers-bindings.test.ts` asserts `resolveWorkersDb`
/ `resolveWorkersCachedDb` return a **new** client on each call (never the same
instance), and that `openWorkersRequestDb` / `closeWorkersRequestDb` end both
primary and cached clients. Source scans on `workers.ts` and `offline-sweep.ts`
assert the close paths stay wired. If you find yourself weakening those tests to
allow reuse or skip closes, stop — you are about to reintroduce either the
I/O-context outage or the 128 MB sawtooth.

Previously `prepare: false` was used because older Hyperdrive versions did not
support prepared statements. That restriction no longer applies.

**Unsupported PostgreSQL features** (do not rely on these on the
Workers/Hyperdrive path):

- SQL-level prepared statements: `PREPARE`, `DISCARD`, `DEALLOCATE`, `EXECUTE`
- [Advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- `LISTEN` / `NOTIFY`
- Any other modification to per-session state unless Cloudflare documents it as
  supported

**Cached read models:** approved read-only `SELECT` paths may use the
`HYPERDRIVE_CACHED` binding (Workers) or Redis read-through (Deno).
Authorization, sessions, and secrets must use the primary connection. See
`src/query-cache/AGENTS.md`.

### Tooling

- `pnpm install` — pulls `drizzle-orm`, `postgres`, `drizzle-kit`
- After editing `schema.ts`, run `pnpm drizzle-kit generate` to create SQL in
  `migrations/`; apply locally with `TURBOPANEL_DATABASE_URL=… pnpm migrate` or
  `DATABASE_URL=… pnpm migrate`. Workers deploy runs `pnpm migrate`
  automatically (Node only — no Deno). Deno dev can still use
  `dev/scripts/sync.sh` (`push`) — see `src/lib/db/AGENTS.md`.

### Caddy dial format

Caddy uses `unix//<path>` where `<path>` has **no leading slash**:

```caddyfile
reverse_proxy unix//run/turbopanel/instance.sock
```

`TURBOPANEL_SOCKET_DIAL` is passed into the `Caddyfile` placeholders.

### Development

The daemon's `runtime-sockets` role (and `scripts/ensure-socket-dir.mjs` for
manual runs) ensures `/run/turbopanel` exists and is owned by the dev user in
development (**`2770 tp:tp`** in production), using passwordless `sudo` when
needed. After bind, the instance hardens the socket file to `0660` (owner+group
only) so the daemon can connect.

The instance Deno process runs with scoped permissions (see the
`instance-launch` unit template):
`--allow-env --allow-sys=networkInterfaces --allow-read=/run/turbopanel,<daemon dir>,<instance dir> --allow-write=/run/turbopanel --allow-run=git,systemctl,tar`
(`tar` is needed for the dev-sync tarball). TCP listeners and Unix-domain
connects (Postgres `.s.PGSQL.5432`, Redis `redis.sock`, instance listen sock) go
on `--allow-net` — Deno 2.9+ treats Unix-socket connect as net, not read. TCP
dev Postgres adds `--allow-net=127.0.0.1:5432`. Public Git provider APIs
(`api.github.com:443`, `gitlab.com:443`) must stay on that list — the GitHub
App manifest callback and GitLab token/API calls fetch them from this process,
and a missing host surfaces as HTTP 502 (`NotCapable`). A GitHub Enterprise
or self-managed GitLab origin is not pre-allowed; add that host to the unit
when one is configured.

### Production

The daemon's orchestration bootstrap runs the `socket-dirs-setup` Ansible
playbook, which installs `/etc/tmpfiles.d/turbopanel.conf` and applies it with
`systemd-tmpfiles --create`. The directory is recreated on boot automatically.

## Caddy (production)

This repo's `Caddyfile` is **production-only** — full detail in
[`caddy.md`](./caddy.md) (server addresses, certs/entrypoint, daemon TLS trust
model, static UI). The one rule that must not be missed:

**The catch-all is why the prefix list is load-bearing.** Caddy answers
`try_files {path} /index.html`, so a prefix the instance owns but Caddy does
not match is served the SPA shell with **HTTP 200** rather than a 404. For a
Git webhook that means the provider records a successful delivery and never
retries — silent, unrecoverable loss. The same trap exists on Workers
(`not_found_handling: "single-page-application"`); add the prefix to `routes`
in `wrangler.jsonc` at the same time. `src/surfaces.test.ts` pins the strings.

## API / WS surfaces (versioned)

Four versioned surfaces each have REST + WS namespaces (where applicable).
Prefixes live in `src/surfaces.ts`; `GET /api/health` is the single
deliberately-unversioned probe (`{ ok, license: 'AGPL-3.0-only', revision:
{ commit, sourceUrl } }` — `TURBOPANEL_REVISION` from systemd / `wrangler
deploy --var`, else `unknown`). `/webhook/*` is a separate top-level traffic
class rather than a versioned API — see the last row.

| Surface                      | REST                  | WS                        | Notes                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client (end-user UI)         | `/api/client/v1/*`    | `/ws/client/v1`           | servers list/detail (+ ips/timeSync/docker/effective timezone, labels, effective sshPort/ntpDefaults), timezone/NTP commands, server labels (`GET`/`PUT /servers/:id/labels`), org record (`GET`/`PATCH /organizations/:id`), org default-timezone + temperature-unit + host-defaults + default-environment + server-capacity + managed-defaults + TurboFabric (`GET`/`PUT /organizations/:id/fabric`, `PATCH /organizations/:id/fabric/relays/:serverId`, `POST /organizations/:id/fabric/apply`) + `/timezones` |
| Install (self-hosted wizard) | `/api/install/v1/*`   | —                         | Deno only for POST endpoints; PAM-gated; no session/cookie on bootstrap                                                                                                                                                                                                                                                                                                      |
| Developer (dev console)      | `/api/developer/v1/*` | `/ws/developer/v1` (stub) | fleet, diagnostics, shell, addresses, `system/upgrade`, `instance/tunnel-token`, `daemon/(:id/)sync-dev`                                                                                                                                                                                                                                                                     |
| Admin                        | `/api/admin/v1/*`     | —                         | Mounted on both Deno and Workers; `superadmin` or `admin` role required; OpenAPI/Scalar at `/api/admin/v1/openapi.json` + `/reference` in development only                                                                                                                                                                                                                   |
| Daemon                       | `/api/daemon/v1/*`    | `/ws/daemon/v1`           | `version`, `instance/ca`; daemons connect on the WS path                                                                                                                                                                                                                                                                                                                     |
| Git webhooks                 | `/webhook/{github,gitlab}(/:ref)` | —             | **Not an API.** The caller is GitHub or GitLab: no session, no daemon JWT, no `Origin`, and what arrives is an event rather than a call. Unversioned and outside every protected prefix by design. Self-hosted providers get the `:ref` suffix; hosted ones get the clean path. Every fronting layer must forward it — see `src/webhook/AGENTS.md` |

- Route modules: `src/daemon/api-routes.ts`, `src/client/routes.ts`,
  `src/lib/install/routes.ts` (registered from `deno.ts` only); Deno-only routes
  `src/developer/system-routes.ts`, `src/developer/dev-sync.ts`,
  `src/developer/tunnel-routes.ts`, and the version route are registered in
  `src/deno-dev.ts`. `src/admin/routes.ts` is mounted on both Deno and Workers
  (admin/superadmin session required). Workers-safe developer REST lives in
  `src/developer/routes-core.ts` (`workers.ts`); full Deno developer surface in
  `src/developer/routes.ts`. Client bindings (`src/client/bindings/`) expose
  `GET|POST|PATCH|DELETE /api/client/v1/bindings` — managed DB principal →
  compose service materialization of binding-owned `variable` rows (no new
  command type). List filters are mutually exclusive: `serviceId`, consumer
  `environmentId`, or managed-cluster `managedEnvironmentId`. Create returns
  `{ ok, id }`; patch returns `{ ok }`.
- The TurboPanel Development Environment calls developer routes via
  `src/instance-client.ts` (Unix socket + HTTPS fallback).
- Hard cutover: daemon, UI, Caddy (`/ws/*`), and Workers routes
  (`wrangler.jsonc`) moved together. The external CDN node installer must fetch
  the CA from the new `/api/daemon/v1/instance/ca` path.

Per-feature client-surface behavior notes (timezone/NTP, host defaults,
labels, TurboFabric, compiled compose, org options, containers, datacenters /
subnets / addresses, …) moved to `src/client/AGENTS.md` → **Client surface
feature notes**.

## Storage classification (four workloads)

Storage is chosen by **the question asked of the data**, not by the shape of the
data. A deploy transcript and a running container's stdout can both be called
"logs" and still belong in opposite classes — one is stored, one is not. Before
adding, moving, or "unifying" a store, place it in this table first — and read
the linked doc.

| # | Workload | Access pattern | Hosted (Workers) | Self-hosted (Deno) | Read before editing |
| - | -------- | -------------- | ---------------- | ------------------ | ------------------- |
| 1 | **Command state** — `command` rows, status, timings, `context` | Relational, transactional, filtered/joined; source of truth | Postgres via Hyperdrive | Postgres (co-located) | `src/lib/commands/AGENTS.md` |
| 2 | **Command execution material** — the one-shot daemon payload | Written once, read once, then deleted (~24 h on failure) | Postgres `dispatch` side table | Postgres `dispatch` side table | `src/lib/db/AGENTS.md` |
| 3 | **Deploy/build transcript** — a command's stdout/stderr | `GET` by known `commandId`, whole or resumed from an offset — **never scanned across commands** | R2 keyed objects (`EXECUTION_LOGS`) | Filesystem under the state tree (or S3) | `src/lib/execution-logs/AGENTS.md` |
| 4 | **Analytics** — host metrics + connection-status events | Aggregate over time buckets; sampled, disposable | Analytics Engine | DuckDB + Parquet under the metrics state root (`resolveMetricsDir()`) | `src/daemon/metrics/AGENTS.md` |

Container output is tailed live (on-demand `docker container logs` via a
correlated cell round trip) and is **never stored**. It is not a storage
workload. Operators who need history ship those bytes to their own sink — see
`../website/docs/architecture/container-logs.mdx`.

Classes 1–2 are canonical business data; 3–4 are retained telemetry and are
never load-bearing for a control-plane decision. **Postgres holds no log bytes**
— no execution-log column, no container-log table; `hasLog` is resolved
store-side. Every telemetry store resolves to a **safe no-op disabled store**
when unconfigured (`resolveExecutionLogStore` /
`resolveServerMetricsStore`), so callers never branch on availability. Public
docs: `../website/docs/architecture/storage-architecture.mdx` (plus
`deployment-logs.mdx` and `container-logs.mdx`).

## DuckDB packaging (`deno compile` + native addon)

The self-hosted metrics store is embedded DuckDB
(`@duckdb/node-api`, pinned exactly in `deno.json` imports **and**
`package.json` — this repo is BYONM, so pnpm owns the actual package install).
Spike-verified packaging facts, encoded in `src/deno-compile-permissions.test.ts`
and gated by `deno task duckdb:smoke`:

- `deno compile` bundles the `duckdb.node` addon from `node_modules`
  automatically and **self-extracts it at runtime**; loading it needs
  `--allow-ffi` (unscoped — the extraction path is a per-binary temp dir).
- It does **not** extract the companion `libduckdb.so` the addon links via
  `RUNPATH $ORIGIN`, and `--include` cannot help (the compiled binary's VFS is
  invisible to the dynamic linker). The daemon's `instance-build` role stages
  `libduckdb.so` under `/opt/turbopanel/vendor/duckdb/lib` on every compiled
  converge (locating it via `scripts/duckdb-native-lib.ts`; converge fails when
  it cannot be staged) and the instance unit puts that directory on
  `LD_LIBRARY_PATH` (see `resolveDuckdbNativeLibraryPath` in
  `src/server-paths.ts`). Source mode (`deno run --allow-ffi`) needs neither —
  addon and `.so` are real sibling files under `node_modules`.
- Metrics state lives at `resolveMetricsDir()` (`<stateDir>/metrics`,
  `TURBOPANEL_METRICS_DIR` override); the compile tasks and the daemon's
  instance-launch unit grant read+write on it. DuckDB is fully in-process —
  the metrics store needs no network grant on either surface.
- `deno task duckdb:smoke` builds the **real** production artifact
  (`deno task compile` → `dist/turbopanel-instance`) and drives its
  `duckdb-smoke` subcommand (`src/duckdb-smoke.ts`, routed by `src/deno.ts`) to
  prove DB create → restart durability → Parquet round trip against the exact
  binary that ships. **Run it inside the Vagrant guest on both linux-x64 and
  linux-arm64** (`../dev/AGENTS.md` → Testing), never on the host.

## Subsystem docs (nested `AGENTS.md`)

Large subsystems live in focused `AGENTS.md` files next to their code — Cursor
loads the nearest one automatically when you work in that directory. **Read the
matching file before editing that area.** This root keeps only cross-cutting
orientation; the detail moved to:

| Subsystem                         | Read before editing                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Daemon Cell** (`/ws/daemon/v1`) | `src/daemon/cell/AGENTS.md`                         | Presence, outbox + request correlation, Redis vs Durable Object backends, the **canonical Durable Object cost / hibernation / billing rules**, and the Postgres liveness read model (`server.is_connected` + `server.status_changed_at` only — no stored tri-state `daemon_status` column)                                                                                                                                                                          |
| **Server metrics**                | `src/daemon/metrics/AGENTS.md`                      | Host-metrics ingestion, Analytics Engine (Workers) / DuckDB + Parquet (Deno) storage, query + chart caching; also carries a history-only connection-status event stream (`blob1 = "status"`) — never authoritative for current liveness                                                                                                                                                                                                                                |
| **Command Pipeline**              | `src/lib/commands/AGENTS.md`                        | Typed commands, queue transport, and correlated dev-sync / tunnel-token / public-URL-apply requests                                                                                                                                                                                                                                                                                                                                                              |
| **Webhook ingress** (`/webhook/*`) | `src/webhook/AGENTS.md`                            | The six-step gate every inbound webhook runs, why its ordering is load-bearing, how a delivery is resolved to the secret that verifies it, the delivery-claim replay ledger, and what adding a new webhook kind costs                                                                                                                                                                                                                                                                                                                                                              |
| **Billing** (`/webhook/stripe`)   | `src/lib/billing/AGENTS.md`                         | Stripe owns money, Postgres owns entitlement: the `payer` / `subscription` / `seat` projection and why nothing on the ingest or page-load path may call Stripe; the dependency-free REST client (idempotency-key rule, `Stripe-Version` pin, no npm SDK); raw-bytes signature verification; the `setting`-row quantity lease (no advisory locks on Hyperdrive); `billingEnabled` = presence of the key                                                                                                                                                                                                                                                              |
| **Execution logs**                | `src/lib/execution-logs/AGENTS.md`                  | Command transcripts (daemon stdout/stderr): the `ExecutionLogStore` contract, R2 (Workers) / filesystem + S3 (Deno) drivers, seq/seal/truncation semantics, retention on the shared maintenance tick. **Keyed-object GET, not an analytics table** — nothing queries across transcripts. Postgres holds no execution-log column; `hasLog` is resolved store-side. This is the **only** log class TurboPanel stores. Container stdout is a live on-demand tail, never this store. |
| **Compose documents**             | `src/lib/compose/AGENTS.md`                         | `ComposeDocument` model, `x-turbopanel` extension, linter, overlay merge; compile-runtime (`compose.yaml` per participating server); schedule in `src/lib/schedule/`; **placement = `environment.server_id` ?? `project.options.defaultServerId`** (compose placement stripped on save)                                                                                                                                                                          |
| **Managed engines**               | `src/lib/managed/AGENTS.md` + `src/client/managed/` | Engine registry + client API (`POST …/managed`, apply/lifecycle/users/databases/status/logs, `GET /organizations/:id/managed`); whole-server `managed.ingress.reconcile` for shared ProxySQL and `managed.ha.reconcile` for per-org Orchestrator (lazy: HA only on servers that host a primary or `failover` replica). Promote / DR / auto-failover journal in `recovery`; detection is unsolicited `managed-ha-event`. All status reads are Postgres-backed (`GET …/managed/status` includes `error` when status is `failed`); engine logs use cell `managed-logs-request`. Container stdout uses the same correlated cell round trip (`docker container logs` on demand) and is never stored |
| **Bindings**                      | `src/client/bindings/`                              | Managed DB principal → compose service materialization of service-scoped `variable` rows (`binding_id`); ride existing `environment.deploy` inject rail; no new command type                                                                                                                                                                                                                                                                                     |
| **Client API routes**             | `src/client/AGENTS.md`                              | Per-endpoint permission contract for the `/api/client/v1/*` surface: access/permission endpoints + the full resource-tree CRUD table (moved from `src/lib/db/AGENTS.md`)                                                                                                                                                                                                                                                                                          |
| **Authentication**                | `src/client/authn/AGENTS.md`                        | Argon2id, sessions, PAM install gate, secret keyring + data encryption, daemon key JWT, auth routes                                                                                                                                                                                                                                                                                                                                                              |
| **CI analysis & coverage**        | `scripts/AGENTS.md`                                 | SonarCloud CI job, Vitest+Deno LCOV merge (`test-coverage.sh`), **`pnpm check:test-inventory`** (every `*.test.ts` claimed by exactly one runner), analysis-scope rules, coverage-attribution traps                                                                                                                                                                                                                                                                                                                                                  |
| **System components**             | `src/client/system/AGENTS.md`                       | Self-host platform component inventory (`container`-tracked vs host-native), container name suffix contract |
| **OpenAPI & Scalar**              | `src/client/openapi/AGENTS.md`                      | Hand-authored specs per surface, Scalar embeds, CPD exclusion |
| **Client route contract**         | `src/client/routes-contract.md`                     | Per-route method/path/permission table for `/api/client/v1/*` (referenced from `src/client/AGENTS.md`) |
| **Email**                         | `src/lib/email/AGENTS.md`                           | Queue abstraction, RabbitMQ→mailer (Deno) / Mailgun (Workers), settings, OTP surface                                                                                                                                                                                                                                                                                                                                                                             |
| **Database & schema**             | `src/lib/db/AGENTS.md`                              | Drizzle schema, tables, migrations; deploy-tree columns (`container_*`, `service.compose_service_name` + `service.name` label (API `name`), non-partial unique per environment on compose name, `environment.server_id`, `environment.generation`); runtime `deployment` / `slot` (nullable `slot.address`) / `label`; TurboFabric `fabric` / `relay` / `subnet` (compose-bridge, not a datacenter subnet); storage identity `storage` / `copy` / `mount` (+ schema-only `secret`); plus `tag` / `marker` / scheduled `task` |
| **Query cache**                   | `src/query-cache/AGENTS.md`                         | Approved read-only cached `SELECT` models (Hyperdrive cached / Redis read-through)                                                                                                                                                                                                                                                                                                                                                                               |
| **TLS & certificate authorities** | `src/lib/tls/AGENTS.md`                             | Platform CA vs Organization CA boundary, org TLS library primitives, leaf issuance + `leaf` tracking, Workers/Deno renewal sweep |

## Self-host system inventory

Moved to `src/client/system/AGENTS.md` — which platform components are
Postgres/`container`-tracked inventory vs host-native, plus the container name
suffix contract.

## OpenAPI & Scalar

Moved to `src/client/openapi/AGENTS.md`.

## Layout

- `src/app.ts` — shared Hono factory (`/api/health` + client/daemon routers)
- `src/deno.ts` — production Deno entry (`deno-server.ts` + no developer modules)
- `src/deno-dev.ts` — development Deno entry; registers install routes, developer
  surface, `/api/daemon/v1/version`, daemon WS, and the dev update overlay
  (`src/developer/dev-update-overlay.ts` — client update UI resolves trunk from
  the local daemon checkout's `dist/manifest.json` and rebuilds the overlay
  before enqueueing updates, instead of comparing against `dl.trbp.nl`)
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main); registers
  `developer/routes-core` once per isolate
- `scripts/check-workers-bundle.mjs` — Wrangler dry-run of the deploy entrypoint
  (pre-commit / `pnpm check:workers-bundle`)
- `src/lib/machine-key.ts` — machine-key derive/normalize (Workers + Deno; no
  `@std` imports)
- `src/surfaces.ts` — versioned API/WS prefix constants
- `src/openapi.ts` / `src/scalar-html.ts` — hand-authored OpenAPI 3.1 specs +
  Scalar embed HTML
- `src/client/routes.ts` — client REST router; imports `src/client/authn/*` and
  `src/client/authz/*`
- `src/client/authn/` — session, credentials, PAM install gate, license CRUD,
  HTTP auth handlers
- `src/client/authz/` — seven-key permission catalog (`organization:own` /
  `organization:manage`, `team:own` / `team:manage`, `system:read` /
  `system:operate` / `system:manage`), `can`/`listVisible`, grant management.
  Org owner/manager grants never satisfy `system:*`; platform-admin bypass
  covers read/operate but `system:manage` is superadmin-only. Explicit
  `system:manage` grants are rejected at create time and ignored by `can()`.
  `GET /permissions` lists grantable keys only. Organization-wide subject
  grants (`actor_type=organization`) apply to every teammate in that org.
  Mutation routes on workspace-tree entities call `assertNotSystemOwnedOr403`
  after the org check (`403` `system_resource_immutable`); that guard keys on
  **workspace kind**, never on project type. Client workspace responses include
  `workspace.kind` (`user` \| `turbopanel`; `WORKSPACE_KIND_SYSTEM` is only a
  deprecated alias). `project.metadata.type = 'system'` is a
  presentation/classification stamp only — never an authorization source.
- `src/daemon/api-routes.ts` / `src/daemon/deno-ws.ts` /
  `src/daemon/workers-ws.ts` — daemon REST + WS (cell-backed)
- `src/daemon/cell/contracts.ts` — `DaemonCell` interface, `DaemonCellRegistry`,
  DTOs
- `src/daemon/cell/protocol.ts` — `DaemonMessage`, envelope codecs,
  `DAEMON_INBOUND_ALLOWED`, `DAEMON_STALE_MS`
- `src/daemon/cell/do.ts` — `DaemonCellObject` (SQLite-backed Durable Object,
  Workers)
- `src/daemon/cell/do-registry.ts` — `createDurableObjectDaemonCellRegistry`
- `src/daemon/cell/redis/` — `RedisDaemonCell`, `RedisCellClient`,
  `createRedisDaemonCellRegistry` (Deno only)
- `src/daemon/cell/stateless-challenge.ts` — stateless HMAC-signed challenge
  tokens (`DaemonChallengeStore`)
- `src/daemon/cell/location.ts` — `resolveCellLocationHint`,
  `resolveCellGeneration`
- `src/daemon/cell/postgres-projection.ts` — write-through helpers for canonical
  Postgres fields
- `src/daemon/cell/snapshot-merge.ts` — `mergeSnapshotPresence`
- `src/daemon/authn/license.ts` — daemon hello license verification
  (`verifyDaemonLicense`)
- `src/daemon/authn/daemon-jwt.ts` — daemon JWT issue/verify (EdDSA/Ed25519,
  15-minute lifetime)
- `src/daemon/authn/daemon-jwt-keyring.ts` — deterministic Ed25519 keyring
  derived from `TURBOPANEL_SECRET` / `TURBOPANEL_SECRETS`; `deriveDaemonJwtKeyring`,
  `buildJwksDocument`
- `src/daemon/authn/daemon-state.ts` — `ServerDaemonState` / `ServerDaemonKey`
  types and parsers for `server.daemon` jsonb
- `src/daemon/authn/server-identity-db.ts` — DB helpers for `server.daemon`
  (`getServerDaemonStateByServerId`, `attachDaemonStateToServer`,
  `touchDaemonKeyLastUsed`, `revokeDaemonKey`, `clearServerDaemonState`)
- `src/daemon/authn/server-key.ts` — `buildAuthPayload`,
  `computePublicKeyFingerprint`, `verifyDaemonSignature`
- `src/daemon/authz/` — daemon-side authorization placeholder
- `src/lib/db/schema.ts` — Drizzle table definitions (`server`, etc.; see
  `src/lib/db/AGENTS.md`); connection factories stay in `src/db.ts`
- `src/lib/install/routes.ts` — self-hosted install wizard (`/api/install/v1/*`;
  Deno-only registration)
- `src/lib/update/manifest.ts` — Workers-safe trunk manifest resolver
  (`fetch`-only; returns `null` on any failure)
- `src/lib/email/` — shared queue types/templates; `smtp/` (Deno/AMQP) and
  `mailgun/` (Workers) backends
- `src/developer/` — developer surface (Deno-only routes + Workers-safe
  `routes-core.ts`)
- `src/webhook/` — inbound webhook surface (`/webhook/*`). Its own top-level
  directory for the same reason it has its own URL prefix: the caller is a
  provider, not a session or an enrolled daemon. `gate.ts` holds the ordered
  six-step gate every kind runs; `git/` holds the GitHub and GitLab adapters.
  Registered from the entrypoints via `registerWebhookRoutes`, never inside
  `registerClientRoutes`
- `src/admin/routes.ts` — admin surface (`/api/admin/v1`); **now mounted** on
  both runtimes; gated to `superadmin` or `admin` via
  `createAdminAccessMiddleware`; dev-only OpenAPI/Scalar;
  `GET/PUT /instance/public-urls` persists `TURBOPANEL_PUBLIC_URLS` in the
  `setting` table; `GET/PUT /settings/signup` toggles public sign-up via
  `IS_SIGNUP_ENABLED`; superadmin `POST /secrets/reencrypt` runs a bounded
  at-rest re-encrypt sweep onto the current data-encryption key version
  (`src/admin/reencrypt-secrets.ts` — resume via `cursor` until `completed`;
  durable `REENCRYPT_SWEEP_LOCK` setting lease across isolates; **409**
  `reencrypt_in_progress` when another sweep holds the lease).
- `src/resource-routes.ts` — workspace/environment/project/service/hosting CRUD
- `src/server-paths.ts` / `src/server-registry.ts` — Unix socket path + daemon
  server row resolution
