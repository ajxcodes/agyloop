/**
 * agyloop - CliGitHubGateway Infrastructure Tests
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { CliGitHubGateway } = require('../../dist/infrastructure/cli-github-gateway');

describe('CliGitHubGateway findPullRequest', () => {
  test('prefers head branch matching over title matching when both are returned in search', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGhArgs = () => {
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
    gateway.runGhArgs = () => {
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
    gateway.runGhArgs = () => {
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
    gateway.runGhArgs = () => {
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
      gateway.runGhArgs = () => {
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
    gateway.runGhArgs = () => '[]';

    const pr = gateway.findPullRequest({ issueNumber: 77 });
    assert.strictEqual(pr, null);
  });
});

// #226: the PR body is where a GitHub closing keyword asserts delivery, so `gh`
// must be asked for it and `findPullRequest` must prefer a PR that carries one.
describe('CliGitHubGateway findPullRequest body plumbing (#226)', () => {
  test('requests the body field for both the headBranch and issueNumber branches', () => {
    const gateway = new CliGitHubGateway();
    const capturedArgs: string[][] = [];
    gateway.runGhArgs = (args: string[]) => {
      capturedArgs.push(args);
      return '[]';
    };

    gateway.findPullRequest({ headBranch: 'task/226', repo: 'org/repo' });
    gateway.findPullRequest({ issueNumber: 226, repo: 'org/repo' });

    assert.strictEqual(capturedArgs.length, 2);
    assert.ok(
      capturedArgs[0].some((a: string) => a.startsWith('number,title,body,state')),
      'headBranch --json must request body'
    );
    assert.ok(
      capturedArgs[1].some((a: string) => a.startsWith('number,title,body,state')),
      'issueNumber --json must request body'
    );
  });

  test('returns the body on GitHubPullRequestData', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGhArgs = () =>
      JSON.stringify([
        {
          number: 9,
          title: 'feat: implement task 75',
          body: '## Summary\n\nCloses #75',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'task/75-new-feature',
          url: 'https://github.com/org/repo/pull/9',
          mergedAt: null,
          labels: []
        }
      ]);

    const pr = gateway.findPullRequest({ issueNumber: 75 });
    assert.strictEqual(pr?.body, '## Summary\n\nCloses #75');
  });

  test('defaults a missing body to an empty string', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGhArgs = () =>
      JSON.stringify([
        {
          number: 8,
          title: 'fix: edge case (#75)',
          state: 'MERGED',
          baseRefName: 'main',
          headRefName: 'fix/75-merged',
          url: 'https://github.com/org/repo/pull/8',
          mergedAt: '2026-09-01T00:00:00Z',
          labels: []
        }
      ]);

    const pr = gateway.findPullRequest({ issueNumber: 75 });
    assert.strictEqual(pr?.body, '');
  });

  test('Tier 1 (body asserts delivery) beats the head-branch convention (#226)', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGhArgs = () =>
      JSON.stringify([
        {
          number: 8,
          title: 'fix: edge case (#75)',
          body: '',
          state: 'MERGED',
          baseRefName: 'main',
          headRefName: 'fix/75-merged',
          url: 'https://github.com/org/repo/pull/8',
          mergedAt: '2026-09-01T00:00:00Z',
          labels: []
        },
        {
          number: 9,
          title: 'feat: implement task 75',
          body: 'Closes #75',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'task/75-new-feature',
          url: 'https://github.com/org/repo/pull/9',
          mergedAt: null,
          labels: []
        }
      ]);

    const pr = gateway.findPullRequest({ issueNumber: 75 });
    assert.strictEqual(pr?.number, 9);
    assert.strictEqual(pr?.headRefName, 'task/75-new-feature');
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
      "issue view 59 --repo 'ajxcodes/agyloop' --json number,title,body,state,labels"
    );
    assert.strictEqual(issue?.number, 59);
    assert.strictEqual(issue?.title, 'Issue 59 title');
    assert.strictEqual(issue?.body, 'Issue 59 body');
    assert.strictEqual(issue?.state, 'OPEN');
    assert.deepStrictEqual(issue?.labels, ['bug']);
    assert.deepStrictEqual(issue?.comments, []);
  });
});

describe('CliGitHubGateway fetchPullRequestComments', () => {
  test('uses gh api instead of gh pr view to avoid GraphQL deprecation', () => {
    const gateway = new CliGitHubGateway();
    const capturedCmds: string[] = [];
    
    gateway.runGh = (cmd: string) => {
      capturedCmds.push(cmd);
      if (cmd.includes('/issues/59/comments')) {
        return JSON.stringify([{ user: { login: 'user1' }, body: 'issue comment', created_at: '2023' }]);
      }
      if (cmd.includes('/pulls/59/reviews')) {
        return JSON.stringify([{ id: 1, user: { login: 'user2' }, body: 'review body', state: 'APPROVED', submitted_at: '2024' }]);
      }
      if (cmd.includes('/pulls/59/comments')) {
        return JSON.stringify([{ user: { login: 'user3' }, body: 'review comment', path: 'src/a.ts', line: 10, pull_request_review_id: 1, created_at: '2025' }]);
      }
      return '[]';
    };

    const comments = gateway.fetchPullRequestComments(59, { repo: 'ajxcodes/agyloop' });
    
    assert.strictEqual(capturedCmds.length, 3);
    assert.ok(capturedCmds[0].includes("'repos/ajxcodes/agyloop/issues/59/comments'"));
    assert.ok(capturedCmds[1].includes("'repos/ajxcodes/agyloop/pulls/59/reviews'"));
    assert.ok(capturedCmds[2].includes("'repos/ajxcodes/agyloop/pulls/59/comments'"));
    
    assert.strictEqual(comments.length, 3);
    assert.strictEqual(comments[0].body, 'issue comment');
    assert.strictEqual(comments[1].body, 'review body');
    assert.strictEqual(comments[2].body, 'review comment');
    assert.strictEqual(comments[2].state, 'APPROVED');
  });

  test('requests every page of every comment surface', () => {
    const gateway = new CliGitHubGateway();
    const capturedCmds: string[] = [];
    gateway.runGh = (cmd: string) => {
      capturedCmds.push(cmd);
      return '[]';
    };

    gateway.fetchPullRequestComments(59, { repo: 'ajxcodes/agyloop' });

    assert.strictEqual(capturedCmds.length, 3);
    for (const cmd of capturedCmds) {
      assert.ok(cmd.includes('--paginate'), `expected --paginate in "${cmd}"`);
    }
  });

  test('consumes every page of a paginated payload', () => {
    const gateway = new CliGitHubGateway();
    const page1 = JSON.stringify([
      { id: 1, user: { login: 'a' }, body: 'page one comment', created_at: '2023' }
    ]);
    const page2 = JSON.stringify([
      { id: 2, user: { login: 'b' }, body: 'page two comment', created_at: '2023' }
    ]);

    gateway.runGh = (cmd: string) => {
      if (cmd.includes('/issues/59/comments')) return `${page1}${page2}`;
      return '[]';
    };

    const comments = gateway.fetchPullRequestComments(59, { repo: 'ajxcodes/agyloop' });

    assert.strictEqual(comments.length, 2);
    assert.strictEqual(comments[0].body, 'page one comment');
    assert.strictEqual(comments[1].body, 'page two comment');
  });

  test('tags every comment with the surface it came from and carries its id', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGh = (cmd: string) => {
      if (cmd.includes('/issues/59/comments')) {
        return JSON.stringify([{ id: 9001, user: { login: 'user1' }, body: 'conversation comment', created_at: '2023' }]);
      }
      if (cmd.includes('/pulls/59/reviews')) {
        return JSON.stringify([{ id: 7, user: { login: 'user2' }, body: 'review body', state: 'CHANGES_REQUESTED', submitted_at: '2024' }]);
      }
      if (cmd.includes('/pulls/59/comments')) {
        return JSON.stringify([{ id: 4242, user: { login: 'user3' }, body: 'inline comment', path: 'src/a.ts', line: 10, pull_request_review_id: 7, created_at: '2025' }]);
      }
      return '[]';
    };

    const comments = gateway.fetchPullRequestComments(59, { repo: 'ajxcodes/agyloop' });

    assert.strictEqual(comments[0].surface, 'conversation');
    assert.strictEqual(comments[0].id, 9001);
    assert.strictEqual(comments[1].surface, 'review');
    assert.strictEqual(comments[2].surface, 'inline');
    assert.strictEqual(comments[2].id, 4242);
    // The reviews surface is the only source of a CHANGES_REQUESTED verdict.
    assert.strictEqual(comments[1].category, 'error');
    assert.strictEqual(comments[2].category, 'error');
  });
});

describe('CliGitHubGateway PR comment severity classification', () => {
  const { classifyPrCommentSeverity } = require('../../dist/infrastructure/cli-github-gateway');

  test('maps the markdown markers the review bots emit', () => {
    assert.deepStrictEqual(classifyPrCommentSeverity('**CRITICAL**: the tree is broken'), {
      category: 'error',
      severity: 'critical'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('🔴 **ERROR**: boom'), {
      category: 'error',
      severity: 'error'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('⚠️ **WARNING**: careful'), {
      category: 'suggestion',
      severity: 'warning'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('💡 **SUGGESTION**: consider this'), {
      category: 'suggestion',
      severity: 'suggestion'
    });
    // An INFO finding is not a GENERAL one: the category must not conflate
    // "informational" with "nothing detected".
    assert.deepStrictEqual(classifyPrCommentSeverity('ℹ️ **INFO**: nice work'), {
      category: 'info',
      severity: 'info'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('**INFO**: nice work'), {
      category: 'info',
      severity: 'info'
    });
  });

  test('keeps the legacy bracket markers working', () => {
    assert.deepStrictEqual(classifyPrCommentSeverity('[error] fix this'), {
      category: 'error',
      severity: 'error'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('[critical] fix this'), {
      category: 'error',
      severity: 'critical'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('[suggestion] fix this'), {
      category: 'suggestion',
      severity: 'suggestion'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('[warning] fix this'), {
      category: 'suggestion',
      severity: 'warning'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('[nit] fix this'), {
      category: 'suggestion',
      severity: 'suggestion'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('[question] why?'), {
      category: 'question',
      severity: 'info'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('[info] fyi'), {
      category: 'info',
      severity: 'info'
    });
  });

  test('a bare question mark in prose is not a question', () => {
    const suggestion = '💡 **SUGGESTION**: The `normalizePorcelainPath` function handles quoted paths. For example, `rawPath.split(/ -> /).pop()?.trim()`.';
    assert.strictEqual(classifyPrCommentSeverity(suggestion).category, 'suggestion');

    const info = 'ℹ️ **INFO**: The `lastReviewVerdict` method scans the history backwards.';
    assert.strictEqual(classifyPrCommentSeverity(info).category, 'info');

    const prose = 'This reads oddly, does it not? The helper is called twice.';
    assert.strictEqual(classifyPrCommentSeverity(prose).category, 'general');
  });

  test('a comment whose headline IS a question is a question', () => {
    assert.strictEqual(classifyPrCommentSeverity('Can you clarify this?').category, 'question');
  });

  /**
   * The marker is read from the LEADING position of the headline, so a marker
   * that is merely quoted anywhere else classifies nothing.
   */
  test('a marker quoted in the body does not classify the comment', () => {
    assert.deepStrictEqual(classifyPrCommentSeverity('ℹ️ **INFO**: see also [error]'), {
      category: 'info',
      severity: 'info'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('ℹ️ **INFO**: see also **CRITICAL**'), {
      category: 'info',
      severity: 'info'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('the `**error**` path is not covered'), {
      category: 'general',
      severity: 'info'
    });
    assert.deepStrictEqual(classifyPrCommentSeverity('fix this [critical] today'), {
      category: 'general',
      severity: 'info'
    });
  });

  /**
   * The run summary of a review bot lists the markers of the comments it
   * added. It quotes them — it is not one of them. Observed live on PR #261:
   * the run summary was classified SUGGESTION purely because its body quoted
   * `- `[suggestion]``.
   */
  test('a run summary that lists the markers it saw is not classified by them', () => {
    const runSummary = [
      '### 🤖 Critique AI Review Run Summary',
      '',
      '- **Confidence Level**: **High**',
      '',
      '#### 📝 New Comments Added (3)',
      '- `[suggestion]` `src/application/detect-implementation-diff.ts` (Line 150)',
      '- `[info]` `src/application/triage-pr-comments.ts` (Line 180)',
      '',
      '*Powered by Critique AI*'
    ].join('\n');

    assert.deepStrictEqual(classifyPrCommentSeverity(runSummary), {
      category: 'general',
      severity: 'info'
    });
  });

  /**
   * The review bot posts its findings as a conversation summary that carries a
   * `**Review feedback on ...**` header; the finding itself is on the next
   * line, and that is where the marker leads.
   */
  test('the marker under the review-feedback header still classifies the comment', () => {
    const summary = [
      '**Review feedback on `src/application/run-lifecycle.ts` (Line 178):**',
      '',
      'ℹ️ **INFO**: The new `implementationHalted` field provides diagnostics.',
      '',
      '*Powered by Critique AI (gemini-2.5-flash)*'
    ].join('\n');

    assert.deepStrictEqual(classifyPrCommentSeverity(summary), {
      category: 'info',
      severity: 'info'
    });
  });

  test('a CHANGES_REQUESTED review is a blocking error whatever its body says', () => {
    assert.deepStrictEqual(classifyPrCommentSeverity('looks good to me', 'CHANGES_REQUESTED'), {
      category: 'error',
      severity: 'error'
    });
  });

  test('the severity never contradicts the category', () => {
    const bodies = [
      '**CRITICAL**: boom',
      '🔴 **ERROR**: boom',
      '⚠️ **WARNING**: careful',
      '💡 **SUGGESTION**: consider',
      'ℹ️ **INFO**: fine',
      '[nit] small thing',
      '[question] why?',
      'Can you clarify this?',
      'plain prose without a marker'
    ];

    for (const body of bodies) {
      const { category, severity } = classifyPrCommentSeverity(body);
      if (severity === 'critical' || severity === 'error') {
        assert.strictEqual(category, 'error', `"${body}" must not contradict its severity`);
      } else if (severity === 'warning' || severity === 'suggestion') {
        assert.strictEqual(category, 'suggestion', `"${body}" must not contradict its severity`);
      } else {
        assert.notStrictEqual(
          category,
          'error',
          `an informational comment must never be rendered as an error: "${body}"`
        );
        assert.notStrictEqual(
          category,
          'suggestion',
          `an informational comment must never be rendered as a suggestion: "${body}"`
        );
      }
    }
  });
});

