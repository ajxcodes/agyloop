/**
 * agyloop - DraftCommitUseCase & ExecuteCommitUseCase Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  StateMachine,
  Stage,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_REVIEW,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  MODE_STANDARD,
  MODE_YOLO,
  CommitMessage,
  InvalidTransitionError,
  CommitExecutionError,
  WorktreeDescriptor
} = require('../../dist/domain');
const {
  DraftCommitUseCase,
  ExecuteCommitUseCase
} = require('../../dist/application');

import type {
  StateRepository,
  CommandExecutorPort,
  CommandExecutionResult,
  GitHubGateway,
  GitHubIssueData,
  PlanGeneratorPort,
  ConfirmationPromptPort,
  ResolvedPlanLocation,
  WorktreeManagerPort
} from '../../src/ports';

class MockStateRepository implements StateRepository {
  public savedSnapshot: any = null;
  public saveCallCount = 0;

  constructor(initialSnapshot: any = null) {
    this.savedSnapshot = initialSnapshot;
  }

  public async load(): Promise<any> {
    return this.savedSnapshot;
  }

  public async save(snapshot: any): Promise<void> {
    this.saveCallCount++;
    this.savedSnapshot = snapshot;
  }

  public async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  public getStateFilePath(): string {
    return '/mock/state.json';
  }
}

class MockCommandExecutor implements CommandExecutorPort {
  public executedCommands: string[] = [];
  public executedOptions: Array<any> = [];
  public responses: Record<string, Partial<CommandExecutionResult>> = {};

  public async execute(command: string, options?: any): Promise<CommandExecutionResult> {
    this.executedCommands.push(command);
    this.executedOptions.push(options);
    const mock = this.responses[command] || {};
    return {
      command,
      exitCode: mock.exitCode !== undefined ? mock.exitCode : 0,
      stdout: mock.stdout !== undefined ? mock.stdout : '',
      stderr: mock.stderr !== undefined ? mock.stderr : '',
      combinedOutput: mock.stdout || '',
      durationMs: 10,
      timedOut: false
    };
  }
}

class MockWorktreeManager implements Partial<WorktreeManagerPort> {
  public removedWorktreeOptions: any = null;

  public async removeWorktree(options: any): Promise<void> {
    this.removedWorktreeOptions = options;
  }
}

class MockGitHubGateway implements GitHubGateway {
  public async getCurrentRepo(): Promise<string | null> {
    return 'ajxcodes/agyloop';
  }

  public async fetchIssue(issueNumber: number, _options?: any): Promise<GitHubIssueData | null> {
    return {
      repo: 'ajxcodes/agyloop',
      number: Number(issueNumber),
      title: '[Task] Phase 4: Implement Interactive Conventional Commit Drafter & Human Approval Gate',
      body: 'Task body details',
      labels: ['enhancement'],
      comments: []
    };
  }
}

class MockPlanGenerator implements Partial<PlanGeneratorPort> {
  public updatedSummary: { path: string; data: any } | null = null;

  public resolvePlanFile(): ResolvedPlanLocation | null {
    return {
      planDir: '/mock/artifacts/plans/30-task',
      planPath: '/mock/artifacts/plans/30-task/implementation-plan.md',
      planFileName: 'implementation-plan.md',
      summaryPath: '/mock/artifacts/plans/30-task/AgyLoop Summary.md'
    };
  }

  public updateSummaryLog(summaryFilePath: string, updateData: any): boolean {
    this.updatedSummary = { path: summaryFilePath, data: updateData };
    return true;
  }
}

class MockConfirmationPrompt implements ConfirmationPromptPort {
  public lastPrompt: string | null = null;
  public answerToReturn: boolean;

  constructor(answer = true) {
    this.answerToReturn = answer;
  }

  public async confirm(message: string): Promise<boolean> {
    this.lastPrompt = message;
    return this.answerToReturn;
  }
}

describe('Commit Application Use Cases', () => {
  describe('DraftCommitUseCase', () => {
    test('throws InvalidTransitionError when pipeline is not at STAGE_COMMIT or STAGE_REVIEW', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_IMPLEMENT) });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const gateway = new MockGitHubGateway();

      const useCase = new DraftCommitUseCase(stateRepo, executor, gateway);
      await assert.rejects(
        () => useCase.execute(),
        (err: any) => err instanceof InvalidTransitionError
      );
    });

    test('drafts conventional commit message using diff and active issue context', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), issue: null });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git diff HEAD'] = {
        stdout: `diff --git a/src/domain/value-objects/commit-message.ts b/src/domain/value-objects/commit-message.ts
new file mode 100644
+++ b/src/domain/value-objects/commit-message.ts
@@ -0,0 +10,1 @@
+export class CommitMessage {}`
      };

      const gateway = new MockGitHubGateway();
      const useCase = new DraftCommitUseCase(stateRepo, executor, gateway);

      const result = await useCase.execute();

      assert.strictEqual(result.commitMessage.type, 'feat');
      assert.strictEqual(result.commitMessage.scope, 'commit');
      assert.strictEqual(result.commitMessage.issueNumber, 30);
      assert.ok(result.commitMessage.description.includes('implement Interactive Conventional Commit Drafter'));
      assert.strictEqual(
        result.commitMessage.toSingleLine(),
        'feat(commit): implement Interactive Conventional Commit Drafter & Human Approval Gate (#30)'
      );
    });

    test('accepts user message override', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const gateway = new MockGitHubGateway();
      const useCase = new DraftCommitUseCase(stateRepo, executor, gateway);

      const result = await useCase.execute({
        workingDiff: 'diff --git a/file.ts b/file.ts',
        userMessage: 'refactor(core): overhaul lifecycle transitions (#30)'
      });

      assert.strictEqual(result.commitMessage.type, 'refactor');
      assert.strictEqual(result.commitMessage.scope, 'core');
      assert.strictEqual(result.commitMessage.toSingleLine(), 'refactor(core): overhaul lifecycle transitions (#30)');
    });

    test('evaluates git commands in worktree directory when sm.worktree is configured', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 48,
        worktreePath: '/mock/repo/.worktrees/48',
        branch: 'fix/48',
        baseBranch: 'main'
      });
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: wt });
      sm.setIssue(48);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git diff HEAD'] = {
        stdout: `diff --git a/file.ts b/file.ts\n+++ b/file.ts\n@@ -0,0 +1 @@\n+test`
      };
      const gateway = new MockGitHubGateway();
      const useCase = new DraftCommitUseCase(stateRepo, executor, gateway);

      await useCase.execute({ workspaceDir: '/mock/repo' });

      assert.ok(executor.executedCommands.includes('git diff HEAD'));
      assert.strictEqual(executor.executedOptions[0]?.cwd, '/mock/repo/.worktrees/48');
    });
  });

  describe('ExecuteCommitUseCase', () => {
    test('throws InvalidTransitionError when not at STAGE_COMMIT', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_IMPLEMENT) });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const useCase = new ExecuteCommitUseCase(stateRepo, executor);

      await assert.rejects(
        () => useCase.execute({ confirmed: true }),
        (err: any) => err instanceof InvalidTransitionError
      );
    });

    test('enforces human confirmation gate and throws if neither confirmed nor prompter available', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const useCase = new ExecuteCommitUseCase(stateRepo, executor);

      const commitMsg = CommitMessage.create({ type: 'feat', description: 'test feature' });

      await assert.rejects(
        () => useCase.execute({ commitMessage: commitMsg }),
        (err: any) => err instanceof CommitExecutionError && err.message.includes('Human confirmation gate')
      );
    });

    test('prompts user and returns cancelled result if user declines confirmation', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const prompter = new MockConfirmationPrompt(false); // User answers 'no'
      const useCase = new ExecuteCommitUseCase(stateRepo, executor, undefined, prompter);

      const commitMsg = CommitMessage.create({ type: 'feat', description: 'test feature' });
      const result = await useCase.execute({ commitMessage: commitMsg });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.confirmed, false);
      assert.strictEqual(result.commitHash, null);
      assert.strictEqual(result.currentStage, STAGE_COMMIT); // Unchanged
    });

    test('executes git commit, advances state, updates summary, and checkpoints on user confirmation', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "feat(scope): test feature (#30)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'a1b2c3d4e5f6\n' };

      const prompter = new MockConfirmationPrompt(true);
      const planGen = new MockPlanGenerator();

      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        planGen as unknown as PlanGeneratorPort,
        prompter
      );

      const commitMsg = CommitMessage.create({
        type: 'feat',
        scope: 'scope',
        description: 'test feature',
        issueNumber: 30
      });

      const result = await useCase.execute({ commitMessage: commitMsg });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.confirmed, true);
      assert.strictEqual(result.commitHash, 'a1b2c3d4e5f6');
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);

      // Verify state saved
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_COMPLETED);

      // Verify summary log updated
      assert.ok(planGen.updatedSummary);
      assert.strictEqual(planGen.updatedSummary!.data.commitHash, 'a1b2c3d4e5f6');
      assert.strictEqual(planGen.updatedSummary!.data.commitMessage, 'feat(scope): test feature (#30)');
    });

    test('auto-approves in YOLO mode without interactive prompt', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), mode: MODE_YOLO });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts' };
      executor.responses['git rev-parse HEAD'] = { stdout: 'yolo1234\n' };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({ type: 'chore', description: 'yolo commit' });

      const result = await useCase.execute({ commitMessage: commitMsg });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commitHash, 'yolo1234');
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);
    });

    test('handles dryRun mode without executing git commit or disk mutation', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const useCase = new ExecuteCommitUseCase(stateRepo, executor);

      const commitMsg = CommitMessage.create({ type: 'fix', description: 'dry run test' });
      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        dryRun: true
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commitHash, 'dry-run-simulated-commit-hash');
      assert.strictEqual(executor.executedCommands.length, 0); // No git commands run
      assert.strictEqual(stateRepo.saveCallCount, 0); // No state saved in dryRun
    });

    test('handles dryRun mode without explicit confirmation or prompting', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const prompter = new MockConfirmationPrompt(false);
      const useCase = new ExecuteCommitUseCase(stateRepo, executor, undefined, prompter);

      const commitMsg = CommitMessage.create({ type: 'fix', description: 'dry run without confirm' });
      const result = await useCase.execute({
        commitMessage: commitMsg,
        dryRun: true
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.confirmed, true);
      assert.strictEqual(result.commitHash, 'dry-run-simulated-commit-hash');
      assert.strictEqual(prompter.lastPrompt, null); // Prompt never called
      assert.strictEqual(executor.executedCommands.length, 0);
      assert.strictEqual(stateRepo.saveCallCount, 0);
    });

    test('handles human rejection by routing to IMPLEMENT and updating summary log', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const planGen = new MockPlanGenerator();
      const prompter = new MockConfirmationPrompt(false);

      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        planGen as unknown as PlanGeneratorPort,
        prompter
      );

      const commitMsg = CommitMessage.create({
        type: 'feat',
        description: 'rejected commit',
        issueNumber: 30
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: false,
        rejectionReason: 'Code needs more edge case handling'
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.confirmed, false);
      assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_IMPLEMENT);

      assert.ok(planGen.updatedSummary);
      assert.strictEqual(planGen.updatedSummary!.data.commitRejection?.targetStage, STAGE_IMPLEMENT);
      assert.strictEqual(planGen.updatedSummary!.data.commitRejection?.reason, 'Code needs more edge case handling');
    });

    test('handles human rejection by routing to PLAN when redesign is required', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const planGen = new MockPlanGenerator();

      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        planGen as unknown as PlanGeneratorPort
      );

      const commitMsg = CommitMessage.create({
        type: 'feat',
        description: 'rejected commit for redesign',
        issueNumber: 30
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: false,
        rejectionTarget: 'PLAN',
        rejectionReason: 'Architecture requires redesign'
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.confirmed, false);
      assert.strictEqual(result.currentStage, STAGE_PLAN);
      assert.strictEqual(stateRepo.savedSnapshot.currentStage, STAGE_PLAN);

      assert.ok(planGen.updatedSummary);
      assert.strictEqual(planGen.updatedSummary!.data.commitRejection?.targetStage, STAGE_PLAN);
      assert.strictEqual(planGen.updatedSummary!.data.commitRejection?.reason, 'Architecture requires redesign');
    });

    test('evaluates git commands in worktree directory and worktree removal in rootWorkspaceDir when sm.worktree is configured', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 48,
        worktreePath: '/mock/repo/.worktrees/48',
        branch: 'fix/48',
        baseBranch: 'main'
      });
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: wt });
      sm.setIssue(48);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix(worktree): test commit (#48)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'feedbeef1234\n' };

      const worktreeManager = new MockWorktreeManager();
      const planGen = new MockPlanGenerator();

      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        planGen as unknown as PlanGeneratorPort,
        undefined,
        worktreeManager as unknown as WorktreeManagerPort
      );

      const commitMsg = CommitMessage.create({
        type: 'fix',
        scope: 'worktree',
        description: 'test commit',
        issueNumber: 48
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo',
        rootWorkspaceDir: '/mock/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.worktreeTornDown, true);

      // Verify all git commands ran inside the worktree directory
      assert.ok(executor.executedOptions.length > 0);
      for (const opt of executor.executedOptions) {
        assert.strictEqual(opt?.cwd, '/mock/repo/.worktrees/48');
      }

      // Verify worktree removal was performed using rootWorkspaceDir
      assert.ok(worktreeManager.removedWorktreeOptions);
      assert.strictEqual(worktreeManager.removedWorktreeOptions.workspaceDir, '/mock/repo');
      assert.strictEqual(worktreeManager.removedWorktreeOptions.worktreePath, '/mock/repo/.worktrees/48');
    });
  });
});
