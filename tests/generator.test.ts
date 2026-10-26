const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  FilePlanGenerator,
  parseArguments,
  TEMPLATE_FILES,
  FALLBACK_TEMPLATES,
  // Issue #259 (S7b): the placeholder status of a stage that has not run.
  // Imported, never re-typed, so the assertions cannot drift from the domain.
  SUMMARY_STATUS_PENDING
} = require('../dist');

/**
 * The on-disk scaffold template. The embedded fallback in
 * `FALLBACK_TEMPLATES` is a second, hand-maintained copy of this file — the
 * drift guard (`G4`) compares the two so they cannot diverge silently.
 */
const SUMMARY_TEMPLATE_PATH = path.resolve(__dirname, '..', 'templates', 'summary-log.md');

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

    test('updateSummaryLog matches and updates Quality Gate and Commit Gate table rows', () => {
      const summaryResult = generator.generateSummaryLog({
        targetDir: tempDir,
        projectName: 'TestApp',
        issueNumber: 50
      });

      // Update with stage queries matching TransitionStageUseCase mappings
      const updatedQuality = generator.updateSummaryLog(summaryResult.summaryPath, {
        stage: 'Quality Gates',
        subagent: 'gate',
        model: 'flash_lite',
        status: 'PASSED',
        duration: '45s'
      });
      assert.strictEqual(updatedQuality, true, 'Should find and update Quality Gate row');

      const updatedCommit = generator.updateSummaryLog(summaryResult.summaryPath, {
        stage: 'Commit / PR',
        subagent: 'Human Gate',
        model: '-',
        status: 'COMPLETED',
        duration: '1m 15s'
      });
      assert.strictEqual(updatedCommit, true, 'Should find and update Commit Gate row');

      const content = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(
        content.includes('| 4. Quality Gate | `gate` | `flash_lite` | PASSED | 45s |'),
        'Summary table should reflect updated Quality Gate row'
      );
      assert.ok(
        content.includes('| 6. Commit Gate | Human Gate | - | COMPLETED | 1m 15s |'),
        'Summary table should reflect updated Commit Gate row'
      );
    });

    test('updateSummaryLog targets the AI Review row, not Plan Review (issue #236, AC2/T8)', () => {
      const summaryResult = generator.generateSummaryLog({
        targetDir: tempDir,
        projectName: 'TestApp',
        issueNumber: 60
      });

      const original = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      // Issue #259 (S7b): the scaffolded placeholders are PENDING for every
      // stage that has not run — they no longer pre-claim APPROVED.
      assert.ok(original.includes('| 2. Plan Review | Human Gate | - | PENDING | - |'));
      assert.ok(original.includes('| 5. AI Review | `reviewer` | `flash` | PENDING | - |'));

      // 1. 'AI Review' must land on row 5 and leave row 2 untouched
      const updatedAi = generator.updateSummaryLog(summaryResult.summaryPath, {
        stage: 'AI Review',
        status: 'SKIPPED',
        duration: '0.1s',
        reviewNote: 'Review skipped: no reviewer output or critique report.'
      });
      assert.strictEqual(updatedAi, true, 'Should find and update the AI Review row');

      const afterAi = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(
        afterAi.includes('| 5. AI Review | `reviewer` | `flash` | SKIPPED | 0.1s |'),
        `AI Review row should be SKIPPED, got:\n${afterAi}`
      );
      assert.ok(
        afterAi.includes('| 2. Plan Review | Human Gate | - | PENDING | - |'),
        'Plan Review row must keep its original status'
      );
      assert.ok(afterAi.includes('- Review skipped: no reviewer output or critique report.'));

      // 2. Regression companion: 'Plan Review' still maps to row 2 (two-pass precedence)
      const updatedPlan = generator.updateSummaryLog(summaryResult.summaryPath, {
        stage: 'Plan Review',
        status: 'COMPLETED',
        duration: '3s'
      });
      assert.strictEqual(updatedPlan, true, 'Should find and update the Plan Review row');

      const afterPlan = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(
        afterPlan.includes('| 2. Plan Review | Human Gate | - | COMPLETED | 3s |'),
        'Plan Review row should be COMPLETED'
      );
      assert.ok(
        afterPlan.includes('| 5. AI Review | `reviewer` | `flash` | SKIPPED | 0.1s |'),
        'AI Review row must keep the SKIPPED status written earlier'
      );
    });

    // ------------------------------------------------------------------
    // Issue #259 (S7b, AC4b): the scaffolded execution summary must not
    // pre-claim green rows for stages that have not run.
    // ------------------------------------------------------------------

    /** The rows of the scaffolded summary, keyed by their stage label. */
    function stageRows(content: string): Map<string, string> {
      const rows = new Map<string, string>();
      for (const line of content.split('\n')) {
        if (!line.startsWith('|') || line.includes('---') || line.includes('Stage | Subagent')) {
          continue;
        }
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length >= 6) {
          rows.set(parts[1], line);
        }
      }
      return rows;
    }

    /**
     * The STATUS CELL of every lifecycle row, keyed by the stage label.
     *
     * The comparison is deliberately on the cell and never on raw bytes: the
     * on-disk template carries trailing double-spaces for markdown hard line
     * breaks, and the embedded fallback must not be sensitive to that.
     */
    function rowStatusCells(content: string): Map<string, string> {
      const statuses = new Map<string, string>();
      for (const line of content.split('\n')) {
        if (!line.startsWith('|') || line.includes('---') || line.includes('Stage | Subagent')) {
          continue;
        }
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length >= 6) {
          statuses.set(parts[1], parts[4]);
        }
      }
      return statuses;
    }

    /**
     * EVERY lifecycle row, keyed by the stage label, with the trimmed CELLS of
     * the row (stage, subagent, model, status, duration).
     *
     * The comparison is on the cells and never on raw bytes: the on-disk
     * template carries trailing double-spaces for markdown hard line breaks,
     * and the embedded fallback must not be sensitive to that.
     */
    function lifecycleRows(content: string): Map<string, string[]> {
      const rows = new Map<string, string[]>();
      for (const line of content.split('\n')) {
        if (!line.startsWith('|') || line.includes('---')) {
          continue;
        }
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 6 || parts[1] === 'Stage') {
          continue;
        }
        rows.set(parts[1], parts.slice(1, 6));
      }
      return rows;
    }

    /**
     * The body lines of the `## Review Notes` block.
     */
    function reviewNotesBody(content: string): string[] {
      const lines = content.split('\n');
      const start = lines.findIndex((l) => l.trim() === '## Review Notes');
      assert.ok(start >= 0, `the content must carry a Review Notes block, got:\n${content}`);
      const body: string[] = [];
      for (const line of lines.slice(start + 1)) {
        if (line.trimStart().startsWith('## ')) break;
        const trimmed = line.trim();
        if (trimmed.length > 0) body.push(trimmed);
      }
      return body;
    }

    /**
     * The `**Key:** value` pairs of the `## Quality Gate Metrics` block,
     * keyed by the metric name.
     */
    function metricsPairs(content: string): Map<string, string> {
      const pairs = new Map<string, string>();
      const lines = content.split('\n');
      const start = lines.findIndex((l) => l.trim() === '## Quality Gate Metrics');
      assert.ok(start >= 0, `the content must carry a Quality Gate Metrics block, got:\n${content}`);
      for (const line of lines.slice(start + 1)) {
        if (line.trimStart().startsWith('## ')) break;
        const match = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
        if (match) {
          pairs.set(match[1].trim(), match[2].trim());
        }
      }
      return pairs;
    }

    test('G1 (AC4b): a freshly scaffolded CodeLoop Summary.md shows PENDING for every stage that has not run and never asserts COMPLETED / PASSED / APPROVED', () => {
      const summaryResult = generator.generateSummaryLog({
        targetDir: tempDir,
        projectName: 'TestApp',
        issueNumber: 70
      });

      const content = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      const rows = stageRows(content);

      // Every stage that has not run is PENDING.
      const notRunStages = [
        '2. Plan Review',
        '3. Implementation',
        '4. Quality Gate',
        '5. AI Review',
        '6. Commit Gate'
      ];
      for (const stage of notRunStages) {
        const row = rows.get(stage) ?? '';
        assert.ok(row, `the summary must carry the '${stage}' row, got:\n${content}`);
        assert.ok(
          row.includes(`| ${SUMMARY_STATUS_PENDING} |`),
          `the '${stage}' row must be ${SUMMARY_STATUS_PENDING}, got: ${row}`
        );
      }

      // The metrics of the stages that have not run are honest too.
      assert.ok(
        content.includes(`- **Build Status:** ${SUMMARY_STATUS_PENDING}`),
        `the build status must not pre-claim a verdict, got:\n${content}`
      );
      assert.ok(
        content.includes('- **Tests:** -'),
        `the tests metric must not pre-claim a result, got:\n${content}`
      );

      // No stage may pre-claim a green outcome.
      assert.ok(
        !content.includes('APPROVED'),
        `a scaffolded summary must not claim an approval, got:\n${content}`
      );
      assert.ok(
        !content.includes('PASSED'),
        `a scaffolded summary must not claim a pass, got:\n${content}`
      );
      for (const stage of notRunStages) {
        assert.ok(
          !String(rows.get(stage)).includes('COMPLETED'),
          `the '${stage}' row must not claim the stage ran, got: ${rows.get(stage)}`
        );
      }
    });

    test('G2 (AC4b): updateSummaryLog still overwrites a PENDING row with the real status (the PENDING placeholder does not break the existing rewrite path)', () => {
      const summaryResult = generator.generateSummaryLog({
        targetDir: tempDir,
        projectName: 'TestApp',
        issueNumber: 71
      });

      const before = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(
        before.includes('| 4. Quality Gate | `gate` | `flash_lite` | PENDING | - |'),
        `the Quality Gate row must start as PENDING, got:\n${before}`
      );

      const updated = generator.updateSummaryLog(summaryResult.summaryPath, {
        stage: 'Quality Gates',
        subagent: 'gate',
        model: 'flash_lite',
        status: 'PASSED',
        duration: '12s',
        buildStatus: 'PASSED',
        testsStatus: '10/10 passing'
      });
      assert.strictEqual(updated, true, 'the PENDING row must still be rewritten');

      const after = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(
        after.includes('| 4. Quality Gate | `gate` | `flash_lite` | PASSED | 12s |'),
        `the real status must replace the placeholder, got:\n${after}`
      );
      assert.ok(
        !after.includes('| 4. Quality Gate | `gate` | `flash_lite` | PENDING | - |'),
        `the placeholder must be gone, got:\n${after}`
      );
      assert.ok(after.includes('- **Build Status:** PASSED'));
      assert.ok(after.includes('- **Tests:** 10/10 passing'));
    });

    test('G3 (AC4b, regression): the pre-update placeholder rows are PENDING and the post-update assertions still hold', () => {
      const summaryResult = generator.generateSummaryLog({
        targetDir: tempDir,
        projectName: 'TestApp',
        issueNumber: 72
      });

      // The two placeholders that the scaffold used to fill with APPROVED.
      const original = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(
        original.includes('| 2. Plan Review | Human Gate | - | PENDING | - |'),
        `the Plan Review placeholder must be PENDING, got:\n${original}`
      );
      assert.ok(
        original.includes('| 5. AI Review | `reviewer` | `flash` | PENDING | - |'),
        `the AI Review placeholder must be PENDING, got:\n${original}`
      );

      // The post-update assertion: the row the tool wrote carries its own value.
      const updatedAi = generator.updateSummaryLog(summaryResult.summaryPath, {
        stage: 'AI Review',
        status: 'SKIPPED',
        duration: '0.1s'
      });
      assert.strictEqual(updatedAi, true, 'Should find and update the AI Review row');

      const afterAi = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(
        afterAi.includes('| 5. AI Review | `reviewer` | `flash` | SKIPPED | 0.1s |'),
        `AI Review row should be SKIPPED, got:\n${afterAi}`
      );
      assert.ok(
        afterAi.includes('| 2. Plan Review | Human Gate | - | PENDING | - |'),
        'Plan Review row must keep its original status'
      );

      // The second post-update assertion: the Plan Review row keeps its value.
      const updatedPlan = generator.updateSummaryLog(summaryResult.summaryPath, {
        stage: 'Plan Review',
        status: 'COMPLETED',
        duration: '3s'
      });
      assert.strictEqual(updatedPlan, true, 'Should find and update the Plan Review row');

      const afterPlan = fs.readFileSync(summaryResult.summaryPath, 'utf8');
      assert.ok(
        afterPlan.includes('| 2. Plan Review | Human Gate | - | COMPLETED | 3s |'),
        'Plan Review row should be COMPLETED'
      );
      assert.ok(
        afterPlan.includes('| 5. AI Review | `reviewer` | `flash` | SKIPPED | 0.1s |'),
        'AI Review row must keep the SKIPPED status written earlier'
      );
    });

    test('G4 (AC4b, regression): the embedded SUMMARY fallback agrees with templates/summary-log.md on EVERY lifecycle row, every metric and the review notes — and never pre-claims a green stage', () => {
      // The two copies of the scaffold — the on-disk template and the embedded
      // fallback used when the template file cannot be read — are maintained by
      // hand, so nothing but this guard keeps them in step. Before the guard,
      // the fallback still carried the pre-S7b false claims (COMPLETED /
      // PASSED / APPROVED) while the on-disk template did not.
      const fallback = FALLBACK_TEMPLATES[TEMPLATE_FILES.SUMMARY];
      const onDisk = fs.readFileSync(SUMMARY_TEMPLATE_PATH, 'utf8');

      const fallbackStatuses = rowStatusCells(fallback);
      const onDiskStatuses = rowStatusCells(onDisk);

      const notRunStages = [
        '2. Plan Review',
        '3. Implementation',
        '4. Quality Gate',
        '5. AI Review',
        '6. Commit Gate'
      ];

      for (const stage of notRunStages) {
        const fallbackStatus = fallbackStatuses.get(stage);
        const onDiskStatus = onDiskStatuses.get(stage);
        assert.ok(fallbackStatus, `the fallback must carry the '${stage}' row, got:\n${fallback}`);
        assert.ok(
          onDiskStatus,
          `templates/summary-log.md must carry the '${stage}' row, got:\n${onDisk}`
        );
        assert.strictEqual(
          fallbackStatus,
          SUMMARY_STATUS_PENDING,
          `the fallback's '${stage}' row must be ${SUMMARY_STATUS_PENDING}, got: ${fallbackStatus}`
        );
        assert.strictEqual(
          onDiskStatus,
          SUMMARY_STATUS_PENDING,
          `templates/summary-log.md's '${stage}' row must be ${SUMMARY_STATUS_PENDING}, got: ${onDiskStatus}`
        );
        assert.strictEqual(
          fallbackStatus,
          onDiskStatus,
          `the fallback and templates/summary-log.md disagree on the '${stage}' status`
        );
      }

      // EVERY lifecycle row — 1 to 6, and every CELL of it (subagent, model,
      // status, duration) — must agree, not just the status cell of rows 2-6.
      // A divergence in row 1 or in a non-status column is a drift too.
      const fallbackRows = lifecycleRows(fallback);
      const onDiskRows = lifecycleRows(onDisk);
      const allStages = [
        '1. Discovery',
        '2. Plan Review',
        '3. Implementation',
        '4. Quality Gate',
        '5. AI Review',
        '6. Commit Gate'
      ];

      assert.deepStrictEqual(
        [...fallbackRows.keys()],
        allStages,
        `the fallback must carry exactly the six lifecycle rows, got:\n${fallback}`
      );
      assert.deepStrictEqual(
        [...onDiskRows.keys()],
        allStages,
        `templates/summary-log.md must carry exactly the six lifecycle rows, got:\n${onDisk}`
      );

      for (const stage of allStages) {
        assert.deepStrictEqual(
          fallbackRows.get(stage),
          onDiskRows.get(stage),
          `the fallback and templates/summary-log.md disagree on the '${stage}' row`
        );
      }

      // The metrics block agrees too — and claims no verdict.
      const fallbackMetrics = metricsPairs(fallback);
      const onDiskMetrics = metricsPairs(onDisk);
      assert.deepStrictEqual(
        [...fallbackMetrics.entries()].sort(),
        [...onDiskMetrics.entries()].sort(),
        'the fallback and templates/summary-log.md must carry the same metrics'
      );
      assert.strictEqual(fallbackMetrics.get('Build Status'), SUMMARY_STATUS_PENDING);
      assert.strictEqual(fallbackMetrics.get('Tests'), '-');

      // The review notes agree too.
      assert.deepStrictEqual(
        reviewNotesBody(fallback),
        reviewNotesBody(onDisk),
        'the fallback and templates/summary-log.md must carry the same review notes'
      );

      // The fallback carries no false claim of its own.
      assert.ok(
        !fallback.includes('| PASSED |'),
        `the fallback must not claim a pass, got:\n${fallback}`
      );
      assert.ok(
        !fallback.includes('| APPROVED |'),
        `the fallback must not claim an approval, got:\n${fallback}`
      );
      assert.ok(
        !fallback.includes('100% passing'),
        `the fallback must not claim a test result, got:\n${fallback}`
      );
      assert.ok(
        !fallback.includes('Build Status:** PASSED'),
        `the fallback must not claim a build verdict, got:\n${fallback}`
      );
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

    test('findPlanDirectory is deterministic (lexicographic, never mtime) when candidates are empty', () => {
      // Issue #283: mtime ordering made the resolver filesystem-order-dependent
      // (#108). Two pristine candidates must resolve by folder name, always.
      const plansDir = path.join(tempDir, 'artifacts', 'plans');
      const dirA = path.join(plansDir, '42-apple-first');
      const dirB = path.join(plansDir, '42-zebra-last');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      // Invert the mtimes: the answer must NOT follow them.
      const pastTime = new Date(Date.now() - 60000);
      const futureTime = new Date(Date.now() + 60000);
      fs.utimesSync(dirA, pastTime, pastTime);
      fs.utimesSync(dirB, futureTime, futureTime);

      assert.strictEqual(generator.findPlanDirectory(tempDir, 42), dirA);

      fs.utimesSync(dirA, futureTime, futureTime);
      fs.utimesSync(dirB, pastTime, pastTime);
      assert.strictEqual(generator.findPlanDirectory(tempDir, 42), dirA);
    });

    test('findPlanDirectory prefers a populated discovery report over an exact slug match', () => {
      const plansDir = path.join(tempDir, 'artifacts', 'plans');
      const dirEmpty = path.join(plansDir, '55-feature-alpha');
      const dirPopulated = path.join(plansDir, '55-feature-beta');
      fs.mkdirSync(dirEmpty, { recursive: true });
      fs.mkdirSync(dirPopulated, { recursive: true });
      fs.writeFileSync(
        path.join(dirPopulated, '[Discovery] - Beta.md'),
        [
          '# [Discovery] - Beta',
          '',
          '## 1. Problem Statement & Symptoms',
          '- **Observed Behavior:** the resolver picked the empty directory',
          '- **Expected Behavior:** the populated report wins',
          '- **Affected Components / Paths:** src/infrastructure/file-plan-generator.ts',
          '',
          '## 2. Root Cause Analysis (RCA)',
          '- **Investigation Steps:** reproduced with two sibling directories',
          '- **Identified Failure Mode:** mtime ordering',
          '- **Relevant Code References:** findPlanDirectory',
          '',
          '## 3. Reproduction Steps & Verification Protocol',
          '- **Local Reproduction Command:** node --test tests/generator.test.ts',
          '- **Failing Test Target:** tests/generator.test.ts',
          '',
          '## 4. Remediation Strategy',
          '- **Recommended Fix Approach:** rank populated candidates first',
          '- **Potential Regressions / Side Effects:** none'
        ].join('\n'),
        'utf8'
      );

      // The title matches the EMPTY directory's slug, but the populated one wins.
      assert.strictEqual(generator.findPlanDirectory(tempDir, 55, 'Feature Alpha'), dirPopulated);
      assert.strictEqual(generator.findPlanDirectory(tempDir, 55), dirPopulated);
    });

    test('findPlanDirectory prefers exact slug match when no candidate is populated', () => {
      const plansDir = path.join(tempDir, 'artifacts', 'plans');
      const dirA = path.join(plansDir, '55-feature-alpha');
      const dirB = path.join(plansDir, '55-feature-beta');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      assert.strictEqual(generator.findPlanDirectory(tempDir, 55, 'Feature Beta'), dirB);
      // Without a title the deterministic lexicographic order applies.
      assert.strictEqual(generator.findPlanDirectory(tempDir, 55), dirA);
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

// ============================================================================
// Plan artifact resolution & mirror content (issues #283, #299, #240/Defect 5)
// ============================================================================

describe('Plan artifact resolution & mirror content (#283, #299, #240/5)', () => {
  let tempDir: string;
  let generator: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-artifacts-test-'));
    generator = new FilePlanGenerator();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A discovery report that `DiscoveryReport.isPopulated` accepts. */
  function populatedReport(title: string): string {
    return [
      `# [Discovery] - ${title}`,
      '',
      '## 1. Problem Statement & Symptoms',
      '- **Observed Behavior:** the scaffold created a second directory',
      '- **Expected Behavior:** one directory per issue',
      '- **Affected Components / Paths:** src/infrastructure/file-plan-generator.ts',
      '',
      '## 2. Root Cause Analysis (RCA)',
      '- **Investigation Steps:** reproduced with `transition DISCOVERY` then `plan`',
      '- **Identified Failure Mode:** the slug was re-derived',
      '- **Relevant Code References:** scaffoldPlanDirectory',
      '',
      '## 3. Reproduction Steps & Verification Protocol',
      '- **Local Reproduction Command:** node --test tests/generator.test.ts',
      '- **Failing Test Target:** tests/generator.test.ts',
      '',
      '## 4. Remediation Strategy',
      '- **Recommended Fix Approach:** shared slug plus populated-first adoption',
      '- **Potential Regressions / Side Effects:** none'
    ].join('\n');
  }

  test('T-299.1/T-299.4/T-299.6: a discovery scaffold writes the implementation mirror', () => {
    const scaffold = generator.scaffoldPlanDirectory({
      projectRoot: tempDir,
      issue: 901,
      title: '[Bug] Some lifecycle bug',
      type: 'discovery'
    });

    const primary = fs.readFileSync(scaffold.planPath, 'utf8');
    const mirror = fs.readFileSync(scaffold.mirrorPath, 'utf8');

    assert.ok(primary.startsWith('# [Discovery] - '), primary.split('\n')[0]);
    assert.ok(mirror.startsWith('# [Implementation] - '), mirror.split('\n')[0]);
    assert.ok(!mirror.includes('Root Cause Analysis'), 'the mirror must not be the RCA template');
    assert.notStrictEqual(primary, mirror, 'the two artifacts must not be byte-identical');
    assert.ok(fs.existsSync(scaffold.planPath));
    assert.ok(fs.existsSync(scaffold.mirrorPath));
  });

  test('T-299.5: a bug-labelled scaffold resolves PLAN to the implementation document', () => {
    const scaffold = generator.scaffoldPlanDirectory({
      projectRoot: tempDir,
      issue: 902,
      title: 'Fix: login crash',
      labels: ['bug']
    });

    const mirror = fs.readFileSync(path.join(scaffold.planDir, 'implementation_plan.md'), 'utf8');
    assert.ok(!/Root Cause Analysis/.test(mirror), 'implementation_plan.md must not carry RCA headings');

    for (const stage of ['PLAN', 'QUALITY_GATE', 'REVIEW', 'COMMIT']) {
      const resolved = generator.resolvePlanFile({ projectRoot: tempDir, planDir: scaffold.planDir, stage });
      assert.ok(resolved, `${stage} must resolve a plan`);
      assert.strictEqual(resolved.planPath, path.join(scaffold.planDir, 'implementation_plan.md'));
    }
  });

  test('T-283.5/T-240.D5: a re-entry adopts the existing directory and never duplicates it', () => {
    const first = generator.scaffoldPlanDirectory({
      projectRoot: tempDir,
      issue: 903,
      title: "[Bug] The base's own new commits",
      type: 'discovery'
    });
    assert.strictEqual(first.directoryCreated, true, 'the first run creates the directory');

    // The discovery subagent populated the report.
    fs.writeFileSync(first.planPath, populatedReport("The base's own new commits"), 'utf8');

    const second = generator.scaffoldPlanDirectory({
      projectRoot: tempDir,
      issue: 903,
      // A DIFFERENT title would derive a different slug; the populated
      // directory must still win.
      title: 'A completely different title',
      type: 'discovery'
    });

    const dirs = fs
      .readdirSync(path.join(tempDir, 'artifacts', 'plans'), { withFileTypes: true })
      .filter((entry: any) => entry.isDirectory())
      .map((entry: any) => entry.name);
    assert.strictEqual(dirs.length, 1, `exactly one directory, got ${dirs.join(', ')}`);
    assert.strictEqual(second.planDir, first.planDir);
    assert.strictEqual(second.adoptedExisting, true);
    assert.strictEqual(second.directoryCreated, false);
    assert.strictEqual(second.planPath, first.planPath, 'the populated primary is reused untouched');
    assert.ok(fs.readFileSync(second.planPath, 'utf8').includes('created a second directory'));
  });
});
