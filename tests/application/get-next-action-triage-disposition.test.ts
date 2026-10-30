/**
 * agyloop - TRIAGE Disposition Tests (issue #269, Defect 1)
 *
 * The livelock: `codeloop next` routed a COMPLETED checkpoint into the TRIAGE
 * gate whenever the task's pull request was OPEN and carried ANY comment. The
 * triage subagent routed it back to COMPLETED — the sanctioned disposition for
 * "nothing actionable here" — and the NEXT `codeloop next` routed it to TRIAGE
 * again. The checkpoint had no vocabulary for "this feedback was handled".
 *
 * G1  - an OPEN PR with one actionable comment routes to TRIAGE
 * G2  - after a recorded disposition the second `next` reports COMPLETED
 * G3  - THE AC's REGRESSION TEST, verbatim
 * G4  - a PR carrying ONLY the automated summary does not route
 * G5  - the summary AND an actionable comment routes; the payload is actionable-only
 * G6  - the TRIAGE directive names the exit condition
 * G7  - the idle report names the recorded disposition
 * G8  - the tool's own dismissal reply is excluded from the detected count
 * G9  - a real CHANGES_REQUESTED review comment still routes (the detector is
 *       NOT weakened)
 * G10 - a NEW actionable comment after the disposition re-routes (the tool does
 *       NOT go blind)
 * G11 - a disposition recorded for ANOTHER pull request does not suppress the
 *       feedback (issue #269, R4)
 * G12 - the dispatch count, the list count, the recorded count and the handled
 *       keys agree on the 3-comment fixture (issue #397, D1-AC1/2/4, S-AC1)
 * G13 - a dismissal never answers the automated summary (issue #397, D1-AC3)
 * G14 - legitimate conversation feedback is still answered and recorded (S-AC2)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { GetNextActionUseCase, TriagePrCommentsUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_COMPLETED,
  STAGE_TRIAGE,
  GATE_TRIAGE,
  NOTE_TRIAGE_GATE_EXIT_CONDITION,
  DISMISS_INLINE_REPLY_MARKER,
  DISMISS_CONVERSATION_REPLY_FOOTER
} = require('../../dist/domain');

import type { StateRepository, ConfigRepository, AgyLoopConfig } from '../../src/ports';
import type { StateMachineSnapshot } from '../../src/domain';

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
      apiModel: 'gemini-3.5-flash'
    }),
    mapModelToTier: () => 'flash' as any
  };
}

/** A COMPLETED checkpoint for issue #900 — the shape the issue describes. */
function seedCompleted(overrides: Record<string, unknown> = {}): StateMachineSnapshot {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    currentStage: STAGE_COMPLETED,
    mode: 'standard',
    issue: 900,
    baseBranch: 'main',
    createdAt: now,
    updatedAt: now,
    history: [{ stage: STAGE_COMPLETED, timestamp: now }],
    pausedAtGate: null,
    pausedAtTimestamp: null,
    ...overrides
  } as unknown as StateMachineSnapshot;
}

/**
 * A gateway whose OPEN PR #7 carries the given comments.
 */
function gatewayWithComments(comments: readonly any[]): any {
  return {
    getCurrentRepo: () => 'owner/repo',
    fetchIssue: async () => null,
    findPullRequest: async () => ({
      number: 7,
      title: 'Task #900',
      state: 'OPEN',
      baseRefName: 'main',
      headRefName: 'task/900',
      url: 'https://example.invalid/pr/7',
      merged: false,
      labels: []
    }),
    fetchPullRequestComments: async () => comments
  };
}

const ACTIONABLE_COMMENT = {
  id: 101,
  author: 'reviewer',
  body: 'Please fix the nil dereference in resolve-subagent.ts',
  created_at: '2026-10-21T11:00:00Z'
};

const SUMMARY_COMMENT = {
  id: 102,
  author: 'github-actions[bot]',
  body: '## Critique AI Review Run Summary\n\nNo findings.',
  created_at: '2026-10-21T11:30:00Z'
};

