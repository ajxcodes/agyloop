/**
 * agyloop - `next` reports actionability from EVIDENCE (issue #337)
 *
 * The defect: `next` computed each stage's completion state and fed it only to
 * prose, then still emitted `actionType: 'subagent'` + an invocation payload and
 * recorded a dispatch. The gate directive told the operator to file evidence it
 * never read. `COMPLETED`/`INITIALIZED` reported `actionable:true` with nothing
 * to dispatch.
 *
 * C1  - DISCOVERY + populated report -> advance, no payload, no write
 * C2  - PLAN + non-blank plan -> advance, no payload, no write
 * C3  - IMPLEMENT + present diff -> advance, no payload, count unchanged
 * C4  - present diff + CHANGES_REQUESTED -> subagent (the remediation route)
 * C5  - IMPLEMENT + clean tree -> subagent (control)
 * C6  - DISCOVERY + blank report -> subagent (control)
 * C7  - PLAN + blank plan -> subagent (control)
 * C8  - QUALITY_GATE + this round's PASSED block -> advance, no filing note
 * C8b - QUALITY_GATE + this round's FAILED block -> advance + retry command
 * C9  - QUALITY_GATE + a PREVIOUS round's block -> subagent + filing note
 * C10 - QUALITY_GATE + nothing filed -> subagent + filing note + false
 * C11 - COMPLETED -> completed, no payload, real commands named
 * C12 - INITIALIZED -> preflight, no payload
 * C13 - C1 under --dry-run declares NO write
 * C14 - a FAILED gate's recorded diagnostics re-dispatch the implementer
 * C14b - the consecutive-failure counter alone also blocks the met condition
 * C15 - a FAILED gate filed with the verdict alone still re-dispatches
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { GetNextActionUseCase } = require('../../dist/application');
const {
  StateMachine,
  WorktreeDescriptor,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  MODE_STANDARD,
  GateResultReport,
  resolveGateRound,
  NOTE_DISCOVERY_COMPLETE,
  NOTE_PLAN_COMPLETE,
  NOTE_IMPLEMENT_PRESENT,
  NOTE_IMPLEMENT_PRESENT_REMEDIATION_PENDING,
  NOTE_IMPLEMENT_GATE_FAILED
} = require('../../dist/domain');

import type {
  StateRepository,
  ConfigRepository,
  AgyLoopConfig,
  GateReportRepositoryPort
} from '../../src/ports';
import type { StateMachineSnapshot, GateResultReport as GateResultReportType } from '../../src/domain';

const ISSUE = 41;
const WORKTREE = '/repo/.worktrees/41';
const PLAN_DIR = '/repo/artifacts/plans/41-task';
const PLAN_PATH = `${PLAN_DIR}/implementation_plan.md`;
const DISCOVERY_PATH = `${PLAN_DIR}/[Discovery] - Bug probe.md`;

const REAL_PLAN = [
  '# [Implementation] - Bug probe',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** change `src/probe.ts` to return a value.'
].join('\n');

const BLANK_PLAN = [
  '# [Implementation] - Bug probe',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:**'
].join('\n');

const DISCOVERY_BLANK = [
  '# [Discovery] - Bug probe',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:**',
  '- **Expected Behavior:**',
  '- **Affected Components / Paths:**',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:**',
  '- **Identified Failure Mode:**',
  '- **Relevant Code References:**'
].join('\n');

const DISCOVERY_POPULATED = [
  '# [Discovery] - Bug probe',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:** the directive invited a dispatch after the report was populated',
  '- **Expected Behavior:** the directive names the advancing command and emits no payload',
  '- **Affected Components / Paths:** `src/application/get-next-action.ts`',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:** read the directive twice around a report write',
  '- **Identified Failure Mode:** the payload was built before the report state was consulted',
  '- **Relevant Code References:** get-next-action.ts:605-638',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '- **Local Reproduction Command:** codeloop next --issue 41 --json',
  '- **Failing Test Target:** tests/application/get-next-action-completion.test.ts',
  '',
  '## 4. Remediation Strategy',
  '- **Recommended Fix Approach:** return an advance directive when the report is populated',
  '- **Potential Regressions / Side Effects:** none when no generator is injected'
].join('\n');

const PASSED_BLOCK = [
  'GATE_REPORT_JSON:',
  '{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",',
  '  "testsStatus": "PASSED (12 passed)", "testsPassed": 12, "testsFailed": 0,',
  '  "durationMs": 1000, "executedCommands": ["npm test"],',
  '  "smokeProtocol": "NOT_DECLARED", "notRun": [] }'
].join('\n');

const FAILED_BLOCK = [
  'GATE_REPORT_JSON:',
  '{ "verdict": "FAILED", "buildSystem": "node", "buildStatus": "PASSED",',
  '  "testsStatus": "FAILED (2 failed)", "testsPassed": 10, "testsFailed": 2,',
  '  "durationMs": 1000, "executedCommands": ["npm test"],',
  '  "smokeProtocol": "NOT_DECLARED", "notRun": [] }'
].join('\n');

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
    resolveModel: (role: string) => {
      const configured = config.models[role] || 'inherit';
      let tier: any = 'inherit';
      let apiModel = 'inherit';
      if (configured.includes('pro')) {
        tier = 'pro';
        apiModel = 'gemini-2.5-pro';
      } else if (configured.includes('flash_lite')) {
        tier = 'flash_lite';
        apiModel = 'gemini-2.5-flash-lite';
      } else if (configured.includes('flash')) {
        tier = 'flash';
        apiModel = 'gemini-3.5-flash';
      }
      return { role: role as any, configured, tier, apiModel };
    },
    mapModelToTier: (inputModel: string): any => {
      if (inputModel.includes('pro')) return 'pro';
      if (inputModel.includes('flash_lite')) return 'flash_lite';
      if (inputModel.includes('flash')) return 'flash';
      return 'inherit';
    }
  };
}

/** Resolves the discovery document at DISCOVERY and the plan document at PLAN. */
class MockPlanGenerator {
  private readonly planContent: string;
  private readonly discoveryContent: string;

