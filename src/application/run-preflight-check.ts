/**
 * agyloop - RunPreFlightCheckUseCase (Application Layer)
 *
 * Coordinates smart pre-flight checks before worktree provisioning:
 * 1. Anti-Duplicate: halts cleanly if task issue is CLOSED on GitHub
 * 2. Anti-Duplicate: halts cleanly if an associated PR is already MERGED
 * 3. Resume Mode: re-attaches to existing worktree/branch if an OPEN PR or branch already exists
 *
 * Strict Hexagonal Architecture: Depends exclusively on Domain and Ports. Zero direct I/O.
 */

import {
  PreFlightCheckEngine,
  PreFlightCheckResult,
  PreFlightHaltError,
  PREFLIGHT_ACTION_HALT,
  PREFLIGHT_ACTION_RESUME,
  PREFLIGHT_ACTION_PROCEED,
  IssueNumber,
  StateMachine
} from '../domain';
import { GitHubGateway, WorktreeManagerPort, StateRepository } from '../ports';

export interface RunPreFlightCheckParams {
  readonly issueNumber?: number | string | null;
  readonly workspaceDir?: string;
  readonly trackerRepo?: string;
}

export class RunPreFlightCheckUseCase {
  private readonly githubGateway?: GitHubGateway;
  private readonly worktreeManager?: WorktreeManagerPort;
  private readonly stateRepo?: StateRepository;

  constructor(
    githubGateway?: GitHubGateway,
    worktreeManager?: WorktreeManagerPort,
    stateRepo?: StateRepository
  ) {
    this.githubGateway = githubGateway;
    this.worktreeManager = worktreeManager;
    this.stateRepo = stateRepo;
  }

  public async execute(params: RunPreFlightCheckParams = {}): Promise<PreFlightCheckResult> {
    let rawIssue = params.issueNumber;
    const cwd = params.workspaceDir || process.cwd();

    // Context auto-inference if issue is null/undefined
    if (rawIssue === null || rawIssue === undefined || String(rawIssue).trim() === '') {
      let inferred = IssueNumber.inferFromPath(cwd);
      if (!inferred && this.worktreeManager && this.worktreeManager.resolveBaseBranch) {
        try {
          const currentBranch = await this.worktreeManager.resolveBaseBranch(cwd);
          inferred = IssueNumber.inferFromBranch(currentBranch);
        } catch {
          // Non-fatal
        }
      }

      if (inferred) {
        rawIssue = inferred;
        if (this.stateRepo) {
          try {
            const snapshot = await this.stateRepo.load();
            if (snapshot && !snapshot.issue) {
              const sm = StateMachine.fromSnapshot(snapshot);
              sm.setIssue(inferred);
              await this.stateRepo.save(sm.toSnapshot());
            }
          } catch {
            // Non-fatal persistence
          }
        }
      }
    }

    if (rawIssue === null || rawIssue === undefined || String(rawIssue).trim() === '') {
      return PreFlightCheckEngine.evaluate({
        issueNumber: null
      });
    }

    const issueId = String(rawIssue).trim();
    const issueNum = Number(issueId);

    let issueState: string | null = null;

    // 1. Fetch GitHub Issue Status
    if (this.githubGateway && Number.isInteger(issueNum) && issueNum > 0) {
      try {
        const issueData = await this.githubGateway.fetchIssue(issueNum, {
          cwd,
          repo: params.trackerRepo
        });
        if (issueData && issueData.state) {
          issueState = issueData.state.toUpperCase();
        }
      } catch {
        // Network or offline fallback
      }
    }

    // Evaluate closed issue immediately
    if (issueState === 'CLOSED') {
      const haltMsg = `Task #${issueId} is already closed.`;
      throw new PreFlightHaltError(haltMsg, 'CLOSED', { issueNumber: issueId });
    }

    // 2. Check for Existing Pull Requests (Merged or Open)
    if (this.githubGateway && this.githubGateway.findPullRequest) {
      try {
        // Search PR by issue number or head branch prefix
        let pr = await this.githubGateway.findPullRequest({
          issueNumber: issueId,
          cwd,
          repo: params.trackerRepo
        });

        if (!pr) {
          pr = await this.githubGateway.findPullRequest({
            headBranch: `task/${issueId}`,
            cwd,
            repo: params.trackerRepo
          });
        }
        if (!pr) {
          pr = await this.githubGateway.findPullRequest({
            headBranch: `fix/${issueId}`,
            cwd,
            repo: params.trackerRepo
          });
        }

        if (pr) {
          if (pr.merged || pr.state === 'MERGED') {
            const taskBranchPattern = new RegExp(`^(?:task|fix)/${issueId}(?:[-_/]|$)`, 'i');
            const isMatchingTaskBranch = taskBranchPattern.test(pr.headRefName || '');

            if (isMatchingTaskBranch || issueState === 'CLOSED') {
              const base = pr.baseRefName || 'main';
              const haltMsg = `PR for task #${issueId} is already merged into ${base}.`;
              throw new PreFlightHaltError(haltMsg, 'MERGED', {
                issueNumber: issueId,
                baseBranch: base,
                prNumber: pr.number
              });
            } else {
              console.warn(
                `[agyloop] Warning: Disregarding merged PR #${pr.number} for open task #${issueId} because head branch '${pr.headRefName}' does not match task/${issueId} or fix/${issueId} convention.`
              );
              pr = null;
            }
          }

          if (pr && pr.state === 'OPEN') {
            let prReviewComments: any[] = [];
            let prHasChangesRequested = false;

            if (this.githubGateway.fetchPullRequestComments && pr.number) {
              try {
                const comments = await this.githubGateway.fetchPullRequestComments(pr.number, {
                  cwd,
                  repo: params.trackerRepo
                });
                prReviewComments = comments || [];
                prHasChangesRequested = prReviewComments.some(
                  (c) => (c.state || '').toUpperCase() === 'CHANGES_REQUESTED'
                );
              } catch {
                // Non-fatal
              }
            }

            return PreFlightCheckEngine.evaluate({
              issueNumber: issueId,
              issueState,
              prState: 'OPEN',
              prNumber: pr.number,
              prBaseBranch: pr.baseRefName,
              prHeadBranch: pr.headRefName,
              prReviewComments,
              prHasChangesRequested
            });
          }
        }
      } catch (err: unknown) {
        if (err instanceof PreFlightHaltError) {
          throw err;
        }
        // Non-fatal error during PR inspection
      }
    }

    // 3. Check for Existing Local / Remote Git Branches
    let existingBranch: string | null = null;
    if (this.worktreeManager && this.worktreeManager.listBranches) {
      try {
        const branches = await this.worktreeManager.listBranches({ workspaceDir: cwd });
        const branchPattern = new RegExp(`^(?:task|fix)/${issueId}(?:-[a-z0-9_-]+)?$`, 'i');
        const matched = branches.find((b) => branchPattern.test(b));
        if (matched) {
          existingBranch = matched;
        }
      } catch {
        // Non-fatal
      }
    }

    // 4. Run PreFlightCheckEngine evaluation
    const result = PreFlightCheckEngine.evaluate({
      issueNumber: issueId,
      issueState,
      existingBranch
    });

    if (result.isHalt) {
      throw new PreFlightHaltError(result.message, result.haltReason || 'GENERAL', {
        issueNumber: issueId
      });
    }

    return result;
  }
}
