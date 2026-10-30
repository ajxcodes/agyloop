const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  RunQualityGateUseCase,
  FileBuildDetector,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_PLAN,
  STAGE_DISCOVERY,
  MODE_STANDARD,
  MODE_YOLO,
  STATUS_PASSED,
  STATUS_FAILED,
  // Issue #259: the verdict token of a refused certification. It is NOT a
  // member of the `GateVerdict` union — the VACUOUS report is built as a
  // plain string — but it IS the honest status of the VACUOUS result.
  STATUS_VACUOUS,
  InvalidTransitionError,
  Ecosystem,
  ECOSYSTEM_NODE,
  // Issue #259: the operator-facing strings of the VACUOUS verdict and of the
  // implementation-evidence line. Imported, never re-typed, so the assertions
  // cannot drift from the shipped wording.
  MSG_GATE_VACUOUS,
  MSG_GATE_UNMEASURABLE,
  MSG_GATE_LINT_MISSING,
  LABEL_IMPLEMENTATION_EVIDENCE,
  LABEL_IMPLEMENTATION_EVIDENCE_LINE,
  LABEL_BASE_FRESHNESS,
  LABEL_BASE_FRESHNESS_LINE,
  HEADER_QUALITY_GATE_REPORT,
  LABEL_OVERALL_VERDICT,
  formatStageDuration,
  FilePlanGenerator,
  SMOKE_PROTOCOL_VALUES,
  SMOKE_PROTOCOL_NOT_REPORTED,
  SMOKE_STATUS_NOT_DECLARED
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
type ImplementationDiff = import('../../src').ImplementationDiff;
type GateCommandReport = import('../../src').GateCommandReport;


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
  public content = '# Test Plan';
  public digests: Array<string | null> = [];

  public scaffoldPlanDirectory(params: ScaffoldParams): ScaffoldResult {
    return {
      planDir: 'artifacts/plans/20-test',
      folderName: '20-test',
      type: 'implementation',
      planPath: 'artifacts/plans/20-test/implementation-plan.md',
      mirrorPath: 'artifacts/plans/20-test/implementation_plan.md',
      summaryPath: 'artifacts/plans/20-test/AgyLoop Summary.md',
      directoryCreated: false,
      filesCreated: false,
      adoptedExisting: true
    };
  }
  public generatePlan(options: GeneratePlanOptions): GeneratePlanResult {
    return {
      planPath: '',
      mirrorPath: null,
      content: '',
      mirrorContent: null,
      created: false,
      mirrorCreated: false
    };
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
    return this.content;
  }
  public hashPlanDocument(planPath: string): string | null {
    if (this.digests.length > 0) {
      return this.digests.shift() ?? null;
    }
    return 'stable-digest';
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
    const plan = await this.resolveCommandPlan(workspaceDir, config, { explicitCommands });
    return plan.commands;
  }

  public async resolveCommandPlan(
    workspaceDir: string,
    config?: AgyLoopConfig,
    options?: import('../../src/ports').GateCommandResolutionOptions
  ): Promise<import('../../src/domain').GateCommandPlan> {
    const base = {
      appended: [] as readonly string[],
      lintRequired: false,
      lintCommand: null,
      planPath: options?.planPath ?? null
    };

    if (options?.explicitCommands && options.explicitCommands.length > 0) {
      return {
        ...base,
        commands: options.explicitCommands.map((c, i) =>
          typeof c === 'string'
            ? { id: `cli-${i}`, label: `CLI ${i}`, command: c }
            : c
        ),
        source: 'explicit',
        sourceDetail: 'mock explicit'
      };
    }

    if (options?.planTargets && options.planTargets.length > 0) {
      return {
        ...base,
        commands: options.planTargets.map((command, idx) => ({
          id: `plan-${idx + 1}`,
          label: `Plan Target ${idx + 1}`,
          command
        })),
        source: 'plan',
        sourceDetail: options.planPath ? `mock plan ${options.planPath}` : 'mock plan'
      };
    }

    if (config?.options?.gateCommands && Array.isArray(config.options.gateCommands) && config.options.gateCommands.length > 0) {
      return {
        ...base,
        commands: config.options.gateCommands.map((c: any, i: number) =>
          typeof c === 'string'
            ? { id: `cfg-${i}`, label: `Config ${i}`, command: c }
            : c
        ),
        source: 'config',
        sourceDetail: 'mock config'
      };
    }

    return {
      ...base,
      commands: this.commandsToResolve,
      source: 'auto-detect',
      sourceDetail: `mock detection from ${workspaceDir}`,
      planPath: options?.planPath ?? null
    };
  }
}

/**
 * A detector whose plan says lint is mandatory while the resolved list omits
 * it: the gate's defence-in-depth preflight must refuse to run anything.
 */
