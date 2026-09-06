import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import { managedContainerName } from '../../lib/naming.ts'
import {
  deleteManagedContainerAllocation,
  ensureManagedContainerAllocation,
  findManagedEngineServiceId,
  pruneManagedContainerOrdinals,
  pruneManagedContainersOutsideMemberSet,
} from './allocate-managed-container.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type MemService = {
  id: string
  environmentId: string
  name: string
  options: Record<string, unknown> | null
}

type MemContainer = {
  id: string
  serviceId: string
  serverId: string
  containerId: string | null
  containerName: string
  status: string
  role: string
  composeServiceName: string
  ordinal: number
}

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function thenableVoid() {
  const promise = Promise.resolve(undefined)
  return {
    onConflictDoNothing: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

type AllocationDbHandle = {
  db: Db
  services: MemService[]
  containers: MemContainer[]
  updates: Array<{ id: string; patch: Record<string, unknown> }>
  deletedContainerIds: string[]
  setMemberOrdinalsHint: (ordinals: number[] | null) => void
}

function createManagedAllocationDb(opts?: {
  services?: MemService[]
  containers?: MemContainer[]
  omitServiceAfterInsert?: boolean
  omitContainerAfterInsert?: boolean
}): AllocationDbHandle {
  const services: MemService[] = (opts?.services ?? []).map((s) => ({
    ...s,
    options: s.options ?? null,
  }))
  const containers = [...(opts?.containers ?? [])]
  let nextServiceNum = services.length + 1
  let nextContainerNum = containers.length + 1
  let selectCalls = 0
  let lastServiceId: string | null = null
  let lastOrdinal = 1
  let lastMemberOrdinals: number[] | null = null
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const deletedContainerIds: string[] = []

  const upsertService = (values: Record<string, unknown>) => {
    const environmentId = values.environmentId as string
    const name = values.name as string
    const existing = services.find(
      (row) =>
        row.environmentId === environmentId &&
        row.name === name,
    )
    if (existing) {
      lastServiceId = existing.id
      return
    }
    const id = `svc-${nextServiceNum++}`
    services.push({
      id,
      environmentId,
      name,
      options: null,
    })
    lastServiceId = id
  }

  const upsertContainer = (values: Record<string, unknown>) => {
    const serviceId = values.serviceId as string
    const role = values.role as string
    const ordinal = values.ordinal as number
    lastOrdinal = ordinal
    const existing = containers.find(
      (row) =>
        row.serviceId === serviceId &&
        row.role === role &&
        row.ordinal === ordinal,
    )
    if (existing) return
    containers.push({
      id: `ctr-${nextContainerNum++}`,
      serviceId,
      serverId: values.serverId as string,
      containerId: (values.containerId as string | null) ?? null,
      containerName: values.containerName as string,
      status: values.status as string,
      role,
      composeServiceName: values.composeServiceName as string,
      ordinal,
    })
  }

  const selectService = () => {
    if (opts?.omitServiceAfterInsert) return []
    if (!lastServiceId) return []
    const row = services.find((entry) => entry.id === lastServiceId)
    return row ? [{ id: row.id, options: row.options }] : []
  }

  const selectContainer = () => {
    if (opts?.omitContainerAfterInsert) return []
    if (!lastServiceId) return []
    const row = containers.find(
      (entry) =>
        entry.serviceId === lastServiceId &&
        entry.role === 'service' &&
        entry.ordinal === lastOrdinal,
    )
    if (!row) return []
    return [{
      id: row.id,
      serverId: row.serverId,
      containerName: row.containerName,
      status: row.status,
      containerId: row.containerId,
      composeServiceName: row.composeServiceName,
    }]
  }

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        if ('environmentId' in values) {
          upsertService(values)
        } else {
          upsertContainer(values)
        }
        return thenableVoid()
      },
    }),
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls += 1
          if (selectCalls % 2 === 1) {
            return thenableRows(selectService())
          }
          return thenableRows(selectContainer())
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          // Container rename/re-home
          const containerRow = containers.find(
            (entry) =>
              entry.serviceId === lastServiceId &&
              entry.role === 'service' &&
              entry.ordinal === lastOrdinal,
          )
          if (containerRow && !('instances' in patch) && !('options' in patch)) {
            updates.push({ id: containerRow.id, patch })
            Object.assign(containerRow, patch)
          }
          // service.options.instances
          if ('options' in patch && lastServiceId) {
            const svc = services.find((s) => s.id === lastServiceId)
            if (svc) {
              svc.options = patch.options as Record<string, unknown>
              updates.push({ id: lastServiceId, patch })
            }
          }
          return thenableVoid()
        },
      }),
    }),
    delete: () => ({
      where: () => {
        // Approximate member-set prune / ingress cleanup when ordinals known
        for (const row of [...containers]) {
          if (row.serviceId !== lastServiceId) continue
          if (
            row.role === 'service' &&
            row.containerId === null &&
            row.status === 'pending' &&
            lastMemberOrdinals &&
            !lastMemberOrdinals.includes(row.ordinal)
          ) {
            deletedContainerIds.push(row.id)
            containers.splice(containers.indexOf(row), 1)
          }
          if (row.role === 'ingress' && row.containerId === null) {
            deletedContainerIds.push(row.id)
            containers.splice(containers.indexOf(row), 1)
          }
        }
        return thenableVoid()
      },
    }),
  } as unknown as Db

  return {
    db,
    services,
    containers,
    updates,
    deletedContainerIds,
    setMemberOrdinalsHint(ordinals: number[] | null) {
      lastMemberOrdinals = ordinals
    },
  }
}

