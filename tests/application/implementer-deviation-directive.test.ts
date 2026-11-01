/**
 * agyloop - implementer/reviewer deviation contract (issue #432, TR-41/42)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { ResolveSubagentUseCase } = require('../../dist/application');

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
});
