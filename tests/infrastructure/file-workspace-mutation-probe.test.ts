/**
 * agyloop - FileWorkspaceMutationProbe (issue #389, AC2)
 *
 * The adapter exists because the obvious oracle is blind: `dist/` is
 * gitignored, so `git status --porcelain` reports a root rebuild as clean. These
 * tests exercise the real filesystem and the real `git` binary — skipping only
 * when git is absent — so the "ignored root vs tracked write" split is measured,
 * not mocked.
 *
 * I1 - a write inside the excluded plan directory is never a finding
 * I2 - an ignored `dist/new.js` is clean to git, yet `compare` names `dist/`
 * I3 - a tracked `README.md` edit is a `tracked-write-outside-scope` finding
 * I4 - a modified file under `dist/` and a deleted root are both findings
 * I5 - a different `workspaceDir` returns `[]` (no invented findings)
 * I6 - a non-repository workspace does not throw and leaves the tracked set null
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { FileWorkspaceMutationProbe } = require('../../dist/infrastructure');
const { ProcessCommandExecutor } = require('../../dist/infrastructure');
const { DetectImplementationDiffUseCase } = require('../../dist/application');
const {
  STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE,
  STAGE_FINDING_RULE_TRACKED_WRITE_OUTSIDE_SCOPE
} = require('../../dist/domain');

const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PLAN_DIR_REL = 'artifacts/plans/389-smoke';

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-probe-389-'));
  fs.mkdirSync(path.join(root, 'artifacts/plans/389-smoke'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\nbuild/\nartifacts/\n.agyloop/\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'probe@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'chore: seed'], { cwd: root });
  return root;
}

function porcelain(root: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
}

describe('FileWorkspaceMutationProbe (issue #389)', { skip: !GIT_AVAILABLE }, () => {
  test('I1: a write inside the excluded plan directory is not a finding', async () => {
    const root = makeWorkspace();
    const probe = new FileWorkspaceMutationProbe(new ProcessCommandExecutor());
    const planDir = path.join(root, PLAN_DIR_REL);

    const baseline = await probe.snapshot({ workspaceDir: root, excludePaths: [planDir] });
    fs.writeFileSync(path.join(planDir, 'report.md'), '# report\n\nwritten inside the plan dir\n');

    const findings = await probe.compare({
      workspaceDir: root,
      baseline,
      excludePaths: [planDir]
    });
    assert.deepStrictEqual(findings, []);
  });

  test('I2: a gitignored dist/new.js is clean to git but is a write-outside-scope finding', async () => {
    const root = makeWorkspace();
    const probe = new FileWorkspaceMutationProbe(new ProcessCommandExecutor());
    const planDir = path.join(root, PLAN_DIR_REL);

    const baseline = await probe.snapshot({ workspaceDir: root, excludePaths: [planDir] });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/new.js'), '// built\n');

    // Positive control: the existing oracle cannot see this at all.
    assert.strictEqual(porcelain(root), '');
    const implementationProbe = new DetectImplementationDiffUseCase(new ProcessCommandExecutor());
    const implementation = await implementationProbe.execute({ workspaceDir: root });
    assert.strictEqual(
      implementation.hasChanges,
      false,
      `the implementation probe must still report no change, got ${JSON.stringify(implementation)}`
    );

    const findings = await probe.compare({
      workspaceDir: root,
      baseline,
      excludePaths: [planDir]
    });
    const dist = findings.find(
      (finding: any) => finding.rule === STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE && finding.path === 'dist/'
    );
    assert.ok(dist, `expected a dist/ finding, got ${JSON.stringify(findings)}`);
    assert.strictEqual(dist.detail, 'root build changed outside the plan directory');
  });

  test('I3: a tracked README.md edit is a tracked-write-outside-scope finding', async () => {
    const root = makeWorkspace();
    const probe = new FileWorkspaceMutationProbe(new ProcessCommandExecutor());
    const planDir = path.join(root, PLAN_DIR_REL);

    const baseline = await probe.snapshot({ workspaceDir: root, excludePaths: [planDir] });
    fs.appendFileSync(path.join(root, 'README.md'), 'tampered\n');

    const findings = await probe.compare({
      workspaceDir: root,
      baseline,
      excludePaths: [planDir]
    });
    const tracked = findings.find(
      (finding: any) =>
        finding.rule === STAGE_FINDING_RULE_TRACKED_WRITE_OUTSIDE_SCOPE && finding.path === 'README.md'
    );
    assert.ok(tracked, `expected a README.md finding, got ${JSON.stringify(findings)}`);
  });

  test('I4: a modified file under dist/ and a deleted root are both findings', async () => {
    const root = makeWorkspace();
    const probe = new FileWorkspaceMutationProbe(new ProcessCommandExecutor());
    const planDir = path.join(root, PLAN_DIR_REL);

    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/a.js'), 'one\n');
    fs.mkdirSync(path.join(root, 'build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'build/out.js'), 'built\n');

    const baseline = await probe.snapshot({ workspaceDir: root, excludePaths: [planDir] });

    // Same file, different content length: a rebuild, not a creation.
    fs.writeFileSync(path.join(root, 'dist/a.js'), 'two-and-longer\n');
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });

    const findings = await probe.compare({
      workspaceDir: root,
      baseline,
      excludePaths: [planDir]
    });
    const paths = findings
      .filter((finding: any) => finding.rule === STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE)
      .map((finding: any) => finding.path);
    assert.deepStrictEqual(paths.sort(), ['build/', 'dist/']);
  });

  test('I5: a different workspaceDir returns [] instead of inventing findings', async () => {
    const root = makeWorkspace();
    const other = makeWorkspace();
    const probe = new FileWorkspaceMutationProbe(new ProcessCommandExecutor());
    const planDir = path.join(root, PLAN_DIR_REL);

    const baseline = await probe.snapshot({ workspaceDir: root, excludePaths: [planDir] });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/polluted.js'), '// polluted\n');

    const findings = await probe.compare({
      workspaceDir: other,
      baseline,
      excludePaths: [path.join(other, PLAN_DIR_REL)]
    });
    assert.deepStrictEqual(findings, []);
  });

  test('I6: a non-repository workspace leaves the tracked set null and does not throw', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-probe-389-nogit-'));
    fs.mkdirSync(path.join(root, 'artifacts/plans/389-smoke'), { recursive: true });
    const probe = new FileWorkspaceMutationProbe(new ProcessCommandExecutor());
    const planDir = path.join(root, PLAN_DIR_REL);

    const baseline = await probe.snapshot({ workspaceDir: root, excludePaths: [planDir] });

    // Unmeasured is NOT clean: `null`, never `[]`.
    assert.strictEqual(baseline.trackedEntries, null);
    const findings = await probe.compare({
      workspaceDir: root,
      baseline,
      excludePaths: [planDir]
    });
    assert.deepStrictEqual(findings, []);
  });
});
