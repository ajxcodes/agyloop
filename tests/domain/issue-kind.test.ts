/**
 * agyloop - Issue kind predicate tests (issue #379)
 *
 * One definition decides whether an issue is a bug. It selects the plan entry
 * stage, so the two halves that matter are:
 *  - labels are EXACT (`not-a-bug` is not a bug label) — the B6 tightening;
 *  - title markers are byte-identical to `detectPlanType` (no drift).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  detectIssueKind,
  BUG_LABELS,
  BUG_TITLE_KEYWORDS,
  BUG_LABEL_PREFIX_PATTERN
} = require('../../dist/domain');
const { FilePlanGenerator } = require('../../dist/infrastructure');

describe('detectIssueKind (issue #379)', () => {
  test('IK-1: exact bug labels match regardless of case and surrounding space', () => {
    for (const label of ['bug', 'BUG', '  Bug  ']) {
      const result = detectIssueKind({ labels: [label] });
      assert.strictEqual(result.kind, 'bug', label);
      assert.strictEqual(result.source, 'label', label);
    }
  });

  test('IK-2: defect and prefixed labels match; empty input is a feature', () => {
    for (const label of ['defect', 'type: bug', 'type:bug', 'kind/bug', 'kind: defect']) {
      const result = detectIssueKind({ labels: [label] });
      assert.strictEqual(result.kind, 'bug', label);
      assert.strictEqual(result.source, 'label', label);
    }
    assert.deepStrictEqual(detectIssueKind({ labels: [], title: 'Add a dashboard' }), {
      kind: 'feature',
      source: 'none'
    });
  });

  test('IK-3: labels merely CONTAINING a keyword are not bug labels (B6)', () => {
    for (const label of ['not-a-bug', 'fixed-in:2.0', 'enhancement', 'priority:p2', 'phase:6']) {
      const result = detectIssueKind({ labels: [label] });
      assert.strictEqual(result.kind, 'feature', label);
      assert.strictEqual(result.source, 'none', label);
    }
  });

  test('IK-4: title markers keep the historical detection', () => {
    for (const title of [
      '[Bug] x',
      'Bug: x',
      'fix: x',
      'fixing the loop',
      'RCA: x',
      'regression/a',
      'crash on login',
      '[error] x'
    ]) {
      const result = detectIssueKind({ title });
      assert.strictEqual(result.kind, 'bug', title);
      assert.strictEqual(result.source, 'title', title);
    }
    for (const title of ['[Task] x', 'feat: x', 'Add dark mode', 'Task Plan']) {
      const result = detectIssueKind({ title });
      assert.strictEqual(result.kind, 'feature', title);
      assert.strictEqual(result.source, 'none', title);
    }
  });

  test('IK-5: a bug label outranks a feature-looking title, and a title marker still fires without labels', () => {
    assert.deepStrictEqual(detectIssueKind({ labels: ['enhancement'], title: '[Bug] x' }), {
      kind: 'bug',
      source: 'title'
    });
    assert.deepStrictEqual(detectIssueKind({ labels: ['bug'], title: '[Task] x' }), {
      kind: 'bug',
      source: 'label'
    });
  });

  test('IK-6: detectPlanType and detectIssueKind never disagree (no drift)', () => {
    const generator = new FilePlanGenerator();
    const shapes = [
      { title: '[Bug] App crashes on startup', labels: [] },
      { title: 'fix: memory leak in worker', labels: [] },
      { title: 'RCA: Investigate latency spike', labels: [] },
      { title: 'Standard task', labels: ['bug'] },
      { title: 'Standard task', labels: ['defect', 'urgent'] },
      { title: '[Task] Implement Auth Module', labels: [] },
      { title: 'feat: add dark mode support', labels: [] },
      { title: 'Setup CI/CD pipeline', labels: ['enhancement'] },
      { title: 'Fix a not-a-bug label', labels: ['not-a-bug'] },
      { title: 'Crash-free feature', labels: ['fixed-in:2.0'] }
    ];
    for (const shape of shapes) {
      const expected = detectIssueKind(shape).kind === 'bug' ? 'discovery' : 'implementation';
      assert.strictEqual(
        generator.detectPlanType(shape),
        expected,
        `${JSON.stringify(shape)} must classify identically`
      );
    }
  });

  test('IK-7: totality and purity — no throws, frozen result', () => {
    assert.doesNotThrow(() => detectIssueKind());
    assert.doesNotThrow(() => detectIssueKind({ labels: null, title: null }));
    assert.doesNotThrow(() => detectIssueKind({ labels: [''], title: '' }));
    assert.doesNotThrow(() => detectIssueKind({ labels: [], title: 'x'.repeat(10000) }));

    const result = detectIssueKind({ labels: ['bug'] });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(BUG_LABELS));
    assert.ok(Object.isFrozen(BUG_TITLE_KEYWORDS));
    assert.ok(BUG_LABEL_PREFIX_PATTERN instanceof RegExp);
  });
});
