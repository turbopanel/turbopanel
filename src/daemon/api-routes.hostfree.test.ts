import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { deriveSecretsConfig } from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import { parseTestSecretsConfig } from "../test-fixtures/secrets.ts";
import { DAEMON_API_PREFIX } from "../surfaces.ts";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  MAX_AUTH_CHALLENGE_BODY_BYTES,
  MAX_AUTH_SESSION_BODY_BYTES,
  MAX_ENROLL_BODY_BYTES,
  registerDaemonApiRoutes,
} from "./api-routes.ts";
import { MAX_METRICS_PAYLOAD_BYTES } from "./metrics/validation.ts";
import { createFailClosedRateLimiter } from "./rate-limit/contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function daemonApp(
  options: Parameters<typeof registerDaemonApiRoutes>[1] = {},
  db?: Db,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (db) {
    app.use("*", (c, next) => {
      c.set("db", db);
      return next();
    });
  }
  registerDaemonApiRoutes(app, options);
  return app;
}

test("daemon docs and JWKS stay host-free", async () => {
  const bare = daemonApp();
  const missingJwks = await bare.request(`${DAEMON_API_PREFIX}/jwks.json`);
  assertEquals(missingJwks.status, 503);

  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const app = daemonApp({ secrets: keyring });
  const jwks = await app.request(`${DAEMON_API_PREFIX}/jwks.json`);
  assertEquals(jwks.status, 200);
  const document = await jwks.json() as { keys: Array<{ kty: string }> };
  if (!Array.isArray(document.keys)) throw new TypeError("expected JWKS keys");
  assertEquals(document.keys.length > 0, true);

  const spec = await app.request(`${DAEMON_API_PREFIX}/openapi.json`);
  assertEquals(spec.status, 200);
  const reference = await app.request(`${DAEMON_API_PREFIX}/reference`);
  assertEquals(reference.status, 200);
  assertEquals((await reference.text()).includes("html"), true);
});

test("readiness, enroll, and session fail closed without a database", async () => {
  const app = daemonApp();
  assertEquals((await app.request(`${DAEMON_API_PREFIX}/readiness`)).status, 503);
  assertEquals(
    (await app.request(`${DAEMON_API_PREFIX}/enroll`, { method: "POST" })).status,
    503,
  );
  assertEquals(
    (await app.request(`${DAEMON_API_PREFIX}/auth/session`, { method: "POST" }))
      .status,
    503,
  );
});

test("anonymous challenge is unavailable without a signing store", async () => {
  const app = daemonApp();
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-length": "0" },
  });
  assertEquals(response.status, 503);
});

test("anonymous challenge is rate-limited before the store is consulted", async () => {
  const app = daemonApp({ restLimiter: createFailClosedRateLimiter() });
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-length": "0" },
  });
  assertEquals(response.status, 429);
});

test("anonymous challenge issues a token from the stateless store", async () => {
  const challengeSigningSecrets = await deriveSecretsConfig(
    parseTestSecretsConfig(),
    "daemon-challenge-signing",
  );
  const app = daemonApp({ challengeSigningSecrets });
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-length": "0" },
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { challengeId?: unknown };
  if (typeof body.challengeId !== "string") {
    throw new TypeError("expected challengeId");
  }
});

test("auth challenge with only serverId does not query the database", async () => {
  const app = daemonApp();
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverId: "00000000-0000-4000-8000-000000000001" }),
  });
  assertEquals(response.status, 400);
});

