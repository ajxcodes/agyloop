/**
 * agyloop - RunReviewUseCase: content-aware blocking (issue #349 AC2/AC3)
 *
 * The regression the issue names: a synthetic report carrying ONE affirmation
 * labelled `critical` beside a reviewer `APPROVED` must record `APPROVED` and
 * pass; one genuine defect must still record `CHANGES_REQUESTED` with an
 * accurate count.
 *
 * R1 - one critical affirmation + APPROVED -> APPROVED at COMMIT, exit-free pass (AC2)
 * R2 - one genuine error defect + APPROVED -> CHANGES_REQUESTED at IMPLEMENT (AC3)
 * R3 - critique-only path: an all-affirmation high-confidence report approves
 * R4 - a clean report produces no exemptions at all
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { RunReviewUseCase } = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');
const {
  AiReviewFinding,
  AiReviewReport,
  ReviewConfidence,
  StateMachine,
  Stage,
  IssueNumber,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_IMPLEMENT,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED
} = require('../../dist/domain');

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

const AFFIRMATION_BODY = 'Correctly pins actions/checkout@v7 and actions/setup-node@v7.';
const DEFECT_BODY = 'Null pointer dereference on an empty payload.';

function finding(props: any) {
  return new AiReviewFinding(props);
}

function report(findings: any) {
  return new AiReviewReport({
    summary: 'critique summary',
    confidence: ReviewConfidence.high('static scan'),
    findings
  });
}

class MockStateRepository {
  public savedSnapshot: any;
  public saveCalls: number;

  constructor(initialSnapshot: any = null) {
    this.savedSnapshot = initialSnapshot;
    this.saveCalls = 0;
  }

  async load(): Promise<any> {
    return this.savedSnapshot;
  }

  async save(snapshot: any): Promise<void> {
    this.saveCalls += 1;
    this.savedSnapshot = snapshot;
  }

  async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  getStateFilePath(): string {
    return '/fake/state.json';
  }
}

class MockConfigRepository {
  loadConfig(): any {
    return DEFAULT_CONFIG;
  }

  resolveModel(role: string): any {
    return { role, configured: 'flash', tier: 'flash', apiModel: 'gemini-3.5-flash' };
  }

  mapModelToTier(): any {
    return 'flash';
  }
}

class MockPlanGenerator {
  updateSummaryLog(): boolean {
    return true;
  }

  scaffoldPlanDirectory(): any {
    return null;
  }

  generatePlan(): any {
    return null;
  }

  generateSummaryLog(): any {
    return null;
  }

  findPlanDirectory(): string | null {
    return null;
  }

  resolvePlanFile(): any {
    return null;
  }

  readPlanDocument(): string {
    return '';
  }
}

describe('RunReviewUseCase - content-aware blocking (issue #349)', () => {
  let stateRepo: MockStateRepository;

  beforeEach(() => {
    const sm = new StateMachine({ stage: new Stage(STAGE_REVIEW), issue: new IssueNumber(349) });
    stateRepo = new MockStateRepository(sm.toSnapshot());
  });

  function buildUseCase() {
    return new RunReviewUseCase(stateRepo, new MockConfigRepository(), new MockPlanGenerator());
  }

  test('R1: one critical affirmation beside APPROVED records APPROVED at COMMIT (AC2)', async () => {
    const result = await buildUseCase().execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: report([
        finding({ path: 'src/app.ts', line: 10, severity: 'critical', body: AFFIRMATION_BODY })
      ])
    });

    assert.strictEqual(result.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.strictEqual(result.reviewSource, 'reviewer-output');
    assert.strictEqual(result.critiqueVerified, true);
    assert.strictEqual(result.reviewerVerdict, VERDICT_APPROVED);
    assert.strictEqual(result.nonActionableFindings.length, 1);
    assert.deepStrictEqual(
      {
        path: result.nonActionableFindings[0].path,
        line: result.nonActionableFindings[0].line,
        severity: result.nonActionableFindings[0].severity,
        actionability: result.nonActionableFindings[0].actionability
      },
      { path: 'src/app.ts', line: 10, severity: 'critical', actionability: 'affirmation' }
    );

    const last = stateRepo.savedSnapshot.history[stateRepo.savedSnapshot.history.length - 1];
    assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_COMMIT);
    assert.strictEqual(last.metadata.reviewVerdict, VERDICT_APPROVED);
    assert.strictEqual(last.metadata.reviewSource, 'reviewer-output');
  });

  test('R2: one genuine error defect beside APPROVED records CHANGES_REQUESTED (AC3)', async () => {
    const result = await buildUseCase().execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: report([
        finding({ path: 'src/app.ts', line: 10, severity: 'error', body: DEFECT_BODY })
      ])
    });

    assert.strictEqual(result.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.reviewSource, 'reviewer-output+critique-escalation');
    assert.ok(
      result.verdict.summary.includes('detected 1 blocking/error violation(s)'),
      result.verdict.summary
    );
    assert.strictEqual(result.nonActionableFindings.length, 0);

    // The reviewer's own status is preserved beside the escalated one.
    assert.strictEqual(result.reviewerVerdict, VERDICT_APPROVED);
  });

  test('R3: the critique-only path approves an all-affirmation high-confidence report', async () => {
    const result = await buildUseCase().execute({
      priorCritiqueReport: report([
        finding({ path: 'src/app.ts', line: 10, severity: 'critical', body: AFFIRMATION_BODY })
      ])
    });

    assert.strictEqual(result.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.strictEqual(result.reviewSource, 'critique-report');
    assert.strictEqual(result.reviewerVerdict, null);
    assert.strictEqual(result.nonActionableFindings.length, 1);
    // The affirmation is not written into the derived criteria either.
    assert.deepStrictEqual([...result.verdict.unfulfilledCriteria], []);
  });

  test('R4: a clean report produces no exemptions', async () => {
    const result = await buildUseCase().execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: report([])
    });

    assert.strictEqual(result.verdict.status, VERDICT_APPROVED);
    assert.deepStrictEqual([...result.nonActionableFindings], []);
  });
});
