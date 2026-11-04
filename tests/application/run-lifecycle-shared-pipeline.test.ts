/**
 * agyloop - RunLifecycleUseCase shared pipeline tests (issue #441)
 *
 * The YOLO and standard modes historically carried two copies of every
 * stage-gate block. The refactor (issue #441, Steps 1-5) extracts those blocks
 * into shared private methods on `RunLifecycleUseCase`; these cases prove the
 * extracted pipeline PRESERVES the observable behaviour of both modes:
 *
 *   - TR-15: a configured `circuitBreakers.maxGateRetries` is honoured
 *     identically in YOLO and standard modes — one genuine gate failure at the
 *     limit trips the breaker in BOTH modes, and below the limit BOTH modes
 *     revert to IMPLEMENT without any breaker pause;
 *   - TR-16: the shared implementation-start leg keeps the one legitimate
 *     behavioural asymmetry — YOLO omits `userInstructions` from
 *     `StartImplementationUseCase`, standard mode forwards it.
 *
 * Issue #425: the gate-failure policy read uses the ACTIVE workspace as `cwd`
 * (`RL-425-1` pins `loadConfigCalls[0]?.cwd === SCOPED_WORKSPACE`); the mocks
 * here record `loadConfig` calls so the pin stays observable on the shared
 * helper's single read.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_COMMIT,
  MODE_STANDARD,
  MODE_YOLO,
  GATE_COMMIT,
  GATE_CIRCUIT_BREAKER,
  AiReviewReport,
  WorktreeDescriptor
} = require('../../dist/domain');

const { RunLifecycleUseCase } = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

const SCOPED_WORKSPACE = '/mock/workspace';

class MockStateRepository {
  public savedSnapshot: any = null;
  public saveCount = 0;

  constructor(initial: any = null) {
    this.savedSnapshot = initial;
  }

  public async load(): Promise<any> {
    return this.savedSnapshot;
  }

  public async save(snapshot: any): Promise<void> {
    this.saveCount++;
    this.savedSnapshot = snapshot;
  }

  public async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  public getStateFilePath(): string {
    return `${SCOPED_WORKSPACE}/.agyloop/state.json`;
  }
}

class MockConfigRepository {
  public config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  /** #425: the ACTIVE workspace must be the `cwd` of every policy read. */
  public loadConfigCalls: any[] = [];

  public loadConfig(params?: any): any {
    this.loadConfigCalls.push(params);
    return this.config;
  }

  public resolveModel(role: string): any {
    return { role, configured: 'default', tier: 'flash', apiModel: 'gemini-2.5-flash' };
  }

  public mapModelToTier(): string {
    return 'flash';
  }
}

class MockPlanGenerator {
  public planContent = '# Test Plan\n\n## Acceptance Criteria\n- [ ] Code compiles\n';

  public scaffoldPlanDirectory(params: any): any {
    return {
      folderName: '32-test-feature',
      planDir: `${SCOPED_WORKSPACE}/artifacts/plans/32-test-feature`,
      planPath: `${SCOPED_WORKSPACE}/artifacts/plans/32-test-feature/implementation-plan.md`,
      summaryPath: `${SCOPED_WORKSPACE}/artifacts/plans/32-test-feature/summary-log.md`,
      mirrorPath: null,
      type: 'implementation'
    };
  }

  public resolvePlanFile(): any {
    return {
      folderName: '32-test-feature',
      planDir: `${SCOPED_WORKSPACE}/artifacts/plans/32-test-feature`,
      planPath: `${SCOPED_WORKSPACE}/artifacts/plans/32-test-feature/implementation-plan.md`,
      summaryPath: `${SCOPED_WORKSPACE}/artifacts/plans/32-test-feature/summary-log.md`,
      mirrorPath: null,
      type: 'implementation'
    };
  }

  public readPlanDocument(): string {
    return this.planContent;
  }

  public updateSummaryLog(): boolean {
    return true;
  }
}

class MockGitHubGateway {
  public async getCurrentRepo(): Promise<string> {
    return 'ajxcodes/agyloop';
  }

  public async fetchIssue(num: number): Promise<any> {
    return {
      number: num,
      title: 'Shared pipeline behaviour preservation',
      body: 'Both modes must behave identically.',
      labels: ['feature']
    };
  }
}

class MockCommandExecutor {
  public executedCommands: string[] = [];

