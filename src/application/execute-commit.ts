/**
 * agyloop - ExecuteCommitUseCase (Application Layer)
 *
 * Coordinates commit execution & human confirmation gate:
 * 1. Validates pipeline stage (must be at STAGE_COMMIT).
 * 2. Resolves CommitMessage (from params or drafting).
 * 3. Enforces Human Approval Confirmation Gate (never commits silently in standard mode).
 * 4. Executes git commit via CommandExecutorPort upon confirmation.
 * 5. Advances StateMachine transition: STAGE_COMMIT -> STAGE_COMPLETED.
 * 6. Updates AgyLoop Summary.md stage Commit / PR with commit hash, message, and timestamp.
 * 7. Checkpoints state to StateRepository.
 *
 * Strict Hexagonal Architecture: zero direct I/O, zero Node.js built-ins.
 */

import {
  StateMachine,
  StageName,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  MODE_YOLO,
  NOTE_COMMIT_CONFIRMED,
  NOTE_COMMIT_AUTO_APPROVED,
  PROMPT_CONFIRM_COMMIT,
  SUMMARY_STAGE_COMMIT_PR,
  SUMMARY_STATUS_COMPLETED,
  CommitMessage,
  CommitExecutionError,
  InvalidTransitionError,
  PublicSanitizer,
  buildGitTokenRedirectConfig,
  consumedHumanWaitMs,
  escapeShellQuote,
  formatStageDuration,
  isRootWorkspace
} from '../domain';
import {
  StateRepository,
  CommandExecutorPort,
  PlanGeneratorPort,
  ConfirmationPromptPort,
  WorktreeManagerPort
} from '../ports';

export interface ExecuteCommitParams {
  readonly commitMessage?: CommitMessage | string | null;
  readonly confirmed?: boolean;
  readonly bypassConfirmation?: boolean;
  readonly staged?: boolean;
  readonly workspaceDir?: string;
  readonly rootWorkspaceDir?: string;
  readonly dryRun?: boolean;
  readonly issue?: number | string | null;
  readonly milestoneTitle?: string | null;
  readonly keepWorktree?: boolean;
  readonly rejectionTarget?: 'IMPLEMENT' | 'PLAN' | StageName | null;
  readonly rejectionDirective?: 'replan' | 'implement' | string | null;
  readonly rejectionFeedback?: string | null;
  readonly rejectionReason?: string | null;
  readonly createPr?: boolean;
  /**
   * True only when a human can answer prompts. Defaults to true for backwards
   * compatibility; the CLI composition root and the readline adapter both enforce
   * TTY so a non-interactive session can never block (issue #218 AC6).
   */
  readonly interactive?: boolean;
}

export interface ExecuteCommitResult {
  readonly success: boolean;
  readonly confirmed: boolean;
  readonly commitHash: string | null;
  readonly commitMessage: CommitMessage;
  readonly currentStage: string;
  readonly stateMachine: StateMachine;
  readonly summaryUpdated: boolean;
  readonly prBaseBranch?: string;
  /**
   * The PR was CREATED by this run (issue #240/Defect 1). When true the manual
   * "Next Step (Create PR)" script is suppressed — it would describe work that
   * was already done.
   */
  readonly prCreated?: boolean;
  /** The created PR's URL, best effort — `undefined` when it could not be read. */
  readonly prUrl?: string;
  /** A PR already existed for the active branch; nothing was created. */
  readonly prExists?: boolean;
  /**
   * True when the PR targets a collector branch (`phase/*`, `feature/*`).
   * Closing keywords do not fire on a collector-base PR (issue #240/Defect 3).
   */
  readonly prBaseIsCollector?: boolean;
  readonly prCommand?: string;
  readonly worktreeTornDown?: boolean;
  readonly worktreeTornDownPath?: string;
  readonly worktreeTornDownIsolated?: boolean;
  readonly pushError?: string;
  readonly fallbackUsed?: boolean;
}

