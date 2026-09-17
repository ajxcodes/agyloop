/**
 * agyloop - InferBaseBranchUseCase (Application Layer)
 *
 * Coordinates dynamic base branch inference and collector branch lifecycle:
 * 1. Discovers candidate branches and checks ancestor merged status.
 * 2. Resolves phase/feature collector branch with label priority and title regex fallback.
 * 3. Enforces in-flight bug routing (fix/* -> active phase/*) vs production hotfix (fix/* -> main).
 * 4. Enforces milestone sealed protection if collector branch is already merged into main.
 * 5. Auto-creates collector branch from main if missing.
 *
 * Strict Hexagonal Architecture: Zero direct I/O, depends only on Domain and Ports.
 */

import {
  BranchInferenceEngine,
  BranchInferenceResult,
  MilestoneSealedError,
  WorktreeCreationError,
  WorktreeDescriptor,
  StateMachine
} from '../domain';
import { WorktreeManagerPort, GitHubGateway, GitHubIssueData, StateRepository } from '../ports';

export interface InferBaseBranchParams {
  readonly issueNumber?: number | string | null;
  readonly title?: string | null;
  readonly labels?: readonly string[];
  readonly explicitBaseBranch?: string | null;
  readonly workspaceDir?: string;
  readonly trackerRepo?: string;
  readonly milestoneTitle?: string | null;
}

export class InferBaseBranchUseCase {
  private readonly worktreeManager: WorktreeManagerPort;
  private readonly githubGateway?: GitHubGateway;
  private readonly stateRepo?: StateRepository;

  constructor(
    worktreeManager: WorktreeManagerPort,
    githubGateway?: GitHubGateway,
    stateRepo?: StateRepository
  ) {
    this.worktreeManager = worktreeManager;
    this.githubGateway = githubGateway;
    this.stateRepo = stateRepo;
  }

