import { assertEquals } from '@std/assert'
import { lexDockerRunCommand } from './lexer.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('redirection and glob characters are imported literally with warnings', () => {
  const redirected = lexDockerRunCommand('docker run nginx > /tmp/out')
  assertEquals(
    redirected.warnings.some((warning) => warning.code === 'redirection_literal'),
    true,
  )
  assertEquals(redirected.tokens.includes('>'), true)

  const globbed = lexDockerRunCommand('docker run nginx *.conf')
  assertEquals(
    globbed.warnings.some((warning) => warning.code === 'glob_literal'),
    true,
  )
  assertEquals(globbed.tokens.includes('*.conf'), true)
})

test('a repeated literal construct only warns once', () => {
  const lexed = lexDockerRunCommand('docker run nginx && true && false')
  const operators = lexed.warnings.filter((warning) =>
    warning.code === 'shell_operator_literal'
  )
  assertEquals(operators.length, 1)
})

test('double-quoted escapes honour the shell subset', () => {
  const lexed = lexDockerRunCommand(
    String.raw`docker run -e "MSG=say \"hi\" \\ \$notvar \`tick\`" nginx`,
  )
  assertEquals(lexed.tokens, [
    '-e',
    String.raw`MSG=say "hi" \ $notvar ` + '`tick`',
    'nginx',
  ])
})

test('a backslash-newline inside double quotes is a line continuation', () => {
  const lexed = lexDockerRunCommand('docker run -e "A=one\\\ntwo" nginx')
  assertEquals(lexed.tokens, ['-e', 'A=onetwo', 'nginx'])
})

test('an unquoted trailing backslash is kept as a literal', () => {
  const lexed = lexDockerRunCommand('docker run nginx \\')
  assertEquals(lexed.tokens.at(-1), '\\')
})

test('CRLF line continuation folds a README paste', () => {
  const lexed = lexDockerRunCommand('docker run \\\r\n  nginx')
  assertEquals(lexed.tokens, ['nginx'])
})

test('backticks are one literal token, including an unclosed span', () => {
  const closed = lexDockerRunCommand('docker run -e UID=`id -u` nginx')
  assertEquals(closed.tokens, ['-e', 'UID=`id -u`', 'nginx'])
  assertEquals(closed.warnings[0]?.code, 'command_substitution_literal')

  const open = lexDockerRunCommand('docker run -e NOTE=`still open nginx')
  assertEquals(open.tokens[1]?.startsWith('NOTE=`'), true)
})

test('unterminated quotes swallow the rest of the line', () => {
  const double = lexDockerRunCommand('docker run -e "MSG=hello nginx')
  assertEquals(double.tokens, ['-e', 'MSG=hello nginx'])
  assertEquals(
    double.warnings.some((warning) => warning.code === 'unterminated_quote'),
    true,
  )

  const single = lexDockerRunCommand("docker run -e 'MSG=hello nginx")
  assertEquals(single.tokens, ['-e', 'MSG=hello nginx'])
  assertEquals(
    single.warnings.some((warning) =>
      warning.code === 'unterminated_quote' && warning.text === "'"
    ),
    true,
  )
})

test('an argv array still scans shell syntax without re-lexing values', () => {
  const lexed = lexDockerRunCommand([
    'docker',
    'run',
    '-e',
    'A=$(id)',
    'nginx',
  ])
  assertEquals(lexed.tokens, ['-e', 'A=$(id)', 'nginx'])
  assertEquals(lexed.warnings[0]?.code, 'command_substitution_literal')
})
