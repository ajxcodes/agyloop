/**
 * codeloop - FilePlanGenerator Infrastructure Adapter
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
  LABEL_SMOKE_PROTOCOL,
  DiscoveryReport,
  detectIssueKind,
  isDiscoveryPlanDocument,
  isPlanContentSubstantive,
  normalizePlanForDigest,
  planSlug,
  planFolderName,
  planIssuePart,
  planDirectoryPrefix,
  planArtifactFileName,
  planByteLength,
  sanitizePlanTitle,
  assertPlanNameWithinLimits,
  PLAN_DIR_NAME_MAX_BYTES,
  VALIDATION_FIELD_PLAN_TITLE,
  ValidationError
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
 *
 * The `TEMPLATE_IMPLEMENTATION` entry MIRRORS `templates/implementation-plan.md`
 * and is kept in step by the drift guard in `tests/generator.test.ts` (case
 * `G5`, issue #392) — change one, change the other. Both copies carry the
 * `### Baseline Evidence` scaffold in the shape `BaselineEvidence.fromPlan`
 * reads, so D1's guard measures a plan authored from either copy.
 */
export const FALLBACK_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  [TEMPLATE_DISCOVERY]: `# [Discovery] - {Title}

**Issue:** #{IssueNumber}  
**Date:** {Date}  
**Author:** CodeLoop Planning Subagent (Read-Only)  

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
**Author:** CodeLoop Planning Subagent  
**Status:** DRAFT | APPROVED  

---

## 1. Context & Objectives
- **Feature Overview:**
- **Acceptance Criteria:**
- **Out of Scope:**
<!-- Name any correction deliberately NOT delivered, so the reviewer cannot count it as met. -->

## 2. Architectural Design & Impact
- **Component Breakdown:**
- **Data Flow / Model Invariants:**
- **Dependencies & Imports:**

## 3. Implementation Steps
- [ ] **Step 1:** 
- [ ] **Step 2:** 
- [ ] **Step 3:** 

### Test Register
<!-- One row per pinned assertion: \`- **TR-1** — **Pins:** \`path\` :: \`test title\`\` (or \`**New test:**\`) plus a \`**Asserts:**\` literal. A \`Pins:\` row must restate the pinned literal exactly; APPROVAL refuses a contradicting row and names \`file:line\`. -->

## 4. Quality Gate & Test Verification

### Quality Gate Targets
- **Target 1:** 
- **Target 2:** 

### Manual Smoke Test Protocol
- **Check 1:** 

### Baseline Evidence

<!-- Baseline claim shape: \`Declared:\` must be the command's literal stdout (copy it verbatim); \`Output:\` must be the stdout that command printed. APPROVAL runs each command once and checks both against the fresh measurement — a \`Declared:\` carrying a value the command does not print is refused, and so is an \`Output:\` that does not match — while a prose \`Declared:\` is accepted only when \`Output:\` verifies. -->
<!-- Baseline command cwd: Baseline commands are measured in more than one directory: APPROVAL runs each command in the workspace it is invoked from (the \`--workspace\` root, otherwise the current directory), and IMPLEMENT runs it again in the task worktree, which is a pristine checkout with no build output because \`dist/\` is git-ignored. A command must therefore print the same stdout in both directories, which rules out resolving the workspace's own build output (\`./dist\`, \`./build\`) at all. Every refusal names the cwd it measured in. -->

#### <claim-id>

- **Declared:**
- **Command:**
- **Output:**
`,

  [TEMPLATE_SUMMARY]: `# CodeLoop Execution Summary

**Project:** {ProjectName}  
**Active Issue:** #{IssueNumber}  
**Session Started:** {Timestamp}  

---

## Lifecycle Execution Log

| Stage | Subagent | Model | Status | Duration |
|---|---|---|---|---|
| 1. Discovery | \`discovery\` | \`inherit\` | PENDING | - |
| 2. Plan Review | Human Gate | - | PENDING | - |
| 3. Plan Approval | Human Gate | - | PENDING | - |
| 4. Implementation | \`implementer\` | \`inherit\` | PENDING | - |
| 5. Quality Gate | \`gate\` | \`flash_lite\` | PENDING | - |
| 6. AI Review | \`reviewer\` | \`flash\` | PENDING | - |
| 7. Commit Gate | Human Gate | - | PENDING | - |

## Quality Gate Metrics
- **Build Status:** not recorded
- **Tests:** not recorded

## Review Notes
-
## Release Notes Dependency
- **GitHub Release notes:** generated by \`ajxcodes/auto-tag\` from commit subjects only (cross-repo; not fixed here).
`
});

