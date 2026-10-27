/**
 * agyloop - FilePlanGenerator Infrastructure Adapter
 *
 * Implements PlanGeneratorPort to manage artifacts/plans/ directory initialization,
 * .gitignore safety enforcement, template compilation, and execution run logs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
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
  CANDIDATE_PLAN_FILENAMES,
  STAGE_DISCOVERY,
  FILENAME_ALT_DISCOVERY_PLAN,
  FILENAME_ALT_IMPLEMENTATION_PLAN,
  EVIDENCE_NOT_RECORDED,
  SUMMARY_STATUS_IN_PROGRESS,
  SUMMARY_STATUS_NOT_RECORDED,
  SUMMARY_STATUS_PENDING,
  DiscoveryReport,
  isDiscoveryPlanDocument,
  isPlanContentSubstantive,
  normalizePlanForDigest,
  planSlug,
  planFolderName,
  planDirectoryPrefix
} from '../domain';

export const LEGACY_SUMMARY_FILENAME = 'AgyLoop Summary.md' as const;

/**
 * The embedded copies of the scaffold templates, used when the on-disk file
 * cannot be read (a broken or custom install).
 *
 * The `TEMPLATE_SUMMARY` entry MIRRORS `templates/summary-log.md` and must not
 * pre-claim a stage that has not run: every not-yet-run row is `PENDING` and
 * the metrics block carries no verdict. The two copies are kept in step by the
 * drift guard in `tests/generator.test.ts` (case `G4`) — change one, change
 * the other.
 */
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
### Manual Bug Smoke Test
- **Smoke Test Results:**
- **Step-by-Step Reproduction:**

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

### Quality Gate Targets
- **Target 1:** 
- **Target 2:** 

### Manual Smoke Test Protocol
- **Check 1:** 
`,

  [TEMPLATE_SUMMARY]: `# AgyLoop Execution Summary

**Project:** {ProjectName}  
**Active Issue:** #{IssueNumber}  
**Session Started:** {Timestamp}  

---

## Lifecycle Execution Log

