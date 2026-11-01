/**
 * agyloop - Approval baseline guard regression suite (issue #388, Defect 1)
 *
 * ABG1 - `transition APPROVAL` refuses a mismatched baseline, nothing is saved
 *        and the checkpoint stays at PLAN
 * ABG2 - `codeloop implement` refuses the same plan BEFORE provisioning a worktree
 * ABG3 - `--dry-run` warns, does not execute the plan's command, and does not save
 * ABG4 - a correct plan that embeds a plan fixture in its smoke protocol (the
 *        #388 plan's `cat > … <<'PLAN'` shape) is approvable: the fenced sample
 *        is DATA, never evidence
 * ABG6 - a workspace-build-output claim is refused IDENTICALLY by both surfaces
 *        (`transition APPROVAL` and `codeloop implement`), even though APPROVAL
 *        measures where `dist/` exists: zero commands execute, nothing is
 *        saved, no worktree is provisioned (issue #418)
 * ABG7 - each surface's refusal names the cwd IT measured in, and the two
 *        directories differ
 *
 * The plan mirrors the #382 `DA-METRICS-1` shape: `{ additions: 3 }` declared,
 * `{ additions: 4 }` measured.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  StartImplementationUseCase,
  TransitionStageUseCase
} = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  MODE_STANDARD,
  ValidationError
} = require('../../dist/domain');
const { ProcessCommandExecutor } = require('../../dist/infrastructure');

const ISSUE = 388;
const MISMATCH_COMMAND = "node -e 'console.log(\"{ additions: 4, deletions: 0 }\")'";

function baselinePlan(declared: string): string {
  return [
    '# [Implementation] - baseline probe',
    '',
    '## Implementation Steps',
    '- [ ] **Step 1:** hold',
    '',
    '### Baseline Evidence',
    '',
    '#### DA-METRICS-1',
    '',
    `- **Declared:** \`${declared}\``,
    `- **Command:** \`${MISMATCH_COMMAND}\``,
    '- **Output:** `{ additions: 4, deletions: 0 }`',
    ''
  ].join('\n');
}

/** The #383 shape: every baseline starts by rebuilding the workspace root. */
function buildLikePlan(): string {
  return [
    '# [Implementation] - build-like baseline probe',
    '',
    '## Implementation Steps',
    '- [ ] **Step 1:** hold',
    '',
    '### Baseline Evidence',
    '',
    '#### root-build-claim',
    '',
    '- **Declared:** `built`',
    '- **Command:** `npm run build >/dev/null 2>&1 && node -e "console.log(\\"built\\")"`',
    '- **Output:** `built`',
    ''
  ].join('\n');
}

/**
 * The #418 shape: the claim resolves the workspace's own build output, so it can
 * only be measured where `dist/` exists — which the task worktree never has.
 */
function workspaceBuildOutputPlan(): string {
  return [
    '# [Implementation] - workspace build-output probe',
    '',
    '## Implementation Steps',
    '- [ ] **Step 1:** hold',
    '',
    '### Baseline Evidence',
    '',
    '#### workspace-dist-claim',
    '',
    '- **Declared:** `{"ok":true}`',
    `- **Command:** \`node -e 'console.log(JSON.stringify({ok:typeof require("./dist/domain").SmokeProtocol==="function"}))'\``,
    '- **Output:** `{"ok":true}`',
    ''
  ].join('\n');
}

/** The failing-claim shape used to prove both surfaces name their own cwd. */
function failingPlan(): string {
  return [
    '# [Implementation] - failing claim probe',
    '',
    '## Implementation Steps',
    '- [ ] **Step 1:** hold',
    '',
    '### Baseline Evidence',
    '',
    '#### failing-claim',
    '',
    '- **Declared:** `measured`',
    "- **Command:** `node -e 'process.exit(3)'`",
    '- **Output:** `measured`',
    ''
  ].join('\n');
}

class MockStateRepository {
  public snapshot: any;
  public saveCallCount = 0;

  constructor(initial: any) {
    this.snapshot = initial;
  }

  public load(): any {
    return this.snapshot;
  }

