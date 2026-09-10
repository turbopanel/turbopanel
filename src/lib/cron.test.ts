import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { cronToOnCalendar, parseCronCommand, parseCronSchedule } from './cron.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function calendar(expression: string): string {
  const result = cronToOnCalendar(expression)
  assert(result.ok, `expected "${expression}" to translate`)
  return result.value
}

function calendarError(expression: unknown): string {
  const result = cronToOnCalendar(expression)
  assert(!result.ok, `expected "${String(expression)}" to be rejected`)
  return result.error
}

function argv(command: string): string[] {
  const result = parseCronCommand(command)
  assert(result.ok, `expected "${command}" to parse`)
  return result.value
}

function argvError(command: unknown): string {
  const result = parseCronCommand(command)
  assert(!result.ok, `expected "${String(command)}" to be rejected`)
  return result.error
}

test('a fixed time translates to a single calendar event', () => {
  assertEquals(calendar('30 2 * * *'), '*-*-* 2:30:00')
  assertEquals(calendar('0 0 1 1 *'), '*-1-1 0:0:00')
})

test('seconds are pinned to :00, never left open', () => {
  // `*` in the seconds field would turn every job into a per-second timer.
  for (const expression of ['* * * * *', '0 0 * * *', '*/5 * * * *']) {
    assertStringIncludes(calendar(expression), ':00')
    assert(!calendar(expression).endsWith(':*'))
  }
})

test('steps render as start/step rather than */step', () => {
  assertEquals(calendar('*/5 * * * *'), '*-*-* *:0/5:00')
  assertEquals(calendar('0 */2 * * *'), '*-*-* 0/2:0:00')
  // A step from an explicit start keeps that start.
  assertEquals(calendar('5/10 * * * *'), '*-*-* *:5..59/10:00')
})

test('ranges and lists survive translation', () => {
  assertEquals(calendar('0 9-17 * * *'), '*-*-* 9..17:0:00')
  assertEquals(calendar('0,30 * * * *'), '*-*-* *:0,30:00')
  assertEquals(calendar('0 0 1,15 * *'), '*-*-1,15 0:0:00')
})

test('a weekday-only schedule renders systemd names', () => {
  assertEquals(calendar('0 0 * * 1-5'), 'Mon,Tue,Wed,Thu,Fri *-*-* 0:0:00')
  assertEquals(calendar('0 0 * * 0'), 'Sun *-*-* 0:0:00')
  // 7 is Sunday in vixie cron and does not exist in systemd.
  assertEquals(calendar('0 0 * * 7'), 'Sun *-*-* 0:0:00')
  assertEquals(calendar('0 0 * * mon,fri'), 'Mon,Fri *-*-* 0:0:00')
})

test('weekday output is week-ordered and deduplicated', () => {
  // Two spellings of one schedule must render identically, or the daemon's
  // unchanged-content rule would reinstall and reload for nothing.
  assertEquals(calendar('0 0 * * 5,1,1'), calendar('0 0 * * 1,5'))
  assertEquals(calendar('0 0 * * 5,1'), 'Mon,Fri *-*-* 0:0:00')
})

test('restricting BOTH day fields is rejected, with the reason', () => {
  // The trap this module exists for: vixie cron takes the union of these two
  // fields, systemd takes the intersection, and no OnCalendar expresses the
  // union. `0 0 13 * 5` is "the 13th OR any Friday" in cron and "Friday the
  // 13th" in systemd — a monthly job that quietly stops being monthly.
  const error = calendarError('0 0 13 * 5')
  assertStringIncludes(error, 'day-of-month')
  assertStringIncludes(error, 'day-of-week')
  assertStringIncludes(error, 'both to match')

  // Either one alone is fine.
  assert(cronToOnCalendar('0 0 13 * *').ok)
  assert(cronToOnCalendar('0 0 * * 5').ok)
})

test('a weekday step is rejected rather than approximated', () => {
  // "Every other Tuesday" is not something a calendar event can say.
  assertStringIncludes(
    calendarError('0 0 * * 1-5/2'),
    'has no systemd equivalent',
  )
})

test('a backwards range is rejected rather than reordered', () => {
  // Silently sorting `fri-mon` into `mon..fri` is a different set of days.
  assertStringIncludes(calendarError('0 0 * * 5-1'), 'runs backwards')
  assertStringIncludes(calendarError('0 17-9 * * *'), 'runs backwards')
})

test('shorthands expand to their vixie equivalents', () => {
  assertEquals(calendar('@daily'), calendar('0 0 * * *'))
  assertEquals(calendar('@midnight'), calendar('0 0 * * *'))
  assertEquals(calendar('@hourly'), calendar('0 * * * *'))
  assertEquals(calendar('@weekly'), calendar('0 0 * * 0'))
  assertEquals(calendar('@monthly'), calendar('0 0 1 * *'))
  assertEquals(calendar('@yearly'), calendar('0 0 1 1 *'))
  assertEquals(calendar('@annually'), calendar('@yearly'))
})

test('@reboot is refused with what to do instead', () => {
  // systemd expresses it as OnBootSec on a different kind of timer; turning it
  // into "every midnight" is the same class of meaning change as the day rule.
  const error = calendarError('@reboot')
  assertStringIncludes(error, '@reboot')
  assertStringIncludes(error, 'on start')
})

