/**
 * agyloop - Root-build command detector (issue #402, Defect 2 / AC4)
 *
 * RBC1 - the #383 shape (`npm run build >/dev/null 2>&1 && …`) is refused by name
 * RBC2 - `npm test` is refused
 * RBC3 - yarn/pnpm build forms are refused
 * RBC4 - vite/cargo/go/make/webpack and destructive `rm -rf dist|build` are refused
 * RBC5 - read-only commands stay allowed
 * RBC6 - a bare `tsc` is refused, `--noEmit` and an absolute scratch `--outDir`
 *        outside the workspace are allowed, an in-workspace `--outDir` is not
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { detectRootBuildCommand } = require('../../dist/domain');

describe('detectRootBuildCommand (issue #402)', () => {
  test('RBC1: the #383 npm run build chain is refused by name', () => {
    const match = detectRootBuildCommand('npm run build >/dev/null 2>&1 && node -e "1"');

    assert.ok(match, 'the #383 shape must be detected');
    assert.strictEqual(match.label, 'npm run build');
    assert.ok(match.excerpt.includes('npm run build'));
  });

  test('RBC2: npm test and its aliases are refused', () => {
    assert.strictEqual(detectRootBuildCommand('npm test').label, 'npm test');
    assert.strictEqual(detectRootBuildCommand('npm run compile').label, 'npm run compile');
    assert.strictEqual(detectRootBuildCommand('npm run prepare').label, 'npm run prepare');
    assert.strictEqual(detectRootBuildCommand('npm run build:docs').label, 'npm run build:docs');
  });

  test('RBC3: yarn and pnpm build forms are refused', () => {
    assert.strictEqual(detectRootBuildCommand('yarn build').label, 'yarn build');
    assert.strictEqual(detectRootBuildCommand('pnpm run build').label, 'pnpm run build');
  });

  test('RBC4: other build runners and destructive root writes are refused', () => {
    assert.strictEqual(detectRootBuildCommand('vite build').label, 'vite build');
    assert.strictEqual(detectRootBuildCommand('cargo build --release').label, 'cargo build');
    assert.strictEqual(detectRootBuildCommand('go build ./...').label, 'go build');
    assert.strictEqual(detectRootBuildCommand('make all').label, 'make');
    assert.strictEqual(detectRootBuildCommand('webpack --mode production').label, 'webpack');
    assert.strictEqual(detectRootBuildCommand('rollup -c').label, 'rollup -c');
    assert.strictEqual(detectRootBuildCommand('rm -rf dist').label, 'rm -rf dist');
    assert.strictEqual(detectRootBuildCommand('rm -rf ./build').label, 'rm -rf build');
  });

  test('RBC5: read-only commands are not refused', () => {
    assert.strictEqual(detectRootBuildCommand("node -e 'console.log(1)'"), null);
    assert.strictEqual(detectRootBuildCommand('git status'), null);
    assert.strictEqual(detectRootBuildCommand('node --test tests/domain/root-build-command.test.ts'), null);
    assert.strictEqual(detectRootBuildCommand('npx tsc --noEmit -p tsconfig.test.json'), null);
    assert.strictEqual(
      detectRootBuildCommand('npx tsc --outDir "$HOME/.cache/agyloop/baseline-402/dist"'),
      null
    );
  });

  test('RBC6: tsc is refused unless it emits nowhere or into an outside scratch dir', () => {
    assert.strictEqual(detectRootBuildCommand('npx tsc').label, 'tsc');
    assert.strictEqual(detectRootBuildCommand('npx tsc --outDir dist').label, 'tsc');
    assert.strictEqual(detectRootBuildCommand('npx tsc --outDir ./dist').label, 'tsc');
    assert.strictEqual(detectRootBuildCommand('npx tsc --noEmit'), null);
    assert.strictEqual(
      detectRootBuildCommand('npx tsc --outDir "/home/agent/.cache/agyloop/baseline-402/dist"'),
      null
    );
    assert.strictEqual(
      detectRootBuildCommand('npx tsc --outDir /home/agent/.cache/agyloop/baseline-402/dist'),
      null
    );
  });

  test('RBC7: an absolute --outDir INSIDE the workspace is still a root build', () => {
    const workspaceDir = '/home/agent/repo';
    assert.strictEqual(
      detectRootBuildCommand('npx tsc --outDir /home/agent/repo/dist', { workspaceDir }).label,
      'tsc'
    );
    assert.strictEqual(
      detectRootBuildCommand('npx tsc --outDir /home/agent/.cache/baseline-402/dist', {
        workspaceDir
      }),
      null
    );
  });

  test('RBC8: an empty command is never a match', () => {
    assert.strictEqual(detectRootBuildCommand(''), null);
    assert.strictEqual(detectRootBuildCommand('   \n  '), null);
  });
});
