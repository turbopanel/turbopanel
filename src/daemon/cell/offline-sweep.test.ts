/**
 * @needs-workers-globals — reaches `offline-sweep.ts` → `workers-bindings.ts` /
 * `do-registry.ts`, which are typed against the Workers ambient globals
 * (`CloudflareBindings`, `DurableObjectStub`, …). Those cannot be loaded under
 * Deno: `@cloudflare/workers-types` redeclares `Request` / `Response` / `fetch`
 * and collides with `lib.deno.ns` + DOM. Excluded from `deno task check:types`;
 * the Workers toolchain owns this file's types.
 */
import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import type {
  DaemonCell,
  DaemonCellLiveness,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "./contracts.ts";
import {
  canDirectHealFromAeEvidence,
  CONNECTED_SWEEP_BUDGET,
  isStale,
  OFFLINE_SWEEP_STALE_MS,
  resetOfflineSweepNullGraceForTests,
  runOfflineSweep,
  SELF_HEAL_SWEEP_BUDGET,
  shouldSweepExecutionLogs,
  shouldSweepTierNotices,
  sweepExpiredCommandDispatchSafely,
  sweepExpiredExecutionLogsSafely,
  sweepExpiredWebhookDeliveriesSafely,
  sweepOnce,
  takeLastOfflineSweepScheduledTimeForTests,
  updateNullGraceBookkeeping,
} from "./offline-sweep.ts";
import { WEBHOOK_DELIVERY_SWEEP_LIMIT } from "../../lib/db/webhook-delivery-records.ts";
import type { ExecutionLogStore } from "../../lib/execution-logs/types.ts";
import {
  endOfflineSweep,
  OFFLINE_SWEEP_LEASE_MS,
  tryBeginOfflineSweep,
} from "./offline-sweep-lease.ts";
import type { Db } from "../../db.ts";
import { COMMAND_DISPATCH_SWEEP_LIMIT } from "../../lib/db/command-records.ts";

const serverId = "srv-offline-sweep-null-grace";

function connectedWithNullPing(): DaemonCellLiveness {
  return { connected: true, lastPingAtMs: null };
}

function connectedWithWarmPing(nowMs: number): DaemonCellLiveness {
  return { connected: true, lastPingAtMs: nowMs - 30_000 };
}

it("canDirectHealFromAeEvidence requires a sample newer than offlineAt", () => {
  const offlineAt = "2020-01-01T00:01:00.000Z";
  const offlineMs = Date.parse(offlineAt);

  assertEquals(canDirectHealFromAeEvidence(offlineAt, undefined), false);
  assertEquals(canDirectHealFromAeEvidence(offlineAt, offlineMs), false);
  assertEquals(canDirectHealFromAeEvidence(offlineAt, offlineMs - 1), false);
  assertEquals(canDirectHealFromAeEvidence(offlineAt, offlineMs + 1), true);
});

it("canDirectHealFromAeEvidence rejects non-finite offlineAt", () => {
  assertEquals(canDirectHealFromAeEvidence("not-a-date", Date.now()), false);
  assertEquals(canDirectHealFromAeEvidence("", 1_700_000_000_000), false);
});

it("offline sweep first null auto-response observation is not stale", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const connectedAt = new Date(nowMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, nowMs);

  assertEquals(isStale(serverId, liveness, nowMs, connectedAt), false);
});

it("offline sweep repeated null past grace is stale", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const connectedAt = new Date(firstTickMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, firstTickMs);

  const laterMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  updateNullGraceBookkeeping(serverId, liveness, laterMs);

  assertEquals(isStale(serverId, liveness, laterMs, connectedAt), true);
});

it("offline sweep warm live ping is not stale within grace", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithWarmPing(nowMs);

  updateNullGraceBookkeeping(serverId, liveness, nowMs);

  assertEquals(isStale(serverId, liveness, nowMs, null), false);
});

it("offline sweep warm live ping clears null grace bookkeeping", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const nullLiveness = connectedWithNullPing();
  const connectedAt = new Date(firstTickMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, nullLiveness, firstTickMs);
  assertEquals(
    isStale(serverId, nullLiveness, firstTickMs, connectedAt),
    false,
  );

  const warmMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  const warmLiveness = connectedWithWarmPing(warmMs);
  updateNullGraceBookkeeping(serverId, warmLiveness, warmMs);

  assertEquals(isStale(serverId, warmLiveness, warmMs, connectedAt), false);
});

it("offline sweep disconnected liveness is stale immediately", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;

  updateNullGraceBookkeeping(
    serverId,
    { connected: false, lastPingAtMs: null },
    nowMs,
  );

  assertEquals(
    isStale(serverId, { connected: false, lastPingAtMs: null }, nowMs, null),
    true,
  );
});

it("offline sweep old connectedAt with null ping is not stale on first observation", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const oldConnectedAt = new Date(
    nowMs - OFFLINE_SWEEP_STALE_MS - 1,
  ).toISOString();

  assertEquals(isStale(serverId, liveness, nowMs, oldConnectedAt), false);
});

it("offline sweep old connectedAt becomes stale after null grace persists", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const oldConnectedAt = new Date(
    firstTickMs - OFFLINE_SWEEP_STALE_MS - 1,
  ).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, firstTickMs);

  const laterMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  updateNullGraceBookkeeping(serverId, liveness, laterMs);

  assertEquals(isStale(serverId, liveness, laterMs, oldConnectedAt), true);
});

