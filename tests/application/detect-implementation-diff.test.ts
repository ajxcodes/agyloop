/**
 * agyloop - DetectImplementationDiffUseCase Unit Tests (issue #259, D1-D10;
 * issue #263, P1-P8)
 *
 * The ONE implementation-evidence probe. It answers a single question before
 * the quality gates run: "does the working tree contain an implementation?".
 *
 * The probe is driven through a mock `CommandExecutorPort` — no real git, no
 * real filesystem — so every verdict is deterministic.
 *
 * D8 pins the two-level fail-closed contract introduced by the implementation
 * phase: a verdict that carries a `probeError` is "no verdict", not "no
 * changes". The probe fails closed; its CONSUMERS keep their pre-existing
 * behaviour instead of parking on an absence of information.
 *
 * Issue #263: the executor is a ROUTER, not a replay queue. Each command shape
 * has its own route and an unlisted command throws — so a two-dot
 * `git diff --name-only <ref> -- .` is an unexpected command, and the suite
 * cannot silently regress into the defect it was written to catch.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { DetectImplementationDiffUseCase, RunLifecycleUseCase } = require('../../dist/application');
const {
  STAGE_COMMIT,
  MODE_YOLO,
  WorktreeDescriptor,
  AiReviewReport
} = require('../../dist/domain');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

type CommandExecutorPort = import('../../src').CommandExecutorPort;
type CommandExecutionOptions = import('../../src').CommandExecutionOptions;
type CommandExecutionResult = import('../../src').CommandExecutionResult;

/** The branch point every routing fixture resolves to. */
const MERGE_BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
/** A second, realistic branch point (the #250 live instance). */
const MERGE_BASE_SHA_1823DBF = '1823dbf0123456789abcdef0123456789abcdef0';

/** A successful command result. */
function ok(command: string, stdout: string): CommandExecutionResult {
  return {
    command,
    stdout,
    stderr: '',
    combinedOutput: stdout,
    exitCode: 0,
    durationMs: 1,
    timedOut: false
  };
}

/** A failed command result (non-zero exit). */
function fail(command: string, exitCode: number, stderr = ''): CommandExecutionResult {
  return {
    command,
    stdout: '',
    stderr,
    combinedOutput: stderr,
    exitCode,
    durationMs: 1,
    timedOut: false
  };
}

interface Route {
  match: RegExp;
  result?: CommandExecutionResult;
  /** When true, the executor throws instead of returning a result. */
  throws?: boolean;
}

/**
 * A routing executor: each command shape has exactly one route, so the test
 * declares WHAT every command means instead of the order it arrives in. A
 * command with no route is a test failure — the probe cannot run a command
 * the suite does not know about.
 */
class RoutingCommandExecutor implements CommandExecutorPort {
  public executed: Array<{ command: string; options?: CommandExecutionOptions }> = [];
  private readonly routes: Route[];

  constructor(routes: Route[]) {
    this.routes = routes;
  }

  public async execute(
    command: string,
    options?: CommandExecutionOptions
  ): Promise<CommandExecutionResult> {
    this.executed.push({ command, options });
    const route = this.routes.find((candidate) => candidate.match.test(command));
    if (!route) {
      throw new Error(`unexpected command: ${command}`);
    }
    if (route.throws) {
      throw new Error(`routing executor threw for: ${command}`);
    }
    return route.result!;
  }
}

interface ProbeFixture {
  status?: CommandExecutionResult;
  mergeBase?: CommandExecutionResult;
  diff?: CommandExecutionResult;
  /** Overrides the route itself — used to make a supplementary command throw. */
  ownCommits?: CommandExecutionResult | { throws: true };
  baseAheadCommits?: CommandExecutionResult;
}

/** Builds one route, letting a fixture override the route's outcome. */
function route(
  match: RegExp,
  override: CommandExecutionResult | { throws: true } | undefined,
  fallback: CommandExecutionResult
): Route {
  if (override && 'throws' in override) {
    return { match, throws: true };
  }
  return { match, result: override ?? fallback };
}

/**
 * The five routes of the corrected probe (issue #263 §2.3). Defaults describe
 * a clean, up-to-date tree: resolvable branch point, empty diff, zero commits.
 */
