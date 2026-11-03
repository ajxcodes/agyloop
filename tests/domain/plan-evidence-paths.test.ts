/**
 * agyloop - Plan evidence paths (issue #432, TR-34)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  lintPlanEvidencePaths,
  extractPlanTargetPaths,
  extractOutOfScopeDeclarations,
  isOutsideWorkspace
} = require('../../dist/domain');

const ROOT = '/repo';

function plan(body: string[]): string {
  return body.join('\n');
}

describe('Plan evidence paths (issue #432)', () => {
  test('PEP1 ignores path-like prose outside the AC section', () => {
    const text = plan([
      '# Plan',
      '',
      '## 1. Context & Objectives',
      'The historical row lives at `artifacts/plans/425/implementation_plan.md`.',
      '',
      '## 2. Design',
      'This prose names node_modules/foo but is not an instruction.'
    ]);
    assert.deepStrictEqual(lintPlanEvidencePaths(text, ROOT), []);
  });

  test('PEP2 extractPlanTargetPaths tags the AC and the checklist', () => {
    const text = plan([
      '## 1. Context & Objectives',
      '- **Acceptance Criteria:**',
      '- AC1: correct `artifacts/plans/425/implementation_plan.md:162`',
      '',
      '## 3. Implementation Steps',
      '- [ ] **Step 1:** edit `src/domain/x.ts`',
      '- [ ] **Step 2:** edit `artifacts/plans/425/implementation_plan.md`'
    ]);
    const findings = extractPlanTargetPaths(text);
    assert.deepStrictEqual(
      findings.map((finding: any) => ({ path: finding.path, target: finding.target })),
      [
        { path: 'artifacts/plans/425/implementation_plan.md', target: 'acceptance criteria' },
        { path: 'src/domain/x.ts', target: 'implementation checklist' },
        { path: 'artifacts/plans/425/implementation_plan.md', target: 'implementation checklist' }
      ]
    );
  });

  test('PEP3 fences are not plan text; out-of-scope declarations are extractable', () => {
    const text = plan([
      '## 1. Context & Objectives',
      '- **Acceptance Criteria:**',
      '- AC1: the correction is delivered as a tracked doc',
      '- **Out of Scope:** the #425 historical row is not edited (it is gitignored)',
      '',
      '### Manual Smoke Test Protocol',
      '```bash',
      '- [ ] edit `artifacts/plans/425/implementation_plan.md`',
      '```'
    ]);
    assert.deepStrictEqual(lintPlanEvidencePaths(text, ROOT), []);
    assert.deepStrictEqual([...extractOutOfScopeDeclarations(text)], [
      'the #425 historical row is not edited (it is gitignored)'
    ]);
  });

  test('PEP4 an absolute path outside the workspace is outside', () => {
    assert.strictEqual(isOutsideWorkspace('/elsewhere/file.ts', ROOT), true);
    assert.strictEqual(isOutsideWorkspace(`${ROOT}/src/x.ts`, ROOT), false);
    assert.strictEqual(isOutsideWorkspace('../sibling/file.ts', ROOT), true);
  });

  test('PEP5 a wrapped out-of-scope bullet joins its continuation lines (issue #439)', () => {
    const text = [
      '- **Out of Scope:** Requiring a row per criterion. Label matching is free-form prose, so',
      '  coverage checking would create false refusals; this issue asks only that the block parse.'
    ].join('\n');
    const declarations = extractOutOfScopeDeclarations(text);
    assert.strictEqual(declarations.length, 1);
    assert.strictEqual(declarations[0], 'Requiring a row per criterion. Label matching is free-form prose, so coverage checking would create false refusals; this issue asks only that the block parse.');
  });

  test('PEP6 a following out-of-scope bullet stays a separate declaration (issue #439)', () => {
    const text = [
      '- **Out of Scope:** the first declaration',
      '- **Out of Scope:** the second declaration'
    ].join('\n');
    assert.deepStrictEqual([...extractOutOfScopeDeclarations(text)], ['the first declaration', 'the second declaration']);
  });

  test('PEP8 a required module specifier is not a delivery target', () => {
    const text = plan([
      '## 3. Implementation Checklist',
      '- [ ] **Step 1:** Require `../../dist/application` from `tests/legacy.test.ts` so the use case is exercised.'
    ]);
    assert.deepStrictEqual(lintPlanEvidencePaths(text, ROOT), []);
  });

  test('PEP9 a write verb on an escaping or excluded path is still a delivery target', () => {
    const text = plan([
      '## 3. Implementation Checklist',
      '- [ ] **Step 1:** Correct `../../dist/application` so the module specifier is corrected.',
      '- [ ] **Step 2:** Update `artifacts/plans/436-task-plan/implementation_plan.md` with the row.'
    ]);
    const findings = lintPlanEvidencePaths(text, ROOT);
    assert.deepStrictEqual(findings.map((finding: any) => finding.path), [
      '../../dist/application',
      'artifacts/plans/436-task-plan/implementation_plan.md'
    ]);
  });

  test('PEP10 an excluded-tree module specifier is still refused', () => {
    const text = plan([
      '## 3. Implementation Checklist',
      '- [ ] **Step 1:** Require `node_modules/left-pad/index.js` from `src/x.ts`.'
    ]);
    const findings = lintPlanEvidencePaths(text, ROOT);
    assert.deepStrictEqual(findings.map((finding: any) => finding.path), [
      'node_modules/left-pad/index.js'
    ]);
  });

  test('PEP11 a requiring gerund is module context', () => {
    const text = plan([
      '## 3. Implementation Checklist',
      '- [ ] **Step 1:** Update `tests/x.ts`, requiring `../../dist/y` so the module is exercised.'
    ]);
    assert.deepStrictEqual(lintPlanEvidencePaths(text, ROOT), []);
  });

  test('PEP7 blank lines, headings, fences and rules end a declaration (issue #439)', () => {
    const text = [
      '- **Out of Scope:** joined across',
      '  a wrapped line',
      '',
      '- **Out of Scope:** stopped by a heading',
      '### Manual Smoke Test Protocol',
      'prose that must not join',
      '- **Out of Scope:**',
      '  an empty marker still joins its continuation',
      '---',
      'prose after the rule must not join',
      '```bash',
      '- **Out of Scope:** fenced text is not plan text',
      '```',
      '- **Out of Scope:** after the fence'
    ].join('\n');
    assert.deepStrictEqual([...extractOutOfScopeDeclarations(text)], ['joined across a wrapped line', 'stopped by a heading', 'an empty marker still joins its continuation', 'after the fence']);
  });
});
