const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  FilePlanGenerator,
  LEGACY_SUMMARY_FILENAME
} = require('../../dist/infrastructure/file-plan-generator');
const { DEFAULT_SUMMARY_FILENAME } = require('../../dist/domain/constants');

describe('FilePlanGenerator - Summary Naming & Backward Compatibility', () => {
  let tempDir: string;
  let generator: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-test-'));
    generator = new FilePlanGenerator();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('generates CodeLoop Summary.md by default', () => {
    assert.strictEqual(DEFAULT_SUMMARY_FILENAME, 'CodeLoop Summary.md');
    const result = generator.generateSummaryLog({
      targetDir: tempDir,
      projectName: 'TestApp',
      issueNumber: 42
    });

    assert.ok(result.created);
    assert.strictEqual(path.basename(result.summaryPath), 'CodeLoop Summary.md');
    assert.ok(fs.existsSync(result.summaryPath));
    assert.ok(fs.existsSync(path.join(tempDir, 'CodeLoop Summary.md')));
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'AgyLoop Summary.md')), false);
  });

  test('retains and loads AgyLoop Summary.md if it already exists in the artifact directory', () => {
    const legacyPath = path.join(tempDir, LEGACY_SUMMARY_FILENAME);
    fs.writeFileSync(legacyPath, '# Legacy AgyLoop Execution Summary\n', 'utf8');

    // Generating summary in a directory that already has legacy summary
    const result = generator.generateSummaryLog({
      targetDir: tempDir,
      projectName: 'TestApp',
      issueNumber: 42
    });

    assert.strictEqual(result.created, false);
    assert.strictEqual(result.summaryPath, legacyPath);
    assert.strictEqual(path.basename(result.summaryPath), 'AgyLoop Summary.md');
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'CodeLoop Summary.md')), false);

    // Resolving plan in the directory with legacy summary
    const planPath = path.join(tempDir, 'implementation_plan.md');
    fs.writeFileSync(planPath, '# Plan', 'utf8');

    const resolved = generator.resolvePlanFile({
      planDir: tempDir
    });

    assert.ok(resolved);
    assert.strictEqual(resolved.summaryPath, legacyPath);
  });

  test('resolves CodeLoop Summary.md if no legacy summary exists', () => {
    const planPath = path.join(tempDir, 'implementation_plan.md');
    const defaultSummaryPath = path.join(tempDir, DEFAULT_SUMMARY_FILENAME);
    fs.writeFileSync(planPath, '# Plan', 'utf8');
    fs.writeFileSync(defaultSummaryPath, '# Summary', 'utf8');

    const resolved = generator.resolvePlanFile({
      planDir: tempDir
    });

    assert.ok(resolved);
    assert.strictEqual(resolved.summaryPath, defaultSummaryPath);
  });
});

describe('FilePlanGenerator - plan digest (issue #298, AC9)', () => {
  let tempDir: string;
  let generator: any;
  let planFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-digest-'));
    generator = new FilePlanGenerator();
    planFile = path.join(tempDir, 'implementation_plan.md');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('FPG-D1: stable for a checkbox tick, changes on a content edit, null when missing', () => {
    fs.writeFileSync(planFile, '# Plan\n\n- [ ] Step one\n', 'utf8');
    const first = generator.hashPlanDocument(planFile);
    assert.ok(first);

    fs.writeFileSync(planFile, '# Plan\n\n- [x] Step one\n', 'utf8');
    assert.strictEqual(generator.hashPlanDocument(planFile), first, 'a tick is not a plan edit');

    fs.writeFileSync(planFile, '# Plan\n\n- [ ] Step two\n', 'utf8');
    assert.notStrictEqual(generator.hashPlanDocument(planFile), first, 'prose changes invalidate approval');

    assert.strictEqual(generator.hashPlanDocument(path.join(tempDir, 'missing.md')), null);
  });
});

describe('FilePlanGenerator - Release Notes dependency (issue #315, AC-32)', () => {
  let tempDir: string;
  let generator: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-release-notes-'));
    generator = new FilePlanGenerator();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a freshly scaffolded summary names the cross-repo dependency', () => {
    const result = generator.generateSummaryLog({
      targetDir: tempDir,
      projectName: 'TestApp',
      issueNumber: 315
    });

    const written = fs.readFileSync(result.summaryPath, 'utf8');
    assert.match(written, /## Release Notes Dependency/);
    assert.match(written, /ajxcodes\/auto-tag/);
    assert.match(written, /not fixed here/);
  });

  test('an older summary gains the dependency without losing its content', () => {
    const summaryPath = path.join(tempDir, 'CodeLoop Summary.md');
    fs.writeFileSync(
      summaryPath,
      '# CodeLoop Execution Summary\n\n## Quality Gate Metrics\n- **Tests:** PASSED (12 passed)\n',
      'utf8'
    );

    const updated = generator.updateSummaryLog(summaryPath, { stage: 'Quality Gate', status: 'COMPLETED' });
    assert.strictEqual(updated, true);

    const written = fs.readFileSync(summaryPath, 'utf8');
    assert.match(written, /PASSED \(12 passed\)/, 'the existing content is preserved');
    assert.match(written, /ajxcodes\/auto-tag/);
    assert.match(written, /not fixed here/);
  });
});

