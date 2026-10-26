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
 *    - SKIPPED: transitions to STAGE_COMMIT as an advisory (no reviewer/critique available).
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
  VERDICT_CHANGES_REQUESTED,
  NOTE_EXECUTING_REVIEW,
  NOTE_REVIEW_APPROVED,
  NOTE_REVIEW_CHANGES_REQUESTED,
  NOTE_REVIEW_SKIPPED,
  NOTE_REVIEW_REOPENED_FROM_COMMIT,
  GATE_COMMIT,
  MS_PER_SECOND,
  ReviewVerdict,
  ReviewSource,
  REVIEW_SOURCE_REVIEWER_OUTPUT,
  REVIEW_SOURCE_CRITIQUE_REPORT,
  REVIEW_SOURCE_SKIPPED,
  REVIEW_SOURCE_REVIEWER_OUTPUT_ESCALATED,
  PublicSanitizer,
  InvalidTransitionError,
  ReviewerSubagentError,
  AiReviewReport,
  AiReviewFinding,
  DEFAULT_CRITIQUE_REVIEW_TIMEOUT_MS,
  DIFF_EXCLUDE_ARGS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  /**
   * A Tier 1 critique report that was produced ELSEWHERE (issue #269, R2/R3).
   *
   * It is the DEDUPED evidence path (issue #297): the report still informs the
   * reviewer prompt and it still drives the TWO-TIER INVARIANT (see
   * `applyTwoTierInvariant`). When it is supplied the critique CLI is not
   * executed — the same evidence, no second subprocess.
   */
  readonly priorCritiqueReport?: AiReviewReport | null;
  readonly critiqueReport?: string | null;
  readonly staged?: boolean;
  readonly baseRef?: string;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  readonly workspaceDir?: string;
  readonly confirmationPrompt?: ConfirmationPromptPort;
  readonly critiqueInstaller?: CritiqueInstallerPort;
  /**
   * True only when a human can answer prompts. Defaults to true for backwards
   * compatibility; the CLI composition root and the readline adapter both enforce
   * TTY so a non-interactive session can never block (issue #218 AC6).
   */
  readonly interactive?: boolean;
}

