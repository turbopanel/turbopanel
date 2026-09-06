import { assertEquals, assertThrows } from '@std/assert'
import {
  type EntityMetricSelector,
  formatEntityMetricId,
  parseEntityMetricId,
} from './entity-metric-id.ts'

const test = Deno.test.bind(Deno)

const ROUND_TRIP_CASES: {
  name: string
  selector: EntityMetricSelector
  id: string
}[] = [
  {
    name: 'host.cpu singleton',
    selector: { scope: 'host.cpu', field: 'busyPercent' },
    id: 'host.cpu.busyPercent',
  },
  {
    name: 'host.cpu processCount singleton',
    selector: { scope: 'host.cpu', field: 'processCount' },
    id: 'host.cpu.processCount',
  },
  {
    name: 'host.memory singleton',
    selector: { scope: 'host.memory', field: 'swapUsedBytes' },
    id: 'host.memory.swapUsedBytes',
  },
  {
    name: 'host.kernel singleton',
    selector: { scope: 'host.kernel', field: 'conntrackUsedPercent' },
    id: 'host.kernel.conntrackUsedPercent',
  },
  {
    name: 'host.storage singleton',
    selector: { scope: 'host.storage', field: 'rootFilesystemAvailableBytes' },
    id: 'host.storage.rootFilesystemAvailableBytes',
  },
  {
    name: 'host.network singleton',
    selector: { scope: 'host.network', field: 'tcpRetransmitPercent' },
    id: 'host.network.tcpRetransmitPercent',
  },
  {
    name: 'cpuDetail singleton',
    selector: { scope: 'cpuDetail', field: 'cpuIrqPercent' },
    id: 'cpuDetail.cpuIrqPercent',
  },
  {
    name: 'memoryDetail singleton',
    selector: { scope: 'memoryDetail', field: 'dirtyBytes' },
    id: 'memoryDetail.dirtyBytes',
  },
  {
    name: 'network entity',
    selector: {
      scope: 'network',
      entityId: 'eth0',
      field: 'receiveBytesPerSecond',
    },
    id: 'network:eth0.receiveBytesPerSecond',
  },
  {
    name: 'filesystem entity',
    selector: {
      scope: 'filesystem',
      entityId: 'root',
      field: 'availableBytes',
    },
    id: 'filesystem:root.availableBytes',
  },
  {
    name: 'block entity',
    selector: { scope: 'block', entityId: 'sda', field: 'utilizationPercent' },
    id: 'block:sda.utilizationPercent',
  },
  {
    name: 'gpu entity',
    selector: { scope: 'gpu', entityId: 'gpu0', field: 'utilizationPercent' },
    id: 'gpu:gpu0.utilizationPercent',
  },
  {
    name: 'hardwareSignal entity uses `hardware` alias',
    selector: { scope: 'hardwareSignal', entityId: 'psu1', field: 'value' },
    id: 'hardware:psu1.value',
  },
  {
    name: 'ingress entity',
    selector: { scope: 'ingress', entityId: 'web', field: 'requests' },
    id: 'ingress:web.requests',
  },
  {
    name: 'databaseProxy entity',
    selector: {
      scope: 'databaseProxy',
      entityId: 'pgbouncer',
      field: 'queries',
    },
    id: 'databaseProxy:pgbouncer.queries',
  },
  {
    name: 'cpuCore entity',
    selector: { scope: 'cpuCore', entityId: 'cpu3', field: 'busyPercent' },
    id: 'cpuCore:cpu3.busyPercent',
  },
]

for (const { name, selector, id } of ROUND_TRIP_CASES) {
  test(`formatEntityMetricId: ${name}`, () => {
    assertEquals(formatEntityMetricId(selector), id)
  })

  test(`parseEntityMetricId: ${name}`, () => {
    assertEquals(parseEntityMetricId(id), selector)
  })
}

test('formatEntityMetricId rejects unknown field for a valid scope', () => {
  assertThrows(
    () =>
      formatEntityMetricId({
        scope: 'gpu',
        entityId: 'gpu0',
        field: 'notAField',
      }),
    TypeError,
    'unknown v4 metric field'
  )
})

test('formatEntityMetricId rejects entityId on a host-singleton scope', () => {
  assertThrows(
    () =>
      formatEntityMetricId({
        scope: 'host.cpu',
        entityId: 'x',
        field: 'busyPercent',
      }),
    TypeError,
    'host-singleton'
  )
})

test('formatEntityMetricId rejects a missing entityId on a per-entity scope', () => {
  assertThrows(
    () => formatEntityMetricId({ scope: 'gpu', field: 'utilizationPercent' }),
    TypeError,
    'requires a non-empty entityId'
  )
})

test('parseEntityMetricId rejects an unknown scope alias', () => {
  assertThrows(
    () => parseEntityMetricId('bogus:x.value'),
    TypeError,
    'unknown entity metric scope alias'
  )
})

test('parseEntityMetricId rejects an unknown field for a known alias', () => {
  assertThrows(
    () => parseEntityMetricId('gpu:gpu0.notAField'),
    TypeError,
    'unknown v4 metric field'
  )
})

test('parseEntityMetricId rejects a malformed per-entity id with no field segment', () => {
  assertThrows(() => parseEntityMetricId('gpu:gpu0'), TypeError, 'invalid entity metric id')
})

test('parseEntityMetricId rejects a malformed per-entity id with an empty entityId', () => {
  assertThrows(
    () => parseEntityMetricId('gpu:.utilizationPercent'),
    TypeError,
    'invalid entity metric id'
  )
})

test('parseEntityMetricId rejects an unknown singleton canonical name', () => {
  assertThrows(
    () => parseEntityMetricId('host.cpu.notAField'),
    TypeError,
    'invalid entity metric id'
  )
})
