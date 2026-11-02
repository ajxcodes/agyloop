/**
 * agyloop - `sync` reads more than the newest 30 merged PRs (#447)
 *
 * The harness installs a FAKE `gh` first on `PATH` in an isolated sandbox. The
 * stub MODELS `--limit` (default 30, exactly like gh) and records argv; nothing
 * reaches GitHub.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const POSIX_ONLY = process.platform === 'win32' ? { skip: 'POSIX-only test' } : {};
const ROOT = path.resolve(__dirname, '..', '..');
const TOTAL_MERGED_PRS = 45;

interface Sandbox {
  readonly dir: string;
  readonly repo: string;
  readonly home: string;
  readonly logPath: string;
}

function makeSandbox(mode: 'complete' | 'truncated'): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-sync-window-'));
  const repo = path.join(dir, 'repo');
  const binDir = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const logPath = path.join(dir, 'gh.log');

  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const git = (args: string[], cwd = repo): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  };

  git(['init', '-q']);
  git(['checkout', '-q', '-b', 'phase/test']);
  git(['config', 'user.email', 'smoke@test']);
  git(['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'probe\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'chore: probe']);
  git(['init', '-q', '--bare', path.join(dir, 'origin.git')], dir);
  git(['remote', 'add', 'origin', path.join(dir, 'origin.git')]);
  git(['push', '-qu', 'origin', 'phase/test']);

  const config = {
    total: mode === 'truncated' ? 1000 : TOTAL_MERGED_PRS,
    alwaysFull: mode === 'truncated'
  };
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const CONFIG = ${JSON.stringify(config)};`,
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(process.env.GH_CALL_LOG, args.join(' ') + '\\n');",
      "const limitAt = args.indexOf('--limit');",
      'const limit = limitAt === -1 ? 30 : Number(args[limitAt + 1]);',
      "const command = args.slice(0, 2).join(' ');",
      "if (command === 'pr list') {",
      '  const count = CONFIG.alwaysFull ? limit : Math.min(limit, CONFIG.total);',
      '  const prs = Array.from({ length: count }, (_, index) => {',
      '    const number = CONFIG.total - index;',
      "    return { number, title: 'delivery ' + number, body: 'Closes #' + (number + 100) };",
      '  });',
      '  process.stdout.write(JSON.stringify(prs));',
      "} else if (command === 'pr view') {",
      "  process.stdout.write('src/feature.ts\\n');",
      "} else if (command === 'issue view') {",
      "  process.stdout.write(JSON.stringify({ number: Number(args[2]), title: 't', body: '', state: 'OPEN', labels: [], comments: [] }));",
      '} else {',
      '  process.exit(0);',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(ghPath, 0o755);

  return { dir, repo, home, logPath };
}

function runSync(sandbox: Sandbox, args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
  ghCalls: string[];
} {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'codeloop.js'), 'sync', ...args], {
    cwd: sandbox.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(sandbox.dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: sandbox.home,
      GH_CALL_LOG: sandbox.logPath,
      AGY_SUBAGENT: ''
    }
  });
  const ghCalls = fs.existsSync(sandbox.logPath)
    ? fs.readFileSync(sandbox.logPath, 'utf8').split('\n').filter(Boolean)
    : [];
  return {
    status: res.status === null ? -1 : res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    ghCalls
  };
}

describe('sync reads every merged PR (#447)', () => {
  test('S447-1: the CLI asks gh for every merged PR and closes the oldest one (issue #447)', POSIX_ONLY, () => {
    const sandbox = makeSandbox('complete');
    try {
      const result = runSync(sandbox, []);

      assert.strictEqual(result.status, 0, result.stderr);
      const listCalls = result.ghCalls.filter((call) => call.startsWith('pr list'));
      assert.strictEqual(listCalls.length, 1, result.ghCalls.join('\n'));
      assert.match(listCalls[0], /--limit \d+ /, listCalls[0]);
      assert.ok(result.stdout.includes('Scanned 45 merged PRs'), result.stdout);
      assert.ok(result.stdout.includes('processed 45 merged PRs'), result.stdout);
      const closes = result.ghCalls.filter((call) => call.startsWith('issue close'));
      assert.strictEqual(closes.length, 45, result.ghCalls.join('\n'));
      assert.strictEqual(
        closes.filter((call) => /^issue close 101\b/.test(call)).length,
        1,
        `the OLDEST merged PR (issue #101) must be closed: ${result.ghCalls.join('\n')}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('S447-2: a truncated scan exits non-zero and closes nothing (issue #447)', POSIX_ONLY, () => {
    const sandbox = makeSandbox('truncated');
    try {
      const result = runSync(sandbox, []);

      assert.notStrictEqual(result.status, 0, result.stdout);
      assert.ok(!result.stdout.includes('Successfully synced'), result.stdout);
      const closes = result.ghCalls.filter((call) => call.startsWith('issue close'));
      assert.strictEqual(closes.length, 0, result.ghCalls.join('\n'));
      const listCalls = result.ghCalls.filter((call) => call.startsWith('pr list'));
      assert.strictEqual(listCalls.length, 5, listCalls.join('\n'));
      assert.match(listCalls[4], /--limit 1000\b/, listCalls[4]);
      assert.ok(result.stderr.includes('1000-PR ceiling'), result.stderr);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