/**
 * The mark rendered for a smoke check (issue #325, AC-17).
 *
 * Three states, not two: `❔` is "ran, no verdict reported" and must never be
 * collapsed into `✅`.
 */
function smokeCheckMark(passed: boolean | null | undefined): string {
  if (passed === true) {
    return '✅';
  }
  if (passed === false) {
    return '❌';
  }
  return '❔';
}

/** The documented order of the `## Quality Gate Metrics` lines (issue #338). */
const SUMMARY_METRIC_ORDER: readonly string[] = [
  'Build System',
  'Build Status',
  'Tests',
  'Executed Commands',
  'Smoke Checks',
  LABEL_SMOKE_PROTOCOL,
  'Not Run'
];

/**
 * Upserts or REMOVES one `- **<label>:** <value>` metric line (issue #338).
 *
 * `value === null` deletes the line: a round that measured nothing must not
 * inherit an earlier round's number. When the line is missing it is inserted
 * after the nearest PRECEDING metric of `SUMMARY_METRIC_ORDER`, so the block
 * keeps one documented order and nothing is ever appended into a later
 * section.
 */
function setSummaryMetric(content: string, label: string, value: string | null): string {
  const lines = content.split('\n');
  const prefix = `- **${label}:**`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (value === null) {
    return index === -1 ? content : lines.filter((_, position) => position !== index).join('\n');
  }
  const rendered = `${prefix} ${value}`;
  if (index !== -1) {
    lines[index] = rendered;
    return lines.join('\n');
  }
  for (let back = SUMMARY_METRIC_ORDER.indexOf(label) - 1; back >= 0; back -= 1) {
    const anchor = `- **${SUMMARY_METRIC_ORDER[back]}:**`;
    const anchorIndex = lines.findIndex((line) => line.startsWith(anchor));
    if (anchorIndex !== -1) {
      lines.splice(anchorIndex + 1, 0, rendered);
      return lines.join('\n');
    }
  }
  const headingIndex = lines.findIndex((line) => line.trim() === '## Quality Gate Metrics');
  if (headingIndex !== -1) {
    lines.splice(headingIndex + 1, 0, rendered);
    return lines.join('\n');
  }
  return `${content.trimEnd()}\n${rendered}\n`;
}

/** True when a filesystem call rejected a name for exceeding the OS limit. */
function isNameTooLongError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENAMETOOLONG'
  );
}