describe('CliGitHubGateway paginated payload parsing', () => {
  const { parsePaginatedJsonArray } = require('../../dist/infrastructure/cli-github-gateway');

  test('accepts the merged single-array shape', () => {
    assert.deepStrictEqual(parsePaginatedJsonArray('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
  });

  test('accepts the concatenated per-page shape', () => {
    assert.deepStrictEqual(parsePaginatedJsonArray('[{"a":1}][{"b":2}]'), [{ a: 1 }, { b: 2 }]);
  });

  test('returns nothing for an empty payload', () => {
    assert.deepStrictEqual(parsePaginatedJsonArray(''), []);
    assert.deepStrictEqual(parsePaginatedJsonArray('   '), []);
  });
});

describe('CliGitHubGateway replyToConversationComment', () => {
  test('posts the reply on the PR conversation surface', () => {
    const gateway = new CliGitHubGateway();
    const calls: any[] = [];
    gateway.runGhArgs = (args: string[]) => {
      calls.push(args);
      return '';
    };

    gateway.replyToConversationComment(261, 6293879014, 'not applicable', { repo: 'ajxcodes/agyloop' });

    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes('api'));
    assert.ok(calls[0].includes('POST'));
    assert.ok(calls[0].some((a: string) => a.includes('repos/ajxcodes/agyloop/issues/261/comments')));
    const bodyArg = calls[0].find((a: string) => a.startsWith('body='));
    assert.ok(bodyArg.includes('not applicable'));
    assert.ok(bodyArg.includes('https://github.com/ajxcodes/agyloop/pull/261#issuecomment-6293879014'));
  });
});

describe('CliGitHubGateway argv-based thread methods (#136)', () => {
  const cp = require('node:child_process');
  const nasty = `it's "quoted" $HOME \`whoami\` $(id); rm -rf /`;

  test('args are passed verbatim as argv without a shell', () => {
    const orig = cp.execFileSync;
    const calls: any[] = [];
    cp.execFileSync = (file: string, args: string[], opts: any) => {
      calls.push({ file, args, opts });
      return '';
    };
    try {
      const gateway = new CliGitHubGateway();
      gateway.replyToThread('T"1 $x', nasty, { cwd: '/tmp' });
      gateway.resolveReviewThread('T`1`', { cwd: '/tmp' });
    } finally {
      cp.execFileSync = orig;
    }
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].file, 'gh');
    assert.ok(calls[0].args.includes(`body=${nasty}`));
    assert.ok(calls[0].args.includes('threadId=T"1 $x'));
    assert.ok(calls[1].args.includes('threadId=T`1`'));
    assert.ok(!calls[0].opts.shell);
  });

  test('listUnresolvedReviewThreads returns unresolved threads with comment ids', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGhArgs = () =>
      JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [
          { id: 'A', isResolved: false, comments: { nodes: [{ databaseId: 1 }, { databaseId: 2 }] } },
          { id: 'B', isResolved: true, comments: { nodes: [{ databaseId: 3 }] } }
        ] } } } }
      });
    const out = gateway.listUnresolvedReviewThreads(7, { repo: 'o/r' });
    assert.deepStrictEqual(out, [{ id: 'A', isResolved: false, commentIds: [1, 2] }]);
  });

  /**
   * The RESOLVED threads are the dismissal route's cross-run memory on the
   * inline surface: a thread that an earlier run resolved must be visible, or
   * the route cannot tell that its comments were already answered.
   */
  test('listReviewThreads returns the resolved threads too', () => {
    const gateway = new CliGitHubGateway();
    gateway.runGhArgs = () =>
      JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [
          { id: 'A', isResolved: false, comments: { nodes: [{ databaseId: 1 }, { databaseId: 2 }] } },
          { id: 'B', isResolved: true, comments: { nodes: [{ databaseId: 3 }] } }
        ] } } } }
      });
    const out = gateway.listReviewThreads(7, { repo: 'o/r' });
    assert.deepStrictEqual(out, [
      { id: 'A', isResolved: false, commentIds: [1, 2] },
      { id: 'B', isResolved: true, commentIds: [3] }
    ]);
  });
});
