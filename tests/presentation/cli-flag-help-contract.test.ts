/**
 * agyloop - flag & help contracts match the implementation (issue #339,
 * absorbing #340: items 4, 7 + AC-2.5)
 *
 * T4.1  `opencode:install` declares `dryRun: 'supported'` — the command writes
 *       two files, so the old "read-only" refusal was false.
 * T4.2  a sandboxed `opencode install --dry-run` exits 0, prints both
 *       would-write paths, and writes NOTHING under $HOME.
 * T4.3  (negative control) the real install in the same sandbox creates both
 *       files — a no-op dry run cannot pass.
 * T7.1  `--restart`'s help line states the TRIAGE precedence and keeps
 *       DISCOVERY as the other outcome.
 * T8.1  table-driven: observed exit code + marker + mutation for every row
 *       equals `COMMAND_CAPABILITIES[key].dryRun`.
 * T8.2  the help `--dry-run` line and the SKILL command table agree with the
 *       capability table in both directions for those rows.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { printHelp } = require('../../dist/presentation/cli');
const { COMMAND_CAPABILITIES, capabilityKey } = require('../../dist/presentation/cli-flags');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'codeloop.js');
const SKILL_FILE = path.join(REPO_ROOT, 'skills', 'agyloop', 'SKILL.md');

function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-flag-contract-'));
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: seed'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  return dir;
}

/** Hash of the sandbox EXCLUDING `.git` (read-only git probes are allowed). */
function treeHash(root: string, ignoreDirs: readonly string[] = ['.git']): string {
  if (!fs.existsSync(root)) return 'absent';
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && ignoreDirs.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(root, full);
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        lines.push(`${rel} ${digest}`);
      }
    }
  };
  walk(root);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

function spawnCli(
  dir: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const home = path.join(dir, '.home');
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, AGY_SUBAGENT: '', HOME: home, ...extraEnv }
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function captureHelp(): string {
  const originalLog = console.log;
  let out = '';
  try {
    console.log = (...a: unknown[]) => {
      out += a.map(String).join(' ') + '\n';
    };
    printHelp();
  } finally {
    console.log = originalLog;
  }
  return out;
}

function listFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

