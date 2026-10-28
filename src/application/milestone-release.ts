/**
 * agyloop - MilestoneReleaseUseCase (Application Layer)
 *
 * Orchestrates the /agyloop release pipeline:
 * 1. Validates phase/feature collector branch against main
 * 2. Checks for unmerged in-flight PRs targeting the collector branch
 * 3. Extracts commits and computes SemVer bump (MAJOR > MINOR > PATCH)
 * 4. Compiles sanitized, categorized Markdown changelog
 * 5. Opens or updates Milestone PR targeting main with release label (release:minor, etc.)
 *
 * Strict Hexagonal Architecture: Depends exclusively on Domain and Ports. Zero direct I/O.
 */

import {
  SemVerCalculator,
  SemVerEvaluationResult,
  MilestoneReleaseError,
  PublicSanitizer,
  NOTE_RELEASE_NOTES_DEPENDENCY
} from '../domain';
import {
  WorktreeManagerPort,
  GitHubGateway,
  GitHubPullRequestData,
  ConfigRepository,
  CommandExecutorPort
} from '../ports';

export interface MilestoneReleaseParams {
  readonly phaseBranch?: string | null;
  readonly baseBranch?: string | null; // defaults to 'main'
  readonly workspaceDir?: string;
  readonly dryRun?: boolean;
  readonly refresh?: boolean;
  readonly configPath?: string | null;
}

export interface MilestoneReleaseResult {
  readonly success: boolean;
  readonly phaseBranch: string;
  readonly baseBranch: string;
  /**
   * The ref the commit range was ACTUALLY computed against (issue #315,
   * AC-29). A missing local base falls back to `origin/<base>`, and the report
   * names the ref it used instead of silently reading a different range.
   */
  readonly baseRefUsed: string;
  readonly evaluation: SemVerEvaluationResult;
  readonly pullRequest?: GitHubPullRequestData;
  readonly message: string;
  readonly dryRun: boolean;
  readonly openInFlightPrsCount: number;
}

export class MilestoneReleaseUseCase {
  private readonly worktreeManager: WorktreeManagerPort;
  private readonly githubGateway?: GitHubGateway;
  private readonly configRepo?: ConfigRepository;
  private readonly commandExecutor?: CommandExecutorPort;

  constructor(
    worktreeManager: WorktreeManagerPort,
    githubGateway?: GitHubGateway,
    configRepo?: ConfigRepository,
    commandExecutor?: CommandExecutorPort
  ) {
    this.worktreeManager = worktreeManager;
    this.githubGateway = githubGateway;
    this.configRepo = configRepo;
    this.commandExecutor = commandExecutor;
  }