// --- sweepOnce AE short-circuit cases ---

const ID_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ID_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

type FakeCell = DaemonCell & {
  checkLivenessCalls: number;
  liveness: DaemonCellLiveness;
};

function createFakeCell(liveness: DaemonCellLiveness): FakeCell {
  const cell = {
    checkLivenessCalls: 0,
    liveness,
    checkLiveness(): Promise<DaemonCellLiveness> {
      cell.checkLivenessCalls += 1;
      return Promise.resolve(cell.liveness);
    },
  } as FakeCell;
  return new Proxy(cell, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string") {
        return () => {
          throw new Error(
            `unexpected DaemonCell.${prop} call in sweepOnce test`,
          );
        };
      }
      return undefined;
    },
  });
}

function createFakeRegistry(
  cells: Map<string, FakeCell>,
): DaemonCellRegistry {
  return {
    getCell(id: string): DaemonCell {
      const cell = cells.get(id);
      if (!cell) throw new Error(`no fake cell for ${id}`);
      return cell;
    },
    listOnlineServerIds(): Promise<string[]> {
      return Promise.resolve([...cells.keys()]);
    },
    getSnapshots(): Promise<Map<string, DaemonCellSnapshot>> {
      return Promise.resolve(new Map());
    },
    purge(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function inertEnv(): CloudflareBindings {
  return {} as CloudflareBindings;
}

function inertDb(): Db {
  return {} as Db;
}

it("sweepOnce: AE-active connected server skips checkLiveness", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([[ID_A, cell]]);
  const disconnected: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () =>
      Promise.resolve(new Map([[ID_A, Date.now()]])),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: (_db, id) => {
      disconnected.push(id);
      return Promise.resolve();
    },
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cell.checkLivenessCalls, 0);
  assertEquals(disconnected, []);
});

it("sweepOnce: connected absent from AE set is probed and demoted", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: false, lastPingAtMs: null });
  const cells = new Map([[ID_A, cell]]);
  const disconnected: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(new Map()),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: (_db, id) => {
      disconnected.push(id);
      return Promise.resolve();
    },
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cell.checkLivenessCalls, 1);
  assertEquals(disconnected, [ID_A]);
});

it("sweepOnce: AE unavailable (null) falls back to check-all", async () => {
  resetOfflineSweepNullGraceForTests();
  const cellA = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cellB = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([
    [ID_A, cellA],
    [ID_B, cellB],
  ]);

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(null),
    listConnected: () =>
      Promise.resolve([
        { id: ID_A, connectedAt: new Date().toISOString() },
        { id: ID_B, connectedAt: new Date().toISOString() },
      ]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cellA.checkLivenessCalls, 1);
  assertEquals(cellB.checkLivenessCalls, 1);
});

it("sweepOnce: AE resolve throws falls back to check-all", async () => {
  resetOfflineSweepNullGraceForTests();
  const cellA = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cellB = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([
    [ID_A, cellA],
    [ID_B, cellB],
  ]);

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.reject(new Error("ae boom")),
    listConnected: () =>
      Promise.resolve([
        { id: ID_A, connectedAt: new Date().toISOString() },
        { id: ID_B, connectedAt: new Date().toISOString() },
      ]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cellA.checkLivenessCalls, 1);
  assertEquals(cellB.checkLivenessCalls, 1);
});

it("sweepOnce: AE-active self-heal is capped by SELF_HEAL_SWEEP_BUDGET", async () => {
  resetOfflineSweepNullGraceForTests();
  const overBudget = SELF_HEAL_SWEEP_BUDGET + 50;
  const sampleAtMs = Date.now();
  const offlineAt = new Date(sampleAtMs - 60_000).toISOString();
  const recentlyOffline = Array.from({ length: overBudget }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    return {
      id,
      connectedAt: new Date().toISOString(),
      offlineAt,
    };
  });
  const activeById = new Map(
    recentlyOffline.map((r) => [r.id, sampleAtMs] as const),
  );
  const cells = new Map(
    recentlyOffline.map((r) => [
      r.id,
      createFakeCell({ connected: true, lastPingAtMs: Date.now() }),
    ]),
  );
  const healed: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(activeById),
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () => Promise.resolve(recentlyOffline),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => {
      throw new Error(
        "AE-direct heal must not call onConnected (cell path)",
      );
    },
    onConnectedFromEvidence: (_db, id) => {
      healed.push(id);
      return Promise.resolve();
    },
  });

  assertEquals(healed.length, SELF_HEAL_SWEEP_BUDGET);
  // Direct AE heal skips checkLiveness — none of the budgeted cells should
  // have been probed (all were AE-active with post-offline evidence).
  for (const cell of cells.values()) {
    assertEquals(cell.checkLivenessCalls, 0);
  }
});