const DISMISSAL_REPLY = {
  id: 104,
  author: 'me',
  surface: 'conversation',
  body: `Reviewed — dismissing.\n\n${DISMISS_CONVERSATION_REPLY_FOOTER}\n> Please fix the nil dereference`,
  created_at: '2026-10-21T11:05:00Z'
};

/**
 * The issue's real 3-comment fixture (issue #397): two inline actionable
 * findings and one conversation automated summary.
 */
const THREE_COMMENT_PR = [
  {
    id: 4427630468,
    surface: 'inline',
    author: 'critique',
    path: 'src/a.ts',
    line: 10,
    body: '- [critique]: SUGGESTION - prefer a readonly field.'
  },
  {
    id: 4427630608,
    surface: 'inline',
    author: 'critique',
    path: 'src/b.ts',
    line: 4,
    body: '- [critique]: INFO - the helper is unused in this diff.'
  },
  {
    id: 6531579688,
    surface: 'conversation',
    author: 'github-actions[bot]',
    body: '### 🤖 Critique AI Review Run Summary\n\nNo critical, error or warning findings.'
  }
];

/**
 * A gateway that ALSO supports the dismissal sinks (issue #397).
 */
function dismissalGateway(comments: readonly any[]): any {
  const repliedThreads: string[] = [];
  const repliedConversation: number[] = [];
  return {
    repliedThreads,
    repliedConversation,
    getCurrentRepo: () => 'owner/repo',
    fetchIssue: async () => null,
    findPullRequest: async () => ({
      number: 7,
      title: 'Task #900',
      state: 'OPEN',
      baseRefName: 'main',
      headRefName: 'task/900',
      url: 'https://example.invalid/pr/7',
      merged: false,
      labels: []
    }),
    fetchPullRequestComments: async () => comments,
    listReviewThreads: async () =>
      comments
        .filter((c: any) => c.surface === 'inline')
        .map((c: any) => ({ id: `thread-${c.id}`, commentIds: [c.id], isResolved: false })),
    replyToThread: async (id: string) => {
      repliedThreads.push(id);
    },
    resolveReviewThread: async () => undefined,
    replyToConversationComment: async (_pr: number, id: number) => {
      repliedConversation.push(id);
    }
  };
}

