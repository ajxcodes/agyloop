const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  RunQualityGateUseCase,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_PLAN,
  MODE_STANDARD,
  STATUS_PASSED,
  STATUS_FAILED,
  InvalidTransitionError,
  Ecosystem,
  ECOSYSTEM_NODE
} = require('../../dist');

type StateRepository = import('../../src').StateRepository;
type StateMachineSnapshot = import('../../src').StateMachineSnapshot;
type ConfigRepository = import('../../src').ConfigRepository;
type AgyLoopConfig = import('../../src').AgyLoopConfig;
type PlanGeneratorPort = import('../../src').PlanGeneratorPort;
type ScaffoldParams = import('../../src').ScaffoldParams;
type ScaffoldResult = import('../../src').ScaffoldResult;
type GeneratePlanOptions = import('../../src').GeneratePlanOptions;
type GeneratePlanResult = import('../../src').GeneratePlanResult;
type GenerateSummaryLogOptions = import('../../src').GenerateSummaryLogOptions;
type GenerateSummaryLogResult = import('../../src').GenerateSummaryLogResult;
type SummaryUpdateData = import('../../src').SummaryUpdateData;
type ResolvePlanOptions = import('../../src').ResolvePlanOptions;
type ResolvedPlanLocation = import('../../src').ResolvedPlanLocation;
type CommandExecutorPort = import('../../src').CommandExecutorPort;
type CommandExecutionOptions = import('../../src').CommandExecutionOptions;
type CommandExecutionResult = import('../../src').CommandExecutionResult;
type ModelTierName = import('../../src').ModelTierName;
type InvalidTransitionError = import('../../src').InvalidTransitionError;


class MockStateRepository implements StateRepository {
  public current: StateMachineSnapshot | null;
  public saved: StateMachineSnapshot[] = [];

  constructor(initialSnapshot: StateMachineSnapshot | null) {
    this.current = initialSnapshot;
  }
  public async load(): Promise<StateMachineSnapshot | null> {
    return this.current;
  }
  public async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.current = snapshot;
    this.saved.push(snapshot);
  }
  public async reset(): Promise<void> {
    this.current = null;
  }
  public getStateFilePath(): string {
    return '.agyloop/state.json';
  }
}

class MockConfigRepository implements ConfigRepository {
  public options: Record<string, unknown>;

  constructor(options: Record<string, unknown> = {}) {
    this.options = {
      commitAfter: false,
      gateTimeoutSeconds: 300,
      autoApproveInYolo: true,
      enableMcpInPlanner: true,
      ...options
    };
  }
  public loadConfig(): AgyLoopConfig {
    return {
      models: {
        planner: 'pro',
        implementer: 'inherit',
        gate: 'flash_lite',
        reviewer: 'flash'
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: Number(this.options.gateTimeoutSeconds) || 300,
        autoApproveInYolo: true,
        enableMcpInPlanner: true,
        ...this.options
      }
    };
  }
  public resolveModel(role: string): { configured: string; tier: ModelTierName; apiModel: string } {
    return {
      configured: 'flash_lite',
      tier: 'flash_lite',
      apiModel: 'gemini-3.5-flash-lite'
    };
  }
  public mapModelToTier(inputModel: string): ModelTierName {
    return 'flash_lite';
  }
}

class MockPlanGenerator implements PlanGeneratorPort {
  public updates: Array<{ summaryPath: string; updateData: SummaryUpdateData }> = [];

  public scaffoldPlanDirectory(params: ScaffoldParams): ScaffoldResult {
    return {
      planDir: 'artifacts/plans/20-test',
      folderName: '20-test',
      type: 'implementation',
      planPath: 'artifacts/plans/20-test/implementation-plan.md',
      mirrorPath: 'artifacts/plans/20-test/implementation_plan.md',
      summaryPath: 'artifacts/plans/20-test/AgyLoop Summary.md'
    };
  }
  public generatePlan(options: GeneratePlanOptions): GeneratePlanResult {
    return { planPath: '', mirrorPath: null, content: '', created: false };
  }
  public generateSummaryLog(options: GenerateSummaryLogOptions): GenerateSummaryLogResult {
    return { summaryPath: '', content: '', created: false };
  }
  public updateSummaryLog(summaryPath: string, updateData: SummaryUpdateData): boolean {
    this.updates.push({ summaryPath, updateData });
    return true;
  }
  public findPlanDirectory(projectRoot: string, issueNumber: number | string): string | null {
    return 'artifacts/plans/20-test';
  }
  public resolvePlanFile(options: ResolvePlanOptions): ResolvedPlanLocation | null {
    return {
      planDir: 'artifacts/plans/20-test',
      planPath: 'artifacts/plans/20-test/implementation-plan.md',
      planFileName: 'implementation-plan.md',
      summaryPath: 'artifacts/plans/20-test/AgyLoop Summary.md'
    };
  }
  public readPlanDocument(planPath: string): string {
    return '# Test Plan';
  }
}

