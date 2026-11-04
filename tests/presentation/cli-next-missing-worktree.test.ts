/**
 * agyloop - `codeloop next` with a missing worktree descriptor (issue #266,
 * absorbs #287 B).
 *
 * A checkpoint at IMPLEMENT whose `worktree` is null (the state left behind by
 * a `codeloop worktree remove` during IMPLEMENT) used to raise the Zero Direct
 * Root Mutation invariant and escape as a raw `Fatal:` + stack trace with exit
 * 1. It must instead return a rendered, actionable directive.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation');
const { makeSandbox: makeSandboxCanonical } = require('../helpers/sandbox.ts');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');

const NOW = '2026-10-24T00:00:00.000Z';
const ISSUE = 803;

interface Sandbox {
  readonly base: string;
  readonly dir: string;
}

function makeMissingWorktreeSandbox(): Sandbox {
  const sandbox = makeSandboxCanonical({
    prefix: 'agyloop-cli-next-missing-wt-',
    dirName: 'repo',
    seed: (dir: string) => {
      fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
    },
    initialCommit: 'chore: probe init'
  });
  const dir = sandbox.dir;
  const base = sandbox.root;

  // A substantive plan: a BLANK plan at IMPLEMENT is the #267 planner
  // directive, which is checked before the worktree guard. These tests are
  // about the worktree guard, so the plan must be real.
  const planDir = path.join(dir, 'artifacts', 'plans', `${ISSUE}-missing-worktree-probe`);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, 'implementation_plan.md'),
    '# [Implementation] - missing worktree probe\n\n## 3. Implementation Steps\n- [ ] **Step 1:** probe the guard\n',
    'utf8'
  );

  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'IMPLEMENT',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        planDir,
        worktree: null,
        createdAt: NOW,
        updatedAt: NOW,
        history: [{ stage: 'IMPLEMENT', timestamp: NOW }]
      },
      null,
      2
    ),
    'utf8'
  );

  return { base, dir };
}


describe('codeloop next with a missing worktree (#266, absorbs #287)', () => {
  test('F1 `next --issue N --json` exits 0 with a directive (AC-10, AC-12)', async () => {
    const sandbox = makeMissingWorktreeSandbox();
    try {
      const run = await runCliInSandboxCanonical(['next', '--issue', String(ISSUE), '--json'], { dir: sandbox.dir });

      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const parsed = JSON.parse(run.stdout);
      assert.strictEqual(parsed.actionType, 'human_gate');
      assert.strictEqual(parsed.worktreePath, null);
      // Issue #315 (AC-7): a human gate is NOT actionable work, and it carries
      // a pause object (synthesised — there is no persisted pause to resume).
      assert.strictEqual(parsed.actionable, false);
      assert.ok(parsed.pause && parsed.pause.gate, `a human gate must carry a pause:\n${run.stdout}`);
      assert.strictEqual(parsed.pause.resumeCommand, null);
      assert.strictEqual(parsed.title, 'Worktree Required');
      assert.ok(
        parsed.humanSummary.includes('codeloop implement'),
        `the directive must name the re-provision command:\n${parsed.humanSummary}`
      );
      assert.ok(
        parsed.humanSummary.includes(`--issue ${ISSUE}`),
        `the directive must name the issue:\n${parsed.humanSummary}`
      );
    } finally {
      fs.rmSync(sandbox.base, { recursive: true, force: true });
    }
  });

  test('F2 no `Fatal:` and no stack trace escapes (AC-10)', async () => {
    const sandbox = makeMissingWorktreeSandbox();
    try {
      for (const args of [
        ['next', '--issue', String(ISSUE), '--json'],
        ['next', '--issue', String(ISSUE)]
      ]) {
        const run = await runCliInSandboxCanonical(args, { dir: sandbox.dir });
        const combined = run.stdout + run.stderr;
        assert.strictEqual(/Fatal:/.test(combined), false, `${args.join(' ')}:\n${combined}`);
        assert.strictEqual(
          /^\s+at\s+\S+/m.test(combined),
          false,
          `${args.join(' ')} leaked a stack trace:\n${combined}`
        );
      }
    } finally {
      fs.rmSync(sandbox.base, { recursive: true, force: true });
    }
  });

  test('F3 the human renderer names the title and the command (AC-10)', async () => {
    const sandbox = makeMissingWorktreeSandbox();
    try {
      const run = await runCliInSandboxCanonical(['next', '--issue', String(ISSUE)], { dir: sandbox.dir });

      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stdout.includes('Next Action   : Worktree Required'), run.stdout);
      assert.ok(
        run.stdout.includes(`codeloop implement --issue ${ISSUE}`),
        `the command must be printed:\n${run.stdout}`
      );
    } finally {
      fs.rmSync(sandbox.base, { recursive: true, force: true });
    }
  });
});
