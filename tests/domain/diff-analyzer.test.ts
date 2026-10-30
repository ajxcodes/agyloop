/**
 * agyloop - DiffAnalyzer Pure Domain Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  DiffAnalyzer,
  COMMIT_TYPE_FEAT,
  COMMIT_TYPE_FIX,
  COMMIT_TYPE_TEST,
  COMMIT_TYPE_DOCS,
  COMMIT_TYPE_CI,
  COMMIT_TYPE_BUILD,
  DIFF_EXCLUDED_PATHSPECS,
  DIFF_EXCLUDED_PATTERNS,
  DIFF_EXCLUDE_ARGS,
  MAX_INLINE_DIFF_LINES
} = require('../../dist/domain');

const SAMPLE_DIFF_SRC = `diff --git a/src/domain/value-objects/review-verdict.ts b/src/domain/value-objects/review-verdict.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/domain/value-objects/review-verdict.ts
@@ -0,0 +1,50 @@
+export class ReviewVerdict {
+  public readonly status: string;
+}
diff --git a/src/application/run-review.ts b/src/application/run-review.ts
--- a/src/application/run-review.ts
+++ b/src/application/run-review.ts
@@ -10,3 +10,5 @@
+export class RunReviewUseCase {}
`;

const SAMPLE_DIFF_BREAKING = `diff --git a/src/ports/command-executor.ts b/src/ports/command-executor.ts
--- a/src/ports/command-executor.ts
+++ b/src/ports/command-executor.ts
@@ -1,5 +1,6 @@
+BREAKING CHANGE: CommandExecutor signature changed
`;

describe('DiffAnalyzer Domain Service', () => {
  test('extracts modified files from standard git diff', () => {
    const files = DiffAnalyzer.extractModifiedFiles(SAMPLE_DIFF_SRC);
    assert.strictEqual(files.length, 2);
    assert.ok(files.includes('src/domain/value-objects/review-verdict.ts'));
    assert.ok(files.includes('src/application/run-review.ts'));
  });

  test('ignores diff --git strings embedded inside modified file hunks', () => {
    const diffWithEmbeddedDiff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,5 @@
+const mockDiff = \`diff --git a/spurious.ts b/spurious.ts
+--- a/spurious.ts
++++ b/spurious.ts\`
`;
    const files = DiffAnalyzer.extractModifiedFiles(diffWithEmbeddedDiff);
    assert.strictEqual(files.length, 1);
    assert.ok(files.includes('src/test.ts'));
    assert.ok(!files.includes('spurious.ts'), 'Should not extract spurious.ts from hunk');
  });

  test('calculates additions and deletions correctly', () => {
    const { additions, deletions } = DiffAnalyzer.calculateMetrics(SAMPLE_DIFF_SRC);
    assert.ok(additions > 0);
    assert.strictEqual(deletions, 0);
  });

  test('infers scope from dominant modified component', () => {
    const files = [
      'src/domain/value-objects/review-verdict.ts',
      'src/application/run-review.ts',
      'prompts/reviewer.md'
    ];
    const scope = DiffAnalyzer.inferScope(files);
    assert.strictEqual(scope, 'reviewer');
  });

  test('infers scope for quality gate files', () => {
    const files = [
      'src/application/run-quality-gate.ts',
      'src/domain/value-objects/gate-summary-report.ts'
    ];
    const scope = DiffAnalyzer.inferScope(files);
    assert.strictEqual(scope, 'gate');
  });

  test('infers scope for domain layer changes', () => {
    const files = [
      'src/domain/constants.ts',
      'src/domain/errors.ts'
    ];
    const scope = DiffAnalyzer.inferScope(files);
    assert.strictEqual(scope, 'domain');
  });

  test('respects explicit scope override', () => {
    const files = ['src/presentation/cli.ts'];
    const scope = DiffAnalyzer.inferScope(files, 'custom-scope');
    assert.strictEqual(scope, 'custom-scope');
  });

  test('infers test type when all modified files are tests', () => {
    const files = ['tests/domain/commit-message.test.ts'];
    const type = DiffAnalyzer.inferType(files);
    assert.strictEqual(type, COMMIT_TYPE_TEST);
  });

  test('infers docs type when all files are documentation', () => {
    const files = ['README.md', 'docs/guide.md'];
    const type = DiffAnalyzer.inferType(files);
    assert.strictEqual(type, COMMIT_TYPE_DOCS);
  });

  test('infers ci type when files are in .github/', () => {
    const files = ['.github/workflows/ci.yml'];
    const type = DiffAnalyzer.inferType(files);
    assert.strictEqual(type, COMMIT_TYPE_CI);
  });

  test('infers fix type from context keyword in issue title', () => {
    const files = ['src/application/run-review.ts'];
    const type = DiffAnalyzer.inferType(files, { issueTitle: '[Bug] Fix parsing error in review verdict' });
    assert.strictEqual(type, COMMIT_TYPE_FIX);
  });

  test('infers feat type from context keyword in issue title', () => {
    const files = ['src/application/execute-commit.ts'];
    const type = DiffAnalyzer.inferType(files, { issueTitle: '[Task] Phase 4: Implement Interactive Conventional Commit Drafter' });
    assert.strictEqual(type, COMMIT_TYPE_FEAT);
  });

  test('detects breaking changes from diff content', () => {
    const isBreaking = DiffAnalyzer.detectBreakingChanges(SAMPLE_DIFF_BREAKING);
    assert.strictEqual(isBreaking, true);
  });

  test('detects breaking changes from context', () => {
    const isBreaking = DiffAnalyzer.detectBreakingChanges(SAMPLE_DIFF_SRC, { isBreaking: true });
    assert.strictEqual(isBreaking, true);
  });

  test('cleans description by stripping task prefixes and lowercasing first letter', () => {
    const cleaned = DiffAnalyzer.cleanDescription(
      '[Task] Phase 4: Implement Interactive Conventional Commit Drafter & Human Approval Gate.',
      'fallback'
    );
    assert.strictEqual(cleaned, 'implement Interactive Conventional Commit Drafter & Human Approval Gate');
  });

  test('generates complete DraftCommitPlan from diff and context', () => {
    const plan = DiffAnalyzer.analyzeDiff(SAMPLE_DIFF_SRC, {
      issueNumber: 30,
      issueTitle: '[Task] Phase 4: Implement Interactive Conventional Commit Drafter & Human Approval Gate'
    });

    assert.strictEqual(plan.inferredType, 'feat');
    assert.strictEqual(plan.inferredScope, 'reviewer');
    assert.strictEqual(plan.commitMessage.type, 'feat');
    assert.strictEqual(plan.commitMessage.scope, 'reviewer');
    assert.strictEqual(plan.commitMessage.issueNumber, 30);
    // #339 (AC-4.4): the subject is bounded at 72 chars, cut at a WORD
    // boundary. The old pin expected the whole 89-char title — the defective
    // behaviour this issue removes (the description itself keeps the full text).
    assert.strictEqual(
      plan.commitMessage.toSingleLine(),
      'feat(reviewer): implement Interactive Conventional Commit Drafter (#30)'
    );
    assert.ok(plan.commitMessage.toSingleLine().length <= 72);
  });

  describe('Context Shielding & Diff Filtering', () => {
    test('defines required exclusion pathspecs and threshold constants', () => {
      assert.deepStrictEqual(Array.from(DIFF_EXCLUDED_PATHSPECS), [
        ':!package-lock.json',
        ':!pnpm-lock.yaml',
        ':!yarn.lock',
        ':!bun.lockb',
        ':!dist/',
        ':!build/'
      ]);
      assert.strictEqual(
        DIFF_EXCLUDE_ARGS,
        "':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock' ':!bun.lockb' ':!dist/' ':!build/'"
      );
      assert.strictEqual(MAX_INLINE_DIFF_LINES, 1000);
    });

    test('isExcludedDiffPath accurately identifies lockfiles and build directories', () => {
      // Direct matches
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('package-lock.json'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('pnpm-lock.yaml'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('yarn.lock'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('bun.lockb'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('dist/bundle.js'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('build/output.min.js'), true);

      // Nested matches
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('packages/core/package-lock.json'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('apps/web/pnpm-lock.yaml'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('sub/yarn.lock'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('nested/bun.lockb'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('packages/ui/dist/index.js'), true);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('packages/api/build/server.js'), true);

      // Allowed source files
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('package.json'), false);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('src/dist.ts'), false);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('src/build.ts'), false);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('src/distribution/index.ts'), false);
      assert.strictEqual(DiffAnalyzer.isExcludedDiffPath('tests/domain/diff-analyzer.test.ts'), false);
    });

    test('filterDiff removes lockfiles and build artifacts while preserving code diffs', () => {
      const mixedDiff = `diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,5 +1,5 @@
-old-lockfile-line
+new-lockfile-line
diff --git a/src/index.ts b/src/index.ts
index 3333333..4444444 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -10,3 +10,4 @@
+export const SHIELD = true;
diff --git a/dist/bundle.js b/dist/bundle.js
index 5555555..6666666 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1,1 +1,1 @@
-var min=1;
+var min=2;
`;

      const filtered = DiffAnalyzer.filterDiff(mixedDiff);
      assert.ok(!filtered.includes('package-lock.json'));
      assert.ok(!filtered.includes('dist/bundle.js'));
      assert.ok(!filtered.includes('old-lockfile-line'));
      assert.ok(!filtered.includes('var min'));
      assert.ok(filtered.includes('src/index.ts'));
      assert.ok(filtered.includes('export const SHIELD = true;'));
    });

    test('filterDiff returns empty string when diff consists entirely of lockfiles', () => {
      const lockfileDiff = `diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
-old
+new
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 3333333..4444444 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,2 +1,2 @@
-v1
+v2
`;
      const filtered = DiffAnalyzer.filterDiff(lockfileDiff);
      assert.strictEqual(filtered, '');
    });

    test('generateDiffStat produces formatted file metrics and change totals', () => {
      const stat = DiffAnalyzer.generateDiffStat(SAMPLE_DIFF_SRC);
      assert.ok(stat.includes('src/domain/value-objects/review-verdict.ts'));
      assert.ok(stat.includes('src/application/run-review.ts'));
      assert.ok(stat.includes('2 files changed'));
      assert.ok(stat.includes('insertions(+)'));
      assert.ok(stat.includes('deletions(-)'));
    });
  });
});

describe('commit draft truthfulness (issue #345 in #339: scope, tags, length)', () => {
  const rotate = (files: readonly string[], n: number): string[] => [
    ...files.slice(n),
    ...files.slice(0, n)
  ];

  /** The #336 delivery shape: 3 source files, 9 test files, 2 markdown files. */
  const SET_336 = [
    'docs/commit-guidelines.md',
    'skills/agyloop/SKILL.md',
    'src/application/triage-pr-comments.ts',
    'src/domain/constants.ts',
    'src/presentation/cli.ts',
    'tests/application/triage-pr-comments.test.ts',
    'tests/application/manage-worktree.test.ts',
    'tests/domain/constants.test.ts',
    'tests/infrastructure/git-worktree-manager.test.ts',
    'tests/presentation/cli-triage-dismiss-report.test.ts',
    'tests/presentation/cli-status-triage-disposition.test.ts',
    'tests/domain/value-objects.test.ts',
    'tests/architecture/operator-strings.test.ts',
    'tests/presentation/cli-plan-output.test.ts'
  ];

  test('T11.1 (AC-4.1/4.2/4.5): the #336 file set resolves to a module scope in every order, never docs', () => {
    assert.strictEqual(SET_336.length, 14);
    const orders = [
      [...SET_336].sort(),
      [...SET_336].sort().reverse(),
      rotate(SET_336, 3),
      rotate(SET_336, 7),
      rotate(SET_336, 11)
    ];
    const results = orders.map((files) => DiffAnalyzer.inferScope(files));

    assert.strictEqual(
      new Set(results).size,
      1,
      `scope must be order-independent, got: ${results.join(', ')}`
    );
    assert.notStrictEqual(results[0], 'docs', 'two .md files must not outrank the source modules');
    // app(2) + cli(2) + domain(2): equal totals, equal weight → the stated
    // tie-break is lexicographic, so `app` — never "first to reach the max".
    assert.strictEqual(results[0], 'app');
  });

  test('T11.2 (AC-4.1/4.5): a two-.md-only diff still resolves to docs', () => {
    assert.strictEqual(DiffAnalyzer.inferScope(['skills/agyloop/SKILL.md', 'docs/x.md']), 'docs');
  });

  test('T11.3 (AC-4.1/4.5): two .md files plus one src/ file resolve to the module scope in both orders', () => {
    const files = ['skills/agyloop/SKILL.md', 'docs/x.md', 'src/application/x.ts'];
    assert.strictEqual(DiffAnalyzer.inferScope(files), 'app');
    assert.strictEqual(DiffAnalyzer.inferScope([...files].reverse()), 'app');
    assert.notStrictEqual(DiffAnalyzer.inferScope(files), 'docs');
  });

  test('T11.4 (AC-4.2 / E3): keyword scopes never match test or docs paths', () => {
    assert.strictEqual(
      DiffAnalyzer.inferScope(['tests/application/triage-discovery.test.ts', 'src/application/x.ts']),
      'app',
      'a test filename must not out-vote the module with `planner`'
    );
    assert.strictEqual(
      DiffAnalyzer.inferScope(['docs/commit-guidelines.md', 'src/application/x.ts']),
      'app',
      'a docs path must not match the `commit` keyword'
    );
    assert.strictEqual(
      DiffAnalyzer.inferScope(['tests/presentation/cli-review.test.ts', 'src/presentation/cli.ts']),
      'cli',
      'a test filename must not out-vote the module with `reviewer`'
    );
  });

  test('T11.5 (AC-4.2): keyword-before-directory precedence is stated and pinned', () => {
    // The keyword wins over the `src/application` directory for THIS file.
    assert.strictEqual(DiffAnalyzer.inferScope(['src/application/run-review.ts']), 'reviewer');
    // Directory scopes still resolve for files with no keyword.
    assert.strictEqual(DiffAnalyzer.inferScope(['src/application/alpha.ts']), 'app');
    assert.strictEqual(DiffAnalyzer.inferScope(['src/domain/constants.ts']), 'domain');
    assert.strictEqual(DiffAnalyzer.inferScope(['src/presentation/cli.ts']), 'cli');
    assert.strictEqual(DiffAnalyzer.inferScope(['.github/workflows/ci.yml']), 'ci');
  });

  test('T11.6 (AC-4.2): the tie-break is weight class, then lexicographic — never first-to-reach', () => {
    // Equal TOTALS (6 vs 6) with different weight classes: keyword-backed (3)
    // beats directory-backed (2), in every order.
    const weighted = [
      'src/presentation/review-a.ts',
      'src/domain/review-b.ts',
      'src/application/alpha.ts',
      'src/application/beta.ts',
      'src/application/gamma.ts'
    ];
    const weightedResults = [
      [...weighted].sort(),
      [...weighted].sort().reverse(),
      rotate(weighted, 2),
      rotate(weighted, 4)
    ].map((files) => DiffAnalyzer.inferScope(files));
    assert.deepStrictEqual(
      weightedResults,
      ['reviewer', 'reviewer', 'reviewer', 'reviewer'],
      `weight-class tie-break must be order-independent, got: ${weightedResults.join(', ')}`
    );

    // Equal totals AND equal weight → lexicographic, in every order.
    const tied = ['src/application/a.ts', 'src/domain/b.ts'];
    const tiedResults = [
      [...tied],
      [...tied].reverse(),
      rotate(tied, 1)
    ].map((files) => DiffAnalyzer.inferScope(files));
    assert.deepStrictEqual(
      tiedResults,
      ['app', 'app', 'app'],
      `lexicographic tie-break must be order-independent, got: ${tiedResults.join(', ')}`
    );
  });

  test('T11.7 (AC-4.3/4.5): milestone and kind tags are stripped wherever they appear', () => {
    const r1 = DiffAnalyzer.cleanDescription(
      '[Phase 6] [Bug] Operator output is false: plan misreports itself',
      'fallback'
    );
    assert.ok(!/\[Phase\s+\d+\]/.test(r1), `milestone tag survived: ${r1}`);
    assert.ok(!/\[Bug\]/.test(r1), `kind tag survived: ${r1}`);
    assert.ok(r1.startsWith('operator output is false'), r1);

    // Mid-string tags (not position 0) are stripped too.
    const r2 = DiffAnalyzer.cleanDescription('[Phase 5] a middle [Feature] tag case', 'fallback');
    assert.ok(!/\[Phase\s+\d+\]/.test(r2), `mid-string milestone tag survived: ${r2}`);
    assert.ok(!/\[Feature\]/.test(r2), `mid-string kind tag survived: ${r2}`);
    assert.strictEqual(r2, 'a middle tag case');

    // Everything stripped away → the fallback, not an empty subject.
    const r3 = DiffAnalyzer.cleanDescription('[Phase 6] [Bug]  ', 'fallback');
    assert.strictEqual(r3, 'fallback');

    // The leading conventional prefix keeps its old behaviour.
    const r4 = DiffAnalyzer.cleanDescription('fix: Resolve the login crash', 'fallback');
    assert.strictEqual(r4, 'resolve the login crash');
  });

  test('T11.9 (AC-4.6 / E2): a markdown-only diff never renders docs(docs):', () => {
    const diff = ['a.md', 'b.md']
      .map(
        (f) =>
          `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y\n`
      )
      .join('');
    const plan = DiffAnalyzer.analyzeDiff(diff, {
      issueTitle: '[Phase 6] [Bug] markdown-only change'
    });

    assert.strictEqual(plan.inferredType, COMMIT_TYPE_DOCS);
    const subject = plan.commitMessage.toSingleLine();
    assert.ok(subject.startsWith('docs: '), `expected a docs subject, got: ${subject}`);
    assert.ok(!subject.startsWith('docs(docs):'), `scope duplication is back: ${subject}`);
    // The scope is still REPORTED for diagnostics…
    assert.strictEqual(plan.inferredScope, 'docs');
    // …but the message renders no duplicate.
    assert.strictEqual(plan.commitMessage.scope, null);
  });

  test('T11.10 (AC-4.5): inferType is unchanged on the existing fixtures', () => {
    assert.strictEqual(
      DiffAnalyzer.inferType(['src/application/run-review.ts'], {
        issueTitle: '[Bug] Fix parsing error in review verdict'
      }),
      COMMIT_TYPE_FIX
    );
    assert.strictEqual(DiffAnalyzer.inferType(['tests/application/a.ts', 'tests/domain/b.test.ts']), COMMIT_TYPE_TEST);
    assert.strictEqual(DiffAnalyzer.inferType(['.github/workflows/ci.yml']), COMMIT_TYPE_CI);
    assert.strictEqual(DiffAnalyzer.inferType(['package.json', 'package-lock.json']), COMMIT_TYPE_BUILD);
  });

  test('T11.11 (AC-4.2): an explicit scope still wins with its sanitisation', () => {
    assert.strictEqual(
      DiffAnalyzer.inferScope(['src/application/x.ts'], 'MyFeature!'),
      'myfeature'
    );
    // A sanitised-to-empty explicit scope falls back to inference.
    assert.strictEqual(DiffAnalyzer.inferScope(['src/application/x.ts'], '!!!'), 'app');
    assert.strictEqual(DiffAnalyzer.inferScope([], 'given'), 'given');
    assert.strictEqual(DiffAnalyzer.inferScope([]), null);
  });
});

