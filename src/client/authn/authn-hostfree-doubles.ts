import type { Db } from '../../db.ts'
import {
  account,
  grant,
  license,
  organization,
  session,
  setting,
  team,
  teammate,
  user,
  verification,
  workspace,
} from '../../lib/db/schema.ts'
import type { OtpType } from '../../lib/email/types.ts'
import {
  deriveOtpVerifier,
  hashEmailForOtp,
} from './email-otp.ts'
import type { DerivedSecretsConfig } from './secrets.ts'
import { IS_SIGNUP_ENABLED_CONFIG_KEY } from './install-state.ts'
import { SUPERADMIN_ROLE } from './session-store.ts'
import type { SessionData } from './session-store.ts'

export async function readJsonBody<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new TypeError('expected JSON object body')
  }
  return body as T
}

export type MockCredentialUser = {
  id: string
  email: string
  password: string
  isDisabled?: boolean
  isEmailVerified?: boolean
}

export type MockAuthUser = {
  id: string
  email: string
  isDisabled: boolean
  isEmailVerified: boolean
  role: string
  displayName?: string | null
}

type MockAuthStateInternal = MockAuthState & {
  lastLogin?: string
  inTransaction?: boolean
  verificationSelectPhase?: number
  verificationDeletePhase?: number
  lastVerificationInsert?: Record<string, unknown>
}

export type MockAuthState = {
  sessions: Map<string, SessionData>
  credentials: Map<string, MockCredentialUser>
  users: MockAuthUser[]
  accounts: Array<{ userId: string; password: string }>
  organizations: Array<{ id: string; name: string | null }>
  settings: Map<string, string>
  licenses: Array<{
    id: string
    organizationId: string
    name: string | null
    token: string
    revokedAt: string | null
    serverId: string | null
    createdAt: string
  }>
  verificationRows: Array<{
    id: string
    identifier: string
    value: string
    expiresAt: string
    createdAt?: string
  }>
  insertedSessions: Array<Record<string, unknown>>
}

type Row = Record<string, unknown>

export function createEmptyMockAuthState(): MockAuthState {
  return {
    sessions: new Map(),
    credentials: new Map(),
    users: [],
    accounts: [],
    organizations: [],
    settings: new Map(),
    licenses: [],
    verificationRows: [],
    insertedSessions: [],
  }
}

function isExpired(iso: string): boolean {
  return iso <= new Date().toISOString()
}

/**
 * Coerce an unknown value to string without Object's default
 * `[object Object]` stringification (`typescript:S6551`).
 */
function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function otpIdentifier(type: OtpType, emailHash: string): string {
  return `otp:${type}:${emailHash}`
}

function attemptsIdentifier(type: OtpType, emailHash: string): string {
  return `otp-attempts:${type}:${emailHash}`
}

function selectCredentialRow(state: MockAuthState, login: string) {
  const key = login.trim().toLowerCase()
  for (const row of state.credentials.values()) {
    if (row.email === key) {
      return {
        userId: row.id,
        email: row.email,
        password: row.password,
        isDisabled: row.isDisabled ?? false,
        isEmailVerified: row.isEmailVerified ?? true,
      }
    }
  }
  for (const row of state.users) {
    if (row.email !== key) continue
    const accountRow = state.accounts.find((a) => a.userId === row.id)
    if (!accountRow) continue
    return {
      userId: row.id,
      email: row.email,
      password: accountRow.password,
      isDisabled: row.isDisabled,
      isEmailVerified: row.isEmailVerified,
    }
  }
  return null
}

