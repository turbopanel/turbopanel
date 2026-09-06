import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_INBOUND_ALLOWED,
  DAEMON_OFFLINE_SWEEP_MS,
  DAEMON_STALE_MS,
  type DaemonMessage,
  generateDeliveryId,
  generateRequestId,
  MAX_DAEMON_WS_DEFAULT_BRANCH_CHARS,
  MAX_DAEMON_WS_ERROR_CHARS,
  MAX_DAEMON_WS_FABRIC_PATH_ENTRIES,
  MAX_DAEMON_WS_FRAME_BYTES,
  MAX_DAEMON_WS_HOST_FIELD_CHARS,
  MAX_DAEMON_WS_ID_CHARS,
  MAX_DAEMON_WS_LOGS_CHARS,
  MAX_DAEMON_WS_REPO_READ_BYTES,
  MAX_DAEMON_WS_REPO_READ_ENTRIES,
  MAX_DAEMON_WS_REPO_READ_PATHS,
  MAX_DAEMON_WS_RESULT_JSON_BYTES,
  MAX_DAEMON_WS_TOPOLOGY_REPORT_JSON_BYTES,
  type DaemonInboundEnvelope,
  outboundEnvelopeToWireMessage,
  parseDaemonBuildInfo,
  parseDaemonMessage,
  validateDaemonInboundEnvelope,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from './protocol.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const TEST_PUBLIC_IPV4 = '203.0.113.1' // RFC 5737 TEST-NET-3

it('parseDaemonMessage round-trips valid JSON', () => {
  const msg: DaemonMessage = {
    type: 'heartbeat',
    at: '2020-01-01T00:00:00.000Z',
  }
  const parsed = parseDaemonMessage(JSON.stringify(msg))
  assertEquals(parsed, msg)
})

it('parseDaemonMessage returns null for invalid JSON', () => {
  assertEquals(parseDaemonMessage('not-json'), null)
})

it('validateDaemonInboundFrame accepts managed-ha-event', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'managed-ha-event',
      managedId: '00000000-0000-4000-8000-000000000001',
      at: VALID_AT,
    })
  )
  assertEquals(result.ok, true)
})

it('validateDaemonInboundFrame rejects managed-ha-event without managedId', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'managed-ha-event',
      at: VALID_AT,
    })
  )
  assertEquals(result.ok, false)
})

it('validateDaemonInboundFrame rejects oversized frames', () => {
  const padding = 'x'.repeat(MAX_DAEMON_WS_FRAME_BYTES)
  const raw = `{"type":"heartbeat","at":"2020-01-01T00:00:00.000Z","pad":"${padding}"}`
  const result = validateDaemonInboundFrame(raw)
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.reason, 'frame exceeds max size')
  }
})

it('validateDaemonInboundFrame rejects disallowed types', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'echo',
      at: '2020-01-01T00:00:00.000Z',
      payload: 1,
    })
  )
  assertEquals(result.ok, false)
})

it('validateDaemonInboundFrame rejects oversized managed logs', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'managed-logs-result',
      id: 'req-1',
      at: '2020-01-01T00:00:00.000Z',
      logs: 'x'.repeat(MAX_DAEMON_WS_LOGS_CHARS + 1),
    })
  )
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.reason, 'logs exceed max length')
  }
})

it('validateDaemonInboundEnvelope rejects oversized command results', () => {
  const result = validateDaemonInboundEnvelope({
    kind: 'command-outcome',
    requestId: 'req-1',
    at: '2020-01-01T00:00:00.000Z',
    ok: true,
    result: { blob: 'x'.repeat(70 * 1024) },
  })
  assertEquals(result.ok, false)
})

it('validateDaemonInboundEnvelope accepts a valid addresses result', () => {
  const result = validateDaemonInboundEnvelope({
    kind: 'addresses-result',
    requestId: 'req-1',
    at: '2020-01-01T00:00:00.000Z',
    ips: [{ address: TEST_PUBLIC_IPV4, version: 4, scope: 'public' }],
  })
  assertEquals(result, { ok: true })
})