it("sweepOnce: AE-direct self-heal never calls registry.getCell or getSnapshot", async () => {
  resetOfflineSweepNullGraceForTests();
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const offlineAt = "2020-01-01T00:00:00.000Z";
  const aeLatestMs = Date.parse("2020-01-01T00:01:00.000Z");
  const getCellCalls: string[] = [];
  const healed: Array<{ id: string; connectedAt?: string | null }> = [];

  const registry: DaemonCellRegistry = {
    getCell(id: string): DaemonCell {
      getCellCalls.push(id);
      throw new Error(
        `AE-direct heal must not call registry.getCell(${id})`,
      );
    },
    listOnlineServerIds(): Promise<string[]> {
      return Promise.resolve([]);
    },
    getSnapshots(): Promise<Map<string, DaemonCellSnapshot>> {
      throw new Error("getSnapshots must not be called");
    },
    purge(): Promise<void> {
      return Promise.resolve();
    },
  };

  await sweepOnce(inertEnv(), inertDb(), {
    registry,
    resolveActiveServerIds: () =>
      Promise.resolve(new Map([[ID_A, aeLatestMs]])),
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () =>
      Promise.resolve([{ id: ID_A, connectedAt, offlineAt }]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => {
      throw new Error("AE-direct heal must not call onConnected");
    },
    onConnectedFromEvidence: (_db, id, at) => {
      healed.push({ id, connectedAt: at });
      return Promise.resolve();
    },
  });

  assertEquals(getCellCalls, []);
  assertEquals(healed, [{ id: ID_A, connectedAt }]);
});

it("sweepOnce: probed self-heal still uses onConnected after checkLiveness", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({
    connected: true,
    lastPingAtMs: Date.now() - 30_000,
  });
  const cells = new Map([[ID_A, cell]]);
  const probedHealed: string[] = [];
  const directHealed: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    // AE map is non-null but empty — recently-offline ID_A is not AE-active,
    // so it goes through the probed heal path.
    resolveActiveServerIds: () => Promise.resolve(new Map()),
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () =>
      Promise.resolve([{
        id: ID_A,
        connectedAt: new Date().toISOString(),
        offlineAt: new Date().toISOString(),
      }]),
    onDisconnected: () => Promise.resolve(),
    onConnected: (_db, id) => {
      probedHealed.push(id);
      return Promise.resolve();
    },
    onConnectedFromEvidence: (_db, id) => {
      directHealed.push(id);
      return Promise.resolve();
    },
  });

  assertEquals(cell.checkLivenessCalls, 1);
  assertEquals(probedHealed, [ID_A]);
  assertEquals(directHealed, []);
});

it(
  "sweepOnce: clean disconnect after metrics sample does not AE-direct heal",
  async () => {
    resetOfflineSweepNullGraceForTests();
    // Metrics sample lands, then a clean webSocketClose projects offline.
    // The pre-disconnect sample is still inside the AE liveness window — that
    // alone must not undo the offline projection without checkLiveness.
    const nowMs = 1_700_000_000_000;
    const sampleAtMs = nowMs - 30_000;
    const offlineAt = new Date(nowMs - 20_000).toISOString();
    const cell = createFakeCell({ connected: false, lastPingAtMs: null });
    const cells = new Map([[ID_A, cell]]);
    const directHealed: string[] = [];
    const probedHealed: string[] = [];

    await sweepOnce(inertEnv(), inertDb(), {
      registry: createFakeRegistry(cells),
      resolveActiveServerIds: () =>
        Promise.resolve(new Map([[ID_A, sampleAtMs]])),
      listConnected: () => Promise.resolve([]),
      listRecentlyOffline: () =>
        Promise.resolve([{
          id: ID_A,
          connectedAt: new Date(nowMs - 120_000).toISOString(),
          offlineAt,
        }]),
      onDisconnected: () => Promise.resolve(),
      onConnected: (_db, id) => {
        probedHealed.push(id);
        return Promise.resolve();
      },
      onConnectedFromEvidence: (_db, id) => {
        directHealed.push(id);
        return Promise.resolve();
      },
    });

    assertEquals(directHealed, []);
    assertEquals(cell.checkLivenessCalls, 1);
    // Cell reports disconnected — probed path must not heal either.
    assertEquals(probedHealed, []);
  },
);

it("dispatch-expiry sweep runs on the passed db, bounded per tick", async () => {
  let limit: number | undefined;
  let deleteCalls = 0;
  const db = {
    delete: () => ({
      where: (condition: { queryChunks?: unknown[] }) => {
        deleteCalls += 1;
        // The bounded limit rides in the delete's subquery parameters.
        limit = (condition.queryChunks ?? []).find(
          (chunk) => typeof chunk === "number",
        ) as number | undefined;
        return { returning: () => Promise.resolve([{ commandId: "cmd-1" }]) };
      },
    }),
  } as unknown as Db;

  await sweepExpiredCommandDispatchSafely(db);

  assertEquals(deleteCalls, 1);
  assertEquals(limit, COMMAND_DISPATCH_SWEEP_LIMIT);
});

it("dispatch-expiry sweep failures stay isolated from the rest of the tick", async () => {
  const db = {
    delete: () => {
      throw new Error("postgres unavailable");
    },
  } as unknown as Db;

  // Resolves instead of throwing — the cron's other sweeps must still run.
  await sweepExpiredCommandDispatchSafely(db);
});

type SweepLockValue = {
  owner: string;
  expiresAt: string;
};

function applySweepLockUpdate(
  lock: { current: SweepLockValue | null },
  row: { value: SweepLockValue },
): Promise<{ key: string }[]> {
  if (lock.current === null) return Promise.resolve([]);
  const expires = Date.parse(lock.current.expiresAt);
  const expired = !Number.isFinite(expires) || expires <= Date.now();
  const stealable = lock.current.owner.length === 0 || expired;
  const sameOwner = row.value.owner === lock.current.owner;
  const releasing = row.value.owner.length === 0;
  if (!stealable && !sameOwner && !releasing) {
    return Promise.resolve([]);
  }
  lock.current = row.value;
  return Promise.resolve([{ key: "OFFLINE_SWEEP_LOCK" }]);
}

