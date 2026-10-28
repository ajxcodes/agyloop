/**
 * agyloop - RunReviewUseCase: operator refutations (issue #349 AC4)
 *
 * The six scenarios the operator named, at use-case level, plus the
 * fail-closed scope limits. Every refusal is raised BEFORE `stateRepo.save()`,
 * so a refused refutation records nothing.
 *
 * RR1 - v7 false claim + valid refutation -> APPROVED, audited (AC4-S1/S5)
 * RR2 - the same run without the refutation -> CHANGES_REQUESTED (AC4-S2)
 * RR3 - genuine defect beside a refuted false claim still escalates (AC4-S6)
 * RR4 - a reviewer CHANGES_REQUESTED can never be rescued
 * RR5 - the critique-only path refuses refutations
 * RR6 - an affirmation cannot be refuted (it is already non-blocking)
 * RR7 - no report -> refused
 * RR8 - the unfulfilled-AC arm is not suppressed
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { RunReviewUseCase } = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');
const {
  AiReviewFinding,
  AiReviewReport,
  ReviewConfidence,
  FindingRefutation,
  RefutationRefusedError,
  StateMachine,
  Stage,
  IssueNumber,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_IMPLEMENT,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  NOTE_REFUTATION_ALREADY_NON_BLOCKING,
  NOTE_REFUTATION_NO_REPORT,
  NOTE_REFUTATION_REQUIRES_APPROVED,
  NOTE_REFUTATION_REQUIRES_VERDICT
} = require('../../dist/domain');

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

const APPROVED_WITH_AC_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: Almost there.
UNFULFILLED_AC:
- The retry loop is bounded
REMEDIATION_GUIDANCE:
- Bound the retry loop
`;

const CHANGES_REQUESTED_BLOCK = `REVIEW_STATUS: CHANGES_REQUESTED
REVIEW_SUMMARY: The nil dereference is unfixed.
UNFULFILLED_AC:
- The nil dereference is fixed
REMEDIATION_GUIDANCE:
- Fix the nil dereference
`;

const V7_BODY = 'actions/checkout@v7 does not exist. Revert to @v4.';
const DEFECT_BODY = 'Null pointer dereference when the row is absent.';
const REFUTE_REASON = 'actions/checkout@v7 exists (v7.0.1, published 2026-07-20) — verified with gh api';

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

function v7Report() {
  return report([finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY })]);
}

function head(constant: string): string {
  return constant.split('{')[0];
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

describe('RunReviewUseCase - operator refutations (issue #349)', () => {
  let stateRepo: MockStateRepository;

  beforeEach(() => {
    const sm = new StateMachine({ stage: new Stage(STAGE_REVIEW), issue: new IssueNumber(349) });
    stateRepo = new MockStateRepository(sm.toSnapshot());
  });

  function buildUseCase() {
    return new RunReviewUseCase(stateRepo, new MockConfigRepository(), new MockPlanGenerator());
  }

  function lastMetadata() {
    const history = stateRepo.savedSnapshot.history;
    return history[history.length - 1].metadata;
  }

  test('RR1: a refuted v7 false claim records APPROVED with an audit trail (AC4-S1/S5)', async () => {
    const result = await buildUseCase().execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: v7Report(),
      refutations: [FindingRefutation.parse(`src/app.ts:10=${REFUTE_REASON}`)]
    });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.strictEqual(result.reviewSource, 'reviewer-output');
    assert.strictEqual(result.critiqueVerified, true);
    assert.strictEqual(result.reviewerVerdict, VERDICT_APPROVED);
    assert.strictEqual(result.refutations.length, 1);
    assert.strictEqual(result.refutations[0].target, 'src/app.ts:10');

    const metadata = lastMetadata();
    assert.strictEqual(metadata.reviewVerdict, VERDICT_APPROVED);
    const audit = metadata.reviewRefutations;
    assert.ok(Array.isArray(audit), 'the checkpoint must carry the audit trail');
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].target, 'src/app.ts:10');
    assert.strictEqual(audit[0].path, 'src/app.ts');
    assert.strictEqual(audit[0].line, 10);
    assert.strictEqual(audit[0].severity, 'error');
    assert.strictEqual(audit[0].actionability, 'change-request');
    assert.strictEqual(audit[0].bodyExcerpt, V7_BODY);
    assert.strictEqual(audit[0].reason, REFUTE_REASON);
    assert.strictEqual(audit[0].findingIndex, 0);
    // Serialisable: the checkpoint is JSON on disk.
    assert.ok(JSON.stringify(metadata).includes(REFUTE_REASON));
  });

  test('RR2: the same report WITHOUT a refutation still reverts (AC4-S2)', async () => {
    const result = await buildUseCase().execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: v7Report()
    });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.reviewSource, 'reviewer-output+critique-escalation');
    assert.ok(
      result.verdict.summary.includes('detected 1 blocking/error violation(s)'),
      result.verdict.summary
    );
    assert.deepStrictEqual([...result.refutations], []);

    const metadata = lastMetadata();
    assert.strictEqual(metadata.reviewVerdict, VERDICT_CHANGES_REQUESTED);
    assert.ok(!('reviewRefutations' in metadata), 'no refutation may be recorded for an unrefuted run');
  });

  test('RR3: a genuine defect beside a refuted false claim still escalates (AC4-S6)', async () => {
    const result = await buildUseCase().execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: report([
        finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY }),
        finding({ path: 'src/db.ts', line: 42, severity: 'error', body: DEFECT_BODY })
      ]),
      refutations: [FindingRefutation.parse(`src/app.ts:10=${REFUTE_REASON}`)]
    });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(
      result.verdict.summary.includes(
        'detected 1 blocking/error violation(s) (1 refuted by the operator)'
      ),
      result.verdict.summary
    );
    const criteria = result.verdict.unfulfilledCriteria.join('\n');
    assert.ok(criteria.includes('src/db.ts:42'), criteria);
    assert.ok(!criteria.includes('actions/checkout@v7'), criteria);
    assert.strictEqual(result.refutations.length, 1);
  });

  test('RR4: a reviewer CHANGES_REQUESTED can never be rescued', async () => {
    const before = JSON.stringify(stateRepo.savedSnapshot);
    const useCase = buildUseCase();

    await assert.rejects(
      () =>
        useCase.execute({
          reviewOutput: CHANGES_REQUESTED_BLOCK,
          priorCritiqueReport: v7Report(),
          refutations: [FindingRefutation.parse(`src/app.ts:10=${REFUTE_REASON}`)]
        }),
      (err: any) => {
        assert.ok(err instanceof RefutationRefusedError);
        assert.ok(
          err.refusals[0].startsWith(head(NOTE_REFUTATION_REQUIRES_APPROVED)),
          err.refusals.join('; ')
        );
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCalls, 0, 'a refused refutation must write nothing');
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before, 'the checkpoint is unchanged');
  });

  test('RR5: the critique-only path refuses a refutation', async () => {
    const before = JSON.stringify(stateRepo.savedSnapshot);
    const useCase = buildUseCase();

    await assert.rejects(
      () =>
        useCase.execute({
          priorCritiqueReport: v7Report(),
          refutations: [FindingRefutation.parse(`src/app.ts:10=${REFUTE_REASON}`)]
        }),
      (err: any) => {
        assert.ok(err instanceof RefutationRefusedError);
        assert.ok(
          err.refusals[0].startsWith(head(NOTE_REFUTATION_REQUIRES_VERDICT)),
          err.refusals.join('; ')
        );
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCalls, 0);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });

  test('RR6: an affirmation cannot be refuted (already non-blocking)', async () => {
    const before = JSON.stringify(stateRepo.savedSnapshot);
    const useCase = buildUseCase();

    await assert.rejects(
      () =>
        useCase.execute({
          reviewOutput: APPROVED_BLOCK,
          priorCritiqueReport: report([
            finding({
              path: 'src/app.ts',
              line: 10,
              severity: 'critical',
              body: 'Correctly pins actions/checkout@v7.'
            })
          ]),
          refutations: [FindingRefutation.parse(`src/app.ts:10=${REFUTE_REASON}`)]
        }),
      (err: any) => {
        assert.ok(err instanceof RefutationRefusedError);
        assert.ok(
          err.refusals[0].startsWith(head(NOTE_REFUTATION_ALREADY_NON_BLOCKING)),
          err.refusals.join('; ')
        );
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCalls, 0);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });

  test('RR7: no critique report refuses a refutation', async () => {
    const before = JSON.stringify(stateRepo.savedSnapshot);
    const useCase = buildUseCase();

    await assert.rejects(
      () =>
        useCase.execute({
          reviewOutput: APPROVED_BLOCK,
          refutations: [FindingRefutation.parse(`src/app.ts:10=${REFUTE_REASON}`)]
        }),
      (err: any) => {
        assert.ok(err instanceof RefutationRefusedError);
        assert.ok(err.refusals[0].startsWith(head(NOTE_REFUTATION_NO_REPORT)), err.refusals.join('; '));
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCalls, 0);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });

  test('RR8: refutation does not suppress the unfulfilled-AC arm', async () => {
    const result = await buildUseCase().execute({
      reviewOutput: APPROVED_WITH_AC_BLOCK,
      priorCritiqueReport: v7Report(),
      refutations: [FindingRefutation.parse(`src/app.ts:10=${REFUTE_REASON}`)]
    });

    assert.strictEqual(result.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    // The source is the reviewer's, NOT a critique escalation: the other arm
    // escalated, so the refutation suppressed nothing it did not name.
    assert.strictEqual(result.reviewSource, 'reviewer-output');
    assert.ok(
      result.verdict.summary.includes('Unfulfilled Acceptance Criteria'),
      result.verdict.summary
    );
    assert.ok(
      result.verdict.unfulfilledCriteria.join('\n').includes('The retry loop is bounded'),
      result.verdict.unfulfilledCriteria.join('\n')
    );
    assert.strictEqual(result.refutations.length, 1);
    assert.strictEqual(lastMetadata().reviewRefutations.length, 1);
  });
});