export class ExecuteCommitUseCase {
  private readonly stateRepo: StateRepository;
  private readonly commandExecutor: CommandExecutorPort;
  private readonly planGenerator?: PlanGeneratorPort;
  private readonly confirmationPrompt?: ConfirmationPromptPort;
  private readonly worktreeManager?: WorktreeManagerPort;

  constructor(
    stateRepo: StateRepository,
    commandExecutor: CommandExecutorPort,
    planGenerator?: PlanGeneratorPort,
    confirmationPrompt?: ConfirmationPromptPort,
    worktreeManager?: WorktreeManagerPort
  ) {
    this.stateRepo = stateRepo;
    this.commandExecutor = commandExecutor;
    this.planGenerator = planGenerator;
    this.confirmationPrompt = confirmationPrompt;
    this.worktreeManager = worktreeManager;
  }

  public async execute(params: ExecuteCommitParams = {}): Promise<ExecuteCommitResult> {
    const initialDir = params.workspaceDir || process.cwd();
    const snapshot = await this.stateRepo.load();
    const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : StateMachine.createInitial();
    const cwd = sm.worktree?.worktreePath;
    if (!cwd) {
      throw new CommitExecutionError('validateWorktree', 'Worktree path is missing in state. Cannot commit to root workspace.');
    }
    const rootDir = params.rootWorkspaceDir || initialDir;

    if (sm.currentStage !== STAGE_COMMIT) {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_COMPLETED,
        sm.mode,
        `Cannot execute commit: Pipeline is at stage '${sm.currentStage}'. Current stage must be '${STAGE_COMMIT}'.`
      );
    }

    // Resolve CommitMessage
    let commitMessage: CommitMessage;
    if (params.commitMessage instanceof CommitMessage) {
      commitMessage = params.commitMessage;
    } else if (typeof params.commitMessage === 'string' && params.commitMessage.trim()) {
      try {
        commitMessage = CommitMessage.parse(params.commitMessage.trim());
      } catch {
        commitMessage = CommitMessage.create({
          type: 'feat',
          description: params.commitMessage.trim(),
          issueNumber: sm.issue
        });
      }
    } else {
      throw new CommitExecutionError(
        'ExecuteCommit',
        'Commit message is required. Please provide a valid CommitMessage.'
      );
    }

    // Dry-run mode: return simulated execution result immediately without prompting
    if (params.dryRun) {
      return {
        success: true,
        confirmed: true,
        commitHash: 'dry-run-simulated-commit-hash',
        commitMessage,
        currentStage: sm.currentStage,
        stateMachine: sm,
        summaryUpdated: false
      };
    }

    // Human Confirmation Gate Evaluation
    const isYolo = sm.mode === MODE_YOLO;
    const isExplicitlyConfirmed = params.confirmed === true;
    const isBypassed = params.bypassConfirmation === true || isYolo;

    let userConfirmed: boolean;

    if (params.confirmed === false) {
      userConfirmed = false;
    } else if (isExplicitlyConfirmed || isBypassed) {
      userConfirmed = true;
    } else if (params.interactive === false) {
      // Non-interactive session: never block on a prompt. Leave the commit
      // unconfirmed so the caller's rejection path reports it as cancelled
      // (mirrors the fail-closed `init` prompt gate).
      userConfirmed = false;
    } else if (this.confirmationPrompt) {
      const promptQuery = `\nProposed Conventional Commit:\n  ${commitMessage.toSingleLine()}\n\nFull Message:\n${commitMessage.toFullMessage()}\n\n${PROMPT_CONFIRM_COMMIT}`;
      userConfirmed = await this.confirmationPrompt.confirm(promptQuery, false);
    } else {
      // Hard invariant: Never commit silently without explicit confirmation
      throw new CommitExecutionError(
        'ExecuteCommit',
        'Human confirmation gate requires explicit approval before committing. Pass confirmed: true, bypassConfirmation: true, or supply ConfirmationPromptPort.'
      );
    }

