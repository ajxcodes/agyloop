/**
 * agyloop - Triage PR Comments & Lifecycle Routing Unit Tests
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  TriagePrCommentsUseCase,
  GetNextActionUseCase,
  RunLifecycleUseCase,
  prFeedbackKey
} = require('../../dist/application');
const {
  STAGE_TRIAGE,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  STAGE_DISCOVERY,
  STAGE_COMPLETED,
  STAGE_INITIALIZED,
  GATE_TRIAGE,
  StateMachine,
  DISMISS_INLINE_REPLY_MARKER,
  DISMISS_INLINE_REPLY_SIGNATURE
} = require('../../dist/domain');

/**
 * The body the tool posts on an inline review thread: the operator's notes
 * plus the tool's own marker, which is what makes the reply recognisable as
 * the tool's on a later run.
 */
function inlineReplyBody(notes: string): string {
  return `${notes}\n\n${DISMISS_INLINE_REPLY_MARKER}`;
}

function makeMockStateRepo(initialSnapshot: any = null) {
  let current = initialSnapshot;
  return {
    load: async () => current,
    save: async (snap: any) => {
      current = snap;
    },
    exists: async () => current !== null,
    delete: async () => {
      current = null;
    }
  };
}

describe('TriagePrCommentsUseCase & Lifecycle Routing', () => {
  test('transitions state machine to STAGE_IMPLEMENT on triage action "implement"', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    sm.pauseAtGate(GATE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'implement',
      comments: [
        { author: 'reviewer', body: '[error] Fix this bug', category: 'error' }
      ]
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.targetStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.comments.length, 1);
  });

  test('transitions state machine to STAGE_PLAN on triage action "plan"', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'plan'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.targetStage, STAGE_PLAN);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
  });

  test('transitions state machine to STAGE_DISCOVERY on triage action "discovery"', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'discovery'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.targetStage, STAGE_DISCOVERY);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
  });

  test('transitions state machine to STAGE_COMPLETED on triage action "dismiss"', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'dismiss'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.targetStage, STAGE_COMPLETED);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_COMPLETED);
  });

  test('getNextAction returns subagent for STAGE_TRIAGE prompting triage execution', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());
    const configRepo = {
      loadConfig: () => ({
        options: {},
        subagents: {}
      }),
      resolveModel: () => 'models/gemini-2.5-pro'
    };

    const getNext = new GetNextActionUseCase(stateRepo as any, configRepo as any);
    const action = await getNext.execute({ issue: 83 });

    assert.strictEqual(action.currentStage, STAGE_TRIAGE);
    assert.strictEqual(action.actionType, 'subagent');
    assert.ok(action.title.includes('Triage'));
    assert.ok(action.humanSummary.includes('Triage'));
  });

  test('enters STAGE_TRIAGE from STAGE_IMPLEMENT then transitions to target', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_PLAN);
    sm.transition('APPROVAL');
    sm.transition(STAGE_IMPLEMENT);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({ issue: 83, action: 'plan' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
  });

  test('throws when transition to STAGE_TRIAGE is not allowed', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_PLAN);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());
    const original = StateMachine.prototype.canTransition;
    StateMachine.prototype.canTransition = () => false;
    try {
      const useCase = new TriagePrCommentsUseCase(stateRepo as any);
      await assert.rejects(
        () => useCase.execute({ issue: 83, action: 'implement' }),
        /Cannot transition to TRIAGE from PLAN/
      );
    } finally {
      StateMachine.prototype.canTransition = original;
    }
  });

  test('formats PR comments and updates sm.triagePayload on execute', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'implement',
      comments: [
        { author: 'Alice', body: 'Please fix typo' },
        { author: 'Bob', body: 'Missing unit test' }
      ]
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(
      result.stateMachine.triagePayload,
      '- [Alice]: Please fix typo\n- [Bob]: Missing unit test'
    );
  });
});

