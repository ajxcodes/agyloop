/**
 * agyloop - use-case `dryRun` contracts (#248 Wave 2)
 *
 * The CLI tests prove the FLAG is forwarded and the output is truthful; these
 * tests prove the USE CASE actually performs no mutation, and every one has a
 * negative control so "do nothing at all" cannot pass.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ResetPipelineUseCase,
  SyncUseCase,
  AbortPipelineUseCase,
  TriagePrCommentsUseCase,
  ManageWorktreeUseCase,
  ManageCritiqueUseCase
} = require('../../dist/application');
const { StateMachine, STAGE_TRIAGE, GATE_TRIAGE, WorktreeDescriptor } = require('../../dist/domain');

function green(command: string, stdout = ''): any {
  return {
    command,
    exitCode: 0,
    stdout,
    stderr: '',
    combinedOutput: stdout,
    durationMs: 1,
    timedOut: false
  };
}

describe('ResetPipelineUseCase dryRun (#248 AC-248.1/2)', () => {
  function makeRepo() {
    return {
      resetCalls: 0,
      resetTaskCalls: [] as number[],
      resetAllCalls: 0,
      reset: async () => {
        repo.resetCalls++;
      },
      resetTask: async (issue: number) => {
        repo.resetTaskCalls.push(issue);
        return true;
      },
      resetAll: async () => {
        repo.resetAllCalls++;
      },
      load: async () => ({
        version: '1.0.0',
        currentStage: 'PLAN',
        mode: 'standard',
        issue: 42,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        history: []
      }),
      getStateFilePath: () => '/mock/.agyloop/state.json',
      forIssue: (issue: number) => ({
        load: async () => ({
          version: '1.0.0',
          currentStage: 'PLAN',
          mode: 'standard',
          issue,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          history: []
        }),
        save: async () => undefined,
        reset: async () => undefined,
        getStateFilePath: () => `/mock/.agyloop/tasks/${issue}.json`
      })
    } as any;
  }
  let repo: any;
  function freshRepo(): any {
    repo = makeRepo();
    return repo;
  }

  test('task scope: no resetTask, removed:false, wouldClear:true', async () => {
    const useCase = new ResetPipelineUseCase(freshRepo());
    const result = await useCase.execute({ issue: 42, dryRun: true });

    assert.strictEqual(repo.resetTaskCalls.length, 0);
    assert.strictEqual(repo.resetCalls, 0);
    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.wouldClear, true);
    assert.strictEqual(result.path, '/mock/.agyloop/tasks/42.json');
  });

  test('task scope with no checkpoint: wouldClear:false', async () => {
    const noCheckpointRepo = freshRepo();
    noCheckpointRepo.forIssue = () => ({
      load: async () => null,
      save: async () => undefined,
      reset: async () => undefined,
      getStateFilePath: () => '/mock/.agyloop/tasks/42.json'
    });
    const result = await new ResetPipelineUseCase(noCheckpointRepo).execute({ issue: 42, dryRun: true });
    assert.strictEqual(result.wouldClear, false);
    assert.strictEqual(result.removed, false);
  });

  test('root scope does not call reset()', async () => {
    const result = await new ResetPipelineUseCase(freshRepo()).execute({ dryRun: true });
    assert.strictEqual(repo.resetCalls, 0);
    assert.strictEqual(result.scope, 'root');
    assert.strictEqual(result.removed, false);
  });

  test('--all does not call resetAll()', async () => {
    const result = await new ResetPipelineUseCase(freshRepo()).execute({ all: true, dryRun: true });
    assert.strictEqual(repo.resetAllCalls, 0);
    assert.strictEqual(repo.resetCalls, 0);
    assert.strictEqual(result.removed, false);
  });

  test('negative control: without dryRun the adapter IS called', async () => {
    const result = await new ResetPipelineUseCase(freshRepo()).execute({ issue: 42 });
    assert.deepStrictEqual(repo.resetTaskCalls, [42]);
    assert.strictEqual(result.removed, true);
    assert.strictEqual(result.dryRun, false);
  });
});

describe('SyncUseCase dryRun (#248 AC-248.3, #328 AC-328.6)', () => {
  class MockExecutor {
    public commands: string[] = [];
    public responses: Record<string, any> = {};
    public async execute(command: string) {
      this.commands.push(command);
      return this.responses[command] ?? green(command);
    }
  }
  class MockGitHub {
    public closed: number[] = [];
    public comments: number[] = [];
    public strictErrors: Record<number, string> = {};
    public states: Record<number, string> = { 10: 'OPEN' };
    public async fetchIssue() {
      throw new Error('the lenient read must never authorize a write (#328)');
    }
    public async fetchIssueStrict(id: number) {
      if (this.strictErrors[id]) {
        throw new Error(this.strictErrors[id]);
      }
      if (!this.states[id]) {
        throw new Error(`gh issue view ${id} returned nothing`);
      }
      return { number: id, state: this.states[id] };
    }
    public async closeIssue(id: number) {
      this.closed.push(id);
    }
    public async commentOnIssue(id: number) {
      this.comments.push(id);
    }
  }
  class MockState {
    public async load() {
      return { baseBranch: 'phase/1' };
    }
  }
  class MockWorktree {
    public async resolveBaseBranch() {
      return 'phase/1';
    }
  }

  function harness(candidates: { number: number; body: string }[]) {
    const executor = new MockExecutor();
    const github = new MockGitHub();
    executor.responses["gh pr list --base 'phase/1' --state merged --json number,title,body"] = green(
      'gh pr list',
      JSON.stringify(candidates)
    );
    for (const candidate of candidates) {
      executor.responses[`gh pr view ${candidate.number} --json files --jq '.files[].path'`] = green(
        `gh pr view ${candidate.number}`,
        'src/app.ts\n'
      );
    }
    const useCase = new SyncUseCase(
      executor as any,
      github as any,
      new MockState() as any,
      new MockWorktree() as any
    );
    return { executor, github, useCase };
  }

  test('dry run issues no fetch/pull/close and closes no issue', async () => {
    const executor = new MockExecutor();
    const github = new MockGitHub();
    const result = await new SyncUseCase(executor as any, github as any, new MockState() as any, new MockWorktree() as any).execute({
      workspaceDir: '/mock',
      dryRun: true
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dryRun, true);
    assert.match(result.message, /\[dry-run\] Would fetch origin/);
    for (const command of executor.commands) {
      assert.ok(!/git fetch|git pull/.test(command), `dry run executed: ${command}`);
      assert.ok(!/^issue close|issue close |issue comment /.test(command), `dry run executed: ${command}`);
    }
    assert.deepStrictEqual(github.closed, []);
    assert.deepStrictEqual(github.comments, []);
  });

  test('dry run lists the issues it would close and writes nothing', async () => {
    const { executor, github, useCase } = harness([{ number: 42, body: 'Closes #10' }]);

    const result = await useCase.execute({ workspaceDir: '/mock', dryRun: true });

    assert.strictEqual(result.success, true);
    assert.ok(
      (result.logs ?? []).includes(
        '[dry-run] Would close issue #10 and post 1 comment (merged in PR #42 into phase/1)'
      ),
      `got: ${JSON.stringify(result.logs)}`
    );
    // Negative control: the forecast must have READ the merged PRs and the issue.
    assert.ok(
      executor.commands.some((command: string) => command.startsWith('gh pr list')),
      `the read-only scan must still run: ${executor.commands.join('\n')}`
    );
    assert.deepStrictEqual(github.closed, []);
    assert.deepStrictEqual(github.comments, []);
  });

  test('dry run lists already-closed and unreadable candidates', async () => {
    const { github, useCase } = harness([
      { number: 41, body: 'Closes #10' },
      { number: 42, body: 'Closes #11' },
      { number: 43, body: 'Closes #12' }
    ]);
    github.states[10] = 'CLOSED';
    github.strictErrors[11] = 'HTTP 502: Bad Gateway';
    github.states[12] = 'OPEN';

    const result = await useCase.execute({ workspaceDir: '/mock', dryRun: true });

    const logs: string[] = result.logs ?? [];
    assert.ok(logs.includes('[dry-run] Would skip #10: already closed'), JSON.stringify(logs));
    assert.ok(
      logs.includes('[dry-run] Would skip #11: unreadable (HTTP 502: Bad Gateway)'),
      JSON.stringify(logs)
    );
    assert.ok(
      logs.some((log: string) => log.includes('[dry-run] Would close issue #12')),
      JSON.stringify(logs)
    );
    assert.strictEqual(result.success, false, 'an unreadable candidate makes the forecast incomplete');
    assert.match(result.message, /#11/);
    assert.deepStrictEqual(github.closed, []);
    assert.deepStrictEqual(github.comments, []);
  });

  test('internal caller regression: no dryRun still fetches (R7)', async () => {
    const executor = new MockExecutor();
    await new SyncUseCase(executor as any, new MockGitHub() as any, new MockState() as any, new MockWorktree() as any).execute({
      workspaceDir: '/mock'
    });
    assert.ok(executor.commands.includes('git fetch origin'), executor.commands.join('\n'));
  });
});

describe('AbortPipelineUseCase dryRun (#248 AC-248.4)', () => {
  function makeSpies() {
    const calls = {
      killAll: 0,
      clearIndexLock: 0,
      quarantine: 0,
      containerRm: [] as string[],
      summary: 0
    };
    const stateRepo = {
      load: async () => ({
        issue: 212,
        currentStage: 'IMPLEMENT',
        mode: 'standard',
        worktree: {
          taskId: '212',
          worktreePath: '/mock/workspace/.worktrees/212',
          branch: 'task/212',
          baseBranch: 'main',
          isIsolated: true
        },
        history: []
      }),
      save: async () => undefined,
      getStateFilePath: () => '/mock/workspace/.agyloop/state.json'
    };
    const commandExecutor = {
      killAll: () => {
        calls.killAll++;
        return 1;
      },
      execute: async (command: string) => {
        if (command.includes('rm -f')) calls.containerRm.push(command);
        if (command.includes('ps -a') && command.includes('name=codeloop-sandbox-*')) {
          return green(command, 'c123\n');
        }
        return green(command);
      }
    };
    const worktreeManager = {
      clearIndexLock: async () => {
        calls.clearIndexLock++;
        return true;
      },
      listWorktrees: async () => [
        { taskId: 212, worktreePath: '/mock/workspace/.worktrees/212', branch: 'task/212', isClean: false }
      ],
      quarantineWorktree: async () => {
        calls.quarantine++;
        return { quarantined: true, outcome: 'stashed', stashed: true };
      }
    };
    const planGenerator = {
      resolvePlanFile: () => ({ summaryPath: '/mock/plan/Summary.md' }),
      updateSummaryLog: () => {
        calls.summary++;
        return true;
      }
    };
    return { calls, stateRepo, commandExecutor, worktreeManager, planGenerator };
  }

  test('touches nothing but still names what it would do', async () => {
    const spies = makeSpies();
    const result = await new AbortPipelineUseCase(spies as any).execute({
      workspaceDir: '/mock/workspace',
      issue: 212,
      dryRun: true
    });

    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(spies.calls.killAll, 0);
    assert.strictEqual(spies.calls.clearIndexLock, 0);
    assert.strictEqual(spies.calls.quarantine, 0);
    assert.deepStrictEqual(spies.calls.containerRm, []);
    assert.strictEqual(spies.calls.summary, 0);
    assert.strictEqual(result.processesTerminated, 0);
    assert.strictEqual(result.indexLockRemoved, false);
    assert.strictEqual(result.auditLogged, false);
    assert.strictEqual(result.worktreesWouldQuarantine.includes('/mock/workspace/.worktrees/212'), true);
    assert.strictEqual(result.containersWouldTerminate.includes('docker:c123'), true);
  });

  test('negative control: a real abort performs every step', async () => {
    const spies = makeSpies();
    const result = await new AbortPipelineUseCase(spies as any).execute({
      workspaceDir: '/mock/workspace',
      issue: 212
    });
    assert.strictEqual(spies.calls.killAll, 1);
    assert.strictEqual(spies.calls.clearIndexLock, 1);
    assert.strictEqual(spies.calls.quarantine, 1);
    assert.ok(spies.calls.containerRm.length > 0);
    assert.strictEqual(spies.calls.summary, 1);
    assert.strictEqual(result.dryRun, false);
  });
});

describe('TriagePrCommentsUseCase dryRun (#248 AC-248.5, R14)', () => {
  function seedTriage() {
    const sm = StateMachine.createInitial({ issue: 901 });
    sm.transition(STAGE_TRIAGE);
    sm.pauseAtGate(GATE_TRIAGE);
    return sm.toSnapshot();
  }

  function makeSpies() {
    let current = seedTriage();
    const calls = { saves: 0, worktrees: 0, dismissal: 0, inferencePersist: [] as any[] };
    const stateRepo = {
      load: async () => current,
      save: async (snap: any) => {
        calls.saves++;
        current = snap;
      },
      getStateFilePath: () => '/mock/.agyloop/tasks/901.json'
    };
    const worktreeManager = {
      createWorktree: async () => {
        calls.worktrees++;
        return new WorktreeDescriptor({
          taskId: '901',
          worktreePath: '/mock/.worktrees/901',
          branch: 'task/901',
          baseBranch: 'main'
        });
      }
    };
    const inferBaseBranchUseCase = {
      execute: async (params: any) => {
        calls.inferencePersist.push(params.persist);
        return { baseBranch: 'main', taskBranchPrefix: 'task/' };
      }
    };
    const githubGateway = {
      findPullRequest: async () => null,
      fetchPullRequestComments: async () => [],
      replyToReviewThread: async () => {
        calls.dismissal++;
      },
      resolveReviewThread: async () => {
        calls.dismissal++;
      }
    };
    return { calls, stateRepo, worktreeManager, inferBaseBranchUseCase, githubGateway };
  }

  test('no save, no worktree, inference non-persistent, wouldTransitionTo set', async () => {
    const spies = makeSpies();
    const useCase = new TriagePrCommentsUseCase(
      spies.stateRepo as any,
      spies.githubGateway as any,
      undefined,
      spies.worktreeManager as any,
      spies.inferBaseBranchUseCase as any
    );

    const result = await useCase.execute({
      issue: 901,
      action: 'implement',
      prNumber: 55,
      comments: [{ author: 'reviewer', body: '[error] fix', category: 'error' }],
      dryRun: true
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.stateUpdated, false);
    assert.strictEqual(spies.calls.saves, 0);
    assert.strictEqual(spies.calls.worktrees, 0);
    assert.strictEqual(spies.calls.dismissal, 0);
    assert.strictEqual(result.wouldTransitionTo, 'IMPLEMENT');
    assert.strictEqual(result.wouldCreateWorktree, true);
    // AC-275.6: the disposition is a PREDICTION on a dry run. Nothing was
    // recorded, so no `recordedAt` timestamp and no `dispositionRecorded:true`
    // may be reported as a fact.
    assert.strictEqual(result.dispositionRecorded, false);
    assert.strictEqual(result.disposition, null);
    assert.strictEqual(result.wouldRecordDisposition, true);
    assert.ok(
      spies.calls.inferencePersist.every((value) => value === false),
      `inference must be non-persistent: ${JSON.stringify(spies.calls.inferencePersist)}`
    );
  });

  test('a dismiss dry run posts nothing and reports wouldDismiss', async () => {
    const spies = makeSpies();
    const useCase = new TriagePrCommentsUseCase(
      spies.stateRepo as any,
      spies.githubGateway as any,
      undefined,
      spies.worktreeManager as any,
      spies.inferBaseBranchUseCase as any
    );
    const result = await useCase.execute({
      issue: 901,
      action: 'dismiss',
      prNumber: 55,
      notes: 'closing',
      comments: [{ author: 'reviewer', body: '[error] fix', category: 'error' }],
      dryRun: true
    });
    assert.strictEqual(spies.calls.dismissal, 0);
    assert.strictEqual(result.wouldDismiss, true);
    assert.strictEqual(result.refused ?? null, null);
  });

  test('negative control: a real run saves exactly once and creates the worktree', async () => {
    const spies = makeSpies();
    const useCase = new TriagePrCommentsUseCase(
      spies.stateRepo as any,
      spies.githubGateway as any,
      undefined,
      spies.worktreeManager as any,
      spies.inferBaseBranchUseCase as any
    );
    const result = await useCase.execute({
      issue: 901,
      action: 'implement',
      comments: [{ author: 'reviewer', body: '[error] fix', category: 'error' }]
    });
    assert.strictEqual(spies.calls.saves, 1);
    assert.strictEqual(spies.calls.worktrees, 1);
    assert.strictEqual(result.stateUpdated, true);
  });
});

describe('ManageWorktreeUseCase dryRun (#248 AC-248.6, R5/R6)', () => {
  function makeManager() {
    return {
      removeCalls: [] as any[],
      cleanCalls: [] as any[],
      removeWorktree: async (options: any) => {
        manager.removeCalls.push(options);
      },
      cleanOrphanedWorktrees: async (options: any) => {
        manager.cleanCalls.push(options);
        return 2;
      },
      resolveTaskWorktreePath: async (workspaceDir: string, taskId: string) =>
        `${workspaceDir}/.worktrees/${taskId}`,
      pruneWorktrees: async () => undefined,
      listWorktrees: async () => []
    } as any;
  }
  let manager: any;

  function makeStore() {
    const saves: any[] = [];
    const snapshot = {
      version: '1.0.0',
      currentStage: 'IMPLEMENT',
      mode: 'standard',
      issue: 87,
      worktree: {
        taskId: '87',
        worktreePath: '/repo/.worktrees/87',
        branch: 'task/87',
        baseBranch: 'main',
        isIsolated: true
      },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      history: []
    };
    const repo = {
      load: async () => snapshot,
      save: async (s: any) => {
        saves.push(s);
      },
      getStateFilePath: () => '/repo/.agyloop/tasks/87.json',
      forIssue: () => repo,
      listAllStates: async () => [snapshot]
    };
    return { repo, saves };
  }

  test('clean forwards dryRun and reports the would-remove count', async () => {
    manager = makeManager();
    const useCase = new ManageWorktreeUseCase(manager);
    const result = await useCase.clean({ workspaceDir: '/repo', dryRun: true });
    assert.strictEqual(manager.cleanCalls[0].dryRun, true);
    assert.match(result.message, /^Would remove 2 orphaned worktree/);
    assert.deepStrictEqual(result.data, { count: 2 });
  });

  test('teardown forwards dryRun, exercises the guards, and saves no descriptor', async () => {
    manager = makeManager();
    const store = makeStore();
    const useCase = new ManageWorktreeUseCase(manager, store.repo as any);
    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo',
      issue: 87,
      dryRun: true
    });

    assert.strictEqual(manager.removeCalls.length, 1);
    assert.strictEqual(manager.removeCalls[0].dryRun, true);
    assert.strictEqual(store.saves.length, 0, 'no checkpoint may be written');
    assert.match(result.message, /^Would remove the worktree at \/repo\/\.worktrees\/87/);
    assert.strictEqual(result.data?.descriptorCleared, false);
    assert.strictEqual(result.data?.wouldClear, true);
  });

  test('clearStaleDescriptor dry run saves nothing', async () => {
    manager = makeManager();
    const store = makeStore();
    const useCase = new ManageWorktreeUseCase(manager, store.repo as any);
    const result = await useCase.clearStaleDescriptor({
      worktreePath: '/repo/.worktrees/87',
      issue: 87,
      dryRun: true
    });
    assert.strictEqual(store.saves.length, 0);
    assert.match(result.message, /^Would clear the stale descriptor/);
    assert.strictEqual(result.data?.wouldClear, true);
  });

  test('negative control: a real teardown clears and saves the descriptor', async () => {
    manager = makeManager();
    const store = makeStore();
    const useCase = new ManageWorktreeUseCase(manager, store.repo as any);
    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo',
      issue: 87
    });
    assert.strictEqual(manager.removeCalls[0].dryRun, false);
    assert.strictEqual(store.saves.length, 1);
    assert.strictEqual(result.data?.descriptorCleared, true);
  });
});

describe('ManageCritiqueUseCase dryRun (#248 AC-248.6)', () => {
  test('install/update forward dryRun to the installer port', async () => {
    const calls: any[] = [];
    const critique = { resolveReviewer: () => ({ source: 'bundled', path: null, isAvailable: false }) };
    const installer = {
      checkUpdateAvailable: async () => ({ currentVersion: null, latestVersion: null, isOutdated: false }),
      getCachedVersionInfo: async () => null,
      fetchLatestVersion: async () => null,
      install: async (options: any) => {
        calls.push({ method: 'install', options });
        return { success: true, version: '0.1.7', targetPath: '/data/bin/critique.js', error: null, dryRun: true };
      },
      update: async (options: any) => {
        calls.push({ method: 'update', options });
        return { success: true, version: '0.1.7', targetPath: '/data/bin/critique.js', error: null, dryRun: true };
      }
    };
    const useCase = new ManageCritiqueUseCase(critique as any, installer as any);

    const installed = await useCase.install({ dryRun: true });
    const updated = await useCase.update({ dryRun: true });

    assert.strictEqual(installed.dryRun, true);
    assert.strictEqual(updated.dryRun, true);
    assert.deepStrictEqual(calls.map((call) => call.method), ['install', 'update']);
    assert.strictEqual(calls[0].options.dryRun, true);
    assert.strictEqual(calls[1].options.dryRun, true);
  });
});
