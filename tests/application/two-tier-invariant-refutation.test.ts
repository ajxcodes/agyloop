/**
 * agyloop - Two-tier invariant: operator refutations (issue #349 AC4.5)
 *
 * A refutation may suppress ONLY the Tier 1 escalation of the finding it names.
 * It never touches the reviewer's verdict, the recorded source, another
 * finding, or the unfulfilled-AC arm — and with no refutation the escalation
 * string is byte-identical to the pre-#349 one.
 *
 * U1 - a refuted finding leaves the remaining one escalating, both counts named
 * U2 - the no-refutation summary is byte-identical, and an empty resolution
 *      produces the same string
 * U3 - refuting every blocking finding leaves the reviewer's verdict in place
 * U4 - the escalated verdict's findings exclude the refuted one
 * U5 - legacy checkpoints load, and an unrefuted run writes NO audit key
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { applyTwoTierInvariant, RunReviewUseCase } = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');
const {
  AiReviewFinding,
  AiReviewReport,
  ReviewConfidence,
  ReviewVerdict,
  FindingRefutation,
  resolveFindingRefutations,
  StateMachine,
  Stage,
  IssueNumber,
  STAGE_REVIEW,
  STAGE_COMMIT,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED
} = require('../../dist/domain');

const V7_BODY = 'actions/checkout@v7 does not exist. Revert to @v4.';
const DEFECT_BODY = 'Null pointer dereference when the row is absent.';

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

function approvedVerdict(extra: any = {}) {
  return new ReviewVerdict({
    status: VERDICT_APPROVED,
    summary: 'reviewer summary',
    confidenceLevel: 'High',
    ...extra
  });
}

function v7Report() {
  return report([finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY })]);
}

function twoFindingReport() {
  return report([
    finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY }),
    finding({ path: 'src/db.ts', line: 42, severity: 'error', body: DEFECT_BODY })
  ]);
}

describe('applyTwoTierInvariant - operator refutations (issue #349)', () => {
  test('U1: a refuted finding leaves the genuine one escalating, both counts named', () => {
    const aiReport = twoFindingReport();
    const resolution = resolveFindingRefutations(aiReport, [
      FindingRefutation.parse('src/app.ts:10=actions/checkout@v7 exists (v7.0.1)')
    ]);

    const outcome = applyTwoTierInvariant(approvedVerdict(), aiReport, resolution);

    assert.strictEqual(outcome.escalatedBy, 'critique');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(
      outcome.verdict.summary.includes('detected 1 blocking/error violation(s) (1 refuted by the operator)'),
      outcome.verdict.summary
    );
    assert.strictEqual(outcome.verdict.unfulfilledCriteria.length, 1);
    assert.ok(outcome.verdict.unfulfilledCriteria[0].includes('src/db.ts:42'));
    assert.ok(!outcome.verdict.unfulfilledCriteria[0].includes('actions/checkout@v7'));
  });

  test('U2: with no refutation the summary is byte-identical to the pre-#349 string', () => {
    const aiReport = twoFindingReport();
    const expected =
      'Review failed: Automated critique detected 2 blocking/error violation(s). reviewer summary';

    const twoArgument = applyTwoTierInvariant(approvedVerdict(), aiReport);
    assert.strictEqual(twoArgument.verdict.summary, expected);

    const emptyResolution = resolveFindingRefutations(aiReport, []);
    const withResolution = applyTwoTierInvariant(approvedVerdict(), aiReport, emptyResolution);
    assert.strictEqual(withResolution.verdict.summary, expected);
    assert.strictEqual(withResolution.verdict.summary, twoArgument.verdict.summary);
  });

  test('U3: refuting every blocking finding leaves the reviewer verdict untouched', () => {
    const aiReport = v7Report();
    const resolution = resolveFindingRefutations(aiReport, [
      FindingRefutation.parse('src/app.ts:10=v7 exists')
    ]);

    const verdict = approvedVerdict();
    const outcome = applyTwoTierInvariant(verdict, aiReport, resolution);

    assert.strictEqual(outcome.escalatedBy, null);
    assert.strictEqual(outcome.verdict, verdict);
    assert.strictEqual(outcome.verdict.status, VERDICT_APPROVED);
  });

  test('U4: the escalated verdict excludes the refuted finding by index', () => {
    const reviewerFinding = finding({
      path: 'docs/README.md',
      line: 3,
      severity: 'warning',
      body: 'Consider shortening this paragraph.'
    });
    const aiReport = twoFindingReport();
    const resolution = resolveFindingRefutations(aiReport, [
      FindingRefutation.parse('src/app.ts:10=v7 exists')
    ]);

    const outcome = applyTwoTierInvariant(
      approvedVerdict({ findings: [reviewerFinding] }),
      aiReport,
      resolution
    );

    const paths = outcome.verdict.findings.map((f: any) => `${f.path}:${f.line}`);
    assert.strictEqual(paths[0], 'docs/README.md:3', 'the reviewer findings still come first');
    assert.ok(paths.includes('src/db.ts:42'), paths.join(', '));
    assert.ok(!paths.includes('src/app.ts:10'), `the refuted finding must be excluded: ${paths.join(', ')}`);
  });

  test('U5: a legacy checkpoint loads and an unrefuted run writes NO reviewRefutations key', async () => {
    const seededAt = '2026-10-01T00:00:00.000Z';
    const base = new StateMachine({ stage: new Stage(STAGE_REVIEW), issue: new IssueNumber(349) }).toSnapshot();
    const legacy = {
      ...base,
      history: [
        {
          stage: STAGE_REVIEW,
          timestamp: seededAt,
          metadata: {
            reviewVerdict: VERDICT_APPROVED,
            reviewSource: 'reviewer-output',
            critiqueVerified: true
          }
        }
      ]
    };

    const loaded = StateMachine.fromSnapshot(legacy);
    assert.strictEqual(loaded.history[0].metadata.reviewVerdict, VERDICT_APPROVED);
    assert.ok(!('reviewRefutations' in loaded.history[0].metadata));

    const stateRepo = new MockStateRepository(legacy);
    const useCase = new RunReviewUseCase(
      stateRepo,
      new MockConfigRepository(),
      new MockPlanGenerator()
    );

    const result = await useCase.execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: report([])
    });

    assert.strictEqual(result.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.deepStrictEqual([...result.refutations], []);
    assert.strictEqual(stateRepo.savedSnapshot.history[0].metadata.reviewVerdict, VERDICT_APPROVED);
    const last = stateRepo.savedSnapshot.history[stateRepo.savedSnapshot.history.length - 1];
    assert.ok(
      !('reviewRefutations' in last.metadata),
      'an unrefuted run must not write the additive key'
    );
  });
});

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

class MockStateRepository {
  public savedSnapshot: any;

  constructor(initialSnapshot: any = null) {
    this.savedSnapshot = initialSnapshot;
  }

  async load(): Promise<any> {
    return this.savedSnapshot;
  }

  async save(snapshot: any): Promise<void> {
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
