/**
 * agyloop - ResetPipelineUseCase Tests
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  ResetPipelineUseCase
} = require('../../dist/application');

describe('ResetPipelineUseCase', () => {
  let mockStateRepo: any;
  let resetCalls: number;
  let resetTaskCalls: (number | string)[];
  let resetAllCalls: number;

  beforeEach(() => {
    resetCalls = 0;
    resetTaskCalls = [];
    resetAllCalls = 0;

    mockStateRepo = {
      reset: async () => {
        resetCalls++;
      },
      resetTask: async (issue: number | string) => {
        resetTaskCalls.push(issue);
      },
      resetAll: async () => {
        resetAllCalls++;
      }
    };
  });

  test('calls reset() when no specific options provided', async () => {
    const useCase = new ResetPipelineUseCase(mockStateRepo);
    await useCase.execute();

    assert.strictEqual(resetCalls, 1);
    assert.strictEqual(resetTaskCalls.length, 0);
    assert.strictEqual(resetAllCalls, 0);
  });

  test('calls resetTask() when issue option is specified', async () => {
    const useCase = new ResetPipelineUseCase(mockStateRepo);
    await useCase.execute({ issue: 42 });

    assert.strictEqual(resetCalls, 0);
    assert.deepStrictEqual(resetTaskCalls, [42]);
    assert.strictEqual(resetAllCalls, 0);
  });

  test('calls resetAll() when all: true is specified', async () => {
    const useCase = new ResetPipelineUseCase(mockStateRepo);
    await useCase.execute({ all: true });

    assert.strictEqual(resetCalls, 0);
    assert.strictEqual(resetTaskCalls.length, 0);
    assert.strictEqual(resetAllCalls, 1);
  });
});
