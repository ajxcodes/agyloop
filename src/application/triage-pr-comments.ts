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
  DISMISS_CONVERSATION_REPLY_REFERENCE_PREFIX,
  DISMISS_FAILURE_DETAIL_LIMIT,
  LABEL_DISMISS_THREADS,
  LABEL_DISMISS_CONVERSATION,
  PR_CATEGORY_GENERAL,
  REGEX_PR_FEEDBACK_HEADER,
  REGEX_PR_FEEDBACK_FOOTER,
  REGEX_DISMISS_CONVERSATION_REFERENCE,
  MSG_DISMISS_NO_THREAD_SUPPORT,
  MSG_DISMISS_NO_CONVERSATION_ID,
  MSG_DISMISS_NO_CONVERSATION_SUPPORT
} from '../domain';
import {
  StateRepository,
  GitHubGateway,
  GitHubGatewayOptions,
  PullRequestReviewComment,
  PlanGeneratorPort,
  WorktreeManagerPort,
  ReviewThread
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
  /** Inline threads skipped because an earlier run already resolved them. */
  readonly threadsSkipped: number;
  readonly conversationsReplied: number;
  /** Conversation comments that were not answered because they were answered already. */
  readonly conversationsSkipped: number;
  /**
   * The subset of `conversationsSkipped` the PR's own state proves were
   * answered: another comment references their id, or their inline review
   * thread is already resolved.
   */
  readonly conversationsAlreadyAnswered: number;
  /**
   * The subset of `conversationsSkipped` whose feedback was answered inline in
   * THIS run.
   */
  readonly conversationsDuplicate: number;
  /** Conversation comments ignored because they are the tool's own dismissal replies. */
  readonly conversationsIgnored: number;
  /**
   * Conversation comments ignored because they are prior answers the tool
   * cannot attribute (they carry neither the tool's footer nor its reference).
   * They are reported rather than silently dropped.
   */
  readonly conversationsPriorAnswers: number;
  readonly failures: readonly TriageDismissFailure[];
  /** The GitHub surfaces the dismissal actually acted on. */
  readonly surfaces: readonly string[];
}

/**
 * The state the two dismissal jobs share.
 *
 * The inline-thread job WRITES the feedback keys it answered inline and the
 * keys whose thread is already resolved; the conversation job READS both, so
 * the same feedback is never answered twice. The two sets and the two
 * collections are therefore shared BY REFERENCE, never copied, so an update
 * made by one job is seen by the other.
 */
interface TriageDismissContext {
  readonly gw: GitHubGateway;
  readonly gwOptions: GitHubGatewayOptions;
  readonly prNumber: number;
  readonly notes: string;
  readonly inlineComments: readonly PullRequestReviewComment[];
  readonly conversationComments: readonly PullRequestReviewComment[];
  readonly inlineById: ReadonlyMap<number, PullRequestReviewComment>;
  /** The ids of the conversation comments the PR's state proves were answered. */
  readonly answeredIds: ReadonlySet<number>;
  /** The moment the newest dismissal answer was posted, or null. */
  readonly newestAnswerAt: number | null;
  /** The feedback keys of the inline comments that were answered inline. */
  readonly answeredInlineKeys: Set<string>;
  /** The feedback keys of the inline comments whose thread is already resolved. */
  readonly resolvedInlineKeys: Set<string>;
  /** The failures of both jobs, in the order they happened. */
  readonly failures: TriageDismissFailure[];
  /** The GitHub surfaces the dismissal acted on, in the order they were met. */
  readonly surfaces: string[];
}

/**
 * What the inline review-thread job achieved.
 */
type TriageDismissThreadOutcome = Pick<
  TriageDismissReport,
  'threadsReplied' | 'threadsResolved' | 'threadsSkipped'
>;

/**
 * What the PR conversation-comment job achieved.
 */
