/**
 * DSH compatibility contract invariant: every published family package and
 * the plugin scaffold declare the minimum runtime metadata consumed by the
 * plugin-manager update guard (issue #754), and no family package — the
 * aggregate package included, whose floor is the family's machine-readable
 * compatibility statement — may declare a floor below the scaffold's cohort
 * floor. Generated nested compatibility shims are intentionally outside the
 * family package walker.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkFamilyPackages } from './lib/family-packages.mjs'
import { floorVersion, readDshFloor, satisfiesFloor } from './lib/rollout-verify.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SUPPORTED_MINIMUM = /^>=\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SCAFFOLD = join(ROOT, 'scripts', 'plugin-template', 'package.json')
const AGGREGATE = join(ROOT, 'packages', 'dsh-web-all', 'package.json')

function readManifest(pkgPath) {
  return JSON.parse(readFileSync(pkgPath, 'utf8'))
}

/** Returns the declared floor after asserting its shape. */
function assertSupportedMinimum(pkgPath) {
  const minimum = readManifest(pkgPath)?.dsh?.engines?.dsh
  assert.equal(typeof minimum, 'string', `${relative(ROOT, pkgPath)} must declare dsh.engines.dsh`)
  assert.match(minimum, SUPPORTED_MINIMUM, `${relative(ROOT, pkgPath)} must use the supported >=<semver> form`)
  return minimum
}

test('every family package declares a supported DSH runtime floor', () => {
  const packages = walkFamilyPackages(ROOT)
  assert.ok(packages.length > 0, 'family walker found no packages')
  for (const { pkgPath } of packages) assertSupportedMinimum(pkgPath)
})

test('the plugin scaffold declares a supported DSH runtime floor', () => {
  assertSupportedMinimum(SCAFFOLD)
})

test('no family floor sits below the scaffold cohort floor, the aggregate included', () => {
  const cohort = readDshFloor(SCAFFOLD)
  const packages = walkFamilyPackages(ROOT)
  assert.ok(
    packages.some(({ pkgPath }) => pkgPath === AGGREGATE),
    'the family walker must cover the aggregate package',
  )
  const below = []
  for (const { pkgPath } of packages) {
    const minimum = assertSupportedMinimum(pkgPath)
    if (!satisfiesFloor(floorVersion(minimum), cohort)) {
      below.push(`${relative(ROOT, pkgPath)}: ${minimum} < ${cohort}`)
    }
  }
  assert.deepEqual(below, [], `family floors below the cohort floor ${cohort}:\n${below.join('\n')}`)
})
