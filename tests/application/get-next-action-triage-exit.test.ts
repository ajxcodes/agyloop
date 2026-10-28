/**
 * agyloop - TRIAGE gate exit on a terminal PR (issue #351, AC-1/AC-2)
 *
 * `NOTE_TRIAGE_GATE_EXIT_CONDITION` promises TWO endings — a recorded
 * disposition, or the PR being merged/closed — but only the first was
 * implemented: `case STAGE_TRIAGE` built the triage directive without ever
 * reading the PR, so the #349 timeline merged PR #350 and `codeloop next` still
 * demanded `resume` + `triage`.
 *
 * T1 - a MERGED PR exits the gate to COMPLETED (the AC-2 regression test)
 * T2 - a CLOSED PR exits the same way
 * T3 - an OPEN PR still dispatches the triage subagent (the gate is not weakened)
 * T4 - fail closed: no gateway keeps the gate
 * T5 - fail closed: a throwing gateway keeps the gate
 * T6 - `--dry-run` predicts the exit and writes nothing
 * T7 - the idle report says WHY the gate ended (AC-1 legibility)
 * T8 - the directive's own exit-condition text matches the behaviour
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { GetNextActionUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_TRIAGE,
  STAGE_COMPLETED,
  GATE_TRIAGE,
  NOTE_TRIAGE_GATE_EXIT_CONDITION,
  NOTE_IDLE_SUMMARY,
  TRIAGE_EXIT_PULL_REQUEST_TERMINAL
} = require('../../dist/domain');

import type { StateRepository, ConfigRepository, AgyLoopConfig } from '../../src/ports';
import type { StateMachineSnapshot } from '../../src/domain';

class MockStateRepo implements StateRepository {
  public savedSnapshot: StateMachineSnapshot | null = null;
  public saveCalls = 0;

  constructor(initial: StateMachineSnapshot | null = null) {
    this.savedSnapshot = initial;
  }

  public async load(): Promise<StateMachineSnapshot | null> {
    return this.savedSnapshot;
  }

  public async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.saveCalls += 1;
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

/** A checkpoint parked at the TRIAGE gate for issue #900 — the #349 shape. */
function seedTriage(overrides: Record<string, unknown> = {}): StateMachineSnapshot {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    currentStage: STAGE_TRIAGE,
    mode: 'standard',
    issue: 900,
    baseBranch: 'main',
    triagePayload: '- [reviewer]: fix the nil dereference',
    createdAt: now,
    updatedAt: now,
    history: [{ stage: STAGE_TRIAGE, timestamp: now }],
    pausedAtGate: GATE_TRIAGE,
    pausedAtTimestamp: now,
    totalHumanWaitMs: 0,
    ...overrides
  } as unknown as StateMachineSnapshot;
}

const ACTIONABLE_COMMENT = {
  id: 101,
  author: 'reviewer',
  body: 'Please fix the nil dereference in resolve-subagent.ts',
  created_at: '2026-10-28T00:00:00Z'
};

/** A gateway whose PR #7 is in the given terminal/open state. */
function gatewayWithPr(state: 'OPEN' | 'MERGED' | 'CLOSED', merged = state === 'MERGED'): any {
  return {
    getCurrentRepo: () => 'owner/repo',
    fetchIssue: async () => null,
    findPullRequest: async () => ({
      number: 7,
      title: 'Task #900',
      body: 'Closes #900',
      state,
      baseRefName: 'main',
      headRefName: 'task/900',
      url: 'https://example.test/pull/7',
      merged,
      labels: []
    }),
    fetchPullRequestComments: async () => [ACTIONABLE_COMMENT]
  };
}

function assertTerminalExit(result: any, saved: StateMachineSnapshot | null, state: 'MERGED' | 'CLOSED') {
  assert.strictEqual(result.currentStage, STAGE_COMPLETED);
  assert.strictEqual(result.actionType, 'completed');
  assert.strictEqual(result.role, undefined, 'a completed directive names no role');
  assert.ok(!result.invocationPayload, 'a completed directive carries no dispatch payload');
  assert.ok(
    !String(result.description).includes('Invoke Triage'),
    `the description must not be a triage directive: ${result.description}`
  );

  assert.ok(saved, 'the exit must be persisted');
  assert.strictEqual(saved!.currentStage, STAGE_COMPLETED);
  assert.strictEqual(saved!.pausedAtGate, null, 'COMPLETED consumes the TRIAGE pause');
  assert.strictEqual(saved!.triagePayload, null, 'the stale payload is cleared');

  const last = saved!.history[saved!.history.length - 1];
  assert.strictEqual(last.metadata?.triageExit, TRIAGE_EXIT_PULL_REQUEST_TERMINAL);
  assert.strictEqual(last.metadata?.prState, state);
  assert.strictEqual(last.metadata?.prNumber, 7);
}