type TriageDismissConversationOutcome = Pick<
  TriageDismissReport,
  | 'conversationsReplied'
  | 'conversationsSkipped'
  | 'conversationsAlreadyAnswered'
  | 'conversationsDuplicate'
  | 'conversationsIgnored'
  | 'conversationsPriorAnswers'
>;

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

/**
 * Whether a comment is a reply the TOOL posted.
 *
 * The tool posts as the same account as the human operator, so the AUTHOR
 * cannot tell the tool's own replies from the operator's own notes — only the
 * tool's marker can. The marker is either the footer or the id-bearing
 * reference; both are posted by the tool and by nothing else.
 */
export function isDismissalReply(body: string): boolean {
  const text = body || '';
  return (
    text.includes(DISMISS_CONVERSATION_REPLY_FOOTER) ||
    text.includes(DISMISS_CONVERSATION_REPLY_REFERENCE_PREFIX)
  );
}

/**
 * The ids of the conversation comments the PR's conversation already answers.
 *
 * Every dismissal reply the tool posts carries a reference to the comment it
 * answers (`...#issuecomment-<id>`), so the ids of the comments that were
 * answered can be read back off the PR. This is the dismissal route's ONLY
 * cross-run memory on the conversation surface: it survives the process,
 * because it is derived from the PR's current state.
 */
export function answeredConversationCommentIds(
  comments: readonly PullRequestReviewComment[]
): Set<number> {
  const answered = new Set<number>();
  for (const comment of comments) {
    for (const match of (comment.body || '').matchAll(REGEX_DISMISS_CONVERSATION_REFERENCE)) {
      const id = Number.parseInt(match[1], 10);
      if (Number.isFinite(id)) {
        answered.add(id);
      }
    }
  }
  return answered;
}

/**
 * The moment a comment was posted, or null when it cannot be determined.
 */
