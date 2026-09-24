const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  READ_ONLY_TOOLS,
  PLANNER_TOOLS,
  FORBIDDEN_WRITE_TOOLS,
  GATE_TOOLS,
  REVIEWER_TOOLS,
  PLANNER_SUBAGENT_DEF,
  GATE_SUBAGENT_DEF,
  REVIEWER_SUBAGENT_DEF,
  ToolWhitelist,
  ResolveSubagentUseCase,
  FileConfigRepository
} = require('../dist');


const configRepo = new FileConfigRepository();
const resolveUseCase = new ResolveSubagentUseCase(configRepo);

describe('Planning Subagent Definition & Safety Guarantees (TypeScript)', () => {
  test('PLANNER_SUBAGENT_DEF enforces scoped write permissions for plans', () => {
    assert.strictEqual(PLANNER_SUBAGENT_DEF.name, 'planner');
    assert.strictEqual(PLANNER_SUBAGENT_DEF.role, 'Architectural Planning Subagent');
    assert.strictEqual(PLANNER_SUBAGENT_DEF.capabilities.enable_write_tools, true);
    assert.strictEqual(PLANNER_SUBAGENT_DEF.capabilities.enable_subagent_tools, false);
    assert.strictEqual(PLANNER_SUBAGENT_DEF.capabilities.enable_mcp_tools, true);
  });

  test('Tool whitelist permits read inspection tools and scoped plan writing tools', () => {
    assert.deepStrictEqual(
      [...PLANNER_SUBAGENT_DEF.tools],
      ['view_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content']
    );

    assert.strictEqual(
      (PLANNER_SUBAGENT_DEF.tools as readonly string[]).includes('run_command'),
      false,
      "Forbidden write/execution tool 'run_command' must not be present in planner toolset."
    );
  });

  test('getPlannerSystemPrompt returns comprehensive guidance with key architectural invariants', () => {
    const prompt = resolveUseCase.getPlannerSystemPrompt();
    assert.ok(typeof prompt === 'string' && prompt.length > 500);
    assert.ok(prompt.includes('AgyLoop Architectural Planning Subagent'));
    assert.ok(prompt.includes('Scoped File Modifications (Plans Only)'));
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
    assert.strictEqual(def.capabilities.enable_write_tools, true);
    assert.ok(def.tools.includes('view_file'));
    assert.ok(def.tools.includes('grep_search'));
    assert.ok(def.tools.includes('write_to_file'));
    assert.ok(def.tools.includes('replace_file_content'));
  });

  test('buildPlanningTaskPrompt formats execution directives and user instructions', () => {
    const prompt = resolveUseCase.buildPlanningTaskPrompt({
      userInstructions: 'Refactor database client to use connection pooling.'
    });

    assert.ok(prompt.includes('# Task: Architectural Investigation & Plan Generation'));
    assert.ok(prompt.includes('Operating Constraints:'));
    assert.ok(prompt.includes('Scoped Write Access'));
    assert.ok(prompt.includes('artifacts/plans/'));
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

  test('REVIEWER_SUBAGENT_DEF enforces read-only inspection and flash routing', () => {
    assert.strictEqual(REVIEWER_SUBAGENT_DEF.name, 'reviewer');
    assert.strictEqual(REVIEWER_SUBAGENT_DEF.role, 'AI Reviewer Subagent');
    assert.strictEqual(REVIEWER_SUBAGENT_DEF.defaultTier, 'flash');
    assert.strictEqual(REVIEWER_SUBAGENT_DEF.capabilities.enable_write_tools, false);
    assert.strictEqual(REVIEWER_SUBAGENT_DEF.capabilities.enable_subagent_tools, false);
    assert.strictEqual(REVIEWER_SUBAGENT_DEF.capabilities.enable_mcp_tools, false);
    assert.deepStrictEqual(
      [...REVIEWER_SUBAGENT_DEF.tools],
      ['view_file', 'grep_search', 'find_by_name', 'list_dir', 'run_command']
    );
  });

  test('ToolWhitelist.reviewer() permits inspection tools and run_command', () => {
    const whitelist = ToolWhitelist.reviewer();
    assert.strictEqual(whitelist.isAllowed('view_file'), true);
    assert.strictEqual(whitelist.isAllowed('grep_search'), true);
    assert.strictEqual(whitelist.isAllowed('find_by_name'), true);
    assert.strictEqual(whitelist.isAllowed('list_dir'), true);
    assert.strictEqual(whitelist.isAllowed('run_command'), true);
    assert.strictEqual(whitelist.isAllowed('write_to_file'), false);
    assert.strictEqual(whitelist.isAllowed('replace_file_content'), false);
  });

  test('getReviewerSystemPrompt returns comprehensive guidance with verdict tokens', () => {
    const prompt = resolveUseCase.getReviewerSystemPrompt();
    assert.ok(prompt.includes('# AgyLoop AI Reviewer Subagent System Prompt'));
    assert.ok(prompt.includes('REVIEW_STATUS: APPROVED | CHANGES_REQUESTED'));
    assert.ok(prompt.includes('UNFULFILLED_AC:'));
    assert.ok(prompt.includes('REMEDIATION_GUIDANCE:'));
  });

  test('getReviewerDefinition integrates with config and resolves model tier', () => {
    const def = resolveUseCase.execute({ role: 'reviewer' });
    assert.strictEqual(def.name, 'reviewer');
    assert.strictEqual(def.model, 'flash');
    assert.strictEqual(def.apiModel, 'gemini-3.5-flash');
    assert.strictEqual(def.capabilities.enable_write_tools, false);
    assert.strictEqual(def.capabilities.enable_subagent_tools, false);
    assert.strictEqual(def.capabilities.enable_mcp_tools, false);
    assert.deepStrictEqual(
      [...def.tools],
      ['view_file', 'grep_search', 'find_by_name', 'list_dir', 'run_command']
    );
  });

  test('buildReviewerTaskPrompt formats review directives, AC, and standards', () => {
    const prompt = resolveUseCase.buildReviewerTaskPrompt({
      issueNumber: 28,
      issueTitle: 'Build Reviewer Subagent',
      acceptanceCriteria: ['AC 1: Whitelist read-only', 'AC 2: Standards ingestion'],
      standardsContent: '# Standards\nRule: Hexagonal only.',
      workingDiff: '+export const REVIEWER = true;',
      userInstructions: 'Zero magic numbers.'
    });

    assert.ok(prompt.includes('# Task: Code Review & Standards Verification'));
    assert.ok(prompt.includes('Active Issue: #28'));
    assert.ok(prompt.includes('Build Reviewer Subagent'));
    assert.ok(prompt.includes('1. AC 1: Whitelist read-only'));
    assert.ok(prompt.includes('2. AC 2: Standards ingestion'));
    assert.ok(prompt.includes('# Standards\nRule: Hexagonal only.'));
    assert.ok(prompt.includes('+export const REVIEWER = true;'));
    assert.ok(prompt.includes('Zero magic numbers.'));
    assert.ok(prompt.includes('REVIEW_STATUS: APPROVED | CHANGES_REQUESTED'));
  });

  test('buildImplementationTaskPrompt fetches and formats issue details from githubGateway when title/body are omitted', () => {
    const mockGithub = {
      getCurrentRepo: () => 'ajxcodes/agyloop',
      fetchIssue: (num: number) => ({
        repo: 'ajxcodes/agyloop',
        number: num,
        title: 'Resolved Issue Title from Gateway',
        body: 'Resolved issue description from GitHub gateway.',
        labels: ['bug'],
        comments: [],
        state: 'OPEN'
      })
    };
    const useCaseWithGithub = new ResolveSubagentUseCase(configRepo, mockGithub as any);
    const prompt = useCaseWithGithub.buildImplementationTaskPrompt({
      planContent: '## Checklist\n- [ ] Step 1',
      issueNumber: 85
    });

    assert.ok(prompt.includes('Active Issue: #85 - Resolved Issue Title from Gateway'));
    assert.ok(prompt.includes('Resolved issue description from GitHub gateway.'));
    assert.ok(prompt.includes('Approved Technical Plan'));
  });

  test('buildImplementationTaskPrompt omits the "Approved Technical Plan" section when planContent is empty', () => {
    const promptWithoutPlan = resolveUseCase.buildImplementationTaskPrompt({
      planContent: '',
      issueNumber: 85,
      issueTitle: 'Some Title'
    });
    assert.strictEqual(promptWithoutPlan.includes('Approved Technical Plan'), false);

    const promptWithWhitespacePlan = resolveUseCase.buildImplementationTaskPrompt({
      planContent: '   \n  \n  ',
      issueNumber: 85,
      issueTitle: 'Some Title'
    });
    assert.strictEqual(promptWithWhitespacePlan.includes('Approved Technical Plan'), false);
  });

  test('buildReviewerTaskPrompt fetches and formats issue details from githubGateway when title/body are omitted', () => {
    const mockGithub = {
      getCurrentRepo: () => 'ajxcodes/agyloop',
      fetchIssue: (num: number) => ({
        repo: 'ajxcodes/agyloop',
        number: num,
        title: 'Review Issue Title from Gateway',
        body: 'Review issue description from GitHub gateway.',
        labels: ['enhancement'],
        comments: [],
        state: 'OPEN'
      })
    };
    const useCaseWithGithub = new ResolveSubagentUseCase(configRepo, mockGithub as any);
    const prompt = useCaseWithGithub.buildReviewerTaskPrompt({
      issueNumber: 85
    });

    assert.ok(prompt.includes('Active Issue: #85 - Review Issue Title from Gateway'));
    assert.ok(prompt.includes('Review issue description from GitHub gateway.'));
  });
});


