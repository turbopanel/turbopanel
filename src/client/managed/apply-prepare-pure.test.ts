import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  decryptSecretForDaemon,
  parseDaemonSecretEnvelope,
} from '../authn/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../authn/secrets.ts'
import type { ManagedApplyCommandPayload } from '../../lib/commands/schemas.ts'
import {
  mintOrganizationCa,
  verifyCertificateSignature,
} from '../../lib/tls/index.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { CommandRecord } from '../../lib/db/command-records.ts'
import type { CommandStatus } from '../../lib/commands/types.ts'
import type { Db } from '../../db.ts'
import {
  awaitCommandTerminal,
  buildManagedOrgTlsMaterial,
  isPrepareError,
  mapManagedApplyPrepareError,
  prepareErrorResponse,
  type ManagedApplyPrepareError,
} from './apply-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

function assertPayloadShape(value: unknown): asserts value is ManagedApplyCommandPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected ManagedApplyCommandPayload object')
  }
  if (!('managedId' in value) || typeof value.managedId !== 'string') {
    throw new TypeError('expected managedId string on payload')
  }
  if ('kind' in value) {
    throw new TypeError('payload must not carry prepare-error kind')
  }
}

function minimalPayload(
  overrides: Partial<ManagedApplyCommandPayload> = {},
): ManagedApplyCommandPayload {
  return {
    managedId: 'm1',
    environmentId: 'e1',
    engine: 'postgres',
    // The compose project is the bare `managed` row id — no readable prefix.
    projectName: 'm1',
    containerName: 'svc-1',
    image: 'postgres:18',
    containerPort: 5432,
    composeYaml: 'services: {}',
    configFiles: [],
    volumes: [],
    exposure: { enabled: false, protocol: 'tcp' },
    credentials: [],
    ...overrides,
  } as ManagedApplyCommandPayload
}

const ALL_PREPARE_ERRORS: Array<{
  error: ManagedApplyPrepareError
  status: number
  body: string
}> = [
  {
    error: { kind: 'datacenter_ip_required', serverId: 's1' },
    status: 422,
    body: 'datacenter_ip_required',
  },
  {
    error: { kind: 'daemon_key_unavailable', serverId: 's1' },
    status: 422,
    body: 'daemon_key_unavailable',
  },
  {
    error: { kind: 'managed_credential_not_sealed' },
    status: 500,
    body: 'managed_credential_not_sealed',
  },
  {
    error: { kind: 'managed_settings_invalid' },
    status: 400,
    body: 'managed_settings_invalid',
  },
  {
    error: { kind: 'managed_primary_missing' },
    status: 500,
    body: 'managed_primary_missing',
  },
  {
    error: { kind: 'managed_private_port_exhausted', serverId: 's1' },
    status: 409,
    body: 'managed_private_port_exhausted',
  },
  {
    error: { kind: 'managed_listener_bind_conflict', serverId: 's1' },
    status: 422,
    body: 'managed_listener_bind_conflict',
  },
  {
    error: {
      kind: 'private_path_unavailable',
      fromServerId: 's1',
      toServerId: 's2',
    },
    status: 422,
    body: 'private_path_unavailable',
  },
  {
    error: {
      kind: 'private_family_mismatch',
      fromServerId: 's1',
      toServerId: 's2',
      datacenterId: 'dc-a',
    },
    status: 422,
    body: 'private_family_mismatch',
  },
  {
    error: {
      kind: 'failover_requires_trusted_datacenter',
      fromServerId: 's1',
      toServerId: 's2',
      datacenterId: 'dc-a',
    },
    status: 422,
    body: 'failover_requires_trusted_datacenter',
  },
]

test('isPrepareError is true for every ManagedApplyPrepareError kind', () => {
  for (const { error } of ALL_PREPARE_ERRORS) {
    assertEquals(isPrepareError(error), true)
  }
})

test('isPrepareError is false for command payloads without kind', () => {
  const payload = minimalPayload()
  assertPayloadShape(payload)
  assertEquals(isPrepareError(payload), false)

  const withExtras = minimalPayload({
    databases: [{ name: 'app', action: 'create' }],
    dropUsers: ['u1'],
    resources: { cpus: 1 },
  })
  assertPayloadShape(withExtras)
  assertEquals(isPrepareError(withExtras), false)
})