  public save(snapshot: any): void {
    this.snapshot = snapshot;
    this.saveCallCount++;
  }

  public reset(): void {
    this.snapshot = null;
  }

  public getStateFilePath(): string {
    return '/mock/state.json';
  }
}

class MockConfigRepository {
  public loadConfig(): any {
    return {
      models: {
        planner: 'pro',
        implementer: 'inherit',
        gate: 'flash_lite',
        reviewer: 'flash'
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: 600,
        autoApproveInYolo: true,
        enableMcpInPlanner: true
      }
    };
  }

  public resolveModel(role: string): any {
    return { role, configured: 'inherit', tier: 'inherit', apiModel: 'inherit' };
  }
}

class RecordingWorktreeManager {
  public createWorktreeCallCount = 0;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  public async createWorktree(options: any): Promise<any> {
    this.createWorktreeCallCount++;
    const worktreePath = path.join(this.root, '.worktrees', String(options.taskId));
    fs.mkdirSync(worktreePath, { recursive: true });
    return {
      taskId: options.taskId,
      worktreePath,
      branch: `task/${options.taskId}`,
      baseBranch: options.baseBranch || 'main',
      createdAt: new Date().toISOString()
    };
  }

  public async removeWorktree(): Promise<void> {}
  public async resolveTaskWorktreePath(_dir: string, taskId: string | number): Promise<string> {
    return path.join(this.root, '.worktrees', String(taskId));
  }
  public resolveTaskBranchName(taskId: string | number): string {
    return `task/${taskId}`;
  }
  public async ensureGitIgnore(): Promise<boolean> {
    return false;
  }
  public async resolveBaseBranch(): Promise<string> {
    return 'main';
  }
  public async pruneWorktrees(): Promise<void> {}
  public async listWorktrees(): Promise<any[]> {
    return [];
  }
  public async cleanOrphanedWorktrees(): Promise<number> {
    return 0;
  }
  public async listBranches(): Promise<string[]> {
    return ['main'];
  }
  public async createBranch(): Promise<void> {}
  public async isAncestor(): Promise<boolean> {
    return false;
  }
  public async getCommitsBetween(): Promise<any[]> {
    return [];
  }
  public async pushBranch(): Promise<boolean> {
    return true;
  }
}

function makePlanGenerator(planDir: string, planPath: string): any {
  return {
    resolvePlanFile: (options: any) => {
      if (options.planPath && fs.existsSync(options.planPath)) {
        return {
          planDir: path.dirname(options.planPath),
          planPath: options.planPath,
          planFileName: path.basename(options.planPath),
          summaryPath: path.join(path.dirname(options.planPath), 'AgyLoop Summary.md')
        };
      }
      if (!fs.existsSync(planDir)) return null;
      return {
        planDir,
        planPath,
        planFileName: path.basename(planPath),
        summaryPath: path.join(planDir, 'AgyLoop Summary.md')
      };
    },
    readPlanDocument: (target: string) => fs.readFileSync(target, 'utf8'),
    hashPlanDocument: (target: string) => `sha256:${fs.readFileSync(target, 'utf8')}`,
    updateSummaryLog: () => true
  };
}

function makeExecutor(stdout: string): any {
  const calls: any[] = [];
  return {
    calls,
    execute: async (command: string, options: any) => {
      calls.push({ command, options });
      return {
        command,
        exitCode: 0,
        stdout,
        stderr: '',
        combinedOutput: stdout,
        durationMs: 1,
        timedOut: false
      };
    }
  };
}

/**
 * Wraps a real executor and records the cwd each command was measured in, so a
 * case can assert both "nothing ran" and "it ran HERE" against the real process
 * path (issue #418).
 */
function makeRecordingExecutor(inner: any): any {
  const calls: any[] = [];
  return {
    calls,
    execute: async (command: string, options: any) => {
      calls.push({ command, cwd: options?.cwd });
      return inner.execute(command, options);
    }
  };
}

/**
 * The #388 plan shape: the only `### Baseline Evidence` heading in the document
 * is a SAMPLE inside a `cat > … <<'PLAN'` smoke block, and the body row names
 * `DA-METRICS-1` with a different value. Before the fence-aware parser the
 * sample became the evidence section and the row a phantom body mismatch, so a
 * genuinely correct plan was refused.
 */
