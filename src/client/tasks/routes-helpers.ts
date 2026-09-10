import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { nowIso } from '../../lib/commands/ids.ts'
import {
  MAX_CRON_TIMEOUT_SECONDS,
  parseCronCommand,
  parseCronSchedule,
} from '../../lib/cron.ts'
import {
  parseTaskNameInput,
  TASK_CONCURRENCY_POLICIES,
  type TaskConcurrencyPolicy,
  type TaskUpdateFields,
} from '../../lib/db/task-records.ts'
import { isAllowedTimezone } from '../../lib/timezones.ts'
import { parseJsonbObject } from '../shared.ts'

export { MAX_CRON_JOBS_PER_SERVICE } from '../../lib/cron.ts'

/**
 * Longest accepted timeout: 24 hours.
 *
 * Aliased from `lib/cron.ts` rather than restated, so the value the API accepts
 * and the value the deploy wire parser enforces cannot drift apart.
 */
export const MAX_TASK_TIMEOUT_SECONDS = MAX_CRON_TIMEOUT_SECONDS

export type TaskListFilters = {
  serviceId?: string
  environmentId?: string
}

export type TaskCreateFields = {
  name: string
  schedule: string
  command: string
  timezone?: string | null
  concurrencyPolicy?: TaskConcurrencyPolicy
  timeoutSeconds?: number | null
  isEnabled?: boolean
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
}

type TaskPatchBodyKey = Exclude<keyof TaskUpdateFields, 'updatedAt'>

export function parseTaskName(
  c: Context<AppEnv>,
  value: unknown,
): string | Response {
  const parsed = parseTaskNameInput(value)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400)
  }
  return parsed.name
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isTaskUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function invalidTaskIdResponse(
  c: Context<AppEnv>,
  id: string,
  kind: 'path' | 'query',
): Response | null {
  if (isTaskUuid(id)) return null
  if (kind === 'path') {
    return c.json({ error: 'Not found' }, 404)
  }
  return c.json({ error: 'Invalid request' }, 400)
}

export function parseTaskSchedule(
  c: Context<AppEnv>,
  value: unknown,
): string | Response {
  const result = parseCronSchedule(value)
  if (!result.ok) {
    return c.json({ error: 'task_schedule_invalid', message: result.error }, 400)
  }
  return result.value
}

export function parseTaskCommand(
  c: Context<AppEnv>,
  value: unknown,
): string | Response {
  const result = parseCronCommand(value)
  if (!result.ok) {
    return c.json({ error: 'task_command_invalid', message: result.error }, 400)
  }
  return typeof value === 'string' ? value.trim() : String(value)
}

export function parseTaskTimezone(
  c: Context<AppEnv>,
  value: unknown,
): string | null | Response | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const timezone = value.trim()
  if (timezone.length === 0) return null
  if (!isAllowedTimezone(timezone)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return timezone
}

export function parseTaskConcurrencyPolicy(
  c: Context<AppEnv>,
  value: unknown,
): TaskConcurrencyPolicy | Response | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !(TASK_CONCURRENCY_POLICIES as readonly string[]).includes(value)
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value as TaskConcurrencyPolicy
}

export function parseTaskTimeoutSeconds(
  c: Context<AppEnv>,
  value: unknown,
): number | null | Response | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_TASK_TIMEOUT_SECONDS
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export function parseTaskIsEnabled(
  c: Context<AppEnv>,
  value: unknown,
): boolean | Response | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export function parseTaskListFilters(
  c: Context<AppEnv>,
): TaskListFilters | Response {
  const serviceId = c.req.query('serviceId')
  const environmentId = c.req.query('environmentId')
  if (serviceId && environmentId) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (serviceId) {
    const invalid = invalidTaskIdResponse(c, serviceId, 'query')
    if (invalid) return invalid
    return { serviceId }
  }
  if (environmentId) {
    const invalid = invalidTaskIdResponse(c, environmentId, 'query')
    if (invalid) return invalid
    return { environmentId }
  }
  return {}
}

function parseTaskRequiredCreateFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Pick<TaskCreateFields, 'name' | 'schedule' | 'command'> | Response {
  const name = parseTaskName(c, body.name)
  if (name instanceof Response) return name
  const schedule = parseTaskSchedule(c, body.schedule)
  if (schedule instanceof Response) return schedule
  const command = parseTaskCommand(c, body.command)
  if (command instanceof Response) return command
  return { name, schedule, command }
}

export function parseTaskCreateFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): TaskCreateFields | Response {
  const required = parseTaskRequiredCreateFields(c, body)
  if (required instanceof Response) return required

  const timezone = parseTaskTimezone(c, body.timezone)
  if (timezone instanceof Response) return timezone
  const concurrencyPolicy = parseTaskConcurrencyPolicy(c, body.concurrencyPolicy)
  if (concurrencyPolicy instanceof Response) return concurrencyPolicy
  const timeoutSeconds = parseTaskTimeoutSeconds(c, body.timeoutSeconds)
  if (timeoutSeconds instanceof Response) return timeoutSeconds
  const isEnabled = parseTaskIsEnabled(c, body.isEnabled)
  if (isEnabled instanceof Response) return isEnabled
  const metadata = parseJsonbObject(c, body, 'metadata')
  if (metadata instanceof Response) return metadata
  const options = parseJsonbObject(c, body, 'options')
  if (options instanceof Response) return options

  return applyOptionalCreateFields({ ...required }, {
    timezone,
    concurrencyPolicy,
    timeoutSeconds,
    isEnabled,
    metadata,
    options,
  })
}

function applyOptionalCreateFields(
  fields: TaskCreateFields,
  extras: {
    timezone: string | null | undefined
    concurrencyPolicy: TaskConcurrencyPolicy | undefined
    timeoutSeconds: number | null | undefined
    isEnabled: boolean | undefined
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
  },
): TaskCreateFields {
  if (extras.timezone !== undefined) fields.timezone = extras.timezone
  if (extras.concurrencyPolicy !== undefined) {
    fields.concurrencyPolicy = extras.concurrencyPolicy
  }
  if (extras.timeoutSeconds !== undefined) fields.timeoutSeconds = extras.timeoutSeconds
  if (extras.isEnabled !== undefined) fields.isEnabled = extras.isEnabled
  if (extras.metadata !== null) fields.metadata = extras.metadata
  if (extras.options !== null) fields.options = extras.options
  return fields
}

function patchHasOnlyUpdatedAt(updateFields: Record<string, unknown>): boolean {
  return Object.keys(updateFields).length === 1
}

const TASK_PATCH_FIELDS: ReadonlyArray<{
  key: TaskPatchBodyKey
  parse: (c: Context<AppEnv>, body: Record<string, unknown>) => unknown
}> = [
  { key: 'name', parse: (c, body) => parseTaskName(c, body.name) },
  { key: 'schedule', parse: (c, body) => parseTaskSchedule(c, body.schedule) },
  { key: 'command', parse: (c, body) => parseTaskCommand(c, body.command) },
  { key: 'timezone', parse: (c, body) => parseTaskTimezone(c, body.timezone) },
  {
    key: 'concurrencyPolicy',
    parse: (c, body) => parseTaskConcurrencyPolicy(c, body.concurrencyPolicy),
  },
  {
    key: 'timeoutSeconds',
    parse: (c, body) => parseTaskTimeoutSeconds(c, body.timeoutSeconds),
  },
  { key: 'isEnabled', parse: (c, body) => parseTaskIsEnabled(c, body.isEnabled) },
  { key: 'metadata', parse: (c, body) => parseJsonbObject(c, body, 'metadata') },
  { key: 'options', parse: (c, body) => parseJsonbObject(c, body, 'options') },
]

export function buildTaskPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): TaskUpdateFields | Response {
  const updateFields: TaskUpdateFields = {
    updatedAt: nowIso(),
  }

  for (const { key, parse } of TASK_PATCH_FIELDS) {
    if (body[key] === undefined) continue
    const parsed = parse(c, body)
    if (parsed instanceof Response) return parsed
    Object.assign(updateFields, { [key]: parsed ?? null })
  }

  if (patchHasOnlyUpdatedAt(updateFields)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return updateFields
}
