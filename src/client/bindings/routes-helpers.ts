/**
 * Pure helpers for the bindings API (prefix validation, collision detection,
 * serialization, and wire-error mapping — extracted for host-free coverage).
 */

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { binding, hosting, managed, principal, variable } from '../../lib/db/schema.ts'
import { getManagedEngineSpec } from '../../lib/managed/index.ts'
import { assertSafeBindingKeyPrefix, DEFAULT_BINDING_KEY_PREFIX } from '../../lib/naming.ts'
import { parseManagedRowOptions } from '../managed/options.ts'
import { isManagedReplicationPrincipal, isManagedRootPrincipal } from '../managed/routes-helpers.ts'
import { listBindingEmittedKeys } from './materialize.ts'
import { isBindingEndpointError, resolveBindingEndpoint } from './resolve-endpoint.ts'

export { assertSafeBindingKeyPrefix, DEFAULT_BINDING_KEY_PREFIX }

export const BINDING_KEY_PREFIX_IN_USE_ERROR = 'binding_key_prefix_in_use'
export const BINDING_ENGINE_DEFAULTS_IN_USE_ERROR = 'binding_engine_defaults_in_use'
export const BINDING_KEY_CONFLICT_ERROR = 'binding_key_conflict'
export const BINDING_ENDPOINT_UNAVAILABLE_ERROR = 'binding_endpoint_unavailable'

export type BindingRow = {
  id: string
  principalId: string
  serviceId: string
  databaseName: string
  keyPrefix: string
  emitEngineDefaults: boolean
  createdAt: string
  updatedAt: string
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  )
}

/**
 * Map a materialize failure onto the HTTP status + body the bindings API
 * returns (callers wrap with `c.json`).
 */
export function bindingMaterializeHttpPayload(
  materializeResult: Readonly<{ kind: string }>,
): { status: 400 | 422; body: { error: string } } {
  if (
    materializeResult.kind === 'binding_endpoint_unavailable' ||
    materializeResult.kind === 'datacenter_ip_required' ||
    materializeResult.kind === 'private_path_unavailable' ||
    // Bindings resolve with `client-backend`, which never raises this; listed
    // so the mapping over `PrivateEndpointError` stays total.
    materializeResult.kind === 'failover_requires_trusted_datacenter'
  ) {
    return { status: 422, body: { error: BINDING_ENDPOINT_UNAVAILABLE_ERROR } }
  }
  return { status: 400, body: { error: materializeResult.kind } }
}

/**
 * Validate engine binding support + target database name. Returns an error
 * message string, or `null` when the target is acceptable.
 */
export function checkBindingDatabaseTarget(
  managedRow: Readonly<{ engine: string | null; options: unknown }>,
  databaseName: string,
): string | null {
  if (!managedRow.engine) {
    return 'binding_engine_unsupported'
  }
  const spec = getManagedEngineSpec(managedRow.engine)
  if (!spec?.binding) {
    return 'binding_engine_unsupported'
  }
  const options = parseManagedRowOptions(spec, managedRow.options)
  if (!options) return 'Invalid managed options'
  if (!options.databases.includes(databaseName)) {
    return 'database_not_found'
  }
  const { pattern, maxLength } = spec.userOperations.identifier
  if (!pattern.test(databaseName) || databaseName.length > maxLength) {
    return 'Invalid database name'
  }
  return null
}

/**
 * Resolve PATCH field overrides for `keyPrefix` / `emitEngineDefaults`.
 */
export function resolvePatchBindingFields(
  body: Readonly<Record<string, unknown>>,
  row: Readonly<{ keyPrefix: string; emitEngineDefaults: boolean }>,
):
  | { ok: true; keyPrefix: string; emitEngineDefaults: boolean }
  | { ok: false; error: string } {
  let keyPrefix = row.keyPrefix
  if (body.keyPrefix !== undefined) {
    const prefixParsed = parseBindingKeyPrefix(body.keyPrefix)
    if (!prefixParsed.ok) return { ok: false, error: prefixParsed.error }
    keyPrefix = prefixParsed.prefix
  }

  let emitEngineDefaults = row.emitEngineDefaults
  if (body.emitEngineDefaults !== undefined) {
    const emitParsed = parseEmitEngineDefaults(body.emitEngineDefaults)
    if (!emitParsed.ok) return { ok: false, error: emitParsed.error }
    emitEngineDefaults = emitParsed.value
  }

  return { ok: true, keyPrefix, emitEngineDefaults }
}