function fencedSamplePlan(): string {
  const FENCE = String.fromCharCode(96, 96, 96);
  return [
    '# [Implementation] - fenced sample probe',
    '',
    'Every baseline value was reproduced through `dist/` before this plan was written.',
    '',
    '## 1. Context & Objectives',
    '',
    '| ID | Declared |',
    '|---|---|',
    '| DA-METRICS-1 | `{ additions: 3, deletions: 0 }` |',
    '',
    '### Manual Smoke Test Protocol',
    '',
    `${FENCE}bash`,
    'set -eu',
    'mkdir -p artifacts/plans/388-sample',
    "cat > artifacts/plans/388-sample/implementation_plan.md <<'PLAN'",
    '# [Implementation] - sample',
    '',
    '### Baseline Evidence',
    '',
    '#### DA-METRICS-1',
    '',
    '- **Declared:** `{ additions: 4, deletions: 0 }`',
    "- **Command:** `node -e 'console.log(4)'`",
    '- **Output:** `{ additions: 4, deletions: 0 }`',
    'PLAN',
    FENCE,
    '',
    '### Baseline Evidence',
    '',
    '#### DA-METRICS-1',
    '',
    '- **Declared:** `{ additions: 3, deletions: 0 }`',
    "- **Command:** `node -e 'console.log(\"{ additions: 3, deletions: 0 }\")'`",
    '- **Output:** `{ additions: 3, deletions: 0 }`',
    ''
  ].join('\n');
}

