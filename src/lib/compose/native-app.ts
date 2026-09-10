/**
 * Split native `serviceKind: node` services out of a compose services map.
 *
 * A `node` service is neither a Docker container nor a document root: the Git
 * release engine publishes it into `<principalHome>/sites/<serviceId>/current`
 * exactly like any other release, and the daemon supervises it with a generated
 * `turbopanel-app-<serviceId>.service` unit listening on an allocated loopback
 * port. Hosting Caddy reverse-proxies to that port the same way it already does
 * for a site vhost — which is precisely why the port allocator here
 * is the site one, driven from a **shared** used-port ledger.
 */

import {
  type ComposeServiceCronJob,
  type ComposeServiceTurbopanelExtension,
  isNodeComposeService,
  type NativeRuntimeFramework,
  type NodeAppMode,
  readServiceTurbopanelExtension,
} from './service-kind.ts'
import { allocateSiteListenPort } from './site.ts'

/**
 * `services.<name>.deploy.restart_policy`, as authored.
 *
 * A plain Compose key, not an `x-turbopanel` one — which is exactly why it has
 * to be read here. A Docker service keeps `deploy.restart_policy` in the
 * compiled runtime document (`field-policy.ts` marks it `interpreted` + `keep`)
 * and `docker compose up` acts on it; a `serviceKind: node` service is removed
 * from the compose document altogether and supervised by a generated systemd
 * unit, so unless the policy is read out here an author who wrote one is left
 * with a field nothing on this lane can ever see.
 *
 * `condition` is the Compose vocabulary (`none` / `on-failure` / `any`), never
 * systemd's: reading the key is a compiler concern, and translating it into
 * unit directives is the daemon's. This shape rides the wire verbatim as
 * `EnvironmentDeployNativeAppRestartPolicy` (`../commands/schemas.ts`), and
 * `turbopaneld/src/deploy/native/unit.ts` is the single place the Compose
 * vocabulary becomes `Restart=` / `RestartSec=` / `StartLimitBurst=` /
 * `StartLimitIntervalSec=`.
 */
export type NativeAppRestartPolicy = {
  condition?: 'none' | 'on-failure' | 'any'
  /** Compose duration (`5s`, `1m30s`). */
  delay?: string
  /** Positive count; at least 1. */
  maxAttempts?: number
  /** Compose duration. */
  window?: string
}

export type NativeAppServiceSpec = {
  composeServiceName: string
  /** Resolved runtime family; `auto` leaves detection to the daemon build. */
  framework: NativeRuntimeFramework
  /** Loopback listen port for hosting Caddy → the app process. */
  listenPort: number
  /** Operator-pinned Node series, when the author declared one. */
  nodeVersion?: string
  /** `NODE_ENV` for build and unit. Omitted means `production`. */
  appMode?: NodeAppMode
  /**
   * Omitted means `true`. A disabled app is still emitted — dropping it would
   * make the daemon reconcile tear the unit down and strand the release; the
   * daemon stops and disables the unit instead of starting it.
   */
  enabled?: boolean
  /** Script run when `source.startCommand` is absent. Default `server.js`. */
  startupFile?: string
  /**
   * Authored `deploy.restart_policy`, when the document set one. Absent means
   * the document said nothing about supervision — see
   * {@link NativeAppRestartPolicy}.
   */
  /**
   * Authored `x-turbopanel.cron[]`, untranslated.
   *
   * `cron` has always been legal on `serviceKind: node` (`HOST_NATIVE_KINDS`),
   * but this split used to drop it, so a Next.js app's jobs passed the linter
   * and never reached a host. Carried here in the shape the author wrote;
   * deploy-prepare translates it exactly once, the same call sites use.
   */
  cron?: ComposeServiceCronJob[]
  restartPolicy?: NativeAppRestartPolicy
  /**
   * Authored `deploy.labels`, when the document set any.
   *
   * Compose keeps *service* metadata (`deploy.labels`) and *container*
   * metadata (`labels:`) in two namespaces, and so does TurboPanel — the
   * compiler never merges one into the other, an invariant pinned by
   * `compile-runtime.hostfree.test.ts`. On the Docker lane the authored block
   * simply stays under `services.<name>.deploy.labels` in the runtime document.
   * A `node` service is removed from that document altogether, so without this
   * field the same authored metadata would exist on one lane and vanish on the
   * other. It rides the deploy payload as
   * `EnvironmentDeployNativeAppService.serviceLabels`
   * (`../commands/schemas.ts`) and is recorded on the generated unit as
   * `X-TurboPanel-Labels`, so `systemctl show` answers on the native lane what
   * `docker inspect` answers on the container one. Named `serviceLabels`
   * rather than `labels` precisely so no later reader mistakes it for the
   * container's own.
   */
  serviceLabels?: Record<string, string>
}