| Stage | Subagent | Model | Status | Duration |
|---|---|---|---|---|
| 1. Discovery | \`discovery\` | \`inherit\` | PENDING | - |
| 2. Plan Review | Human Gate | - | PENDING | - |
| 3. Implementation | \`implementer\` | \`inherit\` | PENDING | - |
| 4. Quality Gate | \`gate\` | \`flash_lite\` | PENDING | - |
| 5. AI Review | \`reviewer\` | \`flash\` | PENDING | - |
| 6. Commit Gate | Human Gate | - | PENDING | - |

## Quality Gate Metrics
- **Build Status:** not recorded
- **Tests:** not recorded

## Review Notes
-
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
    return planSlug(text);
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
    const planPath =
      options.planPath && String(options.planPath).length > 0
        ? options.planPath
        : path.join(targetDir, planFileName);

    let created = false;
    if (!fs.existsSync(planPath) || overwrite) {
      fs.writeFileSync(planPath, content, 'utf8');
      created = true;
    }

    // Issue #299: a DISCOVERY scaffold must NOT put the RCA template into the
    // implementation mirror. The planner, the gate and the reviewer all resolve
    // `implementation_plan.md` as the technical specification, so it carries the
    // implementation template while the `[Discovery]` artifact carries the RCA.
    const mirrorContent = isDiscovery
      ? this.renderTemplate(this.loadTemplate(TEMPLATE_FILES.IMPLEMENTATION, templatesDir), mergedVariables)
      : content;

    let mirrorPath: string | null = null;
    let mirrorCreated = false;
    if (createMirror) {
      mirrorPath = path.join(targetDir, 'implementation_plan.md');
      const exists = fs.existsSync(mirrorPath);
      const existing = exists ? fs.readFileSync(mirrorPath, 'utf8') : '';
      // Heal a legacy discovery-shaped, non-substantive mirror (#299); never
      // touch a real specification the planner wrote.
      const healLegacyMirror =
        isDiscovery && exists && isDiscoveryPlanDocument(existing) && !isPlanContentSubstantive(existing);
      if (!exists || overwrite || healLegacyMirror) {
        fs.writeFileSync(mirrorPath, mirrorContent, 'utf8');
        mirrorCreated = true;
      }
    }

    return { planPath, mirrorPath, content, mirrorContent, created, mirrorCreated };
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
    const legacySummaryPath = path.join(targetDir, LEGACY_SUMMARY_FILENAME);
    const defaultSummaryPath = path.join(targetDir, DEFAULT_SUMMARY_FILENAME);
    const summaryPath = fs.existsSync(legacySummaryPath) ? legacySummaryPath : defaultSummaryPath;

    let created = false;
    if (!fs.existsSync(summaryPath) || overwrite) {
      fs.writeFileSync(summaryPath, content, 'utf8');
      created = true;
    }

    return { summaryPath, content, created };
  }

  /**
   * Absolute paths of the DISCOVERY artifacts in `dir`, in the deterministic
   * order the resolver and the detector both use (issue #283):
   * sorted `[Discovery] - *.md`, then `discovery_plan.md`, then
   * `discovery-plan.md`.
   */
  private listDiscoveryArtifacts(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const prefixed = names
      .filter((name) => name.startsWith('[Discovery] - ') && name.endsWith('.md'))
      .sort();
    const ordered = [...prefixed];
    for (const alias of [FILENAME_ALT_DISCOVERY_PLAN, TEMPLATE_DISCOVERY]) {
      if (names.includes(alias)) {
        ordered.push(alias);
      }
    }
    return ordered.map((name) => path.join(dir, name));
  }

  /** Absolute paths of the IMPLEMENTATION artifacts in `dir`, deterministic. */
  private listImplementationArtifacts(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const prefixed = names
      .filter((name) => name.startsWith('[Implementation] - ') && name.endsWith('.md'))
      .sort();
    const ordered = [...prefixed];
    for (const alias of [FILENAME_ALT_IMPLEMENTATION_PLAN, TEMPLATE_IMPLEMENTATION]) {
      if (names.includes(alias)) {
        ordered.push(alias);
      }
    }
    return ordered.map((name) => path.join(dir, name));
  }

  /** True when any discovery artifact in `dir` carries a populated RCA. */
  private hasPopulatedDiscoveryReport(dir: string): boolean {
    for (const artifact of this.listDiscoveryArtifacts(dir)) {
      try {
        if (DiscoveryReport.fromMarkdown(fs.readFileSync(artifact, 'utf8')).isPopulated) {
          return true;
        }
      } catch {
        // Fail closed on a read error.
      }
    }
    return false;
  }

  /** True when any implementation artifact carries an executable spec. */
  private hasSubstantiveImplementation(dir: string): boolean {
    for (const artifact of this.listImplementationArtifacts(dir)) {
      try {
        const markdown = fs.readFileSync(artifact, 'utf8');
        // A discovery-shaped document is never evidence of a technical spec
        // (issue #299): it may carry body lines, but it is the wrong deliverable.
        if (!isDiscoveryPlanDocument(markdown) && isPlanContentSubstantive(markdown)) {
          return true;
        }
      } catch {
        // Fail closed on a read error.
      }
    }
    return false;
  }

  /** A directory already holds real content (an RCA report or a real spec). */
  private isPopulatedPlanDirectory(dir: string): boolean {
    return this.hasPopulatedDiscoveryReport(dir) || this.hasSubstantiveImplementation(dir);
  }

  /** Candidate `<issue>-*` folder names (unsorted, straight from disk). */
  private listCandidateDirectories(plansDir: string, issueNum: string): string[] {
    try {
      return fs
        .readdirSync(plansDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(planDirectoryPrefix(issueNum)))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * The deterministic candidate ranking (issue #283, §2.4):
   * 1. contains a populated discovery report;
   * 2. contains a substantive implementation plan;
   * 3. exact shared-slug match (when a title is given);
   * 4. lexicographic ascending folder name.
   *
   * No `mtime`, no `readdirSync` order: #108 showed that filesystem order makes
   * the resolver pick a different directory run to run.
   */
  private rankCandidateDirectories(
    plansDir: string,
    candidates: readonly string[],
    issueNum: string,
    title?: string | null
  ): string[] {
    const expected = title ? planFolderName(issueNum, title) : null;
    return [...candidates].sort((a, b) => {
      const rank = (name: string): number => {
        const dir = path.join(plansDir, name);
        if (this.hasPopulatedDiscoveryReport(dir)) return 0;
        if (this.hasSubstantiveImplementation(dir)) return 1;
        if (expected !== null && name === expected) return 2;
        return 3;
      };
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  public scaffoldPlanDirectory(params: ScaffoldParams = {}): ScaffoldResult {
    const projectRoot = params.projectRoot || process.cwd();
    const plansDir = this.ensurePlanDirectory(projectRoot);

    const issueNum = params.issue ? String(params.issue) : 'adhoc';
    const rawTitle = params.title || 'Task Plan';
    const canonicalFolderName = planFolderName(params.issue, rawTitle);
    const canonicalDir = path.join(plansDir, canonicalFolderName);

    const ranked = this.rankCandidateDirectories(
      plansDir,
      this.listCandidateDirectories(plansDir, issueNum),
      issueNum,
      rawTitle
    );
    const populatedCandidate = ranked.find((name) =>
      this.isPopulatedPlanDirectory(path.join(plansDir, name))
    );

    const suppliedDir = params.planDir
      ? path.isAbsolute(params.planDir)
        ? params.planDir
        : path.resolve(projectRoot, params.planDir)
      : null;

    // §2.4 target resolution. The ONLY branch that creates a directory is the
    // final fallback, so a re-entry can never duplicate an existing one.
    let targetDir: string;
    if (suppliedDir) {
      // Explicit intent wins — unless a POPULATED sibling exists and the
      // supplied directory is empty, which is the orphaned-report heal (#283).
      targetDir =
        this.isPopulatedPlanDirectory(suppliedDir) || !populatedCandidate
          ? suppliedDir
          : path.join(plansDir, populatedCandidate);
    } else if (populatedCandidate) {
      targetDir = path.join(plansDir, populatedCandidate);
    } else if (fs.existsSync(canonicalDir)) {
      targetDir = canonicalDir;
    } else if (ranked.length > 0) {
      targetDir = path.join(plansDir, ranked[0]);
    } else {
      targetDir = canonicalDir;
    }

    const existedBefore = fs.existsSync(targetDir);
    if (!existedBefore) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const type =
      params.type === 'discovery' || params.type === 'implementation'
        ? params.type
        : this.detectPlanType(rawTitle, params.labels || []);

    // §2.4 existing-primary reuse: never write a SECOND primary artifact
    // beside one that already exists (a re-entry with a different title would
    // otherwise add an empty `[Discovery] - <new title>.md` that can sort first).
    let primaryPath: string;
    if (type === 'discovery') {
      const artifacts = this.listDiscoveryArtifacts(targetDir);
      const populatedArtifact = artifacts.find((artifact) => {
        try {
          return DiscoveryReport.fromMarkdown(fs.readFileSync(artifact, 'utf8')).isPopulated;
        } catch {
          return false;
        }
      });
      primaryPath =
        populatedArtifact ??
        artifacts[0] ??
        path.join(targetDir, `[Discovery] - ${this.sanitizeFilename(rawTitle)}.md`);
    } else {
      const artifacts = this.listImplementationArtifacts(targetDir);
      primaryPath =
        artifacts[0] ??
        path.join(targetDir, `[Implementation] - ${this.sanitizeFilename(rawTitle)}.md`);
    }

    const planResult = this.generatePlan({
      targetDir,
      type,
      title: rawTitle,
      issueNumber: issueNum,
      planPath: primaryPath,
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
      folderName: path.basename(targetDir),
      type,
      planPath: planResult.planPath,
      mirrorPath: planResult.mirrorPath || path.join(targetDir, 'implementation_plan.md'),
      summaryPath: summaryResult.summaryPath,
      directoryCreated: !existedBefore,
      filesCreated: planResult.created || planResult.mirrorCreated || summaryResult.created,
      adoptedExisting: existedBefore
    };
  }

  public updateSummaryLog(summaryFilePath: string, updateData: SummaryUpdateData): boolean {
    if (!fs.existsSync(summaryFilePath)) {
      return false;
    }

    try {
      let content = fs.readFileSync(summaryFilePath, 'utf8');

      if (updateData.stage) {
        const rawQuery = String(updateData.stage).toLowerCase().trim();
        // Normalize stage query keywords: strip digits, punctuation, and plurals for robust matching
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normQuery = normalize(rawQuery);

        const lines = content.split('\n');
        let updated = false;

        /**
         * Two-pass row matcher (issue #236, collateral fix):
         * Pass 1 evaluates only direct/normalized containment rules; pass 2 the
         * synonym cross-match rules. This prevents the `'AI Review'` query from
         * landing on the `'2. Plan Review'` row via the loose `review`/`review`
         * cross-match (which fired first and broke before reaching `'5. AI Review'`).
         * First-match `break` semantics are preserved within each pass.
         */
        const rowMatches = (rowStage: string, normRow: string): { direct: boolean; synonym: boolean } => ({
          direct:
            rowStage.includes(rawQuery) ||
            rawQuery.includes(rowStage) ||
            normRow.includes(normQuery) ||
            normQuery.includes(normRow),
          synonym:
            (normQuery.includes('commit') && normRow.includes('commit')) ||
            (normQuery.includes('quality') && normRow.includes('quality')) ||
            (normQuery.includes('discovery') && normRow.includes('discovery')) ||
            (normQuery.includes('plan') && normRow.includes('plan')) ||
            (normQuery.includes('implement') && normRow.includes('implement')) ||
            (normQuery.includes('review') && normRow.includes('review'))
        });

        const rewriteRow = (i: number, parts: string[]): void => {
          const formatCell = (val?: string, fallback = '-'): string => {
            if (!val) return fallback;
            const trimmed = val.trim();
            if (trimmed.startsWith('`') && trimmed.endsWith('`')) return trimmed;
            if (trimmed === '-' || trimmed.toLowerCase() === 'human gate') return trimmed;
            return `\`${trimmed}\``;
          };

          const currentSubagent = updateData.subagent ? formatCell(updateData.subagent, parts[2]) : parts[2];
          const currentModel = updateData.model ? formatCell(updateData.model, parts[3]) : parts[3];
          const currentStatus = updateData.status ? updateData.status.toUpperCase() : parts[4];
          const currentDuration = updateData.duration ? updateData.duration : parts[5];

          lines[i] = `| ${parts[1]} | ${currentSubagent} | ${currentModel} | ${currentStatus} | ${currentDuration} |`;
          updated = true;
        };

        // Pass 1: direct / raw / normalized containment only.
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('|') && !line.includes('---') && !line.includes('Stage | Subagent')) {
            const parts = line.split('|').map((p) => p.trim());
            if (parts.length >= 6) {
              const rowStage = parts[1].toLowerCase();
              const normRow = normalize(parts[1]);

              if (rowMatches(rowStage, normRow).direct) {
                rewriteRow(i, parts);
                break;
              }
            }
          }
        }

        // Pass 2 (only when no direct match): synonym cross-match rules.
        if (!updated) {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('|') && !line.includes('---') && !line.includes('Stage | Subagent')) {
              const parts = line.split('|').map((p) => p.trim());
              if (parts.length >= 6) {
                const rowStage = parts[1].toLowerCase();
                const normRow = normalize(parts[1]);

                if (rowMatches(rowStage, normRow).synonym) {
                  rewriteRow(i, parts);
                  break;
                }
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

      if (updateData.reviewRecord) {
        const record = updateData.reviewRecord;
        const base = record.baseCommit ? record.baseCommit.slice(0, 7) : 'unrecorded';
        content = this.replaceSection(
          content,
          'Review Notes',
          `- **Round ${record.round} · ${record.verdict} · base \`${base}\` · ${record.timestamp}** — ${record.summary}`
        );
      } else if (updateData.reviewNote) {
        if (content.includes('## Review Notes')) {
          content = content.replace(
            /## Review Notes([\s\S]*?)(?=\n##|$)/,
            (match) => `${match.trimEnd()}\n- ${updateData.reviewNote}\n`
          );
        }
      }

      if (updateData.notRun && updateData.notRun.length > 0) {
        // Issue #284: one honest line, inside the metrics section it belongs to.
        // "Declared but never executed" must be distinguishable from "passed".
        const rendered = updateData.notRun
          .map((entry) => `${entry.id} (${entry.reason})`)
          .join(', ');
        const line = `- **Not Run:** ${rendered}`;
        if (content.includes('- **Not Run:**')) {
          content = content.replace(/- \*\*Not Run:\*\* .*/i, line);
        } else if (content.includes('- **Tests:**')) {
          content = content.replace(/((?:- \*\*Tests:\*\* .*\n?)(?:- \*\*Executed Commands:\*\* .*\n?)?)/i, `$1${line}\n`);
        } else {
          content = content.trimEnd() + '\n' + line + '\n';
        }
      }

      if (updateData.commitHash || updateData.commitMessage) {
        const hashStr = updateData.commitHash ? `- **Commit Hash:** \`${updateData.commitHash}\`\n` : '';
        const msgStr = updateData.commitMessage ? `- **Commit Message:** \`${updateData.commitMessage}\`\n` : '';
        const timeStr = updateData.commitTimestamp ? `- **Timestamp:** ${updateData.commitTimestamp}\n` : '';
        const commitSection = `## Commit & Release Details\n${hashStr}${msgStr}${timeStr}`.trimEnd();

        if (content.includes('## Commit & Release Details')) {
          content = content.replace(
            /## Commit & Release Details([\s\S]*?)(?=\n##|$)/,
            commitSection
          );
        } else {
          content = content.trimEnd() + '\n\n' + commitSection + '\n';
        }
      }

      if (updateData.planRevisionCount !== undefined && updateData.planRevisionCount > 0) {
        const revSection = `## Plan Revisions\n- **Current Iteration:** #${updateData.planRevisionCount}`;
        if (content.includes('## Plan Revisions')) {
          content = content.replace(/## Plan Revisions([\s\S]*?)(?=\n##|$)/, revSection);
        } else {
          content = content.trimEnd() + '\n\n' + revSection + '\n';
        }
      }

      if (updateData.prComments) {
        const commentsFormatted = Array.isArray(updateData.prComments)
          ? updateData.prComments.map((c) => `- ${c}`).join('\n')
          : `- ${updateData.prComments}`;
        const prCommentsSection = `## PR Review Comments Ingested\n${commentsFormatted}`;
        if (content.includes('## PR Review Comments Ingested')) {
          content = content.replace(/## PR Review Comments Ingested([\s\S]*?)(?=\n##|$)/, prCommentsSection);
        } else {
          content = content.trimEnd() + '\n\n' + prCommentsSection + '\n';
        }
      }

      if (updateData.commitRejection) {
        const rejectionText = typeof updateData.commitRejection === 'object'
          ? `Routed to ${updateData.commitRejection.targetStage}: ${updateData.commitRejection.reason}`
          : String(updateData.commitRejection);
        const rejSection = `## Commit Rejections\n- ${rejectionText}`;
        if (content.includes('## Commit Rejections')) {
          content = content.replace(
            /## Commit Rejections([\s\S]*?)(?=\n##|$)/,
            (match) => `${match.trimEnd()}\n- ${rejectionText}\n`
          );
        } else {
          content = content.trimEnd() + '\n\n' + rejSection + '\n';
        }
      }

      if (updateData.abortEvent) {
        const evt = updateData.abortEvent;
        const filesTouchedStr = evt.filesTouched && evt.filesTouched.length > 0
          ? evt.filesTouched.map((f) => `\`${f}\``).join(', ')
          : 'None';
        const teardownStr = typeof evt.teardownMetrics === 'object' && evt.teardownMetrics !== null
          ? JSON.stringify(evt.teardownMetrics)
          : String(evt.teardownMetrics || 'Complete');

        const abortBlock = [
          '### [ABORTED]',
          `- **Timestamp:** ${evt.timestamp}`,
          `- **Aborted Stage:** ${evt.stage}`,
          `- **Active Subagent:** ${evt.subagent || 'None'}`,
          `- **Files Touched:** ${filesTouchedStr}`,
          `- **Teardown Metrics:** ${teardownStr}`,
          evt.reason ? `- **Reason:** ${evt.reason}` : null
        ].filter(Boolean).join('\n');

        content = content.trimEnd() + '\n\n' + abortBlock + '\n';
      }

      if (updateData.finalize === true) {
        content = this.finalizeSummary(content);
      }

      fs.writeFileSync(summaryFilePath, content, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replaces (never appends to) the body of one `## <heading>` section.
   *
   * Issue #284 (AC6): the review note is one authoritative bullet. The defect
   * was that each write appended, so a re-review left two verdicts with no
   * supersede marker. Headings are preserved exactly — `updateSummaryLog`'s
   * other section regexes key off them.
   */
  private replaceSection(content: string, heading: string, body: string): string {
    const headingLine = `## ${heading}`;
    const start = content.indexOf(headingLine);
    if (start === -1) {
      return `${content.trimEnd()}\n\n${headingLine}\n${body}\n`;
    }
    const bodyStart = start + headingLine.length;
    const nextSection = content.indexOf('\n## ', bodyStart);
    const end = nextSection === -1 ? content.length : nextSection;
    const tail = nextSection === -1 ? '' : content.slice(end);
    return `${content.slice(0, bodyStart)}\n${body}${tail === '' ? '\n' : tail}`;
  }

  /**
   * Makes an unrecorded row honest at the end of a run (issue #284, AC2).
   *
   * Any stage row still `PENDING` / `IN PROGRESS` becomes `NOT RECORDED`:
   * a COMPLETED task must never read as one that has not started. Terminal
   * statuses (`COMPLETED`, `APPROVED`, `FAILED`, `SKIPPED`, `REJECTED`) are
   * untouched, as are the values that were actually recorded.
   */
  private finalizeSummary(content: string): string {
    const lines = content.split('\n').map((line) => {
      if (!line.startsWith('|') || line.includes('---') || line.includes('Stage | Subagent')) {
        return line;
      }
      const parts = line.split('|');
      if (parts.length < 7) {
        return line;
      }
      const status = parts[4].trim();
      if (status === SUMMARY_STATUS_PENDING || status === SUMMARY_STATUS_IN_PROGRESS) {
        parts[4] = ` ${SUMMARY_STATUS_NOT_RECORDED} `;
        return parts.join('|');
      }
      return line;
    });

    let finalized = lines.join('\n');
    finalized = finalized.replace(
      /- \*\*Build Status:\*\* (?:PENDING|-)\s*$/gim,
      `- **Build Status:** ${EVIDENCE_NOT_RECORDED}`
    );
    finalized = finalized.replace(
      /- \*\*Tests:\*\* -\s*$/gim,
      `- **Tests:** ${EVIDENCE_NOT_RECORDED}`
    );
    finalized = finalized.replace(
      /- \*\*Tests:\*\* PENDING\s*$/gim,
      `- **Tests:** ${EVIDENCE_NOT_RECORDED}`
    );
    return finalized;
  }

  public findPlanDirectory(
    projectRoot: string,
    issueNumber: number | string,
    title?: string
  ): string | null {
    if (!issueNumber) return null;
    const plansDir = path.resolve(projectRoot, DEFAULT_PLANS_DIR);
    if (!fs.existsSync(plansDir)) return null;

    try {
      const issueNum = String(issueNumber);
      const ranked = this.rankCandidateDirectories(
        plansDir,
        this.listCandidateDirectories(plansDir, issueNum),
        issueNum,
        title
      );
      if (ranked.length === 0) {
        return null;
      }
      return path.join(plansDir, ranked[0]);
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
        resolvedPlanDir = this.findPlanDirectory(
          cwd,
          options.issue,
          options.title || undefined
        );
      }

      if (resolvedPlanDir && fs.existsSync(resolvedPlanDir)) {
        resolvedPlanPath = this.resolveDocumentInDirectory(resolvedPlanDir, options.stage);
      }
    }

    if (!resolvedPlanPath || !resolvedPlanDir || !fs.existsSync(resolvedPlanPath)) {
      return null;
    }

    const legacySummaryPath = path.join(resolvedPlanDir, LEGACY_SUMMARY_FILENAME);
    const defaultSummaryPath = path.join(resolvedPlanDir, DEFAULT_SUMMARY_FILENAME);
    const summaryPath = fs.existsSync(legacySummaryPath)
      ? legacySummaryPath
      : fs.existsSync(defaultSummaryPath)
        ? defaultSummaryPath
        : undefined;

    return {
      planDir: resolvedPlanDir,
      planPath: resolvedPlanPath,
      planFileName: path.basename(resolvedPlanPath),
      summaryPath
    };
  }

  /**
   * Stage-aware document resolution inside ONE plan directory (issue #283/#299).
   *
   * DISCOVERY ranks a POPULATED `[Discovery] - *.md` ahead of a pristine one,
   * then falls back to the first discovery artifact, then returns `null`
   * (issue #320). DISCOVERY NEVER returns an implementation document: an
   * `implementation_plan.md` is not RCA evidence, and handing one to the
   * discovery subagent told it to `Write ONLY` the wrong document. A caller
   * with no discovery artifact names the plan directory instead.
   *
   * Every other stage may NEVER be handed a discovery-shaped document: the
   * planner, the gate and the reviewer all read the technical specification.
   */
  private resolveDocumentInDirectory(dir: string, stage?: string): string | null {
    const readSafe = (candidate: string): string => {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch {
        return '';
      }
    };

    if (stage === STAGE_DISCOVERY) {
      const discoveryArtifacts = this.listDiscoveryArtifacts(dir);
      const populated = discoveryArtifacts.find((artifact) =>
        DiscoveryReport.fromMarkdown(readSafe(artifact)).isPopulated
      );
      if (populated) {
        return populated;
      }
      if (discoveryArtifacts.length > 0) {
        return discoveryArtifacts[0];
      }
      // No discovery artifact: fail closed. An implementation document is never
      // DISCOVERY evidence (issue #320).
      return null;
    }

    // Plan-stage resolution: substantive implementation documents first
    // (lexicographic on ties), then the scaffold's primary, then the aliases.
    // A discovery-shaped document is skipped everywhere.
    const implementationArtifacts = this.listImplementationArtifacts(dir);
    const substantive = implementationArtifacts.find((artifact) => {
      const markdown = readSafe(artifact);
      return !isDiscoveryPlanDocument(markdown) && isPlanContentSubstantive(markdown);
    });
    if (substantive) {
      return substantive;
    }
    for (const candidate of implementationArtifacts) {
      if (!isDiscoveryPlanDocument(readSafe(candidate))) {
        return candidate;
      }
    }
    // Legacy candidate list, but never a discovery-shaped document.
    for (const candidate of CANDIDATE_PLAN_FILENAMES) {
      const candidatePath = path.join(dir, candidate);
      if (!fs.existsSync(candidatePath)) continue;
      if (isDiscoveryPlanDocument(readSafe(candidatePath))) continue;
      return candidatePath;
    }
    // Last resort: any non-summary markdown that is not discovery-shaped.
    try {
      const files = fs.readdirSync(dir).sort();
      for (const file of files) {
        if (!file.endsWith('.md') || file.toLowerCase().includes('summary')) continue;
        const candidatePath = path.join(dir, file);
        if (isDiscoveryPlanDocument(readSafe(candidatePath))) continue;
        return candidatePath;
      }
    } catch {
      // directory read error
    }
    return null;
  }

  public readPlanDocument(planPath: string): string {
    return fs.readFileSync(planPath, 'utf8');
  }

  /**
   * sha256 of the NORMALIZED plan bytes (issue #298).
   *
   * Normalization is shared with `normalizePlanForDigest`, so checkbox ticks
   * and line-ending noise do not invalidate an approval, while any prose or
   * command edit does. Returns `null` when the file cannot be read: an
   * unreadable approved plan is reported as a gate failure by the caller, not
   * thrown from the adapter.
   */
  public hashPlanDocument(planPath: string): string | null {
    try {
      const content = fs.readFileSync(planPath, 'utf8');
      return createHash('sha256').update(normalizePlanForDigest(content), 'utf8').digest('hex');
    } catch {
      return null;
    }
  }
}
