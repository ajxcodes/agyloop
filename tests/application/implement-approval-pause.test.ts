/**
 * agyloop - `implement` consumes the APPROVAL pause it answers (issue #367)
 *
 * `codeloop implement` advanced APPROVAL -> IMPLEMENT but left
 * `pausedAtGate: 'APPROVAL'` on the saved checkpoint, because
 * `StateMachine.transition` deliberately preserves a pause at any human-wait
 * gate. `codeloop next --json` then reported `actionable: false` with a pause
 * whose message named the very command the operator had just run, so a driver
 * following `next` could not dispatch the implementer. The other documented
 * entry point (`codeloop transition IMPLEMENT`) calls `resumeFromGate()`
 * unconditionally (issue #362), so the two disagreed.
 *
 * IP1 - `implement` consumes the pause and banks the wait
 * IP2 - `implement` and `transition IMPLEMENT` converge on the same shape
 * IP3 - `--dry-run` writes nothing and changes no accounting
 * IP4 - a refusal (missing plan) leaves the on-disk pause intact
 * IP5 - a second `implement` at IMPLEMENT banks nothing twice
 * IP6 - the saved checkpoint makes `next` immediately actionable
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { StartImplementationUseCase, TransitionStageUseCase, GetNextActionUseCase } =
  require('../../dist/application');
const {
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  MODE_STANDARD,
  ROLE_IMPLEMENTER,
  NOTE_DEVELOPER_APPROVED,
  ValidationError,
  DEFAULT_GATE_TIMEOUT_SECONDS
} = require('../../dist/domain');

import type {
  StateRepository,
  ConfigRepository,
  AgyLoopConfig,
  PlanGeneratorPort
} from '../../src/ports';
import type { StateMachineSnapshot } from '../../src/domain';

const NOW = '2026-10-29T00:00:00.000Z';
const PLAN_DIR = '/repo/artifacts/plans/354-probe';
const PLAN_PATH = `${PLAN_DIR}/implementation_plan.md`;
const PLAN_CONTENT = [
  '# Plan',
  '',
  '## 3. Implementation Steps',
  '',
  '- [ ] Step 1: consume the APPROVAL pause on IMPLEMENT entry',
  '',
  '### Quality Gate Targets',
  '',
  '- `npm run build`',
  ''
].join('\n');

class MockStateRepository implements StateRepository {
  public snapshot: StateMachineSnapshot | null = null;
  public saveCallCount = 0;

  constructor(initial: StateMachineSnapshot | null = null) {
    this.snapshot = initial;
  }

  public async load(): Promise<StateMachineSnapshot | null> {
    return this.snapshot;
  }

  public async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.saveCallCount += 1;
    this.snapshot = snapshot;
  }

  public async reset(): Promise<void> {
    this.snapshot = null;
  }

  public getStateFilePath(): string {
    return '/repo/.agyloop/tasks/354.json';
  }
}

class MockConfigRepository implements ConfigRepository {
  private readonly config: AgyLoopConfig = {
    models: {
      planner: 'pro',
      implementer: 'inherit',
      gate: 'flash_lite',
      reviewer: 'flash'
    },
    options: {
      commitAfter: false,
      gateTimeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
      autoApproveInYolo: true,
      enableMcpInPlanner: true
    }
  };

  public loadConfig(): AgyLoopConfig {
    return this.config;
  }

  public resolveModel(role: string) {
    return {
      role,
      configured: this.config.models[role] || 'inherit',
      tier: 'flash' as any,
      apiModel: 'flash'
    };
  }

  public mapModelToTier() {
    return 'flash' as any;
  }
}

class StubPlanGenerator implements PlanGeneratorPort {
  public returnNull = false;

  public scaffoldPlanDirectory(): any {
    throw new Error('not used');
  }

  public generatePlan(): any {
    throw new Error('not used');
  }

  public generateSummaryLog(): any {
    throw new Error('not used');
  }

  public updateSummaryLog(): boolean {
    return true;
  }

  public findPlanDirectory(): string | null {
    return this.returnNull ? null : PLAN_DIR;
  }

  public resolvePlanFile(): any {
    if (this.returnNull) return null;
    return {
      planDir: PLAN_DIR,
      planPath: PLAN_PATH,
      planFileName: 'implementation_plan.md',
      summaryPath: `${PLAN_DIR}/AgyLoop Summary.md`
    };
  }

  public readPlanDocument(): string {
    return PLAN_CONTENT;
  }

  public hashPlanDocument(): string {
    return 'digest-354';
  }
}

/** An APPROVAL-parked checkpoint whose pause was taken 60s ago. */
function seedApprovalPaused(overrides: Record<string, unknown> = {}): StateMachineSnapshot {
  return {
    version: '1.0.0',
    currentStage: STAGE_APPROVAL,
    mode: MODE_STANDARD,
    issue: 354,
    baseBranch: 'main',
    planDir: PLAN_DIR,
    // Present so the saved snapshot is a dispatchable IMPLEMENT checkpoint for
    // IP6 (`next` refuses to dispatch without a worktree).
    worktree: {
      taskId: '354',
      worktreePath: '/repo/.worktrees/354',
      branch: 'task/354',
      baseBranch: 'main',
      isIsolated: true
    },
    createdAt: NOW,
    updatedAt: NOW,
    history: [{ stage: STAGE_APPROVAL, timestamp: NOW }],
    pausedAtGate: 'APPROVAL',
    pausedAtTimestamp: new Date(Date.now() - 60_000).toISOString(),
    totalHumanWaitMs: 1_000,
    ...overrides
  } as unknown as StateMachineSnapshot;
}

