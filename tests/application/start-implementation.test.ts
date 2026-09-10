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
  MODE_STANDARD,
  MODE_YOLO,
  InvalidTransitionError,
  ValidationError,
  DEFAULT_GATE_TIMEOUT_SECONDS
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
    assert.ok(result.taskPrompt.includes('Step 1: Write code'));
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

  test('throws InvalidTransitionError when attempting implementation from PLAN in standard mode', async () => {
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
    await assert.rejects(
      () => useCase.execute({ issue: 16, workspaceDir: tempDir }),
      (err: any) => err instanceof InvalidTransitionError && err.fromStage === STAGE_PLAN
    );
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
});