export interface RunReviewResult {
  /**
   * True when the review stage did not block the pipeline — i.e. the verdict was
   * APPROVED, or SKIPPED as an advisory because no reviewer output or critique
   * report was produced (issue #236). Only a genuine CHANGES_REQUESTED is false.
   */
  readonly passed: boolean;
  readonly verdict: ReviewVerdict;
  /**
   * WHERE the recorded verdict came from (issue #269).
   *
   * - `reviewer-output` — the dispatched Reviewer subagent's verdict block
   *   (Tier 2), filed through `codeloop review --verdict-file`.
   * - `critique-report` — the critique CLI's report (Tier 1).
   * - `skipped` — the advisory fail-open: no reviewer output and no critique
   *   report (issue #236).
   * - `reviewer-output+critique-escalation` — the reviewer APPROVED and the
   *   TWO-TIER INVARIANT escalated the verdict because the critique report
   *   carried a blocking/error finding. The source names BOTH contributors so
   *   it can never claim the reviewer asked for changes the reviewer never
   *   asked for (issue #269, R3).
   */
  readonly reviewSource?: ReviewSource;
  /**
   * True when a real (non-bypassed) Tier 1 critique report informed this
   * verdict (issue #297, AC10). Persisted beside `reviewVerdict`/`reviewSource`
   * so a recorded verdict can be audited after the fact: a reviewer verdict
   * recorded with `critiqueVerified: false` was never cross-checked.
   */
  readonly critiqueVerified: boolean;
  readonly currentStage: string;
  /**
   * The stage the checkpoint was at BEFORE this call transitioned it — the
   * stage a `--dry-run` leaves on disk (#248).
   */
  readonly previousStage?: string;
  /** True when this was a simulation (#248). */
  readonly dryRun?: boolean;
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

/**
 * What escalated a verdict, if anything (issue #269, R3).
 *
 * - `critique` — a Tier 1 critique report carried a blocking/error finding;
 * - `unfulfilled-criteria` — the verdict block itself listed unfulfilled
 *   Acceptance Criteria.
 */
export type ReviewEscalation = 'critique' | 'unfulfilled-criteria';

/**
 * The outcome of the TWO-TIER INVARIANT.
 */
export interface TwoTierInvariantOutcome {
  readonly verdict: ReviewVerdict;
  /**
   * What escalated the verdict, or `null` when nothing did. The recorded
   * SOURCE is derived from it, so the source can never claim the reviewer
   * produced a status the reviewer did not produce.
   */
  readonly escalatedBy: ReviewEscalation | null;
}

/**
 * The TWO-TIER INVARIANT: a Tier 1 critique report may ESCALATE a verdict to
 * CHANGES_REQUESTED (issue #269, R3).
 *
 * Any critical or error violation from critique, or an APPROVED verdict whose
 * own block lists unfulfilled Acceptance Criteria, mandates CHANGES_REQUESTED.
 * Bypassed reports carry zero findings, but the guard also guarantees a stray
 * finding on a bypassed report can never overwrite SKIPPED with
 * CHANGES_REQUESTED.
 *
 * Extracted as a PURE function so the escalation is testable on its own and
 * so the recorded verdict and the recorded source can never drift apart: the
 * caller derives the source from `escalatedBy`, not from a guess.
 */
export function applyTwoTierInvariant(
  verdict: ReviewVerdict,
  aiReport: AiReviewReport | null
): TwoTierInvariantOutcome {
  if (aiReport && !aiReport.bypassed && (aiReport.hasBlockingIssues() || aiReport.errorCount() > 0)) {
    const critiqueCriteria: string[] = [];
    const critiqueRemediation: string[] = [];
    for (const finding of aiReport.findings.filter((f: AiReviewFinding) => f.isBlocking() || f.isError())) {
      critiqueCriteria.push(`[Critique ${finding.severity.toUpperCase()}] ${finding.path}:${finding.line} - ${finding.body}`);
      critiqueRemediation.push(`Fix ${finding.severity} in ${finding.path}:${finding.line}: ${finding.body}`);
    }
    return {
      escalatedBy: 'critique',
      verdict: new ReviewVerdict({
        status: VERDICT_CHANGES_REQUESTED,
        summary: `Review failed: Automated critique detected ${aiReport.errorCount() + (aiReport.hasBlockingIssues() ? 1 : 0)} blocking/error violation(s). ${verdict.summary}`,
        unfulfilledCriteria: [...verdict.unfulfilledCriteria, ...critiqueCriteria],
        remediationGuidance: [...verdict.remediationGuidance, ...critiqueRemediation],
        confidenceLevel: aiReport.confidence.level,
        findings: [...verdict.findings, ...aiReport.findings]
      })
    };
  }

  if (verdict.unfulfilledCriteria.length > 0 && verdict.isApproved()) {
    return {
      escalatedBy: 'unfulfilled-criteria',
      verdict: new ReviewVerdict({
        status: VERDICT_CHANGES_REQUESTED,
        summary: `Review requested changes: Unfulfilled Acceptance Criteria detected. ${verdict.summary}`,
        unfulfilledCriteria: verdict.unfulfilledCriteria,
        remediationGuidance:
          verdict.remediationGuidance.length > 0
            ? verdict.remediationGuidance
            : verdict.unfulfilledCriteria.map((ac) => `Fulfill acceptance criterion: ${ac}`),
        confidenceLevel: verdict.confidenceLevel,
        findings: verdict.findings
      })
    };
  }

  return { escalatedBy: null, verdict };
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

    // A verdict was REQUESTED but arrived EMPTY (issue #269, R1). The
    // operator asked for the reviewer's verdict, so the verdict was never
    // read — and the only safe answer is a LOUD failure. Falling through to
    // the critique path would record a `SKIPPED` verdict, which is a silent
    // downgrade of the reviewer's real one.
    if (
      params.reviewOutput !== undefined &&
      params.reviewOutput !== null &&
      params.reviewOutput.trim().length === 0
    ) {
      throw new ReviewerSubagentError(
        'parse',
        'Reviewer verdict output is empty: a verdict that was never read must fail loudly.'
      );
    }

    /**
     * Whether the dispatched reviewer's verdict block was supplied (issues
     * #269, #297).
     *
     * This is NO LONGER a licence to skip Tier 1. #269 skipped critique to keep
     * the recording path off the network; #297 showed the cost — a self-filed
     * `APPROVED` was never cross-checked, so an `error` finding could be
     * overruled by the very verdict it should fail. The critique still runs on
     * this path (bounded, non-interactive); `priorCritiqueReport` is the dedupe.
     */
    const filingPath =
      typeof params.reviewOutput === 'string' && params.reviewOutput.trim().length > 0;

    // 1. Load active pipeline state checkpoint
    const snapshot = await this.stateRepo.load();
    if (!snapshot) {
      throw new InvalidTransitionError(
        STAGE_NONE,
        STAGE_REVIEW,
        MODE_STANDARD,
        'Cannot run review: No pipeline state found. Run "agyloop implement" and "agyloop next" first.'
      );
    }

    const sm = StateMachine.fromSnapshot(snapshot);
    // Captured BEFORE any transition below: on a dry run this is the stage that
    // stays on disk, so the report must never present the unwritten next stage
    // as the current one (#248 AC-248.7).
    const previousStage = sm.currentStage;
    const activeIssue = params.issue || sm.issue;
    /**
     * Whether the COMMIT pause must be restored after the verdict is recorded.
     * Only set when the review was re-opened from the COMMIT gate.
     */
    let reopenRestorePauseAtCommit = false;
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
    } else if (sm.currentStage === STAGE_COMMIT) {
      // A dispatched reviewer's verdict can arrive while the pipeline ALREADY
      // rests at the COMMIT gate (issue #269). That is precisely the live
      // defect: the commit gate reported "No AI review verdict is recorded for
      // this task" while the reviewer was holding a genuine APPROVED verdict
      // that had NO channel to reach the checkpoint. The verdict is the
      // reviewer's own record of the review, so it must still be recordable —
      // and it must still be able to FAIL the gate.
      //
      // `COMMIT -> REVIEW` is not a legal transition and the transition table
      // is NOT widened (issue #269 invariant 1), so the machine is re-opened
      // through the legal route `COMMIT -> QUALITY_GATE -> REVIEW`. The quality
      // gate had already run — reaching the COMMIT gate requires it — so this
      // is a bookkeeping re-entry, not a re-run.
      //
      // The stale COMMIT pause is consumed here: the human wait at the commit
      // gate is over (a verdict arrived), so it must not keep claiming
      // "waiting for a human" while the machine sits at REVIEW. It is
      // restored below when the verdict leaves the machine at COMMIT.
      const wasPausedAtCommit = sm.pausedAtGate === GATE_COMMIT;
      if (sm.pausedAtGate) {
        sm.resumeFromGate();
      }
      sm.transition(STAGE_QUALITY_GATE, { note: NOTE_REVIEW_REOPENED_FROM_COMMIT });
      sm.transition(STAGE_REVIEW, { note: NOTE_EXECUTING_REVIEW });
      reopenRestorePauseAtCommit = wasPausedAtCommit;
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
      planDir: params.planDir || sm.planDir,
      stage: sm.currentStage
    });

    // eslint-disable-next-line no-useless-assignment
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
    //
    // Issue #297: Tier 1 is NOT disabled by a supplied reviewer verdict. The
    // critique run is the cross-check that makes a filed `APPROVED` trustworthy;
    // `priorCritiqueReport` is the dedupe when the evidence was already
    // produced. On the filing path the run is non-interactive (no install
    // prompt, no update check) and carries a bounded timeout.
    let aiReport: AiReviewReport | null = null;
    let critiqueReportText: string | null = params.critiqueReport || null;
    let critiqueResolution: CritiqueResolution | null = null;

    const shouldExecuteCritique = Boolean(this.critique) && !params.priorCritiqueReport;

    if (shouldExecuteCritique && this.critique) {
      const prompt = params.confirmationPrompt ?? this.confirmationPrompt;
      const installer = params.critiqueInstaller ?? this.critiqueInstaller;

      let resolution = typeof this.critique.resolveReviewer === 'function'
        ? await Promise.resolve(this.critique.resolveReviewer(reviewCwd))
        : { source: 'system_path' as const, path: 'critique', isAvailable: true };
      critiqueResolution = resolution;

      // Auto-install fallback prompt if critique CLI is absent and confirmation
      // prompt is available. NEVER on the filing path: a dispatched reviewer's
      // verdict must be recordable without mutating the operator's machine.
      // Skipped when the session is non-interactive: this prompt defaults to
      // "yes", so an unguarded CI/cron run would both block and silently mutate
      // the machine.
      if (!filingPath && !resolution.isAvailable && prompt && installer && params.interactive !== false && !params.dryRun) {
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

      // Non-blocking version update check with 24-hour cache TTL. A dry run
      // skips it entirely: the check writes the update cache (#248, R13). The
      // filing path skips it too: it is a side effect the verdict does not need.
      if (!filingPath && !params.dryRun && resolution.isAvailable && resolution.path && installer && typeof this.critique.getVersion === 'function') {
        try {
          const currentVer = await this.critique.getVersion(resolution.path);
          const versionInfo = await installer.checkUpdateAvailable(currentVer, {
            resolvedPath: resolution.path,
            timeoutMs: 3000
          });
          if (versionInfo.isOutdated && versionInfo.currentVersion && versionInfo.latestVersion) {
            updateNotification = `💡 A new version of critique is available (v${versionInfo.currentVersion} -> v${versionInfo.latestVersion}).\n   Run \`agyloop critique update\` to upgrade.`;
          }
        } catch {
          // Non-blocking, ignore errors
        }
      }

      try {
        aiReport = await this.critique.review({
          cwd: reviewCwd,
          staged: params.staged,
          baseRef: targetBaseRef,
          timeoutMs: filingPath ? DEFAULT_CRITIQUE_REVIEW_TIMEOUT_MS : undefined
        });
        if (aiReport) {
          critiqueReportText = aiReport.formatMarkdownReport();
        }
      } catch {
        // Non-fatal if critique execution fails
      }
    }

    // A report that was produced ELSEWHERE is the fallback: it still informs
    // the reviewer prompt and it still drives the TWO-TIER INVARIANT below,
    // even though the CLI was not executed for it (issue #269, R2/R3).
    if (!aiReport && params.priorCritiqueReport) {
      aiReport = params.priorCritiqueReport;
      critiqueReportText = aiReport.formatMarkdownReport();
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
    let reviewSource: ReviewSource;

    if (params.reviewOutput) {
      // Tier 2: reviewer-subagent output (binary APPROVED | CHANGES_REQUESTED contract).
      //
      // This branch is reachable ONLY through the `codeloop review` path
      // (issue #269): the CLI reads the dispatched Reviewer subagent's verdict
      // block and hands it in here. `ReviewVerdict.parse` refuses a block that
      // carries no `REVIEW_STATUS: APPROVED|CHANGES_REQUESTED` token — and
      // refuses a self-declared `SKIPPED` outright (issue #236's invariant) —
      // so the recorded verdict is the reviewer's or nothing.
      verdict = ReviewVerdict.parse(params.reviewOutput);
      reviewSource = REVIEW_SOURCE_REVIEWER_OUTPUT;
    } else if (aiReport && !aiReport.bypassed) {
      // Tier 1: a real critique report (bypassed reports mean "review not performed").
      verdict = ReviewVerdict.fromAiReviewReport(aiReport);
      reviewSource = REVIEW_SOURCE_CRITIQUE_REPORT;
    } else {
      // Path A (no critique port / critique returned null) AND Path B (bypassed
      // report — the production absence path): the review did not run at all.
      // Advisory fail-open (issue #236): never fabricate CHANGES_REQUESTED.
      verdict = ReviewVerdict.skipped(
        aiReport && aiReport.bypassed ? aiReport.summary : undefined,
        [
          'Configure critique (`codeloop critique install`) or dispatch the Reviewer subagent (`codeloop next`), then re-run the review.'
        ]
      );
      reviewSource = REVIEW_SOURCE_SKIPPED;
    }

    // Two-Tier Invariant Enforcement:
    // Any critical or error violations from critique or unfulfilled ACs mandate CHANGES_REQUESTED.
    // Bypassed reports carry zero findings, but the guard also guarantees a stray
    // finding on a bypassed report can never overwrite SKIPPED with CHANGES_REQUESTED.
    //
    // The escalation is applied by the ONE pure helper, and the recorded
    // SOURCE is derived from what escalated it (issue #269, R3): a critique
    // escalation on a reviewer's verdict must never be reported as plain
    // `reviewer-output`, because that would claim the reviewer asked for
    // changes the reviewer never asked for.
    //
    // Issue #297: `reviewerVerdict` is the status the reviewer actually emitted,
    // captured BEFORE the invariant can rewrite it, and `critiqueVerified` says
    // whether real Tier 1 evidence informed the record. Together with
    // `reviewSource` they make the record auditable after the fact.
    const reviewerVerdict = filingPath ? verdict.status : null;
    const critiqueVerified = Boolean(aiReport && !aiReport.bypassed);

    const invariant = applyTwoTierInvariant(verdict, aiReport);
    verdict = invariant.verdict;

    if (invariant.escalatedBy === 'critique' && reviewSource === REVIEW_SOURCE_REVIEWER_OUTPUT) {
      reviewSource = REVIEW_SOURCE_REVIEWER_OUTPUT_ESCALATED;
    }

    // ONE provenance object, spread into every transition arm: the three
    // records cannot drift apart (issue #297, AC3/AC10).
    const provenance = {
      reviewVerdict: verdict.status,
      reviewTokens: verdict.formatStructuredTokens(),
      reviewSource,
      critiqueVerified,
      ...(reviewerVerdict ? { reviewerVerdict } : {})
    };

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
        ...provenance,
        suggestedCommitMessage
      });
    } else if (verdict.isSkipped()) {
      // Advisory advance: REVIEW -> COMMIT is already legal; no self-correction
      // payload because there is nothing to correct (issue #236).
      sm.transition(STAGE_COMMIT, {
        note: NOTE_REVIEW_SKIPPED,
        ...provenance
      });
    } else {
      sm.transition(STAGE_IMPLEMENT, {
        note: NOTE_REVIEW_CHANGES_REQUESTED,
        ...provenance,
        selfCorrectionPayload: verdict.formatSelfCorrectionPayload()
      });
    }

    // The commit gate's human wait is restored when the verdict leaves the
    // machine at COMMIT (issue #269): the operator is still waiting there to
    // run the commit. A verdict that reverted the machine to IMPLEMENT leaves
    // the pause consumed — it is not waiting at the commit gate any more.
    if (reopenRestorePauseAtCommit && sm.currentStage === STAGE_COMMIT) {
      sm.pauseAtGate(GATE_COMMIT);
    }

    // 9. Update AgyLoop Summary.md & State Checkpoint
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      if (resolvedPlan && resolvedPlan.summaryPath) {
        const noteDetails = verdict.isApproved()
          ? `Review approved in ${durationStr}: ${verdict.summary}${
              suggestedCommitMessage ? `\nSuggested Commit: \`${suggestedCommitMessage}\`` : ''
            }`
          : verdict.isSkipped()
            ? `Review skipped: ${verdict.summary} Advisory proceeding to commit gate.`
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
      passed: verdict.isApproved() || verdict.isSkipped(),
      verdict,
      reviewSource,
      critiqueVerified,
      currentStage: sm.currentStage,
      previousStage,
      dryRun: params.dryRun === true,
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
