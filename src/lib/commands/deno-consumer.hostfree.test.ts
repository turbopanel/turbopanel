/**
 * Host-free coverage for deno-consumer disposition / deps helpers and the
 * AMQP start/consume/close loop (broker is stubbed).
 */

import { assertEquals, assertRejects } from '@std/assert'
import { stub } from '@std/testing/mock'
import amqplib from 'amqplib'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  applyCommandMessageDisposition,
  buildCommandConsumerDeps,
  commandMessageDisposition,
  startCommandConsumer,
} from './deno-consumer.ts'
import { createNoopCommandQueue } from './noop-command-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('buildCommandConsumerDeps returns undefined when no optional deps are set', () => {
  assertEquals(buildCommandConsumerDeps({}), undefined)
})

test('buildCommandConsumerDeps wires commandQueue when present', () => {
  const commandQueue = createNoopCommandQueue()
  assertEquals(buildCommandConsumerDeps({ commandQueue }), {
    commandQueue,
    resealDeps: undefined,
    secretsConfig: undefined,
    dataEncryptionSecrets: undefined,
  })
})

test('buildCommandConsumerDeps wires resealDeps without a queue', () => {
  const resealDeps = {
    secretsConfig: { runtime: 'deno' },
    dataEncryptionSecrets: { versions: [] },
  } as never
  const deps = buildCommandConsumerDeps({ resealDeps })
  assertEquals(deps?.resealDeps, resealDeps)
  assertEquals(deps?.commandQueue, undefined)
})

test('commandMessageDisposition acks success and branches on transient vs permanent', () => {
  assertEquals(commandMessageDisposition({ ok: true }), 'ack')
  assertEquals(
    commandMessageDisposition({ ok: false, error: new Error('ECONNREFUSED') }),
    'nack_requeue',
  )
  assertEquals(
    commandMessageDisposition({ ok: false, error: new Error('invalid command envelope') }),
    'nack_dead',
  )
  assertEquals(
    commandMessageDisposition({ ok: false, error: 'data integrity failure' }),
    'nack_dead',
  )
})

test('applyCommandMessageDisposition maps dispositions to ack/nack flags', () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const msg = { content: new Uint8Array() } as never
  const channel = {
    ack: (m: unknown) => {
      calls.push({ method: 'ack', args: [m] })
    },
    nack: (m: unknown, allUpTo: boolean, requeue: boolean) => {
      calls.push({ method: 'nack', args: [m, allUpTo, requeue] })
    },
  }

  applyCommandMessageDisposition(channel, msg, 'ack')
  applyCommandMessageDisposition(channel, msg, 'nack_requeue')
  applyCommandMessageDisposition(channel, msg, 'nack_dead')

  assertEquals(calls, [
    { method: 'ack', args: [msg] },
    { method: 'nack', args: [msg, false, true] },
    { method: 'nack', args: [msg, false, false] },
  ])
})

type ConsumeHandler = (msg: { content: { toString(): string } } | null) => void

function createStubBroker(options: {
  consumerTag?: string
  cancel?: () => Promise<void>
  channelClose?: () => Promise<void>
  connectionClose?: () => Promise<void>
} = {}) {
  const dispositions: Array<{ method: string; requeue?: boolean }> = []
  let onMessage: ConsumeHandler | undefined
  const channel = {
    assertExchange: async () => undefined,
    assertQueue: async () => undefined,
    bindQueue: async () => undefined,
    prefetch: async () => undefined,
    consume: async (_queue: string, handler: ConsumeHandler) => {
      onMessage = handler
      return { consumerTag: options.consumerTag ?? 'ctag-1' }
    },
    ack: () => {
      dispositions.push({ method: 'ack' })
    },
    nack: (_msg: unknown, _allUpTo: boolean, requeue: boolean) => {
      dispositions.push({ method: 'nack', requeue })
    },
    cancel: options.cancel ?? (async () => undefined),
    close: options.channelClose ?? (async () => undefined),
  }
  const connection = {
    createConfirmChannel: async () => channel,
    close: options.connectionClose ?? (async () => undefined),
  }
  return { channel, connection, dispositions, deliver: (msg: Parameters<ConsumeHandler>[0]) => {
    if (!onMessage) throw new TypeError('consume handler was not registered')
    onMessage(msg)
  } }
}

function emptyRegistry(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new TypeError('getCell must not be called')
    },
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

function missingRowDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve([]), {
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
}

