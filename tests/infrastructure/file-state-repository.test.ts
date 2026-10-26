const { test, describe, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FileStateRepository } = require('../../dist/infrastructure/file-state-repository');
const { StateStorageError, ValidationError, MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST, MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE } = require('../../dist/domain');

describe('FileStateRepository', () => {
  let originalCwd: () => string;
  let tempDir: string;
  let stateFile: string;

  // The package's real workspace root, resolved from THIS FILE rather than
  // from the process cwd, so the "real root" refusals hold when the suite runs
  // from `.worktrees/<n>` (issue #298).
  const REPO_ROOT = path.resolve(__dirname, '../..');

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

      const repo = new FileStateRepository({
        stateFilePath: stateFile,
        allowWorktreeIssueMismatch: false
      });

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
    /**
     * Runs `fn` with an explicit environment, restoring every key afterwards.
     * `HOME` is overridden because the guard's sandbox is `os.homedir()`-anchored.
     */
    const withSmokeEnv = (
      env: Record<string, string | undefined>,
      fn: () => void
    ): void => {
      const keys = ['NODE_ENV', 'NODE_TEST_CONTEXT', 'HOME'];
      const previous = new Map<string, string | undefined>();
      for (const key of keys) {
        previous.set(key, process.env[key]);
        delete process.env[key];
      }
      Object.assign(process.env, env);
      try {
        fn();
      } finally {
        for (const key of keys) {
          const value = previous.get(key);
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    };

    const isSmokeError = (err: any) =>
      err instanceof StateStorageError && err.message === MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST;

    test('SR1: permits the tool\'s own sandbox path', () => {
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-home-'));
      const sandbox = path.join(fakeHome, '.cache', 'agyloop', 'smoke-241');
      fs.mkdirSync(sandbox, { recursive: true });

      try {
        withSmokeEnv({ HOME: fakeHome, NODE_ENV: 'production' }, () => {
          process.cwd = () => sandbox;
          const repo = new FileStateRepository({
            stateFilePath: path.join(sandbox, '.agyloop', 'state.json')
          });
          assert.doesNotThrow(() =>
            repo.save({ issue: 241, currentStage: 'DISCOVERY', history: [] })
          );
        });
      } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    test('SR2: refuses a /tmp state path outside test mode (unchanged)', () => {
      process.cwd = () => path.join('/tmp', 'foo');
      const repo = new FileStateRepository({ stateFilePath: stateFile });

      withSmokeEnv({ NODE_ENV: 'production' }, () => {
        assert.throws(() => {
          repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
        }, isSmokeError);
      });
    });

    test('SR3a: refuses artifacts/smoke outside test mode', () => {
      process.cwd = () => path.join('/path/to', 'artifacts', 'smoke-123');
      const repo = new FileStateRepository({ stateFilePath: stateFile });

      withSmokeEnv({ NODE_ENV: 'production' }, () => {
        assert.throws(() => {
          repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
        }, isSmokeError);

        assert.throws(() => {
          repo.reset();
        }, isSmokeError);
      });
    });

    test('SR3b: permits artifacts/smoke inside test mode under the same rule as /tmp (N3)', () => {
      process.cwd = () => path.join('/path/to', 'artifacts', 'smoke-123');
      const repo = new FileStateRepository({ stateFilePath: stateFile });

      withSmokeEnv({ NODE_ENV: 'test' }, () => {
        assert.doesNotThrow(() => {
          repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
        });
      });
    });

    test('SR4: refuses a /tmp target even when cwd is outside /tmp (target-keyed)', () => {
      process.cwd = () => path.join('/home', 'user', 'project');
      const tmpSandboxState = path.join(os.tmpdir(), 'smoke-241', '.agyloop', 'state.json');
      const repo = new FileStateRepository({ stateFilePath: tmpSandboxState });

      withSmokeEnv({ NODE_ENV: 'production' }, () => {
        assert.throws(() => {
          repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
        }, isSmokeError);
      });
    });

    test('SR5: a sandbox cwd cannot reach a target outside the sandbox', () => {
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-home-'));
      const sandbox = path.join(fakeHome, '.cache', 'agyloop', 'smoke-241');
      fs.mkdirSync(sandbox, { recursive: true });
      const external = path.join(fakeHome, 'project', '.agyloop', 'state.json');

      try {
        withSmokeEnv({ HOME: fakeHome, NODE_ENV: 'production' }, () => {
          process.cwd = () => sandbox;
          const repo = new FileStateRepository({ stateFilePath: external });
          assert.throws(() => {
            repo.save({ issue: 123, currentStage: 'PLAN', history: [] });
          }, isSmokeError);
        });
      } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    test('SR6: still refuses the real root state under test mode', () => {
      withSmokeEnv({ NODE_ENV: 'test' }, () => {
        const repo = new FileStateRepository({
          workspaceDir: REPO_ROOT,
          stateFilePath: path.join(REPO_ROOT, '.agyloop', 'state.json')
        });
        assert.throws(() => {
          repo.reset();
        }, (err: any) => err instanceof StateStorageError && err.message === MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE);
      });
    });

    test('SR7: a symlinked alias of the sandbox is still recognised', () => {
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-home-'));
      const sandbox = path.join(fakeHome, '.cache', 'agyloop', 'smoke-241');
      const alias = path.join(fakeHome, 'sandbox-alias');
      fs.mkdirSync(sandbox, { recursive: true });
      fs.symlinkSync(sandbox, alias, 'dir');

      try {
        withSmokeEnv({ HOME: fakeHome, NODE_ENV: 'production' }, () => {
          process.cwd = () => alias;
          const repo = new FileStateRepository({
            stateFilePath: path.join(alias, '.agyloop', 'state.json')
          });
          assert.doesNotThrow(() =>
            repo.save({ issue: 241, currentStage: 'DISCOVERY', history: [] })
          );
        });
      } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
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
      // Explicit root: the probe must not depend on the process cwd (#298).
      const repo = new FileStateRepository({
        workspaceDir: REPO_ROOT,
        stateFilePath: path.join(REPO_ROOT, '.agyloop', 'state.json')
      });
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
      const repo = new FileStateRepository({
        workspaceDir: REPO_ROOT,
        stateFilePath: path.join(REPO_ROOT, '.agyloop', 'state.json')
      });
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
          // git rev-parse --show-toplevel is the adapter's workspace-root probe (#244);
          // `worktree list --porcelain` is no longer consulted for state location.
          if (String(cmd).includes('rev-parse --show-toplevel')) {
            return `${repoRoot}\n`;
          }
          if (String(cmd).includes('rev-parse --path-format=absolute --git-common-dir')) {
            return `${path.join(repoRoot, '.git')}\n`;
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

    test('a snapshot carrying a triageDisposition survives save -> load byte-for-byte (issue #269)', () => {
      process.cwd = () => path.join('/home/user/project');
      const repo = new FileStateRepository({ workspaceDir: tempDir, issue: 269 });

      const disposition = {
        prNumber: 7,
        action: 'completed',
        recordedAt: '2026-10-21T12:00:00.000Z',
        feedbackKeys: ['id:101', 'id:102']
      };

      repo.save({
        issue: 269,
        currentStage: 'COMPLETED',
        history: [],
        triageDisposition: disposition
      } as any);

      const loaded = repo.load();
      assert.ok(loaded, 'the checkpoint must be readable');
      assert.deepStrictEqual(
        (loaded as any).triageDisposition,
        disposition,
        'the recorded triage disposition must survive the file round-trip unchanged'
      );
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

    test('forIssue returns a repository bound to the task checkpoint', () => {
      const repo = new FileStateRepository({ workspaceDir: tempDir });

      const scoped = repo.forIssue(226);

      assert.strictEqual(scoped.getStateFilePath(), path.join(tempDir, '.agyloop', 'tasks', '226.json'));
    });

    test('forIssue accepts a numeric string and stays workspace-root-relative', () => {
      // A repository already bound to tasks/9.json must hand back the same
      // workspaceRoot-scoped path, NOT one re-derived from process.cwd(): the
      // checkpoint a caller is reading cannot move because the process changed
      // directory between the read and the write (#226 D6).
      process.cwd = () => path.join('/home/user/project');
      const repo = new FileStateRepository({ workspaceDir: tempDir, issue: 9 });

      const scoped = repo.forIssue('226');

      assert.strictEqual(scoped.getStateFilePath(), path.join(tempDir, '.agyloop', 'tasks', '226.json'));
    });

    test('forIssue writes nothing to disk merely by being called', () => {
      // The resolver calls this before it knows whether anything will be written,
      // so a resolver call must never be able to create a workspace.
      const virgin = path.join(os.tmpdir(), `agyloop-fsrepo-forthissue-${process.pid}-${Date.now()}`);
      const repo = new FileStateRepository({ workspaceDir: virgin });

      const scoped = repo.forIssue(226);

      assert.strictEqual(scoped.getStateFilePath(), path.join(virgin, '.agyloop', 'tasks', '226.json'));
      assert.ok(!fs.existsSync(virgin), 'forIssue must not create the workspace');
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

    /**
     * Issue #250: the adapter must be honest about what it removed, and the
     * filename it removes must come from a STRICTLY parsed number — a raw
     * token used to reach the template and produce `tasks/999abc.json`.
     */
    describe('issue #250: strict issue tokens and honest removal', () => {
      test('forIssue rejects a non-numeric argument instead of producing tasks/NaN.json', () => {
        const repo = new FileStateRepository({ workspaceDir: tempDir });

        assert.throws(() => repo.forIssue('abc'), ValidationError);
        assert.throws(() => repo.forIssue('999abc'), ValidationError);
        assert.throws(() => repo.forIssue(Number.NaN), ValidationError);
        assert.throws(() => repo.forIssue(-1), ValidationError);
        assert.throws(() => repo.forIssue(0), ValidationError);
      });

      test('forIssue still accepts a numeric string (the port keeps number | string)', () => {
        const repo = new FileStateRepository({ workspaceDir: tempDir });

        const scoped = repo.forIssue('226');

        assert.strictEqual(scoped.getStateFilePath(), path.join(tempDir, '.agyloop', 'tasks', '226.json'));
      });

      test('resetTask reports true when a checkpoint was actually removed', () => {
        const repo = new FileStateRepository({ workspaceDir: tempDir });
        fs.mkdirSync(path.join(tempDir, '.agyloop', 'tasks'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, '.agyloop', 'tasks', '10.json'), JSON.stringify({ issue: 10 }));

        assert.strictEqual(repo.resetTask(10), true);
        assert.strictEqual(fs.existsSync(path.join(tempDir, '.agyloop', 'tasks', '10.json')), false);
      });

      test('resetTask reports false when there was nothing to remove', () => {
        const repo = new FileStateRepository({ workspaceDir: tempDir });

        assert.strictEqual(repo.resetTask(10), false);
      });
    });
  });

  describe('worktree-local workspace root resolution (#244)', () => {
    // Scratch roots created by buildWorktreeFixture. Removing them in afterEach
    // (rather than in each caller's finally) means a failing assertion still
    // cannot leave an `agyloop-wt-244-*` tree behind in the temp sandbox.
    const fixtureDirs: string[] = [];

    afterEach(() => {
      for (const dir of fixtureDirs.splice(0, fixtureDirs.length)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    type WorktreeFixture = { base: string; mainPath: string; worktreePath: string };

    // Builds a scratch main repo + one linked worktree whose `.agyloop` is a REAL
    // directory (NOT the GitWorktreeManager symlink -- a symlinked `.agyloop` would
    // make the main-root and worktree-local paths the same file and the assertions
    // below would pass vacuously).
    //
    // Returns null ONLY when there is no usable git binary. The repo itself is
    // built under os.tmpdir() and is therefore owned by the user running the
    // tests, so git cannot refuse it for the ownership/host-mount reason described
    // in the memoization test in state-machine.test.ts -- which is why no other
    // failure is allowed to skip. A swallowed `worktree add` failure would make
    // AC1/AC3 disappear from CI with no red signal at all.
    const buildWorktreeFixture = (): WorktreeFixture | null => {
      const childProcess = require('child_process');
      try {
        childProcess.execFileSync('git', ['--version'], { stdio: 'ignore' });
      } catch {
        return null;
      }

      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-wt-244-'));
      fixtureDirs.push(base);
      const mainPath = path.join(base, 'repo');
      const worktreePath = path.join(base, 'wt-236');
      fs.mkdirSync(mainPath, { recursive: true });

      try {
        childProcess.execFileSync('git', ['init', '-q', '-b', 'main', mainPath], { stdio: 'ignore' });
        childProcess.execFileSync(
          'git',
          ['-C', mainPath, '-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
          { stdio: 'ignore' }
        );
        childProcess.execFileSync('git', ['-C', mainPath, 'worktree', 'add', '-q', worktreePath, 'HEAD'], { stdio: 'ignore' });
      } catch (err) {
        // Loud by design: the scratch repo is user-owned, so a failure here is a
        // real environment problem, not a reason to skip the acceptance criteria.
        fs.rmSync(base, { recursive: true, force: true });
        fixtureDirs.pop();
        throw err;
      }

      fs.mkdirSync(path.join(worktreePath, '.agyloop', 'tasks'), { recursive: true });
      fs.writeFileSync(
        path.join(worktreePath, '.agyloop', 'tasks', '236.json'),
        JSON.stringify({ issue: 236, currentStage: 'COMPLETED', history: [] })
      );
      return { base, mainPath, worktreePath };
    };

    // `wt-236` deliberately does NOT match IssueNumber.inferFromPath's
    // `\.worktrees[/\\](\d+)` pattern, so an issue-less repository resolves to
    // `<worktree>/.agyloop/state.json` (and `validateWorktreeIssueMatch` stays out
    // of the way) exactly as discovery's smoke harness observed.
    const withWorktreeCwd = (worktreePath: string, fn: () => void): void => {
      const originalCwd = process.cwd;
      process.cwd = () => worktreePath;
      FileStateRepository.clearWorkspaceRootCache();
      try {
        fn();
      } finally {
        process.cwd = originalCwd;
        FileStateRepository.clearWorkspaceRootCache();
      }
    };

    test('resolves and reads state inside the task worktree when a linked worktree exists (AC1)', (t: any) => {
      const fixture = buildWorktreeFixture();
      if (fixture === null) {
        t.skip('git is unavailable in this environment');
        return;
      }
      const { mainPath, worktreePath } = fixture;
      assert.strictEqual(fs.lstatSync(path.join(worktreePath, '.agyloop')).isSymbolicLink(), false);

      withWorktreeCwd(worktreePath, () => {
        const repo = new FileStateRepository({ issue: 236 });
        assert.strictEqual(repo.getStateFilePath(), path.join(worktreePath, '.agyloop', 'tasks', '236.json'));
        assert.notStrictEqual(repo.getStateFilePath(), path.join(mainPath, '.agyloop', 'tasks', '236.json'));

        // Read side: the worktree-local COMPLETED checkpoint must be visible.
        assert.strictEqual(repo.load()?.currentStage, 'COMPLETED');
      });
    });

    test('never consults `git worktree list` when resolving the local workspace root (AC2)', () => {
      const childProcess = require('child_process');
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-wt-244-order-'));
      const localRoot = path.join(base, 'wt-236');
      const mainRoot = path.join(base, 'repo');
      const originalExecSync = childProcess.execSync;

      // Deliberately NON-alpha and with the linked worktree NOT first, so any
      // parse of this listing that assumed git's record ordering would answer
      // `mainRoot` instead of `localRoot`. Nothing must read it at all.
      const worktreeListOutput = [
        mainRoot,
        localRoot,
        path.join(base, 'wt-999'),
      ]
        .map((p) => `worktree ${p}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/x\n`)
        .join('\n');

      const invocations: string[] = [];
      childProcess.execSync = (cmd: string) => {
        const c = String(cmd);
        invocations.push(c);
        if (c.includes('rev-parse --show-toplevel')) {
          return `${localRoot}\n`;
        }
        if (c.includes('worktree list --porcelain')) {
          return worktreeListOutput;
        }
        throw new Error(`unexpected git invocation in this test: ${c}`);
      };

      try {
        const originalCwd = process.cwd;
        process.cwd = () => localRoot;
        FileStateRepository.clearWorkspaceRootCache();
        try {
          const repo = new FileStateRepository({ issue: 7 });
          assert.strictEqual(repo.getStateFilePath(), path.join(localRoot, '.agyloop', 'tasks', '7.json'));
          // AC2, strongest form: nothing that decides where state lands may read
          // the worktree list at all -- which makes the answer independent of
          // the listing's ordering by construction.
          assert.strictEqual(
            invocations.some((c) => c.includes('worktree list')),
            false,
            'workspace root resolution must not consult `git worktree list`'
          );
        } finally {
          process.cwd = originalCwd;
          FileStateRepository.clearWorkspaceRootCache();
        }
      } finally {
        childProcess.execSync = originalExecSync;
        FileStateRepository.clearWorkspaceRootCache();
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    test('an issue-less run from a task worktree cannot create the main root checkpoint (AC3)', (t: any) => {
      const fixture = buildWorktreeFixture();
      if (fixture === null) {
        t.skip('git is unavailable in this environment');
        return;
      }
      const { mainPath, worktreePath } = fixture;
      const rootState = path.join(mainPath, '.agyloop', 'state.json');
      const wtState = path.join(worktreePath, '.agyloop', 'state.json');
      assert.strictEqual(fs.existsSync(rootState), false);

      const prevEnv = process.env.NODE_ENV;
      const prevCtx = process.env.NODE_TEST_CONTEXT;
      process.env.NODE_ENV = 'test';
      process.env.NODE_TEST_CONTEXT = 'child-v8';
      try {
        withWorktreeCwd(worktreePath, () => {
          const repo = new FileStateRepository();
          assert.strictEqual(repo.getStateFilePath(), wtState);
          assert.doesNotThrow(() =>
            repo.save({ issue: null, currentStage: 'INITIALIZED', history: [] } as any)
          );
          assert.strictEqual(fs.existsSync(wtState), true);
          assert.strictEqual(fs.existsSync(rootState), false, 'main root .agyloop/state.json must not be created');
        });
      } finally {
        if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
        if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevCtx;
      }
    });

    test('an issue-less run from a task worktree cannot delete the main root checkpoint (AC3)', (t: any) => {
      const fixture = buildWorktreeFixture();
      if (fixture === null) {
        t.skip('git is unavailable in this environment');
        return;
      }
      const { mainPath, worktreePath } = fixture;
      const rootState = path.join(mainPath, '.agyloop', 'state.json');
      const rootTask = path.join(mainPath, '.agyloop', 'tasks', '236.json');
      fs.mkdirSync(path.dirname(rootTask), { recursive: true });
      fs.writeFileSync(rootState, JSON.stringify({ issue: null, currentStage: 'COMPLETED', history: [] }));
      fs.writeFileSync(rootTask, JSON.stringify({ issue: 236, currentStage: 'COMPLETED', history: [] }));

      const prevEnv = process.env.NODE_ENV;
      const prevCtx = process.env.NODE_TEST_CONTEXT;
      process.env.NODE_ENV = 'test';
      process.env.NODE_TEST_CONTEXT = 'child-v8';
      try {
        withWorktreeCwd(worktreePath, () => {
          const repo = new FileStateRepository();
          assert.doesNotThrow(() => repo.resetAll());
          assert.doesNotThrow(() => repo.resetTask(236));
          // The worktree's own checkpoint is the only thing that may be removed.
          assert.strictEqual(fs.existsSync(rootState), true, 'main root .agyloop/state.json must survive');
          assert.strictEqual(fs.existsSync(rootTask), true, 'main root .agyloop/tasks/236.json must survive');
          assert.strictEqual(fs.existsSync(path.join(worktreePath, '.agyloop', 'tasks', '236.json')), false);
        });
      } finally {
        if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
        if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevCtx;
      }
    });

    test('still refuses the main root when local resolution narrows to a task worktree', () => {
      // Simulates agyloop being installed *inside* a task worktree: the primary
      // probe now narrows to <base>/wt, while the canonical main root is only
      // discoverable via `git rev-parse --path-format=absolute --git-common-dir`.
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-wt-244-veto-'));
      const narrowedRoot = path.join(base, 'wt');
      const mainRoot = path.join(base, 'repo');
      const mainStateFile = path.join(mainRoot, '.agyloop', 'state.json');
      const childProcess = require('child_process');
      const originalExecSync = childProcess.execSync;
      const isRootStateError = (err: any) =>
        err instanceof StateStorageError && err.message === MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE;

      childProcess.execSync = (cmd: string) => {
        const c = String(cmd);
        if (c.includes('rev-parse --show-toplevel')) return `${narrowedRoot}\n`;
        if (c.includes('rev-parse --path-format=absolute --git-common-dir')) return `${path.join(mainRoot, '.git')}\n`;
        throw new Error(`unexpected git invocation in this test: ${c}`);
      };

      const prevEnv = process.env.NODE_ENV;
      const prevCtx = process.env.NODE_TEST_CONTEXT;
      process.env.NODE_ENV = 'test';
      process.env.NODE_TEST_CONTEXT = 'child-v8';
      try {
        FileStateRepository.clearWorkspaceRootCache();
        const repo = new FileStateRepository({ stateFilePath: mainStateFile });
        assert.throws(() => repo.save({ issue: 123, currentStage: 'PLAN', history: [] } as any), isRootStateError);
        assert.throws(() => repo.reset(), isRootStateError);
      } finally {
        if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
        if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevCtx;
        childProcess.execSync = originalExecSync;
        FileStateRepository.clearWorkspaceRootCache();
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    test('never trusts or caches malformed `--git-common-dir` output (git < 2.31 echoes the unknown option)', () => {
      // `--path-format` landed in git 2.31. Older git does NOT reject an unknown
      // `--flag=value`: it echoes the argument back onto stdout and exits 0, so
      // execSync does not throw and the probe looks successful:
      //   $ git rev-parse --some-unknown-flag=absolute --git-common-dir
      //   --some-unknown-flag=absolute
      //   /repo/.git
      // Pinning this exact shape is the whole point: the resolver must treat it
      // as a failed probe (fall back to __dirname, uncached) instead of feeding a
      // two-line string to path.resolve, which resolves against process.cwd() --
      // not the `cwd:` option -- and would cache that garbage root for the
      // process lifetime, silently deleting the main-worktree-root veto.
      const childProcess = require('child_process');
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-wt-244-echo-'));
      fixtureDirs.push(base);
      const narrowedRoot = path.join(base, 'wt');
      const commonDir = path.join(base, 'repo', '.git');
      const echoedOutput = `--path-format=absolute\n${commonDir}\n`;
      const originalExecSync = childProcess.execSync;

      const originalCwd = process.cwd;
      process.cwd = () => base;

      // What the pre-fix resolver derived from that output: `path.resolve` treats
      // the whole two-line string as one component, so this is
      // `<cwd>/--path-format=absolute\n<base>/repo` -- a path under the temp
      // sandbox, i.e. one that would pass condition 1 and then be vetoed forever.
      const garbageRoot = path.dirname(path.resolve(echoedOutput.trim()));
      const garbageStateFile = path.join(garbageRoot, '.agyloop', 'state.json');
      const unrelatedStateFile = path.join(base, 'unrelated', '.agyloop', 'state.json');

      let commonDirProbes = 0;
      childProcess.execSync = (cmd: string) => {
        const c = String(cmd);
        if (c.includes('rev-parse --show-toplevel')) return `${narrowedRoot}\n`;
        if (c.includes('rev-parse --path-format=absolute --git-common-dir')) {
          commonDirProbes++;
          return echoedOutput;
        }
        throw new Error(`unexpected git invocation in this test: ${c}`);
      };

      const prevEnv = process.env.NODE_ENV;
      const prevCtx = process.env.NODE_TEST_CONTEXT;
      process.env.NODE_ENV = 'test';
      process.env.NODE_TEST_CONTEXT = 'child-v8';
      try {
        FileStateRepository.clearWorkspaceRootCache();
        // The garbage root is NOT vetoed: nothing was learned from the probe.
        const repo = new FileStateRepository({ stateFilePath: garbageStateFile });
        assert.doesNotThrow(() => repo.save({ issue: null, currentStage: 'PLAN', history: [] } as any));
        assert.strictEqual(fs.existsSync(garbageStateFile), true);

        // ...and the `__dirname` fallback is not cached either: a second save
        // must re-probe rather than reuse the unusable result (#221 posture).
        const unrelated = new FileStateRepository({ stateFilePath: unrelatedStateFile });
        assert.doesNotThrow(() => unrelated.save({ issue: null, currentStage: 'PLAN', history: [] } as any));
        assert.ok(
          commonDirProbes >= 2,
          `malformed probe output must not be cached (probes: ${commonDirProbes})`
        );

        // Control: the guard itself is still live -- a real veto target is refused.
        const vetoed = new FileStateRepository({ stateFilePath: path.join(narrowedRoot, '.agyloop', 'state.json') });
        assert.throws(
          () => vetoed.save({ issue: null, currentStage: 'PLAN', history: [] } as any),
          (err: any) => err instanceof StateStorageError && err.message === MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE
        );
      } finally {
        if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
        if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevCtx;
        childProcess.execSync = originalExecSync;
        process.cwd = originalCwd;
        FileStateRepository.clearWorkspaceRootCache();
        // `base` is removed by this describe's afterEach.
      }
    });

    test('degrades to the cwd fallback, uncached, in a non-git directory', () => {
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-nogit-244-'));
      const originalCwd = process.cwd;
      process.cwd = () => plain;
      FileStateRepository.clearWorkspaceRootCache();
      try {
        assert.strictEqual(
          new FileStateRepository({ issue: 7 }).getStateFilePath(),
          path.join(plain, '.agyloop', 'tasks', '7.json')
        );
        // The fallback must NOT be cached (#221): a second instantiation has to re-probe
        // git rather than reuse the pinned cwd. Asserted by counting execSync
        // invocations, because two instantiations yield the same path whether or not
        // the fallback is cached -- a path comparison cannot distinguish the two worlds.
        //
        // (The load-bearing copy of this contract is tests/state-machine.test.ts ->
        // 'does not cache the cwd fallback when the git probe fails (#221, #244)'.)
        const childProcess = require('child_process');
        const originalExecSync = childProcess.execSync;
        let execCallCount = 0;
        childProcess.execSync = function (...args: any[]) {
          execCallCount++;
          return originalExecSync.apply(this, args);
        };
        try {
          FileStateRepository.clearWorkspaceRootCache();
          new FileStateRepository({ issue: 7 });
          const afterFirst = execCallCount;
          new FileStateRepository({ issue: 7 });
          assert.ok(
            execCallCount > afterFirst,
            'the cwd fallback must not be cached -- a second instantiation must re-probe (#221)'
          );
        } finally {
          childProcess.execSync = originalExecSync;
          FileStateRepository.clearWorkspaceRootCache();
        }
      } finally {
        process.cwd = originalCwd;
        FileStateRepository.clearWorkspaceRootCache();
        fs.rmSync(plain, { recursive: true, force: true });
      }
    });

    test('degrades to the cwd fallback, without throwing, in a bare repository', (t: any) => {
      // Documented behaviour change: `git worktree list --porcelain` used to "succeed"
      // in a bare repo; `--show-toplevel` fails there ("must be run in a work tree"),
      // so a bare repo now resolves to the cwd. Harmless -- a bare repo has no
      // .agyloop working tree -- but pinned here so it cannot regress silently.
      const childProcess = require('child_process');
      // Only a missing/broken git binary may skip. A failing `git init --bare` is a real
      // environment problem and must fail loudly, so this edge case cannot silently
      // vanish from CI (#244).
      //
      // The capability gate MUST run before mkdtempSync, matching
      // buildWorktreeFixture above: node:test does not run afterEach hooks for a
      // t.skip()-ed test, so any temp dir created before this point would never be
      // reclaimed by the fixtureDirs sweep (#244).
      try {
        childProcess.execFileSync('git', ['--version'], { stdio: 'ignore' });
      } catch {
        t.skip('git is unavailable in this environment');
        return;
      }
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-bare-244-'));
      fixtureDirs.push(bare);
      childProcess.execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
      const originalCwd = process.cwd;
      process.cwd = () => bare;
      FileStateRepository.clearWorkspaceRootCache();
      try {
        assert.strictEqual(
          new FileStateRepository({ issue: 7 }).getStateFilePath(),
          path.join(bare, '.agyloop', 'tasks', '7.json')
        );
      } finally {
        process.cwd = originalCwd;
        FileStateRepository.clearWorkspaceRootCache();
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });
  });
});

describe('FileStateRepository - test-run-aware cross-worktree guard (issue #298)', () => {
  const DUMMY_WORKTREE = path.join('/', 'home', 'ajxcodes', 'code', 'agyloop', '.worktrees', '169');
  let originalCwd: () => string;
  let sandbox: string;

  before(() => {
    originalCwd = process.cwd;
  });

  after(() => {
    process.cwd = originalCwd;
  });

  beforeEach(() => {
    process.cwd = () => DUMMY_WORKTREE;
    const homeCache = path.join(os.homedir(), '.cache', 'agyloop');
    fs.mkdirSync(homeCache, { recursive: true });
    sandbox = fs.mkdtempSync(path.join(homeCache, 'smoke-298-'));
    FileStateRepository.clearWorkspaceRootCache();
  });

  afterEach(() => {
    process.cwd = originalCwd;
    if (sandbox && fs.existsSync(sandbox)) {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  function withGuardEnv(
    env: Record<string, string | undefined>,
    fn: () => void
  ): void {
    const keys = ['NODE_ENV', 'NODE_TEST_CONTEXT', 'AGYLOOP_ALLOW_WORKTREE_ISSUE_MISMATCH'];
    const previous = new Map<string, string | undefined>();
    for (const key of keys) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  function sandboxStateFile(): string {
    return path.join(sandbox, '.agyloop', 'state.json');
  }

  function snapshotWithIssue(issue: number): any {
    return { issue, currentStage: 'PLAN', history: [] };
  }

  const mismatchMessage =
    'Cannot save state for issue 999 from inside worktree for issue 169. Use read-only commands inside worktrees.';

  test('FSR-B1: NODE_ENV=test bypasses the cross-worktree guard', () => {
    withGuardEnv({ NODE_ENV: 'test' }, () => {
      const repo = new FileStateRepository({ stateFilePath: sandboxStateFile() });
      assert.doesNotThrow(() => repo.save(snapshotWithIssue(999)));
    });
  });

  test('FSR-B2: NODE_TEST_CONTEXT bypasses the cross-worktree guard', () => {
    withGuardEnv({ NODE_TEST_CONTEXT: 'child-v8' }, () => {
      const repo = new FileStateRepository({ stateFilePath: sandboxStateFile() });
      assert.doesNotThrow(() => repo.save(snapshotWithIssue(999)));
    });
  });

  test('FSR-B3: the explicit env flag bypasses the guard in production', () => {
    withGuardEnv({ NODE_ENV: 'production', AGYLOOP_ALLOW_WORKTREE_ISSUE_MISMATCH: '1' }, () => {
      const repo = new FileStateRepository({ stateFilePath: sandboxStateFile() });
      assert.doesNotThrow(() => repo.save(snapshotWithIssue(999)));
    });
  });

  test('FSR-B4: a production operator run from a mismatched worktree is still refused', () => {
    withGuardEnv({ NODE_ENV: 'production' }, () => {
      const strictRepo = new FileStateRepository({
        stateFilePath: sandboxStateFile(),
        allowWorktreeIssueMismatch: false
      });
      assert.throws(
        () => strictRepo.save(snapshotWithIssue(999)),
        (err: any) => err instanceof StateStorageError && err.message === mismatchMessage
      );

      const defaultRepo = new FileStateRepository({ stateFilePath: sandboxStateFile() });
      assert.throws(
        () => defaultRepo.save(snapshotWithIssue(999)),
        (err: any) => err instanceof StateStorageError && err.message === mismatchMessage
      );
    });
  });

  test('FSR-B5: an explicit allowWorktreeIssueMismatch:true bypasses in production', () => {
    withGuardEnv({ NODE_ENV: 'production' }, () => {
      const repo = new FileStateRepository({
        stateFilePath: sandboxStateFile(),
        allowWorktreeIssueMismatch: true
      });
      assert.doesNotThrow(() => repo.save(snapshotWithIssue(999)));
    });
  });
});
