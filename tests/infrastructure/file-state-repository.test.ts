const { test, describe, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FileStateRepository } = require('../../dist/infrastructure/file-state-repository');
const { StateStorageError, MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST, MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE } = require('../../dist/domain');

describe('FileStateRepository', () => {
  let originalCwd: () => string;
  let tempDir: string;
  let stateFile: string;

  before(() => {
    originalCwd = process.cwd;
  });

  after(() => {
    process.cwd = originalCwd;
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-'));
    stateFile = path.join(tempDir, '.agyloop', 'state.json');
    FileStateRepository.clearWorkspaceRootCache();
  });

  afterEach(() => {
    process.cwd = originalCwd;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('cross-issue state initialization from within worktrees', () => {
    test('throws StateStorageError when trying to save a mismatched issue inside a worktree', () => {
      // Stub process.cwd() to simulate being inside a worktree for issue 169
      const dummyWorktreePath = path.join('/', 'home', 'ajxcodes', 'code', 'agyloop', '.worktrees', '169');
      process.cwd = () => dummyWorktreePath;

      const repo = new FileStateRepository({ stateFilePath: stateFile });

      const snapshot = {
        issue: 999,
        currentStage: 'PLAN',
        history: [],
      };

      assert.throws(() => {
        repo.save(snapshot);
      }, (err: any) => {
        return err instanceof StateStorageError && 
               err.message === 'Cannot save state for issue 999 from inside worktree for issue 169. Use read-only commands inside worktrees.';
      });
    });

    test('allows legitimate save when issue matches inferred worktree issue', () => {
      // Stub process.cwd() to simulate being inside a worktree for issue 169
      const dummyWorktreePath = path.join('/', 'home', 'ajxcodes', 'code', 'agyloop', '.worktrees', '169');
      process.cwd = () => dummyWorktreePath;

      const repo = new FileStateRepository({ stateFilePath: stateFile });

      const snapshot = {
        issue: 169,
        currentStage: 'PLAN',
        history: [],
      };

      assert.doesNotThrow(() => {
        repo.save(snapshot);
      });
      assert.ok(fs.existsSync(stateFile));
    });
  });

  describe('smoke test isolation', () => {
    test('throws StateStorageError on save when cwd is in /tmp', () => {
      process.cwd = () => path.join('/tmp', 'foo');
      const repo = new FileStateRepository({ stateFilePath: stateFile });
      
      const prevEnv = process.env.NODE_ENV;
      const prevTestCtx = process.env.NODE_TEST_CONTEXT;
      process.env.NODE_ENV = 'production';
      delete process.env.NODE_TEST_CONTEXT;
      try {
        assert.throws(() => {
          repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
        }, (err: any) => {
          return err instanceof StateStorageError && 
                 err.message === MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST;
        });
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevTestCtx !== undefined) {
          process.env.NODE_TEST_CONTEXT = prevTestCtx;
        }
      }
    });

    test('throws StateStorageError on save when cwd is in artifacts/smoke', () => {
      process.cwd = () => path.join('/path/to', 'artifacts', 'smoke-123');
      const repo = new FileStateRepository({ stateFilePath: stateFile });
      
      assert.throws(() => {
        repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
      }, (err: any) => {
        return err instanceof StateStorageError && 
               err.message === MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST;
      });
    });

    test('throws StateStorageError on reset when cwd is in artifacts/smoke', () => {
      process.cwd = () => path.join('/path/to', 'artifacts', 'smoke-123');
      const repo = new FileStateRepository({ stateFilePath: stateFile });
      
      assert.throws(() => {
        repo.reset();
      }, (err: any) => {
        return err instanceof StateStorageError && 
               err.message === MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST;
      });
    });

    test('allows save when cwd is normal path', () => {
      process.cwd = () => path.join('/home/user/project');
      const repo = new FileStateRepository({ stateFilePath: stateFile });
      
      assert.doesNotThrow(() => {
        repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
      });
    });
  });

  describe('test environment isolation', () => {
    test('throws StateStorageError on reset and save when touching real root repo in test env', () => {
      // By not providing stateFilePath, it will default to the real root repo
      const repo = new FileStateRepository();
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      try {
        assert.throws(() => {
          repo.reset();
        }, (err: any) => {
          return err instanceof StateStorageError && 
                 err.message === MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE;
        });

        assert.throws(() => {
          repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
        }, (err: any) => {
          return err instanceof StateStorageError && 
                 err.message === MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE;
        });
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    test('throws StateStorageError on reset and save when NODE_TEST_CONTEXT is set and NODE_ENV is undefined', () => {
      const repo = new FileStateRepository();
      const prevEnv = process.env.NODE_ENV;
      const prevTestCtx = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_ENV;
      process.env.NODE_TEST_CONTEXT = 'true';
      try {
        assert.throws(() => {
          repo.reset();
        }, (err: any) => {
          return err instanceof StateStorageError && 
                 err.message === MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE;
        });

        assert.throws(() => {
          repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
        }, (err: any) => {
          return err instanceof StateStorageError && 
                 err.message === MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE;
        });
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevTestCtx !== undefined) {
          process.env.NODE_TEST_CONTEXT = prevTestCtx;
        } else {
          delete process.env.NODE_TEST_CONTEXT;
        }
      }
    });

    test('allows reset and save with a mock temp path even if NODE_ENV === "test"', () => {
      const repo = new FileStateRepository({ stateFilePath: stateFile });
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      process.cwd = () => '/';
      try {
        assert.doesNotThrow(() => {
          repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
        });
        assert.doesNotThrow(() => {
          repo.reset();
        });
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });
  });

  describe('task scoping and multi-state management', () => {
    test('routes to .agyloop/tasks/<issue>.json when issue is provided', () => {
      process.cwd = () => path.join('/home/user/project');
      const repo = new FileStateRepository({ workspaceDir: tempDir, issue: 56 });
      const expectedPath = path.join(tempDir, '.agyloop', 'tasks', '56.json');
      assert.strictEqual(repo.getStateFilePath(), expectedPath);

      repo.save({ issue: 56, currentStage: 'PLAN', history: [] } as any);
      assert.ok(fs.existsSync(expectedPath));

      const loaded = repo.load();
      assert.strictEqual(loaded?.issue, 56);
      assert.strictEqual(loaded?.currentStage, 'PLAN');
    });

    test('listAllStates reads root state and multiple task states, ignoring corrupt JSON and non-JSON files', () => {
      const repo = new FileStateRepository({ workspaceDir: tempDir });

      // Save root state
      fs.mkdirSync(path.join(tempDir, '.agyloop', 'tasks'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.agyloop', 'state.json'),
        JSON.stringify({ issue: null, currentStage: 'INITIALIZED', history: [] })
      );

      // Save task states
      fs.writeFileSync(
        path.join(tempDir, '.agyloop', 'tasks', '10.json'),
        JSON.stringify({ issue: 10, currentStage: 'DISCOVERY', history: [] })
      );
      fs.writeFileSync(
        path.join(tempDir, '.agyloop', 'tasks', '20.json'),
        JSON.stringify({ issue: 20, currentStage: 'IMPLEMENT', history: [] })
      );

      // Add invalid files (corrupt JSON, non-json file)
      fs.writeFileSync(path.join(tempDir, '.agyloop', 'tasks', 'corrupt.json'), 'invalid json{{{');
      fs.writeFileSync(path.join(tempDir, '.agyloop', 'tasks', 'notes.txt'), 'random text');

      const states = repo.listAllStates();
      assert.strictEqual(states.length, 3);

      const stages = states.map((s: any) => s.currentStage).sort();
      assert.deepStrictEqual(stages, ['DISCOVERY', 'IMPLEMENT', 'INITIALIZED']);
    });
  });
});
