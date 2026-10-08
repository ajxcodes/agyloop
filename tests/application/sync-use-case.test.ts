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
    executor.responses['gh pr list --base phase/123 --state merged --json number,title,body'] = {
      stdout: JSON.stringify([
        { number: 42, title: 'Fix bug', body: 'Closes #10' }
      ])
    };

    github.issues.push({ id: 10, state: 'OPEN' });

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.ok(executor.executedCommands.includes('git fetch origin'));
    assert.ok(executor.executedCommands.includes('git pull --ff-only origin phase/123'));
    
    assert.ok(github.closedIssues.includes(10));
    assert.ok(github.comments.some(c => c.issueId === 10 && c.body.includes('PR #42')));
  });

  it('fast-forwards branch without checking out if not currently on it', async () => {
    const executor = new MockCommandExecutor();
    const github = new MockGitHubGateway();
    const state = new MockStateRepo();
    const worktree = new MockWorktreeManager();

    worktree.baseBranch = 'phase/123';
    
    executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/456' };
    executor.responses['gh pr list --base phase/123 --state merged --json number,title,body'] = {
      stdout: '[]'
    };

    const useCase = new SyncUseCase(executor, github, state, worktree);
    const result = await useCase.execute({ workspaceDir: '/tmp' });

    assert.strictEqual(result.success, true);
    assert.ok(executor.executedCommands.includes('git fetch origin phase/123:phase/123'));
  });
});
