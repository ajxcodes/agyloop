import { CommandExecutorPort, GitHubGateway, StateRepository, WorktreeManagerPort } from '../ports';
import { shellQuote } from '../domain';

/**
 * Path prefixes that are NOT implementation evidence (issue #240/Defect 3).
 *
 * A PR that only touches these cannot prove an issue was fixed: PR #258 closed
 * #250 on a test-only diff.
 */
const NON_SOURCE_PATH_PREFIXES: readonly string[] = Object.freeze([
  'tests/',
  'docs/',
  'artifacts/'
]);

/** True when a changed path is a non-test source change. */
function isNonTestSourcePath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, '');
  return !NON_SOURCE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export interface SyncParams {
  readonly workspaceDir?: string;
  /**
   * When true, resolve what would be synced and report it, but perform no
   * fetch, no pull, no `gh pr list` and no issue close/comment (issue #248).
   */
  readonly dryRun?: boolean;
}

export interface SyncResult {
  readonly success: boolean;
  readonly message: string;
  /** True when this was a simulation (#248). */
  readonly dryRun?: boolean;
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
    const dryRun = params.dryRun === true;
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

      // A simulation stops HERE: the branch resolution above is a pure read,
      // and every step below mutates the remote, the local branch or GitHub
      // (#248 AC-248.3).
      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          message: `[dry-run] Would fetch origin and process merged PRs for '${collectorBranch}'. Nothing was fetched, pulled, or closed.`
        };
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
          await this.commandExecutor.execute(`git pull --ff-only origin ${shellQuote(collectorBranch)}`, { cwd });
        } else {
          // Fast-forward the local branch without checking it out
          await this.commandExecutor.execute(`git fetch origin ${shellQuote(`${collectorBranch}:${collectorBranch}`)}`, { cwd });
        }
      } catch (e) {
        warnings.push(`Failed to fast-forward collector branch ${collectorBranch}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 3. Close issues whose PRs merged into the collector branch
      //
      // Issue #240/Defect 3 (escalated): a PR body's `Closes #N` is a CLAIM, not
      // evidence. PR #258 closed an unfixed issue while its whole diff was one
      // test file. The compensator therefore requires a non-test source change
      // in the PR's OWN diff before it closes anything — and fails closed when
      // the diff cannot be read.
      if (collectorBranch !== 'main') {
        try {
          const prsRes = await this.commandExecutor.execute(`gh pr list --base ${shellQuote(collectorBranch)} --state merged --json number,title,body`, { cwd });
          const prs = JSON.parse(prsRes.stdout);

          for (const pr of prs) {
            const body = pr.body || '';
            // Look for Closes #N
            const match = body.match(/Closes #(\d+)/i);
            if (!match) {
              continue;
            }
            const issueId = parseInt(match[1], 10);

            let paths: string[] = [];
            try {
              const viewRes = await this.commandExecutor.execute(
                `gh pr view ${pr.number} --json files --jq '.files[].path'`,
                { cwd }
              );
              if (viewRes.exitCode === 0 && typeof viewRes.stdout === 'string') {
                const stdout = viewRes.stdout.trim();
                if (stdout.startsWith('{')) {
                  // A `gh` that ignored `--jq` (or a gateway that returns the
                  // raw payload) still yields the same paths.
                  try {
                    const parsed = JSON.parse(stdout);
                    paths = Array.isArray(parsed?.files)
                      ? parsed.files
                          .map((entry: { path?: string }) => String(entry?.path ?? ''))
                          .filter((entry: string) => entry.length > 0)
                      : [];
                  } catch {
                    paths = [];
                  }
                } else {
                  paths = stdout
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);
                }
              }
            } catch (e) {
              warnings.push(
                `Not closing #${issueId}: could not verify the diff of PR #${pr.number} (${e instanceof Error ? e.message : String(e)}).`
              );
              logs.push(`Skipped #${issueId}: unverifiable diff for PR #${pr.number}`);
              continue;
            }

            if (paths.length === 0) {
              warnings.push(
                `Not closing #${issueId}: could not verify the diff of PR #${pr.number} (no file list returned).`
              );
              logs.push(`Skipped #${issueId}: unverifiable diff for PR #${pr.number}`);
              continue;
            }

            const sourcePaths = paths.filter(isNonTestSourcePath);
            if (sourcePaths.length === 0) {
              warnings.push(
                `Not closing #${issueId}: PR #${pr.number} contains no non-test source change (files: ${paths.join(', ')}).`
              );
              logs.push(`Skipped #${issueId}: no non-test source change in PR #${pr.number}`);
              continue;
            }

            const issue = await this.githubGateway.fetchIssue(issueId, { cwd });
            if (issue && issue.state !== 'CLOSED') {
              if (this.githubGateway.closeIssue) {
                await this.githubGateway.closeIssue(issueId, { cwd });
              }
              if (this.githubGateway.commentOnIssue) {
                // The comment states only what the diff proves.
                await this.githubGateway.commentOnIssue(
                  issueId,
                  `Closed by agyloop sync: PR #${pr.number} into \`${collectorBranch}\` changed ${sourcePaths.length} non-test file(s) (Closes #${issueId}).`,
                  { cwd }
                );
              }
              logs.push(`Closed issue #${issueId} (merged in PR #${pr.number} to ${collectorBranch})`);
            } else {
              logs.push(`Skipped #${issueId}: already closed or unreadable`);
            }
          }
        } catch (e) {
          warnings.push(`Failed to close merged issues: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return {
        success: true,
        dryRun: false,
        message: `Successfully synced ${collectorBranch} and processed merged PRs.`,
        warnings: warnings.length > 0 ? warnings : undefined,
        logs: logs.length > 0 ? logs : undefined
      };
    } catch (err) {
      return {
        success: false,
        dryRun,
        message: `Sync failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
}
