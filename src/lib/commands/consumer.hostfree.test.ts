/**
 * Host-free coverage for pure consumer helpers + early processCommandEnvelope
 * paths (no Postgres / Redis).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type {
  DaemonCell,
  DaemonCellRegistry,
  PendingRequestRecord,
} from '../../daemon/cell/contracts.ts'
import { COMMAND_DISPATCH_FAILURE_RETENTION_MS } from '../db/command-records.ts'
import type { CommandEnvelope } from './envelope.ts'
import {
  commandTimeoutMs,
  enrichPingResult,
  errorMessage,
  extractObservedHostname,
  hasManagedFollowUpDeps,
  isManagedObservedStatus,
  isPostgresUniqueViolation,
  isTransientError,
  processCommandEnvelope,
  resolveManagedIdFromPayload,
  resolveManagedMemberIdFromFailedPayload,
} from './consumer.ts'
import { createNoopCommandQueue } from './noop-command-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MANAGED_ID = '00000000-0000-4000-8000-0000000000aa'
const MEMBER_ID = '00000000-0000-4000-8000-0000000000dd'
const SERVER_ID = '00000000-0000-4000-8000-0000000000bb'
const COMMAND_ID = '00000000-0000-4000-8000-0000000000cc'

const VALID_MANAGED_APPLY_PAYLOAD = {
  managedId: MANAGED_ID,
  environmentId: '00000000-0000-4000-8000-000000000002',
  engine: 'postgres',
  projectName: 'tp-managed-pg',
  containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-1',
  managedNetwork: '00000000-0000-4000-8000-0000000000ee',
  image: 'docker.io/library/postgres:18-alpine',
  containerPort: 5432,
  composeYaml: 'services:\n  postgres:\n    image: postgres:18-alpine\n',
  configFiles: [
    {
      path: 'postgresql.conf',
      contents: "listen_addresses = '*'\n",
      mode: '0640',
    },
  ],
  volumes: [{ name: 'pgdata', target: '/var/lib/postgresql' }],
  exposure: { enabled: false, protocol: 'tcp' },
  memberId: MEMBER_ID,
  memberRole: 'primary',
  memberOrdinal: 1,
  readEligible: true,
  peers: [],
  credentials: [
    {
      principalId: '00000000-0000-4000-8000-000000000003',
      username: 'postgres',
      role: 'root',
      databases: ['postgres'],
      password: 'tpdaemon.v1.server.key.payload',
    },
  ],
} as const

test('commandTimeoutMs returns per-type budgets and the default', () => {
  assertEquals(commandTimeoutMs('daemon.ping'), 30_000)
  assertEquals(commandTimeoutMs('server.hostname.set'), 120_000)
  assertEquals(commandTimeoutMs('server.ntp.set'), 300_000)
  assertEquals(commandTimeoutMs('server.timezone.set'), 300_000)
  assertEquals(commandTimeoutMs('server.reboot'), 120_000)
  assertEquals(commandTimeoutMs('server.fabric.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('server.tls.trust.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('environment.deploy'), 600_000)
  assertEquals(commandTimeoutMs('environment.lifecycle'), 120_000)
  assertEquals(commandTimeoutMs('environment.stop'), 120_000)
  assertEquals(commandTimeoutMs('managed.apply'), 600_000)
  assertEquals(commandTimeoutMs('managed.lifecycle'), 120_000)
  assertEquals(commandTimeoutMs('managed.destroy'), 300_000)
  assertEquals(commandTimeoutMs('managed.backup'), 1_800_000)
  assertEquals(commandTimeoutMs('managed.restore'), 1_800_000)
  assertEquals(commandTimeoutMs('managed.promote'), 600_000)
  assertEquals(commandTimeoutMs('managed.ingress.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('managed.ha.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('managed.ha.failover'), 600_000)
  assertEquals(commandTimeoutMs('system.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('server.principals.reconcile'), 120_000)
  assertEquals(commandTimeoutMs('unknown.future.command'), 60_000)
})

test('extractObservedHostname parses valid results and swallows invalid', () => {
  assertEquals(extractObservedHostname({ observedHostname: 'web-01' }), 'web-01')
  assertEquals(extractObservedHostname(null), null)
  assertEquals(extractObservedHostname({}), null)
  assertEquals(extractObservedHostname({ observedHostname: '' }), null)
})

test('enrichPingResult only attaches cellDispatchedAt for daemon.ping', () => {
  assertEquals(
    enrichPingResult(
      'server.reboot',
      { scheduled: true },
      {
        sentAt: '2020-01-01T00:00:00.000Z',
      }
    ),
    { scheduled: true }
  )
  assertEquals(enrichPingResult('daemon.ping', { daemonHostname: 'h' }, {}), {
    daemonHostname: 'h',
  })
  assertEquals(
    enrichPingResult(
      'daemon.ping',
      { daemonHostname: 'h' },
      { sentAt: '2020-01-01T00:00:05.000Z' }
    ),
    {
      daemonHostname: 'h',
      cellDispatchedAt: '2020-01-01T00:00:05.000Z',
    }
  )
})

test('errorMessage prefers Error.message then String()', () => {
  assertEquals(errorMessage(new Error('boom')), 'boom')
  assertEquals(errorMessage('plain'), 'plain')
  assertEquals(errorMessage(42), '42')
})

test('isPostgresUniqueViolation detects Postgres 23505 only', () => {
  assertEquals(isPostgresUniqueViolation({ code: '23505' }), true)
  assertEquals(isPostgresUniqueViolation({ code: '23503' }), false)
  assertEquals(isPostgresUniqueViolation(null), false)
  assertEquals(isPostgresUniqueViolation('23505'), false)
})

test('isManagedObservedStatus accepts projectable statuses only', () => {
  assertEquals(isManagedObservedStatus('ready'), true)
  assertEquals(isManagedObservedStatus('stopped'), true)
  assertEquals(isManagedObservedStatus('failed'), true)
  assertEquals(isManagedObservedStatus('applying'), false)
  assertEquals(isManagedObservedStatus('provisioning'), false)
})

test('hasManagedFollowUpDeps requires live queue plus both secret configs', () => {
  assertEquals(hasManagedFollowUpDeps(undefined), false)
  assertEquals(hasManagedFollowUpDeps({}), false)
  assertEquals(hasManagedFollowUpDeps({ commandQueue: createNoopCommandQueue() }), false)
  const liveQueue = {
    enqueue: () => Promise.resolve(),
  }
  assertEquals(
    hasManagedFollowUpDeps({
      commandQueue: liveQueue,
      secretsConfig: { versioned: [] } as never,
      dataEncryptionSecrets: {
        current: { version: 1, key: {} as CryptoKey },
        fallbacks: [],
      },
    }),
    true
  )
})

test('resolveManagedIdFromPayload extracts ids and returns null on miss', () => {
  assertEquals(
    resolveManagedIdFromPayload('managed.lifecycle', {
      managedId: MANAGED_ID,
      action: 'start',
    }),
    MANAGED_ID
  )
  assertEquals(
    resolveManagedIdFromPayload('managed.destroy', {
      managedId: MANAGED_ID,
      removeVolumes: true,
    }),
    MANAGED_ID
  )
  assertEquals(
    resolveManagedIdFromPayload('managed.apply', VALID_MANAGED_APPLY_PAYLOAD),
    MANAGED_ID,
  )
  assertEquals(
    resolveManagedIdFromPayload('managed.restore', {
      managedId: 'm1',
      engine: 'postgres',
      backupId: 'bk_1700000000000',
      artifactExtension: 'dump',
      database: 'appdb',
      checksum: 'c'.repeat(64),
    }),
    'm1',
  )
  assertEquals(
    resolveManagedIdFromPayload('managed.ha.failover', {
      managedId: 'managed-pg-1',
      sourceMemberId: MEMBER_ID,
      targetMemberId: '00000000-0000-4000-8000-0000000000ee',
      phase: 'drain',
    }),
    'managed-pg-1',
  )
  assertEquals(resolveManagedIdFromPayload('managed.lifecycle', {}), null)
  assertEquals(resolveManagedIdFromPayload('managed.apply', { managedId: 'x' }), null)
  assertEquals(resolveManagedIdFromPayload('daemon.ping', {}), null)
})

test('resolveManagedMemberIdFromFailedPayload reads member ids without inventing them', () => {
  assertEquals(
    resolveManagedMemberIdFromFailedPayload('managed.apply', VALID_MANAGED_APPLY_PAYLOAD),
    MEMBER_ID,
  )
  assertEquals(
    resolveManagedMemberIdFromFailedPayload('managed.lifecycle', {
      managedId: MANAGED_ID,
      action: 'start',
      memberId: MEMBER_ID,
    }),
    MEMBER_ID,
  )
  assertEquals(
    resolveManagedMemberIdFromFailedPayload('managed.lifecycle', {
      managedId: MANAGED_ID,
      action: 'start',
    }),
    null,
  )
  assertEquals(
    resolveManagedMemberIdFromFailedPayload('managed.ha.failover', {
      managedId: 'managed-pg-1',
      sourceMemberId: MEMBER_ID,
      targetMemberId: '00000000-0000-4000-8000-0000000000ee',
      phase: 'recover',
    }),
    '00000000-0000-4000-8000-0000000000ee',
  )
  assertEquals(resolveManagedMemberIdFromFailedPayload('managed.destroy', {}), null)
  assertEquals(resolveManagedMemberIdFromFailedPayload('daemon.ping', {}), null)
})

test('isTransientError still classifies durable-object / overloaded edges', () => {
  assertEquals(isTransientError(new Error('Durable Object unavailable')), true)
  assertEquals(isTransientError(new Error('queue overloaded')), false)
})

function queryResult<T>(rows: T[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: (_n: number) => Promise.resolve(rows),
    orderBy: (..._cols: unknown[]) =>
      Object.assign(Promise.resolve(rows), {
        limit: (_n: number) => Promise.resolve(rows),
      }),
  })
}

type CommandRow = {
  id: string
  createdAt: string
  updatedAt: string
  serverId: string
  actorType: string
  actorId: string
  name: string
  status: string
  attempts: number
  context: unknown
  resultSummary: unknown
  errorCode: string | null
  errorMessage: string | null
  queuedAt: string | null
  dispatchStartedAt: string | null
  sentAt: string | null
  ackedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  expiresAt: string | null
}

function baseCommandRow(overrides: Partial<CommandRow> = {}): CommandRow {
  return {
    id: COMMAND_ID,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    serverId: SERVER_ID,
    actorType: 'user',
    actorId: '00000000-0000-4000-8000-000000000001',
    name: 'daemon.ping',
    status: 'queued',
    attempts: 0,
    context: null,
    resultSummary: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: '2020-01-01T00:00:00.000Z',
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

type ConsumerFakeDbOptions = Readonly<{
  commandRow?: CommandRow | null
  serverExists?: boolean
  serverConnected?: boolean
  /** `null` simulates a dispatch payload that is already cleaned up. */
  dispatchPayload?: unknown
  /** Returned by `getCommandMetadata` (metadata-only select). */
  commandMetadata?: Record<string, unknown> | null
  /** `managed.options` for backup side effects. */
  managedOptions?: Record<string, unknown> | null
  /** Relay public key; `null` means stamp fills a missing key. */
  relayPublicKey?: string | null
  /** `replica.serverId` for promote / failover pin updates. */
  replicaServerId?: string
  replicaMember?: { serverId: string; ordinal: number }
  managedEnvironmentId?: string
  fabricRow?: { id: string; organizationId: string; cidr: string; options: unknown }
  gateSiblings?: Array<{ id: string; status: string }>
  hierarchy?: {
    workspaceId: string
    projectId: string
    environmentId: string
    serviceId: string
    containerRowId: string
    containerName: string
  }
  throwOnReplicaObservedUpdate?: boolean
  throwOnManagedReadyUpdate?: boolean
  throwOnManagedFailedUpdate?: boolean
  throwOnManagedOptionsUpdate?: boolean
}>

