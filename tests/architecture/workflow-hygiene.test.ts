/**
 * agyloop - Architecture Fitness Test: CI workflow hygiene (issue #242 / Defect B)
 *
 * The workflows are the release-critical path's environment. This test pins the
 * declarations line-by-line (no YAML dependency; the repo has none) so an
 * action bump, a runner flip or a floating ref cannot land quietly:
 *
 * W1 - every actions/checkout and actions/setup-node ref is @v7
 * W2 - critique.yml passes `fail_on_severity: 'none'` explicitly
 * W3 - the per-job runner map is exactly the declared allowlist
 * W4 - ajxcodes actions are SHA-pinned; no @latest remains
 * W5 - the collector branch is a push trigger; `tag` stays main-only
 * W6 - every setup-node step still sets node-version: 24
 * W7 - the lockfile drift guard runs in the lint job
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CI_PATH = path.join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml');
const CRITIQUE_PATH = path.join(PROJECT_ROOT, '.github', 'workflows', 'critique.yml');

const ci = fs.readFileSync(CI_PATH, 'utf8');
const critique = fs.readFileSync(CRITIQUE_PATH, 'utf8');
const both = `${ci}\n${critique}`;

/** Split a workflow into `{ jobName: body }` by scanning `jobs:` + 2-space keys. */
function jobBlocks(source: string): Record<string, string> {
  const lines = source.split('\n');
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notStrictEqual(jobsIndex, -1, 'workflow has no top-level jobs: block');

  const blocks: Record<string, string> = {};
  let current: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (current !== null) {
      blocks[current] = body.join('\n');
    }
    body = [];
  };

  for (const line of lines.slice(jobsIndex + 1)) {
    const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (job) {
      flush();
      current = job[1];
      continue;
    }
    if (current !== null) {
      body.push(line);
    }
  }
  flush();

  return blocks;
}

/** Every `uses:` value in a workflow source. */
function actionUses(source: string): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
    values.push(match[1]);
  }
  return values;
}

/** The `branches:` list of a top-level trigger event, with quotes stripped. */
function triggerBranches(source: string, event: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${event}:\\s*$`).test(line));
  assert.notStrictEqual(start, -1, `no top-level ${event}: trigger`);

  for (const line of lines.slice(start + 1)) {
    const branches = line.match(/^ {4}branches:\s*\[(.*)\]\s*$/);
    if (branches) {
      return branches[1]
        .split(',')
        .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  throw new Error(`${event}: trigger has no branches: list`);
}

const ALLOWED_RUNNERS = ['ubuntu-24.04', 'ubuntu-latest'];

describe('CI workflow hygiene', () => {
  test('W1: every checkout and setup-node action targets @v7', () => {
    const actionRefs = actionUses(both).filter((ref) =>
      /^actions\/(checkout|setup-node)@/.test(ref)
    );

    assert.ok(actionRefs.length > 0, 'no checkout/setup-node refs found');
    for (const ref of actionRefs) {
      assert.match(ref, /@v7$/, `${ref} still targets a pre-v7 runtime`);
    }
    assert.ok(
      !/actions\/(checkout|setup-node)@v[0-6]\b/.test(both),
      'a workflow still targets a pre-v7 action runtime'
    );
  });

  test('W2: critique.yml passes fail_on_severity explicitly', () => {
    assert.match(critique, /fail_on_severity:\s*'none'/);
  });

  test('W3: the per-job runner map is exactly the declared allowlist', () => {
    const expectedCi: Record<string, string> = {
      lint: 'ubuntu-24.04',
      typecheck: 'ubuntu-latest',
      test: 'ubuntu-latest',
      'posix-shell': 'ubuntu-24.04',
      tag: 'ubuntu-24.04'
    };
    const expectedCritique: Record<string, string> = {
      review: 'ubuntu-latest'
    };

    for (const [source, expected] of [
      [ci, expectedCi],
      [critique, expectedCritique]
    ] as Array<[string, Record<string, string>]>) {
      const blocks = jobBlocks(source);
      assert.deepStrictEqual(
        Object.keys(blocks).sort(),
        Object.keys(expected).sort(),
        'the job set changed — update this allowlist deliberately'
      );

      for (const [job, body] of Object.entries(blocks)) {
        const match = body.match(/^ {4}runs-on:\s*(\S+)\s*$/m);
        if (!match) {
          throw new Error(`${job} has no runs-on`);
        }
        const runner = match[1];
        assert.ok(
          ALLOWED_RUNNERS.includes(runner),
          `${job} uses an undeclared runner: ${runner}`
        );
        assert.strictEqual(runner, expected[job], `${job} runner drifted`);
      }
    }
  });

  test('W4: third-party release actions are SHA-pinned and no @latest remains', () => {
    assert.match(critique, /uses:\s+ajxcodes\/critique@[0-9a-f]{40}/);
    assert.match(ci, /uses:\s+ajxcodes\/auto-tag@[0-9a-f]{40}/);
    assert.ok(!/@latest\b/.test(both), 'a workflow still uses a floating @latest ref');
    assert.match(ci, /uses:\s+rhysd\/actionlint@v1\.7\.12/, 'actionlint must stay version-pinned');
  });

  test('W5: the collector is a push trigger and the tag job stays main-only', () => {
    const pushBranches = triggerBranches(ci, 'push');
    assert.ok(pushBranches.includes('main'), 'push never runs on main');
    assert.ok(pushBranches.includes('phase/**'), 'push does not cover the collector branch');

    const pullRequestBranches = triggerBranches(ci, 'pull_request');
    for (const branch of ['main', 'phase/**', 'feature/**']) {
      assert.ok(pullRequestBranches.includes(branch), `pull_request lost ${branch}`);
    }

    const tagJob = jobBlocks(ci).tag;
    assert.ok(tagJob, 'the tag job is missing');
    assert.match(tagJob, /github\.ref == 'refs\/heads\/main'/);
  });

  test('W6: every setup-node step still sets node-version: 24', () => {
    for (const [job, body] of Object.entries(jobBlocks(ci))) {
      if (!/uses:\s+actions\/setup-node@/.test(body)) {
        continue;
      }
      assert.match(body, /^ {10}node-version:\s*24\s*$/m, `${job} must set node-version: 24`);
    }
    assert.strictEqual(
      (ci.match(/uses:\s+actions\/setup-node@v7/g) || []).length,
      5,
      'expected 5 setup-node sites in ci.yml'
    );
  });

  test('W7: the lint job guards the lockfile against drift', () => {
    const lintJob = jobBlocks(ci).lint;
    assert.ok(lintJob, 'the lint job is missing');
    assert.match(lintJob, /npm install --package-lock-only --ignore-scripts/);
    assert.match(lintJob, /git diff --exit-code -- package-lock\.json/);
  });
});
