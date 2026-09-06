import type { Context, Env, Hono } from 'hono'
import { upgradeWebSocket } from 'hono/deno'
import type { WSContext } from 'hono/ws'
import type { DaemonCellRegistry } from './cell/contracts.ts'
import type { DaemonInboundEnvelope, DaemonMessage } from './cell/protocol.ts'
import {
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_WS_POLICY_VIOLATION_CLOSE,
  outboundEnvelopeToWireMessage,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from './cell/protocol.ts'
import type { DaemonJwtKeyring } from './authn/daemon-jwt-keyring.ts'
import { tryAssignColocatedDaemonToInstalledOrganization } from '../client/authn/install-state.ts'
import { getDb } from '../db.ts'
import type { Db } from '../db.ts'
import { compatLogError, compatLogWarn } from '../log-compat.ts'
import { cellTrace, daemonCellLog } from '../logger.ts'
import {
  onDaemonConnected,
  onDaemonDisconnected,
  onDaemonInbound,
  onDaemonUpdateResult,
} from './cell/control-plane-monitor.ts'
import { CLIENT_WS_PATH, DAEMON_WS_PATH, DEVELOPER_WS_PATH } from '../surfaces.ts'
import { resolveSelfHostedGeo } from '../lib/geo/self-hosted-geo-provider.ts'
import {
  DIRECT_ATTACH_SENTINEL,
  parseTrustedProxyCidrs,
  resolvePeerAddress,
} from '../lib/peer-address.ts'
import { resourcesFromDaemonPresence } from '../lib/db/server-metadata.ts'
import { touchServerMetadata } from '../server-registry.ts'
import { verifyDaemonJwt } from './authn/daemon-jwt.ts'
import { getServerDaemonStateByServerId, isDaemonKeyActive } from './authn/server-identity-db.ts'
import type { CommandQueue } from '../lib/commands/queue.ts'
import type { RateLimiter } from './rate-limit/contracts.ts'
import { handleManagedHaEvent } from '../client/managed/ha-event.ts'
import { recordTopologyGeneration } from '../client/servers/server-topology-records.ts'
import { createInboundWindowGate } from './rate-limit/inbound-window.ts'
import { daemonConnectRateLimitKey } from './rate-limit/keys.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import { resolveSession } from '../client/authn/middleware.ts'
import { isSuperadminRole } from '../client/authn/session-store.ts'
import { verifyLocalConsoleAuthorization } from '../developer/local-console-auth.ts'

/** Max idle block for outbox pump reads — keep low so new commands aren't stuck behind a long sleep. */
const OUTBOX_PUMP_BLOCK_MS = 250

/** Decode a Hono/Deno WS frame (`string | Blob | ArrayBufferLike`) to UTF-8 text. */
export async function wsMessageDataToString(
  data: string | Blob | ArrayBufferLike
): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return await data.text()
  return new TextDecoder().decode(data)
}

export function isClosedConnectionError(err: unknown): boolean {
  return /connection is closed/i.test(String(err))
}

function assignColocatedDaemonOnConnect(db: Db, registry: DaemonCellRegistry): void {
  void tryAssignColocatedDaemonToInstalledOrganization(db, registry).catch((err) => {
    compatLogError('ws', `failed to assign colocated server: ${String(err)}`)
  })
}

/**
 * After license invalidation, Redis purge cannot close the live socket — reject
 * the next inbound frame when the JWT kid no longer matches an active key.
 */
async function assertDaemonKeyStillActive(
  db: Db,
  serverId: string,
  keyId: string,
  ws: WSContext<WebSocket>
): Promise<boolean> {
  const daemonRow = await getServerDaemonStateByServerId(db, serverId)
  if (daemonRow?.key.id !== keyId || !isDaemonKeyActive(daemonRow.key)) {
    cellTrace('inbound-key-revoked', { serverId, keyId })
    ws.close(DAEMON_WS_POLICY_VIOLATION_CLOSE, 'key_revoked')
    return false
  }
  return true
}

