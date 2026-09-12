import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  type EndpointAddressCaches,
  FabricAllocationError,
  type RelayRecord,
} from '../../lib/db/fabric-records.ts'
import {
  bindSecretEncryptFn,
  enqueueRelayPatchReconcile,
  fabricEnableErrorResponse,
  fabricNotEnabledErrorResponse,
  fabricSettingsResponse,
  fabricTypedEnqueueErrorResponse,
  findByServerId,
  gatewayRelayReadyErrorResponse,
  gatewayRolePatchErrorResponse,
  preferredGatewayInvalidErrorResponse,
  preferredGatewayIdsErrorResponse,
  preferredGatewayPatchErrorResponse,
  observedForRelay,
  parseFabricPutBody,
  parseRelayPatchBody,
  relayPatchUpdateFields,
  resolveRelayEndpointOrNull,
  resolveSealedRelayPresharedKey,
  toFabricRelayApiRow,
} from './fabric-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WG_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

test('parseFabricPutBody requires a boolean enabled flag', () => {
  assertEquals(parseFabricPutBody({ enabled: true }), {
    ok: true,
    enabled: true,
  })
  assertEquals(parseFabricPutBody({ enabled: false }), {
    ok: true,
    enabled: false,
  })
  assertEquals(parseFabricPutBody({ enabled: true, allowRelay: true }), {
    ok: true,
    enabled: true,
    allowRelay: true,
  })
  assertEquals(parseFabricPutBody({ enabled: true, allowRelay: false }), {
    ok: true,
    enabled: true,
    allowRelay: false,
  })
  assertEquals(parseFabricPutBody({ enabled: true, allowRelay: 'yes' }), {
    ok: false,
    error: 'Invalid allowRelay',
  })
  assertEquals(parseFabricPutBody({}), { ok: false, error: 'Invalid request' })
  assertEquals(parseFabricPutBody(null), {
    ok: false,
    error: 'Invalid request',
  })
})

test('parseRelayPatchBody validates role, CIDRs, keepalive, endpoint, and PSK', () => {
  assertEquals(parseRelayPatchBody({ role: 'gateway' }).ok, true)
  assertEquals(parseRelayPatchBody({ role: 'router' }).ok, false)
  assertEquals(
    parseRelayPatchBody({ advertisedCidrs: ['10.0.0.0/24'] }).ok,
    true,
  )
  assertEquals(
    parseRelayPatchBody({ advertisedCidrs: ['not-cidr'] }).ok,
    false,
  )
  assertEquals(parseRelayPatchBody({ keepalive: 25 }).ok, true)
  assertEquals(parseRelayPatchBody({ keepalive: 0 }).ok, false)
  assertEquals(parseRelayPatchBody({ keepalive: null }).ok, true)
  assertEquals(
    parseRelayPatchBody({ endpointAddress: '203.0.113.10' }).ok,
    true,
  )
  assertEquals(parseRelayPatchBody({ endpointAddress: 'not-an-ip' }).ok, false)
  assertEquals(parseRelayPatchBody({ endpointAddress: null }).ok, true)
  assertEquals(parseRelayPatchBody({ presharedKey: WG_KEY }).ok, true)
  assertEquals(parseRelayPatchBody({ presharedKey: 'short' }).ok, false)
  assertEquals(parseRelayPatchBody({ presharedKey: null }).ok, true)
  const inherit = parseRelayPatchBody({ allowRelay: null })
  assertEquals(inherit.ok, true)
  if (inherit.ok) assertEquals(inherit.patch.allowRelay, null)
  const tighten = parseRelayPatchBody({ allowRelay: false })
  assertEquals(tighten.ok, true)
  if (tighten.ok) assertEquals(tighten.patch.allowRelay, false)
  const preferred = parseRelayPatchBody({
    preferredGatewayIds: [
      '00000000-0000-4000-8000-00000000000a',
      '00000000-0000-4000-8000-00000000000a',
    ],
  })
  assertEquals(preferred.ok, true)
  if (preferred.ok) {
    assertEquals(preferred.patch.preferredGatewayIds, [
      '00000000-0000-4000-8000-00000000000a',
    ])
  }
  assertEquals(
    parseRelayPatchBody({ preferredGatewayIds: ['not-a-uuid'] }),
    { ok: false, error: 'Invalid preferredGatewayIds' },
  )
  assertEquals(
    parseRelayPatchBody({ allowRelay: 'yes' }),
    { ok: false, error: 'Invalid allowRelay' },
  )
})

