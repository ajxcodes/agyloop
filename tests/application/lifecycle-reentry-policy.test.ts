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
  PLAN_ENTRY_RULES,
  resolveDiscoveryReentry,
  resolveCompletedReentry,
  resolveTriageReentry,
  resolvePlanEntry,
  parseRequestedPlanType,
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

// ---------------------------------------------------------------------------
// Issue #379: the plan entry table. Precedence is skip -> explicit --type ->
// issue kind, and the artifact type is computed independently so a skipped bug
// still scaffolds its RCA report.
// ---------------------------------------------------------------------------

describe('PLAN_ENTRY_RULES (issue #379)', () => {
  test('PE-1: every row resolves to its declared stage/source', () => {
    for (const rule of PLAN_ENTRY_RULES) {
      const decision = resolvePlanEntry({
        requestedType: rule.requestedType === 'any' ? 'auto' : rule.requestedType,
        issueKind: rule.issueKind === 'any' ? 'feature' : rule.issueKind,
        skipDiscovery: rule.skipDiscovery === true
      });
      assert.strictEqual(decision.stage, rule.stage, JSON.stringify(rule));
      assert.strictEqual(decision.source, rule.source, JSON.stringify(rule));
    }
  });

  test('PE-2: --skip-discovery is never shadowed', () => {
    const decision = resolvePlanEntry({
      requestedType: 'discovery',
      issueKind: 'bug',
      skipDiscovery: true
    });
    assert.strictEqual(decision.stage, 'PLAN');
    assert.strictEqual(decision.source, 'skip-discovery');
    assert.strictEqual(decision.artifactType, 'discovery');
  });

  test('PE-3: explicit --type overrides the label inference in both directions', () => {
    const bugImplementation = resolvePlanEntry({
      requestedType: 'implementation',
      issueKind: 'bug',
      skipDiscovery: false
    });
    assert.strictEqual(bugImplementation.stage, 'PLAN');
    assert.strictEqual(bugImplementation.source, 'type-override');
    assert.strictEqual(bugImplementation.artifactType, 'implementation');

    const featureDiscovery = resolvePlanEntry({
      requestedType: 'discovery',
      issueKind: 'feature',
      skipDiscovery: false
    });
    assert.strictEqual(featureDiscovery.stage, 'DISCOVERY');
    assert.strictEqual(featureDiscovery.source, 'type-override');
    assert.strictEqual(featureDiscovery.artifactType, 'discovery');
  });

  test('PE-4: auto infers the entry stage from the issue kind', () => {
    assert.deepStrictEqual(
      resolvePlanEntry({ requestedType: 'auto', issueKind: 'bug', skipDiscovery: false }),
      {
        stage: 'DISCOVERY',
        artifactType: 'discovery',
        source: 'issue-kind-bug',
        reason: 'A bug issue needs root-cause analysis before a plan can be written.'
      }
    );
    assert.deepStrictEqual(
      resolvePlanEntry({ requestedType: 'auto', issueKind: 'feature', skipDiscovery: false }),
      {
        stage: 'PLAN',
        artifactType: 'implementation',
        source: 'issue-kind-feature',
        reason: 'A feature issue has no defect to root-cause, so planning starts directly.'
      }
    );
  });

  test('PE-5: parseRequestedPlanType normalises and never throws', () => {
    assert.strictEqual(parseRequestedPlanType('DISCOVERY'), 'discovery');
    assert.strictEqual(parseRequestedPlanType(' Discovery '), 'discovery');
    assert.strictEqual(parseRequestedPlanType('implementation'), 'implementation');
    assert.strictEqual(parseRequestedPlanType('Implementation '), 'implementation');
    for (const raw of [null, undefined, '', 'auto', 'feature']) {
      assert.strictEqual(parseRequestedPlanType(raw), 'auto', String(raw));
    }
  });

  test('PE-6: artifact type always matches the entry contract', () => {
    assert.strictEqual(
      resolvePlanEntry({ requestedType: 'auto', issueKind: 'bug', skipDiscovery: false }).artifactType,
      'discovery'
    );
    assert.strictEqual(
      resolvePlanEntry({ requestedType: 'auto', issueKind: 'feature', skipDiscovery: false })
        .artifactType,
      'implementation'
    );
    assert.strictEqual(
      resolvePlanEntry({ requestedType: 'auto', issueKind: 'bug', skipDiscovery: true }).artifactType,
      'discovery'
    );
  });

  test('PE-7: all combinations are total and frozen', () => {
    for (const requestedType of ['discovery', 'implementation', 'auto']) {
      for (const issueKind of ['bug', 'feature']) {
        for (const skipDiscovery of [true, false]) {
          const decision = resolvePlanEntry({ requestedType, issueKind, skipDiscovery });
          assert.ok(decision);
          assert.ok(Object.isFrozen(decision));
        }
      }
    }
  });
});
