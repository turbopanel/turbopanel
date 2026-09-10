/**
 * Cron schedules and commands, translated once here for both sides.
 *
 * Operators know cron, so cron is what the compose block accepts. systemd
 * timers are what actually run the job, so `OnCalendar` is what goes on the
 * wire — translated in the control plane, validated and rendered by the daemon.
 * The same doctrine as entitlements and SSH access: one place decides, the
 * daemon reconciles.
 *
 * **The trap this module exists to refuse.** When a cron expression restricts
 * *both* day-of-month and day-of-week, vixie cron takes their **union**:
 * `0 0 13 * 5` fires on the 13th **or** on any Friday. systemd's calendar
 * events take the **intersection**: `Fri *-*-13` fires only on Friday the 13th.
 * There is no `OnCalendar` string that expresses the union, and no amount of
 * care in the renderer changes that. Translating it silently would change what
 * the operator's job means — a monthly billing run that quietly stopped running
 * monthly — so it is rejected with the reason.
 */

import { isValidTimezone } from './timezones.ts'

/** Cap per service, so one compose block cannot generate an unbounded unit set. */
export const MAX_CRON_JOBS_PER_SERVICE = 20

/**
 * Longest run a job may declare, in seconds (24h).
 *
 * Rendered as `RuntimeMaxSec=`; a job that outlives it is killed. The ceiling
 * exists so a typo cannot pin a timer's unit active forever and quietly block
 * every later firing under `forbid`.
 */
export const MAX_CRON_TIMEOUT_SECONDS = 86_400

/** Longest command line accepted, before argv splitting. */
const MAX_COMMAND_LENGTH = 1000
/** Longest single argument, so one token cannot blow up a unit file. */
const MAX_ARG_LENGTH = 512

export type CronParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

function fail<T>(error: string): CronParseResult<T> {
  return { ok: false, error }
}

const WEEKDAY_NAMES = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
] as const

const MONTH_ALIASES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const WEEKDAY_ALIASES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

/**
 * Shorthands, expanded to their vixie-cron equivalents before parsing.
 *
 * `@reboot` is deliberately absent: systemd expresses it as `OnBootSec` on a
 * different kind of timer, and silently turning "once at boot" into "every
 * midnight" would be the same class of meaning change the day-of-week rule
 * refuses.
 */
const CRON_ALIASES: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

type FieldSpec = {
  label: string
  min: number
  max: number
  aliases?: Readonly<Record<string, number>>
}

const MINUTE: FieldSpec = { label: 'minute', min: 0, max: 59 }
const HOUR: FieldSpec = { label: 'hour', min: 0, max: 23 }
const DAY_OF_MONTH: FieldSpec = { label: 'day of month', min: 1, max: 31 }
const MONTH: FieldSpec = { label: 'month', min: 1, max: 12, aliases: MONTH_ALIASES }
const DAY_OF_WEEK: FieldSpec = {
  label: 'day of week',
  min: 0,
  // 7 is Sunday as well as 0, which vixie cron accepts and systemd never sees.
  max: 7,
  aliases: WEEKDAY_ALIASES,
}

/** One comma-separated item, before it becomes systemd syntax. */
type FieldItem =
  | { kind: 'all' }
  | { kind: 'single'; value: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'step'; from: number; to: number; step: number; wholeField: boolean }

function readFieldValue(
  raw: string,
  spec: FieldSpec,
): number | null {
  const token = raw.trim().toLowerCase()
  if (token.length === 0) return null
  const alias = spec.aliases?.[token]
  if (alias !== undefined) return alias
  if (!/^\d{1,2}$/.test(token)) return null
  const value = Number(token)
  if (value < spec.min || value > spec.max) return null
  return value
}

/** The `/N` suffix, bounded by the field's own range. */
function parseStepSuffix(
  raw: string,
  stepRaw: string,
  spec: FieldSpec,
): CronParseResult<number> {
  if (!/^\d{1,3}$/.test(stepRaw) || Number(stepRaw) < 1) {
    return fail(`"${raw}" has an invalid step for the ${spec.label}`)
  }
  const step = Number(stepRaw)
  if (step > spec.max - spec.min + 1) {
    return fail(
      `"${raw}" steps by more than the whole ${spec.label} range`,
    )
  }
  return { ok: true, value: step }
}