export type BindingConflictError =
  | { error: typeof BINDING_KEY_PREFIX_IN_USE_ERROR }
  | { error: typeof BINDING_ENGINE_DEFAULTS_IN_USE_ERROR }
  | { error: typeof BINDING_KEY_CONFLICT_ERROR; key: string }

export async function detectBindingCreateConflicts(
  db: Db,
  params: Readonly<{
    serviceId: string
    keyPrefix: string
    emitEngineDefaults: boolean
    engineCode: string
  }>,
): Promise<BindingConflictError | null> {
  if (await isPrefixInUse(db, params.serviceId, params.keyPrefix)) {
    return { error: BINDING_KEY_PREFIX_IN_USE_ERROR }
  }
  if (
    params.emitEngineDefaults &&
    (await isEngineDefaultsInUse(db, params.serviceId))
  ) {
    return { error: BINDING_ENGINE_DEFAULTS_IN_USE_ERROR }
  }
  const keyCheck = await assertNoBindingKeyConflicts(db, {
    serviceId: params.serviceId,
    keyPrefix: params.keyPrefix,
    emitEngineDefaults: params.emitEngineDefaults,
    engineCode: params.engineCode,
  })
  if (!keyCheck.ok) {
    return { error: BINDING_KEY_CONFLICT_ERROR, key: keyCheck.key }
  }
  return null
}

export async function detectBindingUpdateConflicts(
  db: Db,
  params: Readonly<{
    id: string
    serviceId: string
    previousKeyPrefix: string
    previousEmitEngineDefaults: boolean
    nextKeyPrefix: string
    nextEmitEngineDefaults: boolean
    engineCode: string
  }>,
): Promise<BindingConflictError | null> {
  if (
    params.nextKeyPrefix !== params.previousKeyPrefix &&
    (await isPrefixInUse(db, params.serviceId, params.nextKeyPrefix, params.id))
  ) {
    return { error: BINDING_KEY_PREFIX_IN_USE_ERROR }
  }
  if (
    params.nextEmitEngineDefaults &&
    !params.previousEmitEngineDefaults &&
    (await isEngineDefaultsInUse(db, params.serviceId, params.id))
  ) {
    return { error: BINDING_ENGINE_DEFAULTS_IN_USE_ERROR }
  }
  const keyCheck = await assertNoBindingKeyConflicts(db, {
    serviceId: params.serviceId,
    keyPrefix: params.nextKeyPrefix,
    emitEngineDefaults: params.nextEmitEngineDefaults,
    engineCode: params.engineCode,
    excludeBindingId: params.id,
  })
  if (!keyCheck.ok) {
    return { error: BINDING_KEY_CONFLICT_ERROR, key: keyCheck.key }
  }
  return null
}

export async function resolveBindingPrincipalManagedId(
  db: Db,
  principalId: string,
): Promise<string | null> {
  const [principalRow] = await db
    .select({ managedId: principal.managedId })
    .from(principal)
    .where(eq(principal.id, principalId))
    .limit(1)
  return principalRow?.managedId ?? null
}

/** Resolve the engine code (default `postgres`) driving a binding's key set. */
export async function resolveBindingPrincipalEngine(
  db: Db,
  principalId: string,
): Promise<{ managedId: string | null; engineCode: string }> {
  const managedId = await resolveBindingPrincipalManagedId(db, principalId)
  if (!managedId) return { managedId: null, engineCode: 'postgres' }

  const [mrow] = await db
    .select({ engine: managed.engine })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  return { managedId, engineCode: mrow?.engine ?? 'postgres' }
}