function probeRoutes(fixture: ProbeFixture = {}): Route[] {
  return [
    route(/^git status --porcelain$/, fixture.status, ok('git status --porcelain', '')),
    route(/^git merge-base HEAD /, fixture.mergeBase, ok('git merge-base HEAD', `${MERGE_BASE_SHA}\n`)),
    route(
      /^git diff --name-only [0-9a-f]{7,64} -- \.$/,
      fixture.diff,
      ok('git diff --name-only', '')
    ),
    route(
      /^git rev-list --count [0-9a-f]{7,64}\.\.HEAD$/,
      fixture.ownCommits,
      ok('git rev-list --count', '0\n')
    ),
    route(
      /^git rev-list --count [0-9a-f]{7,64}\.\.'.*'$/,
      fixture.baseAheadCommits,
      ok('git rev-list --count', '0\n')
    )
  ];
}

/** Runs the probe over one routing fixture. */
async function runProbe(
  fixture: ProbeFixture = {},
  params: { workspaceDir?: string; baseRef?: string } = {}
): Promise<{ diff: any; executor: RoutingCommandExecutor }> {
  const executor = new RoutingCommandExecutor(probeRoutes(fixture));
  const useCase = new DetectImplementationDiffUseCase(executor);
  const diff = await useCase.execute({
    workspaceDir: '/mock/workspace',
    baseRef: 'main',
    ...params
  });
  return { diff, executor };
}

