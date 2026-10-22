/**
 * agyloop - DetectImplementationDiffUseCase against REAL git histories
 * (issue #263, R1-R5)
 *
 * The unit suite (detect-implementation-diff.test.ts) pins the probe's command
 * shapes. This suite pins the thing the command shapes are FOR: two real
 * histories in a temporary repository, where the base branch advances after
 * the task worktree was created.
 *
 * Every fixture is built with `git` in a fresh `mkdtempSync` directory, and
 * the probe is driven through the REAL `ProcessCommandExecutor` — so a
 * two-dot diff cannot hide behind a mock.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { DetectImplementationDiffUseCase } = require('../../dist/application');
const { ProcessCommandExecutor } = require('../../dist/infrastructure');

type CommandExecutorPort = import('../../src').CommandExecutorPort;
type CommandExecutionOptions = import('../../src').CommandExecutionOptions;
type CommandExecutionResult = import('../../src').CommandExecutionResult;

/** The suite is skipped when git is not installed. */
const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;

/** Every fixture root created by this file, removed in `after()`. */
const fixtureRoots: string[] = [];

after(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface Fixture {
  repo: string;
  wt: string;
  /** The commit the task branch was created at (the branch point). */
  branchPoint: string;
}

/**
 * Builds the fixture:
 *
 *   main:  commit 1 (a.txt, b.txt)
 *          commit 2 (base.txt)        <- the task branch is created HERE
 *   task/263: optionally one own commit, optionally one uncommitted edit
 *   main:  +3 unrelated commits (the base branch advances — the default case)
 */
function buildFixture(
  options: { ownCommit?: boolean; dirtyTrackedEdit?: boolean; baseAdvance?: number } = {}
): Fixture {
  const { ownCommit = false, dirtyTrackedEdit = false, baseAdvance = 3 } = options;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-263-'));
  fixtureRoots.push(root);
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');

  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base: initial']);

  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base: second']);
  const branchPoint = git(repo, ['rev-parse', 'HEAD']).trim();

  git(repo, ['worktree', 'add', '-q', '-b', 'task/263', wt, 'main']);

  if (ownCommit) {
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'impl.ts'), 'export const impl = 1;\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-qm', 'feat: own work']);
  }

  if (dirtyTrackedEdit) {
    fs.appendFileSync(path.join(wt, 'a.txt'), 'dirty\n');
  }

  const advances: Array<() => void> = [
    () => {
      fs.appendFileSync(path.join(repo, 'a.txt'), 'a2\n');
      git(repo, ['commit', '-qam', 'base: advance a']);
    },
    () => {
      fs.appendFileSync(path.join(repo, 'b.txt'), 'b2\n');
      git(repo, ['commit', '-qam', 'base: advance b']);
    },
    () => {
      fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'base: add c']);
    }
  ];
  for (const advance of advances.slice(0, baseAdvance)) {
    advance();
  }

  return { repo, wt, branchPoint };
}

/** Drives the REAL probe over a fixture. */
async function runProbe(
  workspaceDir: string,
  baseRef = 'main',
  executor: CommandExecutorPort = new ProcessCommandExecutor()
): Promise<any> {
  return new DetectImplementationDiffUseCase(executor).execute({ workspaceDir, baseRef });
}

/** Records every command while delegating to the real executor. */
class RecordingCommandExecutor implements CommandExecutorPort {
  public executed: string[] = [];
  private readonly inner: CommandExecutorPort;

  constructor(inner: CommandExecutorPort) {
    this.inner = inner;
  }

  public async execute(
    command: string,
    options?: CommandExecutionOptions
  ): Promise<CommandExecutionResult> {
    this.executed.push(command);
    return this.inner.execute(command, options);
  }
}

describe(
  'DetectImplementationDiffUseCase — real git histories (issue #263)',
  { skip: GIT_AVAILABLE ? false : 'git is not available' },
  () => {
    test('R1 (AC1, AC2): a clean worktree behind the base reports ZERO files — while the two-dot diff reports the base\'s files', async () => {
      const fixture = buildFixture();
      const diff = await runProbe(fixture.wt);

      assert.strictEqual(diff.hasChanges, false);
      assert.deepStrictEqual(diff.trackedChangedFiles, []);
      assert.deepStrictEqual(diff.untrackedFiles, []);
      assert.strictEqual(diff.baseAheadCommits, 3);
      assert.strictEqual(diff.ownCommits, 0);

      // Control: the OLD two-dot form really does report the base's work.
      const twoDot = git(fixture.wt, ['diff', '--name-only', 'main', '--', '.'])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      assert.deepStrictEqual(
        twoDot.sort(),
        ['a.txt', 'b.txt', 'c.txt'],
        'the control must demonstrate that the two-dot form was wrong'
      );
    });

    test('R2 (AC3): a worktree with its own commit reports ONLY its own file when the base advanced', async () => {
      const fixture = buildFixture({ ownCommit: true });
      const diff = await runProbe(fixture.wt);

      assert.deepStrictEqual(diff.trackedChangedFiles, ['src/impl.ts']);
      assert.strictEqual(diff.hasChanges, true);
    });

    test('R3 (AC4, RV1): an uncommitted edit on a stale branch reports exactly that file (guards against a `...HEAD`-only fix)', async () => {
      const fixture = buildFixture({ dirtyTrackedEdit: true });
      const diff = await runProbe(fixture.wt);

      assert.deepStrictEqual(diff.trackedChangedFiles, ['a.txt']);
      assert.deepStrictEqual(diff.untrackedFiles, []);
      assert.strictEqual(diff.hasChanges, true);
      assert.strictEqual(diff.ownCommits, 0);
      assert.strictEqual(diff.baseAheadCommits, 3);
    });

    test('R4 (AC6): the verdict reports the branch point and both distances', async () => {
      const fixture = buildFixture({ ownCommit: true });
      const diff = await runProbe(fixture.wt);

      assert.strictEqual(diff.baseAheadCommits, 3);
      assert.strictEqual(diff.ownCommits, 1);
      assert.strictEqual(diff.mergeBase, fixture.branchPoint);
      assert.strictEqual(diff.measurementError, null);
    });

    test('R5 (AC7): an unresolvable base ref is reported as unmeasurable, and no diff command runs', async () => {
      const fixture = buildFixture();
      const executor = new RecordingCommandExecutor(new ProcessCommandExecutor());
      const diff = await runProbe(fixture.wt, 'does-not-exist', executor);

      assert.notStrictEqual(diff.measurementError, null);
      assert.ok(
        diff.measurementError!.includes('does-not-exist'),
        `the error must name the base ref, got: ${diff.measurementError}`
      );
      assert.strictEqual(diff.mergeBase, null);
      assert.strictEqual(diff.hasChanges, false);
      assert.ok(
        !executor.executed.some((command) => command.startsWith('git diff --name-only')),
        `no diff command may run without a branch point, got: ${executor.executed.join(', ')}`
      );
    });
  }
);