function mapVerificationRows(
  state: MockAuthStateInternal,
  limit: number,
  inTx: boolean,
) {
  const rows = inTx
    ? state.verificationRows
    : state.verificationRows.filter((row) => !isExpired(row.expiresAt))
  if (inTx) {
    state.verificationSelectPhase = (state.verificationSelectPhase ?? 0) + 1
    if (state.verificationSelectPhase === 1) {
      return rows
        .filter((row) =>
          row.identifier.startsWith('otp:') &&
          !row.identifier.startsWith('otp-attempts:')
        )
        .slice(0, limit)
    }
    if (state.verificationSelectPhase === 2) {
      return rows
        .filter((row) => row.identifier.startsWith('otp-attempts:'))
        .slice(0, limit)
    }
  }
  return rows.slice(0, limit)
}

/** Drizzle-shaped thenable: awaitable directly and via `.limit()` / `.for().limit()`. */
function thenableRows(
  fetchRows: () => Promise<Row[]>,
): Promise<Row[]> & {
  limit: (n: number) => Promise<Row[]>
  for: (lock: string) => { limit: (n: number) => Promise<Row[]> }
} {
  const promise = fetchRows()
  const limited = (n: number) => promise.then((rows) => rows.slice(0, n))
  return Object.assign(promise, {
    limit: limited,
    for: (_lock: string) => ({ limit: limited }),
  })
}

function mapLicenseRows(state: MockAuthState, activeOnly: boolean) {
  return state.licenses
    .filter((row) => !activeOnly || row.revokedAt === null)
    .map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      createdAt: row.createdAt,
      token: row.token,
      licenseId: row.id,
      serverId: row.serverId,
    }))
}

function fetchInnerJoinRows(state: MockAuthState, table: unknown): Promise<Row[]> {
  if (table === session) {
    const entries = [...state.sessions.entries()]
    if (entries.length === 0) return Promise.resolve([])
    const [, data] = entries[0]
    return Promise.resolve([{
      sessionId: data.sessionId,
      userId: data.userId,
      email: data.email,
      role: data.role,
      isDisabled: false,
    }])
  }
  if (table === license) {
    return Promise.resolve(
      mapLicenseRows(state, false)
        .filter((row) => row.serverId !== null)
        .map((row) => ({
          licenseId: row.id,
          id: row.serverId as string,
          name: row.name,
        })),
    )
  }
  return Promise.resolve([])
}

function fetchWhereRows(
  state: MockAuthState,
  internal: MockAuthStateInternal,
  table: unknown,
): Promise<Row[]> {
  if (table === user) {
    return Promise.resolve(state.users.map((row) => ({
      id: row.id,
      isDisabled: row.isDisabled,
      isEmailVerified: row.isEmailVerified,
      email: row.email,
      role: row.role,
    })))
  }
  if (table === organization) {
    return Promise.resolve(
      state.organizations
        .filter((row) => row.name !== null)
        .map((row) => ({ id: row.id })),
    )
  }
  if (table === license) {
    return Promise.resolve(
      mapLicenseRows(state, true).map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        name: row.name,
        createdAt: row.createdAt,
        token: row.token,
      })),
    )
  }
  if (table === setting) {
    return Promise.resolve(
      [...state.settings.entries()].map(([key, value]) => ({ key, value })),
    )
  }
  if (table === verification) {
    const rows = mapVerificationRows(internal, Number.MAX_SAFE_INTEGER, false)
    return Promise.resolve(rows.map((row) => ({
      id: row.id,
      identifier: row.identifier,
      value: row.value,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt ?? row.expiresAt,
    })))
  }
  if (table === account) {
    // Every account row this double stores is a credential account (the app
    // never creates any other provider) — same "where is ignored, state is
    // small and scenario-scoped" convention the `user` case above uses.
    return Promise.resolve(
      state.accounts.map((row) => ({
        id: row.userId,
        userId: row.userId,
        providerId: 'credential',
      })),
    )
  }
  return Promise.resolve([])
}

function fetchCredentialJoinRows(
  state: MockAuthState,
  internal: MockAuthStateInternal,
  limit: number,
): Promise<Row[]> {
  const login = internal.lastLogin
  if (!login) return Promise.resolve([])
  const row = selectCredentialRow(state, login)
  if (!row) return Promise.resolve([])
  return Promise.resolve([row].slice(0, limit))
}