function createConsumerFakeDb(options: ConsumerFakeDbOptions = {}): {
  db: Db
  transitions: Array<{ status: string; error?: string }>
  inserts: Array<Record<string, unknown>>
  managedUpdates: Array<Record<string, unknown>>
  relayUpdates: Array<Record<string, unknown>>
  leafUpserts: number
  dispatchDeletes: number
  dispatchRetentions: string[]
} {
  const transitions: Array<{ status: string; error?: string }> = []
  const inserts: Array<Record<string, unknown>> = []
  const managedUpdates: Array<Record<string, unknown>> = []
  const relayUpdates: Array<Record<string, unknown>> = []
  const leafState = { upserts: 0 }
  const dispatchState = { deletes: 0, retentions: [] as string[] }
  const dispatchPayload =
    options.dispatchPayload === undefined ? {} : options.dispatchPayload
  const commandRow = options.commandRow === undefined ? baseCommandRow() : options.commandRow
  const serverExists = options.serverExists ?? true
  const serverConnected = options.serverConnected ?? false

  const db = {
    select: (fields?: Record<string, unknown>) => ({
      from: () => {
        const source = {
          innerJoin: () => source,
          where: () => {
            // getCommandRecord / listServerCommands: explicit command columns
            if (fields && 'name' in fields && 'attempts' in fields) {
              return queryResult(commandRow ? [commandRow] : [])
            }
            // getCommandDispatchPayload
            if (fields && 'payload' in fields) {
              return queryResult(
                dispatchPayload === null ? [] : [{ payload: dispatchPayload }],
              )
            }
            if (fields === undefined) {
              return queryResult(commandRow ? [commandRow] : [])
            }
            if ('workspaceId' in fields && 'containerRowId' in fields) {
              return queryResult(options.hierarchy ? [options.hierarchy] : [])
            }
            if ('options' in fields && !('cidr' in fields) && !('id' in fields)) {
              return queryResult(
                options.managedOptions === undefined || options.managedOptions === null
                  ? []
                  : [{ options: options.managedOptions }],
              )
            }
            if ('id' in fields && 'organizationId' in fields && 'cidr' in fields) {
              return queryResult(options.fabricRow ? [options.fabricRow] : [])
            }
            if ('publicKey' in fields) {
              return queryResult(
                options.relayPublicKey === undefined
                  ? []
                  : [{ publicKey: options.relayPublicKey }],
              )
            }
            if ('serverId' in fields && 'ordinal' in fields) {
              return queryResult(options.replicaMember ? [options.replicaMember] : [])
            }
            if ('environmentId' in fields) {
              return queryResult(
                options.managedEnvironmentId
                  ? [{ environmentId: options.managedEnvironmentId }]
                  : [],
              )
            }
            if ('id' in fields && 'status' in fields && !('name' in fields)) {
              return queryResult(options.gateSiblings ?? [])
            }
            if (
              'serverId' in fields &&
              !('organizationId' in fields) &&
              !('daemon' in fields) &&
              !('connected' in fields)
            ) {
              return queryResult(
                options.replicaServerId ? [{ serverId: options.replicaServerId }] : [],
              )
            }
            // getServerLicenseBinding first hop
            if ('organizationId' in fields && !('id' in fields)) {
              return queryResult(
                serverExists ? [{ organizationId: '00000000-0000-4000-8000-000000000099' }] : []
              )
            }
            // getCommandMetadata / replica.metadata / relay.metadata
            if ('metadata' in fields && !('daemon' in fields) && !('name' in fields)) {
              return queryResult([{ metadata: options.commandMetadata ?? null }])
            }
            // getServerLicenseBinding license hops / service.id
            if ('id' in fields && !('daemon' in fields) && !('metadata' in fields)) {
              return queryResult([{ id: 'license-1' }])
            }
            // resolveFleetPresence
            if ('daemon' in fields || 'connected' in fields) {
              return queryResult(
                serverExists
                  ? [
                      {
                        id: SERVER_ID,
                        daemon: {
                          key: {
                            id: 'key-1',
                            algorithm: 'Ed25519',
                            publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
                            fingerprint: 'fp',
                            createdAt: '2020-01-01T00:00:00.000Z',
                          },
                        },
                        metadata: null,
                        hostname: 'host-1',
                        machineKey: null,
                        connected: serverConnected,
                        statusChangedAt: '2020-01-01T00:00:00.000Z',
                      },
                    ]
                  : []
              )
            }
            return queryResult([])
          },
        }
        return source
      },
    }),
    delete: () => ({
      where: () => {
        dispatchState.deletes += 1
        return Promise.resolve(undefined)
      },
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserts.push(row)
        const inserted = {
          ...baseCommandRow({
            id: '00000000-0000-4000-8000-0000000000fe',
            name: typeof row.name === 'string' ? row.name : 'managed.apply',
            status: 'queued',
            serverId: typeof row.serverId === 'string' ? row.serverId : SERVER_ID,
          }),
        }
        return Object.assign(Promise.resolve(undefined), {
          returning: () => Promise.resolve([inserted]),
          onConflictDoUpdate: () => {
            leafState.upserts += 1
            return Promise.resolve(undefined)
          },
        })
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        if (
          options.throwOnReplicaObservedUpdate &&
          typeof patch.status === 'string' &&
          typeof patch.metadata === 'object' &&
          patch.metadata !== null &&
          'replication' in patch.metadata
        ) {
          throw new Error('replica observed update failed')
        }
        if (
          options.throwOnManagedReadyUpdate &&
          patch.status === 'ready' &&
          !('errorMessage' in patch) &&
          !('resultSummary' in patch) &&
          !('attempts' in patch)
        ) {
          throw new Error('managed ready update failed')
        }
        if (options.throwOnManagedOptionsUpdate && 'options' in patch) {
          throw new Error('managed options update failed')
        }
        if (
          options.throwOnManagedFailedUpdate &&
          patch.status === 'failed' &&
          !('errorMessage' in patch) &&
          !('attempts' in patch)
        ) {
          throw new Error('managed failed update failed')
        }
        if (typeof patch.status === 'string') {
          transitions.push({
            status: patch.status,
            ...(typeof patch.errorMessage === 'string'
              ? { error: patch.errorMessage }
              : {}),
          })
        }
        if (
          'options' in patch ||
          ('serverId' in patch && !('name' in patch)) ||
          (
            (patch.status === 'ready' || patch.status === 'stopped' || patch.status === 'failed') &&
            !('errorMessage' in patch) &&
            !('attempts' in patch) &&
            !('resultSummary' in patch) &&
            !('name' in patch)
          )
        ) {
          managedUpdates.push(patch)
        }
        if ('publicKey' in patch || (typeof patch.metadata === 'object' &&
          patch.metadata !== null &&
          'appliedPayloadHash' in patch.metadata)) {
          relayUpdates.push(patch)
        }
        if (typeof patch.expiresAt === 'string' && !('status' in patch)) {
          // retainCommandDispatch — failure-retention stamp.
          dispatchState.retentions.push(patch.expiresAt)
        }
        return {
          where: () => ({
            returning: () =>
              Promise.resolve(
                [
                  commandRow
                    ? {
                        ...commandRow,
                        status: (patch.status as string) ?? commandRow.status,
                        updatedAt: new Date().toISOString(),
                        ...(typeof patch.errorMessage === 'string'
                          ? { errorMessage: patch.errorMessage }
                          : {}),
                        ...(patch.resultSummary !== undefined
                          ? { resultSummary: patch.resultSummary }
                          : {}),
                        ...(typeof patch.attempts === 'number' ? { attempts: patch.attempts } : {}),
                      }
                    : undefined,
                ].filter(Boolean)
              ),
          }),
        }
      },
    }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as Db

  return {
    db,
    transitions,
    inserts,
    managedUpdates,
    relayUpdates,
    get leafUpserts() {
      return leafState.upserts
    },
    get dispatchDeletes() {
      return dispatchState.deletes
    },
    get dispatchRetentions() {
      return dispatchState.retentions
    },
  }
}

function emptyRegistry(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new TypeError('getCell must not be called on fail-fast paths')
    },
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

test('processCommandEnvelope no-ops when the command row is missing', async () => {
  const { db, transitions } = createConsumerFakeDb({ commandRow: null })
  const envelope: CommandEnvelope = {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  }
  await processCommandEnvelope(db, emptyRegistry(), envelope)
  assertEquals(transitions.length, 0)
})

test('processCommandEnvelope no-ops for already-terminal commands', async () => {
  const { db, transitions } = createConsumerFakeDb({
    commandRow: baseCommandRow({ status: 'succeeded' }),
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(transitions.length, 0)
})

test('processCommandEnvelope marks expired commands timed_out', async () => {
  const { db, transitions } = createConsumerFakeDb({
    commandRow: baseCommandRow({ expiresAt: '2020-01-01T00:00:01.000Z' }),
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(
    transitions.some((t) => t.status === 'timed_out'),
    true
  )
})

test('processCommandEnvelope no-ops on serverId envelope mismatch', async () => {
  const { db, transitions } = createConsumerFakeDb({
    commandRow: baseCommandRow({ serverId: SERVER_ID }),
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: '00000000-0000-4000-8000-0000000000ff',
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(transitions.length, 0)
})

test('processCommandEnvelope fails when the server row is missing', async () => {
  const { db, transitions } = createConsumerFakeDb({
    serverExists: false,
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(
    transitions.some((t) => t.status === 'dispatching'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'failed'),
    true
  )
})

test('processCommandEnvelope fails fast when the daemon is offline', async () => {
  const { db, transitions } = createConsumerFakeDb({
    serverExists: true,
    serverConnected: false,
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(
    transitions.some((t) => t.status === 'dispatching'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'failed'),
    true
  )
})

function onlineRegistry(pending: PendingRequestRecord | null): {
  registry: DaemonCellRegistry
  enqueued: Array<{ commandId: string; payload: unknown }>
} {
  const enqueued: Array<{ commandId: string; payload: unknown }> = []
  const cell: DaemonCell = {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: 'conn',
        lease: {
          holder: 'conn',
          expiresAt: '2020-01-01T00:01:00.000Z',
        },
      }),
    detachDaemonSocket: () => Promise.resolve(),
    recordInbound: () => Promise.resolve(),
    getSnapshot: () =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
        connected: true,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
        connected: true,
        ...patch,
      }),
    enqueue: (outbound) => {
      enqueued.push({
        commandId: (outbound as { commandId: string }).commandId,
        payload: (outbound as { payload: unknown }).payload,
      })
      return Promise.resolve({
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      })
    },
    markSent: () => Promise.resolve(),
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(pending),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: () => Promise.resolve(),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: () => Promise.resolve(),
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => Promise.resolve(),
  }

  return {
    registry: {
      getCell: () => cell,
      listOnlineServerIds: () => Promise.resolve([SERVER_ID]),
      getSnapshots: () => Promise.resolve(new Map()),
      purge: () => Promise.resolve(),
    },
    enqueued,
  }
}

function donePending(): PendingRequestRecord {
  return {
    serverId: SERVER_ID,
    requestId: COMMAND_ID,
    requestKind: 'command-dispatch',
    status: 'done',
    createdAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-01T00:10:00.000Z',
    sentAt: '2020-01-01T00:00:01.000Z',
    result: { daemonHostname: 'edge-1' },
  }
}

const pingEnvelope: CommandEnvelope = {
  commandId: COMMAND_ID,
  serverId: SERVER_ID,
  type: 'daemon.ping',
  attempt: 1,
  queuedAt: '2020-01-01T00:00:00.000Z',
}

test('processCommandEnvelope dispatches the dispatch payload and drops it on success', async () => {
  const fake = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
    dispatchPayload: { ping: true },
  })
  const { db, transitions } = fake
  const { registry, enqueued } = onlineRegistry(donePending())

  await processCommandEnvelope(db, registry, pingEnvelope)

  assertEquals(
    transitions.some((t) => t.status === 'dispatching'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'sent'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'succeeded'),
    true
  )
  // The daemon envelope carries the `dispatch` payload verbatim.
  assertEquals(enqueued.length, 1)
  assertEquals(enqueued[0]?.payload, { ping: true })
  // Success deletes the payload immediately; nothing is retained.
  assertEquals(fake.dispatchDeletes, 1)
  assertEquals(fake.dispatchRetentions.length, 0)
})

test('processCommandEnvelope retains the dispatch payload ~24h after a failure', async () => {
  const fake = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
    dispatchPayload: { ping: true },
  })
  const { db, transitions } = fake
  const { registry } = onlineRegistry({
    ...donePending(),
    status: 'failed',
    error: 'daemon exploded',
    result: undefined,
  })

  await processCommandEnvelope(db, registry, pingEnvelope)

  assertEquals(
    transitions.some((t) => t.status === 'failed' && t.error === 'daemon exploded'),
    true
  )
  assertEquals(fake.dispatchDeletes, 0)
  assertEquals(fake.dispatchRetentions.length, 1)
  const retainedMs = Date.parse(fake.dispatchRetentions[0]!)
  const expectedMs = Date.now() + COMMAND_DISPATCH_FAILURE_RETENTION_MS
  assertEquals(Math.abs(retainedMs - expectedMs) < 60_000, true)
})

test('processCommandEnvelope fails cleanly when the dispatch payload is gone', async () => {
  const { db, transitions } = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
    dispatchPayload: null,
  })
  const { registry, enqueued } = onlineRegistry(donePending())

  await processCommandEnvelope(db, registry, pingEnvelope)

  // Never dispatched an empty envelope; the command failed instead.
  assertEquals(enqueued.length, 0)
  assertEquals(
    transitions.some(
      (t) => t.status === 'failed' && t.error === 'Command dispatch payload unavailable',
    ),
    true
  )
})

test('processCommandEnvelope dispatches when online and maps a done outcome', async () => {
  const { db, transitions } = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
  })

  const pending: PendingRequestRecord = {
    serverId: SERVER_ID,
    requestId: COMMAND_ID,
    requestKind: 'command-dispatch',
    status: 'done',
    createdAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-01T00:10:00.000Z',
    sentAt: '2020-01-01T00:00:01.000Z',
    result: { daemonHostname: 'edge-1' },
  }

  const cell: DaemonCell = {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: 'conn',
        lease: {
          holder: 'conn',
          expiresAt: '2020-01-01T00:01:00.000Z',
        },
      }),
    detachDaemonSocket: () => Promise.resolve(),
    recordInbound: () => Promise.resolve(),
    getSnapshot: () =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
        connected: true,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
        connected: true,
        ...patch,
      }),
    enqueue: (outbound) =>
      Promise.resolve({
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    markSent: () => Promise.resolve(),
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(pending),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: () => Promise.resolve(),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: () => Promise.resolve(),
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => Promise.resolve(),
  }

  const registry: DaemonCellRegistry = {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([SERVER_ID]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }

  await processCommandEnvelope(db, registry, {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })

  assertEquals(
    transitions.some((t) => t.status === 'dispatching'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'sent'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'succeeded'),
    true
  )
})

