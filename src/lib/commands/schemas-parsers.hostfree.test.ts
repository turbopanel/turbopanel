/**
 * Host-free coverage for schema parsers not exercised in schemas.test.ts.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { managedHaContainerNameFromService } from '../naming.ts'
import {
  parseCommandPayload,
  parseCommandResult,
  parseDeploySecretPlan,
  parseManagedHaFailoverPayload,
  parseManagedHaFailoverResult,
  parseManagedHaReconcilePayload,
  parseManagedHaReconcileResult,
  parseManagedReplicationHealth,
  parsePrincipalsReconcilePayload,
  parsePrincipalsReconcileResult,
  parseTlsTrustReconcilePayload,
  parseTlsTrustReconcileResult,
} from './schemas.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PRINCIPAL_ID = '00000000-0000-4000-8000-000000000001'
const SERVER_ID = '00000000-0000-4000-8000-0000000000bb'
const HA_SERVICE_ID = '00000000-0000-4000-8000-0000000000cc'
const MEMBER_ID = '00000000-0000-4000-8000-0000000000dd'
/** Org-wide managed Docker network name — a `network.kind='managed'` row id. */
const MANAGED_NETWORK = '00000000-0000-4000-8000-0000000000ee'
const PEM =
  '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'

test('parsePrincipalsReconcilePayload accepts principals and rejects duplicates', () => {
  assertEquals(
    parsePrincipalsReconcilePayload({
      principals: [{ principalId: PRINCIPAL_ID, username: 'deploy' }],
    }),
    {
      principals: [{ principalId: PRINCIPAL_ID, username: 'deploy' }],
    },
  )
  assertThrows(
    () =>
      parsePrincipalsReconcilePayload({
        principals: [
          { principalId: PRINCIPAL_ID, username: 'deploy' },
          { principalId: '00000000-0000-4000-8000-000000000002', username: 'deploy' },
        ],
      }),
    Error,
    'principals contains deploy more than once',
  )
  assertThrows(
    () => parsePrincipalsReconcilePayload({ principals: 'x' }),
    TypeError,
    'principals must be an array',
  )
  assertThrows(
    () => parsePrincipalsReconcilePayload(null),
    Error,
    'Invalid principals reconcile payload',
  )
})

test('parsePrincipalsReconcileResult validates integer and boolean fields', () => {
  assertEquals(
    parsePrincipalsReconcileResult({
      principalsApplied: 2,
      keysChanged: ['deploy'],
      keysRemoved: [],
      sshdReloaded: true,
      warnings: ['reloaded'],
    }),
    {
      principalsApplied: 2,
      keysChanged: ['deploy'],
      keysRemoved: [],
      sshdReloaded: true,
      warnings: ['reloaded'],
    },
  )
  assertThrows(
    () =>
      parsePrincipalsReconcileResult({
        principalsApplied: 1.5,
        keysChanged: [],
        keysRemoved: [],
        sshdReloaded: true,
        warnings: [],
      }),
    TypeError,
    'principalsApplied must be an integer',
  )
  assertThrows(
    () =>
      parsePrincipalsReconcileResult({
        principalsApplied: 1,
        keysChanged: [1],
        keysRemoved: [],
        sshdReloaded: true,
        warnings: [],
      }),
    Error,
    'keysChanged must be an array of strings',
  )
  assertThrows(
    () => parsePrincipalsReconcileResult(null),
    Error,
    'Invalid principals reconcile result',
  )
  assertThrows(
    () =>
      parsePrincipalsReconcileResult({
        principalsApplied: 1,
        keysChanged: [],
        keysRemoved: [],
        sshdReloaded: 'yes',
        warnings: [],
      }),
    TypeError,
    'sshdReloaded must be a boolean',
  )
})

test('parseTlsTrustReconcilePayload validates PEM bundle and optional allowRemoval', () => {
  assertEquals(
    parseTlsTrustReconcilePayload({
      bundlePem: PEM,
      fingerprint: 'a'.repeat(64),
      allowRemoval: true,
    }),
    {
      bundlePem: PEM,
      fingerprint: 'a'.repeat(64),
      allowRemoval: true,
    },
  )
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem: 'not-a-pem',
        fingerprint: 'a'.repeat(64),
      }),
    Error,
    'bundlePem must contain at least one certificate',
  )
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem: PEM,
        fingerprint: 'a'.repeat(64),
        allowRemoval: 'yes',
      }),
    TypeError,
    'allowRemoval must be a boolean',
  )
  assertThrows(
    () => parseTlsTrustReconcilePayload(null),
    Error,
    'Invalid tls trust reconcile payload',
  )
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem: '   ',
        fingerprint: 'a'.repeat(64),
      }),
    Error,
    'bundlePem must be a non-empty PEM string',
  )
  assertThrows(
    () => parseTlsTrustReconcilePayload({ bundlePem: PEM, fingerprint: '   ' }),
    Error,
    'fingerprint must be a non-empty string',
  )
})

