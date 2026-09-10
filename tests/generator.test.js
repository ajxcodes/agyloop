const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  slugify,
  sanitizeFilename,
  ensurePlanDirectory,
  findPlanDirectory,
  loadTemplate,
  renderTemplate,
  detectPlanType,
  generatePlan,
  generateSummaryLog,
  updateSummaryLog,
  scaffoldPlanDirectory,
  TEMPLATE_FILES,
  FALLBACK_TEMPLATES
} = require('../lib/generator');
const { parseArguments } = require('../bin/agyloop.js');

describe('Persistent Plans Generator & Templating Engine', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-gen-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('slugify() & sanitizeFilename()', () => {
    test('slugify converts titles to URL-safe lowercased slugs', () => {
      assert.strictEqual(
        slugify('[Task] Phase 2: Implement Persistent artifacts/plans/ File Generation & Templates'),
        'task-phase-2-implement-persistent-artifacts-plans-file-generation-templates'
      );
      assert.strictEqual(slugify('  ---Hello---World---  '), 'hello-world');
      assert.strictEqual(slugify(''), '');
      assert.strictEqual(slugify(null), '');
      assert.strictEqual(slugify('Feature/User_Auth #42!'), 'feature-user-auth-42');
    });

    test('sanitizeFilename removes filesystem-unsafe characters', () => {
      assert.strictEqual(
        sanitizeFilename('Feature: Phase 2 <Plan> *? "quoted" | test'),
        'Feature Phase 2 Plan quoted test'
      );
      assert.strictEqual(sanitizeFilename(''), 'untitled');
      assert.strictEqual(sanitizeFilename(null), 'untitled');
    });
  });

  describe('ensurePlanDirectory() & .gitignore Enforcement', () => {
    test('creates artifacts/plans directory and initializes .gitignore if absent', () => {
      const plansDir = ensurePlanDirectory(tempDir);
      assert.ok(fs.existsSync(plansDir));
      assert.strictEqual(plansDir, path.join(tempDir, 'artifacts', 'plans'));

      const gitignorePath = path.join(tempDir, '.gitignore');
      assert.ok(fs.existsSync(gitignorePath));
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      assert.ok(gitignoreContent.includes('artifacts/plans/'));
    });

    test('appends to existing .gitignore without duplicating existing entry', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n', 'utf8');

      ensurePlanDirectory(tempDir);
      let content = fs.readFileSync(gitignorePath, 'utf8');
      assert.ok(content.includes('node_modules/'));
      assert.ok(content.includes('artifacts/plans/'));

      // Call again to verify idempotence
      ensurePlanDirectory(tempDir);
      content = fs.readFileSync(gitignorePath, 'utf8');
      const matches = content.match(/artifacts\/plans\//g);
      assert.strictEqual(matches.length, 1, 'artifacts/plans/ must not be duplicated in .gitignore');
    });

    test('does not modify .gitignore if artifacts/plans is already ignored', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'artifacts/plans/\n', 'utf8');

      ensurePlanDirectory(tempDir);
      const content = fs.readFileSync(gitignorePath, 'utf8');
      assert.strictEqual(content.trim(), 'artifacts/plans/');
    });
  });

  describe('loadTemplate() & renderTemplate()', () => {
    test('loads existing templates from repository templates directory', () => {
      const discovery = loadTemplate(TEMPLATE_FILES.DISCOVERY);
      const implementation = loadTemplate(TEMPLATE_FILES.IMPLEMENTATION);
      const summary = loadTemplate(TEMPLATE_FILES.SUMMARY);

      assert.ok(discovery.includes('# [Discovery] - {Title}'));
      assert.ok(implementation.includes('# [Implementation] - {Title}'));
      assert.ok(summary.includes('# AgyLoop Execution Summary'));
    });

    test('falls back to embedded string if template file missing from custom directory', () => {
      const emptyDir = path.join(tempDir, 'non-existent-templates');
      const fallback = loadTemplate(TEMPLATE_FILES.DISCOVERY, emptyDir);
      assert.ok(fallback.includes('# [Discovery] - {Title}'));
    });

    test('throws error for unknown template name with no fallback', () => {
      assert.throws(
        () => loadTemplate('unknown-template.md', tempDir),
        /Template not found: unknown-template\.md/
      );
    });

    test('renderTemplate replaces all declared placeholders and keeps unprovided ones intact', () => {
      const template = 'Issue: #{IssueNumber} - {Title} on {Date}. Unused: {UnusedVar}';
      const rendered = renderTemplate(template, {
        IssueNumber: 12,
        Title: 'Test Feature',
        Date: '2026-09-10'
      });

      assert.strictEqual(rendered, 'Issue: #12 - Test Feature on 2026-09-10. Unused: {UnusedVar}');
    });
  });

  describe('detectPlanType()', () => {
    test('detects discovery type from bug labels or titles', () => {
      assert.strictEqual(detectPlanType({ title: '[Bug] App crashes on startup' }), 'discovery');
      assert.strictEqual(detectPlanType({ title: 'fix: memory leak in worker' }), 'discovery');
      assert.strictEqual(detectPlanType({ title: 'RCA: Investigate latency spike' }), 'discovery');
      assert.strictEqual(detectPlanType({ title: 'Standard task', labels: ['bug'] }), 'discovery');
      assert.strictEqual(detectPlanType({ title: 'Standard task', labels: ['defect', 'urgent'] }), 'discovery');
    });

    test('defaults to implementation type for features and generic tasks', () => {
      assert.strictEqual(detectPlanType({ title: '[Task] Implement Auth Module' }), 'implementation');
      assert.strictEqual(detectPlanType({ title: 'feat: add dark mode support' }), 'implementation');
      assert.strictEqual(detectPlanType({ title: 'Setup CI/CD pipeline', labels: ['enhancement'] }), 'implementation');
    });
  });

  describe('generatePlan()', () => {
    test('generates implementation plan and canonical mirror in target directory', () => {
      const result = generatePlan({
        targetDir: tempDir,
        type: 'implementation',
        title: 'User Profile Settings',
        issueNumber: 42,
        date: '2026-09-10'
      });

      assert.ok(result.created);
      assert.ok(fs.existsSync(result.planPath));
      assert.ok(fs.existsSync(result.mirrorPath));
      assert.ok(result.planPath.endsWith('[Implementation] - User Profile Settings.md'));
      assert.ok(result.mirrorPath.endsWith('implementation_plan.md'));

      const content = fs.readFileSync(result.planPath, 'utf8');
      assert.ok(content.includes('# [Implementation] - User Profile Settings'));
      assert.ok(content.includes('**Issue:** #42'));
      assert.ok(content.includes('**Date:** 2026-09-10'));
    });

    test('generates discovery plan for defects', () => {
      const result = generatePlan({
        targetDir: tempDir,
        type: 'discovery',
        title: 'Buffer Overflow Crash',
        issueNumber: 99
      });

      assert.ok(result.planPath.endsWith('[Discovery] - Buffer Overflow Crash.md'));
      const content = fs.readFileSync(result.planPath, 'utf8');
      assert.ok(content.includes('# [Discovery] - Buffer Overflow Crash'));
      assert.ok(content.includes('Root Cause Analysis (RCA)'));
    });

    test('does not overwrite existing plan file unless overwrite=true', () => {
      generatePlan({
        targetDir: tempDir,
        type: 'implementation',
        title: 'Immutable Plan',
        variables: { Extra: 'First' }
      });

      const planPath = path.join(tempDir, '[Implementation] - Immutable Plan.md');
      fs.writeFileSync(planPath, '# Custom Content', 'utf8');

      const secondRun = generatePlan({
        targetDir: tempDir,
        type: 'implementation',
        title: 'Immutable Plan',
        overwrite: false
      });

      assert.strictEqual(secondRun.created, false);
      assert.strictEqual(fs.readFileSync(planPath, 'utf8'), '# Custom Content');

      const overwriteRun = generatePlan({
        targetDir: tempDir,
        type: 'implementation',
        title: 'Immutable Plan',
        overwrite: true
      });

      assert.strictEqual(overwriteRun.created, true);
      assert.ok(fs.readFileSync(planPath, 'utf8').includes('# [Implementation] - Immutable Plan'));
    });
  });

  describe('generateSummaryLog() & updateSummaryLog()', () => {
    test('generates AgyLoop Summary.md with initial metadata', () => {
      const result = generateSummaryLog({
        targetDir: tempDir,
        projectName: 'TestApp',
        issueNumber: 12,
        timestamp: '2026-09-10T12:00:00Z'
      });

      assert.ok(result.created);
      assert.ok(fs.existsSync(result.summaryPath));

      const content = fs.readFileSync(result.summaryPath, 'utf8');
      assert.ok(content.includes('**Project:** TestApp'));
      assert.ok(content.includes('**Active Issue:** #12'));
      assert.ok(content.includes('**Session Started:** 2026-09-10T12:00:00Z'));
      assert.ok(content.includes('| 1. Discovery |'));
    });

    test('updateSummaryLog modifies stage row and metrics', () => {
      const summaryResult = generateSummaryLog({
        targetDir: tempDir,
        projectName: 'TestApp',
        issueNumber: 12
      });

      const updated = updateSummaryLog(summaryResult.summaryPath, {
        stage: 'Discovery',
        subagent: 'planner',
        model: 'pro',
        status: 'COMPLETED',
        duration: '12s',
        buildStatus: 'PASSED',
        testsStatus: '100% (26 passed)',
        reviewNote: 'All architectural invariants satisfied'
      });

      assert.strictEqual(updated, true);
      const content = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(content.includes('| 1. Discovery | `planner` | `pro` | COMPLETED | 12s |'));
      assert.ok(content.includes('- **Build Status:** PASSED'));
      assert.ok(content.includes('- **Tests:** 100% (26 passed)'));
      assert.ok(content.includes('- All architectural invariants satisfied'));
    });
  });

  describe('scaffoldPlanDirectory() & findPlanDirectory()', () => {
    test('scaffolds complete plan folder with templates and summary', () => {
      const scaffold = scaffoldPlanDirectory({
        projectRoot: tempDir,
        issue: 12,
        title: '[Task] Persistent Plan Generation',
        type: 'auto'
      });

      assert.strictEqual(scaffold.folderName, '12-task-persistent-plan-generation');
      assert.strictEqual(scaffold.type, 'implementation');
      assert.ok(fs.existsSync(scaffold.planDir));
      assert.ok(fs.existsSync(scaffold.planPath));
      assert.ok(fs.existsSync(scaffold.mirrorPath));
      assert.ok(fs.existsSync(scaffold.summaryPath));

      // Test findPlanDirectory helper
      const foundDir = findPlanDirectory(tempDir, 12);
      assert.strictEqual(foundDir, scaffold.planDir);

      const notFound = findPlanDirectory(tempDir, 999);
      assert.strictEqual(notFound, null);
    });
  });

  describe('CLI Arguments & Integration', () => {
    test('parseArguments handles --title and --type options', () => {
      const { command, options } = parseArguments([
        'plan',
        '--issue',
        '12',
        '--title',
        'Refactor Database Layer',
        '--type',
        'implementation'
      ]);

      assert.strictEqual(command, 'plan');
      assert.strictEqual(options.issue, '12');
      assert.strictEqual(options.title, 'Refactor Database Layer');
      assert.strictEqual(options.type, 'implementation');
    });

    test('parseArguments safely handles dangling flags without values', () => {
      const { command, options } = parseArguments(['plan', '--title', '--type']);
      assert.strictEqual(command, 'plan');
      assert.strictEqual(options.title, null);
      assert.strictEqual(options.type, null);
    });
  });
});