test('malformed schedules are rejected', () => {
  assertStringIncludes(calendarError('0 0 * *'), 'got 4')
  assertStringIncludes(calendarError('0 0 * * * *'), 'got 6')
  assertStringIncludes(calendarError(''), 'schedule is required')
  assertStringIncludes(calendarError(42), 'must be text')
  assertStringIncludes(calendarError('99 0 * * *'), 'not a valid minute')
  assertStringIncludes(calendarError('0 25 * * *'), 'not a valid hour')
  assertStringIncludes(calendarError('0 0 32 * *'), 'not a valid day of month')
  assertStringIncludes(calendarError('0 0 * 13 *'), 'not a valid month')
  assertStringIncludes(calendarError('0 0 * * 8'), 'not a valid day of week')
  assertStringIncludes(calendarError('*/0 * * * *'), 'invalid step')
  assertStringIncludes(calendarError('*/99 * * * *'), 'whole minute range')
  assertStringIncludes(calendarError('@nonsense'), 'unknown shorthand')
})

test('month names are accepted and rendered numerically', () => {
  assertEquals(calendar('0 0 1 jan *'), calendar('0 0 1 1 *'))
  assertEquals(calendar('0 0 1 JUN-AUG *'), '*-6..8-1 0:0:00')
})

test('a command becomes argv, with php resolved to the dispatcher', () => {
  // Runs *after* systemd drops to User=, so which PHP it resolves — and whether
  // the account may run PHP at all — comes from its own entitlement groups.
  assertEquals(argv('php wp-cron.php'), ['/usr/local/bin/php', 'wp-cron.php'])
  assertEquals(argv('/usr/bin/env true'), ['/usr/bin/env', 'true'])
  assertEquals(argv('  php   -f  cron.php  '), [
    '/usr/local/bin/php',
    '-f',
    'cron.php',
  ])
})

test('shell syntax is rejected, never escaped', () => {
  // systemd runs the command directly. Accepting `>>` would silently pass it to
  // the script as an argument, which looks like redirection and is not.
  for (
    const command of [
      'php cron.php >> /tmp/log',
      'php cron.php && echo done',
      'php cron.php | tee log',
      'php cron.php; rm -rf /',
      'php $(whoami).php',
      'php `id`.php',
      'php *.php',
      'php "quoted arg"',
    ]
  ) {
    const error = argvError(command)
    assertStringIncludes(error, 'no shell')
    assertStringIncludes(error, 'Output is captured for you')
  }
})

test('a bare command that is not a known shortcut needs an absolute path', () => {
  // systemd does not search PATH.
  const error = argvError('node cron.js')
  assertStringIncludes(error, 'absolute path')
  assertStringIncludes(error, 'php')
  // A relative path is caught by the same rule, before `..` matters.
  assertStringIncludes(argvError('../../bin/php x'), 'absolute path')
  // An absolute one still cannot climb out of where it claims to be.
  assertStringIncludes(argvError('/usr/bin/../bin/php x'), '".."')
})

test('empty and oversized commands are rejected', () => {
  assertStringIncludes(argvError(''), 'command is required')
  assertStringIncludes(argvError('   '), 'command is required')
  assertStringIncludes(argvError(7), 'must be text')
  assertStringIncludes(argvError(`/bin/x ${'a'.repeat(1200)}`), 'under 1000')
  assertStringIncludes(
    argvError(`/bin/x ${'a'.repeat(600)}`),
    'under 512 characters',
  )
})

test('parseCronSchedule accepts five-field cron including a day-of-month and day-of-week union', () => {
  assertEquals(parseCronSchedule('0 0 13 * 5'), { ok: true, value: '0 0 13 * 5' })
  assertEquals(parseCronSchedule('  @hourly  '), { ok: true, value: '@hourly' })
  assertEquals(parseCronSchedule('30 2 * * *'), { ok: true, value: '30 2 * * *' })
})

test('parseCronSchedule rejects malformed schedules and unsupported aliases', () => {
  assertEquals(parseCronSchedule('@reboot').ok, false)
  assertEquals(parseCronSchedule('0 * * *').ok, false)
  assertEquals(parseCronSchedule('@whenever').ok, false)
  assertEquals(parseCronSchedule('').ok, false)
  assertEquals(parseCronSchedule(7).ok, false)
})

test('a timezone is appended as systemd\'s trailing calendar field', () => {
  const result = cronToOnCalendar('0 3 * * *', 'Europe/Berlin')
  assert(result.ok, 'expected a zoned schedule to translate')
  assertEquals(result.value, '*-*-* 3:0:00 Europe/Berlin')
})

test('an underscored zone survives translation', () => {
  // `America/New_York` is the case that widened the wire charset on both sides.
  const result = cronToOnCalendar('30 2 * * *', 'America/New_York')
  assert(result.ok, 'expected an underscored zone to translate')
  assertEquals(result.value, '*-*-* 2:30:00 America/New_York')
})

test('an alias schedule keeps its timezone through expansion', () => {
  const result = cronToOnCalendar('@daily', 'Europe/Berlin')
  assert(result.ok, 'expected an alias with a zone to translate')
  assertStringIncludes(result.value, 'Europe/Berlin')
})

test('omitting a timezone leaves the calendar event unzoned', () => {
  // Host-local time is what a timer with no zone has always meant; adding a
  // zone by default would silently move every existing job.
  assertEquals(calendar('0 3 * * *'), '*-*-* 3:0:00')
})

test('a timezone that systemd would not accept is refused', () => {
  for (const bad of ['Not/AZone; rm -rf /', 'Europe/Berlin ', '../etc', '']) {
    const result = cronToOnCalendar('0 3 * * *', bad)
    assert(!result.ok, `expected "${bad}" to be rejected as a timezone`)
  }
})

test('a rejected schedule is still rejected when a zone is supplied', () => {
  // The day-field union refusal is the module's whole reason to exist; a zone
  // must not become a way around it.
  const result = cronToOnCalendar('0 0 13 * 5', 'Europe/Berlin')
  assert(!result.ok, 'expected the day-field union to stay refused')
})
