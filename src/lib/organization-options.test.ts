import { assertEquals } from '@std/assert'
import {
  isUnlimitedMaxServers,
  parseDefaultEnvironmentNameInput,
  parseMaxServersInput,
  parseOrganizationOptions,
  parseTemperatureUnitInput,
  resolveDefaultEnvironmentName,
  resolveRandomizedPrincipalUsernames,
  resolveTemperatureUnit,
} from './organization-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseOrganizationOptions returns empty object for non-records', () => {
  assertEquals(parseOrganizationOptions(null), {})
  assertEquals(parseOrganizationOptions([]), {})
})

test('parseOrganizationOptions reads timezone, maxServers, and host defaults', () => {
  const options = parseOrganizationOptions({
    defaultServerTimezone: ' America/Chicago ',
    enforceServerTimezone: true,
    maxServers: 5,
    sshPort: 2222,
    ntp: { enabled: true, servers: ['time.cloudflare.com'] },
    defaultFabricEnabled: true,
  })
  assertEquals(options.defaultServerTimezone, 'America/Chicago')
  assertEquals(options.enforceServerTimezone, true)
  assertEquals(options.maxServers, 5)
  assertEquals(options.sshPort, 2222)
  assertEquals(options.ntp, {
    enabled: true,
    servers: ['time.cloudflare.com'],
  })
  assertEquals(options.defaultFabricEnabled, true)
})

test('parseOrganizationOptions treats null maxServers as unlimited sentinel', () => {
  const options = parseOrganizationOptions({ maxServers: null })
  assertEquals(options.maxServers, null)
  assertEquals(isUnlimitedMaxServers(options.maxServers), true)
})

test('parseOrganizationOptions ignores invalid maxServers', () => {
  assertEquals(parseOrganizationOptions({ maxServers: -1 }).maxServers, undefined)
  assertEquals(parseOrganizationOptions({ maxServers: 1.5 }).maxServers, undefined)
  assertEquals(parseOrganizationOptions({ maxServers: '3' }).maxServers, undefined)
})

test('parseOrganizationOptions trims defaultEnvironmentName and omits blank', () => {
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: ' Staging ' }).defaultEnvironmentName,
    'Staging'
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: '   ' }).defaultEnvironmentName,
    undefined
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: 12 }).defaultEnvironmentName,
    undefined
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: null }).defaultEnvironmentName,
    undefined
  )
})

test('parseMaxServersInput accepts zero and rejects negatives', () => {
  assertEquals(parseMaxServersInput(0), { ok: true, value: 0 })
  assertEquals(parseMaxServersInput(null), { ok: true, value: null })
  assertEquals(parseMaxServersInput(-1).ok, false)
})

test('parseDefaultEnvironmentNameInput accepts valid names and resets', () => {
  assertEquals(parseDefaultEnvironmentNameInput('Staging'), {
    ok: true,
    value: 'Staging',
  })
  assertEquals(parseDefaultEnvironmentNameInput("O'Reilly"), {
    ok: true,
    value: "O'Reilly",
  })
  assertEquals(parseDefaultEnvironmentNameInput(' Live Env '), {
    ok: true,
    value: 'Live Env',
  })
  assertEquals(parseDefaultEnvironmentNameInput(null), {
    ok: true,
    value: null,
  })
})

test('parseDefaultEnvironmentNameInput rejects invalid values', () => {
  assertEquals(parseDefaultEnvironmentNameInput(12).ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('   ').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('bad/name').ok, true)
  assertEquals(parseDefaultEnvironmentNameInput('bad\nname').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('a'.repeat(256)).ok, false)
})

test('resolveDefaultEnvironmentName uses option or Production fallback', () => {
  assertEquals(resolveDefaultEnvironmentName({ defaultEnvironmentName: 'Staging' }), 'Staging')
  assertEquals(resolveDefaultEnvironmentName({}), 'Production')
})

test('isUnlimitedMaxServers for omitted and null', () => {
  assertEquals(isUnlimitedMaxServers(undefined), true)
  assertEquals(isUnlimitedMaxServers(null), true)
  assertEquals(isUnlimitedMaxServers(0), false)
  assertEquals(isUnlimitedMaxServers(2), false)
})

test('parseOrganizationOptions reads temperatureUnit and ignores invalid values', () => {
  assertEquals(
    parseOrganizationOptions({ temperatureUnit: 'fahrenheit' }).temperatureUnit,
    'fahrenheit'
  )
  assertEquals(parseOrganizationOptions({ temperatureUnit: 'kelvin' }).temperatureUnit, undefined)
  assertEquals(parseOrganizationOptions({ temperatureUnit: 42 }).temperatureUnit, undefined)
})

test('parseTemperatureUnitInput accepts celsius/fahrenheit and rejects everything else', () => {
  assertEquals(parseTemperatureUnitInput('celsius'), {
    ok: true,
    value: 'celsius',
  })
  assertEquals(parseTemperatureUnitInput('fahrenheit'), {
    ok: true,
    value: 'fahrenheit',
  })
  assertEquals(parseTemperatureUnitInput('kelvin').ok, false)
  assertEquals(parseTemperatureUnitInput(null).ok, false)
  assertEquals(parseTemperatureUnitInput(undefined).ok, false)
})

test('resolveTemperatureUnit defaults to celsius', () => {
  assertEquals(resolveTemperatureUnit({}), 'celsius')
  assertEquals(resolveTemperatureUnit({ temperatureUnit: 'fahrenheit' }), 'fahrenheit')
})

Deno.test('randomizedPrincipalUsernames parses and defaults to on', () => {
  assertEquals(
    parseOrganizationOptions({ randomizedPrincipalUsernames: false }).randomizedPrincipalUsernames,
    false
  )
  assertEquals(
    parseOrganizationOptions({ randomizedPrincipalUsernames: 'no' }).randomizedPrincipalUsernames,
    undefined
  )
  assertEquals(resolveRandomizedPrincipalUsernames({}), true)
  assertEquals(
    resolveRandomizedPrincipalUsernames({
      randomizedPrincipalUsernames: false,
    }),
    false
  )
  assertEquals(resolveRandomizedPrincipalUsernames({ randomizedPrincipalUsernames: true }), true)
})

test('parseOrganizationOptions round-trips a valid metricsCapabilityPlan override', () => {
  const options = parseOrganizationOptions({
    metricsCapabilityPlan: { gpuSlots: 4, managedIngressEnabled: false },
  })
  assertEquals(options.metricsCapabilityPlan, {
    gpuSlots: 4,
    managedIngressEnabled: false,
  })
})

test('parseOrganizationOptions ignores an invalid metricsCapabilityPlan override', () => {
  const options = parseOrganizationOptions({
    metricsCapabilityPlan: { gpuSlots: 'not-a-number' },
  })
  assertEquals(options.metricsCapabilityPlan, undefined)
})

test('parseOrganizationOptions leaves metricsCapabilityPlan unset when absent', () => {
  const options = parseOrganizationOptions({})
  assertEquals(options.metricsCapabilityPlan, undefined)
})
