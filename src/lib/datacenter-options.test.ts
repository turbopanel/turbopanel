import { assertEquals } from '@std/assert'
import {
  DATACENTER_PRIORITY_MAX,
  DATACENTER_PRIORITY_MIN,
  DEFAULT_DATACENTER_PRIORITY,
  DEFAULT_DATACENTER_TRUSTED,
  parseDatacenterOptions,
  parseDatacenterPriority,
  resolveDatacenterPolicy,
} from './datacenter-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseDatacenterOptions returns empty object for non-records', () => {
  assertEquals(parseDatacenterOptions(null), {})
  assertEquals(parseDatacenterOptions([]), {})
  assertEquals(parseDatacenterOptions('nope'), {})
})

test('parseDatacenterOptions omits blank timezone and invalid enforce flag', () => {
  assertEquals(
    parseDatacenterOptions({
      defaultServerTimezone: '  ',
      enforceServerTimezone: 'yes',
    }),
    {},
  )
})

test('parseDatacenterOptions keeps trimmed timezone, boolean enforce, and host defaults', () => {
  assertEquals(
    parseDatacenterOptions({
      defaultServerTimezone: '  Europe/Berlin  ',
      enforceServerTimezone: true,
      sshPort: 2200,
      ntp: { enabled: false },
    }),
    {
      defaultServerTimezone: 'Europe/Berlin',
      enforceServerTimezone: true,
      sshPort: 2200,
      ntp: { enabled: false },
    },
  )
})

test('parseDatacenterOptions keeps explicit ipv6 and ipv4 addressPreference', () => {
  assertEquals(parseDatacenterOptions({ addressPreference: 'ipv6' }), {
    addressPreference: 'ipv6',
  })
  assertEquals(parseDatacenterOptions({ addressPreference: 'ipv4' }), {
    addressPreference: 'ipv4',
  })
})

test('parseDatacenterOptions drops invalid addressPreference', () => {
  assertEquals(parseDatacenterOptions({ addressPreference: 'dual' }), {})
})

test('parseDatacenterOptions omits addressPreference when absent', () => {
  assertEquals(
    parseDatacenterOptions({ enforceServerTimezone: false }),
    { enforceServerTimezone: false },
  )
})

test('parseDatacenterOptions keeps in-range integer priority (bounds inclusive)', () => {
  assertEquals(parseDatacenterOptions({ priority: 0 }), { priority: 0 })
  assertEquals(parseDatacenterOptions({ priority: 1000 }), { priority: 1000 })
  assertEquals(parseDatacenterOptions({ priority: 42 }), { priority: 42 })
  assertEquals(DATACENTER_PRIORITY_MIN, 0)
  assertEquals(DATACENTER_PRIORITY_MAX, 1000)
  assertEquals(DEFAULT_DATACENTER_PRIORITY, 100)
})

test('parseDatacenterOptions drops out-of-range priority instead of clamping', () => {
  assertEquals(parseDatacenterOptions({ priority: -1 }), {})
  assertEquals(parseDatacenterOptions({ priority: 1001 }), {})
  assertEquals(parseDatacenterOptions({ priority: Number.MAX_SAFE_INTEGER }), {})
  assertEquals(parseDatacenterOptions({ priority: Number.POSITIVE_INFINITY }), {})
})

test('parseDatacenterOptions drops wrong-type or non-integer priority', () => {
  assertEquals(parseDatacenterOptions({ priority: '50' }), {})
  assertEquals(parseDatacenterOptions({ priority: 5.5 }), {})
  assertEquals(parseDatacenterOptions({ priority: Number.NaN }), {})
  assertEquals(parseDatacenterOptions({ priority: null }), {})
  assertEquals(parseDatacenterOptions({ priority: true }), {})
  assertEquals(parseDatacenterOptions({ priority: [10] }), {})
  assertEquals(parseDatacenterOptions({ priority: { value: 10 } }), {})
})

test('parseDatacenterPriority mirrors the parser contract', () => {
  assertEquals(parseDatacenterPriority(7), 7)
  assertEquals(parseDatacenterPriority(1000), 1000)
  assertEquals(parseDatacenterPriority(1001), undefined)
  assertEquals(parseDatacenterPriority(-0.5), undefined)
  assertEquals(parseDatacenterPriority('7'), undefined)
  assertEquals(parseDatacenterPriority(undefined), undefined)
})

test('parseDatacenterOptions keeps explicit trusted booleans only', () => {
  assertEquals(parseDatacenterOptions({ trusted: true }), { trusted: true })
  assertEquals(parseDatacenterOptions({ trusted: false }), { trusted: false })
  assertEquals(parseDatacenterOptions({ trusted: 'false' }), {})
  assertEquals(parseDatacenterOptions({ trusted: 0 }), {})
  assertEquals(parseDatacenterOptions({ trusted: null }), {})
  assertEquals(parseDatacenterOptions({ trusted: 'yes' }), {})
})

test('parseDatacenterOptions omits priority and trusted when absent', () => {
  assertEquals(parseDatacenterOptions({ addressPreference: 'ipv4' }), {
    addressPreference: 'ipv4',
  })
})

test('parseDatacenterOptions keeps policy alongside the other fields', () => {
  assertEquals(
    parseDatacenterOptions({
      addressPreference: 'ipv4',
      priority: 10,
      trusted: false,
      sshPort: 2200,
    }),
    { addressPreference: 'ipv4', sshPort: 2200, priority: 10, trusted: false },
  )
})

test('resolveDatacenterPolicy applies defaults for absent or invalid fields', () => {
  assertEquals(DEFAULT_DATACENTER_TRUSTED, true)
  assertEquals(resolveDatacenterPolicy(null), { priority: 100, trusted: true })
  assertEquals(resolveDatacenterPolicy({}), { priority: 100, trusted: true })
  assertEquals(resolveDatacenterPolicy({ priority: 5000, trusted: 'no' }), {
    priority: 100,
    trusted: true,
  })
  assertEquals(resolveDatacenterPolicy({ priority: 0, trusted: false }), {
    priority: 0,
    trusted: false,
  })
})
