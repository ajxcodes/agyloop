/**
 * codeloop - MilestoneReleaseUseCase (Application Layer)
 *
 * Orchestrates the /codeloop release pipeline:
 * 1. Validates phase/feature collector branch against main
 * 2. Checks for unmerged in-flight PRs targeting the collector branch
 * 3. Extracts commits and computes SemVer bump (MAJOR > MINOR > PATCH)
 * 4. Compiles sanitized, categorized Markdown changelog
 * 5. Provisions/verifies the release label, then opens or updates Milestone PR
 *    targeting main with that label (release:minor, etc.)
 *
 * Strict Hexagonal Architecture: Depends exclusively on Domain and Ports. Zero direct I/O.
 */

import {
  SemVerCalculator,
  SemVerEvaluationResult,
  MilestoneReleaseError,
  PublicSanitizer,
  NOTE_RELEASE_NOTES_DEPENDENCY,
  releaseLabelCreateCommand,
  releaseLabelDefinition
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

/**
 * The release-label precondition this run enforced (issue #502, AC1/AC2).
 *
 * `existed === false && provisioned === false` is the DRY-RUN verdict: the
 * label is absent and the real run would create it. The renderer reads this
 * object instead of re-deriving a promise from `evaluation.releaseLabel`.
 */
export interface ReleaseLabelPrecondition {
  readonly label: string;
  readonly repo: string | null;
  readonly existed: boolean;
  readonly provisioned: boolean;
  /** The exact `gh label create …` command that provisions this label. */
  readonly remedyCommand: string;
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
  readonly labelPrecondition?: ReleaseLabelPrecondition;
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

    // 5b. Resolve the release-label precondition (issue #502, AC1/AC2).
    //
    // ONE call site for the dry run and the real run: the preview can never
    // validate a different precondition than the run it previews. Dry-run is
    // read-only (existence check only).
    const labelPrecondition = await this.ensureReleaseLabel(
      evaluation.releaseLabel,
      cwd,
      params.dryRun === true
    );

    // 6. Dry-run early exit
    if (params.dryRun) {
      return {
        success: true,
        phaseBranch,
        baseBranch,
        baseRefUsed,
        evaluation,
        message: `[DRY RUN] Would create Milestone PR from '${phaseBranch}' to '${baseBranch}' with label '${evaluation.releaseLabel}'.${this.describeLabelPrecondition(labelPrecondition)}`,
        dryRun: true,
        openInFlightPrsCount,
        labelPrecondition
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
      openInFlightPrsCount,
      labelPrecondition
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

  /**
   * The label precondition as one sentence, or '' when no PR path is reachable.
   */
  private describeLabelPrecondition(precondition?: ReleaseLabelPrecondition): string {
    if (!precondition) return '';
    const where = precondition.repo ? ` in ${precondition.repo}` : '';
    if (precondition.existed) {
      return ` Release label '${precondition.label}' verified${where}.`;
    }
    return ` Release label '${precondition.label}' does not exist yet${where}; the real run will create it with: ${precondition.remedyCommand}`;
  }

  /**
   * Resolves the release label BEFORE any PR is created or refreshed
   * (issue #502, AC1/AC2).
   *
   * - present            -> verified, nothing is written
   * - absent + dry-run   -> reported as "would be provisioned", nothing written
   * - absent + real run  -> `createLabel` (idempotent), or a NAMED refusal that
   *                         quotes the exact `gh label create` command
   *
   * A gateway that can create PRs but cannot look a label up is a refusal, not
   * a silent pass: this run cannot prove the PR would open.
   */
  private async ensureReleaseLabel(
    label: string,
    cwd: string,
    dryRun: boolean
  ): Promise<ReleaseLabelPrecondition | undefined> {
    const gateway = this.githubGateway;
    if (!gateway || !gateway.createPullRequest) return undefined;

    const repo = await this.resolveRepo(cwd);
    const remedyCommand = releaseLabelCreateCommand(label, repo);
    const where = repo ? ` in ${repo}` : '';

    if (!gateway.labelExists) {
      throw new MilestoneReleaseError(
        `Cannot verify release label '${label}'${where}: the GitHub gateway provides no label lookup, so this run cannot prove the milestone PR would open. Create it with: ${remedyCommand}`
      );
    }

    let existed: boolean;
    try {
      existed = await gateway.labelExists(label, { cwd });
    } catch (err: unknown) {
      throw new MilestoneReleaseError(
        `Cannot verify release label '${label}'${where}. Ensure 'gh' is authenticated (gh auth status), or create it with: ${remedyCommand}`,
        { label },
        err
      );
    }

    if (existed) {
      return { label, repo, existed: true, provisioned: false, remedyCommand };
    }
    if (dryRun) {
      return { label, repo, existed: false, provisioned: false, remedyCommand };
    }
    if (!gateway.createLabel) {
      throw new MilestoneReleaseError(
        `Release label '${label}' does not exist${where} and this gateway cannot create it, so the milestone PR would be refused. Create it with: ${remedyCommand}`
      );
    }

    try {
      const definition = releaseLabelDefinition(label);
      await gateway.createLabel(label, {
        cwd,
        color: definition?.color,
        description: definition?.description
      });
    } catch (err: unknown) {
      throw new MilestoneReleaseError(
        `Failed to create release label '${label}'${where}. Create it with: ${remedyCommand}`,
        { label },
        err
      );
    }

    return { label, repo, existed: false, provisioned: true, remedyCommand };
  }

  /** The repo slug for the remedy text; never throws. */
  private async resolveRepo(cwd: string): Promise<string | null> {
    try {
      if (!this.githubGateway || !this.githubGateway.getCurrentRepo) return null;
      return (await this.githubGateway.getCurrentRepo(cwd)) ?? null;
    } catch {
      return null;
    }
  }
}
