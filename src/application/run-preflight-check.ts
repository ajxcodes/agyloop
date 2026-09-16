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
  PREFLIGHT_ACTION_PROCEED
} from '../domain';
import { GitHubGateway, WorktreeManagerPort } from '../ports';

export interface RunPreFlightCheckParams {
  readonly issueNumber?: number | string | null;
  readonly workspaceDir?: string;
  readonly trackerRepo?: string;
}

export class RunPreFlightCheckUseCase {
  private readonly githubGateway?: GitHubGateway;
  private readonly worktreeManager?: WorktreeManagerPort;

  constructor(githubGateway?: GitHubGateway, worktreeManager?: WorktreeManagerPort) {
    this.githubGateway = githubGateway;
    this.worktreeManager = worktreeManager;
  }

  public async execute(params: RunPreFlightCheckParams = {}): Promise<PreFlightCheckResult> {
    const rawIssue = params.issueNumber;
    if (rawIssue === null || rawIssue === undefined || String(rawIssue).trim() === '') {
      return PreFlightCheckEngine.evaluate({
        issueNumber: null
      });
    }

    const issueId = String(rawIssue).trim();
    const issueNum = Number(issueId);
    const cwd = params.workspaceDir || process.cwd();

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
            const base = pr.baseRefName || 'main';
            const haltMsg = `PR for task #${issueId} is already merged into ${base}.`;
            throw new PreFlightHaltError(haltMsg, 'MERGED', {
              issueNumber: issueId,
              baseBranch: base,
              prNumber: pr.number
            });
          }

          if (pr.state === 'OPEN') {
            return PreFlightCheckEngine.evaluate({
              issueNumber: issueId,
              issueState,
              prState: 'OPEN',
              prNumber: pr.number,
              prBaseBranch: pr.baseRefName,
              prHeadBranch: pr.headRefName
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
