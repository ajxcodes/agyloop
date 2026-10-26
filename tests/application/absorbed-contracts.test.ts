/**
 * agyloop - absorbed state/output contracts (#278, #293, #275, #251, #252)
 *
 * Each describe is the regression suite for one absorbed report. They are
 * grouped here because they share the same setup seam: a checkpoint on disk
 * and a use case that must not rewrite it, or must report exactly what it did.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RunLifecycleUseCase,
  ResumePipelineUseCase,
  GetPipelineStatusUseCase
} = require('../../dist/application');
const { StateMachine, ValidationError, STAGE_COMPLETED, STAGE_REVIEW } = require('../../dist/domain');
const { FileStateRepository, GithubCritiqueInstallerGateway, DEFAULT_CONFIG } = require('../../dist/infrastructure');

const NOW = '2026-10-01T00:00:00.000Z';

function snapshot(overrides: Record<string, unknown> = {}): any {
  return {
    version: '1.0.0',
    currentStage: 'PLAN',
    mode: 'standard',
    issue: null,
    milestoneTitle: null,
    baseBranch: 'main',
    worktree: null,
    planDir: null,
    triagePayload: null,
    triageDisposition: null,
    createdAt: NOW,
    updatedAt: NOW,
    history: [{ stage: 'PLAN', timestamp: NOW }],
    pausedAtGate: null,
    pausedAtTimestamp: null,
    totalHumanWaitMs: 0,
    planRevisionCount: 0,
    implementToGateLoops: 0,
    reviewDispatchCount: 0,
    ...overrides
  };
}

function mockConfigRepo(): any {
  return {
    loadConfig: () => ({ ...DEFAULT_CONFIG, options: { ...DEFAULT_CONFIG.options, commitAfter: false } }),
    resolveModel: () => ({ route: 'flash' }),
    mapModelToTier: () => 'flash'
  };
}

describe('#278: StateMachine.setMode is a no-op when the mode is unchanged', () => {
  test('setMode(same) does not advance updatedAt', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    const before = sm.toSnapshot().updatedAt;
    sm.setMode('standard');
    assert.strictEqual(sm.toSnapshot().updatedAt, before);
  });

  test('setMode(other) does advance updatedAt', () => {
    const sm = StateMachine.fromSnapshot(
      snapshot({ mode: 'standard', updatedAt: '2020-01-01T00:00:00.000Z' })
    );
    const before = sm.toSnapshot().updatedAt;
    sm.setMode('plan');
    assert.notStrictEqual(sm.toSnapshot().updatedAt, before);
    assert.strictEqual(sm.mode, 'plan');
  });

  test('an invalid mode still throws', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    assert.throws(() => sm.setMode('garbage' as any), (err: any) => err instanceof ValidationError);
  });
});

describe('#278: a bare run over a COMPLETED checkpoint is a pure read', () => {
  function makeSandbox(overrides: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-278-'));
    fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
    const stateFile = path.join(dir, '.agyloop', 'state.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        snapshot({
          currentStage: STAGE_COMPLETED,
          mode: 'implement',
          issue: 909,
          updatedAt: NOW,
          history: [{ stage: STAGE_COMPLETED, timestamp: NOW }],
          ...overrides
        })
      )
    );
    return { dir, stateFile };
  }

  function makeUseCase(deps: any = {}): any {
    const stateRepo = deps.stateRepo ?? {
      load: async () => null,
      save: async () => {
        throw new Error('save must not be called');
      },
      getStateFilePath: () => '/mock/state.json'
    };
    return new RunLifecycleUseCase({
      stateRepo,
      configRepo: mockConfigRepo(),
      planGenerator: {
        scaffoldPlanDirectory: () => null,
        generatePlan: () => null,
        generateSummaryLog: () => null,
        updateSummaryLog: () => true,
        findPlanDirectory: () => null,
        resolvePlanFile: () => null,
        readPlanDocument: () => ''
      },
      githubGateway: { fetchIssue: async () => null },
      commandExecutor: { execute: async (command: string) => ({ command, exitCode: 0, stdout: '', stderr: '', combinedOutput: '', durationMs: 1, timedOut: false }) },
      worktreeManager: {
        resolveBaseBranch: async () => 'main',
        createWorktree: async () => {
          throw new Error('createWorktree must not be called for a finished run');
        },
        listWorktrees: async () => [],
        resolveTaskWorktreePath: async (workspaceDir: string, taskId: string) => `${workspaceDir}/.worktrees/${taskId}`
      },
      runPreFlightCheckUseCase: {
        execute: async () => {
          throw new Error('preflight must not run for a finished run');
        }
      },
      ...deps.deps
    });
  }

  test('(a) writes nothing, runs no preflight, provisions no worktree, keeps mode', async () => {
    const { dir, stateFile } = makeSandbox();
    let saves = 0;
    const realRepo = new FileStateRepository({ stateFilePath: stateFile });
    const countedRepo = {
      load: () => realRepo.load(),
      save: async (s: any) => {
        saves++;
        return realRepo.save(s);
      },
      getStateFilePath: () => realRepo.getStateFilePath()
    };
    let worktrees = 0;

    const useCase = makeUseCase({
      stateRepo: countedRepo,
      deps: {
        worktreeManager: {
          resolveBaseBranch: async () => 'main',
          createWorktree: async () => {
            worktrees++;
            throw new Error('must not provision');
          },
          listWorktrees: async () => []
        }
      }
    });

    const before = fs.readFileSync(stateFile, 'utf8');
    const result = await useCase.execute({ mode: 'standard', workspaceDir: dir });
    const after = fs.readFileSync(stateFile, 'utf8');

    assert.strictEqual(result.currentStage, STAGE_COMPLETED);
    assert.strictEqual(result.message, 'Pipeline already completed');
    assert.strictEqual(saves, 0);
    assert.strictEqual(worktrees, 0);
    assert.strictEqual(after, before, 'the checkpoint must be byte-identical');
    assert.strictEqual(JSON.parse(after).mode, 'implement', 'the mode must not be rewritten');
    assert.strictEqual(JSON.parse(after).updatedAt, NOW, 'updatedAt must not advance for a read');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('(c) COMPLETED + MODE_IMPLEMENT still re-opens the implementation path', async () => {
    const { dir, stateFile } = makeSandbox();
    const realRepo = new FileStateRepository({ stateFilePath: stateFile });
    let implCalls = 0;

    const useCase = makeUseCase({
      stateRepo: realRepo,
      deps: {
        worktreeManager: undefined,
        startImplementationUseCase: {
          execute: async () => {
            implCalls++;
            const sm = StateMachine.createInitial({ issue: 909 });
            sm.transition('DISCOVERY');
            sm.transition('PLAN');
            sm.transition('APPROVAL');
            sm.transition('IMPLEMENT');
            return { stateMachine: sm, resumed: false };
          }
        }
      }
    });

    const result = await useCase.execute({ mode: 'implement', workspaceDir: dir, worktree: false });
    assert.strictEqual(implCalls, 1, 'the implement re-open path must remain reachable');
    assert.strictEqual(result.currentStage, 'IMPLEMENT');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('(d) a PLAN checkpoint switched to mode=plan persists the mode leg', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-278-plan-'));
    fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
    const stateFile = path.join(dir, '.agyloop', 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(snapshot({ currentStage: 'PLAN', mode: 'standard', issue: 909 })));
    const realRepo = new FileStateRepository({ stateFilePath: stateFile });
    let saves = 0;
    const countedRepo = {
      load: () => realRepo.load(),
      save: async (s: unknown) => {
        saves++;
        return realRepo.save(s as any);
      },
      getStateFilePath: () => realRepo.getStateFilePath()
    };

    // A REAL run (no dryRun): the point is that the mode leg writes. The plan
    // dispatcher is stubbed so the assertion observes the MODE write alone.
    const useCase = makeUseCase({
      stateRepo: countedRepo,
      deps: {
        worktreeManager: undefined,
        startPlanningUseCase: {
          execute: async () => ({
            stateMachine: StateMachine.fromSnapshot(
              snapshot({ currentStage: 'PLAN', mode: 'plan', issue: 909 })
            ),
            discoveryReentry: undefined
          })
        }
      }
    });

    // The repository refuses a write made from inside a task worktree, so the
    // run happens from the workspace it operates on — as a real invocation does.
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await useCase.execute({ mode: 'plan', workspaceDir: dir });

      assert.strictEqual(result.mode, 'plan');
      assert.strictEqual(saves, 1, 'the changed mode must be persisted exactly once');
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.strictEqual(saved.mode, 'plan', 'the saved snapshot must carry the requested mode');
      assert.notStrictEqual(saved.updatedAt, NOW, 'a real mode change must advance updatedAt');
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(e) an unchanged mode performs no save at all', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-278-plan-same-'));
    fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
    const stateFile = path.join(dir, '.agyloop', 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(snapshot({ currentStage: 'PLAN', mode: 'standard', issue: 909 })));
    const realRepo = new FileStateRepository({ stateFilePath: stateFile });
    let saves = 0;
    const countedRepo = {
      load: () => realRepo.load(),
      save: async (s: unknown) => {
        saves++;
        return realRepo.save(s as any);
      },
      getStateFilePath: () => realRepo.getStateFilePath()
    };

    const useCase = makeUseCase({ stateRepo: countedRepo, deps: { worktreeManager: undefined } });
    const before = fs.readFileSync(stateFile, 'utf8');
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await useCase.execute({ mode: 'standard', workspaceDir: dir });
    } finally {
      process.chdir(prevCwd);
    }

    assert.strictEqual(saves, 0, 'an unchanged mode must not trigger the mode-leg save');
    assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), before, 'the checkpoint must be byte-identical');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('#252: resume JSON parity and deterministic other-paused note', () => {
  /**
   * A workspace where 600 and 700 are both paused at COMMIT with EQUAL
   * `updatedAt`. The resolver must select 600 (lowest issue on a tie) and the
   * note must name 700 — regardless of `listAllStates` order.
   */
  function makeRepo(order: 'asc' | 'desc') {
    const snapshots = [
      snapshot({ issue: 600, currentStage: STAGE_REVIEW, pausedAtGate: 'COMMIT', pausedAtTimestamp: NOW, updatedAt: NOW }),
      snapshot({ issue: 700, currentStage: STAGE_REVIEW, pausedAtGate: 'COMMIT', pausedAtTimestamp: NOW, updatedAt: NOW })
    ];
    const ordered = order === 'asc' ? snapshots : [...snapshots].reverse();
    const saves: number[] = [];
    const stateRepo: any = {
      // No ROOT checkpoint: the two task files are the whole workspace, so the
      // resolver must choose between them (the point of the test).
      load: async () => null,
      save: async () => undefined,
      getStateFilePath: () => '/repo/.agyloop/state.json',
      listAllStates: async () => ordered,
      forIssue: (issue: number) => ({
        load: async () => ordered.find((s) => s.issue === issue) ?? null,
        save: async (s: any) => {
          saves.push(issue);
        },
        getStateFilePath: () => `/repo/.agyloop/tasks/${issue}.json`
      })
    };
    return { stateRepo, saves };
  }

  test('the note names the resolver-ranked OTHER task, in either list order', async () => {
    for (const order of ['asc', 'desc'] as const) {
      const { stateRepo } = makeRepo(order);
      const result = await new ResumePipelineUseCase(stateRepo).execute({ dryRun: true });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.resolvedFromIssue, 600, `order=${order}`);
      assert.strictEqual(result.resolvedFromPath, '/repo/.agyloop/tasks/600.json');
      assert.ok(result.message.includes('#700'), `order=${order}: ${result.message}`);
      assert.ok(!result.message.includes('#600 is paused'), `order=${order}: ${result.message}`);
    }
  });

  test('JSON parity fields exist on the result (issue/path)', async () => {
    const { stateRepo } = makeRepo('asc');
    const result = await new ResumePipelineUseCase(stateRepo).execute({ issue: 600, dryRun: true });
    assert.strictEqual(result.resolvedFromIssue, 600);
    assert.strictEqual(result.resolvedFromPath, '/repo/.agyloop/tasks/600.json');
  });

  test('the other-paused note is absent when nothing else is paused', async () => {
    const stateRepo: any = {
      load: async () => null,
      save: async () => undefined,
      getStateFilePath: () => '/repo/.agyloop/state.json',
      listAllStates: async () => [snapshot({ issue: 600, currentStage: STAGE_REVIEW, pausedAtGate: 'COMMIT', pausedAtTimestamp: NOW })],
      forIssue: (issue: number) => ({
        load: async () => snapshot({ issue, currentStage: STAGE_REVIEW, pausedAtGate: 'COMMIT', pausedAtTimestamp: NOW }),
        save: async () => undefined,
        getStateFilePath: () => `/repo/.agyloop/tasks/${issue}.json`
      })
    };
    const result = await new ResumePipelineUseCase(stateRepo).execute({ dryRun: true });
    assert.ok(!/Note: issue #/.test(result.message), result.message);
  });
});

