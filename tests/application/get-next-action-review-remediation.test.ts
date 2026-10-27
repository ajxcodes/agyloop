/**
 * agyloop - IMPLEMENT directive review remediation (issue #313, AC1-AC5)
 *
 * When the REVIEW gate returns `CHANGES_REQUESTED`, `RunReviewUseCase` reverts
 * the machine to IMPLEMENT and records the full remediation in the history
 * entry it writes (`reviewVerdict`, `reviewTokens`, `reviewRound`,
 * `selfCorrectionPayload`). `next` used to rebuild the implementer prompt from
 * the plan + `triagePayload` only, so the remediation was recorded and dropped.
 *
 * RR1 - a `CHANGES_REQUESTED` round reaches the IMPLEMENT prompt verbatim
 * RR2 - a later APPROVED round carries NO stale remediation (AC2)
 * RR3 - a later SKIPPED round carries NO stale remediation (AC2)
 * RR4 - the legacy `selfCorrectionPayload` record is still surfaced (AC1)
 * RR5 - the production `RunReviewUseCase -> next` path survives a JSON
 *       round-trip of the checkpoint (AC1/AC3)
 * RR6 - a first dispatch (no review yet) is unchanged
 * RR7 - review remediation and PR triage comments stay separate channels
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { GetNextActionUseCase, RunReviewUseCase } = require('../../dist/application');
const {
  StateMachine,
  Stage,
  IssueNumber,
  WorktreeDescriptor,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  VERDICT_SKIPPED
} = require('../../dist/domain');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

type StateRepository = import('../../src').StateRepository;
type StateMachineSnapshot = import('../../src').StateMachineSnapshot;
type ConfigRepository = import('../../src').ConfigRepository;
type AgyLoopConfig = import('../../src').AgyLoopConfig;

const REMEDIATION_SENTINEL = 'REMEDIATION_SENTINEL_313';
const LEGACY_SENTINEL = 'LEGACY_SENTINEL_313';
const PRODUCTION_SENTINEL = 'PRODUCTION_SENTINEL_313';
const PR_SENTINEL = 'PR_SENTINEL_313';

const REVIEW_TOKENS = [
  'REVIEW_STATUS: CHANGES_REQUESTED',
  'REVIEW_SUMMARY: round two summary',
  'UNFULFILLED_AC:',
  '- AC one',
  'REMEDIATION_GUIDANCE:',
  `- ${REMEDIATION_SENTINEL}`
].join('\n');

const LEGACY_PAYLOAD = [
  '### Reviewer Subagent Self-Correction Remediation Guidance:',
  'The previous AI Review requested changes. Address these items before continuing:',
  '',
  '**Review Summary**: legacy round',
  '',
  `- ${LEGACY_SENTINEL}`
].join('\n');

const PRODUCTION_BLOCK = [
  'REVIEW_STATUS: CHANGES_REQUESTED',
  'REVIEW_SUMMARY: the production round requested changes',
  'UNFULFILLED_AC:',
  '- The regression is fixed',
  'REMEDIATION_GUIDANCE:',
  `- ${PRODUCTION_SENTINEL}`
].join('\n');

class MockStateRepo implements StateRepository {
  public savedSnapshot: StateMachineSnapshot | null = null;

  constructor(initial: StateMachineSnapshot | null = null) {
    this.savedSnapshot = initial;
  }

  public async load(): Promise<StateMachineSnapshot | null> {
    return this.savedSnapshot;
  }

  public async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.savedSnapshot = snapshot;
  }

  public async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  public getStateFilePath(): string {
    return '/repo/.agyloop/state.json';
  }
}

function makeMockConfig(): ConfigRepository {
  const config: AgyLoopConfig = {
    models: {
      planner: 'pro',
      implementer: 'inherit',
      gate: 'flash_lite',
      reviewer: 'flash'
    },
    options: {
      commitAfter: false,
      gateTimeoutSeconds: 300,
      autoApproveInYolo: true,
      enableMcpInPlanner: true
    }
  };

  return {
    loadConfig: () => config,
    resolveModel: (role: string) => ({
      role,
      configured: config.models[role] || 'inherit',
      tier: 'flash' as any,
      apiModel: 'gemini-2.5-flash'
    }),
    mapModelToTier: () => 'flash' as any
  };
}

/** A real machine that has cycled through one full review round. */
function buildReviewMachine(): any {
  const sm = StateMachine.createInitial({ issue: 313, baseBranch: 'main' });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  sm.transition(STAGE_REVIEW);
  sm.transition(STAGE_IMPLEMENT, {
    reviewVerdict: VERDICT_CHANGES_REQUESTED,
    reviewRound: 2,
    reviewTokens: REVIEW_TOKENS
  });
  sm.setWorktree(
    WorktreeDescriptor.create({
      taskId: 313,
      worktreePath: '/repo/.worktrees/313',
      branch: 'fix/313',
      baseBranch: 'main',
      createdAt: new Date().toISOString()
    })
  );
  return sm;
}

