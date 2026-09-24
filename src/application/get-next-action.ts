/**
 * agyloop - GetNextActionUseCase (Application Layer)
 *
 * Inspects pipeline checkpoint state and generates the exact next operational directive,
 * including copy-paste-ready `invoke_subagent` JSON payloads populated with issue context,
 * active worktree paths, and model tier assignments.
 *
 * Strict Hexagonal Architecture: zero direct I/O, depends only on Domain and Ports.
 */

import {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_TRIAGE,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  ROLE_TITLE_PLANNER,
  ROLE_TITLE_IMPLEMENTER,
  ROLE_TITLE_GATE,
  ROLE_TITLE_REVIEWER,
  MODE_YOLO,
  IssueNumber
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubGateway,
  WorktreeManagerPort,
  BuildDetectorPort
} from '../ports';
import { ResolveSubagentUseCase } from './resolve-subagent';
import { InferBaseBranchUseCase } from './infer-base-branch';

export interface GetNextActionParams {
  readonly workspaceDir?: string;
  readonly configPath?: string | null;
  readonly issue?: number | string | null;
}

export interface SubagentInvocationItem {
  readonly TypeName: string;
  readonly Role: string;
  readonly Model: string;
  readonly Workspace: string;
  readonly Prompt: string;
}

export interface SubagentInvocationPayload {
  readonly Subagents: readonly SubagentInvocationItem[];
}

export interface NextActionResult {
  readonly currentStage: string;
  readonly nextStage: string;
  readonly actionType: 'subagent' | 'human_gate' | 'completed' | 'preflight';
  readonly role?: string;
  readonly title: string;
  readonly description: string;
  readonly worktreePath?: string | null;
  readonly baseBranch?: string | null;
  readonly taskBranch?: string | null;
  readonly invocationPayload?: SubagentInvocationPayload | null;
  readonly humanSummary: string;
}

