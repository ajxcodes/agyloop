/**
 * agyloop - Gate target contract regression suite (issue #348, AC1/AC3/AC4)
 *
 * The defect: a plan's `### Quality Gate Targets` run in the task worktree
 * against the UNCOMMITTED change, before the commit gate. A target that asserts
 * a committed-tree invariant (`git diff --exit-code -- <file>`) therefore fails
 * by construction — and the old workaround (`git add <file>`) hides the file
 * from the commit draft.
 *
 * Chosen behaviour: the plan is REJECTED at approval time, naming the command
 * and the reason. Nothing is staged, so the draft still enumerates the change.
 *
 * GTC1 - StartImplementationUseCase (the `codeloop implement` entry point)
 *        refuses at APPROVAL with `ValidationError('gateTargets', …)`; nothing
 *        is saved and no worktree is created.
 * GTC2 - TransitionStageUseCase `-> APPROVAL` refuses and leaves the checkpoint
 *        at PLAN; the rewritten plan is then accepted.
 * GTC3 - the failure mechanism itself: `git diff --exit-code <file>` exits 1 on
 *        the seeded, intended uncommitted change.
 * GTC4 - parser + linter end-to-end on the same plan file.
 * GTC5 - after the refusal nothing is staged and the draft's enumeration
 *        (`git diff HEAD --name-only`) still sees the changed file.
 *
 * Real git is driven with argument arrays (`spawnSync`), never a shell string.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  StartImplementationUseCase,
  TransitionStageUseCase
} = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  MODE_STANDARD,
  ValidationError,
  parseQualityGateTargets,
  lintQualityGateTargets
} = require('../../dist/domain');

const BAD_COMMAND = 'git diff --exit-code -- package-lock.json';
const ISSUE = 348;

/** Runs git with an argument array (never a shell string). */
function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`
  );
  return result.stdout;
}

function planWithTarget(command: string): string {
  return [
    '# Plan',
    '',
    '## 5. Quality Gate Targets',
    '',
    `- \`${command}\``,
    ''
  ].join('\n');
}

class MockStateRepository {
  public snapshot: any;
  public saveCallCount = 0;

  constructor(initial: any) {
    this.snapshot = initial;
  }

  public load(): any {
    return this.snapshot;
  }

  public save(snapshot: any): void {
    this.snapshot = snapshot;
    this.saveCallCount++;
  }

  public reset(): void {
    this.snapshot = null;
  }

  public getStateFilePath(): string {
    return '/mock/state.json';
  }
}

class MockConfigRepository {
  public loadConfig(): any {
    return {
      models: {
        planner: 'pro',
        implementer: 'inherit',
        gate: 'flash_lite',
        reviewer: 'flash'
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: 600,
        autoApproveInYolo: true,
        enableMcpInPlanner: true
      }
    };
  }

  public resolveModel(role: string): any {
    return { role, configured: 'inherit', tier: 'inherit', apiModel: 'inherit' };
  }
}

class RecordingWorktreeManager {
  public createWorktreeCallCount = 0;
  public readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  public async createWorktree(options: any): Promise<any> {
    this.createWorktreeCallCount++;
    const worktreePath = path.join(this.root, '.worktrees', String(options.taskId));
    fs.mkdirSync(worktreePath, { recursive: true });
    return {
      taskId: options.taskId,
      worktreePath,
      branch: `task/${options.taskId}`,
      baseBranch: options.baseBranch || 'main',
      createdAt: new Date().toISOString()
    };
  }

  public async removeWorktree(): Promise<void> {}
  public async resolveTaskWorktreePath(_dir: string, taskId: string | number): Promise<string> {
    return path.join(this.root, '.worktrees', String(taskId));
  }
  public resolveTaskBranchName(taskId: string | number): string {
    return `task/${taskId}`;
  }
  public async ensureGitIgnore(): Promise<boolean> {
    return false;
  }
  public async resolveBaseBranch(): Promise<string> {
    return 'main';
  }
  public async pruneWorktrees(): Promise<void> {}
  public async listWorktrees(): Promise<any[]> {
    return [];
  }
  public async cleanOrphanedWorktrees(): Promise<number> {
    return 0;
  }
  public async listBranches(): Promise<string[]> {
    return ['main'];
  }
  public async createBranch(): Promise<void> {}
  public async isAncestor(): Promise<boolean> {
    return false;
  }
  public async getCommitsBetween(): Promise<any[]> {
    return [];
  }
  public async pushBranch(): Promise<boolean> {
    return true;
  }
}

function makePlanGenerator(planDir: string, planPath: string): any {
  return {
    resolvePlanFile: (options: any) => {
      if (options.planPath && fs.existsSync(options.planPath)) {
        return {
          planDir: path.dirname(options.planPath),
          planPath: options.planPath,
          planFileName: path.basename(options.planPath),
          summaryPath: path.join(path.dirname(options.planPath), 'AgyLoop Summary.md')
        };
      }
      if (!fs.existsSync(planDir)) return null;
      return {
        planDir,
        planPath,
        planFileName: path.basename(planPath),
        summaryPath: path.join(planDir, 'AgyLoop Summary.md')
      };
    },
    readPlanDocument: (p: string) => fs.readFileSync(p, 'utf8'),
    hashPlanDocument: (p: string) => `sha256:${fs.readFileSync(p, 'utf8')}`,
    updateSummaryLog: () => true
  };
}

