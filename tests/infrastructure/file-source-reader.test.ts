/**
 * agyloop - FileSourceReader revision reads (issue #489)
 *
 * The Test Register's `New test:` check asks the BASE revision whether a
 * title exists, while `Pins:` keeps resolving against the DELIVERED tree. The
 * whole fix rests on this adapter's tri-state: `found` / `absent` /
 * `unavailable` must never be conflated, and the traversal guard must apply
 * to the revision read too.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { FileSourceReader } = require('../../dist/infrastructure');

const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;
const roots: string[] = [];

after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A repo whose base commit holds `tests/base.test.ts`, plus a dirty new file. */
function makeRepo(): string {
  if (!GIT_AVAILABLE) return '';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-489-reader-'));
  roots.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'tests', 'base.test.ts'),
    [
      "const assert = require('node:assert');",
      "test('already on base', () => {",
      '  assert.strictEqual(1, 1);',
      '});'
    ].join('\n')
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base: the pre-change tree']);
  fs.writeFileSync(
    path.join(repo, 'tests', 'added.test.ts'),
    [
      "const assert = require('node:assert');",
      "test('added by the implementation', () => {",
      '  assert.strictEqual(2, 2);',
      '});'
    ].join('\n')
  );
  return repo;
}

test('FR1 reads a file at the base revision although the worktree copy differs (AC1, issue #489)', () => {
  const repo = makeRepo();
  if (!repo) return;
  fs.appendFileSync(
    path.join(repo, 'tests', 'base.test.ts'),
    "\ntest('added later in the worktree', () => {});\n"
  );
  const reader = new FileSourceReader();
  const atBase = reader.readAtRevision('tests/base.test.ts', repo, 'main');
  const delivered = reader.read('tests/base.test.ts', repo);
  assert.strictEqual(atBase.status, 'found');
  assert.strictEqual(
    atBase.status === 'found' && atBase.content.includes('added later in the worktree'),
    false
  );
  assert.strictEqual(String(delivered).includes('added later in the worktree'), true);
});

test('FR2 reports absent when the path does not exist at the revision (AC1, issue #489)', () => {
  const repo = makeRepo();
  if (!repo) return;
  const reader = new FileSourceReader();
  assert.deepStrictEqual(reader.readAtRevision('tests/added.test.ts', repo, 'main'), {
    status: 'absent'
  });
});

test('FR3 reports unavailable when the revision cannot be resolved (issue #489)', () => {
  const repo = makeRepo();
  if (!repo) return;
  const reader = new FileSourceReader();
  const result = reader.readAtRevision('tests/base.test.ts', repo, 'no-such-branch');
  assert.strictEqual(result.status, 'unavailable');
});

test('FR4 keeps the revision read traversal-guarded (issue #489)', () => {
  const repo = makeRepo();
  if (!repo) return;
  const reader = new FileSourceReader();
  assert.strictEqual(
    reader.readAtRevision('../outside.test.ts', repo, 'main').status,
    'unavailable'
  );
  assert.strictEqual(reader.readAtRevision('tests/base.test.ts', repo, '-main').status, 'unavailable');
});

test('FR5 reads from a workspace root that is a subdirectory of the repository (issue #489)', () => {
  const repo = makeRepo();
  if (!repo) return;
  const sub = path.join(repo, 'packages', 'app');
  fs.mkdirSync(path.join(sub, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(sub, 'tests', 'sub.test.ts'), "test('in sub', () => {});\n");
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base: the package']);
  const reader = new FileSourceReader();
  const result = reader.readAtRevision('tests/sub.test.ts', sub, 'main');
  assert.strictEqual(result.status, 'found');
});