test('parseTlsTrustReconcileResult requires applied and fingerprint', () => {
  assertEquals(
    parseTlsTrustReconcileResult({
      applied: false,
      fingerprint: 'b'.repeat(64),
    }),
    { applied: false, fingerprint: 'b'.repeat(64) },
  )
  assertThrows(
    () => parseTlsTrustReconcileResult({ applied: true, fingerprint: '' }),
    Error,
    'fingerprint must be a non-empty string',
  )
  assertThrows(
    () => parseTlsTrustReconcileResult(null),
    Error,
    'Invalid tls trust reconcile result',
  )
})

test('parseDeploySecretPlan accepts entries and rejects hostile paths', () => {
  assertEquals(
    parseDeploySecretPlan([
      {
        key: 'DB_PASSWORD',
        composeServiceName: 'web',
        source: 'env',
        target: 'secrets',
        relativePath: 'db_password',
        forBuild: true,
        forRuntime: false,
      },
    ]),
    [
      {
        key: 'DB_PASSWORD',
        composeServiceName: 'web',
        source: 'env',
        target: 'secrets',
        relativePath: 'db_password',
        forBuild: true,
        forRuntime: false,
      },
    ],
  )
  assertEquals(parseDeploySecretPlan(undefined), undefined)
  assertThrows(
    () => parseDeploySecretPlan({}),
    TypeError,
    'secretPlan must be an array',
  )
  assertThrows(
    () =>
      parseDeploySecretPlan([
        {
          key: 'DB_PASSWORD',
          composeServiceName: 'web',
          source: 'env',
          target: 'secrets',
          relativePath: '../escape',
        },
      ]),
    TypeError,
    'Invalid environment.deploy secretPlan relativePath',
  )
  assertThrows(
    () =>
      parseDeploySecretPlan([
        {
          key: 'DB_PASSWORD',
          composeServiceName: 'web',
          source: 'bad/name',
          target: 'secrets',
          relativePath: 'db_password',
        },
      ]),
    TypeError,
    'Invalid environment.deploy secretPlan source/target',
  )
  assertThrows(
    () =>
      parseDeploySecretPlan([
        {
          key: 'DB_PASSWORD',
          composeServiceName: 'web',
          source: 'env',
          target: '../secrets',
          relativePath: 'db_password',
        },
      ]),
    TypeError,
    'Invalid environment.deploy secretPlan source/target',
  )
})

test('parseManagedReplicationHealth accepts valid snapshots and drops malformed rows', () => {
  assertEquals(
    parseManagedReplicationHealth({
      state: 'streaming',
      observedAt: '2020-01-01T00:00:00.000Z',
      lagBytes: 1024,
      lagSeconds: 2,
    }),
    {
      state: 'streaming',
      observedAt: '2020-01-01T00:00:00.000Z',
      lagBytes: 1024,
      lagSeconds: 2,
    },
  )
  assertEquals(parseManagedReplicationHealth(undefined), undefined)
  assertEquals(parseManagedReplicationHealth('x'), undefined)
  assertEquals(parseManagedReplicationHealth({ state: 'bogus' }), undefined)
  assertEquals(parseManagedReplicationHealth({ state: 'streaming', observedAt: 'not-iso' }), undefined)
  assertEquals(
    parseManagedReplicationHealth({
      state: 'needs_resync',
      observedAt: '2020-01-01T00:00:00.000Z',
      lagBytes: -1,
      lagSeconds: Number.NaN,
    }),
    { state: 'needs_resync', observedAt: '2020-01-01T00:00:00.000Z' },
  )
  assertEquals(
    parseManagedReplicationHealth({
      state: 'catchup',
      observedAt: '2020-01-01T00:00:00.000Z',
    }),
    { state: 'catchup', observedAt: '2020-01-01T00:00:00.000Z' },
  )
})

