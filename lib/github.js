/**
 * agyloop - GitHub Context Discovery Engine (Legacy Bridge)
 *
 * Bridges legacy calls to the compiled TypeScript CliGitHubGateway adapter.
 */

const { CliGitHubGateway } = require('../dist/infrastructure/cli-github-gateway');

const defaultGateway = new CliGitHubGateway();

function runGh(commandArgs, options = {}) {
  return defaultGateway.runGh(commandArgs, options);
}

function getCurrentRepo(workspaceDir = process.cwd()) {
  return defaultGateway.getCurrentRepo(workspaceDir);
}

function fetchIssueContext(issueNumber, options = {}) {
  return defaultGateway.fetchIssue(issueNumber, options);
}

function formatIssueForPrompt(issueData) {
  return CliGitHubGateway.formatIssueForPrompt(issueData);
}

module.exports = {
  runGh,
  getCurrentRepo,
  fetchIssueContext,
  formatIssueForPrompt
};
