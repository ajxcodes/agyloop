/**
 * agyloop - FileProjectScaffolder Infrastructure Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const { FileProjectScaffolder } = require('../../dist/infrastructure');
const { INIT_GITIGNORE_RULES } = require('../../dist/domain');

describe('FileProjectScaffolder', () => {
  let dir: string;
  const scaffolder = new FileProjectScaffolder();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-scaffold-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('detects fullstack markers', async () => {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []');
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}');
    fs.mkdirSync(path.join(dir, 'prisma'));
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), '');
    fs.mkdirSync(path.join(dir, 'backend'));
    fs.mkdirSync(path.join(dir, 'frontend'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'playwright test' } }));

    const m = await scaffolder.detectMarkers(dir);
    assert.strictEqual(m.monorepo, true);
    assert.strictEqual(m.dockerCompose, true);
    assert.strictEqual(m.migrationTool, 'prisma');
    assert.strictEqual(m.e2eTool, 'playwright');
    assert.strictEqual(m.hasBackendMarkers, true);
    assert.strictEqual(m.hasFrontendMarkers, true);
    assert.strictEqual(m.packageScripts['test:e2e'], 'playwright test');

    const gates = [
      { id: 'typecheck', label: 'Typecheck', command: 'npm run typecheck' },
      { id: 'test', label: 'Test', command: 'npm test' }
    ];
    const profile = scaffolder.buildVerificationProfile(m, 'node', gates);
    assert.strictEqual(profile.fastCheck.length, 1);
    assert.strictEqual(profile.gates.length, 2);
    assert.match(profile.smoke.setup, /docker compose up -d/);
    assert.strictEqual(profile.smoke.teardown, 'docker compose down');
    const ids = profile.smoke.steps.map((s: any) => s.id);
    assert.deepStrictEqual(ids, ['db-status', 'api-health', 'e2e-smoke']);
  });

  test('simple project yields single-step smoke from test command', async () => {
    const m = await scaffolder.detectMarkers(dir);
    const profile = scaffolder.buildVerificationProfile(m, 'node', [
      { id: 'test', label: 'Test', command: 'npm test' }
    ]);
    assert.strictEqual(profile.smoke.steps.length, 1);
    assert.strictEqual(profile.smoke.steps[0].command, 'npm test');
    assert.strictEqual(profile.smoke.setup, undefined);
  });

  test('gitignore update is idempotent, preserves content and never ignores config.json', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.codeloop/state.json');
    const { added } = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.ok(!added.includes('.codeloop/state.json'));
    assert.ok(added.includes('.worktrees/'));
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(content.startsWith('node_modules/\n.codeloop/state.json\n'));
    assert.ok(content.includes('# codeloop / agyloop ephemeral runtime state'));
    assert.ok(!/config\.json/.test(content));

    const again = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.deepStrictEqual(again, { added: [], replaced: [] });
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), content);
  });

  test('writeConfig writes atomically formatted JSON and findExistingConfig prefers codeloop', () => {
    fs.writeFileSync(path.join(dir, '.agyloop.json'), '{}');
    assert.strictEqual(scaffolder.findExistingConfig(dir), path.join(dir, '.agyloop.json'));
    assert.strictEqual(scaffolder.detectLegacyLayout(dir).legacyConfigPath, path.join(dir, '.agyloop.json'));

    const p = scaffolder.writeConfig(dir, { a: 1 });
    assert.strictEqual(p, path.join(dir, '.codeloop', 'config.json'));
    assert.strictEqual(fs.readFileSync(p, 'utf8'), '{\n  "a": 1\n}\n');
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.codeloop')), ['config.json']);
    assert.strictEqual(scaffolder.findExistingConfig(dir), p);
    assert.deepStrictEqual(scaffolder.readConfig(p), { a: 1 });
  });

  test('reconciles blanket ignores so config.json is tracked but state is ignored', () => {
    const git = (...args: string[]) => {
      try {
        return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      } catch {
        return null; // exit 1 => not ignored
      }
    };
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\nconfig.json\n.agyloop\n.codeloop/tasks\n');

    const first = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    // #221: a bare `.agyloop` is now the symlink-safe form, not a blanket to swap out. It is
    // retained and paired with `!.agyloop/` so the symlink stays ignored while config.json
    // remains trackable. `.codeloop` has no symlink counterpart, so nothing is replaced.
    assert.deepStrictEqual(first.replaced, []);
    assert.ok(first.added.includes('!.agyloop/'));
    assert.ok(first.added.includes('!.codeloop/config.json'));
    assert.ok(!first.added.includes('.codeloop/tasks/'));
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(content.includes('node_modules\nconfig.json\n'));

    assert.strictEqual(git('check-ignore', '.codeloop/config.json'), null);
    assert.strictEqual(git('check-ignore', '.agyloop/config.json'), null);
    // Issue #315 (AC-12): state lives in `.agyloop/` only. `.codeloop/` holds
    // config and nothing writes `.codeloop/state.json`, so no rule claims it.
    assert.strictEqual(git('check-ignore', '.codeloop/state.json'), null);
    assert.ok(git('check-ignore', '.agyloop/state.json'));

    const again = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.deepStrictEqual(again, { added: [], replaced: [] });
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), content);
    assert.deepStrictEqual(scaffolder.previewGitIgnore(dir, INIT_GITIGNORE_RULES), { added: [], replaced: [] });
  });

  test('SC1: the dispatched-review evidence directory is ignored and config stays trackable (issue #397)', () => {
    const git = (...args: string[]) => {
      try {
        return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      } catch {
        return null; // exit 1 => not ignored
      }
    };
    execFileSync('git', ['init', '-q'], { cwd: dir });

    assert.ok(
      INIT_GITIGNORE_RULES.includes('.agyloop/critique/'),
      'INIT_GITIGNORE_RULES lost the Tier 1 evidence rule'
    );

    const first = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.ok(first.added.includes('.agyloop/critique/'));

    assert.ok(
      git('check-ignore', '.agyloop/critique/397.json'),
      'the Tier 1 evidence file would be committed as review evidence'
    );
    // The re-inclusions the rule must not disturb.
    assert.strictEqual(git('check-ignore', '.agyloop/config.json'), null);
    assert.ok(git('check-ignore', '.agyloop/tasks/397.json'));

    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const again = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.deepStrictEqual(again, { added: [], replaced: [] });
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), content);
    assert.ok(content.includes('!.agyloop/'));
  });

  test('replaces blanket .codeloop/ directory ignore with granular rules', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '/.codeloop/\n');
    const res = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.deepStrictEqual(res.replaced, ['/.codeloop/']);
    assert.ok(!fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').includes('/.codeloop/'));
  });

  test('triggers config re-inclusion negations for **/config.json', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '**/config.json\n');
    const res = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.ok(res.added.includes('!.codeloop/config.json'));
    assert.ok(res.added.includes('!.agyloop/config.json'));
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(content.includes('!.codeloop/config.json'));
    assert.ok(content.includes('!.agyloop/config.json'));
  });

  test('detects indirect parent-dir ignores and appends directory negations before granular rules with warnings', () => {
    const git = (...args: string[]) => {
      try {
        return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      } catch {
        return null;
      }
    };
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.*\n**/.agyloop\n');

    const res = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.ok(res.added.includes('!.codeloop/'));
    assert.ok(res.added.includes('!.agyloop/'));
    assert.ok(res.warnings && res.warnings.length > 0);
    assert.ok(res.warnings[0].includes('.*'));

    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const lines = content.split(/\r?\n/).map((l: string) => l.trim());
    const codeloopNegIdx = lines.indexOf('!.codeloop/');
    const agyloopNegIdx = lines.indexOf('!.agyloop/');
    const codeloopStateIdx = lines.indexOf('.codeloop/state.json');
    const agyloopStateIdx = lines.indexOf('.agyloop/state.json');

    assert.ok(codeloopNegIdx !== -1 && agyloopNegIdx !== -1);
    // Issue #315 (AC-12): the `.codeloop/*` STATE rules are gone — the tool
    // writes no state there — so only the `.agyloop/` granular rule is emitted.
    assert.strictEqual(codeloopStateIdx, -1, 'no dead `.codeloop/state.json` rule may be emitted');
    assert.ok(agyloopStateIdx !== -1);
    assert.ok(agyloopNegIdx < agyloopStateIdx);

    // Verify git check-ignore behaves as expected
    assert.strictEqual(git('check-ignore', '.codeloop/config.json'), null);
    assert.strictEqual(git('check-ignore', '.agyloop/config.json'), null);
    assert.strictEqual(git('check-ignore', '.codeloop/state.json'), null);
    assert.ok(git('check-ignore', '.agyloop/state.json'));
    assert.ok(git('check-ignore', '.agyloop/critique-update-cache.json'));
    assert.ok(git('check-ignore', '.agyloop/state.json.bak'));

    // Idempotent
    const again = scaffolder.updateGitIgnore(dir, INIT_GITIGNORE_RULES);
    assert.deepStrictEqual(again, { added: [], replaced: [] });
  });
});
