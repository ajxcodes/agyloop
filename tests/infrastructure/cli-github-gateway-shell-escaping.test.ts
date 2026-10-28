/**
 * agyloop - CliGitHubGateway Shell-Escaping Regression Tests (#262)
 *
 * The defect this file pins: `commentOnIssue` interpolated the comment body
 * into a DOUBLE-QUOTED shell word and escaped only `"`. Inside a double-quoted
 * word a POSIX shell performs command substitution, so a body carrying
 * backticks or `$(…)` was EXECUTED, not posted — and the failure was silent.
 *
 * The harness installs a FAKE `gh` first on `process.env.PATH`. It records the
 * argv it receives and exits 0. Nothing reaches GitHub.
 */

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliGitHubGateway } = require('../../dist/infrastructure/cli-github-gateway');
const { SyncUseCase } = require('../../dist/application');

const POSIX_ONLY = process.platform === 'win32' ? { skip: 'POSIX-only test' } : {};

let workDir = '';
let argvFile = '';
let stdoutFile = '';
let origPath = '';

/**
 * Installs a fake `gh` that records its argv (NUL-separated) and answers with
 * an optional payload. It is placed FIRST on the PATH, so the real `gh` is
 * never reached.
 */
function installFakeGh(): void {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-gh-'));
  argvFile = path.join(workDir, 'gh-argv.txt');
  stdoutFile = path.join(workDir, 'gh-stdout.txt');

  const script = [
    '#!/bin/sh',
    `printf '%s' '--INV--' >> ${JSON.stringify(argvFile)}`,
    'for a in "$@"; do printf \'%s\\0\' "$a" >> ' + JSON.stringify(argvFile) + '; done',
    'if [ -f "$GH_STDOUT_FILE" ]; then cat "$GH_STDOUT_FILE"; fi',
    'exit 0'
  ].join('\n');

  fs.writeFileSync(path.join(workDir, 'gh'), script, { mode: 0o755 });
  origPath = process.env.PATH || '';
  process.env.PATH = `${workDir}:${origPath}`;
  process.env.GH_STDOUT_FILE = stdoutFile;
}

/**
 * The argv of every recorded `gh` invocation.
 */
function invocations(): string[][] {
  if (!fs.existsSync(argvFile)) return [];
  return fs
    .readFileSync(argvFile, 'utf8')
    .split('--INV--')
    .filter((chunk: string) => chunk.length > 0)
    .map((chunk: string) => chunk.split('\0').filter((s: string) => s !== ''));
}

/**
 * The argv of the LAST recorded `gh` invocation.
 */
function lastInvocation(): string[] {
  const all = invocations();
  return all.length > 0 ? all[all.length - 1] : [];
}

before(() => {
  installFakeGh();
});

beforeEach(() => {
  fs.writeFileSync(argvFile, '');
  fs.writeFileSync(stdoutFile, '');
});

