/**
 * Host-free reencrypt sweep lock + empty-stage batch walks (no Postgres).
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Db } from "../db.ts";
import {
  encryptSecret,
  encryptSecretForDaemon,
} from "../client/authn/data-encryption.ts";
import {
  type DerivedSecretsConfig,
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import {
  secret,
  principal,
  setting,
  storage,
  tls,
  variable,
} from "../lib/db/schema.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../test-fixtures/secrets.ts";
import {
  endReencryptSweep,
  REENCRYPT_BATCH_SIZE,
  REENCRYPT_SWEEP_LEASE_MS,
  REENCRYPT_SWEEP_LOCK_KEY,
  reencryptAtRestSecrets,
  reencryptAtRestSecretsToCompletion,
  resetReencryptSweepLockForTests,
  tryBeginReencryptSweep,
} from "./reencrypt-secrets.ts";

/** Non-production secondary key for rotated-envelope host-free fixtures. */
const TEST_ONLY_TURBOPANEL_SECRET_V2 =
  "Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7" as const;

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type StageKey =
  | "variables"
  | "tls"
  | "principals"
  | "storage"
  | "secrets"
  | "email";

function stageForTable(table: unknown): StageKey | null {
  if (table === variable) return "variables";
  if (table === tls) return "tls";
  if (table === principal) return "principals";
  if (table === storage) return "storage";
  if (table === secret) return "secrets";
  if (table === setting) return "email";
  return null;
}

/** Batches use orderBy→limit; email uses where→limit only. */
function emptySweepDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db;
}

/**
 * Table-aware host-free DB: each stage has an ordered list of select pages.
 * Updates return `returning` rows only when `updateApplied` is true.
 */
function stagedSweepDb(opts: {
  pages: Partial<Record<StageKey, unknown[][]>>;
  updateApplied?: boolean;
}): Db {
  const pageIndex: Record<StageKey, number> = {
    variables: 0,
    tls: 0,
    principals: 0,
    storage: 0,
    secrets: 0,
    email: 0,
  };
  const updateApplied = opts.updateApplied ?? true;

  function nextPage(stage: StageKey): unknown[] {
    const pages = opts.pages[stage] ?? [[]];
    const index = pageIndex[stage];
    pageIndex[stage] = index + 1;
    return pages[index] ?? [];
  }

  return {
    select: () => ({
      from: (table: unknown) => {
        const stage = stageForTable(table);
        return {
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve(stage ? nextPage(stage) : []),
            }),
            limit: () => Promise.resolve(stage ? nextPage(stage) : []),
          }),
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve(updateApplied ? [{ id: "row" }] : []),
        }),
      }),
    }),
  } as unknown as Db;
}

function deriveV1Only() {
  return deriveEncryptionSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, "deno"),
    "data-encryption",
  );
}