test('ensureManagedContainerAllocation creates service + pending ordinal-1 container', async () => {
  const { db, services, containers } = createManagedAllocationDb()
  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
    ordinal: 1,
  })

  assertEquals(services.length, 1)
  assertEquals(services[0]!.name, 'postgres')
  assertEquals(containers.length, 1)
  assertEquals(containers[0]!.role, 'service')
  assertEquals(containers[0]!.ordinal, 1)
  assertEquals(allocation.serviceId, services[0]!.id)
  assertEquals(allocation.containerRowId, containers[0]!.id)
  assertEquals(allocation.containerName, managedContainerName(services[0]!.id, 1))
})

test('ensureManagedContainerAllocation supports ordinals 2 and 3', async () => {
  const handle = createManagedAllocationDb()
  const { db, containers, services } = handle

  const first = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
    ordinal: 1,
  })
  const second = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-2',
    composeServiceName: 'postgres',
    ordinal: 2,
  })
  const third = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-3',
    composeServiceName: 'postgres',
    ordinal: 3,
  })

  // One shared service row; members are ordinals on that service id.
  assertEquals(services.length, 1)
  assertEquals(second.serviceId, first.serviceId)
  assertEquals(third.serviceId, first.serviceId)
  assertEquals(containers.length, 3)
  assertEquals(
    containers.map((r) => r.ordinal).sort((a, b) => a - b),
    [1, 2, 3],
  )
  const serviceId = first.serviceId
  assertEquals(
    containers.find((r) => r.ordinal === 1)?.containerName,
    managedContainerName(serviceId, 1),
  )
  assertEquals(
    containers.find((r) => r.ordinal === 2)?.containerName,
    managedContainerName(serviceId, 2),
  )
  assertEquals(
    containers.find((r) => r.ordinal === 3)?.containerName,
    managedContainerName(serviceId, 3),
  )
})

test('ensureManagedContainerAllocation is idempotent on stub db', async () => {
  const { db, services, containers } = createManagedAllocationDb()
  const first = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
    ordinal: 1,
  })
  const second = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
    ordinal: 1,
  })

  assertEquals(second.serviceId, first.serviceId)
  assertEquals(second.containerRowId, first.containerRowId)
  assertEquals(services.length, 1)
  assertEquals(containers.length, 1)
})

test('ensureManagedContainerAllocation re-homes null-id row to pending on new server', async () => {
  const serviceId = 'svc-existing'
  const { db, containers, updates } = createManagedAllocationDb({
    services: [{
      id: serviceId,
      environmentId: 'env-1',
      name: 'postgres',
      options: null,
    }],
    containers: [{
      id: 'ctr-old',
      serviceId,
      serverId: 'srv-old',
      containerId: null,
      containerName: 'pending',
      status: 'exited',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 1,
    }],
  })

  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-new',
    composeServiceName: 'postgres',
    ordinal: 1,
  })

  assertEquals(allocation.containerRowId, 'ctr-old')
  assertEquals(allocation.containerName, managedContainerName(serviceId, 1))
  assertEquals(containers[0]!.serverId, 'srv-new')
  assertEquals(containers[0]!.status, 'pending')
  assertEquals(containers[0]!.containerName, managedContainerName(serviceId, 1))
  assertEquals(updates.some((u) => u.patch.status === 'pending'), true)
})

test('ensureManagedContainerAllocation skips update when null-id row already matches', async () => {
  const serviceId = 'svc-ready'
  const nextName = managedContainerName(serviceId, 1)
  const { db, updates } = createManagedAllocationDb({
    services: [{
      id: serviceId,
      environmentId: 'env-1',
      name: 'postgres',
      options: null,
    }],
    containers: [{
      id: 'ctr-ready',
      serviceId,
      serverId: 'srv-1',
      containerId: null,
      containerName: nextName,
      status: 'pending',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 1,
    }],
  })

  await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
    ordinal: 1,
  })

  assertEquals(updates.length, 0)
})

test('ensureManagedContainerAllocation renames running row without clearing containerId', async () => {
  const serviceId = 'svc-live'
  const { db, containers, updates } = createManagedAllocationDb({
    services: [{
      id: serviceId,
      environmentId: 'env-1',
      name: 'postgres',
      options: null,
    }],
    containers: [{
      id: 'ctr-live',
      serviceId,
      serverId: 'srv-1',
      containerId: 'docker-abc',
      containerName: 'stale-name',
      status: 'running',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 1,
    }],
  })

  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
    ordinal: 1,
  })

  assertEquals(allocation.containerName, managedContainerName(serviceId, 1))
  assertEquals(containers[0]!.containerId, 'docker-abc')
  assertEquals(containers[0]!.status, 'running')
  assertEquals(updates.length, 1)
  assertEquals(updates[0]!.patch.containerName, managedContainerName(serviceId, 1))
  assertEquals(updates[0]!.patch.role, 'service')
  assertEquals('status' in updates[0]!.patch, false)
})