function thenableRows(rows: Promise<{ key: string }[]>) {
  return Object.assign(rows, { returning: () => rows });
}

function createOfflineSweepLockMemoryDb(initial?: SweepLockValue): Db {
  const lock = { current: initial ?? null };

  return {
    insert: () => ({
      values: (row: { key: string; value: SweepLockValue }) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (lock.current !== null) return Promise.resolve([]);
            lock.current = row.value;
            return Promise.resolve([{ key: row.key }]);
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(lock.current ? [{ value: lock.current }] : []),
        }),
      }),
    }),
    update: () => ({
      set: (row: { value: SweepLockValue }) => ({
        where: () => thenableRows(applySweepLockUpdate(lock, row)),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
    $client: { end: () => Promise.resolve() },
  } as unknown as Db;
}

it("shouldSweepExecutionLogs is true on every 15th UTC minute", () => {
  assertEquals(
    shouldSweepExecutionLogs(Date.parse("2026-01-01T00:00:00.000Z")),
    true,
  );
  assertEquals(
    shouldSweepExecutionLogs(Date.parse("2026-01-01T00:15:00.000Z")),
    true,
  );
  assertEquals(
    shouldSweepExecutionLogs(Date.parse("2026-01-01T00:01:00.000Z")),
    false,
  );
});

it("shouldSweepTierNotices is true on every UTC hour", () => {
  assertEquals(
    shouldSweepTierNotices(Date.parse("2026-01-01T00:00:00.000Z")),
    true,
  );
  assertEquals(
    shouldSweepTierNotices(Date.parse("2026-01-01T01:00:00.000Z")),
    true,
  );
  assertEquals(
    shouldSweepTierNotices(Date.parse("2026-01-01T00:15:00.000Z")),
    false,
  );
});

it("second tick skips while the offline-sweep lease is held", async () => {
  const db = createOfflineSweepLockMemoryDb();
  const first = await tryBeginOfflineSweep(db);
  assertEquals(first !== null, true);
  assertEquals(await tryBeginOfflineSweep(db), null);

  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await runOfflineSweep(inertEnv(), null, { db });
  } finally {
    console.info = originalInfo;
  }
  assertEquals(
    traces.some((line) => line.includes("event=skipped-lease-held")),
    true,
  );
  await endOfflineSweep(db, first!);
  assertEquals((await tryBeginOfflineSweep(db)) !== null, true);
});

it("offline-sweep lease is released when a phase throws", async () => {
  const db = createOfflineSweepLockMemoryDb();
  await runOfflineSweep(inertEnv(), null, {
    db,
    sweepOnceDeps: {
      listConnected: () => {
        throw new Error("phase boom");
      },
      listRecentlyOffline: () => Promise.resolve([]),
      resolveActiveServerIds: () => Promise.resolve(new Map()),
      onDisconnected: () => Promise.resolve(),
      onConnected: () => Promise.resolve(),
    },
  });
  assertEquals((await tryBeginOfflineSweep(db)) !== null, true);
});

it("expired offline-sweep lease is stealable", async () => {
  const db = createOfflineSweepLockMemoryDb({
    owner: "expired-owner",
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  const stolen = await tryBeginOfflineSweep(db);
  assertEquals(stolen !== null, true);
  assertEquals(await tryBeginOfflineSweep(db), null);
});

it(
  "second tick skips while a stalled optional phase still holds the lease past TTL",
  async () => {
    const startedAt = Date.now();
    let hangStarted = false;
    let resolveHang: (rows: { commandId: string }[]) => void = () => {};
    const hang = new Promise<{ commandId: string }[]>((resolve) => {
      resolveHang = resolve;
    });
    const db = createOfflineSweepLockMemoryDb();
    const hangingDb = {
      ...db,
      delete: () => {
        hangStarted = true;
        return {
          where: () => ({
            returning: () => hang,
          }),
        };
      },
    } as unknown as Db;

    const first = runOfflineSweep(inertEnv(), null, {
      db: hangingDb,
      nowMs: startedAt,
      deadlineMs: startedAt + OFFLINE_SWEEP_LEASE_MS + 30_000,
      sweepOnceDeps: {
        listConnected: () => Promise.resolve([]),
        listRecentlyOffline: () => Promise.resolve([]),
        resolveActiveServerIds: () => Promise.resolve(new Map()),
        onDisconnected: () => Promise.resolve(),
        onConnected: () => Promise.resolve(),
      },
    });

    try {
      const waitUntil = startedAt + 2_000;
      while (!hangStarted && Date.now() < waitUntil) {
        await Promise.resolve();
      }
      assertEquals(hangStarted, true);

      const traces: string[] = [];
      const originalInfo = console.info;
      console.info = (...args: unknown[]) => {
        traces.push(args.map(String).join(" "));
      };
      try {
        await runOfflineSweep(inertEnv(), null, {
          db: hangingDb,
          nowMs: startedAt + OFFLINE_SWEEP_LEASE_MS + 1,
        });
      } finally {
        console.info = originalInfo;
      }
      assertEquals(
        traces.some((line) => line.includes("event=skipped-lease-held")),
        true,
      );
    } finally {
      resolveHang([]);
      await first;
    }
  },
);

it("probe stops at the deadline; the next tick's rotation covers the remainder", async () => {
  resetOfflineSweepNullGraceForTests();
  const idC = "cccccccc-dddd-4eee-8fff-000000000000";
  const cellA = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cellB = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cellC = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([
    [ID_A, cellA],
    [ID_B, cellB],
    [idC, cellC],
  ]);
  const connected = [
    { id: ID_A, connectedAt: new Date().toISOString() },
    { id: ID_B, connectedAt: new Date().toISOString() },
    { id: idC, connectedAt: new Date().toISOString() },
  ];
  const registry = createFakeRegistry(cells);

  await sweepOnce(inertEnv(), inertDb(), {
    registry,
    nowMs: 1_700_000_000_000,
    deadlineMs: 0,
    resolveActiveServerIds: () => Promise.resolve(null),
    listConnected: () => Promise.resolve(connected),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });
  assertEquals(cellA.checkLivenessCalls, 0);
  assertEquals(cellB.checkLivenessCalls, 0);
  assertEquals(cellC.checkLivenessCalls, 0);

  await sweepOnce(inertEnv(), inertDb(), {
    registry,
    nowMs: 1_700_000_000_000 + 60_000,
    deadlineMs: Date.now() + 60_000,
    resolveActiveServerIds: () => Promise.resolve(null),
    listConnected: () => Promise.resolve(connected),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });
  assertEquals(cellA.checkLivenessCalls, 1);
  assertEquals(cellB.checkLivenessCalls, 1);
  assertEquals(cellC.checkLivenessCalls, 1);
});

it("sweepOnce: AE timeout takes the fallback path", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([[ID_A, cell]]);

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () =>
      Promise.reject(
        new DOMException("The operation was aborted.", "TimeoutError"),
      ),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cell.checkLivenessCalls, 1);
});

it("sweepOnce: empty candidate lists return before the AE resolver", async () => {
  resetOfflineSweepNullGraceForTests();
  let aeCalled = false;

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(new Map()),
    resolveActiveServerIds: () => {
      aeCalled = true;
      return Promise.resolve(new Map());
    },
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  assertEquals(aeCalled, false);
});

it("takeLastOfflineSweepScheduledTimeForTests returns the last cron stamp once", async () => {
  takeLastOfflineSweepScheduledTimeForTests();
  const scheduledTime = Date.parse("2026-01-01T00:00:00.000Z");
  const db = createOfflineSweepLockMemoryDb();
  await runOfflineSweep(inertEnv(), null, {
    db,
    scheduledTime,
    sweepOnceDeps: {
      listConnected: () => Promise.resolve([]),
      listRecentlyOffline: () => Promise.resolve([]),
      resolveActiveServerIds: () => Promise.resolve(new Map()),
      onDisconnected: () => Promise.resolve(),
      onConnected: () => Promise.resolve(),
    },
  });
  assertEquals(takeLastOfflineSweepScheduledTimeForTests(), scheduledTime);
  assertEquals(takeLastOfflineSweepScheduledTimeForTests(), undefined);
});

it("sweepOnce: default AE resolver is unavailable without SQL credentials", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([[ID_A, cell]]);
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await sweepOnce(inertEnv(), inertDb(), {
      registry: createFakeRegistry(cells),
      listConnected: () =>
        Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
      listRecentlyOffline: () => Promise.resolve([]),
      onDisconnected: () => Promise.resolve(),
      onConnected: () => Promise.resolve(),
    });
  } finally {
    console.info = originalInfo;
  }
  assertEquals(cell.checkLivenessCalls, 1);
  assertEquals(
    traces.some((line) => line.includes("event=ae-unavailable")),
    true,
  );
});