after(() => {
  process.env.PATH = origPath;
  delete process.env.GH_STDOUT_FILE;
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describe('CliGitHubGateway free text reaches gh verbatim (#262)', () => {
  test('commentOnIssue hands the body to gh verbatim, as its own argv element', POSIX_ONLY, () => {
    const gateway = new CliGitHubGateway();
    const body = 'Automatically closed by agyloop sync. Implemented and merged via PR #261 into `phase/6-codeloop`.';

    gateway.commentOnIssue(259, body, { repo: 'ajxcodes/agyloop', cwd: workDir });

    const argv = lastInvocation();
    assert.strictEqual(argv[0], 'issue');
    assert.strictEqual(argv[1], 'comment');
    assert.strictEqual(argv[2], '259');
    assert.ok(argv.includes('--repo'));
    assert.ok(argv.includes('ajxcodes/agyloop'));
    assert.strictEqual(argv[argv.indexOf('--body') + 1], body, 'the body must arrive byte-identical');
    assert.ok(argv.includes(body), 'the body must be present as its own argv element');
  });

  test('commentOnIssue never builds a shell command', () => {
    const gateway = new CliGitHubGateway();
    let shellPathUsed = false;
    gateway.runGh = () => {
      shellPathUsed = true;
      throw new Error('the shell path must not be used for a comment body');
    };

    gateway.commentOnIssue(259, 'body', { repo: 'ajxcodes/agyloop', cwd: workDir });

    assert.strictEqual(shellPathUsed, false, 'commentOnIssue must use the argv path');
  });

  test('a body carrying shell metacharacters is posted verbatim', POSIX_ONLY, () => {
    const gateway = new CliGitHubGateway();
    const body = 'backtick `id`; dollar $(id); and && or | pipe ; semicolon';

    gateway.commentOnIssue(259, body, { repo: 'ajxcodes/agyloop', cwd: workDir });

    const argv = lastInvocation();
    assert.strictEqual(argv[argv.indexOf('--body') + 1], body);
    assert.ok(argv.includes(body));
  });

  test('nothing is executed: an injected command never runs', POSIX_ONLY, () => {
    const gateway = new CliGitHubGateway();
    const marker = path.join(workDir, 'INJECTED_MARKER');
    fs.rmSync(marker, { force: true });

    const bodies = [
      `report \`touch ${marker}\` end`,
      `report $(touch ${marker}) end`,
      `report ; touch ${marker} end`,
      `report && touch ${marker} end`,
      `report | touch ${marker} end`
    ];

    for (const body of bodies) {
      gateway.commentOnIssue(259, body, { repo: 'ajxcodes/agyloop', cwd: workDir });
      assert.ok(
        !fs.existsSync(marker),
        `the body ${JSON.stringify(body)} must not have executed anything`
      );
    }

    // Every body still arrived verbatim.
    const recorded = invocations().map((argv) => argv[argv.indexOf('--body') + 1]);
    assert.deepStrictEqual(recorded, bodies);
  });

  test('applyLabels passes each label verbatim', POSIX_ONLY, () => {
    const gateway = new CliGitHubGateway();
    const labels = ['bug', 'priority:p0', 'weird `id`; rm -rf /'];

    gateway.applyLabels(259, labels, { repo: 'ajxcodes/agyloop', cwd: workDir });

    const argv = lastInvocation();
    assert.strictEqual(argv[0], 'issue');
    assert.strictEqual(argv[1], 'edit');
    assert.strictEqual(argv[2], '259');
    const added = argv.filter((_, i) => argv[i - 1] === '--add-label');
    assert.deepStrictEqual(added, labels, 'each label must arrive as its own argv element');
  });

  test('createPullRequest passes title, body and branches verbatim', POSIX_ONLY, () => {
    const gateway = new CliGitHubGateway();
    const title = 'fix: `whoami` $(id)';
    const body = 'Closes #262 — with "quotes" and `backticks`';
    const base = 'main';
    const head = 'fix/262-shell';

    fs.writeFileSync(stdoutFile, 'https://github.com/org/repo/pull/42\n');
    const pr = gateway.createPullRequest({
      repo: 'ajxcodes/agyloop',
      baseBranch: base,
      headBranch: head,
      title,
      body
    });

    const argv = lastInvocation();
    assert.strictEqual(argv[0], 'pr');
    assert.strictEqual(argv[1], 'create');
    assert.strictEqual(argv[argv.indexOf('--title') + 1], title);
    assert.strictEqual(argv[argv.indexOf('--body') + 1], body);
    assert.strictEqual(argv[argv.indexOf('--base') + 1], base);
    assert.strictEqual(argv[argv.indexOf('--head') + 1], head);
    assert.strictEqual(pr.number, 42);
  });

  test('findPullRequest passes the head branch verbatim', POSIX_ONLY, () => {
    const gateway = new CliGitHubGateway();
    const headBranch = 'fix/262 `id` $(id)';

    fs.writeFileSync(stdoutFile, '[]\n');
    gateway.findPullRequest({ headBranch, repo: 'ajxcodes/agyloop', cwd: workDir });

    const argv = lastInvocation();
    assert.strictEqual(argv[0], 'pr');
    assert.strictEqual(argv[1], 'list');
    assert.strictEqual(argv[argv.indexOf('--head') + 1], headBranch);
    const json = argv[argv.indexOf('--json') + 1];
    assert.ok(
      json.startsWith('number,title,body,state'),
      `the --json element must request the body, got ${JSON.stringify(json)}`
    );
  });

  test('findPullRequest passes the issue token verbatim', POSIX_ONLY, () => {
    const gateway = new CliGitHubGateway();

    fs.writeFileSync(stdoutFile, '[]\n');
    gateway.findPullRequest({ issueNumber: 262, repo: 'ajxcodes/agyloop', cwd: workDir });

    const argv = lastInvocation();
    assert.strictEqual(argv[argv.indexOf('--search') + 1], '262');
  });
});

describe('codeloop sync names the collector branch again (#262)', () => {
  test('the auto-close comment carries the branch name verbatim', POSIX_ONLY, async () => {
    const executor = {
      async execute(command: string) {
        if (command.startsWith('gh pr list')) {
          return {
            stdout: JSON.stringify([{ number: 42, title: 'Fix bug', body: 'Closes #10' }]),
            exitCode: 0
          };
        }
        // Issue #240/Defect 3: the compensator requires the PR's own diff, so
        // the real run reads it before it closes anything.
        if (command.startsWith('gh pr view')) {
          return { stdout: 'src/app.ts\n', exitCode: 0 };
        }
        if (command.includes('git rev-parse')) {
          return { stdout: 'phase/123', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      }
    };
    const stateRepo = { async load() { return null; } };
    const worktrees = { async resolveBaseBranch() { return 'phase/123'; } };
    const gateway = new CliGitHubGateway();

    // #328: the read that authorizes the close now FAILS CLOSED, so the fake
    // `gh` must answer `issue view` with a payload that measures a state. An
    // empty stdout would (correctly) close nothing and post no comment.
    fs.writeFileSync(
      stdoutFile,
      JSON.stringify({ number: 10, title: 't', body: '', state: 'OPEN', labels: [], comments: [] })
    );

    const result = await new SyncUseCase(executor, gateway, stateRepo, worktrees).execute({ workspaceDir: workDir });
    assert.strictEqual(result.success, true, `sync must succeed: ${JSON.stringify(result)}`);

    const bodies = invocations()
      .map((argv) => argv[argv.indexOf('--body') + 1])
      .filter((body) => body && body.startsWith('Closed by agyloop sync'));

    assert.strictEqual(bodies.length, 1, 'exactly one auto-close comment must be posted');
    assert.strictEqual(
      bodies[0],
      'Closed by agyloop sync: PR #42 into `phase/123` changed 1 non-test file(s) (Closes #10).'
    );
  });
});