describe('Approval baseline guard (issue #388)', () => {
  let root: string;
  let planDir: string;
  let planPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-approval-baseline-'));
    planDir = path.join(root, 'artifacts/plans/388-baseline');
    fs.mkdirSync(planDir, { recursive: true });
    planPath = path.join(planDir, 'implementation_plan.md');
    fs.writeFileSync(planPath, baselinePlan('{ additions: 3, deletions: 0 }'), 'utf8');
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  test('ABG1: transition APPROVAL refuses, saves nothing, and stays at PLAN', async () => {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);

    const stateRepo = new MockStateRepository(sm.toSnapshot());
    const executor = makeExecutor('{ additions: 4, deletions: 0 }\n');
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath),
      undefined,
      executor
    );

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('DA-METRICS-1'), err.message);
        assert.ok(err.message.includes('additions: 4'), err.message);
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCallCount, 0, 'a refused approval must persist nothing');
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_PLAN);

    fs.writeFileSync(planPath, baselinePlan('{ additions: 4, deletions: 0 }'), 'utf8');
    const approved = await useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root });
    assert.strictEqual(approved.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_APPROVAL);
  });

  test('ABG2: codeloop implement refuses before provisioning a worktree', async () => {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);

    const stateRepo = new MockStateRepository(sm.toSnapshot());
    const worktreeManager = new RecordingWorktreeManager(root);
    const executor = makeExecutor('{ additions: 4, deletions: 0 }\n');
    const useCase = new StartImplementationUseCase(
      stateRepo as any,
      new MockConfigRepository() as any,
      makePlanGenerator(planDir, planPath),
      undefined,
      undefined,
      worktreeManager as any,
      undefined,
      executor as any
    );

    await assert.rejects(
      () => useCase.execute({ issue: ISSUE, workspaceDir: root }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'planBaseline');
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(
      worktreeManager.createWorktreeCallCount,
      0,
      'a refused approval must not provision a worktree'
    );
    assert.ok(!fs.existsSync(path.join(root, '.worktrees')));
  });

  test('ABG4: a correct plan embedding a plan fixture in its smoke protocol is approvable', async () => {
    fs.writeFileSync(planPath, fencedSamplePlan(), 'utf8');

    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);

    const stateRepo = new MockStateRepository(sm.toSnapshot());
    const executor = makeExecutor('{ additions: 3, deletions: 0 }\n');
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath),
      undefined,
      executor
    );

    const approved = await useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root });

    assert.strictEqual(approved.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.saveCallCount, 1);
    assert.strictEqual(
      executor.calls.length,
      1,
      'the REAL evidence claim is measured; the fenced sample is never evidence'
    );
    assert.ok(
      executor.calls[0].command.includes('additions: 3'),
      'the measured command is the real claim, not the sample'
    );
  });

  test('ABG5: transition APPROVAL refuses a build-like plan and leaves the root build untouched', async () => {
    fs.writeFileSync(planPath, buildLikePlan(), 'utf8');
    const sentinelPath = path.join(root, 'dist', 'sentinel');
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, 'pristine\n', 'utf8');

    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);

    const stateRepo = new MockStateRepository(sm.toSnapshot());
    const executor = makeExecutor('built\n');
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath),
      undefined,
      executor
    );

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('root-build-claim'), err.message);
        assert.ok(err.message.includes('npm run build'), err.message);
        assert.ok(err.message.includes('Never rebuild the repository root'), err.message);
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCallCount, 0, 'a refused approval must persist nothing');
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_PLAN);
    assert.strictEqual(executor.calls.length, 0, 'a build-like claim must not execute');
    assert.strictEqual(fs.readFileSync(sentinelPath, 'utf8'), 'pristine\n');
  });

  test('ABG3: --dry-run warns, does not execute the command, and does not save', async () => {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);

    const stateRepo = new MockStateRepository(sm.toSnapshot());
    const executor = makeExecutor('{ additions: 4, deletions: 0 }\n');
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath),
      undefined,
      executor
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: any) => {
      warnings.push(String(message));
    };
    try {
      await useCase.execute({
        targetStage: STAGE_APPROVAL,
        workspaceDir: root,
        dryRun: true
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.strictEqual(executor.calls.length, 0, 'a preview must not run plan code');
    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.ok(
      warnings.some((warning) => /planBaseline|baseline/i.test(warning)),
      warnings.join('\n')
    );
  });

  test('ABG6: both surfaces refuse a workspace-build-output claim identically', async () => {
    fs.writeFileSync(planPath, workspaceBuildOutputPlan(), 'utf8');
    const rootWorkspace = path.join(root, 'root-ws');
    const taskWorkspace = path.join(root, 'task-ws');
    fs.mkdirSync(path.join(rootWorkspace, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(rootWorkspace, 'dist', 'domain.js'),
      'module.exports = { SmokeProtocol: () => true };\n',
      'utf8'
    );
    fs.mkdirSync(taskWorkspace, { recursive: true });

    const expectRefusal = (label: string) => (err: any) => {
      assert.ok(err instanceof ValidationError, `${label}: expected ValidationError, got ${err}`);
      assert.strictEqual(err.field, 'planBaseline', label);
      assert.ok(err.message.includes('workspace-dist-claim'), `${label}: ${err.message}`);
      assert.ok(err.message.includes('./dist'), `${label}: ${err.message}`);
      assert.ok(err.message.includes('baseline-<issue>/dist'), `${label}: ${err.message}`);
      return true;
    };

    // Surface 1: transition APPROVAL, measuring in the operator workspace where
    // `dist/` genuinely exists. Pre-fix this surface ADMITTED the claim.
    const approvalMachine = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    approvalMachine.setPlanDir(planDir);
    approvalMachine.transition(STAGE_DISCOVERY);
    approvalMachine.transition(STAGE_PLAN);
    const approvalRepo = new MockStateRepository(approvalMachine.toSnapshot());
    const approvalExecutor = makeRecordingExecutor(new ProcessCommandExecutor());
    const transition = new TransitionStageUseCase(
      approvalRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath),
      undefined,
      approvalExecutor
    );

    await assert.rejects(
      () => transition.execute({ targetStage: STAGE_APPROVAL, workspaceDir: rootWorkspace }),
      expectRefusal('transition APPROVAL')
    );
    assert.strictEqual(approvalExecutor.calls.length, 0, 'a statically refused claim executes nothing');
    assert.strictEqual(approvalRepo.saveCallCount, 0, 'a refused approval persists nothing');

    // Surface 2: codeloop implement, measuring in the pristine task worktree.
    const implementMachine = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    implementMachine.setPlanDir(planDir);
    implementMachine.transition(STAGE_DISCOVERY);
    implementMachine.transition(STAGE_PLAN);
    implementMachine.transition(STAGE_APPROVAL);
    const implementRepo = new MockStateRepository(implementMachine.toSnapshot());
    const worktreeManager = new RecordingWorktreeManager(root);
    const implementExecutor = makeRecordingExecutor(new ProcessCommandExecutor());
    const implement = new StartImplementationUseCase(
      implementRepo as any,
      new MockConfigRepository() as any,
      makePlanGenerator(planDir, planPath),
      undefined,
      undefined,
      worktreeManager as any,
      undefined,
      implementExecutor as any
    );

    await assert.rejects(
      () => implement.execute({ issue: ISSUE, workspaceDir: taskWorkspace }),
      expectRefusal('codeloop implement')
    );
    assert.strictEqual(implementExecutor.calls.length, 0, 'a statically refused claim executes nothing');
    assert.strictEqual(implementRepo.saveCallCount, 0, 'a refused implement persists nothing');
    assert.strictEqual(
      worktreeManager.createWorktreeCallCount,
      0,
      'a refused implement must not provision a worktree'
    );
  });

  test('ABG7: each surface names the cwd IT measured in', async () => {
    fs.writeFileSync(planPath, failingPlan(), 'utf8');
    const rootWorkspace = path.join(root, 'root-ws');
    const taskWorkspace = path.join(root, 'task-ws');
    fs.mkdirSync(rootWorkspace, { recursive: true });
    fs.mkdirSync(taskWorkspace, { recursive: true });

    const approvalMachine = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    approvalMachine.setPlanDir(planDir);
    approvalMachine.transition(STAGE_DISCOVERY);
    approvalMachine.transition(STAGE_PLAN);
    const approvalRepo = new MockStateRepository(approvalMachine.toSnapshot());
    const approvalExecutor = makeRecordingExecutor(new ProcessCommandExecutor());
    const transition = new TransitionStageUseCase(
      approvalRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath),
      undefined,
      approvalExecutor
    );

    await assert.rejects(
      () => transition.execute({ targetStage: STAGE_APPROVAL, workspaceDir: rootWorkspace }),
      (err: any) => {
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('failing-claim'), err.message);
        assert.ok(err.message.includes(`cwd=${rootWorkspace}`), err.message);
        assert.ok(err.message.includes('exited 3'), err.message);
        assert.strictEqual(
          err.message.includes(`cwd=${taskWorkspace}`),
          false,
          'the approval refusal must name the directory it measured in, not the worktree'
        );
        return true;
      }
    );
    assert.strictEqual(approvalExecutor.calls.length, 1, 'the failing claim is measured once');

    const implementMachine = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    implementMachine.setPlanDir(planDir);
    implementMachine.transition(STAGE_DISCOVERY);
    implementMachine.transition(STAGE_PLAN);
    implementMachine.transition(STAGE_APPROVAL);
    const implementRepo = new MockStateRepository(implementMachine.toSnapshot());
    const worktreeManager = new RecordingWorktreeManager(root);
    const implementExecutor = makeRecordingExecutor(new ProcessCommandExecutor());
    const implement = new StartImplementationUseCase(
      implementRepo as any,
      new MockConfigRepository() as any,
      makePlanGenerator(planDir, planPath),
      undefined,
      undefined,
      worktreeManager as any,
      undefined,
      implementExecutor as any
    );

    await assert.rejects(
      () => implement.execute({ issue: ISSUE, workspaceDir: taskWorkspace }),
      (err: any) => {
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('failing-claim'), err.message);
        assert.ok(err.message.includes(`cwd=${taskWorkspace}`), err.message);
        assert.ok(err.message.includes('exited 3'), err.message);
        assert.strictEqual(
          err.message.includes(`cwd=${rootWorkspace}`),
          false,
          'the implement refusal must name the directory it measured in, not the root'
        );
        return true;
      }
    );
    assert.strictEqual(implementExecutor.calls.length, 1, 'the failing claim is measured once');
  });
});
