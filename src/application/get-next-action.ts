/**
 * agyloop - GetNextActionUseCase (Application Layer)
 *
 * Inspects pipeline checkpoint state and generates the exact next operational directive,
 * including copy-paste-ready `invoke_subagent` JSON payloads populated with issue context,
 * active worktree paths, and model tier assignments.
 *
 * Strict Hexagonal Architecture: zero direct I/O, depends only on Domain and Ports.
 */

import {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_TRIAGE,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  ROLE_TRIAGE,
  ROLE_DISCOVERY,
  ROLE_TITLE_PLANNER,
  ROLE_TITLE_IMPLEMENTER,
  ROLE_TITLE_GATE,
  ROLE_TITLE_REVIEWER,
  ROLE_TITLE_TRIAGE,
  ROLE_TITLE_DISCOVERY,
  MODE_YOLO,
  VERDICT_APPROVED,
  VERDICT_SKIPPED,
  VERDICT_CHANGES_REQUESTED,
  IssueNumber,
  MAX_IMPLEMENT_GATE_LOOPS,
  GATE_TRIAGE,
  NOTE_PAUSED_TRIAGE_GATE,
  NOTE_RESTARTED_FROM_COMPLETED,
  assertNotRootWorkspace,
  isRootWorkspace
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubGateway,
  WorktreeManagerPort,
  BuildDetectorPort,
  PullRequestReviewComment
} from '../ports';
import { ResolveSubagentUseCase } from './resolve-subagent';
import { resolveCompletedReentry } from './lifecycle-reentry-policy';
import type { InferBaseBranchUseCase } from './infer-base-branch';

export interface GetNextActionParams {
  readonly workspaceDir?: string;
  readonly configPath?: string | null;
  readonly issue?: number | string | null;
  /**
   * Explicit opt-in (issue #237). Only this flag authorises `next` to destroy a
   * COMPLETED checkpoint: `reset()` it and re-open at DISCOVERY. Without it,
   * `next` on a COMPLETED checkpoint is a pure read plus at most the
   * TRIAGE route that open PR review feedback justifies.
   */
  readonly restart?: boolean;
}

/**
 * Result of probing an open PR for unaddressed review feedback.
 *
 * Fields are `readonly` and the shape is internal to this use case: it carries
 * only what the TRIAGE route needs, and it exists so `detectOpenReviewFeedback`
 * can fail closed (return `null`) without a sentinel "no feedback" object that
 * a caller could mistake for feedback.
 */
interface OpenReviewFeedback {
  readonly prNumber: number | null;
  readonly commentCount: number;
  /** `- [author]: body` lines, same format as run-lifecycle.ts's TRIAGE route. */
  readonly payload: string;
}

export interface SubagentInvocationItem {
  readonly TypeName: string;
  readonly Role: string;
  readonly Model: string;
  readonly Workspace: string;
  readonly Prompt: string;
}

export interface SubagentInvocationPayload {
  readonly Subagents: readonly SubagentInvocationItem[];
}

export interface NextActionResult {
  readonly currentStage: string;
  readonly nextStage: string;
  readonly actionType: 'subagent' | 'human_gate' | 'completed' | 'preflight';
  readonly role?: string;
  readonly title: string;
  readonly description: string;
  readonly worktreePath?: string | null;
  readonly baseBranch?: string | null;
  readonly taskBranch?: string | null;
  readonly invocationPayload?: SubagentInvocationPayload | null;
  readonly humanSummary: string;
}