function throwingDb(error: Error): Db {
  return {
    select: () => {
      throw error
    },
  } as unknown as Db
}

async function waitForDisposition(
  dispositions: Array<{ method: string }>,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (dispositions.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new TypeError('timed out waiting for AMQP disposition')
}

const PING_ENVELOPE_JSON = JSON.stringify({
  commandId: '00000000-0000-4000-8000-0000000000cc',
  serverId: '00000000-0000-4000-8000-0000000000bb',
  type: 'daemon.ping',
  attempt: 1,
  queuedAt: '2020-01-01T00:00:00.000Z',
})

test('startCommandConsumer acks a valid envelope and ignores a null delivery', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    const handle = await startCommandConsumer({
      db: missingRowDb(),
      registry: emptyRegistry(),
      amqpUrl: 'amqp://test',
    })
    broker.deliver(null)
    broker.deliver({ content: { toString: () => PING_ENVELOPE_JSON } })
    await waitForDisposition(broker.dispositions)
    assertEquals(broker.dispositions, [{ method: 'ack' }])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startCommandConsumer dead-letters a permanent envelope parse error', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    const handle = await startCommandConsumer({
      db: missingRowDb(),
      registry: emptyRegistry(),
      amqpUrl: 'amqp://test',
    })
    broker.deliver({ content: { toString: () => 'not-json' } })
    await waitForDisposition(broker.dispositions)
    assertEquals(broker.dispositions, [{ method: 'nack', requeue: false }])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startCommandConsumer requeues a transient processing error', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    const handle = await startCommandConsumer({
      db: throwingDb(new Error('ECONNREFUSED')),
      registry: emptyRegistry(),
      amqpUrl: 'amqp://test',
    })
    broker.deliver({ content: { toString: () => PING_ENVELOPE_JSON } })
    await waitForDisposition(broker.dispositions)
    assertEquals(broker.dispositions, [{ method: 'nack', requeue: true }])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startCommandConsumer close swallows cancel and connection errors', async () => {
  const broker = createStubBroker({
    cancel: () => Promise.reject(new Error('cancel failed')),
    channelClose: () => Promise.reject(new Error('channel close failed')),
    connectionClose: () => Promise.reject(new Error('connection close failed')),
  })
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    const handle = await startCommandConsumer({
      db: missingRowDb(),
      registry: emptyRegistry(),
      amqpUrl: 'amqp://test',
    })
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startCommandConsumer retries a non-Error connect failure then succeeds', async () => {
  const broker = createStubBroker()
  let attempts = 0
  const connectStub = stub(amqplib, 'connect', () => {
    attempts += 1
    if (attempts === 1) return Promise.reject('broker down')
    return Promise.resolve(broker.connection as never)
  })
  try {
    const handle = await startCommandConsumer({
      db: missingRowDb(),
      registry: emptyRegistry(),
      amqpUrl: 'amqp://retry-string',
    })
    assertEquals(attempts, 2)
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startCommandConsumer dead-letters a non-Error permanent processing error', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    const handle = await startCommandConsumer({
      db: throwingDb('data integrity failure' as unknown as Error),
      registry: emptyRegistry(),
      amqpUrl: 'amqp://test',
    })
    broker.deliver({ content: { toString: () => PING_ENVELOPE_JSON } })
    await waitForDisposition(broker.dispositions)
    assertEquals(broker.dispositions, [{ method: 'nack', requeue: false }])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startCommandConsumer retries AMQP connect once then succeeds', async () => {
  const broker = createStubBroker()
  let attempts = 0
  const connectStub = stub(amqplib, 'connect', () => {
    attempts += 1
    if (attempts === 1) return Promise.reject(new Error('ECONNREFUSED'))
    return Promise.resolve(broker.connection as never)
  })
  try {
    const handle = await startCommandConsumer({
      db: missingRowDb(),
      registry: emptyRegistry(),
      amqpUrl: 'amqp://retry',
    })
    assertEquals(attempts, 2)
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startCommandConsumer rejects when the first connect succeeds but channel setup fails', async () => {
  const connectStub = stub(amqplib, 'connect', () =>
    Promise.resolve({
      createConfirmChannel: () => Promise.reject(new Error('channel down')),
      close: async () => undefined,
    } as never))
  try {
    await assertRejects(
      () =>
        startCommandConsumer({
          db: missingRowDb(),
          registry: emptyRegistry(),
          amqpUrl: 'amqp://bad-channel',
        }),
      Error,
      'channel down',
    )
  } finally {
    connectStub.restore()
  }
})
