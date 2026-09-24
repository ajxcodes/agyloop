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
  GATE_TRIAGE,
  NOTE_TRIAGE_ROUTED,
  StageName,
  IssueNumber
} from '../domain';
import {
  StateRepository,
  GitHubGateway,
  PullRequestReviewComment,
  PlanGeneratorPort
} from '../ports';

export type TriageAction = 'implement' | 'plan' | 'discovery' | 'completed' | 'dismiss';

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
}

export class TriagePrCommentsUseCase {
  private readonly stateRepo: StateRepository;
  private readonly githubGateway?: GitHubGateway;
  private readonly planGenerator?: PlanGeneratorPort;

  constructor(
    stateRepo: StateRepository,
    githubGateway?: GitHubGateway,
    planGenerator?: PlanGeneratorPort
  ) {
    this.stateRepo = stateRepo;
    this.githubGateway = githubGateway;
    this.planGenerator = planGenerator;
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

    // Default action to 'implement' if not specified
    const selectedAction: TriageAction = params.action || 'implement';
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

    // Ensure state machine is in STAGE_TRIAGE or can transition
    if (sm.currentStage !== STAGE_TRIAGE && sm.canTransition(STAGE_TRIAGE)) {
      sm.transition(STAGE_TRIAGE, {
        note: 'Entering PR comment triage',
        prNumber,
        commentCount: comments.length
      });
    }

    if (sm.pausedAtGate) {
      sm.resumeFromGate();
    }

    // Transition from STAGE_TRIAGE to targetStage
    if (sm.canTransition(targetStage)) {
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
      message: `Triage complete: routed to ${targetStage} with ${comments.length} comment(s).`
    };
  }
}