test('parseRelayPatchBody forces advertisedCidrs empty for member role', () => {
  const parsed = parseRelayPatchBody({
    role: 'member',
    advertisedCidrs: ['10.0.0.0/24'],
  })
  assertEquals(parsed.ok, true)
  if (!parsed.ok) return
  assertEquals(parsed.patch.advertisedCidrs, [])
})

test('parseRelayPatchBody rejects non-objects and oversized advertisedCidrs', () => {
  assertEquals(parseRelayPatchBody(null), { ok: false, error: 'Invalid request' })
  assertEquals(parseRelayPatchBody([]), { ok: false, error: 'Invalid request' })
  assertEquals(
    parseRelayPatchBody({
      advertisedCidrs: Array.from({ length: 33 }, (_, i) => `10.${i}.0.0/24`),
    }).ok,
    false,
  )
  assertEquals(parseRelayPatchBody({ keepalive: 65_536 }).ok, false)
})

test('fabricSettingsResponse omits fabric when TurboFabric is off', () => {
  assertEquals(fabricSettingsResponse(null), { enabled: false, relays: [] })
  assertEquals(
    fabricSettingsResponse({
      id: 'fab-1',
      organizationId: 'org-1',
      cidr: '10.250.0.0/16',
      options: null,
    }),
    {
      enabled: true,
      fabric: {
        id: 'fab-1',
        cidr: '10.250.0.0/16',
        mtu: 1420,
        allowRelay: false,
        containerPool: '10.192.0.0/12',
      },
      relays: [],
    },
  )
})

test('parseFabricPutBody accepts an IPv4 containerPool wide enough for a relay /16', () => {
  assertEquals(parseFabricPutBody({ enabled: true, containerPool: ' 10.64.0.0/10 ' }), {
    ok: true,
    enabled: true,
    containerPool: '10.64.0.0/10',
  })
  assertEquals(parseFabricPutBody({ enabled: true, containerPool: '10.64.0.0/16' }), {
    ok: true,
    enabled: true,
    containerPool: '10.64.0.0/16',
  })
  // Too narrow for one relay aggregate, IPv6, or not a CIDR at all.
  for (const containerPool of ['10.64.0.0/17', 'fd00::/48', '10.64.0.0', 12]) {
    assertEquals(parseFabricPutBody({ enabled: true, containerPool }), {
      ok: false,
      error: 'Invalid containerPool',
    })
  }
})

test('fabricSettingsResponse includes relay rows without presharedKey', () => {
  const relays = [
    {
      serverId: 'srv-1',
      address: '10.250.0.1',
      role: 'member' as const,
      advertisedCidrs: [],
      resolvedAdvertisedCidrs: [],
      keepalive: null,
      endpointAddress: null,
      resolvedEndpoint: '203.0.113.10',
      publicKey: WG_KEY,
      prefix: '10.192.0.0/16',
      hasPresharedKey: true,
      segments: [],
      observed: null,
      allowRelay: null,
      effectiveAllowRelay: false,
      preferredGatewayIds: [],
      gatewayEligible: false,
      paths: [],
    },
    {
      serverId: 'srv-2',
      address: '10.250.0.2',
      role: 'member' as const,
      advertisedCidrs: [],
      resolvedAdvertisedCidrs: [],
      keepalive: 25,
      endpointAddress: '203.0.113.11',
      resolvedEndpoint: '203.0.113.11',
      publicKey: null,
      prefix: '10.193.0.0/16',
      hasPresharedKey: false,
      segments: [],
      observed: null,
      allowRelay: null,
      effectiveAllowRelay: false,
      preferredGatewayIds: [],
      gatewayEligible: false,
      paths: [],
    },
  ]
  const body = fabricSettingsResponse(
    {
      id: 'fab-1',
      organizationId: 'org-1',
      cidr: '10.250.0.0/16',
      options: { mtu: 1420, allowRelay: true },
    },
    relays,
  )
  assertEquals(body.relays.length, 2)
  assertEquals(body.fabric?.allowRelay, true)
  assertEquals(body.relays[0]?.hasPresharedKey, true)
  assertEquals(body.relays[1]?.hasPresharedKey, false)
  assertEquals('presharedKey' in body.relays[0]!, false)
})

