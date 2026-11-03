/**
 * agyloop - Bounded Workspace & Subproject Discovery Tests (issue #334)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { discoverSubprojects } = require('../../dist/infrastructure');
const { SUBPROJECT_MAX_COUNT } = require('../../dist/domain');

/** Writes a file, creating its parent directories. */
function write(root: string, rel: string, content = ''): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function discover(root: string): any[] {
  const fileNames = new Set(
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry: any) => entry.isFile())
      .map((entry: any) => entry.name)
  );
  return discoverSubprojects(root, fileNames);
}

describe('workspace-discovery (#334)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('WD1 discovers container and named subprojects and stops at depth two', () => {
    write(dir, 'apps/web/package.json', '{}');
    write(dir, 'apps/api/go.mod', 'module api\n');
    write(dir, 'packages/core/package.json', '{}');
    write(dir, 'src-tauri/Cargo.toml', '[package]\nname = "tauri"\n');
    write(dir, 'backend/MyApp/App.sln', '<Solution></Solution>');
    write(dir, 'node_modules/x/package.json', '{}');
    write(dir, 'apps/web/nested/package.json', '{}');

    const found = discover(dir);

    assert.deepStrictEqual(
      found.map((s: any) => s.relDir),
      ['apps/api', 'apps/web', 'backend/MyApp', 'packages/core', 'src-tauri']
    );
  });

  test('WD2 ignores build output and dependency directories', () => {
    write(dir, 'apps/web/package.json', '{}');
    write(dir, 'apps/dist/package.json', '{}');
    write(dir, 'apps/.next/package.json', '{}');
    write(dir, 'apps/web/target/package.json', '{}');

    const found = discover(dir);

    assert.deepStrictEqual(found.map((s: any) => s.relDir), ['apps/web']);
  });

  test('WD3 expands pnpm workspace globs into subproject candidates', () => {
    write(dir, 'pnpm-workspace.yaml', 'packages:\n  - "modules/core"\n');
    write(dir, 'modules/core/package.json', '{}');
    write(dir, 'modules/extra/package.json', '{}');

    const found = discover(dir);

    assert.deepStrictEqual(found.map((s: any) => s.relDir), ['modules/core']);
  });

  test('WD4 reads Cargo members, Gradle include and go.work use declarations', () => {
    write(dir, 'Cargo.toml', '[workspace]\nmembers = ["crates/a", "crates/b"]\n');
    write(dir, 'settings.gradle.kts', 'rootProject.name = "ws"\ninclude(":tools:cli")\n');
    write(dir, 'go.work', 'go 1.22\n\nuse ./tools/svc\n');
    write(dir, 'crates/a/Cargo.toml', '[package]\nname = "a"\n');
    write(dir, 'crates/b/Cargo.toml', '[package]\nname = "b"\n');
    write(dir, 'tools/cli/build.gradle.kts', '// cli\n');
    write(dir, 'tools/svc/go.mod', 'module svc\n');

    const found = discover(dir);

    assert.deepStrictEqual(
      found.map((s: any) => s.relDir),
      ['crates/a', 'crates/b', 'tools/cli', 'tools/svc']
    );
  });

  test('WD5 caps discovery count and returns a stable order', () => {
    for (let index = 1; index <= 70; index++) {
      const name = `p${String(index).padStart(3, '0')}`;
      write(dir, `apps/${name}/package.json`, '{}');
    }

    const found = discover(dir);

    assert.strictEqual(found.length, SUBPROJECT_MAX_COUNT);
    assert.strictEqual(found[0].relDir, 'apps/p001');
    assert.strictEqual(found[found.length - 1].relDir, `apps/p${String(SUBPROJECT_MAX_COUNT).padStart(3, '0')}`);
  });

  test('WD6 skips a symlinked candidate and never throws', () => {
    write(dir, 'apps/web/package.json', '{}');

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-discovery-link-'));
    try {
      fs.writeFileSync(path.join(outside, 'package.json'), '{}');
      fs.mkdirSync(path.join(dir, 'apps'), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, 'apps', 'link'), 'dir');

      const found = discover(dir);
      assert.deepStrictEqual(found.map((s: any) => s.relDir), ['apps/web']);

      assert.deepStrictEqual(
        discoverSubprojects(path.join(dir, 'missing-root'), new Set()),
        []
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
