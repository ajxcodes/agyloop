/**
 * codeloop - Dispatched prompt host neutrality (issue #241, D6 slice 1)
 *
 * HN1 - no dispatched prompt names an Antigravity-only tool identifier
 * HN2 - each prompt names the capabilities it needs via the shared formatter
 * HN3 - the anti-inception guardrail names no harness subagent tool
 * HN4 - positive control: the Antigravity ASSETS still name Antigravity tools
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ResolveSubagentUseCase,
  GATE_SUBAGENT_DEF
} = require('../../dist/application');
const {
  DEFAULT_CONFIG,
  FileConfigRepository,
  FilePromptRepository
} = require('../../dist/infrastructure');
const {
  ANTI_INCEPTION_GUARDRAIL,
  DEFAULT_GATE_SYSTEM_PROMPT,
  DEFAULT_PLANNER_SYSTEM_PROMPT,
  IMPLEMENTER_TOOLS,
  PLANNER_TOOLS,
  formatToolProse,
  TOOL_CAPABILITY_READ,
  TOOL_CAPABILITY_SEARCH,
  TOOL_CAPABILITY_LIST,
  TOOL_CAPABILITY_WRITE,
  TOOL_CAPABILITY_EDIT,
  TOOL_CAPABILITY_SHELL
} = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const AGY_TOOL_IDENTIFIER =
  /\b(view_file|grep_search|find_by_name|list_dir|write_to_file|replace_file_content|run_command)\b/;
const OC_BACKTICKED_IDENTIFIER = /`(read|grep|glob|list|write|edit|shell)`/;

/**
 * A workspace with no `prompts/` directory: the repository must fall back to the
 * embedded default, which is what "the Antigravity asset by default" means when
 * the operator's tree has no asset on disk.
 */
function emptyWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-290-'));
}

