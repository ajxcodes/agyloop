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
  MODE_STANDARD,
  CommitMessage,
  DiffAnalyzer,
  DraftCommitPlan,
  PublicSanitizer,
  InvalidTransitionError
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

    return {
      plan,
      commitMessage: finalCommitMessage,
      diffText,
      currentStage: sm.currentStage,
      stateMachine: sm
    };
  }
}
