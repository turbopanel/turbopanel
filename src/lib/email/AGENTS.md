# Email — AGENTS.md

The shared queue abstraction and provider backends: Deno publishes to RabbitMQ for the `mailer/` consumer; Workers send directly to Mailgun. Covers settings-driven configuration (`TURBOPANEL_SYSTEM_EMAIL__*`), mailer throttling/prefetch, and the OTP email surface.

Root context: `../../../AGENTS.md`.

## Email

The `src/lib/email/` module defines a queue abstraction (`EmailQueue`, `EmailJob`, `getEmailQueue`) shared by both runtimes. Job types: `signup-verification`, `email-otp`, and `server-tier-notice` (hosted license-tier nag from `src/lib/tiers/tier-notice-sweep.ts`). Every sender switch (`mailgun/send.ts`, `mailpit/send.ts`, `mailer/smtp-sender.ts`, `mailer/mailgun-sender.ts`, `mailer/mailpit-sender.ts`) must handle a new type or the job is dropped.

### Deno vs Workers paths

- **Deno (self-hosted)** — always publishes email jobs through RabbitMQ via `src/lib/email/smtp/deno-amqp-queue.ts`. The Deno instance itself does not deliver email — it only publishes to RabbitMQ; the **`mailer/`** consumer (`turbopanel-mailer.service`) handles delivery. The mailer is installed by the `instance-launch` role in both dev and managed installs. When the broker is unreachable (or `TURBOPANEL_AMQP_URL` is explicitly empty), the instance uses a noop queue — it does not send Mailgun directly from the instance process.
- **Workers** — `src/lib/email/mailgun/workers-queue.ts` (`createWorkersMailgunQueue`) sends directly to Mailgun inside `enqueue` via `sendMailgunJob`. There is no AMQP/RabbitMQ involvement. Cloudflare Workers provides concurrency control, retries, and durability at the platform level, so a queue consumer is unnecessary. Confirmed in `src/workers.ts`: each fetch resolves `resolveWorkersEmailQueue` from the current DB settings + `platformEnv` (not a permanently cached queue) so admin `PUT /api/admin/v1/settings/email` takes effect without a Worker restart.

The **`mailer/`** consumer runs as **`turbopanel-mailer.service`** on both dev and managed hosts (installed by the `instance-launch` role; Deno mode only). See "Deno mailer throttling and prefetch" below for rate/burst/prefetch behavior.

- **Deno instance** — publishes jobs to RabbitMQ via AMQP. In dev, Ansible injects `TURBOPANEL_SYSTEM_EMAIL__PROVIDER=smtp`, `TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST=127.0.0.1`, and `TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT=1025` so the instance can resolve the `from` address and SMTP config without any DB configuration.
- **Mailer worker (`turbopanel-mailer.service`)** — in dev, Ansible injects `TURBOPANEL_SYSTEM_EMAIL__PROVIDER=mailpit` and `MAILPIT_API_URL=http://127.0.0.1:8025`, so the mailer uses `MailerMailpitSender` (Mailpit HTTP API) — **no SMTP installation required on the worker platform**. In production, uses `smtp` or `mailgun` from DB/env settings.

| Variable | Runtime | Purpose |
|---|---|---|
| `TURBOPANEL_AMQP_URL` | Deno | RabbitMQ connection URL (from `/etc/turbopanel/rabbitmq/.rabbitmq_pass`; dev RabbitMQ listens on `127.0.0.1:5672`) |
| `TURBOPANEL_DATABASE_URL` | Deno mailer | Postgres for DB-backed SMTP settings (`setting` table); same URL as the instance |
| `TURBOPANEL_REDIS_SOCKET` | Deno | Unix socket path used by the Daemon Cell Redis backend (`src/daemon/cell/redis/client.ts`); default `/run/turbopanel/redis.sock` |
| `TURBOPANEL_BASE_URL` | Deno | Public base URL for verification links (falls back to request origin) |
| `TURBOPANEL_SYSTEM_EMAIL__PROVIDER` | Deno instance (dev) / Deno mailer (dev) | Injected by Ansible in dev: `smtp` on the instance unit (SMTP → Mailpit port 1025); `mailpit` on the mailer unit (Mailpit HTTP API, no SMTP install needed) |
| `TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST` / `TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT` | Deno instance (dev) | Ansible injects Mailpit SMTP host/port into **`turbopanel-instance.service`** so the instance can resolve `from`/SMTP settings when enqueueing to RabbitMQ — the instance does not send over SMTP |
| `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE` | Deno mailer | Token-bucket rate limit (default 60) |
| `MAILPIT_API_URL` | Deno mailer (dev) | Mailpit HTTP API base URL (e.g. `http://127.0.0.1:8025`); used by the `mailpit` provider sender in `mailer/mailpit-sender.ts`; falls back to `http://127.0.0.1:${MAILPIT_WEB_PORT ?? 8025}` |
| `MAILPIT_SMTP_PORT` | Deno mailer | Mailpit SMTP port used as fallback when no SMTP config (default 1025) |