/** Cycles QUALITY_GATE -> REVIEW -> IMPLEMENT with the given verdict. */
function recordVerdict(sm: any, verdict: string, round: number): void {
  sm.transition(STAGE_QUALITY_GATE);
  sm.transition(STAGE_REVIEW);
  sm.transition(STAGE_IMPLEMENT, { reviewVerdict: verdict, reviewRound: round });
}

async function runNext(sm: any): Promise<any> {
  const stateRepo = new MockStateRepo(sm.toSnapshot());
  const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());
  return useCase.execute({ workspaceDir: '/repo' });
}

function promptOf(result: any): string {
  assert.ok(result.invocationPayload, 'the directive must carry an invocation payload');
  return result.invocationPayload.Subagents[0].Prompt;
}

describe('IMPLEMENT directive review remediation (issue #313)', () => {
  test('RR1 (AC1): a CHANGES_REQUESTED round reaches the IMPLEMENT prompt verbatim', async () => {
    const result = await runNext(buildReviewMachine());

    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT, 'the machine rests at IMPLEMENT');
    assert.strictEqual(result.role, 'implementer', 'the directive is the implementer');

    const prompt = promptOf(result);
    const required = [
      'CHANGES_REQUESTED',
      'REVIEW_SUMMARY: round two summary',
      'UNFULFILLED_AC',
      'REMEDIATION_GUIDANCE',
      `- ${REMEDIATION_SENTINEL}`,
      'Round 2'
    ];
    const missing = required.filter((token: string) => !prompt.includes(token));
    assert.deepStrictEqual(
      missing,
      [],
      `AC1: the IMPLEMENT prompt is missing ${missing.join(', ')}\n---\n${prompt}`
    );

    assert.strictEqual(
      result.reviewRemediationRound,
      2,
      `AC1: the directive must report round 2, got ${result.reviewRemediationRound}`
    );
    assert.ok(
      result.description.includes('Includes AI review remediation from round 2.'),
      `AC1: the description must name the remediation round, got: ${result.description}`
    );
  });

  test('RR2 (AC2): a later APPROVED round carries no stale remediation', async () => {
    const sm = buildReviewMachine();
    recordVerdict(sm, VERDICT_APPROVED, 3);

    const result = await runNext(sm);
    const prompt = promptOf(result);

    assert.strictEqual(result.role, 'implementer');
    assert.ok(
      !prompt.includes(REMEDIATION_SENTINEL),
      `AC2: round-2 remediation leaked into an APPROVED re-dispatch\n---\n${prompt}`
    );
    assert.ok(
      !prompt.includes('Review Remediation'),
      `AC2: no remediation section may be rendered after an APPROVED round\n---\n${prompt}`
    );
    assert.strictEqual(
      'reviewRemediationRound' in result,
      false,
      `AC2: an APPROVED round must not report a remediation round, got ${result.reviewRemediationRound}`
    );
  });

  test('RR3 (AC2): a later SKIPPED round carries no stale remediation', async () => {
    const sm = buildReviewMachine();
    recordVerdict(sm, VERDICT_SKIPPED, 3);

    const result = await runNext(sm);
    const prompt = promptOf(result);

    assert.strictEqual(result.role, 'implementer');
    assert.ok(
      !prompt.includes(REMEDIATION_SENTINEL),
      `AC2: round-2 remediation leaked into a SKIPPED re-dispatch\n---\n${prompt}`
    );
    assert.ok(
      !prompt.includes('Review Remediation'),
      `AC2: no remediation section may be rendered after a SKIPPED round\n---\n${prompt}`
    );
    assert.strictEqual('reviewRemediationRound' in result, false);
  });

  test('RR4 (AC1): the legacy selfCorrectionPayload record is still surfaced', async () => {
    const sm = StateMachine.createInitial({ issue: 313, baseBranch: 'main' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    // A legacy record: no `reviewTokens`, no `reviewRound`.
    sm.transition(STAGE_IMPLEMENT, {
      reviewVerdict: VERDICT_CHANGES_REQUESTED,
      selfCorrectionPayload: LEGACY_PAYLOAD
    });
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 313,
        worktreePath: '/repo/.worktrees/313',
        branch: 'fix/313',
        baseBranch: 'main',
        createdAt: new Date().toISOString()
      })
    );

    const result = await runNext(sm);
    const prompt = promptOf(result);

    assert.ok(
      prompt.includes(LEGACY_SENTINEL),
      `AC1: the legacy selfCorrectionPayload was dropped\n---\n${prompt}`
    );
    assert.ok(
      prompt.includes('### Review Remediation (CHANGES_REQUESTED)'),
      `AC1: a legacy record has no round, so the heading must omit it\n---\n${prompt}`
    );
    assert.strictEqual(
      result.reviewRemediationRound,
      null,
      `AC1: a legacy record reports no round, got ${result.reviewRemediationRound}`
    );
  });

  test('RR5 (AC1/AC3): the production RunReviewUseCase verdict survives a checkpoint round-trip', async () => {
    const initialSm = new StateMachine({ stage: new Stage('REVIEW'), issue: new IssueNumber(313) });
    initialSm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 313,
        worktreePath: '/repo/.worktrees/313',
        branch: 'fix/313',
        baseBranch: 'main',
        createdAt: new Date().toISOString()
      })
    );
    const reviewRepo = new MockStateRepo(initialSm.toSnapshot());

    const review = new RunReviewUseCase(
      reviewRepo,
      {
        loadConfig: () => DEFAULT_CONFIG,
        resolveModel: (role: string) => ({ role, configured: 'flash', tier: 'flash', apiModel: 'x' }),
        mapModelToTier: () => 'flash'
      },
      {
        updateSummaryLog: () => true,
        scaffoldPlanDirectory: () => null,
        generatePlan: () => null,
        generateSummaryLog: () => null,
        findPlanDirectory: () => null,
        resolvePlanFile: () => ({
          planDir: '/fake/plans/313-task',
          planPath: '/fake/plans/313-task/implementation_plan.md',
          planFileName: 'implementation_plan.md',
          summaryPath: '/fake/plans/313-task/Summary.md'
        }),
        readPlanDocument: () => '# Plan\n\n- Step 1: fix it\n'
      },
      {
        loadStandards: () => '# Standards',
        findStandardsPath: () => '/fake/.github/critique.md'
      },
      {
        resolveReviewer: () => ({ source: 'bundled', path: '/fake/bin/critique.js', isAvailable: true }),
        getVersion: async () => '1.0.0',
        review: async () => {
          const { AiReviewReport, ReviewConfidence } = require('../../dist/domain');
          return new AiReviewReport({
            summary: 'Clean automated review',
            confidence: ReviewConfidence.high('Diff verified.'),
            findings: []
          });
        }
      }
    );

    const outcome = await review.execute({ reviewOutput: PRODUCTION_BLOCK });
    assert.strictEqual(outcome.currentStage, STAGE_IMPLEMENT, 'the review reverted the machine to IMPLEMENT');

    // The ONLY input the next invocation gets is the persisted checkpoint.
    const persisted = JSON.parse(JSON.stringify(await reviewRepo.load()));
    const restoredSm = StateMachine.fromSnapshot(persisted);
    const result = await runNext(restoredSm);
    const prompt = promptOf(result);

    assert.ok(
      prompt.includes(PRODUCTION_SENTINEL),
      `AC1/AC3: the production verdict was lost across the checkpoint round-trip\n---\n${prompt}`
    );
    assert.strictEqual(
      result.reviewRemediationRound,
      1,
      `AC3: the first review round is round 1, got ${result.reviewRemediationRound}`
    );
  });

  test('RR6 (AC2/first dispatch): a checkpoint with no review yet is unchanged', async () => {
    const sm = StateMachine.createInitial({ issue: 313, baseBranch: 'main' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 313,
        worktreePath: '/repo/.worktrees/313',
        branch: 'fix/313',
        baseBranch: 'main',
        createdAt: new Date().toISOString()
      })
    );

    const result = await runNext(sm);
    const prompt = promptOf(result);

    assert.strictEqual(result.role, 'implementer');
    assert.ok(!prompt.includes('Review Remediation'), 'no review has run, so no section is rendered');
    assert.strictEqual('reviewRemediationRound' in result, false);
    assert.strictEqual(
      result.description,
      'Execute surgical code modifications adhering strictly to approved plan in dedicated worktree.'
    );
  });

  test('RR7 (AC1/channel separation): review remediation and PR triage comments coexist', async () => {
    const sm = buildReviewMachine();
    sm.setTriagePayload(PR_SENTINEL);

    const result = await runNext(sm);
    const prompt = promptOf(result);

    assert.ok(
      prompt.includes('### Pull Request Review Comments to Address:'),
      'the PR triage channel must survive'
    );
    assert.ok(prompt.includes(PR_SENTINEL), 'the PR triage payload must be rendered');
    assert.ok(
      prompt.includes('### Review Remediation - Round 2 (CHANGES_REQUESTED)'),
      `AC1: the review remediation heading must be its own channel\n---\n${prompt}`
    );
    assert.ok(prompt.includes(REMEDIATION_SENTINEL), 'the review remediation must be rendered');
  });
});
