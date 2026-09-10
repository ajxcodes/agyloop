/**
 * agyloop - Persistent Plan Generator & Templating Engine
 *
 * Manages persistent planning files in `artifacts/plans/`:
 * - Ensures `artifacts/plans/` exists and is tracked in `.gitignore`.
 * - Compiles standard templates:
 *     - `[Discovery] - {Title}.md` (bug root-cause analysis)
 *     - `[Implementation] - {Title}.md` (feature spec)
 *     - `AgyLoop Summary.md` (cumulative session execution run log)
 * - Manages plan scaffolding for issue-specific directories (`artifacts/plans/<issue>-<slug>/`).
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE_FILES = Object.freeze({
  DISCOVERY: 'discovery-plan.md',
  IMPLEMENTATION: 'implementation-plan.md',
  SUMMARY: 'summary-log.md'
});

const DEFAULT_TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

const FALLBACK_TEMPLATES = Object.freeze({
  [TEMPLATE_FILES.DISCOVERY]: `# [Discovery] - {Title}

**Issue:** #{IssueNumber}  
**Date:** {Date}  
**Author:** AgyLoop Planning Subagent (Read-Only)  

---

## 1. Problem Statement & Symptoms
- **Observed Behavior:**
- **Expected Behavior:**
- **Affected Components / Paths:**

## 2. Root Cause Analysis (RCA)
- **Investigation Steps:**
- **Identified Failure Mode:**
- **Relevant Code References:**

## 3. Reproduction Steps & Verification Protocol
- **Local Reproduction Command:**
- **Failing Test Target:**

## 4. Remediation Strategy
- **Recommended Fix Approach:**
- **Potential Regressions / Side Effects:**
`,

  [TEMPLATE_FILES.IMPLEMENTATION]: `# [Implementation] - {Title}

**Issue:** #{IssueNumber}  
**Date:** {Date}  
**Author:** AgyLoop Planning Subagent  
**Status:** DRAFT | APPROVED  

---

## 1. Context & Objectives
- **Feature Overview:**
- **Acceptance Criteria:**

## 2. Architectural Design & Impact
- **Component Breakdown:**
- **Data Flow / Model Invariants:**
- **Dependencies & Imports:**

## 3. Implementation Steps
- [ ] **Step 1:** 
- [ ] **Step 2:** 
- [ ] **Step 3:** 

## 4. Quality Gate & Test Verification
- **Automated Test Targets:**
- **Build / Lint Commands:**
- **Manual Verification Steps:**
`,

  [TEMPLATE_FILES.SUMMARY]: `# AgyLoop Execution Summary

**Project:** {ProjectName}  
**Active Issue:** #{IssueNumber}  
**Session Started:** {Timestamp}  

---

## Lifecycle Execution Log

| Stage | Subagent | Model | Status | Duration |
|---|---|---|---|---|
| 1. Discovery | \`planner\` | \`pro\` | PENDING | - |
| 2. Plan Review | Human Gate | - | PENDING | - |
| 3. Implementation | \`implementer\` | \`inherit\` | PENDING | - |
| 4. Quality Gate | \`gate\` | \`flash_lite\` | PENDING | - |
| 5. AI Review | \`reviewer\` | \`flash\` | PENDING | - |
| 6. Commit Gate | Human Gate | - | PENDING | - |

## Quality Gate Metrics
- **Build Status:** PENDING
- **Tests:** PENDING

## Review Notes
- Standards compliance verified against repository rules.
`
});

/**
 * Creates a URL- and directory-safe slug from arbitrary text.
 *
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Sanitizes a title string for use in filenames by stripping invalid characters.
 *
 * @param {string} title
 * @returns {string}
 */
