/**
 * agyloop - RunReviewUseCase Unit Tests
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  StateMachine,
  Stage,
  IssueNumber,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  STAGE_COMPLETED,
  MODE_STANDARD,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  ROLE_REVIEWER,
  InvalidTransitionError,
  AiReviewReport,
  AiReviewFinding,
  ReviewConfidence
} = require('../../dist/domain');
const {
  RunReviewUseCase,
  extractAcceptanceCriteria
} = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

import type { AiReviewReport as AiReviewReportType } from '../../src/domain';
import type {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  StandardsRepository,
  CritiquePort,
  CritiqueOptions,
  CritiqueResolution,
  AgyLoopConfig,
  ResolvedPlanLocation
} from '../../src/ports';

class MockStateRepository implements StateRepository {
  public savedSnapshot: any = null;
  public initialSnapshot: any = null;

  constructor(initialSnapshot: any = null) {
    this.initialSnapshot = initialSnapshot;
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

class MockConfigRepository implements ConfigRepository {
  public loadConfig(): AgyLoopConfig {
    return DEFAULT_CONFIG;
  }

  public resolveModel(role: string, config?: AgyLoopConfig): any {
    return {
      role,
      configured: 'flash',
      tier: 'flash',
      apiModel: 'gemini-3.5-flash'
    };
  }

  public mapModelToTier(input: string): any {
    return 'flash';
  }
}

class MockPlanGenerator implements PlanGeneratorPort {
  public summaryUpdates: any[] = [];
  public planContent: string = '';

  public scaffoldPlanDirectory(): any {
    return null;
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
    return '/fake/plans/28-task';
  }

  public resolvePlanFile(): ResolvedPlanLocation | null {
    return {
      planDir: '/fake/plans/28-task',
      planPath: '/fake/plans/28-task/implementation_plan.md',
      planFileName: 'implementation_plan.md',
      summaryPath: '/fake/plans/28-task/Summary.md'
    };
  }

  public readPlanDocument(): string {
    return this.planContent;
  }
}

class MockStandardsRepository implements StandardsRepository {
  public standardsText: string | null = null;

  public loadStandards(): string | null {
    return this.standardsText;
  }

  public findStandardsPath(): string | null {
    return this.standardsText ? '/fake/.github/critique.md' : null;
  }
}

class MockCritique implements CritiquePort {
  public reportToReturn: AiReviewReportType | null = null;

  public resolveReviewer(): CritiqueResolution {
    return { source: 'bundled', path: '/fake/bin/critique.js', isAvailable: true };
  }

  public async review(options?: CritiqueOptions): Promise<AiReviewReportType> {
    if (this.reportToReturn) {
      return this.reportToReturn;
    }
    return new AiReviewReport({
      summary: 'Clean automated review',
      confidence: ReviewConfidence.high('Diff verified.'),
      findings: []
    });
  }
}

describe('extractAcceptanceCriteria Helper', () => {
  test('extracts bullet items from standard Acceptance Criteria section', () => {
    const planText = `
# Plan: Feature X

## 1. Context & Objectives
- **Acceptance Criteria:**
- First AC must pass
- Second AC must handle error
- [ ] Third AC with checkbox

## 2. Architecture
Other content...
`;
    const criteria = extractAcceptanceCriteria(planText);
    assert.deepStrictEqual([...criteria], [
      'First AC must pass',
      'Second AC must handle error',
      'Third AC with checkbox'
    ]);
  });

  test('extracts bullet items from markdown heading ## Acceptance Criteria', () => {
    const planText = `
# Task Plan

## Acceptance Criteria
- Catches unfulfilled criteria
- Provides clear guidance

## Implementation Steps
`;
    const criteria = extractAcceptanceCriteria(planText);
    assert.deepStrictEqual([...criteria], [
      'Catches unfulfilled criteria',
      'Provides clear guidance'
    ]);
  });

  test('handles inline criteria and filters out "None"', () => {
    const planText = `
- **Acceptance Criteria:** None
`;
    const criteria = extractAcceptanceCriteria(planText);
    assert.deepStrictEqual([...criteria], []);
  });

  test('returns empty array for empty or null content', () => {
    assert.deepStrictEqual([...extractAcceptanceCriteria('')], []);
    assert.deepStrictEqual([...extractAcceptanceCriteria(null as any)], []);
  });
});

describe('RunReviewUseCase (Application Layer)', () => {
  let stateRepo: MockStateRepository;
  let configRepo: MockConfigRepository;
  let planGenerator: MockPlanGenerator;
  let standardsRepo: MockStandardsRepository;
  let critique: MockCritique;

  beforeEach(() => {
    const initialSm = new StateMachine({
      stage: new Stage('QUALITY_GATE'),
      issue: new IssueNumber(28)
    });

    stateRepo = new MockStateRepository(initialSm.toSnapshot());
    configRepo = new MockConfigRepository();
    planGenerator = new MockPlanGenerator();
    planGenerator.planContent = `
## Acceptance Criteria
- AC 1: Reviewer subagent definition created
- AC 2: Standards ingestion supported
`;
    standardsRepo = new MockStandardsRepository();
    standardsRepo.standardsText = '# Standards\nRule: Pure domain only.';
    critique = new MockCritique();
  });

  test('rejects execution when no pipeline state exists', async () => {
    stateRepo.savedSnapshot = null;
    const useCase = new RunReviewUseCase(stateRepo, configRepo, planGenerator, standardsRepo);

    await assert.rejects(
      () => useCase.execute(),
      (err: any) => err instanceof InvalidTransitionError && err.fromStage === 'NONE'
    );
  });

  test('rejects execution when current stage is not QUALITY_GATE or REVIEW', async () => {
    const sm = new StateMachine({
      stage: new Stage('PLAN'),
      issue: new IssueNumber(28)
    });
    stateRepo.savedSnapshot = sm.toSnapshot();

    const useCase = new RunReviewUseCase(stateRepo, configRepo, planGenerator, standardsRepo);
    await assert.rejects(
      () => useCase.execute(),
      (err: any) => err instanceof InvalidTransitionError && err.fromStage === 'PLAN'
    );
  });

  test('transitions QUALITY_GATE -> REVIEW -> COMMIT when review is APPROVED', async () => {
    const useCase = new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );

    const reviewOutput = `
REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: All acceptance criteria fulfilled and architecture is sound.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

    const result = await useCase.execute({ reviewOutput });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.verdict.isApproved(), true);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_COMMIT);
    assert.strictEqual(result.reviewerDef.name, ROLE_REVIEWER);
    assert.strictEqual(result.acceptanceCriteria.length, 2);

    // Verify summary log was updated
    assert.strictEqual(planGenerator.summaryUpdates.length, 1);
    const update = planGenerator.summaryUpdates[0].updateData;
    assert.strictEqual(update.stage, 'AI Review');
    assert.strictEqual(update.status, VERDICT_APPROVED);
    assert.ok(update.reviewNote.includes('All acceptance criteria fulfilled'));

    // Verify checkpoint persisted
    const saved = await stateRepo.load();
    assert.strictEqual(saved.currentStage, STAGE_COMMIT);
  });

  test('supports running review from COMPLETED stage', async () => {
    const sm = new StateMachine({
      stage: new Stage(STAGE_COMPLETED),
      issue: new IssueNumber(28)
    });
    stateRepo.savedSnapshot = sm.toSnapshot();

    const useCase = new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );

    const reviewOutput = `
REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: Post-completion review approved.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

    const result = await useCase.execute({ reviewOutput });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
  });

  test('transitions QUALITY_GATE -> REVIEW -> IMPLEMENT when review requests changes', async () => {
    const useCase = new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );

    const reviewOutput = `
REVIEW_STATUS: CHANGES_REQUESTED
REVIEW_SUMMARY: Acceptance criteria AC 2 unfulfilled.
UNFULFILLED_AC:
- AC 2: Standards ingestion missing fallback
REMEDIATION_GUIDANCE:
- Add default candidate search in FileStandardsRepository
`;

    const result = await useCase.execute({ reviewOutput });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.verdict.isChangesRequested(), true);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);

    // Verify self-correction payload in state history metadata
    const history = result.stateMachine.history;
    const lastEntry = history[history.length - 1];
    assert.strictEqual(lastEntry.stage, STAGE_IMPLEMENT);
    assert.ok(lastEntry.metadata?.selfCorrectionPayload);
    assert.ok(
      String(lastEntry.metadata?.selfCorrectionPayload).includes('Standards ingestion missing fallback')
    );

    // Verify summary log update
    assert.strictEqual(planGenerator.summaryUpdates.length, 1);
    const update = planGenerator.summaryUpdates[0].updateData;
    assert.strictEqual(update.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(update.reviewNote.includes('Pipeline reverted to IMPLEMENT'));
  });

  test('uses injected CritiquePort when reviewOutput is not provided', async () => {
    critique.reportToReturn = new AiReviewReport({
      summary: 'Automated AI PR review passed cleanly.',
      confidence: ReviewConfidence.high('No issues detected.'),
      findings: []
    });

    const useCase = new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );

    const result = await useCase.execute();

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.verdict.isApproved(), true);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
  });

  test('assembles prompt with standards, criteria, and directives', async () => {
    const useCase = new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );

    const result = await useCase.execute({
      userInstructions: 'Ensure zero console.log statements remain.',
      workingDiff: 'diff --git a/foo.ts b/foo.ts\n+const x = 1;'
    });

    assert.ok(result.taskPrompt.includes('# Task: Code Review & Standards Verification'));
    assert.ok(result.taskPrompt.includes('Ensure zero console.log statements remain.'));
    assert.ok(result.taskPrompt.includes('diff --git a/foo.ts b/foo.ts'));
    assert.ok(result.taskPrompt.includes('Rule: Pure domain only.'));
    assert.ok(result.taskPrompt.includes('AC 1: Reviewer subagent definition created'));
    assert.ok(result.taskPrompt.includes('REVIEW_STATUS: APPROVED | CHANGES_REQUESTED'));
  });

  test('respects dryRun flag by avoiding state and summary writes', async () => {
    const useCase = new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );

    await useCase.execute({
      dryRun: true,
      reviewOutput: 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: Dry run test'
    });

    assert.strictEqual(planGenerator.summaryUpdates.length, 0);
  });

  test('injects critique markdown report into reviewer prompt', async () => {
    critique.reportToReturn = new AiReviewReport({
      summary: 'Automated critique found 1 styling issue',
      confidence: ReviewConfidence.medium('Linter check'),
      findings: [
        new AiReviewFinding({
          path: 'src/domain.ts',
          line: 12,
          rule: 'no-console',
          message: 'Unexpected console statement',
          severity: 'warning'
        })
      ]
    });

    const useCase = new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );

    const result = await useCase.execute();

    assert.ok(result.critiqueReport);
    assert.ok(result.critiqueReport.includes('Automated critique found 1 styling issue'));
    assert.ok(result.taskPrompt.includes('### Automated Code Critique Report'));
    assert.ok(result.taskPrompt.includes('Unexpected console statement'));
  });

  test('enforces CHANGES_REQUESTED when critique reports critical/error findings even if reviewer LLM outputs APPROVED', async () => {
    critique.reportToReturn = new AiReviewReport({
      summary: 'Automated critique found critical flaw',
      confidence: ReviewConfidence.high('Security scan'),
      findings: [
        new AiReviewFinding({
          path: 'src/security.ts',
          line: 45,
          rule: 'injection-flaw',
          message: 'Potential shell injection detected',
          severity: 'error'
        })
      ]
    });

    const useCase = new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );

    const reviewOutput = `
REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: LLM thinks everything is fine.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

    const result = await useCase.execute({ reviewOutput });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.verdict.isChangesRequested(), true);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
  });
});