test('isPrepareError treats any kind-bearing object as prepare error', () => {
  // Discriminator is structural (`'kind' in value`) — payloads never carry kind.
  const tagged = { kind: 'datacenter_ip_required', serverId: 's2' }
  assertEquals(isPrepareError(tagged as ManagedApplyPrepareError), true)

  const sealedOnly: ManagedApplyPrepareError = {
    kind: 'managed_credential_not_sealed',
  }
  assertEquals(isPrepareError(sealedOnly), true)
})

test('isPrepareError distinguishes error kinds from payloads', () => {
  const error: ManagedApplyPrepareError = {
    kind: 'managed_settings_invalid',
  }
  assertEquals(isPrepareError(error), true)

  const payload = minimalPayload()
  assertEquals(isPrepareError(payload), false)
})

test('prepareErrorResponse maps every ManagedApplyPrepareError kind', async () => {
  const c = mockContext()

  for (const { error, status, body } of ALL_PREPARE_ERRORS) {
    const response = prepareErrorResponse(c, error)
    assertEquals(response.status, status)
    const json: unknown = await response.json()
    if (typeof json !== 'object' || json === null || !('error' in json)) {
      throw new TypeError('expected { error } JSON body')
    }
    assertEquals(json, { error: body })
  }
})

test('prepareErrorResponse status codes stay stable per kind', async () => {
  const c = mockContext()

  const datacenter = prepareErrorResponse(c, {
    kind: 'datacenter_ip_required',
    serverId: 'srv-a',
  })
  assertEquals(datacenter.status, 422)
  assertEquals(await datacenter.json(), { error: 'datacenter_ip_required' })

  const daemonKey = prepareErrorResponse(c, {
    kind: 'daemon_key_unavailable',
    serverId: 'srv-b',
  })
  assertEquals(daemonKey.status, 422)
  assertEquals(await daemonKey.json(), { error: 'daemon_key_unavailable' })

  const credential = prepareErrorResponse(c, {
    kind: 'managed_credential_not_sealed',
  })
  assertEquals(credential.status, 500)
  assertEquals(await credential.json(), { error: 'managed_credential_not_sealed' })

  const settings = prepareErrorResponse(c, {
    kind: 'managed_settings_invalid',
  })
  assertEquals(settings.status, 400)
  assertEquals(await settings.json(), { error: 'managed_settings_invalid' })
})

test('mapManagedApplyPrepareError delegates to prepareErrorResponse for every kind', async () => {
  const c = mockContext()

  for (const { error, status, body } of ALL_PREPARE_ERRORS) {
    const viaMap = mapManagedApplyPrepareError(c, error)
    const viaPrepare = prepareErrorResponse(c, error)
    assertEquals(viaMap.status, status)
    assertEquals(viaMap.status, viaPrepare.status)
    assertEquals(await viaMap.json(), { error: body })
  }
})

test('mapManagedApplyPrepareError matches prepareErrorResponse body and status', async () => {
  const c = mockContext()
  const error: ManagedApplyPrepareError = {
    kind: 'daemon_key_unavailable',
    serverId: 's-match',
  }
  const mapped = mapManagedApplyPrepareError(c, error)
  const prepared = prepareErrorResponse(c, error)
  assertEquals(mapped.status, prepared.status)
  assertEquals(await mapped.json(), await prepared.json())
})

test('mapManagedApplyPrepareError returns 400 for managed_settings_invalid', async () => {
  const c = mockContext()
  const response = mapManagedApplyPrepareError(c, {
    kind: 'managed_settings_invalid',
  })
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'managed_settings_invalid' })
})

test('prepareErrorResponse ignores serverId on wire body', async () => {
  const c = mockContext()
  const response = prepareErrorResponse(c, {
    kind: 'datacenter_ip_required',
    serverId: 'should-not-leak',
  })
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new TypeError('expected JSON object body')
  }
  assertEquals(Object.keys(body).sort((a, b) => a.localeCompare(b)), ['error'])
  assertEquals(body, { error: 'datacenter_ip_required' })
})

