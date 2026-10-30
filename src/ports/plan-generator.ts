/**
 * agyloop - PlanGeneratorPort Interface
 *
 * Port interface for persistent plan directory scaffolding, templating,
 * and execution log maintenance.
 */

export interface ScaffoldParams {
  readonly projectRoot?: string;
  readonly issue?: number | string | null;
  readonly title?: string | null;
  readonly type?: string | null;
  readonly labels?: readonly string[];
  readonly templatesDir?: string;
  /**
   * The checkpoint's tracked directory (issue #283). Explicit intent wins over
   * the derived slug — but a populated sibling report still wins over an empty
   * tracked directory, which is what heals the orphaned-report case.
   */
  readonly planDir?: string | null;
}

export interface ScaffoldResult {
  readonly planDir: string;
  readonly folderName: string;
  readonly type: 'discovery' | 'implementation';
  readonly planPath: string;
  readonly mirrorPath: string;
  readonly summaryPath: string;
  /** `mkdir` actually happened this run (issue #240/Defect 5). */
  readonly directoryCreated: boolean;
  /** Any of plan/mirror/summary was actually written this run. */
  readonly filesCreated: boolean;
  /** The target directory already existed and was reused. */
  readonly adoptedExisting: boolean;
}

/** One gate that was declared but never executed (issue #284). */
export interface SummaryNotRunEntry {
  readonly id: string;
  readonly label?: string;
  readonly reason: string;
}

/**
 * One declared smoke check and its verdict (issue #325, AC-17).
 *
 * Structurally identical to the domain's `GateSmokeCheck`; declared here so the
 * port stays dependency-free. `passed: null` means "ran without reporting a
 * verdict" and renders as an unknown mark — never as a pass.
 */
export interface SummarySmokeCheck {
  readonly id: string;
  readonly label?: string;
  readonly passed: boolean | null;
}

export interface SummaryUpdateData {
  readonly stage?: string;
  readonly status?: string;
  readonly subagent?: string;
  readonly model?: string;
  readonly duration?: string;
  readonly notes?: string;
  readonly buildStatus?: string;
  readonly testsStatus?: string;
  readonly reviewNote?: string;
  /**
   * ONE authoritative review note (issue #284, AC6).
   *
   * Replace-on-write: the section is rewritten, never appended to, so a
   * re-review cannot leave two verdicts with no authority marker.
   */
  readonly reviewRecord?: {
    readonly round: number;
    readonly verdict: string;
    readonly baseCommit: string | null;
    readonly timestamp: string;
    readonly summary: string;
  };
  /**
   * Gates that were declared but NOT executed (issue #284). Rendered as one
   * `- **Not Run:** …` line, so "never attempted" is distinguishable from
   * "passed". Tri-state (issue #338): `undefined` leaves the line untouched,
   * `[]` removes it, a non-empty list replaces it.
   */
  readonly notRun?: readonly SummaryNotRunEntry[];
  /**
   * Finalizes the summary when the run lands at COMPLETED (issue #284).
   *
   * Any stage row still `PENDING` / `IN PROGRESS` becomes `NOT RECORDED`, and
   * the metric defaults become `not recorded`. A completed run must never read
   * as one that has not started.
   */
  readonly finalize?: boolean;
  /**
   * The filed report's build system (issue #338). Tri-state, like the list
   * metrics below: `undefined` leaves the line untouched, `null` REMOVES it
   * (this round filed no report, so it names no ecosystem).
   */
  readonly buildSystem?: string | null;
  readonly detectedEcosystems?: readonly string[] | string;
  /**
   * Commands THIS round measured (issue #338). `undefined` leaves the line
   * untouched, `[]` removes it, a non-empty list replaces it.
   */
  readonly executedCommands?: readonly string[];
  /**
   * Declared smoke checks, each with its own verdict (issue #325, AC-17).
   * Rendered as its own line so the command list stays commands only.
   * `undefined` leaves the line untouched, `[]` removes it.
   */
  readonly smokeChecks?: readonly SummarySmokeCheck[];
  /**
   * The round's smoke-protocol verdict (issue #338): a wire token
   * (`PASSED` / `FAILED` / `NOT_DECLARED`) or `SMOKE_PROTOCOL_NOT_REPORTED`.
   * `undefined` leaves the line untouched; `null` removes it.
   */
  readonly smokeProtocol?: string | null;
  readonly commitHash?: string;
  readonly commitMessage?: string;
  readonly commitTimestamp?: string;
  readonly planRevisionCount?: number;
  readonly prComments?: readonly string[] | string;
  readonly commitRejection?: {
    readonly targetStage?: string;
    readonly reason?: string;
  } | string;
  readonly abortEvent?: {
    readonly timestamp: string;
    readonly stage: string;
    readonly subagent?: string;
    readonly filesTouched?: readonly string[];
    readonly teardownMetrics?: Record<string, unknown> | string;
    readonly reason?: string;
  };
}