it('wireMessageToInboundEnvelope maps inbound wire types', () => {
  const at = '2020-01-01T00:00:00.000Z'

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'addresses-result',
      id: 'r2',
      at,
      ips: [{ address: TEST_PUBLIC_IPV4, version: 4, scope: 'public' }],
    }),
    {
      kind: 'addresses-result',
      requestId: 'r2',
      at,
      ips: [{ address: TEST_PUBLIC_IPV4, version: 4, scope: 'public' }],
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'managed-logs-result',
      id: 'r3',
      at,
      logs: 'line1\n',
    }),
    {
      kind: 'managed-logs-result',
      requestId: 'r3',
      at,
      logs: 'line1\n',
      error: undefined,
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'container-logs-result',
      id: 'r3c',
      at,
      logs: '2026-01-01T00:00:00.000000000Z line\n',
    }),
    {
      kind: 'container-logs-result',
      requestId: 'r3c',
      at,
      logs: '2026-01-01T00:00:00.000000000Z line\n',
      error: undefined,
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'dev-sync-result',
      id: 'r4',
      at,
      ok: true,
    }),
    {
      kind: 'dev-sync-result',
      requestId: 'r4',
      at,
      ok: true,
      error: undefined,
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'tunnel-token-result',
      id: 'r5',
      at,
      ok: false,
      error: 'nope',
    }),
    {
      kind: 'tunnel-token-result',
      requestId: 'r5',
      at,
      ok: false,
      error: 'nope',
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'update-result',
      id: 'r6',
      at,
      ok: true,
    }),
    { kind: 'update-result', requestId: 'r6', at, ok: true, error: undefined }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'public-urls-update-result',
      id: 'r7',
      at,
      ok: true,
    }),
    {
      kind: 'public-urls-update-result',
      requestId: 'r7',
      at,
      ok: true,
      error: undefined,
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'public-urls-update-result',
      id: 'r8',
      at,
      ok: false,
      error: 'cert regen failed',
    }),
    {
      kind: 'public-urls-update-result',
      requestId: 'r8',
      at,
      ok: false,
      error: 'cert regen failed',
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'command-ack',
      id: 'r9',
      at,
      daemonReceivedAt: '2020-01-01T00:00:01.000Z',
    }),
    {
      kind: 'command-ack',
      requestId: 'r9',
      at,
      daemonReceivedAt: '2020-01-01T00:00:01.000Z',
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'command-outcome',
      id: 'r10',
      at,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: '2020-01-01T00:00:01.000Z',
      daemonRespondedAt: '2020-01-01T00:00:02.000Z',
    }),
    {
      kind: 'command-outcome',
      requestId: 'r10',
      at,
      ok: true,
      result: { pong: true },
      error: undefined,
      daemonReceivedAt: '2020-01-01T00:00:01.000Z',
      daemonRespondedAt: '2020-01-01T00:00:02.000Z',
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'command-outcome',
      id: 'r11',
      at,
      ok: false,
      error: 'timeout',
      daemonRespondedAt: '2020-01-01T00:00:03.000Z',
    }),
    {
      kind: 'command-outcome',
      requestId: 'r11',
      at,
      ok: false,
      result: undefined,
      error: 'timeout',
      daemonReceivedAt: undefined,
      daemonRespondedAt: '2020-01-01T00:00:03.000Z',
    }
  )
})

it('wireMessageToInboundEnvelope returns null for non-inbound types', () => {
  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'command-dispatch',
      id: 'r7',
      commandId: 'cmd-1',
      commandType: 'daemon.ping',
      payload: {},
      at: '2020-01-01T00:00:00.000Z',
    }),
    null
  )
})

it('metrics messages are not accepted on the daemon WebSocket', () => {
  assertEquals((DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has('metrics'), false)
})

it('outboundEnvelopeToWireMessage maps outbound kinds', () => {
  const base = {
    deliveryId: crypto.randomUUID(),
    requestId: 'req-1',
    at: '2020-01-01T00:00:00.000Z',
  }

  assertEquals(outboundEnvelopeToWireMessage({ ...base, kind: 'addresses-request' }), {
    type: 'addresses-request',
    id: 'req-1',
    at: base.at,
  })

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'managed-logs-request',
      managedId: '00000000-0000-4000-8000-000000000001',
      tail: 200,
    }),
    {
      type: 'managed-logs-request',
      id: 'req-1',
      managedId: '00000000-0000-4000-8000-000000000001',
      tail: 200,
      at: base.at,
    }
  )

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'container-logs-request',
      containerId: 'aabbccddeeff',
      tail: 200,
    }),
    {
      type: 'container-logs-request',
      id: 'req-1',
      containerId: 'aabbccddeeff',
      tail: 200,
      at: base.at,
    }
  )

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'dev-sync',
      phase: 'begin',
      totalChunks: 2,
      totalBytes: 100,
    }),
    {
      type: 'dev-sync-begin',
      id: 'req-1',
      totalChunks: 2,
      totalBytes: 100,
      at: base.at,
    }
  )

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'dev-sync',
      phase: 'chunk',
      index: 0,
      data: 'abc',
    }),
    {
      type: 'dev-sync-chunk',
      id: 'req-1',
      index: 0,
      data: 'abc',
      at: base.at,
    }
  )

  assertEquals(outboundEnvelopeToWireMessage({ ...base, kind: 'dev-sync', phase: 'end' }), {
    type: 'dev-sync-end',
    id: 'req-1',
    at: base.at,
  })

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'tunnel-token',
      token: 'tok',
    }),
    { type: 'tunnel-token', id: 'req-1', token: 'tok', at: base.at }
  )

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'public-urls-update',
      urls: ['https://panel.example.com', 'huey.lan:8443'],
    }),
    {
      type: 'public-urls-update',
      id: 'req-1',
      urls: ['https://panel.example.com', 'huey.lan:8443'],
      at: base.at,
    }
  )

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'update',
      updateUrl: 'https://example.com/update',
      updateSha256: 'a'.repeat(64),
    }),
    {
      type: 'update',
      id: 'req-1',
      updateUrl: 'https://example.com/update',
      updateSha256: 'a'.repeat(64),
      at: base.at,
    }
  )

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'update',
      channel: 'trunk',
    }),
    {
      type: 'update',
      id: 'req-1',
      channel: 'trunk',
      at: base.at,
    }
  )

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'echo',
      payload: { ok: true },
    }),
    { type: 'echo', payload: { ok: true }, at: base.at }
  )

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'command-dispatch',
      commandId: 'cmd-1',
      commandType: 'ping',
      payload: { target: 'host' },
    }),
    {
      type: 'command-dispatch',
      id: 'req-1',
      commandId: 'cmd-1',
      commandType: 'ping',
      payload: { target: 'host' },
      at: base.at,
    }
  )
})