describe('DetectImplementationDiffUseCase (issue #259)', () => {
  test('D1: an empty git status yields hasChanges === false', async () => {
    const { diff } = await runProbe();

    assert.strictEqual(diff.hasChanges, false);
    assert.strictEqual(diff.probeError, null);
    assert.strictEqual(diff.baseRef, 'main');
    assert.deepStrictEqual(diff.trackedChangedFiles, []);
    assert.deepStrictEqual(diff.untrackedFiles, []);
  });

  test('D2: a tracked modification yields hasChanges === true and the file is listed', async () => {
    const { diff } = await runProbe({
      status: ok('git status --porcelain', 'M  src/index.ts\n'),
      diff: ok('git diff --name-only', 'src/index.ts\n')
    });

    assert.strictEqual(diff.hasChanges, true);
    assert.strictEqual(diff.probeError, null);
    assert.ok(
      diff.trackedChangedFiles.includes('src/index.ts'),
      `expected 'src/index.ts' to be listed, got: ${JSON.stringify(diff.trackedChangedFiles)}`
    );
  });

  test('D3: only lifecycle noise in git status yields hasChanges === false', async () => {
    const { diff } = await runProbe({
      status: ok(
        'git status --porcelain',
        [
          '?? .agyloop/',
          '?? .codeloop/',
          '?? artifacts/',
          '?? node_modules/',
          '?? plugin.json',
          '?? .gitignore',
          '?? prompts/',
          ''
        ].join('\n')
      )
    });

    assert.strictEqual(diff.hasChanges, false);
    assert.strictEqual(diff.probeError, null);
    assert.deepStrictEqual(diff.trackedChangedFiles, []);
    assert.deepStrictEqual(diff.untrackedFiles, []);
  });

  test('D4: an untracked source file yields hasChanges === true', async () => {
    const { diff } = await runProbe({
      status: ok('git status --porcelain', '?? src/new.ts\n')
    });

    assert.strictEqual(diff.hasChanges, true);
    assert.strictEqual(diff.probeError, null);
    assert.ok(
      diff.untrackedFiles.includes('src/new.ts'),
      `expected 'src/new.ts' to be listed, got: ${JSON.stringify(diff.untrackedFiles)}`
    );
  });

  test('D5: a non-zero exit from git status sets probeError and fails closed (hasChanges === false)', async () => {
    const { diff } = await runProbe({
      status: fail('git status --porcelain', 128, 'fatal: not a git repository')
    });

    assert.notStrictEqual(diff.probeError, null, 'a failed probe must report an error');
    assert.ok(
      diff.probeError!.includes('git status --porcelain'),
      `the error must name the failed probe, got: ${diff.probeError}`
    );
    assert.strictEqual(diff.hasChanges, false, 'the probe fails closed');
    assert.deepStrictEqual(diff.trackedChangedFiles, []);
    assert.deepStrictEqual(diff.untrackedFiles, []);
    assert.strictEqual(diff.measurementError, null);
    assert.strictEqual(diff.mergeBase, null);
    assert.strictEqual(diff.baseAheadCommits, null);
    assert.strictEqual(diff.ownCommits, null);
  });

  test('D6 (AC7): an unresolvable base ref is a measurement error — the base is never relabelled "HEAD (fallback)" and no diff is fabricated', async () => {
    const { diff, executor } = await runProbe({
      mergeBase: fail('git merge-base HEAD', 128, "fatal: Not a valid object name main")
    });

    assert.strictEqual(diff.probeError, null, 'the tree WAS readable');
    assert.notStrictEqual(diff.measurementError, null, 'the branch diff could NOT be measured');
    assert.ok(
      diff.measurementError!.includes('git merge-base HEAD'),
      `the error must name the failed command, got: ${diff.measurementError}`
    );
    assert.strictEqual(diff.mergeBase, null);
    assert.strictEqual(diff.baseAheadCommits, null);
    assert.strictEqual(diff.ownCommits, null);
    assert.strictEqual(diff.baseRef, 'main', 'the requested ref is reported, never a fallback label');
    assert.strictEqual(diff.hasChanges, false, 'hasChanges reflects git status only');
    assert.ok(
      !executor.executed.some((call) => call.command.startsWith('git diff --name-only')),
      `no diff may be attempted without a branch point, got: ${executor.executed
        .map((call) => call.command)
        .join(', ')}`
    );
  });

  test('D7: the probe runs in the supplied workspaceDir (cwd is forwarded to the executor)', async () => {
    const { executor } = await runProbe({}, { workspaceDir: '/mock/workspace-x', baseRef: 'develop' });

    assert.strictEqual(executor.executed.length, 5);
    for (const call of executor.executed) {
      assert.strictEqual(
        call.options?.cwd,
        '/mock/workspace-x',
        `command '${call.command}' must run in the supplied workspaceDir`
      );
    }
    assert.ok(
      executor.executed[1].command.includes('develop'),
      `the supplied base ref must be used, got: ${executor.executed[1].command}`
    );
  });

  test('D8 (AC2): a probeError verdict is "no verdict", not "no changes" — the YOLO run does NOT park and the gate does NOT report VACUOUS', async () => {
    // --- 1. the probe itself fails closed -----------------------------------
    const probe = await new DetectImplementationDiffUseCase(
      new RoutingCommandExecutor(probeRoutes({
        status: fail('git status --porcelain', 128, 'fatal: not a git repository')
      }))
    ).execute({ workspaceDir: '/mock/workspace' });

    assert.notStrictEqual(probe.probeError, null, 'the verdict must carry a probeError');
    assert.strictEqual(probe.hasChanges, false, 'the probe fails closed');

    // --- 2. the CONSUMERS must not read that as "no changes" ----------------
    const harness = buildLifecycleHarness();
    const result = await harness.lifecycle.execute({
      mode: MODE_YOLO,
      issue: 32,
      workspaceDir: '/mock/workspace'
    });

    assert.notStrictEqual(
      result.implementationHalted,
      true,
      'a probeError is no verdict — the run must NOT park on an absence of information'
    );
    assert.ok(result.qualityGateResult, 'the gate must still run');
    assert.notStrictEqual(
      result.qualityGateResult.vacuous,
      true,
      'the gate must NOT report VACUOUS when the probe produced no verdict'
    );
    assert.strictEqual(result.qualityGateResult.passed, true, 'the gate must keep its pre-existing behaviour');
    assert.strictEqual(result.currentStage, STAGE_COMMIT, 'the run must keep its pre-existing behaviour');
  });

  /**
   * A DELETED tracked file is an implementation: the porcelain loop has no
   * status filter for tracked entries, so ` D` (deleted in the working tree)
   * and `D ` (deleted and staged) both fall through to the tracked branch.
   *
   * Nothing pinned that, so a future "skip deletions" change would silently
   * make a deletion-only tree look unimplemented — and the gate would then
   * refuse to certify a tree that really was implemented.
   */
  test('D9: a deleted tracked file (unstaged) yields hasChanges === true and the file is listed', async () => {
    const { diff } = await runProbe({
      status: ok('git status --porcelain', ' D src/removed.ts\n'),
      diff: ok('git diff --name-only', 'src/removed.ts\n')
    });

    assert.strictEqual(diff.hasChanges, true, 'a deletion is an implementation');
    assert.strictEqual(diff.probeError, null);
    assert.ok(
      diff.trackedChangedFiles.includes('src/removed.ts'),
      `expected 'src/removed.ts' to be listed, got: ${JSON.stringify(diff.trackedChangedFiles)}`
    );
  });

  test('D10: a deleted tracked file (staged) yields hasChanges === true and the file is listed', async () => {
    const { diff } = await runProbe({
      status: ok('git status --porcelain', 'D  src/removed.ts\n'),
      diff: ok('git diff --name-only', 'src/removed.ts\n')
    });

    assert.strictEqual(diff.hasChanges, true, 'a staged deletion is an implementation');
    assert.strictEqual(diff.probeError, null);
    assert.ok(
      diff.trackedChangedFiles.includes('src/removed.ts'),
      `expected 'src/removed.ts' to be listed, got: ${JSON.stringify(diff.trackedChangedFiles)}`
    );
  });
});

