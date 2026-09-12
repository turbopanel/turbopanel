/**
 * Host-free coverage for the deferred repin fan-out sweep: a fake `Db`
 * serves the pending-pin select and records marker clears; the enqueueing
 * core is injected so no command queue or secrets are exercised.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import type {
  DerivedSecretsConfig,
  SecretsConfig,
} from "../authn/secrets.ts";
import { parseIpPinMetadata } from "../../lib/net/repin.ts";
import type { DatacenterRoutingFanoutParams } from "./routing-fanout.ts";
import {
  DATACENTER_REPIN_FANOUT_SWEEP_CAP,
  runDatacenterRepinFanoutSweep,
} from "./repin-fanout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG_A = "00000000-0000-4000-8000-0000000000b1";
const DC_A = "00000000-0000-4000-8000-0000000000d1";
const DC_B = "00000000-0000-4000-8000-0000000000d2";
const SERVER_1 = "00000000-0000-4000-8000-0000000000a1";
const SERVER_2 = "00000000-0000-4000-8000-0000000000a2";

type PendingRow = {
  id: string;
  organization_id: string;
  datacenter_id: string;
  server_id: string;
  metadata: unknown;
};

function pendingRow(
  id: string,
  datacenterId: string,
  serverId: string,
): PendingRow {
  return {
    id,
    organization_id: ORG_A,
    datacenter_id: datacenterId,
    server_id: serverId,
    metadata: {
      note: "keep",
      repin: {
        at: "2026-09-02T00:00:00.000Z",
        from: "10.20.0.10",
        pendingFanoutAt: "2026-09-02T00:00:00.000Z",
      },
    },
  };
}

function createFakeDb(params: {
  pending: PendingRow[];
  clears: Array<{ metadata: unknown }>;
  seenLimit: (limit: number) => void;
}): Db {
  return {
    execute(query: { queryChunks?: unknown[] }) {
      // The LIMIT parameter is the only bound value in the sweep's select.
      for (const chunk of query.queryChunks ?? []) {
        if (typeof chunk === "number") params.seenLimit(chunk);
      }
      return Promise.resolve(params.pending);
    },
    update() {
      return {
        set(patch: { metadata: unknown }) {
          return {
            where: () => {
              params.clears.push({ metadata: patch.metadata });
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

const queue = {} as CommandQueue;
const secrets = {
  secretsConfig: {} as SecretsConfig,
  dataEncryptionSecrets: {} as DerivedSecretsConfig,
};

test("sweep fans out once per (org, datacenter) group and clears markers", async () => {
  const clears: Array<{ metadata: unknown }> = [];
  const fanOuts: DatacenterRoutingFanoutParams[] = [];
  const db = createFakeDb({
    pending: [
      pendingRow("ip-1", DC_A, SERVER_1),
      pendingRow("ip-2", DC_A, SERVER_2),
      pendingRow("ip-3", DC_B, SERVER_1),
    ],
    clears,
    seenLimit: () => {},
  });

  const result = await runDatacenterRepinFanoutSweep(db, queue, secrets, {
    fanOut: (_db, _queue, p) => {
      fanOuts.push(p);
      return Promise.resolve({ managedIds: [] });
    },
    listManagedIdsForServer: (_db, serverId) =>
      Promise.resolve(serverId === SERVER_1 ? ["managed-1"] : ["managed-2"]),
  });

  assertEquals(result, { processed: 3 });
  assertEquals(fanOuts.length, 2);
  assertEquals(fanOuts[0]?.datacenterId, DC_A);
  assertEquals(fanOuts[0]?.organizationId, ORG_A);
  assertEquals(fanOuts[0]?.actorType, "system");
  assertEquals(fanOuts[0]?.actorId, SERVER_1);
  assertEquals(fanOuts[0]?.extraManagedIds, ["managed-1", "managed-2"]);
  assertEquals(fanOuts[1]?.datacenterId, DC_B);
  assertEquals(fanOuts[1]?.extraManagedIds, ["managed-1"]);

  assertEquals(clears.length, 3);
  for (const clear of clears) {
    const metadata = clear.metadata as Record<string, unknown>;
    assertEquals(metadata.note, "keep");
    const parsed = parseIpPinMetadata(metadata);
    assertEquals(parsed.repin, {
      at: "2026-09-02T00:00:00.000Z",
      from: "10.20.0.10",
    });
  }
});

test("sweep retains markers for a group whose fan-out failed", async () => {
  const clears: Array<{ metadata: unknown }> = [];
  const db = createFakeDb({
    pending: [
      pendingRow("ip-1", DC_A, SERVER_1),
      pendingRow("ip-3", DC_B, SERVER_1),
    ],
    clears,
    seenLimit: () => {},
  });

  const result = await runDatacenterRepinFanoutSweep(db, queue, secrets, {
    fanOut: (_db, _queue, p) =>
      p.datacenterId === DC_A
        ? Promise.reject(new Error("queue unavailable"))
        : Promise.resolve({ managedIds: [] }),
    listManagedIdsForServer: () => Promise.resolve([]),
  });

  assertEquals(result, { processed: 1 });
  assertEquals(clears.length, 1);
});

test("sweep respects and caps the budget", async () => {
  const limits: number[] = [];
  const db = createFakeDb({
    pending: [],
    clears: [],
    seenLimit: (limit) => limits.push(limit),
  });

  assertEquals(
    await runDatacenterRepinFanoutSweep(db, queue, { ...secrets, budget: 5 }),
    { processed: 0 },
  );
  assertEquals(
    await runDatacenterRepinFanoutSweep(db, queue, {
      ...secrets,
      budget: 10_000,
    }),
    { processed: 0 },
  );
  assertEquals(
    await runDatacenterRepinFanoutSweep(db, queue, { ...secrets, budget: 0 }),
    { processed: 0 },
  );
  assertEquals(limits, [5, DATACENTER_REPIN_FANOUT_SWEEP_CAP, 1]);
});
