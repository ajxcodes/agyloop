/**
 * agyloop - `next --json` actionability, end to end (issue #337)
 *
 * The documented contract is `actionable`/`actionType`: a harness dispatches the
 * payload only when `actionable` is true, and runs the named command otherwise.
 * Before #337 `actionable` was "not a human gate and not paused", so an idle
 * report, a pre-flight report and a stage whose completion condition was already
 * met all invited a dispatch that the prose forbade.
 *
 * A1  - COMPLETED: actionable:false, no payload, real commands named
 * A2  - INITIALIZED: actionable:false, no payload, no checkpoint created
 * A3  - DISCOVERY + populated report: advance, no payload, names `plan`
 * A4  - DISCOVERY + blank report: dispatchable (control)
 * A5  - PLAN + substantive plan: advance, no payload, names `transition APPROVAL`
 * A6  - PLAN + blank plan: dispatchable (control)
 * A7  - IMPLEMENT + untracked file: advance, no payload
 * A8  - IMPLEMENT + clean worktree: dispatchable (control)
 * A9  - QUALITY_GATE after `gate-report`: advance, no filing note
 * A10 - QUALITY_GATE with nothing filed: dispatchable + filing note
 * A11 - QUALITY_GATE with a STALE block: dispatchable + filing note
 * A12 - A3's checkpoint is byte-identical before/after
 * A13 - a FAILED gate filed then `transition IMPLEMENT`: the implementer is
 *       re-dispatched with the recorded failure (the gate-failure loop)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { GateResultReport, resolveGateRound, NOTE_IMPLEMENT_GATE_FAILED } = require('../../dist/domain');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 9;

const PASSED_BLOCK = [
  'GATE_REPORT_JSON:',
  '{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",',
  '  "testsStatus": "PASSED (12 passed)", "testsPassed": 12, "testsFailed": 0,',
  '  "durationMs": 1000, "executedCommands": ["npm test"],',
  '  "smokeProtocol": "NOT_DECLARED", "notRun": [] }'
].join('\n');

const FAILED_BLOCK = [
  'GATE_REPORT_JSON:',
  '{ "verdict": "FAILED", "buildSystem": "node", "buildStatus": "PASSED",',
  '  "testsStatus": "FAILED (2 failed)", "testsPassed": 10, "testsFailed": 2,',
  '  "durationMs": 1000, "executedCommands": ["npm test"],',
  '  "smokeProtocol": "NOT_DECLARED", "notRun": [] }'
].join('\n');

const REAL_PLAN = [
  '# [Implementation] - probe',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** add the completion-met return'
].join('\n');

const BLANK_PLAN = [
  '# [Implementation] - probe',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:**'
].join('\n');

const POPULATED_REPORT = [
  '# [Discovery] - probe',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:** the directive invited a dispatch after the report was populated',
  '- **Expected Behavior:** it names the advancing command instead',
  '- **Affected Components / Paths:** `src/application/get-next-action.ts`',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:** read `next` before and after writing the report',
  '- **Identified Failure Mode:** the payload was built before the report state was consulted',
  '- **Relevant Code References:** get-next-action.ts:605-638',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '- **Local Reproduction Command:** `codeloop next --issue 9 --json`',
  '- **Failing Test Target:** tests/presentation/cli-next-actionability.test.ts',
  '',
  '## 4. Remediation Strategy',
  '- **Recommended Fix Approach:** return an advance directive when the report is populated',
  '- **Potential Regressions / Side Effects:** none when no generator is injected'
].join('\n');

const BLANK_REPORT = [
  '# [Discovery] - probe',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:**',
  '- **Expected Behavior:**',
  '- **Affected Components / Paths:**',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:**',
  '- **Identified Failure Mode:**',
  '- **Relevant Code References:**'
].join('\n');

function makeSandbox(prefix = 'agyloop-cli-next-actionability-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runIn(dir: string, args: readonly string[]): Promise<any> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(dir);
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function taskStatePath(dir: string, issue: number = ISSUE): string {
  return path.join(dir, '.agyloop', 'tasks', `${issue}.json`);
}

function readCheckpoint(dir: string, issue: number = ISSUE): any {
  return JSON.parse(fs.readFileSync(taskStatePath(dir, issue), 'utf8'));
}

function writeCheckpoint(dir: string, checkpoint: any, issue: number = ISSUE): void {
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(taskStatePath(dir, issue), JSON.stringify(checkpoint, null, 2), 'utf8');
}

function baseCheckpoint(overrides: any = {}): any {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    currentStage: 'DISCOVERY',
    mode: 'standard',
    issue: ISSUE,
    baseBranch: 'main',
    planDir: null,
    worktree: null,
    createdAt: now,
    updatedAt: now,
    history: [{ stage: 'DISCOVERY', timestamp: now }],
    pausedAtGate: null,
    pausedAtTimestamp: null,
    totalHumanWaitMs: 0,
    ...overrides
  };
}

/** A plan directory holding the discovery/implementation documents. */
function seedPlanDir(dir: string, documents: { plan?: string; discovery?: string }): string {
  const planDir = path.join(dir, 'artifacts', 'plans', `${ISSUE}-task`);
  fs.mkdirSync(planDir, { recursive: true });
  if (documents.plan !== undefined) {
    fs.writeFileSync(path.join(planDir, 'implementation_plan.md'), documents.plan, 'utf8');
  }
  if (documents.discovery !== undefined) {
    fs.writeFileSync(path.join(planDir, '[Discovery] - Task.md'), documents.discovery, 'utf8');
  }
  return planDir;
}

