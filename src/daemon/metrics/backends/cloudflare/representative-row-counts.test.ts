/**
 * Exact AE v5 row-count regression matrix — the "fails loudly" test for the
 * v5 packing layer. Runs every representative-machine fixture
 * (`testing/representative-machines.ts`) through the real capability-plan
 * truncation + field-map packing pipeline (the same two steps ingest
 * performs) and asserts the literal row count and ordered family list per
 * machine shape, plus universal per-row invariants (double20 = interval,
 * full 20/20 doubles/blobs shape).
 *
 * A regression here means either the packing layer silently changed how
 * many AE rows a given machine shape produces, or a capability-plan default
 * drifted out from under a fixture — both should fail this test before they
 * fail in production.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSample } from '../../contract.ts'
import { truncateSampleToCapabilityPlan } from '../../capability-plan.ts'
import type { AuthenticatedMetricsSample } from '../../types.ts'
import { representativeMachineFixtures } from '../../testing/representative-machines.ts'
import {
  AE_BLOB_COUNT,
  AE_BLOB_FAMILY_INDEX,
  AE_BLOB_SOURCE_OR_IDENTITY_INDEX,
  AE_DOUBLE_COUNT,
  AE_DOUBLE_INTERVAL_INDEX,
  buildMetricsDataPoints,
} from './field-map.ts'

for (const fixture of representativeMachineFixtures()) {
  it(`representative machine "${fixture.name}": exact row count + family order`, () => {
    const built = buildMetricsSample(fixture.input)
    const truncated = truncateSampleToCapabilityPlan(built, fixture.plan)
    const sample: AuthenticatedMetricsSample = {
      ...truncated,
      serverId: '11111111-2222-4333-8444-555555555555',
      receivedAt: fixture.input.metadata.sampledAt,
    }

    const points = buildMetricsDataPoints(sample, fixture.slotMapping)

    // A fixture's own plan must entitle its own entities — otherwise
    // truncation silently eats them and every count below still "passes"
    // against a smaller machine than the fixture describes. The A2
    // entity-joined signals (+3 per GPU, +1 per service drive) are exactly
    // the growth that can push a host past the 19-slot baseline.
    assertEquals(
      truncated.hardwareSignals.length,
      fixture.input.hardwareSignals.length,
      `${fixture.name}: plan must entitle every reported hardware signal`
    )

    // Pin signal *identity*, not just the family row total: a GPU- or
    // drive-bearing host whose extra signals still fit one page has an
    // unchanged row count, so losing them would otherwise go unnoticed.
    const packedSignalIds = points
      .filter((point) => point.blobs[AE_BLOB_FAMILY_INDEX] === 'hardware.physical')
      .flatMap((point) => String(point.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX] ?? '').split(','))
      .filter((id) => id.length > 0)
      .sort()
    assertEquals(
      packedSignalIds,
      fixture.input.hardwareSignals.map((signal) => signal.signalId).sort(),
      `${fixture.name}: hardware.physical signal identities`
    )

    assertEquals(
      points.length,
      fixture.expectedRowCount,
      `${fixture.name}: expected ${fixture.expectedRowCount} rows, got ${points.length}`
    )
    assertEquals(
      points.map((point) => point.blobs[AE_BLOB_FAMILY_INDEX]),
      fixture.expectedFamilies,
      `${fixture.name}: family order/multiset mismatch`
    )

    for (const point of points) {
      assertEquals(point.doubles.length, AE_DOUBLE_COUNT, `${fixture.name}: doubles length`)
      assertEquals(point.blobs.length, AE_BLOB_COUNT, `${fixture.name}: blobs length`)
      assertEquals(
        point.doubles[AE_DOUBLE_INTERVAL_INDEX],
        sample.metadata.intervalSeconds,
        `${fixture.name}: double20 must equal intervalSeconds`
      )
    }
  })
}

it('representative machine fixtures: exactly 19 machine shapes covered', () => {
  assertEquals(representativeMachineFixtures().length, 19)
})