/** Framework when `x-turbopanel.framework` is omitted. */
export const NATIVE_APP_DEFAULT_FRAMEWORK: NativeRuntimeFramework = 'auto'

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `deploy.restart_policy.condition` vocabulary a generated unit can express.
 *
 * Exported because `./lint.ts` refuses anything outside it *before* the deploy
 * reaches this module, and a second hand-written copy of the vocabulary in the
 * linter is exactly the drift that lets the two disagree.
 */
export const NATIVE_APP_RESTART_CONDITIONS: ReadonlySet<string> = new Set([
  'none',
  'on-failure',
  'any',
])

/** Compose duration: one or more `<number><unit>` pairs (`5s`, `1m30s`). */
export const NATIVE_APP_RESTART_DURATION_RE =
  /^(\d+(?:\.\d+)?(?:us|ms|s|m|h))+$/

/** True when `value` names a condition the generated unit can express. */
export function isNativeAppRestartCondition(value: unknown): boolean {
  return typeof value === 'string' &&
    NATIVE_APP_RESTART_CONDITIONS.has(value.trim())
}

/** True when `value` is a Compose duration the unit renderer can carry. */
export function isNativeAppRestartDuration(value: unknown): boolean {
  return typeof value === 'string' &&
    NATIVE_APP_RESTART_DURATION_RE.test(value.trim())
}

/**
 * True when `value` is a retry budget the unit can express — a whole count of
 * at least one.
 *
 * `max_attempts: 0` is **not** one. It would render as `StartLimitBurst=0`,
 * which systemd reads as *no* rate limit — the exact opposite of "do not
 * retry". A field that inverts its own meaning on the way to the host cannot be
 * forwarded, and it cannot be dropped either, so `./lint.ts` refuses the
 * document.
 */
export function isNativeAppRestartMaxAttempts(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) && Number.parseInt(trimmed, 10) >= 1
}

function restartDuration(value: unknown): string | undefined {
  return isNativeAppRestartDuration(value)
    ? (value as string).trim()
    : undefined
}

function restartMaxAttempts(value: unknown): number | undefined {
  if (!isNativeAppRestartMaxAttempts(value)) return undefined
  return typeof value === 'number'
    ? value
    : Number.parseInt((value as string).trim(), 10)
}

/** An authored `restart_policy` key, named as the document spells it. */
export type NativeAppRestartPolicyField =
  | 'condition'
  | 'delay'
  | 'max_attempts'
  | 'window'

/**
 * The outcome of reading `deploy.restart_policy` off a `node` service.
 *
 * Two fields rather than one, because "what can be carried" and "what was
 * authored and cannot be" are different answers and the caller needs both. An
 * earlier version returned only the policy and let every unhonourable value
 * fall on the floor — so `max_attempts: 0` or `delay: soon` produced a unit
 * running on defaults, with nothing said anywhere.
 */
export type NativeAppRestartPolicyRead = {
  /** What the generated unit can express, or absent when nothing usable was set. */
  policy?: NativeAppRestartPolicy
  /**
   * Authored keys this lane cannot honour, in document spelling.
   *
   * `./lint.ts` raises one `field_unsupported` diagnostic per entry and
   * `./validate-for-deploy.ts` turns those into a refusal, so a real deploy
   * never reaches {@link splitNativeAppServices} with a non-empty list. It is
   * still returned rather than assumed empty: the reader is the definition of
   * what the lane can carry, and a caller that skipped the linter has to be
   * able to see what it would have said.
   */
  unsupported: NativeAppRestartPolicyField[]
}

