const { test, describe, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FileStateRepository } = require('../../dist/infrastructure/file-state-repository');
const { StateStorageError } = require('../../dist/domain');

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
                 err.message === 'State mutation is forbidden within smoke test isolation directories';
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
               err.message === 'State mutation is forbidden within smoke test isolation directories';
      });
    });

    test('throws StateStorageError on reset when cwd is in artifacts/smoke', () => {
      process.cwd = () => path.join('/path/to', 'artifacts', 'smoke-123');
      const repo = new FileStateRepository({ stateFilePath: stateFile });
      
      assert.throws(() => {
        repo.reset();
      }, (err: any) => {
        return err instanceof StateStorageError && 
               err.message === 'State mutation is forbidden within smoke test isolation directories';
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
});