test("JWT-protected lease rejects a missing bearer and accepts a signed token", async () => {
  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const app = daemonApp({ secrets: keyring });
  const unauthorized = await app.request(`${DAEMON_API_PREFIX}/commands/lease`, {
    method: "POST",
  });
  assertEquals(unauthorized.status, 401);

  const issued = await issueDaemonJwt(
    { sub: "00000000-0000-4000-8000-0000000000aa", kid: "key-1" },
    keyring,
  );
  const leased = await app.request(`${DAEMON_API_PREFIX}/commands/lease`, {
    method: "POST",
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  assertEquals(leased.status, 200);
  const body = await leased.json() as { commands?: unknown };
  assertEquals(body.commands, []);
});

test("enroll and session field parsers stay host-free with a stub db", async () => {
  const db = {} as Db;
  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const app = daemonApp({ secrets: keyring }, db);

  const missingLicense = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(missingLicense.status, 401);

  const missingFields = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      licenseId: "lic-1",
      licenseToken: "tok-1",
    }),
  });
  assertEquals(missingFields.status, 400);

  const invalidMachineKey = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      licenseId: "lic-1",
      licenseToken: "tok-1",
      hostname: "host-1",
      challengeId: "chal-1",
      signature: "sig-1",
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
      machineKey: "not-a-machine-key",
    }),
  });
  assertEquals(invalidMachineKey.status, 400);

  const missingSession = await app.request(`${DAEMON_API_PREFIX}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(missingSession.status, 400);

  const invalidSessionKey = await app.request(
    `${DAEMON_API_PREFIX}/auth/session`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverId: "00000000-0000-4000-8000-0000000000aa",
        keyId: "key-1",
        challengeId: "chal-1",
        signature: "sig-1",
        hostname: "host-1",
        machineKey: "not-a-machine-key",
      }),
    },
  );
  assertEquals(invalidSessionKey.status, 400);
});

const VALID_MACHINE_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const FULL_ENROLL_BODY = {
  licenseId: "lic-1",
  licenseToken: "tok-1",
  hostname: "host-1",
  challengeId: "chal-1",
  signature: "sig-1",
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  machineKey: VALID_MACHINE_KEY,
};

async function jwtDaemonApp(
  options: Parameters<typeof registerDaemonApiRoutes>[1] = {},
  db?: Db,
): Promise<{
  app: Hono<AppEnv>;
  token: string;
  serverId: string;
}> {
  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const serverId = "00000000-0000-4000-8000-0000000000aa";
  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-1" },
    keyring,
  );
  return {
    app: daemonApp({ ...options, secrets: keyring }, db),
    token: issued.token,
    serverId,
  };
}

test("POST /auth/session fails closed without a JWT keyring", async () => {
  const app = daemonApp({}, {} as Db);
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      serverId: "00000000-0000-4000-8000-0000000000aa",
      keyId: "key-1",
      challengeId: "chal-1",
      signature: "sig-1",
      hostname: "host-1",
      machineKey: VALID_MACHINE_KEY,
    }),
  });
  assertEquals(response.status, 503);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "Daemon auth unavailable");
});

test("POST /enroll fails closed without a challenge store", async () => {
  const app = daemonApp({}, {} as Db);
  const response = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FULL_ENROLL_BODY),
  });
  assertEquals(response.status, 503);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "Challenge unavailable");
});

test("POST /enroll treats malformed JSON as an invalid license", async () => {
  const app = daemonApp({}, {} as Db);
  const response = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assertEquals(response.status, 401);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "Invalid license");
});

test("JWT metrics ingest rejects invalid JSON without a database", async () => {
  const { app, token } = await jwtDaemonApp();
  const response = await app.request(`${DAEMON_API_PREFIX}/metrics`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{not-json",
  });
  assertEquals(response.status, 400);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "invalid metrics payload");
});

test("JWT secrets decrypt fails closed without secretsConfig", async () => {
  const { app, token } = await jwtDaemonApp();
  const response = await app.request(`${DAEMON_API_PREFIX}/secrets/decrypt`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ciphertexts: ["tpsecret.v1.x"] }),
  });
  assertEquals(response.status, 503);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "decryption unavailable");
});

test("JWT secrets decrypt rejects malformed and empty ciphertext batches", async () => {
  const { app, token } = await jwtDaemonApp({
    secretsConfig: parseTestSecretsConfig(),
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  const invalidJson = await app.request(`${DAEMON_API_PREFIX}/secrets/decrypt`, {
    method: "POST",
    headers,
    body: "{not-json",
  });
  assertEquals(invalidJson.status, 400);
  assertEquals(
    (await invalidJson.json() as { error?: unknown }).error,
    "invalid json",
  );

  const notArray = await app.request(`${DAEMON_API_PREFIX}/secrets/decrypt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ciphertexts: "tpsecret.v1.x" }),
  });
  assertEquals(notArray.status, 400);
  assertEquals(
    (await notArray.json() as { error?: unknown }).error,
    "ciphertexts must be an array",
  );

  const empty = await app.request(`${DAEMON_API_PREFIX}/secrets/decrypt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ciphertexts: [] }),
  });
  assertEquals(empty.status, 400);
  const emptyBody = await empty.json() as { error?: unknown };
  if (typeof emptyBody.error !== "string") {
    throw new TypeError("expected decrypt length error");
  }
  assertEquals(emptyBody.error.includes("ciphertexts length must be"), true);

  const notString = await app.request(`${DAEMON_API_PREFIX}/secrets/decrypt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ciphertexts: [1] }),
  });
  assertEquals(notString.status, 400);
  assertEquals(
    (await notString.json() as { error?: unknown }).error,
    "ciphertexts must be strings",
  );
});