  constructor(planContent: string = REAL_PLAN, discoveryContent: string = DISCOVERY_BLANK) {
    this.planContent = planContent;
    this.discoveryContent = discoveryContent;
  }

  resolvePlanFile(options: any): any {
    const discovery = options?.stage === STAGE_DISCOVERY;
    return {
      planDir: PLAN_DIR,
      planPath: discovery ? DISCOVERY_PATH : PLAN_PATH,
      planFileName: discovery ? '[Discovery] - Bug probe.md' : 'implementation_plan.md'
    };
  }

  readPlanDocument(path: string): string {
    return path === DISCOVERY_PATH ? this.discoveryContent : this.planContent;
  }

  hashPlanDocument(): string {
    return 'digest-1';
  }

  findPlanDirectory(): string {
    return PLAN_DIR;
  }
}

class FakeProbe {
  public calls: any[] = [];
  private readonly result: any;

  constructor(result: any) {
    this.result = result;
  }

  async execute(params: any = {}): Promise<any> {
    this.calls.push(params);
    return this.result;
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
  trackedChangedFiles: ['src/probe.ts'],
  hasChanges: true
};

class MockGateReportRepo implements GateReportRepositoryPort {
  public report: GateResultReportType | null;
  public loadCalls = 0;

  constructor(report: GateResultReportType | null) {
    this.report = report;
  }

  load(): GateResultReportType | null {
    this.loadCalls += 1;
    return this.report;
  }

  save(): string {
    return '/repo/.agyloop/tasks/41.gate.json';
  }

