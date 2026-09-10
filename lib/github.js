/**
 * agyloop - GitHub Context Discovery Engine
 *
 * Interacts with GitHub CLI (`gh`) to discover issue, pull request,
 * and repository context. Strictly bypasses dummy environment tokens
 * to utilize the authenticated local keyring.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Executes a GitHub CLI command safely with empty GITHUB_TOKEN to use local keyring.
 *
 * @param {string} commandArgs - Command arguments string for `gh`
 * @param {Object} [options]
 * @param {string} [options.cwd]
 * @returns {string} Standard output
 */
function runGh(commandArgs, options = {}) {
  const cwd = options.cwd || process.cwd();
  // Prefix with env GITHUB_TOKEN='' to bypass dummy environment tokens and use local keyring
  const cmd = `env GITHUB_TOKEN='' gh ${commandArgs}`;
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GITHUB_TOKEN: ''
    }
  }).trim();
}

/**
 * Resolves the active GitHub repository slug (e.g. 'owner/repo') from git remotes or package.json.
 *
 * @param {string} [workspaceDir]
 * @returns {string|null}
 */
function getCurrentRepo(workspaceDir = process.cwd()) {
  // 1. Try git remote
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: workspaceDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  } catch (err) {
    // Git command failed, try package.json fallback
  }

  // 2. Try package.json repository field
  const pkgPath = path.join(workspaceDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
      if (repoUrl) {
        const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
        if (match) {
          return `${match[1]}/${match[2]}`;
        }
      }
    } catch (e) {
      // Ignore read error
    }
  }

  return null;
}

/**
 * Fetches structured issue details from GitHub via `gh`.
 *
 * @param {number|string} issueNumber
 * @param {Object} [options]
 * @param {string} [options.repo] - Target repository slug ('owner/repo')
 * @param {string} [options.cwd] - Working directory
 * @returns {Object|null} Issue metadata or null if fetch fails
 */
function fetchIssueContext(issueNumber, options = {}) {
  if (!issueNumber) return null;

  const repo = options.repo || getCurrentRepo(options.cwd);
  const repoFlag = repo ? `--repo ${repo}` : '';

  try {
    // We use explicit JSON fields to avoid deprecated GraphQL fields like projectCards
    const rawJson = runGh(
      `issue view ${issueNumber} ${repoFlag} --json number,title,body,labels,comments`,
      options
    );
    const parsed = JSON.parse(rawJson);
    return {
      repo: repo || 'unknown',
      number: parsed.number || issueNumber,
      title: parsed.title || '',
      body: parsed.body || '',
      labels: (parsed.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      comments: (parsed.comments || []).map((c) => ({
        author: (c.author && c.author.login) || 'unknown',
        body: c.body || '',
        createdAt: c.createdAt
      }))
    };
  } catch (err) {
    return {
      error: err.message,
      repo: repo || 'unknown',
      number: issueNumber
    };
  }
}

/**
 * Formats fetched issue context into a clear Markdown block for prompt injection.
 *
 * @param {Object} issueData
 * @returns {string}
 */
function formatIssueForPrompt(issueData) {
  if (!issueData) return '';
  if (issueData.error) {
    return `### Associated GitHub Issue: #${issueData.number} (Repository: ${issueData.repo})\n*(Warning: Unable to fetch live issue details: ${issueData.error})*\n`;
  }

  const labelBadge = issueData.labels.length > 0 ? issueData.labels.join(', ') : 'None';
  let formatted = `### Active Issue: #${issueData.number} - ${issueData.title}\n`;
  formatted += `- **Repository:** \`${issueData.repo}\`\n`;
  formatted += `- **Labels:** ${labelBadge}\n\n`;
  formatted += `#### Description:\n${issueData.body || '*(No description provided)*'}\n`;

  if (issueData.comments && issueData.comments.length > 0) {
    formatted += `\n#### Discussion & Comments (${issueData.comments.length}):\n`;
    issueData.comments.forEach((c, idx) => {
      formatted += `> **@${c.author}** (${c.createdAt || 'recent'}):\n`;
      const quotedBody = (c.body || '').split('\n').map((line) => `> ${line}`).join('\n');
      formatted += `${quotedBody}\n\n`;
    });
  }

  return formatted.trim();
}

module.exports = {
  runGh,
  getCurrentRepo,
  fetchIssueContext,
  formatIssueForPrompt
};
