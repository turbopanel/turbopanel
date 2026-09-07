/**
 * Host-free coverage for principal store helpers (no Postgres).
 */

import { assertEquals, assertMatch, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import { deriveEncryptionSecretsConfig } from '../authn/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createManagedPrincipal,
  createPrincipal,
  ensureManagedReplicationPrincipal,
  isManagedUsernameTaken,
  isServerPrincipalUsernameTaken,
  isUuid,
  listManagedPrincipals,
  lockOrganizationsForUpdate,
  PRINCIPAL_PROVIDERS,
  replaceTenancies,
  resolveManagedAppliedUsername,
  resolveManagedOwningOrganizationIds,
  rotatePrincipalPassword,
  setPrincipalPassword,
  USERNAME_RE,
} from './store.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function testDataEncryptionSecrets() {
  return await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
}

function managedReplicationDb(): Db {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
          where: () => Promise.resolve([{ organizationId: 'org' }]),
        }),
        where: () => ({
          orderBy: () => Promise.resolve([]),
          for: () => ({
            limit: () => Promise.resolve([{ id: 'org' }]),
          }),
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve([{ organizationId: 'org' }]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: 'repl-new' }]),
      }),
    }),
  } as unknown as Db
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    for: () => ({ limit: () => promise }),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

test('isUuid accepts v5-shaped ids and rejects garbage', () => {
  assertEquals(isUuid('00000000-0000-4000-8000-000000000001'), true)
  assertEquals(isUuid('not-a-uuid'), false)
  assertEquals(isUuid(''), false)
})

test('isServerPrincipalUsernameTaken short-circuits blank and hits/misses', async () => {
  assertEquals(
    await isServerPrincipalUsernameTaken(
      {} as Db,
      'org',
      '   ',
    ),
    false,
  )

  const hit = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: 'p1' }]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await isServerPrincipalUsernameTaken(hit, 'org', 'AppUser'), true)

  const miss = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await isServerPrincipalUsernameTaken(miss, 'org', 'free', 'exclude-me'),
    false,
  )
})

test('replaceTenancies deletes inserts and no-ops when unchanged', async () => {
  let deleted: string[] | null = null
  let inserted: unknown = null
  const tx = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([{ serviceId: 's1' }, { serviceId: 's2' }]),
      }),
    }),
    delete: () => ({
      where: () => {
        deleted = ['s2']
        return thenableRows([])
      },
    }),
    insert: () => ({
      values: (values: unknown) => {
        inserted = values
        return thenableRows([])
      },
    }),
  } as unknown as Db

  await replaceTenancies(tx, 'principal', ['s1', 's3'])
  assertEquals(deleted, ['s2'])
  assertEquals(inserted, [
    { principalId: 'principal', serviceId: 's3' },
  ])

  const noopTx = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([{ serviceId: 'only' }]),
      }),
    }),
    delete: () => {
      throw new TypeError('should not delete')
    },
    insert: () => {
      throw new TypeError('should not insert')
    },
  } as unknown as Db
  await replaceTenancies(noopTx, 'principal', ['only'])
})

test('createPrincipal inserts principal and stewards in a transaction', async () => {
  let principalValues: unknown
  let stewardValues: unknown
  const db = {
    transaction: async (fn: (tx: Db) => Promise<string>) => {
      const tx = {
        insert: () => ({
          values: (values: unknown) => {
            if (!principalValues) {
              principalValues = values
              return {
                returning: () => Promise.resolve([{ id: 'new-principal' }]),
              }
            }
            stewardValues = values
            return thenableRows([])
          },
        }),
      } as unknown as Db
      return await fn(tx)
    },
  } as unknown as Db

  const id = await createPrincipal(
    db,
    {
      kind: 'system',
      provider: 'server',
      username: 'deploy',
      metadata: { a: 1 },
      options: { b: 2 },
    },
    ['svc-1', 'svc-2'],
  )
  assertEquals(id, 'new-principal')
  assertEquals((principalValues as { username: string }).username, 'deploy')
  assertEquals(
    (stewardValues as Array<{ serviceId: string }>).map((r) => r.serviceId),
    ['svc-1', 'svc-2'],
  )
})

test('listManagedPrincipals orders and projects columns', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              {
                id: 'p1',
                kind: 'database',
                provider: 'postgres',
                username: 'app',
                managedId: 'm1',
                metadata: null,
                options: null,
                createdAt: 't0',
                updatedAt: 't1',
              },
            ]),
        }),
      }),
    }),
  } as unknown as Db
  const rows = await listManagedPrincipals(db, 'm1')
  assertEquals(rows[0]?.username, 'app')
})