function timestampOf(createdAt?: string): number | null {
  if (!createdAt) {
    return null;
  }
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The moment the newest dismissal answer on the PR was posted.
 *
 * A dismissal answer is a reply the TOOL posted: it carries the tool's own
 * marker. Replies posted before the tool carried a marker carry none, so they
 * cannot be recognised as answers — see {@link isUnattributablePriorAnswer}.
 */
function newestDismissalAnswerAt(comments: readonly PullRequestReviewComment[]): number | null {
  let newest: number | null = null;
  for (const comment of comments) {
    if (!isDismissalReply(comment.body)) {
      continue;
    }
    const at = timestampOf(comment.createdAt);
    if (at === null) {
      continue;
    }
    if (newest === null || at > newest) {
      newest = at;
    }
  }
  return newest;
}

/**
 * Whether a comment carries review feedback.
 *
 * The gateway classifies every comment it fetches; a comment that carries no
 * review marker at all is classified as GENERAL. Such a comment is not review
 * feedback — it is a note in the conversation.
 */
function carriesReviewFeedback(comment: PullRequestReviewComment): boolean {
  return comment.category !== undefined && comment.category !== PR_CATEGORY_GENERAL;
}

/**
 * Whether a conversation comment is an UNATTRIBUTABLE PRIOR ANSWER.
 *
 * The tool posts as the same account as the human operator, so neither the
 * author nor the content can separate "the tool's own earlier answer" from
 * "the operator's own note". The only reliable discriminator is the tool's
 * marker — and an answer posted before the tool carried one carries none (the
 * 24 replies of the pre-`b36de99` build on PR #261 are exactly that).
 *
 * Such a comment is therefore treated as a PRIOR ANSWER: it is not answered
 * again, because answering it would be a third reply to the same feedback.
 * The rule stays SAFE for genuine human feedback:
 *
 * - it only applies to comments that PREDATE the newest dismissal answer on
 *   the PR — a comment posted after it is new feedback and is answered;
 * - before the tool has dismissed anything on a PR, there is no dismissal
 *   answer to compare against, so every comment is answered;
 * - a comment whose position in time cannot be determined is answered.
 *
 * Every prior answer is reported, so nothing disappears silently.
 */
function isUnattributablePriorAnswer(
  comment: PullRequestReviewComment,
  newestAnswerAt: number | null
): boolean {
  if (newestAnswerAt === null) {
    return false;
  }
  if (carriesReviewFeedback(comment)) {
    return false;
  }
  const at = timestampOf(comment.createdAt);
  if (at === null) {
    return false;
  }
  return at < newestAnswerAt;
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
   *
   * The route has NO memory of its own between runs — the in-run set of
   * answered inline comments died with the process, so every run re-answered
   * everything. What the route remembers is therefore derived from the PR's
   * CURRENT state, which survives the process:
   *
   * - an inline comment whose review thread is RESOLVED was answered by an
   *   earlier run, so it is skipped;
   * - a conversation comment whose id another comment REFERENCES was answered
   *   by an earlier run, so it is skipped.
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
      threadsSkipped: 0,
      conversationsReplied: 0,
      conversationsSkipped: 0,
      conversationsAlreadyAnswered: 0,
      conversationsDuplicate: 0,
      conversationsIgnored: 0,
      conversationsPriorAnswers: 0,
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

    // --- The PR's current state: what has already been answered --------------
    // Every dismissal reply the tool posts on the conversation surface carries
    // a reference to the comment it answers, so the ids of the comments that
    // were answered can be read back off the PR.
    const answeredIds = answeredConversationCommentIds(params.comments);
    const newestAnswerAt = newestDismissalAnswerAt(params.comments);

    /** The feedback keys of the inline comments that were answered inline. */
    const answeredInlineKeys = new Set<string>();
    /** The feedback keys of the inline comments whose thread is already resolved. */
    const resolvedInlineKeys = new Set<string>();

    // The two jobs below share this context: the inline job fills the two
    // feedback-key sets, the conversation job reads them.
    const context: TriageDismissContext = {
      gw,
      gwOptions,
      prNumber: params.prNumber,
      notes: params.notes,
      inlineComments,
      conversationComments,
      inlineById,
      answeredIds,
      newestAnswerAt,
      answeredInlineKeys,
      resolvedInlineKeys,
      failures,
      surfaces
    };

    const threads = await this.triageInlineThreads(context);
    const conversations = await this.dismissConversationComments(context);

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
      threadsReplied: threads.threadsReplied,
      threadsResolved: threads.threadsResolved,
      threadsSkipped: threads.threadsSkipped,
      conversationsReplied: conversations.conversationsReplied,
      conversationsSkipped: conversations.conversationsSkipped,
      conversationsAlreadyAnswered: conversations.conversationsAlreadyAnswered,
      conversationsDuplicate: conversations.conversationsDuplicate,
      conversationsIgnored: conversations.conversationsIgnored,
      conversationsPriorAnswers: conversations.conversationsPriorAnswers,
      failures,
      surfaces
    };
  }

  /**
   * Dismisses the INLINE review threads of the pull request.
   *
   * The inline surface is the only one that can be replied to AND resolved.
   * The job records the feedback keys it answered inline and the keys whose
   * thread an earlier run had already resolved; the conversation job reads
   * both, so the two sets are shared by reference (see
   * {@link TriageDismissContext}).
   */
  private async triageInlineThreads(
    context: TriageDismissContext
  ): Promise<TriageDismissThreadOutcome> {
    const { gw, gwOptions, prNumber, notes, inlineComments, inlineById, failures, surfaces } = context;
    let threadsReplied = 0;
    let threadsResolved = 0;
    let threadsSkipped = 0;

    const canListThreads = Boolean(gw.listReviewThreads || gw.listUnresolvedReviewThreads);
    if (canListThreads && gw.replyToThread && gw.resolveReviewThread) {
      let threads: ReviewThread[] = [];
      try {
        if (gw.listReviewThreads) {
          // The RESOLVED threads are listed too: a resolved thread is the
          // cross-run proof that its comments were already answered.
          threads = await gw.listReviewThreads(prNumber, gwOptions);
        } else {
          threads = (await gw.listUnresolvedReviewThreads!(prNumber, gwOptions)).map((t) => ({
            ...t,
            isResolved: false
          }));
        }
      } catch (err: unknown) {
        failures.push({
          scope: 'thread',
          target: 'review-threads',
          error: failureMessage(err)
        });
      }

      for (const thread of threads) {
        const matched = thread.commentIds.filter((id) => inlineById.has(id));
        if (matched.length === 0) {
          // Not part of the triaged feedback: the thread stays untouched.
          continue;
        }

        if (thread.isResolved) {
          // An earlier run already answered this thread: no reply, no second
          // resolve — the feedback is dismissed, not dismissed twice.
          threadsSkipped++;
          for (const id of matched) {
            const comment = inlineById.get(id);
            if (comment) {
              context.resolvedInlineKeys.add(prFeedbackKey(comment.body));
            }
          }
          continue;
        }

        try {
          await gw.replyToThread(thread.id, notes, gwOptions);
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
            context.answeredInlineKeys.add(prFeedbackKey(comment.body));
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

    return { threadsReplied, threadsResolved, threadsSkipped };
  }

  /**
   * Dismisses the PR CONVERSATION comments.
   *
   * GitHub has no "resolve" for a conversation comment, so the only way to
   * dismiss one is to answer it with a comment. The job reads the feedback
   * keys the inline job recorded, so the same feedback is never answered
   * twice — neither inline nor on the conversation surface.
   */
  private async dismissConversationComments(
    context: TriageDismissContext
  ): Promise<TriageDismissConversationOutcome> {
    const {
      gw,
      gwOptions,
      prNumber,
      notes,
      conversationComments,
      answeredIds,
      newestAnswerAt,
      answeredInlineKeys,
      resolvedInlineKeys,
      failures,
      surfaces
    } = context;
    let conversationsReplied = 0;
    let conversationsSkipped = 0;
    let conversationsAlreadyAnswered = 0;
    let conversationsDuplicate = 0;
    let conversationsIgnored = 0;
    let conversationsPriorAnswers = 0;

    if (gw.replyToConversationComment) {
      for (const comment of conversationComments) {
        // The tool's own dismissal replies are not review feedback: answering
        // them would make the tool talk to itself.
        if (isDismissalReply(comment.body)) {
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

        // The PR's state proves this comment was already answered: another
        // comment on the PR references its id.
        if (answeredIds.has(comment.id)) {
          conversationsAlreadyAnswered++;
          conversationsSkipped++;
          continue;
        }

        // The review bot posts the same feedback inline AND as a conversation
        // summary. Answering it twice would be noise, so a conversation comment
        // whose feedback was already answered inline is skipped — by an
        // earlier run (its thread is resolved) or by this one.
        const feedbackKey = prFeedbackKey(comment.body);
        if (resolvedInlineKeys.has(feedbackKey)) {
          conversationsAlreadyAnswered++;
          conversationsSkipped++;
          continue;
        }
        if (answeredInlineKeys.has(feedbackKey)) {
          conversationsDuplicate++;
          conversationsSkipped++;
          continue;
        }

        // A prior answer the tool cannot attribute (it carries neither the
        // tool's footer nor its reference). Answering it again would be a
        // third reply to the same feedback.
        if (isUnattributablePriorAnswer(comment, newestAnswerAt)) {
          conversationsPriorAnswers++;
          continue;
        }

        try {
          await gw.replyToConversationComment(
            prNumber,
            comment.id,
            buildConversationReply(notes, comment.body),
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
        conversationsPriorAnswers > 0 ||
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

    return {
      conversationsReplied,
      conversationsSkipped,
      conversationsAlreadyAnswered,
      conversationsDuplicate,
      conversationsIgnored,
      conversationsPriorAnswers
    };
  }
}