function startDaemonOutboxPump(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  serverId: string
  connectionId: string
  consumer: string
  ws: WSContext<WebSocket>
  abortRef: { abort: boolean }
}): void {
  const { cell, serverId, connectionId, consumer, ws, abortRef } = params

  void (async () => {
    while (!abortRef.abort) {
      try {
        const batch = await cell.readOutboxBatch({
          consumer,
          count: 50,
          blockMs: OUTBOX_PUMP_BLOCK_MS,
        })
        for (const envelope of batch) {
          const wireMsg = outboundEnvelopeToWireMessage(envelope)
          await cell.markSent(envelope.deliveryId, connectionId)
          cellTrace('outbox-send', {
            serverId,
            conn: connectionId,
            deliveryId: envelope.deliveryId,
            requestId: envelope.requestId,
            kind: envelope.kind,
          })
          ws.send(JSON.stringify(wireMsg))
          await cell.ackOutbox([envelope.deliveryId], consumer)
        }
        if (batch.length > 0) {
          await cell.putSnapshot({
            lastOutboundAt: new Date().toISOString(),
          })
        }
      } catch (err) {
        if (abortRef.abort) {
          break
        }
        if (isClosedConnectionError(err)) {
          abortRef.abort = true
          break
        }
        compatLogWarn('ws', `outbox pump error: ${String(err)}`)
      }
    }
  })()
}

function detachDaemonSocketSafe(
  cell: ReturnType<DaemonCellRegistry['getCell']>,
  params: {
    connectionId: string
    reason: string
    closedAt: string
  },
  db: Db,
  serverId: string,
  connectionId: string | undefined
): void {
  void cell
    .detachDaemonSocket(params)
    .then(async () => {
      cellTrace('detach', {
        serverId,
        conn: connectionId,
        reason: params.reason,
      })
      await onDaemonDisconnected(db, serverId, cell)
      daemonCellLog('INFO', serverId, connectionId, 'daemon disconnected')
    })
    .catch((err) => {
      if (isClosedConnectionError(err)) {
        return
      }
      compatLogWarn('ws', `detachDaemonSocket failed: ${String(err)}`)
    })
}

/**
 * Handle the wire cell ping: pong immediately, refresh presence, and repair a
 * Postgres-only false-offline that can linger after a prior Redis demotion.
 *
 * Exported for tests — this is the only frame an idle daemon sends.
 */
export async function handleDaemonCellPing(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  ws: WSContext<WebSocket>
}): Promise<void> {
  const { cell, db, serverId, connectionId, ws } = params
  const pingAt = new Date().toISOString()
  cellTrace('ping', { serverId, conn: connectionId })
  ws.send(DAEMON_CELL_PONG)
  cellTrace('pong', { serverId, conn: connectionId })
  // Snapshot before recordInbound: after a false Redis demotion the cell may
  // still show connected=0 so we can re-project Postgres online. recordInbound
  // alone self-heals Redis and would make a later inbound hit
  // steadyStateInboundSkipsDbRead while Postgres stays offline (UI shows Offline
  // despite a live socket).
  const snapshotBefore = await cell.getSnapshot()
  await cell.recordInbound({ connectionId, at: pingAt })
  if (!snapshotBefore.connected) {
    await onDaemonConnected(db, serverId, cell, snapshotBefore.connectedAt ?? pingAt)
    return
  }
  // Redis already connected — still repair Postgres-only false offline (stuck
  // after a prior demotion that self-healed Redis only).
  const daemonRow = await getServerDaemonStateByServerId(db, serverId)
  if (daemonRow?.status?.connected === false) {
    await onDaemonConnected(db, serverId, cell, snapshotBefore.connectedAt ?? pingAt)
  }
}

function rejectDaemonInboundFrame(
  ws: WSContext<WebSocket>,
  serverId: string,
  connectionId: string | undefined,
  reason: string
): void {
  cellTrace('inbound-rejected', {
    serverId,
    conn: connectionId,
    reason,
  })
  compatLogWarn('ws', `rejected inbound frame from ${connectionId ?? 'unknown'}: ${reason}`)
  ws.close(DAEMON_WS_POLICY_VIOLATION_CLOSE, 'policy_violation')
}

async function handleDaemonPresenceInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'hello' | 'heartbeat' }>
}): Promise<void> {
  const { cell, db, serverId, connectionId, message } = params
  const presence = message as unknown as Record<string, unknown>
  const resources = resourcesFromDaemonPresence(presence)

  if (message.type === 'hello') {
    await touchServerMetadata(db, serverId, {
      hostname: message.hostname,
      machineKey: message.machineKey,
      os: message.os,
      resources,
      timeSync: message.timeSync,
      docker: message.docker,
    })
  } else if (message.timeSync || resources !== undefined || message.docker) {
    await touchServerMetadata(db, serverId, {
      resources,
      timeSync: message.timeSync,
      docker: message.docker,
    })
  }

  await cell.recordInbound({
    connectionId,
    at: message.at,
    daemonBuild: message.daemonBuild,
  })
  await onDaemonInbound(db, serverId, cell, {
    at: message.at,
    daemonBuild: message.daemonBuild,
  })
}