describe('DetectImplementationDiffUseCase — merge-base-relative measurement (issue #263)', () => {
  test('P1 (AC1, AC2): a clean worktree whose base advanced reports ZERO changed files, not the base\'s N', async () => {
    const { diff, executor } = await runProbe({
      baseAheadCommits: ok('git rev-list --count', '3\n')
    });

    assert.strictEqual(diff.hasChanges, false);
    assert.deepStrictEqual(diff.trackedChangedFiles, []);
    assert.strictEqual(diff.baseAheadCommits, 3);
    assert.strictEqual(diff.ownCommits, 0);

    const diffCommands = executor.executed.filter((call) =>
      call.command.startsWith('git diff --name-only')
    );
    assert.strictEqual(diffCommands.length, 1, 'exactly one diff command may run');
    assert.ok(
      diffCommands[0].command.includes(MERGE_BASE_SHA),
      `the diff must be merge-base-relative, got: ${diffCommands[0].command}`
    );
    assert.ok(
      !executor.executed.some((call) => /^git diff --name-only main/.test(call.command)),
      `the base ref's TIP must never be the diff target, got: ${executor.executed
        .map((call) => call.command)
        .join(', ')}`
    );
  });

  test('P2 (AC1, AC3): a branch with its own commit reports ONLY its own file when the base advanced', async () => {
    const { diff } = await runProbe({
      diff: ok('git diff --name-only', 'src/impl.ts\n'),
      ownCommits: ok('git rev-list --count', '1\n'),
      baseAheadCommits: ok('git rev-list --count', '2\n')
    });

    assert.deepStrictEqual(diff.trackedChangedFiles, ['src/impl.ts']);
    assert.strictEqual(diff.hasChanges, true);
  });

  test('P3 (AC4): the committed and uncommitted signals reconcile into one de-duplicated list', async () => {
    const { diff } = await runProbe({
      status: ok('git status --porcelain', ' M src/index.ts\n?? src/new.ts\n'),
      diff: ok('git diff --name-only', 'src/index.ts\n')
    });

    assert.deepStrictEqual(diff.trackedChangedFiles, ['src/index.ts']);
    assert.deepStrictEqual(diff.untrackedFiles, ['src/new.ts']);
    assert.strictEqual(
      diff.trackedChangedFiles.length + diff.untrackedFiles.length,
      2,
      'a file present in both signals must be counted once'
    );
  });

  test('P4 (AC6): the verdict carries the branch point and both commit counts', async () => {
    const { diff } = await runProbe({
      mergeBase: ok('git merge-base HEAD', `${MERGE_BASE_SHA_1823DBF}\n`),
      diff: ok('git diff --name-only', 'src/impl.ts\n'),
      ownCommits: ok('git rev-list --count', '1\n'),
      baseAheadCommits: ok('git rev-list --count', '2\n')
    });

    assert.strictEqual(diff.baseAheadCommits, 2);
    assert.strictEqual(diff.ownCommits, 1);
    assert.strictEqual(diff.mergeBase, MERGE_BASE_SHA_1823DBF);
    assert.strictEqual(diff.measurementError, null);
  });

  test('P5 (AC6, negative): an up-to-date branch reports baseAheadCommits === 0 and its verdict is unchanged', async () => {
    const { diff } = await runProbe({
      diff: ok('git diff --name-only', 'src/impl.ts\n'),
      ownCommits: ok('git rev-list --count', '4\n'),
      baseAheadCommits: ok('git rev-list --count', '0\n')
    });

    assert.strictEqual(diff.baseAheadCommits, 0);
    assert.strictEqual(diff.hasChanges, true);
    assert.deepStrictEqual(diff.trackedChangedFiles, ['src/impl.ts']);
  });

  test('P6 (AC6): an absent commit count is null (unknown), never 0, and is NOT a measurement error', async () => {
    const { diff } = await runProbe({
      ownCommits: { throws: true },
      baseAheadCommits: ok('git rev-list --count', '')
    });

    assert.strictEqual(diff.ownCommits, null);
    assert.strictEqual(diff.baseAheadCommits, null);
    assert.strictEqual(diff.measurementError, null);
    assert.strictEqual(diff.hasChanges, false);
    assert.notStrictEqual(diff.mergeBase, null, 'the measurement itself succeeded');
  });

  test('P7 (AC2, AC7, RV2): an empty or garbage merge-base never builds a diff command', async () => {
    for (const mergeBase of ['', 'All 10 tests passing\n']) {
      const { diff, executor } = await runProbe({
        mergeBase: ok('git merge-base HEAD', mergeBase)
      });

      assert.notStrictEqual(diff.measurementError, null, `merge-base '${mergeBase}' must not be accepted`);
      assert.strictEqual(diff.mergeBase, null);
      assert.ok(
        !executor.executed.some((call) => call.command.startsWith('git diff --name-only')),
        'no diff command may be emitted without a validated SHA'
      );
      for (const call of executor.executed) {
        assert.ok(
          !call.command.includes('--name-only  --') && !call.command.includes('--name-only --'),
          `an empty SHA was interpolated: ${call.command}`
        );
      }
    }
  });

  test('P8 (hardening): the base ref is shell-quoted, so shell metacharacters never reach the command raw', async () => {
    const payload = 'main; touch /tmp/pwned';
    const quoted = `'${payload}'`;
    const { executor } = await runProbe({}, { baseRef: payload });

    for (const call of executor.executed) {
      if (!call.command.includes('pwned')) {
        continue;
      }
      assert.ok(
        call.command.includes(quoted),
        `the payload must appear quoted, got: ${call.command}`
      );
      assert.ok(
        !call.command.split(quoted).join('').includes('pwned'),
        `the raw payload leaked into the command: ${call.command}`
      );
    }
  });
});