  clear(): void {
    this.report = null;
  }
}

function discoveryMachine(): any {
  const sm = StateMachine.createInitial({
    issue: ISSUE,
    mode: MODE_STANDARD,
    baseBranch: 'main'
  });
  sm.setPlanDir(PLAN_DIR);
  sm.transition(STAGE_DISCOVERY);
  return sm;
}

function planMachine(): any {
  const sm = discoveryMachine();
  sm.transition(STAGE_PLAN);
  return sm;
}

function implementMachine(): any {
  const sm = planMachine();
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
  sm.transition(STAGE_IMPLEMENT);
  return sm;
}

function gateMachine(): any {
  const sm = implementMachine();
  sm.transition(STAGE_QUALITY_GATE);
  return sm;
}

function completedMachine(): any {
  const sm = gateMachine();
  sm.transition(STAGE_REVIEW);
  sm.transition(STAGE_COMMIT);
  sm.transition(STAGE_COMPLETED);
  return sm;
}

function makeUseCase(
  stateRepo: StateRepository,
  options: {
    planGenerator?: any;
    probe?: any;
    gateRepo?: any;
  } = {}
): any {
  return new GetNextActionUseCase(
    stateRepo,
    makeMockConfig(),
    options.planGenerator,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.probe,
    options.gateRepo
  );
}

function reportFor(sm: any, block: string, roundOverride?: number): GateResultReportType {
  const round = roundOverride ?? resolveGateRound(sm.history);
  return GateResultReport.parseBlock(block, round);
}

describe('a met completion condition is not dispatchable (issue #337)', () => {
  test('C1: DISCOVERY with a populated report advances and writes nothing', async () => {
    const sm = discoveryMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const before = JSON.stringify(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN, DISCOVERY_POPULATED)
    }).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'advance');
    assert.strictEqual(result.nextStage, STAGE_PLAN);
    assert.strictEqual(result.role, undefined);
    assert.strictEqual(result.invocationPayload, undefined);
    assert.strictEqual(result.discoveryReportPopulated, true);
    assert.strictEqual(result.discoveryDispatchCount, 0);
    assert.ok(result.description.includes(NOTE_DISCOVERY_COMPLETE), result.description);
    assert.ok(result.description.includes('codeloop plan --issue 41'), result.description);
    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });

  test('C2: PLAN with a non-blank plan advances and writes nothing', async () => {
    const sm = planMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const before = JSON.stringify(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN)
    }).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'advance');
    assert.strictEqual(result.nextStage, STAGE_APPROVAL);
    assert.strictEqual(result.role, undefined);
    assert.strictEqual(result.invocationPayload, undefined);
    assert.strictEqual(result.planDispatchCount, 0);
    assert.ok(result.description.includes(NOTE_PLAN_COMPLETE), result.description);
    assert.ok(
      result.description.includes('codeloop transition APPROVAL --issue 41'),
      result.description
    );
    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });

  test('C3: IMPLEMENT with a present diff advances without a payload or a counter', async () => {
    const sm = implementMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const before = JSON.stringify(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN),
      probe: new FakeProbe(PRESENT_DIFF)
    }).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'advance');
    assert.strictEqual(result.nextStage, STAGE_QUALITY_GATE);
    assert.strictEqual(result.role, undefined);
    assert.strictEqual(result.invocationPayload, undefined);
    assert.strictEqual(result.implementationPresent, true);
    assert.strictEqual(result.implementationDispatchCount, 0);
    assert.ok(result.description.includes(NOTE_IMPLEMENT_PRESENT), result.description);
    assert.ok(
      result.description.includes('codeloop transition QUALITY_GATE --issue 41'),
      result.description
    );
    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });

  test('C4: a present diff with pending review remediation still dispatches', async () => {
    const sm = implementMachine();
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_IMPLEMENT, {
      reviewVerdict: 'CHANGES_REQUESTED',
      reviewTokens: '### Review Remediation - Round 2\n- fix the probe',
      reviewRound: 2
    });
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN),
      probe: new FakeProbe(PRESENT_DIFF)
    }).execute({ workspaceDir: '/repo' });

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'implementer');
    assert.ok(result.invocationPayload, 'the remediation route must carry a payload');
    assert.strictEqual(result.implementationDispatchCount, 1);
    assert.ok(text.includes(NOTE_IMPLEMENT_PRESENT_REMEDIATION_PENDING), text);
    assert.ok(!text.includes('do not re-dispatch the implementer'), text);
    assert.strictEqual(stateRepo.savedSnapshot!.implementationDispatchCount, 1);
  });

  test('C14: a FAILED gate\'s recorded diagnostics re-dispatch the implementer', async () => {
    // Issue #337 review remediation: a gate that exits FAILED returns to
    // IMPLEMENT with the FAILING diff still in the worktree. Treating that diff
    // as a met completion would re-advance into the same failing gate and never
    // hand the implementer the diagnostics — a regression against the
    // gate-failure loop.
    const sm = implementMachine();
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_IMPLEMENT, {
      note: 'Gates failed',
      gateVerdict: 'FAILED',
      gateTokens: 'GATE_STATUS: FAILED\n- npm test: 2 failed',
      failureSnippet: 'AssertionError: expected 1 to equal 2',
      selfCorrectionPayload: 'Fix the failing assertion in src/probe.ts.'
    });
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN),
      probe: new FakeProbe(PRESENT_DIFF)
    }).execute({ workspaceDir: '/repo' });

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'implementer');
    assert.ok(result.invocationPayload, 'a failed gate must re-dispatch the implementer');
    assert.strictEqual(result.implementationPresent, true);
    assert.strictEqual(result.implementationDispatchCount, 1);
    assert.ok(text.includes(NOTE_IMPLEMENT_GATE_FAILED), text);
    assert.ok(!text.includes('do not re-dispatch the implementer'), text);
    assert.ok(text.includes('once the gate\'s failures are fixed'), text);
    const prompt = result.invocationPayload!.Subagents[0].Prompt;
    assert.match(prompt, /Quality Gate Failure/i);
    assert.ok(prompt.includes('GATE_STATUS: FAILED'), prompt);
    assert.ok(prompt.includes('AssertionError: expected 1 to equal 2'), prompt);
    assert.strictEqual(stateRepo.savedSnapshot!.implementationDispatchCount, 1);
  });

  test('C14b: the consecutive-failure counter alone also blocks the met condition', async () => {
    // A checkpoint that records the failed-gate LOOP without the verdict (the
    // in-process counter survives the round) must not read as done either.
    const sm = implementMachine();
    sm.incrementImplementGateLoop();
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN),
      probe: new FakeProbe(PRESENT_DIFF)
    }).execute({ workspaceDir: '/repo' });

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'implementer');
    assert.ok(result.invocationPayload);
    assert.ok(text.includes(NOTE_IMPLEMENT_GATE_FAILED), text);
    assert.ok(!text.includes('do not re-dispatch the implementer'), text);
  });

  test('C15: a FAILED gate filed with the verdict alone still re-dispatches', async () => {
    // `gate-report` + `transition IMPLEMENT` records the verdict and nothing
    // else. The implementer must still be dispatched, with the block framed but
    // carrying no fabricated diagnostics.
    const sm = implementMachine();
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_IMPLEMENT, { gateVerdict: 'FAILED' });
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN),
      probe: new FakeProbe(PRESENT_DIFF)
    }).execute({ workspaceDir: '/repo' });

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'implementer');
    assert.ok(result.invocationPayload);
    assert.ok(text.includes(NOTE_IMPLEMENT_GATE_FAILED), text);
    const prompt = result.invocationPayload!.Subagents[0].Prompt;
    assert.match(prompt, /Quality Gate Failure/i);
  });

  test('C5: IMPLEMENT with a clean tree stays dispatchable (control)', async () => {
    const sm = implementMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN),
      probe: new FakeProbe(CLEAN_DIFF)
    }).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.implementationPresent, false);
    assert.ok(result.invocationPayload);
    assert.strictEqual(result.implementationDispatchCount, 1);
    assert.strictEqual(stateRepo.savedSnapshot!.implementationDispatchCount, 1);
  });

  test('C6: DISCOVERY with a blank report stays dispatchable (control)', async () => {
    const sm = discoveryMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN, DISCOVERY_BLANK)
    }).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'discovery');
    assert.ok(result.invocationPayload);
    assert.strictEqual(result.discoveryDispatchCount, 1);
  });

  test('C7: PLAN with a blank plan stays dispatchable (control)', async () => {
    const sm = planMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(BLANK_PLAN)
    }).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'planner');
    assert.ok(result.invocationPayload);
    assert.strictEqual(result.planDispatchCount, 1);
  });

  test('C13: a met read under --dry-run declares NO write', async () => {
    const sm = discoveryMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const before = JSON.stringify(sm.toSnapshot());

    const result = await makeUseCase(stateRepo, {
      planGenerator: new MockPlanGenerator(REAL_PLAN, DISCOVERY_POPULATED)
    }).execute({ workspaceDir: '/repo', dryRun: true });

    assert.strictEqual(result.actionType, 'advance');
    assert.deepStrictEqual(result.wouldWrite, []);
    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });
});