function fetchVerificationLimited(
  _state: MockAuthState,
  internal: MockAuthStateInternal,
  limit: number,
): Promise<Row[]> {
  const rows = mapVerificationRows(internal, limit, Boolean(internal.inTransaction))
  return Promise.resolve(rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    value: row.value,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt ?? row.expiresAt,
  })))
}

function buildSelectFrom(
  state: MockAuthState,
  internal: MockAuthStateInternal,
  table: unknown,
) {
  const chain = {
    innerJoin: (_other: unknown, _cond: unknown) => ({
      where: (_cond: unknown) => thenableRows(() => fetchInnerJoinRows(state, table)),
    }),
    leftJoin: (_other: unknown, _cond: unknown) => ({
      where: (_cond: unknown) => thenableRows(() => fetchWhereRows(state, internal, table)),
    }),
    where: (_cond: unknown) => thenableRows(() => fetchWhereRows(state, internal, table)),
  }

  if (table === user) {
    return {
      ...chain,
      innerJoin: (_other: unknown, _cond: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (n: number) => fetchCredentialJoinRows(state, internal, n),
        }),
      }),
    }
  }

  if (table === verification) {
    return {
      ...chain,
      where: (_cond: unknown) =>
        thenableRows(() => fetchVerificationLimited(state, internal, Number.MAX_SAFE_INTEGER)),
    }
  }

  return chain
}

function handleInsertValues(
  state: MockAuthState,
  table: unknown,
  row: Record<string, unknown>,
) {
  const internal = state as MockAuthStateInternal
  if (table === session) {
    state.insertedSessions.push(row)
    const userId = String(row.userId)
    const token = String(row.token)
    const cred = [...state.credentials.values()].find((u) => u.id === userId)
    const userRow = state.users.find((u) => u.id === userId)
    state.sessions.set(token, {
      sessionId: crypto.randomUUID(),
      userId,
      email: cred?.email ?? userRow?.email ?? 'user@example.com',
      role: userRow?.role ?? 'user',
    })
    return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) }
  }
  if (table === user) {
    const id = crypto.randomUUID()
    state.users.push({
      id,
      email: String(row.email),
      isDisabled: Boolean(row.isDisabled),
      isEmailVerified: Boolean(row.isEmailVerified),
      role: asString(row.role, 'user'),
      displayName: (row.name as string | null | undefined) ??
        (row.displayName as string | null | undefined) ?? null,
    })
    return { returning: () => Promise.resolve([{ id }]) }
  }
  if (table === account) {
    state.accounts.push({
      userId: String(row.userId),
      password: String(row.password),
    })
    return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) }
  }
  if (table === organization) {
    const id = crypto.randomUUID()
    state.organizations.push({
      id,
      name: (row.name as string | null | undefined) ??
        (row.displayName as string | null | undefined) ?? null,
    })
    return { returning: () => Promise.resolve([{ id }]) }
  }
  if (table === license) {
    const id = crypto.randomUUID()
    state.licenses.push({
      id,
      organizationId: String(row.organizationId),
      name: (row.name as string | null | undefined) ??
        (row.displayName as string | null | undefined) ?? null,
      token: String(row.token),
      revokedAt: null,
      serverId: null,
      createdAt: asString(row.createdAt, new Date().toISOString()),
    })
    return { returning: () => Promise.resolve([{ id }]) }
  }
  if (table === verification) {
    const id = crypto.randomUUID()
    const stamp = asString(
      row.createdAt,
      asString(row.updatedAt, new Date().toISOString()),
    )
    internal.lastVerificationInsert = row
    const identifier = String(row.identifier)
    const existing = state.verificationRows.some((entry) => entry.identifier === identifier)
    if (!existing) {
      state.verificationRows.push({
        id,
        identifier,
        value: String(row.value),
        expiresAt: String(row.expiresAt),
        createdAt: stamp,
      })
    }
    return {
      onConflictDoUpdate: (config: { set?: Record<string, unknown> }) => {
        const target = state.verificationRows.find((entry) =>
          entry.identifier === identifier
        )
        if (target && config.set?.value !== undefined) {
          target.value = String(config.set.value)
        }
        return Promise.resolve(undefined)
      },
    }
  }
  if (
    table === team ||
    table === teammate ||
    table === grant ||
    table === workspace ||
    table === setting
  ) {
    if (table === setting) {
      state.settings.set(String(row.key), String(row.value))
    }
    return {
      returning: () => Promise.resolve([{ id: crypto.randomUUID() }]),
      onConflictDoUpdate: () => ({
        set: () => Promise.resolve(undefined),
      }),
      onConflictDoNothing: () => Promise.resolve(undefined),
    }
  }
  return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) }
}