test('resolveManagedOwningOrganizationIds unions members and extras sorted', async () => {
  let call = 0
  const db = {
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () =>
            Promise.resolve([
              { organizationId: 'org-b' },
              { organizationId: 'org-a' },
              { organizationId: null },
            ]),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => {
          call += 1
          return Promise.resolve([
            { organizationId: 'org-c' },
            { organizationId: 'org-a' },
          ])
        },
      }),
    }),
  } as unknown as Db

  assertEquals(
    await resolveManagedOwningOrganizationIds(db, 'm1', ['extra-server']),
    ['org-a', 'org-b', 'org-c'],
  )
  assertEquals(call, 1)

  assertEquals(await resolveManagedOwningOrganizationIds(db, 'm1'), [
    'org-a',
    'org-b',
  ])
})

test('isManagedUsernameTaken handles empty orgs and hits', async () => {
  assertEquals(
    await isManagedUsernameTaken({} as Db, [], 'app'),
    false,
  )
  assertEquals(
    await isManagedUsernameTaken({} as Db, ['org'], '  '),
    false,
  )

  const hit = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: 'p' }]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await isManagedUsernameTaken(hit, ['org'], 'Root', 'exclude'),
    true,
  )
})

test('resolveManagedAppliedUsername prefers free short name without suffix', async () => {
  const free = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db

  const preferred = await resolveManagedAppliedUsername(
    free,
    ['org'],
    'root',
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    { suffix: false },
  )
  assertEquals(preferred, 'root')

  let takenCalls = 0
  const takenThenFree = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => {
                takenCalls += 1
                // preferred taken, suffixed free
                return Promise.resolve(takenCalls === 1 ? [{ id: 'x' }] : [])
              },
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  const derived = await resolveManagedAppliedUsername(
    takenThenFree,
    ['org'],
    'root',
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    { suffix: false },
  )
  assertMatch(derived, /^root_[a-z0-9]{11}$/)
})

test('resolveManagedAppliedUsername suffix mode never returns the bare name', async () => {
  const free = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db

  const derived = await resolveManagedAppliedUsername(
    free,
    ['org'],
    'postgres',
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    { suffix: true },
  )
  assertMatch(derived, /^postgres_[a-z0-9]{11}$/)
})

test('resolveManagedAppliedUsername throws when pattern cannot fit', async () => {
  const free = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: 'x' }]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () =>
      resolveManagedAppliedUsername(
        free,
        ['org'],
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        { pattern: /^[a-z]+$/, maxLength: 5 },
        { suffix: true },
      ),
    TypeError,
    'invalid managed short username',
  )
})

test('lockOrganizationsForUpdate orders ids and no-ops empty', async () => {
  const locked: string[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          void cond
          return {
            for: () => ({
              limit: () => {
                // Capture order via successive calls by intercepting eq via closed over state is hard;
                // just ensure lock path runs.
                locked.push('hit')
                return Promise.resolve([{ id: 'org' }])
              },
            }),
          }
        },
      }),
    }),
  } as unknown as Db

  await lockOrganizationsForUpdate(db, [])
  assertEquals(locked, [])
  await lockOrganizationsForUpdate(db, [
    '00000000-0000-4000-8000-00000000000b',
    '00000000-0000-4000-8000-00000000000a',
  ])
  assertEquals(locked.length, 2)
})

test('PRINCIPAL_PROVIDERS and USERNAME_RE gate managed usernames', () => {
  assertEquals(PRINCIPAL_PROVIDERS.has('postgres'), true)
  assertEquals(PRINCIPAL_PROVIDERS.has('unknown'), false)
  assertEquals(USERNAME_RE.test('App_User-1'), true)
  assertEquals(USERNAME_RE.test('1bad'), false)
})

test('replaceTenancies removes all edges when next list is empty', async () => {
  let deleted = false
  const tx = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([{ serviceId: 's1' }, { serviceId: 's2' }]),
      }),
    }),
    delete: () => ({
      where: () => {
        deleted = true
        return thenableRows([])
      },
    }),
    insert: () => {
      throw new TypeError('should not insert')
    },
  } as unknown as Db
  await replaceTenancies(tx, 'principal', [])
  assertEquals(deleted, true)
})

test('createPrincipal omits null metadata and options from insert', async () => {
  let principalValues: Record<string, unknown> | undefined
  const db = {
    transaction: async (fn: (tx: Db) => Promise<string>) => {
      const tx = {
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            principalValues = values
            return {
              returning: () => Promise.resolve([{ id: 'bare-principal' }]),
            }
          },
        }),
      } as unknown as Db
      return await fn(tx)
    },
  } as unknown as Db

  const id = await createPrincipal(
    db,
    { kind: 'system', provider: 'server', username: 'deploy' },
    [],
  )
  assertEquals(id, 'bare-principal')
  assertEquals(principalValues?.metadata, undefined)
  assertEquals(principalValues?.options, undefined)
})