function sanitizeFilename(title) {
  if (!title || typeof title !== 'string') return 'untitled';
  return title
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ensures `{projectRoot}/artifacts/plans/` exists and is listed in `{projectRoot}/.gitignore`.
 *
 * @param {string} [projectRoot=process.cwd()]
 * @returns {string} Absolute path to the plans directory
 */
function ensurePlanDirectory(projectRoot = process.cwd()) {
  const plansDir = path.resolve(projectRoot, 'artifacts', 'plans');
  if (!fs.existsSync(plansDir)) {
    fs.mkdirSync(plansDir, { recursive: true });
  }

  const gitignorePath = path.resolve(projectRoot, '.gitignore');
  const ignoreEntry = 'artifacts/plans/';

  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      const lines = content.split(/\r?\n/).map((l) => l.trim());
      const isIgnored = lines.some(
        (l) => l === 'artifacts/plans/' || l === 'artifacts/plans' || l === 'artifacts/' || l === 'artifacts'
      );
      if (!isIgnored) {
        const trailingNewline = content.endsWith('\n') ? '' : '\n';
        const entryToAdd = `${trailingNewline}\n# Antigravity Persistent Plans & Local State\n${ignoreEntry}\n`;
        fs.appendFileSync(gitignorePath, entryToAdd, 'utf8');
      }
    } catch (err) {
      console.warn('Warning: Could not update .gitignore:', err.message);
    }
  } else {
    try {
      const initialContent = `# Antigravity Persistent Plans & Local State\n${ignoreEntry}\n`;
      fs.writeFileSync(gitignorePath, initialContent, 'utf8');
    } catch (err) {
      console.warn('Warning: Could not create .gitignore:', err.message);
    }
  }

  return plansDir;
}

/**
 * Loads a template file from templates/ directory with fallback to embedded string.
 *
 * @param {string} templateFileName
 * @param {string} [customTemplatesDir]
 * @returns {string}
 */
function loadTemplate(templateFileName, customTemplatesDir = null) {
  const dir = customTemplatesDir || DEFAULT_TEMPLATES_DIR;
  const filePath = path.join(dir, templateFileName);

  if (fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.warn(`Warning: Failed to read template at ${filePath}:`, err.message);
    }
  }

  if (FALLBACK_TEMPLATES[templateFileName]) {
    return FALLBACK_TEMPLATES[templateFileName];
  }

  throw new Error(`Template not found: ${templateFileName}`);
}

/**
 * Replaces `{Key}` placeholders in a template string with values from variables dictionary.
 *
 * @param {string} templateContent
 * @param {Record<string, any>} [variables={}]
 * @returns {string}
 */
function renderTemplate(templateContent, variables = {}) {
  if (typeof templateContent !== 'string') return '';
  return templateContent.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key) && variables[key] !== null && variables[key] !== undefined) {
      return String(variables[key]);
    }
    return match;
  });
}

/**
 * Auto-detects whether an issue/task represents a bug discovery (RCA) or feature implementation.
 *
 * @param {Object} params
 * @param {string} [params.title]
 * @param {string[]} [params.labels]
 * @returns {'discovery' | 'implementation'}
 */
function detectPlanType({ title = '', labels = [] } = {}) {
  const bugKeywords = ['bug', 'defect', 'fix', 'rca', 'root-cause', 'regression', 'crash', 'error'];
  const titleLower = String(title).toLowerCase();

  const labelMatch = (labels || []).some((l) =>
    bugKeywords.some((kw) => String(l).toLowerCase().includes(kw))
  );

  const titleMatch = bugKeywords.some((kw) =>
    titleLower.includes(`[${kw}]`) || titleLower.includes(`${kw}:`) || titleLower.includes(`${kw}/`)
  );

  return (labelMatch || titleMatch) ? 'discovery' : 'implementation';
}

/**
 * Generates the technical plan markdown file.
 *
 * @param {Object} options
 * @param {string} options.targetDir - Destination directory
 * @param {'discovery' | 'implementation'} [options.type='implementation']
 * @param {string} [options.title='Plan']
 * @param {number|string} [options.issueNumber='']
 * @param {string} [options.date]
 * @param {Record<string, any>} [options.variables]
 * @param {boolean} [options.overwrite=false]
 * @param {boolean} [options.createMirror=true]
 * @param {string} [options.templatesDir]
 * @returns {{ planPath: string, mirrorPath: string|null, content: string, created: boolean }}
 */
