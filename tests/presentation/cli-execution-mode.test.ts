/**
 * codeloop - the `Execution Mode` cell names how the run actually executed
 * (issue #339, item 11 / AC-3.4, AC-3.5)
 *
 * T10.2  a checkpoint seeded with `mode: plan` that transitions
 *        PLAN → APPROVAL → IMPLEMENT renders `standard` — both the primary cell
 *        and the Active Tasks matrix row, which read the RAW CHECKPOINT FIELD
 *        the state machine cleared on the first transition out of the plan
 *        phase.
 * T10.3  a `plan`-shaped run halted at APPROVAL still renders `plan` (the fix
 *        does not over-clear).
 *
 * The state-machine half (T10.1: the field itself across the walks) lives in
 * `tests/state-machine.test.ts`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { StateMachine } = require('../../dist/domain');
const { makeSandbox } = require('../helpers/sandbox.ts');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');

function makeExecutionModeSandbox(): string {
  return makeSandbox({
    prefix: 'codeloop-execution-mode-',
    dirName: '',
    gitignore: false,
    seed: (d: string) => {
      fs.writeFileSync(path.join(d, 'README.md'), 'x\n', 'utf8');
      fs.mkdirSync(path.join(d, '.home'), { recursive: true });
    },
    initialCommit: 'chore: seed'
  }).dir;
}



const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;


/**
 * Seeds a task checkpoint whose mode is the one `codeloop plan` sets, walked
 * through the given stages. The snapshot records whatever the machine's field
 * became — including the item-11 clear on the first transition past APPROVAL.
 */
function seedPlanModeWalk(dir: string, issue: number, through: readonly string[]): void {
  const sm = StateMachine.createInitial({ mode: 'plan', issue });
  for (const stage of through) {
    sm.transition(stage);
  }
  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, `${issue}.json`), JSON.stringify(sm.toSnapshot(), null, 2));
}


describe('item 11: the Execution Mode cell is truthful (AC-3.4/3.5)', () => {
  test('T10.2: a plan-started run that reached IMPLEMENT renders `standard`', async () => {
    const dir = makeExecutionModeSandbox();
    try {
      const issue = 33952;
      seedPlanModeWalk(dir, issue, ['DISCOVERY', 'PLAN', 'APPROVAL', 'IMPLEMENT']);

      const run = await runCliInSandboxCanonical(['status', '--issue', String(issue)], { dir: dir });

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Execution Mode: standard/, run.stdout);
      assert.ok(
        !/Execution Mode: plan/.test(run.stdout),
        `a run that implemented must not render plan mode:\n${run.stdout}`
      );
      // The Active Tasks matrix reads the SAME raw field.
      const matrixRow = run.stdout
        .split('\n')
        .find((line: string) => line.startsWith(`#${issue} `));
      assert.ok(matrixRow, `the matrix must list the task:\n${run.stdout}`);
      assert.match(matrixRow!, /standard/, `the matrix Mode cell must say standard: ${matrixRow}`);
      assert.ok(!/\bplan\b/.test(matrixRow!), `no plan cell in the matrix row: ${matrixRow}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T10.3: a plan-only run halted at APPROVAL still renders `plan` (no over-clear)', async () => {
    const dir = makeExecutionModeSandbox();
    try {
      const issue = 33953;
      seedPlanModeWalk(dir, issue, ['DISCOVERY', 'PLAN', 'APPROVAL']);

      const run = await runCliInSandboxCanonical(['status', '--issue', String(issue)], { dir: dir });

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Execution Mode: plan/, run.stdout);
      const matrixRow = run.stdout
        .split('\n')
        .find((line: string) => line.startsWith(`#${issue} `));
      assert.ok(matrixRow, `the matrix must list the task:\n${run.stdout}`);
      assert.match(matrixRow!, /plan/, `the matrix must keep plan: ${matrixRow}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