/**
 * Issue #382 (D1, was #360) — classify the diff line BEFORE matching.
 *
 * The detector used to run `diffText.includes('BREAKING CHANGE:')` over the
 * whole raw patch, so a token in a 3-line context block, a hunk-header trailer,
 * a file-header path or a `Binary files … differ` meta line declared the change
 * breaking. The narrowing must not remove the real-detection half: an added or
 * removed content line, and a bare added footer, stay breaking.
 */
describe('breaking-change detection classifies diff lines (issue #382)', () => {
  const TOKEN = 'BREAKING CHANGE:';
  const HEADERS = [
    'diff --git a/docs/x.md b/docs/x.md',
    '--- a/docs/x.md',
    '+++ b/docs/x.md'
  ];

  const diff = (...lines: string[]): string => [...HEADERS, ...lines, ''].join('\n');
  const analyze = (text: string) =>
    DiffAnalyzer.analyzeDiff(text, { issueNumber: 1, issueTitle: 'x' });

  test('DA-BREAK-1: a token confined to a context block is not breaking', () => {
    const contextOnly = diff(
      '@@ -1,3 +1,4 @@',
      ` ${TOKEN} silent commits are forbidden.`,
      ' unchanged',
      '+new line',
      ' context'
    );

    const plan = analyze(contextOnly);
    assert.strictEqual(plan.isBreaking, false);
    assert.ok(!plan.commitMessage.toSingleLine().includes('!'), plan.commitMessage.toSingleLine());
    assert.strictEqual(plan.commitMessage.toSingleLine(), 'docs: x (#1)');
  });

  test('DA-BREAK-2: a token only in the hunk-header trailer is not breaking', () => {
    const hunkOnly = diff(`@@ -1 +1 @@ ${TOKEN} trailer`, ' unchanged', '+plain');
    const plan = analyze(hunkOnly);
    assert.strictEqual(plan.isBreaking, false);
    assert.ok(!plan.commitMessage.toSingleLine().includes('!'), plan.commitMessage.toSingleLine());
  });

  test('DA-BREAK-3: a token only in a file-header path is not breaking', () => {
    const headerOnly = [
      `diff --git a/x.md b/${TOKEN} notes.md`,
      '--- a/x.md',
      `+++ b/${TOKEN} notes.md`,
      '@@ -1 +1 @@',
      '+plain',
      ''
    ].join('\n');

    const plan = analyze(headerOnly);
    assert.strictEqual(plan.isBreaking, false);
    assert.ok(!plan.commitMessage.toSingleLine().includes('!'), plan.commitMessage.toSingleLine());
  });

  test('DA-BREAK-4: a token on an added line or a removed line IS breaking', () => {
    const added = diff('@@ -1 +1,2 @@', ' context', `+${TOKEN} description`);
    const addedPlan = analyze(added);
    assert.strictEqual(addedPlan.isBreaking, true);
    assert.ok(addedPlan.commitMessage.toSingleLine().includes('!:'), addedPlan.commitMessage.toSingleLine());

    const removed = diff('@@ -1,2 +1 @@', `-${TOKEN} description`, ' context');
    const removedPlan = analyze(removed);
    assert.strictEqual(removedPlan.isBreaking, true);
    assert.ok(removedPlan.commitMessage.toSingleLine().includes('!:'), removedPlan.commitMessage.toSingleLine());

    // The pre-existing added-line positive control stays reachable.
    assert.strictEqual(DiffAnalyzer.detectBreakingChanges(SAMPLE_DIFF_BREAKING), true);
  });

  test('DA-BREAK-5: a bare added footer (no description) is still breaking', () => {
    // `REGEX_BREAKING_CHANGE_FOOTER` needs non-empty text after the colon, so
    // this shape is caught only by the token half — which must survive.
    const bareFooter = diff('@@ -1 +1,2 @@', ' context', '+BREAKING CHANGE:');
    assert.strictEqual(analyze(bareFooter).isBreaking, true);
  });

  test('DA-BREAK-6: a real footer with text on an added line is breaking', () => {
    const footer = diff('@@ -1 +1,2 @@', ' context', `+${TOKEN} real description`);
    assert.strictEqual(analyze(footer).isBreaking, true);
  });

  test('DA-BREAK-7: a token only inside a meta line is not breaking', () => {
    const metaOnly = diff(
      '@@ -1 +1 @@',
      `Binary files a/x and b/${TOKEN} y differ`,
      '\\ No newline at end of file'
    );
    const plan = analyze(metaOnly);
    assert.strictEqual(plan.isBreaking, false);
    assert.ok(!plan.commitMessage.toSingleLine().includes('!'), plan.commitMessage.toSingleLine());
  });

  test('DA-METRICS-1: one line-kind definition keeps the existing totals and fixes ++ content', () => {
    // The pre-#382 totals for this fixture are { additions: 4, deletions: 0 };
    // the classifier must not change them.
    assert.deepStrictEqual(DiffAnalyzer.calculateMetrics(SAMPLE_DIFF_SRC), {
      additions: 4,
      deletions: 0
    });

    // An added line whose CONTENT starts with `++`/`--` is one addition, not a
    // file header: the classifier reads line kind, not the first three chars.
    const embeddedDiff = [
      'diff --git a/src/test.ts b/src/test.ts',
      '--- a/src/test.ts',
      '+++ b/src/test.ts',
      '@@ -1,3 +1,5 @@',
      '+const mockDiff = `diff --git a/spurious.ts b/spurious.ts',
      '+--- a/spurious.ts',
      '++++ b/spurious.ts`',
      ''
    ].join('\n');

    assert.deepStrictEqual(DiffAnalyzer.calculateMetrics(embeddedDiff), {
      additions: 3,
      deletions: 0
    });
  });
});