describe('FilePlanGenerator - bounded artifact names (issue #364)', () => {
  let tempDir: string;
  let generator: any;

  const { planArtifactFileName, planByteLength, PLAN_FILE_NAME_MAX_BYTES } = require('../../dist/domain');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-name-test-'));
    generator = new FilePlanGenerator();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("FPG-364.1: scaffoldPlanDirectory's artifact basename is planArtifactFileName", () => {
    const titles = ['A short title', `Phase 6 ${'\u4e2d'.repeat(300)}`];
    for (let index = 0; index < titles.length; index++) {
      const root = path.join(tempDir, `run-${index}`);
      const info = generator.scaffoldPlanDirectory({
        projectRoot: root,
        issue: 364,
        title: titles[index]
      });
      assert.strictEqual(
        path.basename(info.planPath),
        planArtifactFileName(info.type, titles[index]),
        titles[index]
      );
    }
  });

  test('FPG-364.2: generatePlan called without planPath uses the bounded name', () => {
    const title = `Phase 6 ${'\u4e2d'.repeat(300)}`;
    const result = generator.generatePlan({
      targetDir: tempDir,
      type: 'implementation',
      title
    });

    assert.ok(planByteLength(path.basename(result.planPath)) <= PLAN_FILE_NAME_MAX_BYTES);
    assert.strictEqual(path.basename(result.planPath), planArtifactFileName('implementation', title));
    assert.ok(fs.existsSync(result.planPath));
  });
});

// ============================================================================
// Issue #383: the lossy-slug residuals of #364.
// ============================================================================

describe('FilePlanGenerator - #383 residuals', () => {
  let tempDir: string;
  let generator: any;

  const {
    planFolderName,
    planArtifactFileName,
    PLAN_DIR_NAME_MAX_BYTES,
    VALIDATION_FIELD_PLAN_TITLE,
    ValidationError
  } = require('../../dist/domain');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-383-'));
    generator = new FilePlanGenerator();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('FPG-383.1: a raw ENAMETOOLONG becomes the typed plan-title message', () => {
    // AC-D2-4: the single branch that converts the OS error into a remedy. The
    // `fs` here is the same module object the generator reads through, so the
    // property patch is observed.
    const title = 'A title whose derived names fit the documented budget';
    const folder = planFolderName(383, title);
    const file = planArtifactFileName('implementation', title);
    const originalMkdirSync = fs.mkdirSync;
    let stubbed = 0;
    fs.mkdirSync = ((target: any, options: any) => {
      if (String(target).endsWith(folder)) {
        stubbed += 1;
        const error: any = new Error('ENAMETOOLONG: name too long');
        error.code = 'ENAMETOOLONG';
        throw error;
      }
      return originalMkdirSync(target, options);
    }) as typeof fs.mkdirSync;
    try {
      assert.throws(
        () => generator.scaffoldPlanDirectory({ projectRoot: tempDir, issue: 383, title }),
        (error: any) => {
          assert.ok(error instanceof ValidationError, 'typed');
          assert.strictEqual(error.field, VALIDATION_FIELD_PLAN_TITLE);
          assert.ok(error.message.includes(folder), error.message);
          assert.ok(error.message.includes(file), error.message);
          assert.ok(error.message.includes(String(PLAN_DIR_NAME_MAX_BYTES)), error.message);
          assert.ok(error.message.includes('--title'), error.message);
          assert.match(error.message, /filesystem refused/, 'must not be a bare ENAMETOOLONG');
          return true;
        }
      );
    } finally {
      fs.mkdirSync = originalMkdirSync;
    }
    assert.strictEqual(stubbed, 1, 'the stub must be the branch under test');
    assert.ok(
      !fs.existsSync(path.join(tempDir, 'artifacts', 'plans', folder)),
      'no half-scaffolded folder'
    );
  });

  test('FPG-383.2: a checkpoint hint for another ad-hoc title is ignored', () => {
    const first = generator.scaffoldPlanDirectory({
      projectRoot: tempDir,
      title: 'Phase 6 ' + '中'.repeat(40)
    });

    // The checkpoint tracks the FIRST title's folder while this run names the
    // second: the hint is stale, so the scaffold derives its own folder.
    const second = generator.scaffoldPlanDirectory({
      projectRoot: tempDir,
      title: 'Phase 6 ' + '文'.repeat(40),
      planDir: first.planDir,
      planDirIsCheckpoint: true
    });
    assert.notStrictEqual(second.planDir, first.planDir);
    assert.strictEqual(second.checkpointDirIgnored, true);
    assert.strictEqual(second.folderName, planFolderName(null, 'Phase 6 ' + '文'.repeat(40)));

    // The SAME title with a checkpoint hint adopts its own folder.
    const adopt = generator.scaffoldPlanDirectory({
      projectRoot: tempDir,
      title: 'Phase 6 ' + '中'.repeat(40),
      planDir: first.planDir,
      planDirIsCheckpoint: true
    });
    assert.strictEqual(adopt.planDir, first.planDir);
    assert.ok(!adopt.checkpointDirIgnored, 'an own-title hint must not be reported as ignored');

    // An EXPLICIT --plan-dir (flag absent) always wins, even for another title.
    const explicit = generator.scaffoldPlanDirectory({
      projectRoot: tempDir,
      title: 'A brand new ad-hoc title',
      planDir: first.planDir
    });
    assert.strictEqual(explicit.planDir, first.planDir);
    assert.ok(!explicit.checkpointDirIgnored);
    assert.strictEqual(fs.readdirSync(path.join(tempDir, 'artifacts', 'plans')).length, 2);
  });
});
