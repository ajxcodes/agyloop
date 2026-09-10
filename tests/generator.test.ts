const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  FilePlanGenerator,
  parseArguments,
  TEMPLATE_FILES,
  FALLBACK_TEMPLATES
} = require('../dist');

describe('Persistent Plans Generator & Templating Engine (TypeScript)', () => {
  let tempDir: string;
  let generator: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-gen-test-'));
    generator = new FilePlanGenerator();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('slugify() & sanitizeFilename()', () => {
    test('slugify converts titles to URL-safe lowercased slugs', () => {
      assert.strictEqual(
        generator.slugify('Task Phase 2: Implement Persistent artifacts/plans/ File Generation & Templates'),
        'task-phase-2-implement-persistent-artifacts-plans-file-generation-templates'
      );
      assert.strictEqual(generator.slugify('---hello---world---'), 'hello-world');
      assert.strictEqual(generator.slugify('Special @#$$% Characters!!!'), 'special-characters');
      assert.strictEqual(generator.slugify(''), '');
      assert.strictEqual(generator.slugify(null as unknown as string), '');
    });

    test('sanitizeFilename removes filesystem-unsafe characters', () => {
      assert.strictEqual(
        generator.sanitizeFilename('Feature: Phase 2 <Plan> *? "quoted" | test'),
        'Feature Phase 2 Plan quoted test'
      );
      assert.strictEqual(generator.sanitizeFilename('clean-title'), 'clean-title');
      assert.strictEqual(generator.sanitizeFilename(''), 'untitled');
      assert.strictEqual(generator.sanitizeFilename(null as unknown as string), 'untitled');
    });
  });

  describe('ensurePlanDirectory() & .gitignore Enforcement', () => {
    test('creates artifacts/plans directory and initializes .gitignore if absent', () => {
      const plansDir = generator.ensurePlanDirectory(tempDir);
      assert.ok(fs.existsSync(plansDir));
      assert.strictEqual(plansDir, path.join(tempDir, 'artifacts', 'plans'));

      const gitignorePath = path.join(tempDir, '.gitignore');
      assert.ok(fs.existsSync(gitignorePath));
      const content = fs.readFileSync(gitignorePath, 'utf8');
      assert.ok(content.includes('artifacts/plans/'));
    });

    test('appends to existing .gitignore without duplicating existing entry', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.DS_Store\n', 'utf8');

      generator.ensurePlanDirectory(tempDir);
      let content = fs.readFileSync(gitignorePath, 'utf8');
      assert.ok(content.includes('node_modules/'));
      assert.ok(content.includes('artifacts/plans/'));

      generator.ensurePlanDirectory(tempDir);
      content = fs.readFileSync(gitignorePath, 'utf8');
      const occurrences = (content.match(/artifacts\/plans\//g) || []).length;
      assert.strictEqual(occurrences, 1);
    });

    test('does not modify .gitignore if artifacts/plans is already ignored', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'artifacts/plans\n', 'utf8');

      generator.ensurePlanDirectory(tempDir);
      const content = fs.readFileSync(gitignorePath, 'utf8');
      assert.strictEqual(content, 'artifacts/plans\n');
    });
  });

  describe('loadTemplate() & renderTemplate()', () => {
    test('loads existing templates from repository templates directory', () => {
      const discovery = generator.loadTemplate(TEMPLATE_FILES.DISCOVERY);
      assert.ok(discovery.includes('# [Discovery] - {Title}'));
      assert.ok(discovery.includes('Root Cause Analysis (RCA)'));

      const impl = generator.loadTemplate(TEMPLATE_FILES.IMPLEMENTATION);
      assert.ok(impl.includes('# [Implementation] - {Title}'));
      assert.ok(impl.includes('Architectural Design & Impact'));

      const summary = generator.loadTemplate(TEMPLATE_FILES.SUMMARY);
      assert.ok(summary.includes('# AgyLoop Execution Summary'));
      assert.ok(summary.includes('Lifecycle Execution Log'));
    });

    test('falls back to embedded string if template file missing from custom directory', () => {
      const emptyDir = path.join(tempDir, 'empty_templates');
      fs.mkdirSync(emptyDir, { recursive: true });

      const content = generator.loadTemplate(TEMPLATE_FILES.DISCOVERY, emptyDir);
      assert.strictEqual(content, FALLBACK_TEMPLATES[TEMPLATE_FILES.DISCOVERY]);
    });

    test('throws error for unknown template name with no fallback', () => {
      assert.throws(
        () => generator.loadTemplate('unknown-template.md'),
        /Template not found: unknown-template\.md/
      );
    });

    test('renderTemplate replaces all declared placeholders and keeps unprovided ones intact', () => {
      const template = 'Hello {Name}, your issue is #{IssueNumber}. Date: {Date}. Extra: {UnknownVar}.';
      const variables = {
        Name: 'Developer',
        IssueNumber: 42,
        Date: '2026-09-10'
      };
      const rendered = generator.renderTemplate(template, variables);
      assert.strictEqual(
        rendered,
        'Hello Developer, your issue is #42. Date: 2026-09-10. Extra: {UnknownVar}.'
      );
    });
  });

  describe('detectPlanType()', () => {
    test('detects discovery type from bug labels or titles', () => {
      assert.strictEqual(generator.detectPlanType({ title: '[Bug] App crashes on startup' }), 'discovery');
      assert.strictEqual(generator.detectPlanType({ title: 'fix: memory leak in worker' }), 'discovery');
      assert.strictEqual(generator.detectPlanType({ title: 'RCA: Investigate latency spike' }), 'discovery');
      assert.strictEqual(generator.detectPlanType({ title: 'Standard task', labels: ['bug'] }), 'discovery');
      assert.strictEqual(generator.detectPlanType({ title: 'Standard task', labels: ['defect', 'urgent'] }), 'discovery');
    });

    test('defaults to implementation type for features and generic tasks', () => {
      assert.strictEqual(generator.detectPlanType({ title: '[Task] Implement Auth Module' }), 'implementation');
      assert.strictEqual(generator.detectPlanType({ title: 'feat: add dark mode support' }), 'implementation');
      assert.strictEqual(generator.detectPlanType({ title: 'Setup CI/CD pipeline', labels: ['enhancement'] }), 'implementation');
    });
  });

  describe('generatePlan()', () => {
    test('generates implementation plan and canonical mirror in target directory', () => {
      const result = generator.generatePlan({
        targetDir: tempDir,
        type: 'implementation',
        title: 'Add User Dashboard',
        issueNumber: 10,
        date: '2026-09-10'
      });

      assert.ok(result.created);
      assert.ok(fs.existsSync(result.planPath));
      assert.strictEqual(
        result.planPath,
        path.join(tempDir, '[Implementation] - Add User Dashboard.md')
      );

      assert.ok(result.mirrorPath);
      assert.ok(fs.existsSync(result.mirrorPath!));
      assert.strictEqual(result.mirrorPath, path.join(tempDir, 'implementation_plan.md'));

      const content = fs.readFileSync(result.planPath, 'utf8');
      assert.ok(content.includes('# [Implementation] - Add User Dashboard'));
      assert.ok(content.includes('**Issue:** #10'));
      assert.ok(content.includes('**Date:** 2026-09-10'));
    });

    test('generates discovery plan for defects', () => {
      const result = generator.generatePlan({
        targetDir: tempDir,
        type: 'discovery',
        title: 'Buffer Overflow Crash',
        issueNumber: 11
      });

      assert.ok(result.created);
      assert.ok(fs.existsSync(result.planPath));
      assert.strictEqual(
        result.planPath,
        path.join(tempDir, '[Discovery] - Buffer Overflow Crash.md')
      );

      const content = fs.readFileSync(result.planPath, 'utf8');
      assert.ok(content.includes('# [Discovery] - Buffer Overflow Crash'));
      assert.ok(content.includes('Root Cause Analysis (RCA)'));
    });

    test('does not overwrite existing plan file unless overwrite=true', () => {
      generator.generatePlan({
        targetDir: tempDir,
        type: 'implementation',
        title: 'Immutable Plan',
        variables: { Extra: 'First' }
      });

      const planPath = path.join(tempDir, '[Implementation] - Immutable Plan.md');
      fs.writeFileSync(planPath, '# Custom Content', 'utf8');

      const secondRun = generator.generatePlan({
        targetDir: tempDir,
        type: 'implementation',
        title: 'Immutable Plan',
        overwrite: false
      });

      assert.strictEqual(secondRun.created, false);
      assert.strictEqual(fs.readFileSync(planPath, 'utf8'), '# Custom Content');

      const overwriteRun = generator.generatePlan({
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
      const result = generator.generateSummaryLog({
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
      const summaryResult = generator.generateSummaryLog({
        targetDir: tempDir,
        projectName: 'TestApp',
        issueNumber: 12
      });

      const updated = generator.updateSummaryLog(summaryResult.summaryPath, {
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
      const scaffold = generator.scaffoldPlanDirectory({
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
      const foundDir = generator.findPlanDirectory(tempDir, 12);
      assert.strictEqual(foundDir, scaffold.planDir);
    });
  });

  describe('CLI Arguments & Integration', () => {
    test('parseArguments handles --title and --type options', () => {
      const parsed = parseArguments(['plan', '--title', 'My Custom Plan', '--type', 'discovery']);
      assert.strictEqual(parsed.command, 'plan');
      assert.strictEqual(parsed.options.title, 'My Custom Plan');
      assert.strictEqual(parsed.options.type, 'discovery');

      const parsedEq = parseArguments(['plan', '--title=Equal Title', '--type=implementation']);
      assert.strictEqual(parsedEq.options.title, 'Equal Title');
      assert.strictEqual(parsedEq.options.type, 'implementation');
    });

    test('parseArguments safely handles dangling flags without values', () => {
      const parsed = parseArguments(['plan', '--title', '--type']);
      assert.strictEqual(parsed.options.title, null);
      assert.strictEqual(parsed.options.type, null);
    });
  });
});
