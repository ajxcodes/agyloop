const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  READ_ONLY_TOOLS,
  FORBIDDEN_WRITE_TOOLS,
  GATE_TOOLS,
  PLANNER_SUBAGENT_DEF,
  GATE_SUBAGENT_DEF,
  ToolWhitelist,
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

  test('getImplementerSystemPrompt returns detailed instructions with write capabilities', () => {
    const prompt = resolveUseCase.getImplementerSystemPrompt();
    assert.ok(typeof prompt === 'string' && prompt.length > 300);
    assert.ok(prompt.includes('AgyLoop Code Implementation Subagent'));
    assert.ok(prompt.includes('Strict Plan Adherence') || prompt.includes('strictly adhering'));
    assert.ok(prompt.includes('replace_file_content'));
    assert.ok(prompt.includes('write_to_file'));
    assert.ok(prompt.includes('run_command'));
  });

  test('buildImplementationTaskPrompt formats focused token-minimized handoff prompt', () => {
    const prompt = resolveUseCase.buildImplementationTaskPrompt({
      planContent: '## Checklist\n- [ ] Step 1: Implement feature',
      planPath: 'artifacts/plans/16-task/implementation-plan.md',
      issueNumber: 16,
      issueTitle: 'Build Execution Pipeline',
      issueBody: 'Detailed issue description for pipeline.',
      userInstructions: 'Ensure strict typing.'
    });

    assert.ok(prompt.includes('# Task: Implementation Execution'));
    assert.ok(prompt.includes('Operating Constraints:'));
    assert.ok(prompt.includes('Issue Context (#16)'));
    assert.ok(prompt.includes('Build Execution Pipeline'));
    assert.ok(prompt.includes('Detailed issue description for pipeline.'));
    assert.ok(prompt.includes('Developer Directives:'));
    assert.ok(prompt.includes('Ensure strict typing.'));
    assert.ok(prompt.includes('Approved Technical Plan (implementation-plan.md)'));
    assert.ok(prompt.includes('Step 1: Implement feature'));
    assert.ok(prompt.includes('Definition of Done:'));
  });

  test('GATE_SUBAGENT_DEF enforces verification-only capabilities and flash_lite routing', () => {
    assert.strictEqual(GATE_SUBAGENT_DEF.name, 'gate');
    assert.strictEqual(GATE_SUBAGENT_DEF.role, 'Quality Gate Verification Subagent');
    assert.strictEqual(GATE_SUBAGENT_DEF.defaultTier, 'flash_lite');
    assert.strictEqual(GATE_SUBAGENT_DEF.capabilities.enable_write_tools, false);
    assert.strictEqual(GATE_SUBAGENT_DEF.capabilities.enable_subagent_tools, false);
    assert.strictEqual(GATE_SUBAGENT_DEF.capabilities.enable_mcp_tools, false);
    assert.deepStrictEqual([...GATE_SUBAGENT_DEF.tools], ['run_command', 'view_file']);
  });

  test('ToolWhitelist.gate() strictly permits run_command and view_file and rejects write_to_file', () => {
    const whitelist = ToolWhitelist.gate();
    assert.strictEqual(whitelist.isAllowed('run_command'), true);
    assert.strictEqual(whitelist.isAllowed('view_file'), true);
    assert.strictEqual(whitelist.isAllowed('write_to_file'), false);
    assert.strictEqual(whitelist.isAllowed('replace_file_content'), false);
    assert.strictEqual(whitelist.hasForbiddenWriteTools(), true); // contains run_command which is modifying
    assert.throws(() => whitelist.assertAllowed('write_to_file'));
  });

  test('getGateSystemPrompt returns comprehensive guidance with log shielding mandate', () => {
    const prompt = resolveUseCase.getGateSystemPrompt();
    assert.ok(typeof prompt === 'string' && prompt.length > 500);
    assert.ok(prompt.includes('AgyLoop Quality Gate Verification Subagent'));
    assert.ok(prompt.includes('Verification-Only Mandate'));
    assert.ok(prompt.includes('Log Isolation & Shielding Mandate'));
    assert.ok(prompt.includes('run_command'));
    assert.ok(prompt.includes('view_file'));
    assert.ok(prompt.includes('Structured Reporting'));
  });

  test('getGateDefinition integrates with config and resolves model tier', () => {
    const customConfig = {
      models: {
        planner: 'gemini-3.5-pro',
        implementer: 'inherit',
        gate: 'gemini-3.5-flash-lite',
        reviewer: 'flash'
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: 300,
        autoApproveInYolo: true,
        enableMcpInPlanner: false
      }
    };

    const def = resolveUseCase.execute({ role: 'gate', customConfig });
    assert.strictEqual(def.name, 'gate');
    assert.strictEqual(def.model, 'flash_lite');
    assert.strictEqual(def.apiModel, 'gemini-3.5-flash-lite');
    assert.strictEqual(def.capabilities.enable_mcp_tools, false);
    assert.strictEqual(def.capabilities.enable_write_tools, false);
    assert.strictEqual(def.capabilities.enable_subagent_tools, false);
    assert.deepStrictEqual([...def.tools], ['run_command', 'view_file']);
  });

  test('buildGateTaskPrompt formats verification directives and command list', () => {
    const prompt = resolveUseCase.buildGateTaskPrompt({
      issueNumber: 20,
      commands: ['npm run typecheck', 'npm test'],
      userInstructions: 'Verify strict hexagonal boundaries.'
    });

    assert.ok(prompt.includes('# Task: Quality Gate Verification'));
    assert.ok(prompt.includes('Operating Constraints:'));
    assert.ok(prompt.includes('Active Issue: #20'));
    assert.ok(prompt.includes('1. `npm run typecheck`'));
    assert.ok(prompt.includes('2. `npm test`'));
    assert.ok(prompt.includes('Developer Directives:'));
    assert.ok(prompt.includes('Verify strict hexagonal boundaries.'));
    assert.ok(prompt.includes('Required Verdict Output:'));
  });
});

