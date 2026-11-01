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
});