test('buildManagedOrgTlsMaterial issues CA-signed leaf and reseals as denc', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const serverId = '11111111-1111-4111-8111-111111111111'
  const keyId = '22222222-2222-4222-8222-222222222222'
  const managedId = '33333333-3333-4333-8333-333333333333'

  const ca = await mintOrganizationCa({ organizationId: 'Org CA Test' })
  const material = await buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId },
    { certificatePem: ca.certificatePem, privateKeyPem: ca.privateKeyPem, trustBundlePem: ca.certificatePem },
    managedId,
  )

  assertEquals(material.certificatePem.includes('BEGIN CERTIFICATE'), true)
  assertEquals(material.caCertPem, ca.certificatePem)
  assertEquals(material.privateKeyEnvelope.startsWith('tpdaemon.'), true)

  const parsed = parseDaemonSecretEnvelope(material.privateKeyEnvelope)
  assertEquals(parsed?.serverId, serverId)
  assertEquals(parsed?.keyId, keyId)

  const privateKeyPem = await decryptSecretForDaemon(
    secretsConfig,
    { serverId, keyId },
    material.privateKeyEnvelope,
  )
  assertEquals(privateKeyPem.includes('BEGIN PRIVATE KEY'), true)

  assertEquals(
    await verifyCertificateSignature(material.certificatePem, material.caCertPem),
    true,
  )

  // Managed leaves must carry the clientAuth EKU — ProxySQL presents them as
  // client certs on proxy-to-server connections, and Postgres rejects a
  // serverAuth-only leaf with "unsuitable certificate purpose" once
  // ssl_ca_file is set.
  const derBase64 = material.certificatePem
    .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '')
  const der = Uint8Array.from(atob(derBase64), (c) => c.charCodeAt(0))
  // OID 1.3.6.1.5.5.7.3.2 (id-kp-clientAuth) as DER TLV.
  const clientAuthOid = [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02]
  const containsClientAuth = der.some((_, i) =>
    clientAuthOid.every((byte, j) => der[i + j] === byte)
  )
  assertEquals(containsClientAuth, true)
})

test('buildManagedOrgTlsMaterial org A leaf does not validate against org B CA bundle', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const recipientA = {
    serverId: '11111111-1111-4111-8111-111111111111',
    keyId: '22222222-2222-4222-8222-222222222222',
  }
  const recipientB = {
    serverId: '55555555-5555-4555-8555-555555555555',
    keyId: '66666666-6666-4666-8666-666666666666',
  }
  const orgA = await mintOrganizationCa({ organizationId: 'Org A CA' })
  const orgBActive = await mintOrganizationCa({ organizationId: 'Org B CA Active' })
  const orgBRetired = await mintOrganizationCa({ organizationId: 'Org B CA Retired' })
  const orgBBundle = `${orgBActive.certificatePem}${orgBRetired.certificatePem}`

  const leafA = await buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    recipientA,
    {
      certificatePem: orgA.certificatePem,
      privateKeyPem: orgA.privateKeyPem,
      trustBundlePem: orgA.certificatePem,
    },
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  )
  const leafB = await buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    recipientB,
    {
      certificatePem: orgBActive.certificatePem,
      privateKeyPem: orgBActive.privateKeyPem,
      trustBundlePem: orgBBundle,
    },
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  )

  assertEquals(leafB.caCertPem, orgBBundle)
  assertEquals(
    await verifyCertificateSignature(leafA.certificatePem, orgA.certificatePem),
    true,
  )
  assertEquals(
    await verifyCertificateSignature(leafA.certificatePem, orgBBundle),
    false,
  )
  assertEquals(
    await verifyCertificateSignature(leafB.certificatePem, orgBBundle),
    true,
  )
  assertEquals(
    await verifyCertificateSignature(leafB.certificatePem, orgA.certificatePem),
    false,
  )
})

test('buildManagedOrgTlsMaterial ships trustBundlePem as caCertPem and signs with the active signer', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const active = await mintOrganizationCa({ organizationId: 'Org CA Active' })
  const retired = await mintOrganizationCa({ organizationId: 'Org CA Retired' })
  const trustBundlePem = `${active.certificatePem}${retired.certificatePem}`
  const material = await buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    {
      serverId: '11111111-1111-4111-8111-111111111111',
      keyId: '22222222-2222-4222-8222-222222222222',
    },
    {
      certificatePem: active.certificatePem,
      privateKeyPem: active.privateKeyPem,
      trustBundlePem,
    },
    '44444444-4444-4444-8444-444444444444',
  )

  assertEquals(material.caCertPem, trustBundlePem)
  assertEquals(material.caCertPem.split('BEGIN CERTIFICATE').length - 1, 2)
  assertEquals(
    await verifyCertificateSignature(material.certificatePem, material.caCertPem),
    true,
  )
})

