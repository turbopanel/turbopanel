/**
 * Exact AE v4 row-count regression matrix — the "fails loudly" test for the
 * v4 packing layer. Runs every representative-machine fixture
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
import { buildMetricsSampleV4 } from '../../contract-v4.ts'
import { truncateSampleToCapabilityPlanV4 } from '../../capability-plan.ts'
import type { AuthenticatedMetricsSampleV4 } from '../../types-v4.ts'
import { representativeMachineFixtures } from '../../testing/representative-machines.ts'
import {
  AE_V4_BLOB_COUNT,
  AE_V4_BLOB_FAMILY_INDEX,
  AE_V4_DOUBLE_COUNT,
  AE_V4_DOUBLE_INTERVAL_INDEX,
  buildMetricsDataPointsV4,
} from './field-map-v4.ts'

for (const fixture of representativeMachineFixtures()) {
  it(`representative machine "${fixture.name}": exact row count + family order`, () => {
    const built = buildMetricsSampleV4(fixture.input)
    const truncated = truncateSampleToCapabilityPlanV4(built, fixture.plan)
    const sample: AuthenticatedMetricsSampleV4 = {
      ...truncated,
      serverId: '11111111-2222-4333-8444-555555555555',
      receivedAt: fixture.input.metadata.sampledAt,
    }

    const points = buildMetricsDataPointsV4(sample, fixture.slotMapping)

    assertEquals(
      points.length,
      fixture.expectedRowCount,
      `${fixture.name}: expected ${fixture.expectedRowCount} rows, got ${points.length}`
    )
    assertEquals(
      points.map((point) => point.blobs[AE_V4_BLOB_FAMILY_INDEX]),
      fixture.expectedFamilies,
      `${fixture.name}: family order/multiset mismatch`
    )

    for (const point of points) {
      assertEquals(point.doubles.length, AE_V4_DOUBLE_COUNT, `${fixture.name}: doubles length`)
      assertEquals(point.blobs.length, AE_V4_BLOB_COUNT, `${fixture.name}: blobs length`)
      assertEquals(
        point.doubles[AE_V4_DOUBLE_INTERVAL_INDEX],
        sample.metadata.intervalSeconds,
        `${fixture.name}: double20 must equal intervalSeconds`
      )
    }
  })
}

it('representative machine fixtures: exactly 16 machine shapes covered', () => {
  assertEquals(representativeMachineFixtures().length, 16)
})
