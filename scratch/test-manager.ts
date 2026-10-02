import { GitWorktreeManager } from '../src/infrastructure/git-worktree-manager';
import { CommandExecutor } from '../src/infrastructure/command-executor';
const m = new GitWorktreeManager(new CommandExecutor());
m.createWorktree({ taskId: 144, workspaceDir: process.cwd() }).then(console.log).catch(console.error);
