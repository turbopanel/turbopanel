import { assertEquals } from '@std/assert'
import {
  attachEffectivePolicy,
  attachPrivateCidrs,
  groupMembersByDerivedCidr,
  mergeDatacenterMetadata,
  parseMemberPins,
  parseNameSuggestionsQuery,
  parseOptionalUuid,
  parseRequiredCidr,
  resolveOrCreateSubnetForAddress,
  resolveSeededFields,
} from './create-input.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mergeDatacenterMetadata prefers request metadata over seeded defaults', () => {
  assertEquals(
    mergeDatacenterMetadata({ geo: { city: 'Amsterdam' } }, { note: 'ops' }),
    { geo: { city: 'Amsterdam' }, note: 'ops' },
  )
  assertEquals(
    mergeDatacenterMetadata({ geo: { city: 'Amsterdam' } }, null),
    { geo: { city: 'Amsterdam' } },
  )
  assertEquals(mergeDatacenterMetadata(null, { note: 'ops' }), { note: 'ops' })
})

test('parseMemberPins validates UUID + address pairs and rejects duplicates', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000'
  const otherId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

  assertEquals(
    parseMemberPins([
      { serverId: validId, address: '10.0.0.10' },
      { serverId: otherId, address: '10.0.0.11' },
    ]),
    {
      ok: true,
      value: [
        { serverId: validId, address: '10.0.0.10' },
        { serverId: otherId, address: '10.0.0.11' },
      ],
    },
  )
  assertEquals(parseMemberPins(undefined), { ok: false })
  assertEquals(parseMemberPins([]), { ok: false })
  assertEquals(parseMemberPins([[]]), { ok: false })
  assertEquals(parseMemberPins([{ serverId: 'not-a-uuid', address: '10.0.0.1' }]), {
    ok: false,
  })
  assertEquals(
    parseMemberPins([
      { serverId: validId, address: '10.0.0.10' },
      { serverId: validId, address: '10.0.0.11' },
    ]),
    {
      ok: true,
      value: [
        { serverId: validId, address: '10.0.0.10' },
        { serverId: validId, address: '10.0.0.11' },
      ],
    },
  )
  assertEquals(
    parseMemberPins([
      { serverId: validId, address: '10.0.0.10' },
      { serverId: otherId, address: '10.0.0.10' },
    ]),
    { ok: false },
  )
  assertEquals(
    parseMemberPins([
      { serverId: validId, address: '10.0.0.10' },
      { serverId: validId, address: '10.0.0.10' },
    ]),
    { ok: false },
  )
  assertEquals(
    parseMemberPins(Array.from({ length: 65 }, (_, i) => ({
      serverId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`,
      address: `10.${String(Math.floor(i / 256))}.${String(Math.floor((i % 256) / 256))}.${String(i % 256)}`,
    }))),
    { ok: false },
  )
})

test('parseRequiredCidr accepts valid CIDRs only', () => {
  assertEquals(parseRequiredCidr('10.0.0.0/24'), { ok: true, value: '10.0.0.0/24' })
  assertEquals(parseRequiredCidr(' 10.0.0.0/24 '), { ok: true, value: '10.0.0.0/24' })
  assertEquals(parseRequiredCidr('not-a-cidr'), { ok: false })
  assertEquals(parseRequiredCidr(undefined), { ok: false })
})

test('resolveSeededFields fills name and metadata from source server geo', () => {
  const seeded = resolveSeededFields(
    {
      name: null,
      description: null,
      metadata: { operatorNote: 'edge' },
      options: null,
      sourceServerId: 'server-a',
      members: [{ serverId: 'server-a', address: '10.0.0.10' }],
    },
    [{
      id: 'server-a',
      metadata: {
        geo: {
          city: 'Amsterdam',
          country: 'NL',
          asn: 13335,
          asOrganization: 'Cloudflare',
        },
      },
    }],
  )

  assertEquals(seeded.name, 'Amsterdam NL - Cloudflare AS13335')
  assertEquals(seeded.metadata?.operatorNote, 'edge')
  assertEquals(
    (seeded.metadata as Record<string, unknown>).seededFromServerId,
    'server-a',
  )

  const passthrough = resolveSeededFields(
    {
      name: 'Custom DC',
      description: null,
      metadata: null,
      options: null,
      sourceServerId: null,
      members: [],
    },
    [],
  )
  assertEquals(passthrough.name, 'Custom DC')
  assertEquals(passthrough.metadata, null)

  const noGeo = resolveSeededFields(
    {
      name: 'Kept',
      description: null,
      metadata: { note: 'ops' },
      options: null,
      sourceServerId: 'server-b',
      members: [{ serverId: 'server-b', address: '203.0.113.10' }],
    },
    [{ id: 'server-b', metadata: {} }],
  )
  assertEquals(noGeo, { name: 'Kept', metadata: { note: 'ops' } })
})

test('parseOptionalUuid accepts null and valid UUIDs only', () => {
  const valid = '550e8400-e29b-41d4-a716-446655440000'
  assertEquals(parseOptionalUuid(undefined), { ok: true, value: null })
  assertEquals(parseOptionalUuid(valid), { ok: true, value: valid })
  assertEquals(parseOptionalUuid('not-a-uuid'), { ok: false })
})

test('attachPrivateCidrs joins datacenter network CIDR lists', () => {
  const rows = [{ id: 'dc-a', name: 'Site A' }]
  const cidrs = new Map([['dc-a', ['10.0.0.0/24', '10.0.1.0/24']]])
  assertEquals(attachPrivateCidrs(rows, cidrs), [{
    id: 'dc-a',
    name: 'Site A',
    privateCidrs: ['10.0.0.0/24', '10.0.1.0/24'],
  }])
  assertEquals(attachPrivateCidrs([{ id: 'dc-b' }], cidrs)[0].privateCidrs, [])
})

test('attachEffectivePolicy surfaces priority/trusted with defaults applied', () => {
  assertEquals(
    attachEffectivePolicy([
      { id: 'dc-a', options: null },
      { id: 'dc-b', options: { priority: 10, trusted: false } },
      { id: 'dc-c', options: { priority: 9999, trusted: 'nope' } },
    ]),
    [
      { id: 'dc-a', options: null, priority: 100, trusted: true },
      {
        id: 'dc-b',
        options: { priority: 10, trusted: false },
        priority: 10,
        trusted: false,
      },
      {
        id: 'dc-c',
        options: { priority: 9999, trusted: 'nope' },
        priority: 100,
        trusted: true,
      },
    ],
  )
})

test('parseNameSuggestionsQuery validates limit and unassignedOnly flag', () => {
  assertEquals(parseNameSuggestionsQuery(undefined, undefined), {
    unassignedOnly: true,
    limit: 8,
  })
  assertEquals(parseNameSuggestionsQuery('0', '16'), {
    unassignedOnly: false,
    limit: 16,
  })
  assertEquals(parseNameSuggestionsQuery(undefined, '-1'), 'invalid')
  assertEquals(parseNameSuggestionsQuery(undefined, '33'), 'invalid')
})

const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
const SERVER_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function privateIpMetadata(address: string, cidr: string) {
  return {
    ips: [{ address, version: 4, scope: 'private', cidr }],
  }
}

test('groupMembersByDerivedCidr collapses identical prefixes and fails closed', () => {
  const grouped = groupMembersByDerivedCidr(
    [
      { serverId: SERVER_A, address: '203.0.113.10' },
      { serverId: SERVER_B, address: '203.0.113.11' },
    ],
    [
      {
        id: SERVER_A,
        metadata: privateIpMetadata('203.0.113.10', '203.0.113.10/24'),
      },
      {
        id: SERVER_B,
        metadata: privateIpMetadata('203.0.113.11', '203.0.113.11/24'),
      },
    ],
  )
  assertEquals(grouped.ok, true)
  if (!grouped.ok) {
    throw new TypeError('expected grouped CIDRs')
  }
  assertEquals(grouped.groups.length, 1)
  assertEquals(grouped.groups[0]?.cidr, '203.0.113.0/24')
  assertEquals(grouped.groups[0]?.members.length, 2)

  const split = groupMembersByDerivedCidr(
    [
      { serverId: SERVER_A, address: '203.0.113.10' },
      { serverId: SERVER_B, address: '198.51.100.20' },
    ],
    [
      {
        id: SERVER_A,
        metadata: privateIpMetadata('203.0.113.10', '203.0.113.10/24'),
      },
      {
        id: SERVER_B,
        metadata: privateIpMetadata('198.51.100.20', '198.51.100.20/24'),
      },
    ],
  )
  assertEquals(split.ok, true)
  if (!split.ok) {
    throw new TypeError('expected split CIDRs')
  }
  assertEquals(split.groups.length, 2)

  assertEquals(
    groupMembersByDerivedCidr(
      [{ serverId: SERVER_A, address: '203.0.113.10' }],
      [],
    ),
    { ok: false, status: 404 },
  )
  assertEquals(
    groupMembersByDerivedCidr(
      [{ serverId: SERVER_A, address: '203.0.113.10' }],
      [{ id: SERVER_A, metadata: { ips: [] } }],
    ),
    {
      ok: false,
      status: 400,
      error: 'address_cidr_unreported',
      serverId: SERVER_A,
    },
  )
})

test('resolveOrCreateSubnetForAddress reuses known or pending site CIDRs', () => {
  assertEquals(
    resolveOrCreateSubnetForAddress(
      '203.0.113.10',
      privateIpMetadata('203.0.113.10', '203.0.113.10/24'),
      [{ networkId: 'net-a', cidr: '203.0.113.0/24' }],
    ),
    { ok: true, networkId: 'net-a', created: false },
  )
  assertEquals(
    resolveOrCreateSubnetForAddress(
      '203.0.113.10',
      privateIpMetadata('203.0.113.10', '203.0.113.10/24'),
      [{ networkId: '', cidr: '203.0.113.0/24' }],
    ),
    { ok: true, created: true, cidr: '203.0.113.0/24' },
  )
  assertEquals(
    resolveOrCreateSubnetForAddress(
      '203.0.113.10',
      privateIpMetadata('203.0.113.10', '203.0.113.10/24'),
      [{ networkId: 'net-b', cidr: '198.51.100.0/24' }],
    ),
    { ok: true, created: true, cidr: '203.0.113.0/24' },
  )
  assertEquals(
    resolveOrCreateSubnetForAddress('203.0.113.10', { ips: [] }, []),
    { ok: false, error: 'address_not_reported' },
  )
})
