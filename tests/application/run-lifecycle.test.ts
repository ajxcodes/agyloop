/**
 * agyloop - RunLifecycleUseCase End-to-End & Operational Flags Unit Tests
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  MODE_STANDARD,
  MODE_YOLO,
  MODE_PLAN,
  MODE_IMPLEMENT,
  MODE_GATES,
  MODE_COMMIT,
  GATE_APPROVAL,
  GATE_COMMIT,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  CommitMessage,
  AiReviewReport
} = require('../../dist/domain');

const {
  RunLifecycleUseCase,
  StartPlanningUseCase,
  StartImplementationUseCase,
  RunQualityGateUseCase,
  RunReviewUseCase,
  DraftCommitUseCase,
  ExecuteCommitUseCase,
  InferBaseBranchUseCase
} = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

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
    return '/mock/workspace/.agyloop/state.json';
  }
}

class MockConfigRepository {
  public config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  public loadConfig(): any {
    return this.config;
  }

  public resolveModel(role: string): any {
    return {
      role,
      configured: 'default',
      tier: 'flash',
      apiModel: 'gemini-2.5-flash'
    };
  }

  public mapModelToTier(): string {
    return 'flash';
  }
}

class MockPlanGenerator {
  public scaffoldCalls: any[] = [];
  public updateSummaryCalls: any[] = [];
  public planContent = '# Test Plan\n\n## Acceptance Criteria\n- [ ] Code compiles\n- [ ] Tests pass\n';

  public scaffoldPlanDirectory(params: any): any {
    this.scaffoldCalls.push(params);
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

  public updateSummaryLog(path: string, data: any): boolean {
    this.updateSummaryCalls.push({ path, data });
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
      title: 'Operational Flags and Lifecycle Orchestration',
      body: 'Implement yolo and commit-after flags.',
      labels: ['feature', 'phase-4']
    };
  }
}

class MockCommandExecutor {
  public executedCommands: string[] = [];
  public failCommands = new Set<string>();

  public async execute(cmd: string): Promise<any> {
    this.executedCommands.push(cmd);
    if (this.failCommands.has(cmd)) {
      return {
        command: cmd,
        stdout: '',
        stderr: 'Command failed: assertion error',
        exitCode: 1,
        durationMs: 40,
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

    if (cmd.includes('git commit')) {
      return {
        command: cmd,
        stdout: '[main abc1234] feat(lifecycle): implement operational flags\n 1 file changed\n',
        stderr: '',
        exitCode: 0,
        durationMs: 25,
        timedOut: false
      };
    }

    return {
      command: cmd,
      stdout: 'All 10 tests passing\nBuild completed successfully',
      stderr: '',
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
    return '# Repository Coding Standards\n\n1. Hexagonal boundaries.\n2. Conventional commits.\n';
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
  public answer = true;
  public promptCalls: string[] = [];

  public async confirm(message: string): Promise<boolean> {
    this.promptCalls.push(message);
    return this.answer;
  }
}

describe('RunLifecycleUseCase & Operational Modes Orchestration', () => {
  let stateRepo: MockStateRepository;
  let configRepo: MockConfigRepository;
  let planGenerator: MockPlanGenerator;
  let githubGateway: MockGitHubGateway;
  let commandExecutor: MockCommandExecutor;
  let buildDetector: MockBuildDetector;
  let standardsRepo: MockStandardsRepository;
  let critique: MockCritique;
  let confirmationPrompt: MockConfirmationPrompt;
  let lifecycleUseCase: any;

  beforeEach(() => {
    stateRepo = new MockStateRepository();
    configRepo = new MockConfigRepository();
    planGenerator = new MockPlanGenerator();
    githubGateway = new MockGitHubGateway();
    commandExecutor = new MockCommandExecutor();
    buildDetector = new MockBuildDetector();
    standardsRepo = new MockStandardsRepository();
    critique = new MockCritique();
    confirmationPrompt = new MockConfirmationPrompt();

    lifecycleUseCase = new RunLifecycleUseCase({
      stateRepo,
      configRepo,
      planGenerator,
      githubGateway,
      commandExecutor,
      buildDetector,
      standardsRepo,
      critique,
      confirmationPrompt
    });
  });

  describe('1. Full Unattended Fast-Path Loop (yolo --commit-after)', () => {
    test('executes entire continuous lifecycle in single run to COMPLETED', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_YOLO,
        commitAfter: true,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_YOLO);
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);

      // Verify plan was scaffolded
      assert.strictEqual(planGenerator.scaffoldCalls.length, 1);
      assert.strictEqual(planGenerator.scaffoldCalls[0].issue, 32);

      // Verify quality gates executed and passed
      assert.ok(result.qualityGateResult);
      assert.strictEqual(result.qualityGateResult.passed, true);
      assert.ok(commandExecutor.executedCommands.includes('npm test'));

      // Verify AI review executed and approved
      assert.ok(result.reviewResult);
      assert.strictEqual(result.reviewResult.passed, true);
      assert.strictEqual(result.reviewResult.verdict.isApproved(), true);

      // Verify commit drafted and executed
      assert.ok(result.draftCommitResult);
      assert.ok(result.executeCommitResult);
      assert.strictEqual(result.executeCommitResult.success, true);
      assert.strictEqual(result.executeCommitResult.commitHash, 'abc1234');

      // Verify StateMachine history contains the full uninterrupted flow
      const history = result.stateMachine.history.map((h: any) => h.stage);
      assert.deepStrictEqual(history, [
        STAGE_INITIALIZED,
        STAGE_DISCOVERY,
        STAGE_PLAN,
        STAGE_APPROVAL,
        STAGE_IMPLEMENT,
        STAGE_QUALITY_GATE,
        STAGE_REVIEW,
        STAGE_COMMIT,
        STAGE_COMPLETED
      ]);
    });

    test('yolo mode without commitAfter pauses at COMMIT gate', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_YOLO,
        commitAfter: false,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.strictEqual(result.pausedAtGate, GATE_COMMIT);
      assert.ok(result.qualityGateResult?.passed);
      assert.ok(result.reviewResult?.passed);
      assert.strictEqual(result.executeCommitResult, undefined);
    });
  });

  describe('2. Standard Multi-Step Lifecycle Flow with Human Approval Gates', () => {
    test('Step 1 (fresh run): runs discovery & planning, scaffolds plan, and halts at APPROVAL', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_APPROVAL);
      assert.strictEqual(result.pausedAtGate, GATE_APPROVAL);
      assert.strictEqual(planGenerator.scaffoldCalls.length, 1);
      assert.strictEqual(result.qualityGateResult, undefined);
      assert.strictEqual(result.executeCommitResult, undefined);
    });

    test('Step 1 (fresh run for bug/discovery): leaves stage in DISCOVERY and does NOT pause at APPROVAL gate', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        type: 'discovery',
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.pausedAtGate, undefined);
      assert.strictEqual(result.message, 'Pipeline advanced to DISCOVERY.');
    });

    test('Step 2 (resuming from APPROVAL): advances to IMPLEMENT, passes gates & review, halts at COMMIT', async () => {
      // Simulate state rehydrated at APPROVAL
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        commitAfter: false,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.strictEqual(result.pausedAtGate, GATE_COMMIT);
      assert.ok(result.implementationResult);
      assert.ok(result.qualityGateResult?.passed);
      assert.ok(result.reviewResult?.passed);
      assert.ok(result.draftCommitResult);
    });

    test('Step 3 (at COMMIT with interactive confirmation): confirms commit and transitions to COMPLETED', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      sm.transition(STAGE_QUALITY_GATE);
      sm.transition(STAGE_REVIEW);
      sm.transition(STAGE_COMMIT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      confirmationPrompt.answer = true;

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        interactiveCommit: true,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);
      assert.strictEqual(result.executeCommitResult?.success, true);
      assert.strictEqual(result.executeCommitResult?.commitHash, 'abc1234');
    });
  });

  describe('3. Standalone Operational Modes', () => {
    test('mode "plan" halts strictly at APPROVAL gate', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_PLAN,
        issue: 32,
        title: 'Plan Title',
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_PLAN);
      assert.strictEqual(result.currentStage, STAGE_APPROVAL);
      assert.strictEqual(result.pausedAtGate, GATE_APPROVAL);
      assert.strictEqual(planGenerator.scaffoldCalls.length, 1);
    });

    test('mode "plan" for bug/discovery leaves stage in DISCOVERY and does NOT pause at APPROVAL gate', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_PLAN,
        issue: 32,
        type: 'discovery',
        title: 'Bug Fix Plan',
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_PLAN);
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.pausedAtGate, undefined);
      assert.strictEqual(result.message, 'Pipeline advanced to DISCOVERY.');
    });

    test('mode "implement" resumes execution directly from approved plan', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_IMPLEMENT,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_IMPLEMENT);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
      assert.ok(result.implementationResult);
    });

    test('mode "gates" runs quality gates and AI PR review sequentially', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_GATES,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_GATES);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.ok(result.qualityGateResult?.passed);
      assert.ok(result.reviewResult?.passed);
    });

    test('mode "gates --commit-after" auto-commits upon passing gates and review', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_GATES,
        commitAfter: true,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);
      assert.strictEqual(result.executeCommitResult?.commitHash, 'abc1234');
    });

    test('mode "commit" drafts and executes commit with yes bypass', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      sm.transition(STAGE_QUALITY_GATE);
      sm.transition(STAGE_REVIEW);
      sm.transition(STAGE_COMMIT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_COMMIT,
        yes: true,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);
      assert.strictEqual(result.executeCommitResult?.confirmed, true);
      assert.strictEqual(result.executeCommitResult?.commitHash, 'abc1234');
    });
  });

  describe('4. Self-Correction & Reversion Cycles', () => {
    test('reverts from QUALITY_GATE to IMPLEMENT on verification command failure', async () => {
      commandExecutor.failCommands.add('npm test');

      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_GATES,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(result.qualityGateResult?.passed, false);
      assert.strictEqual(result.reviewResult, undefined);
    });

    test('reverts from REVIEW to IMPLEMENT on AI review CHANGES_REQUESTED', async () => {
      critique.reviewResult = AiReviewReport.parse(
        JSON.stringify({
          summary: 'Acceptance criteria not met: missing boundary check',
          confidenceLevel: 'High',
          confidenceExplanation: 'Code review findings',
          resolvedThreads: [],
          comments: [
            {
              path: 'src/index.ts',
              line: 1,
              severity: 'error',
              body: 'Missing boundary validation'
            }
          ]
        })
      );

      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_GATES,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
      assert.ok(result.qualityGateResult?.passed);
      assert.strictEqual(result.reviewResult?.passed, false);
    });

    test('recovers after fix: re-running after correcting issue completes pipeline', async () => {
      // Step 1: Failed gates put pipeline in IMPLEMENT
      commandExecutor.failCommands.add('npm test');
      const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const failedResult = await lifecycleUseCase.execute({
        mode: MODE_YOLO,
        commitAfter: true,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });
      assert.strictEqual(failedResult.success, false);
      assert.strictEqual(failedResult.currentStage, STAGE_IMPLEMENT);

      // Step 2: Fix bug, gates now pass
      commandExecutor.failCommands.clear();

      const recoveredResult = await lifecycleUseCase.execute({
        mode: MODE_YOLO,
        commitAfter: true,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(recoveredResult.success, true);
      assert.strictEqual(recoveredResult.currentStage, STAGE_COMPLETED);
    });
  });

  describe('5. State Hydration & Persistence Resilience', () => {
    test('dryRun does not write to state repository', async () => {
      const initialSaves = stateRepo.saveCount;
      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        dryRun: true,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(stateRepo.saveCount, initialSaves);
    });

    test('already completed pipeline reports completed status cleanly', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      sm.transition(STAGE_QUALITY_GATE);
      sm.transition(STAGE_REVIEW);
      sm.transition(STAGE_COMMIT);
      sm.transition(STAGE_COMPLETED);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);
    });

    test('initializes inferBaseBranchUseCase before startImplementationUseCase and passes it to startImplementationUseCase', () => {
      let passedInferBaseBranchUseCase: any = null;
      class SpyStartImplementationUseCase {
        constructor(
          _stateRepo: any,
          _configRepo: any,
          _planGenerator: any,
          _githubGateway?: any,
          _resolveSubagentUseCase?: any,
          _worktreeManager?: any,
          inferBaseBranchUseCase?: any
        ) {
          passedInferBaseBranchUseCase = inferBaseBranchUseCase;
        }
      }

      const mockWorktreeManager: any = {
        resolveTaskWorktreePath: async () => '/mock/worktree',
        resolveTaskBranchName: () => 'task/32-test',
        createWorktree: async () => ({})
      };

      const customInferBaseBranchUseCase = new InferBaseBranchUseCase(
        mockWorktreeManager,
        githubGateway,
        stateRepo
      );

      // Case 1: Provided via deps
      new RunLifecycleUseCase({
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway,
        commandExecutor,
        worktreeManager: mockWorktreeManager,
        inferBaseBranchUseCase: customInferBaseBranchUseCase,
        startImplementationUseCase: new SpyStartImplementationUseCase(
          stateRepo,
          configRepo,
          planGenerator,
          githubGateway,
          undefined,
          mockWorktreeManager,
          customInferBaseBranchUseCase
        ) as any
      });

      // Case 2: Auto-instantiated when worktreeManager is present and passed to default StartImplementationUseCase
      const lifecycle = new RunLifecycleUseCase({
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway,
        commandExecutor,
        worktreeManager: mockWorktreeManager
      });

      assert.ok((lifecycle as any).inferBaseBranchUseCase instanceof InferBaseBranchUseCase);
      assert.ok((lifecycle as any).startImplementationUseCase['inferBaseBranchUseCase'] instanceof InferBaseBranchUseCase);
      assert.strictEqual(
        (lifecycle as any).startImplementationUseCase['inferBaseBranchUseCase'],
        (lifecycle as any).inferBaseBranchUseCase
      );
    });
  });
});
