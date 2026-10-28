/**
 * agyloop - TRIAGE dismissal fail-closed tests (issue #336)
 *
 * A `dismiss` that posted nothing used to record a disposition and transition
 * the checkpoint to COMPLETED anyway — a dismissal the tool never performed.
 * These cases pin the opposite contract: a dismissal that cannot possibly
 * dismiss anything is REFUSED, and it writes nothing.
 *
 * F1/F2  - a bare dismissal (no notes / whitespace) is refused before GitHub
 * F3/F4  - a dismissal that handled zero items is refused; counts survive
 * F5     - a partial dismissal records only the feedback it actually answered
 * F6     - a merely RESOLVED thread is replied to (resolution is not proof)
 * F7-F10 - a dry run predicts the same refusal the real run enforces
 * F11/F12- the refusal is scoped to `dismiss` (control)
 * F13    - the precondition precedence is pure and shared
 *
 * Every case fails on build a3f1740 and passes after the #336 fix.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  TriagePrCommentsUseCase,
  dismissalPreconditionReason
} = require('../../dist/application');
const {
  STAGE_TRIAGE,
  STAGE_COMPLETED,
  STAGE_IMPLEMENT,
  StateMachine
} = require('../../dist/domain');

function triageSnapshot(issue = 336) {
  const sm = StateMachine.createInitial({ issue });
  sm.transition(STAGE_TRIAGE);
  return sm.toSnapshot();
}

function makeCountingRepo(initialSnapshot: any = null) {
  let current = initialSnapshot;
  const repo = {
    saves: 0,
    load: async () => current,
    save: async (snap: any) => {
      repo.saves++;
      current = snap;
    },
    exists: async () => current !== null,
    delete: async () => {
      current = null;
    }
  };
  return repo;
}

function makeGateway(overrides: Record<string, any> = {}) {
  const calls = {
    replyToThread: 0,
    resolveReviewThread: 0,
    replyToConversationComment: 0
  };
  const gateway = {
    listReviewThreads: async () => [],
    replyToThread: async () => {
      calls.replyToThread++;
    },
    resolveReviewThread: async () => {
      calls.resolveReviewThread++;
    },
    replyToConversationComment: async () => {
      calls.replyToConversationComment++;
    },
    ...overrides
  };
  return { gateway, calls };
}

const ACTIONABLE_INLINE = {
  id: 101,
  surface: 'inline',
  author: 'reviewer',
  body: '[error] Fix the nil dereference',
  category: 'error'
};

describe('TRIAGE dismissal fails closed (issue #336)', () => {
  test('F1 (AC-1): a bare dismiss is refused and writes nothing', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway, calls } = makeGateway();

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      comments: [ACTIONABLE_INLINE]
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.refused?.cause, 'missing-notes');
    assert.ok(result.refused?.reason.includes('-m "<notes>"'));
    assert.strictEqual(result.disposition, null);
    assert.strictEqual(result.dispositionRecorded, false);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_TRIAGE);
    assert.strictEqual(result.stateUpdated, false);
    assert.strictEqual(repo.saves, 0);
    // The notes check runs BEFORE the mutating route: no reply, no resolve.
    assert.deepStrictEqual(calls, {
      replyToThread: 0,
      resolveReviewThread: 0,
      replyToConversationComment: 0
    });
  });

  test('F2 (AC-1): whitespace is not notes — it is refused like a bare dismiss', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway, calls } = makeGateway();

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      notes: '   ',
      comments: [ACTIONABLE_INLINE]
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.refused?.cause, 'missing-notes');
    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(calls.replyToThread, 0);
  });

  test('F3 (AC-2): a dismissal that handled zero items is refused', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway } = makeGateway({ listReviewThreads: async () => [] });

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      notes: 'answered inline',
      comments: [ACTIONABLE_INLINE]
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.refused?.cause, 'nothing-handled');
    assert.ok(result.refused?.reason.includes('codeloop triage completed'));
    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_TRIAGE);
    assert.strictEqual(result.disposition, null);
  });

  test('F4 (AC-2): a wholly failed dismissal refuses but keeps its counts', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway } = makeGateway({
      listReviewThreads: async () => [{ id: 'T1', isResolved: false, commentIds: [101] }],
      replyToThread: async () => {
        throw new Error('secondary rate limit');
      }
    });

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      notes: 'answered inline',
      comments: [ACTIONABLE_INLINE]
    });

    assert.strictEqual(result.refused?.cause, 'nothing-handled');
    assert.strictEqual(result.dismissal?.failures.length, 1);
    assert.strictEqual(result.dismissal?.threadsReplied, 0);
    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(result.disposition, null);
  });

  test('F5 (AC-2): a partial dismissal records only the feedback it answered', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway } = makeGateway({
      listReviewThreads: async () => [
        { id: 'T1', isResolved: false, commentIds: [101] },
        { id: 'T2', isResolved: false, commentIds: [202] }
      ],
      replyToThread: async (id: string) => {
        if (id === 'T2') throw new Error('secondary rate limit');
      }
    });

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      notes: 'answered inline',
      comments: [
        ACTIONABLE_INLINE,
        { id: 202, surface: 'inline', author: 'reviewer', body: '[error] second', category: 'error' }
      ]
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_COMPLETED);
    assert.strictEqual(result.disposition?.action, 'dismiss');
    assert.ok(result.disposition?.feedbackKeys.includes('id:101'));
    assert.ok(
      !result.disposition?.feedbackKeys.includes('id:202'),
      `the FAILED key must stay open: ${JSON.stringify(result.disposition?.feedbackKeys)}`
    );
    assert.strictEqual(repo.saves, 1);
  });

  test('F6 (AC-9): a merely resolved thread is replied to, not skipped', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway, calls } = makeGateway({
      listReviewThreads: async () => [{ id: 'T1', isResolved: true, commentIds: [101] }]
    });

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      notes: 'answered inline',
      comments: [ACTIONABLE_INLINE]
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dismissal?.threadsReplied, 1);
    assert.strictEqual(result.dismissal?.threadsResolved, 0);
    assert.strictEqual(result.dismissal?.threadsSkipped, 0);
    assert.strictEqual(calls.replyToThread, 1);
    // The reply is the answer, so the key is what closes the gate.
    assert.deepStrictEqual(result.disposition?.feedbackKeys, ['id:101']);
  });

  test('F7 (AC-3): a dry run without notes predicts the refusal', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway } = makeGateway();

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      comments: [ACTIONABLE_INLINE],
      dryRun: true
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.refused?.cause, 'missing-notes');
    assert.strictEqual(result.wouldDismiss, false);
    assert.strictEqual(repo.saves, 0);
  });

  test('F8 (AC-3): a dry run with no PR predicts no-pull-request', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway } = makeGateway({
      findPullRequest: async () => null
    });

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      action: 'dismiss',
      notes: 'answered',
      dryRun: true
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.refused?.cause, 'no-pull-request');
    assert.strictEqual(repo.saves, 0);
  });

  test('F9 (AC-3): a dry run over no feedback predicts nothing-handled', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway } = makeGateway();

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      notes: 'answered',
      comments: [],
      dryRun: true
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.refused?.cause, 'nothing-handled');
    assert.strictEqual(repo.saves, 0);
  });

  test('F10 (control): a dry run with every precondition met still predicts a dismissal', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const { gateway } = makeGateway();

    const useCase = new TriagePrCommentsUseCase(repo as any, gateway as any);
    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'dismiss',
      notes: 'answered',
      comments: [ACTIONABLE_INLINE],
      dryRun: true
    });

    assert.ok(result.refused === undefined || result.refused === null);
    assert.strictEqual(result.wouldDismiss, true);
    assert.strictEqual(repo.saves, 0);
  });

  test('F11 (control): non-dismiss actions keep the full actionable key set', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const useCase = new TriagePrCommentsUseCase(repo as any);

    const result = await useCase.execute({
      issue: 336,
      prNumber: 5,
      action: 'implement',
      comments: [
        ACTIONABLE_INLINE,
        { id: 202, surface: 'inline', author: 'reviewer', body: '[error] second', category: 'error' }
      ]
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.disposition?.feedbackKeys.length, 2);
  });

  test('F12 (control): completed with no feedback still advances and saves', async () => {
    const repo = makeCountingRepo(triageSnapshot());
    const useCase = new TriagePrCommentsUseCase(repo as any);

    const result = await useCase.execute({ issue: 336, action: 'completed' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_COMPLETED);
    assert.strictEqual(result.disposition, null);
    assert.strictEqual(repo.saves, 1);
  });

  test('F13 (AC-1/AC-2/AC-3): the precondition helper is pure and ordered', () => {
    const comment = ACTIONABLE_INLINE;
    const everyPreconditionHolds = {
      notes: 'answered',
      prNumber: 5,
      hasGateway: true,
      comments: [comment]
    };

    assert.strictEqual(dismissalPreconditionReason({ ...everyPreconditionHolds, notes: undefined })?.cause, 'missing-notes');
    assert.strictEqual(dismissalPreconditionReason({ ...everyPreconditionHolds, notes: '   ' })?.cause, 'missing-notes');
    assert.strictEqual(dismissalPreconditionReason({ ...everyPreconditionHolds, prNumber: null })?.cause, 'no-pull-request');
    assert.strictEqual(dismissalPreconditionReason({ ...everyPreconditionHolds, hasGateway: false })?.cause, 'no-gateway');
    assert.strictEqual(dismissalPreconditionReason({ ...everyPreconditionHolds, comments: [] })?.cause, 'nothing-handled');
    assert.strictEqual(dismissalPreconditionReason(everyPreconditionHolds), null);
  });
});
