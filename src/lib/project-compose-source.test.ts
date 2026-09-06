import { assertEquals } from '@std/assert'
import { composeSourceDigest, parseComposeSourceInput } from './project-options.ts'
import { detectComposeSourceDrift } from './project-compose-source.ts'

const test = Deno.test.bind(Deno)

const SEEDED = 'services:\n  web:\n    image: nginx\n'

async function seeded() {
  return {
    sourceId: '00000000-0000-4000-8000-000000000001',
    path: 'docker-compose.yml',
    seededCommitSha: 'a'.repeat(40),
    seededDigest: await composeSourceDigest(SEEDED),
  }
}

test('drift compares the repo against what was seeded, not the current compose', async () => {
  // The operator editing their own compose must never read as drift — that is
  // the whole reason the digest hashes the seeded repo bytes.
  const composeSource = await seeded()
  assertEquals(
    await detectComposeSourceDrift({
      composeSource,
      read: () =>
        Promise.resolve({ ok: true as const, commitSha: 'b'.repeat(40), content: SEEDED }),
    }),
    { state: 'unchanged' },
  )
})

test('drift is reported when the repository file changed', async () => {
  const composeSource = await seeded()
  const result = await detectComposeSourceDrift({
    composeSource,
    read: () =>
      Promise.resolve({
        ok: true as const,
        commitSha: 'c'.repeat(40),
        content: SEEDED + '    ports: ["80:80"]\n',
      }),
  })
  assertEquals(result.state, 'drifted')
})

test('a file that disappeared counts as drift, not as unchanged', async () => {
  // The provenance no longer resolves; silently reporting "unchanged" would
  // hide that from the operator.
  const composeSource = await seeded()
  const result = await detectComposeSourceDrift({
    composeSource,
    read: () =>
      Promise.resolve({ ok: true as const, commitSha: 'd'.repeat(40), content: null }),
  })
  assertEquals(result.state, 'drifted')
})

test('an unreadable repository is reported as such, never as drift', async () => {
  const composeSource = await seeded()
  const result = await detectComposeSourceDrift({
    composeSource,
    read: () => Promise.resolve({ ok: false as const, reason: 'server_offline' }),
  })
  assertEquals(result, { state: 'unreadable', reason: 'server_offline' })
})

test('a project with no composeSource is simply not seeded', async () => {
  assertEquals(
    await detectComposeSourceDrift({
      composeSource: undefined,
      read: () => {
        throw new Error('must not read')
      },
    }),
    { state: 'not_seeded' },
  )
})

test('parseComposeSourceInput rejects rather than silently dropping', async () => {
  const base = await seeded()
  // Losing the provenance of a project's compose is not a recoverable mistake,
  // so a malformed block must fail the write instead of vanishing.
  assertEquals(parseComposeSourceInput({ ...base, path: '../etc/passwd' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, path: '/etc/passwd' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, seededDigest: 'nope' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, seededCommitSha: 'zz' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, mode: 'live' }).ok, false)
  assertEquals(parseComposeSourceInput(base).ok, true)
  // Explicit null clears it.
  assertEquals(parseComposeSourceInput(null), { ok: true, value: null })
})

test('parseComposeSourceInput scopes the source to the organization', async () => {
  const base = await seeded()
  assertEquals(parseComposeSourceInput(base, new Set(['other'])).ok, false)
  assertEquals(parseComposeSourceInput(base, new Set([base.sourceId])).ok, true)
})

test('parseComposeSourceInput rejects an empty sourceId and an oversized ref', async () => {
  const base = await seeded()
  assertEquals(
    parseComposeSourceInput({ ...base, sourceId: '' }).ok,
    false,
  )
  assertEquals(
    parseComposeSourceInput({ ...base, ref: 'x'.repeat(256) }).ok,
    false,
  )
})