async function handleDaemonManagedHaInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'managed-ha-event' }>
  commandQueue?: CommandQueue
  reporterServerId: string
}): Promise<void> {
  const { cell, db, connectionId, message } = params
  await handleManagedHaEvent(
    db,
    {
      managedId: message.managedId,
      sourceMemberId: message.sourceMemberId,
      at: message.at,
    },
    {
      commandQueue: params.commandQueue,
      reporterServerId: params.reporterServerId,
    }
  )
  await cell.recordInbound({ connectionId, at: message.at })
}

async function handleDaemonTopologyReportInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'topology-report' }>
  reporterServerId: string
}): Promise<void> {
  const { cell, db, connectionId, message } = params
  await recordTopologyGeneration(db, params.reporterServerId, {
    generation: message.generation,
    bootGeneration: message.bootGeneration,
    snapshot: message.snapshot,
    appliedAt: message.at,
  })
  await cell.recordInbound({ connectionId, at: message.at })
}

async function applyDaemonInboundEnvelope(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  envelope: DaemonInboundEnvelope
}): Promise<void> {
  const { cell, db, serverId, envelope } = params
  const record = await cell.handleInbound(envelope)
  if (envelope.kind !== 'update-result' || !record) return
  await onDaemonUpdateResult(
    db,
    serverId,
    envelope.requestId,
    envelope.ok,
    envelope.at,
    envelope.error
  )
}

export type DaemonWebSocketOptions = {
  developerSurface?: boolean
  db?: Db
  secrets?: DaemonJwtKeyring
  /** Session keyring used to authorize the placeholder client/developer WS. */
  sessionSecrets?: DerivedSecretsConfig
  daemonCellRegistry?: DaemonCellRegistry
  connectLimiter?: RateLimiter
  inboundMessageLimit?: number
  inboundMessageWindowMs?: number
  commandQueue?: CommandQueue
  /**
   * Peer addresses whose forwarding headers are believed. Defaults to loopback
   * (`TURBOPANEL_TRUSTED_PROXY_CIDRS` widens it for a connector on another
   * host); see `peer-address.ts`.
   */
  trustedProxyCidrs?: readonly string[]
}

/**
 * Env-configured trusted proxies, read once per process. `Deno.env` is absent
 * on Workers, where this transport is not registered at all.
 */
let cachedTrustedProxyCidrs: string[] | undefined
function trustedProxyCidrs(): string[] {
  cachedTrustedProxyCidrs ??= parseTrustedProxyCidrs(
    (
      globalThis as {
        Deno?: { env?: { get(key: string): string | undefined } }
      }
    ).Deno?.env?.get('TURBOPANEL_TRUSTED_PROXY_CIDRS')
  )
  return cachedTrustedProxyCidrs
}

