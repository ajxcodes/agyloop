/**
 * agyloop - architecture tripwire: `color-policy.ts` is the ONLY file under
 * `src/` allowed to construct an ANSI escape (issue #339, items 8/9, T9.5).
 *
 * The colour defect (#341) existed because ~30 call sites each built their own
 * escapes and every NEW renderer repeated the mistake. Review cannot catch a
 * missed site; this walk can: any literal escape outside the policy module —
 * or any raw ESC byte anywhere in `src/` — fails here, so a future renderer
 * must go through `shouldColorize`/`paint` or not colour at all.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');
const POLICY_FILE = path.join('src', 'presentation', 'color-policy.ts');

/** Every file under `src/`, as repo-relative POSIX paths. */
function walkSource(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a: any, b: any) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSource(full));
    } else if (entry.isFile()) {
      files.push(path.relative(path.resolve(SRC_ROOT, '..'), full).split(path.sep).join('/'));
    }
  }
  return files;
}

describe('colour policy architecture (T9.5 / AC-3.1)', () => {
  const files = walkSource(SRC_ROOT);

  test('the walk finds the sources it is supposed to police', () => {
    assert.ok(files.length > 20, `expected the whole src tree, found ${files.length} files`);
    assert.ok(files.includes(POLICY_FILE), `${POLICY_FILE} must be part of the walk`);
  });

  test('a literal escape sequence appears ONLY in color-policy.ts', () => {
    const offenders = files.filter(
      (file) =>
        file !== POLICY_FILE &&
        fs.readFileSync(path.resolve(SRC_ROOT, '..', file), 'utf8').includes('\\x1b')
    );
    assert.deepStrictEqual(
      offenders,
      [],
      `every escape must be constructed by ${POLICY_FILE}; found literals in:\n${offenders.join('\n')}`
    );
  });

  test('no raw ESC byte (0x1b) exists in any src file', () => {
    const offenders = files.filter((file) =>
      fs.readFileSync(path.resolve(SRC_ROOT, '..', file)).includes(0x1b)
    );
    assert.deepStrictEqual(offenders, [], `raw ESC bytes in:\n${offenders.join('\n')}`);
  });

  test('the policy module is the one that carries the escape', () => {
    const policy = fs.readFileSync(path.resolve(SRC_ROOT, '..', POLICY_FILE), 'utf8');
    assert.ok(policy.includes('\\x1b['), `${POLICY_FILE} must build the escapes itself`);
    assert.ok(policy.includes('NO_COLOR'), 'the policy must honour NO_COLOR');
    assert.ok(policy.includes("'dumb'"), 'the policy must honour TERM=dumb');
    assert.ok(policy.includes('isTTY'), 'the policy must gate on the stream');
  });
});