const ENV_ID = '00000000-0000-4000-8000-000000000002'
const PROJECT_ID = '00000000-0000-4000-8000-000000000003'
const ORG_ID = '00000000-0000-4000-8000-000000000099'
const SERVICE_ID = '00000000-0000-4000-8000-0000000000ee'
const DEMOTE_ID = '00000000-0000-4000-8000-0000000000ff'
const FABRIC_ID = '550e8400-e29b-41d4-a716-446655440000'

const VALID_DEPLOY_PAYLOAD = {
  environmentId: ENV_ID,
  projectId: PROJECT_ID,
  organizationId: ORG_ID,
  projectName: 'tp-deploy-test',
  composeFiles: [
    {
      filename: 'compose.yaml',
      role: 'runtime',
      source: 'inline',
      content: 'services:\n  web:\n    image: nginx\n',
    },
  ],
  hostings: [] as unknown[],
}

const VALID_FABRIC_ENABLED = {
  enabled: true,
  fabricId: FABRIC_ID,
  address: '10.250.0.11/32',
  prefix: '10.192.0.0/16',
  peers: [] as unknown[],
}

const VALID_BACKUP_PAYLOAD = {
  managedId: MANAGED_ID,
  engine: 'postgres',
  action: 'create',
  backupId: 'bk_1700000000000',
  artifactExtension: 'dump',
  scope: 'instance',
}

