/**
 * agyloop - GitWorktreeManager Infrastructure Adapter
 *
 * Implements WorktreeManagerPort using Git CLI and Node.js filesystem APIs.
 * Enforces strict worktree isolation for parallel subagent task executions.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  WorktreeDescriptor,
  WorktreeCreationError,
  WorktreeCleanupError,
  DEFAULT_WORKTREES_DIR,
  DEFAULT_TASK_BRANCH_PREFIX
} from '../domain';
import {
  WorktreeManagerPort,
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  PruneWorktreesOptions,
  ListWorktreesOptions,
  EnsureGitIgnoreOptions,
  CleanOrphanedOptions,
  ListBranchesOptions,
  CreateBranchOptions,
  GetCommitsOptions,
  IsAncestorOptions,
  PushBranchOptions,
  CommandExecutorPort
} from '../ports';
import { ProcessCommandExecutor } from './process-command-executor';

export class GitWorktreeManager implements WorktreeManagerPort {
  private readonly commandExecutor: CommandExecutorPort;

  constructor(commandExecutor?: CommandExecutorPort) {
    this.commandExecutor = commandExecutor || new ProcessCommandExecutor();
  }

  /**
   * Resolves absolute or relative worktree path for a given task ID.
   */
  public resolveTaskWorktreePath(
    workspaceDir: string,
    taskId: string | number,
    worktreesDir: string = DEFAULT_WORKTREES_DIR
  ): string {
    const cleanWorkspace = workspaceDir || process.cwd();
    const cleanId = String(taskId).trim();
    return path.resolve(cleanWorkspace, worktreesDir, cleanId);
  }

  /**
   * Resolves deterministic branch name for a task: task/<task-id>-<slug>
   */
  public resolveTaskBranchName(
    taskId: string | number,
    slug?: string | null,
    prefix: string = DEFAULT_TASK_BRANCH_PREFIX
  ): string {
    return WorktreeDescriptor.formatBranchName(taskId, slug || undefined, prefix);
  }

  /**
   * Automatically adds .worktrees/ to .gitignore if not already present.
   */
  public async ensureGitIgnore(options?: EnsureGitIgnoreOptions): Promise<boolean> {
    const workspace = options?.workspaceDir || process.cwd();
    const targetEntry = options?.entry || '.worktrees/';
    const gitignorePath = path.join(workspace, '.gitignore');

    try {
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(
          gitignorePath,
          `# AgyLoop Git Worktrees\n${targetEntry}\n`,
          'utf8'
        );
        return true;
      }

      const content = fs.readFileSync(gitignorePath, 'utf8');
      const escaped = targetEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\//g, '\\/?');
      const regex = new RegExp(`(?:^|\\r?\\n)\\s*${escaped}\\s*(?:$|\\r?\\n)`);
      if (regex.test(content)) {
        return false;
      }

      const separator = content.endsWith('\n') ? '' : '\n';
      const updated = `${content}${separator}\n# AgyLoop Git Worktrees\n${targetEntry}\n`;
      fs.writeFileSync(gitignorePath, updated, 'utf8');
      return true;
    } catch (err) {
      // Non-fatal warning if .gitignore cannot be modified
      return false;
    }
  }

  /**
   * Inspects the base branch of the current repository.
   */
  public async resolveBaseBranch(workspaceDir?: string): Promise<string> {
    const workspace = workspaceDir || process.cwd();
    try {
      const res = await this.commandExecutor.execute('git rev-parse --abbrev-ref HEAD', {
        cwd: workspace
      });
      const branch = (res.stdout || '').trim();
      if (branch && branch !== 'HEAD') {
        return branch;
      }
    } catch {
      // Fallback below
    }

    // Try detecting main or master
    try {
      const mainCheck = await this.commandExecutor.execute('git rev-parse --verify main', {
        cwd: workspace
      });
      if (mainCheck.exitCode === 0) return 'main';
    } catch {
      // Continue to master
    }

    try {
      const masterCheck = await this.commandExecutor.execute('git rev-parse --verify master', {
        cwd: workspace
      });
      if (masterCheck.exitCode === 0) return 'master';
    } catch {
      // Fallback
    }

    return 'main';
  }

  /**
   * Provisions an isolated git worktree under .worktrees/<task-id> on branch task/<task-id>-<slug>.
   */
  public async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeDescriptor> {
    const workspace = options.workspaceDir || process.cwd();
    const taskId = String(options.taskId).trim();
    if (!taskId) {
      throw new WorktreeCreationError('createWorktree', 'Task ID is required to create a worktree.');
    }

    const slug =
      options.slug !== undefined && options.slug !== null
        ? options.slug.trim()
        : options.title
        ? WorktreeDescriptor.slugify(options.title)
        : '';

    const branch = this.resolveTaskBranchName(taskId, slug, options.branchPrefix);
    const worktreePath = this.resolveTaskWorktreePath(workspace, taskId, options.worktreesDir);

    // 1. Ensure .worktrees/ and .agyloop/ are ignored in root repo
    await this.ensureGitIgnore({ workspaceDir: workspace, entry: '.worktrees/' });
    await this.ensureGitIgnore({ workspaceDir: workspace, entry: '.agyloop/' });

    // 2. Resolve base branch
    const baseBranch = options.baseBranch || (await this.resolveBaseBranch(workspace));

    // 3. Handle existing worktree directory recovery
    if (fs.existsSync(worktreePath)) {
      const existing = await this.listWorktrees({ workspaceDir: workspace });
      const found = existing.find((wt) => wt.worktreePath === worktreePath);
      if (found) {
        // Already registered worktree, ensure node_modules and return
        this.linkNodeModulesIfPresent(workspace, worktreePath, options.linkNodeModules);
        return found;
      }

      // If directory exists but git does not recognize it, prune and remove orphaned folder
      await this.pruneWorktrees({ workspaceDir: workspace });
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // Continue to add
      }
    }

    // 4. Ensure parent directory exists (.worktrees)
    const parentDir = path.dirname(worktreePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // 5. Execute git worktree add
    let addRes = await this.commandExecutor.execute(
      `git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`,
      { cwd: workspace }
    );

    if (addRes.exitCode !== 0) {
      const output = (addRes.stderr || '') + '\n' + (addRes.stdout || '');
      // If branch is already checked out at a worktree, return existing worktree descriptor idempotently
      if (output.includes('already checked out at')) {
        const match = output.match(/already checked out at '([^']+)'/);
        const existingPath = match ? match[1] : worktreePath;
        this.linkNodeModulesIfPresent(workspace, existingPath, options.linkNodeModules);
        this.linkArtifactsIfPresent(workspace, existingPath);
        return new WorktreeDescriptor({
          taskId,
          worktreePath: existingPath,
          branch,
          baseBranch,
          slug,
          isIsolated: true
        });
      }

      // If branch already exists, reuse the existing branch
      if (output.includes('already exists')) {
        addRes = await this.commandExecutor.execute(
          `git worktree add "${worktreePath}" "${branch}"`,
          { cwd: workspace }
        );
      }
    }

    if (addRes.exitCode !== 0) {
      const output = (addRes.stderr || '') + '\n' + (addRes.stdout || '');
      if (output.includes('already checked out at')) {
        const match = output.match(/already checked out at '([^']+)'/);
        const existingPath = match ? match[1] : worktreePath;
        this.linkNodeModulesIfPresent(workspace, existingPath, options.linkNodeModules);
        this.linkArtifactsIfPresent(workspace, existingPath);
        return new WorktreeDescriptor({
          taskId,
          worktreePath: existingPath,
          branch,
          baseBranch,
          slug,
          isIsolated: true
        });
      }

      throw new WorktreeCreationError(
        'createWorktree',
        addRes.stderr || addRes.stdout || `Failed to create git worktree at ${worktreePath}`,
        { taskId, branch, worktreePath, baseBranch }
      );
    }

    // 6. Build Cache Optimization & Artifacts Mirroring
    this.linkNodeModulesIfPresent(workspace, worktreePath, options.linkNodeModules);
    this.linkArtifactsIfPresent(workspace, worktreePath);

    return new WorktreeDescriptor({
      taskId,
      worktreePath,
      branch,
      baseBranch,
      slug,
      isIsolated: true
    });
  }

  /**
   * Detaches and removes worktree directory and cleans up metadata.
   */
  public async removeWorktree(options: RemoveWorktreeOptions): Promise<void> {
    const workspace = options.workspaceDir || process.cwd();
    const worktreePath = options.worktreePath;

    if (!worktreePath) return;

    // Safely remove symlinks before git worktree remove
    this.unlinkSymlink(path.join(worktreePath, 'node_modules'));
    this.unlinkSymlink(path.join(worktreePath, 'artifacts'));

    // Execute git worktree remove --force
    const removeRes = await this.commandExecutor.execute(
      `git worktree remove --force "${worktreePath}"`,
      { cwd: workspace }
    );

    // If disk folder persists, clean it up forcibly
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }

    // Prune dangling references
    if (options.prune !== false) {
      await this.pruneWorktrees({ workspaceDir: workspace });
    }

    if (removeRes.exitCode !== 0 && fs.existsSync(worktreePath)) {
      throw new WorktreeCleanupError(
        'removeWorktree',
        removeRes.stderr || removeRes.stdout || `Failed to remove git worktree at ${worktreePath}`,
        { worktreePath }
      );
    }
  }

  /**
   * Prunes dangling worktrees via git worktree prune.
   */
  public async pruneWorktrees(options?: PruneWorktreesOptions): Promise<void> {
    const workspace = options?.workspaceDir || process.cwd();
    const cmd = options?.expire
      ? `git worktree prune --expire "${options.expire}"`
      : 'git worktree prune';

    await this.commandExecutor.execute(cmd, { cwd: workspace });
  }

  /**
   * Lists active worktrees registered in the git repository.
   */
  public async listWorktrees(options?: ListWorktreesOptions): Promise<readonly WorktreeDescriptor[]> {
    const workspace = options?.workspaceDir || process.cwd();
    const res = await this.commandExecutor.execute('git worktree list --porcelain', {
      cwd: workspace
    });

    if (res.exitCode !== 0) {
      return [];
    }

    const output = (res.stdout || '').trim();
    if (!output) return [];

    const blocks = output.split(/\n\s*\n/);
    const descriptors: WorktreeDescriptor[] = [];
    const normalizedRoot = path.resolve(workspace);

    for (const block of blocks) {
      const lines = block.split('\n');
      let wtPath = '';
      let branchRef = '';

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.substring('worktree '.length).trim();
        } else if (line.startsWith('branch ')) {
          branchRef = line.substring('branch '.length).trim();
        }
      }

      if (!wtPath) continue;

      const normalizedWtPath = path.resolve(wtPath);
      // Skip the root primary workspace
      if (normalizedWtPath === normalizedRoot) {
        continue;
      }

      const branch = branchRef.replace(/^refs\/heads\//, '') || 'HEAD';
      const taskId = path.basename(normalizedWtPath);

      descriptors.push(
        new WorktreeDescriptor({
          taskId,
          worktreePath: normalizedWtPath,
          branch,
          baseBranch: 'HEAD',
          isIsolated: true
        })
      );
    }

    return descriptors;
  }

  /**
   * Cleans orphaned or stale worktrees/locks and returns count pruned.
   */
  public async cleanOrphanedWorktrees(options?: CleanOrphanedOptions): Promise<number> {
    const workspace = options?.workspaceDir || process.cwd();
    const initialList = await this.listWorktrees({ workspaceDir: workspace });
    await this.pruneWorktrees({ workspaceDir: workspace });

    const worktreesDir = path.join(workspace, DEFAULT_WORKTREES_DIR);
    let cleaned = 0;

    if (fs.existsSync(worktreesDir)) {
      const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
      const activeWorktrees = await this.listWorktrees({ workspaceDir: workspace });
      const activePaths = new Set(activeWorktrees.map((wt) => wt.worktreePath));

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = path.join(worktreesDir, entry.name);
          if (!activePaths.has(fullPath)) {
            try {
              fs.rmSync(fullPath, { recursive: true, force: true });
              cleaned++;
            } catch {
              // Ignore failure on deletion
            }
          }
        }
      }
    }

    await this.pruneWorktrees({ workspaceDir: workspace });
    const finalList = await this.listWorktrees({ workspaceDir: workspace });
    const diff = Math.max(0, initialList.length - finalList.length);
    return Math.max(cleaned, diff);
  }

  /**
   * Lists local and remote branches in the repository.
   */
  public async listBranches(options?: ListBranchesOptions): Promise<readonly string[]> {
    const workspace = options?.workspaceDir || process.cwd();
    const flag = options?.remote !== false ? '-a' : '';
    const res = await this.commandExecutor.execute(`git branch ${flag} --format="%(refname:short)"`, {
      cwd: workspace
    });

    if (res.exitCode !== 0) {
      return [];
    }

    const lines = (res.stdout || '')
      .split('\n')
      .map((l) => l.trim().replace(/^origin\//, '').replace(/^remotes\/origin\//, ''))
      .filter((l) => l.length > 0 && l !== 'HEAD' && !l.includes('->'));

    // Deduplicate branches
    return Array.from(new Set(lines));
  }

  /**
   * Creates a branch from a specified start point.
   */
  public async createBranch(options: CreateBranchOptions): Promise<void> {
    const workspace = options.workspaceDir || process.cwd();
    const startPoint = options.startPoint || 'HEAD';
    const res = await this.commandExecutor.execute(
      `git branch "${options.branchName}" "${startPoint}"`,
      { cwd: workspace }
    );

    if (res.exitCode !== 0) {
      throw new WorktreeCreationError(
        'createBranch',
        res.stderr || res.stdout || `Failed to create branch '${options.branchName}' from '${startPoint}'`
      );
    }
  }

  /**
   * Returns commit messages between two branches (baseBranch..headBranch).
   */
  public async getCommitsBetween(options: GetCommitsOptions): Promise<readonly string[]> {
    const workspace = options.workspaceDir || process.cwd();
    const res = await this.commandExecutor.execute(
      `git log "${options.baseBranch}..${options.headBranch}" --format="%s%x1f%b%x1e"`,
      { cwd: workspace }
    );

    if (res.exitCode !== 0 || !res.stdout.trim()) {
      return [];
    }

    const rawRecords = res.stdout.split('\x1e');
    const commits: string[] = [];

    for (const rec of rawRecords) {
      const clean = rec.trim();
      if (!clean) continue;
      const parts = clean.split('\x1f');
      const header = parts[0]?.trim() || '';
      const body = parts[1]?.trim() || '';
      if (header) {
        commits.push(body ? `${header}\n${body}` : header);
      }
    }

    return commits;
  }

  /**
   * Checks whether ancestorBranch has been merged into descendantBranch.
   */
  public async isAncestor(options: IsAncestorOptions): Promise<boolean> {
    const workspace = options.workspaceDir || process.cwd();
    const ancestorBranch = options.ancestorBranch || (options as any).ancestor || '';
    const descendantBranch = options.descendantBranch || (options as any).descendant || '';

    const ancestorSha = await this.getCommitHash(ancestorBranch, workspace);
    const descendantSha = await this.getCommitHash(descendantBranch, workspace);

    if (ancestorSha && descendantSha && ancestorSha === descendantSha) {
      return false;
    }

    const res = await this.commandExecutor.execute(
      `git merge-base --is-ancestor "${ancestorBranch}" "${descendantBranch}"`,
      { cwd: workspace }
    );

    return res.exitCode === 0;
  }

  private async getCommitHash(branch: string, workspace: string): Promise<string> {
    const res = await this.commandExecutor.execute(`git rev-parse "${branch}^{commit}"`, {
      cwd: workspace
    });
    return (res.stdout || '').trim();
  }

  /**
   * Pushes a local branch to the remote repository.
   * Best-effort execution: returns true on success, false if offline or without push permissions.
   */
  public async pushBranch(options: PushBranchOptions): Promise<boolean> {
    const workspace = options.workspaceDir || process.cwd();
    const remote = options.remote || 'origin';
    const setUpstream = options.setUpstream !== false ? '-u ' : '';
    try {
      const res = await this.commandExecutor.execute(
        `git push ${setUpstream}${remote} "${options.branchName}"`,
        { cwd: workspace }
      );
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  private linkNodeModulesIfPresent(
    workspace: string,
    worktreePath: string,
    optIn?: boolean
  ): void {
    if (optIn === false) return;

    try {
      const rootNodeModules = path.join(workspace, 'node_modules');
      const targetNodeModules = path.join(worktreePath, 'node_modules');

      if (fs.existsSync(rootNodeModules) && !fs.existsSync(targetNodeModules)) {
        fs.symlinkSync(rootNodeModules, targetNodeModules, 'junction');
      }
    } catch {
      // Symlink failure is non-blocking (e.g. permission or platform limitation)
    }
  }

  private linkArtifactsIfPresent(workspace: string, worktreePath: string): void {
    try {
      const rootArtifacts = path.join(workspace, 'artifacts');
      const targetArtifacts = path.join(worktreePath, 'artifacts');

      if (fs.existsSync(rootArtifacts) && !fs.existsSync(targetArtifacts)) {
        fs.symlinkSync(rootArtifacts, targetArtifacts, 'junction');
      }
    } catch {
      // Non-fatal
    }
  }

  private unlinkSymlink(targetPath: string): void {
    try {
      if (fs.existsSync(targetPath)) {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(targetPath);
        }
      }
    } catch {
      // Non-fatal
    }
  }
}