class LintMissingBuildDetector extends MockBuildDetector {
  public async resolveCommandPlan(
    _workspaceDir: string,
    _config?: AgyLoopConfig,
    _options?: import('../../src/ports').GateCommandResolutionOptions
  ): Promise<import('../../src/domain').GateCommandPlan> {
    return {
      commands: [{ id: 'plan-1', label: 'Plan Target 1', command: 'npm run build' }],
      source: 'plan',
      sourceDetail: 'mock plan without lint',
      appended: [],
      lintRequired: true,
      lintCommand: 'npm run lint',
      planPath: null
    };
  }
}

/**
 * A detector whose plan-sourced list carries a required workflow-lint
 * composition with no resolved command (#369): the gate must fail closed.
 */
class CompositionMissingBuildDetector extends MockBuildDetector {
  public async resolveCommandPlan(
    workspaceDir: string,
    config?: AgyLoopConfig,
    options?: import('../../src/ports').GateCommandResolutionOptions
  ): Promise<import('../../src/domain').GateCommandPlan> {
    const plan = await super.resolveCommandPlan(workspaceDir, config, options);
    if (plan.source !== 'plan') return plan;
    return {
      ...plan,
      composition: {
        required: true,
        files: ['.github/workflows/ci.yml'],
        command: null,
        unavailableReason: 'no workflow linter available'
      }
    };
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

  test('files the same evidence record the dispatched path files (issue #284)', async () => {
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

    const saved: any[] = [];
    const gateReportRepo = {
      load: () => null,
      save: (_issue: unknown, report: any) => {
        saved.push(report);
        return '/fake/20.gate.json';
      },
      clear: () => {}
    };

    const useCase = new RunQualityGateUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      commandExecutor,
      undefined,
      undefined,
      gateReportRepo
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(saved.length, 1, 'a passing in-process run must file one record');
    assert.strictEqual(saved[0].verdict, 'PASSED');
    assert.strictEqual(saved[0].durationMs, result.totalDurationMs);
    assert.strictEqual(saved[0].testsStatus, result.testsStatus);
    assert.strictEqual(saved[0].gateRound, 1, 'the first gate round is round 1');

    // The in-process path still writes the summary itself (yolo has no
    // `transition` command in that step), and no gate prose lands in
    // `## Review Notes` any more.
    assert.strictEqual(planGenerator.updates.length, 1);
    const update = planGenerator.updates[0].updateData;
    assert.strictEqual(update.reviewNote, undefined);
    // Issue #338 (S4): the in-process cell names its clock, exactly like the
    // dispatched path. A bare `0s` cannot say whether it is a wall clock or the
    // gate's self-timer — the defect #325.3 removed from the dispatched row.
    assert.match(
      update.duration as string,
      /^(?:\d+m )?\d+s \(gate-reported(?:; (?:\d+m )?\d+s wall)?\)$/
    );
    assert.strictEqual(
      (update.duration as string).split(' (gate-reported')[0],
      formatStageDuration(result.totalDurationMs),
      'the reported prefix is the measured total'
    );
    // Issue #338 (S1/S3): the in-process round renders the SAME evidence set the
    // filed record carries — no per-check verdicts exist on this path, so the
    // lists are empty (and therefore clear an earlier round's lines).
    assert.deepStrictEqual(update.smokeChecks, []);
    assert.deepStrictEqual(update.notRun, []);
    assert.strictEqual(update.buildSystem, saved[0].buildSystem);
    assert.ok(
      [...SMOKE_PROTOCOL_VALUES, SMOKE_PROTOCOL_NOT_REPORTED].includes(
        update.smokeProtocol as string
      ),
      `the protocol verdict must be a vocabulary member, got: ${update.smokeProtocol}`
    );
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

  test('rejects execution from DISCOVERY so wrong-stage remediation stays caller-side (issue #234)', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_DISCOVERY,
      mode: MODE_YOLO,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_DISCOVERY, timestamp: new Date().toISOString() }]
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
        assert.ok((err as Error).message.includes(`Cannot run quality gates from stage 'DISCOVERY'`));
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

  test('supports running quality gates from COMMIT stage', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_COMMIT,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_COMMIT, timestamp: new Date().toISOString() }]
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

  test('supports running quality gates from COMPLETED stage', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_COMPLETED,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_COMPLETED, timestamp: new Date().toISOString() }]
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