test('relayPatchUpdateFields copies only provided patch keys', () => {
  assertEquals(relayPatchUpdateFields({}, undefined), {})
  assertEquals(
    relayPatchUpdateFields(
      {
        role: 'gateway',
        advertisedCidrs: ['10.0.0.0/24'],
        keepalive: 25,
        endpointAddress: '203.0.113.10',
      },
      'sealed',
    ),
    {
      role: 'gateway',
      advertisedCidrs: ['10.0.0.0/24'],
      keepalive: 25,
      endpointAddress: '203.0.113.10',
      presharedKey: 'sealed',
    },
  )
  assertEquals(
    relayPatchUpdateFields(
      {
        allowRelay: false,
        preferredGatewayIds: ['00000000-0000-4000-8000-00000000000a'],
      },
      undefined,
    ),
    {
      allowRelay: false,
      preferredGatewayIds: ['00000000-0000-4000-8000-00000000000a'],
    },
  )
  assertEquals(
    relayPatchUpdateFields({ keepalive: null, endpointAddress: null }, null),
    { keepalive: null, endpointAddress: null, presharedKey: null },
  )
})

test('resolveSealedRelayPresharedKey omits, clears, or seals', async () => {
  const encrypt = (plaintext: string) => Promise.resolve(`sealed:${plaintext}`)
  assertEquals(
    await resolveSealedRelayPresharedKey(undefined, encrypt),
    undefined,
  )
  assertEquals(await resolveSealedRelayPresharedKey(null, encrypt), null)
  assertEquals(
    await resolveSealedRelayPresharedKey('psk', encrypt),
    'sealed:psk',
  )
  assertEquals(await resolveSealedRelayPresharedKey('psk', null), undefined)
})

test('gatewayRelayReadyErrorResponse maps gateway kinds to 422', async () => {
  assertEquals(gatewayRelayReadyErrorResponse(null), null)
  const required = gatewayRelayReadyErrorResponse({
    kind: 'gateway_datacenter_required',
    serverId: 'srv-1',
  })
  assertEquals(required?.status, 422)
  assertEquals(await required?.json(), {
    error: 'gateway_datacenter_required',
  })
  const cidr = gatewayRelayReadyErrorResponse({
    kind: 'gateway_datacenter_cidr_required',
    datacenterId: 'dc-1',
  })
  assertEquals(cidr?.status, 422)
  assertEquals(await cidr?.json(), {
    error: 'gateway_datacenter_cidr_required',
  })
})

test('gatewayRolePatchErrorResponse ignores non-gateway roles', async () => {
  assertEquals(
    gatewayRolePatchErrorResponse('member', {
      kind: 'gateway_datacenter_required',
      serverId: 'srv-1',
    }),
    null,
  )
  assertEquals(gatewayRolePatchErrorResponse('gateway', null), null)
  const denied = gatewayRolePatchErrorResponse('gateway', {
    kind: 'gateway_datacenter_required',
    serverId: 'srv-1',
  })
  assertEquals(denied?.status, 422)
  assertEquals(await denied?.json(), { error: 'gateway_datacenter_required' })
})

test('preferredGatewayIdsErrorResponse is 422 unless every id is a fabric gateway', async () => {
  const gwId = '00000000-0000-4000-8000-00000000000a'
  const memberId = '00000000-0000-4000-8000-00000000000b'
  const relays = [
    relayRow({ serverId: gwId, role: 'gateway' }),
    relayRow({ serverId: memberId, role: 'member' }),
  ]
  assertEquals(
    preferredGatewayIdsErrorResponse([], relays, memberId, undefined),
    null,
  )
  assertEquals(
    preferredGatewayIdsErrorResponse([gwId], relays, memberId, undefined),
    null,
  )
  const invalid = preferredGatewayIdsErrorResponse(
    [memberId],
    relays,
    gwId,
    undefined,
  )
  assertEquals(invalid?.status, 422)
  assertEquals(await invalid?.json(), { error: 'preferred_gateway_invalid' })
  const promoting = preferredGatewayIdsErrorResponse(
    [memberId],
    relays,
    memberId,
    'gateway',
  )
  assertEquals(promoting, null)
  const standalone = preferredGatewayInvalidErrorResponse()
  assertEquals(standalone.status, 422)
  assertEquals(await standalone.json(), { error: 'preferred_gateway_invalid' })
})