describe('TRIAGE disposition (issue #269, Defect 1)', () => {
  test('G1: a COMPLETED checkpoint with an OPEN PR carrying one actionable comment routes to TRIAGE', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([ACTIONABLE_COMMENT])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'triage');

    const saved = await stateRepo.load();
    assert.strictEqual(saved!.currentStage, STAGE_TRIAGE);
    assert.strictEqual(saved!.pausedAtGate, GATE_TRIAGE);
    assert.ok(saved!.triagePayload!.includes('nil dereference'));
  });

  test('G2: after a recorded disposition the second `next` reports COMPLETED / completed', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const gateway = gatewayWithComments([ACTIONABLE_COMMENT]);

    const next = new GetNextActionUseCase(stateRepo, makeMockConfig(), undefined, gateway);
    const first = await next.execute({ workspaceDir: '/repo' });
    assert.strictEqual(first.currentStage, STAGE_TRIAGE);

    // The triage subagent's disposition.
    const triage = new TriagePrCommentsUseCase(stateRepo, gateway);
    const triageResult = await triage.execute({ issue: 900, action: 'completed' });
    assert.strictEqual(triageResult.targetStage, STAGE_COMPLETED);
    assert.strictEqual(triageResult.dispositionRecorded, true);

    const second = await next.execute({ workspaceDir: '/repo' });
    assert.strictEqual(second.currentStage, STAGE_COMPLETED);
    assert.strictEqual(second.actionType, 'completed');
  });

  test('G3: THE AC REGRESSION TEST — route to TRIAGE, triage completed, `next` again is still COMPLETED', async () => {
    // Seed a COMPLETED checkpoint whose PR carries one comment.
    const stateRepo = new MockStateRepo(seedCompleted());
    const gateway = gatewayWithComments([ACTIONABLE_COMMENT]);

    // route to TRIAGE
    const next = new GetNextActionUseCase(stateRepo, makeMockConfig(), undefined, gateway);
    const routed = await next.execute({ workspaceDir: '/repo' });
    assert.strictEqual(routed.currentStage, STAGE_TRIAGE);

    // triage completed
    const triage = new TriagePrCommentsUseCase(stateRepo, gateway);
    await triage.execute({ issue: 900, action: 'completed' });

    // codeloop next again -> the stage must STILL be COMPLETED.
    const again = await next.execute({ workspaceDir: '/repo' });
    assert.strictEqual(again.currentStage, STAGE_COMPLETED);
    assert.strictEqual(again.actionType, 'completed');

    // And it stays that way on every further read: the loop is GONE.
    const third = await next.execute({ workspaceDir: '/repo' });
    assert.strictEqual(third.currentStage, STAGE_COMPLETED);
    assert.strictEqual(third.actionType, 'completed');
  });

  test('G4: a PR carrying ONLY the automated summary does not route', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([SUMMARY_COMMENT])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_COMPLETED);
    assert.strictEqual(result.actionType, 'completed');

    const saved = await stateRepo.load();
    assert.strictEqual(saved!.currentStage, STAGE_COMPLETED);
    assert.strictEqual(saved!.pausedAtGate, null);
  });

  test('G5: the summary AND an actionable comment routes, and the payload is actionable-only', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([SUMMARY_COMMENT, ACTIONABLE_COMMENT])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_TRIAGE);

    const saved = await stateRepo.load();
    assert.ok(saved!.triagePayload!.includes('nil dereference'));
    assert.ok(
      !saved!.triagePayload!.includes('Critique AI Review Run Summary'),
      'the automated summary must not be part of the triage payload'
    );
  });

  test('G6: the TRIAGE directive names the exit condition', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([ACTIONABLE_COMMENT])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    assert.ok(
      result.description.includes(NOTE_TRIAGE_GATE_EXIT_CONDITION),
      `the description must name the exit condition, got: ${result.description}`
    );
    assert.ok(
      result.humanSummary.includes('This gate ends when the feedback is dispositioned'),
      `the summary must name the exit condition, got: ${result.humanSummary}`
    );
    assert.ok(
      result.description.includes('merged/closed'),
      `the exit condition must name the PR being merged/closed, got: ${result.description}`
    );
  });

  test('G6b: the TRIAGE summary names the -m "<notes>" requirement for dismiss (issue #336, AC-4)', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([ACTIONABLE_COMMENT])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    assert.ok(
      result.humanSummary.includes('-m "<notes>"'),
      `the summary must name the -m "<notes>" requirement, got: ${result.humanSummary}`
    );
    assert.ok(
      result.humanSummary.includes('dismiss'),
      `the summary must name dismiss, got: ${result.humanSummary}`
    );
    assert.ok(
      result.humanSummary.includes('This gate ends when the feedback is dispositioned'),
      `the summary must keep the exit condition, got: ${result.humanSummary}`
    );
  });

  test('G7: the idle report names the recorded disposition', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const gateway = gatewayWithComments([ACTIONABLE_COMMENT]);

    const next = new GetNextActionUseCase(stateRepo, makeMockConfig(), undefined, gateway);
    await next.execute({ workspaceDir: '/repo' });

    const triage = new TriagePrCommentsUseCase(stateRepo, gateway);
    await triage.execute({ issue: 900, action: 'completed' });

    const idle = await next.execute({ workspaceDir: '/repo' });
    assert.strictEqual(idle.actionType, 'completed');
    assert.ok(
      idle.humanSummary.includes('Triage disposition recorded'),
      `the idle report must name the disposition, got: ${idle.humanSummary}`
    );
    assert.ok(idle.humanSummary.includes('PR #7'));
    assert.ok(idle.humanSummary.includes('COMPLETED'));
  });

  test('G8: the tool\'s own dismissal reply is excluded from the detected count', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([ACTIONABLE_COMMENT, DISMISSAL_REPLY])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    // The PR carries TWO comments, but only ONE of them is feedback.
    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    const saved = await stateRepo.load();
    assert.ok(saved!.triagePayload!.includes('nil dereference'));
    assert.ok(
      !saved!.triagePayload!.includes('Dismissing this PR conversation comment'),
      "the tool's own reply must not be part of the triage payload"
    );
  });

  test('G8b: a PR carrying ONLY the tool\'s own dismissal reply does not route at all', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([DISMISSAL_REPLY])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_COMPLETED);
    assert.strictEqual(result.actionType, 'completed');
  });

  test('G9: a real CHANGES_REQUESTED review comment still routes (the detector is not weakened)', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([
        {
          id: 201,
          author: 'reviewer',
          body: '**ERROR**: null dereference at src/x.ts:12',
          state: 'CHANGES_REQUESTED',
          created_at: '2026-10-21T11:31:00Z'
        }
      ])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'triage');

    const saved = await stateRepo.load();
    assert.ok(saved!.triagePayload!.includes('null dereference'));
  });

  test('G10: a NEW actionable comment added after the disposition re-routes', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const comments = [ACTIONABLE_COMMENT];
    const gateway: any = {
      getCurrentRepo: () => 'owner/repo',
      fetchIssue: async () => null,
      findPullRequest: async () => ({
        number: 7,
        title: 'Task #900',
        state: 'OPEN',
        baseRefName: 'main',
        headRefName: 'task/900',
        url: 'https://example.invalid/pr/7',
        merged: false,
        labels: []
      }),
      fetchPullRequestComments: async () => comments
    };

    const next = new GetNextActionUseCase(stateRepo, makeMockConfig(), undefined, gateway);
    await next.execute({ workspaceDir: '/repo' });

    const triage = new TriagePrCommentsUseCase(stateRepo, gateway);
    await triage.execute({ issue: 900, action: 'completed' });

    const idle = await next.execute({ workspaceDir: '/repo' });
    assert.strictEqual(idle.currentStage, STAGE_COMPLETED);

    // A NEW finding arrives on the PR.
    comments.push({
      id: 301,
      author: 'reviewer',
      body: 'A brand new finding nobody has seen yet',
      created_at: '2026-10-21T12:30:00Z'
    });

    const rerouted = await next.execute({ workspaceDir: '/repo' });
    assert.strictEqual(rerouted.currentStage, STAGE_TRIAGE);
    const saved = await stateRepo.load();
    assert.ok(saved!.triagePayload!.includes('brand new finding'));
  });

  test('G11: a disposition recorded for ANOTHER pull request does not suppress the feedback (R4)', async () => {
    // The disposition applies to ONE pull request ("for that PR"). A
    // disposition recorded for PR #6 must never suppress the feedback of the
    // task's own PR #7 — the feedback is undispositioned, so it routes.
    const stateRepo = new MockStateRepo(
      seedCompleted({
        triageDisposition: {
          prNumber: 6,
          action: 'completed',
          recordedAt: '2026-10-21T10:00:00.000Z',
          // The SAME key the current PR carries: without the PR-number check
          // the disposition would suppress it.
          feedbackKeys: ['id:101']
        }
      })
    );

    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithComments([ACTIONABLE_COMMENT])
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_TRIAGE, 'the feedback must still route to TRIAGE');
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'triage');

    const saved = await stateRepo.load();
    assert.strictEqual(saved!.currentStage, STAGE_TRIAGE);
    assert.strictEqual(saved!.pausedAtGate, GATE_TRIAGE);
    assert.ok(saved!.triagePayload!.includes('nil dereference'));
  });

  test('G12: the dispatch, the list, the record and the handled keys agree (issue #397)', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const gateway = dismissalGateway(THREE_COMMENT_PR);

    const next = new GetNextActionUseCase(stateRepo, makeMockConfig(), undefined, gateway);
    await next.execute({ workspaceDir: '/repo' });

    const dispatched = await stateRepo.load();
    const triageEntry = dispatched!.history.filter((h: any) => h.stage === STAGE_TRIAGE).pop();
    const dispatchCount = (triageEntry!.metadata as any).commentsCount;
    assert.strictEqual(dispatchCount, 2, 'the dispatcher counted the summary as feedback');
    assert.strictEqual(
      dispatched!.triagePayload!.split('\n').filter((line: string) => line.trim()).length,
      2,
      `the triage payload must carry the 2 actionable items, got: ${dispatched!.triagePayload}`
    );

    const triage = new TriagePrCommentsUseCase(stateRepo, gateway);

    const listed = await triage.execute({ issue: 900, workspaceDir: '/repo' });
    assert.strictEqual(listed.comments.length, 2, 'the list surface diverged from the dispatch');
    assert.ok(
      listed.message.includes('Listed 2'),
      `the list message diverged from the acted-on set: ${listed.message}`
    );

    const dismissed = await triage.execute({
      issue: 900,
      workspaceDir: '/repo',
      action: 'dismiss',
      notes: 'Addressed.'
    });

    const after = await stateRepo.load();
    const routedEntry = after!.history.filter((h: any) => h.stage === STAGE_COMPLETED).pop();
    const recordedCount = (routedEntry!.metadata as any).commentCount;

    assert.strictEqual(recordedCount, 2, 'the routed history recorded a different count');
    assert.strictEqual(
      dismissed.dismissal!.handledFeedbackKeys.length,
      2,
      `the dismissal handled a different set: ${JSON.stringify(dismissed.dismissal!.handledFeedbackKeys)}`
    );
    assert.strictEqual(
      dispatchCount,
      listed.comments.length,
      'the dispatched set and the listed set diverged'
    );
    assert.strictEqual(
      listed.comments.length,
      recordedCount,
      'the listed set and the recorded set diverged'
    );
    assert.strictEqual(
      recordedCount,
      dismissed.dismissal!.handledFeedbackKeys.length,
      'the recorded set and the handled keys diverged'
    );
  });

  test('G13: a dismissal never answers the automated summary post (issue #397, D1-AC3)', async () => {
    const stateRepo = new MockStateRepo(seedCompleted());
    const gateway = dismissalGateway(THREE_COMMENT_PR);

    const next = new GetNextActionUseCase(stateRepo, makeMockConfig(), undefined, gateway);
    await next.execute({ workspaceDir: '/repo' });

    const triage = new TriagePrCommentsUseCase(stateRepo, gateway);
    const dismissed = await triage.execute({
      issue: 900,
      workspaceDir: '/repo',
      action: 'dismiss',
      notes: 'Addressed.'
    });

    assert.ok(
      !gateway.repliedConversation.includes(6531579688),
      'the dismissal posted a public reply on the automated summary banner'
    );
    // Order-insensitive by construction: thread iteration order must not make
    // the assertion brittle, but the SET must be exactly the 2 dispatched items.
    assert.deepStrictEqual(
      new Set(dismissed.disposition!.feedbackKeys),
      new Set(['id:4427630608', 'id:4427630468'])
    );
  });

  test('G14: legitimate conversation feedback is still answered and recorded (S-AC2)', async () => {
    const prose = {
      id: 777,
      surface: 'conversation',
      author: 'alice',
      body: 'please rebase and re-run the tests'
    };
    const stateRepo = new MockStateRepo(seedCompleted());
    const gateway = dismissalGateway([...THREE_COMMENT_PR, prose]);

    const next = new GetNextActionUseCase(stateRepo, makeMockConfig(), undefined, gateway);
    await next.execute({ workspaceDir: '/repo' });

    const dispatched = await stateRepo.load();
    const triageEntry = dispatched!.history.filter((h: any) => h.stage === STAGE_TRIAGE).pop();
    assert.strictEqual((triageEntry!.metadata as any).commentsCount, 3);

    const triage = new TriagePrCommentsUseCase(stateRepo, gateway);
    const listed = await triage.execute({ issue: 900, workspaceDir: '/repo' });
    assert.strictEqual(listed.comments.length, 3);

    const dismissed = await triage.execute({
      issue: 900,
      workspaceDir: '/repo',
      action: 'dismiss',
      notes: 'Addressed.'
    });

    assert.ok(
      gateway.repliedConversation.includes(777),
      'genuine conversation feedback was not answered'
    );
    assert.ok(
      dismissed.dismissal!.handledFeedbackKeys.includes('id:777'),
      'genuine conversation feedback was not recorded as handled'
    );
  });
});
