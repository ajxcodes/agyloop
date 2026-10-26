/**
 * agyloop - TransitionStageUseCase Side-Effect Ordering Tests
 *
 * THE BUG guarded here (#226): the IMPLEMENT worktree guardrail ran BEFORE
 * `sm.transition(...)`, which is the single thrower of `InvalidTransitionError`
 * (`state-machine.ts`). A rejected target therefore provisioned a real
 * `.worktrees/<id>` and branch on disk and then threw — leaving an orphan with
 * no checkpoint ever referencing it. Legality is now decided first, so a
 * rejected transition is a genuine no-op.
 *
 * The sibling defect is the same guardrail's treatment of `dryRun`: the
 * checkpoint save was gated on `!params.dryRun` but the worktree provisioning
 * was not, so `transition --dry-run IMPLEMENT` wrote a worktree and no state.
 *
 * Preamble idioms (`MockStateRepo`, `makeMockWorktree`, `makeMockConfig`,
 * `makeMockPlanGenerator`) are copied from
 * `tests/application/worktree-guardrails.test.ts` — that file's helpers are
 * module-private, so they cannot be shared.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TransitionStageUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  MODE_STANDARD,
  MODE_PLAN,
  InvalidTransitionError,
  PreFlightHaltError,
  WorktreeDescriptor
} = require('../../dist/domain');

import type {
  StateRepository,
  WorktreeManagerPort,
  CreateWorktreeOptions
} from '../../src/ports';
import type { StateMachineSnapshot } from '../../src/domain';

class MockStateRepo implements StateRepository {
  public savedSnapshot: StateMachineSnapshot | null = null;
  public saveCallCount = 0;

  constructor(initial: StateMachineSnapshot | null = null) {
    this.savedSnapshot = initial;
  }

  async load(): Promise<StateMachineSnapshot | null> {
    return this.savedSnapshot;
  }

  async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.saveCallCount++;
    this.savedSnapshot = snapshot;
  }

  async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  getStateFilePath(): string {
    return '/repo/.agyloop/state.json';
  }
}

/** Records the side effects a provisioning attempt would have produced. */
interface WorktreeRecorder {
  createWorktreeCalls: number;
  branches: string[];
}

/**
 * A `WorktreeManagerPort` double that COUNTS `createWorktree` calls AND really
 * `mkdir`s the directory and branch it reports. Without the mkdir, "no worktree
 * was created" would only be a statement about a stub.
 */
function makeRecordingWorktreeManager(
  root: string,
  recorder: WorktreeRecorder,
  overrides: Partial<WorktreeManagerPort> = {}
): WorktreeManagerPort {
  return {
    resolveTaskWorktreePath: async (_dir: string, taskId: string | number) =>
      path.join(root, '.worktrees', String(taskId)),
    resolveTaskBranchName: (taskId: string | number) => `task/${taskId}`,
    ensureGitIgnore: async () => false,
    resolveBaseBranch: async () => 'main',
    createWorktree: async (opts: CreateWorktreeOptions) => {
      recorder.createWorktreeCalls++;
      const worktreePath = path.join(root, '.worktrees', String(opts.taskId));
      fs.mkdirSync(worktreePath, { recursive: true });
      const branch = `task/${opts.taskId}`;
      recorder.branches.push(branch);
      return WorktreeDescriptor.create({
        taskId: opts.taskId,
        worktreePath,
        branch,
        baseBranch: opts.baseBranch || 'main',
        createdAt: new Date().toISOString()
      });
    },
    removeWorktree: async () => {},
    pruneWorktrees: async () => {},
    listWorktrees: async () => [],
    cleanOrphanedWorktrees: async () => 0,
    listBranches: async () => ['main', ...recorder.branches],
    createBranch: async () => {},
    isAncestor: async () => false,
    getCommitsBetween: async () => [],
    pushBranch: async () => true,
    ...overrides
  };
}

function makeMockPlanGenerator() {
  return {
    resolvePlanFile: () => null,
    updateSummaryLog: () => true
  };
}

