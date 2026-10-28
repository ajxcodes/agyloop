/**
 * agyloop - Finding actionability (issue #349 / #242 Defect A, local half)
 *
 * The local two-tier invariant used to be content-blind: a `critical` finding
 * escalated an `APPROVED` verdict even when its body ASSERTED the code was
 * fine ("Correctly pins actions/checkout@v7"). The classifier is a pure
 * predicate over the body, and it fails CLOSED: only a body that positively
 * asserts no defect stops blocking.
 *
 * A1 - a critical affirmation is non-blocking (but still structurally blocking)
 * A2 - a defect body requests a change
 * A3 - no cue at all is AMBIGUOUS and still blocks (fail closed)
 * A4 - change cues win over affirmation cues
 * A5 - the incident's factual claim is a change request (why D2/--refute exists)
 * A6 - the predicate is deterministic (normalisation + no RegExp lastIndex state)
 * A7 - the report's counts agree on a mixed report
 * A8 - warning/suggestion/info are never blocking, whatever their body
 * A9 - the two operator notes are never silent and never unbounded
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  AiReviewFinding,
  AiReviewReport,
  ReviewConfidence,
  classifyFindingActionability,
  formatNonActionableFindingsNote,
  formatCritiqueIgnoredAffirmations,
  excerptFindingBody,
  FINDING_ACTIONABILITY_CHANGE_REQUEST,
  FINDING_ACTIONABILITY_AFFIRMATION,
  FINDING_ACTIONABILITY_AMBIGUOUS,
  FINDING_BODY_EXCERPT_CHARS
} = require('../../dist/domain');

function finding(props: any) {
  return new AiReviewFinding(props);
}

function report(findings: any) {
  return new AiReviewReport({
    summary: 'critique summary',
    confidence: ReviewConfidence.high('static scan'),
    findings
  });
}

describe('finding actionability (issue #349)', () => {
  test('A1: a critical affirmation is an affirmation and does not request a change', () => {
    const f = finding({
      path: 'src/app.ts',
      line: 10,
      severity: 'critical',
      body: 'Correctly pins actions/checkout@v7 and actions/setup-node@v7.'
    });

    assert.strictEqual(f.actionability(), 'affirmation');
    assert.strictEqual(f.requestsChange(), false);
    // The structural predicate is UNCHANGED: severity still gates CI.
    assert.strictEqual(f.isBlocking(), true);
    assert.strictEqual(f.isError(), true);
  });

  test('A2: a genuine defect body requests a change', () => {
    const f = finding({
      path: 'src/app.ts',
      line: 10,
      severity: 'error',
      body: 'Null pointer dereference on an empty payload.'
    });

    assert.strictEqual(f.actionability(), 'change-request');
    assert.strictEqual(f.requestsChange(), true);
  });

  test('A3: a body with no cue is AMBIGUOUS and still blocks (fail closed)', () => {
    const f = finding({
      path: 'src/app.ts',
      line: 10,
      severity: 'critical',
      body: 'actions/setup-node@v7'
    });

    assert.strictEqual(f.actionability(), 'ambiguous');
    assert.strictEqual(f.requestsChange(), true);
  });

  test('A4: change cues win over affirmation cues', () => {
    const f = finding({
      path: 'src/app.ts',
      line: 10,
      severity: 'error',
      body: 'Correctly pins v7, but the retry loop leaks a timer.'
    });

    assert.strictEqual(f.actionability(), 'change-request');
  });

  test('A5: the incident body is a change request (documented reason for --refute)', () => {
    const f = finding({
      path: 'src/app.ts',
      line: 10,
      severity: 'error',
      body: 'actions/checkout@v7 does not exist. Revert to @v4.'
    });

    assert.strictEqual(f.actionability(), 'change-request');
    assert.strictEqual(f.requestsChange(), true);
  });

  test('A6: classification is deterministic across case, spacing, markdown and repeat calls', () => {
    const variants = [
      'Correctly pins actions/checkout@v7.',
      'correctly pins actions/checkout@v7.',
      '  Correctly   pins\tactions/checkout@v7.  ',
      '**Correctly** pins `actions/checkout@v7`.',
      '> Correctly pins actions/checkout@v7.'
    ];

    for (const body of variants) {
      assert.strictEqual(
        classifyFindingActionability(body),
        FINDING_ACTIONABILITY_AFFIRMATION,
        `variant must classify as an affirmation: ${JSON.stringify(body)}`
      );
    }

    // Two consecutive calls on ONE string: no shared RegExp may carry state.
    assert.strictEqual(
      classifyFindingActionability('Null pointer dereference on an empty payload.'),
      classifyFindingActionability('Null pointer dereference on an empty payload.')
    );
    assert.strictEqual(
      classifyFindingActionability('Null pointer dereference on an empty payload.'),
      FINDING_ACTIONABILITY_CHANGE_REQUEST
    );
    // The three vocabularies are distinct values, not prefixes of one another.
    const all = new Set([
      FINDING_ACTIONABILITY_CHANGE_REQUEST,
      FINDING_ACTIONABILITY_AFFIRMATION,
      FINDING_ACTIONABILITY_AMBIGUOUS
    ]);
    assert.strictEqual(all.size, 3);
  });

  test('A7: blockingCount/errorCount/hasBlockingIssues agree on a mixed report', () => {
    const mixed = report([
      finding({
        path: 'src/app.ts',
        line: 10,
        severity: 'critical',
        body: 'Correctly pins actions/checkout@v7.'
      }),
      finding({
        path: 'src/db.ts',
        line: 42,
        severity: 'error',
        body: 'Null pointer dereference when the row is absent.'
      })
    ]);

    assert.strictEqual(mixed.blockingCount(), 1);
    assert.strictEqual(mixed.errorCount(), 1);
    assert.strictEqual(mixed.hasBlockingIssues(), true);
    assert.strictEqual(mixed.blockingFindings().length, 1);
    assert.strictEqual(mixed.blockingFindings()[0].path, 'src/db.ts');
    assert.strictEqual(mixed.nonActionableBlockingFindings().length, 1);
    assert.strictEqual(mixed.nonActionableBlockingFindings()[0].path, 'src/app.ts');
    assert.strictEqual(mixed.affirmationCount(), 1);
    // The report still carries BOTH findings: nothing is dropped.
    assert.strictEqual(mixed.findings.length, 2);
  });

  test('A8: warning/suggestion/info are never blocking whatever their body', () => {
    const bodies = [
      'Null pointer dereference on an empty payload.',
      'Correctly pins actions/checkout@v7.',
      'actions/setup-node@v7'
    ];

    for (const severity of ['warning', 'suggestion', 'info']) {
      for (const body of bodies) {
        const single = report([finding({ path: 'src/app.ts', line: 10, severity, body })]);
        assert.strictEqual(single.blockingCount(), 0, `${severity}: ${body}`);
        assert.strictEqual(single.hasBlockingIssues(), false, `${severity}: ${body}`);
        assert.strictEqual(single.nonActionableBlockingFindings().length, 0, `${severity}: ${body}`);
      }
    }
  });

  test('A9: the notes are empty when nothing was exempted and name what was', () => {
    assert.strictEqual(formatNonActionableFindingsNote([]), '');
    assert.strictEqual(formatNonActionableFindingsNote(undefined), '');

    const note = formatNonActionableFindingsNote([
      {
        path: 'src/app.ts',
        line: 10,
        severity: 'critical',
        actionability: 'affirmation',
        body: 'Correctly pins actions/checkout@v7.'
      }
    ]);

    assert.ok(note.includes('request no change'), note);
    assert.ok(note.includes('src/app.ts:10'), note);
    assert.ok(note.includes('[critical/affirmation]'), note);
    assert.ok(note.includes('Correctly pins actions/checkout@v7.'), note);

    // An over-long body is excerpted by the formatter, never printed whole.
    const longBody = 'x'.repeat(FINDING_BODY_EXCERPT_CHARS * 3);
    const longNote = formatNonActionableFindingsNote([
      {
        path: 'src/app.ts',
        line: 10,
        severity: 'critical',
        actionability: 'affirmation',
        body: longBody
      }
    ]);
    assert.ok(!longNote.includes(longBody), 'the note must not print the whole body');
    const excerpt = excerptFindingBody(longBody);
    assert.ok(excerpt.length <= FINDING_BODY_EXCERPT_CHARS, `excerpt length: ${excerpt.length}`);
    assert.ok(longNote.includes(excerpt), longNote);

    assert.ok(formatCritiqueIgnoredAffirmations(2).includes('Ignored 2'));
    assert.ok(formatCritiqueIgnoredAffirmations(1).includes('request no change'));
  });
});