it('generateRequestId and generateDeliveryId are UUIDs', () => {
  const requestId = generateRequestId()
  const deliveryId = generateDeliveryId()
  assert(UUID_RE.test(requestId))
  assert(UUID_RE.test(deliveryId))
})

it('generateRequestId and generateDeliveryId are unique across calls', () => {
  assertNotEquals(generateRequestId(), generateRequestId())
  assertNotEquals(generateDeliveryId(), generateDeliveryId())
})

it('deliveryId and requestId are independent UUIDs', () => {
  const requestId = generateRequestId()
  const deliveryId = generateDeliveryId()
  assertNotEquals(requestId, deliveryId)
})

const VALID_AT = '2020-01-01T00:00:00.000Z'
const VALID_DAEMON_BUILD = { commit: 'abc123def456', buildId: 'build-1' }

it('parseDaemonBuildInfo accepts optional builtAt and channel', () => {
  assertEquals(
    parseDaemonBuildInfo({
      commit: 'c1',
      buildId: 'b1',
      builtAt: '2020-01-01T00:00:00.000Z',
      channel: 'trunk',
    }),
    {
      commit: 'c1',
      buildId: 'b1',
      builtAt: '2020-01-01T00:00:00.000Z',
      channel: 'trunk',
    }
  )
})

it('parseDaemonBuildInfo rejects missing or empty commit/buildId', () => {
  assertEquals(parseDaemonBuildInfo(null), undefined)
  assertEquals(parseDaemonBuildInfo([]), undefined)
  assertEquals(parseDaemonBuildInfo({ commit: '', buildId: 'b' }), undefined)
  assertEquals(parseDaemonBuildInfo({ commit: 'c', buildId: '' }), undefined)
  assertEquals(parseDaemonBuildInfo({ commit: 1, buildId: 'b' }), undefined)
})

it('validateDaemonInboundFrame rejects invalid json and message shape', () => {
  assertEquals(validateDaemonInboundFrame('not-json').ok, false)
  assertEquals(validateDaemonInboundFrame('{}').ok, false)
  assertEquals(validateDaemonInboundFrame('{"at":"' + VALID_AT + '"}').ok, false)
})

it('validateDaemonInboundFrame accepts hello with optional fields', () => {
  const docker = { version: '28.3.3', composeVersion: '2.39.1' }
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'hello',
      at: VALID_AT,
      daemonBuild: VALID_DAEMON_BUILD,
      hostname: 'host-1',
      machineKey: 'a'.repeat(64),
      docker,
    })
  )
  assertEquals(result.ok, true)
  if (result.ok && result.message.type === 'hello') {
    assertEquals(result.message.docker, docker)
  }
})

it('validateDaemonInboundFrame rejects hello with invalid daemonBuild or hostname', () => {
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'hello',
        at: VALID_AT,
        daemonBuild: { commit: '' },
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'hello',
        at: VALID_AT,
        daemonBuild: VALID_DAEMON_BUILD,
        hostname: 'x'.repeat(MAX_DAEMON_WS_HOST_FIELD_CHARS + 1),
      })
    ).ok,
    false
  )
})

it('validateDaemonInboundFrame rejects heartbeat with invalid timestamp or daemonBuild', () => {
  assertEquals(
    validateDaemonInboundFrame(JSON.stringify({ type: 'heartbeat', at: 'not-a-timestamp' })).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'heartbeat',
        at: VALID_AT,
        daemonBuild: { buildId: 'only-build' },
      })
    ).ok,
    false
  )
})

it('validateDaemonInboundFrame validates addresses-result envelope fields', () => {
  const ok = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'addresses-result',
      id: 'req-1',
      at: VALID_AT,
      ips: [],
    })
  )
  assertEquals(ok.ok, true)

  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'addresses-result',
        id: '',
        at: VALID_AT,
        ips: {},
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'addresses-result',
        id: 'req-1',
        at: VALID_AT,
        ips: 'not-an-array',
      })
    ).ok,
    false
  )
})

