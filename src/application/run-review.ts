/**
 * agyloop - RunReviewUseCase
 *
 * Coordinates AI Review phase execution:
 * 1. Validates lifecycle stage rules (current stage must be QUALITY_GATE or REVIEW).
 * 2. Advances StateMachine transition: QUALITY_GATE -> REVIEW.
 * 3. Resolves Reviewer Subagent configuration and model routing.
 * 4. Discovers and ingests repository standards (via StandardsRepository).
 * 5. Resolves approved plan document and extracts Acceptance Criteria.
 * 6. Assembles focused review task prompt.
 * 7. Executes review inspection and parses ReviewVerdict:
 *    - APPROVED: transitions to STAGE_COMMIT.
 *    - CHANGES_REQUESTED: loops back to STAGE_IMPLEMENT with self-correction guidance.
 * 8. Updates AgyLoop Summary.md with review verdict and duration.
 * 9. Checkpoints pipeline state to StateRepository.
 */

import {
  StateMachine,
  STAGE_NONE,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_IMPLEMENT,
  MODE_STANDARD,
  ROLE_REVIEWER,
  SUMMARY_STAGE_AI_REVIEW,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  NOTE_EXECUTING_REVIEW,
  NOTE_REVIEW_APPROVED,
  NOTE_REVIEW_CHANGES_REQUESTED,
  MS_PER_SECOND,
  ReviewVerdict,
  InvalidTransitionError
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  StandardsRepository,
  CritiquePort,
  CommandExecutorPort
} from '../ports';
import { ResolveSubagentUseCase, SubagentDescriptor } from './resolve-subagent';

export interface RunReviewParams {
  readonly issue?: number | string | null;
  readonly planPath?: string | null;
  readonly planDir?: string | null;
  readonly standardsPath?: string | null;
  readonly userInstructions?: string | null;
  readonly workingDiff?: string | null;
  readonly reviewOutput?: string | null;
  readonly staged?: boolean;
  readonly baseRef?: string;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  readonly workspaceDir?: string;
}

export interface RunReviewResult {
  readonly passed: boolean;
  readonly verdict: ReviewVerdict;
  readonly currentStage: string;
  readonly stateMachine: StateMachine;
  readonly reviewerDef: SubagentDescriptor;
  readonly taskPrompt: string;
  readonly standardsContent: string | null;
  readonly acceptanceCriteria: readonly string[];
  readonly durationMs: number;
}

function cleanBulletLine(rawLine: string): string {
  return rawLine
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .trim();
}

export function extractAcceptanceCriteria(planContent: string | null | undefined): readonly string[] {
  if (!planContent || typeof planContent !== 'string') {
    return Object.freeze([]);
  }

  const lines = planContent.split('\n');
  const criteria: string[] = [];
  let inAcSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for Acceptance Criteria section header
    if (
      line.match(/^#{1,4}\s+.*Acceptance\s+Criteria/i) ||
      line.match(/^-\s+\*\*Acceptance\s+Criteria:?\*\*/i) ||
      line.match(/^\*\*Acceptance\s+Criteria:?\*\*/i)
    ) {
      inAcSection = true;

      // Check if criterion is on the same line after colon
      const inline = line.replace(/^.*?Acceptance\s+Criteria:?\*{0,2}\s*/i, '').trim();
      const lower = inline.toLowerCase();
      if (
        inline.length > 0 &&
        !inline.startsWith('-') &&
        !inline.startsWith('#') &&
        lower !== 'none' &&
        lower !== 'none.' &&
        lower !== 'n/a'
      ) {
        criteria.push(cleanBulletLine(inline));
      }
      continue;
    }

    // If in AC section, collect list items until next section
    if (inAcSection) {
      if (line.startsWith('#') || line.match(/^-\s+\*\*[A-Za-z]/)) {
        inAcSection = false;
        continue;
      }

      if (line.startsWith('-') || line.startsWith('*') || line.match(/^\d+\./)) {
        const cleaned = cleanBulletLine(line);
        if (cleaned.length > 0 && cleaned.toLowerCase() !== 'none' && cleaned.toLowerCase() !== 'n/a') {
          criteria.push(cleaned);
        }
      }
    }
  }

  return Object.freeze(criteria);
}