class MockCommandExecutor implements CommandExecutorPort {
  public responses: CommandExecutionResult[];
  public executed: Array<{ command: string; options?: CommandExecutionOptions }> = [];

  constructor(responses: CommandExecutionResult[] = []) {
    this.responses = [...responses];
  }
  public async execute(command: string, options?: CommandExecutionOptions): Promise<CommandExecutionResult> {
    this.executed.push({ command, options });
    if (this.responses.length > 0) {
      return this.responses.shift()!;
    }
    return {
      command,
      exitCode: 0,
      stdout: 'OK\nℹ tests 10\nℹ pass 10\nℹ fail 0',
      stderr: '',
      combinedOutput: 'OK\nℹ tests 10\nℹ pass 10\nℹ fail 0',
      durationMs: 150,
      timedOut: false
    };
  }
}

type BuildDetectorPort = import('../../src').BuildDetectorPort;
type DetectedProject = import('../../src').DetectedProject;
type GateCommandDefinition = import('../../src').GateCommandDefinition;

class MockBuildDetector implements BuildDetectorPort {
  public detectedProject: DetectedProject;
  public commandsToResolve: readonly GateCommandDefinition[];

  constructor(
    detectedProject?: DetectedProject,
    commandsToResolve?: readonly GateCommandDefinition[]
  ) {
    this.detectedProject = detectedProject || {
      workspaceDir: process.cwd(),
      ecosystems: [
        new Ecosystem({ type: ECOSYSTEM_NODE, markerFiles: ['package.json'], packageManager: 'pnpm' })
      ],
      primaryEcosystem: new Ecosystem({ type: ECOSYSTEM_NODE, markerFiles: ['package.json'], packageManager: 'pnpm' }),
      commands: [
        { id: 'custom-detect', label: 'Auto-detected Runner', command: 'pnpm run test:detected' }
      ],
      hasOverrides: false
    };
    this.commandsToResolve = commandsToResolve || this.detectedProject.commands;
  }

  public async detect(workspaceDir: string): Promise<DetectedProject> {
    return this.detectedProject;
  }

  public async resolveCommands(
    workspaceDir: string,
    config?: AgyLoopConfig,
    explicitCommands?: readonly string[] | readonly GateCommandDefinition[]
  ): Promise<readonly GateCommandDefinition[]> {
    if (explicitCommands && explicitCommands.length > 0) {
      return explicitCommands.map((c, i) =>
        typeof c === 'string'
          ? { id: `cli-${i}`, label: `CLI ${i}`, command: c }
          : c
      );
    }
    const anyConfig = config as unknown as Record<string, unknown> | undefined;
    if (config?.options?.gateCommands && Array.isArray(config.options.gateCommands) && config.options.gateCommands.length > 0) {
      return config.options.gateCommands.map((c: any, i: number) =>
        typeof c === 'string'
          ? { id: `cfg-${i}`, label: `Config ${i}`, command: c }
          : c
      );
    }
    return this.commandsToResolve;
  }
}

