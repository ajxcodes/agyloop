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
    assert.strictEqual(
      plan.commitMessage.toSingleLine(),
      'feat(reviewer): implement Interactive Conventional Commit Drafter & Human Approval Gate (#30)'
    );
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