    if (!userConfirmed) {
      const hasDirective =
        params.rejectionDirective !== undefined && params.rejectionDirective !== null ||
        params.rejectionTarget !== undefined && params.rejectionTarget !== null ||
        params.rejectionReason !== undefined && params.rejectionReason !== null ||
        params.rejectionFeedback !== undefined && params.rejectionFeedback !== null;

      if (hasDirective) {
        const rawDirective = String(params.rejectionDirective || '').toLowerCase();
        const rawTarget = String(params.rejectionTarget || '').toUpperCase();
        const target = (rawDirective === 'replan' || rawTarget === 'PLAN') ? STAGE_PLAN : STAGE_IMPLEMENT;
        const reason = params.rejectionReason || params.rejectionFeedback || `Commit rejected: routed to ${target}`;

        sm.transition(target, {
          note: `Commit rejected by developer: Routed to ${target}`,
          rejectionFeedback: reason
        });
        await this.stateRepo.save(sm.toSnapshot());

        let summaryUpdated = false;
        if (this.planGenerator) {
          const issue = sm.issue || params.issue;
          const planLoc = this.planGenerator.resolvePlanFile({
            projectRoot: cwd,
            issue,
            planDir: sm.planDir
          });
          if (planLoc?.summaryPath) {
            summaryUpdated = this.planGenerator.updateSummaryLog(planLoc.summaryPath, {
              stage: SUMMARY_STAGE_COMMIT_PR,
              status: 'REJECTED',
              commitRejection: {
                targetStage: target,
                reason
              }
            });
          }
        }

        return {
          success: false,
          confirmed: false,
          commitHash: null,
          commitMessage,
          currentStage: sm.currentStage,
          stateMachine: sm,
          summaryUpdated
        };
      }

      return {
        success: false,
        confirmed: false,
        commitHash: null,
        commitMessage,
        currentStage: sm.currentStage,
        stateMachine: sm,
        summaryUpdated: false
      };
    }

    // Check git status / uncommitted changes
    const statusRes = await this.commandExecutor.execute('git status --porcelain', { cwd });
    if (!statusRes.stdout.trim()) {
      throw new CommitExecutionError(
        'git status',
        'Working tree clean; no changes available to commit.'
      );
    }

    // Stage changes if not already strictly staged
    if (!params.staged) {
      const addRes = await this.commandExecutor.execute('git add -A', { cwd });
      if (addRes.exitCode !== 0) {
        throw new CommitExecutionError(
          'git add',
          addRes.stderr || addRes.stdout || 'Failed to stage working changes.'
        );
      }
      // Defensive untrack: remove any accidentally staged symlinks (.agyloop, node_modules, artifacts).
      //
      // `--ignore-unmatch` is load-bearing (issue #102 regression): without it, `git rm --cached`
      // aborts with "fatal: pathspec 'node_modules' did not match any files" as soon as ANY of the
      // three pathspecs is untracked, which happens on a clean repo. The abort happens BEFORE the
      // remaining pathspecs are processed, so `.agyloop` survived and got committed -- and because
      // `.agyloop` is a symlink (mode 120000) rather than a directory, the granular `.gitignore`
      // rules (`.agyloop/state.json`, `.agyloop/tasks/`, ...) never matched it either.
      //
      // Uses the argv form (no shell) so the command behaves identically on Windows and there is
      // no `|| true` to swallow a genuine failure: exit status is checked and we fail closed.
      const untrackRes = await this.commandExecutor.execute('git', {
        cwd,
        args: ['rm', '--cached', '-rf', '--ignore-unmatch', '.agyloop', 'node_modules', 'artifacts']
      });
      if (untrackRes.exitCode !== 0) {
        throw new CommitExecutionError(
          'git rm --cached',
          untrackRes.stderr || untrackRes.stdout || 'Failed to untrack .agyloop / node_modules / artifacts.'
        );
      }
    }