test('findByServerId returns the matching row or undefined', () => {
  const rows = [{ serverId: 'a' }, { serverId: 'b' }]
  assertEquals(findByServerId(rows, 'b'), rows[1])
  assertEquals(findByServerId(rows, 'missing'), undefined)
})

test('preferredGatewayPatchErrorResponse skips when preferredGatewayIds is absent', () => {
  const relays = [relayRow({ serverId: 'gw', role: 'gateway' })]
  assertEquals(
    preferredGatewayPatchErrorResponse({}, relays, 'gw'),
    null,
  )
})

test('preferredGatewayPatchErrorResponse is 422 for a non-gateway id', async () => {
  const gwId = '00000000-0000-4000-8000-00000000000a'
  const memberId = '00000000-0000-4000-8000-00000000000b'
  const relays = [
    relayRow({ serverId: gwId, role: 'gateway' }),
    relayRow({ serverId: memberId, role: 'member' }),
  ]
  const denied = preferredGatewayPatchErrorResponse(
    { preferredGatewayIds: [memberId] },
    relays,
    gwId,
  )
  assertEquals(denied?.status, 422)
  assertEquals(await denied?.json(), { error: 'preferred_gateway_invalid' })
  assertEquals(
    preferredGatewayPatchErrorResponse(
      { preferredGatewayIds: [gwId] },
      relays,
      memberId,
    ),
    null,
  )
})

test('bindSecretEncryptFn returns null without secrets and binds encrypt otherwise', async () => {
  assertEquals(
    bindSecretEncryptFn(undefined, (secrets, plaintext) =>
      Promise.resolve(`${secrets}:${plaintext}`),
    ),
    null,
  )
  const encrypt = bindSecretEncryptFn('key', (secrets, plaintext) =>
    Promise.resolve(`${secrets}:${plaintext}`),
  )
  assertEquals(await encrypt?.('psk'), 'key:psk')
})

test('fabricTypedEnqueueErrorResponse maps typed failures to 422', async () => {
  assertEquals(
    fabricTypedEnqueueErrorResponse([{ serverId: 's1', status: 'queued' }]),
    null,
  )
  const denied = fabricTypedEnqueueErrorResponse([
    { serverId: 's1', status: 'failed', error: 'relay_missing' },
  ])
  assertEquals(denied?.status, 422)
  assertEquals(await denied?.json(), { error: 'relay_missing' })
})

test('enqueueRelayPatchReconcile skips when queue or session is missing', async () => {
  const db = {} as Db
  const commandQueue: CommandQueue = { enqueue: () => Promise.resolve() }
  let called = 0
  const reconcile = () => {
    called += 1
    return Promise.resolve([])
  }
  assertEquals(
    await enqueueRelayPatchReconcile({
      session: { userId: 'u1' },
      commandQueue: Response.json({ error: 'unavailable' }, { status: 503 }),
      db,
      organizationId: 'org-1',
      secrets: {},
      reconcile,
    }),
    null,
  )
  assertEquals(
    await enqueueRelayPatchReconcile({
      session: null,
      commandQueue,
      db,
      organizationId: 'org-1',
      secrets: {},
      reconcile,
    }),
    null,
  )
  assertEquals(called, 0)
})

test('enqueueRelayPatchReconcile returns 422 on typed enqueue errors', async () => {
  const denied = await enqueueRelayPatchReconcile({
    session: { userId: 'u1' },
    commandQueue: { enqueue: () => Promise.resolve() },
    db: {} as Db,
    organizationId: 'org-1',
    secrets: {},
    reconcile: () =>
      Promise.resolve([{
        serverId: 's1',
        status: 'failed',
        error: 'relay_missing',
      }]),
  })
  assertEquals(denied?.status, 422)
  assertEquals(await denied?.json(), { error: 'relay_missing' })
})