it('validateDaemonInboundFrame validates ok-result and command messages', () => {
  for (const type of [
    'dev-sync-result',
    'tunnel-token-result',
    'public-urls-update-result',
    'update-result',
  ] as const) {
    assertEquals(
      validateDaemonInboundFrame(JSON.stringify({ type, id: 'req-1', at: VALID_AT, ok: true })).ok,
      true
    )
    assertEquals(
      validateDaemonInboundFrame(
        JSON.stringify({
          type,
          id: 'req-1',
          at: VALID_AT,
          ok: 'yes',
          error: 'x'.repeat(MAX_DAEMON_WS_ERROR_CHARS + 1),
        })
      ).ok,
      false
    )
  }

  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'command-ack',
        id: 'req-1',
        at: VALID_AT,
        daemonReceivedAt: VALID_AT,
      })
    ).ok,
    true
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'command-ack',
        id: 'req-1',
        at: VALID_AT,
        daemonReceivedAt: 'bad',
      })
    ).ok,
    false
  )

  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'command-outcome',
        id: 'req-1',
        at: VALID_AT,
        ok: true,
        result: { pong: true },
        daemonReceivedAt: VALID_AT,
        daemonRespondedAt: VALID_AT,
      })
    ).ok,
    true
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'command-outcome',
        id: 'x'.repeat(MAX_DAEMON_WS_ID_CHARS + 1),
        at: VALID_AT,
        ok: true,
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'command-outcome',
        id: 'req-1',
        at: VALID_AT,
        ok: true,
        result: { blob: 'x'.repeat(MAX_DAEMON_WS_RESULT_JSON_BYTES) },
      })
    ).ok,
    false
  )
})

it('validateDaemonInboundEnvelope rejects invalid requestId and timestamps', () => {
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'addresses-result',
      requestId: '',
      at: VALID_AT,
      ips: [],
    }),
    { ok: false, reason: 'invalid requestId' }
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'dev-sync-result',
      requestId: 'req-1',
      at: 'bad',
      ok: true,
    }),
    { ok: false, reason: 'invalid at timestamp' }
  )
})

it('validateDaemonInboundEnvelope validates managed-logs and command-outcome caps', () => {
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'managed-logs-result',
      requestId: 'req-1',
      at: VALID_AT,
      logs: 'x'.repeat(MAX_DAEMON_WS_LOGS_CHARS + 1),
    }),
    { ok: false, reason: 'logs exceed max length' }
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'managed-logs-result',
      requestId: 'req-1',
      at: VALID_AT,
      logs: 'ok',
      error: 'x'.repeat(MAX_DAEMON_WS_ERROR_CHARS + 1),
    }),
    { ok: false, reason: 'error exceeds max length' }
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'command-outcome',
      requestId: 'req-1',
      at: VALID_AT,
      ok: false,
      error: 'failed',
    }),
    { ok: true }
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'command-ack',
      requestId: 'req-1',
      at: VALID_AT,
      daemonReceivedAt: 'bad',
    }),
    { ok: false, reason: 'invalid daemonReceivedAt' }
  )
})

it('wireMessageToInboundEnvelope returns null for hello and heartbeat', () => {
  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'hello',
      at: VALID_AT,
      daemonBuild: VALID_DAEMON_BUILD,
    }),
    null
  )
  assertEquals(wireMessageToInboundEnvelope({ type: 'heartbeat', at: VALID_AT }), null)
  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'managed-ha-event',
      managedId: '00000000-0000-4000-8000-000000000001',
      at: VALID_AT,
    }),
    null
  )
})

it('cell ping/pong constants and timing exports are stable', () => {
  assertEquals(DAEMON_CELL_PING, '{"type":"ping"}')
  assertEquals(DAEMON_CELL_PONG, '{"type":"pong"}')
  assertEquals(DAEMON_STALE_MS, 60_000)
  assertEquals(DAEMON_OFFLINE_SWEEP_MS, 150_000)
  assertEquals((DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has('hello'), true)
  assertEquals((DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has('managed-ha-event'), true)
  assertEquals((DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has('fabric-paths-result'), true)
})

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const FABRIC_PATH_AT = '2020-01-01T00:00:00.000Z'

it('validateDaemonInboundFrame accepts a fabric-paths-result', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'fabric-paths-result',
      id: 'req-1',
      at: FABRIC_PATH_AT,
      paths: [
        {
          publicKey: WG_PUBKEY,
          endpoint: '203.0.113.50:48172',
          health: 'healthy',
        },
      ],
    })
  )
  assertEquals(result.ok, true)
})

it('validateDaemonInboundFrame rejects oversized fabric-paths-result entries', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'fabric-paths-result',
      id: 'req-1',
      at: FABRIC_PATH_AT,
      paths: Array.from({ length: MAX_DAEMON_WS_FABRIC_PATH_ENTRIES + 1 }, () => ({
        publicKey: WG_PUBKEY,
        health: 'never',
      })),
    })
  )
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.reason, 'paths exceed max entries')
  }
})

