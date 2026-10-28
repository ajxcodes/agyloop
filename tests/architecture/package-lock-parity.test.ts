/**
 * agyloop - Architecture Fitness Test: package-lock.json ↔ package.json parity
 * (issue #242 / Defect C, absorbs #285)
 *
 * `npm ci` does NOT validate the lockfile's root metadata, so a stale root
 * `version` or a missing `bin` entry ships silently. These tests compare the
 * two files directly.
 *
 * L1 - the lock's `name`/`version` match the manifest at both the top level and
 *      `packages[""]`
 * L2 - the lock advertises exactly the manifest's bins, with matching targets
 *      modulo npm's `./` normalisation
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const pkg = require('../../package.json');
const lock = require('../../package-lock.json');

const strip = (target: string): string => String(target).replace(/^\.\//, '');
const keys = (record: Record<string, string> | undefined): string[] =>
  Object.keys(record || {}).sort();

describe('package-lock.json parity', () => {
  test('L1: root name and version match package.json', () => {
    const root = lock.packages[''];

    assert.strictEqual(lock.name, pkg.name);
    assert.strictEqual(lock.version, pkg.version);
    assert.strictEqual(root.name, pkg.name);
    assert.strictEqual(root.version, pkg.version);
  });

  test('L2: root bins match package.json, including the codeloop bin', () => {
    const root = lock.packages[''];

    assert.deepStrictEqual(keys(root.bin), keys(pkg.bin));
    for (const name of Object.keys(pkg.bin)) {
      assert.strictEqual(
        strip(root.bin[name]),
        strip(pkg.bin[name]),
        `bin ${name} target drift`
      );
    }
  });
});
