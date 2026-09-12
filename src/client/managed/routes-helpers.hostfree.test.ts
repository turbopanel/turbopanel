/**
 * Host-free coverage for managed route pure helpers extracted from routes.ts.
 */

import { assertEquals } from '@std/assert'
import { BadRequestError } from '../shared.ts'
import {
  assertFailoverReplicaTransportAllowed,
  buildDisasterRecoveryQueuedResponse,
  buildEmptyManagedDetailResponse,
  buildFencePromotePendingResponse,
  buildManagedDeleteHardResponse,
  buildManagedDeleteQueuedResponse,
  buildManagedDestroyQueuedResponse,
  buildManagedSslView,
  buildOrgManagedListEntry,
  buildPromoteQueuedResponse,
  buildQueuedFanoutResponse,
  buildStatusMemberView,
  canHardDeleteManaged,
  evaluateManagedDatabaseDelete,
  evaluateManagedUserDropGuard,
  evaluateManagedUserRotateGuard,
  evaluatePromoteLagHttpGate,
  evaluatePromoteMemberRole,
  evaluatePromoteReplicaClass,
  evaluateReadOnlyLoginTargets,
  evaluateReadOnlyLoginTargetsLazy,
  evaluateReplicaClassConversion,
  evaluateReplicaPlacementPrechecks,
  findManagedBackupById,
  MANAGED_NO_READ_TARGETS_ERROR,
  managedStatusListenerParams,
  mergeManagedPatchSettings,
  nextDatabasesAfterCreate,
  nextDatabasesAfterDelete,
  operatorPromoteHttpResult,
  parseDisasterRecoveryPromoteBody,
  parseManagedConnectionRole,
  parseManagedCreateName,
  parseManagedLifecycleAction,
  parseMemberPatch,
  parseMemberReadEligibleCreate,
  parseMemberReadEligiblePatch,
  parsePromoteForce,
  parseReplicaClassCreate,
  pickPrimaryCommandResult,
  replicaEndpointPurpose,
  replicaPlacementNeedsDatacenter,
  sortManagedBackupsDesc,
  validateManagedDatabaseCreateName,
} from './routes-helpers.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import { privateEndpointErrorResponse } from '../../lib/net/private-endpoint.ts'
import { writeManagedRowOptions } from './options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseManagedLifecycleAction accepts start/stop/restart only', () => {
  assertEquals(parseManagedLifecycleAction({ action: 'start' }), {
    ok: true,
    action: 'start',
  })
  assertEquals(parseManagedLifecycleAction({ action: 'stop' }), {
    ok: true,
    action: 'stop',
  })
  assertEquals(parseManagedLifecycleAction({ action: 'restart' }), {
    ok: true,
    action: 'restart',
  })
  assertEquals(parseManagedLifecycleAction({ action: 'pause' }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseManagedLifecycleAction({}), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
})

test('parseManagedCreateName accepts null/string and maps BadRequestError', () => {
  const omitted = parseManagedCreateName({})
  if (!omitted.ok) throw new TypeError('expected ok')
  assertEquals(omitted.name, null)

  const named = parseManagedCreateName({ name: 'Orders DB' })
  if (!named.ok) throw new TypeError('expected ok')
  assertEquals(named.name, 'Orders DB')

  const invalid = parseManagedCreateName({ name: '   ' })
  if (invalid.ok) throw new TypeError('expected invalid blank name')
  assertEquals(invalid, { ok: false, error: 'Invalid request', status: 400 })

  const wrongType = parseManagedCreateName({ name: 42 })
  if (wrongType.ok) throw new TypeError('expected non-string rejection')
  assertEquals(wrongType.status, 400)
})

test('parseManagedCreateName rethrows unexpected errors', () => {
  let threw = false
  try {
    parseManagedCreateName(
      new Proxy({} as Record<string, unknown>, {
        get(_target, prop) {
          if (prop === 'name') throw new TypeError('unexpected')
          return undefined
        },
        has(_target, prop) {
          return prop === 'name'
        },
      }),
    )
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
    assertEquals(error instanceof BadRequestError, false)
  }
  assertEquals(threw, true)
})

test('mergeManagedPatchSettings merges settings object and rejects invalid', () => {
  const base = postgresEngineSpec.parseSettings(
    postgresEngineSpec.defaultSettings,
  )
  if (!base) throw new TypeError('expected defaults')

  const merged = mergeManagedPatchSettings(postgresEngineSpec, base, {
    settings: { exposure: { enabled: true, scope: 'public' } },
  })
  if (!merged) throw new TypeError('expected merged')
  assertEquals(merged.exposure.enabled, true)
  assertEquals(merged.exposure.scope, 'public')

  const ignored = mergeManagedPatchSettings(postgresEngineSpec, base, {
    settings: 'nope',
  })
  if (!ignored) throw new TypeError('expected base when settings non-object')
  assertEquals(ignored.exposure.enabled, base.exposure.enabled)

  const invalid = mergeManagedPatchSettings(postgresEngineSpec, base, {
    settings: { image: '' },
  })
  assertEquals(invalid, null)
})

test('validateManagedDatabaseCreateName rejects bad names and duplicates', () => {
  const id = postgresEngineSpec.userOperations.identifier
  assertEquals(
    validateManagedDatabaseCreateName('good_db', ['postgres'], id),
    null,
  )
  assertEquals(
    validateManagedDatabaseCreateName('bad name', ['postgres'], id)?.error,
    'Invalid database name',
  )
  assertEquals(
    validateManagedDatabaseCreateName('postgres', ['postgres'], id),
    { ok: false, error: 'database_exists', status: 409 },
  )
})

test('evaluateManagedDatabaseDelete guards initial and missing names', () => {
  assertEquals(
    evaluateManagedDatabaseDelete('missing', ['postgres', 'app'], 'postgres'),
    { ok: false, error: 'Not found', status: 404 },
  )
  assertEquals(
    evaluateManagedDatabaseDelete('postgres', ['postgres', 'app'], 'postgres'),
    { ok: false, error: 'cannot_drop_initial_database', status: 409 },
  )
  assertEquals(
    evaluateManagedDatabaseDelete('app', ['postgres', 'app'], 'postgres'),
    null,
  )
})

test('nextDatabasesAfterCreate/Delete sort and filter', () => {
  assertEquals(nextDatabasesAfterCreate(['zeta', 'alpha'], 'mid'), [
    'alpha',
    'mid',
    'zeta',
  ])
  assertEquals(nextDatabasesAfterDelete(['a', 'b', 'c'], 'b'), ['a', 'c'])
})

test('parsePromoteForce and readEligible parsers', () => {
  assertEquals(parsePromoteForce({ force: true }), true)
  assertEquals(parsePromoteForce({ force: false }), false)
  assertEquals(parsePromoteForce({}), false)
  assertEquals(parseMemberReadEligibleCreate({ readEligible: true }), true)
  assertEquals(parseMemberReadEligibleCreate({ readEligible: 'yes' }), false)

  assertEquals(parseMemberReadEligiblePatch({ readEligible: false }), {
    ok: true,
    readEligible: false,
  })
  assertEquals(parseMemberReadEligiblePatch({}), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseReplicaClassCreate({}), {
    ok: true,
    replicaClass: 'failover',
  })
  assertEquals(parseReplicaClassCreate({ replicaClass: 'read' }), {
    ok: true,
    replicaClass: 'read',
  })
  assertEquals(parseReplicaClassCreate({ replicaClass: 'nope' }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseMemberPatch({ replicaClass: 'read' }), {
    ok: true,
    replicaClass: 'read',
  })
  assertEquals(
    parseMemberPatch({ readEligible: true, replicaClass: 'failover' }),
    {
      ok: true,
      readEligible: true,
      replicaClass: 'failover',
    },
  )
  assertEquals(parseMemberPatch({}), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
})

test('canHardDeleteManaged is true only when unplaced', () => {
  assertEquals(canHardDeleteManaged(null), true)
  assertEquals(canHardDeleteManaged(undefined), true)
  assertEquals(canHardDeleteManaged('s1'), false)
})

test('evaluateReplicaPlacementPrechecks blocks duplicate members only', () => {
  assertEquals(
    evaluateReplicaPlacementPrechecks(
      [{ serverId: 's1', role: 'primary' }],
      's1',
    ),
    { ok: false, error: 'managed_member_exists', status: 409 },
  )
  assertEquals(
    evaluateReplicaPlacementPrechecks(
      [{ serverId: 's1', role: 'primary' }],
      's2',
    ),
    null,
  )
})

test('replicaPlacementNeedsDatacenter is class-aware', () => {
  assertEquals(replicaPlacementNeedsDatacenter('fabric', 'read'), false)
  assertEquals(replicaPlacementNeedsDatacenter('public', 'read'), false)
  assertEquals(replicaPlacementNeedsDatacenter('datacenter', 'read'), true)
  assertEquals(replicaPlacementNeedsDatacenter('local', 'read'), true)
  assertEquals(replicaPlacementNeedsDatacenter('fabric', 'failover'), true)
  assertEquals(replicaPlacementNeedsDatacenter('public', 'failover'), true)
  assertEquals(replicaPlacementNeedsDatacenter('datacenter', 'failover'), true)
  assertEquals(replicaPlacementNeedsDatacenter('local', 'failover'), true)
})

test('assertFailoverReplicaTransportAllowed rejects fabric and public', () => {
  assertEquals(assertFailoverReplicaTransportAllowed('local'), null)
  assertEquals(assertFailoverReplicaTransportAllowed('datacenter'), null)
  assertEquals(assertFailoverReplicaTransportAllowed('fabric'), {
    kind: 'failover_replica_requires_datacenter_transport',
  })
  assertEquals(assertFailoverReplicaTransportAllowed('public'), {
    kind: 'failover_replica_requires_datacenter_transport',
  })
})

test('failover_requires_trusted_datacenter maps to a 422 with an error-only body', async () => {
  // The managed routes surface resolver errors through
  // `privateEndpointErrorResponse` (replica create / member class patch);
  // the untrusted-datacenter refusal must keep its own code rather than
  // collapsing into `failover_replica_requires_datacenter_transport`.
  const c = {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Parameters<typeof privateEndpointErrorResponse>[0]
  const response = privateEndpointErrorResponse(c, {
    kind: 'failover_requires_trusted_datacenter',
    fromServerId: 's-replica',
    toServerId: 's-primary',
    datacenterId: 'dc-untrusted',
  })
  assertEquals(response.status, 422)
  assertEquals(await response.json(), {
    error: 'failover_requires_trusted_datacenter',
  })
  // A trusted-derived `datacenter` transport still passes the class gate.
  assertEquals(assertFailoverReplicaTransportAllowed('datacenter'), null)
})

test('evaluateReplicaClassConversion allows failover to read and gates the reverse', () => {
  const replica = { role: 'replica', replicaClass: 'failover' as const }
  assertEquals(evaluateReplicaClassConversion(replica, 'read', false), null)
  assertEquals(
    evaluateReplicaClassConversion(
      { role: 'replica', replicaClass: 'read' },
      'failover',
      false,
    ),
    {
      ok: false,
      error: 'failover_replica_requires_datacenter_transport',
      status: 422,
    },
  )
  assertEquals(
    evaluateReplicaClassConversion(
      { role: 'replica', replicaClass: 'read' },
      'failover',
      true,
    ),
    null,
  )
  assertEquals(
    evaluateReplicaClassConversion(
      { role: 'primary', replicaClass: null },
      'read',
      true,
    ),
    { ok: false, error: 'Invalid request', status: 400 },
  )
})

test('replica add/promote/conversion route helpers encode class rules', () => {
  assertEquals(replicaEndpointPurpose('failover'), 'failover-replication')
  assertEquals(replicaEndpointPurpose('read'), 'read-replication')
  assertEquals(evaluatePromoteReplicaClass('failover'), null)
  assertEquals(evaluatePromoteReplicaClass('read'), {
    ok: false,
    error: 'managed_replica_not_promotable',
    status: 422,
  })
  assertEquals(evaluatePromoteReplicaClass(null), {
    ok: false,
    error: 'managed_replica_not_promotable',
    status: 422,
  })
})

test('evaluatePromoteMemberRole requires replica', () => {
  assertEquals(evaluatePromoteMemberRole('replica'), null)
  assertEquals(evaluatePromoteMemberRole('primary'), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
})

test('user rotate/drop guards', () => {
  assertEquals(evaluateManagedUserRotateGuard({ managedRoot: true }), {
    ok: false,
    error: 'use_root_password_route',
    status: 400,
  })
  assertEquals(
    evaluateManagedUserRotateGuard({ managedReplication: true }),
    { ok: false, error: 'cannot_rotate_replication_user', status: 400 },
  )
  assertEquals(evaluateManagedUserRotateGuard({}), null)

  assertEquals(evaluateManagedUserDropGuard({ managedRoot: true }), {
    ok: false,
    error: 'cannot_drop_root_user',
    status: 400,
  })
  assertEquals(evaluateManagedUserDropGuard({}), null)
})

test('evaluateReadOnlyLoginTargets refuses read-only without a replica', () => {
  assertEquals(evaluateReadOnlyLoginTargets('read-write', []), null)
  assertEquals(
    evaluateReadOnlyLoginTargets('read-only', [
      { role: 'primary', readEligible: true },
    ]),
    { ok: false, error: MANAGED_NO_READ_TARGETS_ERROR, status: 422 },
  )
  assertEquals(
    evaluateReadOnlyLoginTargets('read-only', [
      { role: 'replica', readEligible: false },
    ]),
    { ok: false, error: MANAGED_NO_READ_TARGETS_ERROR, status: 422 },
  )
  assertEquals(
    evaluateReadOnlyLoginTargets('read-only', [
      { role: 'replica', readEligible: true },
    ]),
    null,
  )
})

test('evaluateReadOnlyLoginTargetsLazy loads members only for read-only', async () => {
  let loads = 0
  const loadMembers = () => {
    loads += 1
    return Promise.resolve([{ role: 'replica', readEligible: true }])
  }
  assertEquals(
    await evaluateReadOnlyLoginTargetsLazy('read-write', loadMembers),
    null,
  )
  assertEquals(loads, 0)
  assertEquals(
    await evaluateReadOnlyLoginTargetsLazy('read-only', loadMembers),
    null,
  )
  assertEquals(loads, 1)
  assertEquals(
    await evaluateReadOnlyLoginTargetsLazy(
      'read-only',
      () => Promise.resolve([{ role: 'primary', readEligible: true }]),
    ),
    { ok: false, error: MANAGED_NO_READ_TARGETS_ERROR, status: 422 },
  )
})

test('evaluatePromoteLagHttpGate honors force bypass', () => {
  assertEquals(
    evaluatePromoteLagHttpGate(undefined, true),
    null,
  )
  assertEquals(
    evaluatePromoteLagHttpGate(undefined, false),
    'managed_replica_not_streaming',
  )
  const now = Date.parse('2026-08-10T12:00:00.000Z')
  assertEquals(
    evaluatePromoteLagHttpGate(
      {
        state: 'streaming',
        lagBytes: 1,
        lagSeconds: 1,
        observedAt: '2026-08-10T11:59:50.000Z',
      },
      false,
      now,
    ),
    null,
  )
})

test('pickPrimaryCommandResult and queued response builders', () => {
  assertEquals(pickPrimaryCommandResult([]), undefined)
  assertEquals(
    pickPrimaryCommandResult([{ serverId: 'a' }, {
      commandId: 'c1',
      serverId: 'b',
    }]),
    { commandId: 'c1', serverId: 'b' },
  )
  assertEquals(
    pickPrimaryCommandResult([{ serverId: 'only' }]),
    { serverId: 'only' },
  )

  assertEquals(
    buildQueuedFanoutResponse(
      [{ commandId: 'cmd', serverId: 'srv' }],
      'fallback',
    ),
    {
      ok: true,
      results: [{ commandId: 'cmd', serverId: 'srv' }],
      commandId: 'cmd',
      serverId: 'srv',
      status: 'queued',
    },
  )
  assertEquals(
    buildQueuedFanoutResponse([{ serverId: undefined }], 'fallback'),
    {
      ok: true,
      results: [{ serverId: undefined }],
      commandId: undefined,
      serverId: 'fallback',
      status: 'queued',
    },
  )
})

test('empty detail / delete / destroy / promote response shapes', () => {
  assertEquals(buildEmptyManagedDetailResponse(), {
    managed: null,
    connection: null,
    endpoints: [],
    // Nothing placed yet, so there is no host whose publish could be reported.
    exposure: null,
    settings: null,
    // No org default configured, so a not-yet-created cluster still reports the
    // platform TLS policy it will inherit.
    ssl: { configured: null, effective: 'require', organizationDefault: null },
    release: null,
    server: null,
    rootUsername: null,
    members: [],
    recovery: null,
  })
  assertEquals(
    buildEmptyManagedDetailResponse('verify-full').ssl,
    {
      configured: null,
      effective: 'verify-full',
      organizationDefault: 'verify-full',
    },
  )
  // A service override wins over the org default in both directions.
  assertEquals(buildManagedSslView('prefer', 'verify-full'), {
    configured: 'prefer',
    effective: 'prefer',
    organizationDefault: 'verify-full',
  })
  assertEquals(buildManagedDeleteHardResponse(), { ok: true, deleted: true })
  assertEquals(
    buildManagedDeleteQueuedResponse(
      [{ commandId: 'd1', serverId: 's1' }],
      'fb',
    ),
    {
      ok: true,
      deleted: false,
      commandId: 'd1',
      serverId: 's1',
      results: [{ commandId: 'd1', serverId: 's1' }],
    },
  )
  assertEquals(
    buildManagedDestroyQueuedResponse({ commandId: 'x', serverId: 's' }),
    {
      ok: true,
      destroyCommandId: 'x',
      commandId: 'x',
      serverId: 's',
      status: 'queued',
    },
  )
  assertEquals(
    buildFencePromotePendingResponse({ commandId: 'f', serverId: 's' }),
    {
      ok: true,
      commandId: 'f',
      serverId: 's',
      status: 'queued',
      fenceCommandId: 'f',
      promotePending: true,
    },
  )
  assertEquals(
    buildPromoteQueuedResponse({ commandId: 'p', serverId: 's' }),
    { ok: true, commandId: 'p', status: 'queued', serverId: 's' },
  )
})

test('operatorPromoteHttpResult maps switchover enqueue to HTTP', () => {
  assertEquals(
    operatorPromoteHttpResult({ ok: false, error: 'conflict', status: 409 }),
    { status: 409, body: { error: 'conflict' } },
  )
  assertEquals(
    operatorPromoteHttpResult({
      ok: true,
      commandId: 'f',
      serverId: 's',
      fencePending: true,
    }),
    {
      status: 200,
      body: buildFencePromotePendingResponse({ commandId: 'f', serverId: 's' }),
    },
  )
  assertEquals(
    operatorPromoteHttpResult({
      ok: true,
      commandId: 'p',
      serverId: 's',
      fencePending: false,
    }),
    {
      status: 200,
      body: buildPromoteQueuedResponse({ commandId: 'p', serverId: 's' }),
    },
  )
})

test('backup helpers sort and find by id', () => {
  const backups = [
    { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', createdAt: '2026-02-01T00:00:00.000Z' },
  ]
  assertEquals(sortManagedBackupsDesc(backups).map((b) => b.id), ['b', 'a'])
  assertEquals(findManagedBackupById(backups, 'a')?.id, 'a')
  assertEquals(findManagedBackupById(backups, 'missing'), undefined)
})

test('buildStatusMemberView and org list entry', () => {
  assertEquals(
    buildStatusMemberView({
      id: 'm1',
      serverId: 's1',
      role: 'replica',
      replicaClass: 'read',
      status: 'ready',
      replicationTransport: 'fabric',
      privatePort: 54000,
      replication: { state: 'streaming' },
    }),
    {
      id: 'm1',
      serverId: 's1',
      role: 'replica',
      replicaClass: 'read',
      status: 'ready',
      replicationTransport: 'fabric',
      privatePort: 54000,
      replication: { state: 'streaming' },
    },
  )
  assertEquals(
    buildStatusMemberView({
      id: 'm1-public',
      serverId: 's1',
      role: 'replica',
      status: 'ready',
      replicationTransport: 'public',
      privatePort: 54000,
    }).replicationTransport,
    'public',
  )
  assertEquals(
    buildStatusMemberView({
      id: 'm2',
      serverId: 's2',
      role: 'primary',
      status: null,
      replicationTransport: null,
      privatePort: null,
    }).replication,
    undefined,
  )

  const entry = buildOrgManagedListEntry({
    serializedRow: { id: 'mg', engine: 'postgres' },
    engineDisplayName: 'PostgreSQL',
    environmentDisplayName: 'Production',
    projectId: 'p1',
    projectDisplayName: 'App',
    workspaceId: 'w1',
    workspaceDisplayName: 'Default',
    serverDisplayName: 'Host',
    members: [{ id: 'mem' }],
  })
  assertEquals(entry.id, 'mg')
  assertEquals(entry.engine, 'postgres')
  assertEquals(entry.engineDisplayName, 'PostgreSQL')
  assertEquals(entry.environmentDisplayName, 'Production')
  assertEquals(entry.projectId, 'p1')
  assertEquals(entry.projectDisplayName, 'App')
  assertEquals(entry.workspaceId, 'w1')
  assertEquals(entry.workspaceDisplayName, 'Default')
  assertEquals(entry.serverDisplayName, 'Host')
  assertEquals(entry.members, [{ id: 'mem' }])
})

test('managedStatusListenerParams skips unplaced, uncatalogued, and unreadable rows', () => {
  const settings = postgresEngineSpec.parseSettings(
    postgresEngineSpec.defaultSettings,
  )
  if (!settings) {
    throw new TypeError('failed to parse default postgres settings')
  }
  const options = writeManagedRowOptions({
    settings,
    databases: ['postgres'],
    backups: [],
  })

  assertEquals(managedStatusListenerParams(null), null)
  assertEquals(
    managedStatusListenerParams({
      serverId: null,
      engine: 'postgres',
      options,
    }),
    null,
  )
  assertEquals(
    managedStatusListenerParams({
      serverId: 's1',
      engine: 'nope',
      options,
    }),
    null,
  )
  assertEquals(
    managedStatusListenerParams({
      serverId: 's1',
      engine: 'redis',
      options,
    }),
    null,
  )
  assertEquals(
    managedStatusListenerParams({
      serverId: 's1',
      engine: 'postgres',
      options: { settings: { image: '' } },
    }),
    null,
  )
  assertEquals(
    managedStatusListenerParams({
      serverId: 's1',
      engine: 'postgres',
      options,
    }),
    {
      serverId: 's1',
      engineCode: 'postgres',
      engineDefaultPort: postgresEngineSpec.defaultPort,
      exposure: settings.exposure,
    },
  )
})

test('parseManagedConnectionRole defaults absent values to read-write', () => {
  assertEquals(parseManagedConnectionRole(undefined), 'read-write')
  assertEquals(parseManagedConnectionRole(null), 'read-write')
  assertEquals(parseManagedConnectionRole('read-write'), 'read-write')
  assertEquals(parseManagedConnectionRole('read-only'), 'read-only')
  assertEquals(parseManagedConnectionRole('write-only'), null)
  assertEquals(parseManagedConnectionRole(1), null)
})

test('parseDisasterRecoveryPromoteBody requires confirm and a member id', () => {
  assertEquals(parseDisasterRecoveryPromoteBody({}), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseDisasterRecoveryPromoteBody({ confirm: true }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseDisasterRecoveryPromoteBody({ confirm: true, memberId: '' }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(
    parseDisasterRecoveryPromoteBody({ confirm: false, memberId: 'mem-1' }),
    { ok: false, error: 'Invalid request', status: 400 },
  )
  assertEquals(
    parseDisasterRecoveryPromoteBody({ confirm: true, memberId: 'mem-1' }),
    { ok: true, memberId: 'mem-1' },
  )
})

test('buildDisasterRecoveryQueuedResponse names source and target', () => {
  assertEquals(
    buildDisasterRecoveryQueuedResponse({
      commandId: 'cmd-1',
      serverId: 'srv-target',
      fencePending: true,
      lagBytes: 12,
      sourceMemberId: 'mem-src',
      sourceServerId: 'srv-src',
      sourceDatacenterId: 'dc-src',
      targetMemberId: 'mem-tgt',
      targetServerId: 'srv-target',
      targetDatacenterId: null,
    }),
    {
      ok: true,
      commandId: 'cmd-1',
      status: 'queued',
      serverId: 'srv-target',
      fencePending: true,
      kind: 'disaster-recovery',
      lagBytes: 12,
      source: {
        memberId: 'mem-src',
        serverId: 'srv-src',
        datacenterId: 'dc-src',
      },
      target: {
        memberId: 'mem-tgt',
        serverId: 'srv-target',
        datacenterId: null,
      },
    },
  )
})
