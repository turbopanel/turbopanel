import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { organization, server, topologyGeneration } from '../../lib/db/schema.ts'
import {
  getLatestTopologyGeneration,
  getLatestTopologyGenerations,
  getTopologyGeneration,
  layoutPathsFromSnapshot,
  recordTopologyGeneration,
} from './server-topology-records.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withServerFixture(
  fn: (ctx: { db: ReturnType<typeof createDenoDb>; serverId: string }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping server topology records tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Topology Records Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Server Topology Records Server',
      isConnected: true,
      statusChangedAt: now,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({ db, serverId })
  } finally {
    await db.delete(topologyGeneration).where(eq(topologyGeneration.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('layoutPathsFromSnapshot reads a v6 snapshot and answers null for older or malformed ones', () => {
  assertEquals(
    layoutPathsFromSnapshot({
      generation: 3,
      paths: { backup: '/mnt/nas/backups', logs: '/var/log/turbopanel' },
    }),
    { backup: '/mnt/nas/backups', logs: '/var/log/turbopanel' }
  )
  // Pre-v6 daemon: no `paths` at all.
  assertEquals(layoutPathsFromSnapshot({ generation: 3, hardwareSignals: [] }), null)
  // Half a record is no record.
  assertEquals(layoutPathsFromSnapshot({ paths: { backup: '/backup' } }), null)
  assertEquals(
    layoutPathsFromSnapshot({ paths: { backup: '', logs: '/var/log/turbopanel' } }),
    null
  )
  assertEquals(layoutPathsFromSnapshot(null), null)
  assertEquals(layoutPathsFromSnapshot([]), null)
})

test('getLatestTopologyGeneration returns the highest recorded generation', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTopologyGeneration(db, serverId, {
      generation: 2,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a', 'nic-b'] },
      appliedAt: '2026-01-01T00:05:00.000Z',
    })

    const latest = await getLatestTopologyGeneration(db, serverId)
    assertEquals(latest?.generation, 2)
    assertEquals(latest?.bootGeneration, 1)
    // The daemon-reported object is stored directly — never wrapped.
    assertEquals(latest?.snapshot, { devices: ['nic-a', 'nic-b'] })
    // The daemon's own report timestamp is preserved, not a receipt time.
    assertEquals(Date.parse(latest?.appliedAt ?? ''), Date.parse('2026-01-01T00:05:00.000Z'))
  })
})

async function withTwoServerFixture(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverIdA: string
    serverIdB: string
    serverIdC: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping server topology records tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Topology Records Batch Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const insertedServers = await db
    .insert(server)
    .values(
      ['A', 'B', 'C'].map((label) => ({
        organizationId,
        name: `Server Topology Records Batch Server ${label}`,
        isConnected: true,
        statusChangedAt: now,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      }))
    )
    .returning({ id: server.id })
  const [serverIdA, serverIdB, serverIdC] = insertedServers.map((row) => row.id)

  try {
    await fn({
      db,
      serverIdA: serverIdA!,
      serverIdB: serverIdB!,
      serverIdC: serverIdC!,
    })
  } finally {
    for (const serverId of [serverIdA, serverIdB, serverIdC]) {
      await db.delete(topologyGeneration).where(eq(topologyGeneration.serverId, serverId!))
      await db.delete(server).where(eq(server.id, serverId!))
    }
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('getLatestTopologyGenerations returns the highest generation per server in one query, omitting servers with none recorded', async () => {
  await withTwoServerFixture(async ({ db, serverIdA, serverIdB, serverIdC }) => {
    await recordTopologyGeneration(db, serverIdA, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['a-gen1'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTopologyGeneration(db, serverIdA, {
      generation: 2,
      bootGeneration: 1,
      snapshot: { devices: ['a-gen2'] },
      appliedAt: '2026-01-01T00:05:00.000Z',
    })
    await recordTopologyGeneration(db, serverIdB, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['b-gen1'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    // serverIdC deliberately has no recorded generation.

    const byServer = await getLatestTopologyGenerations(db, [serverIdA, serverIdB, serverIdC])
    assertEquals(byServer.size, 2)
    assertEquals(byServer.get(serverIdA)?.generation, 2)
    assertEquals(byServer.get(serverIdA)?.snapshot, { devices: ['a-gen2'] })
    assertEquals(byServer.get(serverIdB)?.generation, 1)
    assertEquals(byServer.has(serverIdC), false)
  })
})

test('getLatestTopologyGenerations returns an empty map for an empty serverIds list without querying', async () => {
  await withTwoServerFixture(async ({ db }) => {
    const byServer = await getLatestTopologyGenerations(db, [])
    assertEquals(byServer.size, 0)
  })
})

test('getTopologyGeneration resolves a specific historical generation', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTopologyGeneration(db, serverId, {
      generation: 2,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a', 'nic-b'] },
      appliedAt: '2026-01-01T00:05:00.000Z',
    })

    const historical = await getTopologyGeneration(db, serverId, 1)
    assertEquals(historical?.generation, 1)
    assertEquals(historical?.snapshot, { devices: ['nic-a'] })
    assertEquals(Date.parse(historical?.appliedAt ?? ''), Date.parse('2026-01-01T00:00:00.000Z'))

    const missing = await getTopologyGeneration(db, serverId, 99)
    assertEquals(missing, undefined)
  })
})

test('recordTopologyGeneration is idempotent for a repeated generation number', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    // Simulates the daemon resending an unchanged generation on reconnect.
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a', 'nic-b-should-not-be-recorded'] },
      appliedAt: '2026-01-01T00:10:00.000Z',
    })

    const rows = await db
      .select()
      .from(topologyGeneration)
      .where(eq(topologyGeneration.serverId, serverId))
    assertEquals(rows.length, 1)

    const record = await getTopologyGeneration(db, serverId, 1)
    assertEquals(record?.snapshot, { devices: ['nic-a'] })
    // The second call's appliedAt is dropped along with the rest of its row.
    assertEquals(Date.parse(record?.appliedAt ?? ''), Date.parse('2026-01-01T00:00:00.000Z'))
  })
})