  public async execute(cmd: string): Promise<any> {
    this.executedCommands.push(cmd);

    if (cmd === 'git status --porcelain') {
      return {
        command: cmd,
        stdout: 'M  src/index.ts\n',
        stderr: '',
        exitCode: 0,
        durationMs: 10,
        timedOut: false
      };
    }

    if (cmd.includes('diff')) {
      return {
        command: cmd,
        stdout: 'diff --git a/src/index.ts b/src/index.ts\n+const x = 1;\n',
        stderr: '',
        exitCode: 0,
        durationMs: 15,
        timedOut: false
      };
    }

    if (cmd === 'git rev-parse HEAD') {
      return {
        command: cmd,
        stdout: 'abc1234\n',
        stderr: '',
        exitCode: 0,
        durationMs: 10,
        timedOut: false
      };
    }

    const stdout = 'ℹ tests 10\nℹ pass 10\nℹ fail 0\nBuild completed successfully';
    return {
      command: cmd,
      stdout,
      stderr: '',
      combinedOutput: stdout,
      exitCode: 0,
      durationMs: 50,
      timedOut: false
    };
  }
}

class MockBuildDetector {
  public detect(): any {
    return {
      ecosystem: 'node',
      hasBuild: true,
      hasTest: true,
      hasLint: false,
      hasTypecheck: true,
      commands: [
        { id: 'build', label: 'Build', command: 'npm run build' },
        { id: 'typecheck', label: 'Typecheck', command: 'npm run typecheck' },
        { id: 'test', label: 'Test', command: 'npm test' }
      ]
    };
  }

  public resolveCommands(): any[] {
    return [
      { id: 'build', label: 'Build', command: 'npm run build' },
      { id: 'typecheck', label: 'Typecheck', command: 'npm run typecheck' },
      { id: 'test', label: 'Test', command: 'npm test' }
    ];
  }
}

class MockStandardsRepository {
  public loadStandards(): string {
    return '# Repository Coding Standards\n\n1. Hexagonal boundaries.\n';
  }

  public findStandardsPath(): string {
    return `${SCOPED_WORKSPACE}/.github/critique.md`;
  }
}

class MockCritique {
  public async review(): Promise<any> {
    return AiReviewReport.parse(
      JSON.stringify({
        summary: 'All code meets requirements and standards.',
        confidenceLevel: 'High',
        confidenceExplanation: 'Clean diff with passing tests.',
        resolvedThreads: [],
        comments: []
      })
    );
  }
}

class MockWorktreeManager {
  public createWorktreeCallCount = 0;

  public async createWorktree(params: any): Promise<any> {
    this.createWorktreeCallCount++;
    return WorktreeDescriptor.create({
      taskId: params.taskId || 999,
      worktreePath: `${SCOPED_WORKSPACE}/.worktrees/${params.taskId || 999}`,
      branch: `task/${params.taskId || 999}`,
      baseBranch: params.baseBranch || 'main'
    });
  }

  public async removeWorktree(): Promise<void> {}

  public async resolveBaseBranch(): Promise<string> {
    return 'main';
  }
}

/**
 * A genuine (non-VACUOUS) gate failure, injected deterministically. Returns a
 * state machine reverted to IMPLEMENT with the counter intact — the same shape
 * the real `RunQualityGateUseCase` produces on a failing command.
 */
class FailingQualityGateUseCase {
  public calls: any[] = [];

  public async execute(params: any): Promise<any> {
    this.calls.push(params);
    const sm = StateMachine.fromSnapshot(stateRepo.savedSnapshot);
    return {
      passed: false,
      vacuous: false,
      currentStage: STAGE_IMPLEMENT,
      stateMachine: sm,
      reports: [],
      totalDurationMs: 0,
      summaryReport: 'Quality Gate : FAILED\n',
      buildStatus: 'FAILED',
      testsStatus: 'FAILED',
      gateReport: undefined,
      diagnosticSnippet: null,
      implementationDiff: params.implementationDiff
    };
  }
}

/**
 * A recording `StartImplementationUseCase`. The refactored
 * `startImplementationWithTeardownGuard` must forward the SAME params each
 * mode forwarded before the refactor — with the ONE deliberate asymmetry:
 * YOLO omits `userInstructions`, standard mode forwards it (TR-16).
 */
class RecordingStartImplementationUseCase {
  public capturedParams: any[] = [];

  public async execute(params: any): Promise<any> {
    this.capturedParams.push(params);
    const sm = StateMachine.fromSnapshot(stateRepo.savedSnapshot);
    sm.transition(STAGE_IMPLEMENT);
    // The real use case persists the transitioned checkpoint; the fake does the
    // same so the rest of the pipeline reads an IMPLEMENT checkpoint.
    await stateRepo.save(sm.toSnapshot());
    return { stateMachine: sm, resumed: false };
  }
}