function generatePlan(options = {}) {
  const {
    targetDir,
    type = 'implementation',
    title = 'Untitled Plan',
    issueNumber = '',
    date = new Date().toISOString().slice(0, 10),
    variables = {},
    overwrite = false,
    createMirror = true,
    templatesDir = null
  } = options;

  if (!targetDir) {
    throw new Error('targetDir is required to generate plan.');
  }

  const isDiscovery = type === 'discovery';
  const templateFileName = isDiscovery ? TEMPLATE_FILES.DISCOVERY : TEMPLATE_FILES.IMPLEMENTATION;
  const rawTemplate = loadTemplate(templateFileName, templatesDir);

  const mergedVariables = {
    Title: title,
    IssueNumber: issueNumber ? String(issueNumber) : 'N/A',
    Date: date,
    ...variables
  };

  const content = renderTemplate(rawTemplate, mergedVariables);

  const safeTitle = sanitizeFilename(title);
  const prefix = isDiscovery ? '[Discovery] - ' : '[Implementation] - ';
  const planFileName = `${prefix}${safeTitle}.md`;
  const planPath = path.join(targetDir, planFileName);

  let created = false;
  if (!fs.existsSync(planPath) || overwrite) {
    fs.writeFileSync(planPath, content, 'utf8');
    created = true;
  }

  let mirrorPath = null;
  if (createMirror) {
    mirrorPath = path.join(targetDir, 'implementation_plan.md');
    if (!fs.existsSync(mirrorPath) || overwrite) {
      fs.writeFileSync(mirrorPath, content, 'utf8');
    }
  }

  return { planPath, mirrorPath, content, created };
}

/**
 * Generates the cumulative session execution summary log (AgyLoop Summary.md).
 *
 * @param {Object} options
 * @param {string} options.targetDir - Destination directory
 * @param {string} [options.projectName]
 * @param {number|string} [options.issueNumber='']
 * @param {string} [options.timestamp]
 * @param {Record<string, any>} [options.variables]
 * @param {boolean} [options.overwrite=false]
 * @param {string} [options.templatesDir]
 * @returns {{ summaryPath: string, content: string, created: boolean }}
 */
function generateSummaryLog(options = {}) {
  const {
    targetDir,
    projectName = 'AgyLoop Project',
    issueNumber = '',
    timestamp = new Date().toISOString(),
    variables = {},
    overwrite = false,
    templatesDir = null
  } = options;

  if (!targetDir) {
    throw new Error('targetDir is required to generate summary log.');
  }

  const rawTemplate = loadTemplate(TEMPLATE_FILES.SUMMARY, templatesDir);
  const mergedVariables = {
    ProjectName: projectName,
    IssueNumber: issueNumber ? String(issueNumber) : 'N/A',
    Timestamp: timestamp,
    ...variables
  };

  const content = renderTemplate(rawTemplate, mergedVariables);
  const summaryPath = path.join(targetDir, 'AgyLoop Summary.md');

  let created = false;
  if (!fs.existsSync(summaryPath) || overwrite) {
    fs.writeFileSync(summaryPath, content, 'utf8');
    created = true;
  }

  return { summaryPath, content, created };
}

/**
 * Updates a specific stage row or metrics block in AgyLoop Summary.md.
 *
 * @param {string} summaryFilePath - Path to AgyLoop Summary.md
 * @param {Object} updateData
 * @param {string} [updateData.stage] - Stage name or substring (e.g. 'Discovery', 'Plan Review', 'Implementation', 'Quality Gate')
 * @param {string} [updateData.subagent]
 * @param {string} [updateData.model]
 * @param {string} [updateData.status]
 * @param {string} [updateData.duration]
 * @param {string} [updateData.buildStatus]
 * @param {string} [updateData.testsStatus]
 * @param {string} [updateData.reviewNote]
 * @returns {boolean} True if file was updated
 */
function updateSummaryLog(summaryFilePath, updateData = {}) {
  if (!fs.existsSync(summaryFilePath)) return false;

  let content = fs.readFileSync(summaryFilePath, 'utf8');

  // Update table row if stage specified
  if (updateData.stage) {
    const stageQuery = String(updateData.stage).toLowerCase();
    const lines = content.split('\n');
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('|') && !line.includes('---') && !line.includes('Stage | Subagent')) {
        const parts = line.split('|').map((p) => p.trim());
        // parts: ['', stageLabel, subagent, model, status, duration, '']
        if (parts.length >= 6) {
          const rowStage = parts[1].toLowerCase();
          if (rowStage.includes(stageQuery)) {
            const currentSubagent = updateData.subagent ? `\`${updateData.subagent}\`` : parts[2];
            const currentModel = updateData.model ? `\`${updateData.model}\`` : parts[3];
            const currentStatus = updateData.status ? updateData.status.toUpperCase() : parts[4];
            const currentDuration = updateData.duration ? updateData.duration : parts[5];

            lines[i] = `| ${parts[1]} | ${currentSubagent} | ${currentModel} | ${currentStatus} | ${currentDuration} |`;
            updated = true;
            break;
          }
        }
      }
    }

    if (updated) {
      content = lines.join('\n');
    }
  }

  // Update Quality Gate Metrics
  if (updateData.buildStatus) {
    content = content.replace(
      /- \*\*Build Status:\*\* .*/i,
      `- **Build Status:** ${updateData.buildStatus}`
    );
  }
  if (updateData.testsStatus) {
    content = content.replace(
      /- \*\*Tests:\*\* .*/i,
      `- **Tests:** ${updateData.testsStatus}`
    );
  }

  // Append review note if provided
  if (updateData.reviewNote) {
    if (content.includes('## Review Notes')) {
      content = content.replace(
        /## Review Notes([\s\S]*?)(?=\n##|$)/,
        (match) => `${match.trimEnd()}\n- ${updateData.reviewNote}\n`
      );
    }
  }

  fs.writeFileSync(summaryFilePath, content, 'utf8');
  return true;
}