it("sweepOnce: default AE resolver failure falls back to check-all", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([[ID_A, cell]]);
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "acct123",
    TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: "token-xyz",
  } as CloudflareBindings;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError("ae sql boom"));
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await sweepOnce(env, inertDb(), {
      registry: createFakeRegistry(cells),
      listConnected: () =>
        Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
      listRecentlyOffline: () => Promise.resolve([]),
      onDisconnected: () => Promise.resolve(),
      onConnected: () => Promise.resolve(),
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
  }
  assertEquals(cell.checkLivenessCalls, 1);
  assertEquals(
    traces.some((line) => line.includes("event=ae-query-failed")),
    true,
  );
});

it("sweepOnce: checkLiveness throw is isolated and does not demote", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  cell.checkLiveness = () => Promise.reject(new TypeError("rpc boom"));
  const cells = new Map([[ID_A, cell]]);
  const disconnected: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(new Map()),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: (_db, id) => {
      disconnected.push(id);
      return Promise.resolve();
    },
    onConnected: () => Promise.resolve(),
  });

  assertEquals(disconnected, []);
});

it("sweepOnce: missing checkLiveness treats the cell as stale", async () => {
  resetOfflineSweepNullGraceForTests();
  const disconnected: string[] = [];
  const registry: DaemonCellRegistry = {
    getCell(): DaemonCell {
      return {} as DaemonCell;
    },
    listOnlineServerIds(): Promise<string[]> {
      return Promise.resolve([ID_A]);
    },
    getSnapshots(): Promise<Map<string, DaemonCellSnapshot>> {
      return Promise.resolve(new Map());
    },
    purge(): Promise<void> {
      return Promise.resolve();
    },
  };

  await sweepOnce(inertEnv(), inertDb(), {
    registry,
    resolveActiveServerIds: () => Promise.resolve(new Map()),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: (_db, id) => {
      disconnected.push(id);
      return Promise.resolve();
    },
    onConnected: () => Promise.resolve(),
  });

  assertEquals(disconnected, [ID_A]);
});