it('validateDaemonInboundEnvelope rejects oversized fabric path lists', () => {
  const oversized = Array.from({ length: MAX_DAEMON_WS_FABRIC_PATH_ENTRIES + 1 }, () => ({
    publicKey: WG_PUBKEY,
    health: 'never' as const,
  }))
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'fabric-paths-result',
      requestId: 'req-1',
      at: FABRIC_PATH_AT,
      paths: oversized,
    }),
    { ok: false, reason: 'paths exceed max entries' }
  )
})

it('wire mappings round-trip fabric-paths request and result', () => {
  const outbound = outboundEnvelopeToWireMessage({
    kind: 'fabric-paths-request',
    deliveryId: 'del-1',
    requestId: 'req-1',
    fabricId: '00000000-0000-4000-8000-000000000001',
    probeMs: 3000,
    candidates: [
      {
        publicKey: WG_PUBKEY,
        endpoints: ['203.0.113.50:48172'],
      },
    ],
    at: FABRIC_PATH_AT,
  })
  assertEquals(outbound, {
    type: 'fabric-paths-request',
    id: 'req-1',
    fabricId: '00000000-0000-4000-8000-000000000001',
    probeMs: 3000,
    candidates: [
      {
        publicKey: WG_PUBKEY,
        endpoints: ['203.0.113.50:48172'],
      },
    ],
    at: FABRIC_PATH_AT,
  })

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'fabric-paths-result',
      id: 'req-1',
      at: FABRIC_PATH_AT,
      paths: [
        {
          publicKey: WG_PUBKEY,
          endpoint: '203.0.113.50:48172',
          health: 'healthy',
        },
      ],
    }),
    {
      kind: 'fabric-paths-result',
      requestId: 'req-1',
      at: FABRIC_PATH_AT,
      paths: [
        {
          publicKey: WG_PUBKEY,
          endpoint: '203.0.113.50:48172',
          health: 'healthy',
        },
      ],
      error: undefined,
    }
  )
})

it('repo-read-result is on the inbound allowlist', () => {
  assertEquals(DAEMON_INBOUND_ALLOWED.has('repo-read-result'), true)
  // The request direction is outbound only — a daemon must never send one.
  assertEquals((DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has('repo-read-request'), false)
})

it('repo-read-result rejects a payload larger than its cap', () => {
  // The cap is on the TOTAL across files: several files each just under a
  // per-file limit would still be a frame nobody asked for.
  const half = 'a'.repeat(MAX_DAEMON_WS_REPO_READ_BYTES * 0.6)
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'repo-read-result',
      id: 'req-1',
      ok: true,
      at: '2020-01-01T00:00:00.000Z',
      files: [
        { path: 'a.yml', found: true, content: half },
        { path: 'b.yml', found: true, content: half },
      ],
    })
  )
  assertEquals(result.ok, false)
})

it('repo-read-result accepts a normal read', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'repo-read-result',
      id: 'req-1',
      ok: true,
      commitSha: 'a'.repeat(40),
      at: '2020-01-01T00:00:00.000Z',
      files: [
        { path: 'docker-compose.yml', found: true, content: 'services: {}\n' },
        { path: 'missing.yml', found: false, reason: 'not_found' },
      ],
    })
  )
  assertEquals(result.ok, true)
})

it('repo-default-branch-result is on the inbound allowlist', () => {
  assertEquals(DAEMON_INBOUND_ALLOWED.has('repo-default-branch-result'), true)
  // The request direction is outbound only — a daemon must never send one.
  assertEquals(
    (DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has('repo-default-branch-request'),
    false
  )
})

it('repo-default-branch-result accepts a normal answer, including a null branch', () => {
  const named = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'repo-default-branch-result',
      id: 'req-1',
      ok: true,
      defaultBranch: 'main',
      at: '2020-01-01T00:00:00.000Z',
    })
  )
  assertEquals(named.ok, true)

  // `null` is a real answer — the remote resolved but named no branch.
  const empty = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'repo-default-branch-result',
      id: 'req-1',
      ok: true,
      defaultBranch: null,
      at: '2020-01-01T00:00:00.000Z',
    })
  )
  assertEquals(empty.ok, true)
})

it('repo-default-branch-result rejects a branch name over the length cap', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'repo-default-branch-result',
      id: 'req-1',
      ok: true,
      defaultBranch: 'a'.repeat(MAX_DAEMON_WS_DEFAULT_BRANCH_CHARS + 1),
      at: '2020-01-01T00:00:00.000Z',
    })
  )
  assertEquals(result.ok, false)
})

it('validateDaemonInboundFrame rejects hello with a non-string machineKey', () => {
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'hello',
        at: VALID_AT,
        daemonBuild: VALID_DAEMON_BUILD,
        machineKey: 12,
      })
    ).ok,
    false
  )
})

it('validateDaemonInboundFrame rejects heartbeat host fields that are not strings', () => {
  assertEquals(
    validateDaemonInboundFrame(JSON.stringify({ type: 'heartbeat', at: VALID_AT, hostname: 1 })).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'heartbeat',
        at: VALID_AT,
        machineKey: 'x'.repeat(MAX_DAEMON_WS_HOST_FIELD_CHARS + 1),
      })
    ).ok,
    false
  )
})

