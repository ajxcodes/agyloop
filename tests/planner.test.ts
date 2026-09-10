const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  READ_ONLY_TOOLS,
  FORBIDDEN_WRITE_TOOLS,
  PLANNER_SUBAGENT_DEF,
  ResolveSubagentUseCase,
  FileConfigRepository
} = require('../dist');

const configRepo = new FileConfigRepository();
const resolveUseCase = new ResolveSubagentUseCase(configRepo);

describe('Planning Subagent Definition & Safety Guarantees (TypeScript)', () => {
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
        (PLANNER_SUBAGENT_DEF.tools as readonly string[]).includes(forbidden),
        false,
        `Forbidden write tool '${forbidden}' must not be present in planner toolset.`
      );
    }
  });

  test('getPlannerSystemPrompt returns comprehensive guidance with key architectural invariants', () => {
    const prompt = resolveUseCase.getPlannerSystemPrompt();
    assert.ok(typeof prompt === 'string' && prompt.length > 500);
    assert.ok(prompt.includes('AgyLoop Architectural Planning Subagent'));
    assert.ok(prompt.includes('Zero Source Code Modifications'));
    assert.ok(prompt.includes('Root-Cause Analysis (RCA)'));
    assert.ok(prompt.includes('templates/discovery-plan.md'));
    assert.ok(prompt.includes('templates/implementation-plan.md'));
    assert.ok(prompt.includes('view_file'));
  });

  test('getPlannerDefinition integrates with config and resolves model tier', () => {
    const customConfig = {
      models: {
        planner: 'gemini-3.5-pro',
        implementer: 'inherit',
        gate: 'flash_lite',
        reviewer: 'flash'
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: 300,
        autoApproveInYolo: true,
        enableMcpInPlanner: false
      }
    };

    const def = resolveUseCase.execute({ customConfig });
    assert.strictEqual(def.name, 'planner');
    assert.strictEqual(def.model, 'pro');
    assert.strictEqual(def.apiModel, 'gemini-3.5-pro');
    assert.strictEqual(def.capabilities.enable_mcp_tools, false);
    assert.strictEqual(def.capabilities.enable_write_tools, false);
    assert.ok(def.tools.includes('view_file'));
    assert.ok(def.tools.includes('grep_search'));
  });

  test('buildPlanningTaskPrompt formats execution directives and user instructions', () => {
    const prompt = resolveUseCase.buildPlanningTaskPrompt({
      userInstructions: 'Refactor database client to use connection pooling.'
    });

    assert.ok(prompt.includes('# Task: Architectural Investigation & Plan Generation'));
    assert.ok(prompt.includes('Operating Constraints:'));
    assert.ok(prompt.includes('User / Developer Directives:'));
    assert.ok(prompt.includes('Refactor database client to use connection pooling.'));
  });
});