function git(dir: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/** A real repository whose task worktree is a real linked git worktree. */
function makeImplementSandbox(): { dir: string; worktreePath: string } {
  const dir = makeSandbox('agyloop-cli-next-actionability-git-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test']);
  git(dir, ['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-qm', 'chore: base']);

  const worktreePath = path.join(dir, '.worktrees', String(ISSUE));
  git(dir, ['worktree', 'add', '-q', '-b', `task/${ISSUE}-probe`, worktreePath, 'main']);

  const planDir = seedPlanDir(dir, { plan: REAL_PLAN });
  writeCheckpoint(
    dir,
    baseCheckpoint({
      currentStage: 'IMPLEMENT',
      planDir,
      worktree: {
        taskId: String(ISSUE),
        worktreePath,
        branch: `task/${ISSUE}-probe`,
        baseBranch: 'main',
        isIsolated: true
      },
      history: [{ stage: 'IMPLEMENT', timestamp: new Date().toISOString() }]
    })
  );
  return { dir, worktreePath };
}

describe('codeloop next --json reports actionability from evidence (#337)', () => {
  test('A1: COMPLETED is not actionable and never names the placeholder command', async () => {
    const dir = makeSandbox();
    try {
      writeCheckpoint(
        dir,
        baseCheckpoint({
          currentStage: 'COMPLETED',
          history: [{ stage: 'COMPLETED', timestamp: new Date().toISOString() }]
        })
      );

      const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(payload.currentStage, 'COMPLETED');
      assert.strictEqual(payload.actionType, 'completed');
      assert.strictEqual(payload.actionable, false);
      assert.strictEqual('invocationPayload' in payload, false);
      assert.strictEqual(payload.pause, null);
      assert.ok(!payload.humanSummary.includes('codeloop <task>'), payload.humanSummary);
      assert.ok(payload.humanSummary.includes('codeloop plan --issue'), payload.humanSummary);
      assert.ok(payload.humanSummary.includes('codeloop next --restart --issue'), payload.humanSummary);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A2: INITIALIZED is not actionable and a query creates no checkpoint', async () => {
    const dir = makeSandbox();
    try {
      const run = await runIn(dir, ['next', '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(payload.currentStage, 'INITIALIZED');
      assert.strictEqual(payload.actionType, 'preflight');
      assert.strictEqual(payload.actionable, false);
      assert.strictEqual('invocationPayload' in payload, false);
      assert.strictEqual(fs.existsSync(path.join(dir, '.agyloop', 'tasks')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A3 + A12: DISCOVERY with a populated report advances and writes nothing', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, { plan: REAL_PLAN, discovery: POPULATED_REPORT });
      writeCheckpoint(dir, baseCheckpoint({ planDir }));
      const before = fs.readFileSync(taskStatePath(dir), 'utf8');

      const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(payload.currentStage, 'DISCOVERY');
      assert.strictEqual(payload.actionType, 'advance');
      assert.strictEqual(payload.actionable, false);
      assert.strictEqual('invocationPayload' in payload, false);
      assert.strictEqual('role' in payload, false);
      assert.strictEqual(payload.pause, null);
      assert.match(`${payload.description}\n${payload.humanSummary}`, /do not re-dispatch discovery/);
      assert.ok(
        `${payload.description}\n${payload.humanSummary}`.includes(`codeloop plan --issue ${ISSUE}`),
        payload.description
      );
      // A12: a met read is not a dispatch — the checkpoint is byte-identical.
      assert.strictEqual(fs.readFileSync(taskStatePath(dir), 'utf8'), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A4: DISCOVERY with a blank report stays dispatchable (control)', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, { plan: REAL_PLAN, discovery: BLANK_REPORT });
      writeCheckpoint(dir, baseCheckpoint({ planDir }));

      const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(payload.actionType, 'subagent');
      assert.strictEqual(payload.role, 'discovery');
      assert.strictEqual(payload.actionable, true);
      assert.ok(payload.invocationPayload);
      assert.strictEqual(readCheckpoint(dir).discoveryDispatchCount, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A5: PLAN with a substantive plan advances and names the transition', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, { plan: REAL_PLAN });
      writeCheckpoint(
        dir,
        baseCheckpoint({
          currentStage: 'PLAN',
          planDir,
          history: [
            { stage: 'DISCOVERY', timestamp: new Date(Date.now() - 60_000).toISOString() },
            { stage: 'PLAN', timestamp: new Date().toISOString() }
          ]
        })
      );

      const before = fs.readFileSync(taskStatePath(dir), 'utf8');
      const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(payload.currentStage, 'PLAN');
      assert.strictEqual(payload.nextStage, 'APPROVAL');
      assert.strictEqual(payload.actionType, 'advance');
      assert.strictEqual(payload.actionable, false);
      assert.strictEqual('invocationPayload' in payload, false);
      assert.strictEqual('role' in payload, false);
      assert.ok(
        `${payload.description}\n${payload.humanSummary}`.includes(
          `codeloop transition APPROVAL --issue ${ISSUE}`
        ),
        payload.description
      );
      assert.strictEqual(payload.planDispatchCount, 0);
      // A met read writes nothing: no counter key, byte-identical bytes.
      assert.strictEqual(readCheckpoint(dir).planDispatchCount, undefined);
      assert.strictEqual(fs.readFileSync(taskStatePath(dir), 'utf8'), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A6: PLAN with a blank plan stays dispatchable (control)', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, { plan: BLANK_PLAN });
      writeCheckpoint(
        dir,
        baseCheckpoint({
          currentStage: 'PLAN',
          planDir,
          history: [
            { stage: 'DISCOVERY', timestamp: new Date(Date.now() - 60_000).toISOString() },
            { stage: 'PLAN', timestamp: new Date().toISOString() }
          ]
        })
      );

      const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(payload.actionType, 'subagent');
      assert.strictEqual(payload.role, 'planner');
      assert.strictEqual(payload.actionable, true);
      assert.ok(payload.invocationPayload);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A7: IMPLEMENT with an untracked file advances without a payload', async () => {
    const sandbox = makeImplementSandbox();
    try {
      fs.mkdirSync(path.join(sandbox.worktreePath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(sandbox.worktreePath, 'src', 'probe.ts'),
        'export const probe = 1;\n',
        'utf8'
      );

      const before = fs.readFileSync(taskStatePath(sandbox.dir), 'utf8');
      const run = await runIn(sandbox.dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(payload.actionType, 'advance');
      assert.strictEqual(payload.nextStage, 'QUALITY_GATE');
      assert.strictEqual(payload.actionable, false);
      assert.strictEqual('invocationPayload' in payload, false);
      assert.strictEqual('role' in payload, false);
      assert.strictEqual(payload.implementationPresent, true);
      assert.strictEqual(payload.implementationDispatchCount, 0);
      assert.ok(
        `${payload.description}\n${payload.humanSummary}`.includes(
          `codeloop transition QUALITY_GATE --issue ${ISSUE}`
        ),
        payload.description
      );
      // A met read writes nothing: no counter key, byte-identical bytes.
      assert.strictEqual(readCheckpoint(sandbox.dir).implementationDispatchCount, undefined);
      assert.strictEqual(fs.readFileSync(taskStatePath(sandbox.dir), 'utf8'), before);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('A8: IMPLEMENT with a clean worktree stays dispatchable (control)', async () => {
    const sandbox = makeImplementSandbox();
    try {
      const run = await runIn(sandbox.dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(payload.actionType, 'subagent');
      assert.strictEqual(payload.role, 'implementer');
      assert.strictEqual(payload.actionable, true);
      assert.ok(payload.invocationPayload);
      assert.strictEqual(payload.implementationDispatchCount, 1);
      assert.strictEqual(readCheckpoint(sandbox.dir).implementationDispatchCount, 1);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('A9: after gate-report the gate directive advances and drops the filing note', async () => {
    const dir = makeSandbox();
    try {
      writeCheckpoint(
        dir,
        baseCheckpoint({
          currentStage: 'QUALITY_GATE',
          history: [
            { stage: 'IMPLEMENT', timestamp: new Date(Date.now() - 60_000).toISOString() },
            { stage: 'QUALITY_GATE', timestamp: new Date().toISOString() }
          ]
        })
      );
      const reportFile = path.join(dir, 'gate.txt');
      fs.writeFileSync(reportFile, PASSED_BLOCK, 'utf8');

      const filed = await runIn(dir, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        reportFile
      ]);
      assert.strictEqual(filed.code, 0, `${filed.stdout}\n${filed.stderr}`);

      const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);
      const text = `${payload.description}\n${payload.humanSummary}`;

      assert.strictEqual(payload.currentStage, 'QUALITY_GATE');
      assert.strictEqual(payload.nextStage, 'REVIEW');
      assert.strictEqual(payload.actionType, 'advance');
      assert.strictEqual(payload.actionable, false);
      assert.strictEqual('invocationPayload' in payload, false);
      assert.strictEqual(payload.pause, null);
      assert.strictEqual(payload.gateEvidenceFiled, true);
      assert.match(text, /evidence filed/i);
      assert.doesNotMatch(text, /file the gate's emitted/i);
      assert.ok(!text.includes('codeloop gate-report'), text);
      assert.ok(text.includes(`codeloop transition REVIEW --issue ${ISSUE}`), text);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A10: with nothing filed the gate directive still asks for the block', async () => {
    const dir = makeSandbox();
    try {
      writeCheckpoint(
        dir,
        baseCheckpoint({
          currentStage: 'QUALITY_GATE',
          history: [
            { stage: 'IMPLEMENT', timestamp: new Date(Date.now() - 60_000).toISOString() },
            { stage: 'QUALITY_GATE', timestamp: new Date().toISOString() }
          ]
        })
      );

      const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);
      const text = `${payload.description}\n${payload.humanSummary}`;

      assert.strictEqual(payload.actionType, 'subagent');
      assert.strictEqual(payload.role, 'gate');
      assert.strictEqual(payload.actionable, true);
      assert.ok(payload.invocationPayload);
      assert.strictEqual(payload.gateEvidenceFiled, false);
      assert.match(text, /file the gate's emitted/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A11: a STALE block cannot certify this round', async () => {
    const dir = makeSandbox();
    try {
      const checkpoint = baseCheckpoint({
        currentStage: 'QUALITY_GATE',
        history: [
          { stage: 'IMPLEMENT', timestamp: new Date(Date.now() - 60_000).toISOString() },
          { stage: 'QUALITY_GATE', timestamp: new Date().toISOString() }
        ]
      });
      writeCheckpoint(dir, checkpoint);

      // Written directly, stamped one round EARLIER than the checkpoint.
      const staleRound = Math.max(0, resolveGateRound(checkpoint.history) - 1);
      const stale = GateResultReport.parseBlock(PASSED_BLOCK, staleRound);
      fs.writeFileSync(
        path.join(dir, '.agyloop', 'tasks', `${ISSUE}.gate.json`),
        `${JSON.stringify(stale.toJSON(), null, 2)}\n`,
        'utf8'
      );

      const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);
      const text = `${payload.description}\n${payload.humanSummary}`;

      assert.strictEqual(payload.actionType, 'subagent');
      assert.strictEqual(payload.actionable, true);
      assert.ok(payload.invocationPayload);
      assert.strictEqual(payload.gateEvidenceFiled, false);
      assert.match(text, /file the gate's emitted/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A13: a FAILED gate re-dispatches the implementer with its diagnostics', async () => {
    const sandbox = makeImplementSandbox();
    try {
      // The implementation is present — and it is the one the gate rejected.
      fs.mkdirSync(path.join(sandbox.worktreePath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(sandbox.worktreePath, 'src', 'probe.ts'),
        'export const probe = 1;\n',
        'utf8'
      );

      // Move the seeded checkpoint to the gate, then file a FAILED block the way
      // a dispatched gate does.
      const checkpoint = readCheckpoint(sandbox.dir);
      checkpoint.currentStage = 'QUALITY_GATE';
      checkpoint.history = [
        { stage: 'IMPLEMENT', timestamp: new Date(Date.now() - 60_000).toISOString() },
        { stage: 'QUALITY_GATE', timestamp: new Date().toISOString() }
      ];
      writeCheckpoint(sandbox.dir, checkpoint);

      const reportFile = path.join(sandbox.dir, 'gate.txt');
      fs.writeFileSync(reportFile, FAILED_BLOCK, 'utf8');
      const filed = await runIn(sandbox.dir, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        reportFile
      ]);
      assert.strictEqual(filed.code, 0, `${filed.stdout}\n${filed.stderr}`);

      // The legal "go fix it" exit: QUALITY_GATE -> IMPLEMENT.
      const transitioned = await runIn(sandbox.dir, [
        'transition',
        'IMPLEMENT',
        '--issue',
        String(ISSUE)
      ]);
      assert.strictEqual(transitioned.code, 0, `${transitioned.stdout}\n${transitioned.stderr}`);
      assert.strictEqual(readCheckpoint(sandbox.dir).currentStage, 'IMPLEMENT');

      const run = await runIn(sandbox.dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, run.stderr);
      const payload = JSON.parse(run.stdout);
      const text = `${payload.description}\n${payload.humanSummary}`;

      // The existing diff is NOT a met completion: the gate that judged it
      // FAILED is on record, so the harness must get a fresh implementer.
      assert.strictEqual(payload.currentStage, 'IMPLEMENT');
      assert.strictEqual(payload.actionType, 'subagent');
      assert.strictEqual(payload.role, 'implementer');
      assert.strictEqual(payload.actionable, true);
      assert.ok(payload.invocationPayload, 'a FAILED gate must re-dispatch the implementer');
      assert.strictEqual(payload.implementationPresent, true);
      assert.ok(text.includes(NOTE_IMPLEMENT_GATE_FAILED), text);
      assert.ok(!text.includes('do not re-dispatch the implementer'), text);
      assert.match(payload.invocationPayload.Subagents[0].Prompt, /Quality Gate Failure/i);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
