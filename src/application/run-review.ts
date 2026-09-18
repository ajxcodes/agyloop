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
  STAGE_COMPLETED,
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
  PublicSanitizer,
  InvalidTransitionError,
  AiReviewReport,
  AiReviewFinding,
  DIFF_EXCLUDE_ARGS,
  DiffAnalyzer
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  StandardsRepository,
  CritiquePort,
  CritiqueResolution,
  CritiqueInstallerPort,
  ConfirmationPromptPort,
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
  readonly critiqueReport?: string | null;
  readonly staged?: boolean;
  readonly baseRef?: string;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  readonly workspaceDir?: string;
  readonly confirmationPrompt?: ConfirmationPromptPort;
  readonly critiqueInstaller?: CritiqueInstallerPort;
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
  readonly suggestedCommitMessage?: string;
  readonly critiqueReport?: string | null;
  readonly updateNotification?: string | null;
  readonly autoInstalled?: boolean;
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
  private readonly critiqueInstaller?: CritiqueInstallerPort;
  private readonly confirmationPrompt?: ConfirmationPromptPort;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort,
    standardsRepo?: StandardsRepository,
    critique?: CritiquePort,
    commandExecutor?: CommandExecutorPort,
    resolveSubagentUseCase?: ResolveSubagentUseCase,
    critiqueInstaller?: CritiqueInstallerPort,
    confirmationPrompt?: ConfirmationPromptPort
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.standardsRepo = standardsRepo;
    this.critique = critique;
    this.commandExecutor = commandExecutor;
    this.resolveSubagentUseCase =
      resolveSubagentUseCase ?? new ResolveSubagentUseCase(configRepo, undefined, undefined, critique);
    this.critiqueInstaller = critiqueInstaller;
    this.confirmationPrompt = confirmationPrompt;
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
    } else if (sm.currentStage === STAGE_COMPLETED) {
      sm.transition(STAGE_REVIEW, { note: NOTE_EXECUTING_REVIEW });
    } else {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_REVIEW,
        sm.mode,
        `Cannot run review from stage '${sm.currentStage}'. Pipeline must be in '${STAGE_QUALITY_GATE}', '${STAGE_COMPLETED}' (or re-running in '${STAGE_REVIEW}').`
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

    const reviewCwd = sm.worktree?.worktreePath || workspace;
    const targetBaseRef = params.baseRef || sm.baseBranch || undefined;

    let updateNotification: string | null = null;
    let autoInstalled = false;

    // Tier 1: Execute Automated Critique Diagnostics (if CritiquePort available)
    let aiReport: AiReviewReport | null = null;
    let critiqueReportText: string | null = params.critiqueReport || null;
    let critiqueResolution: CritiqueResolution | null = null;

    if (this.critique) {
      const prompt = params.confirmationPrompt ?? this.confirmationPrompt;
      const installer = params.critiqueInstaller ?? this.critiqueInstaller;

      let resolution = typeof this.critique.resolveReviewer === 'function'
        ? await Promise.resolve(this.critique.resolveReviewer(reviewCwd))
        : { source: 'system_path' as const, path: 'critique', isAvailable: true };
      critiqueResolution = resolution;

      // Auto-install fallback prompt if critique CLI is absent and confirmation prompt is available
      if (!resolution.isAvailable && prompt && installer) {
        const confirmed = await prompt.confirm(
          'Critique CLI is not installed. Would you like to install it automatically? [Y/n]',
          true
        );
        if (confirmed) {
          const installResult = await installer.install();
          if (installResult.success) {
            autoInstalled = true;
            if (typeof this.critique.resolveReviewer === 'function') {
              resolution = await Promise.resolve(this.critique.resolveReviewer(reviewCwd));
              critiqueResolution = resolution;
            }
          }
        }
      }

      // Non-blocking version update check with 24-hour cache TTL
      if (resolution.isAvailable && resolution.path && installer && typeof this.critique.getVersion === 'function') {
        try {
          const currentVer = await this.critique.getVersion(resolution.path);
          const versionInfo = await installer.checkUpdateAvailable(currentVer, {
            resolvedPath: resolution.path,
            timeoutMs: 3000
          });
          if (versionInfo.isOutdated && versionInfo.currentVersion && versionInfo.latestVersion) {
            updateNotification = `💡 A new version of critique is available (v${versionInfo.currentVersion} -> v${versionInfo.latestVersion}).\n   Run \`agyloop critique update\` to upgrade.`;
            console.log(`\n${updateNotification}\n`);
          }
        } catch {
          // Non-blocking, ignore errors
        }
      }

      try {
        aiReport = await this.critique.review({
          cwd: reviewCwd,
          staged: params.staged,
          baseRef: targetBaseRef
        });
        if (aiReport) {
          critiqueReportText = aiReport.formatMarkdownReport();
        }
      } catch {
        // Non-fatal if critique execution fails
      }
    }

    let workingDiff = params.workingDiff;
    if (workingDiff === undefined && this.commandExecutor) {
      try {
        const targetBase = targetBaseRef || 'main';
        const diffCmd = params.staged
          ? `git diff --cached -- . ${DIFF_EXCLUDE_ARGS}`
          : `git diff ${targetBase} -- . ${DIFF_EXCLUDE_ARGS}`;
        const res = await this.commandExecutor.execute(diffCmd, { cwd: reviewCwd });
        if (res && typeof res.stdout === 'string' && res.stdout.trim()) {
          workingDiff = res.stdout;
        }
      } catch {
        // Non-fatal, let Reviewer subagent inspect diff on demand
      }
    }

    // Tier 2: Assemble focused review task prompt for Reviewer subagent
    const taskPrompt = this.resolveSubagentUseCase.buildReviewerTaskPrompt({
      issueNumber: activeIssue,
      baseBranch: targetBaseRef,
      acceptanceCriteria,
      standardsContent,
      workingDiff,
      critiqueReport: critiqueReportText,
      critiquePath: critiqueResolution?.isAvailable ? critiqueResolution.path : undefined,
      userInstructions: params.userInstructions,
      workspaceDir: workspace,
      config
    });

    // Evaluate ReviewVerdict
    let verdict: ReviewVerdict;

    if (params.reviewOutput) {
      verdict = ReviewVerdict.parse(params.reviewOutput);
    } else if (aiReport) {
      verdict = ReviewVerdict.fromAiReviewReport(aiReport);
    } else {
      verdict = new ReviewVerdict({
        status: VERDICT_CHANGES_REQUESTED,
        summary: 'Review failed: Neither Reviewer subagent output nor critique report was generated.',
        unfulfilledCriteria: [
          'Review inspection not performed: neither subagent output nor critique report was provided'
        ],
        remediationGuidance: [
          'Execute critique CLI or invoke Reviewer subagent to inspect diff against base branch and provide structured review output.'
        ]
      });
    }

    // Two-Tier Invariant Enforcement:
    // Any critical or error violations from critique or unfulfilled ACs mandate CHANGES_REQUESTED
    if (aiReport && (aiReport.hasBlockingIssues() || aiReport.errorCount() > 0)) {
      const critiqueCriteria: string[] = [];
      const critiqueRemediation: string[] = [];
      for (const finding of aiReport.findings.filter((f: AiReviewFinding) => f.isBlocking() || f.isError())) {
        critiqueCriteria.push(`[Critique ${finding.severity.toUpperCase()}] ${finding.path}:${finding.line} - ${finding.body}`);
        critiqueRemediation.push(`Fix ${finding.severity} in ${finding.path}:${finding.line}: ${finding.body}`);
      }
      verdict = new ReviewVerdict({
        status: VERDICT_CHANGES_REQUESTED,
        summary: `Review failed: Automated critique detected ${aiReport.errorCount() + (aiReport.hasBlockingIssues() ? 1 : 0)} blocking/error violation(s). ${verdict.summary}`,
        unfulfilledCriteria: [...verdict.unfulfilledCriteria, ...critiqueCriteria],
        remediationGuidance: [...verdict.remediationGuidance, ...critiqueRemediation],
        confidenceLevel: aiReport.confidence.level,
        findings: [...verdict.findings, ...aiReport.findings]
      });
    } else if (verdict.unfulfilledCriteria.length > 0 && verdict.isApproved()) {
      verdict = new ReviewVerdict({
        status: VERDICT_CHANGES_REQUESTED,
        summary: `Review requested changes: Unfulfilled Acceptance Criteria detected. ${verdict.summary}`,
        unfulfilledCriteria: verdict.unfulfilledCriteria,
        remediationGuidance:
          verdict.remediationGuidance.length > 0
            ? verdict.remediationGuidance
            : verdict.unfulfilledCriteria.map((ac) => `Fulfill acceptance criterion: ${ac}`),
        confidenceLevel: verdict.confidenceLevel,
        findings: verdict.findings
      });
    }

    const durationMs = Date.now() - startTime;
    const durationStr = `${(durationMs / MS_PER_SECOND).toFixed(1)}s`;

    // Formulate auto-suggested conventional commit message if approved
    let suggestedCommitMessage: string | undefined = undefined;
    if (verdict.isApproved()) {
      const issueNum = activeIssue || sm.issue;
      const issueRef = issueNum ? ` (#${issueNum})` : '';
      let desc = 'implement approved changes';
      if (resolvedPlan?.planPath) {
        const baseName = resolvedPlan.planPath.split('/').pop() || '';
        const cleanName = baseName.replace(/\.md$/, '').replace(/^\[Implementation\]\s*-\s*/i, '');
        if (cleanName.trim()) {
          desc = cleanName.trim().toLowerCase().replace(/^(feat|fix|chore):?\s*/i, '');
        }
      }
      const rawMsg = `feat: ${desc}${issueRef}`;
      suggestedCommitMessage = PublicSanitizer.sanitizeCommitMessage(rawMsg);
    }

    // Enforce State Transitions based on ReviewVerdict
    if (verdict.isApproved()) {
      sm.transition(STAGE_COMMIT, {
        note: NOTE_REVIEW_APPROVED,
        reviewVerdict: VERDICT_APPROVED,
        reviewTokens: verdict.formatStructuredTokens(),
        suggestedCommitMessage
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
        const noteDetails = verdict.isApproved()
          ? `Review approved in ${durationStr}: ${verdict.summary}${
              suggestedCommitMessage ? `\nSuggested Commit: \`${suggestedCommitMessage}\`` : ''
            }`
          : `Review requested changes: ${verdict.summary} Pipeline reverted to IMPLEMENT for self-correction.`;

        this.planGenerator.updateSummaryLog(resolvedPlan.summaryPath, {
          stage: SUMMARY_STAGE_AI_REVIEW,
          subagent: reviewerDef.name,
          model: reviewerDef.model,
          status: verdict.status,
          duration: durationStr,
          reviewNote: noteDetails
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
      durationMs,
      suggestedCommitMessage,
      critiqueReport: critiqueReportText,
      updateNotification,
      autoInstalled
    };
  }
}