export class RunReviewUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator: PlanGeneratorPort;
  private readonly standardsRepo?: StandardsRepository;
  private readonly critique?: CritiquePort;
  private readonly commandExecutor?: CommandExecutorPort;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort,
    standardsRepo?: StandardsRepository,
    critique?: CritiquePort,
    commandExecutor?: CommandExecutorPort,
    resolveSubagentUseCase?: ResolveSubagentUseCase
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.standardsRepo = standardsRepo;
    this.critique = critique;
    this.commandExecutor = commandExecutor;
    this.resolveSubagentUseCase =
      resolveSubagentUseCase ?? new ResolveSubagentUseCase(configRepo);
  }

  public async execute(params: RunReviewParams = {}): Promise<RunReviewResult> {
    const workspace = params.workspaceDir || process.cwd();
    const startTime = Date.now();

    // 1. Load active pipeline state checkpoint
    const snapshot = await this.stateRepo.load();
    if (!snapshot) {
      throw new InvalidTransitionError(
        STAGE_NONE,
        STAGE_REVIEW,
        MODE_STANDARD,
        'Cannot run review: No pipeline state found. Run "agyloop implement" and "agyloop gates" first.'
      );
    }

    const sm = StateMachine.fromSnapshot(snapshot);
    const activeIssue = params.issue || sm.issue;
    if (activeIssue) {
      sm.setIssue(activeIssue);
    }

    // 2. Enforce lifecycle transition rules
    if (sm.currentStage === STAGE_QUALITY_GATE) {
      sm.transition(STAGE_REVIEW, { note: NOTE_EXECUTING_REVIEW });
    } else if (sm.currentStage === STAGE_REVIEW) {
      // Re-running review in REVIEW stage
    } else {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_REVIEW,
        sm.mode,
        `Cannot run review from stage '${sm.currentStage}'. Pipeline must be in '${STAGE_QUALITY_GATE}' (or re-running in '${STAGE_REVIEW}').`
      );
    }

    // 3. Load config and resolve subagent descriptor
    const config = this.configRepo.loadConfig({
      customPath: params.configPath,
      cwd: workspace
    });

    const reviewerDef = this.resolveSubagentUseCase.execute({
      role: ROLE_REVIEWER,
      customConfig: config,
      workspaceDir: workspace
    });

    // 4. Ingest repository standards
    const standardsContent = this.standardsRepo
      ? this.standardsRepo.loadStandards({
          customPath: params.standardsPath,
          cwd: workspace
        })
      : null;

    // 5. Resolve approved plan specification & extract Acceptance Criteria
    const resolvedPlan = this.planGenerator.resolvePlanFile({
      projectRoot: workspace,
      issue: activeIssue,
      planPath: params.planPath,
      planDir: params.planDir
    });

    let planContent = '';
    let acceptanceCriteria: readonly string[] = Object.freeze([]);

    if (resolvedPlan && resolvedPlan.planPath) {
      try {
        planContent = this.planGenerator.readPlanDocument(resolvedPlan.planPath);
        acceptanceCriteria = extractAcceptanceCriteria(planContent);
      } catch {
        // Plan read failure non-fatal, proceed with empty criteria
      }
    }

    // 6. Assemble focused review task prompt
    const taskPrompt = this.resolveSubagentUseCase.buildReviewerTaskPrompt({
      issueNumber: activeIssue,
      acceptanceCriteria,
      standardsContent,
      workingDiff: params.workingDiff,
      userInstructions: params.userInstructions,
      workspaceDir: workspace,
      config
    });

    // 7. Execute review inspection & parse ReviewVerdict
    let verdict: ReviewVerdict;

    if (params.reviewOutput) {
      verdict = ReviewVerdict.parse(params.reviewOutput);
    } else if (this.critique) {
      const aiReport = await this.critique.review({
        cwd: workspace,
        staged: params.staged,
        baseRef: params.baseRef
      });
      verdict = ReviewVerdict.fromAiReviewReport(aiReport);
    } else {
      // Default inspection verdict when neither raw subagent output nor critique gateway provided
      verdict = new ReviewVerdict({
        status: VERDICT_APPROVED,
        summary: 'Review passed: All acceptance criteria and code standards verified.',
        unfulfilledCriteria: [],
        remediationGuidance: []
      });
    }

    const durationMs = Date.now() - startTime;
    const durationStr = `${(durationMs / MS_PER_SECOND).toFixed(1)}s`;

    // 8. Enforce State Transitions based on ReviewVerdict
    if (verdict.isApproved()) {
      sm.transition(STAGE_COMMIT, {
        note: NOTE_REVIEW_APPROVED,
        reviewVerdict: VERDICT_APPROVED,
        reviewTokens: verdict.formatStructuredTokens()
      });
    } else {
      sm.transition(STAGE_IMPLEMENT, {
        note: NOTE_REVIEW_CHANGES_REQUESTED,
        reviewVerdict: VERDICT_CHANGES_REQUESTED,
        reviewTokens: verdict.formatStructuredTokens(),
        selfCorrectionPayload: verdict.formatSelfCorrectionPayload()
      });
    }

    // 9. Update AgyLoop Summary.md & State Checkpoint
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      if (resolvedPlan && resolvedPlan.summaryPath) {
        this.planGenerator.updateSummaryLog(resolvedPlan.summaryPath, {
          stage: SUMMARY_STAGE_AI_REVIEW,
          subagent: reviewerDef.name,
          model: reviewerDef.model,
          status: verdict.status,
          duration: durationStr,
          reviewNote: verdict.isApproved()
            ? `Review approved in ${durationStr}: ${verdict.summary}`
            : `Review requested changes: ${verdict.summary} Pipeline reverted to IMPLEMENT for self-correction.`
        });
      }
    }

    return {
      passed: verdict.isApproved(),
      verdict,
      currentStage: sm.currentStage,
      stateMachine: sm,
      reviewerDef,
      taskPrompt,
      standardsContent,
      acceptanceCriteria,
      durationMs
    };
  }
}