function applyUserPatch(state: MockAuthState, patch: Record<string, unknown>): void {
  for (const row of state.users) {
    if (patch.isEmailVerified !== undefined) {
      row.isEmailVerified = Boolean(patch.isEmailVerified)
    }
  }
}

function returningAfterUpdate(
  state: MockAuthState,
  table: unknown,
  patch: Record<string, unknown>,
): Promise<Row[]> {
  if (table === license) {
    for (const row of state.licenses) {
      if (row.revokedAt === null) {
        row.revokedAt = asString(patch.revokedAt, new Date().toISOString())
        return Promise.resolve([{ id: row.id }])
      }
    }
  }
  applyUserPatch(state, patch)
  if (table === user) {
    const first = state.users[0]
    return Promise.resolve(
      first
        ? [{ id: first.id, isEmailVerified: first.isEmailVerified }]
        : [],
    )
  }
  if (table === account) {
    if (state.accounts.length === 0) return Promise.resolve([])
    const accountRow = state.accounts[0]
    if (patch.password !== undefined) {
      accountRow.password = String(patch.password)
    }
    return Promise.resolve([{ id: crypto.randomUUID() }])
  }
  return Promise.resolve([])
}

function deleteVerificationRows(state: MockAuthState, internal: MockAuthStateInternal): void {
  if (internal.inTransaction) {
    internal.verificationDeletePhase = (internal.verificationDeletePhase ?? 0) + 1
    if (internal.verificationDeletePhase === 1) {
      const idx = state.verificationRows.findIndex((row) =>
        row.identifier.startsWith('otp:') &&
        !row.identifier.startsWith('otp-attempts:')
      )
      if (idx >= 0) state.verificationRows.splice(idx, 1)
      return
    }
    state.verificationRows = state.verificationRows.filter((row) =>
      !row.identifier.startsWith('otp-attempts:')
    )
    return
  }
  state.verificationRows.shift()
}

function pushOtpPair(
  state: MockAuthState,
  otpRow: MockAuthState['verificationRows'][number],
  attemptsRow: MockAuthState['verificationRows'][number],
): void {
  state.verificationRows.push(otpRow, attemptsRow)
}

/** Minimal drizzle-shaped double for auth sign-in + session middleware paths. */
export function createMockAuthDb(state: MockAuthState): Db {
  const internal = state as MockAuthStateInternal

  const db = {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => handleInsertValues(state, table, row),
    }),
    select: (_fields?: unknown) => ({
      from: (table: unknown) => buildSelectFrom(state, internal, table),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          const promise = Promise.resolve().then(() => applyUserPatch(state, patch))
          return Object.assign(promise, {
            returning: () => returningAfterUpdate(state, table, patch),
          })
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (_cond: unknown) => {
        if (table === session) state.sessions.clear()
        if (table === verification) deleteVerificationRows(state, internal)
        return Promise.resolve(undefined)
      },
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => {
      internal.inTransaction = true
      internal.verificationSelectPhase = 0
      internal.verificationDeletePhase = 0
      try {
        return await fn(db as unknown as Db)
      } finally {
        internal.inTransaction = false
        internal.verificationSelectPhase = 0
        internal.verificationDeletePhase = 0
      }
    },
  }

  return db as unknown as Db
}

