/**
 * agyloop - FilePlanGenerator Infrastructure Adapter
 *
 * Implements PlanGeneratorPort to manage artifacts/plans/ directory initialization,
 * .gitignore safety enforcement, template compilation, and execution run logs.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PlanGeneratorPort,
  ScaffoldParams,
  ScaffoldResult,
  SummaryUpdateData,
  GeneratePlanOptions,
  GeneratePlanResult,
  GenerateSummaryLogOptions,
  GenerateSummaryLogResult,
  ResolvePlanOptions,
  ResolvedPlanLocation
} from '../ports';
import {
  DEFAULT_PLANS_DIR,
  DEFAULT_SUMMARY_FILENAME,
  TEMPLATE_DISCOVERY,
  TEMPLATE_IMPLEMENTATION,
  TEMPLATE_SUMMARY,
  DEFAULT_TEMPLATES_DIRNAME,
  TEMPLATE_FILES,
  CANDIDATE_PLAN_FILENAMES
} from '../domain';

export const FALLBACK_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  [TEMPLATE_DISCOVERY]: `# [Discovery] - {Title}

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

  [TEMPLATE_IMPLEMENTATION]: `# [Implementation] - {Title}

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

  [TEMPLATE_SUMMARY]: `# AgyLoop Execution Summary

**Project:** {ProjectName}  
**Active Issue:** #{IssueNumber}  
**Session Started:** {Timestamp}  

---

## Lifecycle Execution Log

| Stage | Subagent | Model | Status | Duration |
|---|---|---|---|---|
| 1. Discovery | \`planner\` | \`pro\` | COMPLETED | - |
| 2. Plan Review | Human Gate | - | APPROVED | - |
| 3. Implementation | \`implementer\` | \`inherit\` | COMPLETED | - |
| 4. Quality Gate | \`gate\` | \`flash_lite\` | PASSED | - |
| 5. AI Review | \`reviewer\` | \`flash\` | APPROVED | - |
| 6. Commit Gate | Human Gate | - | PENDING | - |

## Quality Gate Metrics
- **Build Status:** PASSED
- **Tests:** 100% passing

## Review Notes
- Standards compliance verified against repository rules.
`
});

export class FilePlanGenerator implements PlanGeneratorPort {
  private readonly defaultTemplatesDir: string;

  constructor(options: { defaultTemplatesDir?: string } = {}) {
    this.defaultTemplatesDir =
      options.defaultTemplatesDir ||
      path.resolve(__dirname, '..', '..', DEFAULT_TEMPLATES_DIRNAME);
  }

  public slugify(text: string): string {
    if (!text || typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  public sanitizeFilename(title: string): string {
    if (!title || typeof title !== 'string') return 'untitled';
    return title
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  public ensurePlanDirectory(projectRoot: string = process.cwd()): string {
    const plansDir = path.resolve(projectRoot, DEFAULT_PLANS_DIR);
    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }

    // Enforce .gitignore tracking
    const gitignorePath = path.resolve(projectRoot, '.gitignore');
    const ignoreEntry = `${DEFAULT_PLANS_DIR}/`;

    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, `# Antigravity Persistent Plans\n${ignoreEntry}\n`, 'utf8');
    } else {
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      const lines = gitignoreContent.split(/\r?\n/).map((l) => l.trim());
      const isIgnored = lines.some((l) => l === ignoreEntry || l === DEFAULT_PLANS_DIR);

      if (!isIgnored) {
        const separator = gitignoreContent.endsWith('\n') ? '' : '\n';
        fs.appendFileSync(
          gitignorePath,
          `${separator}\n# Antigravity Persistent Plans\n${ignoreEntry}\n`,
          'utf8'
        );
      }
    }

    return plansDir;
  }

  public loadTemplate(templateName: string, customTemplatesDir?: string | null): string {
    const dir = customTemplatesDir || this.defaultTemplatesDir;
    const templatePath = path.join(dir, templateName);

    if (fs.existsSync(templatePath)) {
      try {
        return fs.readFileSync(templatePath, 'utf8');
      } catch {
        // Fall back to embedded
      }
    }

    if (FALLBACK_TEMPLATES[templateName]) {
      return FALLBACK_TEMPLATES[templateName];
    }

    throw new Error(`Template not found: ${templateName}`);
  }

  public renderTemplate(templateContent: string, variables: Record<string, unknown> = {}): string {
    if (typeof templateContent !== 'string') return '';
    return templateContent.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
      if (
        Object.prototype.hasOwnProperty.call(variables, key) &&
        variables[key] !== null &&
        variables[key] !== undefined
      ) {
        return String(variables[key]);
      }
      return match;
    });
  }

  public detectPlanType(
    titleOrParams: string | { title?: string; labels?: readonly string[] } = '',
    maybeLabels: readonly string[] = []
  ): 'discovery' | 'implementation' {
    let title = '';
    let labels: readonly string[] = maybeLabels;

    if (typeof titleOrParams === 'string') {
      title = titleOrParams;
    } else if (titleOrParams && typeof titleOrParams === 'object') {
      title = titleOrParams.title || '';
      labels = titleOrParams.labels || maybeLabels;
    }

    const bugKeywords = ['bug', 'defect', 'fix', 'rca', 'root-cause', 'regression', 'crash', 'error'];
    const titleLower = String(title).toLowerCase();

    const labelMatch = (labels || []).some((l) =>
      bugKeywords.some((kw) => String(l).toLowerCase().includes(kw))
    );

    const titleMatch = bugKeywords.some((kw) =>
      titleLower.includes(`[${kw}]`) || titleLower.includes(`${kw}:`) || titleLower.includes(`${kw}/`)
    );

    return labelMatch || titleMatch ? 'discovery' : 'implementation';
  }

  public generatePlan(options: GeneratePlanOptions): GeneratePlanResult {
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
    const rawTemplate = this.loadTemplate(templateFileName, templatesDir);

    const mergedVariables: Record<string, unknown> = {
      Title: title,
      IssueNumber: issueNumber ? String(issueNumber) : 'N/A',
      Date: date,
      ...variables
    };

    const content = this.renderTemplate(rawTemplate, mergedVariables);
    const safeTitle = this.sanitizeFilename(title);
    const prefix = isDiscovery ? '[Discovery] - ' : '[Implementation] - ';
    const planFileName = `${prefix}${safeTitle}.md`;
    const planPath = path.join(targetDir, planFileName);

    let created = false;
    if (!fs.existsSync(planPath) || overwrite) {
      fs.writeFileSync(planPath, content, 'utf8');
      created = true;
    }

    let mirrorPath: string | null = null;
    if (createMirror) {
      mirrorPath = path.join(targetDir, 'implementation_plan.md');
      if (!fs.existsSync(mirrorPath) || overwrite) {
        fs.writeFileSync(mirrorPath, content, 'utf8');
      }
    }

    return { planPath, mirrorPath, content, created };
  }

  public generateSummaryLog(options: GenerateSummaryLogOptions): GenerateSummaryLogResult {
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

    const rawTemplate = this.loadTemplate(TEMPLATE_FILES.SUMMARY, templatesDir);
    const mergedVariables: Record<string, unknown> = {
      ProjectName: projectName,
      IssueNumber: issueNumber ? String(issueNumber) : 'N/A',
      Timestamp: timestamp,
      ...variables
    };

    const content = this.renderTemplate(rawTemplate, mergedVariables);
    const summaryPath = path.join(targetDir, DEFAULT_SUMMARY_FILENAME);

    let created = false;
    if (!fs.existsSync(summaryPath) || overwrite) {
      fs.writeFileSync(summaryPath, content, 'utf8');
      created = true;
    }

    return { summaryPath, content, created };
  }

  public scaffoldPlanDirectory(params: ScaffoldParams = {}): ScaffoldResult {
    const projectRoot = params.projectRoot || process.cwd();
    const plansDir = this.ensurePlanDirectory(projectRoot);

    const issueNum = params.issue ? String(params.issue) : 'adhoc';
    const rawTitle = params.title || 'Task Plan';
    const slug = this.slugify(rawTitle);
    const folderName = `${issueNum}-${slug}`;
    const targetDir = path.join(plansDir, folderName);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const type =
      params.type === 'discovery' || params.type === 'implementation'
        ? params.type
        : this.detectPlanType(rawTitle, params.labels || []);

    const planResult = this.generatePlan({
      targetDir,
      type,
      title: rawTitle,
      issueNumber: issueNum,
      templatesDir: params.templatesDir
    });

    const summaryResult = this.generateSummaryLog({
      targetDir,
      projectName: path.basename(projectRoot),
      issueNumber: issueNum,
      templatesDir: params.templatesDir
    });

    return {
      planDir: targetDir,
      folderName,
      type,
      planPath: planResult.planPath,
      mirrorPath: planResult.mirrorPath || path.join(targetDir, 'implementation_plan.md'),
      summaryPath: summaryResult.summaryPath
    };
  }

  public updateSummaryLog(summaryFilePath: string, updateData: SummaryUpdateData): boolean {
    if (!fs.existsSync(summaryFilePath)) {
      return false;
    }

    try {
      let content = fs.readFileSync(summaryFilePath, 'utf8');

      if (updateData.stage) {
        const stageQuery = String(updateData.stage).toLowerCase();
        const lines = content.split('\n');
        let updated = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('|') && !line.includes('---') && !line.includes('Stage | Subagent')) {
            const parts = line.split('|').map((p) => p.trim());
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

      if (updateData.buildSystem || updateData.detectedEcosystems) {
        const sys = updateData.buildSystem || (Array.isArray(updateData.detectedEcosystems) ? updateData.detectedEcosystems.join(', ') : updateData.detectedEcosystems);
        if (content.includes('- **Build System:**')) {
          content = content.replace(/- \*\*Build System:\*\* .*/i, `- **Build System:** ${sys}`);
        } else if (content.includes('- **Build Status:**')) {
          content = content.replace(/- \*\*Build Status:\*\*/i, `- **Build System:** ${sys}\n- **Build Status:**`);
        }
      }

      if (updateData.executedCommands && updateData.executedCommands.length > 0) {
        const cmds = updateData.executedCommands.map((c) => `\`${c}\``).join(', ');
        if (content.includes('- **Executed Commands:**')) {
          content = content.replace(/- \*\*Executed Commands:\*\* .*/i, `- **Executed Commands:** ${cmds}`);
        } else if (content.includes('- **Tests:**')) {
          content = content.replace(/- \*\*Tests:\*\* (.*)/i, `- **Tests:** $1\n- **Executed Commands:** ${cmds}`);
        }
      }

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
    } catch {
      return false;
    }
  }

  public findPlanDirectory(projectRoot: string, issueNumber: number | string): string | null {
    if (!issueNumber) return null;
    const plansDir = path.resolve(projectRoot, DEFAULT_PLANS_DIR);
    if (!fs.existsSync(plansDir)) return null;

    try {
      const entries = fs.readdirSync(plansDir, { withFileTypes: true });
      const targetPrefix = `${issueNumber}-`;
      const match = entries.find((e) => e.isDirectory() && e.name.startsWith(targetPrefix));
      if (match) {
        return path.join(plansDir, match.name);
      }
    } catch {
      // Read failed
    }

    return null;
  }

  public resolvePlanFile(options: ResolvePlanOptions): ResolvedPlanLocation | null {
    const cwd = options.projectRoot || process.cwd();
    let resolvedPlanDir: string | null = null;
    let resolvedPlanPath: string | null = null;

    if (options.planPath) {
      resolvedPlanPath = path.isAbsolute(options.planPath)
        ? options.planPath
        : path.resolve(cwd, options.planPath);
      if (!fs.existsSync(resolvedPlanPath)) {
        return null;
      }
      resolvedPlanDir = path.dirname(resolvedPlanPath);
    } else {
      if (options.planDir) {
        resolvedPlanDir = path.isAbsolute(options.planDir)
          ? options.planDir
          : path.resolve(cwd, options.planDir);
      } else if (options.issue) {
        resolvedPlanDir = this.findPlanDirectory(cwd, options.issue);
      }

      if (resolvedPlanDir && fs.existsSync(resolvedPlanDir)) {
        for (const candidate of CANDIDATE_PLAN_FILENAMES) {
          const candidatePath = path.join(resolvedPlanDir, candidate);
          if (fs.existsSync(candidatePath)) {
            resolvedPlanPath = candidatePath;
            break;
          }
        }

        if (!resolvedPlanPath) {
          try {
            const files = fs.readdirSync(resolvedPlanDir);
            const mdFile = files.find(
              (f) => f.endsWith('.md') && !f.toLowerCase().includes('summary')
            );
            if (mdFile) {
              resolvedPlanPath = path.join(resolvedPlanDir, mdFile);
            }
          } catch {
            // directory read error
          }
        }
      }
    }

    if (!resolvedPlanPath || !resolvedPlanDir || !fs.existsSync(resolvedPlanPath)) {
      return null;
    }

    const summaryPath = path.join(resolvedPlanDir, DEFAULT_SUMMARY_FILENAME);
    return {
      planDir: resolvedPlanDir,
      planPath: resolvedPlanPath,
      planFileName: path.basename(resolvedPlanPath),
      summaryPath: fs.existsSync(summaryPath) ? summaryPath : undefined
    };
  }

  public readPlanDocument(planPath: string): string {
    return fs.readFileSync(planPath, 'utf8');
  }
}
