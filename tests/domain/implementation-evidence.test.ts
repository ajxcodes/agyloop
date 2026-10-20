/**
 * agyloop - Implementation Evidence Predicate Unit Tests (issue #259, E1-E5)
 *
 * Contract of the ONE shared noise-filter predicate:
 * `isImplementationEvidencePath(filePath, isUntracked)`.
 *
 * The rule (mirrors `DIFF_EXCLUDE_ARGS` for tracked changes):
 * - an UNTRACKED entry is evidence unless it is one of the tool's own
 *   bookkeeping paths (state, config, plan scaffold) or a symlink every task
 *   worktree carries;
 * - a TRACKED change is ALWAYS evidence, except for the lock files and the
 *   `dist/` / `build/` output directories.
 *
 * Every expectation is derived from the exported constants, so the test can
 * never drift away from the production rule.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  isImplementationEvidencePath,
  IMPLEMENTATION_EVIDENCE_EXCLUDED_PREFIXES,
  IMPLEMENTATION_EVIDENCE_EXCLUDED_FILES,
  DIFF_EXCLUDED_PATTERNS
} = require('../../dist/domain');

describe('Implementation Evidence Predicate (issue #259)', () => {
  describe('E1: an untracked lifecycle path (.agyloop/, .codeloop/, artifacts/, node_modules/) is ignored', () => {
    test('E1: an untracked lifecycle path (.agyloop/, .codeloop/, artifacts/, node_modules/) is ignored', () => {
      const lifecyclePaths = ['.agyloop/', '.codeloop/', 'artifacts/', 'node_modules/'];

      for (const lifecyclePath of lifecyclePaths) {
        assert.strictEqual(
          isImplementationEvidencePath(lifecyclePath, true),
          false,
          `untracked '${lifecyclePath}' is the tool's own bookkeeping, never an implementation`
        );
      }

      // The directories themselves and their contents are equally noise.
      assert.strictEqual(isImplementationEvidencePath('.agyloop/state.json', true), false);
      assert.strictEqual(isImplementationEvidencePath('artifacts/plans/32-x/implementation-plan.md', true), false);
      assert.strictEqual(isImplementationEvidencePath('node_modules/pkg/index.js', true), false);

      // Every excluded prefix is honoured (the constant is the single source
      // of truth, so a newly added prefix cannot silently start counting).
      for (const prefix of IMPLEMENTATION_EVIDENCE_EXCLUDED_PREFIXES) {
        assert.strictEqual(
          isImplementationEvidencePath(prefix, true),
          false,
          `untracked prefix '${prefix}' must never be evidence`
        );
      }
    });
  });

  describe('E2: an untracked plugin asset (plugin.json, prompts/, .gitignore) is ignored', () => {
    test('E2: an untracked plugin asset (plugin.json, prompts/, .gitignore) is ignored', () => {
      const pluginAssets = ['plugin.json', 'prompts/', '.gitignore'];

      for (const asset of pluginAssets) {
        assert.strictEqual(
          isImplementationEvidencePath(asset, true),
          false,
          `untracked '${asset}' is a plugin asset, never an implementation`
        );
      }

      assert.strictEqual(isImplementationEvidencePath('prompts/implementer.md', true), false);
      assert.strictEqual(isImplementationEvidencePath('config.default.json', true), false);

      // Every excluded file is honoured.
      for (const file of IMPLEMENTATION_EVIDENCE_EXCLUDED_FILES) {
        assert.strictEqual(
          isImplementationEvidencePath(file, true),
          false,
          `untracked file '${file}' must never be evidence`
        );
      }
    });
  });

  describe('E3: a tracked modification (M src/x.ts) is always counted, including under prompts/', () => {
    test('E3: a tracked modification (M src/x.ts) is always counted, including under prompts/', () => {
      assert.strictEqual(isImplementationEvidencePath('src/x.ts', false), true);
      assert.strictEqual(isImplementationEvidencePath('src/deep/nested/module.ts', false), true);
      assert.strictEqual(isImplementationEvidencePath('README.md', false), true);

      // A TRACKED edit under a path that is noise when untracked is a REAL
      // implementation — the noise filter applies to untracked entries only.
      assert.strictEqual(isImplementationEvidencePath('prompts/implementer.md', false), true);
      assert.strictEqual(isImplementationEvidencePath('templates/summary-log.md', false), true);
      assert.strictEqual(isImplementationEvidencePath('rules/coding-standards.md', false), true);
      assert.strictEqual(isImplementationEvidencePath('artifacts/plans/32-x/implementation-plan.md', false), true);
      assert.strictEqual(isImplementationEvidencePath('.agyloop/state.json', false), true);
      assert.strictEqual(isImplementationEvidencePath('plugin.json', false), true);
      assert.strictEqual(isImplementationEvidencePath('.gitignore', false), true);
    });
  });

  describe('E4: lock files and dist/ build/ are excluded from the evidence set (DIFF_EXCLUDE_ARGS parity)', () => {
    test('E4: lock files and dist/ build/ are excluded from the evidence set (DIFF_EXCLUDE_ARGS parity)', () => {
      const lockFiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];

      for (const lockFile of lockFiles) {
        assert.strictEqual(
          isImplementationEvidencePath(lockFile, false),
          false,
          `tracked '${lockFile}' is excluded by DIFF_EXCLUDE_ARGS`
        );
        assert.strictEqual(
          isImplementationEvidencePath(lockFile, true),
          false,
          `untracked '${lockFile}' is excluded by DIFF_EXCLUDE_ARGS`
        );
      }

      assert.strictEqual(isImplementationEvidencePath('dist/', false), false);
      assert.strictEqual(isImplementationEvidencePath('dist/main.js', false), false);
      assert.strictEqual(isImplementationEvidencePath('build/output.txt', false), false);
      assert.strictEqual(isImplementationEvidencePath('dist/main.js', true), false);
      assert.strictEqual(isImplementationEvidencePath('build/output.txt', true), false);

      // Parity: every pattern the tool already excludes from a diff is also
      // excluded from the evidence set, for BOTH tracked and untracked entries.
      for (const pattern of DIFF_EXCLUDED_PATTERNS) {
        const bare = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
        assert.strictEqual(
          isImplementationEvidencePath(bare, false),
          false,
          `tracked '${bare}' must be excluded (DIFF_EXCLUDE_ARGS parity)`
        );
        assert.strictEqual(
          isImplementationEvidencePath(bare, true),
          false,
          `untracked '${bare}' must be excluded (DIFF_EXCLUDE_ARGS parity)`
        );
      }
    });
  });

  describe('E5: an untracked source file (?? src/new.ts) is counted', () => {
    test('E5: an untracked source file (?? src/new.ts) is counted', () => {
      assert.strictEqual(isImplementationEvidencePath('src/new.ts', true), true);
      assert.strictEqual(isImplementationEvidencePath('src/deep/nested/new.ts', true), true);
      assert.strictEqual(isImplementationEvidencePath('docs/guide.md', true), true);

      // Absence of evidence is never evidence: an empty path is not an
      // implementation.
      assert.strictEqual(isImplementationEvidencePath('', true), false);
      assert.strictEqual(isImplementationEvidencePath('', false), false);
      assert.strictEqual(isImplementationEvidencePath('   ', true), false);
    });
  });
});