export function registerDaemonWebSocket<E extends Env>(
  app: Hono<E>,
  options: DaemonWebSocketOptions
): void {
  const inboundMessageLimit = options.inboundMessageLimit ?? 120
  const inboundMessageWindowMs = options.inboundMessageWindowMs ?? 60_000

  app.get(DAEMON_WS_PATH, async (c, next) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket', 426)
    }

    const authHeader = c.req.header('authorization')?.trim() ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : ''
    if (!token || !options.secrets) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }
    const payload = await verifyDaemonJwt(token, options.secrets)
    if (!payload) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }

    if (options.connectLimiter) {
      const { success } = await options.connectLimiter.limit({
        key: daemonConnectRateLimitKey(payload.sub),
      })
      if (!success) {
        return c.text('Too Many Requests', 429)
      }
    }

    const db = options.db
    if (!db) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const registry = options.daemonCellRegistry
    if (!registry) {
      return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    }

    return upgradeWebSocket((c) => {
      // CF-Connecting-IP is honoured only when the immediate peer is a trusted
      // local proxy, so a Cloudflare Tunnel in front of the instance reports
      // the daemon's real address while a daemon dialling Caddy directly
      // cannot forge one. See `peer-address.ts`.
      const peer = resolvePeerAddress(
        {
          realIp: c.req.header('x-real-ip'),
          forwardedFor: c.req.header('x-forwarded-for'),
          cfConnectingIp: c.req.header('cf-connecting-ip'),
        },
        {
          runtime: 'deno',
          trustedProxyCidrs: options.trustedProxyCidrs ?? trustedProxyCidrs(),
        }
      )
      const remoteAddress = peer?.address
      const identityAddress = remoteAddress ?? DIRECT_ATTACH_SENTINEL
      const connectedAt = new Date().toISOString()

      let connectionId: string | undefined
      let leaseHolder: string | undefined
      const pumpControl = { abort: false }
      let attachReady = false
      const pendingMessages: string[] = []
      const inboundGate = createInboundWindowGate(inboundMessageLimit, inboundMessageWindowMs)

      const handleInboundMessage = async (raw: string, ws: WSContext<WebSocket>): Promise<void> => {
        // Exception boundary — mirrors DO webSocketMessage (log + swallow) so a
        // transient DB/cell error cannot tear down the daemon WebSocket.
        try {
          await handleInboundMessageBody(raw, ws)
        } catch (err) {
          compatLogError(
            'ws',
            `inbound message error serverId=${payload.sub} conn=${
              connectionId ?? 'unknown'
            }: ${String(err)}`
          )
        }
      }

      const handleInboundMessageBody = async (
        raw: string,
        ws: WSContext<WebSocket>
      ): Promise<void> => {
        if (raw === DAEMON_CELL_PING) {
          const keyStillActive = await assertDaemonKeyStillActive(db, payload.sub, payload.kid, ws)
          if (!keyStillActive) return
          await handleDaemonCellPing({
            cell: registry.getCell(payload.sub),
            db,
            serverId: payload.sub,
            connectionId,
            ws,
          })
          return
        }

        const validated = validateDaemonInboundFrame(raw)
        if (!validated.ok) {
          rejectDaemonInboundFrame(ws, payload.sub, connectionId, validated.reason)
          return
        }
        const message = validated.message

        const keyStillActive = await assertDaemonKeyStillActive(db, payload.sub, payload.kid, ws)
        if (!keyStillActive) return

        cellTrace('inbound', {
          serverId: payload.sub,
          conn: connectionId,
          type: message.type,
        })

        const cell = registry.getCell(payload.sub)

        if (message.type === 'hello' || message.type === 'heartbeat') {
          await handleDaemonPresenceInbound({
            cell,
            db,
            serverId: payload.sub,
            connectionId,
            message,
          })
          return
        }

        if (message.type === 'managed-ha-event') {
          await handleDaemonManagedHaInbound({
            cell,
            db,
            connectionId,
            message,
            commandQueue: options.commandQueue,
            reporterServerId: payload.sub,
          })
          return
        }

        if (message.type === 'topology-report') {
          await handleDaemonTopologyReportInbound({
            cell,
            db,
            connectionId,
            message,
            reporterServerId: payload.sub,
          })
          return
        }

        await cell.recordInbound({ connectionId, at: message.at })

        const envelope = wireMessageToInboundEnvelope(message)
        if (envelope) {
          await applyDaemonInboundEnvelope({
            cell,
            db,
            serverId: payload.sub,
            envelope,
          })
        }
      }

      return {
        async onOpen(_event, ws) {
          const cell = registry.getCell(payload.sub)
          try {
            const attached = await cell.attachDaemonSocket({
              keyId: payload.kid,
              remoteAddress: identityAddress,
              connectedAt,
            })
            connectionId = attached.connectionId
            leaseHolder = attached.lease.holder
          } catch (err) {
            daemonCellLog('WARN', payload.sub, undefined, `daemon attach failed: ${String(err)}`)
            ws.close(1013, 'attach failed')
            return
          }

          if (identityAddress === DIRECT_ATTACH_SENTINEL) {
            const daemonRow = await getServerDaemonStateByServerId(db, payload.sub)
            if (!daemonRow) {
              compatLogWarn(
                'ws',
                `colocated daemon ${payload.sub} has no postgres row; forcing re-enroll`
              )
              pumpControl.abort = true
              ws.close(4401, 'server row missing')
              return
            }
          }

          const geo = resolveSelfHostedGeo(remoteAddress)
          await onDaemonConnected(
            db,
            payload.sub,
            cell,
            connectedAt,
            undefined,
            geo ?? undefined,
            payload.kid
          )

          cellTrace('attach', {
            serverId: payload.sub,
            conn: connectionId,
            remoteAddress: identityAddress,
          })

          const connectedFromSuffix = peer ? ` from ${peer.address} (${peer.source})` : ''
          daemonCellLog('INFO', payload.sub, connectionId, `daemon connected${connectedFromSuffix}`)

          if (identityAddress === DIRECT_ATTACH_SENTINEL) {
            assignColocatedDaemonOnConnect(db, registry)
          }

          const consumer = `ws:${connectionId}`

          startDaemonOutboxPump({
            cell,
            serverId: payload.sub,
            connectionId,
            consumer,
            ws,
            abortRef: pumpControl,
          })

          attachReady = true
          for (const raw of pendingMessages.splice(0)) {
            await handleInboundMessage(raw, ws)
          }
        },
        async onMessage(event, ws) {
          const raw = await wsMessageDataToString(event.data)
          const gateKey = connectionId ?? identityAddress
          if (!inboundGate.allow(gateKey)) {
            cellTrace('inbound-rate-limited', {
              serverId: payload.sub,
              conn: connectionId,
            })
            pendingMessages.length = 0
            pumpControl.abort = true
            ws.close(1008, 'rate_limited')
            return
          }
          if (!attachReady) {
            if (pendingMessages.length >= inboundMessageLimit) {
              pendingMessages.length = 0
              pumpControl.abort = true
              ws.close(1008, 'rate_limited')
              return
            }
            pendingMessages.push(raw)
            return
          }
          await handleInboundMessage(raw, ws)
        },
        onClose() {
          pumpControl.abort = true
          if (connectionId) {
            inboundGate.release(connectionId)
          } else {
            inboundGate.release(identityAddress)
          }
          if (connectionId && leaseHolder) {
            const cell = registry.getCell(payload.sub)
            detachDaemonSocketSafe(
              cell,
              {
                connectionId,
                reason: 'closed',
                closedAt: new Date().toISOString(),
              },
              db,
              payload.sub,
              connectionId
            )
          }
        },
        onError() {
          pumpControl.abort = true
          if (connectionId) {
            inboundGate.release(connectionId)
          } else {
            inboundGate.release(identityAddress)
          }
          if (connectionId && leaseHolder) {
            const cell = registry.getCell(payload.sub)
            detachDaemonSocketSafe(
              cell,
              {
                connectionId,
                reason: 'error',
                closedAt: new Date().toISOString(),
              },
              db,
              payload.sub,
              connectionId
            )
          }
        },
      }
    })(c, next)
  })

  if (options.developerSurface) {
    registerStubWebSocket(app, DEVELOPER_WS_PATH, 'developer', (c) =>
      authorizeDeveloperUpgrade(c, options.sessionSecrets)
    )
  }
  registerStubWebSocket(app, CLIENT_WS_PATH, 'client', (c) =>
    authorizeClientUpgrade(c, options.sessionSecrets)
  )
}

