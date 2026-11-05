/**
 * codeloop - one shared chokepoint certifies the QUALITY_GATE exit (issue #455)
 *
 * AC3: the certifying guards live in ONE shared chokepoint used by both entry
 * points, so a future guard cannot be added to one and forgotten on the other.
 * `QUALITY_GATE -> REVIEW` is reachable through `codeloop transition REVIEW`
 * AND `codeloop review`; both must call `certifyReviewExit`, and neither may
 * re-implement (or re-reference) the primitives that live in it.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const APPLICATION = path.join(ROOT, 'src', 'application');

function readApplication(name: string): string {
  return fs.readFileSync(path.join(APPLICATION, name), 'utf8');
}

describe('review-exit certification chokepoint (issue #455, AC3)', () => {
  const transition = readApplication('transition-stage.ts');
  const review = readApplication('run-review.ts');
  const chokepoint = readApplication('certify-review-exit.ts');
  const index = readApplication('index.ts');

  test('both review entry points certify through one shared chokepoint (issue #455, AC3)', () => {
    assert.match(transition, /from '\.\/certify-review-exit'/);
    assert.match(review, /from '\.\/certify-review-exit'/);
    assert.ok(transition.includes('certifyReviewExit('), 'transition must call the chokepoint');
    assert.ok(review.includes('certifyReviewExit('), 'review must call the chokepoint');
  });

  test('transition-stage no longer defines the certifying guards it delegated', () => {
    assert.strictEqual(transition.includes('private assertGateReportRanTests('), false);
    assert.strictEqual(
      transition.includes('private assertGateReportCoversDeclaredTargets('),
      false
    );
    assert.strictEqual(transition.includes('private assertApprovedPlanUnchanged('), false);
    assert.strictEqual(transition.includes('private assertPlanDeviationsAcknowledged('), false);
  });

  test('only the chokepoint references the shared certifying primitives', () => {
    for (const primitive of [
      'formatGateEvidenceRequiredMessage',
      'gateTestEvidenceRefusal',
      'assessGateEvidenceCoverage'
    ]) {
      assert.ok(chokepoint.includes(primitive), `the chokepoint must own ${primitive}`);
      assert.strictEqual(
        transition.includes(primitive),
        false,
        `transition-stage must not reference ${primitive}`
      );
      assert.strictEqual(
        review.includes(primitive),
        false,
        `run-review must not reference ${primitive}`
      );
    }

    assert.strictEqual(review.includes('formatPlanDeviationUnacknowledgedMessage'), false);
  });

  test('the chokepoint module is exported from the application layer', () => {
    assert.ok(index.includes("export * from './certify-review-exit'"));
  });
});
