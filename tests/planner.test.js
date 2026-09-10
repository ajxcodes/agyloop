const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  READ_ONLY_TOOLS,
  FORBIDDEN_WRITE_TOOLS,
  PLANNER_SUBAGENT_DEF,
  getPlannerSystemPrompt,
  getPlannerDefinition,
  buildPlanningTaskPrompt
} = require('../lib/planner');

describe('Planning Subagent Definition & Safety Guarantees', () => {
  test('PLANNER_SUBAGENT_DEF enforces physical write suppression', () => {
    assert.strictEqual(PLANNER_SUBAGENT_DEF.name, 'planner');
    assert.strictEqual(PLANNER_SUBAGENT_DEF.role, 'Architectural Planning Subagent');
    assert.strictEqual(PLANNER_SUBAGENT_DEF.capabilities.enable_write_tools, false);
    assert.strictEqual(PLANNER_SUBAGENT_DEF.capabilities.enable_subagent_tools, false);
    assert.strictEqual(PLANNER_SUBAGENT_DEF.capabilities.enable_mcp_tools, true);
  });

  test('Tool whitelist strictly permits read inspection tools and forbids write/modifying tools', () => {
    assert.deepStrictEqual(
      [...PLANNER_SUBAGENT_DEF.tools],
      ['view_file', 'grep_search', 'find_by_name', 'list_dir']
    );

    for (const forbidden of FORBIDDEN_WRITE_TOOLS) {
      assert.strictEqual(
        PLANNER_SUBAGENT_DEF.tools.includes(forbidden),
        false,
        `Forbidden write tool '${forbidden}' must not be present in planner toolset.`
      );
    }
  });

  test('getPlannerSystemPrompt returns comprehensive guidance with key architectural invariants', () => {
    const prompt = getPlannerSystemPrompt();
    assert.ok(typeof prompt === 'string' && prompt.length > 500);
    assert.ok(prompt.includes('AgyLoop Architectural Planning Subagent'));
    assert.ok(prompt.includes('Zero Source Code Modifications'));
    assert.ok(prompt.includes('Root-Cause Analysis (RCA)'));
    assert.ok(prompt.includes('templates/discovery-plan.md'));
    assert.ok(prompt.includes('templates/implementation-plan.md'));
    assert.ok(prompt.includes('view_file'));
  });

  test('getPlannerDefinition integrates with config and resolves model tier', () => {
    const defaultDef = getPlannerDefinition();
    assert.strictEqual(defaultDef.name, 'planner');
    assert.strictEqual(defaultDef.model, 'pro');
    assert.strictEqual(defaultDef.capabilities.enable_write_tools, false);
    assert.strictEqual(defaultDef.capabilities.enable_mcp_tools, true);
    assert.ok(defaultDef.system_prompt.length > 0);

    // Test with custom config override
    const customConfig = {
      models: { planner: 'flash' },
      options: { enableMcpInPlanner: false }
    };
    const customDef = getPlannerDefinition(customConfig);
    assert.strictEqual(customDef.model, 'flash');
    assert.strictEqual(customDef.capabilities.enable_mcp_tools, false);
  });

  test('buildPlanningTaskPrompt formats execution directives and user instructions', () => {
    const prompt = buildPlanningTaskPrompt({
      userInstructions: 'Refactor database query optimization'
    });

    assert.ok(prompt.includes('Task: Architectural Investigation & Plan Generation'));
    assert.ok(prompt.includes('Read-Only'));
    assert.ok(prompt.includes('Refactor database query optimization'));
    assert.ok(prompt.includes('templates/implementation-plan.md'));
  });
});
