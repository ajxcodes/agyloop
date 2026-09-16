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
  PublicSanitizer
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

    // 3. Extract Commits between baseBranch and phaseBranch
    let rawCommits: readonly string[] = [];
    if (this.worktreeManager.getCommitsBetween) {
      rawCommits = await this.worktreeManager.getCommitsBetween({
        baseBranch,
        headBranch: phaseBranch,
        workspaceDir: cwd
      });
    }

    if (rawCommits.length === 0) {
      throw new MilestoneReleaseError(
        `Collector branch '${phaseBranch}' has no new commits relative to '${baseBranch}'. Nothing to release.`
      );
    }

    // 4. Evaluate SemVer and Compile Changelog
    const trackerRepo = config?.migration?.trackerRepo;
    const milestoneTitle = `Release: ${phaseBranch} ➔ ${baseBranch}`;

    const evaluation = SemVerCalculator.evaluate(rawCommits, {
      trackerRepo,
      milestoneTitle
    });

    // 5. Dry-run early exit
    if (params.dryRun) {
      return {
        success: true,
        phaseBranch,
        baseBranch,
        evaluation,
        message: `[DRY RUN] Would create Milestone PR from '${phaseBranch}' to '${baseBranch}' with label '${evaluation.releaseLabel}'.`,
        dryRun: true,
        openInFlightPrsCount
      };
    }

    // 6. Check for existing open Milestone PR or create new one
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
        const sanitizedBody = PublicSanitizer.sanitizeMarkdown(evaluation.changelog, {
          trackerRepo
        });

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

    // 7. Optional Issue Migration Trigger (milestone_only mode)
    if (
      config?.migration?.mode === 'milestone_only' &&
      config.migration.hookCommand &&
      this.commandExecutor
    ) {
      try {
        await this.commandExecutor.execute(config.migration.hookCommand, { cwd });
      } catch {
        // Non-fatal hook execution
      }
    }

    return {
      success: true,
      phaseBranch,
      baseBranch,
      evaluation,
      pullRequest,
      message: `Milestone Release PR prepared: ${phaseBranch} ➔ ${baseBranch} (${evaluation.releaseLabel}).`,
      dryRun: false,
      openInFlightPrsCount
    };
  }
}