  public async execute(params: MilestoneReleaseParams = {}): Promise<MilestoneReleaseResult> {
    const cwd = params.workspaceDir || process.cwd();
    const config = this.configRepo
      ? this.configRepo.loadConfig({ customPath: params.configPath, cwd })
      : undefined;

    const baseBranch = params.baseBranch || 'main';

    // 1. Resolve phase collector branch
    let phaseBranch = params.phaseBranch;
    if (!phaseBranch) {
      phaseBranch = await this.worktreeManager.resolveBaseBranch(cwd);
    }

    if (phaseBranch === baseBranch) {
      throw new MilestoneReleaseError(
        `Cannot release from '${baseBranch}' to '${baseBranch}'. Please specify the active feature or phase branch (e.g. 'phase/1-bridge-arch').`
      );
    }

    // 2. Check for Unmerged In-Flight PRs targeting the collector branch
    let openInFlightPrsCount = 0;
    if (this.githubGateway && this.githubGateway.findPullRequest) {
      try {
        const inFlightPr = await this.githubGateway.findPullRequest({
          baseBranch: phaseBranch,
          state: 'open',
          cwd
        });
        if (inFlightPr) {
          openInFlightPrsCount = 1;
        }
      } catch {
        // Non-fatal inspection failure
      }
    }

    // 3. Resolve the base ref (issue #315, AC-28/AC-29 / #294)
    //
    // Ref resolution lives in the USE CASE, not the git adapter: `getCommitsBetween`
    // returns only strings, so it cannot report which ref it read. A missing
    // local base falls back to `origin/<base>`, and the ref actually used is
    // named on the result.
    const baseRefUsed = await this.resolveBaseRef(baseBranch, cwd);

    // 4. Extract Commits between baseRefUsed and phaseBranch
    let rawCommits: readonly string[] = [];
    if (this.worktreeManager.getCommitsBetween) {
      try {
        rawCommits = await this.worktreeManager.getCommitsBetween({
          baseBranch: baseRefUsed,
          headBranch: phaseBranch,
          workspaceDir: cwd
        });
      } catch (err: unknown) {
        // Defence in depth: the adapter throws when `git log` fails, so a ref
        // that vanished between the probe and the read can never be reported as
        // "nothing to release" (issue #315, AC-28).
        throw new MilestoneReleaseError(err instanceof Error ? err.message : String(err));
      }
    }

    if (rawCommits.length === 0) {
      throw new MilestoneReleaseError(
        `Collector branch '${phaseBranch}' has no new commits relative to '${baseRefUsed}'. Nothing to release.`
      );
    }

    // 5. Evaluate SemVer and Compile Changelog
    const trackerRepo = config?.migration?.trackerRepo;
    const milestoneTitle = `Release: ${phaseBranch} ➔ ${baseBranch}`;

    const evaluation = SemVerCalculator.evaluate(rawCommits, {
      trackerRepo,
      milestoneTitle
    });

    // 6. Dry-run early exit
    if (params.dryRun) {
      return {
        success: true,
        phaseBranch,
        baseBranch,
        baseRefUsed,
        evaluation,
        message: `[DRY RUN] Would create Milestone PR from '${phaseBranch}' to '${baseBranch}' with label '${evaluation.releaseLabel}'.`,
        dryRun: true,
        openInFlightPrsCount
      };
    }

    // 7. Check for existing open Milestone PR or create new one
    let pullRequest: GitHubPullRequestData | undefined;

    if (this.githubGateway && this.githubGateway.createPullRequest) {
      // Check if PR already exists
      if (this.githubGateway.findPullRequest) {
        try {
          const existingPr = await this.githubGateway.findPullRequest({
            headBranch: phaseBranch,
            baseBranch,
            cwd
          });
          if (existingPr) {
            pullRequest = existingPr;
            // Update labels if needed
            if (this.githubGateway.applyLabels && params.refresh) {
              await this.githubGateway.applyLabels(existingPr.number, [evaluation.releaseLabel], { cwd });
            }
          }
        } catch {
          // Continue to create
        }
      }

      if (!pullRequest) {
        const prTitle = `release: Milestone Release ${phaseBranch}`;
        const sanitizedBody = PublicSanitizer.sanitizeMarkdown(
          `${evaluation.changelog}\n\n---\n\n> **Outstanding dependency:** ${NOTE_RELEASE_NOTES_DEPENDENCY}`,
          { trackerRepo }
        );

        pullRequest = await this.githubGateway.createPullRequest({
          title: prTitle,
          body: sanitizedBody,
          baseBranch,
          headBranch: phaseBranch,
          labels: [evaluation.releaseLabel],
          cwd
        });
      }
    }

    // 8. Optional Issue Migration Trigger (milestone_only mode)
    if (
      config?.migration?.mode === 'milestone_only' &&
      config.migration.hookCommand &&
      this.commandExecutor
    ) {
      try {
        const hookResult = await this.commandExecutor.execute(config.migration.hookCommand, { cwd });
        if (hookResult.exitCode !== 0) {
          console.warn(
            `[codeloop] Warning: Migration hook '${config.migration.hookCommand}' exited with code ${hookResult.exitCode}: ${hookResult.stderr || hookResult.stdout || 'Unknown hook error'}`
          );
        }
      } catch (hookErr: unknown) {
        const hookMsg = hookErr instanceof Error ? hookErr.message : String(hookErr);
        console.warn(`[codeloop] Warning: Failed to execute migration hook '${config.migration.hookCommand}': ${hookMsg}`);
      }
    }

    return {
      success: true,
      phaseBranch,
      baseBranch,
      baseRefUsed,
      evaluation,
      pullRequest,
      message: `Milestone Release PR prepared: ${phaseBranch} ➔ ${baseBranch} (${evaluation.releaseLabel}).`,
      dryRun: false,
      openInFlightPrsCount
    };
  }

  /**
   * Resolves the base ref the range is computed against (issue #315,
   * AC-28/AC-29 / #294).
   *
   * An unresolvable ref is a distinct ERROR naming it — never an empty range.
   * A missing local base falls back to `origin/<base>` and returns that ref, so
   * the caller names the ref it actually used. Without a command executor the
   * probe cannot run and the name is trusted as-is; the adapter's own
   * `git log` failure is then surfaced by the caller.
   */
  private async resolveBaseRef(baseBranch: string, cwd: string): Promise<string> {
    if (!this.commandExecutor) {
      return baseBranch;
    }
    if (await this.refExists(baseBranch, cwd)) {
      return baseBranch;
    }
    const remoteRef = `origin/${baseBranch}`;
    if (await this.refExists(remoteRef, cwd)) {
      return remoteRef;
    }
    throw new MilestoneReleaseError(
      `Cannot resolve base ref '${baseBranch}' (also tried '${remoteRef}'). Check the branch name and fetch the remote, then retry.`
    );
  }

  /** True when `git rev-parse --verify --quiet` can resolve `ref`. */
  private async refExists(ref: string, cwd: string): Promise<boolean> {
    if (!this.commandExecutor) {
      return false;
    }
    try {
      const res = await this.commandExecutor.execute(
        `git rev-parse --verify --quiet "${ref}"`,
        { cwd }
      );
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }
}
