import { GitWorktreeManager } from './src/infrastructure/git-worktree-manager';
import { CommandExecutor } from './src/infrastructure/command-executor';
async function run() {
  const executor = new CommandExecutor();
  const manager = new GitWorktreeManager(executor);
  await manager.createWorktree({
    workspaceDir: process.cwd(),
    taskId: '174',
    branchName: 'fix/174-test',
    baseBranch: 'phase/5-orchestrator-hardening'
  });
  console.log("Created worktree. Now tearing down...");
  await manager.removeWorktree({
    workspaceDir: process.cwd(),
    worktreePath: process.cwd() + '/.worktrees/174',
    force: true,
    prune: true
  });
  console.log("Teardown done");
}
run().catch(console.error);
