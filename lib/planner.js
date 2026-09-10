/**
 * agyloop - Planning Subagent Definition & System Prompt Builder
 *
 * Defines the read-only Architectural Planning Subagent for Antigravity.
 * Strictly enforces physical write suppression (zero file creation, edits, or command execution)
 * while allowing read inspection tools and configurable MCP diagnostics.
 */

const fs = require('fs');
const path = require('path');
const { resolveModel, loadConfig } = require('./config');
const { fetchIssueContext, formatIssueForPrompt, getCurrentRepo } = require('./github');

const READ_ONLY_TOOLS = Object.freeze([
  'view_file',
  'grep_search',
  'find_by_name',
  'list_dir'
]);

const FORBIDDEN_WRITE_TOOLS = Object.freeze([
  'write_to_file',
  'replace_file_content',
  'run_command'
]);

const PLANNER_SUBAGENT_DEF = Object.freeze({
  name: 'planner',
  role: 'Architectural Planning Subagent',
  description:
    'Architectural reasoning, deep read-only inspection, and specification generation subagent',
  defaultTier: 'pro',
  tools: READ_ONLY_TOOLS,
  capabilities: Object.freeze({
    enable_write_tools: false,
    enable_subagent_tools: false,
    enable_mcp_tools: true
  })
});

/**
 * Loads the planner system prompt from prompts/planner.md with a fallback.
 *
 * @param {Object} [options]
 * @param {string} [options.promptPath] - Custom path to prompt markdown
 * @returns {string}
 */
function getPlannerSystemPrompt(options = {}) {
  const defaultPath = path.resolve(__dirname, '..', 'prompts', 'planner.md');
  const targetPath = options.promptPath || defaultPath;

  if (fs.existsSync(targetPath)) {
    try {
      return fs.readFileSync(targetPath, 'utf8');
    } catch (err) {
      console.warn(`Warning: Failed to read planner prompt from ${targetPath}:`, err.message);
    }
  }

  // Robust embedded fallback
  return `# AgyLoop Planning Subagent System Prompt\n\nYou are the AgyLoop Architectural Planning Subagent, an analytical, read-only software architect.\nYou are equipped strictly with read inspection tools (view_file, grep_search, find_by_name, list_dir).\nYou are physically incapable of modifying files. Your output is comprehensive technical plans following templates/discovery-plan.md and templates/implementation-plan.md.`;
}

/**
 * Resolves the complete subagent declaration object ready for Antigravity's define_subagent.
 *
 * @param {Object} [customConfig]
 * @returns {Object} Subagent definition descriptor
 */
function getPlannerDefinition(customConfig = null) {
  const config = customConfig || loadConfig();
  const resolved = resolveModel('planner', config);
  const enableMcp =
    config && config.options && typeof config.options.enableMcpInPlanner === 'boolean'
      ? config.options.enableMcpInPlanner
      : true;

  return {
    name: PLANNER_SUBAGENT_DEF.name,
    role: PLANNER_SUBAGENT_DEF.role,
    description: PLANNER_SUBAGENT_DEF.description,
    model: resolved.tier,
    apiModel: resolved.apiModel,
    tools: [...READ_ONLY_TOOLS],
    capabilities: {
      enable_write_tools: false,
      enable_subagent_tools: false,
      enable_mcp_tools: enableMcp
    },
    system_prompt: getPlannerSystemPrompt()
  };
}

/**
 * Assembles the execution task prompt for the planner subagent.
 *
 * @param {Object} params
 * @param {number|string} [params.issueNumber]
 * @param {string} [params.repo]
 * @param {string} [params.userInstructions]
 * @param {string} [params.workspaceDir]
 * @param {Object} [params.config]
 * @returns {string}
 */
function buildPlanningTaskPrompt(params = {}) {
  const workspaceDir = params.workspaceDir || process.cwd();
  const repo = params.repo || getCurrentRepo(workspaceDir);
  let issueContextBlock = '';

  if (params.issueNumber) {
    const issueData = fetchIssueContext(params.issueNumber, {
      repo,
      cwd: workspaceDir
    });
    if (issueData) {
      issueContextBlock = formatIssueForPrompt(issueData);
    }
  }

  let prompt = `# Task: Architectural Investigation & Plan Generation\n\n`;
  prompt += `You are executing the **PLAN** phase of the AgyLoop pair-programming lifecycle.\n`;
  prompt += `Your goal is to inspect the codebase, perform root-cause analysis (for defects) or architectural design (for features), and produce an actionable specification.\n\n`;

  prompt += `### Operating Constraints:\n`;
  prompt += `1. **Read-Only**: You have access strictly to inspection tools (${READ_ONLY_TOOLS.join(', ')}). Do not attempt to modify or write files.\n`;
  prompt += `2. **Empirical Verification**: Verify all file paths, exports, and call-sites before finalizing your design.\n`;
  prompt += `3. **Deliverable**: Create the technical specification in the \`artifacts/plans/\` directory matching the standard templates:\n`;
  prompt += `   - Defects/Bugs: \`templates/discovery-plan.md\`\n`;
  prompt += `   - Features/Tasks: \`templates/implementation-plan.md\`\n\n`;

  if (issueContextBlock) {
    prompt += `----------------------------------------------------------------------\n`;
    prompt += `${issueContextBlock}\n`;
    prompt += `----------------------------------------------------------------------\n\n`;
  }

  if (params.userInstructions) {
    prompt += `### User / Developer Directives:\n${params.userInstructions}\n\n`;
  }

  prompt += `### Expected Output Structure:\n`;
  prompt += `- **Summary & Acceptance Criteria**: Reiterate scope and clear completion criteria.\n`;
  prompt += `- **Architectural Impact**: Detailed breakdown of components, file paths, and potential regression vectors.\n`;
  prompt += `- **Implementation Checklist**: Numbered steps with file targets for the downstream \`implementer\` subagent.\n`;
  prompt += `- **Quality Gate Targets**: Precise automated test commands to verify the change.\n`;

  return prompt.trim();
}

module.exports = {
  READ_ONLY_TOOLS,
  FORBIDDEN_WRITE_TOOLS,
  PLANNER_SUBAGENT_DEF,
  getPlannerSystemPrompt,
  getPlannerDefinition,
  buildPlanningTaskPrompt
};