/** `*` or `*` with a step: the item spans the whole field. */
function wholeFieldItem(
  spec: FieldSpec,
  step: number | undefined,
): CronParseResult<FieldItem> {
  if (step === undefined) return { ok: true, value: { kind: 'all' } }
  return {
    ok: true,
    value: {
      kind: 'step',
      from: spec.min,
      to: spec.max,
      step,
      wholeField: true,
    },
  }
}

/** `5`, `5-9`, `5/10`, `5-9/2` — an item anchored at a real value. */
function parseAnchoredItem(
  raw: string,
  body: string,
  spec: FieldSpec,
  step: number | undefined,
): CronParseResult<FieldItem> {
  const [fromRaw, toRaw, ...rest] = body.split('-')
  if (rest.length > 0 || fromRaw === undefined) {
    return fail(`"${raw}" is not a valid ${spec.label}`)
  }
  const from = readFieldValue(fromRaw, spec)
  if (from === null) return fail(`"${raw}" is not a valid ${spec.label}`)

  if (toRaw === undefined) {
    if (step === undefined) {
      return { ok: true, value: { kind: 'single', value: from } }
    }
    // `5/10` is vixie's "from 5, every 10, to the end of the field".
    return {
      ok: true,
      value: { kind: 'step', from, to: spec.max, step, wholeField: false },
    }
  }

  const to = readFieldValue(toRaw, spec)
  if (to === null) return fail(`"${raw}" is not a valid ${spec.label}`)
  if (to < from) {
    // Wrapping ranges (`fri-mon`) are a vixie extension with no systemd
    // equivalent; rejecting beats silently reordering into `mon..fri`, which is
    // a different set of days.
    return fail(
      `"${raw}" runs backwards; write it as two items (e.g. "5-6,0") instead`,
    )
  }
  if (step === undefined) return { ok: true, value: { kind: 'range', from, to } }
  return { ok: true, value: { kind: 'step', from, to, step, wholeField: false } }
}

function parseFieldItem(
  raw: string,
  spec: FieldSpec,
): CronParseResult<FieldItem> {
  const [body, stepRaw, ...extra] = raw.split('/')
  if (extra.length > 0 || body === undefined) {
    return fail(`"${raw}" is not a valid ${spec.label}`)
  }

  let step: number | undefined
  if (stepRaw !== undefined) {
    const parsed = parseStepSuffix(raw, stepRaw, spec)
    if (!parsed.ok) return parsed
    step = parsed.value
  }

  if (body.trim() === '*') return wholeFieldItem(spec, step)
  return parseAnchoredItem(raw, body, spec, step)
}

function parseField(
  raw: string,
  spec: FieldSpec,
): CronParseResult<FieldItem[]> {
  const items: FieldItem[] = []
  for (const part of raw.split(',')) {
    const item = parseFieldItem(part, spec)
    if (!item.ok) return item
    items.push(item.value)
  }
  return { ok: true, value: items }
}

/** True when the field constrains anything at all. */
function isRestricted(items: readonly FieldItem[]): boolean {
  return !items.some((item) => item.kind === 'all')
}

/** Render a numeric field (minute, hour, day, month) in systemd syntax. */
function renderNumericField(items: readonly FieldItem[]): string {
  if (!isRestricted(items)) return '*'
  return items
    .map((item) => {
      switch (item.kind) {
        case 'single':
          return String(item.value)
        case 'range':
          return `${item.from}..${item.to}`
        case 'step':
          // Always `start/step`, never `*/step`: the explicit start is
          // unambiguous across systemd versions and reads the same as the
          // range form beside it.
          return item.wholeField
            ? `${item.from}/${item.step}`
            : `${item.from}..${item.to}/${item.step}`
        default:
          return '*'
      }
    })
    .join(',')
}

/**
 * Render the weekday field as systemd names.
 *
 * systemd has no repetition on weekdays, so a step here is refused rather than
 * approximated — "every other Tuesday" is not a thing a calendar event can say.
 */
