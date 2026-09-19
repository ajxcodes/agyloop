/**
 * agyloop - CliGitHubGateway Infrastructure Tests
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { CliGitHubGateway } = require('../../dist/infrastructure/cli-github-gateway');

describe('CliGitHubGateway findPullRequest', () => {
  test('prefers head branch matching over title matching when both are returned in search', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGh = () => {
      return JSON.stringify([
        {
          number: 35,
          title: 'feat: unrelated squash commit (#75)',
          state: 'MERGED',
          baseRefName: 'main',
          headRefName: '34-task-metrics',
          url: 'https://github.com/org/repo/pull/35',
          mergedAt: '2026-09-01T00:00:00Z',
          labels: []
        },
        {
          number: 76,
          title: 'feat: implement task 75',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'task/75-new-feature',
          url: 'https://github.com/org/repo/pull/76',
          mergedAt: null,
          labels: []
        }
      ]);
    };

    const pr = gateway.findPullRequest({ issueNumber: 75 });
    assert.ok(pr !== null, 'Should find matching PR');
    assert.strictEqual(pr?.number, 76);
    assert.strictEqual(pr?.headRefName, 'task/75-new-feature');
  });

  test('rejects title match if headRefName points to a different issue number', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGh = () => {
      return JSON.stringify([
        {
          number: 35,
          title: 'feat: historical squash commit (#75)',
          state: 'MERGED',
          baseRefName: 'main',
          headRefName: '34-task-metrics',
          url: 'https://github.com/org/repo/pull/35',
          mergedAt: '2026-09-01T00:00:00Z',
          labels: []
        }
      ]);
    };

    const pr = gateway.findPullRequest({ issueNumber: 75 });
    assert.strictEqual(pr, null, 'Should reject title match when head branch belongs to issue 34');
  });

  test('rejects title match when headRefName uses task/ or fix/ prefix with different issue number', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGh = () => {
      return JSON.stringify([
        {
          number: 40,
          title: 'fix: resolved problem (#88)',
          state: 'MERGED',
          baseRefName: 'main',
          headRefName: 'fix/40-resolve-edge-case',
          url: 'https://github.com/org/repo/pull/40',
          mergedAt: '2026-09-02T00:00:00Z',
          labels: []
        }
      ]);
    };

    const pr = gateway.findPullRequest({ issueNumber: 88 });
    assert.strictEqual(pr, null, 'Should reject title match when head branch is fix/40');
  });

  test('accepts title match when headRefName does not conflict with another issue number', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGh = () => {
      return JSON.stringify([
        {
          number: 99,
          title: 'docs: update documentation (#75)',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'patch-docs-update',
          url: 'https://github.com/org/repo/pull/99',
          mergedAt: null,
          labels: []
        }
      ]);
    };

    const pr = gateway.findPullRequest({ issueNumber: 75 });
    assert.ok(pr !== null, 'Should accept title match when branch has no conflicting issue number');
    assert.strictEqual(pr?.number, 99);
    assert.strictEqual(pr?.headRefName, 'patch-docs-update');
  });

  test('matches head branch with various standard branch conventions', () => {
    const gateway = new CliGitHubGateway();

    const branchNames = [
      'task/77',
      'fix/77-bug',
      'feature-77-something',
      'issue_77',
      'bugfix/77',
      '77-my-patch',
      '77'
    ];

    for (const headRefName of branchNames) {
      gateway.runGh = () => {
        return JSON.stringify([
          {
            number: 101,
            title: 'Unrelated title',
            state: 'OPEN',
            baseRefName: 'main',
            headRefName,
            url: 'https://github.com/org/repo/pull/101',
            mergedAt: null,
            labels: []
          }
        ]);
      };

      const pr = gateway.findPullRequest({ issueNumber: 77 });
      assert.ok(pr !== null, `Should match branch ${headRefName} for issue 77`);
      assert.strictEqual(pr?.number, 101);
    }
  });

  test('returns null when gh pr list returns empty array', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGh = () => '[]';

    const pr = gateway.findPullRequest({ issueNumber: 77 });
    assert.strictEqual(pr, null);
  });
});

describe('CliGitHubGateway fetchIssue', () => {
  test('invokes gh issue view requesting number,title,body,state,labels', () => {
    const gateway = new CliGitHubGateway();
    let capturedCmd = '';
    gateway.runGh = (cmd: string) => {
      capturedCmd = cmd;
      return JSON.stringify({
        number: 59,
        title: 'Issue 59 title',
        body: 'Issue 59 body',
        state: 'OPEN',
        labels: [{ name: 'bug' }]
      });
    };

    const issue = gateway.fetchIssue(59, { repo: 'ajxcodes/agyloop' });
    assert.strictEqual(
      capturedCmd,
      'issue view 59 --repo ajxcodes/agyloop --json number,title,body,state,labels'
    );
    assert.strictEqual(issue?.number, 59);
    assert.strictEqual(issue?.title, 'Issue 59 title');
    assert.strictEqual(issue?.body, 'Issue 59 body');
    assert.strictEqual(issue?.state, 'OPEN');
    assert.deepStrictEqual(issue?.labels, ['bug']);
    assert.deepStrictEqual(issue?.comments, []);
  });
});