describe('item 4: `opencode install --dry-run` simulates (AC-2.1)', () => {
  test('T4.1: the capability table declares opencode:install dryRun supported', () => {
    assert.strictEqual(COMMAND_CAPABILITIES['opencode:install'].dryRun, 'supported');
    // The JSON surface does not exist for this command and stays refused.
    assert.strictEqual(COMMAND_CAPABILITIES['opencode:install'].json, 'refused');
  });

  test('T4.2: a sandboxed dry run exits 0, names both paths, and writes nothing', () => {
    const dir = makeSandbox();
    try {
      const run = spawnCli(dir, ['opencode', 'install', '--dry-run']);

      assert.strictEqual(run.status, 0, `exit 0 expected, got ${run.status}:\n${run.stderr}`);
      assert.ok(run.stdout.includes('[dry-run]'), run.stdout);
      assert.match(run.stdout, /Would write/, run.stdout);
      assert.match(run.stdout, /opencode\.json/, run.stdout);
      assert.match(run.stdout, /SKILL\.md/, run.stdout);

      const home = path.join(dir, '.home');
      assert.deepStrictEqual(
        listFilesUnder(home),
        [],
        'a dry run must not create a single file under $HOME'
      );
      assert.strictEqual(
        fs.existsSync(path.join(home, '.config', 'opencode')),
        false,
        'the config directory must not be created'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T4.3: the real install in the same sandbox creates both files (negative control)', () => {
    const dir = makeSandbox();
    try {
      const run = spawnCli(dir, ['opencode', 'install']);

      assert.strictEqual(run.status, 0, `exit 0 expected, got ${run.status}:\n${run.stderr}`);
      const home = path.join(dir, '.home');
      const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
      const skillPath = path.join(home, '.config', 'opencode', 'skills', 'codeloop', 'SKILL.md');
      assert.ok(fs.existsSync(configPath), `the command registration must exist: ${configPath}`);
      assert.ok(fs.existsSync(skillPath), `the skill asset must exist: ${skillPath}`);
      // …which is exactly why the old "the command does not modify state"
      // refusal was false (#339 item 4).
      assert.match(run.stdout, /OpenCode Integration Assets Installed/, run.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('item 7: `--restart` help states the triage precedence (AC-2.4)', () => {
  test('T7.1: the --restart help line names TRIAGE and keeps DISCOVERY', () => {
    const help = captureHelp();
    // The FLAG entry (line ~610), not the `next` description that mentions it.
    const restartLine = help
      .split('\n')
      .find((line) => line.trimStart().startsWith('--restart'));
    assert.ok(restartLine, 'help must document the --restart flag entry');
    assert.match(restartLine, /TRIAGE/, `the TRIAGE precedence must be named:\n${restartLine}`);
    assert.match(
      restartLine,
      /undispositioned review feedback/,
      `the precedence condition must be stated:\n${restartLine}`
    );
    assert.match(
      restartLine,
      /DISCOVERY/,
      `DISCOVERY must remain the other outcome:\n${restartLine}`
    );
    // The policy itself is NOT changed — only the text. The four rules stay
    // where they were (T7.3 lives in lifecycle-reentry-policy.test.ts).
    assert.match(restartLine, /that feedback wins over DISCOVERY/, restartLine);
  });
});

describe('AC-2.5: the capability table, the help line and the skill agree', () => {
  interface Row {
    readonly key: string;
    readonly args: readonly string[];
    readonly expect: 'supported' | 'refused';
    readonly label: string;
  }

  const rows: readonly Row[] = [
    { key: 'opencode:install', args: ['opencode', 'install', '--dry-run'], expect: 'supported', label: 'opencode install' },
    { key: 'worktree:prune', args: ['worktree', 'prune', '--dry-run'], expect: 'supported', label: 'worktree prune' },
    { key: 'next', args: ['next', '--dry-run'], expect: 'supported', label: 'next' },
    { key: 'plan', args: ['plan', '--dry-run'], expect: 'supported', label: 'plan' },
    { key: 'status', args: ['status', '--dry-run'], expect: 'refused', label: 'status' }
  ];

  test('T8.1: observed exit code + marker + mutation equal the declared capability', () => {
    for (const row of rows) {
      const capability = COMMAND_CAPABILITIES[row.key];
      assert.ok(capability, `the capability table must carry ${row.key}`);
      assert.strictEqual(
        capability.dryRun,
        row.expect,
        `${row.key}: the table must declare dryRun '${row.expect}'`
      );

      const dir = makeSandbox();
      try {
        const before = treeHash(dir);
        const run = spawnCli(dir, row.args);
        const after = treeHash(dir);

        if (row.expect === 'supported') {
          assert.strictEqual(run.status, 0, `${row.label} must simulate (exit 0):\n${run.stderr}`);
          assert.match(
            run.stdout + run.stderr,
            /\[dry[- ]run\]/i,
            `${row.label} must carry the dry-run marker:\n${run.stdout}`
          );
          assert.strictEqual(after, before, `${row.label} --dry-run must mutate nothing`);
        } else {
          assert.strictEqual(run.status, 1, `${row.label} must refuse (exit 1)`);
          assert.ok(
            (run.stderr + run.stdout).includes('does not modify state'),
            `${row.label}: the refusal must state why:\n${run.stderr}`
          );
          assert.strictEqual(after, before, `${row.label} must change nothing while refusing`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('T8.2: the help --dry-run line and the SKILL rows match the capability table', () => {
    const help = captureHelp();
    // The FLAG entry, not a command description that merely mentions the flag.
    const helpDryRunLine = help
      .split('\n')
      .find((line) => line.trimStart().startsWith('--dry-run'));
    assert.ok(helpDryRunLine, 'help must document the --dry-run flag entry');
    assert.match(helpDryRunLine, /Simulate execution without modifying state/, helpDryRunLine);
    assert.match(helpDryRunLine, /read-only commands refuse it/, helpDryRunLine);

    const skill: string = fs.readFileSync(SKILL_FILE, 'utf8');
    const skillRow = (prefix: string): string => {
      const line = skill.split('\n').find((l) => l.startsWith(prefix));
      assert.ok(line, `the skill must document a row starting with ${prefix}`);
      return line!;
    };

    // supported rows advertise the flag in the skill …
    assert.ok(skillRow('| `codeloop next').includes('--dry-run'), 'next: skill must document --dry-run');
    assert.ok(skillRow('| `codeloop plan').includes('--dry-run'), 'plan: skill must document --dry-run');
    const worktreeRow = skillRow('| `codeloop worktree');
    assert.ok(worktreeRow.includes('--dry-run'), 'worktree: skill must document --dry-run');
    assert.match(worktreeRow, /list.*refuses|refuses it/, 'worktree list refuses --dry-run in the skill');
    // … and the refused row must NOT advertise it.
    assert.ok(
      !skillRow('| `codeloop status').includes('--dry-run'),
      'status: the skill must not advertise a refused flag'
    );

    // Both directions against the table itself.
    assert.strictEqual(COMMAND_CAPABILITIES.next.dryRun, 'supported');
    assert.strictEqual(COMMAND_CAPABILITIES.plan.dryRun, 'supported');
    assert.strictEqual(COMMAND_CAPABILITIES['worktree:prune'].dryRun, 'supported');
    assert.strictEqual(COMMAND_CAPABILITIES['worktree:list'].dryRun, 'refused');
    assert.strictEqual(COMMAND_CAPABILITIES.status.dryRun, 'refused');

    // capabilityKey maps the invocations above to those table entries.
    assert.strictEqual(
      capabilityKey({
        command: 'opencode',
        yolo: false,
        worktreeSubcommand: null,
        critiqueSubcommand: null,
        opencodeSubcommand: 'install'
      }),
      'opencode:install'
    );
    assert.strictEqual(
      capabilityKey({
        command: 'worktree',
        yolo: false,
        worktreeSubcommand: 'prune',
        critiqueSubcommand: null,
        opencodeSubcommand: null
      }),
      'worktree:prune'
    );
  });
});
