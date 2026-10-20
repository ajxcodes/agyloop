/**
 * agyloop - DetectImplementationDiffUseCase Unit Tests (issue #259, D1-D8)
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

/**
 * A mock executor that replays a queue of responses and records every call
 * together with the options it received (so the forwarded `cwd` is
 * observable).
 */
class MockCommandExecutor implements CommandExecutorPort {
  public executed: Array<{ command: string; options?: CommandExecutionOptions }> = [];
  public responses: CommandExecutionResult[];

  constructor(responses: CommandExecutionResult[] = []) {
    this.responses = [...responses];
  }

  public async execute(
    command: string,
    options?: CommandExecutionOptions
  ): Promise<CommandExecutionResult> {
    this.executed.push({ command, options });
    if (this.responses.length > 0) {
      return this.responses.shift()!;
    }
    return ok(command, '');
  }
}

describe('DetectImplementationDiffUseCase (issue #259)', () => {
  test('D1: an empty git status yields hasChanges === false', async () => {
    const executor = new MockCommandExecutor([
      ok('git status --porcelain', ''),
      ok('git diff --name-only main -- .', '')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    const diff = await useCase.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(diff.hasChanges, false);
    assert.strictEqual(diff.probeError, null);
    assert.strictEqual(diff.baseRef, 'main');
    assert.deepStrictEqual(diff.trackedChangedFiles, []);
    assert.deepStrictEqual(diff.untrackedFiles, []);
  });

  test('D2: a tracked modification yields hasChanges === true and the file is listed', async () => {
    const executor = new MockCommandExecutor([
      ok('git status --porcelain', 'M  src/index.ts\n'),
      ok('git diff --name-only main -- .', '')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    const diff = await useCase.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(diff.hasChanges, true);
    assert.strictEqual(diff.probeError, null);
    assert.ok(
      diff.trackedChangedFiles.includes('src/index.ts'),
      `expected 'src/index.ts' to be listed, got: ${JSON.stringify(diff.trackedChangedFiles)}`
    );
  });

  test('D3: only lifecycle noise in git status yields hasChanges === false', async () => {
    const executor = new MockCommandExecutor([
      ok(
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
      ),
      ok('git diff --name-only main -- .', '')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    const diff = await useCase.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(diff.hasChanges, false);
    assert.strictEqual(diff.probeError, null);
    assert.deepStrictEqual(diff.trackedChangedFiles, []);
    assert.deepStrictEqual(diff.untrackedFiles, []);
  });

  test('D4: an untracked source file yields hasChanges === true', async () => {
    const executor = new MockCommandExecutor([
      ok('git status --porcelain', '?? src/new.ts\n'),
      ok('git diff --name-only main -- .', '')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    const diff = await useCase.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(diff.hasChanges, true);
    assert.strictEqual(diff.probeError, null);
    assert.ok(
      diff.untrackedFiles.includes('src/new.ts'),
      `expected 'src/new.ts' to be listed, got: ${JSON.stringify(diff.untrackedFiles)}`
    );
  });

  test('D5: a non-zero exit from git status sets probeError and fails closed (hasChanges === false)', async () => {
    const executor = new MockCommandExecutor([
      fail('git status --porcelain', 128, 'fatal: not a git repository')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    const diff = await useCase.execute({ workspaceDir: '/mock/workspace' });

    assert.notStrictEqual(diff.probeError, null, 'a failed probe must report an error');
    assert.ok(
      diff.probeError!.includes('git status --porcelain'),
      `the error must name the failed probe, got: ${diff.probeError}`
    );
    assert.strictEqual(diff.hasChanges, false, 'the probe fails closed');
    assert.deepStrictEqual(diff.trackedChangedFiles, []);
    assert.deepStrictEqual(diff.untrackedFiles, []);
  });

  test('D6: a non-zero exit from git diff (unknown base ref) is not an error and falls back to HEAD', async () => {
    const executor = new MockCommandExecutor([
      ok('git status --porcelain', ''),
      fail('git diff --name-only main -- .', 128, "fatal: ambiguous argument 'main'"),
      ok('git diff --name-only HEAD -- .', 'src/committed.ts\n')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    const diff = await useCase.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(diff.probeError, null, 'an unknown base ref is not a probe error');
    assert.strictEqual(diff.baseRef, 'HEAD (fallback)');
    assert.strictEqual(diff.hasChanges, true);
    assert.ok(
      diff.trackedChangedFiles.includes('src/committed.ts'),
      `the HEAD fallback must still report the committed work, got: ${JSON.stringify(diff.trackedChangedFiles)}`
    );
  });

  test('D7: the probe runs in the supplied workspaceDir (cwd is forwarded to the executor)', async () => {
    const executor = new MockCommandExecutor([
      ok('git status --porcelain', ''),
      ok('git diff --name-only develop -- .', '')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    await useCase.execute({ workspaceDir: '/mock/workspace-x', baseRef: 'develop' });

    assert.strictEqual(executor.executed.length, 2);
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
    const probeExecutor = new MockCommandExecutor([
      fail('git status --porcelain', 128, 'fatal: not a git repository')
    ]);
    const probe = await new DetectImplementationDiffUseCase(probeExecutor).execute({
      workspaceDir: '/mock/workspace'
    });

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
    const executor = new MockCommandExecutor([
      ok('git status --porcelain', ' D src/removed.ts\n'),
      ok('git diff --name-only main -- .', '')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    const diff = await useCase.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(diff.hasChanges, true, 'a deletion is an implementation');
    assert.strictEqual(diff.probeError, null);
    assert.ok(
      diff.trackedChangedFiles.includes('src/removed.ts'),
      `expected 'src/removed.ts' to be listed, got: ${JSON.stringify(diff.trackedChangedFiles)}`
    );
  });

  test('D10: a deleted tracked file (staged) yields hasChanges === true and the file is listed', async () => {
    const executor = new MockCommandExecutor([
      ok('git status --porcelain', 'D  src/removed.ts\n'),
      ok('git diff --name-only main -- .', '')
    ]);
    const useCase = new DetectImplementationDiffUseCase(executor);

    const diff = await useCase.execute({ workspaceDir: '/mock/workspace' });

    assert.strictEqual(diff.hasChanges, true, 'a staged deletion is an implementation');
    assert.strictEqual(diff.probeError, null);
    assert.ok(
      diff.trackedChangedFiles.includes('src/removed.ts'),
      `expected 'src/removed.ts' to be listed, got: ${JSON.stringify(diff.trackedChangedFiles)}`
    );
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