  test('generates structured GateSummaryReport and transition metadata for self-correction handoff', async () => {
    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 24,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    const stateRepo = new MockStateRepository(initialSnapshot);
    const configRepo = new MockConfigRepository();
    const planGenerator = new MockPlanGenerator();
    const commandExecutor = new MockCommandExecutor([
      {
        command: 'npm test',
        exitCode: 1,
        stdout: '',
        stderr: `
✖ failing test in value-objects.test.ts
AssertionError [ERR_ASSERTION]: Expected 42 to equal 99
    at Context.<anonymous> (tests/domain/value-objects.test.ts:35:12)
`,
        combinedOutput: `
✖ failing test in value-objects.test.ts
AssertionError [ERR_ASSERTION]: Expected 42 to equal 99
    at Context.<anonymous> (tests/domain/value-objects.test.ts:35:12)
`,
        durationMs: 800,
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
      issue: 24,
      commands: [{ id: 'test', label: 'Unit Tests', command: 'npm test' }]
    });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.ok(result.gateReport);
    assert.strictEqual(result.gateReport.isFailed(), true);
    assert.ok(result.diagnosticSnippet);
    assert.strictEqual(result.diagnosticSnippet.fileLocation, 'tests/domain/value-objects.test.ts:35:12');

    // Inspect transition history metadata for self-correction payload
    const history = result.stateMachine.history;
    const lastTransition = history[history.length - 1];
    assert.strictEqual(lastTransition.stage, STAGE_IMPLEMENT);
    assert.ok(lastTransition.metadata);
    assert.strictEqual(lastTransition.metadata.gateVerdict, 'FAILED');
    assert.ok(String(lastTransition.metadata.gateTokens).includes('GATE_STATUS: FAILED'));
    assert.strictEqual(lastTransition.metadata.failureFile, 'tests/domain/value-objects.test.ts:35:12');
    assert.ok(String(lastTransition.metadata.selfCorrectionPayload).includes('Self-Correction Quality Gate Failure Diagnostics'));

    // Plan generator update: the gate's own row records the failure, and gate
    // prose no longer lands in `## Review Notes` (issue #284). The failing
    // location still travels in the history metadata asserted above.
    assert.strictEqual(planGenerator.updates.length, 1);
    assert.strictEqual(planGenerator.updates[0].updateData.stage, 'Quality Gates');
    assert.strictEqual(planGenerator.updates[0].updateData.status, 'FAILED');
    assert.strictEqual(planGenerator.updates[0].updateData.reviewNote, undefined);
  });

  test('T7: dead DOCKER_HOST skips the act gate and the pipeline advances to REVIEW (Issue #232)', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-gate-232-'));
    const savedEnv = { DOCKER_HOST: process.env.DOCKER_HOST, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
    const originalExistsSync = fs.existsSync;
    try {
      fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
      fs.mkdirSync(path.join(workspaceDir, '.github', 'workflows'), { recursive: true });
      process.env.DOCKER_HOST = `unix://${path.join(workspaceDir, 'missing.sock')}`;
      process.env.XDG_RUNTIME_DIR = path.join(workspaceDir, 'xdg');
      fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
      // Stub only the standard docker socket for host determinism; delegate everything else
      fs.existsSync = (p: any) => (String(p) === '/var/run/docker.sock' ? false : originalExistsSync(p));

      const detector = new FileBuildDetector();
      detector.hasActBinary = () => true;
      // Issue #295: a dead socket is no longer evidence of anything. This case
      // is about a DEAD runtime, so the probe is what says so.
      detector.probeContainerRuntime = () => null;

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
        commandExecutor,
        detector
      );

      const result = await useCase.execute({ issue: 20, workspaceDir });

      // Dead socket must not fail or revert the pipeline — host gates decide the verdict
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.currentStage, STAGE_REVIEW);

      const executedCommands = commandExecutor.executed.map((e: { command: string }) => e.command);
      assert.ok(executedCommands.some((c: string) => c === 'npm test'));
      assert.ok(!executedCommands.some((c: string) => /^act( |$)/.test(c)));
    } finally {
      fs.existsSync = originalExistsSync;
      if (savedEnv.DOCKER_HOST === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = savedEnv.DOCKER_HOST;
      if (savedEnv.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedEnv.XDG_RUNTIME_DIR;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  // ----------------------------------------------------------------------
  // Issue #259 (AC3): the gate refuses to certify an unimplemented tree.
  //
  // A passing suite over an UNCHANGED tree is positive evidence of nothing:
  // the pre-existing tests still pass when no implementation was produced.
  // The verdict is INJECTED (`implementationDiff`) — the gate use case runs no
  // git command of its own — so the response-queue mock stays authoritative
  // for "which gate command ran".
  // ----------------------------------------------------------------------
  describe('Implementation evidence: the gate refuses to certify an unchanged tree (issue #259)', () => {
    /** The verdict of a tree that was read and carries NO implementation. */
    function unchangedDiff(baseRef = 'main'): ImplementationDiff {
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
    function changedDiff(baseRef = 'main', tracked: readonly string[] = ['src/index.ts']): ImplementationDiff {
      return {
        hasChanges: true,
        baseRef,
        trackedChangedFiles: tracked,
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
    function freshnessLine(
      ahead: number,
      own: number,
      mergeBase: string,
      baseRef = 'main'
    ): string {
      return LABEL_BASE_FRESHNESS_LINE.replace('{label}', LABEL_BASE_FRESHNESS)
        .replace('{ahead}', String(ahead))
        .replace('{baseRef}', baseRef)
        .replace('{own}', String(own))
        .replace('{mergeBase}', mergeBase.slice(0, 7));
    }

    /** A measured verdict carrying explicit branch-relative counts (issue #263). */
    function measuredDiff(params: {
      baseRef?: string;
      tracked?: readonly string[];
      untracked?: readonly string[];
      ahead?: number | null;
      own?: number | null;
      mergeBase?: string | null;
    } = {}): ImplementationDiff {
      const tracked = params.tracked ?? [];
      const untracked = params.untracked ?? [];
      return {
        hasChanges: tracked.length + untracked.length > 0,
        baseRef: params.baseRef ?? 'main',
        trackedChangedFiles: tracked,
        untrackedFiles: untracked,
        probeError: null,
        measurementError: null,
        mergeBase: params.mergeBase === undefined ? 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' : params.mergeBase,
        baseAheadCommits: params.ahead === undefined ? 0 : params.ahead,
        ownCommits: params.own === undefined ? 0 : params.own,
        rawStatus: ''
      };
    }

    /** An unmeasurable verdict: the tree was read, the branch diff was not (issue #263). */
    function unmeasurableDiff(params: { tracked?: readonly string[]; error?: string } = {}): ImplementationDiff {
      const tracked = params.tracked ?? [];
      return {
        hasChanges: tracked.length > 0,
        baseRef: 'main',
        trackedChangedFiles: tracked,
        untrackedFiles: [],
        probeError: null,
        measurementError: params.error ?? "git merge-base HEAD 'main' could not resolve the branch point for 'main'",
        mergeBase: null,
        baseAheadCommits: null,
        ownCommits: null,
        rawStatus: ''
      };
    }

    function implementSnapshot(): StateMachineSnapshot {
      return {
        version: '1.0.0',
        currentStage: STAGE_IMPLEMENT,
        mode: MODE_STANDARD,
        issue: 20,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
      };
    }

    test('V1 (AC3): an injected unchanged-tree diff yields passed === false, vacuous === true, and NO gate command is executed', async () => {
      const stateRepo = new MockStateRepository(implementSnapshot());
      const configRepo = new MockConfigRepository();
      const planGenerator = new MockPlanGenerator();
      const commandExecutor = new MockCommandExecutor();

      const useCase = new RunQualityGateUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        commandExecutor
      );

      const result = await useCase.execute({
        issue: 20,
        implementationDiff: unchangedDiff('main')
      });

      assert.strictEqual(result.passed, false, 'an unchanged tree must never be certified');
      assert.strictEqual(result.vacuous, true);
      assert.strictEqual(
        commandExecutor.executed.length,
        0,
        `no gate command may run over an unimplemented tree, got: ${commandExecutor.executed
          .map((e: { command: string }) => e.command)
          .join(', ')}`
      );
      assert.deepStrictEqual(result.reports, []);
      assert.strictEqual(result.totalDurationMs, 0);
      assert.strictEqual(result.gateReport, undefined, 'no gate report may be produced');

      // The stage was never advanced and the retry counter was never touched.
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(result.stateMachine.implementToGateLoops, 0);

      // Nothing ran, so there is nothing to log.
      assert.strictEqual(planGenerator.updates.length, 0);

      // The verdict is surfaced for the operator-facing diagnostic.
      assert.ok(result.implementationDiff);
      assert.strictEqual(result.implementationDiff.hasChanges, false);
      assert.strictEqual(result.implementationDiff.baseRef, 'main');

      // Issue #259: a VACUOUS verdict records the REFUSAL, not a failure. NO
      // gate command ran, so there is no build outcome and no test outcome to
      // report — `STATUS_FAILED` would claim a failure for an event that never
      // happened (the same false-claim class this issue removes).
      assert.strictEqual(
        result.buildStatus,
        STATUS_VACUOUS,
        'the build status of a VACUOUS verdict must be the refusal, not a failure'
      );
      assert.strictEqual(
        result.testsStatus,
        STATUS_VACUOUS,
        'the test status of a VACUOUS verdict must be the refusal, not a failure'
      );
      assert.notStrictEqual(
        result.buildStatus,
        STATUS_FAILED,
        'a VACUOUS verdict must never claim that the build FAILED'
      );
      assert.notStrictEqual(
        result.testsStatus,
        STATUS_FAILED,
        'a VACUOUS verdict must never claim that the tests FAILED'
      );
    });

    test('V2 (AC3): the VACUOUS summary report says "Overall Verdict : VACUOUS" and never "PASSED"', async () => {
      const stateRepo = new MockStateRepository(implementSnapshot());
      const configRepo = new MockConfigRepository();
      const planGenerator = new MockPlanGenerator();
      const commandExecutor = new MockCommandExecutor();

      const useCase = new RunQualityGateUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        commandExecutor
      );

      const result = await useCase.execute({
        issue: 20,
        implementationDiff: unchangedDiff('main')
      });

      assert.ok(
        result.summaryReport.startsWith(HEADER_QUALITY_GATE_REPORT),
        `the refusal must still be a gate report, got:\n${result.summaryReport}`
      );
      assert.ok(
        result.summaryReport.includes(`${LABEL_OVERALL_VERDICT} : VACUOUS`),
        `the verdict must be VACUOUS, got:\n${result.summaryReport}`
      );
      assert.ok(
        !result.summaryReport.includes('PASSED'),
        `an unimplemented tree must never be reported as PASSED, got:\n${result.summaryReport}`
      );
      assert.ok(
        result.summaryReport.includes(MSG_GATE_VACUOUS.replace('{baseRef}', 'main')),
        `the refusal line must explain itself, got:\n${result.summaryReport}`
      );
      assert.ok(
        result.summaryReport.includes(evidenceLine(0, 'main')),
        `the report must carry the implementation-evidence line, got:\n${result.summaryReport}`
      );
    });

    test('V3 (AC3): an injected changed-tree diff runs the gates and the report carries the "Implementation : N file(s) changed" line', async () => {
      const stateRepo = new MockStateRepository(implementSnapshot());
      const configRepo = new MockConfigRepository();
      const planGenerator = new MockPlanGenerator();
      const commandExecutor = new MockCommandExecutor();

      const useCase = new RunQualityGateUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        commandExecutor
      );

      const result = await useCase.execute({
        issue: 20,
        implementationDiff: changedDiff('main', ['src/index.ts', 'src/other.ts'])
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.vacuous, false);
      assert.ok(
        commandExecutor.executed.length > 0,
        'the gates must actually run over a tree that carries the implementation'
      );
      assert.strictEqual(result.currentStage, STAGE_REVIEW);
      assert.ok(
        result.summaryReport.includes('PASSED'),
        `the gates must still report PASSED over an implemented tree, got:\n${result.summaryReport}`
      );
      assert.ok(
        result.summaryReport.includes(evidenceLine(2, 'main')),
        `the report must carry the implementation-evidence line, got:\n${result.summaryReport}`
      );
    });

    test('V4 (AC5): the gate reports the merge-base-relative count AND the base-freshness advisory', async () => {
      const stateRepo = new MockStateRepository(implementSnapshot());
      const configRepo = new MockConfigRepository();
      const planGenerator = new MockPlanGenerator();
      const commandExecutor = new MockCommandExecutor();

      const useCase = new RunQualityGateUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        commandExecutor
      );

      const verdict = measuredDiff({
        tracked: ['a.ts', 'b.ts'],
        untracked: ['c.ts'],
        ahead: 2,
        own: 1
      });

      const result = await useCase.execute({ issue: 20, implementationDiff: verdict });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.currentStage, STAGE_REVIEW);
      assert.ok(
        result.summaryReport.includes(evidenceLine(3, 'main')),
        `the count must be exactly what the probe measured, got:\n${result.summaryReport}`
      );
      assert.ok(
        result.summaryReport.includes(
          freshnessLine(2, 1, verdict.mergeBase!)
        ),
        `the report must carry the freshness line, got:\n${result.summaryReport}`
      );
    });

    test('V5 (AC6): a stale-but-measured tree still PASSES — staleness is advisory, never a block', async () => {
      const stateRepo = new MockStateRepository(implementSnapshot());
      const configRepo = new MockConfigRepository();
      const planGenerator = new MockPlanGenerator();
      const commandExecutor = new MockCommandExecutor();

      const useCase = new RunQualityGateUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        commandExecutor
      );

      const verdict = measuredDiff({ tracked: ['src/index.ts'], ahead: 4, own: 2 });
      const result = await useCase.execute({ issue: 20, implementationDiff: verdict });

      assert.strictEqual(result.passed, true, 'the gate must not block on staleness alone');
      assert.strictEqual(result.vacuous, false);
      assert.ok(result.summaryReport.includes(evidenceLine(1, 'main')));
      assert.ok(
        result.summaryReport.includes(freshnessLine(4, 2, verdict.mergeBase!)),
        `the freshness advisory must be surfaced, got:\n${result.summaryReport}`
      );
    });

    test('V6 (AC6): a VACUOUS report over a stale tree carries the Base freshness line and runs no gate command', async () => {
      const stateRepo = new MockStateRepository(implementSnapshot());
      const configRepo = new MockConfigRepository();
      const planGenerator = new MockPlanGenerator();
      const commandExecutor = new MockCommandExecutor();

      const useCase = new RunQualityGateUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        commandExecutor
      );

      const verdict = measuredDiff({ ahead: 2, own: 0 });
      const result = await useCase.execute({ issue: 20, implementationDiff: verdict });

      assert.strictEqual(result.vacuous, true);
      assert.strictEqual(
        commandExecutor.executed.length,
        0,
        'no gate command may run over an unimplemented tree'
      );
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(result.stateMachine.implementToGateLoops, 0);
      assert.ok(
        result.summaryReport.includes(freshnessLine(2, 0, verdict.mergeBase!)),
        `the refusal must explain the staleness, got:\n${result.summaryReport}`
      );
    });

    test('V7 (AC7, RV4): an unmeasurable branch diff is NOT a VACUOUS refusal — the gates run and the report says why', async () => {
      const stateRepo = new MockStateRepository(implementSnapshot());
      const configRepo = new MockConfigRepository();
      const planGenerator = new MockPlanGenerator();
      const commandExecutor = new MockCommandExecutor();

      const useCase = new RunQualityGateUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        commandExecutor
      );

      const error = "git merge-base HEAD 'main' could not resolve the branch point for 'main'";
      const result = await useCase.execute({
        issue: 20,
        implementationDiff: unmeasurableDiff({ error })
      });

      assert.notStrictEqual(result.vacuous, true, 'an unmeasurable diff is not a measured empty tree');
      assert.ok(
        commandExecutor.executed.length > 0,
        'the gate keeps its pre-existing behaviour when the branch cannot be measured'
      );
      assert.ok(
        result.summaryReport.includes(MSG_GATE_UNMEASURABLE.replace('{error}', error)),
        `the report must explain the unmeasurable diff, got:\n${result.summaryReport}`
      );
      assert.ok(
        !result.summaryReport.includes(MSG_GATE_VACUOUS.replace('{baseRef}', 'main')),
        `the report must not claim VACUOUS, got:\n${result.summaryReport}`
      );
      assert.ok(
        !result.summaryReport.includes('VACUOUS'),
        `no surface may print VACUOUS for an unmeasurable diff, got:\n${result.summaryReport}`
      );
    });
  });
});