    // Execute git commit
    const fullMsg = commitMessage.toFullMessage();
    const commitRes = await this.commandExecutor.execute('git', { 
      cwd, 
      args: ['commit', '-m', fullMsg] 
    });

    if (commitRes.exitCode !== 0) {
      throw new CommitExecutionError(
        'git commit',
        commitRes.stderr || commitRes.stdout || 'Git commit command failed.'
      );
    }

    // Capture commit hash
    const revRes = await this.commandExecutor.execute('git rev-parse HEAD', { cwd });
    const commitHash = revRes.stdout.trim() || 'unknown';

    // Resolve PR target base branch (inferred collector branch or main)
    const prBaseBranch = sm.baseBranch || 'main';
    // Shape-based, deliberately (issue #240/Defect 3): no default-branch probe
    // exists here, and adding a network call to the commit path is not worth it.
    // `main` / `master` are never collectors.
    const prBaseIsCollector = /^(phase|feature)\//.test(prBaseBranch);

    // Resolve active branch (worktree branch or git rev-parse HEAD fallback)
    let activeBranch = sm.worktree?.branch || '';
    if (!activeBranch) {
      try {
        const branchRes = await this.commandExecutor.execute('git rev-parse --abbrev-ref HEAD', { cwd });
        const detected = branchRes.stdout.trim();
        if (detected && detected !== 'HEAD') {
          activeBranch = detected;
        }
      } catch {
        // Fallback resolution failure non-fatal
      }
    }

    // Resolve milestone and issue for PR generation
    const milestone = params.milestoneTitle || sm.milestoneTitle || undefined;
    const issueId = params.issue || sm.issue;