test('parseManagedHaReconcilePayload accepts raft peers and cluster members', () => {
  const containerName = managedHaContainerNameFromService(HA_SERVICE_ID)
  const payload = parseManagedHaReconcilePayload({
    serverId: SERVER_ID,
    managedNetwork: MANAGED_NETWORK,
    desired: 'present',
    raft: {
      nodeId: SERVER_ID,
      advertiseAddress: '203.0.113.10',
      httpPort: 33001,
      raftPort: 33002,
      peers: [
        {
          nodeId: '00000000-0000-4000-8000-0000000000ee',
          address: '203.0.113.11',
          raftPort: 33002,
          httpPort: 33001,
        },
      ],
    },
    clusters: [
      {
        managedId: 'managed-pg-1',
        clusterAlias: 'managed-pg-1',
        engine: 'postgres',
        members: [
          {
            memberId: MEMBER_ID,
            role: 'primary',
            replicaClass: null,
            host: 'db-1',
            port: 5432,
            promotionRule: 'prefer',
          },
        ],
        replicationUsername: 'tp_repl',
        replicationPasswordEnvelope: 'tpdaemon.v1.server.key.payload',
      },
    ],
    identity: {
      serviceId: HA_SERVICE_ID,
      composeServiceName: 'orchestrator',
      containerName,
    },
  })
  assertEquals(payload.raft?.advertiseAddress, '203.0.113.10')
  assertEquals(payload.clusters[0]?.members[0]?.promotionRule, 'prefer')
  assertEquals(payload.managedNetwork, MANAGED_NETWORK)

  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: {
          nodeId: SERVER_ID,
          advertiseAddress: '203.0.113.10',
          httpPort: 33001,
          raftPort: 33002,
          peers: [{ nodeId: 'bad', address: '203.0.113.11', raftPort: 33002, httpPort: 33001 }],
        },
        clusters: [],
        identity: {
          serviceId: HA_SERVICE_ID,
          composeServiceName: 'orchestrator',
          containerName,
        },
      }),
    TypeError,
    'Invalid managed.ha.reconcile raft peer',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: [
          {
            managedId: 'managed-pg-1',
            clusterAlias: 'managed-pg-1',
            engine: 'postgres',
            members: [
              {
                memberId: MEMBER_ID,
                role: 'primary',
                replicaClass: null,
                host: 'db-1',
                port: 5432,
                promotionRule: 'prefer',
              },
            ],
            replicationUsername: 'tp_repl',
            replicationPasswordEnvelope: 'plaintext-not-allowed',
          },
        ],
        identity: {
          serviceId: HA_SERVICE_ID,
          composeServiceName: 'orchestrator',
          containerName,
        },
      }),
    TypeError,
    'Invalid managed.ha.reconcile cluster',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: [],
        identity: {
          serviceId: HA_SERVICE_ID,
          composeServiceName: 'orchestrator',
          containerName: 'wrong-name',
        },
      }),
    TypeError,
    'Invalid managed.ha.reconcile identity',
  )
})

test('parseManagedHaReconcilePayload requires a Docker-safe managedNetwork', () => {
  const containerName = managedHaContainerNameFromService(HA_SERVICE_ID)
  const base = {
    serverId: SERVER_ID,
    desired: 'present' as const,
    raft: null,
    clusters: [],
    identity: {
      serviceId: HA_SERVICE_ID,
      composeServiceName: 'orchestrator',
      containerName,
    },
  }
  assertThrows(
    () => parseManagedHaReconcilePayload(base),
    TypeError,
    'Invalid managed.ha.reconcile payload',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        ...base,
        managedNetwork: 'not a docker name',
      }),
    TypeError,
    'Invalid managed.ha.reconcile payload',
  )
})

