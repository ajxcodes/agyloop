/**
 * agyloop - Persistent Plan Generator & Templating Engine (Legacy Bridge)
 *
 * Bridges legacy calls to the compiled TypeScript FilePlanGenerator adapter.
 */

const {
  FilePlanGenerator,
  FALLBACK_TEMPLATES
} = require('../dist/infrastructure/file-plan-generator');
const { TEMPLATE_FILES } = require('../dist/domain');

const defaultGenerator = new FilePlanGenerator();

function slugify(text) {
  return defaultGenerator.slugify(text);
}

function sanitizeFilename(name) {
  return defaultGenerator.sanitizeFilename(name);
}

function ensurePlanDirectory(projectRoot = process.cwd()) {
  return defaultGenerator.ensurePlanDirectory(projectRoot);
}

function findPlanDirectory(projectRoot, issueNumber) {
  return defaultGenerator.findPlanDirectory(projectRoot, issueNumber);
}

function loadTemplate(templateName, customTemplatesDir = null) {
  return defaultGenerator.loadTemplate(templateName, customTemplatesDir);
}

function renderTemplate(templateContent, variables = {}) {
  return defaultGenerator.renderTemplate(templateContent, variables);
}

function detectPlanType(paramsOrTitle = {}, maybeLabels = []) {
  if (typeof paramsOrTitle === 'string') {
    return defaultGenerator.detectPlanType(paramsOrTitle, maybeLabels);
  }
  const { title = '', labels = [] } = paramsOrTitle || {};
  return defaultGenerator.detectPlanType(title, labels);
}

function generatePlan(options = {}) {
  return defaultGenerator.generatePlan(options);
}

function generateSummaryLog(options = {}) {
  return defaultGenerator.generateSummaryLog(options);
}

function updateSummaryLog(summaryFilePath, updateData = {}) {
  return defaultGenerator.updateSummaryLog(summaryFilePath, updateData);
}

function scaffoldPlanDirectory(params = {}) {
  return defaultGenerator.scaffoldPlanDirectory(params);
}

module.exports = {
  TEMPLATE_FILES,
  FALLBACK_TEMPLATES,
  slugify,
  sanitizeFilename,
  ensurePlanDirectory,
  findPlanDirectory,
  loadTemplate,
  renderTemplate,
  detectPlanType,
  generatePlan,
  generateSummaryLog,
  updateSummaryLog,
  scaffoldPlanDirectory
};
