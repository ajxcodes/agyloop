/**
 * agyloop - Host tool vocabulary (issue #290, D6 slice 2)
 *
 * HV1  - the registry has one entry per RunnerType and auto is unresolved
 * HV2  - the antigravity vocabulary names exactly the seven Antigravity identifiers
 * HV3  - the opencode vocabulary names exactly read, grep, glob, write, edit and shell
 * HV4  - translating the implementer whitelist for opencode collapses find_by_name and list_dir into glob
 * HV5  - translation is the identity for antigravity and for an unresolved host
 * HV6  - formatToolProse without a vocabulary keeps the host-neutral sentence
 * HV7  - formatToolProse with a vocabulary names that host's tools
 * HV8  - renderSystemPromptForHost is byte-identical for antigravity and for an unresolved host
 * HV9  - rendering the discovery default for opencode removes every Antigravity identifier and collapses the duplicate glob
 * HV10 - the write-tool banner summary is derived from the vocabulary
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  HOST_TOOL_VOCABULARIES,
  ANTIGRAVITY_TOOL_VOCABULARY,
  OPENCODE_TOOL_VOCABULARY,
  RUNNER_TYPES,
  resolveHostToolVocabulary,
  translateToolName,
  translateToolNames,
  renderSystemPromptForHost,
  formatWriteCapabilitySummary,
  formatToolProse,
  DEFAULT_DISCOVERY_SYSTEM_PROMPT,
  DEFAULT_PLANNER_SYSTEM_PROMPT,
  DEFAULT_IMPLEMENTER_SYSTEM_PROMPT,
  DEFAULT_GATE_SYSTEM_PROMPT,
  DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT,
  IMPLEMENTER_TOOLS,
  GATE_TOOLS,
  REVIEWER_TOOLS,
  TOOL_CAPABILITY_READ,
  TOOL_CAPABILITY_SEARCH,
  TOOL_CAPABILITY_LIST,
  TOOL_CAPABILITY_WRITE,
  TOOL_CAPABILITY_EDIT
} = require('../../dist/domain');

const AGY_TOOL_IDENTIFIER =
  /\b(view_file|grep_search|find_by_name|list_dir|write_to_file|replace_file_content|multi_replace_file_content|run_command)\b/;
const OC_BACKTICKED_IDENTIFIER = /`(read|grep|glob|list|write|edit|shell)`/;

const FIVE_CAPABILITIES = [
  TOOL_CAPABILITY_READ,
  TOOL_CAPABILITY_SEARCH,
  TOOL_CAPABILITY_LIST,
  TOOL_CAPABILITY_WRITE,
  TOOL_CAPABILITY_EDIT
];

describe('Host tool vocabulary (issue #290, D6 slice 2)', () => {
  test('HV1: the registry has one entry per RunnerType and auto is unresolved', () => {
    assert.deepStrictEqual(Object.keys(HOST_TOOL_VOCABULARIES).sort(), [...RUNNER_TYPES].sort());
    assert.strictEqual(HOST_TOOL_VOCABULARIES.auto, null);
    assert.strictEqual(HOST_TOOL_VOCABULARIES.antigravity, ANTIGRAVITY_TOOL_VOCABULARY);
    assert.strictEqual(HOST_TOOL_VOCABULARIES.opencode, OPENCODE_TOOL_VOCABULARY);

    assert.strictEqual(Object.isFrozen(HOST_TOOL_VOCABULARIES), true, 'the registry must be frozen');
    assert.strictEqual(Object.isFrozen(ANTIGRAVITY_TOOL_VOCABULARY), true, 'the Antigravity vocabulary must be frozen');
    assert.strictEqual(Object.isFrozen(OPENCODE_TOOL_VOCABULARY), true, 'the OpenCode vocabulary must be frozen');
    assert.strictEqual(Object.isFrozen(ANTIGRAVITY_TOOL_VOCABULARY.tools), true, 'the Antigravity tools map must be frozen');
    assert.strictEqual(Object.isFrozen(OPENCODE_TOOL_VOCABULARY.tools), true, 'the OpenCode tools map must be frozen');
  });

  test('HV2: the antigravity vocabulary names exactly the seven Antigravity identifiers', () => {
    assert.deepStrictEqual(
      { ...ANTIGRAVITY_TOOL_VOCABULARY.tools },
      {
        read: 'view_file',
        search: 'grep_search',
        list: 'list_dir',
        write: 'write_to_file',
        edit: 'replace_file_content',
        shell: 'run_command'
      }
    );
    assert.deepStrictEqual(
      [...translateToolNames(IMPLEMENTER_TOOLS, ANTIGRAVITY_TOOL_VOCABULARY)],
      [...IMPLEMENTER_TOOLS],
      'translation for the Antigravity surface must be the identity, find_by_name included'
    );
  });

  test('HV3: the opencode vocabulary names exactly read, grep, glob, write, edit and shell', () => {
    assert.deepStrictEqual(
      new Set(Object.values(OPENCODE_TOOL_VOCABULARY.tools)),
      new Set(['read', 'grep', 'glob', 'write', 'edit', 'shell'])
    );
    for (const name of Object.values(OPENCODE_TOOL_VOCABULARY.tools)) {
      assert.strictEqual(
        AGY_TOOL_IDENTIFIER.test(String(name)),
        false,
        `the OpenCode vocabulary must not name the Antigravity tool '${name}'`
      );
    }
  });

  test('HV4: translating the implementer whitelist for opencode collapses find_by_name and list_dir into glob', () => {
    assert.deepStrictEqual(
      [...translateToolNames(IMPLEMENTER_TOOLS, OPENCODE_TOOL_VOCABULARY)],
      ['read', 'grep', 'glob', 'write', 'edit', 'shell']
    );
    assert.deepStrictEqual(
      [...translateToolNames(GATE_TOOLS, OPENCODE_TOOL_VOCABULARY)],
      ['shell', 'read']
    );
  });

  test('HV5: translation is the identity for antigravity and for an unresolved host', () => {
    for (const vocabulary of [null, undefined]) {
      assert.deepStrictEqual(
        [...translateToolNames(REVIEWER_TOOLS, vocabulary)],
        [...REVIEWER_TOOLS]
      );
    }
    assert.strictEqual(translateToolName('mcp_custom_tool', OPENCODE_TOOL_VOCABULARY), 'mcp_custom_tool');
    assert.strictEqual(resolveHostToolVocabulary(undefined), null);
    assert.strictEqual(resolveHostToolVocabulary(null), null);
    assert.strictEqual(resolveHostToolVocabulary('auto'), null);
    assert.strictEqual(resolveHostToolVocabulary('nonsense'), null);
    assert.strictEqual(resolveHostToolVocabulary(' OpenCode '), OPENCODE_TOOL_VOCABULARY);
  });

  test('HV6: formatToolProse without a vocabulary keeps the host-neutral sentence', () => {
    assert.strictEqual(
      formatToolProse(FIVE_CAPABILITIES, { plural: true }),
      'your harness-provided read, search, list, write and edit tools'
    );
  });

  test('HV7: formatToolProse with a vocabulary names that host\'s tools', () => {
    assert.strictEqual(
      formatToolProse(FIVE_CAPABILITIES, { plural: true, vocabulary: OPENCODE_TOOL_VOCABULARY }),
      'your harness-provided read, grep, glob, write and edit tools'
    );
    assert.strictEqual(
      formatToolProse(FIVE_CAPABILITIES, { plural: true, vocabulary: ANTIGRAVITY_TOOL_VOCABULARY }),
      'your harness-provided view_file, grep_search, list_dir, write_to_file and replace_file_content tools'
    );
  });

  test('HV8: renderSystemPromptForHost is byte-identical for antigravity and for an unresolved host', () => {
    const prompts = [
      DEFAULT_DISCOVERY_SYSTEM_PROMPT,
      DEFAULT_PLANNER_SYSTEM_PROMPT,
      DEFAULT_IMPLEMENTER_SYSTEM_PROMPT,
      DEFAULT_GATE_SYSTEM_PROMPT,
      DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT
    ];

    for (const prompt of prompts) {
      assert.strictEqual(renderSystemPromptForHost(prompt, null), prompt);
      assert.strictEqual(renderSystemPromptForHost(prompt, undefined), prompt);
      assert.strictEqual(renderSystemPromptForHost(prompt, ANTIGRAVITY_TOOL_VOCABULARY), prompt);
    }
  });

  test('HV9: rendering the discovery default for opencode removes every Antigravity identifier and collapses the duplicate glob', () => {
    const rendered = renderSystemPromptForHost(DEFAULT_DISCOVERY_SYSTEM_PROMPT, OPENCODE_TOOL_VOCABULARY);
    const stripped = rendered.replace(/`/g, '');

    assert.strictEqual(AGY_TOOL_IDENTIFIER.test(rendered), false, `an Antigravity identifier survived:\n${rendered}`);
    assert.strictEqual(stripped.includes('glob, glob'), false, `the duplicate glob survived:\n${rendered}`);
    assert.ok(stripped.includes('(read, grep, glob)'), rendered);
    assert.ok(stripped.includes('(write, edit)'), rendered);
    assert.ok(rendered.includes('in OpenCode'), rendered);
    assert.strictEqual(OC_BACKTICKED_IDENTIFIER.test(rendered), true, 'the OpenCode identifiers must stay backticked');
  });

  test('HV10: the write-tool banner summary is derived from the vocabulary', () => {
    assert.strictEqual(formatWriteCapabilitySummary(OPENCODE_TOOL_VOCABULARY), 'write, edit, shell');
    assert.strictEqual(formatWriteCapabilitySummary(ANTIGRAVITY_TOOL_VOCABULARY), 'write_to_file, replace_file_content, run_command');
    assert.strictEqual(formatWriteCapabilitySummary(null), 'write_to_file, replace_file_content, run_command');
  });
});