/**
 * Authorize a placeholder-WS upgrade. Returns an error `Response` to reject the
 * upgrade, or `null` when the caller may proceed. Mirrors the access checks of
 * the matching REST surface.
 */
type StubUpgradeGuard = (c: Context) => Promise<Response | null>

/** Client WS requires a valid end-user session cookie (same as client REST). */
async function authorizeClientUpgrade(
  c: Context,
  sessionSecrets: DerivedSecretsConfig | undefined
): Promise<Response | null> {
  if (!sessionSecrets) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  const resolved = await resolveSession(c, sessionSecrets, getDb(c))
  return resolved ? null : c.json({ ok: false, error: 'unauthorized' }, 401)
}

/**
 * Developer WS requires developer access: a superadmin session cookie, or HMAC
 * local-console auth (same as the developer REST surface).
 */
async function authorizeDeveloperUpgrade(
  c: Context,
  sessionSecrets: DerivedSecretsConfig | undefined
): Promise<Response | null> {
  if (sessionSecrets) {
    const resolved = await resolveSession(c, sessionSecrets, getDb(c))
    if (resolved && isSuperadminRole(resolved.data.role)) {
      return null
    }
    if (await verifyLocalConsoleAuthorization(c)) {
      return null
    }
    return resolved
      ? c.json({ ok: false, error: 'forbidden' }, 403)
      : c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  if (await verifyLocalConsoleAuthorization(c)) {
    return null
  }
  return c.json({ ok: false, error: 'unauthorized' }, 401)
}

/**
 * Placeholder WebSocket surface for the admin/client UIs. Today the UIs poll
 * REST; these endpoints reserve the namespace for future live streaming.
 *
 * They are **not** open idle sockets: the upgrade is rejected unless the caller
 * passes the same access check as the matching REST surface, and — because
 * there is no live streaming yet — an authorized peer is greeted once and then
 * immediately closed so placeholder sockets cannot accumulate idle connections.
 */
function registerStubWebSocket<E extends Env>(
  app: Hono<E>,
  path: string,
  surface: string,
  authorize: StubUpgradeGuard
): void {
  app.get(path, async (c, next) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket', 426)
    }
    const denied = await authorize(c)
    if (denied) {
      return denied
    }
    return upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        ws.send(
          JSON.stringify({
            type: 'hello',
            surface,
            at: new Date().toISOString(),
          })
        )
        // No live streaming yet — greet then close so authorized peers cannot
        // hold the placeholder socket open indefinitely.
        ws.close(1000, 'not_implemented')
      },
    }))(c, next)
  })
}
