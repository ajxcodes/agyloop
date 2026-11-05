/**
 * codeloop - `codeloop release` provisions/verifies the release label (#502)
 *
 * The defect this file pins: `release` passed `--label release:minor` to
 * `gh pr create` without ever provisioning the label, so `gh` refused the
 * create and the release died on a raw `GitHubContextError` at its last step.
 * `--dry-run` promised a PR it could not open.
 *
 * Full CLI, real git repo, FAKE `gh` first on PATH. The real GitHub is never
 * called by the default suite; the ONE opt-in exception is the AC4 live check
 * below (`AGYLOOP_LIVE_RELEASE_LABELS=1`), which reads the real repository's
 * label vocabulary to pin the state the release path depends on.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { RELEASE_LABEL_DEFINITIONS } = require('../../dist/domain');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { makeSandbox: makeSandboxCanonical } = require('../helpers/sandbox.ts');

interface Sandbox {
  readonly dir: string;
  readonly phaseBranch: string;
  readonly binDir: string;
  readonly ghLog: string;
}

const FAKE_GH = `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "$GH_LOG"
printf '\\n' >> "$GH_LOG"
if [ -n "\${GH_FAIL_LIST:-}" ] && [ "$1 $2" = "label list" ]; then
  printf 'HTTP 401: Bad credentials\\n' >&2
  exit 1
fi
case "$1 $2" in
  "label list") printf '%s' "\${GH_LABELS:-[]}" ;;
  "label create") printf 'created\\n' ;;
  "pr list") printf '[]' ;;
  "pr create") printf 'https://github.com/ajxcodes/agyloop/pull/999\\n' ;;
esac
exit 0
`;

function makeReleaseLabelSandbox(): Sandbox {
  const sandbox = makeSandboxCanonical({
    prefix: 'codeloop-release-label-',
    dirName: '',
    gitignore: false,
    initialBranch: 'main',
    seed: (dir: string) => {
      fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
    },
    initialCommit: 'chore: seed'
  });
  const dir = sandbox.dir;
  const g = (args: string[]) => sandbox.git(args);

  const phaseBranch = 'phase/6-smoke';
  g(['checkout', '-qb', phaseBranch]);
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'feat(release): add the label precondition']);

  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  const binDir = path.join(dir, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ghLog = path.join(dir, 'gh.log');
  fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(ghLog, '');

  return { dir, phaseBranch, binDir, ghLog };
}

function runRelease(sandbox: Sandbox, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'codeloop.js'), 'release', ...args], {
    cwd: sandbox.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(sandbox.dir, '.home'),
      AGY_SUBAGENT: '',
      PATH: `${sandbox.binDir}:${process.env.PATH || ''}`,
      GH_LOG: sandbox.ghLog,
      ...extraEnv
    }
  });
}

function ghLines(sandbox: Sandbox): string[] {
  return fs
    .readFileSync(sandbox.ghLog, 'utf8')
    .split('\n')
    .filter((line: string) => line.length > 0);
}

function lineNumber(lines: string[], predicate: (line: string) => boolean): number {
  const index = lines.findIndex(predicate);
  return index === -1 ? -1 : index + 1;
}

describe('release provisions/verifies the release label (#502)', () => {
  test('a dry run with a missing label reports the provisioning command and opens nothing (#502 AC2)', () => {
    const sandbox = makeReleaseLabelSandbox();
    try {
      const run = runRelease(
        sandbox,
        [sandbox.phaseBranch, '--base-branch', 'main', '--dry-run'],
        { GH_LABELS: '[]' }
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);
      assert.match(run.stdout, /missing; the real run will create it/);
      assert.match(run.stdout, /gh label create release:minor/);
      assert.match(run.stdout, /Would create Milestone PR/);

      const lines = ghLines(sandbox);
      assert.strictEqual(lineNumber(lines, (line) => line.startsWith('label create')), -1);
      assert.strictEqual(lineNumber(lines, (line) => line.startsWith('pr create')), -1);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('a real run provisions the missing label then opens the PR with it (#502 AC1)', () => {
    const sandbox = makeReleaseLabelSandbox();
    try {
      const run = runRelease(sandbox, [sandbox.phaseBranch, '--base-branch', 'main'], {
        GH_LABELS: '[]'
      });
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);
      assert.match(run.stdout, /pull\/999/);
      assert.match(run.stdout, /Release Label Created/);

      const lines = ghLines(sandbox);
      const labelCreateLine = lineNumber(lines, (line) => line.startsWith('label create release:minor '));
      const prCreateLine = lines.find((line: string) => line.startsWith('pr create ')) || '';
      const prCreateLineNumber = lineNumber(lines, (line) => line.startsWith('pr create '));
      const labelCreateCount = lines.filter((line) => line.startsWith('label create release:minor ')).length;
      assert.strictEqual(labelCreateCount, 1);
      assert.match(prCreateLine, /--label release:minor/);
      assert.notStrictEqual(labelCreateLine, -1);
      assert.notStrictEqual(prCreateLineNumber, -1);
      assert.ok(labelCreateLine < prCreateLineNumber, 'the label must be created before the PR is opened');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('an unverifiable label refuses before any PR is created (#502 AC1, AC2)', () => {
    const sandbox = makeReleaseLabelSandbox();
    try {
      const run = runRelease(
        sandbox,
        [sandbox.phaseBranch, '--base-branch', 'main', '--dry-run'],
        { GH_FAIL_LIST: '1' }
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.notStrictEqual(run.status, 0, output);
      assert.match(run.stderr, /Cannot verify release label 'release:minor'/);
      assert.match(run.stderr, /gh label create release:minor/);
      assert.doesNotMatch(run.stdout, /Would create Milestone PR/);
      assert.strictEqual(lineNumber(ghLines(sandbox), (line) => line.startsWith('pr create')), -1);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('the live repository carries all three release labels this change provisions (#502 AC4)', (t: any) => {
    // AC4 has two halves. The LABEL-STATE half is provable from a pre-merge
    // tree and is pinned here against the real `ajxcodes/agyloop` vocabulary,
    // through the same `gh label list` shape `labelExists` uses. The PR-OPENING
    // half is the post-merge operator step (the installed build is what opens
    // it), so it cannot be asserted before this change ships.
    //
    // Opt-in so the default suite stays hermetic: the fake `gh` above is first
    // on PATH, and CI has no repository credentials.
    if (process.env.AGYLOOP_LIVE_RELEASE_LABELS !== '1') {
      t.skip('set AGYLOOP_LIVE_RELEASE_LABELS=1 to verify the live ajxcodes/agyloop labels');
      return;
    }

    const run = spawnSync(
      'gh',
      [
        'label',
        'list',
        '--repo',
        'ajxcodes/agyloop',
        '--limit',
        '200',
        '--json',
        'name,color,description'
      ],
      { encoding: 'utf8' }
    );
    assert.strictEqual(run.status, 0, run.stderr);

    const live = JSON.parse(run.stdout) as Array<{
      name: string;
      color: string;
      description: string;
    }>;
    for (const definition of Object.values(RELEASE_LABEL_DEFINITIONS) as Array<{
      name: string;
      color: string;
      description: string;
    }>) {
      const entry = live.find((candidate) => candidate.name === definition.name);
      if (!entry) {
        throw new Error(`label '${definition.name}' must exist in ajxcodes/agyloop`);
      }
      assert.strictEqual(
        entry.color,
        definition.color,
        `label '${definition.name}' must carry the colour this change provisions`
      );
      assert.strictEqual(
        entry.description,
        definition.description,
        `label '${definition.name}' must carry the description this change provisions`
      );
    }
  });

  test('an existing label keeps the PR argv unchanged (#502 AC3)', () => {
    const sandbox = makeReleaseLabelSandbox();
    try {
      const run = runRelease(sandbox, [sandbox.phaseBranch, '--base-branch', 'main'], {
        GH_LABELS: '[{"name":"release:minor"}]'
      });
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);
      assert.match(run.stdout, /pull\/999/);
      assert.match(run.stdout, /verified/);

      const lines = ghLines(sandbox);
      const labelCreateCount = lines.filter((line) => line.startsWith('label create')).length;
      assert.strictEqual(labelCreateCount, 0);

      const prCreateLine = lines.find((line: string) => line.startsWith('pr create ')) || '';
      const labelOccurrences = prCreateLine.split('--label').length - 1;
      assert.strictEqual(labelOccurrences, 1);
      assert.ok(prCreateLine.includes('--label release:minor'));
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
