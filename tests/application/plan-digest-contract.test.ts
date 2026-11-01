/**
 * agyloop - approved-plan digest contract (issue #421)
 *
 * APD1 - a matching digest returns
 * APD2 - a mismatch refuses with field, path and BOTH digests
 * APD3 - an empty expected digest is a no-op (legacy / non-gated entries)
 * APD4 - an unreadable plan refuses and names the digest as (unreadable)
 * APD5 - --dry-run warns and returns instead of throwing
 * APD6 - the boundary selects the template (gate vs after-approval)
 * APD7 - the suffix is appended verbatim
 *
 * `resolvePlanDigest` is also pinned: a missing port/path or a failing
 * `hashPlanDocument` yields `null` instead of throwing from the adapter.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  assertApprovedPlanUnchanged,
  resolvePlanDigest
} = require('../../dist/application');
const {
  MSG_PLAN_MODIFIED_AFTER_APPROVAL,
  MSG_PLAN_MODIFIED_DURING_GATE,
  ValidationError
} = require('../../dist/domain');

const PLAN_PATH = '/repo/artifacts/plans/421/implementation_plan.md';
const EXPECTED = 'a'.repeat(64);
const ACTUAL = 'b'.repeat(64);

/** A plan generator whose hash is a pure function of the requested path. */
function generatorHashing(hash: string | null): any {
  return {
    resolvePlanFile: () => null,
    readPlanDocument: () => '',
    updateSummaryLog: () => true,
    hashPlanDocument: () => hash
  };
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    }
  };
}

describe('plan-digest-contract (issue #421)', () => {
  test('APD1: a matching digest returns without throwing', () => {
    assert.doesNotThrow(() =>
      assertApprovedPlanUnchanged({
        planGenerator: generatorHashing(EXPECTED),
        planPath: PLAN_PATH,
        expectedDigest: EXPECTED,
        boundary: 'approval'
      })
    );
  });

  test('APD2: a mismatch refuses with field, path and both digests', () => {
    assert.throws(
      () =>
        assertApprovedPlanUnchanged({
          planGenerator: generatorHashing(ACTUAL),
          planPath: PLAN_PATH,
          expectedDigest: EXPECTED,
          boundary: 'approval'
        }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'approvedPlanDigest');
        assert.strictEqual(err.value, ACTUAL, 'the refused value is the bytes on disk');
        assert.match(err.message, new RegExp(PLAN_PATH.replace(/[/.]/g, '\\$&')));
        assert.ok(err.message.includes(EXPECTED), err.message);
        assert.ok(err.message.includes(ACTUAL), err.message);
        assert.match(err.message, /changed after approval/);
        return true;
      }
    );
  });

  test('APD3: an empty expected digest is a no-op', () => {
    assert.doesNotThrow(() =>
      assertApprovedPlanUnchanged({
        planGenerator: generatorHashing(ACTUAL),
        planPath: PLAN_PATH,
        expectedDigest: null,
        boundary: 'approval'
      })
    );
  });

  test('APD4: an unreadable plan refuses and says (unreadable)', () => {
    assert.throws(
      () =>
        assertApprovedPlanUnchanged({
          planGenerator: generatorHashing(null),
          planPath: PLAN_PATH,
          expectedDigest: EXPECTED,
          boundary: 'approval'
        }),
      (err: any) => {
        assert.strictEqual(err.field, 'approvedPlanDigest');
        assert.strictEqual(err.value, null);
        assert.ok(err.message.includes('(unreadable)'), err.message);
        assert.ok(err.message.includes(EXPECTED), err.message);
        return true;
      }
    );
  });

  test('APD5: --dry-run warns and returns', () => {
    const capture = captureWarnings();
    try {
      assert.doesNotThrow(() =>
        assertApprovedPlanUnchanged({
          planGenerator: generatorHashing(ACTUAL),
          planPath: PLAN_PATH,
          expectedDigest: EXPECTED,
          boundary: 'approval',
          dryRun: true
        })
      );
    } finally {
      capture.restore();
    }
    assert.strictEqual(capture.warnings.length, 1, capture.warnings.join('\n'));
    assert.ok(capture.warnings[0].includes(PLAN_PATH), capture.warnings[0]);
    assert.ok(capture.warnings[0].includes(EXPECTED), capture.warnings[0]);
    assert.ok(capture.warnings[0].includes(ACTUAL), capture.warnings[0]);
  });

  test('APD6: the boundary selects the template', () => {
    const refusal = (boundary: 'approval' | 'gate'): string => {
      try {
        assertApprovedPlanUnchanged({
          planGenerator: generatorHashing(ACTUAL),
          planPath: PLAN_PATH,
          expectedDigest: EXPECTED,
          boundary
        });
      } catch (err: any) {
        return err.message;
      }
      throw new Error('expected a refusal');
    };

    const gate = refusal('gate');
    assert.ok(gate.includes(MSG_PLAN_MODIFIED_DURING_GATE.split('{')[0].trim()), gate);
    assert.match(gate, /changed during the quality gate/);

    const approval = refusal('approval');
    assert.ok(
      approval.includes(MSG_PLAN_MODIFIED_AFTER_APPROVAL.split('{')[0].trim()),
      approval
    );
    assert.match(approval, /changed after approval/);
  });

  test('APD7: the suffix is appended verbatim', () => {
    const suffix = ' The filed gate report for round 2 was NOT consumed.';
    assert.throws(
      () =>
        assertApprovedPlanUnchanged({
          planGenerator: generatorHashing(ACTUAL),
          planPath: PLAN_PATH,
          expectedDigest: EXPECTED,
          boundary: 'gate',
          suffix
        }),
      (err: any) => {
        assert.ok(err.message.endsWith(suffix), err.message);
        return true;
      }
    );
  });

  test('APD8: resolvePlanDigest is null without a port, a path, or a usable hash', () => {
    assert.strictEqual(resolvePlanDigest(undefined, PLAN_PATH), null);
    assert.strictEqual(resolvePlanDigest(generatorHashing(EXPECTED), null), null);
    assert.strictEqual(resolvePlanDigest({} as any, PLAN_PATH), null);
    assert.strictEqual(resolvePlanDigest(generatorHashing(null), PLAN_PATH), null);
    assert.strictEqual(
      resolvePlanDigest(
        {
          hashPlanDocument: () => {
            throw new Error('EACCES');
          }
        } as any,
        PLAN_PATH
      ),
      null
    );
    assert.strictEqual(resolvePlanDigest(generatorHashing(EXPECTED), PLAN_PATH), EXPECTED);
  });
});
