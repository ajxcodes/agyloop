/**
 * agyloop - Plan Content Predicate Unit Tests (issue #259, Q1-Q3)
 *
 * Contract of the ONE shared plan-substance predicate:
 * `isPlanContentSubstantive(planContent)`.
 *
 * Why it exists: `codeloop yolo` never dispatches the PLANNER either, so the
 * fast-path's plan is the tool's own blank scaffold — every heading empty,
 * every `**Step N:**` marker without a value. An implementer directive that
 * points at that document is a false instruction, so the park must recognise
 * it and say so.
 *
 * The rule is FAIL-SAFE: every line shape the predicate does not recognise
 * counts as content, so it can only ever fire on the blank scaffold. Q3 pins
 * that direction — a false refusal (parking a run that had a real plan) is
 * impossible for a plan that carries content.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isPlanContentSubstantive } = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'templates', 'implementation-plan.md');

/**
 * Renders a template exactly the way `FilePlanGenerator.renderTemplate` does,
 * so the fixture under test is the scaffold the tool really writes.
 */
function renderTemplate(content: string, variables: Record<string, unknown>): string {
  return content.replace(/\{([A-Za-z0-9_]+)\}/g, (match: string, key: string) => {
    if (
      Object.prototype.hasOwnProperty.call(variables, key) &&
      variables[key] !== null &&
      variables[key] !== undefined
    ) {
      return String(variables[key]);
    }
    return match;
  });
}

/** The tool's own blank scaffold, rendered from the real template. */
function scaffoldedPlan(): string {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return renderTemplate(raw, {
    Title: 'repro task',
    IssueNumber: 'adhoc',
    Date: '2026-10-19'
  });
}

