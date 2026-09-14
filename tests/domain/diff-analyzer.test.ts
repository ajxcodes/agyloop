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
  COMMIT_TYPE_BUILD
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
});
