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
  GateResultReport,
  resolveGateRound,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
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

  /**
   * A round-matching gate report filed for this checkpoint (issue #327). The
   * round is COMPUTED from the history, never a literal: the ingest side reads
   * `resolveGateRound(sm.history)` and a hardcoded round would make this suite
   * silently evidence-free.
   */
  function filedReport(machine: any, verdict = 'PASSED'): any {
    const round = resolveGateRound(machine.history);
    return GateResultReport.fromJSON(
      {
        verdict,
        buildSystem: 'node',
        buildStatus: verdict,
        testsStatus: `${verdict} (3 passed)`,
        testsPassed: 3,
        testsFailed: 0,
        durationMs: 1000,
        executedCommands: ['npm test'],
        smokeProtocol: 'NOT_DECLARED',
        notRun: [],
        gateRound: round
      },
      round
    );
  }

  function gateRepoWith(machine: any): any {
    const reports = new Map<string, any>([['16', filedReport(machine)]]);
    return {
      reports,
      clears: 0,
      load(issue: any) {
        return reports.get(String(issue)) ?? null;
      },
      save(issue: any, report: any) {
        reports.set(String(issue), report);
        return `/fake/${issue}.gate.json`;
      },
      clear(issue: any) {
        this.clears += 1;
        reports.delete(String(issue));
      }
    };
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
    const useCase = new TransitionStageUseCase(
      stateRepo,
      undefined,
      undefined,
      planGenerator(),
      gateRepoWith(machine)
    );

    const result = await useCase.execute({
      targetStage: 'REVIEW',
      issue: 16,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.currentStage, 'REVIEW');
    assert.strictEqual(stateRepo.savedSnapshot?.currentStage, 'REVIEW');
    assert.strictEqual(result.history[result.history.length - 1].metadata.gateVerdict, 'PASSED');
  });

  test('TS-D3: a plan edited after approval refuses QUALITY_GATE -> REVIEW and persists nothing', async () => {
    const machine = machineAt('QUALITY_GATE');
    machine.recordApprovedPlan(planPath, 'digest:the-approved-bytes');
    const stateRepo = new MockStateRepo(machine.toSnapshot());
    // Round-matching evidence, so the DIGEST check is what refuses: the
    // evidence gate runs first and would otherwise mask this rule.
    const useCase = new TransitionStageUseCase(
      stateRepo,
      undefined,
      undefined,
      planGenerator(),
      gateRepoWith(machine)
    );

    await assert.rejects(
      async () =>
        useCase.execute({ targetStage: 'REVIEW', issue: 16, workspaceDir: tempDir }),
      /changed during the quality gate/i
    );

    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(stateRepo.savedSnapshot?.currentStage, 'QUALITY_GATE');
  });

  test('TS-D4: a legacy checkpoint with no digest still transitions', async () => {
    const machine = machineAt('QUALITY_GATE');
    const stateRepo = new MockStateRepo(machine.toSnapshot());
    const useCase = new TransitionStageUseCase(
      stateRepo,
      undefined,
      undefined,
      planGenerator(),
      gateRepoWith(machine)
    );

    const result = await useCase.execute({
      targetStage: 'REVIEW',
      issue: 16,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.currentStage, 'REVIEW');
    assert.strictEqual(stateRepo.saveCallCount, 1);
  });

  test('TS-D5 (#327 AC-3): re-planning re-records the digest on the fresh-approval hop', async () => {
    const machine = machineAt('QUALITY_GATE');
    machine.recordApprovedPlan(planPath, `digest:${fs.readFileSync(planPath, 'utf8')}`);
    const stateRepo = new MockStateRepo(machine.toSnapshot());
    const useCase = new TransitionStageUseCase(stateRepo, undefined, undefined, planGenerator());

    // 1. Edit the plan: it is no longer the approved bytes.
    fs.writeFileSync(planPath, '# Plan\n\n## Steps\n- [ ] Step 1 (edited)\n', 'utf8');

    // 2. The documented recovery, executed hop by hop.
    await useCase.execute({ targetStage: STAGE_PLAN, issue: 16, workspaceDir: tempDir });
    await useCase.execute({ targetStage: STAGE_APPROVAL, issue: 16, workspaceDir: tempDir });
    await useCase.execute({
      targetStage: STAGE_IMPLEMENT,
      issue: 16,
      workspaceDir: tempDir,
      noWorktree: true
    });

    const reApproved = `digest:${fs.readFileSync(planPath, 'utf8')}`;
    assert.strictEqual(
      stateRepo.savedSnapshot?.approvedPlanDigest,
      reApproved,
      'the fresh-approval hop must record the EDITED bytes'
    );

    // 3. The next gate exit succeeds with same-round evidence.
    await useCase.execute({ targetStage: STAGE_QUALITY_GATE, issue: 16, workspaceDir: tempDir });
    const round = resolveGateRound(stateRepo.savedSnapshot?.history);
    const repo = {
      reports: new Map(),
      load: () => null,
      save: () => '',
      clear: () => undefined
    } as any;
    repo.load = () =>
      GateResultReport.fromJSON(
        {
          verdict: 'PASSED',
          buildSystem: 'node',
          buildStatus: 'PASSED',
          testsStatus: 'PASSED (3 passed)',
          testsPassed: 3,
          testsFailed: 0,
          durationMs: 1000,
          executedCommands: ['npm test'],
          smokeProtocol: 'NOT_DECLARED',
          notRun: [],
          gateRound: round
        },
        round
      );
    const reviewing = new TransitionStageUseCase(
      stateRepo,
      undefined,
      undefined,
      planGenerator(),
      repo
    );

    const result = await reviewing.execute({
      targetStage: STAGE_REVIEW,
      issue: 16,
      workspaceDir: tempDir
    });
    assert.strictEqual(result.currentStage, STAGE_REVIEW);
  });

  test('TS-D6 (#327 AC-3): QUALITY_GATE -> PLAN is executable and -> REVIEW without evidence refuses', async () => {
    const machine = machineAt('QUALITY_GATE');
    const stateRepo = new MockStateRepo(machine.toSnapshot());
    const useCase = new TransitionStageUseCase(stateRepo, undefined, undefined, planGenerator());

    await assert.rejects(
      async () =>
        useCase.execute({ targetStage: STAGE_REVIEW, issue: 16, workspaceDir: tempDir }),
      /Gate evidence refused/,
      'a certification exit must not consume nothing'
    );
    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(stateRepo.savedSnapshot?.currentStage, STAGE_QUALITY_GATE);

    const replanned = await useCase.execute({
      targetStage: STAGE_PLAN,
      issue: 16,
      workspaceDir: tempDir
    });
    assert.strictEqual(replanned.currentStage, STAGE_PLAN);
  });

  test('TS-D7 (#348 R5): a retry QUALITY_GATE -> IMPLEMENT is not refused and keeps the digest', async () => {
    fs.writeFileSync(
      planPath,
      [
        '# Plan',
        '',
        '## 5. Quality Gate Targets',
        '',
        '- `git diff --exit-code -- package-lock.json`',
        ''
      ].join('\n'),
      'utf8'
    );
    const digest = `digest:${fs.readFileSync(planPath, 'utf8')}`;
    const machine = machineAt('QUALITY_GATE');
    machine.recordApprovedPlan(planPath, digest);
    const stateRepo = new MockStateRepo(machine.toSnapshot());
    const useCase = new TransitionStageUseCase(stateRepo, undefined, undefined, planGenerator());

    const result = await useCase.execute({
      targetStage: STAGE_IMPLEMENT,
      issue: 16,
      workspaceDir: tempDir,
      noWorktree: true
    });

    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(
      result.approvedPlanDigest,
      digest,
      'a self-correction retry must not re-bless edited bytes'
    );
    assert.strictEqual(stateRepo.saveCallCount, 1);
  });
});