describe('Plan Content Predicate (issue #259)', () => {
  describe('Q1: a freshly scaffolded plan (every heading blank, every "**Step N:**" empty) is NOT substantive', () => {
    test('Q1: a freshly scaffolded plan (every heading blank, every "**Step N:**" empty) is NOT substantive', () => {
      // The REAL scaffold the tool writes (templates/implementation-plan.md,
      // rendered with the tool's own substitutions).
      const scaffold = scaffoldedPlan();
      assert.ok(scaffold.includes('**Step 1:**'), 'the fixture must be the real scaffold');
      assert.strictEqual(
        isPlanContentSubstantive(scaffold),
        false,
        `the tool's own blank scaffold must be recognised as empty, got:\n${scaffold}`
      );

      // The literal shape, spelled out — so the predicate's contract does not
      // depend on the template file.
      const literalScaffold = [
        '# [Implementation] - repro task',
        '',
        '**Issue:** #adhoc  ',
        '**Date:** 2026-10-19  ',
        '**Author:** AgyLoop Planning Subagent  ',
        '**Status:** DRAFT | APPROVED  ',
        '',
        '---',
        '',
        '## 1. Context & Objectives',
        '- **Feature Overview:**',
        '- **Acceptance Criteria:**',
        '',
        '## 2. Architectural Design & Impact',
        '- **Component Breakdown:**',
        '- **Data Flow / Model Invariants:**',
        '- **Dependencies & Imports:**',
        '',
        '## 3. Implementation Steps',
        '- [ ] **Step 1:** ',
        '- [ ] **Step 2:** ',
        '- [ ] **Step 3:** ',
        '',
        '## 4. Quality Gate & Test Verification',
        '- **Automated Test Targets:**',
        '- **Build / Lint Commands:**',
        '- **Manual Verification Steps:**'
      ].join('\n');

      assert.strictEqual(
        isPlanContentSubstantive(literalScaffold),
        false,
        'the blank scaffold must be recognised as empty'
      );

      // No plan document at all is the strongest form of "empty plan".
      assert.strictEqual(isPlanContentSubstantive(''), false);
      assert.strictEqual(isPlanContentSubstantive('   \n\n  \n'), false);
    });
  });

  describe('Q2: a plan with at least one populated step IS substantive', () => {
    test('Q2: a plan with at least one populated step IS substantive', () => {
      const populatedStep = [
        '# [Implementation] - repro task',
        '',
        '## 3. Implementation Steps',
        '- [ ] **Step 1:** Edit `src-target.js` so `answer()` returns 7.',
        '- [ ] **Step 2:** ',
        ''
      ].join('\n');

      assert.strictEqual(
        isPlanContentSubstantive(populatedStep),
        true,
        'a single populated step makes the plan substantive'
      );

      // A populated labelled bullet is content too.
      const populatedBullet = [
        '## 1. Context & Objectives',
        '- **Feature Overview:** Change `answer()` to return 7 instead of 42.',
        ''
      ].join('\n');

      assert.strictEqual(
        isPlanContentSubstantive(populatedBullet),
        true,
        'a populated labelled bullet makes the plan substantive'
      );
    });
  });

  describe('Q4: a whole-line HTML comment is a hint, not content (#402)', () => {
    test('Q4: headings/separators plus whole-line comments stay non-substantive; prose after a comment is substantive', () => {
      const commentsOnly = [
        '# [Implementation] - hint only',
        '',
        '---',
        '',
        '## 4. Quality Gate & Test Verification',
        '',
        '### Baseline Evidence',
        '',
        '<!-- Baseline claim shape: `Declared:` must be the command\'s literal stdout. -->',
        '',
        '#### <claim-id>',
        '',
        '- **Declared:**',
        '- **Command:**',
        '- **Output:**',
        ''
      ].join('\n');
      assert.strictEqual(
        isPlanContentSubstantive(commentsOnly),
        false,
        'a whole-line HTML comment is a structural hint, never executable content'
      );

      const commentThenProse = [
        '### Baseline Evidence',
        '<!-- Baseline claim shape: copy the stdout. -->',
        'The measured folder count is 2.',
        ''
      ].join('\n');
      assert.strictEqual(
        isPlanContentSubstantive(commentThenProse),
        true,
        'prose after a comment is still content'
      );

      // A comment with trailing text on the same line is not a whole-line
      // comment, so it stays a body line (fail-safe).
      assert.strictEqual(
        isPlanContentSubstantive('<!-- hint --> trailing prose'),
        true
      );
    });
  });

  describe('Q3 (fail-safe): a plan written in ANY other shape IS substantive', () => {
    test('Q3 (fail-safe): a plan written in ANY other shape IS substantive', () => {
      // Headings + prose.
      const prose = [
        '# Implementation Plan — repro-task',
        '',
        '## Objective',
        'Change `answer()` in `src-target.js` to return `7` instead of `42`.',
        ''
      ].join('\n');
      assert.strictEqual(isPlanContentSubstantive(prose), true, 'prose is content');

      // A table.
      const table = [
        '| Step | File |',
        '| --- | --- |',
        '| 1 | `src-target.js` |',
        ''
      ].join('\n');
      assert.strictEqual(isPlanContentSubstantive(table), true, 'a table is content');

      // A numbered list.
      const numbered = ['## Steps', '1. Edit the file', '2. Update the test', ''].join('\n');
      assert.strictEqual(isPlanContentSubstantive(numbered), true, 'a numbered list is content');

      // A plain bullet list.
      const plainBullets = ['## Steps', '- Edit the file', '- Update the test', ''].join('\n');
      assert.strictEqual(isPlanContentSubstantive(plainBullets), true, 'a plain bullet list is content');

      // The documented corner case: a document with nothing but headings and
      // separators carries no executable content, so it is NOT substantive.
      const headingsOnly = [
        '# Implementation Plan',
        '',
        '---',
        '',
        '## 1. Context & Objectives',
        '',
        '## 2. Implementation Steps',
        ''
      ].join('\n');
      assert.strictEqual(
        isPlanContentSubstantive(headingsOnly),
        false,
        'a document with nothing but headings and separators carries no content'
      );

      // A written plan — headings, prose, a table and a populated step — is
      // never mistaken for the blank scaffold.
      const writtenPlan = [
        '# [Implementation] - repro-task',
        '',
        '**Issue:** #259  ',
        '**Status:** APPROVED  ',
        '',
        '## 1. Context & Objectives',
        'The fast-path reaches the COMMIT gate with an empty diff.',
        '',
        '| Step | File |',
        '| --- | --- |',
        '| S1 | `src/application/run-lifecycle.ts` |',
        '',
        '## 3. Implementation Steps',
        '- [ ] **Step 1:** Add the implementation-evidence probe.',
        ''
      ].join('\n');
      assert.strictEqual(
        isPlanContentSubstantive(writtenPlan),
        true,
        'a written plan must never be mistaken for the blank scaffold'
      );
    });
  });
});