describe('the gate directive reads the evidence it tells you to file (issue #337)', () => {
  test('C8: a same-round PASSED block is a met condition — advance, no filing note', async () => {
    const sm = gateMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const before = JSON.stringify(sm.toSnapshot());
    const gateRepo = new MockGateReportRepo(reportFor(sm, PASSED_BLOCK));

    const result = await makeUseCase(stateRepo, { gateRepo }).execute({ workspaceDir: '/repo' });

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.actionType, 'advance');
    assert.strictEqual(result.nextStage, STAGE_REVIEW);
    assert.strictEqual(result.role, undefined);
    assert.strictEqual(result.invocationPayload, undefined);
    assert.strictEqual(result.gateEvidenceFiled, true);
    assert.match(text, /evidence filed/i);
    assert.ok(text.includes('codeloop transition REVIEW --issue 41'), text);
    assert.doesNotMatch(text, /file the gate's emitted/i);
    assert.ok(!text.includes('codeloop gate-report'), text);
    assert.strictEqual(gateRepo.loadCalls, 1);
    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot), before);
  });

  test('C8b: a same-round FAILED block still advances and names the retry command', async () => {
    const sm = gateMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const gateRepo = new MockGateReportRepo(reportFor(sm, FAILED_BLOCK));

    const result = await makeUseCase(stateRepo, { gateRepo }).execute({ workspaceDir: '/repo' });

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.actionType, 'advance');
    assert.strictEqual(result.gateEvidenceFiled, true);
    assert.match(text, /FAILED/);
    assert.ok(text.includes('codeloop transition IMPLEMENT --issue 41'), text);
    assert.ok(text.includes('codeloop transition REVIEW --issue 41'), text);
    assert.doesNotMatch(text, /file the gate's emitted/i);
  });

  test('C9: a PREVIOUS round block cannot certify this round', async () => {
    const sm = gateMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    // Resolves to the checkpoint's round, then stamp it one round EARLIER.
    const staleRound = Math.max(0, resolveGateRound(sm.history) - 1);
    const gateRepo = new MockGateReportRepo(reportFor(sm, PASSED_BLOCK, staleRound));

    const result = await makeUseCase(stateRepo, { gateRepo }).execute({ workspaceDir: '/repo' });

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'gate');
    assert.ok(result.invocationPayload);
    assert.strictEqual(result.gateEvidenceFiled, false);
    assert.match(text, /file the gate's emitted/i);
  });

  test('C10: with nothing filed the directive still asks for the block', async () => {
    const sm = gateMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const gateRepo = new MockGateReportRepo(null);

    const result = await makeUseCase(stateRepo, { gateRepo }).execute({ workspaceDir: '/repo' });

    const text = `${result.description}\n${result.humanSummary}`;
    assert.strictEqual(result.actionType, 'subagent');
    assert.ok(result.invocationPayload);
    assert.strictEqual(result.gateEvidenceFiled, false);
    assert.match(text, /file the gate's emitted/i);
    assert.ok(text.includes('codeloop gate-report'), text);
  });

  test('with no repository injected the evidence is UNVERIFIED and no claim is made', async () => {
    const sm = gateMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual('gateEvidenceFiled' in result, false);
    assert.match(result.description, /file the gate's emitted/i);
  });
});

describe('idle and pre-flight reports are not actionable (issue #337)', () => {
  test('C11: COMPLETED is `completed`, carries no payload and names real commands', async () => {
    const sm = completedMachine();
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_COMPLETED);
    assert.strictEqual(result.actionType, 'completed');
    assert.strictEqual(result.invocationPayload, undefined);
    assert.ok(!result.humanSummary.includes('codeloop <task>'), result.humanSummary);
    assert.ok(result.humanSummary.includes('codeloop plan --issue'), result.humanSummary);
    assert.ok(result.humanSummary.includes('codeloop next --restart --issue'), result.humanSummary);
  });

  test('C12: INITIALIZED is `preflight` with no payload', async () => {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const result = await makeUseCase(stateRepo).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.currentStage, STAGE_INITIALIZED);
    assert.strictEqual(result.actionType, 'preflight');
    assert.strictEqual(result.invocationPayload, undefined);
  });
});
