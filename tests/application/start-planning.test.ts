/**
 * agyloop - StartPlanningUseCase Unit Tests
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  StateMachine,
  Stage,
  IssueNumber,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_COMPLETED,
  MODE_PLAN,
  PreFlightHaltError,
  SUMMARY_STAGE_DISCOVERY,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STATUS_IN_PROGRESS,
  SUMMARY_STATUS_COMPLETED,
  SUMMARY_STATUS_PENDING
} = require('../../dist/domain');
const { StartPlanningUseCase } = require('../../dist/application');
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

class MockStateRepository implements StateRepository {
  public savedSnapshot: any = null;

  constructor(initialSnapshot: any = null) {
    this.savedSnapshot = initialSnapshot;
  }

  public async load(): Promise<any> {
    return this.savedSnapshot;
  }

  public async save(snapshot: any): Promise<void> {
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

  public scaffoldPlanDirectory(params: ScaffoldParams): ScaffoldResult {
    this.scaffoldedParams = params;
    return {
      planDir: '/fake/plans/10',
      folderName: '10',
      planPath: '/fake/plans/10/plan.md',
      mirrorPath: '/fake/plans/10/mirror',
      summaryPath: '/fake/plans/10/Summary.md',
      type: params.type === 'discovery' ? 'discovery' : 'implementation'
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
    return '/fake/plans/10';
  }

  public resolvePlanFile(): any {
    return null;
  }

  public readPlanDocument(): string {
    return '';
  }
}

describe('StartPlanningUseCase (Application Layer)', () => {
  let stateRepo: MockStateRepository;
  let githubGateway: MockGitHubGateway;
  let configRepo: MockConfigRepository;
  let planGenerator: MockPlanGenerator;

  beforeEach(() => {
    stateRepo = new MockStateRepository();
    githubGateway = new MockGitHubGateway();
    configRepo = new MockConfigRepository();
    planGenerator = new MockPlanGenerator();
  });

  test('bypasses DISCOVERY directly to PLAN and APPROVAL when skipDiscovery is set', async () => {
    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({
      issue: 10,
      title: 'Add User Preferences Feature',
      type: 'feature',
      skipDiscovery: true
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_APPROVAL);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_DISCOVERY), false);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN), true);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_APPROVAL);

    // Verify summary log does not record redundant discovery row when skipDiscovery is true
    assert.strictEqual(
      planGenerator.summaryUpdates.some((u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY),
      false
    );
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_PLAN_REVIEW && u.updateData.status === SUMMARY_STATUS_PENDING
      )
    );
  });

  test('preserves DISCOVERY in history and advances to APPROVAL for features', async () => {
    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({
      issue: 10,
      title: 'Add User Preferences Feature',
      type: 'feature'
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_APPROVAL);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_DISCOVERY), true);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN), true);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_APPROVAL);

    // Verify summary log records discovery completed and plan review pending
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY && u.updateData.status === SUMMARY_STATUS_COMPLETED
      )
    );
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_PLAN_REVIEW && u.updateData.status === SUMMARY_STATUS_PENDING
      )
    );
  });

  test('transitions bug task to DISCOVERY and pauses for RCA subagent', async () => {
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number: 11,
      title: 'Fix crash on login screen',
      body: 'App crashes when login button is clicked',
      labels: ['bug', 'defect'],
      comments: [],
      state: 'OPEN'
    };

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({
      issue: 11
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_DISCOVERY), true);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN), false);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);

    // Verify summary log recorded discovery in progress
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY && u.updateData.status === SUMMARY_STATUS_IN_PROGRESS
      )
    );
  });

  test('advances from DISCOVERY to PLAN then APPROVAL after discovery completion', async () => {
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number: 11,
      title: 'Fix crash on login screen',
      body: 'App crashes when login button is clicked',
      labels: ['bug', 'defect'],
      comments: [],
      state: 'OPEN'
    };

    const sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: 11 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    stateRepo.savedSnapshot = sm.toSnapshot();

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({
      issue: 11
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_APPROVAL);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_DISCOVERY), true);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN), true);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_APPROVAL);

    // Verify summary log recorded discovery completed and plan review pending
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY && u.updateData.status === SUMMARY_STATUS_COMPLETED
      )
    );
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_PLAN_REVIEW && u.updateData.status === SUMMARY_STATUS_PENDING
      )
    );
  });

  test('handles iterative plan redirection loop from APPROVAL back to PLAN with userFeedback', async () => {
    const sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: 12 });
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    stateRepo.savedSnapshot = sm.toSnapshot();

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({
      issue: 12,
      userFeedback: 'Please add telemetry metrics to the architecture',
      previousPlanContent: '# Original Plan\n...'
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.stateMachine.planRevisionCount, 1);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_PLAN);
    assert.strictEqual(stateRepo.savedSnapshot.planRevisionCount, 1);

    // Verify summary log records revision count
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_PLAN_REVIEW && u.updateData.planRevisionCount === 1
      )
    );
  });

  test('tracks multiple planRevisionCount iterations', async () => {
    const sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: 13 });
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    stateRepo.savedSnapshot = sm.toSnapshot();

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    // Iteration 1
    const res1 = await useCase.execute({
      issue: 13,
      userFeedback: 'First feedback revision'
    });
    assert.strictEqual(res1.stateMachine.planRevisionCount, 1);

    // Re-advance to approval
    res1.stateMachine.transition(STAGE_APPROVAL);
    stateRepo.savedSnapshot = res1.stateMachine.toSnapshot();

    // Iteration 2
    const res2 = await useCase.execute({
      issue: 13,
      userFeedback: 'Second feedback revision'
    });
    assert.strictEqual(res2.stateMachine.planRevisionCount, 2);
  });

  test('throws PreFlightHaltError when issue is CLOSED', async () => {
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number: 99,
      title: 'Closed issue',
      body: '',
      labels: [],
      comments: [],
      state: 'CLOSED'
    };

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    await assert.rejects(
      async () => {
        await useCase.execute({ issue: 99 });
      },
      PreFlightHaltError
    );
  });
});