export class GetNextActionUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator?: PlanGeneratorPort;
  private readonly githubGateway?: GitHubGateway;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;
  private readonly worktreeManager?: WorktreeManagerPort;
  private readonly buildDetector?: BuildDetectorPort;
  private readonly inferBaseBranchUseCase?: InferBaseBranchUseCase;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator?: PlanGeneratorPort,
    githubGateway?: GitHubGateway,
    resolveSubagentUseCase?: ResolveSubagentUseCase,
    worktreeManager?: WorktreeManagerPort,
    buildDetector?: BuildDetectorPort,
    inferBaseBranchUseCase?: InferBaseBranchUseCase
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.githubGateway = githubGateway;
    this.resolveSubagentUseCase =
      resolveSubagentUseCase ?? new ResolveSubagentUseCase(configRepo, githubGateway);
    this.worktreeManager = worktreeManager;
    this.buildDetector = buildDetector;
    this.inferBaseBranchUseCase = inferBaseBranchUseCase;
  }

  public async execute(params: GetNextActionParams = {}): Promise<NextActionResult> {
    const cwd = params.workspaceDir || process.cwd();
    const snapshot = await this.stateRepo.load();
    const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : StateMachine.createInitial();

    const config = this.configRepo.loadConfig({
      customPath: params.configPath,
      cwd
    });

    // Context resolution: explicit issue -> state.issue -> auto-inferred issue
    const explicitIssue = IssueNumber.tryFrom(params.issue)?.value ?? null;
    let inferredIssue: number | null = null;

    if (!explicitIssue && !sm.issue) {
      inferredIssue =
        IssueNumber.inferFromPath(sm.worktree?.worktreePath as string | undefined) ??
        IssueNumber.inferFromPath(cwd);
      if (!inferredIssue && sm.worktree?.branch) {
        inferredIssue = IssueNumber.inferFromBranch(sm.worktree.branch);
      }
      if (!inferredIssue && this.worktreeManager && this.worktreeManager.resolveBaseBranch) {
        try {
          const currentBranch = await this.worktreeManager.resolveBaseBranch(cwd);
          inferredIssue = IssueNumber.inferFromBranch(currentBranch);
        } catch {
          // Non-fatal
        }
      }
      if (inferredIssue) {
        sm.setIssue(inferredIssue);
        await this.stateRepo.save(sm.toSnapshot());
      }
    }

    let activeIssue = explicitIssue ?? sm.issue ?? inferredIssue;

    // Explicit flag ingestion / lifecycle initialization & resume:
    // When explicit --issue <id> is provided:
    // If state is COMPLETED or INITIALIZED with a different (or null) issue (or explicit override):
    const isExplicit = explicitIssue !== null;
    const shouldInitializeOrResume =
      (isExplicit && (sm.currentStage === STAGE_COMPLETED || sm.currentStage === STAGE_INITIALIZED)) ||
      (!isExplicit && inferredIssue !== null && sm.currentStage === STAGE_COMPLETED);

    if (activeIssue && shouldInitializeOrResume) {
      sm.reset(sm.mode, activeIssue);
      const existingPlan = this.planGenerator?.resolvePlanFile({
        projectRoot: cwd,
        issue: activeIssue
      });
      if (existingPlan) {
        sm.transition(STAGE_PLAN, { note: `Resumed planning for issue #${activeIssue}` });
      } else {
        sm.transition(STAGE_DISCOVERY, { note: `Initialized discovery for issue #${activeIssue}` });
      }
      await this.stateRepo.save(sm.toSnapshot());
    } else if (isExplicit && sm.issue !== explicitIssue) {
      sm.setIssue(explicitIssue);
      await this.stateRepo.save(sm.toSnapshot());
    }

    activeIssue = sm.issue;
    if (!sm.baseBranch && activeIssue && (this.inferBaseBranchUseCase || this.worktreeManager)) {
      try {
        const inferBranchUseCase =
          this.inferBaseBranchUseCase ??
          new InferBaseBranchUseCase(
            this.worktreeManager!,
            this.githubGateway,
            this.stateRepo
          );
        const inference = await inferBranchUseCase.execute({
          issueNumber: activeIssue,
          workspaceDir: cwd
        });
        if (inference.baseBranch) {
          sm.setBaseBranch(inference.baseBranch);
          await this.stateRepo.save(sm.toSnapshot());
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[agyloop] Diagnostic: Failed to infer base branch for issue #${activeIssue}: ${errMsg}`);
      }
    }

    const worktreePath = sm.worktree?.worktreePath || null;
    const taskBranch = sm.worktree?.branch || null;
    const baseBranch = sm.baseBranch || 'main';

    switch (sm.currentStage) {
      case STAGE_INITIALIZED: {
        return {
          currentStage: STAGE_INITIALIZED,
          nextStage: STAGE_DISCOVERY,
          actionType: 'preflight',
          title: 'Execute Smart Pre-Flight Discovery',
          description: 'Run pre-flight checks to discover issue metadata, check merged/closed status, and resolve base collector branch.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: `Run pre-flight checks: bin/agyloop transition DISCOVERY${activeIssue ? ` --issue ${activeIssue}` : ''}`
        };
      }

      case STAGE_DISCOVERY: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_PLANNER,
          customConfig: config,
          workspaceDir: cwd
        });

        const prompt = this.resolveSubagentUseCase.buildPlanningTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: cwd,
          config
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'research',
              Role: ROLE_TITLE_PLANNER,
              Model: subagent.model,
              Workspace: 'share',
              Prompt: prompt
            }
          ]
        };

        return {
          currentStage: STAGE_DISCOVERY,
          nextStage: STAGE_PLAN,
          actionType: 'subagent',
          role: ROLE_PLANNER,
          title: 'Invoke Planning Architect Subagent',
          description: 'Generate architectural plan and specifications in artifacts/plans/ with physical write suppression.',
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_PLANNER} with Model '${subagent.model}' (read-only tools).`
        };
      }

      case STAGE_PLAN: {
        if (sm.mode === MODE_YOLO) {
          // In YOLO mode, auto-advance to implement
          return this.buildImplementAction(sm, config, cwd);
        }

        return {
          currentStage: STAGE_PLAN,
          nextStage: STAGE_APPROVAL,
          actionType: 'human_gate',
          title: 'Human Approval Gate',
          description: 'Review the technical plan in artifacts/plans/. Seek user confirmation before modifying source code.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: 'Present the plan to the user and wait for approval. Once approved, run "agyloop implement" or "agyloop transition IMPLEMENT".'
        };
      }

      case STAGE_APPROVAL: {
        if (sm.mode === MODE_YOLO) {
          return this.buildImplementAction(sm, config, cwd);
        }

        return {
          currentStage: STAGE_APPROVAL,
          nextStage: STAGE_IMPLEMENT,
          actionType: 'human_gate',
          title: 'Human Approval Gate',
          description: 'Review the technical plan in artifacts/plans/. Seek user confirmation before modifying source code.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: 'Present the plan to the user and wait for approval. Once approved, run "agyloop implement" or "agyloop transition IMPLEMENT".'
        };
      }

      case STAGE_IMPLEMENT: {
        return this.buildImplementAction(sm, config, cwd);
      }

      case STAGE_QUALITY_GATE: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_GATE,
          customConfig: config,
          workspaceDir: cwd
        });

        let commands: string[] | undefined;
        if (this.buildDetector) {
          const resolvedCommands = await this.buildDetector.resolveCommands(worktreePath || cwd, config);
          commands = resolvedCommands.map(c => c.command);
        }

        const prompt = this.resolveSubagentUseCase.buildGateTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: worktreePath || cwd,
          config,
          commands
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_GATE,
              Model: subagent.model,
              Workspace: 'share',
              Prompt: `Execute verification quality gates strictly inside isolated worktree directory:\nCwd: ${worktreePath || cwd}\n\n${prompt}`
            }
          ]
        };

        return {
          currentStage: STAGE_QUALITY_GATE,
          nextStage: STAGE_REVIEW,
          actionType: 'subagent',
          role: ROLE_GATE,
          title: 'Invoke Quality Gate Verifier Subagent',
          description: 'Run automated build, typecheck, lint, and test suites against the isolated worktree changes.',
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_GATE} with Model '${subagent.model}' inside ${worktreePath || cwd}.`
        };
      }

      case STAGE_REVIEW: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_REVIEWER,
          customConfig: config,
          workspaceDir: cwd
        });

        const prompt = this.resolveSubagentUseCase.buildReviewerTaskPrompt({
          issueNumber: activeIssue,
          baseBranch,
          workspaceDir: worktreePath || cwd,
          config
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_REVIEWER,
              Model: subagent.model,
              Workspace: 'share',
              Prompt: `Inspect isolated worktree diff against base '${baseBranch}':\nCwd: ${worktreePath || cwd}\n\n${prompt}`
            }
          ]
        };

        return {
          currentStage: STAGE_REVIEW,
          nextStage: STAGE_COMMIT,
          actionType: 'subagent',
          role: ROLE_REVIEWER,
          title: 'Invoke AI Reviewer Subagent',
          description: 'Run critique analysis and verify Acceptance Criteria fulfillment against the isolated diff.',
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_REVIEWER} with Model '${subagent.model}' against base '${baseBranch}'.`
        };
      }

      case STAGE_COMMIT: {
        return {
          currentStage: STAGE_COMMIT,
          nextStage: STAGE_COMPLETED,
          actionType: 'human_gate',
          title: 'Conventional Commit & Teardown Gate',
          description: 'Review passed. Draft conventional commit, prompt for confirmation, push to remote, and teardown worktree.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: `Execute commit: run "agyloop commit" (targets base branch '${baseBranch}').`
        };
      }

      case STAGE_TRIAGE: {
        return {
          currentStage: STAGE_TRIAGE,
          nextStage: STAGE_IMPLEMENT,
          actionType: 'human_gate',
          title: 'PR Review Comments Triage Gate',
          description: 'Open PR contains review comments requiring human triage before modifying code or resuming pipeline.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: 'PR review comments detected. Run "bin/agyloop triage" to inspect categorized comments and route to IMPLEMENT, PLAN, DISCOVERY, or COMPLETED.'
        };
      }

      case STAGE_COMPLETED:
      default: {
        return {
          currentStage: sm.currentStage,
          nextStage: STAGE_INITIALIZED,
          actionType: 'completed',
          title: 'Pipeline Completed / Idle',
          description: 'No active tasks pending. Ready to initialize next task or milestone.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: 'Pipeline is idle. Run "agyloop <task>" to start a new lifecycle.'
        };
      }
    }
  }

  private buildImplementAction(sm: StateMachine, config: any, cwd: string): NextActionResult {
    const activeIssue = sm.issue;
    const worktreePath = sm.worktree?.worktreePath || null;
    const taskBranch = sm.worktree?.branch || null;
    const baseBranch = sm.baseBranch || 'main';

    const subagent = this.resolveSubagentUseCase.execute({
      role: ROLE_IMPLEMENTER,
      customConfig: config,
      workspaceDir: cwd
    });

    let planContent = '';
    let planPath = '';
    if (this.planGenerator) {
      const resolved = this.planGenerator.resolvePlanFile({
        projectRoot: cwd,
        issue: activeIssue,
        planDir: sm.planDir
      });
      if (resolved) {
        planPath = resolved.planPath;
        try {
          planContent = this.planGenerator.readPlanDocument(resolved.planPath);
        } catch {
          // Non-fatal
        }
      }
    }

    const prompt = this.resolveSubagentUseCase.buildImplementationTaskPrompt({
      planContent,
      planPath: planPath || undefined,
      issueNumber: activeIssue,
      workspaceDir: worktreePath || cwd,
      config
    });

    const invocationPayload: SubagentInvocationPayload = {
      Subagents: [
        {
          TypeName: 'self',
          Role: ROLE_TITLE_IMPLEMENTER,
          Model: subagent.model,
          Workspace: 'share',
          Prompt: `Execute code modifications strictly inside isolated worktree directory:\nCwd: ${worktreePath || cwd}\nBranch: ${taskBranch || '(auto)'}\n\n${prompt}`
        }
      ]
    };

    const nextStage = sm.currentStage === STAGE_IMPLEMENT ? STAGE_QUALITY_GATE : STAGE_IMPLEMENT;

    return {
      currentStage: sm.currentStage,
      nextStage,
      actionType: 'subagent',
      role: ROLE_IMPLEMENTER,
      title: 'Invoke Code Implementer Subagent',
      description: 'Execute surgical code modifications adhering strictly to approved plan in dedicated worktree.',
      baseBranch,
      taskBranch,
      worktreePath,
      invocationPayload,
      humanSummary: `Invoke ${ROLE_TITLE_IMPLEMENTER} with Model '${subagent.model}' targeting worktree ${worktreePath || '.worktrees/' + activeIssue}.`
    };
  }
}
