const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  StartImplementationUseCase,
  ResolveSubagentUseCase,
  IMPLEMENTER_SUBAGENT_DEF
} = require('../../dist/application');
const {
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_COMPLETED,
  MODE_STANDARD,
  MODE_YOLO,
  InvalidTransitionError,
  ValidationError,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  NOTE_IMPLICIT_APPROVAL
} = require('../../dist/domain');

type StateRepository = import('../../src').StateRepository;
type StateMachineSnapshot = import('../../src').StateMachineSnapshot;
type GitHubGateway = import('../../src').GitHubGateway;
type GitHubIssueData = import('../../src').GitHubIssueData;
type ConfigRepository = import('../../src').ConfigRepository;
type AgyLoopConfig = import('../../src').AgyLoopConfig;
type PlanGeneratorPort = import('../../src').PlanGeneratorPort;
type ScaffoldParams = import('../../src').ScaffoldParams;
type ScaffoldResult = import('../../src').ScaffoldResult;
type SummaryUpdateData = import('../../src').SummaryUpdateData;
type GeneratePlanOptions = import('../../src').GeneratePlanOptions;
type GeneratePlanResult = import('../../src').GeneratePlanResult;
type GenerateSummaryLogOptions = import('../../src').GenerateSummaryLogOptions;
type GenerateSummaryLogResult = import('../../src').GenerateSummaryLogResult;

class MockStateRepository implements StateRepository {
  public snapshot: StateMachineSnapshot | null = null;
  public saveCallCount: number = 0;

  constructor(initialSnapshot: StateMachineSnapshot | null = null) {
    this.snapshot = initialSnapshot;
  }

  public load(): StateMachineSnapshot | null {
    return this.snapshot;
  }

