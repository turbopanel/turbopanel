import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { revokeDaemonKey } from '../../daemon/authn/server-identity-db.ts'
import { license, server } from '../../lib/db/schema.ts'
import { generatePassword } from '../../generate-secret.ts'
import { hashPassword, verifyPassword } from './password.ts'

export type LicenseRecord = {
  id: string
  organizationId: string
  name: string | null
  createdAt: string
}

function nowTs(): string {
  return new Date().toISOString()
}

export async function generateLicenseToken(): Promise<{
  plaintext: string
  hashed: string
}> {
  const plaintext = generatePassword()
  const hashed = await hashPassword(plaintext)
  return { plaintext, hashed }
}

export async function verifyLicenseToken(
  plaintext: string,
  hashed: string,
): Promise<boolean> {
  return verifyPassword(plaintext, hashed)
}

/**
 * Mint one registration key. A license carries no tier: which purchased
 * tier the server it binds ends up on is derived
 * (`src/lib/tiers/assignment.ts`).
 */
export async function createLicense(
  db: Db,
  opts: { organizationId: string; name?: string },
): Promise<{ licenseId: string; licenseToken: string }> {
  const { plaintext, hashed } = await generateLicenseToken()
  const now = nowTs()

  const inserted = await db
    .insert(license)
    .values({
      organizationId: opts.organizationId,
      name: opts.name ?? null,
      token: hashed,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: license.id })

  const licenseId = inserted[0]?.id
  if (!licenseId) {
    throw new Error('License creation failed')
  }

  return { licenseId, licenseToken: plaintext }
}

export async function revokeLicense(
  db: Db,
  licenseId: string,
  organizationId: string,
): Promise<boolean> {
  const updated = await db
    .update(license)
    .set({ revokedAt: nowTs(), updatedAt: nowTs() })
    .where(and(
      eq(license.id, licenseId),
      eq(license.organizationId, organizationId),
      isNull(license.revokedAt),
    ))
    .returning({ id: license.id })

  return updated.length > 0
}

export async function disconnectServersBoundToLicense(
  db: Db,
  licenseId: string,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: server.id })
    .from(license)
    .innerJoin(server, eq(server.id, license.serverId))
    .where(and(
      eq(license.id, licenseId),
      eq(license.organizationId, organizationId),
    ))

  const serverIds: string[] = []
  for (const row of rows) {
    serverIds.push(row.id)
    await revokeDaemonKey(db, row.id)
  }
  return serverIds
}

export type LicenseAttachment =
  | { ok: false; reason: 'not_found' }
  | { ok: true; boundServer: { id: string; name: string | null } | null }

/** What `invalidateLicense` would see, without revoking anything: the bound server. */
export async function inspectLicenseAttachment(
  db: Db,
  licenseId: string,
  organizationId: string,
): Promise<LicenseAttachment> {
  const rows = await db
    .select({
      serverId: license.serverId,
      boundId: server.id,
      boundName: server.name,
    })
    .from(license)
    .leftJoin(server, eq(server.id, license.serverId))
    .where(and(
      eq(license.id, licenseId),
      eq(license.organizationId, organizationId),
      isNull(license.revokedAt),
    ))
    .limit(1)
  const row = rows[0]
  if (!row) return { ok: false, reason: 'not_found' }
  const boundId = row.boundId ?? row.serverId
  return {
    ok: true,
    boundServer: boundId ? { id: boundId, name: row.boundName ?? null } : null,
  }
}

export type InvalidateLicenseResult =
  | { ok: false; reason: 'not_found' }
  | {
    ok: false
    reason: 'attached'
    boundServer: { id: string; name: string | null }
  }
  | { ok: true; serverIds: string[] }

/**
 * Soft-invalidates a license. A live `server_id` attachment without `force`
 * is refused so the console can tell the operator to delete the server first.
 * `serverIds` is always empty on the non-force success path because attachment
 * was refused. `revokeLicense` + `disconnectServersBoundToLicense` run only
 * when `force` is set (or the seat is already unbound).
 */
export async function invalidateLicense(
  db: Db,
  licenseId: string,
  organizationId: string,
  opts?: { force?: boolean },
): Promise<InvalidateLicenseResult> {
  const rows = await db
    .select({
      licenseId: license.id,
      serverId: license.serverId,
      boundId: server.id,
      boundName: server.name,
    })
    .from(license)
    .leftJoin(server, eq(server.id, license.serverId))
    .where(and(
      eq(license.id, licenseId),
      eq(license.organizationId, organizationId),
      isNull(license.revokedAt),
    ))
    .limit(1)
  const row = rows[0]
  if (!row) return { ok: false, reason: 'not_found' }

  const boundId = row.boundId ?? row.serverId
  if (boundId && !opts?.force) {
    return {
      ok: false,
      reason: 'attached',
      boundServer: { id: boundId, name: row.boundName ?? null },
    }
  }

  const revoked = await revokeLicense(db, licenseId, organizationId)
  if (!revoked) return { ok: false, reason: 'not_found' }
  if (!opts?.force) return { ok: true, serverIds: [] }
  const serverIds = await disconnectServersBoundToLicense(
    db,
    licenseId,
    organizationId,
  )
  return { ok: true, serverIds }
}

export type LicenseBoundServer = {
  id: string
  name: string | null
}

export async function listServersBoundToLicenses(
  db: Db,
  organizationId: string,
  licenseIds: string[],
): Promise<Map<string, LicenseBoundServer>> {
  const bound = new Map<string, LicenseBoundServer>()
  if (licenseIds.length === 0) return bound

  const rows = await db
    .select({
      licenseId: license.id,
      id: server.id,
      name: server.name,
    })
    .from(license)
    .innerJoin(server, eq(server.id, license.serverId))
    .where(and(
      eq(license.organizationId, organizationId),
      inArray(license.id, licenseIds),
    ))

  for (const row of rows) {
    bound.set(row.licenseId, { id: row.id, name: row.name })
  }

  return bound
}

export async function listLicenses(
  db: Db,
  organizationId: string,
): Promise<LicenseRecord[]> {
  return db
    .select({
      id: license.id,
      organizationId: license.organizationId,
      name: license.name,
      createdAt: license.createdAt,
    })
    .from(license)
    .where(and(
      eq(license.organizationId, organizationId),
      isNull(license.revokedAt),
    ))
}

export async function lookupActiveLicense(
  db: Db,
  licenseId: string,
): Promise<{ organizationId: string; token: string } | null> {
  const rows = await db
    .select({
      organizationId: license.organizationId,
      token: license.token,
    })
    .from(license)
    .where(and(eq(license.id, licenseId), isNull(license.revokedAt)))
    .limit(1)

  return rows[0] ?? null
}
