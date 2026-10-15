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

    // The following cases pin the guard as fail-closed: a state path is mutable
    // only when it can be PROVEN to live inside the OS temp sandbox and to not be
    // this package's own workspace root. They use synthetic, explicit paths rather
    // than a cwd- or __dirname-derived root, so they assert the same property no
    // matter where the checkout lives (a checkout under /tmp used to make them
    // fail, because tmpdir membership alone certified the real state file).
    describe('fail-closed isolation proof', () => {
      // A root that is intentionally outside os.tmpdir() and does not exist on disk.
      const REAL_ROOT = path.join(path.sep, 'agyloop-unprovable-workspace-root');
      const REAL_STATE_FILE = path.join(REAL_ROOT, '.agyloop', 'state.json');

      const withEnv = (env: Record<string, string | undefined>, fn: () => void): void => {
        const prevEnv = process.env.NODE_ENV;
        const prevCtx = process.env.NODE_TEST_CONTEXT;
        for (const key of ['NODE_ENV', 'NODE_TEST_CONTEXT']) {
          delete process.env[key];
        }
        Object.assign(process.env, env);
        try {
          fn();
        } finally {
          if (prevEnv === undefined) {
            delete process.env.NODE_ENV;
          } else {
            process.env.NODE_ENV = prevEnv;
          }
          if (prevCtx === undefined) {
            delete process.env.NODE_TEST_CONTEXT;
          } else {
            process.env.NODE_TEST_CONTEXT = prevCtx;
          }
        }
      };

      const isRootStateError = (err: any) =>
        err instanceof StateStorageError && err.message === MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE;

      test('refuses a non-temp state path when NODE_ENV === "test"', () => {
        withEnv({ NODE_ENV: 'test' }, () => {
          const repo = new FileStateRepository({ stateFilePath: REAL_STATE_FILE });
          assert.throws(() => repo.save({ issue: 123, currentStage: 'PLAN', history: [] }), isRootStateError);
          assert.throws(() => repo.reset(), isRootStateError);
        });
      });

      test('refuses a non-temp state path when only NODE_TEST_CONTEXT is set', () => {
        withEnv({ NODE_TEST_CONTEXT: 'child-v8' }, () => {
          const repo = new FileStateRepository({ stateFilePath: REAL_STATE_FILE });
          assert.throws(() => repo.save({ issue: 123, currentStage: 'PLAN', history: [] }), isRootStateError);
          assert.throws(() => repo.reset(), isRootStateError);
        });
      });

      test('still allows mutation when the state path is provably inside the temp sandbox', () => {
        withEnv({ NODE_TEST_CONTEXT: 'child-v8' }, () => {
          // Neutral cwd so the unrelated worktree-issue guard stays out of the way.
          process.cwd = () => path.join('/mock', 'repo', 'root');
          const repo = new FileStateRepository({ stateFilePath: stateFile });
          assert.strictEqual(path.resolve(stateFile).startsWith(path.resolve(os.tmpdir()) + path.sep), true);
          assert.doesNotThrow(() => repo.save({ issue: 123, currentStage: 'PLAN', history: [] }));
          assert.strictEqual(fs.existsSync(stateFile), true);
          assert.doesNotThrow(() => repo.reset());
          assert.strictEqual(fs.existsSync(stateFile), false);
        });
      });

      test('refuses when git workspace discovery is unavailable so isolation cannot be proven', () => {
        // Regression: the guard used to compare stateFilePath against a second,
        // independent workspace-root resolution. With git broken (container with a
        // .git indirection pointing outside the mount, CI tarball, broken worktree
        // gitdir) the two resolutions diverged and the guard disabled itself.
        const childProcess = require('child_process');
        const originalExecSync = childProcess.execSync;
        childProcess.execSync = () => {
          throw new Error('git unavailable in this environment');
        };

        try {
          withEnv({ NODE_ENV: 'test' }, () => {
            process.cwd = () => REAL_ROOT;
            FileStateRepository.clearWorkspaceRootCache();
            const repo = new FileStateRepository({ stateFilePath: REAL_STATE_FILE });
            assert.throws(() => repo.save({ issue: 123, currentStage: 'PLAN', history: [] }), isRootStateError);
            assert.throws(() => repo.reset(), isRootStateError);
          });
        } finally {
          childProcess.execSync = originalExecSync;
        }
      });

      test('resetAll and resetTask refuse a real workspace even when the state file itself is temp-isolated', () => {
        // Regression: resetAll()/resetTask() delete files derived from workspaceRoot,
        // not from stateFilePath, so guarding only stateFilePath left the real
        // .agyloop/state.json and .agyloop/tasks/*.json reachable.
        withEnv({ NODE_ENV: 'test' }, () => {
          process.cwd = () => REAL_ROOT;
          FileStateRepository.clearWorkspaceRootCache();
          const repo = new FileStateRepository({ stateFilePath: stateFile });
          assert.throws(() => repo.resetAll(), isRootStateError);
          assert.throws(() => repo.resetTask(123), isRootStateError);
        });
      });

      test('resetAll and resetTask remain allowed when the whole workspace is temp-isolated', () => {
        withEnv({ NODE_ENV: 'test' }, () => {
          const repo = new FileStateRepository({ workspaceDir: tempDir });
          fs.mkdirSync(path.join(tempDir, '.agyloop', 'tasks'), { recursive: true });
          fs.writeFileSync(path.join(tempDir, '.agyloop', 'tasks', '10.json'), JSON.stringify({ issue: 10 }));
          assert.doesNotThrow(() => repo.resetTask(10));
          assert.strictEqual(fs.existsSync(path.join(tempDir, '.agyloop', 'tasks', '10.json')), false);
          assert.doesNotThrow(() => repo.resetAll());
        });
      });

      test('refuses a temp-resident path that is this package workspace root', () => {
        // Regression: tmpdir membership alone is not proof of isolation. When the
        // repository itself is checked out under the OS temp dir (or TMPDIR is an
        // ancestor of it), its own .agyloop/state.json satisfies the tmpdir test and
        // would re-open the guard -- the exact failure this predicate exists to kill.
        // Here git is made to report a temp sandbox as this package's workspace root.
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-temp-repo-'));
        const repoStateFile = path.join(repoRoot, '.agyloop', 'state.json');
        const childProcess = require('child_process');
        const originalExecSync = childProcess.execSync;
        childProcess.execSync = (cmd: string) => {
          if (String(cmd).includes('worktree list --porcelain')) {
            return `worktree ${repoRoot}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n`;
          }
          throw new Error(`unexpected git invocation in this test: ${cmd}`);
        };

        try {
          withEnv({ NODE_ENV: 'test' }, () => {
            FileStateRepository.clearWorkspaceRootCache();
            const repo = new FileStateRepository({ stateFilePath: repoStateFile });
            assert.throws(() => repo.save({ issue: 123, currentStage: 'PLAN', history: [] }), isRootStateError);
            assert.throws(() => repo.reset(), isRootStateError);

            // The workspace root itself is protected too, not just its state file:
            // resetAll()/resetTask() delete targets derived from workspaceRoot.
            const rootedRepo = new FileStateRepository({
              workspaceDir: repoRoot,
              stateFilePath: path.join(repoRoot, 'unrelated.json')
            });
            assert.throws(() => rootedRepo.resetAll(), isRootStateError);
            assert.throws(() => rootedRepo.resetTask(123), isRootStateError);
          });
        } finally {
          childProcess.execSync = originalExecSync;
          FileStateRepository.clearWorkspaceRootCache();
          fs.rmSync(repoRoot, { recursive: true, force: true });
        }

        // The veto must stay narrow: a different sandbox under the same temp root is
        // still writable, so ordinary temp-based tests are unaffected by it.
        withEnv({ NODE_TEST_CONTEXT: 'child-v8' }, () => {
          process.cwd = () => path.join('/mock', 'repo', 'root');
          const repo = new FileStateRepository({ stateFilePath: stateFile });
          assert.doesNotThrow(() => repo.save({ issue: 123, currentStage: 'PLAN', history: [] }));
          assert.strictEqual(fs.existsSync(stateFile), true);
        });
      });
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

    test('resetTask removes specific task state file without touching root or other tasks', () => {
      const repo = new FileStateRepository({ workspaceDir: tempDir });
      fs.mkdirSync(path.join(tempDir, '.agyloop', 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, '.agyloop', 'state.json'), JSON.stringify({ issue: null }));
      fs.writeFileSync(path.join(tempDir, '.agyloop', 'tasks', '10.json'), JSON.stringify({ issue: 10 }));
      fs.writeFileSync(path.join(tempDir, '.agyloop', 'tasks', '20.json'), JSON.stringify({ issue: 20 }));

      repo.resetTask(10);
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.agyloop', 'tasks', '10.json')), false);
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.agyloop', 'tasks', '20.json')), true);
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.agyloop', 'state.json')), true);
    });

    test('resetAll purges all task files and resets root state', () => {
      const repo = new FileStateRepository({ workspaceDir: tempDir });
      fs.mkdirSync(path.join(tempDir, '.agyloop', 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, '.agyloop', 'state.json'), JSON.stringify({ issue: null }));
      fs.writeFileSync(path.join(tempDir, '.agyloop', 'tasks', '10.json'), JSON.stringify({ issue: 10 }));
      fs.writeFileSync(path.join(tempDir, '.agyloop', 'tasks', '20.json'), JSON.stringify({ issue: 20 }));

      repo.resetAll();
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.agyloop', 'tasks', '10.json')), false);
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.agyloop', 'tasks', '20.json')), false);
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.agyloop', 'state.json')), false);
    });
  });
});