/* ------------------------------------------------------------------------- *
 * A minimal lifecycle harness for D8.
 *
 * The point of D8 is the CONSUMER side of the verdict, so the lifecycle has to
 * run for real — with every external dependency mocked.
 * ------------------------------------------------------------------------- */

class MockStateRepository {
  public savedSnapshot: any = null;

  public async load(): Promise<any> {
    return this.savedSnapshot;
  }

  public async save(snapshot: any): Promise<void> {
    this.savedSnapshot = snapshot;
  }

  public async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  public getStateFilePath(): string {
    return '/mock/workspace/.agyloop/state.json';
  }
}

class MockConfigRepository {
  public config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  public loadConfig(): any {
    return this.config;
  }

  public resolveModel(role: string): any {
    return { role, configured: 'default', tier: 'flash', apiModel: 'gemini-2.5-flash' };
  }

  public mapModelToTier(): string {
    return 'flash';
  }
}

class MockPlanGenerator {
  public planContent = '# Test Plan\n\n## Acceptance Criteria\n- [ ] Code compiles\n- [ ] Tests pass\n';

  public scaffoldPlanDirectory(params: any): any {
    return {
      folderName: '32-test-feature',
      planDir: '/mock/workspace/artifacts/plans/32-test-feature',
      planPath: '/mock/workspace/artifacts/plans/32-test-feature/implementation-plan.md',
      summaryPath: '/mock/workspace/artifacts/plans/32-test-feature/summary-log.md',
      mirrorPath: null,
      type: 'implementation'
    };
  }

