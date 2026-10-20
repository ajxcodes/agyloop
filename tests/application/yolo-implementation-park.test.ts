/**
 * agyloop - YOLO Implementation Park Lifecycle Tests (issue #259, AC1/AC2/AC5/AC6, Y1-Y7)
 *
 * `codeloop yolo` PREPARES an implementation but never dispatches the
 * implementer subagent, so the quality gates used to certify the untouched
 * baseline and the pipeline advanced to the COMMIT gate with an empty diff.
 *
 * The contract these tests pin:
 *   - no implementation  => the run PARKS at IMPLEMENT, no gate command runs;
 *   - an implementation  => the gates run and the run reaches the COMMIT gate;
 *   - the park performs NO state transition and never fabricates a pass.
 *
 * The verdict is deterministic: the implementation-evidence probe is injected
 * as a mock, so no real git repository is involved.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  RunLifecycleUseCase,
  RunQualityGateUseCase,
  GetNextActionUseCase,
  DetectImplementationDiffUseCase
} = require('../../dist/application');
const {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  MODE_YOLO,
  ALLOWED_TRANSITIONS,
  WorktreeDescriptor,
  AiReviewReport,
  NOTE_YOLO_NO_IMPLEMENTATION,
  NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN
} = require('../../dist/domain');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

type CommandExecutorPort = import('../../src').CommandExecutorPort;
type CommandExecutionOptions = import('../../src').CommandExecutionOptions;
type CommandExecutionResult = import('../../src').CommandExecutionResult;

/* -------------------------------------------------------------------------- *
 * Verdict fixtures
 * -------------------------------------------------------------------------- */

/** The verdict of a tree that was read and carries NO implementation. */
function unchangedVerdict(baseRef = 'main'): any {
  return {
    hasChanges: false,
    baseRef,
    trackedChangedFiles: [],
    untrackedFiles: [],
    probeError: null,
    rawStatus: ''
  };
}

/** The verdict of a tree that carries a real implementation. */
function changedVerdict(baseRef = 'main'): any {
  return {
    hasChanges: true,
    baseRef,
    trackedChangedFiles: ['src/index.ts'],
    untrackedFiles: [],
    probeError: null,
    rawStatus: 'M  src/index.ts\n'
  };
}

/**
 * The mock probe. It records the parameters it received so the caller can see
 * WHERE the probe ran, and it replays a fixed verdict.
 */
class MockDetectImplementationDiffUseCase {
  public verdict: any;
  public calls: any[] = [];

  constructor(verdict: any) {
    this.verdict = verdict;
  }

  public async execute(params: any): Promise<any> {
    this.calls.push(params);
    return this.verdict;
  }
}

/* -------------------------------------------------------------------------- *
 * Dependency doubles
 * -------------------------------------------------------------------------- */

class MockStateRepository {
  public savedSnapshot: any = null;
  public savedSnapshots: any[] = [];

  public async load(): Promise<any> {
    return this.savedSnapshot;
  }

  public async save(snapshot: any): Promise<void> {
    this.savedSnapshot = snapshot;
    this.savedSnapshots.push(snapshot);
  }

  public async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  public getStateFilePath(): string {
    return '/mock/workspace/.agyloop/state.json';
  }
}