describe('Gate target contract (issue #348)', () => {
  let root: string;
  let planDir: string;
  let planPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-gate-target-'));
    // A REAL repository with an intended, uncommitted change to a tracked file.
    gitOk(root, ['init', '-q']);
    gitOk(root, ['config', 'user.email', 'smoke@example.com']);
    gitOk(root, ['config', 'user.name', 'smoke']);
    fs.writeFileSync(path.join(root, 'package-lock.json'), 'v1\n', 'utf8');
    gitOk(root, ['add', '-A']);
    gitOk(root, ['commit', '-qm', 'seed']);
    fs.writeFileSync(path.join(root, 'package-lock.json'), 'v2\n', 'utf8');

    planDir = path.join(root, 'artifacts/plans/348-gate-target-contract');
    fs.mkdirSync(planDir, { recursive: true });
    planPath = path.join(planDir, 'implementation_plan.md');
    fs.writeFileSync(planPath, planWithTarget(BAD_COMMAND), 'utf8');
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  test('GTC1: codeloop implement refuses at approval, names the command and provisions nothing', async () => {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);

    const stateRepo = new MockStateRepository(sm.toSnapshot());
    const worktreeManager = new RecordingWorktreeManager(root);
    const useCase = new StartImplementationUseCase(
      stateRepo as any,
      new MockConfigRepository() as any,
      makePlanGenerator(planDir, planPath),
      undefined,
      undefined,
      worktreeManager as any
    );

    await assert.rejects(
      () => useCase.execute({ issue: ISSUE, workspaceDir: root }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'gateTargets');
        assert.ok(err.message.includes(BAD_COMMAND), err.message);
        assert.ok(err.message.includes('can never pass'), err.message);
        assert.ok(err.message.includes('UNCOMMITTED'), err.message);
        assert.match(err.message, /plan line 5/, err.message);
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCallCount, 0, 'a refused approval must persist nothing');
    assert.strictEqual(
      stateRepo.snapshot.currentStage,
      STAGE_APPROVAL,
      'the checkpoint must stay at APPROVAL'
    );
    assert.strictEqual(
      worktreeManager.createWorktreeCallCount,
      0,
      'a refused approval must not provision a worktree'
    );
    assert.ok(!fs.existsSync(path.join(root, '.worktrees')), 'no orphan worktree may exist');
  });

  test('GTC2: transition APPROVAL refuses, then accepts the rewritten plan', async () => {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);

    const stateRepo = new MockStateRepository(sm.toSnapshot());
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath)
    );

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'gateTargets');
        assert.ok(err.message.includes(BAD_COMMAND), err.message);
        assert.ok(err.message.includes('can never pass'), err.message);
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCallCount, 0, 'the refused transition must not checkpoint');
    assert.strictEqual(
      stateRepo.snapshot.currentStage,
      STAGE_PLAN,
      'the on-disk checkpoint must still be PLAN'
    );

    fs.writeFileSync(planPath, planWithTarget('npm run build'), 'utf8');
    const approved = await useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root });

    assert.strictEqual(approved.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_APPROVAL);
  });

  test('GTC3: the intended uncommitted change makes the assertion exit 1', () => {
    const result = git(root, ['diff', '--exit-code', '--', 'package-lock.json']);
    assert.strictEqual(
      result.status,
      1,
      'a committed-tree assertion must fail on the tree the gate actually runs in'
    );
  });

  test('GTC4: the parser keeps the target and the linter flags it by plan line', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    const parsed = parseQualityGateTargets(content);
    const findings = lintQualityGateTargets(parsed.targets);

    assert.strictEqual(parsed.found, true);
    assert.deepStrictEqual(parsed.commands, [BAD_COMMAND]);
    assert.deepStrictEqual(parsed.unparsed, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].command, BAD_COMMAND);
    assert.strictEqual(findings[0].line, 5);
    assert.strictEqual(findings[0].index, 1);
  });

  test('GTC5: after the refusal nothing is staged and the draft still sees the file', async () => {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);

    const useCase = new StartImplementationUseCase(
      new MockStateRepository(sm.toSnapshot()) as any,
      new MockConfigRepository() as any,
      makePlanGenerator(planDir, planPath)
    );

    await assert.rejects(() => useCase.execute({ issue: ISSUE, workspaceDir: root }));

    const staged = gitOk(root, ['diff', '--cached', '--name-only']).trim();
    assert.strictEqual(staged, '', 'the refusal must stage nothing');

    const unstaged = gitOk(root, ['diff', '--name-only']).trim();
    assert.strictEqual(unstaged, 'package-lock.json');

    // The commit draft enumerates with `git diff HEAD` (draft-commit.ts:117),
    // so the file is visible with or without a legacy staging workaround.
    const stagedAndUnstaged = gitOk(root, ['diff', 'HEAD', '--name-only']).trim();
    assert.strictEqual(stagedAndUnstaged, 'package-lock.json');
  });
});