/**
 * Issue #301 (P10) — the checkpoint guard precedes artifact writes.
 *
 * A refused save must leave the tree byte-identical and exit non-zero; a
 * successful save scatters the DISCOVERY plan directory AFTER it, and records
 * the adopted directory.
 */
describe('TransitionStageUseCase save-before-scaffold (#301)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-transition-301-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function snapshotAtDiscovery(): StateMachineSnapshot {
    const sm = StateMachine.createInitial({ issue: 906, mode: MODE_STANDARD });
    sm.transition(STAGE_DISCOVERY);
    sm.setPlanDir('/fake/plans/906-task-plan');
    return sm.toSnapshot();
  }

  function recordingGenerator(calls: any[]): any {
    return {
      scaffoldPlanDirectory: (params: any) => {
        calls.push(params);
        return {
          planDir: '/fake/plans/906-task-plan',
          folderName: '906-task-plan',
          planPath: '/fake/plans/906-task-plan/[Discovery] - Task Plan.md',
          summaryPath: '/fake/plans/906-task-plan/CodeLoop Summary.md',
          type: 'discovery',
          directoryCreated: true,
          filesCreated: true,
          adoptedExisting: false
        };
      },
      resolvePlanFile: () => null,
      updateSummaryLog: () => true
    };
  }

  test('N-6 / AC-7: a refused save writes no plan artifacts', async () => {
    const { StateStorageError } = require('../../dist/domain');
    const failingRepo = new (class extends MockStateRepo {
      async save(): Promise<void> {
        throw new StateStorageError('/repo/.agyloop/tasks/906.json', 'save', 'refused by the fixture');
      }
    })(null);
    // Start at INITIALIZED so DISCOVERY is the legal target.
    failingRepo.savedSnapshot = StateMachine.createInitial({ issue: 906, mode: MODE_STANDARD }).toSnapshot();
    const calls: any[] = [];
    const useCase = new TransitionStageUseCase(
      failingRepo,
      undefined,
      undefined,
      recordingGenerator(calls)
    );

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_DISCOVERY, workspaceDir: tempDir }),
      (err: any) => err instanceof StateStorageError
    );
    assert.strictEqual(calls.length, 0, 'a refused save must scaffold nothing');
  });

  test('N-7 / AC-7: the success path still scaffolds and records planDir', async () => {
    const stateRepo = new MockStateRepo(
      StateMachine.createInitial({ issue: 906, mode: MODE_STANDARD }).toSnapshot()
    );
    const calls: any[] = [];
    const useCase = new TransitionStageUseCase(
      stateRepo,
      undefined,
      undefined,
      recordingGenerator(calls)
    );

    const sm = await useCase.execute({ targetStage: STAGE_DISCOVERY, workspaceDir: tempDir });

    assert.strictEqual(sm.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(calls.length, 1, 'the DISCOVERY scaffold must still run');
    assert.strictEqual(sm.planDir, '/fake/plans/906-task-plan');
    assert.strictEqual(stateRepo.saveCallCount, 2, 'one save for the stage, one for the adopted planDir');
    assert.strictEqual(stateRepo.savedSnapshot!.planDir, '/fake/plans/906-task-plan');
  });
});
