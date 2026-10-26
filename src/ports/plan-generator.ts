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
  readonly buildSystem?: string;
  readonly detectedEcosystems?: readonly string[] | string;
  readonly executedCommands?: readonly string[];
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
