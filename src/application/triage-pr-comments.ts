/**
 * agyloop - TriagePrCommentsUseCase (Application Layer)
 *
 * Implements interactive and programmatic PR review comment triage and routing.
 * When PR review comments exist (or are fetched from GitHub), developers can inspect
 * comments categorized by severity and route the pipeline to:
 * - IMPLEMENT (Accept & Fix)
 * - PLAN (Architectural changes needed)
 * - DISCOVERY (Investigate root causes)
 * - COMPLETED (Dismiss/Defer)
 *
 * Strict Hexagonal Architecture: Zero direct I/O, depends only on Domain and Ports.
 */

import {
  StateMachine,
  STAGE_TRIAGE,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  STAGE_DISCOVERY,
  STAGE_COMPLETED,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  GATE_TRIAGE,
  NOTE_TRIAGE_ROUTED,
  StageName,
  IssueNumber,
  NOTE_DISMISS_NO_NOTES,
  NOTE_DISMISS_NO_PR,
  NOTE_DISMISS_NO_GATEWAY,
  DISMISS_CONVERSATION_REPLY_FOOTER,
  DISMISS_FAILURE_DETAIL_LIMIT,
  LABEL_DISMISS_THREADS,
  LABEL_DISMISS_CONVERSATION,
  REGEX_PR_FEEDBACK_HEADER,
  REGEX_PR_FEEDBACK_FOOTER,
  MSG_DISMISS_NO_THREAD_SUPPORT,
  MSG_DISMISS_NO_CONVERSATION_ID,
  MSG_DISMISS_NO_CONVERSATION_SUPPORT
} from '../domain';
import {
  StateRepository,
  GitHubGateway,
  PullRequestReviewComment,
  PlanGeneratorPort,
  WorktreeManagerPort,
  UnresolvedReviewThread
} from '../ports';
import type { InferBaseBranchUseCase } from './infer-base-branch';

export type TriageAction = 'implement' | 'plan' | 'discovery' | 'completed' | 'dismiss';

/**
 * Which GitHub surface a dismissal failure happened on.
 */
export type TriageDismissScope = 'thread' | 'conversation';

export interface TriageDismissFailure {
  readonly scope: TriageDismissScope;
  /** The thread id or the conversation comment id the failure happened on. */
  readonly target: string;
  readonly error: string;
}

/**
 * What the dismissal route actually achieved.
 *
 * The route used to return nothing about its outcome, so the CLI printed an
 * unqualified success line even when a single rejected thread had aborted the
 * whole batch. Every count below is what was really performed.
 */
export interface TriageDismissReport {
  /** False when there was nothing to dismiss (no notes, no PR, no gateway). */
  readonly attempted: boolean;
  /** Why nothing was dismissed, when `attempted` is false. */
  readonly skippedReason?: string;
  readonly threadsReplied: number;
  readonly threadsResolved: number;
  readonly conversationsReplied: number;
  /** Conversation comments skipped because the same feedback was answered inline. */
  readonly conversationsSkipped: number;
  /** Conversation comments ignored because they are the tool's own dismissal replies. */
  readonly conversationsIgnored: number;
  readonly failures: readonly TriageDismissFailure[];
  /** The GitHub surfaces the dismissal actually acted on. */
  readonly surfaces: readonly string[];
}

export interface TriagePrCommentsParams {
  readonly issue?: number | string | null;
  readonly prNumber?: number | null;
  readonly action?: TriageAction;
  readonly notes?: string;
  readonly workspaceDir?: string;
  readonly trackerRepo?: string;
  readonly comments?: readonly PullRequestReviewComment[];
}

export interface TriagePrCommentsResult {
  readonly success: boolean;
  readonly targetStage: StageName;
  readonly stateMachine: StateMachine;
  readonly prNumber?: number | null;
  readonly comments: readonly PullRequestReviewComment[];
  readonly message: string;
  /** Present for the `dismiss` action: what the dismissal really achieved. */
  readonly dismissal?: TriageDismissReport;
}

/**
 * The identity of a piece of review feedback.
 *
 * The review bot posts the SAME feedback twice: once as an inline review
 * comment and once as a PR conversation summary (the conversation body carries
 * an extra `**Review feedback on ...**` header). Both bodies must therefore
 * reduce to the same key, otherwise the dismissal answers the same feedback
 * twice.
 */