function hostAwareUseCase(): InstanceType<typeof ResolveSubagentUseCase> {
  return new ResolveSubagentUseCase(
    new FileConfigRepository(),
    undefined,
    new FilePromptRepository()
  );
}

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

  test('HN6: a configured host renders both the dispatched prompt and the system prompt for that host (AC2)', () => {
    const useCase = hostAwareUseCase();

    for (const host of ['antigravity', 'opencode']) {
      const config = { ...DEFAULT_CONFIG, runner: host };
      const dispatched = useCase.buildPlanningTaskPrompt({ issueNumber: 290, config });
      const systemPrompt = useCase.execute({
        role: 'implementer',
        customConfig: config,
        workspaceDir: PROJECT_ROOT
      }).system_prompt;

      for (const [surface, text] of [
        ['dispatched', dispatched],
        ['system', systemPrompt]
      ] as [string, string][]) {
        if (host === 'opencode') {
          assert.strictEqual(
            AGY_TOOL_IDENTIFIER.test(text),
            false,
            `the ${host} ${surface} prompt must not name an Antigravity tool:\n${text}`
          );
        } else {
          assert.strictEqual(
            OC_BACKTICKED_IDENTIFIER.test(text),
            false,
            `the ${host} ${surface} prompt must not name an OpenCode tool:\n${text}`
          );
        }
      }

      if (host === 'opencode') {
        assert.ok(
          dispatched.includes('your harness-provided read, grep, glob, write and edit tools'),
          `the opencode dispatched prompt must name OpenCode's tools:\n${dispatched}`
        );
        assert.ok(systemPrompt.includes('in OpenCode'), systemPrompt);
      } else {
        assert.ok(
          dispatched.includes(
            'your harness-provided view_file, grep_search, list_dir, write_to_file and replace_file_content tools'
          ),
          `the antigravity dispatched prompt must name Antigravity's tools:\n${dispatched}`
        );
        assert.ok(systemPrompt.includes('in Google Antigravity'), systemPrompt);
      }
    }
  });

  test('HN7: the antigravity render names no OpenCode identifier (AC2)', () => {
    const useCase = hostAwareUseCase();

    const antigravity = useCase.execute({
      role: 'implementer',
      customConfig: { ...DEFAULT_CONFIG, runner: 'antigravity' },
      workspaceDir: PROJECT_ROOT
    }).system_prompt;
    assert.ok(antigravity.includes('in Google Antigravity'), antigravity);
    assert.strictEqual(OC_BACKTICKED_IDENTIFIER.test(antigravity), false, antigravity);

    const opencode = useCase.execute({
      role: 'implementer',
      customConfig: { ...DEFAULT_CONFIG, runner: 'opencode' },
      workspaceDir: PROJECT_ROOT
    }).system_prompt;
    assert.ok(opencode.includes('in OpenCode'), opencode);
    assert.strictEqual(AGY_TOOL_IDENTIFIER.test(opencode), false, opencode);
  });

  test('HN8: execute() translates the whitelist and the system prompt for the selected host (AC3)', () => {
    const useCase = hostAwareUseCase();

    const opencode = useCase.execute({
      role: 'implementer',
      customConfig: { ...DEFAULT_CONFIG, runner: 'opencode' },
      workspaceDir: PROJECT_ROOT
    });
    assert.deepStrictEqual([...opencode.tools], ['read', 'grep', 'glob', 'write', 'edit', 'shell']);

    const antigravity = useCase.execute({
      role: 'implementer',
      customConfig: { ...DEFAULT_CONFIG, runner: 'antigravity' },
      workspaceDir: PROJECT_ROOT
    });
    assert.deepStrictEqual([...antigravity.tools], [...IMPLEMENTER_TOOLS]);

    const gate = useCase.execute({
      role: 'gate',
      customConfig: { ...DEFAULT_CONFIG, runner: 'opencode' },
      workspaceDir: PROJECT_ROOT
    });
    assert.deepStrictEqual([...gate.tools], ['shell', 'read']);
  });

  test('HN9: an unresolved host keeps the Antigravity default and the neutral dispatched prose (AC4)', () => {
    const useCase = hostAwareUseCase();
    const workspace = emptyWorkspace();
    try {
      const def = useCase.execute({
        role: 'planner',
        customConfig: { ...DEFAULT_CONFIG, runner: 'auto' },
        workspaceDir: workspace
      });
      assert.deepStrictEqual([...def.tools], [...PLANNER_TOOLS]);
      assert.strictEqual(def.system_prompt, DEFAULT_PLANNER_SYSTEM_PROMPT);

      const prompt = useCase.buildPlanningTaskPrompt({
        issueNumber: 290,
        config: { ...DEFAULT_CONFIG, runner: 'auto' }
      });
      assert.ok(
        prompt.includes('your harness-provided read, search, list, write and edit tools'),
        `the neutral dispatched prose must survive an unresolved host:\n${prompt}`
      );
      assert.strictEqual(AGY_TOOL_IDENTIFIER.test(prompt), false, prompt);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('HN10: the planner renders its dispatched prompt and its system prompt from the same host vocabulary (AC2)', () => {
    const useCase = hostAwareUseCase();

    for (const host of ['antigravity', 'opencode']) {
      const config = { ...DEFAULT_CONFIG, runner: host };
      const dispatched = useCase.buildPlanningTaskPrompt({ issueNumber: 290, config });
      const systemPrompt = useCase.execute({
        role: 'planner',
        customConfig: config,
        workspaceDir: PROJECT_ROOT
      }).system_prompt;

      assert.ok(dispatched.includes('your harness-provided'), dispatched);
      assert.ok(systemPrompt.includes('CodeLoop Architectural Planning Subagent'), systemPrompt);

      if (host === 'opencode') {
        assert.ok(
          dispatched.includes('your harness-provided read, grep, glob, write and edit tools'),
          `the opencode dispatched planner prompt must name OpenCode's tools:\n${dispatched}`
        );
        assert.strictEqual(
          AGY_TOOL_IDENTIFIER.test(dispatched),
          false,
          `the opencode dispatched planner prompt must not name an Antigravity tool:\n${dispatched}`
        );
        assert.ok(systemPrompt.includes('in OpenCode'), systemPrompt);
        assert.ok(systemPrompt.includes('(`read`, `grep`, `glob`)'), systemPrompt);
        assert.strictEqual(
          AGY_TOOL_IDENTIFIER.test(systemPrompt),
          false,
          `the opencode system planner prompt must not name an Antigravity tool:\n${systemPrompt}`
        );
      } else {
        assert.ok(
          dispatched.includes(
            'your harness-provided view_file, grep_search, list_dir, write_to_file and replace_file_content tools'
          ),
          `the antigravity dispatched planner prompt must name Antigravity's tools:\n${dispatched}`
        );
        assert.strictEqual(
          OC_BACKTICKED_IDENTIFIER.test(dispatched),
          false,
          `the antigravity dispatched planner prompt must not name an OpenCode tool:\n${dispatched}`
        );
        assert.ok(systemPrompt.includes('in Google Antigravity'), systemPrompt);
        assert.ok(
          systemPrompt.includes('(`view_file`, `grep_search`, `find_by_name`, `list_dir`)'),
          systemPrompt
        );
        assert.strictEqual(
          OC_BACKTICKED_IDENTIFIER.test(systemPrompt),
          false,
          `the antigravity system planner prompt must not name an OpenCode tool:\n${systemPrompt}`
        );
      }
    }
  });
});
