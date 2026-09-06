/**
 * Host-free coverage for compose hosting reconcile (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { ComposeDocument } from '../../lib/compose/index.ts'
import { hostingEntryKey } from '../../lib/compose/index.ts'
import { hosting, ip, tls } from '../../lib/db/schema.ts'
import {
  HOSTING_COMPOSE_ROUTE_METADATA_KEY,
  withHostingComposeOwner,
} from '../../lib/hosting-compose-owner.ts'
import { reconcileHostingsFromCompose } from './reconcile-hostings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = 'org-1'
const ENV_ID = 'env-1'
const SVC_WEB = 'svc-web'
const HOSTNAME = 'app.example.com'
const ROUTE = hostingEntryKey({ hostname: HOSTNAME })

type ExistingRow = {
  id: string
  serviceId: string
  metadata: unknown
  options: unknown
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function composeDoc(
  services: Record<string, unknown>,
): ComposeDocument {
  return {
    version: 1,
    data: { services },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

function hostingService(
  hostingEntries: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    image: 'nginx:alpine',
    'x-turbopanel': {
      ...extra,
      hosting: hostingEntries,
    },
  }
}

function composeOwnedMetadata(
  composeServiceName: string,
  route: string,
  adopted = false,
): Record<string, unknown> {
  return withHostingComposeOwner({}, {
    composeServiceName,
    route,
    ...(adopted ? { adopted: true } : {}),
  })
}

function createReconcileDb(opts: {
  hostingRows?: ExistingRow[]
  tlsRows?: Array<{ id: string; label: string | null }>
  ipRows?: Array<{ id: string; label: string | null }>
}) {
  const inserts: Array<Record<string, unknown>> = []
  const updates: Array<{ id: unknown; values: Record<string, unknown> }> = []
  const deletes: unknown[][] = []
  let insertSeq = 0

  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === hosting) {
          return {
            innerJoin: () => ({
              where: () => thenableRows(opts.hostingRows ?? []),
            }),
          }
        }
        if (table === tls) {
          return {
            where: () => thenableRows(opts.tlsRows ?? []),
          }
        }
        if (table === ip) {
          return {
            where: () => thenableRows(opts.ipRows ?? []),
          }
        }
        throw new TypeError('unexpected select table')
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          insertSeq += 1
          const id = `new-host-${insertSeq}`
          inserts.push({ id, ...values })
          return Promise.resolve([{ id }])
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          updates.push({ id: clause, values })
          return Promise.resolve()
        },
      }),
    }),
    delete: () => ({
      where: (clause: unknown) => {
        deletes.push([clause])
        return Promise.resolve()
      },
    }),
  } as unknown as Db

  return { db, inserts, updates, deletes }
}

test('reconcileHostingsFromCompose is a no-op when nothing is declared or owned', async () => {
  const { db, inserts, deletes } = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({}),
    serviceRows: [],
  })
  assertEquals(result, {
    ok: true,
    created: [],
    updated: [],
    adopted: [],
    removed: [],
    released: [],
  })
  assertEquals(inserts, [])
  assertEquals(deletes, [])
})

test('reconcileHostingsFromCompose skips non-mapping services and services without hosting', async () => {
  const { db, inserts } = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      skip: 'not-a-mapping',
      api: { image: 'node:22' },
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected create to succeed')
  assertEquals(result.created, ['new-host-1'])
  assertEquals(inserts.length, 1)
  assertEquals(inserts[0]?.name, HOSTNAME)
  assertEquals(inserts[0]?.serviceId, SVC_WEB)
})

test('reconcileHostingsFromCompose creates a row and pins TLS/IP by id or label', async () => {
  const { db, inserts } = createReconcileDb({
    tlsRows: [
      { id: 'tls-1', label: 'prod-cert' },
      { id: 'tls-2', label: 'prod-cert' },
    ],
    ipRows: [{ id: 'ip-1', label: '203.0.113.10' }],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{
        hostname: HOSTNAME,
        pathPrefix: '/app',
        targetPort: 8080,
        forceHttps: true,
        tls: { mode: 'certificate', certificateRef: 'tls-1' },
        bind: { scope: 'public', ipRef: '203.0.113.10' },
      }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected create with pins to succeed')
  assertEquals(result.created, ['new-host-1'])
  assertEquals(inserts[0]?.tlsId, 'tls-1')
  assertEquals(inserts[0]?.ipId, 'ip-1')
  const options = inserts[0]?.options as Record<string, unknown>
  assertEquals(options.hostnames, [HOSTNAME])
  assertEquals(options.pathPrefix, '/app')
  assertEquals(options.targetPort, 8080)
  assertEquals((options.proxy as { forceHttps?: boolean })?.forceHttps, true)
})

test('reconcileHostingsFromCompose drops targetPort on site services', async () => {
  const { db, inserts } = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{
        hostname: HOSTNAME,
        targetPort: 8080,
      }], { serviceKind: 'site' }),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected site create to succeed')
  const options = inserts[0]?.options as Record<string, unknown>
  assertEquals('targetPort' in options, false)
})

test('reconcileHostingsFromCompose updates an existing compose-owned row', async () => {
  const existingId = 'host-existing'
  const { db, inserts, updates } = createReconcileDb({
    hostingRows: [{
      id: existingId,
      serviceId: SVC_WEB,
      metadata: composeOwnedMetadata('web', ROUTE),
      options: { hostnames: [HOSTNAME], web: { env: { KEEP: '1' } } },
    }],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME, forceHttps: false }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected update to succeed')
  assertEquals(result.updated, [existingId])
  assertEquals(result.created, [])
  assertEquals(inserts, [])
  assertEquals(updates.length, 1)
  const options = updates[0]?.values.options as Record<string, unknown>
  assertEquals((options.web as { env?: Record<string, string> })?.env, {
    KEEP: '1',
  })
  assertEquals((options.proxy as { forceHttps?: boolean })?.forceHttps, false)
})

test('reconcileHostingsFromCompose adopts a matching panel-authored row', async () => {
  const panelId = 'host-panel'
  const { db, updates } = createReconcileDb({
    hostingRows: [{
      id: panelId,
      serviceId: SVC_WEB,
      metadata: { note: 'panel' },
      options: { hostnames: [HOSTNAME], pathPrefix: '/' },
    }],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected adopt to succeed')
  assertEquals(result.adopted, [panelId])
  assertEquals(result.updated, [])
  const metadata = updates[0]?.values.metadata as Record<string, unknown>
  assertEquals(metadata.composeOwned, true)
  assertEquals(metadata.composeAdopted, true)
  assertEquals(metadata.note, 'panel')
})

test('reconcileHostingsFromCompose reports a multi-hostname panel conflict', async () => {
  const { db } = createReconcileDb({
    hostingRows: [{
      id: 'host-multi',
      serviceId: SVC_WEB,
      metadata: {},
      options: {
        hostnames: [HOSTNAME, 'www.example.com'],
        pathPrefix: '/',
      },
    }],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  assertEquals(result, {
    ok: false,
    error: {
      kind: 'hosting_route_conflict',
      composeServiceName: 'web',
      hostname: HOSTNAME,
      pathPrefix: '/',
      hostingId: 'host-multi',
      otherHostnames: ['www.example.com'],
    },
  })
})

test('reconcileHostingsFromCompose ignores tcp panel rows and other services', async () => {
  const { db, inserts } = createReconcileDb({
    hostingRows: [
      {
        id: 'host-tcp',
        serviceId: SVC_WEB,
        metadata: {},
        options: { hostnames: [HOSTNAME], protocol: 'tcp' },
      },
      {
        id: 'host-other',
        serviceId: 'svc-other',
        metadata: {},
        options: { hostnames: [HOSTNAME], pathPrefix: '/' },
      },
      {
        id: 'host-path',
        serviceId: SVC_WEB,
        metadata: {},
        options: { hostnames: [HOSTNAME], pathPrefix: '/other' },
      },
    ],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected create after ignored panel rows')
  assertEquals(result.created, ['new-host-1'])
  assertEquals(inserts.length, 1)
})

test('reconcileHostingsFromCompose refuses automatic TLS mode', async () => {
  const { db } = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{
        hostname: HOSTNAME,
        tls: { mode: 'automatic' },
      }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  assertEquals(result.ok, false)
  if (result.ok) throw new TypeError('expected automatic TLS refusal')
  assertEquals(result.error.kind, 'hosting_tls_mode_unsupported')
  if (result.error.kind !== 'hosting_tls_mode_unsupported') {
    throw new TypeError('expected tls mode error')
  }
  assertEquals(result.error.mode, 'automatic')
  assertEquals(result.error.hostname, HOSTNAME)
})

test('reconcileHostingsFromCompose reports unresolved and ambiguous TLS refs', async () => {
  const missing = await reconcileHostingsFromCompose(createReconcileDb({
    tlsRows: [{ id: 'tls-1', label: 'other' }],
  }).db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{
        hostname: HOSTNAME,
        tls: { mode: 'certificate', certificateRef: 'missing-cert' },
      }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  assertEquals(missing, {
    ok: false,
    error: {
      kind: 'hosting_tls_ref_unresolved',
      composeServiceName: 'web',
      hostname: HOSTNAME,
      ref: 'missing-cert',
      reason: 'not_found',
    },
  })

  const ambiguous = await reconcileHostingsFromCompose(createReconcileDb({
    tlsRows: [
      { id: 'tls-a', label: 'shared' },
      { id: 'tls-b', label: 'shared' },
    ],
  }).db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{
        hostname: HOSTNAME,
        tls: { mode: 'certificate', certificateRef: 'shared' },
      }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  assertEquals(ambiguous.ok, false)
  if (ambiguous.ok) throw new TypeError('expected ambiguous TLS ref')
  assertEquals(ambiguous.error, {
    kind: 'hosting_tls_ref_unresolved',
    composeServiceName: 'web',
    hostname: HOSTNAME,
    ref: 'shared',
    reason: 'ambiguous',
  })
})

test('reconcileHostingsFromCompose reports unresolved IP refs', async () => {
  const result = await reconcileHostingsFromCompose(createReconcileDb({
    ipRows: [{ id: 'ip-1', label: '203.0.113.10' }],
  }).db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{
        hostname: HOSTNAME,
        bind: { scope: 'public', ipRef: '198.51.100.10' },
      }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  assertEquals(result, {
    ok: false,
    error: {
      kind: 'hosting_ip_ref_unresolved',
      composeServiceName: 'web',
      hostname: HOSTNAME,
      ref: '198.51.100.10',
      reason: 'not_found',
    },
  })
})

test('reconcileHostingsFromCompose skips a declaration whose service row is missing', async () => {
  const { db, inserts } = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      ghost: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [],
  })
  if (!result.ok) throw new TypeError('expected skip-missing-service to succeed')
  assertEquals(result.created, [])
  assertEquals(inserts, [])
})

test('reconcileHostingsFromCompose deletes orphaned compose-owned rows', async () => {
  const { db, deletes } = createReconcileDb({
    hostingRows: [{
      id: 'host-orphan',
      serviceId: SVC_WEB,
      metadata: composeOwnedMetadata('web', 'gone.example.com /'),
      options: { hostnames: ['gone.example.com'] },
    }],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({ web: { image: 'nginx:alpine' } }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected prune to succeed')
  assertEquals(result.removed, ['host-orphan'])
  assertEquals(result.released, [])
  assertEquals(deletes.length, 1)
})

test('reconcileHostingsFromCompose releases adopted rows when the declaration disappears', async () => {
  const { db, updates, deletes } = createReconcileDb({
    hostingRows: [{
      id: 'host-adopted',
      serviceId: SVC_WEB,
      metadata: composeOwnedMetadata('web', 'old.example.com /', true),
      options: { hostnames: ['old.example.com'] },
    }],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({ web: { image: 'nginx:alpine' } }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected release to succeed')
  assertEquals(result.released, ['host-adopted'])
  assertEquals(result.removed, [])
  assertEquals(deletes, [])
  assertEquals(updates.length, 1)
  const metadata = updates[0]?.values.metadata as Record<string, unknown>
  assertEquals(metadata.composeOwned, undefined)
  assertEquals(metadata.composeAdopted, undefined)
})

test('reconcileHostingsFromCompose ignores compose-owned rows without a route key', async () => {
  const { db, inserts } = createReconcileDb({
    hostingRows: [{
      id: 'host-unkeyed',
      serviceId: SVC_WEB,
      metadata: { composeOwned: true },
      options: { hostnames: [HOSTNAME] },
    }],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected create when existing row has no route')
  assertEquals(result.created, ['new-host-1'])
  assertEquals(inserts.length, 1)
  assertEquals(
    typeof (inserts[0]?.metadata as Record<string, unknown>)[
      HOSTING_COMPOSE_ROUTE_METADATA_KEY
    ],
    'string',
  )
})
