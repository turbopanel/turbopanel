import { assertEquals } from '@std/assert'
import {
  buildNetworkDockerOptions,
  isValidDockerNetworkName,
  normalizeDockerNetworkOptions,
  normalizeDockerNetworkOptionsStrict,
  readNetworkDockerAddressing,
  readNetworkDockerNetworkName,
} from './docker-network-name.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('readNetworkDockerNetworkName prefers options.dockerNetworkName', () => {
  assertEquals(
    readNetworkDockerNetworkName({ dockerNetworkName: '  shared-net  ' }, null),
    'shared-net',
  )
})

test('buildNetworkDockerOptions wraps docker network name', () => {
  assertEquals(buildNetworkDockerOptions('shared-net'), { dockerNetworkName: 'shared-net' })
})

test('isValidDockerNetworkName matches Docker Engine allowlist', () => {
  assertEquals(isValidDockerNetworkName('turbopanel-shared'), true)
  assertEquals(isValidDockerNetworkName('a.b_c-1'), true)
  assertEquals(isValidDockerNetworkName('-bad'), false)
  assertEquals(isValidDockerNetworkName('has space'), false)
})

test('normalizeDockerNetworkOptions trims and requires a valid name', () => {
  assertEquals(
    normalizeDockerNetworkOptions({ dockerNetworkName: '  shared  ', label: 'x' }),
    { dockerNetworkName: 'shared', label: 'x' },
  )
  assertEquals(normalizeDockerNetworkOptions({}), null)
  assertEquals(normalizeDockerNetworkOptions({ dockerNetworkName: '-bad' }), null)
})

test('normalizeDockerNetworkOptions accepts subnet, ipRange, gateway and mtu together', () => {
  assertEquals(
    normalizeDockerNetworkOptions({
      dockerNetworkName: 'edge',
      subnet: ' 10.77.0.0/16 ',
      ipRange: '10.77.8.0/24',
      gateway: '10.77.0.1',
      mtu: 1450,
    }),
    {
      dockerNetworkName: 'edge',
      subnet: '10.77.0.0/16',
      ipRange: '10.77.8.0/24',
      gateway: '10.77.0.1',
      mtu: 1450,
    },
  )
  // Explicit nulls clear rather than persist.
  assertEquals(
    normalizeDockerNetworkOptions({ dockerNetworkName: 'edge', subnet: null, mtu: null }),
    { dockerNetworkName: 'edge' },
  )
})

test('normalizeDockerNetworkOptionsStrict reports which addressing key is wrong', () => {
  const strict = (options: Record<string, unknown>) =>
    normalizeDockerNetworkOptionsStrict({ dockerNetworkName: 'edge', ...options })
  assertEquals(strict({ subnet: '10.77.0.0' }), {
    ok: false,
    reason: 'docker_network_subnet_invalid',
  })
  // ipRange / gateway are only meaningful with a subnet.
  assertEquals(strict({ ipRange: '10.77.8.0/24' }), {
    ok: false,
    reason: 'docker_network_ip_range_invalid',
  })
  assertEquals(strict({ gateway: '10.77.0.1' }), {
    ok: false,
    reason: 'docker_network_gateway_invalid',
  })
  // Containment.
  assertEquals(strict({ subnet: '10.77.0.0/16', ipRange: '10.78.0.0/24' }), {
    ok: false,
    reason: 'docker_network_ip_range_invalid',
  })
  assertEquals(strict({ subnet: '10.77.0.0/16', gateway: '10.78.0.1' }), {
    ok: false,
    reason: 'docker_network_gateway_invalid',
  })
  // A gateway is a bare address, never a CIDR.
  assertEquals(strict({ subnet: '10.77.0.0/16', gateway: '10.77.0.1/16' }), {
    ok: false,
    reason: 'docker_network_gateway_invalid',
  })
  // MTU bounds match the fabric bridge.
  assertEquals(strict({ mtu: 1279 }), { ok: false, reason: 'docker_network_mtu_invalid' })
  assertEquals(strict({ mtu: 9001 }), { ok: false, reason: 'docker_network_mtu_invalid' })
  assertEquals(strict({ mtu: '1500' }), { ok: false, reason: 'docker_network_mtu_invalid' })
  assertEquals(strict({ mtu: 9000 }).ok, true)
  assertEquals(normalizeDockerNetworkOptionsStrict({}), {
    ok: false,
    reason: 'docker_network_name_required',
  })
})

test('readNetworkDockerAddressing prefers the cidr column and salvages what still fits', () => {
  assertEquals(readNetworkDockerAddressing(null, { dockerNetworkName: 'edge' }), {})
  assertEquals(
    readNetworkDockerAddressing('10.77.0.0/16', {
      dockerNetworkName: 'edge',
      subnet: '10.99.0.0/16',
      ipRange: '10.77.8.0/24',
      gateway: '10.77.0.1',
      mtu: 1450,
    }),
    { subnet: '10.77.0.0/16', ipRange: '10.77.8.0/24', gateway: '10.77.0.1', mtu: 1450 },
  )
  assertEquals(
    readNetworkDockerAddressing(null, { dockerNetworkName: 'edge', subnet: '10.77.0.0/16' }),
    { subnet: '10.77.0.0/16' },
  )
  // A stale ipRange from before a re-range is dropped, not handed to Docker.
  assertEquals(
    readNetworkDockerAddressing('10.80.0.0/16', {
      dockerNetworkName: 'edge',
      ipRange: '10.77.8.0/24',
      mtu: 1450,
    }),
    { subnet: '10.80.0.0/16', mtu: 1450 },
  )
})