  public resolvePlanFile(): any {
    return {
      folderName: '32-test-feature',
      planDir: '/mock/workspace/artifacts/plans/32-test-feature',
      planPath: '/mock/workspace/artifacts/plans/32-test-feature/implementation-plan.md',
      summaryPath: '/mock/workspace/artifacts/plans/32-test-feature/summary-log.md',
      mirrorPath: null,
      type: 'implementation'
    };
  }

  public readPlanDocument(): string {
    return this.planContent;
  }

  public updateSummaryLog(): boolean {
    return true;
  }
}

class MockGitHubGateway {
  public async getCurrentRepo(): Promise<string> {
    return 'ajxcodes/agyloop';
  }

  public async fetchIssue(): Promise<any> {
    return { number: 32, title: 'Implementation evidence probe', body: '', labels: ['feature'] };
  }
}

/**
 * The executor every lifecycle dependency shares. `git status --porcelain`
 * FAILS (the tree cannot be read), every other command succeeds.
 */
class UnreadableTreeCommandExecutor implements CommandExecutorPort {
  public async execute(
    command: string,
    options?: CommandExecutionOptions
  ): Promise<CommandExecutionResult> {
    if (command === 'git status --porcelain') {
      return fail(command, 128, 'fatal: not a git repository');
    }
    return ok(command, 'All 10 tests passing\nBuild completed successfully');
  }
}

class MockBuildDetector {
  public detect(): any {
    return {
      ecosystem: 'node',
      hasBuild: true,
      hasTest: true,
      hasLint: false,
      hasTypecheck: true,
      commands: [{ id: 'test', label: 'Automated Test Suite (npm)', command: 'npm test' }]
    };
  }

  public resolveCommands(): any[] {
    return [{ id: 'test', label: 'Automated Test Suite (npm)', command: 'npm test' }];
  }
}

class MockStandardsRepository {
  public loadStandards(): string {
    return '# Repository Coding Standards\n';
  }

  public findStandardsPath(): string {
    return '/mock/workspace/.github/critique.md';
  }
}

class MockCritique {
  public reviewResult: any = AiReviewReport.parse(
    JSON.stringify({
      summary: 'All code meets requirements and standards.',
      confidenceLevel: 'High',
      confidenceExplanation: 'Clean diff with passing tests.',
      resolvedThreads: [],
      comments: []
    })
  );

  public async review(): Promise<any> {
    return this.reviewResult;
  }
}

class MockConfirmationPrompt {
  public async confirm(): Promise<boolean> {
    return true;
  }
}

class MockWorktreeManager {
  public async createWorktree(params: any): Promise<any> {
    return WorktreeDescriptor.create({
      taskId: params.issueNumber || 999,
      worktreePath: `/mock/workspace/.worktrees/${params.issueNumber || 999}`,
      branch: `task/${params.issueNumber || 999}`,
      baseBranch: params.baseBranch || 'main'
    });
  }

  public async removeWorktree(): Promise<void> {}
  public async cleanOrphanedWorktrees(): Promise<number> {
    return 0;
  }
  public async resolveTaskWorktreePath(): Promise<string | null> {
    return '/mock/workspace/.worktrees/999';
  }
  public async resolveTaskBranchName(): Promise<string> {
    return 'task/999';
  }
}

/** Builds a YOLO lifecycle whose tree can NEVER be read by the probe. */
function buildLifecycleHarness(): { lifecycle: any; stateRepo: MockStateRepository } {
  const stateRepo = new MockStateRepository();
  const commandExecutor = new UnreadableTreeCommandExecutor();

  const lifecycle = new RunLifecycleUseCase({
    stateRepo,
    configRepo: new MockConfigRepository(),
    planGenerator: new MockPlanGenerator(),
    githubGateway: new MockGitHubGateway(),
    commandExecutor,
    buildDetector: new MockBuildDetector(),
    standardsRepo: new MockStandardsRepository(),
    critique: new MockCritique(),
    confirmationPrompt: new MockConfirmationPrompt(),
    worktreeManager: new MockWorktreeManager()
  });

  return { lifecycle, stateRepo };
}