it("sweepOnce: onDisconnected throw is isolated", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: false, lastPingAtMs: null });
  const cells = new Map([[ID_A, cell]]);

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(new Map()),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.reject(new TypeError("projection failed")),
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cell.checkLivenessCalls, 1);
});

it("sweepOnce: probed self-heal throw is isolated", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({
    connected: true,
    lastPingAtMs: Date.now() - 30_000,
  });
  const cells = new Map([[ID_A, cell]]);

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(new Map()),
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () =>
      Promise.resolve([{
        id: ID_A,
        connectedAt: new Date().toISOString(),
        offlineAt: new Date().toISOString(),
      }]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.reject(new TypeError("heal failed")),
    onConnectedFromEvidence: () => Promise.resolve(),
  });

  assertEquals(cell.checkLivenessCalls, 1);
});

it("sweepOnce: AE-direct self-heal throw is isolated", async () => {
  resetOfflineSweepNullGraceForTests();
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const offlineAt = "2020-01-01T00:00:00.000Z";
  const aeLatestMs = Date.parse("2020-01-01T00:01:00.000Z");

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(new Map()),
    resolveActiveServerIds: () =>
      Promise.resolve(new Map([[ID_A, aeLatestMs]])),
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () =>
      Promise.resolve([{ id: ID_A, connectedAt, offlineAt }]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => {
      throw new TypeError("AE-direct heal must not call onConnected");
    },
    onConnectedFromEvidence: () =>
      Promise.reject(new TypeError("evidence heal failed")),
  });
});

it("sweepOnce: recently-offline id already connected is not merged twice", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([[ID_A, cell]]);

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(null),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () =>
      Promise.resolve([{
        id: ID_A,
        connectedAt: new Date().toISOString(),
        offlineAt: new Date().toISOString(),
      }]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cell.checkLivenessCalls, 1);
});

it("sweepOnce: null-grace bookkeeping is pruned when a server leaves the batch", async () => {
  resetOfflineSweepNullGraceForTests();
  const t0 = 1_700_000_000_000;
  const nullCell = createFakeCell({ connected: true, lastPingAtMs: null });
  const warmCell = createFakeCell({
    connected: true,
    lastPingAtMs: t0 - 30_000,
  });
  const cells = new Map([
    [ID_A, nullCell],
    [ID_B, warmCell],
  ]);
  const registry = createFakeRegistry(cells);
  const disconnected: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry,
    nowMs: t0,
    resolveActiveServerIds: () => Promise.resolve(null),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date(t0).toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  await sweepOnce(inertEnv(), inertDb(), {
    registry,
    nowMs: t0 + 1_000,
    resolveActiveServerIds: () => Promise.resolve(null),
    listConnected: () =>
      Promise.resolve([{ id: ID_B, connectedAt: new Date(t0).toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  await sweepOnce(inertEnv(), inertDb(), {
    registry,
    nowMs: t0 + OFFLINE_SWEEP_STALE_MS + 1,
    resolveActiveServerIds: () => Promise.resolve(null),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date(t0).toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: (_db, id) => {
      disconnected.push(id);
      return Promise.resolve();
    },
    onConnected: () => Promise.resolve(),
  });

  assertEquals(disconnected, []);
});

it("sweepOnce fallback logs truncated when the connected budget is exceeded", async () => {
  resetOfflineSweepNullGraceForTests();
  const overBudget = CONNECTED_SWEEP_BUDGET + 1;
  const connected = Array.from({ length: overBudget }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    connectedAt: new Date().toISOString(),
  }));
  const cells = new Map(
    connected.map((row) => [
      row.id,
      createFakeCell({ connected: true, lastPingAtMs: Date.now() }),
    ]),
  );
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await sweepOnce(inertEnv(), inertDb(), {
      registry: createFakeRegistry(cells),
      nowMs: 1_700_000_000_000,
      resolveActiveServerIds: () => Promise.resolve(null),
      listConnected: () => Promise.resolve(connected),
      listRecentlyOffline: () => Promise.resolve([]),
      onDisconnected: () => Promise.resolve(),
      onConnected: () => Promise.resolve(),
    });
  } finally {
    console.info = originalInfo;
  }
  assertEquals(
    traces.some((line) => line.includes("event=truncated")),
    true,
  );
});

it("sweepOnce: an already-due deadline skips demote as budget-exhausted", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: false, lastPingAtMs: null });
  const cells = new Map([[ID_A, cell]]);
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await sweepOnce(inertEnv(), inertDb(), {
      registry: createFakeRegistry(cells),
      // Probe reserve is 8s; an already-due tick deadline skips later
      // phases immediately (left <= 0) instead of hanging a callback.
      deadlineMs: 0,
      resolveActiveServerIds: () => Promise.resolve(new Map()),
      listConnected: () =>
        Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
      listRecentlyOffline: () => Promise.resolve([]),
      onDisconnected: () => Promise.resolve(),
      onConnected: () => Promise.resolve(),
    });
  } finally {
    console.info = originalInfo;
  }
  assertEquals(
    traces.some((line) =>
      line.includes("event=budget-exhausted") && line.includes("phase=demote")
    ),
    true,
  );
});