/**
 * Read `deploy.restart_policy` off a raw compose service.
 *
 * Only keys the document actually authored are kept — no defaults are
 * synthesized here, because an absent field has to stay distinguishable from
 * one set to what happens to be the current default. The unit renderer is what
 * decides what "absent" means, and it already has a defensible answer.
 *
 * An authored value the lane cannot express is reported in
 * {@link NativeAppRestartPolicyRead.unsupported} rather than discarded.
 */
export function readNativeAppRestartPolicy(
  raw: Record<string, unknown>,
): NativeAppRestartPolicyRead {
  if (!isPlainMapping(raw.deploy)) return { unsupported: [] }
  const authored = raw.deploy.restart_policy
  if (authored === undefined || authored === null) return { unsupported: [] }
  // A `restart_policy` that is not a mapping is the Compose schema's to
  // report; this reader has no field-level answer for it.
  if (!isPlainMapping(authored)) return { unsupported: [] }

  const unsupported: NativeAppRestartPolicyField[] = []
  const keep = <T>(
    field: NativeAppRestartPolicyField,
    value: unknown,
    read: (value: unknown) => T | undefined,
  ): T | undefined => {
    if (value === undefined) return undefined
    const parsed = read(value)
    if (parsed === undefined) unsupported.push(field)
    return parsed
  }

  const condition = keep(
    'condition',
    authored.condition,
    (value) =>
      isNativeAppRestartCondition(value)
        ? (value as string).trim() as NativeAppRestartPolicy['condition']
        : undefined,
  )
  const delay = keep('delay', authored.delay, restartDuration)
  const maxAttempts = keep(
    'max_attempts',
    authored.max_attempts,
    restartMaxAttempts,
  )
  const window = keep('window', authored.window, restartDuration)

  if (
    condition === undefined && delay === undefined &&
    maxAttempts === undefined && window === undefined
  ) {
    return { unsupported }
  }
  return {
    policy: {
      ...(condition === undefined ? {} : { condition }),
      ...(delay === undefined ? {} : { delay }),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      ...(window === undefined ? {} : { window }),
    },
    unsupported,
  }
}

/**
 * Read `deploy.labels` off a raw compose service.
 *
 * Both Compose spellings are accepted, because both are valid Compose and an
 * author who picked the list form did not thereby ask for their metadata to be
 * dropped: a mapping (`com.example.team: platform`) and a sequence of
 * `KEY=VALUE` strings. A sequence entry with no `=` is a bare key, which
 * Compose reads as an empty value.
 *
 * The result is *service* metadata. It never becomes container `labels:` — see
 * {@link NativeAppServiceSpec.serviceLabels}.
 */
export function readNativeAppServiceLabels(
  raw: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!isPlainMapping(raw.deploy)) return undefined
  const authored = raw.deploy.labels

  let labels: Record<string, string>
  if (isPlainMapping(authored)) {
    labels = serviceLabelsFromMapping(authored)
  } else if (Array.isArray(authored)) {
    labels = serviceLabelsFromSequence(authored)
  } else {
    return undefined
  }

  return Object.keys(labels).length > 0 ? labels : undefined
}

function serviceLabelsFromMapping(
  authored: Record<string, unknown>,
): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const [key, value] of Object.entries(authored)) {
    if (key.length === 0) continue
    if (value === null || value === undefined) {
      labels[key] = ''
      continue
    }
    // Allow-list the scalar types worth stringifying, rather than excluding
    // `object`: the narrower guard is what tells a static analyzer `value`
    // can no longer be a bare object collapsing to `[object Object]` below.
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      continue
    }
    labels[key] = String(value)
  }
  return labels
}

function serviceLabelsFromSequence(
  authored: readonly unknown[],
): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const entry of authored) {
    if (typeof entry !== 'string') continue
    const separator = entry.indexOf('=')
    const key = (separator === -1 ? entry : entry.slice(0, separator)).trim()
    if (key.length === 0) continue
    labels[key] = separator === -1 ? '' : entry.slice(separator + 1)
  }
  return labels
}