function renderWeekdayField(
  items: readonly FieldItem[],
): CronParseResult<string> {
  if (!isRestricted(items)) return { ok: true, value: '' }
  const names: string[] = []
  const nameOf = (value: number) => WEEKDAY_NAMES[value === 7 ? 0 : value]
  for (const item of items) {
    if (item.kind === 'step') {
      return fail(
        'a step in the day-of-week field has no systemd equivalent; list the days instead (e.g. "mon,wed,fri")',
      )
    }
    if (item.kind === 'single') {
      names.push(nameOf(item.value) as string)
      continue
    }
    if (item.kind === 'range') {
      // `5-7` spans Friday..Sunday, which wraps once 7 folds to 0. Expanding to
      // a list keeps the meaning without relying on systemd range semantics.
      for (let value = item.from; value <= item.to; value += 1) {
        names.push(nameOf(value) as string)
      }
    }
  }
  const unique = [...new Set(names)]
  // Sorted into week order so two spellings of one schedule render identically
  // and the unchanged-content rule keeps holding.
  unique.sort(
    (a, b) => WEEKDAY_NAMES.indexOf(a as never) - WEEKDAY_NAMES.indexOf(b as never),
  )
  return { ok: true, value: unique.join(',') }
}

/**
 * Translate a 5-field cron expression into a systemd `OnCalendar` value.
 *
 * Seconds are always `00`: cron has no sub-minute resolution, and emitting `*`
 * there would turn every job into a per-second timer.
 */
/** `@daily` and friends, expanded to the five-field expression they stand for. */
function expandCronAlias(trimmed: string): CronParseResult<string> {
  const lowered = trimmed.toLowerCase()
  const alias = CRON_ALIASES[lowered]
  if (alias !== undefined) return { ok: true, value: alias }
  if (lowered === '@reboot') {
    return fail(
      '`@reboot` is not a schedule a timer can express. Use a real time, or run the work from the service itself on start.',
    )
  }
  return fail(
    `unknown shorthand "${trimmed}" — supported: ${
      Object.keys(CRON_ALIASES).join(', ')
    }`,
  )
}

/** The five cron fields, parsed, in cron order. */
type CronFields = {
  minute: FieldItem[]
  hour: FieldItem[]
  dom: FieldItem[]
  month: FieldItem[]
  dow: FieldItem[]
}

/** All five fields, or the first one that did not parse. */
function parseCronFields(trimmed: string): CronParseResult<CronFields> {
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    return fail(
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    )
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]

  const minute = parseField(minuteRaw, MINUTE)
  if (!minute.ok) return minute
  const hour = parseField(hourRaw, HOUR)
  if (!hour.ok) return hour
  const dom = parseField(domRaw, DAY_OF_MONTH)
  if (!dom.ok) return dom
  const month = parseField(monthRaw, MONTH)
  if (!month.ok) return month
  const dow = parseField(dowRaw, DAY_OF_WEEK)
  if (!dow.ok) return dow

  return {
    ok: true,
    value: {
      minute: minute.value,
      hour: hour.value,
      dom: dom.value,
      month: month.value,
      dow: dow.value,
    },
  }
}

/**
 * Validate a stored scheduled-task cron expression.
 *
 * Accepts standard five-field cron and the supported `@hourly` / `@daily` /
 * … aliases, and keeps the authored string. Unlike {@link cronToOnCalendar},
 * this does **not** refuse a day-of-month **and** day-of-week restriction:
 * that union is valid cron, and a task row is configuration only — nothing
 * is translated to a systemd timer yet.
 */
export function parseCronSchedule(input: unknown): CronParseResult<string> {
  if (typeof input !== 'string') return fail('a schedule must be text')
  const trimmed = input.trim()
  if (trimmed.length === 0) return fail('a schedule is required')
  if (trimmed.length > 200) return fail('that schedule is too long to be one')

  if (trimmed.startsWith('@')) {
    const alias = expandCronAlias(trimmed)
    if (!alias.ok) return alias
    return { ok: true, value: trimmed }
  }

  const parsed = parseCronFields(trimmed)
  if (!parsed.ok) return parsed
  return { ok: true, value: trimmed }
}

/**
 * Translate a cron expression into a systemd `OnCalendar` value.
 *
 * `timezone` is an optional IANA identifier. systemd accepts one as a trailing
 * field on the calendar spec (`Mon *-*-* 03:00:00 Europe/Berlin`), and doing it
 * here keeps the module's promise that cron is translated in exactly one place:
 * the daemon validates the string it is handed and renders it, it never parses
 * a zone itself. Omitted means the host's local time, which is what a timer
 * with no zone has always meant.
 */
