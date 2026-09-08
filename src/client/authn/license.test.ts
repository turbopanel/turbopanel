import { and, eq } from 'drizzle-orm'
import { assertEquals } from '@std/assert'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { license, organization, server } from '../../lib/db/schema.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
} from './authn-hostfree-doubles.ts'
import {
  createLicense,
  generateLicenseToken,
  invalidateLicense,
  listLicenses,
  listServersBoundToLicenses,
  lookupActiveLicense,
  revokeLicense,
  verifyLicenseToken,
} from './license.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

test('generateLicenseToken and verifyLicenseToken round-trip', async () => {
  const { plaintext, hashed } = await generateLicenseToken()
  assertEquals(plaintext.length, 48)
  assertEquals(hashed.startsWith('$argon2id$'), true)
  assertEquals(await verifyLicenseToken(plaintext, hashed), true)
  assertEquals(await verifyLicenseToken('wrong-token', hashed), false)
})

test('createLicense stores a hashed token and returns plaintext once', async () => {
  if (!dbUrl) {
    console.warn('Skipping license DB test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'License Test Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id

  try {
    const created = await createLicense(db, {
      organizationId,
      name: 'Test key',
    })
    assertEquals(typeof created.licenseId, 'string')
    assertEquals(created.licenseToken.length, 48)

    const active = await lookupActiveLicense(db, created.licenseId)
    if (!active) {
      throw new TypeError('expected active license row')
    }
    assertEquals(active.organizationId, organizationId)
    assertEquals(await verifyLicenseToken(created.licenseToken, active.token), true)

    const listed = await listLicenses(db, organizationId)
    assertEquals(listed.some((row) => row.id === created.licenseId), true)
  } finally {
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('revokeLicense is idempotent and invalidateLicense returns server ids', async () => {
  if (!dbUrl) {
    console.warn('Skipping license revoke test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'License Revoke Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id

  try {
    const created = await createLicense(db, { organizationId })
    assertEquals(await revokeLicense(db, created.licenseId, organizationId), true)
    assertEquals(await revokeLicense(db, created.licenseId, organizationId), false)

    const invalidated = await invalidateLicense(db, created.licenseId, organizationId)
    assertEquals(invalidated.ok, false)

    const bound = await listServersBoundToLicenses(
      db,
      organizationId,
      [created.licenseId],
    )
    assertEquals(bound.size, 0)

    assertEquals(await lookupActiveLicense(db, created.licenseId), null)

    const listed = await listLicenses(db, organizationId)
    assertEquals(listed.some((row) => row.id === created.licenseId), false)
  } finally {
    await db.delete(license).where(and(eq(license.organizationId, organizationId)))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('invalidateLicense refuses while a live server is attached', async () => {
  if (!dbUrl) {
    console.warn('Skipping license attach test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'License Attach Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const now = new Date().toISOString()
  const [bound] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Attached host',
    })
    .returning({ id: server.id, name: server.name })
  const serverId = bound!.id

  try {
    const created = await createLicense(db, { organizationId, name: 'Attached seat' })
    await db
      .update(license)
      .set({ serverId, updatedAt: now })
      .where(eq(license.id, created.licenseId))

    const refused = await invalidateLicense(db, created.licenseId, organizationId)
    assertEquals(refused.ok, false)
    if (!refused.ok) {
      assertEquals(refused.reason, 'attached')
      if (refused.reason === 'attached') {
        assertEquals(refused.boundServer.id, serverId)
        assertEquals(refused.boundServer.name, 'Attached host')
      }
    }

    const forced = await invalidateLicense(
      db,
      created.licenseId,
      organizationId,
      { force: true },
    )
    assertEquals(forced.ok, true)
    if (forced.ok) {
      assertEquals(forced.serverIds, [serverId])
    }
    assertEquals(await lookupActiveLicense(db, created.licenseId), null)
  } finally {
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('invalidateLicense does not treat a revoked attached row as occupied', async () => {
  if (!dbUrl) {
    console.warn('Skipping license revoked-attach test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'License Revoked Attach Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const now = new Date().toISOString()
  const [bound] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Stale host',
    })
    .returning({ id: server.id })
  const serverId = bound!.id

  try {
    const created = await createLicense(db, { organizationId })
    await db
      .update(license)
      .set({ serverId, updatedAt: now })
      .where(eq(license.id, created.licenseId))
    assertEquals(await revokeLicense(db, created.licenseId, organizationId), true)

    const result = await invalidateLicense(db, created.licenseId, organizationId)
    assertEquals(result.ok, false)
    if (!result.ok) {
      assertEquals(result.reason, 'not_found')
    }
  } finally {
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('listServersBoundToLicenses returns empty map for empty id list', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const bound = await listServersBoundToLicenses(
    db,
    '00000000-0000-4000-8000-000000000010',
    [],
  )
  assertEquals(bound.size, 0)
})

test('lookupActiveLicense returns null when mock store is empty', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  assertEquals(
    await lookupActiveLicense(db, '00000000-0000-4000-8000-000000000011'),
    null,
  )
})

test('createLicense inserts into mock store and lists active licenses', async () => {
  const state = createEmptyMockAuthState()
  const db = createMockAuthDb(state)
  const organizationId = '00000000-0000-4000-8000-000000000012'

  const created = await createLicense(db, {
    organizationId,
    name: 'Mock seat',
  })
  assertEquals(created.licenseToken.length, 48)
  assertEquals(state.licenses.length, 1)

  const listed = await listLicenses(db, organizationId)
  assertEquals(listed.length, 1)
  assertEquals(listed[0]?.id, created.licenseId)

  const active = await lookupActiveLicense(db, created.licenseId)
  if (!active) {
    throw new TypeError('expected mock lookupActiveLicense to return a row')
  }
  assertEquals(await verifyLicenseToken(created.licenseToken, active.token), true)
})

test('invalidateLicense revokes mock license and reports no bound servers', async () => {
  const state = createEmptyMockAuthState()
  const db = createMockAuthDb(state)
  const organizationId = '00000000-0000-4000-8000-000000000013'
  const created = await createLicense(db, { organizationId })

  const result = await invalidateLicense(db, created.licenseId, organizationId)
  if (!result.ok) {
    throw new TypeError('expected mock invalidateLicense to succeed')
  }
  assertEquals(result.serverIds.length, 0)
  assertEquals(await lookupActiveLicense(db, created.licenseId), null)
})

test('listServersBoundToLicenses maps mock license server bindings', async () => {
  const state = createEmptyMockAuthState()
  const organizationId = '00000000-0000-4000-8000-000000000014'
  const licenseId = '00000000-0000-4000-8000-000000000015'
  const serverId = '00000000-0000-4000-8000-000000000016'
  state.licenses.push({
    id: licenseId,
    organizationId,
    name: 'Bound seat',
    token: 'hashed-token',
    revokedAt: null,
    serverId,
    createdAt: new Date().toISOString(),
  })
  const db = createMockAuthDb(state)

  const bound = await listServersBoundToLicenses(db, organizationId, [licenseId])
  assertEquals(bound.size, 1)
  const row = bound.get(licenseId)
  if (!row) {
    throw new TypeError('expected bound server row for mock license')
  }
  assertEquals(row.id, serverId)
  assertEquals(row.name, 'Bound seat')
})