it("sweepOnce AE: heal-direct phase timeout is budget-exhausted", async () => {
  resetOfflineSweepNullGraceForTests();
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const offlineAt = "2020-01-01T00:00:00.000Z";
  const aeLatestMs = Date.parse("2020-01-01T00:01:00.000Z");
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await sweepOnce(inertEnv(), inertDb(), {
      registry: createFakeRegistry(new Map()),
      deadlineMs: Date.now() + 25,
      resolveActiveServerIds: () =>
        Promise.resolve(new Map([[ID_A, aeLatestMs]])),
      listConnected: () => Promise.resolve([]),
      listRecentlyOffline: () =>
        Promise.resolve([{ id: ID_A, connectedAt, offlineAt }]),
      onDisconnected: () => Promise.resolve(),
      onConnected: () => Promise.resolve(),
      onConnectedFromEvidence: () => new Promise(() => {}),
    });
  } finally {
    console.info = originalInfo;
  }
  assertEquals(
    traces.some((line) =>
      line.includes("event=budget-exhausted") &&
      line.includes("phase=heal-direct")
    ),
    true,
  );
});

it("sweepOnce fallback: an already-due deadline skips heal after demote", async () => {
  resetOfflineSweepNullGraceForTests();
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await sweepOnce(inertEnv(), inertDb(), {
      registry: createFakeRegistry(new Map()),
      deadlineMs: 0,
      resolveActiveServerIds: () => Promise.resolve(null),
      listConnected: () => Promise.resolve([]),
      listRecentlyOffline: () =>
        Promise.resolve([{
          id: ID_A,
          connectedAt: new Date().toISOString(),
          offlineAt: new Date().toISOString(),
        }]),
      onDisconnected: () => Promise.resolve(),
      onConnected: () => Promise.resolve(),
    });
  } finally {
    console.info = originalInfo;
  }
  // Fallback still enters runBoundedPhase("demote") first; an already-due
  // deadline never reaches heal. The hanging heal-direct case covers the
  // timeout catch on a later phase.
  assertEquals(
    traces.some((line) =>
      line.includes("event=budget-exhausted") && line.includes("phase=demote")
    ),
    true,
  );
  assertEquals(
    traces.some((line) => line.includes("phase=heal")),
    false,
  );
});

it("webhook-delivery sweep runs on the passed db, bounded per tick", async () => {
  let limit: number | undefined;
  let deleteCalls = 0;
  const db = {
    delete: () => ({
      where: (condition: { queryChunks?: unknown[] }) => {
        deleteCalls += 1;
        limit = (condition.queryChunks ?? []).find(
          (chunk) => typeof chunk === "number",
        ) as number | undefined;
        return { returning: () => Promise.resolve([{ id: "delivery-1" }]) };
      },
    }),
  } as unknown as Db;

  await sweepExpiredWebhookDeliveriesSafely(db);

  assertEquals(deleteCalls, 1);
  assertEquals(limit, WEBHOOK_DELIVERY_SWEEP_LIMIT);
});

it("webhook-delivery sweep failures stay isolated from the rest of the tick", async () => {
  const db = {
    delete: () => {
      throw new TypeError("postgres unavailable");
    },
  } as unknown as Db;

  await sweepExpiredWebhookDeliveriesSafely(db);
});

function fakeExecutionLogStore(
  sweep: ExecutionLogStore["sweepExpired"],
): ExecutionLogStore {
  return {
    appendChunk: () => {
      throw new TypeError("unused");
    },
    readFrom: () => {
      throw new TypeError("unused");
    },
    exists: () => {
      throw new TypeError("unused");
    },
    seal: () => {
      throw new TypeError("unused");
    },
    delete: () => {
      throw new TypeError("unused");
    },
    sweepExpired: sweep,
  };
}

it("execution-log sweep traces when transcripts were deleted", async () => {
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await sweepExpiredExecutionLogsSafely(
      fakeExecutionLogStore(() => Promise.resolve(3)),
      90,
    );
  } finally {
    console.info = originalInfo;
  }
  assertEquals(
    traces.some((line) =>
      line.includes("event=execution-logs-swept") && line.includes("deleted=3")
    ),
    true,
  );
});

it("execution-log sweep failures stay isolated from the rest of the tick", async () => {
  await sweepExpiredExecutionLogsSafely(
    fakeExecutionLogStore(() => Promise.reject(new TypeError("r2 down"))),
    90,
  );
});

it("runOfflineSweep logs lease-acquire-failed and returns", async () => {
  const db = {
    insert: () => {
      throw new TypeError("lease db down");
    },
    $client: { end: () => Promise.resolve() },
  } as unknown as Db;
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await runOfflineSweep(inertEnv(), null, { db });
  } finally {
    console.info = originalInfo;
  }
  assertEquals(
    traces.some((line) => line.includes("event=lease-acquire-failed")),
    true,
  );
});

