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
  MODE_COMMIT,
  GATE_APPROVAL,
  GATE_COMMIT,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  CommitMessage,
  AiReviewReport,
  WorktreeDescriptor,
  NOTE_DISCOVERY_PARK_AWAITING_RCA,
  NOTE_YOLO_PARKED_AT_DISCOVERY
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

class MockWorktreeManager {
  public async createWorktree(params: any): Promise<any> {
    return WorktreeDescriptor.create({
      taskId: params.issueNumber || 999,
      worktreePath: `/mock/workspace/.worktrees/${params.issueNumber || 999}`,
      branch: `task/${params.issueNumber || 999}`,
      baseBranch: params.baseBranch || 'main'
    });
  }
  public async removeWorktree(options: any): Promise<void> {}
  public async cleanOrphanedWorktrees(options?: any): Promise<number> { return 0; }
  public async resolveTaskWorktreePath(): Promise<string | null> { return '/mock/workspace/.worktrees/999'; }
  public async resolveTaskBranchName(): Promise<string> { return 'task/999'; }
}

describe('RunLifecycleUseCase & Operational Modes Orchestration', () => {
  const mockWorktree = WorktreeDescriptor.create({
    taskId: 999,
    worktreePath: '/mock/repo/.worktrees/999',
    branch: 'fix/999',
    baseBranch: 'main'
  });

  let stateRepo: MockStateRepository;
  let configRepo: MockConfigRepository;
  let planGenerator: MockPlanGenerator;
  let githubGateway: MockGitHubGateway;
  let commandExecutor: MockCommandExecutor;
  let buildDetector: MockBuildDetector;
  let standardsRepo: MockStandardsRepository;
  let critique: MockCritique;
  let confirmationPrompt: MockConfirmationPrompt;
  let worktreeManager: MockWorktreeManager;
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
    worktreeManager = new MockWorktreeManager();

    lifecycleUseCase = new RunLifecycleUseCase({
      stateRepo,
      configRepo,
      planGenerator,
      githubGateway,
      commandExecutor,
      buildDetector,
      standardsRepo,
      critique,
      confirmationPrompt,
      worktreeManager
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

    test('yolo with passing gates and absent critique pauses at COMMIT without reverting (issue #236, AC1)', async () => {
      // Production absence path: gateway normalizes "critique missing" to a bypassed report.
      critique.reviewResult = AiReviewReport.bypassed('Critique CLI binary not found.');

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
      assert.strictEqual(result.reviewResult?.passed, true);
      assert.strictEqual(result.reviewResult?.verdict.status, 'SKIPPED');
      assert.strictEqual(result.executeCommitResult, undefined);
      assert.ok(
        !String(result.message).includes('Reverted'),
        `message must not claim a revert, got: ${result.message}`
      );
    });
  });

  describe('2. Standard Multi-Step Lifecycle Flow with Human Approval Gates', () => {
    test('Step 1 (fresh run): runs discovery & planning, scaffolds plan, and halts at PLAN', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_PLAN);
      assert.strictEqual(result.pausedAtGate, undefined);
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
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
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
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
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

    // --- Zero-Hang Invariant (issue #218 / AC6) ---------------------------

    test('non-interactive session never opens the commit prompt and pauses at the COMMIT gate', { timeout: 5000 }, async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      sm.transition(STAGE_QUALITY_GATE);
      sm.transition(STAGE_REVIEW);
      sm.transition(STAGE_COMMIT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      confirmationPrompt.answer = true;
      confirmationPrompt.promptCalls.length = 0;

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        interactive: false,
        interactiveCommit: true,
        workspaceDir: '/mock/workspace'
      });

      assert.deepStrictEqual(confirmationPrompt.promptCalls, []);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.strictEqual(result.pausedAtGate, GATE_COMMIT);
      assert.strictEqual(result.executeCommitResult, undefined);
    });
  });

  describe('3. Standalone Operational Modes', () => {
    test('mode "plan" halts strictly at PLAN gate', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_PLAN,
        issue: 32,
        title: 'Plan Title',
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_PLAN);
      assert.strictEqual(result.currentStage, STAGE_PLAN);
      assert.strictEqual(result.pausedAtGate, undefined);
      assert.strictEqual(planGenerator.scaffoldCalls.length, 1);
    });

    test('mode "plan" for bug/discovery advances to PLAN and halts at PLAN gate', async () => {
      const result = await lifecycleUseCase.execute({
        mode: MODE_PLAN,
        issue: 32,
        type: 'discovery',
        title: 'Bug Fix Plan',
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_PLAN);
      assert.strictEqual(result.currentStage, STAGE_PLAN);
      assert.strictEqual(result.pausedAtGate, undefined);
      assert.strictEqual(planGenerator.scaffoldCalls.length, 1);
    });

    test('mode "implement" resumes execution directly from approved plan', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: 32, worktree: mockWorktree });
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

    test('mode "implement" forwards worktree:false as noWorktree into StartImplementationUseCase.execute (issue #247, AC5)', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const lp = lifecycleUseCase as any;
      const originalExecute = lp.startImplementationUseCase.execute.bind(lp.startImplementationUseCase);
      const capturedParams: any[] = [];
      lp.startImplementationUseCase.execute = async (params: any) => {
        capturedParams.push(params);
        return originalExecute(params);
      };

      const withNoWorktree = await lifecycleUseCase.execute({
        mode: MODE_IMPLEMENT,
        issue: 32,
        worktree: false,
        workspaceDir: '/mock/workspace'
      });
      assert.strictEqual(withNoWorktree.success, true);
      assert.strictEqual(capturedParams.length, 1);
      assert.strictEqual(
        capturedParams[0].noWorktree,
        true,
        'worktree:false must cross the boundary as noWorktree:true so provisioning truly skips'
      );

      // Control: a normal run forwards noWorktree:false.
      const smControl = StateMachine.createInitial({ mode: MODE_PLAN, issue: 33, worktree: mockWorktree });
      smControl.transition(STAGE_DISCOVERY);
      smControl.transition(STAGE_PLAN);
      smControl.transition(STAGE_APPROVAL);
      stateRepo.savedSnapshot = smControl.toSnapshot();

      const withWorktree = await lifecycleUseCase.execute({
        mode: MODE_IMPLEMENT,
        issue: 33,
        worktree: true,
        workspaceDir: '/mock/workspace'
      });
      assert.strictEqual(withWorktree.success, true);
      assert.strictEqual(capturedParams.length, 2);
      assert.strictEqual(capturedParams[1].noWorktree, false);
    });

    test('mode "standard" from IMPLEMENT stage runs quality gates and AI PR review sequentially', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_STANDARD);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.ok(result.qualityGateResult?.passed);
      assert.ok(result.reviewResult?.passed);
    });

    test('mode "standard" from IMPLEMENT stage does not emit stage transition notifications via onProgress', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const progressLogs: string[] = [];
      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace',
        onProgress: (msg: string) => progressLogs.push(msg)
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.deepStrictEqual(progressLogs, []);
    });

    test('mode "standard" --step flag has no effect: pipeline advances fully to COMMIT', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const progressLogs: string[] = [];
      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        step: true,
        workspaceDir: '/mock/workspace',
        onProgress: (msg: string) => progressLogs.push(msg)
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.ok(result.qualityGateResult?.passed);
      assert.ok(result.reviewResult?.passed);
    });

    test('mode "gates --commit-after" auto-commits upon passing gates and review', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        commitAfter: true,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);
      assert.strictEqual(result.executeCommitResult?.commitHash, 'abc1234');
    });

    test('mode "commit" drafts and executes commit with yes bypass', async () => {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
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

      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
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

      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
      assert.ok(result.qualityGateResult?.passed);
      assert.strictEqual(result.reviewResult?.passed, false);
    });

    test('standard mode with absent critique advances to the COMMIT gate without reverting (issue #236, AC1)', async () => {
      critique.reviewResult = AiReviewReport.bypassed('Critique CLI binary not found.');

      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.strictEqual(result.pausedAtGate, GATE_COMMIT);
      assert.ok(result.qualityGateResult?.passed);
      assert.strictEqual(result.reviewResult?.passed, true);
      assert.strictEqual(result.reviewResult?.verdict.status, 'SKIPPED');
      assert.ok(
        !String(result.message).toLowerCase().includes('reverted'),
        `message must not claim a revert, got: ${result.message}`
      );
    });

    test('recovers after fix: re-running after correcting issue completes pipeline', async () => {
      // Step 1: Failed gates put pipeline in IMPLEMENT
      commandExecutor.failCommands.add('npm test');
      const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 32, worktree: mockWorktree });
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
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
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

  describe('6. Preflight PR comment routing to TRIAGE', () => {
    const { STAGE_TRIAGE, GATE_TRIAGE, ALLOWED_TRANSITIONS } = require('../../dist/domain');
    const fromStages = [STAGE_DISCOVERY, STAGE_PLAN, STAGE_APPROVAL, STAGE_IMPLEMENT, STAGE_QUALITY_GATE, STAGE_REVIEW];

    function buildLifecycle(stage: string) {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      (sm as any)._currentStage = stage;
      stateRepo.savedSnapshot = { ...sm.toSnapshot(), currentStage: stage };
      const preflight = {
        execute: async () => ({
          isResume: true,
          resumePrNumber: 5,
          prReviewComments: [{ author: 'r', body: 'fix', category: 'error' }]
        })
      };
      return new RunLifecycleUseCase({
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway,
        commandExecutor,
        buildDetector,
        standardsRepo,
        critique,
        confirmationPrompt,
        runPreFlightCheckUseCase: preflight
      });
    }

    test('ALLOWED_TRANSITIONS permits TRIAGE from intermediate stages', () => {
      for (const stage of fromStages) {
        assert.ok(ALLOWED_TRANSITIONS[stage].includes(STAGE_TRIAGE), `${stage} should allow TRIAGE`);
      }
    });

    for (const stage of fromStages) {
      test(`transitions to TRIAGE from ${stage}`, async () => {
        const lifecycle = buildLifecycle(stage);
        const result = await lifecycle.execute({ mode: MODE_STANDARD, issue: 32, workspaceDir: '/mock/workspace' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.currentStage, STAGE_TRIAGE);
        assert.strictEqual(result.pausedAtGate, GATE_TRIAGE);
      });
    }

    test('returns failure when TRIAGE transition is not allowed', async () => {
      const lifecycle = buildLifecycle(STAGE_REVIEW);
      const original = StateMachine.prototype.canTransition;
      StateMachine.prototype.canTransition = () => false;
      try {
        const result = await lifecycle.execute({ mode: MODE_STANDARD, issue: 32, workspaceDir: '/mock/workspace' });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.currentStage, STAGE_REVIEW);
        assert.strictEqual(result.message, `Cannot transition to TRIAGE from ${STAGE_REVIEW}`);
      } finally {
        StateMachine.prototype.canTransition = original;
      }
    });

    test('formats preflight PR review comments with author and body into triage payload', async () => {
      const lifecycle = buildLifecycle(STAGE_IMPLEMENT);
      const result = await lifecycle.execute({ mode: MODE_STANDARD, issue: 32, workspaceDir: '/mock/workspace' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_TRIAGE);
      assert.strictEqual(
        stateRepo.savedSnapshot.triagePayload,
        '- [r]: fix'
      );
    });
  });

  describe('7. YOLO Discovery Park & Gate Guard (issue #234)', () => {
    function buildYoloLifecycle(deps: any = {}): any {
      return new RunLifecycleUseCase({
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway,
        commandExecutor,
        buildDetector,
        standardsRepo,
        critique,
        confirmationPrompt,
        worktreeManager,
        ...deps
      });
    }

    function gateMustNotRun(): { useCase: any; calls: () => number } {
      let calls = 0;
      return {
        useCase: {
          execute: async () => {
            calls++;
            throw new Error('gate must not run');
          }
        },
        calls: () => calls
      };
    }

    /** The REAL gate use case, counting invocations so the happy path stays real. */
    function countingGate(): { useCase: any; calls: () => number } {
      let calls = 0;
      const real = new RunQualityGateUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        commandExecutor,
        buildDetector
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

    function assertDiscoveryPark(result: any, gateCalls: () => number): void {
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_YOLO);
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.pausedAtGate, undefined);
      assert.strictEqual(result.qualityGateResult, undefined);
      assert.strictEqual(result.worktree, undefined);
      assert.strictEqual(gateCalls(), 0, 'quality gates must never run from DISCOVERY');
      assert.ok(result.planResult, 'planning result must be surfaced');
      assert.match(result.message, /codeloop next/);
      assert.match(result.message, /codeloop resume/);
    }

    test('A1: --type discovery parks at DISCOVERY before resolveWorktree and the gates', async () => {
      const gate = gateMustNotRun();
      let createWorktreeCalls = 0;
      const originalCreateWorktree = worktreeManager.createWorktree;
      worktreeManager.createWorktree = async (params: any) => {
        createWorktreeCalls++;
        return originalCreateWorktree.call(worktreeManager, params);
      };

      try {
        const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });
        const result = await lifecycle.execute({
          mode: MODE_YOLO,
          issue: 32,
          type: 'discovery',
          workspaceDir: '/mock/workspace'
        });

        assertDiscoveryPark(result, gate.calls);
        assert.strictEqual(createWorktreeCalls, 0, 'the park leg must return before resolveWorktree');
        assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
        assert.strictEqual(stateRepo.savedSnapshot.mode, MODE_YOLO);
      } finally {
        worktreeManager.createWorktree = originalCreateWorktree;
      }
    });

    test('A2: bug-family label classifies the task and parks at DISCOVERY', async () => {
      const gate = gateMustNotRun();
      const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });

      const originalFetchIssue = githubGateway.fetchIssue;
      githubGateway.fetchIssue = async (...args: any[]) => {
        const data = await originalFetchIssue.apply(githubGateway, args as [number]);
        return { ...data, labels: ['bug'] };
      };

      try {
        const result = await lifecycle.execute({
          mode: MODE_YOLO,
          issue: 32,
          workspaceDir: '/mock/workspace'
        });

        assertDiscoveryPark(result, gate.calls);
        assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
      } finally {
        githubGateway.fetchIssue = originalFetchIssue;
      }
    });

    test('A3: [bug]-style title parks at DISCOVERY without an issue', async () => {
      const gate = gateMustNotRun();
      const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });

      const result = await lifecycle.execute({
        mode: MODE_YOLO,
        title: '[bug] probe',
        workspaceDir: '/mock/workspace'
      });

      assertDiscoveryPark(result, gate.calls);
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
    });

    test('A4: worktree descriptor is persisted immediately after resolveWorktree (crash-safety)', async () => {
      class HistoryStateRepository extends MockStateRepository {
        public saved: any[] = [];

        public async save(snapshot: any): Promise<void> {
          this.saved.push(snapshot);
          await super.save(snapshot);
        }
      }

      const repo = new HistoryStateRepository();
      let worktreeAtGateCall: any = undefined;
      const crashingGate = {
        execute: async () => {
          worktreeAtGateCall = repo.savedSnapshot?.worktree ?? null;
          throw new Error('simulated gate crash');
        }
      };

      const lifecycle = new RunLifecycleUseCase({
        stateRepo: repo,
        configRepo,
        planGenerator,
        githubGateway,
        commandExecutor,
        buildDetector,
        standardsRepo,
        critique,
        confirmationPrompt,
        worktreeManager,
        runQualityGateUseCase: crashingGate
      });

      await assert.rejects(
        async () => {
          await lifecycle.execute({ mode: MODE_YOLO, issue: 32, workspaceDir: '/mock/workspace' });
        },
        (err: unknown) => err instanceof Error && err.message === 'simulated gate crash'
      );

      assert.notStrictEqual(worktreeAtGateCall, null, 'descriptor must be persisted when the gate step runs');
      assert.ok(
        repo.saved.some((s: any) => s.currentStage === STAGE_PLAN && s.worktree !== null),
        'a PLAN snapshot carrying the worktree must be saved right after resolveWorktree'
      );
      assert.ok(repo.savedSnapshot?.worktree?.worktreePath, 'final snapshot still carries the descriptor');
    });

    test('A5: unexpected stage at the gate step checkpoints and returns instead of throwing', async () => {
      const gate = gateMustNotRun();
      const implSpy = {
        execute: async (): Promise<any> => ({
          stateMachine: StateMachine.fromSnapshot(stateRepo.savedSnapshot)
        })
      };
      const lifecycle = buildYoloLifecycle({
        runQualityGateUseCase: gate.useCase,
        startImplementationUseCase: implSpy
      });

      const result = await lifecycle.execute({
        mode: MODE_YOLO,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.currentStage, STAGE_PLAN);
      assert.strictEqual(gate.calls(), 0, 'gate use case must be unreachable from PLAN');
      assert.match(result.message, /codeloop next/);
      assert.doesNotMatch(result.message, /Cannot run quality gates from stage/);
      assert.ok(stateRepo.savedSnapshot, 'checkpoint must be persisted');
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_PLAN);
    });

    // ---- issue #237: the park must hold on RE-ENTRY -----------------------
    //
    // The #234 park is entered from a fresh INITIALIZED checkpoint. Re-running
    // `yolo` after that park is the single most natural operator action, and the
    // DISCOVERY -> PLAN advance used to be unconditional — so the second run
    // streamed out of a pristine, unpopulated `[Discovery] - ….md` scaffold and
    // bypassed the RCA gate entirely.
    function seedDiscoveryCheckpoint(): void {
      const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 32 });
      sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
      stateRepo.savedSnapshot = sm.toSnapshot();
    }

    test('B1: yolo re-entry after the DISCOVERY park parks and never runs gates', async () => {
      seedDiscoveryCheckpoint();
      const gate = gateMustNotRun();
      let createWorktreeCalls = 0;
      const originalCreateWorktree = worktreeManager.createWorktree;
      worktreeManager.createWorktree = async (params: any) => {
        createWorktreeCalls++;
        return originalCreateWorktree.call(worktreeManager, params);
      };

      try {
        const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });
        const result = await lifecycle.execute({
          mode: MODE_YOLO,
          issue: 32,
          workspaceDir: '/mock/workspace'
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.mode, MODE_YOLO);
        assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
        assert.strictEqual(result.pausedAtGate, undefined);
        assert.strictEqual(gate.calls(), 0, 'the RCA park must hold before any gate runs');
        assert.strictEqual(createWorktreeCalls, 0, 'no worktree may be provisioned from a parked RCA');
        assert.strictEqual(result.qualityGateResult, undefined);
        assert.strictEqual(result.implementationResult, undefined);
        assert.strictEqual(result.reviewResult, undefined);
        assert.strictEqual(result.executeCommitResult, undefined);
        // The re-entry park message names the outstanding work (the RCA report).
        assert.strictEqual(result.planResult?.discoveryReentry, 'PARK_AT_DISCOVERY');
        assert.strictEqual(result.message, NOTE_DISCOVERY_PARK_AWAITING_RCA);
        assert.doesNotMatch(result.message, /YOLO cannot dispatch subagents inline/);

        // Stage and history are both untouched: no PLAN entry was ever written.
        assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
        assert.strictEqual(stateRepo.savedSnapshot.history.length, 2);
        assert.ok(
          !stateRepo.savedSnapshot.history.some((h: any) => h.stage === STAGE_PLAN),
          'a parked re-entry must gain no PLAN history entry'
        );
      } finally {
        worktreeManager.createWorktree = originalCreateWorktree;
      }
    });

    test('B2: yolo re-entry with a populated discovery report proceeds to the COMMIT gate', async () => {
      seedDiscoveryCheckpoint();
      // The discovery subagent ran: the report on disk carries real content.
      planGenerator.planContent = [
        '# [Discovery] - Operational Flags and Lifecycle Orchestration',
        '',
        '## 1. Problem Statement & Symptoms',
        '- **Observed Behavior:** the yolo fast-path halts before the quality gates',
        '- **Expected Behavior:** gates and review run unattended to the COMMIT gate',
        '- **Affected Components / Paths:** src/application/run-lifecycle.ts',
        '',
        '## 2. Root Cause Analysis (RCA)',
        '- **Investigation Steps:** traced the yolo leg stage guard end to end',
        '- **Identified Failure Mode:** stage reached the gates without an approved plan',
        '- **Relevant Code References:** src/application/run-lifecycle.ts:845',
        '',
        '## 3. Reproduction Steps & Verification Protocol',
        '- **Local Reproduction Command:** npm test',
        '- **Failing Test Target:** tests/application/run-lifecycle.test.ts',
        '',
        '## 4. Remediation Strategy',
        '- **Recommended Fix Approach:** release the park on content evidence',
        '- **Potential Regressions / Side Effects:** none'
      ].join('\n');

      const gate = countingGate();
      const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });

      const result = await lifecycle.execute({
        mode: MODE_YOLO,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.strictEqual(result.planResult?.discoveryReentry, 'ADVANCE_TO_PLAN');
      assert.strictEqual(gate.calls(), 1, 'gates must run once the RCA evidence exists');
      assert.ok(result.qualityGateResult?.passed);
      assert.ok(result.reviewResult?.passed);
      assert.strictEqual(result.pausedAtGate, GATE_COMMIT);
    });

    test('B3: yolo re-entry with --skip-discovery bypasses the RCA park', async () => {
      seedDiscoveryCheckpoint();
      const gate = countingGate();
      const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });

      const result = await lifecycle.execute({
        mode: MODE_YOLO,
        issue: 32,
        skipDiscovery: true,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.strictEqual(result.planResult?.discoveryReentry, 'ADVANCE_TO_PLAN');
      // The bypass is recorded in history metadata so it stays auditable.
      const planEntry = stateRepo.savedSnapshot.history.find((h: any) => h.stage === STAGE_PLAN);
      assert.strictEqual(planEntry?.metadata?.skipDiscovery, true);
    });

    // ---- #237 finding 11: AC1 was only pinned for yolo -------------------
    //
    // The park rule is mode-independent (`resolveDiscoveryReentry` takes no
    // mode), but the only re-entry-park test exercised `yolo`. `plan` and the
    // bare `codeloop` standard run reach DISCOVERY through
    // `executePlanMode`/`executeStandardMode`, and those two legs each build
    // their OWN park message — the leg the CLI was dropping (finding 3).
    test('B4: plan-mode re-entry parks and names the outstanding RCA work', async () => {
      seedDiscoveryCheckpoint();
      const gate = gateMustNotRun();

      const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });
      const result = await lifecycle.execute({
        mode: MODE_PLAN,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_PLAN);
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.pausedAtGate, undefined, 'a parked re-entry must not pause at APPROVAL');
      assert.strictEqual(result.planResult?.discoveryReentry, 'PARK_AT_DISCOVERY');
      assert.strictEqual(result.message, NOTE_DISCOVERY_PARK_AWAITING_RCA);
      assert.strictEqual(gate.calls(), 0);
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(stateRepo.savedSnapshot.history.length, 2);
      assert.ok(
        !stateRepo.savedSnapshot.history.some((h: any) => h.stage === STAGE_PLAN),
        'a parked plan-mode re-entry must gain no PLAN history entry'
      );
    });

    test('B5: standard-mode re-entry parks and names the outstanding RCA work', async () => {
      seedDiscoveryCheckpoint();
      const gate = gateMustNotRun();

      const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });
      const result = await lifecycle.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_STANDARD);
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.pausedAtGate, undefined, 'a parked re-entry must not pause at APPROVAL');
      assert.strictEqual(result.planResult?.discoveryReentry, 'PARK_AT_DISCOVERY');
      assert.strictEqual(result.message, NOTE_DISCOVERY_PARK_AWAITING_RCA);
      assert.strictEqual(gate.calls(), 0);
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(stateRepo.savedSnapshot.history.length, 2);
    });

    test('B6: plan-mode and standard-mode re-entry both release on content evidence', async () => {
      // The positive control for B4/B5: without it, a resolver that always
      // parked outside yolo would also satisfy them.
      seedDiscoveryCheckpoint();
      planGenerator.planContent = [
        '# [Discovery] - Operational Flags and Lifecycle Orchestration',
        '',
        '## 1. Problem Statement & Symptoms',
        '- **Observed Behavior:** the discovery park holds on re-entry',
        '- **Expected Behavior:** gates run once an RCA report exists',
        '- **Affected Components / Paths:**',
        '  - src/application/start-planning.ts',
        '',
        '## 2. Root Cause Analysis (RCA)',
        '- **Investigation Steps:**',
        '  1. Traced the DISCOVERY re-entry leg end to end.',
        '- **Identified Failure Mode:** the park had no content evidence check',
        '- **Relevant Code References:**',
        '  - src/domain/value-objects/discovery-report.ts',
        '',
        '## 3. Reproduction Steps & Verification Protocol',
        '- **Local Reproduction Command:** npm test',
        '- **Failing Test Target:** tests/application/run-lifecycle.test.ts',
        '',
        '## 4. Remediation Strategy',
        '- **Recommended Fix Approach:** consult resolveDiscoveryReentry',
        '- **Potential Regressions / Side Effects:** none'
      ].join('\n');

      for (const mode of [MODE_PLAN, MODE_STANDARD]) {
        stateRepo = new MockStateRepository();
        seedDiscoveryCheckpoint();
        const lifecycle = buildYoloLifecycle();
        const result = await lifecycle.execute({
          mode,
          issue: 32,
          workspaceDir: '/mock/workspace'
        });

        assert.strictEqual(result.planResult?.discoveryReentry, 'ADVANCE_TO_PLAN', `${mode} must advance`);
        // Both legs stop right after planning and hand back to the operator:
        // plan mode returns at PLAN, and the standard run returns at PLAN too
        // (it does not continue into implementation from a DISCOVERY entry).
        assert.strictEqual(result.currentStage, STAGE_PLAN, `${mode} must reach PLAN`);
        assert.notStrictEqual(result.message, NOTE_DISCOVERY_PARK_AWAITING_RCA);
        assert.strictEqual(
          stateRepo.savedSnapshot.currentStage,
          STAGE_PLAN,
          `${mode} must checkpoint the advanced stage`
        );
      }
    });
  });
});
