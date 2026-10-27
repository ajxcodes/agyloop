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
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  MODE_PLAN,
  MODE_STANDARD,
  MODE_YOLO,
  PreFlightHaltError,
  SUMMARY_STAGE_DISCOVERY,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STATUS_IN_PROGRESS,
  SUMMARY_STATUS_COMPLETED,
  SUMMARY_STATUS_PENDING,
  SUMMARY_STATUS_SKIPPED
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
  /**
   * null by default: the generator cannot resolve a plan for a fresh directory.
   * Set to a location (plus `planDocument`) to simulate a discovery report that
   * actually exists on disk — the content evidence `resolveDiscoveryReentry`
   * needs before it will advance a DISCOVERY checkpoint (issue #237).
   */
  public resolvedPlan: any = null;
  public planDocument = '';
  /**
   * Optional per-path override, so a test can make the scaffold's discovery
   * report and the file `resolvePlanFile` hands back differ — which is exactly
   * what happens on a real bug task (see `hasPopulatedDiscoveryReport`).
   */
  public planDocumentByPath: Record<string, string> = {};
  /**
   * When set, `scaffoldPlanDirectory` reports this planDir instead of the
   * default. Used to reproduce BLOCKER 2: a re-entry whose re-derived slug
   * differs from the seed, so the scaffold lands in a different directory.
   */
  public scaffoldPlanDirOverride: string | null = null;

  public scaffoldPlanDirectory(params: ScaffoldParams): ScaffoldResult {
    this.scaffoldedParams = params;
    if (this.scaffoldPlanDirOverride) {
      const planDir = this.scaffoldPlanDirOverride;
      return {
        planDir,
        folderName: planDir.split('/').pop() as string,
        planPath: `${planDir}/[Discovery] - ${params.title ?? 'Task Plan'}.md`,
        mirrorPath: `${planDir}/implementation_plan.md`,
        summaryPath: `${planDir}/Summary.md`,
        type: params.type === 'discovery' ? 'discovery' : 'implementation',
        directoryCreated: true,
        filesCreated: true,
        adoptedExisting: false
      };
    }
    return {
      planDir: '/fake/plans/10',
      folderName: '10',
      planPath: '/fake/plans/10/plan.md',
      mirrorPath: '/fake/plans/10/mirror',
      summaryPath: '/fake/plans/10/Summary.md',
      type: params.type === 'discovery' ? 'discovery' : 'implementation',
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
    return '/fake/plans/10';
  }

  public resolvePlanFile(): any {
    return this.resolvedPlan;
  }

  public readPlanDocument(planPath?: string): string {
    if (planPath && Object.prototype.hasOwnProperty.call(this.planDocumentByPath, planPath)) {
      return this.planDocumentByPath[planPath];
    }
    return this.planDocument;
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

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_DISCOVERY), false);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN), true);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_PLAN);

    // Issue #284: a bypassed RCA gate is RECORDED as SKIPPED (terminal), not
    // omitted — a skipped stage must never be reported as one that ran, and a
    // missing row cannot be distinguished from an unfinished one.
    const discoveryUpdate = planGenerator.summaryUpdates.find(
      (u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY
    );
    assert.ok(discoveryUpdate, 'the bypassed Discovery row must still be written');
    assert.strictEqual(discoveryUpdate!.updateData.status, SUMMARY_STATUS_SKIPPED);
    assert.strictEqual(discoveryUpdate!.updateData.subagent, 'discovery');
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_PLAN_REVIEW && u.updateData.status === SUMMARY_STATUS_IN_PROGRESS
      )
    );
  });

  test('respects provided mode parameter during execute', async () => {
    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({
      issue: 12,
      mode: 'yolo' as any
    });

    assert.strictEqual(result.stateMachine.mode, 'yolo');
    assert.strictEqual(stateRepo.savedSnapshot.mode, 'yolo');
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

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_DISCOVERY), true);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN), true);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_PLAN);

    // Verify summary log records discovery completed and plan review pending
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY && u.updateData.status === SUMMARY_STATUS_COMPLETED
      )
    );
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_PLAN_REVIEW && u.updateData.status === SUMMARY_STATUS_IN_PROGRESS
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
      issue: 11,
      mode: MODE_STANDARD
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

    // A discovery subagent actually ran: the report on disk carries content.
    // This is the evidence `resolveDiscoveryReentry` requires before it will
    // advance a checkpoint that is already resting at DISCOVERY (issue #237).
    planGenerator.resolvedPlan = {
      planDir: '/fake/plans/10',
      planPath: '/fake/plans/10/[Discovery] - Fix crash on login screen.md',
      planFileName: '[Discovery] - Fix crash on login screen.md',
      summaryPath: '/fake/plans/10/Summary.md'
    };
    planGenerator.planDocument = [
      '# [Discovery] - Fix crash on login screen',
      '',
      '## 1. Problem Statement & Symptoms',
      '- **Observed Behavior:** app crashes when the login button is clicked',
      '- **Expected Behavior:** the login form renders with a validation error',
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

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({
      issue: 11
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.discoveryReentry, 'ADVANCE_TO_PLAN');
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_DISCOVERY), true);
    assert.strictEqual(result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN), true);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_PLAN);

    // Verify summary log recorded discovery completed and plan review pending
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY && u.updateData.status === SUMMARY_STATUS_COMPLETED
      )
    );
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_PLAN_REVIEW && u.updateData.status === SUMMARY_STATUS_IN_PROGRESS
      )
    );
  });

  test('parks at DISCOVERY on re-entry when the discovery report is still an unpopulated scaffold', async () => {
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number: 11,
      title: 'Fix crash on login screen',
      body: 'App crashes when login button is clicked',
      labels: ['bug', 'defect'],
      comments: [],
      state: 'OPEN'
    };

    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 11 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    stateRepo.savedSnapshot = sm.toSnapshot();

    // The generator CAN resolve a discovery file — the pristine scaffold the
    // park is about — but its content carries no filled key bullets.
    planGenerator.resolvedPlan = {
      planDir: '/fake/plans/10',
      planPath: '/fake/plans/10/[Discovery] - Fix crash on login screen.md',
      planFileName: '[Discovery] - Fix crash on login screen.md',
      summaryPath: '/fake/plans/10/Summary.md'
    };
    planGenerator.planDocument = [
      '# [Discovery] - Fix crash on login screen',
      '',
      '## 1. Problem Statement & Symptoms',
      '- **Observed Behavior:**',
      '- **Expected Behavior:**',
      '- **Affected Components / Paths:**',
      '',
      '## 2. Root Cause Analysis (RCA)',
      '- **Investigation Steps:**',
      '- **Identified Failure Mode:**',
      '- **Relevant Code References:**'
    ].join('\n');

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({ issue: 11, mode: MODE_YOLO });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
    assert.strictEqual(
      result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN),
      false,
      'a parked re-entry must gain no PLAN history entry'
    );
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);

    // The existing summary-log leg still records Discovery / IN PROGRESS, and
    // nothing claims the plan review started.
    assert.ok(
      planGenerator.summaryUpdates.some(
        (u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY && u.updateData.status === SUMMARY_STATUS_IN_PROGRESS
      )
    );
    assert.ok(
      !planGenerator.summaryUpdates.some((u: any) => u.updateData.stage === SUMMARY_STAGE_PLAN_REVIEW)
    );
  });

  test('a read failure while loading the discovery report fails closed to the park', async () => {
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number: 11,
      title: 'Fix crash on login screen',
      body: 'App crashes when login button is clicked',
      labels: ['bug', 'defect'],
      comments: [],
      state: 'OPEN'
    };

    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 11 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    stateRepo.savedSnapshot = sm.toSnapshot();

    planGenerator.resolvedPlan = {
      planDir: '/fake/plans/10',
      planPath: '/fake/plans/10/unreadable.md',
      planFileName: 'unreadable.md'
    };
    planGenerator.readPlanDocument = (): string => {
      throw new Error('EACCES: permission denied');
    };

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({ issue: 11, mode: MODE_YOLO });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
  });

  test('the scaffolded discovery report is the evidence, not the implementation mirror the resolver returns', async () => {
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number: 11,
      title: 'Fix crash on login screen',
      body: 'App crashes when login button is clicked',
      labels: ['bug', 'defect'],
      comments: [],
      state: 'OPEN'
    };

    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 11 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    stateRepo.savedSnapshot = sm.toSnapshot();

    // `resolvePlanFile` picks the `implementation_plan.md` alias out of the
    // DISCOVERY candidate list, which is the PRISTINE mirror — not the RCA.
    const populated = [
      '# [Discovery] - Fix crash on login screen',
      '- **Observed Behavior:** crash on login with an empty cookie jar',
      '- **Expected Behavior:** the login form renders a validation error',
      '- **Affected Components / Paths:** src/login.ts',
      '- **Investigation Steps:** read src/login.ts end to end',
      '- **Identified Failure Mode:** nil dereference of the session resolver',
      '- **Relevant Code References:** src/login.ts:41',
      '- **Local Reproduction Command:** npm test -- --grep login',
      '- **Failing Test Target:** tests/login.test.ts',
      '- **Recommended Fix Approach:** guard the resolver result',
      '- **Potential Regressions / Side Effects:** none'
    ].join('\n');
    planGenerator.planDocumentByPath = {
      // The scaffold's own discovery report (the file the discovery subagent wrote).
      '/fake/plans/10/plan.md': populated,
      // The pristine mirror the port's own resolution points at.
      '/fake/plans/10/implementation_plan.md': '- **Observed Behavior:**\n- **Expected Behavior:**\n'
    };
    planGenerator.resolvedPlan = {
      planDir: '/fake/plans/10',
      planPath: '/fake/plans/10/implementation_plan.md',
      planFileName: 'implementation_plan.md'
    };

    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({ issue: 11, mode: MODE_YOLO });

    assert.strictEqual(result.discoveryReentry, 'ADVANCE_TO_PLAN');
    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
  });

  test('T-320.4: an implementation-shaped document is never scored as RCA evidence', async () => {
    // Both the scaffold's own candidate (`scaffoldInfo.planPath`) and the
    // resolver's answer point at implementation-shaped content. Kind is checked
    // BEFORE content, so neither may populate the gate or invent a gap
    // (issue #320, AC1).
    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 11 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    stateRepo.savedSnapshot = sm.toSnapshot();

    const substantiveImplementation = [
      '# [Implementation] - probe',
      '',
      '## 1. Context & Objectives',
      '- **Feature Overview:** stale substantive implementation content.',
      '- **Acceptance Criteria:** it must never satisfy the RCA gate.',
      '',
      '## 2. Architectural Design & Impact',
      '- **Component Breakdown:** the gate and the directive.',
      '- **Data Flow / Model Invariants:** kind is checked before content.',
      '- **Dependencies & Imports:** domain predicates only.',
      '',
      '## 3. Implementation Steps',
      '- [ ] **Step 1:** add the discovery-shape filter before scoring.',
      '',
      '## 4. Quality Gate & Test Verification',
      '- **Target 1:** npm run lint'
    ].join('\n');

    planGenerator.planDocument = substantiveImplementation;
    planGenerator.planDocumentByPath = {
      '/fake/plans/10/plan.md': substantiveImplementation,
      '/fake/plans/10/implementation_plan.md': substantiveImplementation
    };
    planGenerator.resolvedPlan = {
      planDir: '/fake/plans/10',
      planPath: '/fake/plans/10/implementation_plan.md',
      planFileName: 'implementation_plan.md'
    };

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 11, mode: MODE_YOLO });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
    assert.strictEqual(result.discoveryReportEvidence.populated, false);
    assert.strictEqual(result.discoveryReportEvidence.populatedPath, null);
    assert.strictEqual(result.discoveryReportEvidence.missingEvidence, null);
  });

  test('skipDiscovery short-circuits DISCOVERY -> PLAN on re-entry and records the bypass', async () => {
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number: 11,
      title: 'Fix crash on login screen',
      body: 'App crashes when login button is clicked',
      labels: ['bug', 'defect'],
      comments: [],
      state: 'OPEN'
    };

    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 11 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    stateRepo.savedSnapshot = sm.toSnapshot();

    // No report at all, and no content: only the explicit opt-in can release this.
    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );

    const result = await useCase.execute({
      issue: 11,
      mode: MODE_YOLO,
      skipDiscovery: true
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.discoveryReentry, 'ADVANCE_TO_PLAN');
    // The opt-in is recorded in history metadata so a bypassed RCA gate is auditable.
    const planEntry = result.stateMachine.history.find((h: any) => h.stage === STAGE_PLAN);
    assert.ok(planEntry, 'a PLAN history entry must exist');
    assert.strictEqual(planEntry!.metadata?.skipDiscovery, true);
    // Issue #284: the bypass is recorded as a TERMINAL SKIPPED row, naming the
    // discovery subagent — never omitted, never COMPLETED.
    const bypassRow = planGenerator.summaryUpdates.find(
      (u: any) => u.updateData.stage === SUMMARY_STAGE_DISCOVERY
    );
    assert.ok(bypassRow, 'the bypassed Discovery row must still be written');
    assert.strictEqual(bypassRow!.updateData.status, SUMMARY_STATUS_SKIPPED);
    assert.strictEqual(bypassRow!.updateData.subagent, 'discovery');
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

  // ---- issue #237, BLOCKER 2: the re-entry evidence check read the wrong
  // plan directory. `scaffoldPlanDirectory` re-derives the folder slug from the
  // issue title, so a natural re-entry (`yolo --issue 237`, no `--title`)
  // produced a DIFFERENT slug from the one the first run seeded. The
  // unconditional `sm.setPlanDir(scaffoldInfo.planDir)` then repointed the
  // checkpoint at the new empty scaffold, and `hasPopulatedDiscoveryReport`
  // — which read `sm.planDir` — was scoped to it. The operator was told their
  // populated report "is still an unpopulated scaffold".
  //
  // `planGenerator` here mocks the mismatch directly: the scaffold lands in
  // `237-task-plan` while the checkpoint already tracks
  // `237-bug-probe-crash`.
  /** A real discovery report in the nested sub-list shape subagents write. */
  const POPULATED_NESTED_REPORT = [
    '# [Discovery] - Bug: probe crash',
    '',
    '## 1. Problem Statement & Symptoms',
    '- **Observed Behavior:** probe crash on login whenever the session cookie is absent',
    '- **Expected Behavior:** the login form renders an inline validation error',
    '- **Affected Components / Paths:**',
    '  - `src/login.ts`',
    '  - `src/session.ts`',
    '',
    '## 2. Root Cause Analysis (RCA)',
    '- **Investigation Steps:**',
    '  1. Read `src/login.ts` end to end.',
    '  2. Reproduced with a cleared cookie jar.',
    '- **Identified Failure Mode:** nil dereference of the session resolver at `src/login.ts:41`',
    '- **Relevant Code References:**',
    '  - `src/login.ts` (line 41)',
    '  - `src/session.ts` (line 12)',
    '',
    '## 3. Reproduction Steps & Verification Protocol',
    '- **Local Reproduction Command:**',
    '  1. `npm test -- --grep login`',
    '  2. Observe the crash.',
    '- **Failing Test Target:** `tests/login.test.ts`',
    '',
    '## 4. Remediation Strategy',
    '- **Recommended Fix Approach:** guard the resolver result before dereferencing',
    '- **Potential Regressions / Side Effects:** none; the guard only adds an early return'
  ].join('\n');

  /** Seeds a DISCOVERY checkpoint that already tracks `checkpointPlanDir`. */
  function seedCheckpointWithPlanDir(checkpointPlanDir: string): void {
    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 237 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    sm.setPlanDir(checkpointPlanDir);
    stateRepo.savedSnapshot = sm.toSnapshot();
  }

  /** Runs the re-entry and returns the use case result. */
  async function runReentry(issue = 237) {
    const useCase = new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    );
    return useCase.execute({ issue, mode: MODE_YOLO });
  }

  test('BLOCKER 2: a populated report in the CHECKPOINT directory releases the park', async () => {
    // The exact reviewer repro: the checkpoint tracks `237-bug-probe-crash`
    // (populated), the re-entry scaffolds the differently-slugged
    // `237-task-plan` (empty). The park must be released, not held.
    seedCheckpointWithPlanDir('/fake/plans/237-bug-probe-crash');
    planGenerator.resolvedPlan = {
      planDir: '/fake/plans/237-bug-probe-crash',
      planPath: '/fake/plans/237-bug-probe-crash/[Discovery] - Bug probe crash.md',
      planFileName: '[Discovery] - Bug probe crash.md'
    };
    planGenerator.planDocumentByPath = {
      '/fake/plans/237-bug-probe-crash/[Discovery] - Bug probe crash.md': POPULATED_NESTED_REPORT,
      // The freshly scaffolded mirror in the OTHER directory stays a scaffold.
      '/fake/plans/237-task-plan/[Discovery] - Task Plan.md': '- **Observed Behavior:**\n- **Expected Behavior:**\n'
    };

    const result = await runReentry();

    assert.strictEqual(result.discoveryReentry, 'ADVANCE_TO_PLAN');
    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
  });

  test('BLOCKER 2: a re-entry never orphans an existing plan directory', async () => {
    // Even when BOTH directories are empty scaffolds, the checkpoint must keep
    // its own planDir: repointing it at a fresh empty directory would orphan
    // every artifact the operator already has.
    seedCheckpointWithPlanDir('/fake/plans/237-bug-probe-crash');
    planGenerator.scaffoldPlanDirOverride = '/fake/plans/237-task-plan';

    const result = await runReentry();

    assert.strictEqual(
      result.stateMachine.planDir,
      '/fake/plans/237-bug-probe-crash',
      'a re-entry must not repoint an existing planDir at a fresh scaffold'
    );
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
  });

  test('BLOCKER 2: a FIRST run still adopts the freshly scaffolded planDir', async () => {
    // The positive control for the gate above: without it, never adopting the
    // scaffold would also satisfy the orphan test.
    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 237 });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    stateRepo.savedSnapshot = sm.toSnapshot();
    assert.strictEqual(stateRepo.savedSnapshot.planDir, null, 'fixture must start without a planDir');

    const result = await runReentry();

    assert.strictEqual(result.stateMachine.planDir, '/fake/plans/10');
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
  });

  test('BLOCKER 2: progress notes go to the checkpoint log, not the discarded scaffold', async () => {
    // The summary-log path was the other half of the fix: writing to
    // `scaffoldInfo.summaryPath` on a re-entry stranded progress notes in the
    // scaffold the checkpoint had just declined to adopt.
    seedCheckpointWithPlanDir('/fake/plans/237-bug-probe-crash');
    planGenerator.resolvedPlan = {
      planDir: '/fake/plans/237-bug-probe-crash',
      planPath: '/fake/plans/237-bug-probe-crash/[Discovery] - Bug probe crash.md',
      planFileName: '[Discovery] - Bug probe crash.md',
      // The checkpoint's own execution log.
      summaryPath: '/fake/plans/237-bug-probe-crash/CodeLoop Summary.md'
    };
    planGenerator.planDocumentByPath = {
      '/fake/plans/237-bug-probe-crash/[Discovery] - Bug probe crash.md': POPULATED_NESTED_REPORT
    };

    await runReentry();

    assert.ok(planGenerator.summaryUpdates.length > 0, 'a progress row must be written');
    for (const update of planGenerator.summaryUpdates) {
      assert.strictEqual(
        update.summaryFilePath,
        '/fake/plans/237-bug-probe-crash/CodeLoop Summary.md',
        'summary rows must land in the checkpoint plan directory, not the discarded scaffold'
      );
    }
    assert.ok(
      !planGenerator.summaryUpdates.some((u: any) => u.summaryFilePath === '/fake/plans/10/Summary.md'),
      'the fresh scaffold log must not receive progress notes on a re-entry'
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

// ============================================================================
// Plan artifact resolution & supplied plans (issues #283, #267)
// ============================================================================

const fsReal = require('node:fs');
const osReal = require('node:os');
const pathReal = require('node:path');
const { FilePlanGenerator } = require('../../dist/infrastructure');

describe('StartPlanningUseCase plan-artifact resolution (#283, #267)', () => {
  const { test: caseTest, beforeEach: caseBeforeEach, afterEach: caseAfterEach } = require('node:test');

  let workspace: string;
  let stateRepo: any;
  let githubGateway: any;
  let configRepo: any;
  let planGenerator: any;

  function populatedReport(title: string): string {
    return [
      `# [Discovery] - ${title}`,
      '',
      '## 1. Problem Statement & Symptoms',
      '- **Observed Behavior:** plan scaffolds a second directory and parks falsely',
      '- **Expected Behavior:** one directory per issue',
      '- **Affected Components / Paths:** src/infrastructure/file-plan-generator.ts',
      '',
      '## 2. Root Cause Analysis (RCA)',
      '- **Investigation Steps:** ran transition DISCOVERY then plan',
      '- **Identified Failure Mode:** the slug was re-derived',
      '- **Relevant Code References:** scaffoldPlanDirectory',
      '',
      '## 3. Reproduction Steps & Verification Protocol',
      '- **Local Reproduction Command:** codeloop transition DISCOVERY --issue 283',
      '- **Failing Test Target:** tests/generator.test.ts',
      '',
      '## 4. Remediation Strategy',
      '- **Recommended Fix Approach:** one slug grammar, populated-first adoption',
      '- **Potential Regressions / Side Effects:** deterministic selection'
    ].join('\n');
  }

  /**
   * A report in the discovery prompt's own Expected Output Structure: `##`
   * headings and prose, with NO `- **Key:**` bullet (issue #306).
   */
  function headingReport(title: string): string {
    return [
      `# [Discovery] - ${title}`,
      '',
      '**Issue:** #283',
      '**Date:** 2026-10-27',
      '**Author:** AgyLoop Discovery Subagent (Read-Only)',
      '',
      '## Summary & Symptoms',
      '',
      'The plan command scaffolds a second directory and then parks because the report is not bullet-shaped. Reproduced three times with a cleared state file.',
      '',
      '## Root Cause Analysis',
      '',
      'The RCA gate counted one markdown construct instead of measuring content, so a heading-shaped report scored zero filled keys and was reported as a scaffold.',
      '',
      '## Manual Bug Smoke Test',
      '',
      'The reproduction exits 1 with the park message; the same checkpoint with the content fix advances to PLAN, three times out of three.',
      '',
      '## Remediation Strategy',
      '',
      'Score content from either shape and make the park name the empty sections and blank template keys.'
    ].join('\n');
  }

  function plansDir(): string {
    return pathReal.join(workspace, 'artifacts', 'plans');
  }

  function planDirectories(): string[] {
    if (!fsReal.existsSync(plansDir())) return [];
    return fsReal
      .readdirSync(plansDir(), { withFileTypes: true })
      .filter((entry: any) => entry.isDirectory())
      .map((entry: any) => entry.name)
      .sort();
  }

  function seedDiscoveryCheckpoint(planDir: string | null, issue: number = 283): void {
    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue });
    sm.transition(STAGE_DISCOVERY, { note: 'Initiated discovery mode for defect RCA' });
    if (planDir) sm.setPlanDir(planDir);
    stateRepo.savedSnapshot = sm.toSnapshot();
  }

  /**
   * A substantive IMPLEMENTATION document (issue #320): content-rich, but not
   * discovery-shaped, so it must never be RCA evidence.
   */
  function substantiveImplementationPlan(title: string): string {
    return [
      `# [Implementation] - ${title}`,
      '',
      '## 1. Context & Objectives',
      '- **Feature Overview:** stale substantive implementation content.',
      '- **Acceptance Criteria:** it must never satisfy the RCA gate.',
      '',
      '## 2. Architectural Design & Impact',
      '- **Component Breakdown:** the gate and the directive.',
      '- **Data Flow / Model Invariants:** kind is checked before content.',
      '- **Dependencies & Imports:** domain predicates only.',
      '',
      '## 3. Implementation Steps',
      '- [ ] **Step 1:** add the discovery-shape filter before DiscoveryReport scoring.',
      '',
      '## 4. Quality Gate & Test Verification',
      '- **Target 1:** npm run lint'
    ].join('\n');
  }

  function nonBugIssue(number: number, title: string): void {
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number,
      title,
      body: 'feature probe body',
      labels: [],
      comments: [],
      state: 'OPEN'
    };
  }

  caseBeforeEach(() => {
    workspace = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'agyloop-start-planning-283-'));
    stateRepo = new MockStateRepository();
    githubGateway = new MockGitHubGateway();
    githubGateway.issueToReturn = {
      repo: 'owner/repo',
      number: 283,
      title: "[Bug] The base's own new commits",
      body: 'plan artifacts are wrong',
      labels: ['bug'],
      comments: [],
      state: 'OPEN'
    };
    configRepo = new MockConfigRepository();
    planGenerator = new FilePlanGenerator();
  });

  caseAfterEach(() => {
    fsReal.rmSync(workspace, { recursive: true, force: true });
  });

  caseTest('T-283.1: discovery-then-plan advances to PLAN in exactly one directory', async () => {
    // Discovery ran first and scaffolded the canonical directory.
    const scaffold = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 283,
      title: "[Bug] The base's own new commits",
      type: 'discovery'
    });
    seedDiscoveryCheckpoint(scaffold.planDir);
    fsReal.writeFileSync(scaffold.planPath, populatedReport("The base's own new commits"), 'utf8');

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 283, mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.discoveryReentry, 'ADVANCE_TO_PLAN');
    const dirs = planDirectories();
    assert.strictEqual(dirs.length, 1, `exactly one directory, got ${dirs.join(', ')}`);
    assert.strictEqual(result.stateMachine.planDir, scaffold.planDir);
    assert.strictEqual(result.scaffoldInfo?.directoryCreated, false);
    assert.strictEqual(result.scaffoldInfo?.adoptedExisting, true);
  });

  caseTest('T-283.2: a populated report in a sibling directory releases the gate and is adopted', async () => {
    // The checkpoint tracks an EMPTY scaffold (the old `plan` default), while
    // the populated report lives in a differently-slugged sibling.
    const empty = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 283,
      title: 'task plan',
      type: 'discovery'
    });
    const populatedDir = pathReal.join(plansDir(), '283-bug-probe-crash');
    fsReal.mkdirSync(populatedDir, { recursive: true });
    const populatedPath = pathReal.join(populatedDir, '[Discovery] - Bug probe crash.md');
    fsReal.writeFileSync(populatedPath, populatedReport('Bug probe crash'), 'utf8');

    seedDiscoveryCheckpoint(empty.planDir);

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 283, mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.stateMachine.planDir, populatedDir);
    assert.strictEqual(result.discoveryReportEvidence.populated, true);
    assert.strictEqual(result.discoveryReportEvidence.populatedPath, populatedPath);
    assert.ok(
      result.discoveryReportEvidence.checkedPaths.includes(populatedPath),
      `checkedPaths must include the populated report, got ${result.discoveryReportEvidence.checkedPaths.join(', ')}`
    );
  });

  caseTest('T-283.3: a pristine report still parks and the evidence names the checked paths', async () => {
    const scaffold = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 283,
      title: "[Bug] The base's own new commits",
      type: 'discovery'
    });
    seedDiscoveryCheckpoint(scaffold.planDir);

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 283, mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
    assert.strictEqual(result.discoveryReportEvidence.populated, false);
    assert.ok(result.discoveryReportEvidence.checkedPaths.length > 0);
    assert.ok(result.discoveryReportEvidence.checkedPaths.includes(scaffold.planPath));
  });

  caseTest('T-306.T9: a heading-style report in the checkpoint directory releases the park', async () => {
    // AC1 at the application level: the prompt's own heading-shaped output
    // must advance DISCOVERY -> PLAN with zero `- **Key:**` bullets on disk.
    const scaffold = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 283,
      title: "[Bug] The base's own new commits",
      type: 'discovery'
    });
    seedDiscoveryCheckpoint(scaffold.planDir);
    fsReal.writeFileSync(scaffold.planPath, headingReport("The base's own new commits"), 'utf8');

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 283, mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.discoveryReentry, 'ADVANCE_TO_PLAN');
    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.discoveryReportEvidence.populated, true);
    assert.strictEqual(result.discoveryReportEvidence.populatedPath, scaffold.planPath);
  });

  caseTest('T-306.T10: the park evidence names the scaffold gaps', async () => {
    // AC3: the park must name WHICH evidence is missing, not "unpopulated
    // scaffold", and must say which file the verdict was formed on.
    const scaffold = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 283,
      title: "[Bug] The base's own new commits",
      type: 'discovery'
    });
    seedDiscoveryCheckpoint(scaffold.planDir);

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 283, mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
    assert.strictEqual(result.discoveryReportEvidence.populated, false);
    assert.strictEqual(result.discoveryReportEvidence.evaluatedPath, scaffold.planPath);
    const missing = result.discoveryReportEvidence.missingEvidence ?? '';
    assert.ok(
      missing.includes('Problem Statement'),
      `missing evidence must name the empty section, got: ${missing}`
    );
    assert.ok(
      missing.includes('Observed Behavior'),
      `missing evidence must name a blank key, got: ${missing}`
    );
    assert.ok(result.discoveryReportEvidence.checkedPaths.length > 0);
  });

  caseTest('T-306.T11: a heading-style report outranks an empty sibling directory', async () => {
    // The #283 BLOCKER-2 vector, heading flavour: directory ranking reads
    // `isPopulated`, so a heading report must win over an empty scaffold.
    const empty = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 283,
      title: 'task plan',
      type: 'discovery'
    });
    const headingDir = pathReal.join(plansDir(), '283-heading-probe');
    fsReal.mkdirSync(headingDir, { recursive: true });
    const headingPath = pathReal.join(headingDir, '[Discovery] - Heading probe.md');
    fsReal.writeFileSync(headingPath, headingReport('Heading probe'), 'utf8');

    seedDiscoveryCheckpoint(empty.planDir);

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 283, mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.discoveryReentry, 'ADVANCE_TO_PLAN');
    assert.strictEqual(result.stateMachine.planDir, headingDir);
    assert.strictEqual(result.discoveryReportEvidence.populated, true);
    assert.strictEqual(result.discoveryReportEvidence.populatedPath, headingPath);
  });

  caseTest('T-267.B2: a supplied plan creates no competing directory', async () => {
    const suppliedDir = pathReal.join(workspace, 'supplied');
    fsReal.mkdirSync(suppliedDir, { recursive: true });
    const suppliedPlan = pathReal.join(suppliedDir, 'plan.md');
    fsReal.writeFileSync(
      suppliedPlan,
      '# [Implementation] - supplied\n\n## 3. Implementation Steps\n- [ ] **Step 1:** noop\n',
      'utf8'
    );
    seedDiscoveryCheckpoint(null);

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 283, mode: MODE_YOLO, planPath: suppliedPlan, workspaceDir: workspace });

    assert.strictEqual(result.suppliedPlanPath, suppliedPlan);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual(result.scaffoldInfo, null, 'a supplied plan must not scaffold');
    assert.strictEqual(planDirectories().length, 0, 'no artifacts/plans directory may be created');
  });

  caseTest('T-267.B3: a supplied BLANK plan is rejected before any transition', async () => {
    const suppliedDir = pathReal.join(workspace, 'supplied');
    fsReal.mkdirSync(suppliedDir, { recursive: true });
    const blankPlan = pathReal.join(suppliedDir, 'blank.md');
    fsReal.writeFileSync(blankPlan, '', 'utf8');
    seedDiscoveryCheckpoint(null);

    await assert.rejects(
      async () =>
        new StartPlanningUseCase(stateRepo, githubGateway, configRepo, planGenerator).execute({
          issue: 283,
          mode: MODE_YOLO,
          planPath: blankPlan,
          workspaceDir: workspace
        }),
      (err: any) => {
        assert.match(err.message, /blank/i);
        assert.ok(err.message.includes(blankPlan), err.message);
        return true;
      }
    );

    assert.strictEqual(planDirectories().length, 0);
  });

  caseTest('T-320.1: a non-bug scaffold with a substantive implementation plan parks and names the RCA gaps', async () => {
    // Defect A: the gate seeded `scaffoldInfo.planPath` and scored it with the
    // shape-agnostic content predicate, so an `implementation_plan.md` released
    // the RCA gate with no discovery report at all (issue #320, AC1/AC2).
    const scaffold = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 320,
      title: 'probe',
      type: 'discovery'
    });
    fsReal.writeFileSync(
      pathReal.join(scaffold.planDir, 'implementation_plan.md'),
      substantiveImplementationPlan('probe'),
      'utf8'
    );
    nonBugIssue(320, 'feature probe');
    seedDiscoveryCheckpoint(scaffold.planDir, 320);

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 320, title: 'feature probe', mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
    assert.strictEqual(result.discoveryReportEvidence.populated, false);
    assert.ok(
      String(result.discoveryReportEvidence.evaluatedPath).endsWith('[Discovery] - probe.md'),
      `the park must name the blank discovery report, got: ${String(result.discoveryReportEvidence.evaluatedPath)}`
    );
    const missing = result.discoveryReportEvidence.missingEvidence ?? '';
    assert.match(missing, /Observed Behavior|Problem Statement/);
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
  });

  caseTest('T-320.2: a directory holding only implementation artifacts yields no RCA evidence', async () => {
    // Defect A's second door: DISCOVERY resolution used to fall back to the
    // implementation aliases, so a directory with no discovery artifact still
    // released the gate (issue #320, AC1/AC6).
    const scaffold = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 320,
      title: 'probe',
      type: 'implementation'
    });
    fsReal.writeFileSync(scaffold.planPath, substantiveImplementationPlan('probe'), 'utf8');
    fsReal.writeFileSync(
      pathReal.join(scaffold.planDir, 'implementation_plan.md'),
      substantiveImplementationPlan('probe'),
      'utf8'
    );
    nonBugIssue(320, 'probe');
    seedDiscoveryCheckpoint(scaffold.planDir, 320);

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 320, title: 'probe', mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
    assert.strictEqual(result.discoveryReportEvidence.populated, false);
    assert.ok(
      !String(result.discoveryReportEvidence.evaluatedPath ?? '').includes('implementation'),
      `an implementation document must never be the verdict's file: ${String(result.discoveryReportEvidence.evaluatedPath)}`
    );
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(
      result.stateMachine.history.some((h: any) => h.stage === STAGE_PLAN),
      false,
      'a parked re-entry must gain no PLAN history entry'
    );
  });

  caseTest('T-320.3: a reopened issue (COMPLETED -> DISCOVERY) with a stale plan cannot bypass the gate', async () => {
    const scaffold = planGenerator.scaffoldPlanDirectory({
      projectRoot: workspace,
      issue: 320,
      title: 'probe',
      type: 'discovery'
    });
    fsReal.writeFileSync(
      pathReal.join(scaffold.planDir, 'implementation_plan.md'),
      substantiveImplementationPlan('probe'),
      'utf8'
    );

    // Walk a checkpoint to COMPLETED, then reopen it at DISCOVERY — the legal
    // transition that makes the stale plan reachable in practice (AC3).
    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 320 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_COMMIT);
    sm.transition(STAGE_COMPLETED);
    sm.transition(STAGE_DISCOVERY);
    sm.setPlanDir(scaffold.planDir);
    stateRepo.savedSnapshot = sm.toSnapshot();
    nonBugIssue(320, 'feature probe');

    const result = await new StartPlanningUseCase(
      stateRepo,
      githubGateway,
      configRepo,
      planGenerator
    ).execute({ issue: 320, title: 'feature probe', mode: MODE_YOLO, workspaceDir: workspace });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.discoveryReentry, 'PARK_AT_DISCOVERY');
    assert.strictEqual(result.discoveryReportEvidence.populated, false);
    assert.ok(
      String(result.discoveryReportEvidence.evaluatedPath).endsWith('[Discovery] - probe.md'),
      `the park must name the blank discovery report, got: ${String(result.discoveryReportEvidence.evaluatedPath)}`
    );
    assert.ok(
      result.stateMachine.history.some((h: any) => h.stage === STAGE_COMPLETED),
      'the reopened checkpoint keeps its COMPLETED history'
    );
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_DISCOVERY);
  });
});
