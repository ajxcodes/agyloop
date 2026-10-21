/**
 * agyloop - Recording a dispatched Reviewer Subagent's verdict (issue #269, Defect 2)
 *
 * `RunReviewParams.reviewOutput` was declared, parsed and consumed — and NO
 * caller ever supplied it, so the reviewer subagent's Tier 2 verdict was
 * STRUCTURALLY UNRECORDABLE: a `CHANGES_REQUESTED` could never fail a gate,
 * and the COMMIT gate could only ever be reached with "No AI review verdict is
 * recorded for this task".
 *
 * RV1 - APPROVED  -> COMMIT, passed, `reviewVerdict: 'APPROVED'`
 * RV2 - CHANGES_REQUESTED -> IMPLEMENT, NOT passed, `reviewVerdict: 'CHANGES_REQUESTED'`
 * RV3 - a self-declared `SKIPPED` is REFUSED by `ReviewVerdict.parse` (#236)
 * RV4 - a CHANGES_REQUESTED is never downgraded to SKIPPED
 * RV5 - no reviewer output and no critique report -> SKIPPED -> COMMIT (N1:
 *      the #236 fail-open is NOT inverted)
 * RV8 - filing a verdict does NOT execute the Tier 1 critique CLI (R2)
 * RV9 - a critique escalation is reported as such, never as the reviewer's
 *      verdict (R3)
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  StateMachine,
  Stage,
  IssueNumber,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_IMPLEMENT,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  VERDICT_SKIPPED,
  ReviewerSubagentError
} = require('../../dist/domain');
const { RunReviewUseCase } = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

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
import type { AiReviewReport as AiReviewReportType } from '../../src/domain';

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

class MockConfigRepository implements ConfigRepository {
  public loadConfig(): AgyLoopConfig {
    return DEFAULT_CONFIG;
  }

  public resolveModel(role: string): any {
    return { role, configured: 'flash', tier: 'flash', apiModel: 'gemini-3.5-flash' };
  }

  public mapModelToTier(): any {
    return 'flash';
  }
}

class MockPlanGenerator implements PlanGeneratorPort {
  public updateSummaryLog(): boolean {
    return true;
  }

  public scaffoldPlanDirectory(): any {
    return null;
  }

  public generatePlan(): any {
    return null;
  }

  public generateSummaryLog(): any {
    return null;
  }

  public findPlanDirectory(): string | null {
    return null;
  }

  public resolvePlanFile(): ResolvedPlanLocation | null {
    return {
      planDir: '/fake/plans/269-task',
      planPath: '/fake/plans/269-task/implementation_plan.md',
      planFileName: 'implementation_plan.md',
      summaryPath: '/fake/plans/269-task/Summary.md'
    };
  }

  public readPlanDocument(): string {
    return '# Plan\n\n## Acceptance Criteria\n- AC 1: the verdict is recordable\n';
  }
}

class MockStandardsRepository implements StandardsRepository {
  public loadStandards(): string | null {
    return '# Standards';
  }

  public findStandardsPath(): string | null {
    return '/fake/.github/critique.md';
  }
}

/** A critique port that reports NOTHING (a clean Tier 1 report). */
class CleanCritique implements CritiquePort {
  /**
   * How many times the Tier 1 critique was EXECUTED (issue #269, R2).
   *
   * The recording path must not run the critique CLI: it is a network call, a
   * latency cost and an interactive install prompt on a path that must never
   * block. The counter makes the claim checkable.
   */
  public reviewCalls = 0;

  public resolveReviewer(): CritiqueResolution {
    return { source: 'bundled', path: '/fake/bin/critique.js', isAvailable: true };
  }

  public async review(_options?: CritiqueOptions): Promise<AiReviewReportType> {
    this.reviewCalls += 1;
    const { AiReviewReport, ReviewConfidence } = require('../../dist/domain');
    return new AiReviewReport({
      summary: 'Clean automated review',
      confidence: ReviewConfidence.high('Diff verified.'),
      findings: []
    });
  }
}

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

