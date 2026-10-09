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