  public async execute(params: InferBaseBranchParams = {}): Promise<BranchInferenceResult> {
    const cwd = params.workspaceDir || process.cwd();

    // 1. If explicit base branch is supplied, honor it directly
    if (params.explicitBaseBranch && params.explicitBaseBranch.trim()) {
      const explicit = params.explicitBaseBranch.trim();
      const isCollector = explicit.startsWith('phase/') || explicit.startsWith('feature/');
      const isBug = (params.labels || []).some((l) => l.toLowerCase() === 'bug');
      const prefix = isBug ? 'fix/' : 'task/';
      const issuePart = params.issueNumber ? `${params.issueNumber}-` : '';
      const slug = WorktreeDescriptor.slugify(params.title || 'task');
      const suggested = `${prefix}${issuePart}${slug}`;
      const result: BranchInferenceResult = {
        baseBranch: explicit,
        taskBranchPrefix: prefix,
        branchType: isBug ? 'fix' : 'task',
        suggestedBranch: suggested,
        isPhaseCollector: isCollector,
        isCollectorBranch: isCollector,
        isBug,
        isHotfix: false,
        isMilestoneSealed: false,
        needsCreation: false,
        autoCreatedBaseBranch: false,
        autoCreateFrom: 'main',
        phaseIdentifier: null,
        rationale: `Using explicit base branch '${explicit}'.`
      };

      if (this.stateRepo) {
        try {
          const snapshot = await this.stateRepo.load();
          if (snapshot) {
            const sm = StateMachine.fromSnapshot(snapshot);
            sm.setBaseBranch(explicit);
            if (params.issueNumber) sm.setIssue(params.issueNumber);
            await this.stateRepo.save(sm.toSnapshot());
          }
        } catch {
          // Non-fatal
        }
      }

      return result;
    }

    const defaultBranch = await this.worktreeManager.resolveBaseBranch(cwd);

    // 2. Discover available local and remote branches
    let availableBranches: readonly string[] = [];
    if (this.worktreeManager.listBranches) {
      try {
        availableBranches = await this.worktreeManager.listBranches({ workspaceDir: cwd });
      } catch {
        availableBranches = [];
      }
    }

    // 3. Gather issue metadata (labels, title) from GitHub if issue number is present
    let labels: string[] = params.labels ? [...params.labels] : [];
    let title: string = params.title || '';
    let issueData: GitHubIssueData | null = null;

    if (params.issueNumber && this.githubGateway) {
      const parsedNum = Number(params.issueNumber);
      if (Number.isInteger(parsedNum) && parsedNum > 0) {
        try {
          issueData = await this.githubGateway.fetchIssue(parsedNum, {
            cwd,
            repo: params.trackerRepo
          });
          if (issueData) {
            if (issueData.labels && issueData.labels.length > 0 && labels.length === 0) {
              labels = [...issueData.labels];
            }
            if (issueData.title && !title) {
              title = issueData.title;
            }
          }
        } catch {
          // Network or offline fallback
        }
      }
    }

    // 4. Identify which candidate collector branches have already been merged into main
    const mergedBranches: string[] = [];
    if (this.worktreeManager.isAncestor) {
      for (const branch of availableBranches) {
        if (branch.startsWith('phase/') || branch.startsWith('feature/')) {
          try {
            const isMerged = await this.worktreeManager.isAncestor({
              ancestorBranch: branch,
              descendantBranch: defaultBranch,
              workspaceDir: cwd
            });
            if (isMerged) {
              mergedBranches.push(branch);
            }
          } catch {
            // Non-fatal
          }
        }
      }
    }

    // 5. Evaluate inference via pure domain engine
    const inference = BranchInferenceEngine.infer({
      issueNumber: params.issueNumber,
      issueTitle: title,
      issueLabels: labels,
      milestoneTitle: params.milestoneTitle || issueData?.milestone?.title,
      availableBranches,
      mergedBranches,
      defaultBranch
    });

    // 6. Handle Milestone Sealed Error
    if (inference.isMilestoneSealed) {
      throw new MilestoneSealedError(inference.baseBranch, inference.rationale);
    }

    // 7. Auto-create collector branch if required
    if (inference.needsCreation && this.worktreeManager.createBranch) {
      try {
        await this.worktreeManager.createBranch({
          branchName: inference.baseBranch,
          startPoint: inference.autoCreateFrom,
          workspaceDir: cwd
        });

        // Best-effort remote push for newly auto-created collector branch
        if (this.worktreeManager.pushBranch) {
          try {
            await this.worktreeManager.pushBranch({
              branchName: inference.baseBranch,
              remote: 'origin',
              workspaceDir: cwd
            });
          } catch {
            // Non-fatal if remote is not reachable or offline
          }
        }
      } catch (err: unknown) {
        // If branch already exists (e.g. concurrent creation race condition), proceed safely.
        // For fatal creation errors (e.g. invalid permissions or ref name), bubble up cleanly.
        const errMsg = err instanceof Error ? err.message : String(err);
        const lower = errMsg.toLowerCase();
        const isAlreadyExists =
          lower.includes('already exists') ||
          lower.includes('fatal: a branch named') ||
          lower.includes('already exists in');
        if (!isAlreadyExists) {
          throw new WorktreeCreationError('autoCreateCollectorBranch', errMsg, {
            branchName: inference.baseBranch,
            startPoint: inference.autoCreateFrom
          });
        }
      }
    }

    // 8. Persist inferred base branch in pipeline state checkpoint if stateRepo is available
    if (this.stateRepo) {
      try {
        const snapshot = await this.stateRepo.load();
        if (snapshot) {
          const sm = StateMachine.fromSnapshot(snapshot);
          sm.setBaseBranch(inference.baseBranch);
          if (params.issueNumber) {
            sm.setIssue(params.issueNumber);
          }
          await this.stateRepo.save(sm.toSnapshot());
        }
      } catch {
        // Non-blocking for pure branch inference
      }
    }

    return inference;
  }
}