describe('Issue #136 hardening', () => {
  const root = path.resolve(__dirname, '../..');
  const skill = fs.readFileSync(path.join(root, 'skills/agyloop/SKILL.md'), 'utf8');
  const planner = fs.readFileSync(path.join(root, 'prompts/planner.md'), 'utf8');

  test('planner prompt filters already-implemented work', () => {
    assert.ok(/filter out already implemented/i.test(planner));
  });

  test('SKILL.md forbids bypassing QUALITY_GATE/REVIEW via forced transitions', () => {
    assert.ok(skill.includes('bypass the `QUALITY_GATE` or `REVIEW`'));
  });

  test('SKILL.md has no deprecated gates/gate CLI references and uses next --json', () => {
    assert.ok(!/bin\/agyloop gates?\b/.test(skill));
    assert.ok(skill.includes('bin/agyloop next --json'));
  });

  test('SKILL.md documents transition target semantics', () => {
    assert.ok(skill.includes('<TARGET_STAGE>'));
    assert.ok(skill.includes('InvalidTransitionError'));
  });

  test('transition to the current stage throws InvalidTransitionError', () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_PLAN);
    assert.throws(() => sm.transition(STAGE_PLAN), (e: any) => e.name === 'InvalidTransitionError' || /InvalidTransition/.test(e.constructor.name));
  });

  test('triage with no action is read-only and does not change state', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_PLAN);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());
    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      comments: [{ author: 'r', body: 'hi', category: 'general' }]
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
    assert.strictEqual((await stateRepo.load()).currentStage, STAGE_PLAN);
  });

  test('triage dismiss -m replies to and resolves only threads of triaged comments', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());
    const replies: any[] = [];
    const resolved: string[] = [];
    const gateway = {
      listUnresolvedReviewThreads: async () => [
        { id: 'T1', commentIds: [101] },
        { id: 'T2', commentIds: [202, 203] },
        { id: 'T3', commentIds: [999] }
      ],
      replyToThread: async (id: string, body: string) => { replies.push([id, body]); },
      resolveReviewThread: async (id: string) => { resolved.push(id); }
    };
    const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: 5,
      action: 'dismiss',
      notes: 'Not applicable',
      comments: [
        { id: 101, author: 'r', body: 'x', category: 'general' },
        { id: 203, author: 'r', body: 'y', category: 'general' }
      ]
    });
    assert.strictEqual(result.stateMachine.currentStage, STAGE_COMPLETED);
    assert.deepStrictEqual(replies, [
      ['T1', inlineReplyBody('Not applicable')],
      ['T2', inlineReplyBody('Not applicable')]
    ]);
    assert.deepStrictEqual(resolved, ['T1', 'T2']);
  });

  test('thread handling failure emits a warning and the transition still succeeds', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());
    const gateway = {
      listUnresolvedReviewThreads: async () => [{ id: 'T1', commentIds: [101] }],
      replyToThread: async () => { throw new Error('boom-reply'); },
      resolveReviewThread: async () => {}
    };
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: any[]) => { warnings.push(a.join(' ')); };
    try {
      const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);
      const result = await useCase.execute({
        issue: 83,
        prNumber: 5,
        action: 'dismiss',
        notes: 'n',
        comments: [{ id: 101, author: 'r', body: 'x', category: 'general' }]
      });
      assert.strictEqual(result.stateMachine.currentStage, STAGE_COMPLETED);
    } finally {
      console.warn = origWarn;
    }
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('boom-reply'));
  });
});

/**
 * The dismissal route used to wrap the whole thread batch in ONE try/catch and
 * returned no outcome, so a single rejected thread aborted every remaining
 * thread and the CLI still printed an unqualified success line.
 */