    // Check if PR already exists for the active branch
    let prExists = false;
    if (activeBranch) {
      try {
        const prListRes = await this.commandExecutor.execute(`gh pr list --head '${escapeShellQuote(activeBranch)}' --json number`, { cwd });
        if (prListRes.exitCode === 0 && prListRes.stdout.trim()) {
          const prs = JSON.parse(prListRes.stdout.trim());
          if (Array.isArray(prs) && prs.length > 0) {
            prExists = true;
          }
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (err) {
        // Fallback to assuming no PR exists if gh fails or is unauthenticated
      }
    }

    let prCommand: string;
    if (prExists) {
      prCommand = `echo "PR already exists for branch '${escapeShellQuote(activeBranch)}'."; gh pr view`;
    } else {
      let prCommandCore = activeBranch
        ? `gh pr create --base '${escapeShellQuote(prBaseBranch)}' --head '${escapeShellQuote(activeBranch)}'`
        : `gh pr create --base '${escapeShellQuote(prBaseBranch)}'`;

      if (issueId) {
        const singleLine = commitMessage.toSingleLine();
        const sanitizedTitle = PublicSanitizer.sanitizeCommitMessage(singleLine);

        const rawBody = commitMessage.body ? `${commitMessage.body}\n\nCloses #${issueId}` : `Closes #${issueId}`;
        const sanitizedBody = PublicSanitizer.sanitizeMarkdown(rawBody);

        prCommandCore += ` --title '${escapeShellQuote(sanitizedTitle)}' --body '${escapeShellQuote(sanitizedBody)}'`;

        if (milestone) {
          prCommandCore += ` --milestone '${escapeShellQuote(milestone)}'`;
        }
      }

      // Wrap with dirty tree check to avoid "Warning: 1 uncommitted change" from gh pr create
      prCommand = `if ! git diff-index --quiet HEAD --; then git stash push -q -m "pr-create"; ${prCommandCore}; git stash pop -q; else ${prCommandCore}; fi`;
    }

    // Remote Task Branch Push with Automated Token Fallback
    let pushFailed = false;
    let pushError: string | undefined;
    let fallbackUsed = false;

    if (activeBranch) {
      try {
        const pushRes = await this.commandExecutor.execute(`git push -u origin "${activeBranch}"`, { cwd });
        if (pushRes.exitCode !== 0) {
          const standardError = (pushRes.stderr || pushRes.stdout || 'Git push failed.').trim();

          // Attempt HTTPS token fallback
          const tokenRes = await this.commandExecutor.execute('gh auth token', { cwd });
          const token = tokenRes.stdout.trim();

          if (token && tokenRes.exitCode === 0) {
            const redirectConfig = buildGitTokenRedirectConfig(token);
            const fallbackCmd = `git ${redirectConfig} push -u origin "${activeBranch}"`;

            const fallbackRes = await this.commandExecutor.execute(fallbackCmd, { cwd });
            if (fallbackRes.exitCode === 0) {
              fallbackUsed = true;
            } else {
              pushFailed = true;
              pushError = (fallbackRes.stderr || fallbackRes.stdout || standardError).trim();
            }
          } else {
            pushFailed = true;
            pushError = standardError;
          }
        }
      } catch (err: unknown) {
        pushFailed = true;
        pushError = err instanceof Error ? err.message : String(err);
      }
    }

    if (pushFailed) {
      throw new CommitExecutionError('git push', `Failed to push to remote: ${pushError}`);
    }

    // Issue #240/Defect 1: report what this run DID with the PR, and never hand
    // the operator a script for work that is already done. `prCommand` is
    // returned ONLY when no PR was created.
    let prCreated = false;
    let prUrl: string | undefined;
    let returnedPrCommand: string | undefined = prCommand;

    if (params.createPr && !prExists) {
      try {
        const createRes = await this.commandExecutor.execute(prCommand, { cwd });
        if (createRes.exitCode === 0) {
          prCreated = true;
          returnedPrCommand = undefined;
          prUrl = await this.readCreatedPrUrl(activeBranch, cwd);
        } else {
          console.warn(
            'Auto PR creation failed:',
            (createRes.stderr || createRes.stdout || 'gh pr create exited non-zero').trim()
          );
        }
      } catch (err: unknown) {
        // Non-fatal if PR creation fails during auto-create
        console.warn('Auto PR creation failed:', err instanceof Error ? err.message : String(err));
      }
    }

    // Advance StateMachine
    const transitionNote = isYolo ? NOTE_COMMIT_AUTO_APPROVED : NOTE_COMMIT_CONFIRMED;
    const waitBefore = sm.totalHumanWaitMs;
    sm.transition(STAGE_COMPLETED, {
      note: transitionNote,
      commitHash,
      commitMessage: commitMessage.toSingleLine()
    });
    // Issue #284 (AC5): this row IS a human gate with a row of its own, so its
    // wait is the honest measurement — and the value the live `263m 50s` used
    // to contradict.
    const commitGateWaitMs = consumedHumanWaitMs(waitBefore, sm.totalHumanWaitMs);

    // Checkpoint state
    await this.stateRepo.save(sm.toSnapshot());

    // Automated Worktree Teardown
    let worktreeTornDown = false;
    let worktreeTornDownPath: string | undefined = undefined;
    let worktreeTornDownIsolated: boolean | undefined = undefined;
    // Issue #247 (S2): never tear down a non-isolated descriptor, and never a
    // descriptor whose path resolves onto the root workspace — the shared
    // root-invariant predicate (`isRootWorkspace`) is authoritative; the
    // `isIsolated` label alone is not trusted.
    const worktree = sm.worktree;
    const shouldTeardown =
      !params.keepWorktree &&
      Boolean(worktree) &&
      Boolean(this.worktreeManager) &&
      !pushFailed &&
      worktree !== null &&
      worktree.isIsolated !== false &&
      !isRootWorkspace(worktree.worktreePath, rootDir);

    if (shouldTeardown && this.worktreeManager && sm.worktree) {
      const wtPath = sm.worktree.worktreePath;

      let doTeardown = false;
      if (isExplicitlyConfirmed || isBypassed) {
        doTeardown = true;
      } else if (params.interactive !== false && this.confirmationPrompt) {
        doTeardown = await this.confirmationPrompt.confirm(
          `\nTeardown git worktree at ${wtPath}?`,
          true
        );
      }

      if (doTeardown) {
        try {
          await this.worktreeManager.removeWorktree({
            worktreePath: wtPath,
            workspaceDir: rootDir,
            force: true,
            prune: true,
            // Internal teardown: the worktree may already be gone (removed out
            // of band) and/or registered outside `.worktrees` (an adopted
            // worktree). Both are legitimate here; neither waives the
            // registration check, and no external path is ever rmSync'ed (#282).
            tolerateMissing: true,
            allowExternal: true
          });
          // Capture the descriptor facts BEFORE the state loses the worktree, so
          // the CLI can report the torn-down path accurately (issue #247, S7).
          const tornDownIsIsolated = sm.worktree.isIsolated;
          sm.setWorktree(null);
          await this.stateRepo.save(sm.toSnapshot());
          worktreeTornDown = true;
          worktreeTornDownPath = wtPath;
          worktreeTornDownIsolated = tornDownIsIsolated;
        } catch {
          // Teardown failure non-fatal
        }
      }
    }

    // Best-effort cleanup of stale external subagent worktrees
    if (this.worktreeManager) {
      try {
        await this.worktreeManager.cleanOrphanedWorktrees({
          workspaceDir: rootDir,
          subagents: true
        });
      } catch {
        // Non-blocking best effort cleanup
      }
    }

    // Update Summary Log
    let summaryUpdated = false;
    if (this.planGenerator) {
      const issue = sm.issue || params.issue;
      const planLoc = this.planGenerator.resolvePlanFile({
        projectRoot: rootDir,
        issue,
        planDir: sm.planDir
      });
      const summaryPath = planLoc?.summaryPath;
      if (summaryPath) {
        summaryUpdated = this.planGenerator.updateSummaryLog(summaryPath, {
          stage: SUMMARY_STAGE_COMMIT_PR,
          status: SUMMARY_STATUS_COMPLETED,
          duration: formatStageDuration(commitGateWaitMs),
          commitHash,
          commitMessage: commitMessage.toSingleLine(),
          commitTimestamp: new Date().toISOString(),
          // Issue #284 (AC2): reaching COMPLETED is the last chance to make an
          // unrecorded row honest. Nothing may survive as PENDING/IN PROGRESS.
          finalize: true
        });
      }
    }

    return {
      success: true,
      confirmed: true,
      commitHash,
      commitMessage,
      currentStage: sm.currentStage,
      stateMachine: sm,
      summaryUpdated,
      prBaseBranch,
      prCreated,
      prUrl,
      prExists,
      prBaseIsCollector,
      prCommand: returnedPrCommand,
      worktreeTornDown,
      worktreeTornDownPath,
      worktreeTornDownIsolated,
      pushError,
      fallbackUsed
    };
  }

  /**
   * Reads the URL of the PR that was just created (issue #240/Defect 1).
   *
   * Best effort: the PR exists whether or not `gh pr view` can read it back, so
   * a failure here must not undo the creation or fail the commit. Returning
   * `undefined` makes the CLI say "URL unavailable" rather than invent one.
   */
  private async readCreatedPrUrl(activeBranch: string, cwd: string): Promise<string | undefined> {
    if (!activeBranch) {
      return undefined;
    }
    try {
      const res = await this.commandExecutor.execute(
        `gh pr view '${escapeShellQuote(activeBranch)}' --json url --jq .url`,
        { cwd }
      );
      const url = (res.stdout || '').trim();
      if (res.exitCode === 0 && url.length > 0) {
        return url;
      }
    } catch {
      // Best effort only.
    }
    return undefined;
  }
}
