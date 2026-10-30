/**
 * agyloop - Dispatched prompt host neutrality (issue #241, D6 slice 1)
 *
 * HN1 - no dispatched prompt names an Antigravity-only tool identifier
 * HN2 - each prompt names the capabilities it needs via the shared formatter
 * HN3 - the anti-inception guardrail names no harness subagent tool
 * HN4 - positive control: the Antigravity ASSETS still name Antigravity tools
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  ResolveSubagentUseCase,
  GATE_SUBAGENT_DEF
} = require('../../dist/application');
const {
  ANTI_INCEPTION_GUARDRAIL,
  DEFAULT_GATE_SYSTEM_PROMPT,
  formatToolProse,
  TOOL_CAPABILITY_READ,
  TOOL_CAPABILITY_SEARCH,
  TOOL_CAPABILITY_LIST,
  TOOL_CAPABILITY_WRITE,
  TOOL_CAPABILITY_EDIT,
  TOOL_CAPABILITY_SHELL
} = require('../../dist/domain');

const AGY_TOOL_IDENTIFIER =
  /\b(view_file|grep_search|find_by_name|list_dir|write_to_file|replace_file_content|run_command)\b/;

function allTaskPrompts(): Map<string, string> {
  const useCase = new ResolveSubagentUseCase({});
  return new Map([
    ['discovery', useCase.buildDiscoveryTaskPrompt({ issueNumber: 241 })],
    ['planning', useCase.buildPlanningTaskPrompt({ issueNumber: 241 })],
    ['implementation', useCase.buildImplementationTaskPrompt({ issueNumber: 241 })],
    ['gate', useCase.buildGateTaskPrompt({ issueNumber: 241, planPath: '/tmp/plan.md' })],
    ['reviewer', useCase.buildReviewerTaskPrompt({ issueNumber: 241 })],
    ['triage', useCase.buildTriageTaskPrompt({ issueNumber: 241 })]
  ]);
}

describe('Dispatched prompt host neutrality (issue #241, D6)', () => {
  test('HN1: no dispatched task prompt names an Antigravity-only tool', () => {
    for (const [name, prompt] of allTaskPrompts()) {
      const match = prompt.match(AGY_TOOL_IDENTIFIER);
      assert.strictEqual(
        match,
        null,
        `the ${name} prompt must not name Antigravity's '${match ? match[0] : ''}'`
      );
    }
  });

  test('HN2: each prompt names the capabilities it needs through the shared formatter', () => {
    const prompts = allTaskPrompts();
    const expected = new Map<string, string[]>([
      [
        'discovery',
        [formatToolProse([TOOL_CAPABILITY_READ, TOOL_CAPABILITY_SEARCH, TOOL_CAPABILITY_LIST, TOOL_CAPABILITY_WRITE, TOOL_CAPABILITY_EDIT], { plural: true })]
      ],
      [
        'planning',
        [formatToolProse([TOOL_CAPABILITY_READ, TOOL_CAPABILITY_SEARCH, TOOL_CAPABILITY_LIST, TOOL_CAPABILITY_WRITE, TOOL_CAPABILITY_EDIT], { plural: true })]
      ],
      [
        'implementation',
        [
          formatToolProse([TOOL_CAPABILITY_EDIT]),
          formatToolProse([TOOL_CAPABILITY_WRITE]),
          formatToolProse([TOOL_CAPABILITY_SHELL])
        ]
      ],
      [
        'gate',
        [
          formatToolProse([TOOL_CAPABILITY_SHELL, TOOL_CAPABILITY_READ], { plural: true }),
          formatToolProse([TOOL_CAPABILITY_READ])
        ]
      ],
      [
        'reviewer',
        [
          formatToolProse([TOOL_CAPABILITY_READ, TOOL_CAPABILITY_SEARCH, TOOL_CAPABILITY_LIST, TOOL_CAPABILITY_SHELL], { plural: true }),
          formatToolProse([TOOL_CAPABILITY_SHELL])
        ]
      ],
      ['triage', [formatToolProse([TOOL_CAPABILITY_SHELL])]]
    ]);

    for (const [name, phrases] of expected) {
      const prompt = prompts.get(name)!;
      for (const phrase of phrases) {
        assert.ok(
          prompt.includes(phrase),
          `the ${name} prompt must contain "${phrase}", got:\n${prompt}`
        );
      }
    }

    assert.ok(
      prompts.get('discovery')!.includes('your harness-provided read, search, list, write and edit tools'),
      'the neutral prose must read as prose, not as host identifiers'
    );
  });

  test('HN3: the anti-inception guardrail names no harness subagent tool', () => {
    assert.strictEqual(ANTI_INCEPTION_GUARDRAIL.includes('invoke_subagent'), false);
    assert.strictEqual(ANTI_INCEPTION_GUARDRAIL.includes('define_subagent'), false);
    for (const prompt of allTaskPrompts().values()) {
      assert.ok(prompt.includes(ANTI_INCEPTION_GUARDRAIL));
    }
  });

  test('HN4: the Antigravity assets still name Antigravity tools (out of slice 1)', () => {
    assert.deepStrictEqual([...GATE_SUBAGENT_DEF.tools], ['run_command', 'view_file']);
    assert.ok(DEFAULT_GATE_SYSTEM_PROMPT.includes('run_command'));
  });

  test('HN5: the implementer smoke directive names codeloop, never the deprecated launcher (#388)', () => {
    const prompt = new ResolveSubagentUseCase({}).buildImplementationTaskPrompt({
      issueNumber: 388
    });

    assert.ok(prompt.includes('codeloop'), prompt);
    assert.ok(prompt.includes('Do not claim smoke results; the gate owns the protocol.'), prompt);
    assert.strictEqual(
      /(?:^|[\s`])(?:bin\/)?agyloop\s+(?:transition|implement|next|plan|commit|review|status)\b/.test(
        prompt
      ),
      false,
      'the directive must not instruct an operator to run the deprecated launcher'
    );
  });
});
