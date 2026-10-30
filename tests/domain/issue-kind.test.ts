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
      // #382: a READ non-bug label set is the source of the feature verdict —
      // it is no longer indistinguishable from "no labels were read".
      assert.strictEqual(result.source, 'label', label);
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

/**
 * Issue #382 (D4, was #385) — the title rule matches a MARKER, not ordinary
 * English.
 *
 * #379 widened the title fallback to `(?:^|[^a-z0-9])<kw>`, which classified
 * `Improve error handling` as a bug AND overrode a non-bug label. The title rule
 * is now the historical DELIMITED predicate (verbatim) plus ONE anchored
 * addition: a leading bug imperative (`crash on login`, `fixing the loop`).
 *
 * Amended AC A2: the mutation check has TWO directions, because delimiter-only
 * passes the false positives (that is why #379 widened it) and the widened rule
 * passes the markers (that is why they stayed green).
 */
describe('marker-shaped title rule (issue #382, amended AC A2)', () => {
  const FALSE_POSITIVES = [
    'Improve error handling',
    'Feature: RCA tooling',
    'Add a bug reporting dashboard',
    'Error budget dashboard for SLOs',
    'Add defect tracking view',
    'Reduce regression test flakiness'
  ];

  const MARKERS = [
    '[Bug] x',
    'Bug: x',
    'fix: x',
    'fixing the loop',
    'RCA: x',
    'regression/a',
    'crash on login',
    '[error] x'
  ];

  /** The rule #379 SHIPPED: any word-start keyword. Counterfactual (a). */
  function widenedRuleIsBug(title: string): boolean {
    const titleLower = title.toLowerCase();
    return BUG_TITLE_KEYWORDS.some((keyword: string) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^a-z0-9])${escaped}`).test(titleLower);
    });
  }

  /** The pre-#379 delimiter-only rule. Counterfactual (b). */
  function delimiterOnlyIsBug(title: string): boolean {
    const titleLower = title.toLowerCase();
    return BUG_TITLE_KEYWORDS.some(
      (keyword: string) =>
        titleLower.includes(`[${keyword}]`) ||
        titleLower.includes(`${keyword}:`) ||
        titleLower.includes(`${keyword}/`)
    );
  }

  test('IK-8: ordinary English titles classify as features', () => {
    for (const title of FALSE_POSITIVES) {
      assert.deepStrictEqual(
        detectIssueKind({ title }),
        { kind: 'feature', source: 'none' },
        title
      );
    }
  });

  test('IK-9: marker-limited precedence — a non-bug label is not overridden by ordinary English', () => {
    assert.deepStrictEqual(
      detectIssueKind({ labels: ['enhancement'], title: 'Improve error handling' }),
      { kind: 'feature', source: 'label' }
    );
    assert.deepStrictEqual(
      detectIssueKind({ labels: ['enhancement'], title: '[Bug] x' }),
      { kind: 'bug', source: 'title' }
    );
    assert.deepStrictEqual(
      detectIssueKind({ labels: ['bug'], title: '[Task] x' }),
      { kind: 'bug', source: 'label' }
    );
  });

  test('IK-10: detectPlanType and detectIssueKind stay in lockstep on every shape', () => {
    const generator = new FilePlanGenerator();
    const shapes = [
      // The pre-existing IK-6 matrix.
      { title: '[Bug] App crashes on startup', labels: [] },
      { title: 'fix: memory leak in worker', labels: [] },
      { title: 'RCA: Investigate latency spike', labels: [] },
      { title: 'Standard task', labels: ['bug'] },
      { title: 'Standard task', labels: ['defect', 'urgent'] },
      { title: '[Task] Implement Auth Module', labels: [] },
      { title: 'feat: add dark mode support', labels: [] },
      { title: 'Setup CI/CD pipeline', labels: ['enhancement'] },
      { title: 'Fix a not-a-bug label', labels: ['not-a-bug'] },
      { title: 'Crash-free feature', labels: ['fixed-in:2.0'] },
      // #382: the false positives…
      ...FALSE_POSITIVES.map((title) => ({ title, labels: [] })),
      // …the markers…
      ...MARKERS.map((title) => ({ title, labels: [] })),
      // …and the precedence pair.
      { title: 'Improve error handling', labels: ['enhancement'] },
      { title: '[Bug] x', labels: ['enhancement'] }
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

  test('IK-MUT-1: the shipped widened rule classifies every false positive as a bug', () => {
    for (const title of FALSE_POSITIVES) {
      assert.strictEqual(widenedRuleIsBug(title), true, `counterfactual must be red: ${title}`);
      assert.deepStrictEqual(
        detectIssueKind({ title }),
        { kind: 'feature', source: 'none' },
        `the new rule must keep it a feature: ${title}`
      );
    }
  });

  test('IK-MUT-2: the delimiter-only rule loses the two undelimited markers', () => {
    for (const title of ['crash on login', 'fixing the loop']) {
      assert.strictEqual(delimiterOnlyIsBug(title), false, `counterfactual must be red: ${title}`);
      assert.deepStrictEqual(
        detectIssueKind({ title }),
        { kind: 'bug', source: 'title' },
        `the new rule must keep it a bug: ${title}`
      );
    }
  });

  test('IK-11: labelsUnavailable is present only when true and the result stays frozen', () => {
    const unavailable = detectIssueKind({ title: 'Add dark mode', labelsUnavailable: true });
    assert.strictEqual(unavailable.labelsUnavailable, true);
    assert.strictEqual(unavailable.kind, 'feature');
    assert.ok(Object.isFrozen(unavailable));

    assert.strictEqual('labelsUnavailable' in detectIssueKind({ title: 'Add dark mode' }), false);
    assert.strictEqual('labelsUnavailable' in detectIssueKind({ labels: ['bug'] }), false);

    // Totality survives the new field.
    assert.doesNotThrow(() => detectIssueKind({ labelsUnavailable: true }));
    assert.doesNotThrow(() => detectIssueKind({ labels: [], title: 'x'.repeat(10000) }));
  });
});