test('parseManagedHaReconcileResult accepts optional containers', () => {
  const containerName = managedHaContainerNameFromService(HA_SERVICE_ID)
  assertEquals(
    parseManagedHaReconcileResult({
      summary: 'registered',
      registeredClusters: ['managed-pg-1'],
      restarted: false,
      containers: [
        {
          composeServiceName: 'orchestrator',
          containerId: 'cid-1',
          containerName,
          status: 'running',
          role: 'turbopanel',
        },
      ],
    }),
    {
      summary: 'registered',
      registeredClusters: ['managed-pg-1'],
      restarted: false,
      containers: [
        {
          composeServiceName: 'orchestrator',
          containerId: 'cid-1',
          containerName,
          status: 'running',
          role: 'turbopanel',
        },
      ],
    },
  )
  assertThrows(
    () =>
      parseManagedHaReconcileResult({
        summary: 'bad',
        registeredClusters: ['../etc'],
        restarted: false,
      }),
    TypeError,
    'Invalid managed.ha.reconcile result',
  )
  assertThrows(
    () =>
      parseManagedHaReconcileResult({
        summary: 'bad containers',
        registeredClusters: ['managed-pg-1'],
        restarted: false,
        containers: [{ composeServiceName: 'orchestrator' }],
      }),
    TypeError,
    'Invalid managed.ha.reconcile result containers',
  )
})

test('parseManagedHaFailoverPayload and result validate phase and ids', () => {
  const payload = parseManagedHaFailoverPayload({
    managedId: 'managed-pg-1',
    sourceMemberId: MEMBER_ID,
    targetMemberId: '00000000-0000-4000-8000-0000000000ee',
    phase: 'drain',
    engine: 'postgres',
    sourceHost: '10.0.0.1',
    sourcePort: 5432,
  })
  assertEquals(payload.managedId, 'managed-pg-1')
  assertEquals(payload.phase, 'drain')
  assertEquals(payload.engine, 'postgres')
  assertEquals(payload.sourceHost, '10.0.0.1')

  assertEquals(
    parseManagedHaFailoverResult({
      summary: 'drained',
      phase: 'recover',
    }),
    { summary: 'drained', phase: 'recover' },
  )

  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: 'managed-pg-1',
        sourceMemberId: MEMBER_ID,
        targetMemberId: '00000000-0000-4000-8000-0000000000ee',
        phase: 'promote',
      }),
    TypeError,
    'Invalid managed.ha.failover payload',
  )
  assertThrows(
    () => parseManagedHaFailoverPayload(null),
    TypeError,
    'Invalid managed.ha.failover payload',
  )
  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: 'managed-pg-1',
        sourceMemberId: MEMBER_ID,
        targetMemberId: '00000000-0000-4000-8000-0000000000ee',
        phase: 'drain',
        engine: 'sqlite',
      }),
    TypeError,
    'Invalid managed.ha.failover payload',
  )
  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: 'managed-pg-1',
        sourceMemberId: MEMBER_ID,
        targetMemberId: '00000000-0000-4000-8000-0000000000ee',
        phase: 'drain',
        sourceHost: '',
      }),
    TypeError,
    'Invalid managed.ha.failover payload',
  )
  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: 'managed-pg-1',
        sourceMemberId: MEMBER_ID,
        targetMemberId: '00000000-0000-4000-8000-0000000000ee',
        phase: 'drain',
        targetPort: 0,
      }),
    TypeError,
    'Invalid managed.ha.failover payload',
  )
  assertEquals(
    parseManagedHaFailoverPayload({
      managedId: 'managed-pg-1',
      sourceMemberId: MEMBER_ID,
      targetMemberId: '00000000-0000-4000-8000-0000000000ee',
      phase: 'recover',
      targetHost: '203.0.113.40',
      targetPort: 5433,
    }).targetHost,
    '203.0.113.40',
  )
  assertThrows(
    () => parseManagedHaFailoverResult(null),
    TypeError,
    'Invalid managed.ha.failover result',
  )
  assertThrows(
    () => parseManagedHaFailoverResult({ summary: 'ok', phase: 'promote' }),
    TypeError,
    'Invalid managed.ha.failover result',
  )
})

