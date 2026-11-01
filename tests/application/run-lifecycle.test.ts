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
  ValidationError,
  InvalidTransitionError,
  WorktreeCreationError,
  NOTE_DISCOVERY_PARK_AWAITING_RCA,
  NOTE_YOLO_PARKED_AT_DISCOVERY,
  // Issue #259: the operator-facing strings of the VACUOUS refusal and of the
  // implementation-evidence line. Imported, never re-typed.
  NOTE_GATES_VACUOUS_STANDARD,
  NOTE_GATES_VACUOUS_YOLO,
  DEFAULT_CB_MAX_GATE_RETRIES,
  GATE_CIRCUIT_BREAKER,
  STATUS_FAILED,
  HEADER_QUALITY_GATE_REPORT,
  LABEL_OVERALL_VERDICT,
  LABEL_IMPLEMENTATION_EVIDENCE,
  LABEL_IMPLEMENTATION_EVIDENCE_LINE,
  LABEL_BASE_FRESHNESS,
  LABEL_BASE_FRESHNESS_LINE
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

    const stdout = 'ℹ tests 10\nℹ pass 10\nℹ fail 0\nBuild completed successfully';
    return {
      command: cmd,
      // Issue #412: an exit-0 test command with no positive test total is a
      // gate failure, so the mock must print a parseable summary.
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
  /** Counts real provisioning attempts so "no worktree was created" is observable. */
  public createWorktreeCallCount = 0;

  public async createWorktree(params: any): Promise<any> {
    this.createWorktreeCallCount++;
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

/**
 * Records provisioning/teardown calls IN ORDER, so "was provenance captured
 * before provisioning?" and "what was removed?" are observable assertions
 * (issue #420).
 */
class RecordingWorktreeManager {
  public calls: string[] = [];
  public removedOptions: any[] = [];
  public deletedBranches: any[] = [];

  /** Pre-provisioning state the recorder reports; configurable per case. */
  public existingWorktreePaths: string[] = [];
  public existingBranches: readonly string[] | null = ['main'];

  public listWorktreesError: Error | null = null;
  public listBranchesError: Error | null = null;
  public removeWorktreeError: Error | null = null;

  public createWorktreeCount = 0;

  public async listWorktrees(): Promise<any[]> {
    this.calls.push('listWorktrees');
    if (this.listWorktreesError) throw this.listWorktreesError;
    return this.existingWorktreePaths.map((worktreePath) =>
      WorktreeDescriptor.create({
        taskId: 32,
        worktreePath,
        branch: 'task/32',
        baseBranch: 'main'
      })
    );
  }

  public async listBranches(): Promise<readonly string[]> {
    this.calls.push('listBranches');
    if (this.listBranchesError) throw this.listBranchesError;
    return this.existingBranches ?? [];
  }

  public async createWorktree(): Promise<any> {
    this.calls.push('createWorktree');
    this.createWorktreeCount++;
    return WorktreeDescriptor.create({
      taskId: 32,
      worktreePath: '/mock/workspace/.worktrees/32',
      branch: 'task/32',
      baseBranch: 'main'
    });
  }

  public async removeWorktree(options: any): Promise<void> {
    this.calls.push('removeWorktree');
    this.removedOptions.push(options);
    if (this.removeWorktreeError) throw this.removeWorktreeError;
  }

  public async deleteBranch(options: any): Promise<void> {
    this.calls.push('deleteBranch');
    this.deletedBranches.push(options);
  }

  public async resolveTaskWorktreePath(): Promise<string> {
    return '/mock/workspace/.worktrees/32';
  }
}

/**
 * The implementation-evidence probe (issue #259). Injected so the verdict is
 * deterministic — no real git repository is involved.
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

  /**
   * The verdict of a tree that carries a real implementation (issue #259,
   * S11). The cases that are ABOUT the fast-path over an implemented tree
   * inject it explicitly, so the precondition is a statement of the test
   * instead of an accident of the mock's `git status` answer.
   */
  const IMPLEMENTATION_PRESENT_VERDICT = {
    hasChanges: true,
    baseRef: 'main',
    trackedChangedFiles: ['src/index.ts'],
    untrackedFiles: [],
    probeError: null,
    rawStatus: 'M  src/index.ts\n'
  };

  /**
   * The verdict of a tree that was read and carries NO implementation
   * (issue #259, S11).
   */
  const NO_IMPLEMENTATION_VERDICT = {
    hasChanges: false,
    baseRef: 'main',
    trackedChangedFiles: [],
    untrackedFiles: [],
    probeError: null,
    rawStatus: ''
  };

  /**
   * A lifecycle whose implementation-evidence probe returns an EXPLICIT
   * verdict (issue #259, S11). The shared fixture in `beforeEach` is
   * untouched: the migration is per case.
   */
  function buildLifecycleWithProbe(verdict: any): any {
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
      detectImplementationDiffUseCase: new MockDetectImplementationDiffUseCase(verdict)
    });
  }

  describe('1. Full Unattended Fast-Path Loop (yolo --commit-after)', () => {
    test('executes entire continuous lifecycle in single run to COMPLETED when the injected probe reports an implementation', async () => {
      // Issue #259 (S11): the implementation-evidence verdict is INJECTED, so
      // "an implementation exists" is a statement of this case and not an
      // accident of the mock's `git status` answer.
      const lifecycle = buildLifecycleWithProbe(IMPLEMENTATION_PRESENT_VERDICT);

      const result = await lifecycle.execute({
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
      // Issue #379: a feature issue enters PLAN directly, so no phantom
      // DISCOVERY transition appears in the uninterrupted flow.
      assert.deepStrictEqual(history, [
        STAGE_INITIALIZED,
        STAGE_PLAN,
        STAGE_IMPLEMENT,
        STAGE_QUALITY_GATE,
        STAGE_REVIEW,
        STAGE_COMMIT,
        STAGE_COMPLETED
      ]);
    });

    test('yolo mode without commitAfter pauses at COMMIT gate when the injected probe reports an implementation', async () => {
      // Issue #259 (S11): the implementation-evidence verdict is INJECTED, so
      // "an implementation exists" is a statement of this case and not an
      // accident of the mock's `git status` answer.
      const lifecycle = buildLifecycleWithProbe(IMPLEMENTATION_PRESENT_VERDICT);

      const result = await lifecycle.execute({
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

    test('yolo with passing gates and absent critique pauses at COMMIT without reverting when the injected probe reports an implementation (issue #236, AC1)', async () => {
      // Production absence path: gateway normalizes "critique missing" to a bypassed report.
      critique.reviewResult = AiReviewReport.bypassed('Critique CLI binary not found.');

      // Issue #259 (S11): the implementation-evidence verdict is INJECTED, so
      // "an implementation exists" is a statement of this case and not an
      // accident of the mock's `git status` answer.
      const lifecycle = buildLifecycleWithProbe(IMPLEMENTATION_PRESENT_VERDICT);

      const result = await lifecycle.execute({
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

    test('yolo parks at IMPLEMENT and never reaches the COMMIT gate when the injected probe reports no implementation (issue #259)', async () => {
      // Issue #259 (S11): the explicit negative case the file did not have.
      // The implementation-evidence verdict is INJECTED, so "no
      // implementation" is a statement of this case and not an accident of the
      // mock's `git status` answer.
      const lifecycle = buildLifecycleWithProbe(NO_IMPLEMENTATION_VERDICT);

      const result = await lifecycle.execute({
        mode: MODE_YOLO,
        commitAfter: false,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      // A park is a deliberate, checkpointed halt — not a failure.
      assert.strictEqual(result.success, true, `the park must succeed, got: ${result.message}`);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT, 'the stage must stay at IMPLEMENT');
      assert.strictEqual(result.implementationHalted, true);

      // Nothing was certified, reviewed or published.
      assert.strictEqual(result.qualityGateResult, undefined, 'the gates must not certify an unimplemented tree');
      assert.strictEqual(result.reviewResult, undefined, 'the review must not run over an unimplemented tree');
      assert.strictEqual(result.executeCommitResult, undefined, 'no commit may be published');
      assert.strictEqual(result.pausedAtGate, undefined, 'a park is not a human gate');

      // No gate command ran over the unimplemented tree.
      for (const gateCommand of ['npm run build', 'npm run typecheck', 'npm test']) {
        assert.ok(
          !commandExecutor.executedCommands.includes(gateCommand),
          `no gate command may run, got: ${commandExecutor.executedCommands.join(', ')}`
        );
      }

      // The checkpoint records the park.
      assert.ok(stateRepo.savedSnapshot, 'a checkpoint must be persisted');
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_IMPLEMENT);
      assert.notStrictEqual(stateRepo.savedSnapshot.currentStage, STAGE_COMMIT);
      assert.notStrictEqual(stateRepo.savedSnapshot.currentStage, STAGE_COMPLETED);
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
      // A pristine discovery scaffold: the RCA report exists but is unfilled.
      planGenerator.planContent = [
        '# [Discovery] - probe',
        '',
        '## 1. Problem Statement & Symptoms',
        '- **Observed Behavior:**',
        '- **Expected Behavior:**'
      ].join('\n');

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        type: 'discovery',
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.pausedAtGate, undefined);
      // Issue #379: a discovery entry must not claim it advanced past the RCA
      // stage; it parks with the evidence message (B5: the standard leg is no
      // longer silent).
      assert.strictEqual(result.planResult?.discoveryParked, true);
      assert.match(result.message ?? '', /Parked at DISCOVERY/);
      assert.match(result.message ?? '', /Checked:/);
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

    test('mode "plan" for a bug issue parks at DISCOVERY', async () => {
      // The stub decides the kind from the LABEL, not from --type (issue #379).
      githubGateway.fetchIssue = async (num: number) =>
        ({
          number: num,
          title: 'Login screen crashes on submit',
          body: 'Repro steps attached.',
          labels: ['bug'],
          comments: [],
          state: 'OPEN'
        }) as any;
      // A pristine discovery scaffold: the report exists but carries no RCA.
      planGenerator.planContent = [
        '# [Discovery] - Login screen crashes on submit',
        '',
        '## 1. Problem Statement & Symptoms',
        '- **Observed Behavior:**',
        '- **Expected Behavior:**',
        '',
        '## 2. Root Cause Analysis (RCA)',
        '- **Investigation Steps:**',
        '- **Identified Failure Mode:**'
      ].join('\n');

      const result = await lifecycleUseCase.execute({
        mode: MODE_PLAN,
        issue: 32,
        title: 'Login screen crashes on submit',
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_PLAN);
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.pausedAtGate, undefined);
      assert.strictEqual(result.planResult?.discoveryParked, true);
      assert.ok(
        result.message?.startsWith(NOTE_DISCOVERY_PARK_AWAITING_RCA),
        `the bug entry must print the RCA park message, got: ${result.message}`
      );
      assert.match(result.message ?? '', /Checked:/);
      assert.strictEqual(planGenerator.scaffoldCalls.length, 1);
      assert.strictEqual(planGenerator.scaffoldCalls[0].type, 'discovery');
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
      assert.ok(
        !stateRepo.savedSnapshot.history.some((h: any) => h.stage === STAGE_PLAN),
        'a bug entry must record no PLAN transition'
      );
    });

    test('mode "plan" for a bug issue still plans when --type implementation overrides the label', async () => {
      githubGateway.fetchIssue = async (num: number) =>
        ({
          number: num,
          title: 'Login screen crashes on submit',
          body: 'Repro steps attached.',
          labels: ['bug'],
          comments: [],
          state: 'OPEN'
        }) as any;

      const result = await lifecycleUseCase.execute({
        mode: MODE_PLAN,
        issue: 32,
        type: 'implementation',
        title: 'Login screen crashes on submit',
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_PLAN);
      assert.strictEqual(result.pausedAtGate, undefined);
      assert.strictEqual(result.planResult?.discoveryParked, false);
      assert.strictEqual(result.message, `Pipeline advanced to ${STAGE_PLAN}.`);
      const planEntry = stateRepo.savedSnapshot.history
        .filter((h: any) => h.stage === STAGE_PLAN)
        .pop();
      assert.strictEqual(planEntry.metadata.entrySource, 'type-override');
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

    test('implement mode stops at IMPLEMENT on an unchanged tree — it runs no gate command and never reaches the COMMIT gate (issue #259 cross-mode invariant)', async () => {
      // Issue #259 (S9/Q11): the CROSS-MODE invariant — no lifecycle path may
      // advance past IMPLEMENT to QUALITY_GATE without positive evidence that
      // the implementation exists. `codeloop implement` already satisfies it:
      // it PREPARES and STOPS, handing the operator the next step. This case
      // pins that honest stop, so a future change cannot quietly make the
      // implement path advance past IMPLEMENT and re-open the defect.
      const sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      stateRepo.savedSnapshot = sm.toSnapshot();

      const probe = new MockDetectImplementationDiffUseCase(NO_IMPLEMENTATION_VERDICT);
      const lifecycle = buildLifecycleWithProbe(NO_IMPLEMENTATION_VERDICT);

      const result = await lifecycle.execute({
        mode: MODE_IMPLEMENT,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.mode, MODE_IMPLEMENT);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT, 'the implement path must stop at IMPLEMENT');
      assert.notStrictEqual(result.currentStage, STAGE_COMMIT);
      assert.ok(result.implementationResult, 'the implementation must be prepared');

      // The evidence half of the invariant: nothing was certified or reviewed.
      assert.strictEqual(result.qualityGateResult, undefined, 'the implement path must run no gate');
      assert.strictEqual(result.reviewResult, undefined, 'the implement path must run no review');
      assert.strictEqual(result.executeCommitResult, undefined, 'the implement path must publish no commit');

      for (const gateCommand of ['npm run build', 'npm run typecheck', 'npm test']) {
        assert.ok(
          !commandExecutor.executedCommands.includes(gateCommand),
          `no gate command may run, got: ${commandExecutor.executedCommands.join(', ')}`
        );
      }

      // The implement path never advances past IMPLEMENT, so it needs no
      // evidence check at all.
      assert.strictEqual(probe.calls.length, 0, 'the implement path must not probe the tree');
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

    function buildLifecycle(
      stage: string,
      prReviewComments: any[] = [{ author: 'r', body: 'fix', category: 'error' }]
    ) {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 32, worktree: mockWorktree });
      (sm as any)._currentStage = stage;
      stateRepo.savedSnapshot = { ...sm.toSnapshot(), currentStage: stage };
      const preflight = {
        execute: async () => ({
          isResume: true,
          resumePrNumber: 5,
          prReviewComments
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

    test('G15: the preflight dispatcher counts the SAME actionable set as `next` (issue #397, D1-AC5)', async () => {
      const actionable = {
        id: 4427630468,
        author: 'critique',
        body: '- [critique]: SUGGESTION - prefer a readonly field.'
      };
      const summary = {
        id: 6531579688,
        author: 'github-actions[bot]',
        body: '### Critique AI Review Run Summary\n\nNo critical, error or warning findings.'
      };

      const lifecycle = buildLifecycle(STAGE_IMPLEMENT, [actionable, summary]);
      const result = await lifecycle.execute({ mode: MODE_STANDARD, issue: 32, workspaceDir: '/mock/workspace' });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_TRIAGE);

      const payload = stateRepo.savedSnapshot.triagePayload;
      assert.strictEqual(
        payload.split('\n').filter((line: string) => line.trim()).length,
        1,
        `the payload must carry only the actionable item, got: ${payload}`
      );
      assert.ok(
        !payload.includes('Critique AI Review Run Summary'),
        'the repository summary must not be routed as feedback'
      );

      const triageEntry = stateRepo.savedSnapshot.history
        .filter((h: any) => h.stage === STAGE_TRIAGE)
        .pop();
      assert.strictEqual(triageEntry.metadata.commentsCount, 1);
    });

    test('G15b: a preflight carrying only the automated summary does not route to TRIAGE (issue #397)', async () => {
      const lifecycle = buildLifecycle(STAGE_DISCOVERY, [
        {
          id: 6531579688,
          author: 'github-actions[bot]',
          body: '### Critique AI Review Run Summary\n\nNo critical, error or warning findings.'
        }
      ]);
      const result = await lifecycle.execute({ mode: MODE_PLAN, issue: 32, workspaceDir: '/mock/workspace' });

      assert.notStrictEqual(result.currentStage, STAGE_TRIAGE);
      assert.notStrictEqual(stateRepo.savedSnapshot.pausedAtGate, GATE_TRIAGE);
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
      // Issue #315 (AC-9): the park records NO pause (`pausedAtGate` is
      // undefined, asserted above), so a resume hint here would be advice the
      // checkpoint cannot honour. The hint is appended only when a pause exists.
      assert.doesNotMatch(result.message, /codeloop resume/);
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
      // #339 (item 3): the fixture is the scenario this test's comment names —
      // a pristine, unpopulated `[Discovery] - ….md` scaffold (proper H1, no
      // content). The old default content (`# Test Plan`) is an
      // implementation-shaped document that DISCOVERY-stage resolution can
      // never return in production and that the kind gate now reports as a
      // TITLE rejection, not a content park.
      planGenerator.planContent = PRISTINE_SCAFFOLD;
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
        // Issue #283: the park names the paths that were checked.
        assert.ok(result.message?.startsWith(NOTE_DISCOVERY_PARK_AWAITING_RCA));
        assert.match(result.message ?? '', /Checked:/);
        assert.doesNotMatch(result.message ?? '', /YOLO cannot dispatch subagents inline/);

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
      // See B1: the content-park fixture must carry the discovery H1 — a
      // foreign first line is now (correctly) reported as a title rejection.
      planGenerator.planContent = PRISTINE_SCAFFOLD;
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
      assert.ok(result.message?.startsWith(NOTE_DISCOVERY_PARK_AWAITING_RCA));
      assert.match(result.message ?? '', /Checked:/);
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
      // See B1: content-park fixture with the discovery H1.
      planGenerator.planContent = PRISTINE_SCAFFOLD;
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
      assert.ok(result.message?.startsWith(NOTE_DISCOVERY_PARK_AWAITING_RCA));
      assert.match(result.message ?? '', /Checked:/);
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

    // ---- issue #306: the park names the evidence, not the shape ----------
    /** A pristine scaffold, as `scaffoldPlanDirectory` would write it. */
    const PRISTINE_SCAFFOLD = `# [Discovery] - probe

**Issue:** #32
**Date:** 2026-10-27
**Author:** AgyLoop Discovery Subagent (Read-Only)

## 1. Problem Statement & Symptoms
- **Observed Behavior:**
- **Expected Behavior:**
- **Affected Components / Paths:**

## 2. Root Cause Analysis (RCA)
- **Investigation Steps:**
- **Identified Failure Mode:**
- **Relevant Code References:**

## 3. Reproduction Steps & Verification Protocol
- **Local Reproduction Command:**
- **Failing Test Target:**

## 4. Remediation Strategy
- **Recommended Fix Approach:**
- **Potential Regressions / Side Effects:**
`;

    /** The prompt-shaped report: `##` headings + prose, no key bullets. */
    const HEADING_SHAPE_REPORT = `# [Discovery] - probe

**Issue:** #32
**Date:** 2026-10-27
**Author:** AgyLoop Discovery Subagent (Read-Only)

## Summary & Symptoms

The yolo re-entry parks before the gates even though the discovery report is complete. Reproduced three times against the current build with a fresh checkpoint.

## Root Cause Analysis

The RCA gate counted one markdown construct instead of measuring content, so a heading-shaped report scored zero filled keys and was read as a scaffold.

## Manual Bug Smoke Test

The reproduction parks with the scaffold message; the same report in bullet shape advances, three times out of three.

## Remediation Strategy

Score content from either shape and make the park name the empty sections and blank keys.
`;

    test('T12: the yolo DISCOVERY park names the missing evidence', async () => {
      seedDiscoveryCheckpoint();
      planGenerator.planContent = PRISTINE_SCAFFOLD;
      const gate = gateMustNotRun();

      const lifecycle = buildYoloLifecycle({ runQualityGateUseCase: gate.useCase });
      const result = await lifecycle.execute({
        mode: MODE_YOLO,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(gate.calls(), 0, 'the park must hold before any gate runs');
      assert.ok(result.message?.startsWith(NOTE_DISCOVERY_PARK_AWAITING_RCA));
      assert.match(result.message ?? '', /Missing evidence/);
      assert.match(result.message ?? '', /Checked:/);
      assert.match(
        result.message ?? '',
        /Problem Statement & Symptoms|Observed Behavior/,
        'the park must name an empty section or a blank template key'
      );
      // AC3: it must no longer call a populated report an unpopulated scaffold.
      assert.doesNotMatch(result.message ?? '', /unpopulated scaffold/);
    });

    test('T13: a heading-style RCA advances a yolo re-entry to the COMMIT gate', async () => {
      // The positive control for T12: without it, a resolver that always parks
      // would satisfy the diagnostics assertion above.
      seedDiscoveryCheckpoint();
      planGenerator.planContent = HEADING_SHAPE_REPORT;
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
      assert.strictEqual(gate.calls(), 1, 'gates must run once the heading RCA exists');
      assert.doesNotMatch(result.message ?? '', /Missing evidence/);
    });
  });

  describe('8. --no-worktree Forwarding Across Modes (issue #247)', () => {
    /**
     * Wraps the REAL StartImplementationUseCase so the params it receives are
     * captured while its provisioning behaviour still runs. A stubbed use case
     * would hide the very regression this block guards (the guardrail is
     * enforced *inside* the use case, from the forwarded flag).
     */
    function captureImplementationParams(lifecycle: any): any[] {
      const captured: any[] = [];
      const lp = lifecycle as any;
      const originalExecute = lp.startImplementationUseCase.execute.bind(lp.startImplementationUseCase);
      lp.startImplementationUseCase.execute = async (params: any) => {
        captured.push(params);
        return originalExecute(params);
      };
      return captured;
    }

    /** Seeds an APPROVAL checkpoint with NO worktree descriptor attached. */
    function seedApprovalCheckpoint(issue: number): void {
      const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      stateRepo.savedSnapshot = sm.toSnapshot();
    }

    test('YOLO mode forwards worktree:false as noWorktree:true into StartImplementationUseCase.execute (issue #247)', async () => {
      const capturedParams = captureImplementationParams(lifecycleUseCase);

      const result = await lifecycleUseCase.execute({
        mode: MODE_YOLO,
        issue: 32,
        worktree: false,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        capturedParams.length,
        1,
        'the YOLO path must call StartImplementationUseCase.execute exactly once'
      );
      assert.strictEqual(
        capturedParams[0].noWorktree,
        true,
        'worktree:false must cross the boundary as noWorktree:true so provisioning truly skips'
      );
      assert.strictEqual(
        worktreeManager.createWorktreeCallCount,
        0,
        '--no-worktree must not provision a worktree in YOLO mode'
      );
      assert.strictEqual(result.worktree, null, 'no worktree descriptor may be reported');
    });

    test('YOLO mode forwards noWorktree:false when the worktree is enabled (negative control, issue #247)', async () => {
      const capturedParams = captureImplementationParams(lifecycleUseCase);

      const result = await lifecycleUseCase.execute({
        mode: MODE_YOLO,
        issue: 32,
        worktree: true,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(capturedParams.length, 1);
      assert.strictEqual(
        capturedParams[0].noWorktree,
        false,
        'a worktree-enabled YOLO run must not claim noWorktree'
      );
      assert.strictEqual(
        worktreeManager.createWorktreeCallCount,
        1,
        'the worktree-enabled YOLO run must still provision exactly one worktree'
      );
    });

    test('STANDARD mode forwards worktree:false as noWorktree:true into StartImplementationUseCase.execute (issue #247)', async () => {
      seedApprovalCheckpoint(32);
      const capturedParams = captureImplementationParams(lifecycleUseCase);

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        worktree: false,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        capturedParams.length,
        1,
        'the STANDARD path must call StartImplementationUseCase.execute exactly once'
      );
      assert.strictEqual(
        capturedParams[0].noWorktree,
        true,
        'worktree:false must cross the boundary as noWorktree:true so provisioning truly skips'
      );
      assert.strictEqual(
        worktreeManager.createWorktreeCallCount,
        0,
        '--no-worktree must not provision a worktree in STANDARD mode'
      );
      assert.strictEqual(result.worktree, null, 'no worktree descriptor may be reported');
    });

    test('STANDARD mode forwards noWorktree:false when the worktree is enabled (negative control, issue #247)', async () => {
      seedApprovalCheckpoint(32);
      const capturedParams = captureImplementationParams(lifecycleUseCase);

      const result = await lifecycleUseCase.execute({
        mode: MODE_STANDARD,
        issue: 32,
        worktree: true,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(capturedParams.length, 1);
      assert.strictEqual(
        capturedParams[0].noWorktree,
        false,
        'a worktree-enabled STANDARD run must not claim noWorktree'
      );
      assert.strictEqual(
        worktreeManager.createWorktreeCallCount,
        1,
        'the worktree-enabled STANDARD run must still provision exactly one worktree'
      );
    });
  });

  // ------------------------------------------------------------------------
  // Issue #259 (AC2): the VACUOUS gate verdict reaches BOTH gate-failure
  // branches, and in neither of them is it a failure.
  //
  //   - the STANDARD loop must not start failing on an unchanged tree
  //     (it reports the refusal truthfully and returns success === true);
  //   - the STANDARD loop must not lose its gates over an implemented tree
  //     (the commands still run and the report still says PASSED);
  //   - the YOLO branch must treat a VACUOUS verdict as a refusal, so it
  //     consumes NO gate retry and never trips the circuit breaker.
  //
  // The verdict is driven deterministically by injecting the probe.
  // ------------------------------------------------------------------------
  describe('9. Implementation evidence in the lifecycle (issue #259)', () => {
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

    /** The `Implementation : N file(s) changed relative to '<baseRef>'` line. */
    function evidenceLine(count: number, baseRef: string): string {
      return LABEL_IMPLEMENTATION_EVIDENCE_LINE.replace('{label}', LABEL_IMPLEMENTATION_EVIDENCE)
        .replace('{count}', String(count))
        .replace('{baseRef}', baseRef);
    }

    /** The `Base freshness : …` advisory line (issue #263). */
    function freshnessLine(ahead: number, own: number, mergeBase: string, baseRef = 'main'): string {
      return LABEL_BASE_FRESHNESS_LINE.replace('{label}', LABEL_BASE_FRESHNESS)
        .replace('{ahead}', String(ahead))
        .replace('{baseRef}', baseRef)
        .replace('{own}', String(own))
        .replace('{mergeBase}', mergeBase.slice(0, 7));
    }

    /** Seeds a checkpoint at IMPLEMENT — the IMPLEMENT -> QUALITY_GATE boundary. */
    function seedImplementCheckpoint(mode: string, gateRetries = 0): void {
      const sm = StateMachine.createInitial({ mode, issue: 32, worktree: mockWorktree });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      if (mode === MODE_STANDARD) {
        // The standard loop reaches IMPLEMENT through the APPROVAL gate.
        sm.transition(STAGE_APPROVAL);
      }
      sm.transition(STAGE_IMPLEMENT);
      stateRepo.savedSnapshot = { ...sm.toSnapshot(), implementToGateLoops: gateRetries };
    }

    /** The lifecycle with the shared mocks plus the injected probe. */
    function buildLifecycle(verdict: any, extraDeps: any = {}): any {
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
        detectImplementationDiffUseCase: new MockDetectImplementationDiffUseCase(verdict),
        ...extraDeps
      });
    }

    test('V4 (AC2, standard mode): a standard-mode run on an unchanged tree reports the VACUOUS refusal with success === true and never "Quality gates failed" or "reverted to IMPLEMENT"', async () => {
      seedImplementCheckpoint(MODE_STANDARD);
      const probe = new MockDetectImplementationDiffUseCase(unchangedVerdict('main'));
      const lifecycle = buildLifecycle(unchangedVerdict('main'), {
        detectImplementationDiffUseCase: probe
      });

      const result = await lifecycle.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(
        result.success,
        true,
        `a VACUOUS verdict is a refusal, not a failure; got: ${result.message}`
      );
      assert.ok(result.qualityGateResult, 'the gate result must be surfaced');
      assert.strictEqual(result.qualityGateResult.passed, false);
      assert.strictEqual(result.qualityGateResult.vacuous, true);
      assert.strictEqual(
        result.currentStage,
        STAGE_IMPLEMENT,
        'the stage was never advanced, so nothing was reverted'
      );
      assert.strictEqual(result.pausedAtGate, undefined, 'a refusal is not a human gate');

      assert.strictEqual(result.message, NOTE_GATES_VACUOUS_STANDARD.replace('{baseRef}', 'main'));
      assert.ok(
        !String(result.message).includes('Quality gates failed'),
        `the refusal must not claim the gates failed, got: ${result.message}`
      );
      assert.ok(
        !/reverted/i.test(String(result.message)),
        `the refusal must not claim a revert, got: ${result.message}`
      );

      // No gate command ran over the unimplemented tree.
      assert.ok(
        !commandExecutor.executedCommands.includes('npm test'),
        `no gate command may run, got: ${commandExecutor.executedCommands.join(', ')}`
      );

      // The retry counter is untouched: a refusal must never consume a retry.
      assert.strictEqual(result.stateMachine.implementToGateLoops, 0);

      // The probe ran exactly once, at the IMPLEMENT -> QUALITY_GATE boundary.
      assert.strictEqual(probe.calls.length, 1);
    });

    test('V5 (AC2, standard mode): a standard-mode run on a tree that contains the implementation still executes the gate commands and reports PASSED', async () => {
      seedImplementCheckpoint(MODE_STANDARD);
      const lifecycle = buildLifecycle(changedVerdict('main'));

      const result = await lifecycle.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.qualityGateResult, 'the gate result must be surfaced');
      assert.strictEqual(result.qualityGateResult.passed, true);
      assert.strictEqual(result.qualityGateResult.vacuous, false);

      // The gates really ran.
      assert.ok(
        commandExecutor.executedCommands.includes('npm test'),
        `the gate commands must still run over an implemented tree, got: ${commandExecutor.executedCommands.join(', ')}`
      );
      assert.ok(
        result.qualityGateResult.summaryReport.includes('PASSED'),
        `the gates must still report PASSED, got:\n${result.qualityGateResult.summaryReport}`
      );
      assert.ok(
        result.qualityGateResult.summaryReport.includes(evidenceLine(1, 'main')),
        `the report must carry the implementation-evidence line, got:\n${result.qualityGateResult.summaryReport}`
      );

      // The standard loop is not degraded: it still advances past the gates.
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
    });

    test('V6 (AC2, YOLO defence-in-depth): a VACUOUS gate verdict reaching the YOLO gate-failure branch returns success === true, consumes no gate retry, and does not trip the circuit breaker', async () => {
      // The gate-retry counter starts AT the circuit-breaker limit: a genuine
      // gate failure would trip the breaker here, so a VACUOUS verdict that
      // does NOT trip it is proven to be exempt from the breaker.
      seedImplementCheckpoint(MODE_YOLO, DEFAULT_CB_MAX_GATE_RETRIES);

      const vacuousGate = {
        execute: async (params: any) => ({
          passed: false,
          vacuous: true,
          currentStage: STAGE_IMPLEMENT,
          stateMachine: StateMachine.fromSnapshot(stateRepo.savedSnapshot),
          reports: [],
          totalDurationMs: 0,
          summaryReport: `${HEADER_QUALITY_GATE_REPORT}\n${LABEL_OVERALL_VERDICT} : VACUOUS\n`,
          buildStatus: STATUS_FAILED,
          testsStatus: STATUS_FAILED,
          gateReport: undefined,
          diagnosticSnippet: null,
          implementationDiff: params.implementationDiff
        })
      };

      const lifecycle = buildLifecycle(changedVerdict('main'), {
        runQualityGateUseCase: vacuousGate
      });

      const result = await lifecycle.execute({
        mode: MODE_YOLO,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(
        result.success,
        true,
        `a VACUOUS verdict is a refusal, not a failure; got: ${result.message}`
      );
      assert.ok(result.qualityGateResult);
      assert.strictEqual(result.qualityGateResult.vacuous, true);
      assert.strictEqual(result.message, NOTE_GATES_VACUOUS_YOLO);
      assert.ok(
        !String(result.message).includes('Quality gates failed'),
        `the refusal must not claim the gates failed, got: ${result.message}`
      );
      assert.ok(
        !/reverted/i.test(String(result.message)),
        `the refusal must not claim a revert, got: ${result.message}`
      );

      // The circuit breaker did not trip.
      assert.notStrictEqual(result.pausedAtGate, GATE_CIRCUIT_BREAKER);
      assert.strictEqual(result.pausedAtGate, undefined);
      assert.notStrictEqual(
        stateRepo.savedSnapshot?.pausedAtGate,
        GATE_CIRCUIT_BREAKER,
        'no breaker pause may be persisted'
      );

      // No gate retry was consumed.
      assert.strictEqual(
        result.stateMachine.implementToGateLoops,
        DEFAULT_CB_MAX_GATE_RETRIES,
        'a VACUOUS verdict must not consume a gate retry'
      );

      // Control: the SAME scenario with a genuine (non-VACUOUS) gate failure
      // DOES trip the breaker — so the assertions above are meaningful.
      seedImplementCheckpoint(MODE_YOLO, DEFAULT_CB_MAX_GATE_RETRIES);
      const failingGate = {
        execute: async (params: any) => ({
          passed: false,
          vacuous: false,
          currentStage: STAGE_IMPLEMENT,
          stateMachine: StateMachine.fromSnapshot(stateRepo.savedSnapshot),
          reports: [],
          totalDurationMs: 0,
          summaryReport: `${HEADER_QUALITY_GATE_REPORT}\n${LABEL_OVERALL_VERDICT} : FAILED\n`,
          buildStatus: STATUS_FAILED,
          testsStatus: STATUS_FAILED,
          gateReport: undefined,
          diagnosticSnippet: null,
          implementationDiff: params.implementationDiff
        })
      };
      const controlLifecycle = buildLifecycle(changedVerdict('main'), {
        runQualityGateUseCase: failingGate
      });

      const control = await controlLifecycle.execute({
        mode: MODE_YOLO,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(control.success, false);
      assert.strictEqual(
        control.pausedAtGate,
        GATE_CIRCUIT_BREAKER,
        'a genuine gate failure at the retry limit must still trip the breaker'
      );
    });

    test('L2 (AC5): the lifecycle gate report prints exactly the merge-base-relative count the probe measured', async () => {
      seedImplementCheckpoint(MODE_STANDARD);
      const verdict = {
        ...changedVerdict('main'),
        trackedChangedFiles: ['src/a.ts', 'src/b.ts'],
        untrackedFiles: ['src/c.ts'],
        measurementError: null,
        mergeBase: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        baseAheadCommits: 0,
        ownCommits: 1
      };
      const lifecycle = buildLifecycle(verdict);

      const result = await lifecycle.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.ok(result.qualityGateResult);
      assert.ok(
        result.qualityGateResult.summaryReport.includes(evidenceLine(3, 'main')),
        `2 tracked + 1 untracked must print as 3, got:\n${result.qualityGateResult.summaryReport}`
      );
      assert.ok(
        !result.qualityGateResult.summaryReport.includes(LABEL_BASE_FRESHNESS),
        `an up-to-date branch must not print a freshness line, got:\n${result.qualityGateResult.summaryReport}`
      );
    });

    test('L3 (AC6): an advanced base branch makes the lifecycle gate report carry the freshness numbers without blocking the run', async () => {
      seedImplementCheckpoint(MODE_STANDARD);
      const verdict = {
        ...changedVerdict('main'),
        measurementError: null,
        mergeBase: '1823dbf0123456789abcdef0123456789abcdef0',
        baseAheadCommits: 2,
        ownCommits: 1
      };
      const lifecycle = buildLifecycle(verdict);

      const result = await lifecycle.execute({
        mode: MODE_STANDARD,
        issue: 32,
        workspaceDir: '/mock/workspace'
      });

      assert.ok(result.qualityGateResult);
      assert.ok(
        result.qualityGateResult.summaryReport.includes(
          freshnessLine(2, 1, '1823dbf0123456789abcdef0123456789abcdef0')
        ),
        `the freshness line must carry the exact numbers, got:\n${result.qualityGateResult.summaryReport}`
      );
      assert.strictEqual(
        result.currentStage,
        STAGE_COMMIT,
        'staleness is advisory — the run must still advance'
      );
    });
  });

  /**
   * Issue #250 (R9): the RESOLVED checkpoint is authoritative about its own
   * issue.
   *
   * With the scope applied, `sm` is the checkpoint the operator's issue (or the
   * scan) named. A path/branch inference may only SUPPLY an issue for a
   * checkpoint that has NONE — it must never RELABEL a resolved one, or the
   * scoped file would be rewritten with someone else's issue number.
   */
  describe('the resolved checkpoint keeps its own issue (R9)', () => {
    test('a branch-inferred issue never relabels a checkpoint that already has one', async () => {
      const scopedRepo = new MockStateRepository({
        version: '1.0.0',
        currentStage: STAGE_INITIALIZED,
        mode: MODE_STANDARD,
        issue: 250,
        baseBranch: 'phase/6-codeloop',
        createdAt: '2026-10-19T09:00:00.000Z',
        updatedAt: '2026-10-19T09:00:00.000Z',
        history: [{ stage: STAGE_INITIALIZED, timestamp: '2026-10-19T09:00:00.000Z' }]
      });

      // The cwd/branch hint points at a DIFFERENT issue (251).
      const branchWorktreeManager: any = new MockWorktreeManager();
      branchWorktreeManager.resolveBaseBranch = async () => 'task/251-x';

      const scopedLifecycle = new RunLifecycleUseCase({
        stateRepo: scopedRepo,
        configRepo: new MockConfigRepository(),
        planGenerator: new MockPlanGenerator(),
        githubGateway: new MockGitHubGateway(),
        commandExecutor: new MockCommandExecutor(),
        buildDetector: new MockBuildDetector(),
        standardsRepo: new MockStandardsRepository(),
        critique: new MockCritique(),
        confirmationPrompt: new MockConfirmationPrompt(),
        worktreeManager: branchWorktreeManager
      });

      const result = await scopedLifecycle.execute({
        mode: MODE_STANDARD,
        workspaceDir: '/mock/workspace'
      });

      assert.strictEqual(
        scopedRepo.savedSnapshot.issue,
        250,
        'the resolved checkpoint must keep its own issue (251 was only an inference)'
      );
      assert.strictEqual(result.stateMachine.issue, 250);
    });
  });

  /**
   * Issue #420: implement mode provisions the worktree BEFORE the plan guards
   * run inside `StartImplementationUseCase`, so a refusal has to undo ONLY what
   * this invocation created. These cases drive `RunLifecycleUseCase` in implement
   * mode with a recording manager and a throwing/`resolving` stage use case.
   */
  describe('10. implement-mode provisioning teardown (#420)', () => {
    const SEEDED_UPDATED_AT = '2026-11-01T00:00:00.000Z';
    const DESCRIPTOR_PATH = '/mock/workspace/.worktrees/32';
    const BRANCH = 'task/32';

    function seedApprovalSnapshot(overrides: Record<string, any> = {}): any {
      return {
        version: '1.0.0',
        currentStage: STAGE_APPROVAL,
        mode: MODE_IMPLEMENT,
        issue: 32,
        milestoneTitle: null,
        baseBranch: 'main',
        worktree: null,
        planDir: '/mock/workspace/artifacts/plans/32-test-feature',
        planPath: null,
        approvedPlanDigest: 'seeded-approved-digest',
        approvedPlanPath: '/mock/workspace/artifacts/plans/32-test-feature/implementation_plan.md',
        triagePayload: null,
        triageDisposition: null,
        createdAt: SEEDED_UPDATED_AT,
        updatedAt: SEEDED_UPDATED_AT,
        history: [{ stage: STAGE_APPROVAL, timestamp: SEEDED_UPDATED_AT }],
        pausedAtGate: GATE_APPROVAL,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0,
        ...overrides
      };
    }

    /** Seeds the checkpoint and returns the manager + a lifecycle whose stage throws. */
    function buildRefusingLifecycle(
      error: Error,
      configure?: (manager: RecordingWorktreeManager) => void
    ): { manager: RecordingWorktreeManager; lifecycle: any; seeded: any; progress: string[] } {
      const manager = new RecordingWorktreeManager();
      configure?.(manager);
      const seeded = seedApprovalSnapshot();
      stateRepo = new MockStateRepository(seeded);
      const progress: string[] = [];
      const lifecycle = new RunLifecycleUseCase({
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway,
        commandExecutor,
        buildDetector,
        standardsRepo,
        critique,
        confirmationPrompt,
        worktreeManager: manager,
        // Deterministic seams: no real git probing and no pre-flight network.
        inferBaseBranchUseCase: {
          execute: async () => ({ baseBranch: 'main', taskBranchPrefix: 'task' })
        } as any,
        runPreFlightCheckUseCase: {
          execute: async () => ({
            action: 'PROCEED',
            message: '',
            canProceed: true,
            isHalt: false,
            isResume: false
          })
        } as any,
        startImplementationUseCase: {
          execute: async () => {
            throw error;
          }
        } as any
      });
      return { manager, lifecycle, seeded, progress };
    }

    function runParams(extra: Record<string, any> = {}): any {
      return {
        mode: MODE_IMPLEMENT,
        issue: 32,
        workspaceDir: '/mock/workspace',
        ...extra
      };
    }

    function pick(snapshot: any): any {
      return {
        currentStage: snapshot.currentStage,
        worktree: snapshot.worktree,
        baseBranch: snapshot.baseBranch,
        pausedAtGate: snapshot.pausedAtGate,
        approvedPlanDigest: snapshot.approvedPlanDigest,
        updatedAt: snapshot.updatedAt
      };
    }

    test('IMPL-420-1: a refused guard discards the worktree and branch it created and restores the checkpoint', async () => {
      const guardError = new ValidationError('planBaseline', 'BL-1', 'claim BL-1 exited 2');
      const { manager, lifecycle, seeded } = buildRefusingLifecycle(guardError);

      await assert.rejects(
        () => lifecycle.execute(runParams()),
        (err: any) => {
          assert.strictEqual(err, guardError, 'the guard error must be rethrown unchanged');
          assert.strictEqual(err.field, 'planBaseline');
          return true;
        }
      );

      assert.deepStrictEqual(
        manager.calls,
        ['listWorktrees', 'listBranches', 'createWorktree', 'removeWorktree', 'deleteBranch'],
        'provenance must be captured BEFORE provisioning, then the created worktree/branch removed'
      );

      assert.strictEqual(manager.removedOptions.length, 1);
      assert.deepStrictEqual(manager.removedOptions[0], {
        worktreePath: DESCRIPTOR_PATH,
        workspaceDir: '/mock/workspace',
        force: true,
        prune: true,
        tolerateMissing: true
      });
      assert.notStrictEqual(
        manager.removedOptions[0].allowExternal,
        true,
        'the refusal cleanup must never opt into external worktrees'
      );

      assert.deepStrictEqual(manager.deletedBranches, [
        { branchName: BRANCH, workspaceDir: '/mock/workspace' }
      ]);

      assert.strictEqual(stateRepo.savedSnapshot.worktree, null);
      assert.deepStrictEqual(pick(stateRepo.savedSnapshot), pick(seeded));
    });

    test('IMPL-420-2: a branch that existed before the run survives the refusal', async () => {
      const { manager, lifecycle, seeded } = buildRefusingLifecycle(
        new ValidationError('planBaseline', 'BL-1', 'claim BL-1 exited 2'),
        (m) => {
          m.existingBranches = ['main', BRANCH];
        }
      );

      await assert.rejects(() => lifecycle.execute(runParams()));

      assert.strictEqual(manager.removedOptions.length, 1);
      assert.deepStrictEqual(manager.deletedBranches, [], 'a pre-existing branch must never be deleted');
      assert.deepStrictEqual(pick(stateRepo.savedSnapshot), pick(seeded));
    });

    test('IMPL-420-3: an adopted/pre-existing worktree survives and stays visible on the checkpoint', async () => {
      const { manager, lifecycle } = buildRefusingLifecycle(
        new ValidationError('planBaseline', 'BL-1', 'claim BL-1 exited 2'),
        (m) => {
          m.existingWorktreePaths = [DESCRIPTOR_PATH];
        }
      );

      await assert.rejects(() => lifecycle.execute(runParams()));

      assert.strictEqual(manager.calls.includes('removeWorktree'), false);
      assert.strictEqual(manager.calls.includes('deleteBranch'), false);
      assert.ok(
        stateRepo.savedSnapshot.worktree,
        'the descriptor must be kept so the surviving worktree stays discoverable'
      );
    });

    test('IMPL-420-4: a checkpoint that already carries a descriptor captures no provenance and removes nothing', async () => {
      const manager = new RecordingWorktreeManager();
      const seeded = seedApprovalSnapshot({
        worktree: {
          taskId: '32',
          worktreePath: DESCRIPTOR_PATH,
          branch: BRANCH,
          baseBranch: 'main'
        }
      });
      stateRepo = new MockStateRepository(seeded);
      const lifecycle = new RunLifecycleUseCase({
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway,
        commandExecutor,
        buildDetector,
        standardsRepo,
        critique,
        confirmationPrompt,
        worktreeManager: manager,
        inferBaseBranchUseCase: {
          execute: async () => ({ baseBranch: 'main', taskBranchPrefix: 'task' })
        } as any,
        runPreFlightCheckUseCase: {
          execute: async () => ({
            action: 'PROCEED',
            message: '',
            canProceed: true,
            isHalt: false,
            isResume: false
          })
        } as any,
        startImplementationUseCase: {
          execute: async () => {
            throw new ValidationError('approvedPlanDigest', null, 'changed after approval');
          }
        } as any
      });

      await assert.rejects(() => lifecycle.execute(runParams()));

      assert.strictEqual(manager.calls.includes('listWorktrees'), false);
      assert.strictEqual(manager.calls.includes('listBranches'), false);
      assert.strictEqual(manager.calls.includes('removeWorktree'), false);
      assert.strictEqual(manager.calls.includes('deleteBranch'), false);
      assert.ok(stateRepo.savedSnapshot.worktree, 'the pre-existing descriptor must survive');
    });

    test('IMPL-420-5: a non-refusal error is not torn down', async () => {
      const boom = new WorktreeCreationError('createWorktree', 'boom');
      const { manager, lifecycle } = buildRefusingLifecycle(boom);

      await assert.rejects(
        () => lifecycle.execute(runParams()),
        (err: any) => err === boom
      );

      assert.strictEqual(manager.calls.includes('removeWorktree'), false);
      assert.strictEqual(manager.calls.includes('deleteBranch'), false);
      assert.ok(stateRepo.savedSnapshot.worktree, 'the descriptor written by provisioning must be kept');
    });

    test('IMPL-420-6: InvalidTransitionError is a refusal and is cleaned up', async () => {
      const guardError = new InvalidTransitionError(
        STAGE_DISCOVERY,
        STAGE_IMPLEMENT,
        MODE_IMPLEMENT,
        'Cannot start implementation from DISCOVERY.'
      );
      const { manager, lifecycle, seeded } = buildRefusingLifecycle(guardError);

      await assert.rejects(
        () => lifecycle.execute(runParams()),
        (err: any) => err === guardError
      );

      assert.strictEqual(manager.removedOptions.length, 1);
      assert.strictEqual(manager.deletedBranches.length, 1);
      assert.deepStrictEqual(pick(stateRepo.savedSnapshot), pick(seeded));
    });

    test('IMPL-420-7: a failed teardown keeps the descriptor and warns the operator', async () => {
      const guardError = new ValidationError('planBaseline', 'BL-1', 'claim BL-1 exited 2');
      const { manager, lifecycle, progress } = buildRefusingLifecycle(guardError, (m) => {
        m.removeWorktreeError = new Error('worktree is locked');
      });

      await assert.rejects(
        () =>
          lifecycle.execute(
            runParams({ onProgress: (message: string) => progress.push(message) })
          ),
        (err: any) => err === guardError
      );

      assert.strictEqual(manager.deletedBranches.length, 0);
      assert.ok(stateRepo.savedSnapshot.worktree, 'the descriptor must survive a failed teardown');
      assert.strictEqual(progress.length, 1);
      assert.ok(progress[0].includes(DESCRIPTOR_PATH), progress[0]);
      assert.ok(progress[0].includes('codeloop worktree prune'), progress[0]);
    });

    test('IMPL-420-8: unknown branch provenance removes the worktree but leaves the branch', async () => {
      const { manager, lifecycle, seeded } = buildRefusingLifecycle(
        new ValidationError('planBaseline', 'BL-1', 'claim BL-1 exited 2'),
        (m) => {
          m.listBranchesError = new Error('git branch failed');
        }
      );

      await assert.rejects(() => lifecycle.execute(runParams()));

      assert.strictEqual(manager.removedOptions.length, 1);
      assert.strictEqual(manager.calls.includes('deleteBranch'), false);
      assert.deepStrictEqual(pick(stateRepo.savedSnapshot), pick(seeded));
    });

    test('IMPL-420-9: the success path provisions once and removes nothing', async () => {
      const manager = new RecordingWorktreeManager();
      const seeded = seedApprovalSnapshot();
      stateRepo = new MockStateRepository(seeded);
      const descriptor = WorktreeDescriptor.create({
        taskId: 32,
        worktreePath: DESCRIPTOR_PATH,
        branch: BRANCH,
        baseBranch: 'main'
      });
      const lifecycle = new RunLifecycleUseCase({
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway,
        commandExecutor,
        buildDetector,
        standardsRepo,
        critique,
        confirmationPrompt,
        worktreeManager: manager,
        inferBaseBranchUseCase: {
          execute: async () => ({ baseBranch: 'main', taskBranchPrefix: 'task' })
        } as any,
        runPreFlightCheckUseCase: {
          execute: async () => ({
            action: 'PROCEED',
            message: '',
            canProceed: true,
            isHalt: false,
            isResume: false
          })
        } as any,
        startImplementationUseCase: {
          execute: async () => {
            const sm = StateMachine.fromSnapshot(seeded);
            sm.setWorktree(descriptor);
            sm.transition(STAGE_IMPLEMENT);
            await stateRepo.save(sm.toSnapshot());
            return { stateMachine: sm, resumed: false };
          }
        } as any
      });

      const result = await lifecycle.execute(runParams());

      assert.strictEqual(manager.createWorktreeCount, 1);
      assert.strictEqual(manager.calls.includes('removeWorktree'), false);
      assert.strictEqual(manager.calls.includes('deleteBranch'), false);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(stateRepo.savedSnapshot.worktree.branch, BRANCH);
    });

    test('IMPL-420-10: --dry-run and --no-worktree provision and remove nothing', async () => {
      for (const extra of [{ dryRun: true }, { worktree: false }]) {
        const { manager, lifecycle } = buildRefusingLifecycle(
          new ValidationError('planBaseline', 'BL-1', 'claim BL-1 exited 2')
        );

        await assert.rejects(() => lifecycle.execute(runParams(extra)));

        assert.strictEqual(manager.createWorktreeCount, 0, `no provisioning for ${JSON.stringify(extra)}`);
        assert.strictEqual(manager.calls.includes('removeWorktree'), false);
        assert.strictEqual(manager.calls.includes('deleteBranch'), false);
        assert.strictEqual(stateRepo.saveCount, 0, `nothing may be written for ${JSON.stringify(extra)}`);
      }
    });
  });
});

/**
 * Issue #425: `RunLifecycleUseCase.execute()` must bind the WHOLE run to
 * `params.workspaceDir` — the checkpoint directory AND the repository the run
 * provisions/measures in — never to `process.cwd()`. Before the fix the CLI
 * omitted the field at every lifecycle call site, so the checkpoint was read
 * from `--workspace` while provisioning happened in the invocation cwd.
 */
describe('workspace scoping (#425)', () => {
  const SCOPED_WORKSPACE = '/mock/scoped-workspace';
  const SEEDED_AT = '2026-11-01T00:00:00.000Z';

  class RecordingConfigRepository extends MockConfigRepository {
    public loadConfigCalls: any[] = [];

    public loadConfig(params?: any): any {
      this.loadConfigCalls.push(params);
      return super.loadConfig();
    }
  }

  /** Records the provisioning root the lifecycle hands to the adapter. */
  class RecordingProvisioner {
    public createWorktreeCalls: any[] = [];
    public createWorktreeCount = 0;

    public async listWorktrees(): Promise<any[]> {
      return [];
    }

    public async listBranches(): Promise<readonly string[]> {
      return ['main'];
    }

    public async createWorktree(options: any): Promise<any> {
      this.createWorktreeCalls.push(options);
      this.createWorktreeCount++;
      return WorktreeDescriptor.create({
        taskId: String(options.taskId),
        worktreePath: `${options.workspaceDir}/.worktrees/${options.taskId}`,
        branch: `task/${options.taskId}`,
        baseBranch: options.baseBranch || 'main'
      });
    }

    public async removeWorktree(): Promise<void> {}
    public async deleteBranch(): Promise<void> {}
  }

  test('RL-425-1: execute() provisions in params.workspaceDir, never in the cwd', async () => {
    const seeded = {
      version: '1.0.0',
      currentStage: STAGE_PLAN,
      mode: MODE_IMPLEMENT,
      issue: 32,
      milestoneTitle: null,
      baseBranch: 'main',
      worktree: null,
      planDir: `${SCOPED_WORKSPACE}/artifacts/plans/32-test-feature`,
      planPath: null,
      approvedPlanDigest: null,
      approvedPlanPath: null,
      triagePayload: null,
      triageDisposition: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      history: [{ stage: STAGE_PLAN, timestamp: SEEDED_AT }],
      pausedAtGate: null,
      pausedAtTimestamp: null,
      totalHumanWaitMs: 0
    };

    const stateRepo = new MockStateRepository(seeded);
    const configRepo = new RecordingConfigRepository();
    const provisioner = new RecordingProvisioner();

    const lifecycle = new RunLifecycleUseCase({
      stateRepo,
      configRepo,
      planGenerator: new MockPlanGenerator(),
      githubGateway: new MockGitHubGateway(),
      commandExecutor: new MockCommandExecutor(),
      buildDetector: new MockBuildDetector(),
      standardsRepo: new MockStandardsRepository(),
      critique: new MockCritique(),
      confirmationPrompt: new MockConfirmationPrompt(),
      worktreeManager: provisioner as any,
      inferBaseBranchUseCase: {
        execute: async () => ({ baseBranch: 'main', taskBranchPrefix: 'task' })
      } as any,
      runPreFlightCheckUseCase: {
        execute: async () => ({
          action: 'PROCEED',
          message: '',
          canProceed: true,
          isHalt: false,
          isResume: false
        })
      } as any,
      startImplementationUseCase: {
        execute: async () => {
          const sm = StateMachine.fromSnapshot(seeded);
          sm.transition(STAGE_APPROVAL);
          sm.transition(STAGE_IMPLEMENT);
          return { stateMachine: sm, resumed: false };
        }
      } as any
    });

    const result = await lifecycle.execute({
      mode: MODE_IMPLEMENT,
      issue: 32,
      workspaceDir: SCOPED_WORKSPACE
    });

    assert.strictEqual(provisioner.createWorktreeCount, 1, 'implement must provision exactly once');
    assert.strictEqual(
      provisioner.createWorktreeCalls[0].workspaceDir,
      SCOPED_WORKSPACE,
      'createWorktree must receive params.workspaceDir'
    );
    assert.notStrictEqual(
      provisioner.createWorktreeCalls[0].workspaceDir,
      process.cwd(),
      'the provisioning root must never be the process cwd'
    );
    assert.strictEqual(configRepo.loadConfigCalls[0]?.cwd, SCOPED_WORKSPACE, 'config must load from the workspace');
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(
      result.worktree?.worktreePath,
      `${SCOPED_WORKSPACE}/.worktrees/32`,
      'the recorded worktree must live under the workspace'
    );
  });
});
