/**
 * agyloop - Lifecycle Re-Entry Policy unit tests (issue #237)
 *
 * Pins the two rule tables and the shared TRIAGE predicate that now form the
 * single chokepoint for every re-entry decision:
 * - DISCOVERY re-entry (Defect 1: an unattended YOLO re-run must not advance
 *   out of an unpopulated discovery scaffold).
 * - COMPLETED re-entry (Defect 2: a read-only `next` must not destroy a
 *   checkpoint; only an explicit `--restart` may).
 *
 * Table-driven over EVERY row, plus the fail-closed rows and the one
 * precedence pair that is not obvious from reading the table in isolation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  DISCOVERY_REENTRY_RULES,
  COMPLETED_REENTRY_RULES,
  resolveDiscoveryReentry,
  resolveCompletedReentry,
  resolveTriageReentry,
  shouldRouteToTriage
} = require('../../dist/application/lifecycle-reentry-policy');
const {
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_TRIAGE
} = require('../../dist/domain');

/** Every stage name, used to prove the fail-closed guard is total. */
const ALL_STAGES = Object.freeze([
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_TRIAGE
] as const);

describe('Lifecycle Re-Entry Policy (issue #237)', () => {
  describe('DISCOVERY_REENTRY_RULES (Defect 1)', () => {
    test('every row of the table resolves to its declared decision', () => {
      for (const rule of DISCOVERY_REENTRY_RULES) {
        const decision = resolveDiscoveryReentry({
          currentStage: STAGE_DISCOVERY,
          skipDiscovery: rule.skipDiscovery === true,
          discoveryReportPresent: rule.discoveryReportPresent === true
        });
        assert.strictEqual(
          decision,
          rule.decision,
          `row {skipDiscovery:${rule.skipDiscovery}, discoveryReportPresent:${rule.discoveryReportPresent}} must resolve to ${rule.decision}`
        );
      }
    });

    test('the table is ordered skipDiscovery-first, so the opt-in is never shadowed', () => {
      assert.strictEqual(DISCOVERY_REENTRY_RULES.length, 3);
      assert.strictEqual(DISCOVERY_REENTRY_RULES[0].skipDiscovery, true);
      assert.strictEqual(DISCOVERY_REENTRY_RULES[1].discoveryReportPresent, true);
      assert.strictEqual(DISCOVERY_REENTRY_RULES[2].decision, 'PARK_AT_DISCOVERY');
    });

    test('fail-closed default: no evidence and no opt-in parks', () => {
      assert.strictEqual(
        resolveDiscoveryReentry({
          currentStage: STAGE_DISCOVERY,
          skipDiscovery: false,
          discoveryReportPresent: false
        }),
        'PARK_AT_DISCOVERY'
      );
    });

    test('the opt-in wildcard releases the park with a pristine scaffold', () => {
      // R1's `discoveryReportPresent: 'any'` wildcard: --skip-discovery must work
      // even when the report on disk is still the untouched template.
      assert.strictEqual(
        resolveDiscoveryReentry({
          currentStage: STAGE_DISCOVERY,
          skipDiscovery: true,
          discoveryReportPresent: false
        }),
        'ADVANCE_TO_PLAN'
      );
    });

    test('content evidence releases the park without any flag', () => {
      assert.strictEqual(
        resolveDiscoveryReentry({
          currentStage: STAGE_DISCOVERY,
          skipDiscovery: false,
          discoveryReportPresent: true
        }),
        'ADVANCE_TO_PLAN'
      );
    });

    test('a non-DISCOVERY stage never reaches the table and parks', () => {
      for (const currentStage of ALL_STAGES) {
        if (currentStage === STAGE_DISCOVERY) continue;
        // Even the most permissive input combination must not advance a stage the
        // rule was not written for.
        assert.strictEqual(
          resolveDiscoveryReentry({ currentStage, skipDiscovery: true, discoveryReportPresent: true }),
          'PARK_AT_DISCOVERY',
          `stage ${currentStage} must not be advanced by the discovery rule`
        );
      }
    });

    test('is total: never returns undefined for an exhaustive-table refactor', () => {
      for (const currentStage of ALL_STAGES) {
        for (const skipDiscovery of [false, true]) {
          for (const discoveryReportPresent of [false, true]) {
            const decision = resolveDiscoveryReentry({
              currentStage,
              skipDiscovery,
              discoveryReportPresent
            });
            assert.ok(
              decision === 'ADVANCE_TO_PLAN' || decision === 'PARK_AT_DISCOVERY',
              `unexpected decision ${String(decision)}`
            );
          }
        }
      }
    });
  });

  describe('COMPLETED_REENTRY_RULES (Defect 2)', () => {
    test('every row of the table resolves to its declared decision', () => {
      for (const rule of COMPLETED_REENTRY_RULES) {
        const decision = resolveCompletedReentry({
          currentStage: STAGE_COMPLETED,
          restartOptIn: rule.restartOptIn,
          hasOpenReviewFeedback: rule.hasOpenReviewFeedback
        });
        assert.strictEqual(
          decision,
          rule.decision,
          `row {restartOptIn:${rule.restartOptIn}, hasOpenReviewFeedback:${rule.hasOpenReviewFeedback}} must resolve to ${rule.decision}`
        );
      }
    });

    test('precedence: open review feedback outranks a restart', () => {
      // The only non-obvious row: destroying a checkpoint that still carries
      // unaddressed review feedback would lose that feedback forever.
      assert.strictEqual(
        resolveCompletedReentry({
          currentStage: STAGE_COMPLETED,
          restartOptIn: true,
          hasOpenReviewFeedback: true
        }),
        'ROUTE_TRIAGE'
      );
    });

    test('an explicit --restart with no feedback resets', () => {
      assert.strictEqual(
        resolveCompletedReentry({
          currentStage: STAGE_COMPLETED,
          restartOptIn: true,
          hasOpenReviewFeedback: false
        }),
        'RESTART'
      );
    });

    test('fail-closed default: no restart and no feedback reports idle', () => {
      assert.strictEqual(
        resolveCompletedReentry({
          currentStage: STAGE_COMPLETED,
          restartOptIn: false,
          hasOpenReviewFeedback: false
        }),
        'REPORT_IDLE_COMPLETED'
      );
    });

    test('feedback alone routes to TRIAGE without destroying anything', () => {
      assert.strictEqual(
        resolveCompletedReentry({
          currentStage: STAGE_COMPLETED,
          restartOptIn: false,
          hasOpenReviewFeedback: true
        }),
        'ROUTE_TRIAGE'
      );
    });

    test('a non-COMPLETED stage never reaches the table and reports idle', () => {
      for (const currentStage of ALL_STAGES) {
        if (currentStage === STAGE_COMPLETED) continue;
        assert.strictEqual(
          resolveCompletedReentry({
            currentStage,
            restartOptIn: true,
            hasOpenReviewFeedback: false
          }),
          'REPORT_IDLE_COMPLETED',
          `stage ${currentStage} must not be reset by the completed rule`
        );
      }
    });

    test('is total: never returns undefined for an exhaustive-table refactor', () => {
      for (const currentStage of ALL_STAGES) {
        for (const restartOptIn of [false, true]) {
          for (const hasOpenReviewFeedback of [false, true]) {
            const decision = resolveCompletedReentry({
              currentStage,
              restartOptIn,
              hasOpenReviewFeedback
            });
            assert.ok(
              decision === 'REPORT_IDLE_COMPLETED' ||
                decision === 'ROUTE_TRIAGE' ||
                decision === 'RESTART',
              `unexpected decision ${String(decision)}`
            );
          }
        }
      }
    });

    test('the feedback rows are DERIVED from shouldRouteToTriage, not re-encoded', () => {
      // Finding 4: the JSDoc used to claim `resolveCompletedReentry` shared
      // `shouldRouteToTriage` when it had its own copy of the rule. This pins
      // the derivation: every table row that says ROUTE_TRIAGE is exactly the
      // row the shared predicate selects, and no other row is.
      for (const rule of COMPLETED_REENTRY_RULES) {
        const routes = shouldRouteToTriage({
          currentStage: STAGE_COMPLETED,
          hasOpenReviewFeedback: rule.hasOpenReviewFeedback
        });
        assert.strictEqual(
          routes,
          rule.decision === 'ROUTE_TRIAGE',
          `row {restartOptIn:${rule.restartOptIn}, hasOpenReviewFeedback:${rule.hasOpenReviewFeedback}} must agree with the shared predicate`
        );
        assert.strictEqual(
          resolveCompletedReentry({
            currentStage: STAGE_COMPLETED,
            restartOptIn: rule.restartOptIn,
            hasOpenReviewFeedback: rule.hasOpenReviewFeedback
          }),
          rule.decision,
          'resolution must still match the declared row'
        );
      }

      // And the precedence the derivation exists to protect: feedback outranks
      // the explicit --restart, so a checkpoint is never destroyed with
      // unaddressed review comments still on it.
      assert.strictEqual(
        shouldRouteToTriage({ currentStage: STAGE_COMPLETED, hasOpenReviewFeedback: true }),
        true
      );
      assert.strictEqual(
        resolveCompletedReentry({
          currentStage: STAGE_COMPLETED,
          restartOptIn: true,
          hasOpenReviewFeedback: true
        }),
        'ROUTE_TRIAGE'
      );
    });
  });

  describe('shouldRouteToTriage (shared predicate)', () => {
    test('feedback from a non-TRIAGE stage routes to TRIAGE', () => {
      for (const currentStage of ALL_STAGES) {
        if (currentStage === STAGE_TRIAGE) continue;
        assert.strictEqual(
          shouldRouteToTriage({ currentStage, hasOpenReviewFeedback: true }),
          true,
          `open feedback at ${currentStage} must route to TRIAGE`
        );
      }
    });

    test('already at TRIAGE never re-routes', () => {
      assert.strictEqual(
        shouldRouteToTriage({ currentStage: STAGE_TRIAGE, hasOpenReviewFeedback: true }),
        false
      );
    });

    test('no feedback never routes to TRIAGE', () => {
      for (const currentStage of ALL_STAGES) {
        assert.strictEqual(
          shouldRouteToTriage({ currentStage, hasOpenReviewFeedback: false }),
          false
        );
      }
    });

    test('is exactly the predicate RunLifecycleUseCase applied inline before the refactor', () => {
      // Behaviour-preserving de-duplication (issue #237): the old guard was
      // `isResume && (comments.length > 0 || changesRequested) && stage !== TRIAGE`,
      // where the first two clauses are precisely `hasOpenReviewFeedback`.
      const preflightResult = {
        isResume: true,
        prReviewComments: [{ author: 'r', body: 'fix' }],
        prHasChangesRequested: false
      };
      const hasOpenReviewFeedback = Boolean(
        preflightResult &&
          preflightResult.isResume &&
          ((preflightResult.prReviewComments && preflightResult.prReviewComments.length > 0) ||
            preflightResult.prHasChangesRequested)
      );

      for (const currentStage of ALL_STAGES) {
        const legacy = Boolean(
          preflightResult &&
            preflightResult.isResume &&
            (preflightResult.prReviewComments.length > 0 || preflightResult.prHasChangesRequested) &&
            currentStage !== STAGE_TRIAGE
        );
        assert.strictEqual(
          shouldRouteToTriage({ currentStage, hasOpenReviewFeedback }),
          legacy,
          `predicate drift at ${currentStage}`
        );
      }
    });
  });

  describe('TRIAGE re-entry (issue #351)', () => {
    test('a MERGED or CLOSED pull request ends the gate', () => {
      for (const pullRequestState of ['MERGED', 'CLOSED']) {
        assert.strictEqual(
          resolveTriageReentry({ currentStage: STAGE_TRIAGE, pullRequestState }),
          'EXIT_TO_COMPLETED',
          `${pullRequestState} at TRIAGE must exit the gate`
        );
      }
    });

    test('the state is normalised before it is matched', () => {
      assert.strictEqual(
        resolveTriageReentry({ currentStage: STAGE_TRIAGE, pullRequestState: 'merged' }),
        'EXIT_TO_COMPLETED'
      );
    });

    test('OPEN, unmeasured and unrecognised states report the gate (fail closed)', () => {
      for (const pullRequestState of ['OPEN', null, '', 'UNKNOWN']) {
        assert.strictEqual(
          resolveTriageReentry({ currentStage: STAGE_TRIAGE, pullRequestState }),
          'REPORT_TRIAGE_GATE',
          `${String(pullRequestState)} at TRIAGE must keep the gate`
        );
      }
    });

    test('no other stage is ever exited by this rule', () => {
      for (const currentStage of ALL_STAGES) {
        if (currentStage === STAGE_TRIAGE) continue;
        assert.strictEqual(
          resolveTriageReentry({ currentStage, pullRequestState: 'MERGED' }),
          'REPORT_TRIAGE_GATE',
          `${currentStage} must not be advanced by the TRIAGE exit`
        );
      }
    });
  });
});