test("JWT secrets rehydrate fails closed without a database", async () => {
  const { app, token } = await jwtDaemonApp();
  const response = await app.request(
    `${DAEMON_API_PREFIX}/deployments/secrets/rehydrate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  assertEquals(response.status, 503);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "database unavailable");
});

test("JWT command log ingest fails closed without an execution log store", async () => {
  const { app, token } = await jwtDaemonApp();
  const response = await app.request(
    `${DAEMON_API_PREFIX}/commands/00000000-0000-7000-8000-0000000000aa/log`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ seq: 0, bytes: btoa("output") }),
    },
  );
  assertEquals(response.status, 503);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "execution logs unavailable");
});

/** Chunked body so Fetch does not attach a truthful Content-Length. */
function oversizedBodyStream(byteLength: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(Math.min(byteLength, 8192));
  chunk.fill(0x78);
  let remaining = byteLength;
  return new ReadableStream({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const n = Math.min(remaining, chunk.byteLength);
      controller.enqueue(chunk.subarray(0, n));
      remaining -= n;
    },
  });
}

async function assertStreaming413(
  response: Response,
): Promise<void> {
  assertEquals(response.status, 413);
  const body = await response.json() as { ok?: unknown; error?: unknown };
  assertEquals(body.ok, false);
  assertEquals(body.error, "request body too large");
}

test("POST /auth/challenge rejects an oversized body without Content-Length", async () => {
  const app = daemonApp();
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedBodyStream(MAX_AUTH_CHALLENGE_BODY_BYTES + 1),
  });
  await assertStreaming413(response);
});

test("POST /enroll rejects an oversized body without Content-Length", async () => {
  const app = daemonApp({}, {} as Db);
  const response = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedBodyStream(MAX_ENROLL_BODY_BYTES + 1),
  });
  await assertStreaming413(response);
});

test("POST /auth/session rejects an oversized body without Content-Length", async () => {
  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const app = daemonApp({ secrets: keyring }, {} as Db);
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedBodyStream(MAX_AUTH_SESSION_BODY_BYTES + 1),
  });
  await assertStreaming413(response);
});

test("POST /metrics rejects an oversized body without Content-Length", async () => {
  const { app, token } = await jwtDaemonApp();
  const response = await app.request(`${DAEMON_API_PREFIX}/metrics`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: oversizedBodyStream(MAX_METRICS_PAYLOAD_BYTES + 1),
  });
  await assertStreaming413(response);
});

test("POST /auth/session treats malformed JSON as missing fields", async () => {
  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const app = daemonApp({ secrets: keyring }, {} as Db);
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assertEquals(response.status, 400);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "Missing required session fields");
});