/** A human-readable one-line description of an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

  /**
   * The filesystem-safe title body (issue #364).
   *
   * Delegates to the domain so the sanitisation grammar is shared with the
   * derived folder; the FILENAME authority is `planArtifactFileName`, which
   * additionally bounds the result.
   */
  public sanitizeFilename(title: string): string {
    return sanitizePlanTitle(title);
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

    // Issue #379 / #382: one issue-kind predicate for the entry point and the
    // generator. The historical delimited markers (`[bug]`, `fix:`, `rca/`) are
    // matched verbatim; the ONLY undelimited form is a LEADING bug imperative
    // (`crash on login`, `fixing the loop`), never "any word-start keyword".
    // Labels match exactly (`not-a-bug` is a feature) and a non-bug label is
    // only overridden by a marker-shaped title. The two consumers cannot drift:
    // this method is the predicate, it has no second opinion.
    return detectIssueKind({ title, labels }).kind === 'bug' ? 'discovery' : 'implementation';
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
    // Issue #364: the filename is DERIVED (bounded), never merely sanitised, so
    // a long/CJK title cannot die on `open … ENAMETOOLONG` after the folder was
    // already created. Both write legs share this one function.
    const planFileName = planArtifactFileName(
      isDiscovery ? 'discovery' : 'implementation',
      title
    );
    // Fail BEFORE the write if a future caller bypasses the bound. The FOLDER
    // budget is checked only when THIS call derived the component (#364
    // review): `targetDir` is often an ADOPTED pre-#364 directory whose name is
    // 154–211 bytes, and asserting on `path.basename(targetDir)` turned every
    // re-entry into a bogus "pass a shorter --title". `scaffoldPlanDirectory`
    // asserts the canonical name before it resolves a target.
    assertPlanNameWithinLimits({
      folderName: options.folderName ?? null,
      fileName: planFileName,
      title
    });
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
      projectName = 'CodeLoop Project',
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

  /**
   * Candidate `<issue>-*` folder names (unsorted, straight from disk).
   *
   * NOTE: this is the PREFIX scan only. An ad-hoc run is keyed by its TITLE, so
   * the exact-match filter lives at the call site in `scaffoldPlanDirectory`
   * (issue #383) — a plain `adhoc-*` scan would let a second title adopt the
   * first title's folder.
   */
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

    // Issue #383: an AD-HOC run is keyed by its TITLE, never by a sibling's
    // prefix. `planIssuePart` is the same normalisation `planFolderName` uses.
    const adhocRun = planIssuePart(params.issue) === 'adhoc';

    // Issue #364 (N5): derive and VALIDATE every name BEFORE the first write.
    // `detectPlanType` reads only the title + labels, so it can move above the
    // target resolution; the type decides which filename prefix is budgeted.
    const type =
      params.type === 'discovery' || params.type === 'implementation'
        ? params.type
        : this.detectPlanType(rawTitle, params.labels || []);
    const canonicalFolderName = planFolderName(params.issue, rawTitle);
    const primaryFileName = planArtifactFileName(type, rawTitle);
    assertPlanNameWithinLimits({
      folderName: canonicalFolderName,
      fileName: primaryFileName,
      title: rawTitle
    });
    const canonicalDir = path.join(plansDir, canonicalFolderName);

    // Issue #383: the exact-match filter is the ADOPTION half of the lossy-title
    // fix (the value-object hash is the NAMING half). An ad-hoc title may only
    // ever adopt its OWN canonical folder — never every `adhoc-*` sibling.
    const ranked = this.rankCandidateDirectories(
      plansDir,
      this.listCandidateDirectories(plansDir, issueNum).filter(
        (name) => !adhocRun || name === canonicalFolderName
      ),
      issueNum,
      rawTitle
    );
    const populatedCandidate = ranked.find((name) =>
      this.isPopulatedPlanDirectory(path.join(plansDir, name))
    );

    let suppliedDir = params.planDir
      ? path.isAbsolute(params.planDir)
        ? params.planDir
        : path.resolve(projectRoot, params.planDir)
      : null;

    // Issue #383: an ad-hoc run whose CHECKPOINT tracks another title's folder
    // must derive its own. Only a checkpoint-supplied hint can be ignored — an
    // explicit `--plan-dir` (planDirIsCheckpoint falsy) always wins.
    let checkpointDirIgnored = false;
    if (
      suppliedDir !== null &&
      adhocRun &&
      params.planDirIsCheckpoint === true &&
      path.basename(suppliedDir) !== canonicalFolderName
    ) {
      suppliedDir = null;
      checkpointDirIgnored = true;
    }

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
    try {
      if (!existedBefore) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

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
          populatedArtifact ?? artifacts[0] ?? path.join(targetDir, primaryFileName);
      } else {
        const artifacts = this.listImplementationArtifacts(targetDir);
        primaryPath = artifacts[0] ?? path.join(targetDir, primaryFileName);
      }

      const planResult = this.generatePlan({
        targetDir,
        folderName: canonicalFolderName,
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
        adoptedExisting: existedBefore,
        checkpointDirIgnored
      };
    } catch (error) {
      // AC-4: a failed write must not leave a half-scaffolded folder behind for
      // a later run to adopt. The directory did NOT exist before this call, so
      // everything inside it was created here — removing it cannot destroy
      // pre-existing work. A directory that existed before is adopted, and is
      // NEVER removed (R6).
      if (!existedBefore) {
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          // Best effort: leave the evidence if the filesystem refuses.
        }
      }

      if (isNameTooLongError(error)) {
        // AC-5: never surface a bare `ENAMETOOLONG`. If a name still overflows
        // a budget (only reachable if a future caller bypasses the bound), the
        // validator produces the precise message; otherwise the filesystem
        // refused a within-budget name, which is reported with the same remedy.
        assertPlanNameWithinLimits({
          folderName: canonicalFolderName,
          fileName: primaryFileName,
          title: rawTitle
        });
        throw new ValidationError(
          VALIDATION_FIELD_PLAN_TITLE,
          rawTitle,
          `the derived plan folder "${canonicalFolderName}" (${planByteLength(canonicalFolderName)} bytes) and file "${primaryFileName}" (${planByteLength(primaryFileName)} bytes) are within the ${PLAN_DIR_NAME_MAX_BYTES}-byte limit, but the filesystem refused the name (${errorMessage(error)}); pass a shorter --title, or choose the folder with --plan-dir`
        );
      }

      throw error;
    }
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
        /**
         * The row this write addresses (issue #376, AC14).
         *
         * Absent/`1` is the unlabelled `<N>. Stage` row — today's behaviour,
         * unchanged. `R > 1` addresses `<N>. Stage (round R)`.
         */
        const requestedRound = Math.max(1, Math.trunc(updateData.round ?? 1));

        const lines = content.split('\n');
        let updated = false;

        /**
         * Parses a row label into its BASE stage label and its round.
         *
         * The suffix parser is anchored (`$`), so a stage name that merely
         * contains parentheses is untouched. `round: null` is the plain row.
         */
        const splitStageLabel = (label: string): { base: string; round: number | null } => {
          const match = label.match(/\s*\(round\s+(\d+)\)\s*$/i);
          if (!match || match.index === undefined) {
            return { base: label.trim(), round: null };
          }
          return {
            base: label.slice(0, match.index).trim(),
            round: parseInt(match[1], 10)
          };
        };

        /**
         * True when this row is the one the write may touch.
         *
         * A round-1 write owns the plain row AND `(round 1)`; a later round
         * owns ONLY its own labelled row, so it can never overwrite round 1.
         */
        const acceptsRound = (rowRound: number | null): boolean =>
          requestedRound > 1 ? rowRound === requestedRound : rowRound === null || rowRound === 1;

        interface StageRow {
          readonly index: number;
          readonly parts: string[];
          readonly base: string;
          readonly normBase: string;
          readonly round: number | null;
        }

        const collectStageRows = (): StageRow[] => {
          const rows: StageRow[] = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.startsWith('|') || line.includes('---') || line.includes('Stage | Subagent')) {
              continue;
            }
            const parts = line.split('|').map((p) => p.trim());
            if (parts.length < 6) continue;
            const { base, round } = splitStageLabel(parts[1]);
            rows.push({ index: i, parts, base, normBase: normalize(base), round });
          }
          return rows;
        };

        /**
         * Two-pass row matcher (issue #236, collateral fix):
         * Pass 1 evaluates only direct/normalized containment rules; pass 2 the
         * synonym cross-match rules. This prevents the `'AI Review'` query from
         * landing on the `'2. Plan Review'` row via the loose `review`/`review`
         * cross-match (which fired first and broke before reaching `'5. AI Review'`).
         * First-match `break` semantics are preserved within each pass.
         *
         * Issue #376: the match runs against the BASE label (round suffix
         * stripped), and the `plan`/`review` synonym rules are suppressed when
         * either side names an `approval`, so `Plan Approval` never collides
         * with `Plan Review`. The `Quality Gates` query still reaches its row
         * through the `quality` synonym.
         */
        const rowMatches = (rowStage: string, normRow: string): { direct: boolean; synonym: boolean } => {
          const approvalOnEitherSide =
            normQuery.includes('approval') || normRow.includes('approval');
          return {
            direct:
              rowStage.includes(rawQuery) ||
              rawQuery.includes(rowStage) ||
              normRow.includes(normQuery) ||
              normQuery.includes(normRow),
            synonym:
              (normQuery.includes('commit') && normRow.includes('commit')) ||
              (normQuery.includes('quality') && normRow.includes('quality')) ||
              (normQuery.includes('discovery') && normRow.includes('discovery')) ||
              (!approvalOnEitherSide &&
                normQuery.includes('plan') &&
                normRow.includes('plan')) ||
              (normQuery.includes('implement') && normRow.includes('implement')) ||
              (!approvalOnEitherSide &&
                normQuery.includes('review') &&
                normRow.includes('review'))
          };
        };

        const buildRowLine = (parts: string[], label: string): string =>
          `| ${label} | ${parts[2]} | ${parts[3]} | ${parts[4]} | ${parts[5]} |`;

        const rewriteRow = (i: number, parts: string[], label: string = parts[1]): void => {
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

          lines[i] = `| ${label} | ${currentSubagent} | ${currentModel} | ${currentStatus} | ${currentDuration} |`;
          updated = true;
        };

        const stageRows = collectStageRows();
        const directMatch = (row: StageRow): boolean =>
          rowMatches(row.base.toLowerCase(), row.normBase).direct;
        const synonymMatch = (row: StageRow): boolean =>
          rowMatches(row.base.toLowerCase(), row.normBase).synonym;

        let target: StageRow | null = null;
        for (const row of stageRows) {
          if (acceptsRound(row.round) && directMatch(row)) {
            target = row;
            break;
          }
        }
        if (!target) {
          for (const row of stageRows) {
            if (acceptsRound(row.round) && synonymMatch(row)) {
              target = row;
              break;
            }
          }
        }

        if (target) {
          rewriteRow(target.index, target.parts);
        } else if (requestedRound > 1) {
          // No row for this round yet. Rename the plain row to `(round 1)` and
          // append this round after it — never replace the earlier round.
          const plain =
            stageRows.find((row) => row.round === null && directMatch(row)) ??
            stageRows.find((row) => row.round === null && synonymMatch(row));
          if (plain) {
            const label = `${plain.base} (round ${requestedRound})`;
            lines[plain.index] = buildRowLine(plain.parts, `${plain.base} (round 1)`);
            lines.splice(plain.index + 1, 0, buildRowLine(plain.parts, label));
            rewriteRow(plain.index + 1, plain.parts, label);
          } else {
            // Only labelled rows exist: append after the highest same-base row
            // so a third round lands in ascending order.
            const sameBase = stageRows.filter(
              (row) => row.round !== null && (directMatch(row) || synonymMatch(row))
            );
            if (sameBase.length > 0) {
              const highest = sameBase.reduce((best, row) =>
                (row.round ?? 0) > (best.round ?? 0) ? row : best
              );
              const label = `${highest.base} (round ${requestedRound})`;
              lines.splice(highest.index + 1, 0, buildRowLine(highest.parts, label));
              rewriteRow(highest.index + 1, highest.parts, label);
            }
            // No matching row at all: skip the write (fail-closed) rather than
            // inventing a stage row.
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

      // Issue #338: every metric line is written through ONE tri-state helper.
      // `undefined` leaves the line untouched, `null` REMOVES it, a value
      // replaces or inserts it. The old `if (… && length > 0)` guards made
      // "this round measured nothing" unrepresentable, so a NOT RECORDED round
      // kept the previous round's command list, check marks and skip reasons.
      if (updateData.buildSystem === null) {
        content = setSummaryMetric(content, 'Build System', null);
      } else {
        let sys: string | undefined = updateData.buildSystem ?? undefined;
        if (!sys && updateData.detectedEcosystems) {
          sys =
            typeof updateData.detectedEcosystems === 'string'
              ? updateData.detectedEcosystems
              : updateData.detectedEcosystems.join(', ');
        }
        if (sys !== undefined) {
          content = setSummaryMetric(content, 'Build System', sys);
        }
      }

      if (updateData.executedCommands !== undefined) {
        const cmds =
          updateData.executedCommands.length > 0
            ? updateData.executedCommands.map((c) => `\`${c}\``).join(', ')
            : null;
        content = setSummaryMetric(content, 'Executed Commands', cmds);
      }

      if (updateData.smokeChecks !== undefined) {
        // Issue #325 (AC-17): smoke checks are protocol steps, not commands, so
        // they render on their own line with their own verdict. A `null` verdict
        // is `❔` — "ran, no verdict reported" is not a pass.
        const rendered =
          updateData.smokeChecks.length > 0
            ? updateData.smokeChecks
                .map((check) => `${check.id} ${smokeCheckMark(check.passed)}`)
                .join(', ')
            : null;
        content = setSummaryMetric(content, 'Smoke Checks', rendered);
      }

      if (updateData.smokeProtocol !== undefined) {
        // Issue #338 (S3): the protocol verdict renders NEXT TO the per-check
        // marks, so a `❔` is resolvable: `PASSED` = protocol passed without a
        // per-check verdict, `NOT_DECLARED` = no protocol declared, and
        // `not reported` = a report was filed without a verdict.
        content = setSummaryMetric(content, LABEL_SMOKE_PROTOCOL, updateData.smokeProtocol);
      }

      if (updateData.gateSelfReport) {
        // Issue #376 (AC16): the gate's own timer is NOT the row's clock. It
        // renders once per round as a named note carrying BOTH clocks, so the
        // Duration column stays one summable wall clock.
        content = this.upsertGateSelfReport(
          content,
          updateData.gateSelfReport.round,
          updateData.gateSelfReport.text
        );
      }

      if (updateData.reviewRecord) {
        content = this.upsertReviewNote(content, updateData.reviewRecord);
      } else if (updateData.reviewNote) {
        if (content.includes('## Review Notes')) {
          content = content.replace(
            /## Review Notes([\s\S]*?)(?=\n##|$)/,
            (match) => `${match.trimEnd()}\n- ${updateData.reviewNote}\n`
          );
        }
      }

      if (updateData.notRun !== undefined) {
        // Issue #284: one honest line, inside the metrics section it belongs to.
        // "Declared but never executed" must be distinguishable from "passed".
        // Issue #338: `[]` removes the line — a round that declared no skip must
        // not inherit an earlier round's reason.
        const rendered =
          updateData.notRun.length > 0
            ? updateData.notRun
                .map((entry) => `${entry.id} (${entry.reason})`)
                .join(', ')
            : null;
        content = setSummaryMetric(content, 'Not Run', rendered);
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

      // Issue #432: tri-state, like every other metric. `undefined` leaves the
      // section untouched, `[]` removes it, and a non-empty list names every
      // record with its acknowledgement state.
      if (updateData.planDeviations !== undefined) {
        if (updateData.planDeviations.length === 0) {
          content = content.replace(/\n*## Plan Deviations[\s\S]*?(?=\n## |$)/, '\n');
        } else {
          const body = updateData.planDeviations
            .map(
              (record) =>
                `- **Plan Deviations:** ${record.id} (${record.acknowledged ? 'acknowledged' : 'unacknowledged'}) — plan section "${record.planSection}" pins "${record.planLiteral}"; the implementation asserts "${record.implementedAssertion}"`
            )
            .join('\n');
          content = this.replaceSection(content, 'Plan Deviations', body);
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

      // Issue #315 (AC-32, absorbing #257): the published GitHub Release notes
      // are generated by `ajxcodes/auto-tag` — another repository, another
      // release train. Every summary states that outstanding dependency, so an
      // in-repo changelog fix can never read as "the release notes are done".
      // The upsert also repairs summaries scaffolded before this section
      // existed.
      if (!content.includes('## Release Notes Dependency')) {
        content =
          content.trimEnd() +
          '\n\n## Release Notes Dependency\n' +
          '- **GitHub Release notes:** generated by `ajxcodes/auto-tag` from commit subjects only (cross-repo; not fixed here).\n';
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
   *
   * Issue #376 (AC17): `upsertReviewNote` builds the body for Review Notes, so
   * a re-review keeps every round's verdict while still rewriting the section
   * as a whole.
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
   * Upserts ONE review bullet per round (issue #376, AC17, absorbing #396).
   *
   * The section used to be replaced on every write, so round 1's
   * `CHANGES_REQUESTED` verdict and its remediation vanished from the run's own
   * deliverable. Rounds are now accumulated, sorted ascending, and the highest
   * round is marked ` (current)` — but ONLY when more than one round exists, so
   * a single-round note stays byte-identical to the pre-#376 shape.
   */
  private upsertReviewNote(
    content: string,
    record: {
      readonly round: number;
      readonly verdict: string;
      readonly baseCommit: string | null;
      readonly timestamp: string;
      readonly summary: string;
    }
  ): string {
    const bullets = new Map<number, string>();

    const headingLine = '## Review Notes';
    const start = content.indexOf(headingLine);
    if (start !== -1) {
      const bodyStart = start + headingLine.length;
      const nextSection = content.indexOf('\n## ', bodyStart);
      const body = content.slice(bodyStart, nextSection === -1 ? content.length : nextSection);
      for (const line of body.split('\n')) {
        const match = line.match(/^- \*\*Round (\d+) · /);
        if (!match) continue;
        // Strip the previous render's ` (current)` marker before re-rendering.
        bullets.set(parseInt(match[1], 10), line.replace(/ \(current\)(?= · base )/, ''));
      }
    }

    const base = record.baseCommit ? record.baseCommit.slice(0, 7) : 'unrecorded';
    bullets.set(
      record.round,
      `- **Round ${record.round} · ${record.verdict} · base \`${base}\` · ${record.timestamp}** — ${record.summary}`
    );

    const rounds = [...bullets.keys()].sort((a, b) => a - b);
    const rendered = rounds.map((round) => bullets.get(round) as string);
    if (rounds.length > 1) {
      const highest = rounds[rounds.length - 1];
      const index = rounds.indexOf(highest);
      rendered[index] = rendered[index].replace(
        /^(- \*\*Round \d+ · [^·]+?)( · )/,
        '$1 (current)$2'
      );
    }

    return this.replaceSection(content, 'Review Notes', rendered.join('\n'));
  }

  /**
   * Upserts ONE `Quality Gate self-report (round R)` note (issue #376, AC16).
   *
   * The Duration column carries the wall clock only — two clocks packed into
   * one cell cannot be summed and no longer reconciled with
   * `Session Started → Commit`. The gate's own timer therefore renders as a
   * named note carrying both clocks, once per round, kept in ascending order.
   */
  private upsertGateSelfReport(content: string, round: number, text: string): string {
    const lines = content.split('\n');
    const rendered = `- **Quality Gate self-report (round ${round}):** ${text}`;
    const keyPrefix = `- **Quality Gate self-report (round ${round}):**`;

    const existingIndex = lines.findIndex((line) => line.startsWith(keyPrefix));
    if (existingIndex !== -1) {
      lines[existingIndex] = rendered;
      return lines.join('\n');
    }

    let anchor = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].startsWith('- **Quality Gate self-report (round ')) {
        anchor = i;
        break;
      }
    }
    if (anchor === -1) {
      // The last row of the LIFECYCLE table: the notes read directly beneath
      // the table they explain, never after a later section's table.
      const sectionStart = lines.findIndex(
        (line) => line.trim() === '## Lifecycle Execution Log'
      );
      const sectionEnd =
        sectionStart === -1
          ? -1
          : lines.findIndex(
              (line, index) => index > sectionStart && line.startsWith('## ')
            );
      const limit = sectionStart === -1 ? lines.length : sectionEnd === -1 ? lines.length : sectionEnd;
      for (let i = limit - 1; i >= Math.max(sectionStart, 0); i -= 1) {
        const line = lines[i];
        if (line.startsWith('|') && !line.includes('---') && !line.includes('Stage | Subagent')) {
          anchor = i;
          break;
        }
      }
    }
    if (anchor === -1) {
      return `${content.trimEnd()}\n\n${rendered}\n`;
    }

    lines.splice(anchor + 1, 0, '', rendered);
    return lines.join('\n');
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
