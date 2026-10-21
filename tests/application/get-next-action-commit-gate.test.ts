/**
 * agyloop - COMMIT-Gate Description Tests (issue #259, AC4, C1-C3)
 *
 * The COMMIT gate used to hard-code "Review passed." regardless of what the
 * AI review actually did. A SKIPPED review (#236's deliberate advisory
 * fail-open) must never be presented as a pass, and the #236 fail-open itself
 * must NOT be inverted into a fabricated CHANGES_REQUESTED.
 *
 * The verdict is read from the recorded history metadata (`reviewVerdict`),
 * exactly the way `RunReviewUseCase` writes it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { GetNextActionUseCase } = require('../../dist/application');
const { RunReviewUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  VERDICT_APPROVED,
  VERDICT_SKIPPED
} = require('../../dist/domain');

type StateRepository = import('../../src').StateRepository;
type StateMachineSnapshot = import('../../src').StateMachineSnapshot;
type ConfigRepository = import('../../src').ConfigRepository;
type AgyLoopConfig = import('../../src').AgyLoopConfig;

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

/**
 * Builds a checkpoint resting at the COMMIT gate.
 *
 * `reviewVerdict` is written into the metadata of the COMMIT history entry —
 * exactly the shape `RunReviewUseCase` produces. Passing `null` simulates a
 * checkpoint that carries NO recorded verdict at all.
 */
function buildCommitCheckpoint(reviewVerdict: string | null): StateMachineSnapshot {
  const sm = StateMachine.createInitial({ issue: 259, baseBranch: 'main' });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  sm.transition(STAGE_REVIEW);
  sm.transition(
    STAGE_COMMIT,
    reviewVerdict === null ? { note: 'Reached the commit gate' } : { note: 'Reached the commit gate', reviewVerdict }
  );
  return sm.toSnapshot();
}

async function commitGateDescription(reviewVerdict: string | null): Promise<string> {
  const stateRepo = new MockStateRepo(buildCommitCheckpoint(reviewVerdict));
  const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

  const result = await useCase.execute({ workspaceDir: '/repo' });

  assert.strictEqual(result.currentStage, STAGE_COMMIT);
  assert.strictEqual(result.actionType, 'human_gate');
  return result.description;
}

const COMMIT_INSTRUCTIONS =
  'Draft conventional commit, prompt for confirmation, push to remote, and teardown worktree.';

describe('GetNextActionUseCase COMMIT-gate description (issue #259, AC4)', () => {
  test('C1 (AC4): at the COMMIT gate with an APPROVED verdict the description still says "Review passed"', async () => {
    const description = await commitGateDescription(VERDICT_APPROVED);

    assert.ok(
      description.startsWith('Review passed.'),
      `an APPROVED verdict must still read as a pass, got: ${description}`
    );
    assert.ok(
      description.includes(COMMIT_INSTRUCTIONS),
      `the commit instructions must be preserved, got: ${description}`
    );
  });

  test('C2 (AC4): at the COMMIT gate with a SKIPPED verdict the description says SKIPPED and never "Review passed"', async () => {
    const description = await commitGateDescription(VERDICT_SKIPPED);

    assert.ok(
      description.includes('SKIPPED'),
      `a SKIPPED verdict must be named, got: ${description}`
    );
    assert.ok(
      description.includes('advisory, not a pass'),
      `a SKIPPED verdict must be labelled advisory, got: ${description}`
    );
    assert.ok(
      !description.includes('Review passed'),
      `a SKIPPED verdict must never be described as a pass, got: ${description}`
    );
    assert.ok(
      description.includes(COMMIT_INSTRUCTIONS),
      `the commit instructions must be preserved, got: ${description}`
    );
  });

  test('C3 (AC4): at the COMMIT gate with no recorded verdict the description claims neither a pass nor a skip', async () => {
    const description = await commitGateDescription(null);

    assert.ok(
      description.includes('No AI review verdict is recorded'),
      `an unrecorded verdict must be reported as such, got: ${description}`
    );
    assert.ok(
      !description.includes('Review passed'),
      `an unrecorded verdict must never be described as a pass, got: ${description}`
    );
    assert.ok(
      !description.includes('SKIPPED'),
      `an unrecorded verdict must not be described as a skip, got: ${description}`
    );
    assert.ok(
      description.includes(COMMIT_INSTRUCTIONS),
      `the commit instructions must be preserved, got: ${description}`
    );
  });
});

/**
 * C4 (issue #269, AC2.4): after a dispatched Reviewer subagent's verdict is
 * RECORDED through the production path, the COMMIT gate reports the ACTUAL
 * verdict — never "No AI review verdict is recorded for this task".
 */
describe('GetNextActionUseCase COMMIT-gate description after a recorded reviewer verdict (issue #269)', () => {
  test('C4: a recorded reviewer APPROVED verdict is reported as "Review passed."', async () => {
    const sm = StateMachine.createInitial({ issue: 269, baseBranch: 'main' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);

    const stateRepo = new MockStateRepo(sm.toSnapshot());

    // The production recording path: `RunReviewUseCase` with a reviewer
    // subagent's verdict block (what `codeloop review --verdict-file` does).
    const reviewUseCase = new RunReviewUseCase(
      stateRepo,
      makeMockConfig(),
      {
        resolvePlanFile: () => null,
        readPlanDocument: () => '',
        updateSummaryLog: () => true
      } as any,
      undefined,
      undefined
    );
    const review = await reviewUseCase.execute({
      reviewOutput: 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: All good.\nUNFULFILLED_AC:\n- None\n'
    });
    assert.strictEqual(review.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(review.currentStage, STAGE_COMMIT);

    // Now the COMMIT gate must describe what ACTUALLY happened.
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());
    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.ok(
      result.description.startsWith('Review passed.'),
      `the recorded APPROVED verdict must read as a pass, got: ${result.description}`
    );
    assert.ok(
      !result.description.includes('No AI review verdict is recorded'),
      `the gate must not claim the verdict is missing, got: ${result.description}`
    );
  });
});