describe('Triage dismissal outcome reporting (dismiss must report what it achieved)', () => {
  function dismissStateRepo() {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    return makeMockStateRepo(sm.toSnapshot());
  }

  function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: any[]) => { warnings.push(a.join(' ')); };
    return fn()
      .then((result) => ({ result, warnings }))
      .finally(() => { console.warn = origWarn; });
  }

  test('one rejected thread does not abort the remaining threads', async () => {
    const stateRepo = dismissStateRepo();
    const replies: any[] = [];
    const resolved: string[] = [];
    const gateway = {
      listUnresolvedReviewThreads: async () => [
        { id: 'T1', commentIds: [101] },
        { id: 'T2', commentIds: [202] },
        { id: 'T3', commentIds: [303] }
      ],
      replyToThread: async (id: string, body: string) => {
        if (id === 'T1') throw new Error('secondary rate limit');
        replies.push([id, body]);
      },
      resolveReviewThread: async (id: string) => { resolved.push(id); },
      replyToConversationComment: async () => {}
    };

    const { result, warnings } = await captureWarnings(async () => {
      const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);
      return useCase.execute({
        issue: 83,
        prNumber: 5,
        action: 'dismiss',
        notes: 'not applicable',
        comments: [
          { id: 101, surface: 'inline', author: 'r', body: 'x' },
          { id: 202, surface: 'inline', author: 'r', body: 'y' },
          { id: 303, surface: 'inline', author: 'r', body: 'z' }
        ]
      });
    });

    // The failed thread is skipped, the other two are still answered.
    assert.deepStrictEqual(replies, [
      ['T2', inlineReplyBody('not applicable')],
      ['T3', inlineReplyBody('not applicable')]
    ]);
    assert.deepStrictEqual(resolved, ['T2', 'T3']);
    assert.strictEqual(result.dismissal?.attempted, true);
    assert.strictEqual(result.dismissal?.threadsReplied, 2);
    assert.strictEqual(result.dismissal?.threadsResolved, 2);
    assert.strictEqual(result.dismissal?.failures.length, 1);
    assert.strictEqual(result.dismissal?.failures[0].scope, 'thread');
    assert.strictEqual(result.dismissal?.failures[0].target, 'T1');
    assert.ok(warnings.length === 1);
    assert.ok(warnings[0].includes('secondary rate limit'));
  });

  test('a thread that cannot be resolved is reported as failed, not as dismissed', async () => {
    const stateRepo = dismissStateRepo();
    const gateway = {
      listUnresolvedReviewThreads: async () => [{ id: 'T1', commentIds: [101] }],
      replyToThread: async () => {},
      resolveReviewThread: async () => { throw new Error('resolve rejected'); },
      replyToConversationComment: async () => {}
    };

    const { result } = await captureWarnings(async () => {
      const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);
      return useCase.execute({
        issue: 83,
        prNumber: 5,
        action: 'dismiss',
        notes: 'n',
        comments: [{ id: 101, surface: 'inline', author: 'r', body: 'x' }]
      });
    });

    assert.strictEqual(result.dismissal?.threadsReplied, 1);
    assert.strictEqual(result.dismissal?.threadsResolved, 0);
    assert.strictEqual(result.dismissal?.failures.length, 1);
    assert.ok(result.dismissal?.failures[0].error.includes('resolve rejected'));
  });

  test('dismiss answers PR conversation comments that have no inline counterpart', async () => {
    const stateRepo = dismissStateRepo();
    const conversationReplies: any[] = [];
    const gateway = {
      listUnresolvedReviewThreads: async () => [],
      replyToThread: async () => { throw new Error('no inline thread expected'); },
      resolveReviewThread: async () => { throw new Error('no inline thread expected'); },
      replyToConversationComment: async (prNumber: number, commentId: number, body: string) => {
        conversationReplies.push([prNumber, commentId, body]);
      }
    };

    const { result } = await captureWarnings(async () => {
      const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);
      return useCase.execute({
        issue: 83,
        prNumber: 5,
        action: 'dismiss',
        notes: 'not applicable',
        comments: [
          {
            id: 9001,
            surface: 'conversation',
            author: 'github-actions[bot]',
            body: '**Review feedback on `src/application/run-lifecycle.ts` (Line 178):**\n\nℹ️ **INFO**: nice work'
          }
        ]
      });
    });

    assert.strictEqual(conversationReplies.length, 1);
    assert.strictEqual(conversationReplies[0][0], 5);
    assert.strictEqual(conversationReplies[0][1], 9001);
    assert.ok(conversationReplies[0][2].includes('not applicable'));
    assert.strictEqual(result.dismissal?.conversationsReplied, 1);
    assert.deepStrictEqual(result.dismissal?.surfaces, ['PR conversation']);
  });

  test('dismiss does not answer the same feedback twice when it exists inline and as a conversation comment', async () => {
    const stateRepo = dismissStateRepo();
    const inlineBody = 'ℹ️ **INFO**: The `lastReviewVerdict` method scans the history backwards.\n\n*Powered by Critique AI (gemini-2.5-flash)*';
    const conversationBody = '**Review feedback on `src/application/get-next-action.ts` (Line 671):**\n\n' + inlineBody;
    const replies: any[] = [];
    const resolved: string[] = [];
    const conversationReplies: any[] = [];
    const gateway = {
      listUnresolvedReviewThreads: async () => [{ id: 'T1', commentIds: [500] }],
      replyToThread: async (id: string, body: string) => { replies.push([id, body]); },
      resolveReviewThread: async (id: string) => { resolved.push(id); },
      replyToConversationComment: async (prNumber: number, commentId: number, body: string) => {
        conversationReplies.push([prNumber, commentId, body]);
      }
    };

    const { result } = await captureWarnings(async () => {
      const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);
      return useCase.execute({
        issue: 83,
        prNumber: 5,
        action: 'dismiss',
        notes: 'not applicable',
        comments: [
          { id: 500, surface: 'inline', author: 'github-actions[bot]', body: inlineBody },
          { id: 9001, surface: 'conversation', author: 'github-actions[bot]', body: conversationBody }
        ]
      });
    });

    assert.deepStrictEqual(replies, [['T1', inlineReplyBody('not applicable')]]);
    assert.deepStrictEqual(resolved, ['T1']);
    assert.strictEqual(conversationReplies.length, 0, 'the same feedback must not be answered twice');
    assert.strictEqual(result.dismissal?.conversationsSkipped, 1);
    assert.strictEqual(result.dismissal?.conversationsReplied, 0);
  });

  test('dismiss does not answer the tool\'s own dismissal replies', async () => {
    const stateRepo = dismissStateRepo();
    const conversationReplies: any[] = [];
    const gateway = {
      listUnresolvedReviewThreads: async () => [],
      replyToThread: async () => {},
      resolveReviewThread: async () => {},
      replyToConversationComment: async (prNumber: number, commentId: number, body: string) => {
        conversationReplies.push([prNumber, commentId, body]);
      }
    };

    const { result } = await captureWarnings(async () => {
      const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);
      return useCase.execute({
        issue: 83,
        prNumber: 5,
        action: 'dismiss',
        notes: 'not applicable',
        comments: [
          {
            id: 9002,
            surface: 'conversation',
            author: 'ajxcodes',
            body: 'not applicable\n\nDismissing this PR conversation comment:\n> ℹ️ **INFO**: nice work'
          }
        ]
      });
    });

    assert.strictEqual(conversationReplies.length, 0);
    assert.strictEqual(result.dismissal?.conversationsIgnored, 1);
    assert.strictEqual(result.dismissal?.conversationsReplied, 0);
  });

  test('dismiss without notes reports that nothing was dismissed', async () => {
    const stateRepo = dismissStateRepo();
    const gateway = {
      listUnresolvedReviewThreads: async () => [],
      replyToThread: async () => {},
      resolveReviewThread: async () => {},
      replyToConversationComment: async () => {}
    };

    const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: 5,
      action: 'dismiss',
      comments: [{ id: 9001, surface: 'conversation', author: 'r', body: 'x' }]
    });

    assert.strictEqual(result.dismissal?.attempted, false);
    assert.ok(result.dismissal?.skippedReason);
    assert.strictEqual(result.dismissal?.failures.length, 0);
  });

  test('prFeedbackKey reduces the bot header and the attribution footer away', () => {
    const inlineBody = 'ℹ️ **INFO**: The `lastReviewVerdict` method scans the history backwards.\n\n*Powered by Critique AI (gemini-2.5-flash)*';
    const conversationBody = '**Review feedback on `src/application/get-next-action.ts` (Line 671):**\n\n' + inlineBody;

    assert.strictEqual(prFeedbackKey(conversationBody), prFeedbackKey(inlineBody));
    assert.notStrictEqual(prFeedbackKey(conversationBody), prFeedbackKey('ℹ️ **INFO**: another finding'));
  });
});