const CHANGES_REQUESTED_BLOCK = `REVIEW_STATUS: CHANGES_REQUESTED
REVIEW_SUMMARY: The nil dereference in resolve-subagent.ts is unfixed.
UNFULFILLED_AC:
- The nil dereference is fixed
REMEDIATION_GUIDANCE:
- Fix the nil dereference in src/application/resolve-subagent.ts
`;

describe('Recording a dispatched reviewer verdict (issue #269, Defect 2)', () => {
  let stateRepo: MockStateRepository;
  let configRepo: MockConfigRepository;
  let planGenerator: MockPlanGenerator;
  let standardsRepo: MockStandardsRepository;
  let critique: CleanCritique;

  beforeEach(() => {
    const initialSm = new StateMachine({
      stage: new Stage('REVIEW'),
      issue: new IssueNumber(269)
    });
    stateRepo = new MockStateRepository(initialSm.toSnapshot());
    configRepo = new MockConfigRepository();
    planGenerator = new MockPlanGenerator();
    standardsRepo = new MockStandardsRepository();
    critique = new CleanCritique();
  });

  function buildUseCase(): any {
    return new RunReviewUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      standardsRepo,
      critique
    );
  }

  test('RV1: an APPROVED reviewer output advances to COMMIT and is recorded in the history', async () => {
    const result = await buildUseCase().execute({ reviewOutput: APPROVED_BLOCK });

    assert.strictEqual(result.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.strictEqual(result.reviewSource, 'reviewer-output');

    const saved: any = await stateRepo.load();
    assert.strictEqual(saved.currentStage, STAGE_COMMIT);
    const last = saved.history[saved.history.length - 1];
    assert.strictEqual(last.stage, STAGE_COMMIT);
    assert.strictEqual(last.metadata.reviewVerdict, VERDICT_APPROVED);
  });

  test('RV2: a CHANGES_REQUESTED reviewer output FAILS the gate and reverts to IMPLEMENT', async () => {
    const result = await buildUseCase().execute({ reviewOutput: CHANGES_REQUESTED_BLOCK });

    assert.strictEqual(result.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(result.passed, false, 'a CHANGES_REQUESTED must fail the gate');
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.reviewSource, 'reviewer-output');

    const saved: any = await stateRepo.load();
    assert.strictEqual(saved.currentStage, STAGE_IMPLEMENT);
    const last = saved.history[saved.history.length - 1];
    assert.strictEqual(last.stage, STAGE_IMPLEMENT);
    assert.strictEqual(last.metadata.reviewVerdict, VERDICT_CHANGES_REQUESTED);
  });

  test('RV3: a self-declared SKIPPED block is REFUSED by ReviewVerdict.parse (#236)', async () => {
    await assert.rejects(
      () => buildUseCase().execute({ reviewOutput: 'REVIEW_STATUS: SKIPPED\nREVIEW_SUMMARY: nope\n' }),
      (err: any) => err instanceof ReviewerSubagentError
    );

    // The checkpoint must be UNCHANGED: a refused verdict writes nothing.
    const saved: any = await stateRepo.load();
    assert.strictEqual(saved.currentStage, STAGE_REVIEW);
    assert.ok(
      !saved.history.some((h: any) => h.metadata?.reviewVerdict === VERDICT_SKIPPED),
      'a refused verdict must not be recorded'
    );
  });

  test('RV4: a CHANGES_REQUESTED output is NEVER downgraded to SKIPPED', async () => {
    const result = await buildUseCase().execute({ reviewOutput: CHANGES_REQUESTED_BLOCK });

    assert.notStrictEqual(result.verdict.status, VERDICT_SKIPPED);
    assert.strictEqual(result.verdict.status, VERDICT_CHANGES_REQUESTED);

    const saved: any = await stateRepo.load();
    const recorded = saved.history
      .map((h: any) => h.metadata?.reviewVerdict)
      .filter((v: any) => typeof v === 'string');
    assert.ok(recorded.includes(VERDICT_CHANGES_REQUESTED));
    assert.ok(!recorded.includes(VERDICT_SKIPPED));
  });

  test('RV5: with no reviewer output and no critique report the verdict is still SKIPPED -> COMMIT (N1)', async () => {
    // No critique port at all: the production absence path.
    const useCase = new RunReviewUseCase(stateRepo, configRepo, planGenerator, standardsRepo);
    const result = await useCase.execute({});

    assert.strictEqual(result.verdict.status, VERDICT_SKIPPED);
    assert.strictEqual(result.passed, true, 'the #236 advisory fail-open is NOT inverted');
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.strictEqual(result.reviewSource, 'skipped');

    const saved: any = await stateRepo.load();
    const last = saved.history[saved.history.length - 1];
    assert.strictEqual(last.metadata.reviewVerdict, VERDICT_SKIPPED);
  });

  test('RV6: a verdict can be recorded while the pipeline rests at the COMMIT gate', async () => {
    // The LIVE case (issue #269): the commit gate reported "No AI review
    // verdict is recorded for this task" while the reviewer was holding a
    // genuine APPROVED verdict that had no channel to the checkpoint.
    const sm = StateMachine.createInitial({ issue: 269 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_COMMIT);
    stateRepo = new MockStateRepository(sm.toSnapshot());

    const result = await buildUseCase().execute({ reviewOutput: APPROVED_BLOCK });

    assert.strictEqual(result.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.currentStage, STAGE_COMMIT);

    const saved: any = await stateRepo.load();
    const last = saved.history[saved.history.length - 1];
    assert.strictEqual(last.stage, STAGE_COMMIT);
    assert.strictEqual(last.metadata.reviewVerdict, VERDICT_APPROVED);
  });

  test('RV7: a CHANGES_REQUESTED recorded at the COMMIT gate reverts to IMPLEMENT', async () => {
    const sm = StateMachine.createInitial({ issue: 269 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_COMMIT);
    stateRepo = new MockStateRepository(sm.toSnapshot());

    const result = await buildUseCase().execute({ reviewOutput: CHANGES_REQUESTED_BLOCK });

    assert.strictEqual(result.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(result.passed, false, 'a CHANGES_REQUESTED must fail the gate');
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);

    const saved: any = await stateRepo.load();
    assert.strictEqual(saved.currentStage, STAGE_IMPLEMENT);
    const last = saved.history[saved.history.length - 1];
    assert.strictEqual(last.metadata.reviewVerdict, VERDICT_CHANGES_REQUESTED);
  });

  test('RV8: filing a verdict does NOT execute the Tier 1 critique CLI (issue #269, R2)', async () => {
    // The recording path is hermetic: the reviewer's verdict is authoritative,
    // so the critique CLI must not be executed — no network round-trip, no
    // latency cost and NO interactive install prompt on a path that must never
    // block or mutate the machine.
    const result = await buildUseCase().execute({ reviewOutput: APPROVED_BLOCK });

    assert.strictEqual(critique.reviewCalls, 0, 'the critique CLI must not be executed');
    assert.strictEqual(result.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(result.reviewSource, 'reviewer-output');
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
  });

  test('RV9: a critique escalation is reported as such, never as the reviewer\'s verdict (issue #269, R3)', async () => {
    // The reviewer APPROVED, but the critique report carries a blocking
    // finding, so the TWO-TIER INVARIANT escalates the verdict to
    // CHANGES_REQUESTED. The recorded SOURCE must name BOTH contributors:
    // plain `reviewer-output` would claim that the reviewer asked for changes
    // the reviewer never asked for.
    const { AiReviewReport, AiReviewFinding, ReviewConfidence } = require('../../dist/domain');
    const priorCritiqueReport = new AiReviewReport({
      summary: 'Automated critique found a blocking defect',
      confidence: ReviewConfidence.high('Deep static scan'),
      findings: [
        new AiReviewFinding({
          path: 'src/index.ts',
          line: 1,
          rule: 'blocking-defect',
          message: 'Injected blocking defect',
          severity: 'error'
        })
      ]
    });

    const result = await buildUseCase().execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport
    });

    assert.strictEqual(result.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);

    // The source must NOT claim the reviewer requested the changes.
    assert.notStrictEqual(
      result.reviewSource,
      'reviewer-output',
      'the source must not claim the reviewer produced the CHANGES_REQUESTED'
    );
    assert.strictEqual(result.reviewSource, 'reviewer-output+critique-escalation');
  });
});
