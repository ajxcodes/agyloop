/**
 * agyloop - Quota Pause & Persisted Circuit-Breaker Checkpoint Tests (issue #218 AC4)
 *
 * THE CORE BUG guarded here: `handleCircuitBreakerTrip` paused the state machine
 * in memory but never called `stateRepo.save()`, so the on-disk checkpoint kept
 * `pausedAtGate: null` and the next invocation re-entered the failing stage from
 * scratch. Every assertion below reloads the persisted snapshot — a call-count
 * alone would not prove the round trip.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  DEFAULT_CONFIG,
  CB_ACTION_PAUSE_FOR_HUMAN,
  GATE_CIRCUIT_BREAKER,
  QUOTA_RESUME_COMMAND,
  RunLifecycleUseCase,
  StateMachine,
  QuotaExhaustedError,
  classifyQuotaExhaustion,
  STAGE_QUALITY_GATE,
  STAGE_PLAN,
  MODE_YOLO,
  MODE_PLAN
} = require('../../dist');

/** In-memory StateRepository that records every persisted snapshot. */
function makeStateRepo(initial: any) {
  const repo = {
    persisted: JSON.parse(JSON.stringify(initial)),
    snapshots: [] as any[],
    saveCount: 0,
    load: async () => repo.persisted,
    save: async (snapshot: any) => {
      repo.saveCount++;
      repo.persisted = snapshot;
      repo.snapshots.push(snapshot);
    },
    reset: async () => {},
    getStateFilePath: () => path.join(os.tmpdir(), 'quota-pause-state.json')
  };
  return repo;
}

function makeConfigRepo(circuitBreakers?: any) {
  return {
    loadConfig: () => ({
      ...DEFAULT_CONFIG,
      ...(circuitBreakers
        ? { circuitBreakers: { ...DEFAULT_CONFIG.circuitBreakers, ...circuitBreakers } }
        : {})
    }),
    resolveModel: () => ({ role: 'gate', tier: 'flash_lite', apiModel: 'gemini-3.5-flash-lite' }),
    mapModelToTier: () => 'flash_lite'
  };
}

const mockPlanGenerator = {
  scaffoldPlanDirectory: () => ({}),
  generatePlan: () => ({}),
  generateSummaryLog: () => ({}),
  updateSummaryLog: () => true,
  findPlanDirectory: () => null,
  resolvePlanFile: () => null,
  readPlanDocument: () => ''
};

const mockBuildDetector = {
  detect: () => ({ ecosystem: 'node', commands: [{ id: 'test', label: 'Test', command: 'exit 1' }] }),
  resolveCommands: () => [{ id: 'test', label: 'Test', command: 'exit 1' }]
};

const failingCommandExecutor = {
  execute: async () => ({
    command: 'exit 1',
    exitCode: 1,
    stdout: '',
    stderr: 'Test failed',
    combinedOutput: 'Test failed',
    durationMs: 10,
    timedOut: false
  })
};

