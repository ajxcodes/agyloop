/**
 * agyloop - Implementer smoke directive tests (issue #388, Defect 3 / was #386)
 *
 * ISD1 - a plan with a frozen smoke section renders `### Manual Smoke Test
 *        Protocol (frozen at dispatch)`, every check body verbatim, and its label
 *        + plan line
 * ISD2 - a plan with no section renders the exact prohibition, so an
 *        implementer can never be expected to invent a protocol
 * ISD3 - the Definition of Done names the plan's literal assertions, its
 *        IK/decision table and every frozen smoke check
 * ISD4 - the #379 round-1 regression: `crash on login` is copied verbatim and
 *        `crash: on login` never appears, because a unit test may not restate a
 *        frozen literal with different punctuation
 * ISD5 - a declared but non-executable protocol states that the gate owns it
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { ResolveSubagentUseCase } = require('../../dist/application');

const FENCE = String.fromCharCode(96, 96, 96);
const PROHIBITION = 'Do not claim smoke results; the gate owns the protocol.';

function planWithSmoke(checks: string[], extra: string[] = []): string {
  return [
    '# [Implementation] - directive probe',
    '',
    ...extra,
    '## 3. Implementation Steps',
    '- [ ] **Step 1:** classify',
    '',
    '### Manual Smoke Test Protocol',
    '',
    ...checks,
    ''
  ].join('\n');
}

describe('Implementer smoke directive (issue #388)', () => {
  const useCase = new ResolveSubagentUseCase({});

  test('ISD1: the frozen checks reach the implementer verbatim, with label and plan line', () => {
    const first = 'node -e \'require("node:assert").strictEqual("crash on login", "crash on login")\'';
    const second = 'node -e \'console.log("second check")\'';
    const plan = planWithSmoke([
      '**Check A — classifier**',
      '',
      `${FENCE}bash`,
      first,
      FENCE,
      '',
      '**Check B — second**',
      '',
      `${FENCE}bash`,
      second,
      FENCE
    ]);

    const prompt = useCase.buildImplementationTaskPrompt({ issueNumber: 388, planContent: plan });

    assert.ok(prompt.includes('### Manual Smoke Test Protocol (frozen at dispatch)'), prompt);
    assert.ok(prompt.includes(first), prompt);
    assert.ok(prompt.includes(second), prompt);
    assert.ok(prompt.includes('Check A — classifier'), prompt);
    assert.match(prompt, /\(plan line \d+\)/);
    assert.ok(prompt.includes('Run each check exactly as written, in order'), prompt);
    assert.ok(prompt.includes('codeloop'), prompt);
  });

  test('ISD2: a plan with no protocol renders the prohibition, not invented checks', () => {
    const prompt = useCase.buildImplementationTaskPrompt({
      issueNumber: 388,
      planContent: '# [Implementation] - empty\n\n## 3. Implementation Steps\n- [ ] **Step 1:** hold\n'
    });

    assert.ok(prompt.includes('### Manual Smoke Test Protocol'), prompt);
    assert.ok(prompt.includes(PROHIBITION), prompt);
    assert.ok(prompt.includes('Do not invent checks'), prompt);
    assert.ok(prompt.includes('codeloop'), prompt);
    assert.ok(!prompt.includes('(frozen at dispatch)'), prompt);

    // An empty plan control keeps the same prohibition.
    const absent = useCase.buildImplementationTaskPrompt({ issueNumber: 388 });
    assert.ok(absent.includes(PROHIBITION), absent);
  });

  test('ISD3: the Definition of Done names literal assertions, the IK table and frozen smoke checks', () => {
    const prompt = useCase.buildImplementationTaskPrompt({ issueNumber: 388 });

    assert.ok(prompt.includes('Definition of Done:'), prompt);
    assert.ok(prompt.includes('literal assertions'), prompt);
    assert.ok(prompt.includes('IK/decision table'), prompt);
    assert.ok(prompt.includes('frozen smoke check'), prompt);
    assert.ok(prompt.includes('do not restate a literal with different punctuation'), prompt);
  });

  test('ISD4: the #379 `crash on login` fixture is copied, never restated with a colon', () => {
    const plan = planWithSmoke(
      [
        `${FENCE}bash`,
        'node -e \'require("node:assert").strictEqual(require("./dist/domain").detectIssueKind({ title: "crash on login" }).kind, "bug")\'',
        FENCE
      ],
      [
        '## 4. Quality Gate & Test Verification',
        '',
        '| ID | Asserts |',
        '|---|---|',
        '| IK-4 | `crash on login` becomes a bug |',
        ''
      ]
    );

    const prompt = useCase.buildImplementationTaskPrompt({ issueNumber: 388, planContent: plan });

    assert.ok(prompt.includes('crash on login'), prompt);
    assert.ok(!prompt.includes('crash: on login'), 'the directive restated a literal with different punctuation');
    assert.ok(prompt.includes('IK-4'), prompt);
  });

  test('ISD5: a declared but non-executable protocol says the gate owns it', () => {
    const plan = planWithSmoke([
      `${FENCE}bash`,
      'node -e \'require("fs").writeFileSync(".agyloop/tasks/388.json", "{}")\'',
      FENCE
    ]);

    const prompt = useCase.buildImplementationTaskPrompt({ issueNumber: 388, planContent: plan });

    assert.ok(prompt.includes('### Manual Smoke Test Protocol (frozen at dispatch)'), prompt);
    assert.ok(prompt.includes('NOT executable as written'), prompt);
    assert.ok(prompt.includes(PROHIBITION), prompt);
    assert.ok(prompt.includes('missing-parent-directory'), prompt);
  });

  test('ISD6: an explicit smokeProtocol wins over the plan text', () => {
    const { SmokeProtocol } = require('../../dist/domain');
    const explicit = SmokeProtocol.fromPlan(
      planWithSmoke([`${FENCE}bash`, 'echo explicit-check', FENCE])
    );

    const prompt = useCase.buildImplementationTaskPrompt({
      issueNumber: 388,
      planContent: '# [Implementation] - no smoke here\n',
      smokeProtocol: explicit
    });

    assert.ok(prompt.includes('echo explicit-check'), prompt);
    assert.ok(prompt.includes('### Manual Smoke Test Protocol (frozen at dispatch)'), prompt);
  });
});
