/**
 * agyloop - REVIEW dispatch threads the probe's untracked files (issue #356, Defect 2)
 *
 * The reviewer's ONLY inspection command was `git diff <base> -- . <excludes>`,
 * which cannot see an untracked file. A change whose load-bearing part was a NEW
 * file (#352's `.github/actionlint.yaml`) was therefore invisible: the prompt
 * printed nothing for it, and the APPROVED verdict certified a diff it had never
 * seen. `detect-implementation-diff` already measures `untrackedFiles`; the
 * dispatch must consume that measurement instead of re-deriving one.
 *
 * GU1 - an untracked-only change names the path + a full-content command
 * GU2 - no probe at all degrades to the pre-#356 prompt (no section)
 * GU3 - an unreadable tree (`probeError`) fails closed, still dispatches
 * GU4 - an empty untracked list with a tracked change renders no section
 * GU5 - the dispatch measures exactly once and never names a staging command
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { GetNextActionUseCase } = require('../../dist/application');
const {
  StateMachine,
  WorktreeDescriptor,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  ROLE_REVIEWER
} = require('../../dist/domain');

const ISSUE = 356;
const WORKTREE = '/repo/.worktrees/356';
const HEADING = '### Untracked Implementation Files';
const ACTIONLINT_COMMAND =
  "git diff --no-index -- /dev/null '.github/actionlint.yaml' || true";

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
      planDir: `/repo/artifacts/plans/${ISSUE}-task`,
      planPath: `/repo/artifacts/plans/${ISSUE}-task/implementation_plan.md`,
      planFileName: 'implementation_plan.md'
    };
  }

  readPlanDocument(): string {
    return '# [Implementation] - probe\n\n- [ ] Step 1: do the probe\n';
  }

  hashPlanDocument(): string {
    return 'digest-1';
  }

  findPlanDirectory(): string {
    return `/repo/artifacts/plans/${ISSUE}-task`;
  }

  updateSummaryLog(): boolean {
    return true;
  }
}

const TRACKED_ONLY_DIFF: any = {
  hasChanges: true,
  baseRef: 'main',
  trackedChangedFiles: ['src/application/resolve-subagent.ts'],
  untrackedFiles: [],
  probeError: null,
  measurementError: null,
  rawStatus: ' M src/application/resolve-subagent.ts'
};

const UNTRACKED_ONLY_DIFF: any = {
  hasChanges: true,
  baseRef: 'main',
  trackedChangedFiles: [],
  untrackedFiles: ['.github/actionlint.yaml'],
  probeError: null,
  measurementError: null,
  rawStatus: '?? .github/actionlint.yaml'
};

const UNREADABLE_DIFF: any = {
  ...UNTRACKED_ONLY_DIFF,
  probeError: 'git status --porcelain exited with code 128',
  rawStatus: ''
};

class FakeProbe {
  public result: any;
  public calls: any[] = [];

  constructor(result: any = TRACKED_ONLY_DIFF) {
    this.result = result;
  }

  async execute(params: any = {}): Promise<any> {
    this.calls.push(params);
    return this.result;
  }
}

function machineAtReview() {
  const sm = StateMachine.createInitial({
    issue: ISSUE,
    mode: 'standard',
    baseBranch: 'main'
  });
  sm.setPlanDir(`/repo/artifacts/plans/${ISSUE}-task`);
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  sm.transition(STAGE_REVIEW);
  sm.setWorktree(
    WorktreeDescriptor.create({
      taskId: ISSUE,
      worktreePath: WORKTREE,
      branch: `task/${ISSUE}-work`,
      baseBranch: 'main',
      createdAt: new Date().toISOString()
    })
  );
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

function promptOf(result: any): string {
  return result.invocationPayload?.Subagents?.[0]?.Prompt ?? '';
}

describe('REVIEW dispatch names the untracked change set (issue #356)', () => {
  test('GU1: an untracked-only change is named, with a command that prints its full content', async () => {
    const probe = new FakeProbe(UNTRACKED_ONLY_DIFF);
    const { useCase } = useCaseFor(machineAtReview().toSnapshot(), probe);

    const result = await useCase.execute({ workspaceDir: '/repo', issue: ISSUE });

    assert.strictEqual(result.role, ROLE_REVIEWER);
    assert.strictEqual(result.actionType, 'subagent');
    const prompt = promptOf(result);
    assert.ok(prompt.includes(HEADING), `the untracked section must render:\n${prompt}`);
    assert.ok(prompt.includes('.github/actionlint.yaml'), 'the untracked path must be named');
    assert.ok(
      prompt.includes(ACTIONLINT_COMMAND),
      `the content command must render:\n${prompt}`
    );
  });

  test('GU2: with no probe the prompt is unchanged and the dispatch still happens', async () => {
    const stateRepo = new MockStateRepo(machineAtReview().toSnapshot());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      new MockConfigRepo(),
      new MockPlanGenerator()
    );

    const result = await useCase.execute({ workspaceDir: '/repo', issue: ISSUE });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, ROLE_REVIEWER);
    const prompt = promptOf(result);
    assert.strictEqual(prompt.includes(HEADING), false, prompt);
  });

  test('GU3: an unreadable tree fails closed — no section, dispatch still happens', async () => {
    const probe = new FakeProbe(UNREADABLE_DIFF);
    const { useCase } = useCaseFor(machineAtReview().toSnapshot(), probe);

    const result = await useCase.execute({ workspaceDir: '/repo', issue: ISSUE });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, ROLE_REVIEWER);
    assert.strictEqual(promptOf(result).includes(HEADING), false, promptOf(result));
  });

  test('GU4: an empty untracked list with a tracked change renders no section', async () => {
    const probe = new FakeProbe(TRACKED_ONLY_DIFF);
    const { useCase } = useCaseFor(machineAtReview().toSnapshot(), probe);

    const result = await useCase.execute({ workspaceDir: '/repo', issue: ISSUE });

    assert.strictEqual(result.role, ROLE_REVIEWER);
    assert.strictEqual(promptOf(result).includes(HEADING), false, promptOf(result));
  });

  test('GU5: the dispatch measures exactly once and never names a staging command', async () => {
    const cases = [
      { probe: new FakeProbe(UNTRACKED_ONLY_DIFF), label: 'untracked-only' },
      { probe: new FakeProbe(TRACKED_ONLY_DIFF), label: 'tracked-only' },
      { probe: new FakeProbe(UNREADABLE_DIFF), label: 'unreadable' }
    ];

    for (const { probe, label } of cases) {
      const { useCase } = useCaseFor(machineAtReview().toSnapshot(), probe);
      const result = await useCase.execute({ workspaceDir: '/repo', issue: ISSUE });
      const prompt = promptOf(result);

      assert.strictEqual(probe.calls.length, 1, `${label}: the dispatch must measure exactly once`);
      assert.strictEqual(prompt.includes('git add'), false, `${label}: the prompt names staging`);
      assert.strictEqual(prompt.includes('git stash'), false, `${label}: the prompt names stashing`);
    }
  });
});