test('enqueueRelayPatchReconcile returns null when membership enqueue succeeds', async () => {
  assertEquals(
    await enqueueRelayPatchReconcile({
      session: { userId: 'u1' },
      commandQueue: { enqueue: () => Promise.resolve() },
      db: {} as Db,
      organizationId: 'org-1',
      secrets: {},
      reconcile: () =>
        Promise.resolve([{ serverId: 's1', status: 'queued', commandId: 'c1' }]),
    }),
    null,
  )
})

test('fabricEnableErrorResponse maps CIDR and pool exhaustion to 409', async () => {
  const cidr = fabricEnableErrorResponse(new Error('No free CIDR left in pool'))
  assertEquals(cidr.status, 409)
  assertEquals(await cidr.json(), { error: 'fabric_cidr_unavailable' })

  const pool = fabricEnableErrorResponse(new Error('address pool exhausted'))
  assertEquals(pool.status, 409)
  assertEquals(await pool.json(), { error: 'fabric_address_pool_exhausted' })

  const other = fabricEnableErrorResponse('boom')
  assertEquals(other.status, 500)
  assertEquals(await other.json(), { error: 'TurboFabric update failed' })

  // Typed allocation failures report their own kind — a container pool too
  // small for the org's relays is a prefix, not host-address, exhaustion.
  const prefix = fabricEnableErrorResponse(
    new FabricAllocationError('fabric_prefix_pool_exhausted'),
  )
  assertEquals(prefix.status, 409)
  assertEquals(await prefix.json(), { error: 'fabric_prefix_pool_exhausted' })
})

test('fabricNotEnabledErrorResponse returns stable 409', async () => {
  const res = fabricNotEnabledErrorResponse()
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'TurboFabric is not enabled' })
})

function relayRow(
  overrides: Partial<RelayRecord> & Pick<RelayRecord, 'serverId'>,
): RelayRecord {
  return {
    id: 'relay-1',
    fabricId: 'fab-1',
    address: '10.250.0.1',
    role: 'member',
    keepalive: null,
    endpointAddress: null,
    publicKey: WG_KEY,
    prefix: '10.192.0.0/16',
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
    ...overrides,
  }
}

function emptyEndpointCaches(): EndpointAddressCaches {
  return {
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
    datacenterMembershipsByServer: new Map(),
    policyByDatacenter: new Map(),
    natEndpointByPair: new Map(),
    failedPathKindsByPair: new Map(),
  }
}

test('observedForRelay returns null without a public key', () => {
  assertEquals(observedForRelay([], null), null)
})

test('observedForRelay picks the newest peer observation by public key', () => {
  const otherKey = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
  const relays = [
    relayRow({
      serverId: 's1',
      publicKey: otherKey,
      metadata: {
        observed: {
          at: '2020-01-01T00:00:00.000Z',
          peers: [{
            publicKey: WG_KEY,
            lastHandshakeAt: '2020-01-01T00:01:00.000Z',
            transferRx: 10,
          }],
        },
      },
    }),
    relayRow({
      serverId: 's2',
      publicKey: WG_KEY,
      metadata: {
        observed: {
          at: '2020-01-02T00:00:00.000Z',
          peers: [{
            publicKey: WG_KEY,
            lastHandshakeAt: '2020-01-02T00:01:00.000Z',
            transferTx: 99,
          }],
        },
      },
    }),
  ]
  assertEquals(observedForRelay(relays, WG_KEY), {
    lastHandshakeAt: '2020-01-02T00:01:00.000Z',
    transferTx: 99,
  })
})

test('resolveRelayEndpointOrNull resolves pinned and public endpoints, else null', () => {
  const pinned = relayRow({
    serverId: 's1',
    endpointAddress: '203.0.113.10',
  })
  assertEquals(
    resolveRelayEndpointOrNull(pinned, emptyEndpointCaches()),
    '203.0.113.10',
  )

  const caches: EndpointAddressCaches = {
    ...emptyEndpointCaches(),
    publicAddressByServer: new Map([['s2', '203.0.113.11']]),
  }
  assertEquals(
    resolveRelayEndpointOrNull(relayRow({ serverId: 's2' }), caches),
    '203.0.113.11',
  )

  assertEquals(
    resolveRelayEndpointOrNull(relayRow({ serverId: 's3' }), emptyEndpointCaches()),
    null,
  )
})