export function cronToOnCalendar(
  input: unknown,
  timezone?: string | null,
): CronParseResult<string> {
  if (typeof input !== 'string') return fail('a schedule must be text')
  const trimmed = input.trim()
  if (trimmed.length === 0) return fail('a schedule is required')
  if (trimmed.length > 200) return fail('that schedule is too long to be one')

  if (timezone !== undefined && timezone !== null && !isValidTimezone(timezone)) {
    return fail('that is not a timezone name systemd will accept')
  }

  if (trimmed.startsWith('@')) {
    const alias = expandCronAlias(trimmed)
    return alias.ok ? cronToOnCalendar(alias.value, timezone) : alias
  }

  const parsed = parseCronFields(trimmed)
  if (!parsed.ok) return parsed
  const { minute, hour, dom, month, dow } = parsed.value

  // The whole reason this module rejects rather than approximates. See the file
  // header: cron unions these two fields, systemd intersects them, and no
  // `OnCalendar` string expresses the union.
  if (isRestricted(dom) && isRestricted(dow)) {
    return fail(
      'cron runs a job when the day-of-month **or** the day-of-week matches; a systemd timer needs both to match. Restrict one field and leave the other as "*", or split this into two jobs.',
    )
  }

  const weekday = renderWeekdayField(dow)
  if (!weekday.ok) return weekday

  const date = `*-${renderNumericField(month)}-${renderNumericField(dom)}`
  const time = `${renderNumericField(hour)}:${renderNumericField(minute)}:00`
  const prefix = weekday.value.length > 0 ? `${weekday.value} ` : ''
  const zone = timezone ? ` ${timezone}` : ''
  return { ok: true, value: `${prefix}${date} ${time}${zone}` }
}

/**
 * Characters that mean something to a shell and nothing to `ExecStart`.
 *
 * systemd runs the command directly — there is no shell, so `>>`, `&&`, `|`,
 * globs, and substitutions are inert text rather than syntax. Accepting them
 * would let an operator write a line that looks like it redirects output and
 * silently passes `>>` to their script as an argument.
 */
const SHELL_METACHARACTERS = /[|&;<>()$`\\"'*?[\]{}~\n\r\0]/

/** Bare names the platform will resolve to an absolute path. */
const KNOWN_COMMANDS: Readonly<Record<string, string>> = {
  // The series dispatcher. Runs *after* systemd drops to `User=`, so which PHP
  // it resolves — and whether it may run PHP at all — comes from the account's
  // own entitlement groups. That is the cleanest proof entitlement had to be an
  // OS grant rather than something baked into a generated unit.
  php: '/usr/local/bin/php',
}

/**
 * Parse a command line into argv for `ExecStart`.
 *
 * Not a shell parser and deliberately not shell-quoting-aware: the doctrine
 * everywhere in this codebase is validate-then-reject, never escape. An
 * operator who needs a pipeline writes a script and runs the script.
 */
export function parseCronCommand(input: unknown): CronParseResult<string[]> {
  if (typeof input !== 'string') return fail('a command must be text')
  const trimmed = input.trim()
  if (trimmed.length === 0) return fail('a command is required')
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return fail(`a command must be under ${MAX_COMMAND_LENGTH} characters`)
  }
  const offending = SHELL_METACHARACTERS.exec(trimmed)
  if (offending) {
    return fail(
      `"${offending[0]}" cannot be used here — the command runs directly, with no shell, so redirection, pipes, and globs are not available. Put them in a script and run that instead. Output is captured for you.`,
    )
  }

  const argv = trimmed.split(/\s+/).filter((token) => token.length > 0)
  if (argv.some((token) => token.length > MAX_ARG_LENGTH)) {
    return fail(`each argument must be under ${MAX_ARG_LENGTH} characters`)
  }

  const [command, ...args] = argv as [string, ...string[]]
  const known = KNOWN_COMMANDS[command]
  if (known) return { ok: true, value: [known, ...args] }
  if (!command.startsWith('/')) {
    return fail(
      `"${command}" must be an absolute path (systemd does not search PATH). Known shortcuts: ${
        Object.keys(KNOWN_COMMANDS).join(', ')
      }.`,
    )
  }
  if (command.split('/').includes('..')) {
    return fail(`"${command}" must not contain ".."`)
  }
  return { ok: true, value: argv }
}
