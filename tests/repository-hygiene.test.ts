/**
 * agyloop - repository hygiene (#333 AC6)
 *
 * The four scratch artifacts that were tracked at the repository root are one
 * `git rm` each. Removing them from the INDEX is what keeps the commit gate
 * (`git add -A`) from re-staging them; removing them from the working tree is
 * what keeps them out of a future `git add`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRATCH_ARTIFACTS = ['issue-pr-injection.md', 'new-issue.md', 'next1.json', 'next2.json'];

describe('repository hygiene (#333 AC6)', () => {
  test('HYG-333-1 the scratch artifacts are untracked (#333 AC6)', () => {
    const output = execFileSync('git', ['ls-files', '--', ...SCRATCH_ARTIFACTS], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });

    const tracked = output
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0);

    assert.deepStrictEqual(tracked, []);
  });

  test('HYG-333-2 the scratch artifacts are absent from the working tree (#333 AC6)', () => {
    const present = SCRATCH_ARTIFACTS.filter((name: string) =>
      fs.existsSync(path.join(REPO_ROOT, name))
    );

    assert.deepStrictEqual(present, []);
  });
});
