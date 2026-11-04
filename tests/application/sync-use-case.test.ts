/**
 * Tests for SyncUseCase (Application Layer)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SyncUseCase } = require('../../dist/application');
const { writeBuildStamp } = require('../../bin/stale-dist.js');

/**
 * Issue #516: a real-filesystem fixture whose `src/` and `dist/` agree. The
 * default `detectStaleDist` reads it, so the post-pull re-check is measured, not
 * simulated.
 */
function makeFreshnessFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-sync-freshness-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist', 'presentation'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.ts'), 'export const x = 1;\n');
  fs.writeFileSync(
    path.join(dir, 'dist', 'presentation', 'cli.js'),
    'module.exports = {};\n'
  );
  writeBuildStamp(dir);
  return dir;
}

class MockCommandExecutor {
  executedCommands: string[] = [];
  responses: Record<string, any> = {};
  /** Issue #516: runs when the collector branch is fast-forwarded. */
  pullHook?: () => void;

  async execute(command: string, options?: any) {
    this.executedCommands.push(command);
    if (this.pullHook && command.startsWith('git pull')) {
      this.pullHook();
    }
    if (this.responses[command]) {
      return this.responses[command];
    }
    return { stdout: '', exitCode: 0 };
  }
}

class MockGitHubGateway {
  issues: any[] = [];
  closedIssues: number[] = [];
  comments: { issueId: number, body: string }[] = [];
  /** Issues the fail-closed read refuses to report (drives a thrown read). */
  strictErrors: Record<number, string> = {};
  /** Spy: `sync` must never make a write decision from the lenient read (#328). */
  fetchIssueCalls: number[] = [];
  closeIssueError?: string;

  async fetchIssue(issueId: number) {
    this.fetchIssueCalls.push(issueId);
    throw new Error('the lenient read must never authorize a write (#328)');
  }

  async fetchIssueStrict(issueId: number) {
    const failure = this.strictErrors[issueId];
    if (failure) {
      throw new Error(failure);
    }
    const issue = this.issues.find(i => i.id === issueId);
    if (!issue) {
      throw new Error(`gh issue view ${issueId} returned nothing`);
    }
    return { number: issue.id, state: issue.state };
  }

  async closeIssue(issueId: number) {
    if (this.closeIssueError) {
      throw new Error(this.closeIssueError);
    }
    this.closedIssues.push(issueId);
  }

  async commentOnIssue(issueId: number, body: string) {
    this.comments.push({ issueId, body });
  }
}

class MockStateRepo {
  snapshot: any = null;

  async load() {
    return this.snapshot;
  }
}

class MockWorktreeManager {
  baseBranch: string = 'main';

  async resolveBaseBranch() {
    return this.baseBranch;
  }
}

