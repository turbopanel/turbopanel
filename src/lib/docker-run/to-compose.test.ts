import { assertEquals } from '@std/assert'
import { parseDockerRunCommand } from './parse.ts'
import { dockerRunToComposeDocument } from './to-compose.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function compile(argv: string) {
  return dockerRunToComposeDocument(parseDockerRunCommand(argv), {
    serviceName: 'web',
  })
}

function serviceOf(result: ReturnType<typeof compile>) {
  const services = result.compose.data.services as Record<string, unknown>
  return services.web as Record<string, unknown>
}

test('a command after the image is written onto the service', () => {
  const result = compile('docker run nginx:alpine sh -c echo')
  assertEquals(serviceOf(result).command, ['sh', '-c', 'echo'])
})

test('a Windows drive-letter volume keeps the colon in the source', () => {
  const result = compile(String.raw`docker run -v 'C:\data:/app' nginx`)
  assertEquals(serviceOf(result).volumes, [String.raw`C:\data:/app`])
  assertEquals(
    result.riskFlags.some((flag) => flag.kind === 'host_bind_mount'),
    true,
  )
})

test('an anonymous -v path is not declared as a named volume', () => {
  const result = compile('docker run -v /data nginx')
  assertEquals(serviceOf(result).volumes, ['/data'])
  assertEquals(result.compose.data.volumes, undefined)
})

test('--gpus all is a bare string; CSV lists continue a previous value', () => {
  const all = compile('docker run --gpus all nginx')
  assertEquals(serviceOf(all).gpus, 'all')

  const listed = compile(
    'docker run --gpus driver=nvidia,device=0,1,capabilities=compute,utility nginx',
  )
  const gpus = serviceOf(listed).gpus as Array<Record<string, unknown>>
  assertEquals(gpus[0]?.driver, 'nvidia')
  assertEquals(gpus[0]?.device_ids, ['0', '1'])
  assertEquals(gpus[0]?.capabilities, ['compute', 'utility'])
})

test('empty CSV chunks in --mount are skipped', () => {
  const result = compile(
    'docker run --mount type=volume,,source=data,target=/var/lib/data nginx',
  )
  const volumes = serviceOf(result).volumes as Array<Record<string, unknown>>
  assertEquals(volumes[0], {
    type: 'volume',
    source: 'data',
    target: '/var/lib/data',
  })
  assertEquals(result.compose.data.volumes, { data: {} })
})

test('--mount without a target is a blocking diagnostic', () => {
  const result = compile('docker run --mount type=bind,source=/etc/hosts nginx')
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'option_value_unparsed' &&
      diagnostic.blocking &&
      diagnostic.message.includes('no target=')
    ),
    true,
  )
})

test('--link becomes a legacy links entry with a note', () => {
  const result = compile('docker run --link db:db nginx')
  assertEquals(serviceOf(result).links, ['db:db'])
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.flag === '--link' &&
      diagnostic.code === 'option_value_unparsed' &&
      diagnostic.blocking === false
    ),
    true,
  )
})

test('malformed blkio, log-opt, storage-opt and ulimit values are reported', () => {
  const result = compile(
    'docker run --device-read-bps nospec --log-opt plain --storage-opt size ' +
      '--ulimit nofile --blkio-weight-device /dev/sda nginx',
  )
  const codes = result.diagnostics
    .filter((diagnostic) => diagnostic.code === 'option_value_unparsed')
    .map((diagnostic) => diagnostic.flag)
    .sort((a, b) => (a ?? '').localeCompare(b ?? ''))
  assertEquals(codes, [
    '--blkio-weight-device',
    '--device-read-bps',
    '--log-opt',
    '--storage-opt',
    '--ulimit',
  ])
})

test('an illegal Compose network name is not attached', () => {
  const result = compile('docker run --network "has space" nginx')
  assertEquals(serviceOf(result).networks, undefined)
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('cannot be a Compose network key')
    ),
    true,
  )
})

test('a second named network is skipped after the first attachment', () => {
  const result = compile('docker run --network app --network extra nginx')
  assertEquals(serviceOf(result).networks, { app: null })
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Only the first named network')
    ),
    true,
  )
})

test('network_mode drops aliases that have nowhere to attach', () => {
  const result = compile(
    'docker run --network host --network-alias web nginx',
  )
  assertEquals(serviceOf(result).network_mode, 'host')
  assertEquals(serviceOf(result).networks, undefined)
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('network_mode: host')
    ),
    true,
  )
})

test('--volume-driver without named volumes is reported, not invented', () => {
  const result = compile('docker run --volume-driver local nginx')
  assertEquals(result.compose.data.volumes, undefined)
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.flag === '--volume-driver' &&
      diagnostic.message.includes('declares none')
    ),
    true,
  )
})

test('duplicate unconditional risk flags are recorded once', () => {
  const result = compile('docker run --privileged --privileged nginx')
  const privileged = result.riskFlags.filter((flag) => flag.kind === 'privileged')
  assertEquals(privileged.length, 1)
})
