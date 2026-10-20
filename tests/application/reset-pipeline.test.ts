/**
 * agyloop - ResetPipelineUseCase Tests
 *
 * Issue #250 (AC B4): a reset must REPORT what it actually did. The use case
 * used to return a bare `StateMachine`, so the caller had no way to tell
 * "cleared the checkpoint" from "there was no checkpoint to clear" — and the
 * CLI printed an unconditional success line for both.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  ResetPipelineUseCase
} = require('../../dist/application');
const { ValidationError } = require('../../dist/domain');

describe('ResetPipelineUseCase', () => {
  let mockStateRepo: any;
  let resetCalls: number;
  let resetTaskCalls: number[];
  let resetAllCalls: number;
  /** What `resetTask` reports: `true` = a file was removed, `false` = none. */
  let resetTaskOutcome: boolean;

  beforeEach(() => {
    resetCalls = 0;
    resetTaskCalls = [];
    resetAllCalls = 0;
    resetTaskOutcome = true;

    mockStateRepo = {
      reset: async () => {
        resetCalls++;
      },
      resetTask: async (issue: number) => {
        resetTaskCalls.push(issue);
        return resetTaskOutcome;
      },
      resetAll: async () => {
        resetAllCalls++;
      },
      getStateFilePath: () => '/mock/.agyloop/state.json',
      forIssue: (issue: number) => ({
        load: async () => ({ version: '1.0.0', currentStage: 'PLAN', issue, history: [] }),
        save: async () => undefined,
        reset: async () => undefined,
        getStateFilePath: () => `/mock/.agyloop/tasks/${issue}.json`
      })
    };
  });

  test('calls reset() when no specific options provided', async () => {
    const useCase = new ResetPipelineUseCase(mockStateRepo);
    const result = await useCase.execute();

    assert.strictEqual(resetCalls, 1);
    assert.strictEqual(resetTaskCalls.length, 0);
    assert.strictEqual(resetAllCalls, 0);
    assert.strictEqual(result.scope, 'root');
    assert.strictEqual(result.issue, null);
    assert.strictEqual(result.removed, true);
  });

  test('calls resetTask() when issue option is specified', async () => {
    const useCase = new ResetPipelineUseCase(mockStateRepo);
    const result = await useCase.execute({ issue: 42 });

    assert.strictEqual(resetCalls, 0);
    assert.deepStrictEqual(resetTaskCalls, [42]);
    assert.strictEqual(resetAllCalls, 0);
    assert.strictEqual(result.scope, 'task');
    assert.strictEqual(result.issue, 42);
    assert.strictEqual(result.removed, true);
    assert.strictEqual(result.path, '/mock/.agyloop/tasks/42.json');
  });

  test('calls resetAll() when all: true is specified', async () => {
    const useCase = new ResetPipelineUseCase(mockStateRepo);
    const result = await useCase.execute({ all: true });

    assert.strictEqual(resetCalls, 0);
    assert.strictEqual(resetTaskCalls.length, 0);
    assert.strictEqual(resetAllCalls, 1);
    assert.strictEqual(result.scope, 'all');
    assert.strictEqual(result.issue, null);
  });

  test('reports removed === false when the adapter removed nothing (AC B4)', async () => {
    resetTaskOutcome = false;
    const useCase = new ResetPipelineUseCase(mockStateRepo);
    const result = await useCase.execute({ issue: 42 });

    assert.strictEqual(result.removed, false, 'a reset that removed nothing must say so');
    assert.strictEqual(result.scope, 'task');
  });

  test('falls back to an existence probe when a legacy adapter returns undefined', async () => {
    mockStateRepo.resetTask = async () => undefined;
    const useCase = new ResetPipelineUseCase(mockStateRepo);
    const result = await useCase.execute({ issue: 42 });

    assert.strictEqual(result.removed, true, 'the probe found tasks/42.json');
  });

  test('rejects an invalid issue token instead of building a garbage filename', async () => {
    const useCase = new ResetPipelineUseCase(mockStateRepo);

    await assert.rejects(
      useCase.execute({ issue: '999abc' }),
      (err: unknown) => err instanceof ValidationError
    );
    assert.strictEqual(resetTaskCalls.length, 0, 'nothing may be reset for a rejected token');
    assert.strictEqual(resetCalls, 0);
  });
});