describe('TRIAGE gate exits when the PR is terminal (issue #351)', () => {
  test('T1: a MERGED PR exits to COMPLETED without a triage action', async () => {
    const stateRepo = new MockStateRepo(seedTriage());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithPr('MERGED')
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assertTerminalExit(result, await stateRepo.load(), 'MERGED');
  });

  test('T2: a CLOSED PR exits the same way', async () => {
    const stateRepo = new MockStateRepo(seedTriage());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithPr('CLOSED')
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assertTerminalExit(result, await stateRepo.load(), 'CLOSED');
  });

  test('T3: an OPEN PR still dispatches the triage subagent', async () => {
    const stateRepo = new MockStateRepo(seedTriage());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithPr('OPEN')
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'triage');
    assert.strictEqual(result.invocationPayload.Subagents[0].Role, 'Triage Subagent');

    const saved = await stateRepo.load();
    assert.strictEqual(saved!.currentStage, STAGE_TRIAGE, 'the checkpoint stays at the gate');
    assert.strictEqual(saved!.pausedAtGate, GATE_TRIAGE, 'the pause is intact');
  });

  test('T4: fail closed — no gateway keeps the gate', async () => {
    const stateRepo = new MockStateRepo(seedTriage());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    assert.strictEqual(result.role, 'triage');
    const saved = await stateRepo.load();
    assert.strictEqual(saved!.currentStage, STAGE_TRIAGE);
    assert.strictEqual(saved!.pausedAtGate, GATE_TRIAGE);
  });

  test('T5: fail closed — a throwing gateway keeps the gate', async () => {
    const stateRepo = new MockStateRepo(seedTriage());
    const gateway = {
      getCurrentRepo: () => 'owner/repo',
      fetchIssue: async () => null,
      findPullRequest: async () => {
        throw new Error('gh: not authenticated');
      }
    } as any;
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), undefined, gateway);

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    assert.strictEqual(result.role, 'triage');
    const saved = await stateRepo.load();
    assert.strictEqual(saved!.currentStage, STAGE_TRIAGE);
    assert.strictEqual(saved!.pausedAtGate, GATE_TRIAGE);
  });

  test('T6: `--dry-run` predicts the exit and writes nothing', async () => {
    const stateRepo = new MockStateRepo(seedTriage());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithPr('MERGED')
    );

    const result = await useCase.execute({ workspaceDir: '/repo', dryRun: true });

    assert.strictEqual(result.currentStage, STAGE_COMPLETED);
    assert.strictEqual(result.actionType, 'completed');
    assert.strictEqual(result.dryRun, true);
    assert.ok(
      result.wouldWrite.some((entry: string) => /COMPLETED \(triage PR MERGED\)/.test(entry)),
      `the suppressed write must be declared, got: ${JSON.stringify(result.wouldWrite)}`
    );
    assert.strictEqual(stateRepo.saveCalls, 0, '--dry-run must never persist');
    assert.strictEqual(stateRepo.savedSnapshot!.currentStage, STAGE_TRIAGE);
  });

  test('T7: the idle report says WHY the gate ended', async () => {
    const stateRepo = new MockStateRepo(seedTriage());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithPr('MERGED')
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.ok(
      result.humanSummary.includes('Triage gate ended: PR #7 is MERGED.'),
      `the idle report must name the exit, got: ${result.humanSummary}`
    );
    assert.ok(
      result.humanSummary.includes(NOTE_IDLE_SUMMARY),
      'the idle summary is preserved'
    );
  });

  test('T8: the stated exit condition matches the implemented one', async () => {
    const stateRepo = new MockStateRepo(seedTriage());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      gatewayWithPr('OPEN')
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.ok(result.description.includes(NOTE_TRIAGE_GATE_EXIT_CONDITION));
    assert.ok(/merged\/closed/.test(NOTE_TRIAGE_GATE_EXIT_CONDITION));
    assert.ok(NOTE_TRIAGE_GATE_EXIT_CONDITION.includes('codeloop next'));
  });
});
