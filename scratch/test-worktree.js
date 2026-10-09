const { GitWorktreeManager } = require('../dist/infrastructure/git-worktree-manager');
const { CommandExecutor } = require('../dist/infrastructure/command-executor');
const m = new GitWorktreeManager(new CommandExecutor());
m.resolveTaskWorktreePath('/home/ajxcodes/code/agyloop', '144').then(console.log);
