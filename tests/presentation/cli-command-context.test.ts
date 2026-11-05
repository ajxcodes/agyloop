/**
 * codeloop - the unified CLI command context (issue #441 Step 2)
 *
 * TR-13 (AC3): the export surface of `src/presentation/cli.ts` is unchanged by
 * the command-context refactor — every value export that existed before must
 * still be present on the built module, none renamed.
 *
 * TR-14 (AC2): `status`, `next` and `branch-info` resolve the SAME task
 * checkpoint through the unified resolver — one checkpoint file (`tasks/441.json`),
 * the same resolution target reported by each surface, and the root
 * checkpoint (`.agyloop/state.json`) is never created by any of them.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const cliModule = require('../../dist/presentation/cli');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');
const { makeSandbox } = require('../helpers/sandbox.ts');
const { runCli } = cliModule;

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 441;

/** The 18 value exports of `src/presentation/cli.ts` at the merge base (#441). */
const EXPECTED_EXPORTS = [
  'runCli',
  'main',
  'printHelp',
  'parseArguments',
  'computePromptsAllowed',
  'RESUME_COMMAND',
  'COMMIT_GATE_COMMAND',
  'APPROVAL_GATE_COMMAND',
  'synthesiseHumanGatePause',
  'readPersistedGatePause',
  'formatVerdictInputMissing',
  'formatStageBadge',
  'dismissCountLines',
  'printTriageRefusal',
  'printTriageDismissOutcome',
  'lifecycleHaltExitCode',
  'persistedHaltExitCode',
  'installStreamErrorGuards'
] as const;

describe('the CLI export surface is unchanged (TR-13, AC3)', () => {
  test('every pre-refactor value export is still present', () => {
    for (const name of EXPECTED_EXPORTS) {
      assert.ok(
        typeof cliModule[name] === 'function' || typeof cliModule[name] === 'string',
        `export '${name}' must survive the command-context refactor`
      );
    }
  });

  test('the export surface is exactly the pre-refactor set (no accidental additions or removals)', () => {
    const actualKeys = Object.keys(cliModule).sort();
    assert.deepStrictEqual(actualKeys, [...EXPECTED_EXPORTS].sort());
  });
});

function taskStateFileFor(dir: string, issue: number): string {
  return path.join(dir, '.agyloop', 'tasks', `${issue}.json`);
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** An IMPLEMENT checkpoint with the same shape the smoke protocol seeds. */
function seedImplementCheckpoint(dir: string, issue: number): string {
  const now = '2026-11-01T00:00:00.000Z';
  const taskPath = taskStateFileFor(dir, issue);
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(
    taskPath,
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'IMPLEMENT',
      mode: 'standard',
      issue,
      baseBranch: 'main',
      worktree: null,
      planDir: null,
      planPath: null,
      createdAt: now,
      updatedAt: now,
      history: [{ stage: 'IMPLEMENT', timestamp: now }]
    })
  );
  return taskPath;
}

/**
 * Runs `runCli` in a git-initialized sandbox (the same host shape the smoke
 * protocol builds), with both console streams captured and everything restored.
 */

/** The canonical harness composed for this suite: makeSandbox dir (smoke@example.com/Smoke) + the ISSUE impl checkpoint. */
async function runCliInSandboxLocal(
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string; dir: string }> {
  const sandbox = makeSandbox({
    prefix: 'codeloop-cli-command-context-',
    dirName: '',
    gitignore: false,
    userConfig: { email: 'smoke@example.com', name: 'Smoke' },
    initialCommit: null
  });
  const dir = sandbox.dir;
  seedImplementCheckpoint(dir, ISSUE);
  const result = await runCliInSandboxCanonical(args, { dir, stripAnsi: true });
  return { ...result, dir };
}

describe('status, next and branch-info share the command context (TR-14, AC2)', () => {
  test('all three surfaces resolve the same task checkpoint and never write the root', async () => {
    let statusParsed: Record<string, any>;
    let nextParsed: Record<string, any>;
    let branchInfoParsed: Record<string, any>;
    let dir: string;

    const status = await runCliInSandboxLocal(['status', '--issue', String(ISSUE), '--json']);
    dir = status.dir;
    try {
      assert.strictEqual(status.code, 0, status.stderr);
      statusParsed = JSON.parse(status.stdout);
      assert.ok(
        statusParsed.stateFilePath.endsWith(path.join('.agyloop', 'tasks', `${ISSUE}.json`)),
        `status must resolve the task checkpoint, got: ${statusParsed.stateFilePath}`
      );
      assert.strictEqual(statusParsed.currentStage, 'IMPLEMENT');
      assert.strictEqual(statusParsed.issue, ISSUE);

      const branchInfo = await runCliInSandboxNoSeed(dir, ['branch-info', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(branchInfo.code, 0, branchInfo.stderr);
      branchInfoParsed = JSON.parse(branchInfo.stdout);
      assert.strictEqual(
        branchInfoParsed.checkpoint,
        statusParsed.stateFilePath,
        'branch-info must name the SAME checkpoint status resolved'
      );

      const next = await runCliInSandboxNoSeed(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(next.code, 0, next.stderr);
      nextParsed = JSON.parse(next.stdout);
      assert.strictEqual(nextParsed.currentStage, 'IMPLEMENT');
      assert.ok('actionable' in nextParsed, 'the next payload must carry the actionable boolean');

      // The root checkpoint was never created by any of the three surfaces.
      assert.ok(
        !fs.existsSync(path.join(dir, '.agyloop', 'state.json')),
        'the unified command context must not create the root checkpoint'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Runs `runCli` again in the SAME sandbox without re-seeding, restoring state.
 */

/** The canonical harness run in a caller-owned dir. */
async function runCliInSandboxNoSeed(
  dir: string,
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runCliInSandboxCanonical(args, { dir, stripAnsi: true });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

