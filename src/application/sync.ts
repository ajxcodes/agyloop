import { CommandExecutorPort, GitHubGateway, GitHubIssueData, StateRepository, WorktreeManagerPort } from '../ports';
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

/**
 * A one-line reason fit for an operator log: first line, whitespace collapsed,
 * bounded so a stack-bearing `gh` error cannot swamp the output (#328).
 */
function shortReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const collapsed = raw.split('\n')[0].replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return 'unknown error';
  }
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

/**
 * The candidates a scan could not reach a definite, evidence-backed
 * disposition for. Both lists make the run INCOMPLETE (#328, INV-3).
 */
interface IssueScanOutcome {
  /** Issues whose state could not be measured; nothing was written for them. */
  readonly unreadable: { id: number; reason: string }[];
  /** Issues that were provably OPEN but whose close/comment did not complete. */
  readonly failedWrites: { id: number; reason: string }[];
}

export interface SyncParams {
  readonly workspaceDir?: string;
  /**
   * When true, perform no `git fetch`, no `git pull`, no issue close and no
   * issue comment — but DO run the read-only scan (`gh pr list`, `gh pr view`,
   * `fetchIssueStrict`) so the forecast is real (issue #248, #328).
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

  /**
   * The human-readable "why the run is incomplete" sentences (#328).
   */
  private describeIncomplete(outcome: IssueScanOutcome): string[] {
    const sentences: string[] = [];
    for (const item of outcome.unreadable) {
      sentences.push(
        `issue #${item.id} is unreadable (${item.reason}). Nothing was closed or commented on for it.`
      );
    }
    for (const item of outcome.failedWrites) {
      sentences.push(`the close/comment for #${item.id} failed (${item.reason}).`);
    }
    return sentences;
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

      // A simulation stops short of the mutating git steps, but it still READS
      // the merged PRs it would act on, so the forecast is evidence-backed
      // (#248 AC-248.3, #328 AC-328.6).
      if (dryRun) {
        const outcome: IssueScanOutcome =
          collectorBranch !== 'main'
            ? await this.processMergedIssues({ cwd, collectorBranch, dryRun: true, logs, warnings })
            : { unreadable: [], failedWrites: [] };
        const sentences = this.describeIncomplete(outcome);

        if (sentences.length > 0) {
          return {
            success: false,
            dryRun: true,
            message: `[dry-run] Forecast incomplete: ${sentences.join(' ')}`,
            warnings: warnings.length > 0 ? warnings : undefined,
            logs: logs.length > 0 ? logs : undefined
          };
        }

        return {
          success: true,
          dryRun: true,
          message: `[dry-run] Would fetch origin and process merged PRs for '${collectorBranch}'. Nothing was fetched, pulled, or closed.`,
          warnings: warnings.length > 0 ? warnings : undefined,
          logs: logs.length > 0 ? logs : undefined
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
      const outcome: IssueScanOutcome =
        collectorBranch !== 'main'
          ? await this.processMergedIssues({ cwd, collectorBranch, dryRun: false, logs, warnings })
          : { unreadable: [], failedWrites: [] };

      const sentences = this.describeIncomplete(outcome);
      const incomplete = sentences.length > 0;

      return {
        success: !incomplete,
        dryRun: false,
        message: incomplete
          ? `Sync incomplete: ${sentences.join(' ')}`
          : `Successfully synced ${collectorBranch} and processed merged PRs.`,
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

  /**
   * Scans the collector branch's merged PRs and closes the issues they prove
   * they delivered.
   *
   * Issue #240/Defect 3 (escalated): a PR body's `Closes #N` is a CLAIM, not
   * evidence. PR #258 closed an unfixed issue while its whole diff was one
   * test file. The compensator therefore requires a non-test source change in
   * the PR's OWN diff before it closes anything — and fails closed when the
   * diff cannot be read.
   *
   * Issue #328: the issue read that authorizes the close is the FAIL-CLOSED
   * `fetchIssueStrict`, and only `state === 'OPEN'` authorizes a write. An
   * unreadable issue is skipped, reported, and makes the run incomplete.
   */
  private async processMergedIssues(params: {
    cwd: string;
    collectorBranch: string;
    dryRun: boolean;
    logs: string[];
    warnings: string[];
  }): Promise<IssueScanOutcome> {
    const { cwd, collectorBranch, dryRun, logs, warnings } = params;
    const outcome: IssueScanOutcome = { unreadable: [], failedWrites: [] };

    const markUnreadable = (issueId: number, reason: string): void => {
      outcome.unreadable.push({ id: issueId, reason });
      warnings.push(
        `Not closing #${issueId}: could not read the issue (${reason}). Nothing was closed or commented on.`
      );
      logs.push(
        dryRun
          ? `[dry-run] Would skip #${issueId}: unreadable (${reason})`
          : `Skipped #${issueId}: unreadable (${reason})`
      );
    };

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

        // 1. Capability. A gateway that cannot prove the state cannot authorize
        // a write (#328, INV-2): refuse rather than fall back to a lenient read.
        if (!this.githubGateway.fetchIssueStrict) {
          markUnreadable(issueId, 'gateway cannot prove the issue state');
          continue;
        }

        // 2. Fail-closed read.
        let issue: GitHubIssueData;
        try {
          issue = await this.githubGateway.fetchIssueStrict(issueId, { cwd });
        } catch (e) {
          markUnreadable(issueId, shortReason(e));
          continue;
        }

        // 3. A measured CLOSED is a definite, non-mutating disposition.
        if (issue.state === 'CLOSED') {
          logs.push(
            dryRun
              ? `[dry-run] Would skip #${issueId}: already closed`
              : `Skipped #${issueId}: already closed`
          );
          continue;
        }

        // 4. Allow-list (INV-1): only a measured OPEN authorizes a write.
        if (issue.state !== 'OPEN') {
          markUnreadable(issueId, `unexpected state '${String(issue.state)}'`);
          continue;
        }

        // 5. Forecast only.
        if (dryRun) {
          logs.push(
            `[dry-run] Would close issue #${issueId} and post 1 comment (merged in PR #${pr.number} into ${collectorBranch})`
          );
          continue;
        }

        // 6. Real run. Both capabilities are required BEFORE either is used:
        // never close without the comment, never comment without the close.
        try {
          if (!this.githubGateway.closeIssue || !this.githubGateway.commentOnIssue) {
            throw new Error('gateway has no close/comment capability');
          }
          await this.githubGateway.closeIssue(issueId, { cwd });
          // The comment states only what the diff proves.
          await this.githubGateway.commentOnIssue(
            issueId,
            `Closed by agyloop sync: PR #${pr.number} into \`${collectorBranch}\` changed ${sourcePaths.length} non-test file(s) (Closes #${issueId}).`,
            { cwd }
          );
          logs.push(`Closed issue #${issueId} (merged in PR #${pr.number} to ${collectorBranch})`);
        } catch (e) {
          const reason = shortReason(e);
          outcome.failedWrites.push({ id: issueId, reason });
          warnings.push(
            `Not closing #${issueId}: could not close it (${reason}). The close/comment did not complete.`
          );
          logs.push(`Failed to close #${issueId}: ${reason}`);
        }
      }
    } catch (e) {
      warnings.push(`Failed to close merged issues: ${e instanceof Error ? e.message : String(e)}`);
    }

    return outcome;
  }
}
