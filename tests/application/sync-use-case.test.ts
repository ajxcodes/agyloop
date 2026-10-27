/**
 * Tests for SyncUseCase (Application Layer)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { SyncUseCase } = require('../../dist/application');

class MockCommandExecutor {
  executedCommands: string[] = [];
  responses: Record<string, any> = {};

  async execute(command: string, options?: any) {
    this.executedCommands.push(command);
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

  async fetchIssue(issueId: number) {
    return this.issues.find(i => i.id === issueId) || null;
  }

  async closeIssue(issueId: number) {
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
  it('resolves base branch, fetches, fast-forwards, and processes merged PRs', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
    executor.responses["gh pr list --base 'phase/123' --state merged --json number,title,body"] = {
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
            'Closed by agyloop sync: PR #42 into `phase/123` changed 1 non-test file(s) (Closes #10).'
      ),
      `the auto-close comment must carry the collector branch verbatim, got: ${JSON.stringify(github.comments)}`
    );
    assert.ok(result.logs !== undefined, 'Result should include logs metadata');
    assert.ok(result.logs.some((l: string) => l.includes('Closed issue #10')));
  });

  it('fast-forwards branch without checking out if not currently on it', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/456' };
    executor.responses["gh pr list --base 'phase/123' --state merged --json number,title,body"] = {
      stdout: '[]'
    };

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.ok(executor.executedCommands.includes("git fetch origin 'phase/123:phase/123'"));
  });

  it('does NOT close an issue on a test-only PR (issue #240/Defect 3)', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
    executor.responses["gh pr list --base 'phase/123' --state merged --json number,title,body"] = {
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

  it('does NOT close an issue when the PR diff cannot be verified (fail closed)', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'phase/123' };
    executor.responses["gh pr list --base 'phase/123' --state merged --json number,title,body"] = {
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

  it('returns warnings in result metadata if an operation fails', async () => {    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    
    // Simulate fetch failure
    executor.execute = async (cmd) => {
      if (cmd === 'git fetch origin') {
        throw new Error('Network error');
      }
      return { stdout: '', exitCode: 0 };
    };

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.ok(result.warnings !== undefined, 'Result should include warnings metadata');
    assert.ok(result.warnings.some((w: string) => w.includes('Failed to fetch from origin: Network error')));
  });
});