it("runOfflineSweep logs lease-release-failed and still finishes the tick", async () => {
  const lock = createOfflineSweepLockMemoryDb();
  const db = {
    ...lock,
    update: () => ({
      set: () => ({
        where: () => {
          throw new TypeError("release failed");
        },
      }),
    }),
  } as unknown as Db;
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    await runOfflineSweep(inertEnv(), null, {
      db,
      sweepOnceDeps: {
        listConnected: () => Promise.resolve([]),
        listRecentlyOffline: () => Promise.resolve([]),
        resolveActiveServerIds: () => Promise.resolve(new Map()),
        onDisconnected: () => Promise.resolve(),
        onConnected: () => Promise.resolve(),
      },
    });
  } finally {
    console.info = originalInfo;
  }
  assertEquals(
    traces.some((line) => line.includes("event=lease-release-failed")),
    true,
  );
  assertEquals(
    traces.some((line) => line.includes("event=tick-complete")),
    true,
  );
});

// ---------------------------------------------------------------------------
// T12 · the billing phases on the cron tick: skipped wholesale without a key,
// run in order with one, and what a throwing grace clock does to the rest.
// ---------------------------------------------------------------------------

import { createMemoryDb, type MemoryDb } from "../../test-fixtures/memory-db.ts";
import {
  license,
  organization,
  payer,
  server,
  setting,
  subscription,
  subscriptionItem,
  tier,
} from "../../lib/db/schema.ts";
import { BILLING_RECONCILE_REPORT_KEY } from "../../lib/billing/reconcile.ts";

/** Every scheduled phase fires on the hour: execution logs, tier notices, grace clock, reconcile. */
const ON_THE_HOUR = Date.parse("2026-01-01T00:00:00.000Z");

const inertSweep = {
  listConnected: () => Promise.resolve([]),
  listRecentlyOffline: () => Promise.resolve([]),
  resolveActiveServerIds: () => Promise.resolve(new Map<string, number>()),
  onDisconnected: () => Promise.resolve(),
  onConnected: () => Promise.resolve(),
};

/** A projection-shaped memory db; `withSubscription: false` leaves that table unregistered so its first read throws. */
function billingSweepDb(opts: { withSubscription: boolean }): MemoryDb {
  return createMemoryDb([
    [setting, []],
    [organization, []],
    [server, []],
    [license, []],
    [tier, []],
    [payer, []],
    ...(opts.withSubscription ? [[subscription, []] as const] : []),
    [subscriptionItem, []],
  ]);
}

async function runTickCapturingTrace(env: CloudflareBindings, db: Db): Promise<string[]> {
  const traces: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    // `scheduledTime` picks the phases; the budget clock is the real one, so
    // `nowMs` must be live or every phase reads as over budget before it runs.
    await runOfflineSweep(env, null, {
      db,
      scheduledTime: ON_THE_HOUR,
      nowMs: Date.now(),
      sweepOnceDeps: inertSweep,
    });
  } finally {
    console.info = originalInfo;
  }
  return traces;
}

const tickComplete = (traces: string[]) => traces.find((line) => line.includes("event=tick-complete")) ?? "";
const reconcileReport = (db: MemoryDb) => db.rows(setting).find((row) => row.key === BILLING_RECONCILE_REPORT_KEY) ?? null;

it("T12 · with no Stripe key neither billing phase runs: no projection read, no reconcile report, nothing marked skipped", async () => {
  const db = billingSweepDb({ withSubscription: false });
  const traces = await runTickCapturingTrace(inertEnv(), db);
  // The grace clock would have read `subscription` (unregistered here, so it
  // would have thrown) and reconcile would have listed payers.
  assertEquals(db.ops.includes("select:subscription"), false);
  assertEquals(db.ops.includes("select:payer"), false);
  assertEquals(reconcileReport(db), null);
  assertEquals(tickComplete(traces).includes("phasesSkipped=[]"), true);
});

it("T12 · with a key both billing phases run on their tick: the grace clock scans subscriptions, reconcile lists payers and writes its report", async () => {
  const db = billingSweepDb({ withSubscription: true });
  const env = { TURBOPANEL_STRIPE_SECRET_KEY: "sk_test_x" } as unknown as CloudflareBindings;
  const traces = await runTickCapturingTrace(env, db);
  assertEquals(db.ops.includes("select:subscription"), true);
  assertEquals(db.ops.includes("select:payer"), true);
  assertEquals(reconcileReport(db) !== null, true);
  assertEquals(tickComplete(traces).includes("phasesSkipped=[]"), true);
});

it("T12 · finding: a throwing grace clock is NOT isolated — reconcile and the queued sweeps after it are skipped on that tick", async () => {
  // `subscription` is unregistered, so the grace clock's first read throws.
  const db = billingSweepDb({ withSubscription: false });
  const env = { TURBOPANEL_STRIPE_SECRET_KEY: "sk_test_x" } as unknown as CloudflareBindings;
  const traces = await runTickCapturingTrace(env, db);
  assertEquals(
    traces.some((line) => line.includes("event=budget-exhausted") && line.includes("phase=billing-grace-clock")),
    true,
  );
  // The code comment promises each billing phase is isolated; the optional
  // phase runner aborts the chain instead, exactly as it does for the other
  // optional phases. Reconcile is Postgres-only and did not need Stripe.
  const done = tickComplete(traces);
  for (const phase of ["billing-grace-clock", "billing-reconcile", "reconcile"]) {
    assertEquals(done.includes(phase), true, phase);
  }
  assertEquals(db.ops.includes("select:payer"), false);
  assertEquals(reconcileReport(db), null);
  // The tick lease is still released.
  assertEquals((await tryBeginOfflineSweep(db)) !== null, true);
});