describe('Quality Gate execution contract (issue #298)', () => {
  function gateSnapshot(extra: Record<string, unknown> = {}): StateMachineSnapshot {
    const now = new Date().toISOString();
    return {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 20,
      createdAt: now,
      updatedAt: now,
      history: [{ stage: STAGE_IMPLEMENT, timestamp: now }],
      ...extra
    } as StateMachineSnapshot;
  }

  function planWithTargets(commands: readonly string[]): string {
    return [
      '# Plan',
      '',
      '## 5. Quality Gate Targets',
      '',
      '```bash',
      ...commands,
      '```',
      ''
    ].join('\n');
  }

  function planWithSmoke(commands: readonly string[], checks: readonly string[]): string {
    const blocks: string[] = [
      '# Plan',
      '',
      '## 5. Quality Gate Targets',
      '',
      '```bash',
      ...commands,
      '```',
      '',
      '## 6. Manual Smoke Test Protocol',
      ''
    ];
    checks.forEach((body, idx) => {
      blocks.push(`#### Check ${idx + 1} — check ${idx + 1}`, '', '```bash', body, '```', '');
    });
    return blocks.join('\n');
  }

  function resultOf(overrides: Partial<CommandExecutionResult> = {}): CommandExecutionResult {
    return {
      command: 'mock',
      exitCode: 0,
      stdout: 'OK\nℹ tests 10\nℹ pass 10\nℹ fail 0',
      stderr: '',
      combinedOutput: 'OK\nℹ tests 10\nℹ pass 10\nℹ fail 0',
      durationMs: 10,
      timedOut: false,
      ...overrides
    } as CommandExecutionResult;
  }

  test('RQG-P1: the plan commands are executed and the source is reported', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm run build', 'npm test']);
    const commandExecutor = new MockCommandExecutor();
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.commandSource, 'plan');
    assert.deepStrictEqual(
      commandExecutor.executed.map((entry) => entry.command),
      ['npm run build', 'npm test']
    );
    assert.ok(result.summaryReport.includes('Command Source'));
    assert.ok(result.summaryReport.includes('Execution Cwd'));
    assert.ok(result.summaryReport.includes('Plan Integrity'));
  });

  test('RQG-L1: a plan-sourced lint failure is a build-class failure', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm run lint', 'npm test']);
    const commandExecutor = new MockCommandExecutor([
      resultOf({ exitCode: 1, stdout: 'lint error', combinedOutput: 'src/x.ts:1:1 lint error', stderr: 'lint error' })
    ]);
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.buildStatus, STATUS_FAILED);
    assert.strictEqual(result.reports[0].id, 'plan-1');
  });

  test('RQG-L2: a lint-required plan with no lint command fails before execution', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm run build']);
    const commandExecutor = new MockCommandExecutor();
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new LintMissingBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(
      commandExecutor.executed.length,
      0,
      'a mandatory lint that is absent must stop the gate before any command runs'
    );
    assert.strictEqual(result.reports.length, 1);
    assert.strictEqual(result.reports[0].id, 'plan-integrity');
    assert.ok(
      (result.reports[0].failureSnippet ?? '').includes(MSG_GATE_LINT_MISSING),
      `the preflight must state the lint invariant, got: ${result.reports[0].failureSnippet}`
    );
    assert.strictEqual(result.buildStatus, STATUS_FAILED);
  });

  test('RQG-P2: a failing plan-sourced `npm test` is a TEST-class failure, not a pass', async () => {
    // Plan targets carry synthetic ids (`plan-N`), so classification must come
    // from the command text: a probe used to report `testsStatus: PASSED` next
    // to an overall FAILED verdict (issue #298 review round 1).
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm test']);
    const commandExecutor = new MockCommandExecutor([
      resultOf({ exitCode: 1, stdout: 'not ok 1', combinedOutput: 'not ok 1 - boom', stderr: '' })
    ]);
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.testsStatus, STATUS_FAILED);
    assert.strictEqual(result.reports[0].id, 'plan-1');
  });

  test('RQG-P3: a failing plan-sourced `npm run build` is a BUILD-class failure', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm run build']);
    const commandExecutor = new MockCommandExecutor([
      resultOf({ exitCode: 1, stdout: 'tsc error', combinedOutput: 'tsc error', stderr: 'tsc error' })
    ]);
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.buildStatus, STATUS_FAILED);
  });

  test('RQG-S1: a static smoke finding fails before any command runs', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithSmoke(['npm test'], [
      'node -e \'const m = require("fixture.js"); console.log(m);\''
    ]);
    const commandExecutor = new MockCommandExecutor();
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(commandExecutor.executed.length, 0, 'no command may run for a broken protocol');
    assert.strictEqual(result.reports[0].id, 'smoke-protocol');
    assert.match(result.reports[0].failureSnippet ?? '', /bare-module-path/);
    assert.match(result.reports[0].failureSnippet ?? '', /Check 1/);
    assert.match(result.reports[0].failureSnippet ?? '', /plan line \d+/);
    assert.strictEqual(result.smokeStatus, 'FAILED');
  });

  test('RQG-T1 (#348): a committed-tree target fails preflight with no command executed', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['git diff --exit-code -- package-lock.json']);
    const commandExecutor = new MockCommandExecutor();
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(
      commandExecutor.executed.length,
      0,
      'the gate must fail closed before running a doomed command'
    );
    assert.strictEqual(result.reports.length, 1);
    assert.strictEqual(result.reports[0].id, 'gate-target-contract');
    assert.strictEqual(result.reports[0].label, 'Quality Gate Target Contract');
    assert.strictEqual(result.reports[0].passed, false);
    assert.ok(
      (result.reports[0].failureSnippet ?? '').includes(
        'git diff --exit-code -- package-lock.json'
      )
    );
    assert.ok((result.reports[0].failureSnippet ?? '').includes('can never pass'));
    assert.strictEqual(result.smokeStatus, SMOKE_STATUS_NOT_DECLARED);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
  });

  test('RQG-T3 (#369): a required-but-unavailable workflow composition fails preflight', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm run lint']);
    const commandExecutor = new MockCommandExecutor();
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new CompositionMissingBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(
      commandExecutor.executed.length,
      0,
      'the gate must fail closed before running anything the composition cannot lint'
    );
    assert.strictEqual(result.reports.length, 1);
    assert.strictEqual(result.reports[0].id, 'gate-target-contract');
    const snippet = result.reports[0].failureSnippet ?? '';
    assert.ok(snippet.includes('.github/workflows/ci.yml'), snippet);
    assert.ok(snippet.includes('actionlint'), snippet);
  });

  test('RQG-S2: a runtime smoke failure names the failing check and plan line', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithSmoke(['npm test'], [
      'echo "C1 PASS"',
      'echo "C2 FAIL: broken"\nexit 1'
    ]);
    const commandExecutor = new MockCommandExecutor([
      resultOf(),
      resultOf({
        exitCode: 1,
        stdout: '__AGYLOOP_SMOKE_CHECK_1__\nC1 PASS\n__AGYLOOP_SMOKE_CHECK_2__\nC2 FAIL: broken\n',
        combinedOutput: '__AGYLOOP_SMOKE_CHECK_1__\nC1 PASS\n__AGYLOOP_SMOKE_CHECK_2__\nC2 FAIL: broken\n'
      })
    ]);
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.smokeStatus, 'FAILED');
    assert.ok(result.smokeReport);
    assert.match(result.smokeReport.failureSnippet ?? '', /Check 2/);
    assert.match(result.smokeReport.failureSnippet ?? '', /plan line \d+/);
  });

  test('RQG-S3: a printed FAIL line fails the gate even on exit 0', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithSmoke(['npm test'], ['echo "S1 PASS"']);
    const commandExecutor = new MockCommandExecutor([
      resultOf(),
      resultOf({
        exitCode: 0,
        stdout: '__AGYLOOP_SMOKE_CHECK_1__\nS1 FAIL: silent lie\n',
        combinedOutput: '__AGYLOOP_SMOKE_CHECK_1__\nS1 FAIL: silent lie\n'
      })
    ]);
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.smokeStatus, 'FAILED');
    assert.match(result.smokeReport?.failureSnippet ?? '', /Check 1/);
  });

  test('RQG-S4: a smoke timeout fails the gate and is named', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithSmoke(['npm test'], ['echo "S1 PASS"']);
    const commandExecutor = new MockCommandExecutor([
      resultOf(),
      resultOf({
        exitCode: -1,
        timedOut: true,
        stdout: '__AGYLOOP_SMOKE_CHECK_1__\n',
        combinedOutput: '__AGYLOOP_SMOKE_CHECK_1__\n'
      })
    ]);
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.smokeStatus, 'TIMED_OUT');
    assert.strictEqual(result.smokeReport?.timedOut, true);
    assert.match(result.smokeReport?.failureSnippet ?? '', /timed out/i);
  });

  test('RQG-D1: a digest mismatch before execution fails with no commands and a plan-integrity report', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm test']);
    planGenerator.digests = ['actual-digest'];
    const commandExecutor = new MockCommandExecutor();
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot({ approvedPlanDigest: 'approved-digest' })),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(commandExecutor.executed.length, 0);
    assert.strictEqual(result.reports[0].id, 'plan-integrity');
    assert.strictEqual(result.planIntegrityStatus, 'mismatch');
    assert.match(result.reports[0].failureSnippet ?? '', /approved-digest/);
    assert.match(result.reports[0].failureSnippet ?? '', /actual-digest/);
  });

  test('RQG-D2: a plan changed during the run fails the gate even when every command passes', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm test']);
    planGenerator.digests = ['before-digest', 'after-digest'];
    const commandExecutor = new MockCommandExecutor();
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.planIntegrityStatus, 'mismatch');
    const integrityReport = result.reports.find((report: GateCommandReport) => report.id === 'plan-integrity');
    assert.ok(integrityReport, 'a mid-run change must append a plan-integrity report');
    assert.match(integrityReport.failureSnippet ?? '', /before-digest/);
    assert.match(integrityReport.failureSnippet ?? '', /after-digest/);
  });

  test('RQG-N1: a plan with no smoke section reports NOT DECLARED and keeps the pass path', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm test']);
    const commandExecutor = new MockCommandExecutor();
    const useCase = new RunQualityGateUseCase(
      new MockStateRepository(gateSnapshot()),
      new MockConfigRepository(),
      planGenerator,
      commandExecutor,
      new MockBuildDetector()
    );

    const result = await useCase.execute({ issue: 20 });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.smokeStatus, 'NOT DECLARED');
    assert.strictEqual(result.smokeReport, undefined);
    assert.strictEqual(result.currentStage, STAGE_REVIEW);
  });
});