export type SplitNativeAppResult = {
  /** Services that remain for Docker Compose (native apps removed). */
  containerServices: Record<string, unknown>
  apps: NativeAppServiceSpec[]
}

/**
 * Partition compose `services`, pulling `serviceKind: node` entries out into
 * {@link NativeAppServiceSpec} rows.
 *
 * `usedPorts` must be the same set the site split used — see
 * `splitSiteServices`. Passing a fresh set is only correct when the
 * caller knows there are no sites in the same document.
 */
export function splitNativeAppServices(
  services: Record<string, unknown>,
  usedPorts: Set<number> = new Set<number>(),
  preferredListenPortByService: ReadonlyMap<string, number> = new Map(),
): SplitNativeAppResult {
  const containerServices: Record<string, unknown> = {}
  const apps: NativeAppServiceSpec[] = []

  const names = Object.keys(services).sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    const raw = services[name]
    if (!isPlainMapping(raw) || !isNodeComposeService(raw)) {
      containerServices[name] = raw
      continue
    }

    const extension = readServiceTurbopanelExtension(raw)
    // Validation rejects a `node` service with no source; a document that slips
    // through anyway must still stay out of Docker — an image-less service
    // would just fail `compose up`.
    if (!extension?.source) continue

    apps.push(nativeAppSpecFor(
      name,
      raw,
      extension,
      allocateSiteListenPort(
        name,
        usedPorts,
        preferredListenPortByService.get(name),
      ),
    ))
  }

  return { containerServices, apps }
}

function nativeAppSpecFor(
  name: string,
  raw: Record<string, unknown>,
  extension: ComposeServiceTurbopanelExtension,
  listenPort: number,
): NativeAppServiceSpec {
  // `unsupported` is not consulted here: `./lint.ts` refuses those documents
  // at deploy time, so anything reaching this split has already been told
  // what this lane can carry.
  const { policy: restartPolicy } = readNativeAppRestartPolicy(raw)
  const serviceLabels = readNativeAppServiceLabels(raw)

  return {
    composeServiceName: name,
    framework: extension.framework ?? NATIVE_APP_DEFAULT_FRAMEWORK,
    listenPort,
    ...(extension.nodeVersion === undefined
      ? {}
      : { nodeVersion: extension.nodeVersion }),
    ...(extension.appMode === undefined ? {} : { appMode: extension.appMode }),
    ...(extension.enabled === undefined ? {} : { enabled: extension.enabled }),
    ...(extension.startupFile === undefined
      ? {}
      : { startupFile: extension.startupFile }),
    // Read from the service body, not from the extension: these are plain
    // Compose keys that would otherwise leave with the service when it is
    // pulled out of `containerServices` by the split above.
    ...(extension.cron === undefined ? {} : { cron: extension.cron }),
    ...(restartPolicy === undefined ? {} : { restartPolicy }),
    ...(serviceLabels === undefined ? {} : { serviceLabels }),
  }
}

/**
 * Re-allocate listen ports out of the shared ledger, so `used` (shared with
 * {@link assignSiteListenPorts}) cannot hand a site and an app the same port.
 * Returns a new array sorted by compose service name.
 *
 * `preferredListenPortByService` exists for symmetry with the site lane and is
 * empty for native apps in the deploy path: the app's port is TurboPanel's
 * allocation, and `x-turbopanel.hosting[].targetPort` is refused on
 * `serviceKind: node` rather than allowed to move it
 * (`buildNativeAppServicesForDeploy` in
 * `../../client/environments/deploy-routes-helpers.ts`).
 */
export function assignNativeAppListenPorts<
  T extends { composeServiceName: string; listenPort: number },
>(
  apps: readonly T[],
  preferredListenPortByService: ReadonlyMap<string, number> = new Map(),
  used: Set<number> = new Set<number>(),
): T[] {
  const sorted = [...apps].sort((a, b) =>
    a.composeServiceName.localeCompare(b.composeServiceName)
  )
  return sorted.map((app) => ({
    ...app,
    listenPort: allocateSiteListenPort(
      app.composeServiceName,
      used,
      preferredListenPortByService.get(app.composeServiceName),
    ),
  }))
}