/**
 * Scaffolds an issue-specific plan directory in artifacts/plans/<issue>-<slug>/
 * with appropriate discovery or implementation templates and execution summary.
 *
 * @param {Object} options
 * @param {string} [options.projectRoot=process.cwd()]
 * @param {number|string} [options.issue]
 * @param {string} [options.title]
 * @param {'discovery'|'implementation'|'auto'} [options.type='auto']
 * @param {string[]} [options.labels]
 * @param {string} [options.projectName]
 * @param {Record<string, any>} [options.variables]
 * @param {boolean} [options.overwrite=false]
 * @param {string} [options.templatesDir]
 * @returns {Object} Scaffolding result
 */
function scaffoldPlanDirectory(options = {}) {
  const {
    projectRoot = process.cwd(),
    issue = '',
    title = 'Task Plan',
    type = 'auto',
    labels = [],
    projectName,
    variables = {},
    overwrite = false,
    templatesDir = null
  } = options;

  const plansDir = ensurePlanDirectory(projectRoot);

  const resolvedType =
    type === 'auto' || !type ? detectPlanType({ title, labels }) : type;

  const titleSlug = slugify(title);
  const folderName = issue ? `${issue}-${titleSlug}` : titleSlug || 'ad-hoc-plan';
  const planDir = path.join(plansDir, folderName);

  if (!fs.existsSync(planDir)) {
    fs.mkdirSync(planDir, { recursive: true });
  }

  // Determine Project Name from package.json or git root basename
  let resolvedProject = projectName;
  if (!resolvedProject) {
    try {
      const pkgPath = path.join(projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name) resolvedProject = pkg.name;
      }
    } catch {
      // ignore
    }
    if (!resolvedProject) {
      resolvedProject = path.basename(projectRoot);
    }
  }

  const planResult = generatePlan({
    targetDir: planDir,
    type: resolvedType,
    title,
    issueNumber: issue,
    variables,
    overwrite,
    createMirror: true,
    templatesDir
  });

  const summaryResult = generateSummaryLog({
    targetDir: planDir,
    projectName: resolvedProject,
    issueNumber: issue,
    variables,
    overwrite,
    templatesDir
  });

  return {
    plansDir,
    planDir,
    folderName,
    type: resolvedType,
    planPath: planResult.planPath,
    mirrorPath: planResult.mirrorPath,
    summaryPath: summaryResult.summaryPath,
    created: {
      plan: planResult.created,
      summary: summaryResult.created
    }
  };
}

/**
 * Searches for an existing plan directory matching an issue number or prefix.
 *
 * @param {string} [projectRoot=process.cwd()]
 * @param {number|string} [issueNumber='']
 * @returns {string|null} Absolute path to plan directory or null if not found
 */
function findPlanDirectory(projectRoot = process.cwd(), issueNumber = '') {
  const plansDir = path.resolve(projectRoot, 'artifacts', 'plans');
  if (!fs.existsSync(plansDir) || !issueNumber) return null;

  const targetPrefix = `${issueNumber}-`;
  try {
    const entries = fs.readdirSync(plansDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && (entry.name === String(issueNumber) || entry.name.startsWith(targetPrefix))) {
        return path.join(plansDir, entry.name);
      }
    }
  } catch {
    // ignore
  }

  return null;
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
