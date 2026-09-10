/**
 * Route-level behavior of `POST /commands/:commandId/log` that does not need a
 * live Postgres: the chunk that races a command's terminal transition must
 * still end up compacted.
 *
 * `transitionCommand` seals on the terminal transition, but that seal is a
 * no-op when no index exists yet — so a first (or final) chunk landing
 * afterwards would otherwise stay an unsealed pile of parts forever.
 */

import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import type { Db } from "../db.ts";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import { registerDaemonApiRoutes } from "./api-routes.ts";
import {
  ExecutionLogGapError,
  ExecutionLogSealedError,
  type ExecutionLogAppendResult,
  type ExecutionLogChunk,
  type ExecutionLogSealResult,
  type ExecutionLogStore,
} from "../lib/execution-logs/types.ts";

const SERVER_ID = "srv-log-seal";
const KEY_ID = "key-log-seal";
const COMMAND_ID = "00000000-0000-7000-8000-0000000000aa";

async function testSecrets() {
  return await deriveDaemonJwtKeyring({
    versioned: [{ version: 1, value: "execution_log_route_test_secret_value" }],
  });
}

/**
 * Minimal drizzle-shaped stub: every `select()` consumes the next queued row
 * set, in call order (daemon key state first, then the command target).
 */
function createFakeDb(rowSets: unknown[][]): Db {
  const queue = [...rowSets];
  const chain = (rows: unknown[]) => {
    const self = {
      from: () => self,
      where: () => self,
      limit: () => Promise.resolve(rows),
      then: (
        onFulfilled?: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return self;
  };
  return { select: () => chain(queue.shift() ?? []) } as unknown as Db;
}

/** Row shape `getServerDaemonStateByServerId` expects for an active key. */
function activeDaemonKeyRow(): Record<string, unknown> {
  return {
    daemon: {
      key: {
        id: KEY_ID,
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-log-seal",
        createdAt: new Date().toISOString(),
      },
    },
    metadata: null,
    hostname: "host.example",
    machineKey: null,
    connected: true,
    statusChangedAt: null,
  };
}

type RecordingStore = ExecutionLogStore & {
  appends: number[];
  seals: string[];
};

function createRecordingStore(): RecordingStore {
  const appends: number[] = [];
  const seals: string[] = [];
  let nextSeq = 0;
  return {
    appends,
    seals,
    appendChunk(
      _commandId: string,
      chunk: ExecutionLogChunk,
    ): Promise<ExecutionLogAppendResult> {
      appends.push(chunk.seq);
      nextSeq = chunk.seq + 1;
      return Promise.resolve({ nextSeq });
    },
    readFrom() {
      return Promise.resolve(null);
    },
    exists() {
      return Promise.resolve(true);
    },
    seal(commandId: string): Promise<ExecutionLogSealResult | null> {
      seals.push(commandId);
      return Promise.resolve({ bytes: 0 });
    },
    delete() {
      return Promise.resolve();
    },
    sweepExpired() {
      return Promise.resolve(0);
    },
  };
}

async function postChunk(commandStatus: string): Promise<{
  status: number;
  store: RecordingStore;
}> {
  const store = createRecordingStore();
  const db = createFakeDb([
    [activeDaemonKeyRow()],
    [{ serverId: SERVER_ID, status: commandStatus }],
  ]);

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("executionLogStore", store);
    return next();
  });
  const secrets = await testSecrets();
  registerDaemonApiRoutes(app as unknown as Hono, { secrets });

  const issued = await issueDaemonJwt({ sub: SERVER_ID, kid: KEY_ID }, secrets);
  const response = await app.request(
    `/api/daemon/v1/commands/${COMMAND_ID}/log`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seq: 0, bytes: btoa("output") }),
    },
  );
  return { status: response.status, store };
}

describe("POST /commands/:commandId/log seal-on-terminal", () => {
  it("seals a chunk that arrives after the command already went terminal", async () => {
    const { status, store } = await postChunk("succeeded");
    assertEquals(status, 202);
    assertEquals(store.appends, [0]);
    // The transition's own seal ran before any index existed, so this append
    // is the only thing that can compact the transcript.
    assertEquals(store.seals, [COMMAND_ID]);
  });

  it("seals a post-terminal chunk for every terminal status", async () => {
    for (const terminal of ["failed", "timed_out", "cancelled"]) {
      const { status, store } = await postChunk(terminal);
      assertEquals(status, 202);
      assertEquals(store.seals, [COMMAND_ID], `sealed for ${terminal}`);
    }
  });

  it("does not seal while the command is still running", async () => {
    const { status, store } = await postChunk("running");
    assertEquals(status, 202);
    assertEquals(store.appends, [0]);
    assert(store.seals.length === 0, "a live command must not be compacted");
  });
});

async function postChunkWithStore(
  store: ExecutionLogStore,
): Promise<Response> {
  const db = createFakeDb([
    [activeDaemonKeyRow()],
    [{ serverId: SERVER_ID, status: "running" }],
  ]);

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("executionLogStore", store);
    return next();
  });
  const secrets = await testSecrets();
  registerDaemonApiRoutes(app as unknown as Hono, { secrets });

  const issued = await issueDaemonJwt({ sub: SERVER_ID, kid: KEY_ID }, secrets);
  return await app.request(
    `/api/daemon/v1/commands/${COMMAND_ID}/log`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seq: 2, bytes: btoa("output") }),
    },
  );
}

function throwingStore(error: Error): ExecutionLogStore {
  return {
    appendChunk() {
      return Promise.reject(error);
    },
    readFrom() {
      return Promise.resolve(null);
    },
    exists() {
      return Promise.resolve(true);
    },
    seal() {
      return Promise.resolve({ bytes: 0 });
    },
    delete() {
      return Promise.resolve();
    },
    sweepExpired() {
      return Promise.resolve(0);
    },
  };
}

describe("POST /commands/:commandId/log seq errors", () => {
  it("returns 409 seq gap when append skips a sequence", async () => {
    const response = await postChunkWithStore(
      throwingStore(new ExecutionLogGapError(1, 2)),
    );
    assertEquals(response.status, 409);
    const body = await response.json() as {
      ok?: unknown;
      error?: unknown;
      nextSeq?: unknown;
    };
    assertEquals(body.ok, false);
    assertEquals(body.error, "seq gap");
    assertEquals(body.nextSeq, 1);
  });

  it("returns 409 log sealed when append arrives after compact", async () => {
    const response = await postChunkWithStore(
      throwingStore(new ExecutionLogSealedError(COMMAND_ID)),
    );
    assertEquals(response.status, 409);
    const body = await response.json() as { ok?: unknown; error?: unknown };
    assertEquals(body.ok, false);
    assertEquals(body.error, "log sealed");
  });
});
