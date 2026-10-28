/**
 * agyloop - IMPLEMENT boundary contract tests (issue #327, Defect 4 / #330)
 *
 * The defect: `next` at IMPLEMENT returned a byte-identical implementer
 * directive whether the worktree was untouched or already carried the whole
 * implementation, named no advancing command, and recorded no re-dispatch.
 *
 * IB1 - a clean worktree names the command + the completion condition, state absent
 * IB2 - a non-empty diff flips the condition to present and says "do not re-dispatch"
 * IB3 - an unreadable tree is UNVERIFIED and records NO dispatch
 * IB4 - consecutive reads persist 1/2/3 and never advance the stage
 * IB5 - a paused read records 0
 * IB6 - `--dry-run` declares the counter write and persists nothing
 * IB7 - the APPROVAL/YOLO directive is unchanged and uncounted
 * IB8 - the probe receives the task worktree and the descriptor's base branch
 * IB9 - every transition named at IMPLEMENT is legal there
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { GetNextActionUseCase } = require('../../dist/application');
const {
  StateMachine,
  WorktreeDescriptor,
  ALLOWED_TRANSITIONS,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  MODE_STANDARD,
  MODE_YOLO,
  NOTE_IMPLEMENT_ADVANCE_CONDITION,
  NOTE_IMPLEMENT_PRESENT,
  NOTE_IMPLEMENT_ABSENT,
  NOTE_IMPLEMENT_UNVERIFIED,
  formatImplementAdvanceCommand
} = require('../../dist/domain');

const ISSUE = 41;
const WORKTREE = '/repo/.worktrees/41';
const ADVANCE = `codeloop transition QUALITY_GATE --issue ${ISSUE}`;

const PLAN_CONTENT = [
  '# [Implementation] - probe',
  '',
  '## 3. Implementation Steps',
  '- [ ] Step 1: do the probe'
].join('\n');

import type { StateRepository } from '../../src/ports';
import type { StateMachineSnapshot } from '../../src/domain';

class MockStateRepo implements StateRepository {
  public savedSnapshot: StateMachineSnapshot | null;
  public saveCallCount = 0;

  constructor(initial: StateMachineSnapshot | null) {
    this.savedSnapshot = initial;
  }

  async load(): Promise<StateMachineSnapshot | null> {
    return this.savedSnapshot;
  }

  async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.saveCallCount += 1;
    this.savedSnapshot = snapshot;
  }

  async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  getStateFilePath(): string {
    return '/repo/.agyloop/state.json';
  }
}

class MockConfigRepo {
  public config: any;

  constructor() {
    this.config = {
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
  }

  loadConfig(): any {
    return this.config;
  }

  resolveModel(role: string): any {
    const configured = this.config.models[role] || 'inherit';
    return { role, configured, tier: 'inherit', apiModel: 'inherit' };
  }

  mapModelToTier(inputModel: string): any {
    if (inputModel.includes('pro')) return 'pro';
    if (inputModel.includes('flash_lite')) return 'flash_lite';
    if (inputModel.includes('flash')) return 'flash';
    return 'inherit';
  }
}

class MockPlanGenerator {
  resolvePlanFile(): any {
    return {
      planDir: '/repo/artifacts/plans/41-task',
      planPath: '/repo/artifacts/plans/41-task/implementation_plan.md',
      planFileName: 'implementation_plan.md'
    };
  }

  readPlanDocument(): string {
    return PLAN_CONTENT;
  }

  hashPlanDocument(): string {
    return 'digest-1';
  }

  findPlanDirectory(): string {
    return '/repo/artifacts/plans/41-task';
  }

  updateSummaryLog(): boolean {
    return true;
  }
}

const CLEAN_DIFF: any = {
  hasChanges: false,
  baseRef: 'main',
  trackedChangedFiles: [],
  untrackedFiles: [],
  probeError: null,
  measurementError: null,
  rawStatus: ''
};

const PRESENT_DIFF: any = {
  ...CLEAN_DIFF,
  hasChanges: true,
  trackedChangedFiles: ['src/probe.ts']
};

const UNREADABLE_DIFF: any = {
  ...CLEAN_DIFF,
  probeError: 'git status --porcelain exited with code 128',
  rawStatus: ''
};

const UNMEASURABLE_CLEAN_DIFF: any = {
  ...CLEAN_DIFF,
  measurementError: 'git merge-base HEAD main could not resolve the branch point'
};

class FakeProbe {
  public result: any;
  public calls: any[] = [];
  public throwOnExecute = false;

  constructor(result: any = CLEAN_DIFF) {
    this.result = result;
  }

  async execute(params: any = {}): Promise<any> {
    this.calls.push(params);
    if (this.throwOnExecute) {
      throw new Error('probe exploded');
    }
    return this.result;
  }
}

function machineAtImplement(options: any = {}) {
  const sm = StateMachine.createInitial({
    issue: ISSUE,
    mode: options.mode || MODE_STANDARD,
    baseBranch: 'main'
  });
  sm.setPlanDir('/repo/artifacts/plans/41-task');
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  if ((options.mode || MODE_STANDARD) === MODE_YOLO) {
    sm.transition(STAGE_IMPLEMENT);
  } else {
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
  }
  sm.setWorktree(
    WorktreeDescriptor.create({
      taskId: ISSUE,
      worktreePath: WORKTREE,
      branch: 'task/41-work',
      baseBranch: 'phase/6-boundary',
      createdAt: new Date().toISOString()
    })
  );
  if (options.pausedAtGate) {
    sm.pauseAtGate(options.pausedAtGate);
  }
  return sm;
}

function useCaseFor(snapshot: any, probe: any) {
  const stateRepo = new MockStateRepo(snapshot);
  const useCase = new GetNextActionUseCase(
    stateRepo,
    new MockConfigRepo(),
    new MockPlanGenerator(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    probe
  );
  return { stateRepo, useCase };
}

async function readNext(snapshot: any, probe: any, params: any = {}) {
  const { stateRepo, useCase } = useCaseFor(snapshot, probe);
  const result = await useCase.execute({ workspaceDir: '/repo', ...params });
  return { result, stateRepo };
}

describe('IMPLEMENT directive names the completing command and the condition (#327 AC-8/AC-11)', () => {
  test('IB1: a clean worktree names the advancing command, the condition and the absent state', async () => {
    const sm = machineAtImplement();
    const probe = new FakeProbe(CLEAN_DIFF);

    const { result, stateRepo } = await readNext(sm.toSnapshot(), probe);

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.role, 'implementer');
    assert.ok(text.includes(ADVANCE), `the advancing command must be named:\n${text}`);
    assert.ok(
      text.includes(NOTE_IMPLEMENT_ADVANCE_CONDITION),
      `the completion condition must be named:\n${text}`
    );
    assert.ok(text.includes(NOTE_IMPLEMENT_ABSENT), text);
    assert.ok(!text.includes(NOTE_IMPLEMENT_PRESENT), text);
    assert.strictEqual(result.implementationPresent, false);
    assert.strictEqual(result.implementationDispatchCount, 1);
    assert.strictEqual(stateRepo.savedSnapshot!.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(stateRepo.savedSnapshot!.implementationDispatchCount, 1);
  });

  test('IB2: a non-empty diff flips the condition to present and forbids re-dispatch', async () => {
    const sm = machineAtImplement();
    const probe = new FakeProbe(PRESENT_DIFF);

    // One dispatch already recorded, as a real re-read would have left it.
    sm.recordImplementationDispatch();
    const { result, stateRepo } = await readNext(sm.toSnapshot(), probe);

    const text = `${result.description}\n${result.humanSummary}`;
    assert.ok(text.includes(ADVANCE), text);
    assert.ok(text.includes(NOTE_IMPLEMENT_ADVANCE_CONDITION), text);
    assert.ok(text.includes(NOTE_IMPLEMENT_PRESENT), text);
    assert.ok(text.includes('do not re-dispatch the implementer'), text);
    assert.ok(!text.includes(NOTE_IMPLEMENT_ABSENT), text);
    assert.strictEqual(result.implementationPresent, true);
    assert.strictEqual(result.implementationDispatchCount, 2);
    assert.strictEqual(stateRepo.savedSnapshot!.currentStage, STAGE_IMPLEMENT);
  });

  test('IB3: an unreadable tree is UNVERIFIED and records NO dispatch', async () => {
    const sm = machineAtImplement();
    const probe = new FakeProbe(UNREADABLE_DIFF);

    const { result, stateRepo } = await readNext(sm.toSnapshot(), probe);

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.implementationPresent, null);
    assert.ok(text.includes(NOTE_IMPLEMENT_UNVERIFIED), text);
    assert.ok(!text.includes(NOTE_IMPLEMENT_PRESENT), text);
    assert.ok(!text.includes(NOTE_IMPLEMENT_ABSENT), text);
    assert.ok(text.includes(ADVANCE), text);
    assert.strictEqual(result.implementationDispatchCount, 0);
    assert.strictEqual(stateRepo.saveCallCount, 0, 'a diagnostic is not a dispatch');
    assert.strictEqual(stateRepo.savedSnapshot!.currentStage, STAGE_IMPLEMENT);
  });

  test('IB3b: an absent probe and a throwing probe are both UNVERIFIED, never a claim', async () => {
    const sm = machineAtImplement();
    const absent = await readNext(sm.toSnapshot(), undefined);
    assert.strictEqual(absent.result.implementationPresent, null);
    assert.ok(absent.result.description.includes(NOTE_IMPLEMENT_UNVERIFIED));
    assert.strictEqual(absent.stateRepo.saveCallCount, 0);

    const throwing = new FakeProbe(CLEAN_DIFF);
    throwing.throwOnExecute = true;
    const threw = await readNext(sm.toSnapshot(), throwing);
    assert.strictEqual(threw.result.implementationPresent, null);
    assert.strictEqual(threw.stateRepo.saveCallCount, 0);
  });

  test('IB3c: a readable but UNMEASURABLE clean tree makes no claim either', async () => {
    const sm = machineAtImplement();
    const probe = new FakeProbe(UNMEASURABLE_CLEAN_DIFF);

    const { result, stateRepo } = await readNext(sm.toSnapshot(), probe);

    assert.strictEqual(result.implementationPresent, null);
    assert.ok(result.description.includes(NOTE_IMPLEMENT_UNVERIFIED));
    assert.strictEqual(stateRepo.savedSnapshot!.implementationDispatchCount, 1);
  });
});

describe('IMPLEMENT re-dispatch record (#327 AC-10/AC-13)', () => {
  test('IB4: consecutive reads persist 1/2/3 and never advance the stage', async () => {
    const probe = new FakeProbe(CLEAN_DIFF);
    const machine = machineAtImplement();
    const { stateRepo, useCase } = useCaseFor(machine.toSnapshot(), probe);
    const before = machine.toSnapshot();

    const counts = [];
    for (let read = 0; read < 3; read++) {
      const result = await useCase.execute({ workspaceDir: '/repo' });
      counts.push(result.implementationDispatchCount);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT, 'next never advances a stage');
      assert.strictEqual(
        stateRepo.savedSnapshot!.currentStage,
        STAGE_IMPLEMENT,
        'the persisted checkpoint stays at IMPLEMENT'
      );
    }

    assert.deepStrictEqual(counts, [1, 2, 3]);
    assert.strictEqual(stateRepo.savedSnapshot!.implementationDispatchCount, 3);

    // AC-13: a readable tree changes exactly the counter + `updatedAt`.
    // Compare a checkpoint written by the new schema (schema materialisation
    // of the new key is a separate fact, proven by T-327.2).
    const { stateRepo: diffRepo, useCase: diffUseCase } = useCaseFor(before, probe);
    await diffUseCase.execute({ workspaceDir: '/repo' });
    const initial = diffRepo.savedSnapshot;
    await diffUseCase.execute({ workspaceDir: '/repo' });
    const after = diffRepo.savedSnapshot!;
    const changed = [...new Set([...Object.keys(initial!), ...Object.keys(after)])]
      .filter((key) => JSON.stringify((initial as any)[key]) !== JSON.stringify((after as any)[key]))
      .sort();
    // `updatedAt` may be identical when both writes land in the same
    // millisecond, so it is allowed but not required.
    assert.ok(
      changed.every((key) => key === 'implementationDispatchCount' || key === 'updatedAt'),
      `only the declared fields may change, got ${JSON.stringify(changed)}`
    );
    assert.ok(changed.includes('implementationDispatchCount'));
  });

  test('IB5: a paused read records 0', async () => {
    const sm = machineAtImplement({ pausedAtGate: STAGE_QUALITY_GATE });
    const probe = new FakeProbe(CLEAN_DIFF);

    const { result, stateRepo } = await readNext(sm.toSnapshot(), probe);

    assert.strictEqual(result.implementationDispatchCount, 0);
    assert.strictEqual(stateRepo.saveCallCount, 0, 'a paused read is not a dispatch');
  });

  test('IB6: --dry-run declares the counter write and persists nothing', async () => {
    const sm = machineAtImplement();
    const probe = new FakeProbe(CLEAN_DIFF);
    const before = JSON.stringify(sm.toSnapshot());

    const { result, stateRepo } = await readNext(sm.toSnapshot(), probe, { dryRun: true });

    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.deepStrictEqual(result.wouldWrite, ['checkpoint: implementationDispatchCount + updatedAt']);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });

  test('IB7: the APPROVAL/YOLO directive is unchanged and uncounted', async () => {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_YOLO, baseBranch: 'main' });
    sm.setPlanDir('/repo/artifacts/plans/41-task');
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: ISSUE,
        worktreePath: WORKTREE,
        branch: 'task/41-work',
        baseBranch: 'main',
        createdAt: new Date().toISOString()
      })
    );
    const probe = new FakeProbe(PRESENT_DIFF);

    const { result, stateRepo } = await readNext(sm.toSnapshot(), probe);

    assert.strictEqual(result.currentStage, STAGE_APPROVAL);
    assert.strictEqual(result.nextStage, STAGE_IMPLEMENT);
    assert.strictEqual(
      result.description,
      'Execute surgical code modifications adhering strictly to approved plan in dedicated worktree.'
    );
    assert.strictEqual('implementationPresent' in result, false);
    assert.strictEqual('implementationDispatchCount' in result, false);
    assert.strictEqual(probe.calls.length, 0, 'the YOLO directive does not probe');
    assert.strictEqual(stateRepo.saveCallCount, 0);
  });

  test('IB8: the probe receives the task worktree and the descriptor base branch', async () => {
    const sm = machineAtImplement();
    const probe = new FakeProbe(CLEAN_DIFF);

    await readNext(sm.toSnapshot(), probe);

    assert.strictEqual(probe.calls.length, 1);
    assert.strictEqual(probe.calls[0].workspaceDir, WORKTREE);
    assert.strictEqual(probe.calls[0].baseRef, 'phase/6-boundary');
  });

  test('IB9: every transition named at IMPLEMENT is legal there', async () => {
    const probe = new FakeProbe(PRESENT_DIFF);
    const { result } = await readNext(machineAtImplement().toSnapshot(), probe);

    const named = new Set();
    const pattern = /codeloop transition ([A-Z_]+)/g;
    for (const text of [result.description, result.humanSummary]) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        named.add(match[1]);
      }
    }

    assert.ok(named.size > 0, 'the directive names at least one transition');
    for (const target of named) {
      assert.ok(
        ALLOWED_TRANSITIONS[STAGE_IMPLEMENT].includes(target),
        `${target} must be a legal exit from IMPLEMENT`
      );
    }
  });

  test('IB9b: the named command is the domain formatter, not a hand-typed string', () => {
    assert.strictEqual(formatImplementAdvanceCommand(ISSUE), ADVANCE);
    assert.ok(ADVANCE.includes(`--issue ${ISSUE}`));
  });
});
