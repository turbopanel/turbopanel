import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { Hono } from 'hono'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import {
  buildLocalConsoleAuthorization,
  buildLocalConsoleCanonicalPayload,
  hashLocalConsoleContent,
  LOCAL_CONSOLE_CONTENT_SHA256_HEADER,
  LOCAL_CONSOLE_INFO,
  LOCAL_CONSOLE_MAX_SKEW_MS,
  LOCAL_CONSOLE_SCHEME,
  localConsoleRequestTarget,
  verifyLocalConsoleAuthorization,
} from './local-console-auth.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SECRET = TEST_ONLY_TURBOPANEL_SECRET
const SECRET_V2 =
  'Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7'
const PATH = '/api/developer/v1/daemon/sync-dev'

const ENV_KEYS = [
  'TURBOPANEL_DEV_SURFACE',
  'TURBOPANEL_MODE',
  'TURBOPANEL_UI_MODE',
  'TURBOPANEL_SECRET',
  'TURBOPANEL_SECRETS',
] as const

async function withDevSurface<T>(
  fn: () => Promise<T>,
  keyring?: string,
): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) saved.set(key, Deno.env.get(key))
  try {
    Deno.env.set('TURBOPANEL_DEV_SURFACE', '1')
    if (keyring !== undefined) {
      Deno.env.set('TURBOPANEL_SECRETS', keyring)
    } else {
      Deno.env.set('TURBOPANEL_SECRETS', `1:${SECRET}`)
    }
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
}