export function prFeedbackKey(body: string): string {
  const withoutHeader = (body || '').replace(REGEX_PR_FEEDBACK_HEADER, '');
  const withoutFooter = withoutHeader.replace(REGEX_PR_FEEDBACK_FOOTER, '');
  return withoutFooter.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The headline of a comment — the line a reader recognises it by.
 */
function feedbackHeadline(body: string): string {
  for (const line of (body || '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
  }
  return '';
}

/**
 * The reply posted on the PR conversation surface. GitHub has no threaded
 * reply for conversation comments, so the reply quotes the comment it answers.
 */
function buildConversationReply(notes: string, body: string): string {
  return `${notes}\n\n${DISMISS_CONVERSATION_REPLY_FOOTER}\n> ${feedbackHeadline(body)}`;
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TriagePrCommentsUseCase {
  private readonly stateRepo: StateRepository;
  private readonly githubGateway?: GitHubGateway;
  private readonly planGenerator?: PlanGeneratorPort;
  private readonly worktreeManager?: WorktreeManagerPort;
  private readonly inferBaseBranchUseCase?: InferBaseBranchUseCase;

  constructor(
    stateRepo: StateRepository,
    githubGateway?: GitHubGateway,
    planGenerator?: PlanGeneratorPort,
    worktreeManager?: WorktreeManagerPort,
    inferBaseBranchUseCase?: InferBaseBranchUseCase
  ) {
    this.stateRepo = stateRepo;
    this.githubGateway = githubGateway;
    this.planGenerator = planGenerator;
    this.worktreeManager = worktreeManager;
    this.inferBaseBranchUseCase = inferBaseBranchUseCase;
  }

  public async execute(params: TriagePrCommentsParams = {}): Promise<TriagePrCommentsResult> {
    const cwd = params.workspaceDir || process.cwd();
    const snapshot = await this.stateRepo.load();
    const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : StateMachine.createInitial();

    const explicitIssue = IssueNumber.tryFrom(params.issue)?.value ?? null;
    let inferredIssue = sm.issue;
    if (!explicitIssue && !inferredIssue) {
      inferredIssue = IssueNumber.inferFromPath(cwd);
    }
    const activeIssue = explicitIssue ?? inferredIssue;
    if (activeIssue && sm.issue !== activeIssue) {
      sm.setIssue(activeIssue);
    }

    // Resolve PR Number
    let prNumber = params.prNumber || null;
    if (!prNumber && this.githubGateway?.findPullRequest && activeIssue) {
      try {
        const pr = await this.githubGateway.findPullRequest({
          issueNumber: activeIssue,
          cwd,
          repo: params.trackerRepo
        });
        if (pr && pr.number) {
          prNumber = pr.number;
        }
      } catch {
        // Non-fatal
      }
    }

    // Fetch or use provided comments
    let comments: PullRequestReviewComment[] = params.comments ? [...params.comments] : [];
    if (comments.length === 0 && prNumber && this.githubGateway?.fetchPullRequestComments) {
      try {
        const fetched = await this.githubGateway.fetchPullRequestComments(prNumber, {
          cwd,
          repo: params.trackerRepo
        });
        if (fetched) {
          comments = fetched;
        }
      } catch {
        // Non-fatal
      }
    }

    // Read-only list mode: no action means display comments without mutating state
    if (!params.action) {
      return {
        success: true,
        targetStage: sm.currentStage,
        stateMachine: sm,
        prNumber,
        comments,
        message: `Listed ${comments.length} PR review comment(s) (read-only).`
      };
    }

    const selectedAction: TriageAction = params.action;

    // The dismissal route runs BEFORE the state transition so its outcome can
    // be reported truthfully. It never blocks the transition: a partial
    // dismissal is reported as partial, not as a failure of the routing.
    let dismissal: TriageDismissReport | undefined;
    if (selectedAction === 'dismiss') {
      dismissal = await this.performDismissal({
        prNumber,
        notes: params.notes,
        comments,
        cwd,
        repo: params.trackerRepo
      });
    }

    let targetStage: StageName;

    switch (selectedAction) {
      case 'plan':
        targetStage = STAGE_PLAN;
        break;
      case 'discovery':
        targetStage = STAGE_DISCOVERY;
        break;
      case 'completed':
      case 'dismiss':
        targetStage = STAGE_COMPLETED;
        break;
      case 'implement':
      default:
        targetStage = STAGE_IMPLEMENT;
        break;
    }

    if (targetStage === STAGE_COMPLETED) {
      sm.setTriagePayload(null);
    } else if (comments.length > 0) {
      const formattedComments = comments
        .map((c) => `- [${c.author || 'Unknown'}]: ${c.body}`)
        .join('\n');
      sm.setTriagePayload(formattedComments);
    } else if (!sm.triagePayload && params.notes) {
      sm.setTriagePayload(params.notes);
    }

    // Ensure state machine is in STAGE_TRIAGE or can transition
    if (sm.currentStage !== STAGE_TRIAGE && sm.canTransition(STAGE_TRIAGE)) {
      sm.transition(STAGE_TRIAGE, {
        note: 'Entering PR comment triage',
        prNumber,
        commentCount: comments.length
      });
    } else if (sm.currentStage !== STAGE_TRIAGE) {
      throw new Error(`Cannot transition to TRIAGE from ${sm.currentStage}`);
    }

    if (sm.pausedAtGate) {
      sm.resumeFromGate();
    }

    // Transition from STAGE_TRIAGE to targetStage
    if (sm.canTransition(targetStage)) {
      if (targetStage === STAGE_IMPLEMENT && this.worktreeManager) {
        let baseBranch = sm.baseBranch;
        if (!baseBranch && activeIssue && this.inferBaseBranchUseCase) {
           try {
             const inference = await this.inferBaseBranchUseCase.execute({ issueNumber: activeIssue, workspaceDir: cwd });
             if (inference.baseBranch) {
               baseBranch = inference.baseBranch;
               sm.setBaseBranch(baseBranch);
             }
           } catch {
             // Non-fatal
           }
        }
        try {
          const worktreeRes = await this.worktreeManager.createWorktree({
            taskId: activeIssue || 'adhoc',
            workspaceDir: cwd,
            baseBranch: baseBranch || 'main'
          });
          sm.setWorktree(worktreeRes);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            targetStage: sm.currentStage,
            stateMachine: sm,
            prNumber,
            comments,
            message: `Failed to construct worktree for implementation: ${msg}`
          };
        }
      }

      sm.transition(targetStage, {
        note: params.notes || NOTE_TRIAGE_ROUTED,
        prNumber,
        triageAction: selectedAction,
        commentCount: comments.length
      });
    }

    await this.stateRepo.save(sm.toSnapshot());

    return {
      success: true,
      targetStage,
      stateMachine: sm,
      prNumber,
      comments,
      dismissal,
      message: `Triage complete: routed to ${targetStage} with ${comments.length} comment(s).`
    };
  }

  /**
   * Dismisses the triaged feedback on a pull request.
   *
   * Two surfaces carry review feedback: inline review threads (which can be
   * replied to AND resolved) and PR conversation comments (which can only be
   * answered with a comment — GitHub has no "resolve" for them). Both are
   * handled, and each failure is isolated so one rejected comment cannot abort
   * the batch: the report says what was really achieved.
   */
  private async performDismissal(params: {
    prNumber: number | null;
    notes?: string;
    comments: readonly PullRequestReviewComment[];
    cwd: string;
    repo?: string;
  }): Promise<TriageDismissReport> {
    const empty = (attempted: boolean, skippedReason?: string): TriageDismissReport => ({
      attempted,
      skippedReason,
      threadsReplied: 0,
      threadsResolved: 0,
      conversationsReplied: 0,
      conversationsSkipped: 0,
      conversationsIgnored: 0,
      failures: [],
      surfaces: []
    });

    if (!params.notes) {
      return empty(false, NOTE_DISMISS_NO_NOTES);
    }
    if (!params.prNumber) {
      return empty(false, NOTE_DISMISS_NO_PR);
    }
    const gw = this.githubGateway;
    if (!gw) {
      return empty(false, NOTE_DISMISS_NO_GATEWAY);
    }

    const gwOptions = { cwd: params.cwd, repo: params.repo };
    const failures: TriageDismissFailure[] = [];
    const surfaces: string[] = [];

    // Inline comments are the ones that can belong to a review thread. A
    // comment without a surface is inline — the historical meaning of `id`.
    const inlineComments = params.comments.filter((c) => (c.surface ?? 'inline') !== 'conversation');
    const conversationComments = params.comments.filter((c) => c.surface === 'conversation');

    const inlineById = new Map<number, PullRequestReviewComment>();
    for (const comment of inlineComments) {
      if (typeof comment.id === 'number') {
        inlineById.set(comment.id, comment);
      }
    }

    let threadsReplied = 0;
    let threadsResolved = 0;
    let conversationsReplied = 0;
    let conversationsSkipped = 0;
    let conversationsIgnored = 0;
    /** The feedback keys of the inline comments that were answered inline. */
    const answeredInlineKeys = new Set<string>();

    // --- Inline review threads ------------------------------------------------
    if (gw.listUnresolvedReviewThreads && gw.replyToThread && gw.resolveReviewThread) {
      let threads: UnresolvedReviewThread[] = [];
      try {
        threads = await gw.listUnresolvedReviewThreads(params.prNumber, gwOptions);
      } catch (err: unknown) {
        failures.push({
          scope: 'thread',
          target: 'unresolved-review-threads',
          error: failureMessage(err)
        });
      }

      for (const thread of threads) {
        const matched = thread.commentIds.filter((id) => inlineById.has(id));
        if (matched.length === 0) {
          // Not part of the triaged feedback: the thread stays untouched.
          continue;
        }

        try {
          await gw.replyToThread(thread.id, params.notes, gwOptions);
        } catch (err: unknown) {
          // One rejected thread must not abort the batch, and the thread is
          // left open because it was never answered.
          failures.push({ scope: 'thread', target: thread.id, error: failureMessage(err) });
          continue;
        }

        threadsReplied++;
        for (const id of matched) {
          const comment = inlineById.get(id);
          if (comment) {
            answeredInlineKeys.add(prFeedbackKey(comment.body));
          }
        }

        try {
          await gw.resolveReviewThread(thread.id, gwOptions);
          threadsResolved++;
        } catch (err: unknown) {
          failures.push({ scope: 'thread', target: thread.id, error: failureMessage(err) });
        }
      }

      if (threadsReplied > 0 || failures.some((f) => f.scope === 'thread')) {
        surfaces.push(LABEL_DISMISS_THREADS);
      }
    } else if (inlineComments.length > 0) {
      failures.push({
        scope: 'thread',
        target: 'unresolved-review-threads',
        error: MSG_DISMISS_NO_THREAD_SUPPORT
      });
    }

    // --- PR conversation comments --------------------------------------------
    if (gw.replyToConversationComment) {
      for (const comment of conversationComments) {
        // The tool's own dismissal replies are not review feedback: answering
        // them would make the tool talk to itself.
        if (comment.body.includes(DISMISS_CONVERSATION_REPLY_FOOTER)) {
          conversationsIgnored++;
          continue;
        }

        if (typeof comment.id !== 'number') {
          failures.push({
            scope: 'conversation',
            target: 'unknown',
            error: MSG_DISMISS_NO_CONVERSATION_ID
          });
          continue;
        }

        // The review bot posts the same feedback inline AND as a conversation
        // summary. Answering it twice would be noise, so a conversation comment
        // whose feedback was already answered inline is skipped.
        if (answeredInlineKeys.has(prFeedbackKey(comment.body))) {
          conversationsSkipped++;
          continue;
        }

        try {
          await gw.replyToConversationComment(
            params.prNumber,
            comment.id,
            buildConversationReply(params.notes, comment.body),
            gwOptions
          );
          conversationsReplied++;
        } catch (err: unknown) {
          failures.push({
            scope: 'conversation',
            target: String(comment.id),
            error: failureMessage(err)
          });
        }
      }

      if (
        conversationsReplied > 0 ||
        conversationsSkipped > 0 ||
        conversationsIgnored > 0 ||
        failures.some((f) => f.scope === 'conversation')
      ) {
        surfaces.push(LABEL_DISMISS_CONVERSATION);
      }
    } else if (conversationComments.length > 0) {
      failures.push({
        scope: 'conversation',
        target: 'conversation-comments',
        error: MSG_DISMISS_NO_CONVERSATION_SUPPORT
      });
    }

    if (failures.length > 0) {
      // The failure details are in the report; the warning keeps the
      // long-standing "failures never block the transition" behaviour visible
      // to a caller that only reads stderr. The detail list is truncated so a
      // run that hit one rate limit on every thread stays readable.
      const shown = failures.slice(0, DISMISS_FAILURE_DETAIL_LIMIT);
      const details = shown.map((f) => `${f.scope} ${f.target}: ${f.error}`).join('; ');
      const rest = failures.length - shown.length;
      console.warn(
        `Warning: failed to dismiss all feedback on PR #${params.prNumber}: ${failures.length} failure(s): ${details}${rest > 0 ? `; ... and ${rest} more` : ''}`
      );
    }

    return {
      attempted: true,
      threadsReplied,
      threadsResolved,
      conversationsReplied,
      conversationsSkipped,
      conversationsIgnored,
      failures,
      surfaces
    };
  }
}