test('buildManagedOrgTlsMaterial adds private listener IP SAN for remote replication', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const managedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const ca = await mintOrganizationCa({ organizationId: 'Org CA Remote Primary' })
  const material = await buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    {
      serverId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      keyId: 'cccccccc-dddd-4eee-8fff-000000000000',
    },
    { certificatePem: ca.certificatePem, privateKeyPem: ca.privateKeyPem, trustBundlePem: ca.certificatePem },
    managedId,
    ['svc-1'],
    ['203.0.113.50'],
  )

  const { parseCertificatePem } = await import('../../lib/tls/parse.ts')
  const leaf = await parseCertificatePem(material.certificatePem)
  assertEquals(leaf.dnsNames.includes(`managed-${managedId}`), true)
  assertEquals(leaf.dnsNames.includes('svc-1'), true)
  assertEquals(leaf.ipAddresses.includes('203.0.113.50'), true)
})

test('buildManagedOrgTlsMaterial dedupes managed leaf name and localhost from extraSans', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const managedId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb'
  const ca = await mintOrganizationCa({ organizationId: 'Org CA Dedupe Test' })
  const material = await buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    {
      serverId: 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc',
      keyId: 'ffffffff-0000-4bbb-8ccc-dddddddddddd',
    },
    { certificatePem: ca.certificatePem, privateKeyPem: ca.privateKeyPem, trustBundlePem: ca.certificatePem },
    managedId,
    [`managed-${managedId}`, 'localhost', 'extra.example'],
  )

  const { parseCertificatePem } = await import('../../lib/tls/parse.ts')
  const leaf = await parseCertificatePem(material.certificatePem)
  const managedName = `managed-${managedId}`
  assertEquals(
    leaf.dnsNames.filter((name) => name === managedName).length,
    1,
  )
  assertEquals(
    leaf.dnsNames.filter((name) => name === 'localhost').length,
    1,
  )
  assertEquals(leaf.dnsNames.includes('extra.example'), true)
})

function commandRecord(status: CommandStatus): CommandRecord {
  return {
    id: 'cmd-1',
    serverId: 'srv-1',
    actorEntityType: 'user',
    actorEntityId: 'u1',
    type: 'managed.apply',
    status,
    context: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    error: null,
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    queuedAt: null,
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
  }
}

test('awaitCommandTerminal returns the first terminal record', async () => {
  const db = {} as Db
  const record = commandRecord('succeeded')
  const result = await awaitCommandTerminal(db, 'cmd-1', {
    loadCommand: () => Promise.resolve(record),
    sleep: () => Promise.resolve(),
  })
  assertEquals(result, record)
})

test('awaitCommandTerminal polls until the command is terminal', async () => {
  const db = {} as Db
  const polls: CommandStatus[] = ['queued', 'running', 'succeeded']
  let slept = 0
  const result = await awaitCommandTerminal(db, 'cmd-1', {
    timeoutMs: 5_000,
    pollMs: 1,
    loadCommand: () => {
      const status = polls.shift()
      if (!status) throw new TypeError('unexpected extra poll')
      return Promise.resolve(commandRecord(status))
    },
    sleep: () => {
      slept += 1
      return Promise.resolve()
    },
  })
  assertEquals(result?.status, 'succeeded')
  assertEquals(slept, 2)
})

test('awaitCommandTerminal returns the last record after timeout', async () => {
  const db = {} as Db
  const result = await awaitCommandTerminal(db, 'cmd-1', {
    timeoutMs: 0,
    loadCommand: () => Promise.resolve(commandRecord('queued')),
    sleep: () => Promise.resolve(),
  })
  assertEquals(result?.status, 'queued')
})

test('awaitCommandTerminal returns null when the command is missing', async () => {
  const db = {} as Db
  const result = await awaitCommandTerminal(db, 'cmd-missing', {
    timeoutMs: 0,
    loadCommand: () => Promise.resolve(null),
    sleep: () => Promise.resolve(),
  })
  assertEquals(result, null)
})
