import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  assertDatacenterCidr,
  assertNetworkKindScope,
  buildNetworkCreateValues,
  cidrCollisionResponse,
} from './network-scope.ts'
import {
  applyCidrPatch,
  type NetworkPatchFields,
  parseCreateNetworkOptions,
  parseCreateOrganizationId,
  parseNetworkKind,
  parseNetworkPatchFields,
  parseOptionalCidrField,
  parseOptionalNameField,
  parseUuidQueryParam,
  reconcileDockerNetworkAddressing,
  rejectImmutableNetworkScopePatch,
  requireDockerNetworkName,
  requireDockerNetworkOptions,
  resolveKindQueryFilter,
} from './routes-pure.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(query: Record<string, string> = {}): Context<AppEnv> {
  return {
    req: {
      query(key: string) {
        return query[key]
      },
      header() {
        return undefined
      },
    },
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

async function expectErrorResponse(
  response: Response | null,
  status: number,
  error: string,
): Promise<void> {
  if (response === null) {
    throw new TypeError('expected error response')
  }
  assertEquals(response.status, status)
  assertEquals(await response.json(), { error })
}

test('assertNetworkKindScope enforces datacenter and docker scope rules', async () => {
  const c = mockContext() as Parameters<typeof assertNetworkKindScope>[0]

  await expectErrorResponse(
    assertNetworkKindScope(c, 'datacenter', null, null),
    400,
    'network_scope_required',
  )
  await expectErrorResponse(
    assertNetworkKindScope(c, 'datacenter', 'dc-1', 'srv-1'),
    400,
    'network_single_scope_conflict',
  )
  assertEquals(assertNetworkKindScope(c, 'datacenter', 'dc-1', null), null)

  assertEquals(assertNetworkKindScope(c, 'docker', null, 'srv-1'), null)
  await expectErrorResponse(
    assertNetworkKindScope(c, 'docker', 'dc-1', null),
    400,
    'network_single_scope_conflict',
  )
  assertEquals(assertNetworkKindScope(c, 'docker', null, null), null)
})

test('assertNetworkKindScope keeps reserved ranges org-only', async () => {
  const c = mockContext() as Parameters<typeof assertNetworkKindScope>[0]

  assertEquals(assertNetworkKindScope(c, 'reserved', null, null), null)
  assertEquals(assertNetworkKindScope(c, 'reserved', undefined, undefined), null)
  await expectErrorResponse(
    assertNetworkKindScope(c, 'reserved', 'dc-1', null),
    400,
    'network_single_scope_conflict',
  )
  await expectErrorResponse(
    assertNetworkKindScope(c, 'reserved', null, 'srv-1'),
    400,
    'network_single_scope_conflict',
  )
})

test('assertDatacenterCidr requires a CIDR for kind=datacenter and kind=reserved', async () => {
  const c = mockContext() as Parameters<typeof assertDatacenterCidr>[0]

  await expectErrorResponse(
    assertDatacenterCidr(c, 'datacenter', null),
    400,
    'network_cidr_required',
  )
  await expectErrorResponse(
    assertDatacenterCidr(c, 'reserved', null),
    400,
    'network_cidr_required',
  )
  assertEquals(assertDatacenterCidr(c, 'datacenter', '10.0.0.0/24'), null)
  assertEquals(assertDatacenterCidr(c, 'reserved', '10.0.0.0/8'), null)
  assertEquals(assertDatacenterCidr(c, 'docker', null), null)
})

test('cidrCollisionResponse maps a collision onto 409 with the code and both ranges', async () => {
  const c = mockContext() as Parameters<typeof cidrCollisionResponse>[0]
  const bare = cidrCollisionResponse(c, {
    code: 'cidr_overlaps_fabric',
    cidr: '10.250.1.0/24',
    conflictingCidr: '10.250.0.0/16',
    networkId: null,
    datacenterId: null,
  })
  assertEquals(bare.status, 409)
  assertEquals(await bare.json(), {
    error: 'cidr_overlaps_fabric',
    cidr: '10.250.1.0/24',
    conflictingCidr: '10.250.0.0/16',
  })

  const withRow = cidrCollisionResponse(c, {
    code: 'subnet_overlaps',
    cidr: '10.0.0.0/25',
    conflictingCidr: '10.0.0.0/24',
    networkId: 'net-1',
    datacenterId: 'dc-1',
  })
  assertEquals(withRow.status, 409)
  assertEquals(await withRow.json(), {
    error: 'subnet_overlaps',
    cidr: '10.0.0.0/25',
    conflictingCidr: '10.0.0.0/24',
    networkId: 'net-1',
    datacenterId: 'dc-1',
  })
})

test('buildNetworkCreateValues omits null optional fields', () => {
  assertEquals(
    buildNetworkCreateValues({
      organizationId: 'org-1',
      kind: 'docker',
      datacenterId: undefined,
      serverId: undefined,
      name: null,
      cidr: null,
      metadata: null,
      options: { dockerNetworkName: 'shared-net' },
    }),
    {
      organizationId: 'org-1',
      kind: 'docker',
      options: { dockerNetworkName: 'shared-net' },
    },
  )

  assertEquals(
    buildNetworkCreateValues({
      organizationId: 'org-1',
      kind: 'datacenter',
      datacenterId: 'dc-1',
      serverId: null,
      name: 'Private LAN',
      cidr: '10.0.0.0/24',
      metadata: { note: 'primary' },
      options: null,
    }),
    {
      organizationId: 'org-1',
      kind: 'datacenter',
      datacenterId: 'dc-1',
      serverId: null,
      name: 'Private LAN',
      cidr: '10.0.0.0/24',
      metadata: { note: 'primary' },
    },
  )
})

test('resolveKindQueryFilter accepts datacenter, docker, managed and reserved only', () => {
  const c = mockContext()
  assertEquals(resolveKindQueryFilter(c), undefined)
  assertEquals(resolveKindQueryFilter(mockContext({ kind: 'docker' })), 'docker')
  assertEquals(
    resolveKindQueryFilter(mockContext({ kind: 'datacenter' })),
    'datacenter',
  )
  assertEquals(resolveKindQueryFilter(mockContext({ kind: 'managed' })), 'managed')
  assertEquals(resolveKindQueryFilter(mockContext({ kind: 'reserved' })), 'reserved')
  for (const kind of ['vpn', 'compose']) {
    const bad = resolveKindQueryFilter(mockContext({ kind }))
    if (!(bad instanceof Response)) throw new TypeError('expected response')
    assertEquals(bad.status, 400)
  }
})

test('parseNetworkKind rejects platform-allocated kinds', async () => {
  const c = mockContext()
  for (const kind of ['managed', 'compose']) {
    await expectErrorResponse(
      parseNetworkKind(c, { kind }) as Response,
      400,
      'Invalid request',
    )
  }
})

test('parseNetworkKind accepts reserved as an operator-creatable kind', () => {
  assertEquals(parseNetworkKind(mockContext(), { kind: 'reserved' }), 'reserved')
})

test('parseNetworkPatchFields allows rename and re-range on a reserved network', () => {
  const c = mockContext()
  const patch = parseNetworkPatchFields(
    c,
    { name: 'Corp VPN - Chicago branch', cidr: '10.100.0.0/16' },
    'reserved',
  )
  if (patch instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(patch.name, 'Corp VPN - Chicago branch')
  assertEquals(patch.cidr, '10.100.0.0/16')
})

test('parseNetworkPatchFields refuses clearing the CIDR of CIDR-bearing kinds', async () => {
  const c = mockContext()
  for (const kind of ['datacenter', 'reserved']) {
    await expectErrorResponse(
      parseNetworkPatchFields(c, { cidr: null }, kind) as Response,
      400,
      'network_cidr_required',
    )
  }
  const docker = parseNetworkPatchFields(c, { cidr: null }, 'docker')
  if (docker instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(docker.cidr, null)
})

test('parseNetworkPatchFields reconciles docker cidr and options.subnet against the stored row', async () => {
  const c = mockContext()
  const existing = {
    cidr: '10.77.0.0/16',
    options: { dockerNetworkName: 'edge', subnet: '10.77.0.0/16', gateway: '10.77.0.1' },
  }
  // Clearing drops options.subnet too — but not while a gateway depends on it.
  await expectErrorResponse(
    parseNetworkPatchFields(c, { cidr: null }, 'docker', existing) as Response,
    400,
    'docker_network_subnet_required',
  )
  const cleared = parseNetworkPatchFields(c, { cidr: null }, 'docker', {
    cidr: '10.77.0.0/16',
    options: { dockerNetworkName: 'edge', subnet: '10.77.0.0/16', mtu: 1400 },
  })
  if (cleared instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(cleared.cidr, null)
  assertEquals(cleared.options, { dockerNetworkName: 'edge', mtu: 1400 })

  // cidr-only re-derives options.subnet; a gateway outside the new range is refused.
  await expectErrorResponse(
    parseNetworkPatchFields(c, { cidr: '10.90.0.0/16' }, 'docker', existing) as Response,
    400,
    'docker_network_gateway_invalid',
  )
  const reranged = parseNetworkPatchFields(c, { cidr: '10.77.0.0/17' }, 'docker', {
    cidr: '10.77.0.0/16',
    options: { dockerNetworkName: 'edge', subnet: '10.77.0.0/16' },
  })
  if (reranged instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(reranged.cidr, '10.77.0.0/17')
  assertEquals(reranged.options, { dockerNetworkName: 'edge', subnet: '10.77.0.0/17' })

  // options-only: a subnet re-ranges, no subnet keeps the stored cidr.
  const viaOptions = parseNetworkPatchFields(
    c,
    { options: { dockerNetworkName: 'edge', subnet: '10.80.0.0/16' } },
    'docker',
    existing,
  )
  if (viaOptions instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(viaOptions.cidr, '10.80.0.0/16')
  const keepCidr = parseNetworkPatchFields(
    c,
    { options: { dockerNetworkName: 'edge' } },
    'docker',
    existing,
  )
  if (keepCidr instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(keepCidr.cidr, '10.77.0.0/16')
  assertEquals(keepCidr.options, { dockerNetworkName: 'edge', subnet: '10.77.0.0/16' })

  // Both must agree.
  await expectErrorResponse(
    parseNetworkPatchFields(
      c,
      { cidr: '10.1.0.0/16', options: { dockerNetworkName: 'edge', subnet: '10.2.0.0/16' } },
      'docker',
      existing,
    ) as Response,
    400,
    'docker_network_subnet_mismatch',
  )
})

test('parseNetworkPatchFields refuses every patch on a managed network', async () => {
  const c = mockContext()
  const bodies: Record<string, unknown>[] = [
    { options: { dockerNetworkName: 'operator-supplied' } },
    { name: 'Managed' },
    { cidr: '10.42.0.0/24' },
    { metadata: { note: 'operator' } },
    {},
  ]
  for (const body of bodies) {
    await expectErrorResponse(
      parseNetworkPatchFields(c, body, 'managed') as Response,
      400,
      'managed_network_immutable',
    )
  }
})

test('parseUuidQueryParam validates list filter UUIDs', () => {
  const c = mockContext()
  const valid = '550e8400-e29b-41d4-a716-446655440000'
  assertEquals(parseUuidQueryParam(c, undefined), undefined)
  assertEquals(parseUuidQueryParam(c, `  ${valid}  `), valid)
  const bad = parseUuidQueryParam(c, 'not-a-uuid')
  if (!(bad instanceof Response)) throw new TypeError('expected response')
  assertEquals(bad.status, 400)
})

test('parseCreateOrganizationId rejects mismatched context organizationId', async () => {
  const orgId = '550e8400-e29b-41d4-a716-446655440000'
  const ok = parseCreateOrganizationId(
    mockContext({ organizationId: orgId }),
    { organizationId: orgId },
  )
  assertEquals(ok, orgId)

  const mismatch = parseCreateOrganizationId(
    mockContext({ organizationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }),
    { organizationId: orgId },
  )
  if (!(mismatch instanceof Response)) throw new TypeError('expected response')
  assertEquals(mismatch.status, 400)
  assertEquals(await mismatch.json(), { error: 'organizationId mismatch' })
})

test('parseCreateOrganizationId rejects non-UUID organizationId', async () => {
  const bad = parseCreateOrganizationId(mockContext(), { organizationId: 'not-a-uuid' })
  if (!(bad instanceof Response)) throw new TypeError('expected response')
  assertEquals(bad.status, 400)
  assertEquals(await bad.json(), { error: 'Invalid request' })
})

test('parseNetworkKind and CIDR helpers validate create/patch input', () => {
  const c = mockContext()
  assertEquals(parseNetworkKind(c, { kind: 'docker' }), 'docker')
  const badKind = parseNetworkKind(c, { kind: 'vpn' })
  if (!(badKind instanceof Response)) throw new TypeError('expected response')
  assertEquals(badKind.status, 400)

  assertEquals(parseOptionalNameField(c, {}), null)
  assertEquals(parseOptionalCidrField(c, { cidr: '10.0.0.0/24' }), '10.0.0.0/24')
  assertEquals(parseOptionalCidrField(c, {}), null)

  const patchFields: NetworkPatchFields = { updatedAt: '2020-01-01T00:00:00.000Z' }
  assertEquals(applyCidrPatch(c, { cidr: null }, patchFields), null)
  assertEquals(patchFields.cidr, null)
})

test('parseOptionalNameField and CIDR helpers reject invalid values', () => {
  const c = mockContext()
  const badName = parseOptionalNameField(c, {
    name: 'bad\nname',
  })
  if (!(badName instanceof Response)) throw new TypeError('expected response')
  assertEquals(badName.status, 400)

  const badCidr = parseOptionalCidrField(c, { cidr: 'not-a-cidr' })
  if (!(badCidr instanceof Response)) throw new TypeError('expected response')
  assertEquals(badCidr.status, 400)

  const patchFields: NetworkPatchFields = { updatedAt: '2020-01-01T00:00:00.000Z' }
  const badPatchCidr = applyCidrPatch(c, { cidr: '999.0.0.0/99' }, patchFields)
  if (!(badPatchCidr instanceof Response)) throw new TypeError('expected response')
  assertEquals(badPatchCidr.status, 400)
})

test('parseNetworkPatchFields rejects invalid name metadata and options', async () => {
  const c = mockContext()

  const badName = parseNetworkPatchFields(c, { name: 12 }, 'datacenter')
  if (!(badName instanceof Response)) throw new TypeError('expected response')
  assertEquals(badName.status, 400)

  const badDisplayName = parseNetworkPatchFields(c, {
    name: 'bad\nname',
  }, 'datacenter')
  if (!(badDisplayName instanceof Response)) throw new TypeError('expected response')
  assertEquals(badDisplayName.status, 400)

  const badMetadata = parseNetworkPatchFields(c, { metadata: [] }, 'datacenter')
  if (!(badMetadata instanceof Response)) throw new TypeError('expected response')
  assertEquals(badMetadata.status, 400)

  const badOptions = parseNetworkPatchFields(c, { options: 'nope' }, 'datacenter')
  if (!(badOptions instanceof Response)) throw new TypeError('expected response')
  assertEquals(badOptions.status, 400)

  const badDockerOptions = parseNetworkPatchFields(c, { options: {} }, 'docker')
  if (!(badDockerOptions instanceof Response)) throw new TypeError('expected response')
  assertEquals(await badDockerOptions.json(), { error: 'docker_network_name_required' })
})

test('parseCreateNetworkOptions requires docker network name for docker kind', async () => {
  const c = mockContext()
  assertEquals(parseCreateNetworkOptions(c, {}, 'datacenter'), null)
  assertEquals(
    parseCreateNetworkOptions(c, { options: { note: 'lan' } }, 'datacenter'),
    { note: 'lan' },
  )

  const badDocker = parseCreateNetworkOptions(c, { options: {} }, 'docker')
  if (!(badDocker instanceof Response)) throw new TypeError('expected response')
  assertEquals(await badDocker.json(), { error: 'docker_network_name_required' })

  assertEquals(
    parseCreateNetworkOptions(c, { options: { dockerNetworkName: 'shared' } }, 'docker'),
    { dockerNetworkName: 'shared' },
  )

  const badJson = parseCreateNetworkOptions(c, { options: [] }, 'docker')
  if (!(badJson instanceof Response)) throw new TypeError('expected response')
  assertEquals(badJson.status, 400)
})

test('parseCreateNetworkOptions defers docker addressing validation to CIDR reconciliation', async () => {
  const c = mockContext()
  // A top-level cidr is the source of truth; ipRange / gateway inside it are
  // accepted without an explicit options.subnet, which is derived.
  const raw = parseCreateNetworkOptions(
    c,
    { options: { dockerNetworkName: 'edge', ipRange: '10.77.8.0/24', gateway: '10.77.0.1' } },
    'docker',
  )
  if (raw instanceof Response || raw === null) throw new TypeError('expected options')
  assertEquals(raw, { dockerNetworkName: 'edge', ipRange: '10.77.8.0/24', gateway: '10.77.0.1' })
  const reconciled = reconcileDockerNetworkAddressing(c, { cidr: '10.77.0.0/16', options: raw })
  if (reconciled instanceof Response) throw new TypeError('expected reconciled addressing')
  assertEquals(reconciled, {
    cidr: '10.77.0.0/16',
    options: {
      dockerNetworkName: 'edge',
      subnet: '10.77.0.0/16',
      ipRange: '10.77.8.0/24',
      gateway: '10.77.0.1',
    },
  })

  // Still refused once the range is known and they fall outside it …
  await expectErrorResponse(
    reconcileDockerNetworkAddressing(c, { cidr: '10.90.0.0/16', options: raw }) as Response,
    400,
    'docker_network_ip_range_invalid',
  )
  // … or when no range is given at all.
  await expectErrorResponse(
    reconcileDockerNetworkAddressing(c, { cidr: null, options: raw }) as Response,
    400,
    'docker_network_ip_range_invalid',
  )
  // The name is still checked up front.
  await expectErrorResponse(
    parseCreateNetworkOptions(c, { options: { ipRange: '10.77.8.0/24' } }, 'docker') as Response,
    400,
    'docker_network_name_required',
  )
})

test('parseNetworkPatchFields accepts ipRange and gateway that rely on the stored docker cidr', async () => {
  const c = mockContext()
  const existing = {
    cidr: '10.77.0.0/16',
    options: { dockerNetworkName: 'edge', subnet: '10.77.0.0/16' },
  }
  const patched = parseNetworkPatchFields(
    c,
    { options: { dockerNetworkName: 'edge', ipRange: '10.77.8.0/24', gateway: '10.77.0.1' } },
    'docker',
    existing,
  )
  if (patched instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(patched.cidr, '10.77.0.0/16')
  assertEquals(patched.options, {
    dockerNetworkName: 'edge',
    subnet: '10.77.0.0/16',
    ipRange: '10.77.8.0/24',
    gateway: '10.77.0.1',
  })

  // A re-range in the same body anchors them instead of the stored cidr.
  const reranged = parseNetworkPatchFields(
    c,
    {
      cidr: '10.90.0.0/16',
      options: { dockerNetworkName: 'edge', ipRange: '10.90.8.0/24', gateway: '10.90.0.1' },
    },
    'docker',
    existing,
  )
  if (reranged instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(reranged.cidr, '10.90.0.0/16')
  assertEquals(reranged.options, {
    dockerNetworkName: 'edge',
    subnet: '10.90.0.0/16',
    ipRange: '10.90.8.0/24',
    gateway: '10.90.0.1',
  })

  // Outside the stored range is still refused, after reconciliation.
  await expectErrorResponse(
    parseNetworkPatchFields(
      c,
      { options: { dockerNetworkName: 'edge', gateway: '10.90.0.1' } },
      'docker',
      existing,
    ) as Response,
    400,
    'docker_network_gateway_invalid',
  )
})

test('requireDockerNetworkName checks only the name', async () => {
  const c = mockContext()
  assertEquals(requireDockerNetworkName(c, { dockerNetworkName: 'edge', ipRange: 'nope' }), null)
  await expectErrorResponse(requireDockerNetworkName(c, null), 400, 'docker_network_name_required')
  await expectErrorResponse(
    requireDockerNetworkName(c, { dockerNetworkName: 'bad name' }),
    400,
    'docker_network_name_required',
  )
})

test('requireDockerNetworkOptions enforces dockerNetworkName', async () => {
  const c = mockContext()
  const ok = requireDockerNetworkOptions(c, { dockerNetworkName: 'shared-net' })
  assertEquals(ok, { dockerNetworkName: 'shared-net' })
  const bad = requireDockerNetworkOptions(c, {})
  if (!(bad instanceof Response)) throw new TypeError('expected response')
  assertEquals(bad.status, 400)
  assertEquals(await bad.json(), { error: 'docker_network_name_required' })
})

test('parseNetworkPatchFields normalizes docker options on patch', () => {
  const c = mockContext()
  const dockerPatch = parseNetworkPatchFields(c, {
    options: { dockerNetworkName: 'external-net' },
  }, 'docker')
  if (dockerPatch instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(dockerPatch.options, { dockerNetworkName: 'external-net' })

  const datacenterPatch = parseNetworkPatchFields(c, {
    options: { note: 'site lan' },
  }, 'datacenter')
  if (datacenterPatch instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(datacenterPatch.options, { note: 'site lan' })
})

test('rejectImmutableNetworkScopePatch blocks datacenterId and serverId on patch', () => {
  const c = mockContext()
  assertEquals(rejectImmutableNetworkScopePatch(c, {}), null)
  const denied = rejectImmutableNetworkScopePatch(c, { serverId: '550e8400-e29b-41d4-a716-446655440000' })
  if (!(denied instanceof Response)) throw new TypeError('expected response')
  assertEquals(denied.status, 400)
})
