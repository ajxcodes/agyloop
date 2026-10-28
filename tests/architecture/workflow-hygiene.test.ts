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
 * W8 - no workflow names a retired Ubuntu image (#352)
 * W9 - the three release-relevant jobs run on the validated image, cite the
 *      run that justified it, and record the engine they ran on
 * W10 - the canaries stay on ubuntu-latest (never silently pinned)
 * W11 - the tag namespace has exactly one writer, and it is a main push
 * W12 - posix-shell stays a soak job with one mount/engine contract
 * W13 - actionlint knows the validated ubuntu-26.04 label (#352)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, '.github', 'workflows');
const CI_PATH = path.join(WORKFLOWS_DIR, 'ci.yml');
const CRITIQUE_PATH = path.join(WORKFLOWS_DIR, 'critique.yml');
const ACTIONLINT_CONFIG_PATH = path.join(PROJECT_ROOT, '.github', 'actionlint.yaml');

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

/** The `runs-on:` value of a job body. */
function runnerOf(body: string): string {
  const match = body.match(/^ {4}runs-on:\s*(\S+)\s*$/m);
  if (!match) {
    throw new Error('a job has no runs-on');
  }
  return match[1];
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

// The 24.04 → 26.04 migration is complete (#352): only the validated pin and the
// floating canary are declared. Pinning a job back is a commit that edits this
// list, exactly like the migration itself.
const ALLOWED_RUNNERS = ['ubuntu-26.04', 'ubuntu-latest'];

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
      lint: 'ubuntu-26.04',
      typecheck: 'ubuntu-latest',
      test: 'ubuntu-latest',
      'posix-shell': 'ubuntu-26.04',
      tag: 'ubuntu-26.04'
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

  test('W8: no workflow names a retired Ubuntu image', () => {
    assert.ok(
      !/ubuntu-24\.04/.test(both),
      'a workflow (or its comment) still names ubuntu-24.04 — the 26.04 migration is done (#352), so a pin-back is a deliberate commit'
    );
    assert.match(ci, /runs-on: ubuntu-26\.04/, 'no job runs on the validated 26.04 image');
  });

  test('W9: the release-relevant jobs run on the validated image and record it', () => {
    const blocks = jobBlocks(ci);
    for (const job of ['lint', 'posix-shell', 'tag']) {
      assert.strictEqual(
        runnerOf(blocks[job]),
        'ubuntu-26.04',
        `${job} must run on the image #352 validated`
      );
      assert.match(
        blocks[job],
        /#352/,
        `${job} must cite the validation run that justified its pin`
      );
    }
    for (const job of ['lint', 'posix-shell']) {
      assert.match(
        blocks[job],
        /docker version --format/,
        `${job} must record the Docker engine version in its log (AC-1/AC-2)`
      );
      assert.match(blocks[job], /uname -r/, `${job} must record the kernel in its log`);
      assert.match(blocks[job], /runner: \$\{PRETTY_NAME/, `${job} must record the image`);
    }
  });

  test('W10: the canaries stay on ubuntu-latest', () => {
    const ciJobs = jobBlocks(ci);
    for (const job of ['typecheck', 'test']) {
      assert.strictEqual(
        runnerOf(ciJobs[job]),
        'ubuntu-latest',
        `${job} is a canary: it must follow ubuntu-latest, not be pinned (#352)`
      );
    }
    assert.strictEqual(
      runnerOf(jobBlocks(critique).review),
      'ubuntu-latest',
      'the critique job is a canary: it must follow ubuntu-latest, not be pinned (#352)'
    );
  });

  test('W11: the tag namespace has exactly one writer, and it is a main push', () => {
    const workflowFiles = fs
      .readdirSync(WORKFLOWS_DIR)
      .filter((name: string) => /\.ya?ml$/.test(name))
      .sort();
    assert.deepStrictEqual(
      workflowFiles,
      ['ci.yml', 'critique.yml'],
      'a validation-only workflow was committed — #352 must not leave one behind'
    );

    const tagJob = jobBlocks(ci).tag;
    assert.ok(tagJob, 'the tag job is missing');
    assert.match(
      tagJob,
      /needs: \[lint, typecheck, test\]/,
      'tag.needs changed — posix-shell is still soaking and must not gate a release'
    );
    assert.match(tagJob, /github\.ref == 'refs\/heads\/main'/, 'the tag job must stay main-only');
    assert.ok(tagJob.includes('git push -f'), 'the force-push must stay inside the main-only tag job');

    const forcePushes = both.match(/git push -f\b/g) ?? [];
    assert.strictEqual(forcePushes.length, 1, 'exactly one ref force-push site may exist in the workflows');
    assert.ok(
      !/^\s+tags:/m.test(both),
      'a tags: trigger was declared — the tag namespace is written by the main-push job only'
    );
  });

  test('W12: posix-shell stays a soak job with one mount and one engine contract', () => {
    const job = jobBlocks(ci)['posix-shell'];
    assert.ok(job, 'the posix-shell job is missing');
    assert.match(job, /continue-on-error:\s*true/, 'posix-shell is still soaking and must not block a release');
    assert.strictEqual(
      (job.match(/"\$R" run/g) ?? []).length,
      5,
      'the five container invocations must all go through the one engine selector'
    );
    assert.strictEqual(
      (job.match(/-v "\$PWD:\/work" -w \/work/g) ?? []).length,
      4,
      'every mounted container step must bind the checkout at /work — one mount contract'
    );
    for (const flag of ['--user', '--privileged', '--userns', '--net=host']) {
      assert.ok(
        !job.includes(flag),
        `posix-shell must not pass ${flag} to work around a runner engine change (#352)`
      );
    }
  });

  test('W13: actionlint is told about the validated ubuntu-26.04 label', () => {
    assert.ok(
      fs.existsSync(ACTIONLINT_CONFIG_PATH),
      'actionlint has no config — it would flag ubuntu-26.04 as an unknown runner label and turn the lint job red (#352)'
    );
    const config = fs.readFileSync(ACTIONLINT_CONFIG_PATH, 'utf8');
    assert.match(
      config,
      /^self-hosted-runner:\s*$/m,
      'actionlint.yaml lost its self-hosted-runner: block — the ubuntu-26.04 label declaration is gone (#352)'
    );
    assert.match(
      config,
      /^ {2}labels:\s*$/m,
      'actionlint.yaml lost its labels: list — the ubuntu-26.04 declaration is not inside the self-hosted-runner block (#352)'
    );
    assert.match(
      config,
      /^ {4}- ubuntu-26\.04\s*$/m,
      'actionlint.yaml no longer declares exactly ubuntu-26.04 — the label is not taught to actionlint, so lint fails or a near-miss label such as ubuntu-26.26 would slip through (#352)'
    );
  });
});
