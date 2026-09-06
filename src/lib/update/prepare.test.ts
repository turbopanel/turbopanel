import { assertEquals } from '@std/assert'
import {
  getServerUpdatePreparer,
  setServerUpdatePreparer,
} from './prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('the update preparer is unset by default and round-trips when set', async () => {
  const previous = getServerUpdatePreparer()
  try {
    setServerUpdatePreparer(null)
    assertEquals(getServerUpdatePreparer(), null)

    let ran = false
    const preparer = async () => {
      ran = true
    }
    setServerUpdatePreparer(preparer)
    assertEquals(getServerUpdatePreparer(), preparer)
    await getServerUpdatePreparer()?.()
    assertEquals(ran, true)

    setServerUpdatePreparer(null)
    assertEquals(getServerUpdatePreparer(), null)
  } finally {
    setServerUpdatePreparer(previous)
  }
})