describe('RunQualityGateUseCase (Application Layer)', () => {
  test('executes successful gates and advances from IMPLEMENT to REVIEW', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor();

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.currentStage, STAGE_REVIEW);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_REVIEW);
    assert.ok(result.summaryReport.includes('PASSED'));
    assert.ok(result.summaryReport.includes('Next Stage      : REVIEW'));

    // Check summary log update
    assert.strictEqual(planGenerator.updates.length, 1);
    const update = planGenerator.updates[0].updateData;
    assert.strictEqual(update.stage, 'Quality Gates');
    assert.strictEqual(update.status, 'COMPLETED');
    assert.strictEqual(update.buildStatus, STATUS_PASSED);
    assert.ok(update.testsStatus && update.testsStatus.includes(STATUS_PASSED));

    // Check state persistence
    assert.strictEqual(stateRepo.saved.length, 1);
    assert.strictEqual(stateRepo.saved[0].currentStage, STAGE_REVIEW);
  });

  test('falls back from QUALITY_GATE to IMPLEMENT when command fails', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor([
      {
        command: 'npm run typecheck',
        exitCode: 1,
        stdout: '',
        stderr: 'src/domain/error.ts:10:5 - error TS2304: Cannot find name "Foo".',
        combinedOutput: 'src/domain/error.ts:10:5 - error TS2304: Cannot find name "Foo".',
        durationMs: 300,
        timedOut: false
      }
    ]);

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.buildStatus, STATUS_FAILED);
    assert.ok(result.summaryReport.includes('FAILED'));
    assert.ok(result.summaryReport.includes('Cannot find name "Foo"'));

    // Summary log recorded failure
    assert.strictEqual(planGenerator.updates.length, 1);
    assert.strictEqual(planGenerator.updates[0].updateData.status, 'FAILED');
    assert.strictEqual(planGenerator.updates[0].updateData.buildStatus, STATUS_FAILED);

    // State checkpoint saved reverting to IMPLEMENT
    assert.strictEqual(stateRepo.saved.length, 1);
    assert.strictEqual(stateRepo.saved[0].currentStage, STAGE_IMPLEMENT);
  });

  test('falls back to IMPLEMENT when command times out', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor([
      {
        command: 'npm run typecheck',
        exitCode: 1,
        stdout: '',
        stderr: 'Command timed out',
        combinedOutput: 'Command timed out',
        durationMs: 5000,
        timedOut: true
      }
    ]);

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.reports[0].timedOut, true);
    assert.ok(result.summaryReport.includes('TIMED OUT'));
  });

  test('rejects execution when pipeline is not in IMPLEMENT or QUALITY_GATE', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_PLAN,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_PLAN, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor();

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor
    );

    await assert.rejects(
      async () => {
        await useCase.execute({ issue: 20 });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidTransitionError);
        assert.strictEqual((err as InvalidTransitionError).code, 'ERR_INVALID_TRANSITION');
        return true;
      }
    );

  });

  test('supports resuming from QUALITY_GATE stage', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_QUALITY_GATE,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_QUALITY_GATE, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor();

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor
    );

    const result = await useCase.execute({ issue: 20 });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.currentStage, STAGE_REVIEW);
  });

  test('extracts test metrics and handles custom commands', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor([
      {
        command: 'npm test -- --custom',
        exitCode: 0,
        stdout: 'Running custom tests...\nℹ tests 42\nℹ pass 42\nℹ fail 0\nAll tests passed',
        stderr: '',
        combinedOutput: 'Running custom tests...\nℹ tests 42\nℹ pass 42\nℹ fail 0\nAll tests passed',
        durationMs: 450,
        timedOut: false
      }
    ]);

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor
    );

    const result = await useCase.execute({
      issue: 20,
      commands: [
        { id: 'custom-tests', label: 'Custom Test Runner', command: 'npm test -- --custom' }
      ]
    });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.reports.length, 1);
    assert.ok(result.reports[0].testMetrics);
    assert.strictEqual(result.reports[0].testMetrics.total, 42);
    assert.strictEqual(result.reports[0].testMetrics.passed, 42);
    assert.ok(result.summaryReport.includes('42/42 tests passed'));
  });

  test('uses BuildDetectorPort when provided to execute auto-detected commands and records buildSystem in summary', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 22,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor();
    const buildDetector = new MockBuildDetector();

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor,
      buildDetector
    );

    const result = await useCase.execute({ issue: 22 });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.buildSystem, 'node (pnpm)');
    assert.deepStrictEqual(result.detectedEcosystems, ['node (pnpm)']);
    assert.ok(result.summaryReport.includes('Build System    : node (pnpm)'));

    // Check executor ran auto-detected command
    assert.strictEqual(commandExecutor.executed.length, 1);
    assert.strictEqual(commandExecutor.executed[0].command, 'pnpm run test:detected');

    // Check plan generator update
    assert.strictEqual(planGenerator.updates.length, 1);
    const update = planGenerator.updates[0].updateData;
    assert.strictEqual(update.buildSystem, 'node (pnpm)');
    assert.deepStrictEqual(update.executedCommands, ['pnpm run test:detected']);
  });

  test('parses Playwright test metrics ("X passed, Y failed")', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 22,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor([
      {
        command: 'npx playwright test',
        exitCode: 0,
        stdout: 'Running 8 tests using 4 workers\n  8 passed (4.2s)\nTo open last HTML report run: npx playwright show-report',
        stderr: '',
        combinedOutput: 'Running 8 tests using 4 workers\n  8 passed (4.2s)\nTo open last HTML report run: npx playwright show-report',
        durationMs: 4200,
        timedOut: false
      }
    ]);

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor
    );

    const result = await useCase.execute({
      issue: 22,
      commands: [
        { id: 'playwright', label: 'Playwright E2E Test Suite', command: 'npx playwright test' }
      ]
    });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.reports.length, 1);
    const report = result.reports[0];
    assert.ok(report.testMetrics);
    assert.strictEqual(report.testMetrics.passed, 8);
    assert.strictEqual(report.testMetrics.total, 8);
    assert.ok(result.summaryReport.includes('8/8 tests passed'));
  });

  test('respects config overrides over auto-detected commands via BuildDetectorPort', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 22,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository({
      gateCommands: ['echo from-config-override']
    });
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor();
    const buildDetector = new MockBuildDetector();

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor,
      buildDetector
    );

    const result = await useCase.execute({ issue: 22 });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(commandExecutor.executed.length, 1);
    assert.strictEqual(commandExecutor.executed[0].command, 'echo from-config-override');
  });
});
