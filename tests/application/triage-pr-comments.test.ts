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
  RunLifecycleUseCase
} = require('../../dist/application');
const {
  STAGE_TRIAGE,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  STAGE_DISCOVERY,
  STAGE_COMPLETED,
  STAGE_INITIALIZED,
  GATE_TRIAGE,
  StateMachine
} = require('../../dist/domain');

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
    assert.deepStrictEqual(replies, [['T1', 'Not applicable'], ['T2', 'Not applicable']]);
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