describe('TransitionStageUseCase side-effect ordering (#226)', () => {
  let tempDir: string;
  let recorder: WorktreeRecorder;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-transition-test-'));
    recorder = { createWorktreeCalls: 0, branches: [] };
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  /** Snapshots a machine parked at `stage`, driven by real transitions. */
  function snapshotAt(stage: string, mode: string = MODE_STANDARD): StateMachineSnapshot {
    const sm = StateMachine.createInitial({ issue: null, mode: mode as any });
    const route: Record<string, string[]> = {
      [STAGE_INITIALIZED]: [],
      [STAGE_DISCOVERY]: [STAGE_DISCOVERY],
      [STAGE_PLAN]: [STAGE_DISCOVERY, STAGE_PLAN],
      [STAGE_APPROVAL]: [STAGE_DISCOVERY, STAGE_PLAN, STAGE_APPROVAL]
    };
    for (const step of route[stage] || []) {
      sm.transition(step);
    }
    assert.strictEqual(sm.currentStage, stage, `fixture must actually be parked at ${stage}`);
    return sm.toSnapshot();
  }

  test('a REJECTED transition creates no worktree directory, no branch, and no checkpoint (#226)', async () => {
    // PLAN -> IMPLEMENT is legal only in YOLO; in `plan` mode it is rejected.
    const stateRepo = new MockStateRepo(snapshotAt(STAGE_PLAN, MODE_PLAN));
    const worktreeManager = makeRecordingWorktreeManager(tempDir, recorder);
    const useCase = new TransitionStageUseCase(
      stateRepo,
      worktreeManager,
      undefined,
      makeMockPlanGenerator() as any
    );

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_IMPLEMENT, workspaceDir: tempDir }),
      (err: unknown) => {
        assert.ok(
          err instanceof InvalidTransitionError,
          `expected InvalidTransitionError, got ${err}`
        );
        assert.match(
          (err as Error).message,
          /Invalid lifecycle transition/,
          'the reorder must not change the error contract'
        );
        return true;
      }
    );

    assert.strictEqual(recorder.createWorktreeCalls, 0, 'a rejected transition must not provision');
    assert.deepStrictEqual(recorder.branches, [], 'a rejected transition must not create a branch');
    assert.ok(
      !fs.existsSync(path.join(tempDir, '.worktrees')),
      'no worktree directory may exist after a rejected transition'
    );
    assert.strictEqual(stateRepo.saveCallCount, 0, 'a rejected transition must not checkpoint');
  });

  test('a REJECTED transition from INITIALIZED also provisions nothing', async () => {
    const stateRepo = new MockStateRepo(snapshotAt(STAGE_INITIALIZED));
    const worktreeManager = makeRecordingWorktreeManager(tempDir, recorder);
    const useCase = new TransitionStageUseCase(stateRepo, worktreeManager);

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_IMPLEMENT, workspaceDir: tempDir }),
      (err: unknown) => err instanceof InvalidTransitionError
    );

    assert.strictEqual(recorder.createWorktreeCalls, 0);
    assert.deepStrictEqual(recorder.branches, []);
    assert.ok(!fs.existsSync(path.join(tempDir, '.worktrees')));
    assert.strictEqual(stateRepo.saveCallCount, 0);
  });

  test('a LEGAL transition into IMPLEMENT still provisions exactly one worktree (control)', async () => {
    const stateRepo = new MockStateRepo(snapshotAt(STAGE_APPROVAL));
    const worktreeManager = makeRecordingWorktreeManager(tempDir, recorder);
    const useCase = new TransitionStageUseCase(stateRepo, worktreeManager);

    const sm = await useCase.execute({ targetStage: STAGE_IMPLEMENT, workspaceDir: tempDir });

    assert.strictEqual(sm.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(recorder.createWorktreeCalls, 1);
    assert.deepStrictEqual(recorder.branches, ['task/adhoc']);
    assert.ok(fs.existsSync(path.join(tempDir, '.worktrees', 'adhoc')));
    assert.ok(sm.worktree, 'the machine must carry the descriptor it just provisioned');
    assert.strictEqual(sm.worktree!.branch, 'task/adhoc');
    assert.strictEqual(stateRepo.saveCallCount, 1, 'the checkpoint must still be written once');
    assert.strictEqual(stateRepo.savedSnapshot!.currentStage, STAGE_IMPLEMENT);
  });

  test('transition IMPLEMENT --dry-run provisions nothing and writes no checkpoint', async () => {
    const stateRepo = new MockStateRepo(snapshotAt(STAGE_APPROVAL));
    const worktreeManager = makeRecordingWorktreeManager(tempDir, recorder);
    const useCase = new TransitionStageUseCase(stateRepo, worktreeManager);

    const sm = await useCase.execute({
      targetStage: STAGE_IMPLEMENT,
      workspaceDir: tempDir,
      dryRun: true
    });

    assert.strictEqual(sm.currentStage, STAGE_IMPLEMENT, 'the in-memory transition still happens');
    assert.strictEqual(recorder.createWorktreeCalls, 0);
    assert.deepStrictEqual(recorder.branches, []);
    assert.ok(!fs.existsSync(path.join(tempDir, '.worktrees')));
    assert.strictEqual(stateRepo.saveCallCount, 0);
  });

  test('--dry-run honours the flag at the use-case level for a non-IMPLEMENT target', async () => {
    // Proves `if (!params.dryRun)` is live independent of the CLI forwarding it.
    // APPROVAL is chosen because it is a legal, side-effect-free target that
    // does not need a plan directory and does not touch a worktree.
    const stateRepo = new MockStateRepo(snapshotAt(STAGE_PLAN));
    const useCase = new TransitionStageUseCase(stateRepo);

    const sm = await useCase.execute({ targetStage: STAGE_APPROVAL, dryRun: true });

    assert.strictEqual(sm.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.saveCallCount, 0);
  });

  test('the PLAN precondition still halts before any worktree work', async () => {
    const stateRepo = new MockStateRepo(snapshotAt(STAGE_DISCOVERY));
    const worktreeManager = makeRecordingWorktreeManager(tempDir, recorder);
    const useCase = new TransitionStageUseCase(stateRepo, worktreeManager);

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_PLAN, workspaceDir: tempDir }),
      (err: unknown) => err instanceof PreFlightHaltError
    );

    assert.strictEqual(recorder.createWorktreeCalls, 0);
    assert.ok(!fs.existsSync(path.join(tempDir, '.worktrees')));
    assert.strictEqual(stateRepo.saveCallCount, 0);
  });
});
describe('TransitionStageUseCase - approved plan immutability (issue #298)', () => {
  let tempDir: string;
  let planDir: string;
  let planPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-transition-digest-'));
    planDir = path.join(tempDir, 'artifacts/plans/16-task');
    fs.mkdirSync(planDir, { recursive: true });
    planPath = path.join(planDir, 'implementation_plan.md');
    fs.writeFileSync(planPath, '# Plan\n\n## Steps\n- [ ] Step 1\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function planGenerator(): any {
    return {
      resolvePlanFile: () => ({
        planDir,
        planPath,
        planFileName: 'implementation_plan.md'
      }),
      readPlanDocument: () => fs.readFileSync(planPath, 'utf8'),
      updateSummaryLog: () => true,
      hashPlanDocument: () => `digest:${fs.readFileSync(planPath, 'utf8')}`
    };
  }

  function machineAt(stage: string): any {
    const sm = StateMachine.createInitial({ issue: 16, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    const route: Record<string, string[]> = {
      [STAGE_PLAN]: [STAGE_DISCOVERY, STAGE_PLAN],
      [STAGE_APPROVAL]: [STAGE_DISCOVERY, STAGE_PLAN, STAGE_APPROVAL],
      [STAGE_IMPLEMENT]: [STAGE_DISCOVERY, STAGE_PLAN, STAGE_APPROVAL, STAGE_IMPLEMENT],
      'QUALITY_GATE': [STAGE_DISCOVERY, STAGE_PLAN, STAGE_APPROVAL, STAGE_IMPLEMENT, 'QUALITY_GATE']
    };
    for (const step of route[stage] || []) {
      sm.transition(step);
    }
    return sm;
  }

  test('TS-D1: entering IMPLEMENT from APPROVAL records the approved digest', async () => {
    const stateRepo = new MockStateRepo(machineAt(STAGE_APPROVAL).toSnapshot());
    const useCase = new TransitionStageUseCase(stateRepo, undefined, undefined, planGenerator());

    const result = await useCase.execute({
      targetStage: STAGE_IMPLEMENT,
      issue: 16,
      workspaceDir: tempDir,
      noWorktree: true
    });

    const expected = `digest:${fs.readFileSync(planPath, 'utf8')}`;
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.approvedPlanDigest, expected);
    assert.strictEqual(result.approvedPlanPath, planPath);
    assert.strictEqual(stateRepo.savedSnapshot?.approvedPlanDigest, expected);
  });

  test('TS-D2: QUALITY_GATE -> REVIEW succeeds while the digest still matches', async () => {
    const machine = machineAt('QUALITY_GATE');
    machine.recordApprovedPlan(planPath, `digest:${fs.readFileSync(planPath, 'utf8')}`);
    const stateRepo = new MockStateRepo(machine.toSnapshot());
    const useCase = new TransitionStageUseCase(stateRepo, undefined, undefined, planGenerator());

    const result = await useCase.execute({
      targetStage: 'REVIEW',
      issue: 16,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.currentStage, 'REVIEW');
    assert.strictEqual(stateRepo.savedSnapshot?.currentStage, 'REVIEW');
  });

  test('TS-D3: a plan edited after approval refuses QUALITY_GATE -> REVIEW and persists nothing', async () => {
    const machine = machineAt('QUALITY_GATE');
    machine.recordApprovedPlan(planPath, 'digest:the-approved-bytes');
    const stateRepo = new MockStateRepo(machine.toSnapshot());
    const useCase = new TransitionStageUseCase(stateRepo, undefined, undefined, planGenerator());

    await assert.rejects(
      async () =>
        useCase.execute({ targetStage: 'REVIEW', issue: 16, workspaceDir: tempDir }),
      /changed during the quality gate/i
    );

    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(stateRepo.savedSnapshot?.currentStage, 'QUALITY_GATE');
  });

  test('TS-D4: a legacy checkpoint with no digest still transitions', async () => {
    const stateRepo = new MockStateRepo(machineAt('QUALITY_GATE').toSnapshot());
    const useCase = new TransitionStageUseCase(stateRepo, undefined, undefined, planGenerator());

    const result = await useCase.execute({
      targetStage: 'REVIEW',
      issue: 16,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.currentStage, 'REVIEW');
    assert.strictEqual(stateRepo.saveCallCount, 1);
  });
});
