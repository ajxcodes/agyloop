/**
 * agyloop - DraftCommitUseCase & ExecuteCommitUseCase Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  StateMachine,
  Stage,
  GATE_COMMIT,
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
  WorktreeDescriptor,
  COMMIT_EXCLUDED_PATHSPECS
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
  public cleanOrphanedCalls: any[] = [];

  public async removeWorktree(options: any): Promise<void> {
    this.removedWorktreeOptions = options;
  }

  public async cleanOrphanedWorktrees(options?: any): Promise<number> {
    this.cleanOrphanedCalls.push(options);
    return 1;
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
  const mockWorktree = WorktreeDescriptor.create({
    taskId: 999,
    worktreePath: '/mock/repo/.worktrees/999',
    branch: 'fix/999',
    baseBranch: 'main'
  });

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
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), issue: null, worktree: mockWorktree });
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
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
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

    test('lists untracked files alongside the tracked diff (issue #240/Defect 2)', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), issue: null, worktree: mockWorktree });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git diff HEAD'] = {
        stdout: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -0,0 +1 @@
+export const app = 1;`
      };
      executor.responses['git status --porcelain -uall'] = {
        stdout: '?? tests/new.test.ts\n M src/app.ts\n'
      };

      const useCase = new DraftCommitUseCase(stateRepo, executor, new MockGitHubGateway());
      const result = await useCase.execute();

      assert.deepStrictEqual([...result.untrackedFiles], ['tests/new.test.ts']);
      assert.strictEqual(result.listedFiles.length, 2);
      assert.ok(result.listedFiles.includes('src/app.ts'));
      assert.ok(result.listedFiles.includes('tests/new.test.ts'));
      assert.strictEqual(
        result.listedFiles.filter((f: string) => f === 'src/app.ts').length,
        1,
        'a tracked file must not be duplicated by the untracked union'
      );
    });

    test('N-16 / AC-9: the draft never lists the excluded trees, only the real change', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), issue: null, worktree: mockWorktree });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain -uall'] = {
        stdout: '?? .agyloop\n?? artifacts\n?? feature.txt\n'
      };

      const useCase = new DraftCommitUseCase(stateRepo, executor, new MockGitHubGateway());
      const result = await useCase.execute();

      assert.deepStrictEqual([...result.listedFiles], ['feature.txt']);
      assert.deepStrictEqual([...result.untrackedFiles], ['feature.txt']);
      assert.ok(result.excludedFiles.includes('.agyloop'));
      assert.ok(result.excludedFiles.includes('artifacts'));
    });

    test('N-17 / AC-9: a tracked bookkeeping path is never listed (git rm --cached untracks it)', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), issue: null, worktree: mockWorktree });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git diff HEAD'] = {
        stdout: `diff --git a/.agyloop/state.json b/.agyloop/state.json
new file mode 100644
--- /dev/null
+++ b/.agyloop/state.json
@@ -0,0 +1 @@
+{}
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -0,0 +1 @@
+export const app = 1;`
      };

      const useCase = new DraftCommitUseCase(stateRepo, executor, new MockGitHubGateway());
      const result = await useCase.execute();

      assert.ok(result.listedFiles.includes('src/app.ts'));
      assert.ok(
        !result.listedFiles.includes('.agyloop/state.json'),
        `excluded tracked paths must never be listed: ${JSON.stringify(result.listedFiles)}`
      );
      assert.ok(result.excludedFiles.includes('.agyloop/state.json'));
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
      const sm = new StateMachine({ stage: new Stage(STAGE_IMPLEMENT), worktree: mockWorktree });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const useCase = new ExecuteCommitUseCase(stateRepo, executor);

      await assert.rejects(
        () => useCase.execute({ confirmed: true }),
        (err: any) => err instanceof InvalidTransitionError
      );
    });

    test('enforces human confirmation gate and throws if neither confirmed nor prompter available', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
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
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
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

    // --- Zero-Hang Invariant (issue #218 / AC6) ---------------------------

    test('skips the commit confirmation prompt when interactive is false', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const prompter = new MockConfirmationPrompt(true); // Would answer "yes"
      const useCase = new ExecuteCommitUseCase(stateRepo, executor, undefined, prompter);

      const commitMsg = CommitMessage.create({ type: 'feat', description: 'test feature' });
      const result = await useCase.execute({ commitMessage: commitMsg, interactive: false });

      assert.strictEqual(prompter.lastPrompt, null, 'prompt must never be opened');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.confirmed, false);
      assert.strictEqual(result.currentStage, STAGE_COMMIT); // Unchanged
    });

    test('skips the worktree teardown prompt when interactive is false', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      const worktreeManager = new MockWorktreeManager();
      const prompter = new MockConfirmationPrompt(true); // Would answer "yes" to both prompts
      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        undefined,
        prompter,
        worktreeManager as unknown as WorktreeManagerPort
      );

      const commitMsg = CommitMessage.create({ type: 'feat', description: 'test feature' });
      const result = await useCase.execute({ commitMessage: commitMsg, interactive: false });

      assert.strictEqual(prompter.lastPrompt, null, 'no prompt (commit or teardown) may be opened');
      assert.ok(!result.worktreeTornDown);
      assert.strictEqual(worktreeManager.removedWorktreeOptions, null);
    });

    test('still prompts for worktree teardown when interactive is not specified', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "feat(teardown): test commit"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'b1b2b3b4b5b6\n' };

      const worktreeManager = new MockWorktreeManager();
      const prompts: string[] = [];
      const prompter: ConfirmationPromptPort = {
        async confirm(message: string): Promise<boolean> {
          prompts.push(message);
          return true;
        }
      };

      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        undefined,
        prompter,
        worktreeManager as unknown as WorktreeManagerPort
      );

      const commitMsg = CommitMessage.create({ type: 'feat', description: 'test commit' });
      const result = await useCase.execute({ commitMessage: commitMsg });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.worktreeTornDown, true);
      assert.strictEqual(prompts.length, 2, 'commit gate then teardown gate');
      // Issue #247 (S7): the teardown prompt names the worktree without
      // claiming isolation up front — the descriptor decides that, not the copy.
      assert.ok(prompts[1].includes('Teardown git worktree at'));
      assert.strictEqual(prompts[1].includes('isolated'), false);
    });

    test('executes git commit, advances state, updates summary, and checkpoints on user confirmation', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
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
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), mode: MODE_YOLO, worktree: mockWorktree });
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
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
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
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
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
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
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
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
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

    test('N-18 / AC-9: a tree containing only excluded paths fails honestly, before git add', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
      sm.setIssue(32);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: '?? .agyloop\n?? artifacts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };

      const prompter = new MockConfirmationPrompt(true);
      const useCase = new ExecuteCommitUseCase(stateRepo, executor, undefined, prompter);
      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'only bookkeeping paths',
        issueNumber: 32
      });

      await assert.rejects(
        () => useCase.execute({ commitMessage: commitMsg }),
        (err: any) => {
          assert.ok(err instanceof CommitExecutionError);
          assert.strictEqual(err.operation, 'git status');
          assert.match(err.message, /only paths agyloop excludes/);
          assert.match(err.message, /\.agyloop/);
          return true;
        }
      );
      assert.ok(
        !executor.executedCommands.includes('git add -A'),
        'the honest refusal must precede staging'
      );
    });

    test('executes defensive git rm --cached with --ignore-unmatch after git add -A to untrack symlinks', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
      sm.setIssue(30);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "feat(scope): defensive untrack test (#30)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'deadbeef1234\n' };

      const prompter = new MockConfirmationPrompt(true);
      const useCase = new ExecuteCommitUseCase(stateRepo, executor, undefined, prompter);

      const commitMsg = CommitMessage.create({
        type: 'feat',
        scope: 'scope',
        description: 'defensive untrack test',
        issueNumber: 30
      });

      await useCase.execute({ commitMessage: commitMsg });

      assert.ok(executor.executedCommands.includes('git add -A'));

      // The guard must run after git add -A (otherwise it untracks nothing).
      const addIdx = executor.executedCommands.indexOf('git add -A');
      const rmCallIdx = executor.executedCommands.findIndex(
        (cmd, i) =>
          cmd === 'git' &&
          Array.isArray(executor.executedOptions[i]?.args) &&
          executor.executedOptions[i].args[0] === 'rm'
      );
      assert.ok(rmCallIdx !== -1, 'git rm --cached should have been executed via argv');
      assert.ok(rmCallIdx > addIdx, 'git rm --cached should run after git add -A');

      // Regression guard (#102): without --ignore-unmatch, `git rm --cached` aborts with
      // "fatal: pathspec 'node_modules' did not match any files" on the FIRST untracked
      // pathspec, leaving .agyloop staged. Asserted on the argv, not the command string,
      // because the old implementation drove git through a shell string.
      const rmArgs = executor.executedOptions[rmCallIdx].args;
      assert.deepStrictEqual(
        rmArgs,
        ['rm', '--cached', '-rf', '--ignore-unmatch', '.agyloop', 'node_modules', 'artifacts'],
        'untrack guard must pass --ignore-unmatch so unmatched pathspecs cannot abort it'
      );
      // Issue #301: the argv is built from the ONE shared constant, so the draft
      // list and the commit can never exclude different trees.
      assert.deepStrictEqual(rmArgs.slice(4), [...COMMIT_EXCLUDED_PATHSPECS]);

      // The old guard appended `|| true`, which turned the fatal into a silent success.
      assert.ok(
        !executor.executedOptions[rmCallIdx].args.includes('||'),
        'untrack guard must not rely on a shell `|| true` escape'
      );
    });

    test('fails closed when the defensive untrack guard exits non-zero', async () => {
      // Guards the other half of #102: the old command swallowed every failure via `|| true`,
      // so a real error (locked index, permission denied) let the commit proceed and publish
      // the .agyloop symlink anyway. The guard must abort the commit instead.
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
      sm.setIssue(31);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git'] = {
        exitCode: 128,
        stderr: "fatal: Unable to create '.git/index.lock': File exists."
      };

      const prompter = new MockConfirmationPrompt(true);
      const useCase = new ExecuteCommitUseCase(stateRepo, executor, undefined, prompter);

      const commitMsg = CommitMessage.create({
        type: 'feat',
        scope: 'scope',
        description: 'untrack guard failure test',
        issueNumber: 31
      });

      await assert.rejects(
        () => useCase.execute({ commitMessage: commitMsg }),
        (err: any) => {
          assert.ok(err instanceof CommitExecutionError);
          assert.strictEqual(err.operation, 'git rm --cached');
          return true;
        }
      );

      // Must never reach the commit.
      assert.ok(
        !executor.executedCommands.includes(
          'git commit -m "feat(scope): untrack guard failure test (#31)"'
        ),
        'commit must not proceed after the untrack guard fails'
      );
    });

    test('pushes active task branch to remote on successful commit', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 88,
        worktreePath: '/mock/repo/.worktrees/88',
        branch: 'fix/88',
        baseBranch: 'main'
      });
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: wt });
      sm.setIssue(88);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: push task branch (#88)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit1234\n' };
      executor.responses['git push -u origin "fix/88"'] = { exitCode: 0 };

      const worktreeManager = new MockWorktreeManager();
      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        undefined,
        undefined,
        worktreeManager as unknown as WorktreeManagerPort
      );

      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'push task branch',
        issueNumber: 88
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo',
        rootWorkspaceDir: '/mock/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.worktreeTornDown, true);
      assert.strictEqual(result.pushError, undefined);
      assert.strictEqual(result.fallbackUsed, false);
      assert.ok(executor.executedCommands.includes('git push -u origin "fix/88"'));
    });

    test('attempts HTTPS fallback push with gh auth token when standard push fails', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 88,
        worktreePath: '/mock/repo/.worktrees/88',
        branch: 'fix/88',
        baseBranch: 'main'
      });
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: wt });
      sm.setIssue(88);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: fallback push (#88)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit1234\n' };
      executor.responses['git push -u origin "fix/88"'] = {
        exitCode: 1,
        stderr: 'Permission denied (publickey).'
      };
      executor.responses['gh auth token'] = {
        exitCode: 0,
        stdout: 'ghp_secret_token_1234\n'
      };

      const fallbackCmd =
        `git -c url."https://x-access-token:ghp_secret_token_1234@github.com/".insteadOf="git@github.com:" ` +
        `-c url."https://x-access-token:ghp_secret_token_1234@github.com/".insteadOf="https://github.com/" ` +
        `push -u origin "fix/88"`;
      executor.responses[fallbackCmd] = { exitCode: 0 };

      const worktreeManager = new MockWorktreeManager();
      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        undefined,
        undefined,
        worktreeManager as unknown as WorktreeManagerPort
      );

      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'fallback push',
        issueNumber: 88
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo',
        rootWorkspaceDir: '/mock/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.fallbackUsed, true);
      assert.strictEqual(result.pushError, undefined);
      assert.strictEqual(result.worktreeTornDown, true);
      assert.ok(executor.executedCommands.includes(fallbackCmd));
    });

    test('preserves worktree when standard push and fallback push fail', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 88,
        worktreePath: '/mock/repo/.worktrees/88',
        branch: 'fix/88',
        baseBranch: 'main'
      });
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: wt });
      sm.setIssue(88);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: failed push (#88)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit1234\n' };
      executor.responses['git push -u origin "fix/88"'] = {
        exitCode: 1,
        stderr: 'Permission denied (publickey).'
      };
      executor.responses['gh auth token'] = {
        exitCode: 0,
        stdout: 'ghp_secret_token_1234\n'
      };

      const fallbackCmd =
        `git -c url."https://x-access-token:ghp_secret_token_1234@github.com/".insteadOf="git@github.com:" ` +
        `-c url."https://x-access-token:ghp_secret_token_1234@github.com/".insteadOf="https://github.com/" ` +
        `push -u origin "fix/88"`;
      executor.responses[fallbackCmd] = {
        exitCode: 1,
        stderr: 'fatal: Authentication failed'
      };

      const worktreeManager = new MockWorktreeManager();
      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        undefined,
        undefined,
        worktreeManager as unknown as WorktreeManagerPort
      );

      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'failed push',
        issueNumber: 88
      });

      await assert.rejects(
        () => useCase.execute({
          commitMessage: commitMsg,
          confirmed: true,
          workspaceDir: '/mock/repo',
          rootWorkspaceDir: '/mock/repo'
        }),
        (err: any) => err.message.includes('fatal: Authentication failed')
      );
      assert.strictEqual(worktreeManager.removedWorktreeOptions, null);
    });

    // Issue #301 (absorbing #307): `worktree: null` is a LEGAL root-scoped run.
    // The gate must commit the workspace it was pointed at, not refuse.
    test('N-14: commits from the workspace root when the checkpoint has no worktree', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT) }); // no worktree
      sm.setIssue(88);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M feature.txt\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: root commit test (#88)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'rootcommit\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'main\n' };
      executor.responses['git push -u origin "main"'] = { exitCode: 0 };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'root commit test',
        issueNumber: 88
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commitCwd, '/repo');
      assert.strictEqual(result.worktreeMode, 'root');
      const statusIndex = executor.executedCommands.indexOf('git status --porcelain');
      assert.ok(statusIndex >= 0, 'git status must run');
      assert.strictEqual(executor.executedOptions[statusIndex].cwd, '/repo');
    });

    test('N-15: commits inside the isolated worktree when the descriptor is present', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
      sm.setIssue(89);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M feature.txt\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: isolated commit test (#89)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'wtcommit\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/89\n' };
      executor.responses['git push -u origin "task/89"'] = { exitCode: 0 };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'isolated commit test',
        issueNumber: 89
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commitCwd, mockWorktree.worktreePath);
      assert.strictEqual(result.worktreeMode, 'isolated');
      const statusIndex = executor.executedCommands.indexOf('git status --porcelain');
      assert.strictEqual(executor.executedOptions[statusIndex].cwd, mockWorktree.worktreePath);
    });

    test('invokes cleanOrphanedWorktrees with subagents: true after commit completion', async () => {
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree });
      sm.setIssue(90);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: clean subagents (#90)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit90\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'fix/90\n' };
      executor.responses['git push -u origin "fix/90"'] = { exitCode: 0 };

      const worktreeManager = new MockWorktreeManager();
      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        executor,
        undefined,
        undefined,
        worktreeManager as unknown as WorktreeManagerPort
      );

      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'clean subagents',
        issueNumber: 90
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo',
        rootWorkspaceDir: '/mock/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(worktreeManager.cleanOrphanedCalls.length, 1);
      assert.strictEqual(worktreeManager.cleanOrphanedCalls[0].subagents, true);
      assert.strictEqual(worktreeManager.cleanOrphanedCalls[0].workspaceDir, '/mock/repo');
    });

    test('executes pr command when createPr is true', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 91,
        worktreePath: '/mock/repo/.worktrees/91',
        branch: 'task/91',
        baseBranch: 'main'
      });
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: wt });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: auto pr (#91)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit91\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/91\n' };
      executor.responses['git push -u origin "task/91"'] = { exitCode: 0 };
      executor.responses["gh pr list --head 'task/91' --json number"] = { exitCode: 0, stdout: '[]' };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'auto pr',
        issueNumber: 91
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        createPr: true
      });

      assert.strictEqual(result.success, true);
      assert.ok(executor.executedCommands.some(cmd => cmd.includes('gh pr create')));
    });

    test('reports the created PR URL and suppresses the manual script (issue #240/Defect 1)', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 92,
        worktreePath: '/mock/repo/.worktrees/92',
        branch: 'task/92',
        baseBranch: 'phase/6-codeloop'
      });
      const sm = new StateMachine({
        stage: new Stage(STAGE_COMMIT),
        worktree: wt,
        baseBranch: 'phase/6-codeloop'
      });
      sm.setIssue(92);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: auto pr (#92)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit92\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/92\n' };
      executor.responses['git push -u origin "task/92"'] = { exitCode: 0 };
      executor.responses["gh pr list --head 'task/92' --json number"] = { exitCode: 0, stdout: '[]' };
      executor.responses["gh pr view 'task/92' --json url --jq .url"] = {
        exitCode: 0,
        stdout: 'https://example.test/pull/7\n'
      };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const result = await useCase.execute({
        commitMessage: CommitMessage.create({ type: 'fix', description: 'auto pr', issueNumber: 92 }),
        confirmed: true,
        createPr: true
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.prCreated, true);
      assert.strictEqual(result.prUrl, 'https://example.test/pull/7');
      assert.strictEqual(result.prCommand, undefined, 'a created PR must not print the manual script');
      assert.strictEqual(result.prBaseIsCollector, true);
      // Issue #351: the value the CLI's collector caveat keys on is the SAME
      // issue the body's `Closes #N` names — here from the checkpoint, since
      // `params.issue` is absent.
      assert.strictEqual(result.resolvedIssue, 92);
      assert.ok(executor.executedCommands.some((cmd: string) => cmd.includes('gh pr create')));
    });

    test('a PR that was NOT created still returns the manual command', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 93,
        worktreePath: '/mock/repo/.worktrees/93',
        branch: 'task/93',
        baseBranch: 'main'
      });
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: wt });
      sm.setIssue(93);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: manual (#93)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit93\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/93\n' };
      executor.responses['git push -u origin "task/93"'] = { exitCode: 0 };
      executor.responses["gh pr list --head 'task/93' --json number"] = { exitCode: 0, stdout: '[]' };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const result = await useCase.execute({
        commitMessage: CommitMessage.create({ type: 'fix', description: 'manual', issueNumber: 93 }),
        confirmed: true
      });

      assert.strictEqual(result.prCreated, false);
      assert.strictEqual(result.prExists, false);
      assert.strictEqual(typeof result.prCommand, 'string');
      assert.ok((result.prCommand as string).includes('gh pr create'));
      assert.strictEqual(result.prBaseIsCollector, false);
      // Issue #351: even when no PR is created, the result names the issue the
      // body WOULD close — the CLI caveat must describe the same operand.
      assert.strictEqual(result.resolvedIssue, 93);
      assert.ok(!executor.executedCommands.some((cmd: string) => cmd.includes('gh pr create')));
    });

    test('an ALREADY EXISTING PR is reported as existing, not created', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 94,
        worktreePath: '/mock/repo/.worktrees/94',
        branch: 'task/94',
        baseBranch: 'main'
      });
      const sm = new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: wt });
      sm.setIssue(94);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: existing (#94)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit94\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/94\n' };
      executor.responses['git push -u origin "task/94"'] = { exitCode: 0 };
      executor.responses["gh pr list --head 'task/94' --json number"] = {
        exitCode: 0,
        stdout: '[{"number": 5}]'
      };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const result = await useCase.execute({
        commitMessage: CommitMessage.create({ type: 'fix', description: 'existing', issueNumber: 94 }),
        confirmed: true,
        createPr: true
      });

      assert.strictEqual(result.prExists, true);
      assert.strictEqual(result.prCreated, false);
      assert.ok(!executor.executedCommands.some((cmd: string) => cmd.includes('gh pr create')));
    });

    test('generates prCommand with title, body with Closes #id, and --milestone from sm.milestoneTitle', async () => {
      const wt = WorktreeDescriptor.create({
        taskId: 62,
        worktreePath: '/mock/repo/.worktrees/62',
        branch: 'task/62',
        baseBranch: 'phase/v0.6.0'
      });
      const sm = new StateMachine({
        stage: new Stage(STAGE_COMMIT),
        worktree: wt,
        baseBranch: 'phase/v0.6.0',
        milestoneTitle: 'v0.6.0'
      });
      sm.setIssue(62);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "feat(pr): automated milestone linking (#62)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit62hash\n' };
      executor.responses['git push -u origin "task/62"'] = { exitCode: 0 };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({
        type: 'feat',
        scope: 'pr',
        description: 'automated milestone linking',
        issueNumber: 62
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.prCommand,
        'gh pr create --base \'phase/v0.6.0\' --head \'task/62\' --title \'feat(pr): automated milestone linking (#62)\' --body \'Closes #62\' --milestone \'v0.6.0\''
      );
      // Issue #315 (AC-23): one copy-pasteable line — no stash wrapper, no
      // conditional shell the operator has to read before pasting.
      assert.ok(!result.prCommand!.includes('git stash'), result.prCommand);
      assert.ok(!result.prCommand!.includes('if !'), result.prCommand);
    });

    test('generates prCommand with description and Closes #id in body when commit has body, and honors milestoneTitle param override', async () => {
      const wt = WorktreeDescriptor.create({ taskId: 62, worktreePath: '/mock/repo/.worktrees/62', branch: 'task/62-override', baseBranch: 'main' });
      const sm = new StateMachine({
        stage: new Stage(STAGE_COMMIT),
        baseBranch: 'main',
        worktree: wt
      });
      sm.setIssue(62);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "feat: commit with body (#62)\\n\\nDetailed feature description."'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit62hash2\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'task/62-override\n' };
      executor.responses['git push -u origin "task/62-override"'] = { exitCode: 0 };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({
        type: 'feat',
        description: 'commit with body',
        body: 'Detailed feature description.',
        issueNumber: 62
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo',
        milestoneTitle: 'v0.7.0'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.prCommand,
        'gh pr create --base \'main\' --head \'task/62-override\' --title \'feat: commit with body (#62)\' --body \'Detailed feature description.\n\nCloses #62\' --milestone \'v0.7.0\''
      );
    });

    test('generates prCommand without title, body, or milestone when no issue is present', async () => {
      const wt = WorktreeDescriptor.create({ taskId: 999, worktreePath: '/mock/repo/.worktrees/999', branch: 'chore/cleanup', baseBranch: 'main' });
      const sm = new StateMachine({
        stage: new Stage(STAGE_COMMIT),
        baseBranch: 'main',
        worktree: wt
      });
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "chore: ad-hoc task"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commitchore\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'chore/cleanup\n' };
      executor.responses['git push -u origin "chore/cleanup"'] = { exitCode: 0 };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({
        type: 'chore',
        description: 'ad-hoc task'
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.prCommand,
        'gh pr create --base \'main\' --head \'chore/cleanup\' --title \'chore: ad-hoc task\' --body \'Closes #999\''
      );
    });

    test('skips PR creation and suggests viewing if PR already exists', async () => {
      const wt = WorktreeDescriptor.create({ taskId: 170, worktreePath: '/mock/repo/.worktrees/170', branch: 'fix/170', baseBranch: 'main' });
      const sm = new StateMachine({
        stage: new Stage(STAGE_COMMIT),
        baseBranch: 'main',
        worktree: wt
      });
      sm.setIssue(170);
      const stateRepo = new MockStateRepository(sm.toSnapshot());
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git commit -m "fix: skip pr create (#170)"'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'commit170\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'fix/170\n' };
      executor.responses['git push -u origin "fix/170"'] = { exitCode: 0 };
      executor.responses['gh pr list --head \'fix/170\' --json number'] = { exitCode: 0, stdout: '[{"number":170}]\n' };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({
        type: 'fix',
        description: 'skip pr create',
        issueNumber: 170
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        confirmed: true,
        workspaceDir: '/mock/repo'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.prCommand,
        'echo "PR already exists for branch \'fix/170\'."; gh pr view'
      );
    });

    // --- #226: COMMIT -> COMPLETED must not strand the inherited pause -------
    //
    // End-to-end through the real defect path. `ExecuteCommitUseCase` calls
    // `sm.transition(STAGE_COMPLETED)`, and before #226 that persisted
    // `{ currentStage: COMPLETED, pausedAtGate: COMMIT }` — a finished pipeline
    // that also claimed to be waiting on a human, with no way to clear it.

    test('COMMIT -> COMPLETED persists a checkpoint with no stale COMMIT pause (#226)', async () => {
      const pausedAt = new Date(Date.now() - 5000).toISOString();
      // Seed through the snapshot: `pauseAtGate()` always stamps "now".
      const sm = StateMachine.fromSnapshot({
        ...new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree }).toSnapshot(),
        pausedAtGate: GATE_COMMIT,
        pausedAtTimestamp: pausedAt
      });
      const stateRepo = new MockStateRepository(sm);
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'deadbee\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'fix/999\n' };

      const useCase = new ExecuteCommitUseCase(stateRepo, executor);
      const commitMsg = CommitMessage.create({ type: 'fix', description: 'terminal pause' });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        bypassConfirmation: true,
        interactive: false
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);

      const saved = stateRepo.savedSnapshot;
      assert.strictEqual(saved.currentStage, STAGE_COMPLETED);
      assert.strictEqual(
        saved.pausedAtGate,
        null,
        'a COMPLETED checkpoint must never advertise a pending human gate'
      );
      assert.strictEqual(saved.pausedAtTimestamp, null);
      assert.ok(
        saved.totalHumanWaitMs >= 4000,
        `expected the inherited ~5s human wait to be banked, got ${saved.totalHumanWaitMs}`
      );

      const roundTripped = JSON.parse(JSON.stringify(saved));
      assert.strictEqual(roundTripped.pausedAtGate, null, 'the clear must survive serialisation');

      const reloaded = StateMachine.fromSnapshot(roundTripped);
      assert.strictEqual(reloaded.pausedAtGate, null, 'a reloaded checkpoint must report no pause');
      assert.strictEqual(reloaded.currentStage, STAGE_COMPLETED);
    });

    // --- issue #315 / #318.1: the COMMIT wait is banked AND rendered ----------
    test('a recorded COMMIT pause is consumed into totalHumanWaitMs and a non-zero summary row (#315)', async () => {
      const pausedAt = new Date(Date.now() - 30_000).toISOString();
      const sm = StateMachine.fromSnapshot({
        ...new StateMachine({ stage: new Stage(STAGE_COMMIT), worktree: mockWorktree }).toSnapshot(),
        pausedAtGate: GATE_COMMIT,
        pausedAtTimestamp: pausedAt
      });
      const stateRepo = new MockStateRepository(sm);
      const executor = new MockCommandExecutor();
      executor.responses['git status --porcelain'] = { stdout: 'M src/file.ts\n' };
      executor.responses['git add -A'] = { exitCode: 0 };
      executor.responses['git rev-parse HEAD'] = { stdout: 'deadbee\n' };
      executor.responses['git rev-parse --abbrev-ref HEAD'] = { stdout: 'fix/999\n' };
      const planGenerator = new MockPlanGenerator();

      const useCase = new ExecuteCommitUseCase(stateRepo, executor, planGenerator);
      const result = await useCase.execute({
        commitMessage: CommitMessage.create({ type: 'fix', description: 'commit gate wait' }),
        bypassConfirmation: true,
        interactive: false
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.stateMachine.totalHumanWaitMs >= 30_000,
        `the use case must consume the recorded pause, got ${result.stateMachine.totalHumanWaitMs}`
      );
      assert.ok(
        (stateRepo.savedSnapshot as any).totalHumanWaitMs >= 30_000,
        'the consumed wait must be PERSISTED, not only held in memory'
      );

      // The summary row is the measured wait — never the `0s` the standard
      // REVIEW→COMMIT path used to render because nothing paused the machine.
      assert.ok(planGenerator.updatedSummary, 'the summary row must be written');
      const duration = String(planGenerator.updatedSummary!.data.duration);
      assert.match(
        duration,
        /^(?:\d+m )?\d+s$/,
        `the Commit Gate duration must be a rendered duration, got: ${duration}`
      );
      assert.notStrictEqual(duration, '0s', 'a 30s wait may never render as 0s');
    });
  });
});

