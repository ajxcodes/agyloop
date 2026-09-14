/**
 * agyloop - FileStandardsRepository Infrastructure Adapter Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FileStandardsRepository } = require('../../dist/infrastructure');

describe('FileStandardsRepository (Infrastructure Layer)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-standards-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns null when no standards files exist in workspace', () => {
    const repo = new FileStandardsRepository();
    const result = repo.loadStandards({ cwd: tempDir });
    assert.strictEqual(result, null);
    assert.strictEqual(repo.findStandardsPath({ cwd: tempDir }), null);
  });

  test('discovers .github/critique.md as top priority candidate', () => {
    const githubDir = path.join(tempDir, '.github');
    fs.mkdirSync(githubDir, { recursive: true });
    const critiqueFile = path.join(githubDir, 'critique.md');
    fs.writeFileSync(critiqueFile, '# Critique Standards\nRule 1: Strict review.', 'utf8');

    // Also write .critique.md, .github/ai-reviewer-standards.md, and AGENTS.md to verify priority
    fs.writeFileSync(path.join(tempDir, '.critique.md'), '# Dot Critique\nLower priority.', 'utf8');
    fs.writeFileSync(path.join(githubDir, 'ai-reviewer-standards.md'), '# AI Reviewer Standards\nLower priority.', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Agents\nLowest priority.', 'utf8');

    const repo = new FileStandardsRepository();
    const detectedPath = repo.findStandardsPath({ cwd: tempDir });
    assert.strictEqual(detectedPath, critiqueFile);

    const content = repo.loadStandards({ cwd: tempDir });
    assert.ok(content !== null);
    assert.ok(content && content.includes('Rule 1: Strict review.'));
  });

  test('discovers .critique.md when .github/critique.md does not exist', () => {
    const dotCritique = path.join(tempDir, '.critique.md');
    fs.writeFileSync(dotCritique, '# Dot Critique Rules\nReview every change.', 'utf8');

    const githubDir = path.join(tempDir, '.github');
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, 'ai-reviewer-standards.md'), '# AI Reviewer Standards\nLower priority.', 'utf8');

    const repo = new FileStandardsRepository();
    const detectedPath = repo.findStandardsPath({ cwd: tempDir });
    assert.strictEqual(detectedPath, dotCritique);

    const content = repo.loadStandards({ cwd: tempDir });
    assert.ok(content !== null);
    assert.ok(content && content.includes('Review every change.'));
  });

  test('discovers .github/ai-reviewer-standards.md when critique files do not exist', () => {
    const githubDir = path.join(tempDir, '.github');
    fs.mkdirSync(githubDir, { recursive: true });
    const standardsFile = path.join(githubDir, 'ai-reviewer-standards.md');
    fs.writeFileSync(standardsFile, '# GitHub Standards\nRule 1: No magic strings.', 'utf8');

    // Also write AGENTS.md to verify priority
    fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Agents\nLower priority.', 'utf8');

    const repo = new FileStandardsRepository();
    const detectedPath = repo.findStandardsPath({ cwd: tempDir });
    assert.strictEqual(detectedPath, standardsFile);

    const content = repo.loadStandards({ cwd: tempDir });
    assert.ok(content !== null);
    assert.ok(content && content.includes('Rule 1: No magic strings.'));
  });

  test('discovers AGENTS.md when .github/ai-reviewer-standards.md does not exist', () => {
    const agentsFile = path.join(tempDir, 'AGENTS.md');
    fs.writeFileSync(agentsFile, '# AGENTS Guidance\nClean architecture only.', 'utf8');

    const repo = new FileStandardsRepository();
    const detectedPath = repo.findStandardsPath({ cwd: tempDir });
    assert.strictEqual(detectedPath, agentsFile);

    const content = repo.loadStandards({ cwd: tempDir });
    assert.ok(content !== null);
    assert.ok(content && content.includes('Clean architecture only.'));
  });

  test('discovers STANDARDS.md as subsequent candidate', () => {
    const standardsFile = path.join(tempDir, 'STANDARDS.md');
    fs.writeFileSync(standardsFile, '# Repo Standards\nStrict typechecking.', 'utf8');

    const repo = new FileStandardsRepository();
    const detectedPath = repo.findStandardsPath({ cwd: tempDir });
    assert.strictEqual(detectedPath, standardsFile);

    const content = repo.loadStandards({ cwd: tempDir });
    assert.ok(content !== null);
    assert.ok(content && content.includes('Strict typechecking.'));
  });

  test('prioritizes explicit customPath over default candidate locations', () => {
    // Write default candidate
    fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Default candidate', 'utf8');

    // Write custom standards file
    const customPath = path.join(tempDir, 'custom-rules.md');
    fs.writeFileSync(customPath, '# Custom Rules\nCustom directive.', 'utf8');

    const repo = new FileStandardsRepository();
    const detectedPath = repo.findStandardsPath({ customPath: 'custom-rules.md', cwd: tempDir });
    assert.strictEqual(detectedPath, customPath);

    const content = repo.loadStandards({ customPath: 'custom-rules.md', cwd: tempDir });
    assert.ok(content !== null);
    assert.ok(content && content.includes('Custom directive.'));
  });

  test('falls back to candidate search if customPath does not exist', () => {
    const agentsFile = path.join(tempDir, 'AGENTS.md');
    fs.writeFileSync(agentsFile, '# AGENTS Guidance', 'utf8');

    const repo = new FileStandardsRepository();
    const detectedPath = repo.findStandardsPath({ customPath: 'non-existent.md', cwd: tempDir });
    assert.strictEqual(detectedPath, agentsFile);
  });
});
