import { assertEquals } from '@std/assert'
import { parseDockerRunCommand, parseDockerRunTokens } from './parse.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a repeated non-repeatable flag keeps the last value and notes it', () => {
  const parsed = parseDockerRunCommand(
    'docker run --name first --name second nginx',
  )
  assertEquals(
    parsed.entries.filter((entry) => entry.rawFlag === '--name').map((entry) =>
      entry.value
    ),
    ['first', 'second'],
  )
  assertEquals(
    parsed.diagnostics.some((diagnostic) =>
      diagnostic.code === 'option_not_repeatable' &&
      diagnostic.flag === '--name' &&
      diagnostic.blocking === false
    ),
    true,
  )
})

test('a long option missing its value at end-of-line is blocking', () => {
  const parsed = parseDockerRunCommand('docker run --name')
  assertEquals(
    parsed.diagnostics.some((diagnostic) =>
      diagnostic.code === 'missing_option_value' &&
      diagnostic.flag === '--name' &&
      diagnostic.blocking
    ),
    true,
  )
  assertEquals(parsed.image, null)
})

test('a short option missing its value at end-of-line is blocking', () => {
  const parsed = parseDockerRunCommand('docker run -p')
  assertEquals(
    parsed.diagnostics.some((diagnostic) =>
      diagnostic.code === 'missing_option_value' &&
      diagnostic.flag === '-p' &&
      diagnostic.blocking
    ),
    true,
  )
})

test('an unknown short flag in a cluster is reported, not guessed', () => {
  const parsed = parseDockerRunCommand('docker run -z nginx')
  const unknown = parsed.diagnostics.find((diagnostic) =>
    diagnostic.code === 'unknown_option'
  )
  assertEquals(unknown?.flag, '-z')
  assertEquals(unknown?.blocking, true)
  assertEquals(parsed.image, 'nginx')
})

test('a near-miss long flag suggests the closest known option', () => {
  const parsed = parseDockerRunCommand('docker run --nam nginx')
  const unknown = parsed.diagnostics.find((diagnostic) =>
    diagnostic.code === 'unknown_option'
  )
  assertEquals(unknown?.flag, '--nam')
  assertEquals(unknown?.message.includes('did you mean "--name"'), true)
})

test('a far-miss long flag has no suggestion', () => {
  const parsed = parseDockerRunCommand('docker run --zzzzzzzz nginx')
  const unknown = parsed.diagnostics.find((diagnostic) =>
    diagnostic.code === 'unknown_option'
  )
  assertEquals(unknown?.message.includes('did you mean'), false)
})

test('short flags accept an attached =value', () => {
  const parsed = parseDockerRunCommand('docker run -e=FOO=bar nginx')
  assertEquals(
    parsed.entries.map((entry) => [entry.rawFlag, entry.value]),
    [['-e', 'FOO=bar']],
  )
  assertEquals(parsed.image, 'nginx')
})

test('a boolean short flag with =value never consumes the next token', () => {
  const parsed = parseDockerRunCommand('docker run -d=false nginx')
  assertEquals(parsed.entries[0]?.rawFlag, '-d')
  assertEquals(parsed.entries[0]?.value, 'false')
  assertEquals(parsed.image, 'nginx')
})

test('-- ends the option scan so later dashes are the command', () => {
  const parsed = parseDockerRunCommand('docker run -- nginx --help')
  assertEquals(parsed.image, 'nginx')
  assertEquals(parsed.command, ['--help'])
})

test('a bare -- with no image is a distinct missing-image message', () => {
  const parsed = parseDockerRunCommand('docker run --')
  const missing = parsed.diagnostics.find((diagnostic) =>
    diagnostic.code === 'missing_image'
  )
  assertEquals(missing?.blocking, true)
  assertEquals(missing?.message.includes('after "--"'), true)
})

test('lexer warnings fold into parse diagnostics as non-blocking', () => {
  const parsed = parseDockerRunTokens(['nginx', '&&', 'true'], [
    {
      code: 'shell_operator_literal',
      text: '&&',
      message: 'pipeline taken literally',
    },
  ])
  assertEquals(parsed.diagnostics[0]?.code, 'shell_syntax_literal')
  assertEquals(parsed.diagnostics[0]?.blocking, false)
  assertEquals(parsed.image, 'nginx')
})