  public save(snapshot: StateMachineSnapshot): void {
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

class MockGitHubGateway implements GitHubGateway {
  public issueToReturn: GitHubIssueData | null = null;

  constructor(issueToReturn: GitHubIssueData | null = null) {
    this.issueToReturn = issueToReturn;
  }

  public getCurrentRepo(): string | null {
    return 'ajxcodes/agyloop';
  }

  public fetchIssue(issueNumber: number): GitHubIssueData | null {
    if (this.issueToReturn) return this.issueToReturn;
    return {
      repo: 'ajxcodes/agyloop',
      number: issueNumber,
      title: `Feature Implementation #${issueNumber}`,
      body: 'Implement context handoff execution pipeline.',
      labels: ['enhancement'],
      comments: []
    };
  }
}

class MockConfigRepository implements ConfigRepository {
  public config: AgyLoopConfig;

  constructor(customModels: Record<string, string> = {}) {
    this.config = {
      models: {
        planner: 'pro',
        implementer: 'inherit',
        gate: 'flash_lite',
        reviewer: 'flash',
        ...customModels
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
        autoApproveInYolo: true,
        enableMcpInPlanner: true
      }
    };
  }

  public loadConfig(): AgyLoopConfig {
    return this.config;
  }

  public resolveModel(role: string) {
    const configured = this.config.models[role] || 'inherit';
    let tier: import('../../src').ModelTierName = 'inherit';
    let apiModel = 'inherit';
    if (configured === 'pro' || configured.includes('pro')) {
      tier = 'pro';
      apiModel = configured.includes('gemini') ? configured : 'gemini-2.5-pro';
    } else if (configured === 'flash') {
      tier = 'flash';
      apiModel = 'gemini-3.5-flash';
    }
    return { role, configured, tier, apiModel };
  }

  public mapModelToTier(inputModel: string): import('../../src').ModelTierName {
    if (inputModel.includes('pro')) return 'pro' as const;
    if (inputModel.includes('flash_lite')) return 'flash_lite' as const;
    if (inputModel.includes('flash')) return 'flash' as const;
    return 'inherit' as const;
  }
}

class MockPlanGenerator implements PlanGeneratorPort {
  public planDir: string | null;
  public summaryUpdates: Array<{ file: string; data: SummaryUpdateData }> = [];

  constructor(planDir: string | null = null) {
    this.planDir = planDir;
  }

  public scaffoldPlanDirectory(_params: ScaffoldParams): ScaffoldResult {
    throw new Error('Not implemented');
  }

  public generatePlan(_options: GeneratePlanOptions): GeneratePlanResult {
    return { planPath: '', mirrorPath: null, content: '', created: true };
  }

  public generateSummaryLog(_options: GenerateSummaryLogOptions): GenerateSummaryLogResult {
    return { summaryPath: '', content: '', created: true };
  }

  public updateSummaryLog(file: string, data: SummaryUpdateData): boolean {
    this.summaryUpdates.push({ file, data });
    return true;
  }

  public findPlanDirectory(_root: string, _issue: number | string): string | null {
    return this.planDir;
  }

  public resolvePlanFile(
    options: import('../../src').ResolvePlanOptions
  ): import('../../src').ResolvedPlanLocation | null {
    if (options.planPath && fs.existsSync(options.planPath)) {
      return {
        planDir: path.dirname(options.planPath),
        planPath: options.planPath,
        planFileName: path.basename(options.planPath),
        summaryPath: path.join(path.dirname(options.planPath), 'AgyLoop Summary.md')
      };
    }
    const dir =
      this.planDir ||
      (options.issue ? this.findPlanDirectory(options.projectRoot || '', options.issue) : null);
    if (!dir || !fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir);
    const planFile = files.find(
      (f: string) => f.endsWith('.md') && !f.toLowerCase().includes('summary')
    );
    if (!planFile) return null;

    const planPath = path.join(dir, planFile);
    return {
      planDir: dir,
      planPath,
      planFileName: planFile,
      summaryPath: path.join(dir, 'AgyLoop Summary.md')
    };
  }

  public readPlanDocument(planPath: string): string {
    return fs.readFileSync(planPath, 'utf8');
  }
}

describe('StartImplementationUseCase & Subagent Handoff (TypeScript)', () => {
  let tempDir: string;
  let testPlanDir: string;
  let testPlanPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-impl-test-'));
    testPlanDir = path.join(tempDir, 'artifacts/plans/16-test-task');
    fs.mkdirSync(testPlanDir, { recursive: true });
    testPlanPath = path.join(testPlanDir, 'implementation-plan.md');
    fs.writeFileSync(
      testPlanPath,
      `# Test Implementation Plan\n\n## Checklist\n- [ ] Step 1: Write code\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(testPlanDir, 'AgyLoop Summary.md'),
      `# Summary Log\n`,
      'utf8'
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('advances stage from APPROVAL to IMPLEMENT, loads plan, and saves state', async () => {
    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [
        { stage: STAGE_INITIALIZED, timestamp: new Date().toISOString() },
        { stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }
      ]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);
    const github = new MockGitHubGateway();

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen, github);
    const result = await useCase.execute({
      issue: 16,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.resumed, false);
    assert.strictEqual(stateRepo.saveCallCount, 1);
    assert.strictEqual(stateRepo.snapshot?.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.planPath, testPlanPath);
    assert.ok(result.planContent.includes('# Test Implementation Plan'));

    // Verify implementer subagent definition
    assert.strictEqual(result.implementerDef.name, 'implementer');
    assert.strictEqual(result.implementerDef.role, 'Code Implementation Subagent');
    assert.strictEqual(result.implementerDef.capabilities.enable_write_tools, true);
    assert.strictEqual(result.implementerDef.capabilities.enable_subagent_tools, false);
    assert.strictEqual(result.implementerDef.capabilities.enable_mcp_tools, false);
    assert.ok(result.implementerDef.tools.includes('write_to_file'));
    assert.ok(result.implementerDef.tools.includes('replace_file_content'));
    assert.ok(result.implementerDef.tools.includes('run_command'));
    assert.ok(result.implementerDef.tools.includes('view_file'));

    // Verify token-minimized handoff prompt
    assert.ok(result.taskPrompt.includes('# Task: Implementation Execution'));
    assert.ok(result.taskPrompt.includes('### Operating Constraints:'));
    assert.ok(result.taskPrompt.includes('Plan Fidelity'));
    assert.ok(result.taskPrompt.includes('Issue Context (#16)'));
    assert.ok(result.taskPrompt.includes('### Approved Technical Plan'));
    assert.ok(result.taskPrompt.includes('The approved technical plan is located at'));
    assert.ok(result.taskPrompt.includes('Definition of Done'));

    // Verify summary log was updated
    assert.strictEqual(planGen.summaryUpdates.length, 2);
    assert.strictEqual(planGen.summaryUpdates[0].data.status, 'APPROVED');
    assert.strictEqual(planGen.summaryUpdates[1].data.status, 'IN PROGRESS');
  });

  test('allows resuming when pipeline is already at IMPLEMENT stage', async () => {
    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    const result = await useCase.execute({
      issue: 16,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.resumed, true);
  });

  test('allows direct transition from PLAN to IMPLEMENT in YOLO mode', async () => {
    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_PLAN,
      mode: MODE_YOLO,
      issue: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_PLAN, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    const result = await useCase.execute({
      issue: 16,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.resumed, false);
  });

  test('allows reopening implementation when pipeline is at COMPLETED stage', async () => {
    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_COMPLETED,
      mode: MODE_STANDARD,
      issue: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_COMPLETED, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    const result = await useCase.execute({
      issue: 16,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.resumed, false);
    assert.strictEqual(stateRepo.snapshot?.currentStage, STAGE_IMPLEMENT);
  });

  test('allows direct transition from PLAN to IMPLEMENT in standard mode by implicitly approving', async () => {
    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_PLAN,
      mode: MODE_STANDARD,
      issue: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_PLAN, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    const result = await useCase.execute({ issue: 16, workspaceDir: tempDir });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.resumed, false);
    
    // History should reflect PLAN -> APPROVAL -> IMPLEMENT
    const history = result.stateMachine.history;
    assert.strictEqual(history[history.length - 2].stage, STAGE_APPROVAL);
    assert.strictEqual(history[history.length - 2].metadata?.note, NOTE_IMPLICIT_APPROVAL);
    assert.strictEqual(history[history.length - 1].stage, STAGE_IMPLEMENT);
  });

  test('throws InvalidTransitionError when pipeline state is uninitialized', async () => {
    const stateRepo = new MockStateRepository(null);
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    await assert.rejects(
      () => useCase.execute({ issue: 16, workspaceDir: tempDir }),
      (err: any) => err instanceof InvalidTransitionError
    );
  });

  test('throws InvalidTransitionError when attempting implementation from DISCOVERY stage', async () => {
    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_DISCOVERY,
      mode: MODE_STANDARD,
      issue: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_DISCOVERY, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    await assert.rejects(
      () => useCase.execute({ issue: 16, workspaceDir: tempDir }),
      (err: any) => err instanceof InvalidTransitionError
    );
  });

  test('throws ValidationError when approved plan document cannot be found', async () => {
    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 99,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(null); // No plan directory found

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    await assert.rejects(
      () => useCase.execute({ issue: 99, workspaceDir: tempDir }),
      (err: any) => err instanceof ValidationError && err.field === 'planPath'
    );
  });

  test('supports explicit planPath override', async () => {
    const customPlanPath = path.join(tempDir, 'custom-plan.md');
    fs.writeFileSync(customPlanPath, '# Custom Plan Specification\n', 'utf8');

    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(null);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    const result = await useCase.execute({
      planPath: customPlanPath,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.planPath, customPlanPath);
    assert.strictEqual(result.planContent, '# Custom Plan Specification\n');
  });

  test('dryRun avoids saving state or mutating disk', async () => {
    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    const result = await useCase.execute({
      issue: 16,
      workspaceDir: tempDir,
      dryRun: true
    });

    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(planGen.summaryUpdates.length, 0);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
  });

  test('ResolveSubagentUseCase resolves implementer role with custom model config', () => {
    const configRepo = new MockConfigRepository({ implementer: 'gemini-3.5-pro' });
    const resolveUseCase = new ResolveSubagentUseCase(configRepo);

    const def = resolveUseCase.execute({ role: 'implementer' });
    assert.strictEqual(def.name, 'implementer');
    assert.strictEqual(def.role, 'Code Implementation Subagent');
    assert.strictEqual(def.model, 'pro');
    assert.strictEqual(def.apiModel, 'gemini-3.5-pro');
    assert.strictEqual(def.capabilities.enable_write_tools, true);
    assert.strictEqual(def.capabilities.enable_subagent_tools, false);
    assert.strictEqual(def.capabilities.enable_mcp_tools, false);
    assert.ok(def.system_prompt.includes('AgyLoop Code Implementation Subagent'));
  });

  test('IMPLEMENTER_SUBAGENT_DEF conforms to required invariants', () => {
    assert.strictEqual(IMPLEMENTER_SUBAGENT_DEF.name, 'implementer');
    assert.strictEqual(IMPLEMENTER_SUBAGENT_DEF.defaultTier, 'inherit');
    assert.strictEqual(IMPLEMENTER_SUBAGENT_DEF.capabilities.enable_write_tools, true);
    assert.strictEqual(IMPLEMENTER_SUBAGENT_DEF.capabilities.enable_subagent_tools, false);
    assert.strictEqual(IMPLEMENTER_SUBAGENT_DEF.capabilities.enable_mcp_tools, false);
    assert.ok(IMPLEMENTER_SUBAGENT_DEF.tools.includes('write_to_file'));
    assert.ok(IMPLEMENTER_SUBAGENT_DEF.tools.includes('replace_file_content'));
    assert.ok(IMPLEMENTER_SUBAGENT_DEF.tools.includes('run_command'));
  });

  test('automatically injects self-correction failure diagnostics when resuming from failed quality gate', async () => {
    const testPlanDir = path.join(tempDir, 'artifacts', 'plans', '24-self-correction');
    fs.mkdirSync(testPlanDir, { recursive: true });
    fs.writeFileSync(path.join(testPlanDir, 'implementation_plan.md'), '# Plan 24\n- [ ] Task 1');

    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 24,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [
        { stage: STAGE_APPROVAL, timestamp: new Date().toISOString() },
        { stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() },
        { stage: 'QUALITY_GATE', timestamp: new Date().toISOString() },
        {
          stage: STAGE_IMPLEMENT,
          timestamp: new Date().toISOString(),
          metadata: {
            note: 'Quality gates failed',
            failureSnippet: 'AssertionError: expected false to be true\n    at tests/domain/test.ts:20:5',
            selfCorrectionPayload: '### Self-Correction Quality Gate Failure Diagnostics:\n- **Failing File**: `tests/domain/test.ts:20:5`\n```\nAssertionError: expected false to be true\n```'
          }
        }
      ]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    const result = await useCase.execute({
      issue: 24,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.resumed, true);
    assert.strictEqual(result.isSelfCorrection, true);
    assert.ok(result.taskPrompt.includes('### Self-Correction Quality Gate Failure Diagnostics:'));
    assert.ok(result.taskPrompt.includes('tests/domain/test.ts:20:5'));
    assert.ok(result.taskPrompt.includes('AssertionError: expected false to be true'));
  });

  test('supports explicit failureDiagnostics parameter in StartImplementationUseCase', async () => {
    const testPlanDir = path.join(tempDir, 'artifacts', 'plans', '24-explicit-diag');
    fs.mkdirSync(testPlanDir, { recursive: true });
    fs.writeFileSync(path.join(testPlanDir, 'implementation_plan.md'), '# Plan 24\n- [ ] Task 1');

    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 24,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir);

    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);
    const result = await useCase.execute({
      issue: 24,
      workspaceDir: tempDir,
      failureDiagnostics: 'Error: Cannot find module "foo" at index.ts:15:3'
    });

    assert.strictEqual(result.isSelfCorrection, true);
    assert.ok(result.taskPrompt.includes('### Self-Correction Quality Gate Failure Diagnostics:'));
    assert.ok(result.taskPrompt.includes('Cannot find module "foo"'));
  });

  // Merge conflict handling tests
  test('injects merge conflict payload into selfCorrectionPayload when hasMergeConflicts is true and commandExecutor detects conflicts', async () => {
    const testPlanDir2 = path.join(tempDir, 'artifacts', 'plans', '49-conflict-test');
    fs.mkdirSync(testPlanDir2, { recursive: true });
    fs.writeFileSync(path.join(testPlanDir2, 'implementation_plan.md'), '# Conflict Plan\n- [ ] Fix conflicts');

    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 49,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir2);

    type CommandExecutorPort = import('../../src').CommandExecutorPort;
    type CommandExecutionResult = import('../../src').CommandExecutionResult;

    // Mock executor: fetch succeeds, merge fails, conflicts listed, file has markers
    const conflictFileContent = [
      'line before',
      '<<<<<<< HEAD',
      'local version',
      '=======',
      'incoming version',
      '>>>>>>> origin/main',
      'line after'
    ].join('\n');

    const mockExecutor: CommandExecutorPort = {
      async execute(command: string): Promise<CommandExecutionResult> {
        const base: CommandExecutionResult = {
          command,
          exitCode: 0,
          stdout: '',
          stderr: '',
          combinedOutput: '',
          durationMs: 1,
          timedOut: false
        };
        if (command.includes('git fetch')) {
          return { ...base, exitCode: 0 };
        }
        if (command.includes('git merge')) {
          return { ...base, exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/foo.ts' };
        }
        if (command.includes('diff --name-only')) {
          return { ...base, stdout: 'src/foo.ts\n' };
        }
        if (command.includes('cat ')) {
          return { ...base, stdout: conflictFileContent };
        }
        return base;
      }
    };

    const useCase = new StartImplementationUseCase(
      stateRepo,
      configRepo,
      planGen,
      undefined,
      undefined,
      undefined,
      undefined,
      mockExecutor
    );

    const result = await useCase.execute({
      issue: 49,
      workspaceDir: tempDir,
      noWorktree: true,
      hasMergeConflicts: true,
      mergeBaseBranch: 'main'
    });

    assert.strictEqual(result.isSelfCorrection, true);
    assert.ok(result.taskPrompt.includes('### Merge Conflict Pre-Flight:'));
    assert.ok(result.taskPrompt.includes('src/foo.ts'));
    assert.ok(result.taskPrompt.includes('<<<<<<<'));
    assert.ok(result.taskPrompt.includes('>>>>>>>'));
    assert.ok(result.taskPrompt.includes('Resolution Instructions'));
  });

  test('does not inject conflict payload when merge succeeds cleanly', async () => {
    const testPlanDir3 = path.join(tempDir, 'artifacts', 'plans', '49-clean-merge');
    fs.mkdirSync(testPlanDir3, { recursive: true });
    fs.writeFileSync(path.join(testPlanDir3, 'implementation_plan.md'), '# Clean Merge Plan\n- [ ] Task');

    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 49,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir3);

    type CommandExecutorPort = import('../../src').CommandExecutorPort;
    type CommandExecutionResult = import('../../src').CommandExecutionResult;

    // Mock executor: both fetch and merge succeed
    const mockExecutor: CommandExecutorPort = {
      async execute(command: string): Promise<CommandExecutionResult> {
        return {
          command,
          exitCode: 0,
          stdout: '',
          stderr: '',
          combinedOutput: '',
          durationMs: 1,
          timedOut: false
        };
      }
    };

    const useCase = new StartImplementationUseCase(
      stateRepo,
      configRepo,
      planGen,
      undefined,
      undefined,
      undefined,
      undefined,
      mockExecutor
    );

    const result = await useCase.execute({
      issue: 49,
      workspaceDir: tempDir,
      noWorktree: true,
      hasMergeConflicts: true,
      mergeBaseBranch: 'main'
    });

    assert.strictEqual(result.isSelfCorrection, false);
    assert.ok(!result.taskPrompt.includes('### Merge Conflict Pre-Flight:'));
  });

  test('surfaces fetch failure as diagnostic note in conflict payload', async () => {
    const testPlanDir4 = path.join(tempDir, 'artifacts', 'plans', '49-fetch-fail');
    fs.mkdirSync(testPlanDir4, { recursive: true });
    fs.writeFileSync(path.join(testPlanDir4, 'implementation_plan.md'), '# Fetch Fail Plan\n- [ ] Task');

    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 49,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir4);

    type CommandExecutorPort = import('../../src').CommandExecutorPort;
    type CommandExecutionResult = import('../../src').CommandExecutionResult;

    const mockExecutor: CommandExecutorPort = {
      async execute(command: string): Promise<CommandExecutionResult> {
        const base: CommandExecutionResult = {
          command,
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: unable to access remote',
          combinedOutput: 'fatal: unable to access remote',
          durationMs: 1,
          timedOut: false
        };
        return base;
      }
    };

    const useCase = new StartImplementationUseCase(
      stateRepo,
      configRepo,
      planGen,
      undefined,
      undefined,
      undefined,
      undefined,
      mockExecutor
    );

    const result = await useCase.execute({
      issue: 49,
      workspaceDir: tempDir,
      noWorktree: true,
      hasMergeConflicts: true,
      mergeBaseBranch: 'main'
    });

    assert.strictEqual(result.isSelfCorrection, true);
    assert.ok(result.taskPrompt.includes('Merge Conflict Pre-Flight (Fetch Failed):'));
    assert.ok(result.taskPrompt.includes('unable to access remote'));
  });

  test('skips merge conflict logic when no commandExecutor is provided', async () => {
    const testPlanDir5 = path.join(tempDir, 'artifacts', 'plans', '49-no-executor');
    fs.mkdirSync(testPlanDir5, { recursive: true });
    fs.writeFileSync(path.join(testPlanDir5, 'implementation_plan.md'), '# No Executor Plan\n- [ ] Task');

    const stateRepo = new MockStateRepository({
      version: '1.0.0',
      currentStage: STAGE_APPROVAL,
      mode: MODE_STANDARD,
      issue: 49,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_APPROVAL, timestamp: new Date().toISOString() }]
    });
    const configRepo = new MockConfigRepository();
    const planGen = new MockPlanGenerator(testPlanDir5);

    // No commandExecutor provided — conflict logic should be skipped
    const useCase = new StartImplementationUseCase(stateRepo, configRepo, planGen);

    const result = await useCase.execute({
      issue: 49,
      workspaceDir: tempDir,
      noWorktree: true,
      hasMergeConflicts: true,
      mergeBaseBranch: 'main'
    });

    // Without commandExecutor, no conflict payload should be injected
    assert.strictEqual(result.isSelfCorrection, false);
    assert.ok(!result.taskPrompt.includes('Merge Conflict'));
  });
});
