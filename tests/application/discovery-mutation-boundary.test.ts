/**
 * agyloop - DISCOVERY scoped-write boundary, application layer (issue #389)
 *
 * The boundary prose had no reader: a blank and a polluted discovery run
 * produced byte-identical `next` output. These cases drive the use case with a
 * FAKE probe so the wiring is what is measured:
 *
 * T1 - a dispatch captures the baseline exactly once, excluding the plan dir
 * T2 - a report-only run advances with NO `stageFindings` key (AC4b)
 * T3 - a `dist/` finding rides the subagent path and names dist (AC3a)
 * T4 - the same finding on the populated path keeps `advance` (AC3a)
 * T5 - a tracked finding is the blocking human gate on both paths (AC3b)
 * T6 - no probe injected means NO key (AC3c)
 * T7 - leaving DISCOVERY / reset() clears the baseline; re-entry re-captures
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { GetNextActionUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE,
  STAGE_FINDING_RULE_TRACKED_WRITE_OUTSIDE_SCOPE,
  TITLE_DISCOVERY_BOUNDARY_VIOLATION
} = require('../../dist/domain');

import type { StateRepository, ConfigRepository, AgyLoopConfig } from '../../src/ports';
import type { StateMachineSnapshot, WorkspaceMutationBaseline } from '../../src/domain';

const ISSUE = 41;
const PLAN_DIR = '/repo/artifacts/plans/41-bug-probe';
const DISCOVERY_PATH = `${PLAN_DIR}/[Discovery] - Bug probe.md`;

const DISCOVERY_BLANK = [
  '# [Discovery] - Bug probe',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:**',
  '- **Expected Behavior:**',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:**',
  '- **Identified Failure Mode:**'
].join('\n');

const DISCOVERY_POPULATED = [
  '# [Discovery] - Bug probe',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:** the directive never reported the boundary state',
  '- **Expected Behavior:** a write outside the plan directory is reported',
  '- **Affected Components / Paths:** src/application/get-next-action.ts',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:** read the directive twice around an ignored rebuild',
  '- **Identified Failure Mode:** the boundary was prose with no reader',
  '- **Relevant Code References:** get-next-action.ts DISCOVERY case',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '- **Local Reproduction Command:** codeloop next --issue 41 --json',
  '- **Failing Test Target:** tests/application/discovery-mutation-boundary.test.ts',
  '',
  '## 4. Remediation Strategy',
  '- **Recommended Fix Approach:** capture a dispatch-time baseline and compare',
  '- **Potential Regressions / Side Effects:** none when no probe is injected'
].join('\n');

class MockStateRepo implements StateRepository {
  public savedSnapshot: StateMachineSnapshot | null = null;

  constructor(initial: StateMachineSnapshot | null = null) {
    this.savedSnapshot = initial;
  }

  async load(): Promise<StateMachineSnapshot | null> {
    return this.savedSnapshot;
  }

  async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.savedSnapshot = snapshot;
  }

  async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  getStateFilePath(): string {
    return '/repo/.agyloop/state.json';
  }
}

function makeMockConfig(): ConfigRepository {
  const config: AgyLoopConfig = {
    models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
    options: {
      commitAfter: false,
      gateTimeoutSeconds: 300,
      autoApproveInYolo: true,
      enableMcpInPlanner: true
    }
  };
  return {
    loadConfig: () => config,
    resolveModel: (role: string) => {
      const configured = config.models[role] || 'inherit';
      return { role: role as never, configured, tier: 'inherit', apiModel: 'inherit' };
    },
    mapModelToTier: () => 'inherit'
  };
}

function planGen(discoveryContent: string | (() => string)): any {
  const read = typeof discoveryContent === 'function' ? discoveryContent : () => discoveryContent;
  return {
    findPlanDirectory: () => PLAN_DIR,
    resolvePlanFile: (options: any) => ({
      planDir: PLAN_DIR,
      planPath: options?.stage === STAGE_DISCOVERY ? DISCOVERY_PATH : `${PLAN_DIR}/implementation_plan.md`,
      planFileName: 'implementation_plan.md'
    }),
    readPlanDocument: () => read()
  };
}

class FakeProbe {
  public readonly snapshotCalls: any[] = [];
  public readonly compareCalls: any[] = [];
  public nextFindings: readonly any[] = [];

  public async snapshot(params: any): Promise<WorkspaceMutationBaseline> {
    this.snapshotCalls.push(params);
    return {
      workspaceDir: params.workspaceDir,
      capturedAt: new Date().toISOString(),
      roots: [],
      trackedEntries: []
    };
  }

  public async compare(params: any): Promise<readonly any[]> {
    this.compareCalls.push(params);
    return this.nextFindings;
  }
}

function discoveryCheckpoint(): any {
  const sm = StateMachine.createInitial({ issue: ISSUE });
  sm.transition(STAGE_DISCOVERY, { note: 'probe' });
  sm.setPlanDir(PLAN_DIR);
  return sm;
}

function distFinding(): any {
  return {
    rule: STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE,
    path: 'dist/',
    detail: 'root build changed outside the plan directory'
  };
}

function trackedFinding(): any {
  return {
    rule: STAGE_FINDING_RULE_TRACKED_WRITE_OUTSIDE_SCOPE,
    path: 'README.md',
    detail: 'changed outside the plan directory'
  };
}

describe('DISCOVERY scoped-write boundary (issue #389)', () => {
  test('T1: the dispatch captures the baseline exactly once and excludes the plan dir', async () => {
    const stateRepo = new MockStateRepo(discoveryCheckpoint().toSnapshot());
    const probe = new FakeProbe();
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      planGen(DISCOVERY_BLANK),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      probe
    );

    const first = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(first.actionType, 'subagent');
    assert.strictEqual(probe.snapshotCalls.length, 1, 'dispatch must capture once');
    assert.deepStrictEqual(probe.snapshotCalls[0].excludePaths, [PLAN_DIR]);
    assert.strictEqual(probe.snapshotCalls[0].workspaceDir, '/repo');

    // A second dispatch in the SAME round must not launder the first run's
    // writes by re-capturing the baseline.
    await useCase.execute({ workspaceDir: '/repo' });
    await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(probe.snapshotCalls.length, 1, 'earliest baseline wins');
  });

  test('T2: a report-only run advances with no stageFindings key', async () => {
    const stateRepo = new MockStateRepo(discoveryCheckpoint().toSnapshot());
    const probe = new FakeProbe();
    probe.nextFindings = [];
    let content = DISCOVERY_BLANK;
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      planGen(() => content),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      probe
    );

    const dispatch = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(dispatch.actionType, 'subagent');

    // The subagent writes ONLY the report inside the plan directory.
    content = DISCOVERY_POPULATED;
    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'advance');
    assert.strictEqual('stageFindings' in result, false);
    assert.strictEqual(result.description.includes('Discovery boundary findings'), false);
  });

  test('T3: a dist finding rides the subagent path and names dist', async () => {
    const stateRepo = new MockStateRepo(discoveryCheckpoint().toSnapshot());
    const probe = new FakeProbe();
    probe.nextFindings = [distFinding()];
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      planGen(DISCOVERY_BLANK),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      probe
    );

    await useCase.execute({ workspaceDir: '/repo' }); // captures the baseline
    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'subagent');
    assert.deepStrictEqual(result.stageFindings, [distFinding()]);
    assert.ok(result.description.includes('dist/'), result.description);
    assert.ok(result.humanSummary.includes('root build'), result.humanSummary);
  });

  test('T4: the same finding on the populated path keeps advance', async () => {
    const stateRepo = new MockStateRepo(discoveryCheckpoint().toSnapshot());
    const probe = new FakeProbe();
    probe.nextFindings = [distFinding()];
    let content = DISCOVERY_BLANK;
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      planGen(() => content),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      probe
    );

    await useCase.execute({ workspaceDir: '/repo' }); // baseline
    content = DISCOVERY_POPULATED;
    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'advance');
    assert.deepStrictEqual(result.stageFindings, [distFinding()]);
    assert.ok(result.description.includes('dist/'), result.description);
  });

  test('T5: a tracked finding is the blocking human gate on both paths', async () => {
    for (const settledContent of [DISCOVERY_BLANK, DISCOVERY_POPULATED]) {
      const stateRepo = new MockStateRepo(discoveryCheckpoint().toSnapshot());
      const probe = new FakeProbe();
      probe.nextFindings = [trackedFinding()];
      let content = DISCOVERY_BLANK;
      const useCase = new GetNextActionUseCase(
        stateRepo,
        makeMockConfig(),
        planGen(() => content),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        probe
      );

      await useCase.execute({ workspaceDir: '/repo' }); // baseline
      content = settledContent;
      const result = await useCase.execute({ workspaceDir: '/repo' });

      assert.strictEqual(result.actionType, 'human_gate');
      assert.strictEqual(result.title, TITLE_DISCOVERY_BOUNDARY_VIOLATION);
      assert.deepStrictEqual(result.stageFindings, [trackedFinding()]);
      assert.ok(result.description.includes('README.md'), result.description);
      assert.strictEqual(result.invocationPayload, undefined);
    }
  });

  test('T6: no probe injected means no stageFindings key', async () => {
    const stateRepo = new MockStateRepo(discoveryCheckpoint().toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), planGen(DISCOVERY_POPULATED));

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'advance');
    assert.strictEqual('stageFindings' in result, false);
  });

  test('T7: leaving DISCOVERY and reset() clear the baseline; re-entry re-captures', async () => {
    const sm = discoveryCheckpoint();
    const baseline: WorkspaceMutationBaseline = {
      workspaceDir: '/repo',
      capturedAt: new Date().toISOString(),
      roots: [],
      trackedEntries: []
    };

    sm.setDiscoveryMutationBaseline(baseline);
    assert.deepStrictEqual(sm.discoveryMutationBaseline, baseline);

    // Leaving DISCOVERY ends the measurement window.
    sm.transition(STAGE_PLAN, { note: 'probe' });
    assert.strictEqual(sm.discoveryMutationBaseline, null);

    // reset() clears it too.
    sm.setDiscoveryMutationBaseline(baseline);
    sm.reset(undefined, ISSUE);
    assert.strictEqual(sm.discoveryMutationBaseline, null);

    // Re-entering DISCOVERY allows a fresh capture.
    sm.transition(STAGE_DISCOVERY, { note: 'probe' });
    sm.setPlanDir(PLAN_DIR);
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const probe = new FakeProbe();
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      planGen(DISCOVERY_BLANK),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      probe
    );

    await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(probe.snapshotCalls.length, 1);
  });
});
