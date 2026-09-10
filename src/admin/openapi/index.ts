import { resolveSessionCookieNameFromUrl } from "../../client/authn/crypto.ts";
import { ADMIN_API_PREFIX } from "../../surfaces.ts";

const cookieSecurity = [{ cookieAuth: [] }] as const;

/** Hand-authored OpenAPI 3.1 spec for documented admin REST routes. */
export function getAdminOpenApiSpec(
  serverUrl: string,
  _opts?: { devSurface?: boolean; runtime?: "deno" | "workers" },
): object {
  const sessionCookieName = resolveSessionCookieNameFromUrl(serverUrl);

  return {
    openapi: "3.1.0",
    info: {
      title: "TurboPanel Admin API",
      version: "0.1.0",
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: "Instance", description: "Control-plane instance configuration" },
      { name: "Settings", description: "System settings (email, etc.)" },
      { name: "Daemon Fleet", description: "Fleet-wide daemon management" },
    ],
    "x-tagGroups": [
      { name: "Instance", tags: ["Instance", "Settings"] },
      { name: "Fleet", tags: ["Daemon Fleet"] },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: sessionCookieName,
        },
      },
      schemas: {
        PublicUrlsResponse: {
          type: "object",
          required: ["ok", "urls"],
          properties: {
            ok: { type: "boolean", const: true },
            urls: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        PublicUrlsPutBody: {
          type: "object",
          required: ["urls"],
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        PublicUrlsPutResponse: {
          type: "object",
          required: ["ok", "urls", "applied"],
          properties: {
            ok: { type: "boolean", const: true },
            urls: {
              type: "array",
              items: { type: "string" },
            },
            applied: { type: "boolean", const: false },
          },
        },
        PublicUrlsValidationError: {
          type: "object",
          required: ["ok", "error", "invalid"],
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string" },
            invalid: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        PublicUrlsApplyBody: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        PublicUrlsApplyResponse: {
          type: "object",
          required: ["ok", "applied"],
          properties: {
            ok: { type: "boolean" },
            applied: { type: "boolean" },
            error: { type: "string" },
          },
        },
        PublicUrlsApplyUnavailable: {
          type: "object",
          required: ["ok", "error"],
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string" },
          },
        },
        EmailSettingEntry: {
          type: "object",
          required: ["value", "source"],
          properties: {
            value: { type: "string", nullable: true },
            source: { type: "string", enum: ["env", "db", "default"] },
          },
        },
        EmailSettingsResponse: {
          type: "object",
          required: ["settings"],
          properties: {
            settings: {
              type: "object",
              additionalProperties: {
                $ref: "#/components/schemas/EmailSettingEntry",
              },
            },
          },
        },
        EmailSettingsPutBody: {
          type: "object",
          additionalProperties: { type: "string", nullable: true },
        },
        CellPurgeBatchBody: {
          type: "object",
          required: ["serverIds"],
          properties: {
            serverIds: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
          },
        },
        CellPurgeResponse: {
          type: "object",
          required: ["ok", "serverId", "purged"],
          properties: {
            ok: { type: "boolean", const: true },
            serverId: { type: "string" },
            purged: { type: "boolean", const: true },
          },
        },
        CellPurgeErrorResponse: {
          type: "object",
          required: ["ok", "error"],
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string" },
          },
        },
        CellPurgeBatchResponse: {
          type: "object",
          required: ["ok", "results"],
          properties: {
            ok: { type: "boolean", const: true },
            results: {
              type: "array",
              items: {
                type: "object",
                required: ["serverId", "ok"],
                properties: {
                  serverId: { type: "string" },
                  ok: { type: "boolean" },
                  error: { type: "string" },
                },
              },
            },
          },
        },
        Forge: {
          type: "object",
          description:
            "A registered Git provider application. Sealed material (App private " +
            "key, OAuth client secret, webhook secret) is never returned — only " +
            "its presence is reported.",
          required: [
            "id",
            "organizationId",
            "provider",
            "name",
            "baseUrl",
            "externalAppId",
            "webhookRef",
            "webhookPath",
            "readOnly",
            "hasPrivateKey",
            "hasClientSecret",
            "hasWebhookSecret",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            organizationId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
              description:
                "null = instance-wide: every organization may connect through it. " +
                "A uuid means the app belongs to that organization alone.",
            },
            provider: { type: "string", enum: ["github", "gitlab"] },
            name: { type: "string" },
            baseUrl: {
              type: "string",
              description:
                "Origin the app lives on — github.com / gitlab.com, or a GitHub " +
                "Enterprise Server or self-managed GitLab. Part of the uniqueness " +
                "key, because a provider app id is unique per origin, not globally.",
            },
            apiUrl: {
              oneOf: [{ type: "string" }, { type: "null" }],
              description: "Explicit API origin; derived from baseUrl when null",
            },
            externalAppId: {
              type: "string",
              description:
                "Provider-side id. For GitHub the numeric App id that arrives as " +
                "X-GitHub-Hook-Installation-Target-ID; for GitLab the application id.",
            },
            appSlug: { oneOf: [{ type: "string" }, { type: "null" }] },
            clientId: { oneOf: [{ type: "string" }, { type: "null" }] },
            redirectUri: { oneOf: [{ type: "string" }, { type: "null" }] },
            webhookRef: {
              type: "string",
              description:
                "Opaque routing token in this app's webhook URL. Not a credential " +
                "— the HMAC (GitHub) or token compare (GitLab) still authenticates.",
            },
            webhookPath: {
              type: "string",
              description: "Ingress path this app's deliveries should arrive on",
            },
            webhookUrl: {
              oneOf: [{ type: "string" }, { type: "null" }],
              description:
                "Absolute delivery URL; null when no public origin is configured",
            },
            readOnly: {
              type: "boolean",
              description:
                "True for an instance-wide app viewed from an organization: " +
                "visible and usable, but only an instance admin may edit it.",
            },
            hasPrivateKey: { type: "boolean" },
            hasClientSecret: { type: "boolean" },
            hasWebhookSecret: { type: "boolean" },
          },
        },
        ForgeListResponse: {
          type: "object",
          required: ["apps"],
          properties: {
            apps: { type: "array", items: { $ref: "#/components/schemas/Forge" } },
          },
        },
        ForgeResponse: {
          type: "object",
          required: ["app"],
          properties: { app: { $ref: "#/components/schemas/Forge" } },
        },
        ForgeCreateBody: {
          type: "object",
          required: ["provider", "name", "externalAppId"],
          properties: {
            provider: { type: "string", enum: ["github", "gitlab"] },
            name: { type: "string", minLength: 1 },
            externalAppId: { type: "string", minLength: 1 },
            baseUrl: {
              type: "string",
              description: "Defaults to the provider's public origin when omitted",
            },
            apiUrl: { oneOf: [{ type: "string" }, { type: "null" }] },
            appSlug: { oneOf: [{ type: "string" }, { type: "null" }] },
            clientId: { oneOf: [{ type: "string" }, { type: "null" }] },
            redirectUri: { oneOf: [{ type: "string" }, { type: "null" }] },
            privateKeyPem: {
              oneOf: [{ type: "string" }, { type: "null" }],
              description: "GitHub App private key. Sealed before persist, never returned.",
            },
            clientSecret: {
              oneOf: [{ type: "string" }, { type: "null" }],
              description: "GitLab OAuth application secret. Sealed before persist.",
            },
            webhookSecret: {
              oneOf: [{ type: "string" }, { type: "null" }],
              description:
                "GitHub HMAC secret, or the GitLab X-Gitlab-Token value. GitLab " +
                "does not sign deliveries, so for GitLab this is the whole " +
                "credential and is subject to a minimum length.",
            },
          },
        },
        ForgePatchBody: {
          type: "object",
          description:
            "Partial update — omitted keys keep their stored value, so a PATCH that " +
            "omits privateKeyPem keeps the sealed one. Send null to clear a " +
            "nullable field. provider and organizationId are immutable.",
          properties: {
            name: { type: "string", minLength: 1 },
            externalAppId: { type: "string", minLength: 1 },
            baseUrl: { type: "string", minLength: 1 },
            apiUrl: { oneOf: [{ type: "string" }, { type: "null" }] },
            appSlug: { oneOf: [{ type: "string" }, { type: "null" }] },
            clientId: { oneOf: [{ type: "string" }, { type: "null" }] },
            redirectUri: { oneOf: [{ type: "string" }, { type: "null" }] },
            privateKeyPem: { oneOf: [{ type: "string" }, { type: "null" }] },
            clientSecret: { oneOf: [{ type: "string" }, { type: "null" }] },
            webhookSecret: { oneOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        GithubManifestStartBody: {
          type: "object",
          properties: {
            name: { type: "string", description: "App name shown on GitHub" },
            baseUrl: {
              type: "string",
              description: "GitHub Enterprise Server origin; defaults to github.com",
            },
            organizationLogin: {
              oneOf: [{ type: "string" }, { type: "null" }],
              description:
                "Create the App under this GitHub organization rather than the " +
                "acting user's account, so it belongs to the org.",
            },
          },
        },
        GithubManifestStartResponse: {
          type: "object",
          required: ["manifest", "createUrl", "state"],
          properties: {
            manifest: {
              type: "object",
              description:
                "POST this to createUrl as form field `manifest`. Its " +
                "hook_attributes.url already points at the new app's scoped " +
                "webhook path, so the App is born self-identifying.",
            },
            createUrl: { type: "string" },
            state: {
              type: "string",
              description:
                "Signed state carrying the pending webhook ref, origin and name",
            },
          },
        },
        SecretsReencryptCursor: {
          type: "object",
          required: ["stage"],
          properties: {
            stage: {
              type: "string",
              enum: [
                "variables",
                "tls",
                "principals",
                "storage",
                "secrets",
                "email",
              ],
            },
            afterId: {
              type: "string",
              description:
                "Last processed row id within the stage (resume exclusive lower bound)",
            },
          },
        },
        SecretsReencryptResponse: {
          type: "object",
          required: [
            "ok",
            "scanned",
            "reencrypted",
            "skipped",
            "failed",
            "completed",
            "cursor",
          ],
          properties: {
            ok: { type: "boolean", const: true },
            scanned: { type: "integer" },
            reencrypted: { type: "integer" },
            skipped: { type: "integer" },
            failed: { type: "integer" },
            completed: {
              type: "boolean",
              description:
                "True when the sweep finished; otherwise resume with `cursor`",
            },
            cursor: {
              oneOf: [
                { $ref: "#/components/schemas/SecretsReencryptCursor" },
                { type: "null" },
              ],
            },
          },
        },
      },
    },
    paths: {
      [`${ADMIN_API_PREFIX}/instance/public-urls`]: {
        get: {
          tags: ["Instance"],
          summary: "List configured public URLs",
          security: [...cookieSecurity],
          responses: {
            "200": {
              description: "Persisted public URL entries",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicUrlsResponse" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
          },
        },
        put: {
          tags: ["Instance"],
          summary: "Persist public URL entries",
          security: [...cookieSecurity],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicUrlsPutBody" },
              },
            },
          },
          responses: {
            "200": {
              description: "URLs persisted (apply step not run)",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/PublicUrlsPutResponse",
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "422": {
              description: "One or more URL entries failed validation",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/PublicUrlsValidationError",
                  },
                },
              },
            },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/forges`]: {
        get: {
          tags: ["Git apps"],
          summary: "List instance-wide Git provider applications",
          description:
            "Instance-wide apps only: this surface is role-gated and carries no " +
            "organization context. An organization's own apps are managed through " +
            "the client surface at /api/client/v1/forges.",
          security: [...cookieSecurity],
          responses: {
            "200": {
              description: "Registered instance-wide apps",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ForgeListResponse" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "503": { description: "Database unavailable" },
          },
        },
        post: {
          tags: ["Git apps"],
          summary: "Register an instance-wide Git provider application",
          description:
            "Registers an existing GitHub App or GitLab OAuth application from " +
            "credentials you already hold. To have GitHub create one for you — " +
            "with the correct scoped webhook URL already set — use the manifest " +
            "flow instead. Several apps per provider may coexist.",
          security: [...cookieSecurity],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForgeCreateBody" },
              },
            },
          },
          responses: {
            "201": {
              description: "The registered app",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ForgeResponse" },
                },
              },
            },
            "400": { description: "Invalid request body, or a rejected field" },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "503": {
              description:
                "Database unavailable, or no encryption key configured to seal the secrets",
            },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/forges/{id}`]: {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        get: {
          tags: ["Git apps"],
          summary: "Read one instance-wide Git provider application",
          security: [...cookieSecurity],
          responses: {
            "200": {
              description: "The app",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ForgeResponse" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "404": { description: "Not found" },
          },
        },
        patch: {
          tags: ["Git apps"],
          summary: "Update one instance-wide Git provider application",
          security: [...cookieSecurity],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForgePatchBody" },
              },
            },
          },
          responses: {
            "200": {
              description: "The updated app",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ForgeResponse" },
                },
              },
            },
            "400": { description: "Invalid request body, or a rejected field" },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "404": { description: "Not found" },
          },
        },
        delete: {
          tags: ["Git apps"],
          summary: "Delete one instance-wide Git provider application",
          description:
            "Cascades to the installations granted through it. Sources that " +
            "referenced those installations survive but lose their clone " +
            "credential and must be reconnected.",
          security: [...cookieSecurity],
          responses: {
            "204": { description: "Deleted" },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "404": { description: "Not found" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/forges/{id}/sync`]: {
        post: {
          tags: ["Git apps"],
          summary: "Reconcile an app against GitHub's own record of it",
          description:
            "Reads `GET /app` with the App JWT and updates the stored name, " +
            "slug, app id and visibility. An operator can rename an App on " +
            "GitHub and nothing announces it — and a stale slug is not " +
            "cosmetic, it builds the install URL.",
          security: [...cookieSecurity],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "The reconciled app",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ForgeResponse" },
                },
              },
            },
            "400": { description: "Not a GitHub app" },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "404": { description: "Not found" },
            "502": { description: "GitHub refused the lookup" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/forges/github/manifest`]: {
        post: {
          tags: ["Git apps"],
          summary: "Start the GitHub App Manifest flow",
          description:
            "Returns a manifest to POST to GitHub, which creates the App and " +
            "redirects back with a code. The manifest's hook_attributes.url is " +
            "already the new app's scoped webhook path, so deliveries identify " +
            "their app from the first one onward.",
          security: [...cookieSecurity],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GithubManifestStartBody" },
              },
            },
          },
          responses: {
            "200": {
              description: "Manifest, target URL, and signed state",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/GithubManifestStartResponse",
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "503": {
              description: "No public URL configured, or no root secret to sign the state",
            },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/forges/github/manifest/callback`]: {
        get: {
          tags: ["Git apps"],
          summary: "Finish the GitHub App Manifest flow",
          description:
            "Exchanges GitHub's one-shot code for the App id, private key, " +
            "webhook secret and client credentials, stores them as an " +
            "instance-wide app, then 302s the operator's browser back to " +
            "/admin/git.",
          security: [...cookieSecurity],
          parameters: [
            {
              name: "code",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "state",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "302": {
              description: "Redirect to /admin/git with created= or error=",
            },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/settings/email`]: {
        get: {
          tags: ["Settings"],
          summary: "Read resolved email settings",
          security: [...cookieSecurity],
          responses: {
            "200": {
              description: "Email settings with source metadata",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/EmailSettingsResponse",
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "503": { description: "Database unavailable" },
          },
        },
        put: {
          tags: ["Settings"],
          summary: "Persist email settings to the database",
          description:
            "Env-overridden keys are accepted but ignored. Secret values from env are never returned. " +
            "Send null for a key to clear a database-backed value and revert to defaults.",
          security: [...cookieSecurity],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EmailSettingsPutBody" },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated settings",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/EmailSettingsResponse",
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "503": { description: "Database unavailable" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/instance/public-urls/apply`]: {
        post: {
          tags: ["Instance"],
          summary:
            "Apply public URLs to co-located daemon (cert regen + Caddy reload)",
          description:
            "Deno only. Sends a public-urls-update WS message to the co-located daemon. " +
            "Optional body persists URLs before apply. Workers returns 422.",
          security: [...cookieSecurity],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicUrlsApplyBody" },
              },
            },
          },
          responses: {
            "200": {
              description: "URLs applied on the co-located host",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/PublicUrlsApplyResponse",
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "401": { description: "Unauthorized" },
            "403": {
              description: "Forbidden — requires admin or superadmin role",
            },
            "422": {
              description:
                "Validation failure or Workers runtime (cert apply not applicable)",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      {
                        $ref: "#/components/schemas/PublicUrlsValidationError",
                      },
                      {
                        $ref: "#/components/schemas/PublicUrlsApplyUnavailable",
                      },
                    ],
                  },
                },
              },
            },
            "500": {
              description: "Daemon reported failure or apply timed out",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/PublicUrlsApplyResponse",
                  },
                },
              },
            },
            "503": {
              description: "Co-located daemon not connected",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/PublicUrlsApplyUnavailable",
                  },
                },
              },
            },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/connections`]: {
        get: {
          tags: ["Daemon Fleet"],
          summary: "List connected daemons",
          security: [...cookieSecurity],
          responses: {
            "200": { description: "Online daemon connections" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/events`]: {
        get: {
          tags: ["Daemon Fleet"],
          summary: "Collect recent daemon events across the fleet",
          security: [...cookieSecurity],
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": { description: "Fleet event log entries" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/commands`]: {
        get: {
          tags: ["Daemon Fleet"],
          summary: "Collect recent daemon commands across the fleet",
          security: [...cookieSecurity],
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": { description: "Fleet command history" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/broadcast`]: {
        post: {
          tags: ["Daemon Fleet"],
          summary: "Broadcast a payload to all connected daemons",
          security: [...cookieSecurity],
          responses: {
            "200": { description: "Broadcast accepted" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/instance/addresses`]: {
        get: {
          tags: ["Instance"],
          summary: "Collect instance network addresses",
          description:
            "Deno only. Workers returns 422 with an empty address payload.",
          security: [...cookieSecurity],
          responses: {
            "200": { description: "Instance address summary" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
            "422": { description: "Not available on Workers runtime" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/addresses`]: {
        get: {
          tags: ["Daemon Fleet"],
          summary: "Collect network addresses from all connected daemons",
          security: [...cookieSecurity],
          responses: {
            "200": { description: "Per-daemon address summaries" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/cells/purge-batch`]: {
        post: {
          tags: ["Daemon Fleet"],
          summary: "Purge daemon cells for multiple server IDs",
          description:
            "Works even when Postgres server rows are already deleted (orphaned cells). " +
            "Per-id failures are reported in the results array.",
          security: [...cookieSecurity],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CellPurgeBatchBody" },
              },
            },
          },
          responses: {
            "200": {
              description: "Batch purge completed",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CellPurgeBatchResponse",
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "401": { description: "Unauthorized" },
            "403": { description: "Superadmin access required" },
            "503": { description: "Daemon cell registry unavailable" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/cells/{serverId}/purge`]: {
        post: {
          tags: ["Daemon Fleet"],
          summary: "Purge a single daemon cell by server ID",
          description:
            "Works even when the Postgres server row is already deleted (orphaned test-server DOs).",
          security: [...cookieSecurity],
          parameters: [
            {
              name: "serverId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Cell purged",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CellPurgeResponse" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Superadmin access required" },
            "500": {
              description: "Purge failed",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CellPurgeErrorResponse",
                  },
                },
              },
            },
            "503": { description: "Daemon cell registry unavailable" },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/secrets/reencrypt`]: {
        post: {
          tags: ["Instance"],
          summary: "Re-encrypt at-rest secrets to the current key version",
          description:
            "Bounded sweep over secret variables, TLS private keys, principal passwords, " +
            "and SYSTEM_EMAIL secret keys. Re-seals older-version `tpsecret` blobs; skips " +
            "current-version `tpsecret` and valid `tpdaemon` delivery envelopes; fails " +
            "plaintext or malformed material. Pass the previous `cursor` to resume until " +
            "`completed` is true. Concurrent sweeps return 409 `reencrypt_in_progress` " +
            "(durable `setting`-row lease across Workers isolates and Deno processes).",
          security: [...cookieSecurity],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    cursor: {
                      $ref: "#/components/schemas/SecretsReencryptCursor",
                    },
                    limit: {
                      type: "integer",
                      minimum: 1,
                      description:
                        "Max blobs to scan this call (capped server-side)",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Sweep batch finished (check `completed` / `cursor` for resume)",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/SecretsReencryptResponse",
                  },
                },
              },
            },
            "400": { description: "Invalid cursor or limit" },
            "401": { description: "Unauthorized" },
            "403": { description: "Superadmin access required" },
            "409": {
              description: "Another re-encryption sweep is already in progress",
            },
            "503": { description: "Database or encryption unavailable" },
          },
        },
      },
    },
  };
}