it('validateDaemonInboundFrame accepts managed-ha-event with a valid sourceMemberId', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'managed-ha-event',
      managedId: '00000000-0000-4000-8000-000000000001',
      sourceMemberId: '00000000-0000-4000-8000-000000000002',
      at: VALID_AT,
    })
  )
  assertEquals(result.ok, true)
})

it('validateDaemonInboundFrame rejects managed-ha-event with an invalid sourceMemberId', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'managed-ha-event',
      managedId: '00000000-0000-4000-8000-000000000001',
      sourceMemberId: 'not-a-uuid',
      at: VALID_AT,
    })
  )
  assertEquals(result.ok, false)
})

it('validateDaemonInboundFrame rejects fabric path field shapes', () => {
  const base = {
    type: 'fabric-paths-result',
    id: 'req-1',
    at: FABRIC_PATH_AT,
  }
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        paths: [{ publicKey: WG_PUBKEY, health: 'maybe' }],
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        paths: [
          {
            publicKey: WG_PUBKEY,
            health: 'healthy',
            endpoint: 'not-an-endpoint',
          },
        ],
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        paths: [
          {
            publicKey: WG_PUBKEY,
            health: 'healthy',
            lastHandshakeAt: 'not-a-timestamp',
          },
        ],
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        paths: [{ publicKey: WG_PUBKEY, health: 'healthy', latencyMs: -1 }],
      })
    ).ok,
    false
  )
})

it('outboundEnvelopeToWireMessage maps repo-read-request with and without credential', () => {
  const publicRepo = outboundEnvelopeToWireMessage({
    kind: 'repo-read-request',
    deliveryId: 'del-1',
    requestId: 'req-1',
    cloneUrl: 'https://example.com/repo.git',
    ref: 'trunk',
    paths: ['compose.yaml'],
    maxBytesPerFile: 1024,
    at: VALID_AT,
  })
  assertEquals(publicRepo, {
    type: 'repo-read-request',
    id: 'req-1',
    cloneUrl: 'https://example.com/repo.git',
    ref: 'trunk',
    paths: ['compose.yaml'],
    maxBytesPerFile: 1024,
    at: VALID_AT,
  })

  const privateRepo = outboundEnvelopeToWireMessage({
    kind: 'repo-read-request',
    deliveryId: 'del-2',
    requestId: 'req-2',
    cloneUrl: 'https://example.com/private.git',
    ref: 'main',
    paths: ['a.yml', 'b.yml'],
    listPath: '.',
    maxBytesPerFile: 2048,
    credential: 'tpdaemon.sealed',
    credentialKind: 'token',
    credentialUsername: 'git',
    at: VALID_AT,
  })
  assertEquals(privateRepo.type, 'repo-read-request')
  if (privateRepo.type !== 'repo-read-request') {
    throw new TypeError('expected repo-read-request')
  }
  assertEquals(privateRepo.credential, 'tpdaemon.sealed')
  assertEquals(privateRepo.credentialKind, 'token')
  assertEquals(privateRepo.credentialUsername, 'git')
  assertEquals(privateRepo.listPath, '.')
})

it('outboundEnvelopeToWireMessage maps repo-default-branch-request', () => {
  assertEquals(
    outboundEnvelopeToWireMessage({
      kind: 'repo-default-branch-request',
      deliveryId: 'del-1',
      requestId: 'req-1',
      cloneUrl: 'https://example.com/repo.git',
      at: VALID_AT,
    }),
    {
      type: 'repo-default-branch-request',
      id: 'req-1',
      cloneUrl: 'https://example.com/repo.git',
      at: VALID_AT,
    }
  )
})

it('wireMessageToInboundEnvelope maps repo-default-branch-result', () => {
  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'repo-default-branch-result',
      id: 'req-1',
      at: VALID_AT,
      ok: true,
      defaultBranch: 'main',
    }),
    {
      kind: 'repo-default-branch-result',
      requestId: 'req-1',
      at: VALID_AT,
      ok: true,
      defaultBranch: 'main',
      error: undefined,
    }
  )
})

it('wireMessageToInboundEnvelope maps repo-read-result', () => {
  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'repo-read-result',
      id: 'req-1',
      at: VALID_AT,
      ok: true,
      commitSha: 'a'.repeat(40),
      files: [{ path: 'compose.yaml', found: true, content: 'services: {}\n' }],
      entries: [{ path: 'compose.yaml', kind: 'file' }],
    }),
    {
      kind: 'repo-read-result',
      requestId: 'req-1',
      at: VALID_AT,
      ok: true,
      commitSha: 'a'.repeat(40),
      files: [{ path: 'compose.yaml', found: true, content: 'services: {}\n' }],
      entries: [{ path: 'compose.yaml', kind: 'file' }],
      error: undefined,
    }
  )
})

