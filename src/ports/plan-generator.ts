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
}

export interface ScaffoldResult {
  readonly planDir: string;
  readonly folderName: string;
  readonly type: 'discovery' | 'implementation';
  readonly planPath: string;
  readonly mirrorPath: string;
  readonly summaryPath: string;
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
}

export interface GeneratePlanOptions {
  readonly targetDir: string;
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
  readonly created: boolean;
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
  findPlanDirectory(projectRoot: string, issueNumber: number | string): string | null;

  /**
   * Resolves the target plan directory and plan specification file.
   */
  resolvePlanFile(options: ResolvePlanOptions): ResolvedPlanLocation | null;

  /**
   * Reads the plan document content from disk.
   */
  readPlanDocument(planPath: string): string;
}