describe('Quota pause + persisted circuit-breaker checkpoint', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-quota-pause-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('persists pausedAtGate CIRCUIT_BREAKER on quality-gate retry exhaustion', async () => {
    const stateRepo = makeStateRepo({
      issue: 218,
      currentStage: STAGE_QUALITY_GATE,
      mode: MODE_YOLO,
      history: []
    });

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: stateRepo as any,
      configRepo: makeConfigRepo({
        maxGateRetries: 1,
        actionOnTrip: CB_ACTION_PAUSE_FOR_HUMAN
      }) as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: failingCommandExecutor as any,
      buildDetector: mockBuildDetector as any
    });

    const result = await lifecycle.execute({
      mode: MODE_YOLO,
      issue: 218,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.pausedAtGate, GATE_CIRCUIT_BREAKER);

    // The round trip is the assertion that matters: reload the persisted checkpoint
    // through a fresh StateMachine and the gate must still be there.
    const reloaded = StateMachine.fromSnapshot(stateRepo.persisted);
    assert.strictEqual(reloaded.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.strictEqual(
      stateRepo.persisted.pausedAtGate,
      GATE_CIRCUIT_BREAKER,
      'pausedAtGate must be on disk, not only in memory'
    );
    assert.ok(stateRepo.persisted.pausedAtTimestamp);
    assert.notStrictEqual(result.quotaExhausted, true, 'a retry breaker is not a quota halt');
  });

  test('pauses and persists when a stage use case throws QuotaExhaustedError', async () => {
    const stateRepo = makeStateRepo({ issue: 218, currentStage: STAGE_PLAN, mode: MODE_PLAN, history: [] });

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: stateRepo as any,
      configRepo: makeConfigRepo() as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: failingCommandExecutor as any,
      buildDetector: mockBuildDetector as any,
      startPlanningUseCase: {
        execute: async () => {
          throw new QuotaExhaustedError({
            signal: classifyQuotaExhaustion('RESOURCE_EXHAUSTED retry-after: 120'),
            runner: 'opencode',
            stage: STAGE_PLAN
          });
        }
      } as any
    });

    const result = await lifecycle.execute({ mode: MODE_PLAN, issue: 218, workspaceDir: tempDir });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.strictEqual(result.quotaExhausted, true);
    assert.ok(result.message?.includes(GATE_CIRCUIT_BREAKER), result.message);

    const reloaded = StateMachine.fromSnapshot(stateRepo.persisted);
    assert.strictEqual(reloaded.pausedAtGate, GATE_CIRCUIT_BREAKER);
  });

  test('quota diagnostic message contains the reset time and resume instructions', async () => {
    const stateRepo = makeStateRepo({ issue: 218, currentStage: STAGE_PLAN, mode: MODE_PLAN, history: [] });

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: stateRepo as any,
      configRepo: makeConfigRepo() as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: failingCommandExecutor as any,
      buildDetector: mockBuildDetector as any,
      startPlanningUseCase: {
        execute: async () => {
          throw new QuotaExhaustedError({
            signal: classifyQuotaExhaustion('RESOURCE_EXHAUSTED retry-after: 120')
          });
        }
      } as any
    });

    const result = await lifecycle.execute({ mode: MODE_PLAN, issue: 218, workspaceDir: tempDir });

    assert.match(String(result.message), /reset at \d{4}-\d{2}-\d{2}T/);
    assert.ok(String(result.message).includes(QUOTA_RESUME_COMMAND), result.message);
    assert.ok(String(result.message).includes('429'), result.message);
  });

  test('does not write state on the quota path when dryRun is true', async () => {
    const stateRepo = makeStateRepo({ issue: 218, currentStage: STAGE_PLAN, mode: MODE_PLAN, history: [] });

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: stateRepo as any,
      configRepo: makeConfigRepo() as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: failingCommandExecutor as any,
      buildDetector: mockBuildDetector as any,
      startPlanningUseCase: {
        execute: async () => {
          throw new QuotaExhaustedError({
            signal: classifyQuotaExhaustion('RESOURCE_EXHAUSTED retry-after: 120')
          });
        }
      } as any
    });

    const result = await lifecycle.execute({
      mode: MODE_PLAN,
      issue: 218,
      workspaceDir: tempDir,
      dryRun: true
    });

    assert.strictEqual(result.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.strictEqual(stateRepo.saveCount, 0, 'dryRun must never persist');
    assert.strictEqual(stateRepo.persisted.pausedAtGate, undefined);
  });

  test('rethrows non-quota errors unchanged', async () => {
    const stateRepo = makeStateRepo({ issue: 218, currentStage: STAGE_PLAN, mode: MODE_PLAN, history: [] });

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: stateRepo as any,
      configRepo: makeConfigRepo() as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: failingCommandExecutor as any,
      buildDetector: mockBuildDetector as any,
      startPlanningUseCase: {
        execute: async () => {
          throw new Error('unrelated failure');
        }
      } as any
    });

    await assert.rejects(
      async () => lifecycle.execute({ mode: MODE_PLAN, issue: 218, workspaceDir: tempDir }),
      (err: any) => {
        assert.ok(!(err instanceof QuotaExhaustedError));
        assert.strictEqual(err.message, 'unrelated failure');
        return true;
      }
    );
    assert.notStrictEqual(stateRepo.persisted.pausedAtGate, GATE_CIRCUIT_BREAKER);
  });

  test('surfaces the breaker result even when stateRepo.save rejects', async () => {
    const base = makeStateRepo({
      issue: 218,
      currentStage: STAGE_QUALITY_GATE,
      mode: MODE_YOLO,
      history: []
    });
    // Only the pause-persist write is guarded: the lifecycle's earlier checkpoint
    // writes must still succeed so the run reaches the breaker.
    const stateRepo = {
      persisted: base.persisted,
      snapshots: base.snapshots,
      load: base.load,
      reset: base.reset,
      getStateFilePath: base.getStateFilePath,
      save: async (snapshot: any) => {
        if (snapshot.pausedAtGate === GATE_CIRCUIT_BREAKER) {
          throw new Error('disk full');
        }
        stateRepo.persisted = snapshot;
        stateRepo.snapshots.push(snapshot);
      }
    };

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: stateRepo as any,
      configRepo: makeConfigRepo({
        maxGateRetries: 1,
        actionOnTrip: CB_ACTION_PAUSE_FOR_HUMAN
      }) as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: failingCommandExecutor as any,
      buildDetector: mockBuildDetector as any
    });

    const result = await lifecycle.execute({ mode: MODE_YOLO, issue: 218, workspaceDir: tempDir });

    assert.strictEqual(result.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.ok(result.message && result.message.length > 0);
    assert.ok(result.message?.includes('Circuit breaker'), result.message);
  });

  test('persisted snapshot reloaded via StateMachine.fromSnapshot retains the gate', async () => {
    const stateRepo = makeStateRepo({
      issue: 218,
      currentStage: STAGE_QUALITY_GATE,
      mode: MODE_YOLO,
      history: []
    });

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: stateRepo as any,
      configRepo: makeConfigRepo({
        maxGateRetries: 1,
        actionOnTrip: CB_ACTION_PAUSE_FOR_HUMAN
      }) as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: failingCommandExecutor as any,
      buildDetector: mockBuildDetector as any
    });

    await lifecycle.execute({ mode: MODE_YOLO, issue: 218, workspaceDir: tempDir });

    const lastPersisted = stateRepo.snapshots[stateRepo.snapshots.length - 1];
    const reloaded = StateMachine.fromSnapshot(JSON.parse(JSON.stringify(lastPersisted)));

    assert.strictEqual(reloaded.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.ok(reloaded.pausedAtTimestamp);
    // A resume clears the gate; until then the next run keeps the context.
    reloaded.resumeFromGate();
    assert.strictEqual(reloaded.pausedAtGate, null);
  });
});
