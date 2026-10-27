/**
 * agyloop - DraftCommitUseCase (Application Layer)
 *
 * Coordinates semantic commit drafting:
 * 1. Validates pipeline stage (must be at or transitioning to STAGE_COMMIT).
 * 2. Extracts working or staged diff via CommandExecutorPort.
 * 3. Ingests active issue context via GitHubGateway.
 * 4. Performs pure diff analysis and Conventional Commit drafting via DiffAnalyzer.
 *
 * Strict Hexagonal Architecture: zero direct I/O, zero Node.js built-ins.
 */

import {
  StateMachine,
  STAGE_COMMIT,
  STAGE_REVIEW,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MODE_STANDARD,
  CommitMessage,
  DiffAnalyzer,
  DraftCommitPlan,
  PublicSanitizer,
  InvalidTransitionError,
  isCommitExcludedPath
} from '../domain';
import {
  StateRepository,
  CommandExecutorPort,
  GitHubGateway,
  PlanGeneratorPort
} from '../ports';

export interface DraftCommitParams {
  readonly issue?: number | string | null;
  readonly staged?: boolean;
  readonly workingDiff?: string | null;
  readonly baseRef?: string;
  readonly workspaceDir?: string;
  readonly explicitType?: string | null;
  readonly explicitScope?: string | null;
  readonly isBreaking?: boolean;
  readonly userMessage?: string | null;
}

export interface DraftCommitResult {
  readonly plan: DraftCommitPlan;
  readonly commitMessage: CommitMessage;
  readonly diffText: string;
  readonly currentStage: string;
  readonly stateMachine: StateMachine;
  /**
   * Untracked paths the commit WILL include, because the executor stages with
   * `git add -A` (issue #240/Defect 2). The tracked-only diff cannot see them,
   * so the operator's file list omitted files the commit actually contained.
   */
  readonly untrackedFiles: readonly string[];
  /**
   * Exactly what will be staged: the analysed `modifiedFiles` followed by any
   * untracked path not already listed. A SEPARATE array so `DiffAnalyzer`
   * stays pure — the analysed plan's semantics are not mutated.
   */
  readonly listedFiles: readonly string[];
  /**
   * Paths the commit gate EXCLUDES (`.agyloop`, `node_modules`, `artifacts`)
   * and that therefore never reach `listedFiles` (issue #301, absorbing #319).
   *
   * One predicate with `ExecuteCommitUseCase`'s `git rm --cached`, so the
   * printed list and the commit cannot disagree.
   */
  readonly excludedFiles: readonly string[];
}

export class DraftCommitUseCase {
  private readonly stateRepo: StateRepository;
  private readonly commandExecutor: CommandExecutorPort;
  private readonly githubGateway: GitHubGateway;
  private readonly planGenerator?: PlanGeneratorPort;

  constructor(
    stateRepo: StateRepository,
    commandExecutor: CommandExecutorPort,
    githubGateway: GitHubGateway,
    planGenerator?: PlanGeneratorPort
  ) {
    this.stateRepo = stateRepo;
    this.commandExecutor = commandExecutor;
    this.githubGateway = githubGateway;
    this.planGenerator = planGenerator;
  }

  public async execute(params: DraftCommitParams = {}): Promise<DraftCommitResult> {
    const initialDir = params.workspaceDir || process.cwd();
    const snapshot = await this.stateRepo.load();
    const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : StateMachine.createInitial();
    const cwd = sm.worktree?.worktreePath || initialDir;

    if (sm.currentStage !== STAGE_COMMIT && sm.currentStage !== STAGE_REVIEW) {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_COMMIT,
        sm.mode,
        `Cannot draft commit: Pipeline is at '${sm.currentStage}'. Current stage must be '${STAGE_COMMIT}'.`
      );
    }

    // Extract diff
    let diffText = params.workingDiff || '';

    if (!diffText) {
      if (params.staged) {
        const res = await this.commandExecutor.execute('git diff --cached', { cwd });
        diffText = res.stdout;
      } else if (params.baseRef) {
        const res = await this.commandExecutor.execute(`git diff ${params.baseRef}...HEAD`, { cwd });
        diffText = res.stdout;
      } else {
        const headRes = await this.commandExecutor.execute('git diff HEAD', { cwd });
        if (headRes.stdout.trim()) {
          diffText = headRes.stdout;
        } else {
          const unstagedRes = await this.commandExecutor.execute('git diff', { cwd });
          diffText = unstagedRes.stdout;
        }
      }
    }

