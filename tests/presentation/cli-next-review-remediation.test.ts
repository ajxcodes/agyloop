/** The canonical task seed at IMPLEMENT with the review entries appended. */
function seedImplementCheckpoint(dir: string, reviewEntries: readonly Record<string, unknown>[]): void {
  const now = new Date().toISOString();
  seedTask(dir, {
    issue: ISSUE,
    currentStage: 'IMPLEMENT',
    planDir: path.join(dir, 'artifacts', 'plans', `${ISSUE}-task`),
    worktree: {
      taskId: String(ISSUE),
      worktreePath: path.join(dir, '.worktrees', String(ISSUE)),
      branch: `fix/${ISSUE}`,
      baseBranch: 'main',
      isIsolated: true
    },
    createdAt: now,
    updatedAt: now,
    history: [{ stage: 'IMPLEMENT', timestamp: now }, ...reviewEntries]
  });
  fs.mkdirSync(path.join(dir, 'artifacts', 'plans', `${ISSUE}-task`), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'artifacts', 'plans', `${ISSUE}-task`, 'implementation_plan.md'),
    REAL_PLAN,
    'utf8'
  );
  fs.mkdirSync(path.join(dir, '.worktrees', String(ISSUE)), { recursive: true });
}

/**
 * agyloop - `next --json` IMPLEMENT review remediation (issue #313, AC1-AC4)
 *
 * This is the issue's own reproduction, at the CLI boundary: seed a real
 * `.agyloop/tasks/<n>.json` checkpoint whose latest history entry holds a
 * `CHANGES_REQUESTED` review record, then read `next --json`.
 *
 * CR1 - the seeded remediation sentinel reaches the implementer prompt (AC4)
 * CR2 - an APPROVED latest round carries no stale remediation (AC4/AC2)
 * CR3 - the checkpoint is the source: it survives a fresh invocation (AC3)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');
const { makeSandbox } = require('../helpers/sandbox.ts');
const { seedTask, seedCheckpoint, seedRootState, seedCorruptTask, checkpointPath } = require('../helpers/state-seed.ts');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 313;
const SENTINEL = 'REMEDIATION_SENTINEL_313';

const REAL_PLAN = [
  '# [Implementation] - probe',
  '',
  '**Issue:** #313',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** do the probe'
].join('\n');

const CHANGES_BLOCK = [
  'REVIEW_STATUS: CHANGES_REQUESTED',
  'REVIEW_SUMMARY: round two summary',
  'UNFULFILLED_AC:',
  '- AC one',
  'REMEDIATION_GUIDANCE:',
  `- ${SENTINEL}`
].join('\n');

const APPROVED_BLOCK = [
  'REVIEW_STATUS: APPROVED',
  'REVIEW_SUMMARY: all good',
  'UNFULFILLED_AC:',
  '- None',
  'REMEDIATION_GUIDANCE:',
  '- None'
].join('\n');

function taskStateFile(dir: string): string {
  return path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
}



/**
 * Seeds a checkpoint resting at IMPLEMENT whose history ends with the given
 * review entries — exactly the shape `RunReviewUseCase` persists.
 */

async function nextJson(dir: string): Promise<any> {
  const result = await runCliInSandboxCanonical(['next', '--issue', String(ISSUE), '--json'], { dir: dir, stripAnsi: true });
  assert.strictEqual(result.code, 0, `next failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe('codeloop next --json review remediation (issue #313)', () => {
  test('CR1 (AC4/AC3): a seeded CHANGES_REQUESTED round reaches the implementer prompt', async () => {
    const dir = makeSandbox({ initGit: false, dirName: '' }).dir;
    try {
      seedImplementCheckpoint(dir, [
        {
          stage: 'IMPLEMENT',
          timestamp: new Date().toISOString(),
          metadata: {
            reviewVerdict: 'CHANGES_REQUESTED',
            reviewRound: 2,
            reviewTokens: CHANGES_BLOCK
          }
        }
      ]);
      const before = fs.readFileSync(taskStateFile(dir));

      const payload = await nextJson(dir);
      const prompt = payload.invocationPayload.Subagents[0].Prompt;

      assert.strictEqual(payload.role, 'implementer', 'the directive is the implementer');
      const missing = [
        SENTINEL,
        'REVIEW_SUMMARY:',
        'UNFULFILLED_AC',
        'REMEDIATION_GUIDANCE',
        'Round 2'
      ].filter((token) => !prompt.includes(token));
      assert.deepStrictEqual(
        missing,
        [],
        `AC4: the IMPLEMENT prompt is missing ${missing.join(', ')}\n---\n${prompt}`
      );
      assert.strictEqual(
        payload.reviewRemediationRound,
        2,
        `AC4: expected reviewRemediationRound 2, got ${payload.reviewRemediationRound}`
      );

      const after = fs.readFileSync(taskStateFile(dir));
      assert.ok(before.equals(after), 'AC3: next must not mutate the checkpoint on the IMPLEMENT read path');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CR2 (AC4/AC2): an APPROVED latest round carries no stale remediation', async () => {
    const dir = makeSandbox({ initGit: false, dirName: '' }).dir;
    try {
      seedImplementCheckpoint(dir, [
        {
          stage: 'IMPLEMENT',
          timestamp: new Date().toISOString(),
          metadata: {
            reviewVerdict: 'CHANGES_REQUESTED',
            reviewRound: 2,
            reviewTokens: CHANGES_BLOCK
          }
        },
        {
          stage: 'IMPLEMENT',
          timestamp: new Date().toISOString(),
          metadata: {
            reviewVerdict: 'APPROVED',
            reviewRound: 3,
            reviewTokens: APPROVED_BLOCK
          }
        }
      ]);

      const payload = await nextJson(dir);
      const prompt = payload.invocationPayload.Subagents[0].Prompt;

      assert.strictEqual(payload.role, 'implementer');
      assert.ok(
        !prompt.includes(SENTINEL),
        `AC2: stale round-2 remediation leaked into the APPROVED re-dispatch\n---\n${prompt}`
      );
      assert.ok(
        !prompt.includes('Review Remediation'),
        `AC2: no remediation section may be rendered after an APPROVED round\n---\n${prompt}`
      );
      assert.strictEqual(
        'reviewRemediationRound' in payload,
        false,
        `AC2: an APPROVED round must not report a remediation round, got ${payload.reviewRemediationRound}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CR3 (AC3): the checkpoint still records the review and a second next still carries it', async () => {
    const dir = makeSandbox({ initGit: false, dirName: '' }).dir;
    try {
      seedImplementCheckpoint(dir, [
        {
          stage: 'IMPLEMENT',
          timestamp: new Date().toISOString(),
          metadata: {
            reviewVerdict: 'CHANGES_REQUESTED',
            reviewRound: 2,
            reviewTokens: CHANGES_BLOCK
          }
        }
      ]);

      const first = await nextJson(dir);
      assert.ok(
        first.invocationPayload.Subagents[0].Prompt.includes(SENTINEL),
        'AC3: the first read must carry the remediation'
      );

      const checkpoint = JSON.parse(fs.readFileSync(taskStateFile(dir), 'utf8'));
      assert.ok(
        JSON.stringify(checkpoint.history).includes(SENTINEL),
        'AC3: the checkpoint must still record the review tokens after next'
      );

      // A fresh invocation: the checkpoint is the only input.
      const second = await nextJson(dir);
      assert.ok(
        second.invocationPayload.Subagents[0].Prompt.includes(SENTINEL),
        'AC3: an independent next invocation must rebuild the remediation from the checkpoint'
      );
      assert.strictEqual(second.reviewRemediationRound, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
