/**
 * agyloop - `codeloop next` terminal REVIEW directive (issue #272, AC4)
 *
 * Discovery must not depend on having read the OpenCode skill: the terminal
 * render — not only the JSON `Prompt` — names the verdict-filing channel and the
 * exit condition. A paused read must not record a dispatch.
 *
 * RV5.
 *
 * RV7 (issue #356) proves the live dispatch hands the reviewer the untracked
 * file its own `git diff` command cannot see — and stages nothing doing it.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { NOTE_REVIEW_GATE_EXIT_CONDITION } = require('../../dist/domain');

const ISSUE = 912;

function seedCheckpoint(dir: string, extra: Record<string, unknown> = {}): string {
  const stateFile = path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'REVIEW',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'REVIEW', timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null,
        reviewDispatchCount: 0,
        ...extra
      },
      null,
      2
    ),
    'utf8'
  );
  return stateFile;
}

async function runNextIn(dir: string): Promise<{ code: number; output: string }> {
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let output = '';

  try {
    process.chdir(dir);
    console.log = (...args: any[]) => {
      output += args.map(String).join(' ') + '\n';
    };
    console.error = (...args: any[]) => {
      output += args.map(String).join(' ') + '\n';
    };
    const code = await runCli(['next', '--issue', String(ISSUE)]);
    return { code, output };
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

/**
 * Runs `next --json` and captures STDOUT ONLY, so the printed payload is one
 * parseable JSON document even when the CLI also warns on stderr (issue #314).
 */
async function runNextJsonIn(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';

  try {
    process.chdir(dir);
    console.log = (...args: any[]) => {
      stdout += args.map(String).join(' ') + '\n';
    };
    console.error = (...args: any[]) => {
      stderr += args.map(String).join(' ') + '\n';
    };
    const code = await runCli(['next', '--issue', String(ISSUE), '--json']);
    return { code, stdout, stderr };
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('codeloop next terminal REVIEW directive (issue #272)', () => {
  test('RV5a: the terminal render names the channel and the exit condition', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-next-review-'));
    try {
      const stateFile = seedCheckpoint(sandbox);
      const run = await runNextIn(sandbox);

      assert.strictEqual(run.code, 0, run.output);
      assert.ok(run.output.includes('codeloop review --issue'), run.output);
      assert.ok(run.output.includes('--verdict-file'), run.output);
      // Issue #297: the instruction is addressed to the ORCHESTRATOR, and the
      // channel itself is unchanged.
      assert.ok(
        run.output.includes("Orchestrator: file the reviewer's emitted verdict block"),
        run.output
      );
      // Every secondary snippet interpolates the REAL issue (issue #291 F3).
      assert.ok(
        run.output.includes('codeloop review --issue 912 --review-output'),
        `the inline snippet must name the issue, got:\n${run.output}`
      );
      assert.ok(
        run.output.includes('codeloop review --issue 912 --verdict-stdin'),
        `the stdin snippet must name the issue, got:\n${run.output}`
      );
      assert.ok(run.output.includes(NOTE_REVIEW_GATE_EXIT_CONDITION), run.output);
      assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).reviewDispatchCount, 1);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('RV5b: a paused read does not record a dispatch', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-next-review-'));
    try {
      const stateFile = seedCheckpoint(sandbox, {
        pausedAtGate: 'APPROVAL',
        pausedAtTimestamp: new Date().toISOString()
      });
      const run = await runNextIn(sandbox);

      assert.strictEqual(run.code, 0, run.output);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(stateFile, 'utf8')).reviewDispatchCount,
        0,
        'a paused read is not a dispatch'
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('RV6: the dispatched prompt quotes the critique binary the CLI resolved (issue #314)', async () => {
    // A nested root keeps the resolver's sibling candidate (`../critique`)
    // absent, so the bundled `<worktree>/bin/critique.js` is deterministic.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-next-review-314-'));
    const sandbox = path.join(root, 'worktree');
    try {
      fs.mkdirSync(path.join(sandbox, 'bin'), { recursive: true });
      const critiquePath = path.join(sandbox, 'bin', 'critique.js');
      fs.writeFileSync(critiquePath, '#!/usr/bin/env node\n');
      seedCheckpoint(sandbox);

      const run = await runNextJsonIn(sandbox);

      assert.strictEqual(run.code, 0, run.stderr || run.stdout);
      const payload = JSON.parse(run.stdout);
      const prompt = payload.invocationPayload?.Subagents?.[0]?.Prompt ?? '';
      assert.strictEqual(payload.role, 'reviewer', `expected the reviewer directive, got ${payload.role}`);
      assert.ok(
        prompt.includes(`node '${critiquePath}' --json`),
        `AC1: the Tier 1 command must quote the resolved path, got:\n${prompt.slice(0, 3000)}`
      );
      assert.ok(!prompt.includes('export PATH='), 'AC4: no PATH export may be rendered');
      assert.ok(
        !prompt.includes('~/.local/bin/critique --json'),
        'AC3: the dead hardcoded command must not be rendered'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('RV7: the live dispatch names a real untracked file and stages nothing (issue #356)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-next-review-356-'));
    const sandbox = path.join(root, 'worktree');
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: sandbox, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    try {
      fs.mkdirSync(path.join(sandbox, '.github', 'workflows'), { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: sandbox, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: sandbox, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: sandbox, stdio: 'ignore' });

      // A TRACKED file inside .github/ is what stops `git status --porcelain`
      // from collapsing the untracked entry to `?? .github/`.
      fs.writeFileSync(path.join(sandbox, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf8');
      fs.writeFileSync(path.join(sandbox, 'README.md'), 'probe\n', 'utf8');
      git(['add', '-A']);
      git(['commit', '-qm', 'chore: base with a tracked .github directory']);

      // The load-bearing part of the change set, and invisible to `git diff`.
      fs.writeFileSync(
        path.join(sandbox, '.github', 'actionlint.yaml'),
        'self-hosted-runner:\n  labels:\n    - ubuntu-26.04\n',
        'utf8'
      );
      seedCheckpoint(sandbox);

      const run = await runNextJsonIn(sandbox);

      assert.strictEqual(run.code, 0, run.stderr || run.stdout);
      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.role, 'reviewer', `expected the reviewer directive, got ${payload.role}`);

      const prompt = payload.invocationPayload?.Subagents?.[0]?.Prompt ?? '';
      assert.ok(
        prompt.includes('.github/actionlint.yaml'),
        `the untracked-only implementation file is invisible to the reviewer prompt:\n${prompt.slice(0, 3000)}`
      );
      assert.ok(
        prompt.includes("git diff --no-index -- /dev/null '.github/actionlint.yaml' || true"),
        `the prompt must carry a content command for the untracked path:\n${prompt.slice(0, 3000)}`
      );
      assert.strictEqual(prompt.includes('git add'), false, 'the dispatch must not name staging');

      // The dispatch is READ-ONLY evidence: the path is still untracked AND the
      // index is untouched (staging changes what the commit draft sees, #240).
      assert.strictEqual(git(['status', '--porcelain', '--', '.github']), '?? .github/actionlint.yaml');
      assert.strictEqual(git(['diff', '--cached', '--name-only']), '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