it('repo-read-result rejects invalid files and entries shapes', () => {
  const base = {
    type: 'repo-read-result',
    id: 'req-1',
    ok: true,
    at: VALID_AT,
  }
  assertEquals(validateDaemonInboundFrame(JSON.stringify({ ...base, files: 'nope' })).ok, false)
  assertEquals(validateDaemonInboundFrame(JSON.stringify({ ...base, files: [null] })).ok, false)
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        files: [{ found: true }],
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        files: [{ path: 'a.yml', found: 'yes' }],
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        files: [{ path: 'a.yml', found: true, content: 1 }],
      })
    ).ok,
    false
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        files: Array.from({ length: MAX_DAEMON_WS_REPO_READ_PATHS + 1 }, (_, i) => ({
          path: `f${i}.yml`,
          found: false,
        })),
      })
    ).ok,
    false
  )
  assertEquals(validateDaemonInboundFrame(JSON.stringify({ ...base, entries: {} })).ok, false)
})

it('repo-read-result rejects too many directory entries', () => {
  const entries = Array.from({ length: MAX_DAEMON_WS_REPO_READ_ENTRIES + 1 }, (_, i) => ({
    path: `f${i}`,
    kind: 'file',
  }))
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'repo-read-result',
      id: 'req-1',
      ok: true,
      at: '2020-01-01T00:00:00.000Z',
      entries,
    })
  )
  assertEquals(result.ok, false)
})

it('metrics live/sensor result kinds are on the inbound allowlist', () => {
  const allowed = DAEMON_INBOUND_ALLOWED as ReadonlySet<string>
  assertEquals(allowed.has('metrics-live-start-result'), true)
  assertEquals(allowed.has('metrics-live-stop-result'), true)
  assertEquals(allowed.has('topology-overrides-update-result'), true)
  // Requests remain outbound-only.
  assertEquals(allowed.has('metrics-live-start'), false)
  assertEquals(allowed.has('metrics-live-stop'), false)
  assertEquals(allowed.has('topology-overrides-update'), false)
})

it('validateDaemonInboundFrame validates metrics live/sensor ok-results', () => {
  for (const type of [
    'metrics-live-start-result',
    'metrics-live-stop-result',
    'topology-overrides-update-result',
  ]) {
    const ok = validateDaemonInboundFrame(
      JSON.stringify({
        type,
        id: 'req-1',
        ok: true,
        at: VALID_AT,
      })
    )
    assertEquals(ok.ok, true, `${type} valid frame`)

    const missingOk = validateDaemonInboundFrame(
      JSON.stringify({
        type,
        id: 'req-1',
        at: VALID_AT,
      })
    )
    assertEquals(missingOk.ok, false, `${type} missing ok`)

    const oversizedError = validateDaemonInboundFrame(
      JSON.stringify({
        type,
        id: 'req-1',
        ok: false,
        error: 'e'.repeat(MAX_DAEMON_WS_ERROR_CHARS + 1),
        at: VALID_AT,
      })
    )
    assertEquals(oversizedError.ok, false, `${type} oversized error`)
  }
})

it('wire mappings round-trip metrics live/sensor kinds', () => {
  const base = {
    deliveryId: crypto.randomUUID(),
    requestId: 'req-m',
    at: VALID_AT,
  }

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'metrics-live-start',
      leaseId: 'lease-1',
      intervalSeconds: 10,
      expiresAt: '2020-01-01T01:00:00.000Z',
    }),
    {
      type: 'metrics-live-start',
      id: 'req-m',
      leaseId: 'lease-1',
      intervalSeconds: 10,
      expiresAt: '2020-01-01T01:00:00.000Z',
      at: VALID_AT,
    }
  )
  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'metrics-live-stop',
      leaseId: 'lease-1',
    }),
    {
      type: 'metrics-live-stop',
      id: 'req-m',
      leaseId: 'lease-1',
      at: VALID_AT,
    }
  )
  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: 'topology-overrides-update',
      overrides: {
        cpuTemperature: { chip: 'coretemp', label: 'Package id 0' },
        nic1: 'eth0',
        hostingPath: '/mnt/data',
        drivetempEnabled: true,
        generation: 3,
        generationAppliedAt: VALID_AT,
      },
    }),
    {
      type: 'topology-overrides-update',
      id: 'req-m',
      overrides: {
        cpuTemperature: { chip: 'coretemp', label: 'Package id 0' },
        nic1: 'eth0',
        hostingPath: '/mnt/data',
        drivetempEnabled: true,
        generation: 3,
        generationAppliedAt: VALID_AT,
      },
      at: VALID_AT,
    }
  )

  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'metrics-live-start-result',
      id: 'req-m',
      ok: true,
      at: VALID_AT,
    }),
    {
      kind: 'metrics-live-start-result',
      requestId: 'req-m',
      at: VALID_AT,
      ok: true,
      error: undefined,
    }
  )
  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'metrics-live-stop-result',
      id: 'req-m',
      ok: false,
      error: 'no lease',
      at: VALID_AT,
    }),
    {
      kind: 'metrics-live-stop-result',
      requestId: 'req-m',
      at: VALID_AT,
      ok: false,
      error: 'no lease',
    }
  )
  assertEquals(
    wireMessageToInboundEnvelope({
      type: 'topology-overrides-update-result',
      id: 'req-m',
      ok: true,
      at: VALID_AT,
    }),
    {
      kind: 'topology-overrides-update-result',
      requestId: 'req-m',
      at: VALID_AT,
      ok: true,
      error: undefined,
    }
  )
})