class MockConfigRepository {
  public config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  public loadConfig(): any {
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
  public planContent = '# Test Plan\n\n## Acceptance Criteria\n- [ ] Code compiles\n- [ ] Tests pass\n';

  public scaffoldPlanDirectory(): any {
    return {
      folderName: '32-test-feature',
      planDir: '/mock/workspace/artifacts/plans/32-test-feature',
      planPath: '/mock/workspace/artifacts/plans/32-test-feature/implementation-plan.md',
      summaryPath: '/mock/workspace/artifacts/plans/32-test-feature/summary-log.md',
      mirrorPath: null,
      type: 'implementation'
    };
  }

  public resolvePlanFile(): any {
    return {
      folderName: '32-test-feature',
      planDir: '/mock/workspace/artifacts/plans/32-test-feature',
      planPath: '/mock/workspace/artifacts/plans/32-test-feature/implementation-plan.md',
      summaryPath: '/mock/workspace/artifacts/plans/32-test-feature/summary-log.md',
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

  public async fetchIssue(): Promise<any> {
    return { number: 32, title: 'Implementation evidence probe', body: '', labels: ['feature'] };
  }
}

/**
 * The shared command executor. `git status --porcelain` and
 * `git diff --name-only <ref> -- .` are the probe's two commands; everything
 * else (the gate commands) succeeds.
 */
class MockCommandExecutor implements CommandExecutorPort {
  public executedCommands: string[] = [];
  public statusStdout = '';
  public diffStdout = '';

  public async execute(
    command: string,
    options?: CommandExecutionOptions
  ): Promise<CommandExecutionResult> {
    this.executedCommands.push(command);

    if (command === 'git status --porcelain') {
      return this.result(command, this.statusStdout);
    }

    if (command.startsWith('git diff --name-only')) {
      return this.result(command, this.diffStdout);
    }

    return this.result(command, 'All 10 tests passing\nBuild completed successfully');
  }

  private result(command: string, stdout: string): CommandExecutionResult {
    return {
      command,
      stdout,
      stderr: '',
      combinedOutput: stdout,
      exitCode: 0,
      durationMs: 1,
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
      commands: [{ id: 'test', label: 'Automated Test Suite (npm)', command: 'npm test' }]
    };
  }

  public resolveCommands(): any[] {
    return [{ id: 'test', label: 'Automated Test Suite (npm)', command: 'npm test' }];
  }
}

class MockStandardsRepository {
  public loadStandards(): string {
    return '# Repository Coding Standards\n';
  }

  public findStandardsPath(): string {
    return '/mock/workspace/.github/critique.md';
  }
}

class MockCritique {
  public reviewResult: any = AiReviewReport.parse(
    JSON.stringify({
      summary: 'All code meets requirements and standards.',
      confidenceLevel: 'High',
      confidenceExplanation: 'Clean diff with passing tests.',
      resolvedThreads: [],
      comments: []
    })
  );

  public async review(): Promise<any> {
    return this.reviewResult;
  }
}

class MockConfirmationPrompt {
  public async confirm(): Promise<boolean> {
    return true;
  }
}

class MockWorktreeManager {
  public async createWorktree(params: any): Promise<any> {
    return WorktreeDescriptor.create({
      taskId: params.issueNumber || 999,
      worktreePath: `/mock/workspace/.worktrees/${params.issueNumber || 999}`,
      branch: `task/${params.issueNumber || 999}`,
      baseBranch: params.baseBranch || 'main'
    });
  }

  public async removeWorktree(): Promise<void> {}
  public async cleanOrphanedWorktrees(): Promise<number> {
    return 0;
  }
  public async resolveTaskWorktreePath(): Promise<string | null> {
    return '/mock/workspace/.worktrees/999';
  }
  public async resolveTaskBranchName(): Promise<string> {
    return 'task/999';
  }
}

/* -------------------------------------------------------------------------- *
 * Harness
 * -------------------------------------------------------------------------- */

interface Harness {
  lifecycle: any;
  stateRepo: MockStateRepository;
  commandExecutor: MockCommandExecutor;
  configRepo: MockConfigRepository;
  planGenerator: MockPlanGenerator;
  probe: MockDetectImplementationDiffUseCase | null;
}

/**
 * Builds the lifecycle with every external dependency mocked. `extraDeps`
 * receives the shared dependencies and returns the use cases to inject (the
 * probe, the gate), so each test can drive the verdict deterministically
 * without re-creating the mocks.
 */
function buildHarness(verdict: any = unchangedVerdict(), extraDeps?: (deps: any) => any): Harness {
  const stateRepo = new MockStateRepository();
  const configRepo = new MockConfigRepository();
  const planGenerator = new MockPlanGenerator();
  const commandExecutor = new MockCommandExecutor();
  const probe = new MockDetectImplementationDiffUseCase(verdict);

  const deps: any = {
    stateRepo,
    configRepo,
    planGenerator,
    githubGateway: new MockGitHubGateway(),
    commandExecutor,
    buildDetector: new MockBuildDetector(),
    standardsRepo: new MockStandardsRepository(),
    critique: new MockCritique(),
    confirmationPrompt: new MockConfirmationPrompt(),
    worktreeManager: new MockWorktreeManager(),
    detectImplementationDiffUseCase: probe
  };

  const lifecycle = new RunLifecycleUseCase({
    ...deps,
    ...(extraDeps ? extraDeps(deps) : {})
  });

  return { lifecycle, stateRepo, commandExecutor, configRepo, planGenerator, probe };
}

/** A gate use case that must never be reached. */
function gateMustNotRun(): { useCase: any; calls: () => number } {
  let calls = 0;
  return {
    useCase: {
      execute: async () => {
        calls++;
        throw new Error('the quality gate must not run over an unimplemented tree');
      }
    },
    calls: () => calls
  };
}

/** The REAL gate use case, counting invocations so the happy path stays real. */
function countingGate(deps: any): { useCase: any; calls: () => number } {
  let calls = 0;
  const real = new RunQualityGateUseCase(
    deps.stateRepo,
    deps.configRepo,
    deps.planGenerator,
    deps.commandExecutor,
    deps.buildDetector
  );
  return {
    useCase: {
      execute: async (params: any) => {
        calls++;
        return real.execute(params);
      }
    },
    calls: () => calls
  };
}

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

describe('YOLO implementation park (issue #259)', () => {
  let transitionSpy: any[] = [];
  let originalTransition: any;

  beforeEach(() => {
    transitionSpy = [];
    originalTransition = StateMachine.prototype.transition;
    StateMachine.prototype.transition = function (targetStage: any, metadata: any = {}) {
      transitionSpy.push(targetStage);
      return originalTransition.call(this, targetStage, metadata);
    };
  });

  afterEach(() => {
    StateMachine.prototype.transition = originalTransition;
  });

  test('Y1 (AC1): a YOLO run over an unchanged tree dispatches no gate command — the gate use case is never invoked', async () => {
    const gate = gateMustNotRun();
    const harness = buildHarness(unchangedVerdict(), () => ({
      runQualityGateUseCase: gate.useCase
    }));

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.strictEqual(gate.calls(), 0, 'the quality gate use case must never be invoked');
    assert.strictEqual(result.qualityGateResult, undefined, 'no gate result may be reported');
    assert.ok(
      !harness.commandExecutor.executedCommands.includes('npm test'),
      `no gate command may run, got: ${harness.commandExecutor.executedCommands.join(', ')}`
    );
  });

  test('Y2 (AC1): the YOLO result reports implementationHalted === true and the non-green message NOTE_YOLO_NO_IMPLEMENTATION', async () => {
    const harness = buildHarness(unchangedVerdict('main'), () => ({
      runQualityGateUseCase: gateMustNotRun().useCase
    }));

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.strictEqual(result.implementationHalted, true);
    assert.strictEqual(result.message, NOTE_YOLO_NO_IMPLEMENTATION.replace('{baseRef}', 'main'));
    assert.ok(
      !result.message.includes('✓'),
      `the park message must not be a success signal, got: ${result.message}`
    );
    assert.ok(
      !/passed/i.test(result.message),
      `the park message must not claim a pass, got: ${result.message}`
    );
    // The verdict is surfaced for `--json` consumers and diagnostics.
    assert.ok(result.implementationDiff, 'the probe verdict must be surfaced');
    assert.strictEqual(result.implementationDiff!.baseRef, 'main');
  });

  test('Y3 (AC1): a YOLO run WITH an implementation diff executes the gates and reaches the COMMIT gate', async () => {
    let gate: { useCase: any; calls: () => number } | null = null;
    const harness = buildHarness(changedVerdict('main'), (deps) => {
      gate = countingGate(deps);
      return { runQualityGateUseCase: gate.useCase };
    });

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.strictEqual(gate!.calls(), 1, 'the gates must run over an implemented tree');
    assert.ok(result.qualityGateResult, 'a gate result must be reported');
    assert.strictEqual(result.qualityGateResult.passed, true);
    assert.strictEqual(result.currentStage, STAGE_COMMIT, 'the run must reach the COMMIT gate');
    assert.strictEqual(result.implementationHalted, undefined, 'an implemented tree must not park');
    assert.ok(
      harness.commandExecutor.executedCommands.includes('npm test'),
      'the gate command must actually run'
    );
  });

  test('Y4 (AC2): the persisted checkpoint stage is IMPLEMENT (never QUALITY_GATE/COMMIT) after a park', async () => {
    const harness = buildHarness(unchangedVerdict(), () => ({
      runQualityGateUseCase: gateMustNotRun().useCase
    }));

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);

    const persisted = harness.stateRepo.savedSnapshot;
    assert.ok(persisted, 'a checkpoint must be persisted');
    assert.strictEqual(persisted.currentStage, STAGE_IMPLEMENT);
    assert.notStrictEqual(persisted.currentStage, STAGE_QUALITY_GATE);
    assert.notStrictEqual(persisted.currentStage, STAGE_COMMIT);
    assert.notStrictEqual(persisted.currentStage, STAGE_COMPLETED);
    // A park is not a human gate.
    assert.strictEqual(persisted.pausedAtGate, null);
  });

  test('Y5 (AC2): the park performs no StateMachine.transition — the stage is legal and the history is unchanged', async () => {
    const harness = buildHarness(unchangedVerdict(), () => ({
      runQualityGateUseCase: gateMustNotRun().useCase
    }));

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    // No transition left IMPLEMENT: an IMPLEMENT -> IMPLEMENT transition is
    // not a legal one and would have thrown.
    assert.ok(
      !transitionSpy.includes(STAGE_QUALITY_GATE),
      `the park must not transition to the quality gate, got: ${transitionSpy.join(', ')}`
    );
    assert.ok(
      !transitionSpy.includes(STAGE_REVIEW),
      `the park must not transition to the review, got: ${transitionSpy.join(', ')}`
    );
    assert.ok(
      !transitionSpy.includes(STAGE_COMMIT),
      `the park must not transition to the commit gate, got: ${transitionSpy.join(', ')}`
    );
    assert.strictEqual(
      transitionSpy.filter((stage: string) => stage === STAGE_IMPLEMENT).length,
      1,
      `exactly one transition INTO implement is legal, got: ${transitionSpy.join(', ')}`
    );

    // The stage the park leaves behind is a legal stage.
    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.ok(
      ALLOWED_TRANSITIONS[STAGE_IMPLEMENT].length > 0,
      'IMPLEMENT must still be a legal stage with outgoing transitions'
    );
    assert.ok(
      !ALLOWED_TRANSITIONS[STAGE_IMPLEMENT].includes(STAGE_IMPLEMENT),
      'IMPLEMENT -> IMPLEMENT is not a legal transition — the park must not attempt one'
    );

    // The history did not grow during the park: the last two persisted
    // snapshots carry the same history.
    const snapshots = harness.stateRepo.savedSnapshots;
    assert.ok(snapshots.length >= 2, 'the checkpoint must be persisted');
    const last = snapshots[snapshots.length - 1];
    const previous = snapshots[snapshots.length - 2];
    assert.strictEqual(
      last.history.length,
      previous.history.length,
      `the park must not append a history entry, got: ${JSON.stringify(last.history)}`
    );
    assert.strictEqual(last.history[last.history.length - 1].stage, STAGE_IMPLEMENT);
    assert.deepStrictEqual(
      last.history.map((entry: any) => entry.stage),
      [STAGE_INITIALIZED, STAGE_DISCOVERY, STAGE_PLAN, STAGE_IMPLEMENT],
      'the persisted history must end at IMPLEMENT and contain nothing beyond it'
    );
    assert.ok(
      !last.history.some((entry: any) => entry.stage === STAGE_QUALITY_GATE),
      'the persisted history must not contain a quality-gate entry'
    );
  });

  test('Y6 (AC5, negative control): with an empty git status the YOLO run parks instead of publishing a no-op commit', async () => {
    const harness = buildHarness(undefined, (deps) => {
      // The REAL probe over a tree whose `git status --porcelain` is empty.
      deps.commandExecutor.statusStdout = '';
      deps.commandExecutor.diffStdout = '';
      return {
        detectImplementationDiffUseCase: new DetectImplementationDiffUseCase(deps.commandExecutor),
        runQualityGateUseCase: gateMustNotRun().useCase
      };
    });

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.strictEqual(result.implementationHalted, true, 'an empty tree must park');
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.qualityGateResult, undefined, 'the gates must not certify an empty tree');
    assert.strictEqual(result.reviewResult, undefined, 'the review must not run over an empty tree');
    assert.strictEqual(result.executeCommitResult, undefined, 'no commit may be published');
    assert.strictEqual(harness.stateRepo.savedSnapshot.currentStage, STAGE_IMPLEMENT);
    assert.notStrictEqual(harness.stateRepo.savedSnapshot.currentStage, STAGE_COMMIT);
  });

  test('Y7 (AC6): the YOLO park surfaces an implementer directive with actionType "subagent" and role "implementer"', async () => {
    const harness = buildHarness(unchangedVerdict(), () => ({
      runQualityGateUseCase: gateMustNotRun().useCase
    }));

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.strictEqual(result.implementationHalted, true);

    // The directive is produced by the SAME use case `codeloop next` uses,
    // over the checkpoint the park persisted.
    const getNextAction = new GetNextActionUseCase(
      harness.stateRepo,
      harness.configRepo,
      harness.planGenerator
    );

    const directive = await getNextAction.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(directive.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(directive.actionType, 'subagent');
    assert.strictEqual(directive.role, 'implementer');
    assert.ok(directive.invocationPayload, 'the directive must carry an invocation payload');
    assert.strictEqual(directive.invocationPayload!.Subagents.length, 1);
  });
});

/**
 * S10 — the park must not point an implementer directive at an EMPTY plan.
 *
 * `codeloop yolo` never dispatches the PLANNER either, so the plan it holds
 * IS the tool's own blank scaffold. A directive that points at an empty plan
 * is a false instruction, so the park records the verdict and the operator is
 * told what to do instead.
 */
describe('YOLO implementation park — the empty-plan guard (issue #259, S10)', () => {
  /** The tool's own blank scaffold, as `StartPlanningUseCase` writes it. */
  const BLANK_SCAFFOLD = [
    '# [Implementation] - repro task',
    '',
    '**Issue:** #adhoc  ',
    '**Date:** 2026-10-19  ',
    '**Author:** AgyLoop Planning Subagent  ',
    '**Status:** DRAFT | APPROVED  ',
    '',
    '---',
    '',
    '## 1. Context & Objectives',
    '- **Feature Overview:**',
    '- **Acceptance Criteria:**',
    '',
    '## 3. Implementation Steps',
    '- [ ] **Step 1:** ',
    '- [ ] **Step 2:** ',
    '- [ ] **Step 3:** ',
    ''
  ].join('\n');

  /** A plan a planner subagent (or the operator) actually wrote. */
  const POPULATED_PLAN = [
    '# [Implementation] - repro task',
    '',
    '## Objective',
    'Change `answer()` in `src-target.js` to return `7` instead of `42`.',
    '',
    '## 3. Implementation Steps',
    '- [ ] **Step 1:** Edit `src-target.js` so `answer()` returns `7`.',
    '- [ ] **Step 2:** Update `index.test.js` so the test expects `7`.',
    ''
  ].join('\n');

  test('Q4 (AC7): a YOLO park over an EMPTY plan reports implementationPlanEmpty === true and the park message says the plan is empty', async () => {
    const harness = buildHarness(unchangedVerdict('main'), () => ({
      runQualityGateUseCase: gateMustNotRun().useCase
    }));
    harness.planGenerator.planContent = BLANK_SCAFFOLD;

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.strictEqual(result.implementationHalted, true, 'an unchanged tree must still park');
    assert.strictEqual(
      result.implementationPlanEmpty,
      true,
      'the park must report that the plan carries no implementation steps'
    );

    const planPath = result.implementationResult?.planPath ?? '';
    assert.ok(planPath, 'the park must know which plan it is talking about');
    assert.strictEqual(
      result.message,
      NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN.replace('{baseRef}', 'main').replace('{planPath}', planPath),
      'the park message must name the empty plan'
    );
    assert.ok(
      result.message.includes(planPath),
      `the park message must name the plan path, got: ${result.message}`
    );
    assert.ok(
      /blank scaffold/i.test(result.message),
      `the park message must say the plan is the blank scaffold, got: ${result.message}`
    );
  });

  test('Q5 (AC7, negative control): a YOLO park over a POPULATED plan reports implementationPlanEmpty === false and the implementer directive is still produced (the issue-scoped path is not broken)', async () => {
    const harness = buildHarness(unchangedVerdict('main'), () => ({
      runQualityGateUseCase: gateMustNotRun().useCase
    }));
    harness.planGenerator.planContent = POPULATED_PLAN;

    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.strictEqual(result.implementationHalted, true, 'an unchanged tree must still park');
    assert.strictEqual(
      result.implementationPlanEmpty,
      false,
      'a written plan must never be reported as empty'
    );
    assert.strictEqual(
      result.message,
      NOTE_YOLO_NO_IMPLEMENTATION.replace('{baseRef}', 'main'),
      'the ordinary park message must be used for a written plan'
    );
    assert.ok(
      !/blank scaffold/i.test(result.message),
      `the park message must not claim the plan is empty, got: ${result.message}`
    );

    // The directive is still produced — by the SAME use case `codeloop next`
    // uses, over the checkpoint the park persisted.
    const getNextAction = new GetNextActionUseCase(
      harness.stateRepo,
      harness.configRepo,
      harness.planGenerator
    );

    const directive = await getNextAction.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(directive.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(directive.actionType, 'subagent');
    assert.strictEqual(directive.role, 'implementer');
    assert.ok(directive.invocationPayload, 'the directive must carry an invocation payload');
  });
});
