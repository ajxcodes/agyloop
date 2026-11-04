/**
 * agyloop - implementer/reviewer deviation contract (issue #432, TR-41/42)
 *
 * IDD6 - the reviewer prompt's AC_EVIDENCE contract teaches `out-of-scope` for a
 *        plan-declared operator step (issue #506).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { ResolveSubagentUseCase } = require('../../dist/application');
const {
  REVIEWER_AC_EVIDENCE_SENTENCE,
  REVIEWER_AC_EVIDENCE_STATUS_CONTRACT,
  PLAN_DEVIATION_EXAMPLE,
  formatPlanDeviationChannelNote
} = require('../../dist/domain');

const RECORD = {
  id: 'PD-1',
  planSection: '§4.2 row IMPL-428-4 (d)',
  planLiteral: 'result.pausedAtGate === GATE_APPROVAL',
  implementedAssertion: 'result.currentStage === STAGE_PLAN',
  reason: 'the fresh-run case already pins STAGE_PLAN',
  files: ['tests/application/run-lifecycle.test.ts:664'],
  recordedAt: '2026-11-01T00:00:00.000Z',
  acknowledged: false,
  acknowledgedAt: null,
  acknowledgementReason: null
};

function useCase(): any {
  return new ResolveSubagentUseCase({ loadConfig: () => ({ models: {}, options: {} }) } as any);
}

describe('implementer/reviewer deviation contract (issue #432)', () => {
  test('IDD1 the implementer prompt mandates the block and forbids a silent override', () => {
    const prompt = useCase().buildImplementationTaskPrompt({ issueNumber: 432 });
    assert.ok(prompt.includes('PLAN_DEVIATION:'), 'the prompt must name the marker');
    assert.ok(prompt.includes('codeloop deviation'), 'the prompt must name the filing command');
    assert.ok(/Never change a literal silently/.test(prompt));
    for (const key of ['planSection', 'planLiteral', 'implementedAssertion', 'reason']) {
      assert.ok(prompt.includes(key), `the prompt must name ${key}`);
    }
    assert.ok(prompt.includes(PLAN_DEVIATION_EXAMPLE), 'the prompt must show the accepted shape');
  });

  test('IDD2 the reviewer prompt mandates AC_EVIDENCE and lists recorded deviations', () => {
    const prompt = useCase().buildReviewerTaskPrompt({
      issueNumber: 432,
      planDeviations: [RECORD],
      outOfScope: ['the #425 historical row is not edited']
    });
    assert.ok(prompt.includes('AC_EVIDENCE:'), 'the prompt must name the evidence marker');
    assert.ok(prompt.includes('PD-1'), 'the prompt must list the recorded deviation');
    assert.ok(prompt.includes('the #425 historical row is not edited'));
  });

  test('IDD3 the required verdict format fence carries the AC_EVIDENCE block (issue #435)', () => {
    const prompt = useCase().buildReviewerTaskPrompt({ issueNumber: 435 });
    const section = prompt.slice(prompt.indexOf('### Required Verdict Output:'));
    const fenced = /```markdown\n([\s\S]*?)```/.exec(section);
    if (!fenced) throw new Error('the required verdict section has no fenced format');
    assert.ok(fenced[1].includes('REVIEW_STATUS:'));
    assert.ok(fenced[1].includes('AC_EVIDENCE:'));
    assert.ok(fenced[1].indexOf('AC_EVIDENCE:') > fenced[1].indexOf('REMEDIATION_GUIDANCE:'));
  });

  test('IDD4 a multi-line out-of-scope declaration renders as one bullet (issue #439)', () => {
    const prompt = useCase().buildReviewerTaskPrompt({
      issueNumber: 439,
      outOfScope: ['Requiring a row per criterion. Label matching is free-form prose,\n  so coverage checking would create false refusals.']
    });
    const section = prompt.slice(prompt.indexOf('### Out of Scope Declarations:'), prompt.indexOf('### Delivered Evidence Contract'));
    assert.ok(section.includes('- Requiring a row per criterion. Label matching is free-form prose, so coverage checking would create false refusals.'));
    assert.ok(!section.includes('free-form prose,\n'));
  });

  test('IDD5 the reviewer prompt states only the AC_EVIDENCE coverage the review command enforces (issue #439)', () => {
    const prompt = useCase().buildReviewerTaskPrompt({ issueNumber: 439 });
    assert.ok(prompt.includes(REVIEWER_AC_EVIDENCE_SENTENCE));
    assert.ok(!prompt.includes('Every acceptance criterion the plan declares'));
  });

  test('IDD6 the AC_EVIDENCE contract names out-of-scope for a plan-declared operator step (#506 AC1)', () => {
    const prompt = useCase().buildReviewerTaskPrompt({ issueNumber: 506 });
    const contract = prompt.slice(
      prompt.indexOf('### Delivered Evidence Contract'),
      prompt.indexOf('### Required Verdict Output')
    );
    assert.ok(contract.includes(REVIEWER_AC_EVIDENCE_STATUS_CONTRACT));
    assert.ok(contract.includes('`out-of-scope`'));
    assert.ok(!contract.includes("If a criterion's only evidence lives outside the diff, report it `unverifiable` and name the path"));
  });

  test('IDD7 the reviewer prompt requires a reported deviation and never a silent edit (#437)', () => {
    const prompt = useCase().buildReviewerTaskPrompt({ issueNumber: 437 });
    assert.ok(prompt.includes('Discovered Plan Deviations (report, do not edit)'));
    assert.ok(prompt.includes('read-only'));
    assert.ok(prompt.includes(PLAN_DEVIATION_EXAMPLE));
    assert.ok(prompt.includes('The orchestrator files it'));
    assert.ok(prompt.includes('REVIEW and COMMIT'));
  });

  test('IDD8 the channel note states the accepted wire format (#451 AC1)', () => {
    const note = formatPlanDeviationChannelNote(451);
    assert.ok(note.includes(PLAN_DEVIATION_EXAMPLE));
  });
});