test('resolveRelayEndpointOrNull ignores datacenter pins and private reported IPs', () => {
  // GET has no viewer/`self` pair, so a private LAN pin cannot be published as
  // a generic endpoint — callers in another datacenter cannot route it.
  const caches: EndpointAddressCaches = {
    ...emptyEndpointCaches(),
    publicAddressByServer: new Map([['s1', '203.0.113.20']]),
    datacenterMembershipsByServer: new Map([['s1', [{
      ipId: 'ip-s1',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-a',
      address: '10.0.0.8',
      family: 4,
    }]]]),
    reportedByServer: new Map([['s2', [
      { address: '10.1.0.9', version: 4, scope: 'private' },
    ]]]),
  }
  assertEquals(
    resolveRelayEndpointOrNull(relayRow({ serverId: 's1' }), caches),
    '203.0.113.20',
  )
  assertEquals(
    resolveRelayEndpointOrNull(relayRow({ serverId: 's2' }), caches),
    null,
  )
})

test('fabric GET does not surface a private datacenter endpoint across datacenters', () => {
  // Two relays in *different* datacenters, neither with an operator pin or a
  // public address. The reader of a fabric GET response has no way to know the
  // viewer's datacenter, so `resolvedEndpoint` must stay null; the pair-aware
  // LAN path belongs on `paths[]`.
  const relays = [
    relayRow({ serverId: 'srv-dc-a', address: '10.250.0.1' }),
    relayRow({ serverId: 'srv-dc-b', address: '10.250.0.2' }),
  ]
  const caches: EndpointAddressCaches = {
    ...emptyEndpointCaches(),
    reportedByServer: new Map([
      ['srv-dc-a', [{ address: '10.10.0.5', version: 4, scope: 'private' }]],
      ['srv-dc-b', [{ address: '10.20.0.5', version: 4, scope: 'private' }]],
    ]),
    datacenterMembershipsByServer: new Map([
      ['srv-dc-a', [{
        ipId: 'ip-a',
        serverId: 'srv-dc-a',
        datacenterId: 'dc-a',
        networkId: 'net-a',
        address: '10.10.0.5',
        family: 4,
      }]],
      ['srv-dc-b', [{
        ipId: 'ip-b',
        serverId: 'srv-dc-b',
        datacenterId: 'dc-b',
        networkId: 'net-b',
        address: '10.20.0.5',
        family: 4,
      }]],
    ]),
  }

  const body = fabricSettingsResponse(
    {
      id: 'fab-1',
      organizationId: 'org-1',
      cidr: '10.250.0.0/16',
      options: { mtu: 1420, allowRelay: false },
    },
    relays.map((relay) =>
      toFabricRelayApiRow({
        relay,
        hasPresharedKey: false,
        segments: [],
        caches,
        relays,
        resolvedAdvertisedCidrs: [],
      })
    ),
  )

  assertEquals(body.relays.map((row) => row.resolvedEndpoint), [null, null])
  for (const row of body.relays) {
    assertEquals(row.resolvedEndpoint === '10.10.0.5', false)
    assertEquals(row.resolvedEndpoint === '10.20.0.5', false)
  }
})