export async function serializeBindingRow(db: Db, row: BindingRow) {
  const [principalRow] = await db
    .select({
      managedId: principal.managedId,
      username: principal.username,
    })
    .from(principal)
    .where(eq(principal.id, row.principalId))
    .limit(1)

  let engine: string | null = null
  const managedId: string | null = principalRow?.managedId ?? null
  let managedEnvironmentId: string | null = null
  let endpoint: { host: string; port: number } | null = null
  let readSplit: boolean | null = null
  let keys: string[] = []

  if (managedId) {
    const [mrow] = await db
      .select({
        id: managed.id,
        engine: managed.engine,
        options: managed.options,
        environmentId: managed.environmentId,
      })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    if (mrow?.engine) {
      engine = mrow.engine
      managedEnvironmentId = mrow.environmentId
      const spec = getManagedEngineSpec(mrow.engine)
      keys = listBindingEmittedKeys({
        keyPrefix: row.keyPrefix,
        emitEngineDefaults: row.emitEngineDefaults,
        engineCode: mrow.engine,
      }) ?? []
      if (spec) {
        const options = parseManagedRowOptions(spec, mrow.options)
        if (options) {
          const resolved = await resolveBindingEndpoint(db, {
            serviceId: row.serviceId,
            managedId: mrow.id,
            engineCode: mrow.engine,
            engineDefaultPort: spec.defaultPort,
          })
          if (!isBindingEndpointError(resolved)) {
            endpoint = { host: resolved.host, port: resolved.port }
            readSplit = resolved.readSplit
          }
        }
      }
    }
  }

  return {
    id: row.id,
    principalId: row.principalId,
    serviceId: row.serviceId,
    databaseName: row.databaseName,
    keyPrefix: row.keyPrefix,
    emitEngineDefaults: row.emitEngineDefaults,
    keys,
    endpoint,
    engine,
    managedId,
    managedEnvironmentId,
    readSplit,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export type BindingListRow = {
  id: string
  principalId: string
  serviceId: string
  databaseName: string
  keyPrefix: string
  emitEngineDefaults: boolean
  createdAt: string
  updatedAt: string
  keys: string[]
  endpoint: { host: string; port: number } | null
  engine: string | null
  managedId: string | null
  managedEnvironmentId: string | null
  readSplit: boolean | null
}

/**
 * Parse + validate `keyPrefix` from a body field. Returns either the safe
 * prefix or an error code string (caller maps to HTTP status).
 */
export function parseBindingKeyPrefix(
  value: unknown,
): { ok: true; prefix: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { ok: true, prefix: DEFAULT_BINDING_KEY_PREFIX }
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'Invalid request' }
  }
  try {
    return { ok: true, prefix: assertSafeBindingKeyPrefix(value) }
  } catch {
    return { ok: false, error: 'Invalid keyPrefix' }
  }
}

export function parseEmitEngineDefaults(
  value: unknown,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: true }
  }
  if (typeof value !== 'boolean') {
    return { ok: false, error: 'Invalid request' }
  }
  return { ok: true, value }
}

/**
 * True when any emitted key is already owned by a non-binding variable at
 * service or hosting scope for the target service.
 */
export async function findBindingKeyConflicts(
  db: Db,
  params: Readonly<{
    serviceId: string
    keys: readonly string[]
    /** Exclude this binding's own rows (PATCH). */
    excludeBindingId?: string
  }>,
): Promise<string | null> {
  if (params.keys.length === 0) return null

  const serviceConds = [
    eq(variable.serviceId, params.serviceId),
    inArray(variable.key, [...params.keys]),
  ]
  if (params.excludeBindingId) {
    serviceConds.push(
      or(
        sql`${variable.bindingId} IS NULL`,
        sql`${variable.bindingId} != ${params.excludeBindingId}`,
      )!,
    )
  } else {
    serviceConds.push(sql`${variable.bindingId} IS NULL`)
  }

  const [serviceHit] = await db
    .select({ key: variable.key })
    .from(variable)
    .where(and(...serviceConds))
    .limit(1)
  if (serviceHit) return serviceHit.key

  const hostingIds = await db
    .select({ id: hosting.id })
    .from(hosting)
    .where(eq(hosting.serviceId, params.serviceId))
  if (hostingIds.length === 0) return null

  const [hostingHit] = await db
    .select({ key: variable.key })
    .from(variable)
    .where(
      and(
        inArray(
          variable.hostingId,
          hostingIds.map((h) => h.id),
        ),
        inArray(variable.key, [...params.keys]),
      ),
    )
    .limit(1)
  return hostingHit?.key ?? null
}

/**
 * Check whether creating/updating a binding would collide with existing
 * user variables for the keys it will emit.
 */
export async function assertNoBindingKeyConflicts(
  db: Db,
  params: Readonly<{
    serviceId: string
    keyPrefix: string
    emitEngineDefaults: boolean
    engineCode: string
    excludeBindingId?: string
  }>,
): Promise<{ ok: true } | { ok: false; key: string }> {
  const keys = listBindingEmittedKeys({
    keyPrefix: params.keyPrefix,
    emitEngineDefaults: params.emitEngineDefaults,
    engineCode: params.engineCode,
  })
  if (!keys) return { ok: true }
  const conflict = await findBindingKeyConflicts(db, {
    serviceId: params.serviceId,
    keys,
    ...(params.excludeBindingId ? { excludeBindingId: params.excludeBindingId } : {}),
  })
  if (conflict) return { ok: false, key: conflict }
  return { ok: true }
}