/**
 * The dismissal route has NO memory of its own between runs: the set of
 * answered inline comments was a local of `performDismissal`, so it died with
 * the process and every run re-answered everything on the PR. On PR #261 that
 * produced 51 replies to 53 conversation comments, 49 of them redundant.
 *
 * The route must therefore derive "already answered" from the PR's CURRENT
 * state, which survives the process:
 *
 * - an inline comment whose review thread carries the tool's DISMISSAL MARKER
 *   was answered by an earlier run;
 * - a conversation comment whose id another comment REFERENCES was answered by
 *   an earlier run.
 *
 * The thread's RESOLUTION state is NOT that proof: the review bot
 * auto-resolves the threads it creates, so on PR #261 34 of the 64 resolved
 * threads had never been answered by anyone — and they were skipped as if
 * they had.
 *
 * The fake PR below keeps that state between two runs: the replies the route
 * posts land on the PR (carrying the marker the route appends), and the
 * threads it resolves stay resolved.
 */
describe('Triage dismissal cross-run memory (issue #259)', () => {
  const {
    DISMISS_CONVERSATION_REPLY_REFERENCE
  } = require('../../dist/domain');

  const REPO = 'ajxcodes/agyloop';
  const PR = 261;

  interface FakeComment {
    id: number;
    surface: 'inline' | 'conversation';
    author: string;
    body: string;
    category: string;
    createdAt: string;
  }

  interface FakeThread {
    id: string;
    isResolved: boolean;
    commentIds: number[];
  }

  function makeFakePr(options: { comments: FakeComment[]; threads: FakeThread[] }) {
    const state = {
      comments: options.comments.map((c) => ({ ...c })),
      threads: options.threads.map((t) => ({ ...t })),
      threadReplies: [] as Array<[string, string]>,
      conversationReplies: [] as Array<[number, string]>,
      nextId: 99000
    };

    const gateway = {
      listReviewThreads: async () =>
        state.threads.map((t) => ({ ...t, commentIds: [...t.commentIds] })),
      // The subset a gateway that cannot report the resolved threads exposes.
      listUnresolvedReviewThreads: async () =>
        state.threads
          .filter((t) => !t.isResolved)
          .map((t) => ({ ...t, commentIds: [...t.commentIds] })),
      replyToThread: async (id: string, body: string) => {
        state.threadReplies.push([id, body]);
        // GitHub keeps the reply ON the PR: it comes back on the next run as
        // an inline comment of the thread. That reply — and the marker it
        // carries — is the cross-run memory of the inline surface.
        const thread = state.threads.find((t) => t.id === id);
        const replyId = state.nextId++;
        state.comments.push({
          id: replyId,
          surface: 'inline',
          author: 'ajxcodes',
          body,
          category: 'general',
          createdAt: '2026-10-20T19:00:00Z'
        });
        if (thread) {
          thread.commentIds.push(replyId);
        }
      },
      resolveReviewThread: async (id: string) => {
        const thread = state.threads.find((t) => t.id === id);
        if (thread) {
          thread.isResolved = true;
        }
      },
      replyToConversationComment: async (_prNumber: number, commentId: number, body: string) => {
        state.conversationReplies.push([commentId, body]);
        // The infrastructure appends the id-bearing reference; the PR keeps
        // it, exactly as GitHub would.
        const permalink = `https://github.com/${REPO}/pull/${PR}#issuecomment-${commentId}`;
        state.comments.push({
          id: state.nextId++,
          surface: 'conversation',
          author: 'ajxcodes',
          body: `${body}\n\n${DISMISS_CONVERSATION_REPLY_REFERENCE.replace('{permalink}', permalink)}`,
          category: 'general',
          createdAt: '2026-10-20T18:00:00Z'
        });
      }
    };

    return { state, gateway };
  }

  function dismissStateRepo() {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    return makeMockStateRepo(sm.toSnapshot());
  }

  test('a second dismiss run over the same PR state replies to nothing', async () => {
    const { state, gateway } = makeFakePr({
      threads: [
        { id: 'T1', isResolved: false, commentIds: [101] },
        { id: 'T2', isResolved: false, commentIds: [202] }
      ],
      comments: [
        {
          id: 101,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: 'ℹ️ **INFO**: the inline finding',
          category: 'info',
          createdAt: '2026-10-20T14:58:03Z'
        },
        {
          id: 202,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: '💡 **SUGGESTION**: the other inline finding',
          category: 'suggestion',
          createdAt: '2026-10-20T14:58:04Z'
        },
        {
          id: 9001,
          surface: 'conversation',
          author: 'github-actions[bot]',
          body: '**Review feedback on `src/a.ts` (Line 1):**\n\nℹ️ **INFO**: the conversation finding',
          category: 'info',
          createdAt: '2026-10-20T14:58:05Z'
        },
        {
          id: 9002,
          surface: 'conversation',
          author: 'ajxcodes',
          body: 'please rebase and double check the tests',
          category: 'general',
          createdAt: '2026-10-20T14:58:06Z'
        }
      ]
    });

    const stateRepo = dismissStateRepo();
    const useCase = new TriagePrCommentsUseCase(stateRepo as any, gateway as any);

    const first = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(first.dismissal?.threadsReplied, 2, 'the first run answers the open threads');
    assert.strictEqual(first.dismissal?.threadsResolved, 2);
    assert.strictEqual(first.dismissal?.conversationsReplied, 2, 'the first run answers the feedback');
    assert.ok(
      state.conversationReplies.some(([id]) => id === 9002),
      'a human comment must never be swallowed'
    );

    // --- the second run over the SAME PR state ------------------------------
    const second = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(second.dismissal?.attempted, true);
    const secondReplies =
      (second.dismissal?.threadsReplied ?? 0) + (second.dismissal?.conversationsReplied ?? 0);
    assert.strictEqual(secondReplies, 0, 'the second run must reply to nothing');
    assert.strictEqual(second.dismissal?.threadsReplied, 0, 'the second run must reply to no thread');
    assert.strictEqual(second.dismissal?.threadsResolved, 0, 'a resolved thread must not be resolved again');
    assert.strictEqual(second.dismissal?.threadsSkipped, 2, 'the resolved threads must be reported as skipped');
    assert.strictEqual(second.dismissal?.conversationsReplied, 0, 'the second run must answer nothing');
    assert.strictEqual(
      second.dismissal?.conversationsSkipped,
      2,
      'the already-answered comments must be counted as SKIPPED'
    );
    assert.strictEqual(second.dismissal?.conversationsAlreadyAnswered, 2);
    assert.strictEqual(
      second.dismissal?.conversationsIgnored,
      2,
      "the tool's own replies must be ignored, not answered"
    );

    assert.strictEqual(state.threadReplies.length, 2, 'no thread may be replied to twice');
    assert.strictEqual(state.conversationReplies.length, 2, 'no comment may be answered twice');
  });

  /**
   * A RESOLVED thread is NOT proof that the feedback was answered: the
   * review bot auto-resolves the threads it creates (on PR #261, 34 of the 64
   * resolved threads had never been answered by anyone). A resolved thread
   * without the tool's dismissal marker is therefore UNANSWERED: it is
   * replied to, and it is not resolved again — it is already closed.
   */
  test('a resolved thread without a dismissal reply is answered, not skipped', async () => {
    const { state, gateway } = makeFakePr({
      threads: [{ id: 'T1', isResolved: true, commentIds: [101] }],
      comments: [
        {
          id: 101,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: 'ℹ️ **INFO**: the inline finding',
          category: 'info',
          createdAt: '2026-10-20T14:58:03Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(result.dismissal?.threadsReplied, 1, 'the unanswered thread must be replied to');
    assert.strictEqual(result.dismissal?.threadsSkipped, 0, 'it must not be counted as skipped');
    assert.strictEqual(
      result.dismissal?.threadsResolved,
      0,
      'an already-resolved thread must not be resolved again'
    );
    assert.strictEqual(state.threadReplies.length, 1, 'the thread must be replied to');
    assert.ok(
      state.threadReplies[0][1].includes(DISMISS_INLINE_REPLY_MARKER),
      'the reply must carry the tool\'s marker'
    );
  });

  /**
   * The cross-run memory still works when the tool's marker is in the thread:
   * a thread that carries a dismissal reply was answered, whatever its
   * resolution state says.
   */
  test('a resolved thread that carries the tool\'s dismissal marker is skipped, not answered again', async () => {
    const { state, gateway } = makeFakePr({
      threads: [{ id: 'T1', isResolved: true, commentIds: [101, 900] }],
      comments: [
        {
          id: 101,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: 'ℹ️ **INFO**: the inline finding',
          category: 'info',
          createdAt: '2026-10-20T14:58:03Z'
        },
        {
          id: 900,
          surface: 'inline',
          author: 'ajxcodes',
          body: inlineReplyBody('not applicable'),
          category: 'general',
          createdAt: '2026-10-20T19:00:00Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(result.dismissal?.threadsReplied, 0, 'an answered thread must not be replied to');
    assert.strictEqual(result.dismissal?.threadsSkipped, 1, 'an answered thread must be reported as skipped');
    assert.strictEqual(result.dismissal?.threadsResolved, 0);
    assert.strictEqual(state.threadReplies.length, 0, 'an answered thread must not be replied to');
  });

  test('an unresolved thread that carries the tool\'s dismissal marker is not answered twice', async () => {
    const { state, gateway } = makeFakePr({
      threads: [{ id: 'T1', isResolved: false, commentIds: [101, 900] }],
      comments: [
        {
          id: 101,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: 'ℹ️ **INFO**: the inline finding',
          category: 'info',
          createdAt: '2026-10-20T14:58:03Z'
        },
        {
          id: 900,
          surface: 'inline',
          author: 'ajxcodes',
          body: inlineReplyBody('not applicable'),
          category: 'general',
          createdAt: '2026-10-20T19:00:00Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(result.dismissal?.threadsReplied, 0, 'an answered thread must not be replied to');
    assert.strictEqual(result.dismissal?.threadsSkipped, 1, 'an answered thread must be reported as skipped');
    assert.strictEqual(state.threadReplies.length, 0, 'an answered thread must not be replied to');
  });

  /**
   * The tool posts as the same account as the human operator, so its own
   * replies are recognisable ONLY by their marker. They are evidence, not
   * feedback: they are never answered, and they never create a feedback key.
   */
  test('the tool\'s own dismissal reply is never answered as feedback', async () => {
    const ownReply = inlineReplyBody('not applicable');
    const { state, gateway } = makeFakePr({
      threads: [{ id: 'T1', isResolved: false, commentIds: [900] }],
      comments: [
        {
          id: 900,
          surface: 'inline',
          author: 'ajxcodes',
          body: ownReply,
          category: 'general',
          createdAt: '2026-10-20T19:00:00Z'
        },
        {
          id: 9001,
          surface: 'conversation',
          author: 'ajxcodes',
          body: ownReply,
          category: 'general',
          createdAt: '2026-10-20T19:00:00Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(result.dismissal?.threadsReplied, 0, 'the tool must not answer its own reply');
    assert.strictEqual(result.dismissal?.threadsSkipped, 1, 'the thread it already answered is skipped');
    assert.strictEqual(state.threadReplies.length, 0, 'the tool must not answer its own reply');
    assert.strictEqual(
      result.dismissal?.conversationsAlreadyAnswered,
      0,
      "the tool's own reply must not create a feedback key"
    );
    assert.strictEqual(
      result.dismissal?.conversationsSkipped,
      0,
      "the tool's own reply must not silence the conversation surface"
    );
  });

  /**
   * The 30 replies the tool already posted on PR #261 carry its historic
   * signature and nothing else — the marker did not exist yet. They must keep
   * being read as answers, or those threads would be answered a second time.
   */
  test('a thread answered by the tool\'s historic signature is recognised as answered', async () => {
    const { state, gateway } = makeFakePr({
      threads: [{ id: 'T1', isResolved: true, commentIds: [101, 900] }],
      comments: [
        {
          id: 101,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: 'ℹ️ **INFO**: the inline finding',
          category: 'info',
          createdAt: '2026-10-20T14:58:03Z'
        },
        {
          id: 900,
          surface: 'inline',
          author: 'ajxcodes',
          body: `Reviewed — the finding is correct.\n\n${DISMISS_INLINE_REPLY_SIGNATURE} (issue #259)`,
          category: 'general',
          createdAt: '2026-10-20T19:11:03Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(result.dismissal?.threadsReplied, 0, 'the historic answer must not be repeated');
    assert.strictEqual(result.dismissal?.threadsSkipped, 1, 'the historic answer must be read as an answer');
    assert.strictEqual(state.threadReplies.length, 0, 'the historic answer must not be repeated');
  });

  /**
   * The state PR #261 was left in: the review bot resolved 34 threads nobody
   * ever answered, and the tool answered 30 others itself. The 34 must be
   * answered; the 30 must be left alone.
   */
  test('PR #261\'s state: the threads nobody answered are answered, the ones the tool answered are skipped', async () => {
    const { state, gateway } = makeFakePr({
      threads: [
        // Resolved by the review bot, never answered.
        { id: 'T-unanswered', isResolved: true, commentIds: [101] },
        // Answered by the tool itself, with its historic signature.
        { id: 'T-answered', isResolved: true, commentIds: [202, 900] }
      ],
      comments: [
        {
          id: 101,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: '💡 **SUGGESTION**: the suggestion nobody answered',
          category: 'suggestion',
          createdAt: '2026-10-20T18:08:42Z'
        },
        {
          id: 202,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: 'ℹ️ **INFO**: the finding the tool answered',
          category: 'info',
          createdAt: '2026-10-20T18:08:41Z'
        },
        {
          id: 900,
          surface: 'inline',
          author: 'ajxcodes',
          body: `Reviewed — the finding is correct.\n\n${DISMISS_INLINE_REPLY_SIGNATURE} (issue #259)`,
          category: 'general',
          createdAt: '2026-10-20T19:11:03Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(result.dismissal?.threadsReplied, 1, 'the thread nobody answered must be answered');
    assert.strictEqual(result.dismissal?.threadsSkipped, 1, 'the thread the tool answered must be skipped');
    assert.strictEqual(
      result.dismissal?.threadsResolved,
      0,
      'a thread that is already closed must not be resolved again'
    );
    assert.deepStrictEqual(
      state.threadReplies.map(([id]) => id),
      ['T-unanswered'],
      'only the thread nobody answered may be replied to'
    );
  });

  test('a conversation comment whose feedback was answered inline in an earlier run is already answered', async () => {
    const inlineBody = 'ℹ️ **INFO**: The `lastReviewVerdict` method scans the history backwards.';
    const { state, gateway } = makeFakePr({
      threads: [{ id: 'T1', isResolved: true, commentIds: [500, 501] }],
      comments: [
        {
          id: 500,
          surface: 'inline',
          author: 'github-actions[bot]',
          body: inlineBody,
          category: 'info',
          createdAt: '2026-10-20T14:58:03Z'
        },
        {
          // The reply an earlier run posted on the thread: the marker it
          // carries is what proves the feedback was answered.
          id: 501,
          surface: 'inline',
          author: 'ajxcodes',
          body: inlineReplyBody('not applicable'),
          category: 'general',
          createdAt: '2026-10-20T19:00:00Z'
        },
        {
          id: 9001,
          surface: 'conversation',
          author: 'github-actions[bot]',
          body: '**Review feedback on `src/a.ts` (Line 1):**\n\n' + inlineBody,
          category: 'info',
          createdAt: '2026-10-20T14:58:04Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(result.dismissal?.conversationsReplied, 0, 'the same feedback must not be answered twice');
    assert.strictEqual(result.dismissal?.conversationsAlreadyAnswered, 1);
    assert.strictEqual(state.conversationReplies.length, 0);
  });

  /**
   * The 24 replies of the pre-`b36de99` build on PR #261 carry neither the
   * tool's footer nor its reference: no rule can prove they were tool answers.
   * They are therefore treated as prior answers — answering them again would
   * be a THIRD reply to the same feedback — but only when they predate the
   * newest dismissal answer, so a human comment posted afterwards is still
   * answered.
   */
  test('an unmarked prior answer is not answered again, but a comment posted after it is', async () => {
    const { state, gateway } = makeFakePr({
      threads: [],
      comments: [
        {
          id: 9101,
          surface: 'conversation',
          author: 'ajxcodes',
          body:
            'not applicable\n\nDismissing this PR conversation comment:\n> ℹ️ **INFO**: the finding\n\n' +
            DISMISS_CONVERSATION_REPLY_REFERENCE.replace(
              '{permalink}',
              `https://github.com/${REPO}/pull/${PR}#issuecomment-9001`
            ),
          category: 'general',
          createdAt: '2026-10-20T17:02:37Z'
        },
        {
          id: 9100,
          surface: 'conversation',
          author: 'ajxcodes',
          body:
            'Reviewed — the backward scan of the history is exactly what keeps the COMMIT gate description current.\n\nConfirmed as intended; no change required.',
          category: 'general',
          createdAt: '2026-10-20T15:27:27Z'
        },
        {
          id: 9200,
          surface: 'conversation',
          author: 'ajxcodes',
          body: 'please rebase onto main',
          category: 'general',
          createdAt: '2026-10-20T18:30:00Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(
      result.dismissal?.conversationsPriorAnswers,
      1,
      'the legacy answer must not be answered a third time'
    );
    assert.strictEqual(
      result.dismissal?.conversationsReplied,
      1,
      'a comment posted after the newest dismissal answer is new feedback'
    );
    assert.deepStrictEqual(
      state.conversationReplies.map(([id]) => id),
      [9200],
      'only the new comment may be answered'
    );
    assert.strictEqual(result.dismissal?.conversationsIgnored, 1, "the tool's own reply is ignored");
  });

  test('on a PR the tool has never dismissed, every comment is answered', async () => {
    const { state, gateway } = makeFakePr({
      threads: [],
      comments: [
        {
          id: 9001,
          surface: 'conversation',
          author: 'github-actions[bot]',
          body: '**Review feedback on `src/a.ts` (Line 1):**\n\nℹ️ **INFO**: the finding',
          category: 'info',
          createdAt: '2026-10-20T14:58:05Z'
        },
        {
          id: 9002,
          surface: 'conversation',
          author: 'ajxcodes',
          body: 'please rebase and double check the tests',
          category: 'general',
          createdAt: '2026-10-20T14:58:06Z'
        }
      ]
    });

    const useCase = new TriagePrCommentsUseCase(dismissStateRepo() as any, gateway as any);
    const result = await useCase.execute({
      issue: 83,
      prNumber: PR,
      action: 'dismiss',
      notes: 'not applicable',
      comments: state.comments
    });

    assert.strictEqual(result.dismissal?.conversationsReplied, 2);
    assert.strictEqual(result.dismissal?.conversationsPriorAnswers, 0);
  });
});

/**
 * Issue #269 (Defect 1): the recorded TRIAGE DISPOSITION.
 *
 * The disposition is what turns the TRIAGE livelock into a one-shot gate: the
 * detector consults it before routing, so without it `codeloop next` re-routes
 * the very same feedback forever.
 */
describe('TriagePrCommentsUseCase disposition recording (issue #269)', () => {
  const PR = 7;

  const ACTIONABLE_COMMENT = {
    id: 101,
    surface: 'conversation',
    author: 'reviewer',
    body: 'Please fix the nil dereference in resolve-subagent.ts',
    category: 'error',
    createdAt: '2026-10-21T11:00:00Z'
  };

  const SUMMARY_COMMENT = {
    id: 102,
    surface: 'conversation',
    author: 'github-actions[bot]',
    body: '## Critique AI Review Run Summary\n\nNo findings.',
    category: 'general',
    createdAt: '2026-10-21T11:30:00Z'
  };

  test('TP1: `triage completed` records a disposition for the PR', async () => {
    const sm = StateMachine.createInitial({ issue: 900 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 900,
      prNumber: PR,
      action: 'completed',
      comments: [ACTIONABLE_COMMENT]
    });

    assert.strictEqual(result.dispositionRecorded, true);
    assert.ok(result.disposition, 'the result must carry the disposition');
    assert.strictEqual(result.disposition!.prNumber, PR);
    assert.strictEqual(result.disposition!.action, 'completed');
    assert.deepStrictEqual([...result.disposition!.feedbackKeys], ['id:101']);
    assert.ok(result.disposition!.recordedAt, 'the disposition must be timestamped');
  });

  test('TP2: `triage implement` records a disposition too', async () => {
    const sm = StateMachine.createInitial({ issue: 900 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 900,
      prNumber: PR,
      action: 'implement',
      comments: [ACTIONABLE_COMMENT]
    });

    assert.strictEqual(result.dispositionRecorded, true);
    assert.strictEqual(result.disposition!.action, 'implement');
    assert.strictEqual(result.disposition!.prNumber, PR);
  });

  test('TP3: when no PR feedback could be read, NO disposition is recorded', async () => {
    const sm = StateMachine.createInitial({ issue: 900 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 900,
      prNumber: PR,
      action: 'completed',
      comments: []
    });

    assert.strictEqual(result.dispositionRecorded, false);
    assert.strictEqual(result.disposition, null);
    // The checkpoint must NOT carry a disposition either: an empty key set must
    // never masquerade as "everything was dispositioned".
    const saved: any = await stateRepo.load();
    assert.strictEqual(saved.triageDisposition, null);
  });

  test('TP4: the disposition is persisted in the snapshot', async () => {
    const sm = StateMachine.createInitial({ issue: 900 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    await useCase.execute({
      issue: 900,
      prNumber: PR,
      action: 'completed',
      comments: [ACTIONABLE_COMMENT, SUMMARY_COMMENT]
    });

    const saved: any = await stateRepo.load();
    assert.ok(saved.triageDisposition, 'the snapshot must carry the disposition');
    assert.strictEqual(saved.triageDisposition.prNumber, PR);
    assert.strictEqual(saved.triageDisposition.action, 'completed');
    // The repository's own automated summary is NOT feedback, so it is not a
    // dispositioned feedback key.
    assert.deepStrictEqual([...saved.triageDisposition.feedbackKeys], ['id:101']);

    // The history records THAT a disposition was taken.
    const last = saved.history[saved.history.length - 1];
    assert.strictEqual(last.metadata.triageDisposition, true);
    assert.ok(
      last.metadata.dispositionNote.includes('Triage disposition recorded: completed'),
      `the history note must name the disposition, got: ${JSON.stringify(last.metadata.dispositionNote)}`
    );
    assert.ok(last.metadata.dispositionNote.includes('PR #7'));
    assert.ok(last.metadata.dispositionNote.includes('1 feedback item(s)'));
  });
});