export function seedMockCredentialUser(
  state: MockAuthState,
  cred: MockCredentialUser,
): void {
  state.credentials.set(cred.email, cred)
  if (!state.users.some((row) => row.id === cred.id)) {
    state.users.push({
      id: cred.id,
      email: cred.email,
      isDisabled: cred.isDisabled ?? false,
      isEmailVerified: cred.isEmailVerified ?? true,
      role: 'user',
    })
  }
  if (!state.accounts.some((row) => row.userId === cred.id)) {
    state.accounts.push({
      userId: cred.id,
      password: cred.password,
    })
  }
}

export function seedMockUser(state: MockAuthState, userRow: MockAuthUser): void {
  state.users.push(userRow)
}

export function seedMockSession(
  state: MockAuthState,
  token: string,
  data: SessionData,
): void {
  state.sessions.set(token, data)
}

export function seedMockInstalledInstance(state: MockAuthState): void {
  state.organizations.push({
    id: crypto.randomUUID(),
    name: 'Root Organization',
  })
  state.users.push({
    id: crypto.randomUUID(),
    email: 'root@example.com',
    isDisabled: false,
    isEmailVerified: true,
    role: SUPERADMIN_ROLE,
  })
}

export function seedMockSignupEnabled(state: MockAuthState, enabled: boolean): void {
  state.settings.set(IS_SIGNUP_ENABLED_CONFIG_KEY, enabled ? '1' : '0')
}

/** Tag the next credential lookup to match a specific login string. */
export function withMockLogin(
  state: MockAuthState,
  login: string,
): MockAuthState {
  return Object.assign(state, { lastLogin: login })
}

export async function seedMockOtpVerification(
  state: MockAuthState,
  email: string,
  type: OtpType,
  otp: string,
  secrets: DerivedSecretsConfig,
): Promise<void> {
  const emailHash = await hashEmailForOtp(email)
  const identifier = otpIdentifier(type, emailHash)
  const attemptsId = attemptsIdentifier(type, emailHash)
  const verifier = await deriveOtpVerifier(type, emailHash, otp, secrets)
  const expiresAt = new Date(Date.now() + 600_000).toISOString()
  const stamp = new Date().toISOString()
  pushOtpPair(
    state,
    {
      id: crypto.randomUUID(),
      identifier,
      value: verifier,
      expiresAt,
      createdAt: stamp,
    },
    {
      id: crypto.randomUUID(),
      identifier: attemptsId,
      value: '0',
      expiresAt,
      createdAt: stamp,
    },
  )
}

/** Seed an expired OTP row (and attempts companion) for negative-path tests. */
export async function seedMockExpiredOtpVerification(
  state: MockAuthState,
  email: string,
  type: OtpType,
  otp: string,
  secrets: DerivedSecretsConfig,
): Promise<void> {
  const emailHash = await hashEmailForOtp(email)
  const identifier = otpIdentifier(type, emailHash)
  const attemptsId = attemptsIdentifier(type, emailHash)
  const verifier = await deriveOtpVerifier(type, emailHash, otp, secrets)
  const expiresAt = new Date(Date.now() - 60_000).toISOString()
  const stamp = new Date(Date.now() - 120_000).toISOString()
  pushOtpPair(
    state,
    {
      id: crypto.randomUUID(),
      identifier,
      value: verifier,
      expiresAt,
      createdAt: stamp,
    },
    {
      id: crypto.randomUUID(),
      identifier: attemptsId,
      value: '0',
      expiresAt,
      createdAt: stamp,
    },
  )
}
