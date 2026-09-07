/**
 * Host-free coverage for server route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import {
  SERVER_UUID_RE,
  STATUS_CACHE_CONTROL,
  STATUS_CACHE_MAX_AGE_MS,
  UPDATE_CHANNEL,
  isServerUuid,
  buildBatchStatusCoalesceKey,
  expiredBatchStatusCoalesceKeys,
  currentCommitFromDaemonBuild,
  parseServerPatchCore,
  isHostingEnableTransition,
  isHostingDisableTransition,
  hostingHierarchyFailedBody,
  serverDeletedPayload,
  queueServerUpdateHttpStatus,
  emptyServersUpdatesPayload,
  resolveTrunkTargetFields,
  resolveBatchUpdateEligibility,
  runPreparedServerUpdate,
  updateResetErrorStatus,
  distinctNonEmptyIds,
  errorMessageFromUnknown,
  resolveServerTimezoneFields,
  resolveServerHostDefaultsFields,
  shapeServerDatacenters,
  shapeServerOsFields,
  shapeServerPresenceFields,
  shouldSkipProjectedUpdateRepair,
  repairedUpdateDoneProjection,
  repairedUpdateIdleProjection,
} from './routes-helpers.ts'
import { colocatedServerUpdateBlockedReason } from './update-status.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

test('isServerUuid and SERVER_UUID_RE accept canonical UUIDs', () => {
  assertEquals(isServerUuid(UUID), true)
  assertEquals(isServerUuid('not-a-uuid'), false)
  assertEquals(isServerUuid(null), false)
  assertEquals(isServerUuid(12), false)
  assertEquals(SERVER_UUID_RE.test(UUID.toUpperCase()), true)
})

test('buildBatchStatusCoalesceKey sorts visible ids for stable keys', () => {
  assertEquals(
    buildBatchStatusCoalesceKey('u1', 'o1', [UUID_B, UUID]),
    buildBatchStatusCoalesceKey('u1', 'o1', [UUID, UUID_B]),
  )
  assertEquals(
    buildBatchStatusCoalesceKey('u1', 'o1', [UUID]),
    `u1:o1:${UUID}`,
  )
})

test('expiredBatchStatusCoalesceKeys skips in-flight promises', () => {
  const now = 1_000
  const keys = expiredBatchStatusCoalesceKeys(
    [
      ['a', { expiresAt: 500 }],
      ['b', { expiresAt: 500, promise: Promise.resolve() }],
      ['c', { expiresAt: 2_000 }],
    ],
    now,
  )
  assertEquals(keys, ['a'])
})

test('currentCommitFromDaemonBuild maps daemonBuild commit fields', () => {
  assertEquals(currentCommitFromDaemonBuild(undefined), null)
  assertEquals(currentCommitFromDaemonBuild({}), null)
  assertEquals(currentCommitFromDaemonBuild({ commit: 'abc' }), {
    commit: 'abc',
    buildId: '',
    builtAt: '',
  })
  assertEquals(
    currentCommitFromDaemonBuild({
      commit: 'abc',
      buildId: 'b1',
      builtAt: '2020-01-01T00:00:00.000Z',
    }),
    {
      commit: 'abc',
      buildId: 'b1',
      builtAt: '2020-01-01T00:00:00.000Z',
    },
  )
})

test('parseServerPatchCore validates name, options, and emptiness', () => {
  const empty = parseServerPatchCore({})
  if (empty.ok) throw new TypeError('expected empty patch rejection')
  assertEquals(empty.error, 'Invalid request')

  const badName = parseServerPatchCore({ name: '' })
  if (badName.ok) throw new TypeError('expected empty name rejection')

  const badOptions = parseServerPatchCore({ options: 'nope' })
  if (badOptions.ok) throw new TypeError('expected bad options rejection')

  const rejectedDc = parseServerPatchCore({ datacenterId: null })
  if (rejectedDc.ok) throw new TypeError('expected datacenterId rejection')
  assertEquals(rejectedDc.error, 'Invalid request')

  const withName = parseServerPatchCore(
    { name: 'edge-1' },
    '2020-01-01T00:00:00.000Z',
  )
  if (!withName.ok) throw new TypeError('expected name patch')
  assertEquals(withName.patch.name, 'edge-1')
  assertEquals(withName.patch.updatedAt, '2020-01-01T00:00:00.000Z')

  const withHosting = parseServerPatchCore({
    options: { hosting: { enabled: true } },
  })
  if (!withHosting.ok) throw new TypeError('expected hosting options patch')
  assertEquals(withHosting.patch.options?.hosting?.enabled, true)

  const withSsh = parseServerPatchCore({ options: { sshPort: 2222 } })
  if (!withSsh.ok) throw new TypeError('expected sshPort patch')
  assertEquals(withSsh.patch.options?.sshPort, 2222)

  const clearSsh = parseServerPatchCore({ options: { sshPort: null } })
  if (!clearSsh.ok) throw new TypeError('expected sshPort clear')
  assertEquals(clearSsh.patch.options?.sshPort, null)

  const badSsh = parseServerPatchCore({ options: { sshPort: 0 } })
  if (badSsh.ok) throw new TypeError('expected invalid sshPort rejection')
  assertEquals(badSsh.error, 'Invalid sshPort')

  const withNtp = parseServerPatchCore({
    options: { ntp: { enabled: true } },
  })
  if (!withNtp.ok) throw new TypeError('expected ntp patch')
  assertEquals(withNtp.patch.options?.ntp, { enabled: true })

  const clearNtp = parseServerPatchCore({ options: { ntp: null } })
  if (!clearNtp.ok) throw new TypeError('expected ntp clear')
  assertEquals(clearNtp.patch.options?.ntp, null)

  const badNtp = parseServerPatchCore({ options: { ntp: 0 } })
  if (badNtp.ok) throw new TypeError('expected invalid ntp rejection')
  assertEquals(badNtp.error, 'Invalid ntp')
})

test('shapeServerDatacenters dedupes and sorts memberships', () => {
  const names = new Map([
    ['dc-b', 'Beta'],
    ['dc-a', 'Alpha'],
  ])
  assertEquals(
    shapeServerDatacenters(
      [
        { datacenterId: 'dc-b' },
        { datacenterId: 'dc-a' },
        { datacenterId: 'dc-b' },
      ],
      names,
    ),
    [
      { id: 'dc-a', name: 'Alpha' },
      { id: 'dc-b', name: 'Beta' },
    ],
  )
})

test('hosting enable/disable transitions detect edges only', () => {
  const enablePatch = {
    options: { hosting: { enabled: true } },
    updatedAt: 't',
  }
  const disablePatch = {
    options: { hosting: { enabled: false } },
    updatedAt: 't',
  }
  assertEquals(isHostingEnableTransition(null, enablePatch), true)
  assertEquals(
    isHostingEnableTransition({ hosting: { enabled: true } }, enablePatch),
    false,
  )
  assertEquals(
    isHostingDisableTransition({ hosting: { enabled: true } }, disablePatch),
    true,
  )
  assertEquals(isHostingDisableTransition(null, disablePatch), false)
  assertEquals(
    isHostingDisableTransition({ hosting: { enabled: true } }, enablePatch),
    false,
  )
})

test('serverDeletedPayload and hostingHierarchyFailedBody shapes', () => {
  assertEquals(serverDeletedPayload('srv-1', null), {
    ok: true,
    serverId: 'srv-1',
    status: 200,
  })
  assertEquals(serverDeletedPayload('srv-1', 'boom'), {
    ok: false,
    serverId: 'srv-1',
    deleted: true,
    error: 'Server deleted but daemon cell purge failed: boom',
    status: 500,
  })
  assertEquals(hostingHierarchyFailedBody(), {
    error: 'Failed to provision hosting hierarchy',
    code: 'hosting_hierarchy_failed',
  })
})

test('queueServerUpdateHttpStatus maps colocated vs other errors', () => {
  assertEquals(
    queueServerUpdateHttpStatus(colocatedServerUpdateBlockedReason()),
    403,
  )
  assertEquals(queueServerUpdateHttpStatus('Daemon not connected'), 404)
})

test('emptyServersUpdatesPayload and resolveTrunkTargetFields', () => {
  assertEquals(emptyServersUpdatesPayload().channel, UPDATE_CHANNEL)
  assertEquals(emptyServersUpdatesPayload().targetStatus, 'unknown')
  assertEquals(emptyServersUpdatesPayload().servers, [])

  assertEquals(resolveTrunkTargetFields(null), {
    target: null,
    targetStatus: 'unknown',
    targetError: 'Could not resolve trunk channel manifest',
  })
  const manifest = {
    commit: 'c1',
    buildId: 'b1',
    builtAt: '2020-01-01T00:00:00.000Z',
    manifestUrl: 'https://example.test/manifest',
  }
  assertEquals(resolveTrunkTargetFields(manifest), {
    target: manifest,
    targetStatus: 'ok',
    targetError: undefined,
  })
})

test('resolveBatchUpdateEligibility covers each rejection path', () => {
  assertEquals(
    resolveBatchUpdateEligibility({
      connected: false,
      colocated: false,
      current: null,
      targetCommit: 't',
    }),
    { ok: false, error: 'Daemon not connected' },
  )
  assertEquals(
    resolveBatchUpdateEligibility({
      connected: true,
      colocated: true,
      current: null,
      targetCommit: 't',
    }),
    { ok: false, error: colocatedServerUpdateBlockedReason() },
  )
  assertEquals(
    resolveBatchUpdateEligibility({
      connected: true,
      colocated: false,
      current: { commit: 't', buildId: '' },
      targetCommit: 't',
    }),
    { ok: false, error: 'Up to date' },
  )
  assertEquals(
    resolveBatchUpdateEligibility({
      connected: true,
      colocated: false,
      current: null,
      targetCommit: null,
    }),
    { ok: false, error: 'Target unavailable' },
  )
  assertEquals(
    resolveBatchUpdateEligibility({
      connected: true,
      colocated: false,
      current: { commit: 'old', buildId: '' },
      targetCommit: 'new',
    }),
    { ok: true, updateAvailable: true },
  )
})

test('updateResetErrorStatus and distinctNonEmptyIds / errorMessageFromUnknown', () => {
  assertEquals(updateResetErrorStatus('update in progress'), 409)
  assertEquals(updateResetErrorStatus('other'), 500)
  assertEquals(distinctNonEmptyIds([null, '', UUID, UUID, undefined]), [UUID])
  assertEquals(errorMessageFromUnknown(new Error('x')), 'x')
  assertEquals(errorMessageFromUnknown('y'), 'y')
})

test('timezone and presence shaping helpers', () => {
  const tz = resolveServerTimezoneFields(
    { timezone: 'UTC' },
    { enforceServerTimezone: false },
    undefined,
    'America/Chicago',
  )
  assertEquals(tz.timezone, 'UTC')
  assertEquals(tz.timezoneSource, 'server')

  const inherited = resolveServerHostDefaultsFields(
    {},
    { sshPort: 22022, ntp: { enabled: true } },
    { sshPort: 2222 },
  )
  assertEquals(inherited.sshPort, 2222)
  assertEquals(inherited.sshPortSource, 'datacenter')
  assertEquals(inherited.ntpDefaults, { enabled: true })
  assertEquals(inherited.ntpDefaultsSource, 'organization')

  const builtin = resolveServerHostDefaultsFields({}, {}, undefined)
  assertEquals(builtin.sshPort, 22)
  assertEquals(builtin.sshPortSource, null)
  assertEquals(builtin.ntpDefaults, null)

  const os = shapeServerOsFields({ family: 'linux', id: 'debian' })
  assertEquals(os.os?.id, 'debian')
  assertEquals(typeof os.osDisplay, 'string')

  const presence = shapeServerPresenceFields(
    {
      connected: true,
      hostname: 'host',
      os: { family: 'linux' },
      docker: { version: '28.3.3' },
    },
    true,
  )
  assertEquals(presence.connected, true)
  assertEquals(presence.hostname, 'host')
  assertEquals(presence.colocatedWithInstance, true)
  assertEquals(presence.docker, { version: '28.3.3' })

  assertEquals(shapeServerPresenceFields(undefined, false).connected, false)
  assertEquals(shapeServerPresenceFields(undefined, false).docker, null)
})

test('projected update repair helpers', () => {
  assertEquals(shouldSkipProjectedUpdateRepair(null), true)
  assertEquals(shouldSkipProjectedUpdateRepair({ status: 'idle' }), true)
  assertEquals(shouldSkipProjectedUpdateRepair({ status: 'updating' }), false)
  assertEquals(
    repairedUpdateDoneProjection({
      requestId: 'r1',
      channel: 'trunk',
      queuedAt: 'q',
      finishedAt: 'f',
    }),
    {
      status: 'done',
      requestId: 'r1',
      channel: 'trunk',
      queuedAt: 'q',
      finishedAt: 'f',
    },
  )
  assertEquals(repairedUpdateIdleProjection(), { status: 'idle' })
})

test('status cache constants stay stable for Cache-Control headers', () => {
  assertEquals(STATUS_CACHE_CONTROL, 'private, max-age=5')
  assertEquals(STATUS_CACHE_MAX_AGE_MS, 5_000)
})

test('runPreparedServerUpdate enqueues after prepare and refreshes queuedAt', async () => {
  const events: string[] = []
  await runPreparedServerUpdate({
    prepare: async () => {
      events.push('prepare')
    },
    enqueue: async () => {
      events.push('enqueue')
    },
    markQueued: async (queuedAt) => {
      events.push(`queued:${typeof queuedAt}`)
    },
    markFailed: async () => {
      events.push('failed')
    },
  })
  assertEquals(events, ['prepare', 'enqueue', 'queued:string'])
})

test('runPreparedServerUpdate surfaces prepare failures without enqueueing', async () => {
  const events: string[] = []
  await runPreparedServerUpdate({
    prepare: () => Promise.reject(new Error('compile boom')),
    enqueue: async () => {
      events.push('enqueue')
    },
    markQueued: async () => {
      events.push('queued')
    },
    markFailed: async (error) => {
      events.push(`failed:${error}`)
    },
  })
  assertEquals(events, ['failed:Dev daemon rebuild failed: compile boom'])
})

test('runPreparedServerUpdate surfaces enqueue failures', async () => {
  const events: string[] = []
  await runPreparedServerUpdate({
    prepare: async () => {},
    enqueue: () => Promise.reject(new Error('cell gone')),
    markQueued: async () => {
      events.push('queued')
    },
    markFailed: async (error) => {
      events.push(`failed:${error}`)
    },
  })
  assertEquals(events, ['failed:cell gone'])
})

test('parseServerPatchCore accepts machineClass pins and rejects unknown classes', () => {
  const physical = parseServerPatchCore({ machineClass: 'physical' })
  if (!physical.ok) throw new TypeError('expected physical machineClass patch')
  assertEquals(physical.patch.machineClass, 'physical')
  assertEquals(physical.patch.name, undefined)
  assertEquals(physical.patch.options, undefined)

  const cleared = parseServerPatchCore({ machineClass: null })
  if (!cleared.ok) throw new TypeError('expected machineClass clear patch')
  assertEquals(cleared.patch.machineClass, null)

  const unknown = parseServerPatchCore({ machineClass: 'bare-metal' })
  if (unknown.ok) throw new TypeError('expected unknown machineClass rejection')
  assertEquals(unknown.error, 'Invalid machineClass')
  assertEquals(unknown.status, 400)

  const wrongType = parseServerPatchCore({ machineClass: 1 })
  if (wrongType.ok) throw new TypeError('expected non-string machineClass rejection')
})