const VALID_RESTORE_PAYLOAD = {
  managedId: MANAGED_ID,
  engine: 'postgres',
  backupId: 'bk_1700000000000',
  artifactExtension: 'dump',
  database: 'appdb',
  checksum: 'c'.repeat(64),
}

const VALID_HA_FAILOVER_PAYLOAD = {
  managedId: 'managed-pg-1',
  sourceMemberId: MEMBER_ID,
  targetMemberId: DEMOTE_ID,
  phase: 'drain',
  engine: 'postgres',
}

const MANAGED_NETWORK = '00000000-0000-4000-8000-0000000000ee'

const VALID_INGRESS_RECONCILE_PAYLOAD = {
  serverId: SERVER_ID,
  managedNetwork: MANAGED_NETWORK,
  clusters: [] as unknown[],
}

const HA_SERVICE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const VALID_HA_RECONCILE_PAYLOAD = {
  serverId: SERVER_ID,
  managedNetwork: MANAGED_NETWORK,
  desired: 'absent' as const,
  raft: null,
  clusters: [] as unknown[],
  identity: {
    serviceId: HA_SERVICE_ID,
    composeServiceName: 'orchestrator',
    containerName: `${HA_SERVICE_ID}-ha`,
  },
}

const SYSTEM_HIERARCHY = {
  workspaceId: '00000000-0000-4000-8000-0000000000a1',
  projectId: PROJECT_ID,
  environmentId: ENV_ID,
  serviceId: SERVICE_ID,
  containerRowId: '00000000-0000-4000-8000-0000000000a2',
  containerName: `${SERVICE_ID}-in`,
}

const INGRESS_DONE = {
  summary: 'ok',
  appliedUsers: [] as string[],
  appliedBackends: [] as string[],
  restarted: false,
}