export interface GeneratePlanOptions {
  readonly targetDir: string;
  /**
   * The canonical folder name DERIVED by this call, when the caller derived
   * one (issue #364 review). Omit it when `targetDir` is an ADOPTED directory:
   * a pre-#364 folder name can exceed the 143-byte bound, and the filesystem
   * accepting the name is proof enough. The filename assertion always runs.
   */
  readonly folderName?: string | null;
  /**
   * The exact primary artifact to write (issue #283). When supplied, the
   * existing-primary reuse has already chosen it (e.g. a populated
   * `[Discovery] - <title>.md` that must be reused byte-for-byte).
   */
  readonly planPath?: string | null;
  readonly type?: 'discovery' | 'implementation';
  readonly title?: string;
  readonly issueNumber?: number | string;
  readonly date?: string;
  readonly variables?: Record<string, unknown>;
  readonly overwrite?: boolean;
  readonly createMirror?: boolean;
  readonly templatesDir?: string | null;
}

export interface GeneratePlanResult {
  readonly planPath: string;
  readonly mirrorPath: string | null;
  readonly content: string;
  /** The spec content when it differs from `content` (discovery scaffolds). */
  readonly mirrorContent: string | null;
  readonly created: boolean;
  readonly mirrorCreated: boolean;
}

export interface GenerateSummaryLogOptions {
  readonly targetDir: string;
  readonly projectName?: string;
  readonly issueNumber?: number | string;
  readonly timestamp?: string;
  readonly variables?: Record<string, unknown>;
  readonly overwrite?: boolean;
  readonly templatesDir?: string | null;
}

export interface GenerateSummaryLogResult {
  readonly summaryPath: string;
  readonly content: string;
  readonly created: boolean;
}

export interface ResolvePlanOptions {
  readonly projectRoot?: string;
  readonly issue?: number | string | null;
  readonly planPath?: string | null;
  readonly planDir?: string | null;
  readonly title?: string | null;
  readonly stage?: string;
}

export interface ResolvedPlanLocation {
  readonly planDir: string;
  readonly planPath: string;
  readonly planFileName: string;
  readonly summaryPath?: string;
}

export interface PlanGeneratorPort {
  /**
   * Scaffolds an issue plan directory with templates and execution summary.
   */
  scaffoldPlanDirectory(params: ScaffoldParams): ScaffoldResult;

  /**
   * The plan type a scaffold would resolve from a title + labels (issue #364).
   *
   * `--type auto` delegates here, so a `--dry-run` can preview the SAME
   * artifact prefix the real run writes (`[Discovery] - ` vs
   * `[Implementation] - `) instead of always guessing implementation.
   * Optional so existing fake generators need no change.
   */
  detectPlanType?(title: string, labels?: readonly string[]): 'discovery' | 'implementation';

  /**
   * Generates a plan document in targetDir.
   */
  generatePlan(options: GeneratePlanOptions): GeneratePlanResult;

  /**
   * Generates summary log in targetDir.
   */
  generateSummaryLog(options: GenerateSummaryLogOptions): GenerateSummaryLogResult;

  /**
   * Updates stage status or metrics in an existing AgyLoop Summary.md file.
   */
  updateSummaryLog(summaryFilePath: string, updateData: SummaryUpdateData): boolean;

  /**
   * Finds the existing plan directory for an issue.
   */
  findPlanDirectory(projectRoot: string, issueNumber: number | string, title?: string): string | null;

  /**
   * Resolves the target plan directory and plan specification file.
   */
  resolvePlanFile(options: ResolvePlanOptions): ResolvedPlanLocation | null;

  /**
   * Reads the plan document content from disk.
   */
  readPlanDocument(planPath: string): string;

  /**
   * Returns the sha256 of the NORMALIZED plan bytes (issue #298), or `null`
   * when the file cannot be read. Checkbox ticks and line-ending noise are
   * normalized away, so they are not plan edits.
   *
   * Optional: a legacy/external mock without it simply reports plan integrity
   * as UNVERIFIED instead of failing.
   */
  hashPlanDocument?(planPath: string): string | null;
}