describe('#252: the resolver stays on the application barrel', () => {
  test('resolveCheckpointScope / resolveAuthoritativeCheckpoint are exported', () => {
    const application = require('../../dist/application');
    assert.strictEqual(typeof application.resolveCheckpointScope, 'function');
    assert.strictEqual(typeof application.resolveAuthoritativeCheckpoint, 'function');
    assert.strictEqual(typeof application.selectAuthoritativeCheckpoint, 'function');

    const dts = fs.readFileSync(
      path.join(__dirname, '..', '..', 'dist', 'application', 'index.d.ts'),
      'utf8'
    );
    assert.ok(dts.includes('resolve-task-checkpoint'), dts.slice(0, 400));
  });
});

describe('#251: corrupt checkpoints are rendered, one bad file does not brick the matrix', () => {
  test('a GARBAGE stage throws a ValidationError from the use case', async () => {
    const stateRepo: any = {
      load: async () => ({ currentStage: 'GARBAGE' }),
      getStateFilePath: () => '/repo/.agyloop/tasks/999.json',
      listAllStates: async () => [],
      forIssue: () => ({
        load: async () => ({ currentStage: 'GARBAGE' }),
        getStateFilePath: () => '/repo/.agyloop/tasks/999.json'
      })
    };
    await assert.rejects(
      new GetPipelineStatusUseCase(stateRepo).execute({ issue: 999 }),
      (err: any) => err instanceof ValidationError
    );
  });

  test('activeTasks skips the invalid snapshot and reports skippedCorrupt', async () => {
    const valid = snapshot({ issue: 998, currentStage: 'PLAN' });
    const stateRepo: any = {
      load: async () => valid,
      getStateFilePath: () => '/repo/.agyloop/state.json',
      listAllStates: async () => [valid, { currentStage: 'GARBAGE' }],
      forIssue: (issue: number) => ({
        load: async () => (issue === 998 ? valid : { currentStage: 'GARBAGE' }),
        getStateFilePath: () => `/repo/.agyloop/tasks/${issue}.json`
      })
    };

    const result = await new GetPipelineStatusUseCase(stateRepo).execute();
    assert.deepStrictEqual(result.activeTasks.map((task: any) => task.issue), [998]);
    assert.strictEqual(result.skippedCorrupt.length, 1);
    assert.ok(result.skippedCorrupt[0].error.length > 0);
  });
});

describe('#248: critique installer dry run downloads nothing', () => {
  test('fetches metadata once, writes no binary and no cache', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-critique-dry-'));
    const cacheFile = path.join(dir, 'cache.json');
    const targetBase = path.join(dir, 'data');
    const fetched: string[] = [];

    const fetcher = async (url: string) => {
      fetched.push(url);
      return new Response(
        JSON.stringify({
          tag_name: 'v0.1.8',
          html_url: 'https://example.test/release',
          assets: [{ name: 'critique.js', browser_download_url: 'https://example.test/critique.js' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const gateway = new GithubCritiqueInstallerGateway({
      targetBaseDir: targetBase,
      cacheFilePath: cacheFile,
      fetcher: fetcher as any
    });

    const result = await gateway.install({ dryRun: true });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.version, '0.1.8');
    assert.ok(result.targetPath && result.targetPath.endsWith(path.join('bin', 'critique.js')));
    assert.strictEqual(fetched.length, 1, 'only the metadata fetch is permitted');
    assert.ok(fetched[0].includes('api.github.com'), fetched[0]);
    assert.strictEqual(fs.existsSync(targetBase), false, 'no target directory may be created');
    assert.strictEqual(fs.existsSync(cacheFile), false, 'no cache manifest may be written');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