async function signedRequest(opts: {
  method?: string
  url?: string
  body?: string
  timestamp?: string
  contentSha256?: string
  authorization?: string
  mutateAuthPath?: string
  mutateAuthMethod?: string
} = {}): Promise<Request> {
  const method = opts.method ?? 'POST'
  const url = opts.url ?? `http://localhost${PATH}`
  const body = opts.body ?? '{}'
  const requestTarget = new URL(url).pathname + new URL(url).search
  const contentSha256 = opts.contentSha256 ?? await hashLocalConsoleContent(body)
  const timestamp = opts.timestamp ?? new Date().toISOString()
  const authorization = opts.authorization ??
    await buildLocalConsoleAuthorization(
      opts.mutateAuthMethod ?? method,
      opts.mutateAuthPath ?? requestTarget,
      SECRET,
      contentSha256,
      timestamp,
    )
  return new Request(url, {
    method,
    headers: {
      Authorization: authorization,
      [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
      'content-type': 'application/json',
    },
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  })
}

async function verifyRequest(
  request: Request,
  nowMs?: number,
  rootSecret?: string,
): Promise<boolean> {
  const app = new Hono()
  let result = false
  app.all('*', async (c) => {
    result = await verifyLocalConsoleAuthorization(c, rootSecret, nowMs)
    return c.json({ ok: result })
  })
  await app.request(request)
  return result
}

describe('local-console canonical payload helpers', () => {
  it('buildLocalConsoleCanonicalPayload uses NUL separators and uppercases method', () => {
    const payload = buildLocalConsoleCanonicalPayload(
      '2026-08-14T12:00:00.000Z',
      'post',
      '/api/developer/v1/x?y=1',
      'digest',
    )
    assertEquals(
      payload,
      `${LOCAL_CONSOLE_INFO}\0${'2026-08-14T12:00:00.000Z'}\0POST\0/api/developer/v1/x?y=1\0digest`,
    )
  })

  it('localConsoleRequestTarget includes search and excludes hash', () => {
    assertEquals(
      localConsoleRequestTarget('http://localhost/api/dev?force=1#ignored'),
      '/api/dev?force=1',
    )
    assertEquals(
      localConsoleRequestTarget(new URL('https://host/path')),
      '/path',
    )
  })

  it('hashLocalConsoleContent is stable for empty bodies', async () => {
    const empty = await hashLocalConsoleContent(new Uint8Array())
    const fromString = await hashLocalConsoleContent('')
    assertEquals(empty, fromString)
    assertEquals(empty.length > 0, true)
  })
})

describe('verifyLocalConsoleAuthorization', () => {
  it('is disabled when the developer surface is off', async () => {
    const saved = Deno.env.get('TURBOPANEL_DEV_SURFACE')
    try {
      Deno.env.delete('TURBOPANEL_DEV_SURFACE')
      const req = await signedRequest()
      assertEquals(await verifyRequest(req), false)
    } finally {
      if (saved === undefined) Deno.env.delete('TURBOPANEL_DEV_SURFACE')
      else Deno.env.set('TURBOPANEL_DEV_SURFACE', saved)
    }
  })

  it('accepts a valid signed mutating request within skew', async () => {
    await withDevSurface(async () => {
      const now = Date.now()
      const req = await signedRequest({
        timestamp: new Date(now).toISOString(),
      })
      assertEquals(await verifyRequest(req, now), true)
    })
  })

  it('accepts HMAC signed with TURBOPANEL_SECRET when TURBOPANEL_SECRETS is unset', async () => {
    const saved = new Map<string, string | undefined>()
    for (const key of ENV_KEYS) saved.set(key, Deno.env.get(key))
    try {
      Deno.env.set('TURBOPANEL_DEV_SURFACE', '1')
      Deno.env.delete('TURBOPANEL_SECRETS')
      Deno.env.set('TURBOPANEL_SECRET', SECRET)
      const req = await signedRequest()
      assertEquals(await verifyRequest(req), true)
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) Deno.env.delete(key)
        else Deno.env.set(key, value)
      }
    }
  })

  it('rejects expired skew', async () => {
    await withDevSurface(async () => {
      const now = Date.now()
      const issued = now - LOCAL_CONSOLE_MAX_SKEW_MS - 1_000
      const req = await signedRequest({
        timestamp: new Date(issued).toISOString(),
      })
      assertEquals(await verifyRequest(req, now), false)
    })
  })

  it('rejects method mismatch', async () => {
    await withDevSurface(async () => {
      const req = await signedRequest({
        method: 'POST',
        mutateAuthMethod: 'PUT',
      })
      assertEquals(await verifyRequest(req), false)
    })
  })

  it('rejects path mismatch', async () => {
    await withDevSurface(async () => {
      const req = await signedRequest({
        mutateAuthPath: '/api/developer/v1/other',
      })
      assertEquals(await verifyRequest(req), false)
    })
  })

  it('rejects query tampering', async () => {
    await withDevSurface(async () => {
      const base = `http://localhost${PATH}?force=1`
      const contentSha256 = await hashLocalConsoleContent('{}')
      const timestamp = new Date().toISOString()
      const authorization = await buildLocalConsoleAuthorization(
        'POST',
        `${PATH}?force=1`,
        SECRET,
        contentSha256,
        timestamp,
      )
      // Replay captured auth against a different query string.
      const tampered = new Request(`http://localhost${PATH}?force=0`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
          'content-type': 'application/json',
        },
        body: '{}',
      })
      assertEquals(await verifyRequest(tampered), false)

      const honest = await signedRequest({ url: base })
      assertEquals(await verifyRequest(honest), true)
    })
  })

  it('rejects body tampering while keeping captured digest/auth headers', async () => {
    await withDevSurface(async () => {
      const originalBody = '{"ok":true}'
      const contentSha256 = await hashLocalConsoleContent(originalBody)
      const timestamp = new Date().toISOString()
      const authorization = await buildLocalConsoleAuthorization(
        'POST',
        PATH,
        SECRET,
        contentSha256,
        timestamp,
      )
      const tampered = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
          'content-type': 'application/json',
        },
        body: '{"ok":false}',
      })
      assertEquals(await verifyRequest(tampered), false)
    })
  })

  it('leaves request body readable after verification', async () => {
    await withDevSurface(async () => {
      const body = '{"ping":true}'
      const req = await signedRequest({ body })
      const app = new Hono()
      let authOk = false
      let seenBody = ''
      app.post('*', async (c) => {
        authOk = await verifyLocalConsoleAuthorization(c, SECRET)
        seenBody = await c.req.text()
        return c.json({ ok: true })
      })
      await app.request(req)
      assertEquals(authOk, true)
      assertEquals(seenBody, body)
    })
  })

  it('accepts GET without re-checking body bytes against the digest header', async () => {
    await withDevSurface(async () => {
      const contentSha256 = await hashLocalConsoleContent('{}')
      const timestamp = new Date().toISOString()
      const authorization = await buildLocalConsoleAuthorization(
        'GET',
        PATH,
        SECRET,
        contentSha256,
        timestamp,
      )
      const req = new Request(`http://localhost${PATH}`, {
        method: 'GET',
        headers: {
          Authorization: authorization,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
        },
      })
      assertEquals(await verifyRequest(req), true)
    })
  })

  it('uses the current keyring entry [0] for verification', async () => {
    await withDevSurface(async () => {
      const body = '{}'
      const contentSha256 = await hashLocalConsoleContent(body)
      const timestamp = new Date().toISOString()
      const authorization = await buildLocalConsoleAuthorization(
        'POST',
        PATH,
        SECRET_V2,
        contentSha256,
        timestamp,
      )
      const req = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
          'content-type': 'application/json',
        },
        body,
      })
      assertEquals(await verifyRequest(req), true)
    }, `2:${SECRET_V2},1:${SECRET}`)
  })

  it('rejects authorization signed with a retired keyring entry', async () => {
    await withDevSurface(async () => {
      const body = '{}'
      const contentSha256 = await hashLocalConsoleContent(body)
      const timestamp = new Date().toISOString()
      const authorization = await buildLocalConsoleAuthorization(
        'POST',
        PATH,
        SECRET,
        contentSha256,
        timestamp,
      )
      const req = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
          'content-type': 'application/json',
        },
        body,
      })
      assertEquals(await verifyRequest(req), false)
    }, `2:${SECRET_V2},1:${SECRET}`)
  })

  it('rejects requests when instance secrets configuration is invalid', async () => {
    await withDevSurface(async () => {
      const req = await signedRequest()
      assertEquals(await verifyRequest(req), false)
    }, 'not-a-valid-keyring')
  })

  it('rejects malformed authorization material and a missing digest header', async () => {
    await withDevSurface(async () => {
      const noScheme = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer nope' },
        body: '{}',
      })
      assertEquals(await verifyRequest(noScheme, undefined, SECRET), false)

      const noDot = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { Authorization: `${LOCAL_CONSOLE_SCHEME} nodot` },
        body: '{}',
      })
      assertEquals(await verifyRequest(noDot, undefined, SECRET), false)

      const badB64 = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { Authorization: `${LOCAL_CONSOLE_SCHEME} %%%.$$$` },
        body: '{}',
      })
      assertEquals(await verifyRequest(badB64, undefined, SECRET), false)

      const notADate = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `${LOCAL_CONSOLE_SCHEME} ${btoa('not-a-date')}.aaaaaaaa`,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: 'digest',
        },
        body: '{}',
      })
      assertEquals(await verifyRequest(notADate, undefined, SECRET), false)

      const missingDigest = await signedRequest()
      const withoutDigest = new Request(missingDigest.url, {
        method: 'POST',
        headers: { Authorization: missingDigest.headers.get('Authorization') ?? '' },
        body: '{}',
      })
      assertEquals(await verifyRequest(withoutDigest, undefined, SECRET), false)

      const noHeader = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        body: '{}',
      })
      assertEquals(await verifyRequest(noHeader, undefined, SECRET), false)

      const leadingDot = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { Authorization: `${LOCAL_CONSOLE_SCHEME} .aaaaaaaa` },
        body: '{}',
      })
      assertEquals(await verifyRequest(leadingDot, undefined, SECRET), false)

      const timestamp = btoa(new Date().toISOString())
      const shortSig = btoa(String.fromCodePoint(1, 2, 3))
      const lengthMismatch = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `${LOCAL_CONSOLE_SCHEME} ${timestamp}.${shortSig}`,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: 'digest',
        },
        body: '{}',
      })
      assertEquals(await verifyRequest(lengthMismatch, undefined, SECRET), false)

      const emptySecret = await signedRequest()
      assertEquals(await verifyRequest(emptySecret, undefined, ''), false)
    })
  })
})
test('local-console auth suite loaded', () => {
  assertEquals(typeof verifyLocalConsoleAuthorization, 'function')
})
