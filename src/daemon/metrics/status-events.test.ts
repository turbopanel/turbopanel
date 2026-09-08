import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { resetMetricsRateLimitForTests } from './validation.ts'
import {
  emitServerStatusEvent,
  getServerStatusEventSink,
  resetServerStatusEventSinkForTests,
  type ServerStatusEventSink,
  setServerStatusEventSink,
} from './status-events.ts'

const EVENT = {
  serverId: '11111111-2222-4333-8444-555555555555',
  connected: true,
  reason: 'connect' as const,
  at: '2026-01-01T00:00:00.000Z',
}

it('setServerStatusEventSink registers and clears the module sink', () => {
  resetServerStatusEventSinkForTests()
  assertEquals(getServerStatusEventSink(), null)

  const sink: ServerStatusEventSink = { writeStatusEvent() {} }
  setServerStatusEventSink(sink)
  assertEquals(getServerStatusEventSink(), sink)

  setServerStatusEventSink(null)
  assertEquals(getServerStatusEventSink(), null)
})

it('emitServerStatusEvent is a no-op when no sink is registered', () => {
  resetServerStatusEventSinkForTests()
  emitServerStatusEvent(EVENT)
})

it('emitServerStatusEvent prefers an explicit sink over the registered one', () => {
  resetServerStatusEventSinkForTests()
  const registered: string[] = []
  const explicit: string[] = []
  setServerStatusEventSink({
    writeStatusEvent() {
      registered.push('registered')
    },
  })
  emitServerStatusEvent(EVENT, {
    writeStatusEvent() {
      explicit.push('explicit')
    },
  })
  assertEquals(explicit, ['explicit'])
  assertEquals(registered, [])
})

it('emitServerStatusEvent uses the registered sink when no explicit sink', () => {
  resetServerStatusEventSinkForTests()
  const calls: ServerStatusEventSink['writeStatusEvent'] extends (event: infer E) => unknown
    ? E[]
    : never = []
  setServerStatusEventSink({
    writeStatusEvent(event) {
      calls.push(event)
    },
  })
  emitServerStatusEvent(EVENT)
  assertEquals(calls, [EVENT])
})

it('emitServerStatusEvent swallows sync throws from writeStatusEvent', () => {
  resetMetricsRateLimitForTests()
  const errors: string[] = []
  const originalError = console.error
  console.error = (msg?: unknown) => {
    errors.push(String(msg))
  }
  try {
    emitServerStatusEvent(EVENT, {
      writeStatusEvent() {
        throw new Error('sync write failed')
      },
    })
    assertEquals(errors.length, 1)
    assertEquals(errors[0]?.includes('status_write_failed'), true)
    assertEquals(errors[0]?.includes(EVENT.serverId), true)
  } finally {
    console.error = originalError
  }
})

it('emitServerStatusEvent swallows rejected promises from writeStatusEvent', async () => {
  resetMetricsRateLimitForTests()
  const errors: string[] = []
  const originalError = console.error
  console.error = (msg?: unknown) => {
    errors.push(String(msg))
  }
  try {
    emitServerStatusEvent(EVENT, {
      writeStatusEvent() {
        return Promise.reject(new Error('async write failed'))
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertEquals(errors.length, 1)
    assertEquals(errors[0]?.includes('async write failed'), true)
  } finally {
    console.error = originalError
  }
})
