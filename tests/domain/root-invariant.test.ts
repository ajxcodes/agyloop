/**
 * agyloop - Root-Invariant Value Object Unit Tests (#247, T1)
 *
 * Contract of the ONE shared Zero Direct Root Mutation predicate:
 * `isRootWorkspace`, `isPathInsideRoot`, `assertNotRootWorkspace`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  isRootWorkspace,
  isPathInsideRoot,
  isSamePath,
  assertNotRootWorkspace,
  ZERO_DIRECT_ROOT_MUTATION_MESSAGE
} = require('../../dist/domain');

describe('Root-Invariant Value Object (#247)', () => {
  describe('isRootWorkspace', () => {
    test('equals the root for identical, relative, nested-relative and ".."-normalized variants', () => {
      const root = '/repo';
      const cwd = process.cwd();

      assert.strictEqual(isRootWorkspace('/repo', root), true);
      assert.strictEqual(isRootWorkspace('/repo/', root), true);
      assert.strictEqual(isRootWorkspace('/repo/nested/..', root), true);
      assert.strictEqual(isRootWorkspace('/repo/a/b/../../x/../.', root), true);
      // Relative candidates resolve against the process cwd, so they equal the
      // root exactly when the root IS the cwd (the `codeloop next` scenario:
      // cwd === repoRoot and the descriptor path is '.').
      assert.strictEqual(isRootWorkspace('.', cwd), true);
      assert.strictEqual(isRootWorkspace('./', cwd), true);
      assert.strictEqual(isRootWorkspace('./nested/..', cwd), true);
    });

    test('is false for sibling and .worktrees/<id> paths', () => {
      const root = '/repo';

      assert.strictEqual(isRootWorkspace('/repo/.worktrees/41', root), false);
      assert.strictEqual(isRootWorkspace('/sibling-repo', root), false);
      assert.strictEqual(isRootWorkspace('/other', root), false);
      assert.strictEqual(isRootWorkspace('/repo2', root), false, 'no stem/prefix matching');
    });

    test('resolves both sides, so a non-normalized root still matches', () => {
      assert.strictEqual(isRootWorkspace('/repo/./', '/repo/nested/..'), true);
    });

    test('anchors a relative candidate on the workspace root it is compared with', () => {
      // The domain layer may not import `path` (architecture fitness test), so the
      // anchor is the workspace root itself instead of the process cwd: a relative
      // descriptor path denotes the workspace it is checked against.
      assert.strictEqual(isRootWorkspace('.', '/repo'), true);
      assert.strictEqual(isRootWorkspace('./nested/..', '/repo'), true);
      assert.strictEqual(isRootWorkspace('..', '/repo'), false, 'the parent is not the root');
      assert.strictEqual(isRootWorkspace('sub', '/repo'), false);
    });
  });

  describe('isPathInsideRoot', () => {
    test('is true only for strict descendants', () => {
      assert.strictEqual(isPathInsideRoot('/repo/.worktrees/41', '/repo'), true);
      assert.strictEqual(isPathInsideRoot('/repo/.worktrees', '/repo'), true);
      assert.strictEqual(isPathInsideRoot('/repo/deep/nested/x', '/repo'), true);
      assert.strictEqual(isPathInsideRoot(path.join(process.cwd(), 'relative', 'node'), process.cwd()), true);
    });

    test('is false for the root itself and for ancestors', () => {
      assert.strictEqual(isPathInsideRoot('/repo', '/repo'), false, 'the root is not inside itself');
      assert.strictEqual(isPathInsideRoot('/repo/.', '/repo'), false);
      assert.strictEqual(isPathInsideRoot('/', '/repo'), false, 'ancestor');
      assert.strictEqual(isPathInsideRoot('/other', '/repo'), false);
    });

    test('is false for paths that merely share a stem prefix (no over-restriction)', () => {
      assert.strictEqual(isPathInsideRoot('/repo-alt', '/repo'), false);
      assert.strictEqual(isPathInsideRoot('/repository', '/repo'), false);
    });
  });

  describe('isSamePath', () => {
    // T-D1 (#282): the application layer's path comparison. Pure and
    // resolve-normalized; never stem matching, never relative-vs-absolute.
    test('compares resolve-normalized paths and never conflates relative with absolute', () => {
      assert.strictEqual(isSamePath('/repo/.worktrees/87', '/repo/.worktrees/./87'), true);
      assert.strictEqual(isSamePath('/repo/.worktrees/87', '/repo/.worktrees/87/'), true);
      assert.strictEqual(isSamePath('/repo/.worktrees/87', '/repo/x/../.worktrees/87'), true);
      assert.strictEqual(isSamePath('/repo/.worktrees/87', '/repo/.worktrees/88'), false);
      assert.strictEqual(isSamePath('', ''), false);
      assert.strictEqual(isSamePath('a', '/a'), false);
      assert.strictEqual(
        isSamePath('/repo/.worktrees/87', '/repo/.worktrees/870'),
        false,
        'no stem/prefix matching'
      );
    });
  });

  describe('assertNotRootWorkspace', () => {
    test('throws carrying the Zero Direct Root Mutation message text', () => {
      assert.throws(
        () => assertNotRootWorkspace('/repo', '/repo'),
        (err: Error) => {
          assert.ok(err.message.includes('Zero Direct Root Mutation invariant violated'));
          return true;
        }
      );
    });

    test('does not throw for a genuine non-root worktree path', () => {
      assert.doesNotThrow(() => assertNotRootWorkspace('/repo/.worktrees/41', '/repo'));
    });

    test('is resolve-normalized: relative variants of the workspace root still throw', () => {
      assert.throws(() => assertNotRootWorkspace(process.cwd(), process.cwd()));
      assert.throws(() => assertNotRootWorkspace('./', process.cwd()));
    });

    test('keeps the exact verbatim wording with the ValidationError-style context prefix', () => {
      try {
        assertNotRootWorkspace('/repo', '/repo', 'worktreePath');
        assert.fail('must throw');
      } catch (err: unknown) {
        const message = (err as Error).message;
        const expected = `Validation failed for field 'worktreePath': ${ZERO_DIRECT_ROOT_MUTATION_MESSAGE.replace('{rootDir}', '/repo')}`;
        assert.strictEqual(
          message,
          "Validation failed for field 'worktreePath': Zero Direct Root Mutation invariant violated. Pipeline must execute code modifications inside an isolated worktree, but target resolved to root workspace '/repo'."
        );
        assert.strictEqual(message, expected);
      }
    });
  });
});
