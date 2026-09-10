/**
 * agyloop - Planning Subagent Definition & System Prompt Builder (Legacy Bridge)
 *
 * Bridges legacy calls to the compiled TypeScript domain and application modules.
 */

const {
  READ_ONLY_TOOLS,
  FORBIDDEN_WRITE_TOOLS
} = require('../dist/domain');
const {
  ResolveSubagentUseCase,
  PLANNER_SUBAGENT_DEF
} = require('../dist/application/resolve-subagent');
const { FileConfigRepository } = require('../dist/infrastructure/file-config-repository');
const { CliGitHubGateway } = require('../dist/infrastructure/cli-github-gateway');

const configRepo = new FileConfigRepository();
const githubGateway = new CliGitHubGateway();
const useCase = new ResolveSubagentUseCase(configRepo, githubGateway);

function getPlannerSystemPrompt(options = {}) {
  return useCase.getPlannerSystemPrompt(options);
}

function getPlannerDefinition(customConfig = null) {
  return useCase.execute({ customConfig });
}

function buildPlanningTaskPrompt(params = {}) {
  return useCase.buildPlanningTaskPrompt(params);
}

module.exports = {
  READ_ONLY_TOOLS,
  FORBIDDEN_WRITE_TOOLS,
  PLANNER_SUBAGENT_DEF,
  getPlannerSystemPrompt,
  getPlannerDefinition,
  buildPlanningTaskPrompt
};
