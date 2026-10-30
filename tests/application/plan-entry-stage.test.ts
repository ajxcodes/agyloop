/**
 * agyloop - Plan entry stage tests (issue #379)
 *
 * Pins the entry decision the use case takes from the issue kind, and the
 * `next` directive it leaves behind. The issue-label lookup is stubbed through
 * `MockGitHubGateway.issueToReturn.labels`, so the two branches (bug ->
 * DISCOVERY, feature -> PLAN) are proven to come from the label, not from the
 * execution mode.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  STAGE_DISCOVERY,
  STAGE_PLAN,
  MODE_PLAN,
  SUMMARY_STAGE_DISCOVERY,
  SUMMARY_STATUS_IN_PROGRESS,
  SUMMARY_STATUS_SKIPPED
} = require('../../dist/domain');
const { StartPlanningUseCase, GetNextActionUseCase } = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

import type {
  StateRepository,
  GitHubGateway,
  GitHubIssueData,
  ConfigRepository,
  PlanGeneratorPort,
  ScaffoldParams,
  ScaffoldResult,
  AgyLoopConfig
} from '../../src/ports';

const PLAN_DIR = '/fake/plans/11';
const REPORT_TITLE = 'Dashboard filters missing';
const REPORT_PATH = `${PLAN_DIR}/[Discovery] - ${REPORT_TITLE}.md`;

const POPULATED_REPORT = [
  '# [Discovery] - Dashboard filters missing',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:** the dashboard renders no filters',
  '- **Expected Behavior:** the dashboard renders filters',
  '- **Affected Components / Paths:** src/login.ts',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:** read src/login.ts end to end',
  '- **Identified Failure Mode:** nil dereference of the session resolver',
  '- **Relevant Code References:** src/login.ts:41',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '- **Local Reproduction Command:** npm test -- --grep login',
  '- **Failing Test Target:** tests/login.test.ts',
  '',
  '## 4. Remediation Strategy',
  '- **Recommended Fix Approach:** guard the resolver result before use',
  '- **Potential Regressions / Side Effects:** none'
].join('\n');

const BLANK_REPORT = [
  '# [Discovery] - Dashboard filters missing',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:**',
  '- **Expected Behavior:**',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:**',
  '- **Identified Failure Mode:**'
].join('\n');

class MockStateRepository implements StateRepository {
  public savedSnapshot: any = null;
  public saveCount = 0;

  constructor(initialSnapshot: any = null) {
    this.savedSnapshot = initialSnapshot;
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
    return '/fake/state.json';
  }
}

class MockGitHubGateway implements GitHubGateway {
  public issueToReturn: GitHubIssueData | null = null;

  public getCurrentRepo(): string | null {
    return 'owner/repo';
  }

  public async fetchIssue(num: number): Promise<GitHubIssueData | null> {
    if (this.issueToReturn) return this.issueToReturn;
    return {
      repo: 'owner/repo',
      number: num,
      title: 'Default Issue Title',
      body: 'Default body',
      labels: [],
      comments: [],
      state: 'OPEN'
    };
  }
}

class MockConfigRepository implements ConfigRepository {
  public loadConfig(): AgyLoopConfig {
    return DEFAULT_CONFIG;
  }

  public resolveModel(role: string): any {
    return {
      role,
      configured: 'flash',
      tier: 'flash',
      apiModel: 'gemini-3.5-flash'
    };
  }

  public mapModelToTier(): any {
    return 'flash';
  }
}

class MockPlanGenerator implements PlanGeneratorPort {
  public summaryUpdates: any[] = [];
  public scaffoldedParams: ScaffoldParams | null = null;
  public resolvedPlan: any = null;
  public planDocument = BLANK_REPORT;

  public scaffoldPlanDirectory(params: ScaffoldParams): ScaffoldResult {
    this.scaffoldedParams = params;
    const type = params.type === 'discovery' ? 'discovery' : 'implementation';
    const planPath =
      type === 'discovery'
        ? `${PLAN_DIR}/[Discovery] - ${params.title ?? 'Task Plan'}.md`
        : `${PLAN_DIR}/implementation_plan.md`;
    return {
      planDir: PLAN_DIR,
      folderName: '11',
      planPath,
      mirrorPath: `${PLAN_DIR}/implementation_plan.md`,
      summaryPath: `${PLAN_DIR}/Summary.md`,
      type,
      directoryCreated: true,
      filesCreated: true,
      adoptedExisting: false
    };
  }

  public generatePlan(): any {
    return null;
  }

  public generateSummaryLog(): any {
    return null;
  }

  public updateSummaryLog(summaryFilePath: string, updateData: any): boolean {
    this.summaryUpdates.push({ summaryFilePath, updateData });
    return true;
  }

  public findPlanDirectory(): string | null {
    return PLAN_DIR;
  }

  public resolvePlanFile(options: any = {}): any {
    // Only DISCOVERY resolution has a configured report. A stage-less lookup
    // (the dry-run "reuse" probe) sees nothing until a directory exists.
    if (options.stage === STAGE_DISCOVERY) {
      return this.resolvedPlan;
    }
    return null;
  }

  public readPlanDocument(): string {
    return this.planDocument;
  }
}

function issueWithLabels(number: number, labels: string[]): GitHubIssueData {
  return {
    repo: 'owner/repo',
    number,
    title: REPORT_TITLE,
    body: 'The form crashes on submit.',
    labels,
    comments: [],
    state: 'OPEN'
  } as GitHubIssueData;
}

describe('Plan entry stage (issue #379)', () => {
  let stateRepo: MockStateRepository;
  let githubGateway: MockGitHubGateway;
  let configRepo: MockConfigRepository;
  let planGenerator: MockPlanGenerator;

  function buildUseCase(): any {
    return new StartPlanningUseCase(stateRepo, githubGateway, configRepo, planGenerator);
  }

  beforeEach(() => {
    stateRepo = new MockStateRepository();
    githubGateway = new MockGitHubGateway();
    configRepo = new MockConfigRepository();
    planGenerator = new MockPlanGenerator();
  });

  test('PE-SP1: a bug-labelled issue parks at DISCOVERY with an actionable entry', async () => {
    githubGateway.issueToReturn = issueWithLabels(11, ['bug']);

    const result = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.ok(
      !result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN),
      'a bug entry must not record a PLAN transition'
    );
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.planEntry?.stage, STAGE_DISCOVERY);
    assert.strictEqual(result.planEntry?.source, 'issue-kind-bug');
    assert.strictEqual(result.discoveryParked, true);

    const entry = stateRepo.savedSnapshot.history[stateRepo.savedSnapshot.history.length - 1];
    assert.strictEqual(entry.stage, STAGE_DISCOVERY);
    assert.strictEqual(entry.metadata.entryStage, STAGE_DISCOVERY);
    assert.strictEqual(entry.metadata.entrySource, 'issue-kind-bug');
    assert.strictEqual(entry.metadata.issueKind, 'bug');
    assert.strictEqual(planGenerator.scaffoldedParams?.type, 'discovery');
    assert.ok(stateRepo.savedSnapshot.planDir, 'INV-3: the checkpoint must record planDir');
  });

  test('PE-SP2: a non-bug issue lands at PLAN with no phantom DISCOVERY', async () => {
    githubGateway.issueToReturn = issueWithLabels(11, ['enhancement']);

    const result = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.ok(
      !result.stateMachine.history.some((h: any) => h.stage === STAGE_DISCOVERY),
      'a feature entry must record no DISCOVERY stage'
    );
    assert.strictEqual(result.planEntry?.source, 'issue-kind-feature');
    const planEntry = stateRepo.savedSnapshot.history
      .filter((h: any) => h.stage === STAGE_PLAN)
      .pop();
    assert.strictEqual(planEntry.metadata.entryStage, STAGE_PLAN);
    assert.strictEqual(planEntry.metadata.entrySource, 'issue-kind-feature');
    assert.strictEqual(result.discoveryParked, false);
    assert.strictEqual(planGenerator.scaffoldedParams?.type, 'implementation');
  });

  test('PE-SP3: --type overrides the label inference in both directions', async () => {
    githubGateway.issueToReturn = issueWithLabels(11, ['bug']);
    const bugImplementation = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      type: 'implementation',
      workspaceDir: '/fake/workspace'
    });
    assert.strictEqual(bugImplementation.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(
      bugImplementation.stateMachine.history.filter((h: any) => h.stage === STAGE_PLAN).pop().metadata
        .entrySource,
      'type-override'
    );

    stateRepo = new MockStateRepository();
    planGenerator = new MockPlanGenerator();
    githubGateway = new MockGitHubGateway();
    githubGateway.issueToReturn = issueWithLabels(11, ['enhancement']);
    const featureDiscovery = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      type: 'discovery',
      workspaceDir: '/fake/workspace'
    });
    assert.strictEqual(featureDiscovery.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(
      featureDiscovery.stateMachine.history.filter((h: any) => h.stage === STAGE_DISCOVERY).pop().metadata
        .entrySource,
      'type-override'
    );
  });

  test('PE-SP4: a blank scaffold never advances; a populated report does', async () => {
    // (a) A pristine scaffold stays at DISCOVERY.
    githubGateway.issueToReturn = issueWithLabels(11, ['bug']);
    planGenerator.planDocument = BLANK_REPORT;
    const blank = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });
    assert.strictEqual(blank.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(blank.discoveryReportEvidence.populated, false);

    // (b) A report already filled on disk is evidence and advances to PLAN.
    stateRepo = new MockStateRepository();
    planGenerator = new MockPlanGenerator();
    planGenerator.resolvedPlan = {
      planDir: PLAN_DIR,
      planPath: REPORT_PATH,
      planFileName: `[Discovery] - ${REPORT_TITLE}.md`,
      summaryPath: `${PLAN_DIR}/Summary.md`
    };
    planGenerator.planDocument = POPULATED_REPORT;
    const populated = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });
    assert.strictEqual(populated.stateMachine.currentStage, STAGE_PLAN);
    const planEntry = populated.stateMachine.history
      .filter((h: any) => h.stage === STAGE_PLAN)
      .pop();
    assert.strictEqual(planEntry.metadata.entrySource, 'discovery-report-present');
    assert.strictEqual(planEntry.metadata.discoveryReportPath, REPORT_PATH);

    // (c) A feature entry records its skip reason.
    stateRepo = new MockStateRepository();
    planGenerator = new MockPlanGenerator();
    githubGateway.issueToReturn = issueWithLabels(11, ['enhancement']);
    const feature = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });
    assert.strictEqual(feature.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(feature.planEntry?.source, 'issue-kind-feature');
  });

  test('PE-SP5: the two branches are driven by the stubbed label lookup', async () => {
    const cases = [
      ['bug', STAGE_DISCOVERY],
      ['enhancement', STAGE_PLAN]
    ];
    for (const [label, expected] of cases) {
      stateRepo = new MockStateRepository();
      planGenerator = new MockPlanGenerator();
      githubGateway = new MockGitHubGateway();
      githubGateway.issueToReturn = issueWithLabels(11, [label]);
      const result = await buildUseCase().execute({
        issue: 11,
        mode: MODE_PLAN,
        workspaceDir: '/fake/workspace'
      });
      assert.strictEqual(result.stateMachine.currentStage, expected, label);
    }
  });

  test('PE-SP6: --skip-discovery wins and is recorded on the PLAN transition', async () => {
    githubGateway.issueToReturn = issueWithLabels(11, ['bug']);

    const result = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      skipDiscovery: true,
      workspaceDir: '/fake/workspace'
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.discoveryParked, false);
    const planEntry = stateRepo.savedSnapshot.history
      .filter((h: any) => h.stage === STAGE_PLAN)
      .pop();
    assert.strictEqual(planEntry.metadata.skipDiscovery, true);
    assert.strictEqual(planEntry.metadata.entrySource, 'skip-discovery');
    assert.strictEqual(planGenerator.scaffoldedParams?.type, 'discovery');
  });

  test('PE-SP7: the Discovery summary row tells the truth on both branches', async () => {
    githubGateway.issueToReturn = issueWithLabels(11, ['bug']);
    await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });
    const bugRow = planGenerator.summaryUpdates
      .filter((u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY)
      .pop();
    assert.strictEqual(bugRow.updateData.status, SUMMARY_STATUS_IN_PROGRESS);
    assert.strictEqual(bugRow.updateData.subagent, 'discovery');

    stateRepo = new MockStateRepository();
    planGenerator = new MockPlanGenerator();
    githubGateway.issueToReturn = issueWithLabels(11, ['enhancement']);
    await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });
    const featureRow = planGenerator.summaryUpdates
      .filter((u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY)
      .pop();
    assert.strictEqual(featureRow.updateData.status, SUMMARY_STATUS_SKIPPED);
    assert.strictEqual(featureRow.updateData.subagent, '-');
    assert.strictEqual(featureRow.updateData.model, '-');
  });

  test('PE-SP8: a DISCOVERY re-entry park stays a no-op', async () => {
    const { StateMachine } = require('../../dist/domain');
    const sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: 11 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    stateRepo.savedSnapshot = sm.toSnapshot();
    githubGateway.issueToReturn = issueWithLabels(11, ['bug']);
    planGenerator.resolvedPlan = {
      planDir: PLAN_DIR,
      planPath: REPORT_PATH,
      planFileName: `[Discovery] - ${REPORT_TITLE}.md`,
      summaryPath: `${PLAN_DIR}/Summary.md`
    };
    planGenerator.planDocument = BLANK_REPORT;

    const result = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });

    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
    assert.strictEqual(result.discoveryParked, true);
    assert.strictEqual(stateRepo.saveCount, 0, 'a re-entry park must write nothing');
    assert.strictEqual(planGenerator.scaffoldedParams, null, 'a re-entry park must scaffold nothing');
  });

  test('PE-SP9: the bug dry run previews the park and writes nothing', async () => {
    githubGateway.issueToReturn = issueWithLabels(11, ['bug']);

    const result = await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      dryRun: true,
      workspaceDir: '/fake/workspace'
    });

    assert.strictEqual(result.discoveryParked, true);
    assert.strictEqual(result.dryRunPreview?.action, 'scaffold');
    assert.strictEqual(result.dryRunPreview?.type, 'discovery');
    assert.strictEqual(planGenerator.scaffoldedParams, null);
    assert.strictEqual(stateRepo.saveCount, 0);
  });

  test('PE-NA1: the bug checkpoint leaves an actionable discovery dispatch', async () => {
    githubGateway.issueToReturn = issueWithLabels(11, ['bug']);
    await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });

    planGenerator.resolvedPlan = {
      planDir: PLAN_DIR,
      planPath: REPORT_PATH,
      planFileName: `[Discovery] - ${REPORT_TITLE}.md`,
      summaryPath: `${PLAN_DIR}/Summary.md`
    };
    planGenerator.planDocument = BLANK_REPORT;

    const next = await new GetNextActionUseCase(stateRepo, configRepo, planGenerator).execute({
      issue: 11,
      workspaceDir: '/fake/workspace'
    });

    assert.strictEqual(next.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(next.actionType, 'subagent');
    assert.strictEqual(next.role, 'discovery');
    assert.ok(next.invocationPayload, 'a dispatchable subagent directive carries a payload');
    const subagent = next.invocationPayload.Subagents[0];
    assert.match(String(subagent.Role), /Discovery/);
    assert.ok(
      String(subagent.Prompt).includes('[Discovery]'),
      'the prompt must name the scaffolded RCA report'
    );
    assert.strictEqual(next.discoveryReportPopulated, false);
  });

  test('PE-NA2: the feature checkpoint leaves the planner directive', async () => {
    githubGateway.issueToReturn = issueWithLabels(11, ['enhancement']);
    await buildUseCase().execute({
      issue: 11,
      mode: MODE_PLAN,
      workspaceDir: '/fake/workspace'
    });

    const next = await new GetNextActionUseCase(stateRepo, configRepo, planGenerator).execute({
      issue: 11,
      workspaceDir: '/fake/workspace'
    });

    assert.strictEqual(next.actionType, 'subagent');
    assert.strictEqual(next.role, 'planner');
  });
});