describe('in-process gate row names its clock (issue #338)', () => {
  test('#338 T6: the REAL summary writer renders a labelled in-process gate row', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-in-process-gate-'));
    const planDirRel = 'artifacts/plans/20-test';
    const planDir = path.join(ws, planDirRel);
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'implementation_plan.md'), '# Plan\n\n- [ ] Step 1\n', 'utf8');
    const summaryPath = path.join(planDir, 'CodeLoop Summary.md');
    fs.copyFileSync(
      path.join(__dirname, '..', '..', 'templates', 'summary-log.md'),
      summaryPath
    );

    const initialSnapshot: StateMachineSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: MODE_STANDARD,
      issue: 20,
      planDir: planDirRel,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };

    try {
      const useCase = new RunQualityGateUseCase(
        new MockStateRepository(initialSnapshot),
        new MockConfigRepository(),
        new FilePlanGenerator(),
        new MockCommandExecutor()
      );

      const result = await useCase.execute({ issue: 20, workspaceDir: ws, commands: ['true'] });
      assert.strictEqual(result.passed, true);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      const gateRow =
        summary.split('\n').find((line: string) => line.startsWith('| 4. Quality Gate |')) ?? '';
      assert.ok(gateRow.length > 0, `the gate row must exist, got:\n${summary}`);
      const cell = (gateRow.split('|')[5] ?? '').trim();
      assert.match(
        cell,
        /^(?:\d+m )?\d+s \(gate-reported(?:; (?:\d+m )?\d+s wall)?\)$/,
        `the in-process row must name its clock, got: "${cell}"`
      );
      assert.ok(
        summary.includes('- **Smoke Protocol:**'),
        `the in-process round must render the protocol verdict, got:\n${summary}`
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