describe('SyncUseCase', () => {
  test('resolves base branch, fetches, fast-forwards, and processes merged PRs', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
    executor.responses["gh pr list --base 'phase/123' --state merged --limit 100 --json number,title,body"] = {
      stdout: JSON.stringify([
        { number: 42, title: 'Fix bug', body: 'Closes #10' }
      ])
    };
    // Issue #240/Defect 3: the compensator reads the PR's OWN diff before it
    // closes anything.
    executor.responses["gh pr view 42 --json files --jq '.files[].path'"] = {
      exitCode: 0,
      stdout: 'src/app.ts\ntests/unit/app.test.ts\n'
    };

    github.issues.push({ id: 10, state: 'OPEN' });

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.ok(executor.executedCommands.includes('git fetch origin'));
    assert.ok(executor.executedCommands.includes("git pull --ff-only origin 'phase/123'"));

    assert.ok(github.closedIssues.includes(10));
    // (#262) The auto-close comment names the collector branch — the backticks
    // and the branch name must both survive the trip to GitHub. (#284) It also
    // states only what the diff proves: one non-test source file changed.
    assert.ok(
      github.comments.some(
        (c: { issueId: number; body: string }) =>
          c.issueId === 10 &&
          c.body ===
            'Closed by codeloop sync: PR #42 into `phase/123` changed 1 non-test file(s) (Closes #10).'
      ),
      `the auto-close comment must carry the collector branch verbatim, got: ${JSON.stringify(github.comments)}`
    );
    assert.ok(result.logs !== undefined, 'Result should include logs metadata');
    assert.ok(result.logs.some((l: string) => l.includes('Closed issue #10')));
  });

  test('fast-forwards branch without checking out if not currently on it', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/456' };
    executor.responses["gh pr list --base 'phase/123' --state merged --limit 100 --json number,title,body"] = {
      stdout: '[]'
    };

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.ok(executor.executedCommands.includes("git fetch origin 'phase/123:phase/123'"));
  });

  test('does NOT close an issue on a test-only PR (issue #240/Defect 3)', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
    executor.responses["gh pr list --base 'phase/123' --state merged --limit 100 --json number,title,body"] = {
      stdout: JSON.stringify([{ number: 9, title: 'no-op', body: 'Closes #250' }])
    };
    executor.responses["gh pr view 9 --json files --jq '.files[].path'"] = {
      exitCode: 0,
      stdout: 'tests/x.test.ts\n'
    };

    github.issues.push({ id: 250, state: 'OPEN' });

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(github.closedIssues, [], 'a no-op PR must never close an issue');
    assert.deepStrictEqual(github.comments, [], 'and it must not assert an implementation');
    assert.ok(result.warnings !== undefined);
    assert.ok(
      result.warnings.some((w: string) =>
        w.includes('Not closing #250: PR #9 contains no non-test source change')
      ),
      `the skip must be explained, got: ${JSON.stringify(result.warnings)}`
    );
  });

  test('does NOT close an issue when the PR diff cannot be verified (fail closed)', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
    executor.responses["gh pr list --base 'phase/123' --state merged --limit 100 --json number,title,body"] = {
      stdout: JSON.stringify([{ number: 11, title: 'gh down', body: 'Closes #251' }])
    };
    executor.responses["gh pr view 11 --json files --jq '.files[].path'"] = {
      exitCode: 1,
      stdout: ''
    };

    github.issues.push({ id: 251, state: 'OPEN' });

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(github.closedIssues, []);
    assert.ok(result.warnings !== undefined);
    assert.ok(
      result.warnings.some((w: string) =>
        w.includes('Not closing #251: could not verify the diff of PR #11')
      ),
      `the unverifiable PR must be reported, got: ${JSON.stringify(result.warnings)}`
    );
  });

  test('returns warnings in result metadata if an operation fails', async () => {    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    
    // Simulate fetch failure
    executor.execute = async (cmd) => {
      if (cmd === 'git fetch origin') {
        throw new Error('Network error');
      }
      if (cmd.startsWith('gh pr list')) {
        return { stdout: '[]', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.ok(result.warnings !== undefined, 'Result should include warnings metadata');
    assert.ok(result.warnings.some((w: string) => w.includes('Failed to fetch from origin: Network error')));
  });

  /**
   * Builds the standard harness: a `phase/123` collector branch, the merged PRs
   * given, and `src/app.ts` as each PR's verified diff.
   */
  function harness(
    prs: { number: number; body: string }[]
  ): { executor: MockCommandExecutor; github: MockGitHubGateway; useCase: any } {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
    executor.responses["gh pr list --base 'phase/123' --state merged --limit 100 --json number,title,body"] = {
      stdout: JSON.stringify(prs)
    };
    for (const pr of prs) {
      executor.responses[`gh pr view ${pr.number} --json files --jq '.files[].path'`] = {
        exitCode: 0,
        stdout: 'src/app.ts\n'
      };
    }

    return { executor, github, useCase: new SyncUseCase(executor, github, state, worktree) };
  }

  /**
   * #328 AC-328.1/AC-328.3 — the defect: an unreadable issue used to be closed
   * and commented on, because the lenient read returned `state: 'UNKNOWN'` and
   * the guard was `state !== 'CLOSED'`.
   */
  test('fails closed when the strict issue read throws', async () => {
    const { github, useCase } = harness([{ number: 901, body: 'Closes #306' }]);
    github.strictErrors[306] = 'GitHub context error during \'fetchIssueStrict #306\': HTTP 502: Bad Gateway';

    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.deepStrictEqual(github.closedIssues, [], 'an unreadable issue must never be closed');
    assert.deepStrictEqual(github.comments, [], 'and it must never be commented on');
    assert.deepStrictEqual(github.fetchIssueCalls, [], 'the lenient read must not be consulted');
    assert.strictEqual(result.success, false);
    assert.match(result.message, /#306/);
    assert.ok(
      result.logs!.includes(
        "Skipped #306: unreadable (GitHub context error during 'fetchIssueStrict #306': HTTP 502: Bad Gateway)"
      ),
      `the skip must name the issue and the reason, got: ${JSON.stringify(result.logs)}`
    );
    assert.ok(
      result.warnings!.some((w: string) => w.includes('Not closing #306: could not read the issue')),
      `a warning must explain the skip, got: ${JSON.stringify(result.warnings)}`
    );
  });

  test('never consults the lenient fetchIssue for a write decision', async () => {
    const { github, useCase } = harness([{ number: 42, body: 'Closes #10' }]);
    github.issues.push({ id: 10, state: 'OPEN' });

    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.deepStrictEqual(github.fetchIssueCalls, [], 'fetchIssue is prompt-only (#328, INV-5)');
    assert.deepStrictEqual(github.closedIssues, [10]);
    assert.strictEqual(result.success, true);
  });

  test('an unexpected issue state never authorizes a write', async () => {
    const { github, useCase } = harness([{ number: 42, body: 'Closes #306' }]);
    github.issues.push({ id: 306, state: 'UNKNOWN' });

    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.deepStrictEqual(github.closedIssues, [], 'only a measured OPEN may authorize a close');
    assert.deepStrictEqual(github.comments, []);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.logs!.includes("Skipped #306: unreadable (unexpected state 'UNKNOWN')"),
      `got: ${JSON.stringify(result.logs)}`
    );
  });

  test('reports already-closed, unreadable and closed-by-this-run distinctly', async () => {
    const { github, useCase } = harness([
      { number: 41, body: 'Closes #10' },
      { number: 42, body: 'Closes #11' },
      { number: 43, body: 'Closes #12' }
    ]);
    github.issues.push({ id: 10, state: 'OPEN' });
    github.issues.push({ id: 11, state: 'CLOSED' });
    github.strictErrors[12] = 'HTTP 502: Bad Gateway';

    const result = await useCase.execute({ workspaceDir: '/tmp' });

    const logs: string[] = result.logs ?? [];
    assert.ok(logs.includes('Closed issue #10 (merged in PR #41 to phase/123)'), JSON.stringify(logs));
    assert.ok(logs.includes('Skipped #11: already closed'), JSON.stringify(logs));
    assert.ok(logs.includes('Skipped #12: unreadable (HTTP 502: Bad Gateway)'), JSON.stringify(logs));
    for (const log of logs) {
      assert.ok(
        !log.includes('already closed or unreadable'),
        `the conflated sentence must be gone, got: ${log}`
      );
    }
    assert.deepStrictEqual(github.closedIssues, [10]);
    assert.strictEqual(result.success, false, 'one unreadable candidate makes the run incomplete');
  });

  test('refuses to write when the gateway has no fail-closed read', async () => {
    const { github, useCase } = harness([{ number: 42, body: 'Closes #306' }]);
    github.issues.push({ id: 306, state: 'OPEN' });
    (github as any).fetchIssueStrict = undefined;

    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.deepStrictEqual(github.closedIssues, []);
    assert.deepStrictEqual(github.comments, []);
    assert.deepStrictEqual(github.fetchIssueCalls, [], 'the lenient read must not be consulted');
    assert.strictEqual(result.success, false);
    assert.ok(
      result.logs!.some((l: string) => l.includes('unreadable') && l.includes('#306')),
      `the log must say unreadable, got: ${JSON.stringify(result.logs)}`
    );
  });

  test('a failed close/comment marks the run incomplete', async () => {
    const { github, useCase } = harness([{ number: 42, body: 'Closes #306' }]);
    github.issues.push({ id: 306, state: 'OPEN' });
    github.closeIssueError = 'gh issue close failed';

    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, false);
    assert.match(result.message, /#306/);
    assert.deepStrictEqual(github.comments, [], 'no comment may follow a failed close');
    assert.ok(
      result.logs!.includes('Failed to close #306: gh issue close failed'),
      `got: ${JSON.stringify(result.logs)}`
    );
  });

  test('closes and comments exactly once for a readable open issue', async () => {
    const { github, useCase } = harness([{ number: 42, body: 'Closes #10' }]);
    github.issues.push({ id: 10, state: 'OPEN' });

    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.deepStrictEqual(github.closedIssues, [10]);
    assert.strictEqual(github.comments.length, 1);
    assert.strictEqual(github.comments[0].issueId, 10);
    assert.strictEqual(
      github.comments[0].body,
      'Closed by codeloop sync: PR #42 into `phase/123` changed 1 non-test file(s) (Closes #10).'
    );
    assert.strictEqual(result.success, true);
  });

  test('refuses after a pull that advances src/ past dist/, before any gh write (AC1, AC2, #516)', async () => {
    const fixtureDir = makeFreshnessFixture();
    try {
      const executor = new MockCommandExecutor();
      const github = new MockGitHubGateway();
      const state = new MockStateRepo();
      const worktree = new MockWorktreeManager();

      worktree.baseBranch = 'phase/123';
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
      executor.responses["gh pr list --base 'phase/123' --state merged --limit 100 --json number,title,body"] = {
        stdout: JSON.stringify([{ number: 42, body: 'Closes #10' }])
      };
      executor.responses["gh pr view 42 --json files --jq '.files[].path'"] = {
        exitCode: 0,
        stdout: 'src/app.ts\n'
      };
      github.issues.push({ id: 10, state: 'OPEN' });
      executor.pullHook = () => {
        fs.writeFileSync(path.join(fixtureDir, 'src', 'x.ts'), 'export const x = 2;\n');
      };

      const useCase = new SyncUseCase(executor, github, state, worktree);
      const result = await useCase.execute({ workspaceDir: fixtureDir });

      assert.strictEqual(result.success, false);
      assert.ok(
        result.message.includes("pulling 'phase/123'"),
        `the refusal must name the pull: ${result.message}`
      );
      assert.ok(result.message.includes('stale'), `the refusal must say stale: ${result.message}`);
      assert.ok(
        result.message.includes('npm run build'),
        `the refusal must name the rebuild: ${result.message}`
      );
      assert.deepStrictEqual(
        executor.executedCommands.filter((cmd: string) => cmd.startsWith('gh ')),
        [],
        'no gh command may run after the pull made the build stale'
      );
      assert.deepStrictEqual(github.closedIssues, [], 'no issue may be closed on a pre-pull build');
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('completes a sync whose pull leaves src/ unchanged (AC3, #516)', async () => {
    const fixtureDir = makeFreshnessFixture();
    try {
      const executor = new MockCommandExecutor();
      const github = new MockGitHubGateway();
      const state = new MockStateRepo();
      const worktree = new MockWorktreeManager();

      worktree.baseBranch = 'phase/123';
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
      executor.responses["gh pr list --base 'phase/123' --state merged --limit 100 --json number,title,body"] = {
        stdout: '[]'
      };

      const useCase = new SyncUseCase(executor, github, state, worktree);
      const result = await useCase.execute({ workspaceDir: fixtureDir });

      assert.strictEqual(result.success, true, result.message);
      assert.ok(result.message.includes('Successfully synced'), result.message);
      assert.ok(
        executor.executedCommands.includes(
          "gh pr list --base 'phase/123' --state merged --limit 100 --json number,title,body"
        ),
        `the merged-PR scan must still run: ${JSON.stringify(executor.executedCommands)}`
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