test('toFabricRelayApiRow maps relay fields and omits presharedKey on the wire', () => {
  const relay = relayRow({
    serverId: 'srv-1',
    role: 'gateway',
    advertisedCidrs: ['10.0.0.0/24'],
    keepalive: 25,
    endpointAddress: '203.0.113.10',
    metadata: {
      observed: {
        at: '2020-01-01T00:00:00.000Z',
        peers: [{
          publicKey: WG_KEY,
          lastHandshakeAt: '2020-01-01T00:05:00.000Z',
        }],
      },
    },
  })
  const caches: EndpointAddressCaches = {
    ...emptyEndpointCaches(),
    publicAddressByServer: new Map([['srv-1', '198.51.100.10']]),
  }
  const row = toFabricRelayApiRow({
    relay,
    hasPresharedKey: true,
    segments: [{ name: 'tpn_test', subnet: '10.192.0.0/24' }],
    caches,
    relays: [relay],
    resolvedAdvertisedCidrs: ['10.0.0.0/24'],
  })
  assertEquals(row.serverId, 'srv-1')
  assertEquals(row.role, 'gateway')
  assertEquals(row.advertisedCidrs, ['10.0.0.0/24'])
  assertEquals(row.resolvedAdvertisedCidrs, ['10.0.0.0/24'])
  assertEquals(row.resolvedEndpoint, '203.0.113.10')
  assertEquals(row.hasPresharedKey, true)
  assertEquals(row.observed?.lastHandshakeAt, '2020-01-01T00:05:00.000Z')
  assertEquals(row.allowRelay, null)
  assertEquals(row.effectiveAllowRelay, false)
  assertEquals(row.preferredGatewayIds, [])
  assertEquals(row.gatewayEligible, true)
  assertEquals(row.paths, [])
  assertEquals('presharedKey' in row, false)
})

test('toFabricRelayApiRow maps path summaries from relay metadata', () => {
  const relay = relayRow({
    serverId: 'srv-1',
    metadata: {
      paths: {
        at: '2020-01-01T00:00:00.000Z',
        entries: [{
          peerServerId: 'srv-2',
          selected: 'gateway',
          viaServerId: 'srv-gw',
          lastHandshakeAt: '2020-01-01T00:05:00.000Z',
          latencyMs: 44,
          degraded: false,
        }],
      },
    },
  })
  const row = toFabricRelayApiRow({
    relay,
    hasPresharedKey: false,
    segments: [],
    caches: emptyEndpointCaches(),
    relays: [relay],
    resolvedAdvertisedCidrs: [],
  })
  assertEquals(row.paths, [{
    peerServerId: 'srv-2',
    selected: 'gateway',
    viaServerId: 'srv-gw',
    lastHandshakeAt: '2020-01-01T00:05:00.000Z',
    latencyMs: 44,
    degraded: false,
  }])
})

test('toFabricRelayApiRow computes effectiveAllowRelay from org and relay policy', () => {
  const relay = relayRow({
    serverId: 'srv-1',
    allowRelay: false,
    preferredGatewayIds: ['00000000-0000-4000-8000-00000000000a'],
  })
  const tightened = toFabricRelayApiRow({
    relay,
    hasPresharedKey: false,
    segments: [],
    caches: emptyEndpointCaches(),
    relays: [relay],
    resolvedAdvertisedCidrs: [],
    orgAllowRelay: true,
  })
  assertEquals(tightened.allowRelay, false)
  assertEquals(tightened.effectiveAllowRelay, false)
  assertEquals(tightened.preferredGatewayIds, [
    '00000000-0000-4000-8000-00000000000a',
  ])
  const inherited = toFabricRelayApiRow({
    relay: relayRow({ serverId: 'srv-1', role: 'member' }),
    hasPresharedKey: false,
    segments: [],
    caches: emptyEndpointCaches(),
    relays: [relay],
    resolvedAdvertisedCidrs: [],
    orgAllowRelay: true,
  })
  assertEquals(inherited.allowRelay, null)
  assertEquals(inherited.effectiveAllowRelay, true)
  assertEquals(inherited.gatewayEligible, false)
})

test('toFabricRelayApiRow emits derived resolvedAdvertisedCidrs when stored list is empty', () => {
  const relay = relayRow({
    serverId: 'srv-1',
    role: 'gateway',
    advertisedCidrs: [],
  })
  const row = toFabricRelayApiRow({
    relay,
    hasPresharedKey: false,
    segments: [],
    caches: emptyEndpointCaches(),
    relays: [relay],
    resolvedAdvertisedCidrs: ['198.51.100.0/24', '203.0.113.0/24'],
  })
  assertEquals(row.advertisedCidrs, [])
  assertEquals(row.resolvedAdvertisedCidrs, [
    '198.51.100.0/24',
    '203.0.113.0/24',
  ])
  assertEquals('presharedKey' in row, false)
})
