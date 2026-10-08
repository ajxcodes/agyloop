import { CommandExecutorPort, GitHubGateway, StateRepository, WorktreeManagerPort } from '../ports';

export interface SyncParams {
  readonly workspaceDir?: string;
}

export interface SyncResult {
  readonly success: boolean;
  readonly message: string;
  readonly warnings?: string[];
  readonly logs?: string[];
}

export class SyncUseCase {
  private readonly commandExecutor: CommandExecutorPort;
  private readonly githubGateway: GitHubGateway;
  private readonly stateRepo: StateRepository;
  private readonly worktreeManager: WorktreeManagerPort;

  constructor(
    commandExecutor: CommandExecutorPort,
    githubGateway: GitHubGateway,
    stateRepo: StateRepository,
    worktreeManager: WorktreeManagerPort
  ) {
    this.commandExecutor = commandExecutor;
    this.githubGateway = githubGateway;
    this.stateRepo = stateRepo;
    this.worktreeManager = worktreeManager;
  }

  public async execute(params: SyncParams = {}): Promise<SyncResult> {
    const cwd = params.workspaceDir || process.cwd();
    const warnings: string[] = [];
    const logs: string[] = [];

    try {
      // 1. Resolve collector branch
      const currentBranch = await this.worktreeManager.resolveBaseBranch(cwd);
      let collectorBranch = currentBranch;

      if (!collectorBranch.startsWith('phase/') && !collectorBranch.startsWith('feature/')) {
        const snapshot = await this.stateRepo.load();
        if (snapshot?.baseBranch) {
          collectorBranch = snapshot.baseBranch;
        } else {
          // If not on a collector branch and no active state base branch, assume main
          collectorBranch = 'main';
        }
      }

      // 2. Fetch and fast-forward
      try {
        await this.commandExecutor.execute('git fetch origin', { cwd });
      } catch (e) {
        warnings.push(`Failed to fetch from origin: ${e instanceof Error ? e.message : String(e)}`);
      }

      try {
        // If we are currently on the collector branch, git pull --ff-only
        const headBranchRes = await this.commandExecutor.execute('git rev-parse --abbrev-ref HEAD', { cwd });
        const headBranch = headBranchRes.stdout.trim();
        
        if (headBranch === collectorBranch) {
          await this.commandExecutor.execute('git pull --ff-only origin ' + collectorBranch, { cwd });
        } else {
          // Fast-forward the local branch without checking it out
          await this.commandExecutor.execute(`git fetch origin ${collectorBranch}:${collectorBranch}`, { cwd });
        }
      } catch (e) {
        warnings.push(`Failed to fast-forward collector branch ${collectorBranch}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 3. Close issues whose PRs merged into the collector branch
      if (collectorBranch !== 'main') {
        try {
          const prsRes = await this.commandExecutor.execute(`gh pr list --base ${collectorBranch} --state merged --json number,title,body`, { cwd });
          const prs = JSON.parse(prsRes.stdout);
          
          for (const pr of prs) {
            const body = pr.body || '';
            // Look for Closes #N
            const match = body.match(/Closes #(\d+)/i);
            if (match) {
              const issueId = parseInt(match[1], 10);
              const issue = await this.githubGateway.fetchIssue(issueId, { cwd });
              if (issue && issue.state !== 'CLOSED') {
                if (this.githubGateway.closeIssue) {
                  await this.githubGateway.closeIssue(issueId, { cwd });
                }
                if (this.githubGateway.commentOnIssue) {
                  await this.githubGateway.commentOnIssue(issueId, `Automatically closed by agyloop sync. Implemented and merged via PR #${pr.number} into \`${collectorBranch}\`.`, { cwd });
                }
                logs.push(`Closed issue #${issueId} (merged in PR #${pr.number} to ${collectorBranch})`);
              }
            }
          }
        } catch (e) {
          warnings.push(`Failed to close merged issues: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return {
        success: true,
        message: `Successfully synced ${collectorBranch} and processed merged PRs.`,
        warnings: warnings.length > 0 ? warnings : undefined,
        logs: logs.length > 0 ? logs : undefined
      };
    } catch (err) {
      return {
        success: false,
        message: `Sync failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
}
