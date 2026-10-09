/**
 * agyloop - Circuit Breakers & Safety Protocol Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  loadConfig,
  DEFAULT_CONFIG,
  DEFAULT_CB_MAX_TURNS_PER_SUBAGENT,
  DEFAULT_CB_MAX_GATE_RETRIES,
  DEFAULT_CB_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_CB_MAX_WALL_CLOCK_DURATION_SECONDS,
  DEFAULT_CB_TOKEN_BUDGET_THRESHOLD,
  DEFAULT_CB_ACTION_ON_TRIP,
  CB_ACTION_PAUSE_FOR_HUMAN,
  CB_ACTION_ABORT,
  CircuitBreakerTrippedError,
  ValidationError,
  RunLifecycleUseCase,
  STAGE_QUALITY_GATE,
  MODE_YOLO
} = require('../../dist');

describe('Circuit Breakers Configuration & Tripping Protocol', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-cb-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('DEFAULT_CONFIG contains strongly-typed circuitBreakers block with default values', () => {
    const cb = DEFAULT_CONFIG.circuitBreakers;
    assert.ok(cb, 'circuitBreakers must be defined in DEFAULT_CONFIG');
    assert.strictEqual(cb.maxTurnsPerSubagent, DEFAULT_CB_MAX_TURNS_PER_SUBAGENT);
    assert.strictEqual(cb.maxGateRetries, DEFAULT_CB_MAX_GATE_RETRIES);
    assert.strictEqual(cb.maxConcurrentSubagents, DEFAULT_CB_MAX_CONCURRENT_SUBAGENTS);
    assert.strictEqual(cb.maxWallClockDurationSeconds, DEFAULT_CB_MAX_WALL_CLOCK_DURATION_SECONDS);
    assert.strictEqual(cb.tokenBudgetThreshold, DEFAULT_CB_TOKEN_BUDGET_THRESHOLD);
    assert.strictEqual(cb.actionOnTrip, DEFAULT_CB_ACTION_ON_TRIP);
  });

  test('loadConfig validates overrides and throws ValidationError on invalid values', () => {
    const configPath = path.join(tempDir, '.agyloop.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        circuitBreakers: {
          maxGateRetries: -3
        }
      }),
      'utf8'
    );

    assert.throws(
      () => {
        loadConfig({ workspaceDir: tempDir });
      },
      (err: any) => {
        assert.ok(err instanceof ValidationError);
        assert.strictEqual(err.field, 'circuitBreakers.maxGateRetries');
        return true;
      }
    );
  });

  test('RunLifecycleUseCase trips circuit breaker after consecutive quality gate failures when actionOnTrip is abort', async () => {
    let gateAttempts = 0;

    let currentState: any = {
      issue: 212,
      currentStage: STAGE_QUALITY_GATE,
      mode: MODE_YOLO,
      history: []
    };

    const mockStateRepo = {
      load: async () => currentState,
      save: async (s: any) => {
        currentState = s;
      },
      reset: async () => {},
      getStateFilePath: () => path.join(tempDir, 'state.json')
    };

    const mockConfigRepo = {
      loadConfig: () => ({
        ...DEFAULT_CONFIG,
        circuitBreakers: {
          ...DEFAULT_CONFIG.circuitBreakers,
          maxGateRetries: 1,
          actionOnTrip: CB_ACTION_ABORT
        }
      }),
      resolveModel: () => ({ role: 'gate', tier: 'flash_lite', apiModel: 'gemini-3.5-flash-lite' }),
      mapModelToTier: () => 'flash_lite'
    };

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
      detect: () => ({
        ecosystem: 'node',
        commands: [
          { id: 'test', label: 'Test', command: 'exit 1' }
        ]
      }),
      resolveCommands: () => [
        { id: 'test', label: 'Test', command: 'exit 1' }
      ]
    };

    const mockCommandExecutor = {
      execute: async () => {
        gateAttempts++;
        return {
          command: 'exit 1',
          exitCode: 1,
          stdout: '',
          stderr: 'Test failed',
          combinedOutput: 'Test failed',
          durationMs: 10,
          timedOut: false
        };
      }
    };

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: mockStateRepo as any,
      configRepo: mockConfigRepo as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: mockCommandExecutor as any,
      buildDetector: mockBuildDetector as any
    });

    await assert.rejects(
      async () => {
        await lifecycle.execute({
          mode: MODE_YOLO,
          issue: 212,
          skipPrompt: true,
          workspaceDir: tempDir
        });
      },
      (err: any) => {
        assert.ok(err instanceof CircuitBreakerTrippedError);
        assert.strictEqual(err.breaker, 'qualityGateRetries');
        assert.strictEqual(err.action, CB_ACTION_ABORT);
        assert.strictEqual(err.limit, 1);
        return true;
      }
    );

    assert.strictEqual(gateAttempts, 1);
  });

  test('RunLifecycleUseCase pauses for human when actionOnTrip is pause_for_human', async () => {
    let currentState: any = {
      issue: 212,
      currentStage: STAGE_QUALITY_GATE,
      mode: MODE_YOLO,
      history: []
    };

    const mockStateRepo = {
      load: async () => currentState,
      save: async (state: any) => {
        currentState = state;
      },
      reset: async () => {},
      getStateFilePath: () => path.join(tempDir, 'state.json')
    };

    const mockConfigRepo = {
      loadConfig: () => ({
        ...DEFAULT_CONFIG,
        circuitBreakers: {
          ...DEFAULT_CONFIG.circuitBreakers,
          maxGateRetries: 1,
          actionOnTrip: CB_ACTION_PAUSE_FOR_HUMAN
        }
      }),
      resolveModel: () => ({ role: 'gate', tier: 'flash_lite', apiModel: 'gemini-3.5-flash-lite' }),
      mapModelToTier: () => 'flash_lite'
    };

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
      detect: () => ({
        ecosystem: 'node',
        commands: [
          { id: 'test', label: 'Test', command: 'exit 1' }
        ]
      }),
      resolveCommands: () => [
        { id: 'test', label: 'Test', command: 'exit 1' }
      ]
    };

    const mockCommandExecutor = {
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

    const lifecycle = new RunLifecycleUseCase({
      stateRepo: mockStateRepo as any,
      configRepo: mockConfigRepo as any,
      planGenerator: mockPlanGenerator as any,
      commandExecutor: mockCommandExecutor as any,
      buildDetector: mockBuildDetector as any
    });

    const result = await lifecycle.execute({
      mode: MODE_YOLO,
      issue: 212,
      skipPrompt: true,
      workspaceDir: tempDir
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.message?.includes("Circuit breaker 'qualityGateRetries' tripped"));
  });
});