async function deriveRotated() {
  const env = parseSecretsEnv(`2:${TEST_ONLY_TURBOPANEL_SECRET_V2},1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  return {
    env,
    secrets: await deriveEncryptionSecretsConfig(env, "data-encryption"),
  };
}

function deriveV2Only() {
  return deriveEncryptionSecretsConfig(
    parseSecretsEnv(`2:${TEST_ONLY_TURBOPANEL_SECRET_V2}`, "deno"),
    "data-encryption",
  );
}

type SweepLockValue = {
  owner: string;
  expiresAt: string;
};

/**
 * In-memory `setting` row that mimics the durable sweep lease so two callers
 * sharing this Db behave like independent isolates hitting the same Postgres.
 */
function createSweepLockMemoryDb(initial?: SweepLockValue): Db {
  let lock: SweepLockValue | null = initial ?? null;

  return {
    insert: () => ({
      values: (row: { key: string; value: SweepLockValue }) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (lock !== null) return Promise.resolve([]);
            lock = row.value;
            return Promise.resolve([{ key: row.key }]);
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(lock ? [{ value: lock }] : []),
        }),
      }),
    }),
    update: () => ({
      set: (row: { value: SweepLockValue }) => ({
        where: () => ({
          returning: () => {
            if (lock === null) return Promise.resolve([]);
            const expires = Date.parse(lock.expiresAt);
            const expired = !Number.isFinite(expires) || expires <= Date.now();
            if (!expired) return Promise.resolve([]);
            lock = row.value;
            return Promise.resolve([{ key: REENCRYPT_SWEEP_LOCK_KEY }]);
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => {
        lock = null;
        return Promise.resolve([]);
      },
    }),
  } as unknown as Db;
}

test("tryBeginReencryptSweep is exclusive until end", async () => {
  const db = createSweepLockMemoryDb();
  const first = await tryBeginReencryptSweep(db);
  assertEquals(first !== null, true);
  assertEquals(await tryBeginReencryptSweep(db), null);
  await endReencryptSweep(db, first!);
  assertEquals((await tryBeginReencryptSweep(db)) !== null, true);
});

test("tryBeginReencryptSweep allows only one of two concurrent callers", async () => {
  const db = createSweepLockMemoryDb();
  const [first, second] = await Promise.all([
    tryBeginReencryptSweep(db),
    tryBeginReencryptSweep(db),
  ]);
  const held = [first, second].filter((lock) => lock !== null);
  assertEquals(held.length, 1);
  await endReencryptSweep(db, held[0]!);
});

test("tryBeginReencryptSweep steals an expired lease", async () => {
  const db = createSweepLockMemoryDb({
    owner: "stale-owner",
    expiresAt: new Date(Date.now() - REENCRYPT_SWEEP_LEASE_MS).toISOString(),
  });
  const stolen = await tryBeginReencryptSweep(db);
  assertEquals(stolen !== null, true);
  assertEquals(await tryBeginReencryptSweep(db), null);
  await endReencryptSweep(db, stolen!);
});

test("reencryptAtRestSecrets walks empty stages to completed", async () => {
  await resetReencryptSweepLockForTests();
  const result = await reencryptAtRestSecrets(
    emptySweepDb(),
    {} as DerivedSecretsConfig,
    { limit: 10 },
  );
  assertEquals(result.completed, true);
  assertEquals(result.cursor, null);
  assertEquals(result.scanned, 0);
  assertEquals(REENCRYPT_BATCH_SIZE >= 10, true);
});

test("reencryptAtRestSecrets rejects non-positive and non-integer limits", async () => {
  await assertRejects(
    () =>
      reencryptAtRestSecrets(emptySweepDb(), {} as DerivedSecretsConfig, {
        limit: 0,
      }),
    TypeError,
    "reencrypt limit must be a positive integer",
  );
  await assertRejects(
    () =>
      reencryptAtRestSecrets(emptySweepDb(), {} as DerivedSecretsConfig, {
        limit: 1.5,
      }),
    TypeError,
    "reencrypt limit must be a positive integer",
  );
});

test("reencryptAtRestSecrets resume from tls across empty stages", async () => {
  await resetReencryptSweepLockForTests();
  const mid = await reencryptAtRestSecrets(
    emptySweepDb(),
    {} as DerivedSecretsConfig,
    { cursor: { stage: "tls" }, limit: 5 },
  );
  assertEquals(mid.completed, true);
  assertEquals(mid.cursor, null);

  const done = await reencryptAtRestSecretsToCompletion(
    emptySweepDb(),
    {} as DerivedSecretsConfig,
  );
  assertEquals(done.scanned, 0);
});

test("reencryptAtRestSecrets reseals old-version enc and fails plaintext/malformed", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const oldEnvelope = await encryptSecret(v1Only, "variable-v1-secret");

  const db = stagedSweepDb({
    pages: {
      variables: [[
        {
          id: "00000000-0000-4000-8000-0000000000v1",
          value: oldEnvelope,
        },
        {
          id: "00000000-0000-4000-8000-0000000000v2",
          value: "plain-at-rest",
        },
        {
          id: "00000000-0000-4000-8000-0000000000v3",
          value: "tpsecret.malformed-not-parseable",
        },
      ]],
    },
  });

  const batch = await reencryptAtRestSecrets(db, rotated, { limit: 50 });
  assertEquals(batch.scanned, 3);
  assertEquals(batch.reencrypted, 1);
  assertEquals(batch.failed, 2);
  assertEquals(batch.completed, true);
});

test("reencryptAtRestSecrets skips current enc and valid denc; fails malformed denc", async () => {
  await resetReencryptSweepLockForTests();
  const { env, secrets: rotated } = await deriveRotated();
  const current = await encryptSecret(rotated, "already-current");
  const denc = await encryptSecretForDaemon(
    env,
    {
      serverId: "00000000-0000-4000-8000-0000000000s1",
      keyId: "00000000-0000-4000-8000-0000000000k1",
    },
    "daemon-bound",
  );
  const db = stagedSweepDb({
    pages: {
      variables: [[
        { id: "00000000-0000-4000-8000-0000000000c1", value: current },
        { id: "00000000-0000-4000-8000-0000000000d1", value: denc },
        {
          id: "00000000-0000-4000-8000-0000000000d2",
          value: "tpdaemon.not-a-valid-daemon-envelope",
        },
      ]],
    },
  });

  const batch = await reencryptAtRestSecrets(db, rotated, { limit: 50 });
  assertEquals(batch.scanned, 3);
  assertEquals(batch.skipped, 2);
  assertEquals(batch.failed, 1);
  assertEquals(batch.reencrypted, 0);
});

test("reencryptAtRestSecrets counts CAS miss as skipped", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const oldEnvelope = await encryptSecret(v1Only, "cas-race");
  const db = stagedSweepDb({
    pages: {
      variables: [[
        { id: "00000000-0000-4000-8000-0000000000c2", value: oldEnvelope },
      ]],
    },
    updateApplied: false,
  });

  const batch = await reencryptAtRestSecrets(db, rotated, { limit: 10 });
  assertEquals(batch.scanned, 1);
  assertEquals(batch.reencrypted, 0);
  assertEquals(batch.skipped, 1);
});

test("reencryptAtRestSecrets fails when decrypt cannot use current keyring", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const v2Only = await deriveV2Only();
  const orphan = await encryptSecret(v1Only, "orphaned-v1");
  const db = stagedSweepDb({
    pages: {
      variables: [[
        { id: "00000000-0000-4000-8000-0000000000o1", value: orphan },
      ]],
    },
  });

  const batch = await reencryptAtRestSecrets(db, v2Only, { limit: 5 });
  assertEquals(batch.scanned, 1);
  assertEquals(batch.failed, 1);
  assertEquals(batch.reencrypted, 0);
});

test("reencryptAtRestSecrets returns incomplete cursor on a full page", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const a = await encryptSecret(v1Only, "page-a");
  const b = await encryptSecret(v1Only, "page-b");
  const db = stagedSweepDb({
    pages: {
      variables: [
        [
          { id: "00000000-0000-4000-8000-0000000000a1", value: a },
          { id: "00000000-0000-4000-8000-0000000000a2", value: b },
        ],
        [],
      ],
    },
  });

  const first = await reencryptAtRestSecrets(db, rotated, { limit: 2 });
  assertEquals(first.completed, false);
  assertEquals(first.cursor, {
    stage: "variables",
    afterId: "00000000-0000-4000-8000-0000000000a2",
  });
  assertEquals(first.reencrypted, 2);

  const second = await reencryptAtRestSecrets(db, rotated, {
    cursor: first.cursor,
    limit: 2,
  });
  assertEquals(second.completed, true);
  assertEquals(second.cursor, null);
});

test("reencryptAtRestSecrets sweeps tls including null privateKey skips", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const oldKey = await encryptSecret(v1Only, "tls-key");
  const db = stagedSweepDb({
    pages: {
      tls: [[
        { id: "00000000-0000-4000-8000-0000000000t0", privateKeyPem: null },
        {
          id: "00000000-0000-4000-8000-0000000000t1",
          privateKeyPem: oldKey,
        },
      ]],
    },
  });

  const tlsBatch = await reencryptAtRestSecrets(db, rotated, {
    cursor: { stage: "tls" },
    limit: 50,
  });
  assertEquals(tlsBatch.reencrypted, 1);
  assertEquals(tlsBatch.scanned, 1);
  assertEquals(tlsBatch.completed, true);
});

test("reencryptAtRestSecrets sweeps principals including null password skips", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const oldPass = await encryptSecret(v1Only, "principal-pass");
  const db = stagedSweepDb({
    pages: {
      principals: [[
        { id: "00000000-0000-4000-8000-0000000000p0", password: null },
        {
          id: "00000000-0000-4000-8000-0000000000p1",
          password: oldPass,
        },
      ]],
    },
  });

  const principalBatch = await reencryptAtRestSecrets(db, rotated, {
    cursor: {
      stage: "principals",
      afterId: "00000000-0000-4000-8000-0000000000p0",
    },
    limit: 50,
  });
  assertEquals(principalBatch.reencrypted, 1);
  assertEquals(principalBatch.scanned, 1);
  assertEquals(principalBatch.completed, true);
});
test("reencryptAtRestSecrets email stage reseals old and skips current", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const oldSmtp = await encryptSecret(v1Only, "smtp-v1");
  const currentMailgun = await encryptSecret(rotated, "mailgun-v2");
  const db = stagedSweepDb({
    pages: {
      email: [[
        {
          value: {
            PROVIDER: "mailgun",
            MAILGUN_API_KEY: currentMailgun,
            SMTP_PASS: oldSmtp,
            IGNORED: "",
            NOT_A_SECRET: 12,
          },
        },
      ]],
    },
  });

  const batch = await reencryptAtRestSecrets(db, rotated, {
    cursor: { stage: "email" },
    limit: 10,
  });
  assertEquals(batch.completed, true);
  assertEquals(batch.scanned, 2);
  assertEquals(batch.skipped, 1);
  assertEquals(batch.reencrypted, 1);
  assertEquals(batch.failed, 0);
});

test("reencryptAtRestSecrets email fails plaintext and skips CAS miss after reseal", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const oldSmtp = await encryptSecret(v1Only, "smtp-v1");
  const db = stagedSweepDb({
    pages: {
      email: [[
        {
          value: {
            MAILGUN_API_KEY: "plaintext-mailgun",
            SMTP_PASS: oldSmtp,
          },
        },
      ]],
    },
    updateApplied: false,
  });

  const batch = await reencryptAtRestSecrets(db, rotated, {
    cursor: { stage: "email" },
    limit: 10,
  });
  assertEquals(batch.scanned, 2);
  assertEquals(batch.failed, 1);
  assertEquals(batch.reencrypted, 0);
  assertEquals(batch.skipped, 1);
});

test("reencryptAtRestSecrets email counts decrypt failures", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const v2Only = await deriveV2Only();
  const orphan = await encryptSecret(v1Only, "email-orphan");
  const db = stagedSweepDb({
    pages: {
      email: [[{ value: { SMTP_PASS: orphan } }]],
    },
  });

  const batch = await reencryptAtRestSecrets(db, v2Only, {
    cursor: { stage: "email" },
    limit: 5,
  });
  assertEquals(batch.scanned, 1);
  assertEquals(batch.failed, 1);
  assertEquals(batch.reencrypted, 0);
});
test("reencryptAtRestSecrets email ignores non-object setting values", async () => {
  await resetReencryptSweepLockForTests();
  for (const value of [null, "string", ["array"], undefined]) {
    const db = stagedSweepDb({
      pages: { email: [[{ value }]] },
    });
    const batch = await reencryptAtRestSecrets(db, {} as DerivedSecretsConfig, {
      cursor: { stage: "email" },
      limit: 1,
    });
    assertEquals(batch.scanned, 0);
    assertEquals(batch.completed, true);
  }
});

test("reencryptAtRestSecrets sweeps storage including a null contentEnvelope skip", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const oldContent = await encryptSecret(v1Only, "storage-blob");
  const db = stagedSweepDb({
    pages: {
      storage: [[
        { id: "00000000-0000-4000-8000-0000000000c0", contentEnvelope: null },
        {
          id: "00000000-0000-4000-8000-0000000000c1",
          contentEnvelope: oldContent,
        },
      ]],
    },
  });

  const batch = await reencryptAtRestSecrets(db, rotated, {
    cursor: { stage: "storage" },
    limit: 50,
  });
  assertEquals(batch.reencrypted, 1);
  assertEquals(batch.scanned, 1);
  assertEquals(batch.completed, true);
});

test("reencryptAtRestSecrets sweeps the secret table including daemon-bound envelopes", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const oldSecret = await encryptSecret(v1Only, "secret-row");
  const db = stagedSweepDb({
    pages: {
      secrets: [[
        {
          id: "00000000-0000-4000-8000-0000000000s1",
          secretEnvelope: oldSecret,
        },
      ]],
    },
  });

  const batch = await reencryptAtRestSecrets(db, rotated, {
    cursor: { stage: "secrets" },
    limit: 50,
  });
  assertEquals(batch.reencrypted, 1);
  assertEquals(batch.scanned, 1);
  assertEquals(batch.completed, true);
});

test("tryBeginReencryptSweep treats a malformed lock as held and steals a non-date expiry", async () => {
  const malformed = createSweepLockMemoryDb({
    owner: "x",
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  Object.assign(malformed, {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ value: { expiresAt: "soon" } }]),
        }),
      }),
    }),
  });
  assertEquals(await tryBeginReencryptSweep(malformed), null);

  const invalidExpiry = createSweepLockMemoryDb({
    owner: "stale-owner",
    expiresAt: "not-a-date",
  });
  const stolen = await tryBeginReencryptSweep(invalidExpiry);
  assertEquals(stolen !== null, true);
  await endReencryptSweep(invalidExpiry, stolen!);
});

test("reencryptAtRestSecretsToCompletion resumes across incomplete batches", async () => {
  await resetReencryptSweepLockForTests();
  const v1Only = await deriveV1Only();
  const { secrets: rotated } = await deriveRotated();
  const envelopes = await Promise.all(
    Array.from(
      { length: REENCRYPT_BATCH_SIZE + 1 },
      (_, i) => encryptSecret(v1Only, `row-${i}`),
    ),
  );
  const fullPage = envelopes.slice(0, REENCRYPT_BATCH_SIZE).map((value, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    value,
  }));
  const remainder = [{
    id: `00000000-0000-4000-8000-${
      String(REENCRYPT_BATCH_SIZE).padStart(12, "0")
    }`,
    value: envelopes[REENCRYPT_BATCH_SIZE],
  }];
  const db = stagedSweepDb({
    pages: {
      variables: [fullPage, remainder, []],
    },
  });

  const totals = await reencryptAtRestSecretsToCompletion(db, rotated);
  assertEquals(totals.scanned, REENCRYPT_BATCH_SIZE + 1);
  assertEquals(totals.reencrypted, REENCRYPT_BATCH_SIZE + 1);
});

test("reencryptAtRestSecrets normalizes bad cursors to variables", async () => {
  const result = await reencryptAtRestSecrets(
    emptySweepDb(),
    {} as DerivedSecretsConfig,
    { cursor: { stage: "nope" as never }, limit: 1 },
  );
  assertEquals(result.completed, true);
});