it('validateDaemonInboundEnvelope accepts a metrics-live-start-result', () => {
  const okResult = validateDaemonInboundEnvelope({
    kind: 'metrics-live-start-result',
    requestId: 'req-m',
    at: VALID_AT,
    ok: true,
  })
  assertEquals(okResult.ok, true)
})

it('validateDaemonInboundFrame accepts a topology-report', () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: 'topology-report',
      at: VALID_AT,
      generation: 1,
      bootGeneration: 0,
      snapshot: { devices: [] },
    }),
  )
  assertEquals(result.ok, true)
})

it('validateDaemonInboundFrame rejects topology-report field shapes', () => {
  const base = {
    type: 'topology-report',
    at: VALID_AT,
    generation: 1,
    bootGeneration: 0,
    snapshot: {},
  }
  assertEquals(
    validateDaemonInboundFrame(JSON.stringify({ ...base, at: 'not-a-timestamp' })).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(JSON.stringify({ ...base, generation: -1 })).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(JSON.stringify({ ...base, bootGeneration: 1.5 })).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        ...base,
        snapshot: { pad: 'x'.repeat(MAX_DAEMON_WS_TOPOLOGY_REPORT_JSON_BYTES + 1) },
      }),
    ).ok,
    false,
  )
})

it('validateDaemonInboundFrame rejects remaining result-envelope edges', () => {
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'managed-logs-result',
        id: 'req-1',
        at: VALID_AT,
        logs: 12,
      }),
    ).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'repo-read-result',
        id: 'req-1',
        at: 'not-a-timestamp',
        ok: true,
        files: [],
      }),
    ).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'repo-read-result',
        id: 'req-1',
        at: VALID_AT,
        ok: 'yes',
        files: [],
      }),
    ).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'repo-default-branch-result',
        id: 'req-1',
        at: VALID_AT,
        ok: 'yes',
      }),
    ).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'repo-default-branch-result',
        id: 'req-1',
        at: VALID_AT,
        ok: true,
        defaultBranch: 12,
      }),
    ).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'managed-ha-event',
        managedId: '00000000-0000-4000-8000-000000000001',
        at: 'not-a-timestamp',
      }),
    ).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'fabric-paths-result',
        id: 'req-1',
        at: VALID_AT,
        paths: [42],
      }),
    ).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: 'fabric-paths-result',
        id: 'req-1',
        at: VALID_AT,
        paths: [{ publicKey: 'not-a-key', health: 'healthy' }],
      }),
    ).ok,
    false,
  )
})

it('validateDaemonInboundEnvelope rejects forged result and unknown kinds', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'command-outcome',
      requestId: 'req-1',
      at: VALID_AT,
      ok: true,
      result: circular,
    }).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'command-outcome',
      requestId: 'req-1',
      at: VALID_AT,
      ok: true,
      result: () => {},
    }).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'command-outcome',
      requestId: 'req-1',
      at: VALID_AT,
      ok: true,
      error: 12,
    } as unknown as Parameters<typeof validateDaemonInboundEnvelope>[0]).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'command-ack',
      requestId: 'req-1',
      at: VALID_AT,
      daemonReceivedAt: 'bad',
    }).ok,
    false,
  )
  const oversized = 'x'.repeat(MAX_DAEMON_WS_REPO_READ_BYTES + 1)
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'repo-read-result',
      requestId: 'req-1',
      at: VALID_AT,
      ok: true,
      files: [{ path: 'compose.yaml', found: true, content: oversized }],
    }).ok,
    false,
  )
  const extraEntries = Array.from(
    { length: MAX_DAEMON_WS_REPO_READ_ENTRIES + 1 },
    (_, i) => ({ path: `file-${i}`, kind: 'file' as const }),
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'repo-read-result',
      requestId: 'req-1',
      at: VALID_AT,
      ok: true,
      files: [],
      entries: extraEntries,
    }).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'repo-default-branch-result',
      requestId: 'req-1',
      at: VALID_AT,
      ok: true,
      error: 'x'.repeat(MAX_DAEMON_WS_ERROR_CHARS + 1),
    }).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'unknown-kind',
      requestId: 'req-1',
      at: VALID_AT,
    } as unknown as DaemonInboundEnvelope).ok,
    false,
  )
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: 'fabric-paths-result',
      requestId: 'req-1',
      at: VALID_AT,
      paths: [{ publicKey: 'not-a-key', health: 'healthy' }],
    }).ok,
    false,
  )
})

