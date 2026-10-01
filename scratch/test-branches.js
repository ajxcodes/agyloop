const { GitWorktreeManager } = require('../dist/infrastructure/git-worktree-manager');
const { CommandExecutor } = require('../dist/infrastructure/command-executor');
const m = new GitWorktreeManager(new CommandExecutor());
m.listBranches({ workspaceDir: process.cwd() }).then(console.log);