const HA_RECONCILE_DONE = {
  summary: 'absent',
  registeredClusters: [] as string[],
  restarted: false,
}

function followUpSecrets(queue: { enqueue: (envelope: { commandId: string; type: string }) => Promise<void> }) {
  return {
    commandQueue: queue,
    secretsConfig: { versioned: [] } as never,
    dataEncryptionSecrets: {
      current: { version: 1, key: {} as CryptoKey },
      fallbacks: [],
    },
  }
}

function typedEnvelope(type: CommandEnvelope['type']): CommandEnvelope {
  return {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type,
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  }
}

function doneWith(result: unknown): PendingRequestRecord {
  return { ...donePending(), result }
}

async function runOnline(
  type: CommandEnvelope['type'],
  payload: unknown,
  pending: PendingRequestRecord | null,
  extras: ConsumerFakeDbOptions & {
    deps?: Parameters<typeof processCommandEnvelope>[3]
  } = {},
) {
  const { deps, ...dbOptions } = extras
  const fake = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
    dispatchPayload: payload,
    commandRow: baseCommandRow({ name: type }),
    ...dbOptions,
  })
  const { registry } = onlineRegistry(pending)
  await processCommandEnvelope(fake.db, registry, typedEnvelope(type), deps)
  return fake
}

test('processCommandEnvelope hostname success touches observed hostname', async () => {
  const fake = await runOnline(
    'server.hostname.set',
    {},
    doneWith({ observedHostname: 'web-01', summary: 'renamed' }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope hostname success skips when observed hostname is missing', async () => {
  const fake = await runOnline('server.hostname.set', {}, doneWith({}))
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope timezone success and malformed result both stay succeeded', async () => {
  const ok = await runOnline('server.timezone.set', {}, doneWith({ timezone: 'UTC' }))
  assertEquals(ok.transitions.some((t) => t.status === 'succeeded'), true)
  const bad = await runOnline('server.timezone.set', {}, doneWith({ timezone: '' }))
  assertEquals(bad.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope ntp success and malformed result both stay succeeded', async () => {
  const ok = await runOnline(
    'server.ntp.set',
    { enabled: true },
    doneWith({
      ntpServers: ['time.cloudflare.com'],
      ntpEnabled: true,
      ntpSynced: true,
      fallbackNtpServers: ['pool.ntp.org'],
      summary: 'synced',
    }),
  )
  assertEquals(ok.transitions.some((t) => t.status === 'succeeded'), true)
  const bad = await runOnline('server.ntp.set', { enabled: true }, doneWith({ ntpServers: 'nope' }))
  assertEquals(bad.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope deploy success with generation swallows apply errors', async () => {
  const fake = await runOnline(
    'environment.deploy',
    { ...VALID_DEPLOY_PAYLOAD, generation: 1 },
    doneWith({ projectName: 'tp-deploy-test' }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope deploy success reconciles an empty container report', async () => {
  const fake = await runOnline(
    'environment.deploy',
    VALID_DEPLOY_PAYLOAD,
    doneWith({ projectName: 'tp-deploy-test', containers: [] }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope deploy failure runs the failed-deploy side effect', async () => {
  const fake = await runOnline('environment.deploy', VALID_DEPLOY_PAYLOAD, {
    ...donePending(),
    status: 'failed',
    error: 'compose up failed',
    result: undefined,
  })
  assertEquals(
    fake.transitions.some((t) => t.status === 'failed' && t.error === 'compose up failed'),
    true,
  )
})

test('processCommandEnvelope deploy wait timeout runs timed_out deploy side effect', async () => {
  const fake = await runOnline('environment.deploy', VALID_DEPLOY_PAYLOAD, null)
  assertEquals(fake.transitions.some((t) => t.status === 'timed_out'), true)
})

test('processCommandEnvelope deploy unexpected pending status fails the command', async () => {
  const fake = await runOnline('environment.deploy', VALID_DEPLOY_PAYLOAD, {
    ...donePending(),
    status: 'acked',
    result: undefined,
  })
  assertEquals(
    fake.transitions.some(
      (t) => t.status === 'failed' && t.error === 'Unexpected pending request status: acked',
    ),
    true,
  )
})

test('processCommandEnvelope deploy expired pending times out', async () => {
  const fake = await runOnline('environment.deploy', VALID_DEPLOY_PAYLOAD, {
    ...donePending(),
    status: 'expired',
    result: undefined,
  })
  assertEquals(fake.transitions.some((t) => t.status === 'timed_out'), true)
})

test('processCommandEnvelope fabric disable offline still runs the failed-fabric side effect', async () => {
  const fake = createConsumerFakeDb({
    serverExists: true,
    serverConnected: false,
    dispatchPayload: { enabled: false },
    commandRow: baseCommandRow({ name: 'server.fabric.reconcile' }),
  })
  await processCommandEnvelope(fake.db, emptyRegistry(), typedEnvelope('server.fabric.reconcile'))
  assertEquals(fake.transitions.some((t) => t.status === 'failed'), true)
})

test('processCommandEnvelope fabric enabled success without publicKey is a no-op stamp', async () => {
  const fake = await runOnline(
    'server.fabric.reconcile',
    VALID_FABRIC_ENABLED,
    doneWith({ summary: 'TurboFabric reconciled' }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope fabric enabled success swallows an invalid result publicKey', async () => {
  const fake = await runOnline(
    'server.fabric.reconcile',
    VALID_FABRIC_ENABLED,
    doneWith({ summary: 'ok', publicKey: 'not-a-wg-key' }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope fabric enabled invalid payload is swallowed on success', async () => {
  const fake = await runOnline('server.fabric.reconcile', { enabled: true }, doneWith({ summary: 'ok' }))
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope fabric disable failure clears applied hash best-effort', async () => {
  const fake = await runOnline('server.fabric.reconcile', { enabled: false }, {
    ...donePending(),
    status: 'failed',
    error: 'wg syncconf failed',
    result: undefined,
  })
  assertEquals(fake.transitions.some((t) => t.status === 'failed'), true)
})

test('processCommandEnvelope environment stop and lifecycle reconcile empty container reports', async () => {
  const stop = await runOnline(
    'environment.stop',
    { environmentId: ENV_ID, projectId: PROJECT_ID, projectName: 'tp-stop' },
    doneWith({ projectName: 'tp-stop', containers: [] }),
  )
  assertEquals(stop.transitions.some((t) => t.status === 'succeeded'), true)
  const life = await runOnline(
    'environment.lifecycle',
    { environmentId: ENV_ID, projectId: PROJECT_ID, projectName: 'tp-life', action: 'start' },
    doneWith({ projectName: 'tp-life', containers: [] }),
  )
  assertEquals(life.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope environment stop/lifecycle invalid payloads stay succeeded', async () => {
  const stop = await runOnline('environment.stop', {}, doneWith({}))
  assertEquals(stop.transitions.some((t) => t.status === 'succeeded'), true)
  const life = await runOnline('environment.lifecycle', { action: 'start' }, doneWith({}))
  assertEquals(life.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope system.reconcile success with containers is best-effort', async () => {
  const fake = await runOnline(
    'system.reconcile',
    {
      environmentId: ENV_ID,
      action: 'reconcile',
      components: [
        {
          component: 'hosting-ingress',
          serviceId: SERVICE_ID,
          composeServiceName: 'traefik',
          containerName: `${SERVICE_ID}-in`,
          role: 'ingress',
          desired: 'present',
        },
      ],
    },
    doneWith({ summary: 'ok', containers: [] }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope system.reconcile invalid payload is swallowed', async () => {
  const fake = await runOnline('system.reconcile', {}, doneWith({ containers: [] }))
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.apply success projects ready for the primary', async () => {
  const fake = await runOnline(
    'managed.apply',
    VALID_MANAGED_APPLY_PAYLOAD,
    doneWith({ host: '127.0.0.1', port: 5432, containers: [] }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.apply replica success omits the placement pin', async () => {
  const fake = await runOnline(
    'managed.apply',
    { ...VALID_MANAGED_APPLY_PAYLOAD, memberRole: 'replica' },
    doneWith({ host: '127.0.0.1', port: 5432 }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.lifecycle success projects observed status', async () => {
  const fake = await runOnline(
    'managed.lifecycle',
    { managedId: MANAGED_ID, action: 'start', engine: 'postgres' },
    doneWith({ status: 'ready' }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.lifecycle stop without recoveryId skips fence advance', async () => {
  const fake = await runOnline(
    'managed.lifecycle',
    { managedId: MANAGED_ID, action: 'stop', engine: 'postgres' },
    doneWith({ status: 'stopped' }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.lifecycle invalid payload is swallowed', async () => {
  const fake = await runOnline('managed.lifecycle', {}, doneWith({ status: 'ready' }))
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.backup success returns early without a managed row', async () => {
  const fake = await runOnline(
    'managed.backup',
    VALID_BACKUP_PAYLOAD,
    doneWith({
      backupId: 'bk_1700000000000',
      path: '/var/lib/backups/x.dump',
      sizeBytes: 12,
      checksum: 'c'.repeat(64),
    }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.restore success projects ready', async () => {
  const fake = await runOnline('managed.restore', VALID_RESTORE_PAYLOAD, doneWith({}))
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(fake.managedUpdates.some((patch) => patch.status === 'ready'), true)
})

test('processCommandEnvelope managed.destroy success returns when the managed row is missing', async () => {
  const fake = await runOnline(
    'managed.destroy',
    { managedId: MANAGED_ID, removeVolumes: true },
    doneWith({ status: 'stopped', containers: [] }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.promote success flips roles in the fake transaction', async () => {
  const fake = await runOnline(
    'managed.promote',
    { managedId: MANAGED_ID, memberId: MEMBER_ID, demoteMemberId: DEMOTE_ID },
    doneWith({
      status: 'ready',
      role: 'primary',
      promotedMemberId: MEMBER_ID,
      demotedMemberId: DEMOTE_ID,
      demoted: true,
    }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ha.failover drain without recoveryId is a no-op', async () => {
  const fake = await runOnline(
    'managed.ha.failover',
    VALID_HA_FAILOVER_PAYLOAD,
    doneWith({ summary: 'drained', phase: 'drain' }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ha.failover recover flips roles', async () => {
  const fake = await runOnline(
    'managed.ha.failover',
    { ...VALID_HA_FAILOVER_PAYLOAD, phase: 'recover' },
    doneWith({ summary: 'recovered', phase: 'recover' }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ingress.reconcile invalid payload is swallowed', async () => {
  const fake = await runOnline('managed.ingress.reconcile', {}, doneWith({}))
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ha.reconcile invalid payload is swallowed', async () => {
  const fake = await runOnline('managed.ha.reconcile', {}, doneWith({}))
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.apply failure marks managed rows failed', async () => {
  const fake = await runOnline('managed.apply', VALID_MANAGED_APPLY_PAYLOAD, {
    ...donePending(),
    status: 'failed',
    error: 'apply exploded',
    result: undefined,
  })
  assertEquals(
    fake.transitions.some((t) => t.status === 'failed' && t.error === 'apply exploded'),
    true,
  )
})

test('processCommandEnvelope managed.lifecycle failure with recovery metadata advances the fence', async () => {
  const fake = await runOnline(
    'managed.lifecycle',
    { managedId: MANAGED_ID, action: 'stop', engine: 'postgres' },
    {
      ...donePending(),
      status: 'failed',
      error: 'fence stop failed',
      result: undefined,
    },
    { commandMetadata: { recoveryId: 'rec-1', fencePhase: 'stop' } },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'failed'), true)
})

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

const MANAGED_OPTIONS_WITH_BACKUP = {
  settings: {},
  databases: ['postgres'],
  backups: [{
    id: 'bk_old',
    createdAt: '2020-01-01T00:00:00.000Z',
    sizeBytes: 8,
    checksum: 'a'.repeat(64),
    path: '/var/lib/backups/old.dump',
  }],
}

function liveQueue() {
  const envelopes: Array<{ commandId: string; type: string }> = []
  return {
    envelopes,
    queue: {
      enqueue: (envelope: { commandId: string; type: string }) => {
        envelopes.push({ commandId: envelope.commandId, type: envelope.type })
        return Promise.resolve()
      },
    },
  }
}

test('processCommandEnvelope fabric success stamps a missing publicKey and desired hash', async () => {
  const fake = await runOnline(
    'server.fabric.reconcile',
    VALID_FABRIC_ENABLED,
    doneWith({
      summary: 'TurboFabric reconciled',
      publicKey: WG_PUBKEY,
      peers: [{ publicKey: WG_PUBKEY, health: 'healthy' }],
    }),
    {
      commandMetadata: { desiredHash: 'desired-hash-1' },
      relayPublicKey: null,
      fabricRow: {
        id: FABRIC_ID,
        organizationId: ORG_ID,
        cidr: '10.192.0.0/16',
        options: {},
      },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(fake.relayUpdates.some((patch) => patch.publicKey === WG_PUBKEY), true)
  assertEquals(
    fake.relayUpdates.some((patch) =>
      typeof patch.metadata === 'object' &&
      patch.metadata !== null &&
      (patch.metadata as { appliedPayloadHash?: string }).appliedPayloadHash === 'desired-hash-1'
    ),
    true,
  )
})

test('processCommandEnvelope managed.apply projects member health and swallows replica update errors', async () => {
  const fake = await runOnline(
    'managed.apply',
    VALID_MANAGED_APPLY_PAYLOAD,
    doneWith({
      host: '203.0.113.10',
      port: 5432,
      member: {
        memberId: MEMBER_ID,
        role: 'primary',
        status: 'ready',
        replication: {
          state: 'streaming',
          observedAt: '2020-01-01T00:00:00.000Z',
          lagBytes: 0,
          lagSeconds: 0,
        },
      },
    }),
    { throwOnReplicaObservedUpdate: true },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.apply enqueues pending standby applies', async () => {
  const { queue, envelopes } = liveQueue()
  const fake = await runOnline(
    'managed.apply',
    VALID_MANAGED_APPLY_PAYLOAD,
    doneWith({ host: '127.0.0.1', port: 5432 }),
    {
      commandMetadata: {
        pendingStandbyApplies: [
          { serverId: SERVER_ID, memberId: MEMBER_ID },
          {
            serverId: SERVER_ID,
            memberId: MEMBER_ID,
            payload: { ...VALID_MANAGED_APPLY_PAYLOAD, memberRole: 'replica' },
          },
        ],
      },
      deps: { commandQueue: queue },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(fake.inserts.some((row) => row.name === 'managed.apply'), true)
  assertEquals(envelopes.some((entry) => entry.type === 'managed.apply'), true)
})

test('processCommandEnvelope managed.apply marks a follow-up failed when the queue rejects', async () => {
  const fake = await runOnline(
    'managed.apply',
    VALID_MANAGED_APPLY_PAYLOAD,
    doneWith({ host: '127.0.0.1', port: 5432 }),
    {
      commandMetadata: {
        pendingStandbyApplies: [{
          serverId: SERVER_ID,
          memberId: MEMBER_ID,
          payload: { ...VALID_MANAGED_APPLY_PAYLOAD, memberRole: 'replica' },
        }],
      },
      deps: {
        commandQueue: {
          enqueue: () => Promise.reject(new Error('queue down')),
        },
      },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(
    fake.transitions.some((t) => t.status === 'failed' && t.error === 'Command queue unavailable'),
    true,
  )
})

test('processCommandEnvelope managed.apply commits a pending TLS leaf best-effort', async () => {
  const fake = await runOnline(
    'managed.apply',
    VALID_MANAGED_APPLY_PAYLOAD,
    doneWith({ host: '127.0.0.1', port: 5432 }),
    {
      commandMetadata: {
        pendingTlsLeaf: {
          kind: 'engine',
          organizationId: ORG_ID,
          serverId: SERVER_ID,
          caId: '00000000-0000-4000-8000-0000000000ca',
          caGeneration: 1,
          notAfter: '2030-01-01T00:00:00.000Z',
          managedId: MANAGED_ID,
          replicaId: MEMBER_ID,
        },
      },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(fake.leafUpserts, 1)
})

test('processCommandEnvelope managed.lifecycle stop enqueues a follow-up promote', async () => {
  const { queue, envelopes } = liveQueue()
  const fake = await runOnline(
    'managed.lifecycle',
    { managedId: MANAGED_ID, action: 'stop', engine: 'postgres' },
    doneWith({
      status: 'stopped',
      member: { memberId: MEMBER_ID, role: 'replica', status: 'stopped' },
    }),
    {
      commandMetadata: {
        followUpPromote: {
          serverId: SERVER_ID,
          payload: { managedId: MANAGED_ID, memberId: MEMBER_ID, demoteMemberId: DEMOTE_ID },
        },
      },
      deps: { commandQueue: queue },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(envelopes.some((entry) => entry.type === 'managed.promote'), true)
})

test('processCommandEnvelope managed.lifecycle stop with recoveryId advances the fence', async () => {
  const fake = await runOnline(
    'managed.lifecycle',
    { managedId: MANAGED_ID, action: 'stop', engine: 'postgres' },
    doneWith({ status: 'stopped' }),
    { commandMetadata: { recoveryId: 'rec-1', fencePhase: 'stop' } },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.backup create and delete rewrite options', async () => {
  const created = await runOnline(
    'managed.backup',
    VALID_BACKUP_PAYLOAD,
    doneWith({
      backupId: 'bk_1700000000000',
      path: '/var/lib/backups/x.dump',
      sizeBytes: 12,
      checksum: 'c'.repeat(64),
      database: 'appdb',
      pruned: ['bk_old'],
      completedAt: '2020-01-02T00:00:00.000Z',
    }),
    { managedOptions: MANAGED_OPTIONS_WITH_BACKUP },
  )
  assertEquals(created.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(created.managedUpdates.some((patch) => 'options' in patch), true)

  const deleted = await runOnline(
    'managed.backup',
    { ...VALID_BACKUP_PAYLOAD, action: 'delete' },
    doneWith({ backupId: 'bk_old' }),
    { managedOptions: MANAGED_OPTIONS_WITH_BACKUP },
  )
  assertEquals(deleted.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.backup swallows a ready-row update failure', async () => {
  const fake = await runOnline(
    'managed.backup',
    VALID_BACKUP_PAYLOAD,
    doneWith({
      backupId: 'bk_1700000000000',
      path: '/var/lib/backups/x.dump',
      sizeBytes: 12,
      checksum: 'c'.repeat(64),
    }),
    {
      managedOptions: MANAGED_OPTIONS_WITH_BACKUP,
      throwOnManagedOptionsUpdate: true,
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.destroy uses payload environmentId and deletes the member', async () => {
  const fake = await runOnline(
    'managed.destroy',
    {
      managedId: MANAGED_ID,
      removeVolumes: true,
      deleteAfterDestroy: true,
      deleteMemberAfterDestroy: true,
      memberId: MEMBER_ID,
      environmentId: ENV_ID,
    },
    doneWith({ status: 'stopped', containers: [] }),
    {
      replicaMember: { serverId: SERVER_ID, ordinal: 1 },
      managedEnvironmentId: ENV_ID,
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.destroy looks up environmentId and opens the replica gate', async () => {
  const { queue, envelopes } = liveQueue()
  const fake = await runOnline(
    'managed.destroy',
    { managedId: MANAGED_ID, removeVolumes: true, memberId: MEMBER_ID },
    doneWith({ status: 'stopped', containers: [] }),
    {
      managedEnvironmentId: ENV_ID,
      gateSiblings: [{ id: COMMAND_ID, status: 'succeeded' }],
      commandMetadata: {
        managedDestroyGate: {
          gateId: 'gate-1',
          memberIds: [MEMBER_ID],
          followups: [{
            serverId: SERVER_ID,
            memberId: MANAGED_ID,
            payload: {
              managedId: MANAGED_ID,
              removeVolumes: true,
              deleteAfterDestroy: true,
            },
          }],
        },
      },
      deps: { commandQueue: queue },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(envelopes.some((entry) => entry.type === 'managed.destroy'), true)
})

test('processCommandEnvelope managed.promote flips the replica pin then swallows a unique-index clash', async () => {
  const fake = await runOnline(
    'managed.promote',
    { managedId: MANAGED_ID, memberId: MEMBER_ID, demoteMemberId: DEMOTE_ID },
    doneWith({
      status: 'ready',
      role: 'primary',
      promotedMemberId: MEMBER_ID,
      demotedMemberId: DEMOTE_ID,
      demoted: true,
      replication: {
        state: 'streaming',
        observedAt: '2020-01-01T00:00:00.000Z',
      },
    }),
    {
      replicaServerId: SERVER_ID,
      throwOnManagedReadyUpdate: true,
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ha.failover drain with recoveryId is best-effort', async () => {
  const fake = await runOnline(
    'managed.ha.failover',
    VALID_HA_FAILOVER_PAYLOAD,
    doneWith({ summary: 'drained', phase: 'drain' }),
    { commandMetadata: { recoveryId: 'rec-1', fencePhase: 'drain' } },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ha.failover recover flips roles when the replica pin exists', async () => {
  const fake = await runOnline(
    'managed.ha.failover',
    { ...VALID_HA_FAILOVER_PAYLOAD, phase: 'recover' },
    doneWith({ summary: 'recovered', phase: 'recover' }),
    { replicaServerId: SERVER_ID },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.restore invalid payload is swallowed', async () => {
  const fake = await runOnline('managed.restore', {}, doneWith({}))
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.apply failure without a managed id skips the failed-row write', async () => {
  const fake = await runOnline('managed.apply', { managedId: 'x' }, {
    ...donePending(),
    status: 'failed',
    error: 'apply exploded',
    result: undefined,
  })
  assertEquals(fake.transitions.some((t) => t.status === 'failed'), true)
})

test('processCommandEnvelope managed.promote failure without recovery metadata marks rows failed', async () => {
  const fake = await runOnline(
    'managed.promote',
    { managedId: MANAGED_ID, memberId: MEMBER_ID, demoteMemberId: DEMOTE_ID },
    {
      ...donePending(),
      status: 'failed',
      error: 'promote exploded',
      result: undefined,
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'failed'), true)
})

test('processCommandEnvelope fabric success with a live queue still stamps after key fill', async () => {
  const { queue } = liveQueue()
  const fake = await runOnline(
    'server.fabric.reconcile',
    VALID_FABRIC_ENABLED,
    doneWith({
      summary: 'TurboFabric reconciled',
      publicKey: WG_PUBKEY,
      peers: [{ publicKey: WG_PUBKEY, health: 'stale' }],
    }),
    {
      commandMetadata: { desiredHash: 'desired-hash-2' },
      relayPublicKey: null,
      fabricRow: {
        id: FABRIC_ID,
        organizationId: ORG_ID,
        cidr: '10.192.0.0/16',
        options: {},
      },
      deps: { commandQueue: queue },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(fake.relayUpdates.some((patch) => patch.publicKey === WG_PUBKEY), true)
})

test('processCommandEnvelope managed.apply standby follow-up carries a pending TLS leaf', async () => {
  const { queue, envelopes } = liveQueue()
  const fake = await runOnline(
    'managed.apply',
    VALID_MANAGED_APPLY_PAYLOAD,
    doneWith({ host: '127.0.0.1', port: 5432 }),
    {
      commandMetadata: {
        pendingStandbyApplies: [{
          serverId: SERVER_ID,
          memberId: MEMBER_ID,
          payload: { ...VALID_MANAGED_APPLY_PAYLOAD, memberRole: 'replica' },
          pendingTlsLeaf: {
            kind: 'engine',
            organizationId: ORG_ID,
            serverId: SERVER_ID,
            caId: '00000000-0000-4000-8000-0000000000ca',
            caGeneration: 1,
            notAfter: '2030-01-01T00:00:00.000Z',
            managedId: MANAGED_ID,
            replicaId: MEMBER_ID,
          },
        }],
      },
      deps: { commandQueue: queue },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(envelopes.some((entry) => entry.type === 'managed.apply'), true)
  assertEquals(
    fake.inserts.some((row) =>
      typeof row.metadata === 'object' &&
      row.metadata !== null &&
      'pendingTlsLeaf' in (row.metadata as Record<string, unknown>)
    ),
    true,
  )
})

test('processCommandEnvelope managed.ingress.reconcile skips omitted containers', async () => {
  const fake = await runOnline(
    'managed.ingress.reconcile',
    VALID_INGRESS_RECONCILE_PAYLOAD,
    doneWith(INGRESS_DONE),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ingress.reconcile returns when hierarchy is missing', async () => {
  const fake = await runOnline(
    'managed.ingress.reconcile',
    VALID_INGRESS_RECONCILE_PAYLOAD,
    doneWith({ ...INGRESS_DONE, containers: [] }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ingress.reconcile reconciles a hierarchy row best-effort', async () => {
  const fake = await runOnline(
    'managed.ingress.reconcile',
    VALID_INGRESS_RECONCILE_PAYLOAD,
    doneWith({ ...INGRESS_DONE, containers: [] }),
    { hierarchy: SYSTEM_HIERARCHY },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ha.reconcile skips omitted containers', async () => {
  const fake = await runOnline(
    'managed.ha.reconcile',
    VALID_HA_RECONCILE_PAYLOAD,
    doneWith(HA_RECONCILE_DONE),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.ha.reconcile reconciles a hierarchy row best-effort', async () => {
  const fake = await runOnline(
    'managed.ha.reconcile',
    VALID_HA_RECONCILE_PAYLOAD,
    doneWith({ ...HA_RECONCILE_DONE, containers: [] }),
    { hierarchy: SYSTEM_HIERARCHY },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})

test('processCommandEnvelope managed.destroy re-applies the primary after member cleanup', async () => {
  const { queue, envelopes } = liveQueue()
  const fake = await runOnline(
    'managed.destroy',
    {
      managedId: MANAGED_ID,
      removeVolumes: true,
      deleteMemberAfterDestroy: true,
      memberId: MEMBER_ID,
      environmentId: ENV_ID,
    },
    doneWith({ status: 'stopped', containers: [] }),
    {
      replicaMember: { serverId: SERVER_ID, ordinal: 1 },
      managedEnvironmentId: ENV_ID,
      commandMetadata: {
        pendingPrimaryReapply: {
          serverId: SERVER_ID,
          payload: VALID_MANAGED_APPLY_PAYLOAD,
        },
      },
      deps: followUpSecrets(queue),
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(envelopes.some((entry) => entry.type === 'managed.apply'), true)
})

test('processCommandEnvelope managed.destroy leaves the gate closed while a sibling is pending', async () => {
  const { queue, envelopes } = liveQueue()
  const fake = await runOnline(
    'managed.destroy',
    { managedId: MANAGED_ID, removeVolumes: true, memberId: MEMBER_ID },
    doneWith({ status: 'stopped', containers: [] }),
    {
      gateSiblings: [{ id: COMMAND_ID, status: 'sent' }],
      commandMetadata: {
        managedDestroyGate: {
          gateId: 'gate-2',
          memberIds: [MEMBER_ID],
          followups: [{
            serverId: SERVER_ID,
            memberId: MANAGED_ID,
            payload: {
              managedId: MANAGED_ID,
              removeVolumes: true,
              deleteAfterDestroy: true,
            },
          }],
        },
      },
      deps: { commandQueue: queue },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(envelopes.some((entry) => entry.type === 'managed.destroy'), false)
})

test('processCommandEnvelope managed.destroy marks a gated follow-up failed when the queue rejects', async () => {
  const fake = await runOnline(
    'managed.destroy',
    { managedId: MANAGED_ID, removeVolumes: true, memberId: MEMBER_ID },
    doneWith({ status: 'stopped', containers: [] }),
    {
      gateSiblings: [{ id: COMMAND_ID, status: 'succeeded' }],
      commandMetadata: {
        managedDestroyGate: {
          gateId: 'gate-3',
          memberIds: [MEMBER_ID],
          followups: [{
            serverId: SERVER_ID,
            memberId: MANAGED_ID,
            payload: {
              managedId: MANAGED_ID,
              removeVolumes: true,
              deleteAfterDestroy: true,
            },
          }],
        },
      },
      deps: {
        commandQueue: {
          enqueue: () => Promise.reject(new Error('queue down')),
        },
      },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(
    fake.transitions.some((t) => t.status === 'failed' && t.error === 'Command queue unavailable'),
    true,
  )
})

test('processCommandEnvelope managed.promote without a replica pin still marks ready', async () => {
  const fake = await runOnline(
    'managed.promote',
    { managedId: MANAGED_ID, memberId: MEMBER_ID, demoteMemberId: DEMOTE_ID },
    doneWith({
      status: 'ready',
      role: 'primary',
      promotedMemberId: MEMBER_ID,
      demotedMemberId: DEMOTE_ID,
      demoted: true,
    }),
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
  assertEquals(
    fake.managedUpdates.some((patch) => patch.status === 'ready' && !('serverId' in patch)),
    true,
  )
})

test('processCommandEnvelope managed.promote failure swallows a failed-row write error', async () => {
  const fake = await runOnline(
    'managed.promote',
    { managedId: MANAGED_ID, memberId: MEMBER_ID, demoteMemberId: DEMOTE_ID },
    {
      ...donePending(),
      status: 'failed',
      error: 'promote exploded',
      result: undefined,
    },
    { throwOnManagedFailedUpdate: true },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'failed'), true)
})

test('processCommandEnvelope managed.ha.failover recover with recoveryId is best-effort', async () => {
  const fake = await runOnline(
    'managed.ha.failover',
    { ...VALID_HA_FAILOVER_PAYLOAD, phase: 'recover' },
    doneWith({ summary: 'recovered', phase: 'recover' }),
    {
      replicaServerId: SERVER_ID,
      commandMetadata: { recoveryId: 'rec-2' },
    },
  )
  assertEquals(fake.transitions.some((t) => t.status === 'succeeded'), true)
})