test('ensureManagedContainerAllocation syncs options.instances from memberOrdinals', async () => {
  const serviceId = 'svc-inst'
  const handle = createManagedAllocationDb({
    services: [{
      id: serviceId,
      environmentId: 'env-1',
      name: 'postgres',
      options: null,
    }],
    containers: [{
      id: 'ctr-1',
      serviceId,
      serverId: 'srv-1',
      containerId: null,
      containerName: managedContainerName(serviceId, 1),
      status: 'pending',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 1,
    }],
  })
  handle.setMemberOrdinalsHint([1, 2])

  await ensureManagedContainerAllocation(handle.db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
    ordinal: 1,
    memberOrdinals: [1, 2],
  })

  assertEquals(handle.services[0]!.options?.instances, 2)
})

test('pruneManagedContainersOutsideMemberSet removes out-of-set pending ordinals', async () => {
  const serviceId = 'svc-prune'
  const containers: MemContainer[] = [
    {
      id: 'ctr-1',
      serviceId,
      serverId: 'srv-1',
      containerId: null,
      containerName: managedContainerName(serviceId, 1),
      status: 'pending',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 1,
    },
    {
      id: 'ctr-2',
      serviceId,
      serverId: 'srv-2',
      containerId: null,
      containerName: managedContainerName(serviceId, 2),
      status: 'pending',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 2,
    },
  ]
  const deleted: string[] = []
  const db = {
    delete: () => ({
      where: () => {
        for (const row of [...containers]) {
          if (
            row.serviceId === serviceId &&
            row.role === 'service' &&
            row.containerId === null &&
            row.status === 'pending' &&
            row.ordinal === 2
          ) {
            deleted.push(row.id)
            containers.splice(containers.indexOf(row), 1)
          }
        }
        return Promise.resolve(undefined)
      },
    }),
  } as unknown as Db

  await pruneManagedContainersOutsideMemberSet(db, serviceId, [1])
  assertEquals(deleted, ['ctr-2'])
  assertEquals(containers.map((r) => r.id), ['ctr-1'])
})

test('ensureManagedContainerAllocation throws when service row missing after upsert', async () => {
  const { db } = createManagedAllocationDb({ omitServiceAfterInsert: true })
  await assertRejects(
    () =>
      ensureManagedContainerAllocation(db, {
        environmentId: 'env-1',
        serverId: 'srv-1',
        composeServiceName: 'postgres',
        ordinal: 1,
      }),
    Error,
    'managed service allocation missing after upsert',
  )
})

test('ensureManagedContainerAllocation throws when container row missing after upsert', async () => {
  const { db } = createManagedAllocationDb({ omitContainerAfterInsert: true })
  await assertRejects(
    () =>
      ensureManagedContainerAllocation(db, {
        environmentId: 'env-1',
        serverId: 'srv-1',
        composeServiceName: 'postgres',
        ordinal: 1,
      }),
    Error,
    'managed container allocation missing after upsert',
  )
})

test('ensureManagedContainerAllocation rejects non-positive ordinal', async () => {
  const { db } = createManagedAllocationDb()
  await assertRejects(
    () =>
      ensureManagedContainerAllocation(db, {
        environmentId: 'env-1',
        serverId: 'srv-1',
        composeServiceName: 'postgres',
        ordinal: 0,
      }),
    TypeError,
    'Invalid managed container ordinal',
  )
})

test('pruneManagedContainersOutsideMemberSet is a no-op for an empty ordinal set', async () => {
  const db = {
    delete: () => {
      throw new TypeError('should not delete when no ordinals remain')
    },
  } as unknown as Db
  await pruneManagedContainersOutsideMemberSet(db, 'svc-1', [])
})

test('deleteManagedContainerAllocation deletes the pending replica row', async () => {
  let deleted = false
  const db = {
    delete: () => ({
      where: () => {
        deleted = true
        return Promise.resolve()
      },
    }),
  } as unknown as Db
  await deleteManagedContainerAllocation(db, { serviceId: 'svc-1', ordinal: 2 })
  assertEquals(deleted, true)
})

test('findManagedEngineServiceId returns the matching service or null', async () => {
  const found = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'svc-engine' }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await findManagedEngineServiceId(found, 'env-1', 'postgres'),
    'svc-engine',
  )

  const missing = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await findManagedEngineServiceId(missing, 'env-1', 'postgres'), null)
})

test('pruneManagedContainerOrdinals deletes listed pending ordinals', async () => {
  let deleted = false
  const db = {
    delete: () => ({
      where: () => {
        deleted = true
        return Promise.resolve()
      },
    }),
  } as unknown as Db
  await pruneManagedContainerOrdinals(db, 'svc-1', [])
  assertEquals(deleted, false)
  await pruneManagedContainerOrdinals(db, 'svc-1', [1, 2])
  assertEquals(deleted, true)
})