const CLEAN_DIFF: any = {
  hasChanges: false,
  baseRef: 'main',
  trackedChangedFiles: [],
  untrackedFiles: [],
  probeError: null,
  measurementError: null,
  rawStatus: ''
};

class FakeProbe {
  public readonly result: any;

  constructor(result: any = CLEAN_DIFF) {
    this.result = result;
  }

  public async execute(): Promise<any> {
    return this.result;
  }
}

function makeImplementationUseCase(stateRepo: MockStateRepository, plan: StubPlanGenerator) {
  return new StartImplementationUseCase(stateRepo, new MockConfigRepository(), plan);
}

describe('`implement` consumes the APPROVAL pause it answers (issue #367)', () => {
  test('IP1: implement consumes the pause and banks the wait', async () => {
    const stateRepo = new MockStateRepository(seedApprovalPaused());
    const useCase = makeImplementationUseCase(stateRepo, new StubPlanGenerator());

    const result = await useCase.execute({ issue: 354, workspaceDir: '/repo' });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(stateRepo.saveCallCount, 1, 'the checkpoint is saved exactly once');

    const saved = stateRepo.snapshot!;
    assert.strictEqual(saved.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(saved.pausedAtGate, null, 'the APPROVAL pause is consumed');
    assert.strictEqual(saved.pausedAtTimestamp, null);
    assert.ok(
      saved.totalHumanWaitMs! > 1_000,
      `the wait must be banked, got ${saved.totalHumanWaitMs}`
    );

    const last = saved.history[saved.history.length - 1];
    assert.strictEqual(last.stage, STAGE_IMPLEMENT);
    assert.strictEqual(last.metadata?.note, NOTE_DEVELOPER_APPROVED);
  });

  test('IP2: implement and transition IMPLEMENT converge on the same checkpoint shape', async () => {
    const implementRepo = new MockStateRepository(seedApprovalPaused());
    await makeImplementationUseCase(implementRepo, new StubPlanGenerator()).execute({
      issue: 354,
      workspaceDir: '/repo'
    });
    const viaImplement = implementRepo.snapshot!;

    const transitionRepo = new MockStateRepository(seedApprovalPaused());
    const transition = new TransitionStageUseCase(transitionRepo);
    await transition.execute({
      targetStage: STAGE_IMPLEMENT,
      issue: 354,
      workspaceDir: '/repo',
      noWorktree: true
    });
    const viaTransition = transitionRepo.snapshot!;

    for (const key of ['currentStage', 'pausedAtGate', 'pausedAtTimestamp'] as const) {
      assert.strictEqual(
        viaImplement[key],
        viaTransition[key],
        `${key} must agree between the two entry points`
      );
    }
    assert.strictEqual(viaImplement.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(viaImplement.pausedAtGate, null);
    // Wall-clock elapsed differs between the two runs, so only the direction is
    // asserted — never the totals against each other.
    assert.ok(viaImplement.totalHumanWaitMs! > 1_000);
    assert.ok(viaTransition.totalHumanWaitMs! > 1_000);
  });

  test('IP3: implement --dry-run writes nothing and changes no accounting', async () => {
    const seeded = seedApprovalPaused();
    const stateRepo = new MockStateRepository(seeded);
    const useCase = makeImplementationUseCase(stateRepo, new StubPlanGenerator());

    const result = await useCase.execute({ issue: 354, workspaceDir: '/repo', dryRun: true });

    assert.strictEqual(stateRepo.saveCallCount, 0, '--dry-run must never persist');
    assert.strictEqual(stateRepo.snapshot!.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.snapshot!.pausedAtGate, 'APPROVAL');
    assert.strictEqual(stateRepo.snapshot!.totalHumanWaitMs, seeded.totalHumanWaitMs);
    // The prediction is allowed to differ from disk.
    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
  });

  test('IP4: a refusal keeps the pause on disk', async () => {
    const seeded = seedApprovalPaused();
    const stateRepo = new MockStateRepository(seeded);
    const plan = new StubPlanGenerator();
    plan.returnNull = true;
    const useCase = makeImplementationUseCase(stateRepo, plan);

    await assert.rejects(
      () => useCase.execute({ issue: 354, workspaceDir: '/repo' }),
      (err: any) => err instanceof ValidationError
    );

    assert.strictEqual(stateRepo.saveCallCount, 0, 'a refusal must not persist');
    assert.strictEqual(stateRepo.snapshot!.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.snapshot!.pausedAtGate, 'APPROVAL');
    assert.strictEqual(stateRepo.snapshot!.pausedAtTimestamp, seeded.pausedAtTimestamp);
  });

  test('IP5: a second implement at IMPLEMENT banks nothing twice', async () => {
    const stateRepo = new MockStateRepository(seedApprovalPaused());
    const plan = new StubPlanGenerator();
    const useCase = makeImplementationUseCase(stateRepo, plan);

    await useCase.execute({ issue: 354, workspaceDir: '/repo' });
    const firstTotal = stateRepo.snapshot!.totalHumanWaitMs!;

    const second = await useCase.execute({ issue: 354, workspaceDir: '/repo' });

    assert.strictEqual(second.resumed, true);
    assert.strictEqual(
      stateRepo.snapshot!.totalHumanWaitMs,
      firstTotal,
      'no pause means nothing to bank'
    );
  });

  test('IP6: the saved checkpoint makes `next` actionable for the implementer', async () => {
    const stateRepo = new MockStateRepository(seedApprovalPaused());
    await makeImplementationUseCase(stateRepo, new StubPlanGenerator()).execute({
      issue: 354,
      workspaceDir: '/repo'
    });

    const nextRepo = new MockStateRepository(stateRepo.snapshot);
    const next = new GetNextActionUseCase(
      nextRepo,
      new MockConfigRepository(),
      new StubPlanGenerator(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new FakeProbe()
    );

    const result = await next.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    // `actionable` and `pause` are the CLI's projection of exactly these two
    // facts (cli.ts: `actionable = persistedPause === null &&
    // res.actionType === 'subagent'`); the use case does not carry them. IP7
    // asserts the projected `actionable: true` / `pause: null` end-to-end.
    assert.strictEqual(result.actionType, 'subagent', 'the implementer must be dispatchable');
    assert.ok(result.invocationPayload, 'a dispatchable directive carries its payload');
    assert.strictEqual(
      nextRepo.snapshot!.pausedAtGate,
      null,
      'the saved checkpoint must not carry a pause'
    );
    assert.strictEqual(result.role, ROLE_IMPLEMENTER);
  });
});