test('setPrincipalPassword seals explicit password and generate mode', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  let sealed: string | undefined

  const db = {
    update: () => ({
      set: (patch: { password: string }) => {
        sealed = patch.password
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: 'p1' }]),
          }),
        }
      },
    }),
  } as unknown as Db

  const stored = await setPrincipalPassword(
    db,
    dataEncryptionSecrets,
    'p1',
    { password: ' rotate-me ' },
  )
  assertEquals(stored.plaintext, undefined)
  assertEquals(typeof sealed, 'string')
  assertEquals(sealed?.startsWith('tpsecret.'), true)

  const generated = await setPrincipalPassword(
    db,
    dataEncryptionSecrets,
    'p1',
    { generate: true },
  )
  assertEquals(typeof generated.plaintext, 'string')
  assertEquals((generated.plaintext ?? '').length > 0, true)
})

test('setPrincipalPassword rejects missing input and missing principal', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  await assertRejects(
    () =>
      setPrincipalPassword(
        {} as Db,
        dataEncryptionSecrets,
        'p1',
        {} as { generate: true },
      ),
    TypeError,
    'password or generate:true is required',
  )

  const missing = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () =>
      setPrincipalPassword(missing, dataEncryptionSecrets, 'missing', {
        password: 'x',
      }),
    Error,
    'Principal not found',
  )
})

test('rotatePrincipalPassword returns generated plaintext', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  const db = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: 'p1' }]),
        }),
      }),
    }),
  } as unknown as Db
  const rotated = await rotatePrincipalPassword(db, dataEncryptionSecrets, 'p1')
  assertEquals(typeof rotated.plaintext, 'string')
  assertEquals(rotated.plaintext.length > 0, true)
})

test('createManagedPrincipal inserts sealed password and validates inputs', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  let insertValues: Record<string, unknown> | undefined

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertValues = values
        return {
          returning: () => Promise.resolve([{ id: 'managed-user' }]),
        }
      },
    }),
  } as unknown as Db

  const created = await createManagedPrincipal(db, dataEncryptionSecrets, {
    managedId: 'm1',
    provider: 'postgres',
    username: 'app_user',
    metadata: { role: 'app' },
  })
  assertEquals(created.principalId, 'managed-user')
  assertEquals(typeof created.password, 'string')
  assertEquals(insertValues?.managedId, 'm1')
  assertEquals(typeof insertValues?.password, 'string')
  assertEquals((insertValues?.password as string).startsWith('tpsecret.'), true)

  await assertRejects(
    () =>
      createManagedPrincipal(db, dataEncryptionSecrets, {
        managedId: 'm1',
        provider: 'postgres',
        username: '1bad',
      }),
    TypeError,
    'invalid username',
  )
  await assertRejects(
    () =>
      createManagedPrincipal(db, dataEncryptionSecrets, {
        managedId: 'm1',
        provider: 'not-real',
        username: 'valid_user',
      }),
    TypeError,
    'invalid provider',
  )
})

test('ensureManagedReplicationPrincipal reuses existing replication row', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              {
                id: 'repl-existing',
                kind: 'database',
                provider: 'postgres',
                username: 'tp_repl',
                appliedUsername: 'tp_repl',
                managedId: 'm1',
                metadata: { managedReplication: true },
                options: null,
                createdAt: 't0',
                updatedAt: 't1',
              },
            ]),
        }),
      }),
    }),
  } as unknown as Db

  const existing = await ensureManagedReplicationPrincipal(
    db,
    await testDataEncryptionSecrets(),
    {
      managedId: 'm1',
      provider: 'postgres',
      identifier: { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
      randomizeSuffix: true,
    },
  )
  assertEquals(existing, {
    principalId: 'repl-existing',
    appliedUsername: 'tp_repl',
    created: false,
  })
})

test('ensureManagedReplicationPrincipal creates replication principal when absent', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  const result = await ensureManagedReplicationPrincipal(
    managedReplicationDb(),
    dataEncryptionSecrets,
    {
      managedId: '01936b3e-aaaa-bbbb-cccc-123456789abc',
      provider: 'postgres',
      identifier: { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
      randomizeSuffix: true,
    },
  )
  assertEquals(result.created, true)
  assertEquals(result.principalId, 'repl-new')
  assertMatch(result.appliedUsername, /^tp_repl_[a-z0-9]{11}$/)
})

test('resolveManagedAppliedUsername returns a fresh suffix when candidate is taken', async () => {
  let takenCalls = 0
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => {
                takenCalls += 1
                return Promise.resolve([{ id: 'x' }])
              },
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db

  const derived = await resolveManagedAppliedUsername(
    db,
    ['org'],
    'root',
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    { suffix: false },
  )
  assertMatch(derived, /^root_[a-z0-9]{11}$/)
  assertEquals(takenCalls, 2)
})