let stateRepo: MockStateRepository;
let configRepo: MockConfigRepository;

function freshDeps(): any {
  stateRepo = new MockStateRepository();
  configRepo = new MockConfigRepository();
  return {
    stateRepo,
    configRepo,
    planGenerator: new MockPlanGenerator(),
    githubGateway: new MockGitHubGateway(),
    commandExecutor: new MockCommandExecutor(),
    buildDetector: new MockBuildDetector(),
    standardsRepo: new MockStandardsRepository(),
    critique: new MockCritique(),
    worktreeManager: new MockWorktreeManager()
  };
}

/**
 * Seeds a checkpoint at the stage whose leg can START implementation:
 * PLAN for YOLO, APPROVAL for standard (issue #441 fixture).
 */
function seedCheckpointAtImplementationLeg(mode: string, gateRetries = 0): void {
  const sm = StateMachine.createInitial({ mode, issue: 32 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  if (mode === MODE_STANDARD) {
    // The standard loop reaches the implementation leg through the APPROVAL gate.
    sm.transition(STAGE_APPROVAL);
  }
  stateRepo.savedSnapshot = { ...sm.toSnapshot(), implementToGateLoops: gateRetries };
}

/**
 * Seeds a checkpoint at IMPLEMENT — the IMPLEMENT -> QUALITY_GATE boundary the
 * breaker guard reads the retry counter at.
 */
function seedCheckpointAtImplement(mode: string, gateRetries = 0): void {
  const sm = StateMachine.createInitial({ mode, issue: 32 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  if (mode === MODE_STANDARD) {
    sm.transition(STAGE_APPROVAL);
  }
  sm.transition(STAGE_IMPLEMENT);
  stateRepo.savedSnapshot = { ...sm.toSnapshot(), implementToGateLoops: gateRetries };
}

describe('RunLifecycleUseCase shared pipeline (issue #441)', () => {
  beforeEach(() => {
    freshDeps();
  });

  test('TR-15 (AC1, AC6): a configured maxGateRetries is honoured identically in yolo and standard modes — a genuine gate failure at the limit trips the breaker in BOTH', async () => {
    for (const mode of [MODE_YOLO, MODE_STANDARD]) {
      const deps = freshDeps();
      // The configured limit is 1 and the counter is seeded AT the limit: a
      // genuine gate failure must trip the breaker in BOTH modes.
      (configRepo.config as any).circuitBreakers = {
        ...(configRepo.config as any).circuitBreakers,
        maxGateRetries: 1
      };

      const failingGate = new FailingQualityGateUseCase();
      const lifecycle = new RunLifecycleUseCase({ ...deps, runQualityGateUseCase: failingGate });

      seedCheckpointAtImplement(mode, 1);

      const result = await lifecycle.execute({
        mode,
        issue: 32,
        workspaceDir: SCOPED_WORKSPACE
      });

      assert.strictEqual(
        result.pausedAtGate,
        GATE_CIRCUIT_BREAKER,
        `${mode}: a genuine gate failure at the configured limit must trip the breaker, got: ${result.message}`
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(
        stateRepo.savedSnapshot?.pausedAtGate,
        GATE_CIRCUIT_BREAKER,
        `${mode}: the breaker pause must be persisted`
      );
      // The shared policy read comes from the ACTIVE workspace (#425).
      assert.strictEqual(
        configRepo.loadConfigCalls[0]?.cwd,
        SCOPED_WORKSPACE,
        `${mode}: the breaker policy must load with the active workspace as cwd`
      );
    }
  });

  test('TR-15 (AC1, AC6): below the configured maxGateRetries BOTH modes revert to IMPLEMENT with no breaker pause and no review', async () => {
    for (const mode of [MODE_YOLO, MODE_STANDARD]) {
      const deps = freshDeps();
      (configRepo.config as any).circuitBreakers = {
        ...(configRepo.config as any).circuitBreakers,
        maxGateRetries: 1
      };

      const failingGate = new FailingQualityGateUseCase();
      const lifecycle = new RunLifecycleUseCase({ ...deps, runQualityGateUseCase: failingGate });

      // The counter starts BELOW the configured limit (0 < 1).
      seedCheckpointAtImplement(mode, 0);

      const result = await lifecycle.execute({
        mode,
        issue: 32,
        workspaceDir: SCOPED_WORKSPACE
      });

      assert.strictEqual(
        result.pausedAtGate,
        undefined,
        `${mode}: a gate failure under the limit must not pause at the breaker`
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(
        result.currentStage,
        STAGE_IMPLEMENT,
        `${mode}: the run must revert to IMPLEMENT`
      );
      assert.strictEqual(
        result.reviewResult,
        undefined,
        `${mode}: a failed gate must never reach the AI review`
      );
      assert.ok(
        !stateRepo.savedSnapshot?.pausedAtGate,
        `${mode}: no breaker pause may be persisted below the limit`
      );
    }
  });

  test('TR-15 (AC1, AC6): the VACUOUS verdict precedent is kept by the shared block — a refusal never trips the breaker even at the limit', async () => {
    // The VACUOUS branch stays in each mode and precedes the shared breaker
    // check; seeding the counter AT the limit with a VACUOUS verdict proves
    // the ordering was preserved by both extractions.
    for (const mode of [MODE_YOLO, MODE_STANDARD]) {
      const deps = freshDeps();
      (configRepo.config as any).circuitBreakers = {
        ...(configRepo.config as any).circuitBreakers,
        maxGateRetries: 1
      };

      seedCheckpointAtImplement(mode, 1);

      const vacuousGate = {
        execute: async (params: any) => {
          const sm = StateMachine.fromSnapshot(stateRepo.savedSnapshot);
          return {
            passed: false,
            vacuous: true,
            currentStage: STAGE_IMPLEMENT,
            stateMachine: sm,
            reports: [],
            totalDurationMs: 0,
            summaryReport: 'Quality Gate : VACUOUS\n',
            buildStatus: 'FAILED',
            testsStatus: 'FAILED',
            gateReport: undefined,
            diagnosticSnippet: null,
            implementationDiff: params.implementationDiff
          };
        }
      };
      const lifecycle = new RunLifecycleUseCase({ ...deps, runQualityGateUseCase: vacuousGate });

      const result = await lifecycle.execute({
        mode,
        issue: 32,
        workspaceDir: SCOPED_WORKSPACE
      });

      assert.strictEqual(
        result.success,
        true,
        `${mode}: a VACUOUS verdict is a refusal, not a failure; got: ${result.message}`
      );
      assert.strictEqual(
        result.pausedAtGate,
        undefined,
        `${mode}: a VACUOUS verdict must not trip the breaker`
      );
      assert.strictEqual(
        result.stateMachine.implementToGateLoops,
        1,
        `${mode}: a VACUOUS verdict must not consume a retry`
      );
    }
  });

  test('TR-16 (AC4): the shared implementation-start leg keeps yolo\'s userInstructions omission', async () => {
    const deps = freshDeps();
    const startImplementation = new RecordingStartImplementationUseCase();
    const lifecycle = new RunLifecycleUseCase({
      ...deps,
      startImplementationUseCase: startImplementation
    });

    // The YOLO implementation leg starts from PLAN/APPROVAL.
    seedCheckpointAtImplementationLeg(MODE_YOLO);

    const result = await lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: SCOPED_WORKSPACE,
      userInstructions: 'smoke instructions'
    });

    assert.strictEqual(result.success, true, `got: ${result.message}`);
    assert.strictEqual(startImplementation.capturedParams.length, 1);
    assert.strictEqual(
      startImplementation.capturedParams[0].userInstructions,
      undefined,
      'YOLO must keep OMITTING userInstructions from StartImplementationUseCase'
    );
  });

  test('TR-16 (AC4): the shared implementation-start leg forwards userInstructions in standard mode', async () => {
    const deps = freshDeps();
    const startImplementation = new RecordingStartImplementationUseCase();
    const lifecycle = new RunLifecycleUseCase({
      ...deps,
      startImplementationUseCase: startImplementation
    });

    seedCheckpointAtImplementationLeg(MODE_STANDARD);

    const result = await lifecycle.execute({
      mode: MODE_STANDARD,
      issue: 32,
      workspaceDir: SCOPED_WORKSPACE,
      userInstructions: 'smoke instructions'
    });

    assert.strictEqual(result.success, true, `got: ${result.message}`);
    assert.strictEqual(startImplementation.capturedParams.length, 1);
    assert.strictEqual(
      startImplementation.capturedParams[0].userInstructions,
      'smoke instructions',
      'standard mode must still forward userInstructions to StartImplementationUseCase'
    );
    // The forwarded run continues: both modes reach the COMMIT gate on green.
    assert.strictEqual(result.pausedAtGate, GATE_COMMIT);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
  });
});