export class GetNextActionUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator?: PlanGeneratorPort;
  private readonly githubGateway?: GitHubGateway;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;
  private readonly worktreeManager?: WorktreeManagerPort;
  private readonly buildDetector?: BuildDetectorPort;
  private readonly inferBaseBranchUseCase?: InferBaseBranchUseCase;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator?: PlanGeneratorPort,
    githubGateway?: GitHubGateway,
    resolveSubagentUseCase?: ResolveSubagentUseCase,
    worktreeManager?: WorktreeManagerPort,
    buildDetector?: BuildDetectorPort,
    inferBaseBranchUseCase?: InferBaseBranchUseCase
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.githubGateway = githubGateway;
    this.resolveSubagentUseCase =
      resolveSubagentUseCase ?? new ResolveSubagentUseCase(configRepo, githubGateway, undefined, undefined, buildDetector);
    this.worktreeManager = worktreeManager;
    this.buildDetector = buildDetector;
    this.inferBaseBranchUseCase = inferBaseBranchUseCase;
  }

  public async execute(params: GetNextActionParams = {}): Promise<NextActionResult> {
    const cwd = params.workspaceDir || process.cwd();
    const snapshot = await this.stateRepo.load();
    const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : StateMachine.createInitial();

    const config = this.configRepo.loadConfig({
      customPath: params.configPath,
      cwd
    });

    // Context resolution: explicit issue -> state.issue -> auto-inferred issue
    const explicitIssue = IssueNumber.tryFrom(params.issue)?.value ?? null;
    let inferredIssue: number | null = null;

    if (!explicitIssue && !sm.issue) {
      inferredIssue =
        IssueNumber.inferFromPath(sm.worktree?.worktreePath as string | undefined) ??
        IssueNumber.inferFromPath(cwd);
      if (!inferredIssue && sm.worktree?.branch) {
        inferredIssue = IssueNumber.inferFromBranch(sm.worktree.branch);
      }
      if (!inferredIssue && this.worktreeManager && this.worktreeManager.resolveBaseBranch) {
        try {
          const currentBranch = await this.worktreeManager.resolveBaseBranch(cwd);
          inferredIssue = IssueNumber.inferFromBranch(currentBranch);
        } catch {
          // Non-fatal
        }
      }
      if (inferredIssue) {
        sm.setIssue(inferredIssue);
        await this.stateRepo.save(sm.toSnapshot());
      }
    }

    let activeIssue = explicitIssue ?? sm.issue ?? inferredIssue;

    // ---- Read-path write contract (issue #237) ------------------------------
    // `codeloop next` is a QUERY. Outside an explicit `--restart` it may write
    // only context fields (issue, baseBranch) and, on a COMPLETED checkpoint
    // with open PR review feedback, route to TRIAGE. It may NEVER advance a
    // stage on its own initiative, and it may NEVER reset a checkpoint.
    //
    // The previous implementation inferred operator intent from whether
    // `--issue` merely happened to be supplied, which destroyed COMPLETED
    // checkpoints (planDir, worktree, history, counters) and persisted the
    // forbidden `{ currentStage: "PLAN", planDir: null }` snapshot by reaching
    // `Plan` straight from a reset machine — bypassing TransitionStageUseCase's
    // planDir precondition. The decision now lives in one chokepoint and depends
    // only on explicit intent plus evidence.
    const restartOptIn = params.restart === true;

    if (sm.currentStage === STAGE_COMPLETED) {
      // Probe the CHECKPOINT's own issue, not `activeIssue`.
      //
      // `activeIssue` prefers an explicit `--issue`, so `next --issue 51`
      // against a checkpoint whose issue is 40 resolved 40's checkpoint against
      // 51's PR feedback — routing one task's state on another task's review
      // comments. The checkpoint's own issue is the subject of the decision;
      // `activeIssue` is only the fallback for a task file written before the
      // issue was recorded (`issue: null`), which cannot be resolved from the
      // checkpoint itself.
      const feedbackIssue = sm.issue ?? activeIssue;
      const feedback = feedbackIssue ? await this.detectOpenReviewFeedback(feedbackIssue, cwd) : null;
      const decision = resolveCompletedReentry({
        currentStage: sm.currentStage,
        restartOptIn,
        hasOpenReviewFeedback: feedback !== null
      });

      if (decision === 'ROUTE_TRIAGE' && feedback) {
        // Byte-identical to RunLifecycleUseCase's TRIAGE route, now sharing one
        // rule definition (`shouldRouteToTriage`) with it.
        if (sm.canTransition(STAGE_TRIAGE)) {
          sm.setTriagePayload(feedback.payload);
          sm.transition(STAGE_TRIAGE, {
            note: NOTE_PAUSED_TRIAGE_GATE,
            prNumber: feedback.prNumber,
            commentsCount: feedback.commentCount
          });
          // TRIAGE is in HUMAN_WAIT_GATES, so transition() preserves the pause
          // rather than consuming it as a stale mechanical halt.
          sm.pauseAtGate(GATE_TRIAGE);
          await this.stateRepo.save(sm.toSnapshot());
        }
        // Otherwise the COMPLETED case below reports idle — no mutation at all.
      } else if (decision === 'RESTART' && activeIssue !== null) {
        sm.reset(sm.mode, activeIssue);
        // DISCOVERY, never PLAN: the RCA rule (R1) requires either an opt-in or
        // content evidence, and a freshly reset checkpoint has neither. This is
        // why the forbidden `{ PLAN, planDir: null }` snapshot is structurally
        // unreachable from this path, not merely discouraged by convention.
        sm.transition(STAGE_DISCOVERY, { note: NOTE_RESTARTED_FROM_COMPLETED, restart: true });
        await this.stateRepo.save(sm.toSnapshot());
      }
      // REPORT_IDLE_COMPLETED: no mutation whatsoever. A RESTART with a
      // unresolvable issue falls through to the idle report rather than
      // resetting to a null-issue checkpoint, which is why the guard above is
      // `activeIssue !== null`.
    } else if (explicitIssue !== null && sm.issue !== explicitIssue) {
      // One of the two fields the query path is always permitted to write.
      sm.setIssue(explicitIssue);
      await this.stateRepo.save(sm.toSnapshot());
    }

    activeIssue = sm.issue;
    if (!sm.baseBranch && activeIssue && this.inferBaseBranchUseCase) {
      try {
        const inference = await this.inferBaseBranchUseCase.execute({
          issueNumber: activeIssue,
          workspaceDir: cwd
        });
        if (inference.baseBranch) {
          sm.setBaseBranch(inference.baseBranch);
          await this.stateRepo.save(sm.toSnapshot());
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[agyloop] Diagnostic: Failed to infer base branch for issue #${activeIssue}: ${errMsg}`);
      }
    }

    const worktreePath = sm.worktree?.worktreePath || null;
    const taskBranch = sm.worktree?.branch || null;
    const baseBranch = sm.baseBranch || 'main';

    switch (sm.currentStage) {
      case STAGE_INITIALIZED: {
        return {
          currentStage: STAGE_INITIALIZED,
          nextStage: STAGE_DISCOVERY,
          actionType: 'preflight',
          title: 'Execute Smart Pre-Flight Discovery',
          description: 'Run pre-flight checks to discover issue metadata, check merged/closed status, and resolve base collector branch.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: `Run pre-flight checks: bin/agyloop transition DISCOVERY${activeIssue ? ` --issue ${activeIssue}` : ''}`
        };
      }

      case STAGE_DISCOVERY: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_DISCOVERY,
          customConfig: config,
          workspaceDir: cwd
        });

         
        const planDir = sm.planDir;
        let planPath: string | undefined;
        if (this.planGenerator) {
          const resolved = this.planGenerator.resolvePlanFile({
            projectRoot: cwd,
            issue: activeIssue,
            planDir: sm.planDir,
            stage: sm.currentStage
          });
          if (resolved) {
            planPath = resolved.planPath;
          }
        }

        const prompt = this.resolveSubagentUseCase.buildDiscoveryTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: cwd,
          config,
          planDir,
          planPath
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_DISCOVERY,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: prompt
            }
          ]
        };

        return {
          currentStage: STAGE_DISCOVERY,
          nextStage: STAGE_PLAN,
          actionType: 'subagent',
          role: ROLE_DISCOVERY,
          title: 'Invoke Defect Discovery Subagent',
          description: 'Execute root-cause analysis and manual smoke testing to produce a discovery report.',
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_DISCOVERY} with Model '${subagent.model}' (scoped write tools).`
        };
      }

      case STAGE_PLAN: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_PLANNER,
          customConfig: config,
          workspaceDir: cwd
        });

         
        const planDir = sm.planDir;
        let planPath: string | undefined;
        if (this.planGenerator) {
          const resolved = this.planGenerator.resolvePlanFile({
            projectRoot: cwd,
            issue: activeIssue,
            planDir: sm.planDir,
            stage: sm.currentStage
          });
          if (resolved) {
            planPath = resolved.planPath;
          }
        }

        const prompt = this.resolveSubagentUseCase.buildPlanningTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: cwd,
          config,
          planDir,
          planPath
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_PLANNER,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: prompt
            }
          ]
        };

        return {
          currentStage: STAGE_PLAN,
          nextStage: STAGE_APPROVAL,
          actionType: 'subagent',
          role: ROLE_PLANNER,
          title: 'Invoke Planning Architect Subagent',
          description: 'Generate architectural plan and specifications in artifacts/plans/ with scoped write tools.',
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_PLANNER} with Model '${subagent.model}' (scoped write tools).`
        };
      }

      case STAGE_APPROVAL: {
        if (sm.mode === MODE_YOLO) {
          return this.buildImplementAction(sm, config, cwd);
        }

        return {
          currentStage: STAGE_APPROVAL,
          nextStage: STAGE_IMPLEMENT,
          actionType: 'human_gate',
          title: 'Human Approval Gate',
          description: 'Review the technical plan in artifacts/plans/. Seek user confirmation before modifying source code.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: 'Present the plan to the user and wait for approval. Once approved, run "agyloop implement" or "agyloop transition IMPLEMENT".'
        };
      }

      case STAGE_IMPLEMENT: {
        if (sm.implementToGateLoops >= MAX_IMPLEMENT_GATE_LOOPS) {
          return {
            currentStage: sm.currentStage,
            nextStage: STAGE_QUALITY_GATE,
            actionType: 'human_gate',
            title: 'Quality Gate Retry Breaker',
            description: `Quality gate has failed ${sm.implementToGateLoops} times consecutively. Manual intervention required to prevent infinite loop.`,
            baseBranch,
            taskBranch,
            worktreePath,
            humanSummary: `Too many consecutive failures (${sm.implementToGateLoops}). Please inspect the workspace manually and fix the issue before running "agyloop transition QUALITY_GATE" or "agyloop implement".`
          };
        }
        return this.buildImplementAction(sm, config, cwd);
      }

      case STAGE_QUALITY_GATE: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_GATE,
          customConfig: config,
          workspaceDir: cwd
        });

        let commands: string[] | undefined;
        if (this.buildDetector) {
          const resolvedCommands = await this.buildDetector.resolveCommands(worktreePath || cwd, config);
          commands = resolvedCommands.map(c => c.command);
        }

        let planContent = '';
        let planPath: string | undefined;
        if (this.planGenerator) {
          const resolved = this.planGenerator.resolvePlanFile({
            projectRoot: cwd,
            issue: activeIssue,
            planDir: sm.planDir,
            stage: sm.currentStage
          });
          if (resolved) {
            planPath = resolved.planPath;
            try {
              planContent = this.planGenerator.readPlanDocument(resolved.planPath);
            } catch {
              // Non-fatal
            }
          }
        }

        const prompt = this.resolveSubagentUseCase.buildGateTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: worktreePath || cwd,
          config,
          commands,
          planContent: planContent || undefined,
          planPath
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_GATE,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: `Execute verification quality gates strictly inside isolated worktree directory:\nCwd: ${worktreePath || cwd}\n\n${prompt}`
            }
          ]
        };

        return {
          currentStage: STAGE_QUALITY_GATE,
          nextStage: STAGE_REVIEW,
          actionType: 'subagent',
          role: ROLE_GATE,
          title: 'Invoke Quality Gate Verifier Subagent',
          description: 'Run automated build, typecheck, lint, and test suites against the isolated worktree changes.',
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_GATE} with Model '${subagent.model}' inside ${worktreePath || cwd}.`
        };
      }

      case STAGE_REVIEW: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_REVIEWER,
          customConfig: config,
          workspaceDir: cwd
        });

        const prompt = this.resolveSubagentUseCase.buildReviewerTaskPrompt({
          issueNumber: activeIssue,
          baseBranch,
          workspaceDir: worktreePath || cwd,
          config
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_REVIEWER,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: `Inspect isolated worktree diff against base '${baseBranch}':\nCwd: ${worktreePath || cwd}\n\n${prompt}`
            }
          ]
        };

        return {
          currentStage: STAGE_REVIEW,
          nextStage: STAGE_COMMIT,
          actionType: 'subagent',
          role: ROLE_REVIEWER,
          title: 'Invoke AI Reviewer Subagent',
          description: 'Run critique analysis and verify Acceptance Criteria fulfillment against the isolated diff.',
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_REVIEWER} with Model '${subagent.model}' against base '${baseBranch}'.`
        };
      }

      case STAGE_COMMIT: {
        return {
          currentStage: STAGE_COMMIT,
          nextStage: STAGE_COMPLETED,
          actionType: 'human_gate',
          title: 'Conventional Commit & Teardown Gate',
          // Issue #259 (AC4): the verdict is read from the recorded history
          // metadata — a SKIPPED review must never be described as a pass.
          description: this.buildCommitGateDescription(this.lastReviewVerdict(sm)),
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: `Execute commit: run "agyloop commit" (targets base branch '${baseBranch}').`
        };
      }

      case STAGE_TRIAGE: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_TRIAGE,
          customConfig: config,
          workspaceDir: cwd
        });

        const prompt = this.resolveSubagentUseCase.buildTriageTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: worktreePath || cwd,
          config,
          triagePayload: sm.triagePayload
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_TRIAGE,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: prompt
            }
          ]
        };

        return {
          currentStage: STAGE_TRIAGE,
          nextStage: STAGE_IMPLEMENT,
          actionType: 'subagent',
          role: ROLE_TRIAGE,
          title: 'Invoke Triage Subagent',
          description: 'Open PR contains review comments requiring triage and pipeline routing.',
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke Triage Subagent with Model '${subagent.model}' to categorize comments and route to IMPLEMENT, PLAN, DISCOVERY, or COMPLETED.`
        };
      }

      case STAGE_COMPLETED:
      default: {
        return {
          currentStage: sm.currentStage,
          nextStage: STAGE_INITIALIZED,
          actionType: 'completed',
          title: 'Pipeline Completed / Idle',
          description: 'No active tasks pending. Ready to initialize next task or milestone.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary:
            'Pipeline is idle. Run "codeloop <task>" to start a new lifecycle, or "codeloop next --restart --issue <n>" to re-open a COMPLETED task.'
        };
      }
    }
  }

  /**
   * Probes the OPEN PR of `issue` for unaddressed review feedback.
   *
   * Reuses the exact optional-port method chain and the non-fatal discipline of
   * `TriagePrCommentsUseCase` and `RunPreFlightCheckUseCase` (issue #237): a
   * `next` invocation is a query, and an offline or rate-limited GitHub must
   * still get an answer. Every step is individually guarded, so a gateway that
   * throws, a missing PR, a merged/closed PR, or a gateway without either
   * optional method all collapse to `null` — treated as "no feedback", never as
   * "authorise a reset".
   */
  private async detectOpenReviewFeedback(issue: number, cwd: string): Promise<OpenReviewFeedback | null> {
    const gateway = this.githubGateway;
    if (!gateway?.findPullRequest) {
      return null;
    }

    try {
      const pr = await gateway.findPullRequest({ issueNumber: issue, cwd });
      // Only an OPEN PR's review feedback is actionable: a merged or closed one
      // was already resolved by whatever closed it.
      if (!pr || pr.state !== 'OPEN' || !pr.number) {
        return null;
      }

      let comments: readonly PullRequestReviewComment[] = [];
      if (gateway.fetchPullRequestComments) {
        const fetched = await gateway.fetchPullRequestComments(pr.number, { cwd });
        if (fetched) {
          comments = fetched;
        }
      }

      // Same predicate as run-preflight-check.ts: an empty comment list is not
      // feedback.
      //
      // The clause that used to follow — `|| comments.some(c => c.state ===
      // 'CHANGES_REQUESTED')` — was dead: `CliGitHubGateway.fetchPullRequest
      // Comments` only pushes a review when it has a non-empty body, so any
      // entry carrying `state: 'CHANGES_REQUESTED'` already made the list
      // non-empty. A CHANGES_REQUESTED verdict submitted with NO prose is
      // therefore invisible to this port entirely — a real limitation, but not
      // one a second operand on the same list can repair, and pretending
      // otherwise made the predicate look stricter than it is.
      const hasOpenReviewFeedback = comments.length > 0;

      if (!hasOpenReviewFeedback) {
        return null;
      }

      return {
        prNumber: pr.number,
        commentCount: comments.length,
        payload: comments.map((c) => `- [${c.author || 'Unknown'}]: ${c.body}`).join('\n')
      };
    } catch {
      return null;
    }
  }

  /**
   * Reads the MOST RECENT recorded AI-review verdict from the checkpoint
   * history (issue #259).
   *
   * `RunReviewUseCase` records the verdict in the metadata of the history
   * entry it writes (`reviewVerdict`), so the COMMIT gate can describe what
   * actually happened instead of hard-coding "Review passed". The history is
   * scanned backwards: the last verdict is the one that produced this
   * checkpoint.
   */
  private lastReviewVerdict(sm: StateMachine): string | null {
    const history = sm.history;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const verdict = history[index].metadata?.reviewVerdict;
      if (typeof verdict === 'string' && verdict.length > 0) {
        return verdict;
      }
    }

    return null;
  }

  /**
   * Builds the COMMIT-gate description for the recorded review verdict.
   *
   * The approved path keeps its original wording; every other verdict says
   * what actually happened. A skipped review is advisory, never a pass — the
   * #236 fail-open is preserved, only the WORDING at this gate changes.
   */
  private buildCommitGateDescription(reviewVerdict: string | null): string {
    const commitInstructions =
      'Draft conventional commit, prompt for confirmation, push to remote, and teardown worktree.';

    if (reviewVerdict === VERDICT_APPROVED) {
      return `Review passed. ${commitInstructions}`;
    }

    if (reviewVerdict === VERDICT_SKIPPED) {
      return `AI review was SKIPPED (no reviewer output, no critique report) — advisory, not a pass. ${commitInstructions}`;
    }

    if (reviewVerdict === VERDICT_CHANGES_REQUESTED) {
      return `AI review requested changes — this checkpoint should not be at the COMMIT gate. ${commitInstructions}`;
    }

    return `No AI review verdict is recorded for this task. ${commitInstructions}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildImplementAction(sm: StateMachine, config: any, cwd: string): NextActionResult {
    const activeIssue = sm.issue;
    const worktreePath = sm.worktree?.worktreePath || null;
    
    // Issue #247: the implement-action root check shares the ONE domain invariant
    // predicate (resolve-normalized) instead of a raw `===` compare, so `next`
    // and every cleanup path agree on the same descriptor verdict (AC7). The
    // thrown message text is single-sourced in `assertNotRootWorkspace`.
    if (!worktreePath || isRootWorkspace(worktreePath, cwd)) {
      assertNotRootWorkspace(worktreePath ?? cwd, cwd, 'worktreePath');
    }

    const taskBranch = sm.worktree?.branch || null;
    const baseBranch = sm.baseBranch || 'main';

    const subagent = this.resolveSubagentUseCase.execute({
      role: ROLE_IMPLEMENTER,
      customConfig: config,
      workspaceDir: cwd
    });

    let planContent = '';
    let planPath = '';
    if (this.planGenerator) {
      const resolved = this.planGenerator.resolvePlanFile({
        projectRoot: cwd,
        issue: activeIssue,
        planDir: sm.planDir,
        stage: sm.currentStage
      });
      if (resolved) {
        planPath = resolved.planPath;
        try {
          planContent = this.planGenerator.readPlanDocument(resolved.planPath);
        } catch {
          // Non-fatal
        }
      }
    }

    const prompt = this.resolveSubagentUseCase.buildImplementationTaskPrompt({
      planContent,
      planPath: planPath || undefined,
      issueNumber: activeIssue,
      workspaceDir: worktreePath || cwd,
      config,
      prReviewComments: sm.triagePayload
    });

    const invocationPayload: SubagentInvocationPayload = {
      Subagents: [
        {
          TypeName: 'self',
          Role: ROLE_TITLE_IMPLEMENTER,
          Model: subagent.model,
          Workspace: 'inherit',
          Prompt: `Execute code modifications strictly inside isolated worktree directory:\nCwd: ${worktreePath || cwd}\nBranch: ${taskBranch || '(auto)'}\n\n${prompt}`
        }
      ]
    };

    const nextStage = sm.currentStage === STAGE_IMPLEMENT ? STAGE_QUALITY_GATE : STAGE_IMPLEMENT;

    return {
      currentStage: sm.currentStage,
      nextStage,
      actionType: 'subagent',
      role: ROLE_IMPLEMENTER,
      title: 'Invoke Code Implementer Subagent',
      description: 'Execute surgical code modifications adhering strictly to approved plan in dedicated worktree.',
      baseBranch,
      taskBranch,
      worktreePath,
      invocationPayload,
      humanSummary: `Invoke ${ROLE_TITLE_IMPLEMENTER} with Model '${subagent.model}' targeting worktree ${worktreePath || '.worktrees/' + activeIssue}.`
    };
  }
}
