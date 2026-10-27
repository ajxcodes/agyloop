/**
 * agyloop - `fetchIssue` asks for the milestone and the checkpoint persists it
 * (issue #284, AC7 / Defect 6)
 *
 * The defect: `gh issue view --json` never requested `milestone`, and it
 * requested no `comments` either — so every checkpoint recorded
 * `milestoneTitle: null`, starving the release/changelog path (#257).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { CliGitHubGateway } = require('../../dist/infrastructure');
const { EXIT_CODE_SUCCESS } = require('../../dist/domain');

const ISSUE_PAYLOAD = JSON.stringify({
  number: 284,
  title: '[Phase 6] [Bug] Operator output & run evidence are wrong',
  body: 'Consolidated report.',
  state: 'OPEN',
  labels: [{ name: 'bug' }],
  milestone: { title: 'Phase 6: CodeLoop' },
  comments: [
    { author: { login: 'ajxcodes' }, body: 'Fresh #297-run evidence.', createdAt: '2026-10-26T10:00:00Z' }
  ]
});

interface Sandbox {
  readonly dir: string;
  readonly binDir: string;
  readonly logPath: string;
}

function makeSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-gh-milestone-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });

  const binDir = path.join(dir, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const logPath = path.join(dir, 'gh-calls.log');
  const payloadPath = path.join(dir, 'issue.json');
  fs.writeFileSync(payloadPath, ISSUE_PAYLOAD, 'utf8');

  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$GH_CALL_LOG"',
      'case "$*" in',
      '  *"issue view"*) cat "$GH_ISSUE_PAYLOAD" ;;',
      '  *"pr list"*) echo \'[]\' ;;',
      '  *) echo \'\' ;;',
      'esac',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(ghPath, 0o755);

  process.env.GH_CALL_LOG = logPath;
  process.env.GH_ISSUE_PAYLOAD = payloadPath;

  return { dir, binDir, logPath };
}

function withFakeGh<T>(sandbox: Sandbox, fn: () => T): T {
  const prevPath = process.env.PATH;
  const prevLog = process.env.GH_CALL_LOG;
  const prevPayload = process.env.GH_ISSUE_PAYLOAD;
  try {
    process.env.PATH = `${sandbox.binDir}${path.delimiter}${prevPath}`;
    process.env.GH_CALL_LOG = sandbox.logPath;
    process.env.GH_ISSUE_PAYLOAD = path.join(sandbox.dir, 'issue.json');
    return fn();
  } finally {
    process.env.PATH = prevPath;
    if (prevLog === undefined) delete process.env.GH_CALL_LOG;
    else process.env.GH_CALL_LOG = prevLog;
    if (prevPayload === undefined) delete process.env.GH_ISSUE_PAYLOAD;
    else process.env.GH_ISSUE_PAYLOAD = prevPayload;
  }
}

function calledArgv(sandbox: Sandbox): string[] {
  if (!fs.existsSync(sandbox.logPath)) return [];
  return fs.readFileSync(sandbox.logPath, 'utf8').split('\n').filter(Boolean);
}

describe('fetchIssue milestone and comments (issue #284, AC7)', () => {
  test('requests the exact field list the parser reads', () => {
    const sandbox = makeSandbox();
    try {
      const issue = withFakeGh(sandbox, () =>
        new CliGitHubGateway().fetchIssue(284, { cwd: sandbox.dir })
      );

      assert.ok(issue, 'the issue must be read');
      const argv = calledArgv(sandbox);
      assert.ok(argv.length > 0, 'the fake gh must have been invoked');

      const issueCall = argv.find((line: string) => line.includes('issue view')) as string | undefined;
      assert.ok(issueCall, `an 'issue view' call must be logged, got: ${JSON.stringify(argv)}`);
      assert.ok(
        (issueCall as string).includes('--json number,title,body,state,labels,milestone,comments'),
        `the exact field list must be requested, got: ${issueCall}`
      );

      // Drift guard: every field the parser reads must be requested.
      const requested = new Set(
        ((issueCall as string).split('--json')[1] || '').trim().split(',').map((field: string) => field.trim())
      );
      for (const field of ['number', 'title', 'body', 'state', 'labels', 'milestone', 'comments']) {
        assert.ok(requested.has(field), `the field list must request '${field}', got: ${issueCall}`);
      }
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('maps the milestone title and the comments payload', () => {
    const sandbox = makeSandbox();
    try {
      const issue = withFakeGh(sandbox, () =>
        new CliGitHubGateway().fetchIssue(284, { cwd: sandbox.dir })
      );
      assert.ok(issue);
      assert.strictEqual(issue.milestone.title, 'Phase 6: CodeLoop');
      assert.strictEqual(issue.comments.length, 1);
      assert.strictEqual(issue.comments[0].author, 'ajxcodes');
      assert.strictEqual(issue.comments[0].body, 'Fresh #297-run evidence.');
      assert.strictEqual(issue.comments[0].createdAt, '2026-10-26T10:00:00Z');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('plan persists milestoneTitle on the checkpoint (on-disk assertion)', () => {
    const sandbox = makeSandbox();
    const prevCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    try {
      process.chdir(sandbox.dir);
      process.env.PATH = `${sandbox.binDir}${path.delimiter}${prevPath}`;
      process.env.GH_CALL_LOG = sandbox.logPath;
      process.env.GH_ISSUE_PAYLOAD = path.join(sandbox.dir, 'issue.json');
      process.env.HOME = path.join(sandbox.dir, '.home');
      delete process.env.AGY_SUBAGENT;
      console.log = () => {};
      console.error = () => {};

      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, '..', '..', 'bin', 'codeloop.js'), 'plan', '--issue', '284', '--skip-discovery'],
        { cwd: sandbox.dir, encoding: 'utf8', env: { ...process.env } }
      );
      assert.strictEqual(result.status, EXIT_CODE_SUCCESS, `plan must succeed, got:\n${result.stderr}`);

      const checkpointPath = path.join(sandbox.dir, '.agyloop', 'tasks', '284.json');
      assert.ok(fs.existsSync(checkpointPath), 'the task checkpoint must exist');
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      assert.strictEqual(
        checkpoint.milestoneTitle,
        'Phase 6: CodeLoop',
        `milestoneTitle must be persisted, got: ${JSON.stringify(checkpoint)}`
      );
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      process.env.PATH = prevPath;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      delete process.env.GH_CALL_LOG;
      delete process.env.GH_ISSUE_PAYLOAD;
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