export async function isPrefixInUse(
  db: Db,
  serviceId: string,
  keyPrefix: string,
  excludeBindingId?: string,
): Promise<boolean> {
  const conds = [
    eq(binding.serviceId, serviceId),
    eq(binding.keyPrefix, keyPrefix),
  ]
  if (excludeBindingId) {
    conds.push(sql`${binding.id} != ${excludeBindingId}`)
  }
  const [row] = await db
    .select({ id: binding.id })
    .from(binding)
    .where(and(...conds))
    .limit(1)
  return Boolean(row)
}

export async function isEngineDefaultsInUse(
  db: Db,
  serviceId: string,
  excludeBindingId?: string,
): Promise<boolean> {
  const conds = [
    eq(binding.serviceId, serviceId),
    eq(binding.isEmitEngineDefaults, true),
  ]
  if (excludeBindingId) {
    conds.push(sql`${binding.id} != ${excludeBindingId}`)
  }
  const [row] = await db
    .select({ id: binding.id })
    .from(binding)
    .where(and(...conds))
    .limit(1)
  return Boolean(row)
}

/**
 * Whether a user-created variable key conflicts with any binding on the
 * parent service (service or hosting parent).
 */
export async function isKeyOwnedByBindingOnService(
  db: Db,
  serviceId: string,
  key: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: variable.id })
    .from(variable)
    .where(
      and(
        eq(variable.serviceId, serviceId),
        eq(variable.key, key),
        isNotNull(variable.bindingId),
      ),
    )
    .limit(1)
  return Boolean(row)
}

export async function resolveServiceIdForHosting(
  db: Db,
  hostingId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ serviceId: hosting.serviceId })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  return row?.serviceId ?? null
}

export type BindingsListFilter =
  | { kind: 'service'; serviceId: string }
  | { kind: 'environment'; environmentId: string }
  | { kind: 'managedEnvironment'; managedEnvironmentId: string }

export type BindingsListFilterError = {
  ok: false
  error: string
  status: 400
}

export function parseBindingsListFilter(params: {
  serviceId: string | undefined
  environmentId: string | undefined
  managedEnvironmentId: string | undefined
}): { ok: true; filter: BindingsListFilter } | BindingsListFilterError {
  const filterCount = [
    params.serviceId,
    params.environmentId,
    params.managedEnvironmentId,
  ].filter(Boolean).length
  if (filterCount !== 1) {
    return {
      ok: false,
      error: 'Exactly one of serviceId, environmentId, or managedEnvironmentId must be specified',
      status: 400,
    }
  }
  if (params.serviceId) {
    return {
      ok: true,
      filter: { kind: 'service', serviceId: params.serviceId },
    }
  }
  if (params.managedEnvironmentId) {
    return {
      ok: true,
      filter: {
        kind: 'managedEnvironment',
        managedEnvironmentId: params.managedEnvironmentId,
      },
    }
  }
  return {
    ok: true,
    filter: { kind: 'environment', environmentId: params.environmentId! },
  }
}

export function bindingDatabaseTargetHttpStatus(
  error: string,
): 400 | 404 {
  if (error === 'database_not_found') return 404
  return 400
}

function uniqueViolationMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

export function mapBindingUniqueViolation(
  err: unknown,
):
  | { error: typeof BINDING_ENGINE_DEFAULTS_IN_USE_ERROR; status: 409 }
  | { error: typeof BINDING_KEY_PREFIX_IN_USE_ERROR; status: 409 }
  | null {
  if (!isPostgresUniqueViolation(err)) return null
  const message = uniqueViolationMessage(err)
  if (message.includes('uniq_binding_service_engine_defaults')) {
    return { error: BINDING_ENGINE_DEFAULTS_IN_USE_ERROR, status: 409 }
  }
  if (message.includes('uniq_binding_service_prefix')) {
    return { error: BINDING_KEY_PREFIX_IN_USE_ERROR, status: 409 }
  }
  return null
}

export function isBindableDatabasePrincipal(row: {
  kind: string | null | undefined
  managedId: string | null | undefined
  metadata: unknown
}): boolean {
  if (row.kind !== 'database' || !row.managedId) return false
  if (isManagedRootPrincipal(row.metadata)) return false
  if (isManagedReplicationPrincipal(row.metadata)) return false
  return true
}
