import { assertEquals, assertThrows } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  assertValidHostname,
  HOSTNAME_MAX_LENGTH,
  isValidHostname,
} from './hostname.ts'

it('isValidHostname accepts RFC-1123 names', () => {
  assertEquals(isValidHostname('a'), true)
  assertEquals(isValidHostname('web-01'), true)
  assertEquals(isValidHostname('host.example.com'), true)
  assertEquals(isValidHostname(`a${'b'.repeat(61)}c`), true)
  const labels = Array.from({ length: 4 }, (_, i) => `label${i}`).join('.')
  assertEquals(labels.length <= HOSTNAME_MAX_LENGTH, true)
  assertEquals(isValidHostname(labels), true)
})

it('isValidHostname rejects unsafe values', () => {
  const reject = [
    'a b',
    'Web01',
    ';',
    '|',
    '&',
    '$(reboot)',
    '`id`',
    '()',
    '<>',
    '"x"',
    "'x'",
    '*',
    '?',
    '{}',
    '-a',
    'a-',
    '.a',
    'a.',
    '',
    'a'.repeat(254),
  ]
  for (const value of reject) {
    assertEquals(isValidHostname(value), false, `expected reject: ${JSON.stringify(value)}`)
  }
})

it('assertValidHostname throws for unsafe values', () => {
  assertThrows(() => assertValidHostname('a b'), Error, 'Invalid hostname')
  assertValidHostname('web-01')
})

it('isValidHostname rejects non-string values', () => {
  assertEquals(isValidHostname(12), false)
  assertEquals(isValidHostname(null), false)
  assertEquals(isValidHostname(undefined), false)
})