    // Issue #240/Defect 2: the count/list must match what `git add -A` will
    // stage. The analysed diff is tracked-only, so untracked paths are collected
    // separately. Staged mode never runs `git add -A`, so it never lists them.
    let untrackedFiles: readonly string[] = [];
    let excludedUntracked: readonly string[] = [];
    if (!params.staged) {
      try {
        const statusRes = await this.commandExecutor.execute('git status --porcelain -uall', { cwd });
        if (typeof statusRes.stdout === 'string') {
          const collected = statusRes.stdout
            .split('\n')
            .filter((line) => line.startsWith('?? '))
            .map((line) => stripPathQuotes(line.slice(3).trim()))
            .filter((entry) => entry.length > 0);
          // Issue #301: `untrackedFiles` is the INCLUDED set the caller marks
          // `(untracked)`; excluded bookkeeping is reported separately.
          excludedUntracked = collected.filter(isCommitExcludedPath);
          untrackedFiles = collected.filter((entry) => !isCommitExcludedPath(entry));
        }
      } catch {
        // A status probe failure must not fail the draft; the list is simply
        // the tracked set the diff already gave us.
      }
    }

    // Resolve issue context
    const issueNum = params.issue || sm.issue;
    let issueTitle: string | null = null;

    if (issueNum) {
      const parsedNum = Number(issueNum);
      if (Number.isInteger(parsedNum) && parsedNum > 0) {
        try {
          const issueContext = await this.githubGateway.fetchIssue(parsedNum, { cwd });
          if (issueContext) {
            issueTitle = issueContext.title;
          }
        } catch {
          // Fallback gracefully without throwing on network failure
        }
      }
    }

    // Run pure diff analysis
    const plan = DiffAnalyzer.analyzeDiff(diffText, {
      issueNumber: issueNum,
      issueTitle,
      explicitType: params.explicitType,
      explicitScope: params.explicitScope,
      isBreaking: params.isBreaking
    });

    let finalCommitMessage = plan.commitMessage;

    if (params.userMessage && typeof params.userMessage === 'string' && params.userMessage.trim()) {
      try {
        finalCommitMessage = CommitMessage.parse(params.userMessage.trim());
      } catch {
        // If not a full conventional message, use it as description
        finalCommitMessage = CommitMessage.create({
          type: plan.inferredType,
          scope: plan.inferredScope,
          description: params.userMessage.trim(),
          isBreaking: plan.isBreaking,
          issueNumber: issueNum ? Number(issueNum) : null
        });
      }
    }

    const sanitizedDesc = PublicSanitizer.sanitizeCommitMessage(finalCommitMessage.description);
    const sanitizedBody = finalCommitMessage.body
      ? PublicSanitizer.sanitizeCommitMessage(finalCommitMessage.body)
      : null;

    finalCommitMessage = CommitMessage.create({
      type: finalCommitMessage.type,
      scope: finalCommitMessage.scope,
      description: sanitizedDesc,
      body: sanitizedBody,
      isBreaking: finalCommitMessage.isBreaking,
      issueNumber: finalCommitMessage.issueNumber
    });

    const listedFiles = [
      ...plan.modifiedFiles.filter((file) => !isCommitExcludedPath(file)),
      ...untrackedFiles.filter(
        (file) => !isCommitExcludedPath(file) && !plan.modifiedFiles.includes(file)
      )
    ];

    // Issue #301 (absorbing #319): the SAME exclusion predicate the commit uses
    // for `git rm --cached`, applied to both the analysed (tracked) paths and
    // the untracked ones — a tracked `.agyloop/state.json` is untracked by the
    // commit too, so it must never appear in the printed list either.
    const excludedFiles = Array.from(
      new Set([
        ...plan.modifiedFiles.filter(isCommitExcludedPath),
        ...excludedUntracked
      ])
    );

    return {
      plan,
      commitMessage: finalCommitMessage,
      diffText,
      currentStage: sm.currentStage,
      stateMachine: sm,
      untrackedFiles,
      listedFiles,
      excludedFiles
    };
  }
}

/**
 * Strips the C-style quoting `git status --porcelain` applies to unusual paths.
 * A plain path is returned unchanged.
 */
function stripPathQuotes(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return raw;
}