### Settings-driven configuration (`TURBOPANEL_SYSTEM_EMAIL__*`)

Email behavior is configured via the hierarchical settings system under the `TURBOPANEL_SYSTEM_EMAIL` prefix. Full keys use a double-underscore separator:

```
TURBOPANEL_SYSTEM_EMAIL__<SHORT_KEY>
```

Examples: `TURBOPANEL_SYSTEM_EMAIL__PROVIDER`, `TURBOPANEL_SYSTEM_EMAIL__FROM`, `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE`.

**Env-wins semantics**: when a `TURBOPANEL_SYSTEM_EMAIL__*` env var is present and non-empty, it takes precedence over any DB value and the default. DB values are only used when no overriding env var is set. The admin UI reflects this (env-overridden secrets are hidden; DB secrets are masked).

**DB storage (self-hosted):** email settings are persisted as a single `setting` row with `key = 'SYSTEM_EMAIL'` and `value` as a JSON object (e.g. `{ "PROVIDER": "smtp", "FROM": "noreply@turbopanel.local" }`). Short keys match `EMAIL_SETTING_SHORT_KEYS` in `src/lib/settings/email-settings.ts`. When env vars (`TURBOPANEL_SYSTEM_EMAIL__*`) override all keys, the `SYSTEM_EMAIL` row may remain absent — env always wins and the resolver never reads per-key `setting` rows for email.

Short keys and new rate/queue keys (added to `src/lib/settings/email-settings.ts`):

| Short key | Default | Env key | Notes |
|---|----|----|----|
| `PROVIDER` | `smtp` | `TURBOPANEL_SYSTEM_EMAIL__PROVIDER` | `smtp`, `mailgun`, or `mailpit` (dev only — Mailpit HTTP API sender) |
| `FROM` | `noreply@turbopanel.local` | `TURBOPANEL_SYSTEM_EMAIL__FROM` | |
| `MAILGUN_API_KEY` | — | `TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY` | secret |
| `MAILGUN_DOMAIN` | — | `TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN` | |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | `TURBOPANEL_SYSTEM_EMAIL__SMTP_*` | |
| `RATE_LIMIT_PER_MINUTE` | `60` | `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE` | used by the Deno mailer |
| `RATE_LIMIT_BURST` | same as rate | — | max bucket size; see mailer throttling |
| `QUEUE_PREFETCH` | `1` | — | RabbitMQ `channel.prefetch` for the mailer consumer |

The **`mailer/`** consumer resolves settings via `resolveEmailSettings(db, Deno.env.toObject())` with a 30s TTL cache and re-resolves on each consumed message. Without restart, the mailer hot-applies **provider** (swaps the active sender), **rate/burst** (swaps the token bucket), and **prefetch** (re-applies `channel.prefetch`). **FROM**, SMTP/Mailgun credentials, and transport config are re-resolved inside `MailerSmtpSender` / `MailerMailgunSender` / `MailerMailpitSender` on each send.

### Deno mailer throttling and prefetch

The mailer (`mailer/main.ts`) drives a token-bucket `RateLimiter` from the settings:

- `RATE_LIMIT_PER_MINUTE` controls refill rate (tokens per minute).
- `RATE_LIMIT_BURST` controls bucket capacity (defaults to the rate when unset or non-positive). Capacity is the burst value itself — it may be lower than the refill rate.
- `QUEUE_PREFETCH` is applied via `channel.prefetch(...)` at startup and again when the resolved value changes (default 1).

On each consumed message the mailer re-resolves (cached) and, if rate or burst changed, swaps the limiter while preserving as many in-flight tokens as the new capacity allows.

### OTP email surface

Client authentication supports one-time passcodes (OTPs) for sign-in, email verification, and password reset flows. OTPs are generated and verified by `src/client/authn/email-otp.ts` and surfaced via `src/client/authn/otp-http.ts` (mounted under the client auth router):

- `POST /api/client/v1/auth/send-otp` — create + enqueue an `email-otp` job
- `POST /api/client/v1/auth/verify-otp` — verify an OTP (does not consume by default in some flows)
- `POST /api/client/v1/auth/sign-in/otp` — verify OTP and establish a session (sign-in)
- `POST /api/client/v1/auth/verify-email/otp` — verify email ownership OTP
- `POST /api/client/v1/auth/reset-password/request-otp` — create a `forget-password` OTP and enqueue
- `POST /api/client/v1/auth/reset-password/otp` — verify OTP and set a new password

These endpoints enqueue `EmailJob` payloads of type `email-otp` (with `otpType`: `sign-in` | `email-verification` | `forget-password`). On Deno, the mailer delivers them via the configured provider; on Workers, delivery is direct via Mailgun (or noop when provider is SMTP).