test('parseManagedHaReconcilePayload rejects raft, cluster, and member field errors', () => {
  const containerName = managedHaContainerNameFromService(HA_SERVICE_ID)
  const identity = {
    serviceId: HA_SERVICE_ID,
    composeServiceName: 'orchestrator',
    containerName,
  }
  const member = {
    memberId: MEMBER_ID,
    role: 'replica' as const,
    replicaClass: 'failover' as const,
    host: 'db-2',
    port: 5432,
    promotionRule: 'must_not' as const,
    containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-2',
  }
  const cluster = {
    managedId: 'managed-pg-1',
    clusterAlias: 'managed-pg-1',
    engine: 'postgres',
    members: [member],
    replicationUsername: 'tp_repl',
    replicationPasswordEnvelope: 'tpdaemon.v1.server.key.payload',
  }
  const parsed = parseManagedHaReconcilePayload({
    serverId: SERVER_ID,
    managedNetwork: MANAGED_NETWORK,
    desired: 'present',
    raft: {
      nodeId: SERVER_ID,
      advertiseAddress: '203.0.113.10',
      httpPort: 33001,
      raftPort: 33002,
      peers: [],
    },
    clusters: [cluster],
    identity,
  })
  assertEquals(parsed.clusters[0]?.members[0]?.replicaClass, 'failover')
  assertEquals(parsed.clusters[0]?.members[0]?.containerName, member.containerName)

  assertThrows(
    () => parseManagedHaReconcilePayload(null),
    TypeError,
    'Invalid managed.ha.reconcile payload',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'maybe',
        raft: null,
        clusters: [],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile payload',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: Array.from({ length: 65 }, () => cluster),
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile payload',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: 'x',
        clusters: [],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile raft',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: {
          nodeId: SERVER_ID,
          advertiseAddress: '203.0.113.10',
          httpPort: 33001,
          raftPort: 33002,
          peers: Array.from({ length: 33 }, (_, index) => ({
            nodeId: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
            address: '203.0.113.11',
            raftPort: 33002,
            httpPort: 33001,
          })),
        },
        clusters: [],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile raft',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: {
          nodeId: SERVER_ID,
          advertiseAddress: '203.0.113.10',
          httpPort: 33001,
          raftPort: 33002,
          peers: [null],
        },
        clusters: [],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile raft peer',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: [null],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile cluster',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: [{ ...cluster, members: [] }],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile cluster',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: [{ ...cluster, members: [null] }],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile cluster member',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: [{
          ...cluster,
          members: [{ ...member, replicaClass: 'standby' }],
        }],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile cluster member',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: [{
          ...cluster,
          members: [{ ...member, containerName: 'Bad Name' }],
        }],
        identity,
      }),
    TypeError,
    'Invalid managed.ha.reconcile cluster member',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        managedNetwork: MANAGED_NETWORK,
        desired: 'present',
        raft: null,
        clusters: [],
        identity: 'x',
      }),
    TypeError,
    'Invalid managed.ha.reconcile identity',
  )
})

test('parseCommandPayload and parseCommandResult dispatch HA and principals types', () => {
  const containerName = managedHaContainerNameFromService(HA_SERVICE_ID)
  const haPayload = {
    serverId: SERVER_ID,
    managedNetwork: MANAGED_NETWORK,
    desired: 'absent' as const,
    raft: null,
    clusters: [],
    identity: {
      serviceId: HA_SERVICE_ID,
      composeServiceName: 'orchestrator',
      containerName,
    },
  }
  assertEquals(
    parseCommandPayload('managed.ha.reconcile', haPayload),
    parseManagedHaReconcilePayload(haPayload),
  )
  assertEquals(
    parseCommandResult('managed.ha.reconcile', {
      summary: 'absent',
      registeredClusters: [],
      restarted: false,
    }),
    { summary: 'absent', registeredClusters: [], restarted: false },
  )
  assertEquals(
    parseCommandPayload('managed.ha.failover', {
      managedId: 'managed-pg-1',
      sourceMemberId: MEMBER_ID,
      targetMemberId: '00000000-0000-4000-8000-0000000000ee',
      phase: 'drain',
      engine: 'postgres',
      sourceHost: '10.0.0.1',
      sourcePort: 5432,
    }),
    parseManagedHaFailoverPayload({
      managedId: 'managed-pg-1',
      sourceMemberId: MEMBER_ID,
      targetMemberId: '00000000-0000-4000-8000-0000000000ee',
      phase: 'drain',
      engine: 'postgres',
      sourceHost: '10.0.0.1',
      sourcePort: 5432,
    }),
  )
  assertEquals(
    parseCommandResult('managed.ha.failover', { summary: 'drained', phase: 'drain' }),
    { summary: 'drained', phase: 'drain' },
  )
  assertEquals(
    parseCommandResult('server.principals.reconcile', {
      principalsApplied: 0,
      keysChanged: [],
      keysRemoved: [],
      sshdReloaded: false,
      warnings: [],
    }),
    {
      principalsApplied: 0,
      keysChanged: [],
      keysRemoved: [],
      sshdReloaded: false,
      warnings: [],
    },
  )
})
