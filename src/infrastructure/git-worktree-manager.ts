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
  WorktreeError,
  DEFAULT_WORKTREES_DIR,
  DEFAULT_TASK_BRANCH_PREFIX,
  DEFAULT_STATE_DIR,
  CODELOOP_STATE_DIR,
  INIT_GITIGNORE_RULES,
  DEFAULT_BASE_BRANCH,
  DEFAULT_BASE_BRANCH_CANDIDATES,
  ValidationError,
  isRootWorkspace,
  isPathInsideRoot,
  isSamePath,
  shellQuote
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
  DeleteBranchOptions,
  GetCommitsOptions,
  IsAncestorOptions,
  PushBranchOptions,
  CommandExecutorPort,
  QuarantineWorktreeResult
} from '../ports';
import { ProcessCommandExecutor } from './process-command-executor';

export class GitWorktreeManager implements WorktreeManagerPort {
  private readonly commandExecutor: CommandExecutorPort;

  constructor(commandExecutor?: CommandExecutorPort) {
    this.commandExecutor = commandExecutor || new ProcessCommandExecutor();
  }

  /**
   * Resolves the primary repository root.
   * When inside a linked git worktree or nested subdirectory, git rev-parse --show-toplevel
   * returns the worktree path itself, not the primary repo root.
   * git worktree list --porcelain outputs all worktrees, and the very first worktree listed
   * is always the main repository root.
   */
  private async getRepoRoot(workspaceDir?: string): Promise<string> {
    const cwd = workspaceDir || process.cwd();
    try {
      const res = await this.commandExecutor.execute('git worktree list --porcelain', { cwd });
      if (res.exitCode === 0 && res.stdout) {
        const firstLine = res.stdout.trim().split('\n')[0] || '';
        const match = firstLine.match(/^worktree (.+)$/);
        if (match && match[1]) {
          return path.resolve(match[1].trim());
        }
      }
    } catch {
      // Fallback below
    }

    try {
      const res = await this.commandExecutor.execute('git rev-parse --show-toplevel', { cwd });
      if (res.exitCode === 0 && res.stdout && res.stdout.trim()) {
        const topLevel = res.stdout.trim();
        if (path.isAbsolute(topLevel)) {
          return path.resolve(topLevel);
        }
      }
    } catch {
      // Fallback below
    }

    return path.resolve(cwd);
  }

  /** Public probe for the PRIMARY repository root (see the port doc). */
  public async resolveRepositoryRoot(workspaceDir?: string): Promise<string> {
    return this.getRepoRoot(workspaceDir);
  }

  /**
   * Resolves the worktree path for a task ID inside `<repo>/<worktreesDir>`.
   *
   * Issue #282: the target used to be joined blindly with
   * `path.resolve(root, '.worktrees', target)`. `path.resolve` DISCARDS the
   * base when the argument is absolute, so `worktree remove /tmp/victim`
   * resolved to `/tmp/victim` and the removal path then deleted it. The
   * segment is now validated and the result is proven to be a strict
   * descendant of the worktrees directory BEFORE it is returned:
   *
   *   - one path segment only, `[A-Za-z0-9._-]+`, never `.` / `..` / `-...`;
   *   - absolute inputs and separators are refused;
   *   - an existing symlink is refused (and a symlink that escapes the
   *     worktrees directory via its parents is refused by the realpath check).
   */
  public async resolveTaskWorktreePath(
    workspaceDir: string,
    taskId: string | number,
    worktreesDir?: string
  ): Promise<string> {
    const segment = String(taskId ?? '').trim();
    const targetWorktreesDir = worktreesDir || DEFAULT_WORKTREES_DIR;

    if (!segment) {
      throw new ValidationError(
        'taskId',
        taskId,
        'Task ID is required to resolve a worktree path inside the worktrees directory.'
      );
    }

    if (path.isAbsolute(segment)) {
      throw new ValidationError(
        'taskId',
        segment,
        `Refusing absolute worktree target '${segment}': a task ID must be a single path segment inside '<repo>/${targetWorktreesDir}', never an absolute path.`
      );
    }

    if (segment.includes('/') || segment.includes('\\') || segment !== path.basename(segment)) {
      throw new ValidationError(
        'taskId',
        segment,
        `Refusing worktree target '${segment}': a task ID must be a single path segment inside '<repo>/${targetWorktreesDir}' (path separators are not accepted).`
      );
    }

    if (
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('-') ||
      !/^[A-Za-z0-9._-]+$/.test(segment)
    ) {
      throw new ValidationError(
        'taskId',
        segment,
        `Refusing worktree target '${segment}': a task ID must be a single path segment inside '<repo>/${targetWorktreesDir}' (allowed characters: letters, digits, '.', '_', '-').`
      );
    }

    if (path.isAbsolute(targetWorktreesDir)) {
      throw new ValidationError(
        'worktreesDir',
        targetWorktreesDir,
        `worktreesDir must be repository-relative, got the absolute path '${targetWorktreesDir}'.`
      );
    }

    const root = await this.getRepoRoot(workspaceDir);
    const worktreesRoot = path.resolve(root, targetWorktreesDir);

    // Issue #282: a REPOSITORY-RELATIVE value can still escape
    // (`../escape-dir`), so the worktrees root itself must be a strict
    // descendant of the repository root before any target is resolved into it.
    const worktreesRelative = path.relative(path.resolve(root), worktreesRoot);
    if (
      worktreesRelative === '' ||
      worktreesRelative === '..' ||
      worktreesRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(worktreesRelative)
    ) {
      throw new ValidationError(
        'worktreesDir',
        targetWorktreesDir,
        `worktreesDir must stay inside the repository root '${root}', got '${targetWorktreesDir}'.`
      );
    }

    const candidate = path.resolve(worktreesRoot, segment);

    const relative = path.relative(worktreesRoot, candidate);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new ValidationError(
        'taskId',
        segment,
        `Refusing worktree target '${segment}': it resolves outside '${worktreesRoot}'.`
      );
    }

    // `lstat` (not `stat`) so a BROKEN symlink is still detected. A symlink at
    // the target is refused outright: `worktree remove` follows it, and the
    // containment guarantee below is about real locations, not names.
    let targetStat: fs.Stats | null = null;
    try {
      targetStat = fs.lstatSync(candidate);
    } catch {
      // Not present (or unreadable): nothing to inspect.
    }

    if (targetStat?.isSymbolicLink()) {
      throw new ValidationError(
        'taskId',
        segment,
        `Refusing worktree target '${segment}': '${candidate}' is a symbolic link, not a worktree directory.`
      );
    }

    if (targetStat) {
      try {
        const realCandidate = fs.realpathSync(candidate);
        const realWorktreesRoot = fs.existsSync(worktreesRoot)
          ? fs.realpathSync(worktreesRoot)
          : worktreesRoot;
        const realRelative = path.relative(realWorktreesRoot, realCandidate);
        if (
          realRelative === '' ||
          realRelative === '..' ||
          realRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(realRelative)
        ) {
          throw new ValidationError(
            'taskId',
            segment,
            `Refusing worktree target '${segment}': '${candidate}' resolves outside '${worktreesRoot}'.`
          );
        }
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError(
          'taskId',
          segment,
          `Refusing worktree target '${segment}': '${candidate}' could not be resolved safely (${err instanceof Error ? err.message : String(err)}).`
        );
      }
    }

    return candidate;
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
   * Automatically adds .worktrees to .gitignore if not already present.
   */
  public async ensureGitIgnore(options?: EnsureGitIgnoreOptions): Promise<boolean> {
    const workspace = await this.getRepoRoot(options?.workspaceDir);
    const rawEntry = options?.entry || '.worktrees';
    const targetEntry = rawEntry.trim().replace(/\/$/, '');
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

      // Granular state rules (agyloop/codeloop init) supersede the blanket state-dir ignore,
      // which would otherwise hide the tracked config.json again.
      if (targetEntry === DEFAULT_STATE_DIR || targetEntry === CODELOOP_STATE_DIR) {
        const lines = content.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/\/$/, ''));
        const granular = INIT_GITIGNORE_RULES
          .filter((r) => r.startsWith('.agyloop/') || r.startsWith('.codeloop/'))
          .map((r) => r.replace(/^\//, '').replace(/\/$/, ''));
        if (granular.some((g) => lines.includes(g))) {
          return false;
        }
      }

      const escaped = targetEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:^|\\r?\\n)\\s*\\/?${escaped}\\/?\\s*(?:$|\\r?\\n)`);
      if (regex.test(content)) {
        return false;
      }

      const separator = content.endsWith('\n') ? '' : '\n';
      const updated = `${content}${separator}\n# AgyLoop Git Worktrees\n${targetEntry}\n`;
      fs.writeFileSync(gitignorePath, updated, 'utf8');
      return true;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // Non-fatal warning if .gitignore cannot be modified
      return false;
    }
  }

  /**
   * Inspects the base branch of the current repository.
   * Staged probe (issue #218 / AC5): attached HEAD -> well-known local candidates
   * (develop, master, main, trunk) -> DEFAULT_BASE_BRANCH.
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

    // Try the well-known default branch candidates before falling back to 'main'.
    for (const candidate of DEFAULT_BASE_BRANCH_CANDIDATES) {
      try {
        const check = await this.commandExecutor.execute(
          `git rev-parse --verify refs/heads/${candidate}`,
          { cwd: workspace }
        );
        if (check.exitCode === 0) return candidate;
      } catch {
        // Continue to the next candidate.
      }
    }

    return DEFAULT_BASE_BRANCH;
  }

  /**
   * Provisions an isolated git worktree under .worktrees/<task-id> on branch task/<task-id>-<slug>.
   */
  public async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeDescriptor> {
    const workspace = await this.getRepoRoot(options.workspaceDir);
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
    const worktreePath = await this.resolveTaskWorktreePath(workspace, taskId, options.worktreesDir);

    // 1. Ensure .worktrees and .agyloop are ignored in root repo
    await this.ensureGitIgnore({ workspaceDir: workspace, entry: '.worktrees' });
    await this.ensureGitIgnore({ workspaceDir: workspace, entry: `${DEFAULT_STATE_DIR}` });

    // 2. Resolve base branch
    const baseBranch = options.baseBranch || (await this.resolveBaseBranch(workspace));

    // 3. Handle existing worktree directory recovery
    if (fs.existsSync(worktreePath)) {
      const existing = await this.listWorktrees({ workspaceDir: workspace });
      const found = existing.find((wt) => wt.worktreePath === worktreePath);
      if (found) {
        // Already registered worktree, ensure node_modules, artifacts, and .agyloop, then return
        this.linkNodeModulesIfPresent(workspace, worktreePath, options.linkNodeModules);
        this.linkArtifactsIfPresent(workspace, worktreePath);
        this.linkAgyloopStateIfPresent(workspace, worktreePath);
        return found;
      }

      // If directory exists but git does not recognize it, prune and remove orphaned folder
      await this.pruneWorktrees({ workspaceDir: workspace });
      try {
        // Defence in depth (#282): the hardened resolver already refuses a
        // symlinked target, and this recursive delete must never follow one.
        if (!fs.lstatSync(worktreePath).isSymbolicLink()) {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
      } catch {
        // Continue to add
      }
    }

    // 4. Ensure parent directory exists (.worktrees)
    const parentDir = path.dirname(worktreePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // 5. Check if an existing LOCAL branch matching task/<id> or fix/<id> already exists.
    // The check must answer "is there already LOCAL work in progress for this task?":
    // it lists local branches only (ListBranchesOptions.remote = false). A branch that
    // exists only on the remote — the ordinary leftover of a merged PR — does not
    // count as "in progress", because reusing it would make
    // `git worktree add <path> <branch>` fall into git's DWIM rule and start the task
    // branch at the REMOTE's commit instead of the current base branch (#264).
    let targetBranch = branch;
    let branchAlreadyExists = false;

    try {
      const existingBranches = await this.listBranches({ workspaceDir: workspace, remote: false });
      const branchPattern = new RegExp(`^(task|fix)/${taskId}([-_/]|$)`, 'i');
      const matched = existingBranches.find((b) => branchPattern.test(b));
      if (matched) {
        targetBranch = matched;
        branchAlreadyExists = true;
      }
    } catch {
      // Non-fatal, proceed with default branch. If the branch list itself cannot be
      // read, the fresh `-b` create below starts from baseBranch (the correct
      // direction for this defect class) and the start-point verification is the
      // independent backstop.
    }

    // 6. Execute git worktree add
    let addRes;
    if (branchAlreadyExists) {
      // Branch exists. Reuse it without -b. If it is already held by another worktree,
      // it will intentionally fail ("is already used by worktree at" on modern git,
      // "is already checked out at" on older git) and we attach to it below.
      addRes = await this.commandExecutor.execute(
        `git worktree add "${worktreePath}" "${targetBranch}"`,
        { cwd: workspace }
      );
    } else {
      // Branch doesn't exist, create it with -b
      addRes = await this.commandExecutor.execute(
        `git worktree add -b "${targetBranch}" "${worktreePath}" "${baseBranch}"`,
        { cwd: workspace }
      );
    }

    if (addRes.exitCode !== 0) {
      const output = addRes.stderr || addRes.stdout || '';

      // `git worktree add` refuses to check out a branch that another worktree already
      // holds. Resolve which worktree holds it from `git worktree list --porcelain`
      // (an authoritative query, independent of git's wording) and only fall back to
      // parsing the error text, which git has changed over time.
      const holder = await this.findWorktreeForBranch(workspace, targetBranch);

      if (holder && holder.prunable) {
        // git still has a registration for this branch, but the worktree directory was
        // deleted behind git's back (`rm -rf .worktrees/<id>` without
        // `git worktree remove`). Attaching to it would hand back a descriptor
        // pointing at a path that does not exist, so drop the dead registration and
        // check the branch out afresh instead.
        await this.pruneWorktrees({ workspaceDir: workspace });
        const recheck = await this.findWorktreeForBranch(workspace, targetBranch);

        if (recheck && recheck.prunable) {
          throw new WorktreeCreationError(
            'createWorktree',
            `Branch '${targetBranch}' is still registered to a missing worktree at ${recheck.worktreePath} after 'git worktree prune'. Delete that stale registration manually (it lives in the repository's .git/worktrees administrative directory) and retry.`,
            { taskId, branch: targetBranch, worktreePath, baseBranch }
          );
        }

        if (recheck) {
          return this.adoptExistingWorktree(workspace, recheck.worktreePath, {
            taskId,
            branch: targetBranch,
            baseBranch,
            slug,
            linkNodeModules: options.linkNodeModules
          });
        }

        // The branch is free again; check it out at the canonical path.
        const retry = await this.commandExecutor.execute(
          `git worktree add "${worktreePath}" "${targetBranch}"`,
          { cwd: workspace }
        );
        if (retry.exitCode === 0) {
          // The branch pre-existed locally, so this re-add reuses it: report the
          // reuse (branch + tip, merged-branch policy notice) so a stale local
          // branch is visible rather than silent (#264).
          await this.reportBranchReuse(workspace, targetBranch, baseBranch);
          return this.adoptExistingWorktree(workspace, worktreePath, {
            taskId,
            branch: targetBranch,
            baseBranch,
            slug,
            linkNodeModules: options.linkNodeModules
          });
        }

        throw new WorktreeCreationError(
          'createWorktree',
          retry.stderr || retry.stdout || output,
          { taskId, branch: targetBranch, worktreePath, baseBranch }
        );
      }

      const checkedOutPath =
        holder?.worktreePath ?? this.extractAlreadyCheckedOutPath(output);

      if (checkedOutPath) {
        return this.adoptExistingWorktree(workspace, checkedOutPath, {
          taskId,
          branch: targetBranch,
          baseBranch,
          slug,
          linkNodeModules: options.linkNodeModules
        });
      }

      // Any other error
      throw new WorktreeCreationError(
        'createWorktree',
        output || `Failed to create git worktree at ${worktreePath}`,
        { taskId, branch: targetBranch, worktreePath, baseBranch }
      );
    }

    // 7. Verify the worktree's start point on the fresh-create path: git checked
    // out baseBranch for us, so the worktree HEAD must equal the base branch's tip.
    // A mismatch means the task branch did not start from the base — exactly the
    // stale-start defect this verification exists to catch (#264) — and is a hard
    // error rather than a silent success. The reuse arm intentionally gets
    // visibility (reportBranchReuse), not a HEAD assertion: a reused branch with
    // real work on it legitimately sits past the merge-base, and the worktree
    // necessarily starts at the branch tip.
    if (!branchAlreadyExists) {
      await this.verifyWorktreeStartPoint(workspace, worktreePath, baseBranch, {
        taskId,
        branch: targetBranch
      });
    }

    // 8. Report the reuse of a pre-existing LOCAL branch (visibility, not
    // enforcement), so a stale local branch is seen instead of silently reused.
    const reusedBranchCommit = branchAlreadyExists
      ? await this.reportBranchReuse(workspace, targetBranch, baseBranch)
      : undefined;

    // 9. Build Cache Optimization, Artifacts & State Checkpoint Mirroring
    this.linkNodeModulesIfPresent(workspace, worktreePath, options.linkNodeModules);
    this.linkArtifactsIfPresent(workspace, worktreePath);
    this.linkAgyloopStateIfPresent(workspace, worktreePath);

    return new WorktreeDescriptor({
      taskId,
      worktreePath,
      branch: targetBranch,
      baseBranch,
      slug,
      isIsolated: true,
      reusedBranchCommit
    });
  }

  /**
   * Verifies that a freshly created worktree actually started from the base
   * branch: its HEAD must equal the base branch's tip. A mismatch is a hard
   * error; an unreadable start point (either rev-parse fails or is empty) is
   * reported loud-but-lenient — the `git worktree add` itself succeeded, so
   * failing the run because a base ref cannot be resolved would be a false
   * positive.
   */
  private async verifyWorktreeStartPoint(
    workspace: string,
    worktreePath: string,
    baseBranch: string,
    context: { taskId: string; branch: string }
  ): Promise<void> {
    const headRes = await this.commandExecutor.execute(`git -C "${worktreePath}" rev-parse HEAD`, {
      cwd: workspace
    });
    const baseRes = await this.commandExecutor.execute(
      `git -C "${worktreePath}" rev-parse "${baseBranch}"`,
      { cwd: workspace }
    );

    const actualSha = (headRes.exitCode === 0 ? headRes.stdout || '' : '').trim();
    const expectedSha = (baseRes.exitCode === 0 ? baseRes.stdout || '' : '').trim();

    if (!actualSha || !expectedSha) {
      console.warn(
        `[codeloop] createWorktree: unable to verify worktree start point for branch '${context.branch}' at ${worktreePath} (worktree HEAD or base branch '${baseBranch}' could not be read); proceeding without start-point verification.`
      );
      return;
    }

    if (actualSha !== expectedSha) {
      throw new WorktreeCreationError(
        'createWorktree',
        `Worktree at ${worktreePath} did not start from the base branch: worktree HEAD is ${actualSha} but base branch '${baseBranch}' is at ${expectedSha} (expectedSha=${expectedSha}, actualSha=${actualSha}). Inspect how the branch was created with \`git -C ${worktreePath} reflog show ${context.branch}\` for its DWIM origin.`,
        {
          taskId: context.taskId,
          branch: context.branch,
          worktreePath,
          baseBranch,
          expectedSha,
          actualSha
        }
      );
    }
  }

  /**
   * Reports the reuse of a pre-existing local branch: the branch is always named,
   * with its tip commit when it can be read, plus a non-blocking warning when the
   * branch is already merged into the base (a policy signal for the operator —
   * recreating such a branch from the base is recommended).
   *
   * Returns the branch tip commit, or undefined when it could not be read, so the
   * caller can attach it to the descriptor as `reusedBranchCommit`.
   */
  private async reportBranchReuse(
    workspace: string,
    branchName: string,
    baseBranch: string
  ): Promise<string | undefined> {
    let tipSha: string | undefined;
    try {
      const tipRes = await this.commandExecutor.execute(`git rev-parse "${branchName}"`, {
        cwd: workspace
      });
      const sha = (tipRes.exitCode === 0 ? tipRes.stdout || '' : '').trim();
      if (sha) {
        tipSha = sha;
      }
    } catch {
      // Degrade gracefully to a branch-only notice.
    }

    if (tipSha) {
      console.warn(
        `[codeloop] createWorktree: reusing existing local branch "${branchName}" at commit ${tipSha} (base: "${baseBranch}")`
      );
    } else {
      console.warn(
        `[codeloop] createWorktree: reusing existing local branch "${branchName}" (base: "${baseBranch}")`
      );
    }

    try {
      const merged = await this.isAncestor({
        ancestorBranch: branchName,
        descendantBranch: baseBranch,
        workspaceDir: workspace
      });
      if (merged) {
        console.warn(
          `[codeloop] createWorktree: branch "${branchName}" is already merged into base "${baseBranch}"; recreating it from the base branch is recommended.`
        );
      }
    } catch {
      // Non-fatal: the policy notice is advisory only.
    }

    return tipSha;
  }

  /**
   * Attaches to a worktree that already exists, applying the same
   * node_modules / artifacts / .agyloop link treatment a freshly created one gets.
   */
  private adoptExistingWorktree(
    workspace: string,
    worktreePath: string,
    fields: {
      taskId: string;
      branch: string;
      baseBranch: string;
      slug: string;
      linkNodeModules?: boolean;
    }
  ): WorktreeDescriptor {
    // Issue #247 (S5): refuse to adopt the repository root as a task worktree.
    // Adopting it registers `{ worktreePath: <repoRoot>, isIsolated: false }` into
    // the checkpoint, which later teardown paths then treat as a removable
    // worktree — the destructive incident behind #247. Strict resolve-normalized
    // equality only: non-root external worktrees stay adoptable.
    if (isRootWorkspace(worktreePath, workspace)) {
      throw new WorktreeCreationError(
        'adoptExistingWorktree',
        `Refusing to adopt the repository root as a task worktree (Zero Direct Root Mutation). The target branch '${fields.branch}' is checked out at the repo root; create the task branch inside .worktrees/ or run with --no-worktree deliberately.`,
        { taskId: fields.taskId, branch: fields.branch, worktreePath }
      );
    }

    this.linkNodeModulesIfPresent(workspace, worktreePath, fields.linkNodeModules);

    this.linkArtifactsIfPresent(workspace, worktreePath);
    this.linkAgyloopStateIfPresent(workspace, worktreePath);

    return new WorktreeDescriptor({
      taskId: fields.taskId,
      worktreePath,
      branch: fields.branch,
      baseBranch: fields.baseBranch,
      slug: fields.slug,
      isIsolated: worktreePath !== path.resolve(workspace)
    });
  }

  /**
   * Extracts the conflicting worktree path from a `git worktree add` failure message.
   *
   * Git's wording here is not a stable API: releases up to ~2.44 reported
   * "'<branch>' is already checked out at '<path>'", while modern releases (verified on
   * 2.53.0) report "'<branch>' is already used by worktree at '<path>'". Both are matched.
   * Returns null when the output does not describe a branch already held by a worktree.
   */
  private extractAlreadyCheckedOutPath(output: string): string | null {
    const match = output.match(/already (?:checked out|used by worktree) at '([^']+)'/);
    return match && match[1] ? path.resolve(match[1]) : null;
  }

  /**
   * Returns the worktree that currently holds the given branch, or null if the branch
   * is not checked out in any worktree (or git could not be queried).
   *
   * `git worktree list --porcelain` always lists every worktree, external ones included,
   * so this is the reliable way to answer "which worktree already has this branch?"
   * without depending on the wording of a git error message.
   *
   * Do NOT "dedupe" this into `listWorktrees`. `listWorktrees` deliberately skips the
   * root worktree and, unless `includeExternal` is set, every worktree outside
   * `<root>/.worktrees`; recovery here must be able to attach to the root worktree when
   * that is where the branch lives. Routing this through `listWorktrees` would make a
   * branch checked out in the root silently unresolvable and break recovery.
   *
   * A dead registration is reported with `prunable: true` rather than filtered out:
   * `git worktree list --porcelain` keeps listing such entries (with their `branch`
   * line) after the worktree directory has been deleted, so dropping them silently
   * would hide the exact case the caller has to treat differently.
   */
  private async findWorktreeForBranch(
    workspaceDir: string,
    branch: string
  ): Promise<{ worktreePath: string; prunable: boolean } | null> {
    try {
      const res = await this.commandExecutor.execute('git worktree list --porcelain', {
        cwd: workspaceDir
      });
      if (res.exitCode !== 0 || !res.stdout) return null;

      // Porcelain emits blank-line separated blocks, each carrying `worktree <path>`
      // first, then `branch <ref>`, and finally -- for a dead registration --
      // `prunable <reason>`. The marker therefore only shows up *after* the branch
      // line, so the block has to be read whole before it can be classified.
      const wantedRef = `refs/heads/${branch}`;

      for (const block of res.stdout.split(/\n\s*\n/)) {
        let wtPath = '';
        let branchRef = '';
        let prunable = false;

        for (const rawLine of block.split('\n')) {
          const line = rawLine.trim();
          if (line.startsWith('worktree ')) {
            wtPath = line.slice('worktree '.length).trim();
          } else if (line.startsWith('branch ')) {
            branchRef = line.slice('branch '.length).trim();
          } else if (line.startsWith('prunable')) {
            prunable = true;
          }
        }

        if (wtPath && branchRef === wantedRef) {
          return { worktreePath: path.resolve(wtPath), prunable };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Detaches and removes worktree directory and cleans up metadata.
   *
   * Issue #282: this is the only destructive command in the operator surface,
   * and it used to have no target validation, no ownership check and no
   * post-condition. Pre-fix, `path.resolve` had already discarded the base for
   * an absolute target, the #247 guard only blacklisted the root/ancestors, and
   * the "external and disjoint" branch of the fallback then deleted ANY
   * disjoint directory recursively — with a success message. A missing target
   * printed the success constant too, because the failure check was gated on
   * the same `existsSync` as the fallback.
   *
   * The ordering below is the contract: VALIDATE -> REFUSE -> ACT. Every check
   * completes before the first side effect (the symlink unlinks are mutations
   * too), and `fs.rmSync` is reachable ONLY for a registered worktree strictly
   * inside `<root>/.worktrees` — never for an external path, registered or not.
   */
  public async removeWorktree(options: RemoveWorktreeOptions): Promise<void> {
    const workspace = await this.getRepoRoot(options.workspaceDir);
    const rawTarget = String(options.worktreePath ?? '').trim();

    // 0. An empty target is a caller bug, not a silent no-op (pre-fix: return).
    if (!rawTarget) {
      throw new WorktreeCleanupError(
        'removeWorktree',
        'A worktree path is required to remove a worktree.',
        { worktreePath: options.worktreePath }
      );
    }

    const resolvedTarget = path.resolve(rawTarget);
    const resolvedRoot = path.resolve(workspace);
    const worktreesDir = path.resolve(resolvedRoot, DEFAULT_WORKTREES_DIR);
    const insideWorktrees = isPathInsideRoot(resolvedTarget, worktreesDir);

    // 1. Issue #247 (S3): refuse the repository root — and any path that CONTAINS the
    // repository root — BEFORE any side effect (no symlink unlink, no git call,
    // no rmSync). Resolve-normalized equality/containment only, never stem matching.
    if (
      isRootWorkspace(resolvedTarget, resolvedRoot) ||
      isPathInsideRoot(resolvedRoot, resolvedTarget)
    ) {
      // `isPathInsideRoot(resolvedRoot, resolvedTarget)` means the root would be
      // deleted as a descendant of the target — an ancestor-kill.
      throw new WorktreeCleanupError(
        'removeWorktree',
        `Refusing to remove the repository root (or a path containing it) as a worktree: '${rawTarget}'.`,
        { worktreePath: rawTarget }
      );
    }

    // 2. Containment (#282): the operator command is scoped to
    // `<root>/.worktrees/<id>`. Anything else is refused unless the caller
    // explicitly opted into an external path — and even then, step 5 proves it
    // is registered to THIS repository. The old "external and disjoint"
    // whitelist is gone.
    if (!insideWorktrees && !options.allowExternal) {
      throw new WorktreeCleanupError(
        'removeWorktree',
        `Refusing to remove '${resolvedTarget}': it is outside the worktrees directory '${worktreesDir}'. Only worktrees this repository provisioned under that directory may be removed.`,
        { worktreePath: resolvedTarget }
      );
    }

    // 3. Existence (#282): a missing target is a FAILURE, never a success
    // message. Internal teardown may tolerate an already-deleted directory
    // (the commit gate / lifecycle teardown of a worktree removed out of band).
    if (!fs.existsSync(resolvedTarget)) {
      if (options.tolerateMissing) {
        if (options.prune !== false && !options.dryRun) {
          await this.pruneWorktrees({ workspaceDir: workspace });
        }
        return;
      }

      throw new WorktreeCleanupError(
        'removeWorktree',
        `Worktree path does not exist: '${resolvedTarget}' (it is not a live worktree of '${resolvedRoot}'). If it is still registered as a prunable worktree, run \`git worktree prune\` to drop the stale registration.`,
        { worktreePath: resolvedTarget }
      );
    }

    // 4. Symlink refusal (#282): `git worktree remove` and the recursive
    // delete both follow a symlink, so a link is never a worktree directory.
    let targetStat: fs.Stats | null = null;
    try {
      targetStat = fs.lstatSync(resolvedTarget);
    } catch {
      // The existence check above already succeeded; an unreadable entry is
      // treated as "not a symlink" and the ownership check below decides.
    }

    if (targetStat?.isSymbolicLink()) {
      throw new WorktreeCleanupError(
        'removeWorktree',
        `Refusing to remove '${resolvedTarget}': it is a symbolic link, not a worktree directory.`,
        { worktreePath: resolvedTarget }
      );
    }

    if (insideWorktrees) {
      try {
        const realTarget = fs.realpathSync(resolvedTarget);
        const realWorktreesDir = fs.existsSync(worktreesDir)
          ? fs.realpathSync(worktreesDir)
          : worktreesDir;
        if (!isPathInsideRoot(realTarget, realWorktreesDir)) {
          throw new WorktreeCleanupError(
            'removeWorktree',
            `Refusing to remove '${resolvedTarget}': it resolves outside the worktrees directory '${worktreesDir}' (symlink escape).`,
            { worktreePath: resolvedTarget }
          );
        }
      } catch (err) {
        if (err instanceof WorktreeCleanupError) throw err;
        throw new WorktreeCleanupError(
          'removeWorktree',
          `Refusing to remove '${resolvedTarget}': its real path could not be verified (${err instanceof Error ? err.message : String(err)}).`,
          { worktreePath: resolvedTarget }
        );
      }
    }

    // 5. Ownership (#282): only a path `git worktree list --porcelain` reports
    // — queried in THIS repository — may be deleted. One query, one answer:
    // a same-named worktree of another repository can never match.
    const registration = await this.findRegisteredWorktree(resolvedRoot, resolvedTarget);
    if (!registration.registered) {
      throw new WorktreeCleanupError(
        'removeWorktree',
        `Refusing to remove '${resolvedTarget}': it is not a registered git worktree of '${resolvedRoot}'. Use \`codeloop worktree clean\` for unregistered folders inside .worktrees.`,
        { worktreePath: resolvedTarget }
      );
    }
    if (registration.prunable) {
      throw new WorktreeCleanupError(
        'removeWorktree',
        `Refusing to remove '${resolvedTarget}': its registration is prunable. Run \`git worktree prune\` to drop the stale registration, then retry.`,
        { worktreePath: resolvedTarget }
      );
    }

    // 5b. Dry run (issue #248): every guard above has PASSED, so returning here
    // is a truthful prediction — a real invocation would delete this path.
    // Returning before step 6 is what makes the simulation non-destructive
    // (no symlink unlink, no `git worktree remove`, no rmSync, no prune).
    if (options.dryRun) {
      return;
    }

    // 6. Side effects — only now.
    // Safely remove symlinks before git worktree remove
    this.unlinkSymlink(path.join(resolvedTarget, 'node_modules'));
    this.unlinkSymlink(path.join(resolvedTarget, 'artifacts'));
    this.unlinkSymlink(path.join(resolvedTarget, DEFAULT_STATE_DIR));

    // Execute git worktree remove --force
    const removeRes = await this.commandExecutor.execute(
      `git worktree remove --force "${resolvedTarget}"`,
      { cwd: workspace }
    );

    // Issue #247 (S4): git refuses to remove the main working tree. That refusal
    // must surface BEFORE the fallback below — pre-fix, this exact scenario ran
    // `rmSync` on the repo root first, which made the final `existsSync` check
    // silently pass, so the deletion printed as success.
    const removalOutput = [removeRes.stderr, removeRes.stdout, removeRes.combinedOutput]
      .filter((chunk): chunk is string => typeof chunk === 'string' && chunk.length > 0)
      .join('\n');
    if (removeRes.exitCode !== 0 && /is a main working tree/.test(removalOutput)) {
      throw new WorktreeCleanupError(
        'removeWorktree',
        removeRes.stderr || removeRes.stdout || `Failed to remove git worktree at ${resolvedTarget}`,
        { worktreePath: resolvedTarget }
      );
    }

    // 7. Failure handling (#282): decided from `removed`, captured immediately
    // after git — never from an `existsSync` that a deletion we just performed
    // would make pass. The `rmSync` fallback exists only for a REGISTERED
    // in-`.worktrees` worktree git could not detach; it is unreachable for any
    // external path (AC-10).
    let removed = !fs.existsSync(resolvedTarget);
    if (removeRes.exitCode !== 0 && insideWorktrees && !removed) {
      try {
        fs.rmSync(resolvedTarget, { recursive: true, force: true });
      } catch {
        // Surfaced by the post-condition below.
      }
      removed = !fs.existsSync(resolvedTarget);
    }

    if (!removed) {
      throw new WorktreeCleanupError(
        'removeWorktree',
        removalOutput || `Failed to remove git worktree at ${resolvedTarget}`,
        { worktreePath: resolvedTarget }
      );
    }

    // Prune dangling references
    if (options.prune !== false) {
      await this.pruneWorktrees({ workspaceDir: workspace });
    }
  }

  /**
   * Answers "does THIS repository register `target` as a worktree, and is that
   * registration prunable?" from ONE `git worktree list --porcelain` run in
   * `workspace` (#282, the ownership check).
   *
   * Not routed through `listWorktrees`: that method filters the root out and,
   * unless asked, every external worktree — the ownership check must be able to
   * match any registered path, and must not depend on the filters.
   */
  private async findRegisteredWorktree(
    workspace: string,
    target: string
  ): Promise<{ registered: boolean; prunable: boolean }> {
    try {
      const res = await this.commandExecutor.execute('git worktree list --porcelain', {
        cwd: workspace
      });
      if (res.exitCode !== 0 || !res.stdout) return { registered: false, prunable: false };

      const resolvedTarget = path.resolve(target);
      let realTarget: string | null = null;
      try {
        realTarget = fs.realpathSync(resolvedTarget);
      } catch {
        realTarget = null;
      }

      for (const block of res.stdout.split(/\n\s*\n/)) {
        let wtPath = '';
        let prunable = false;

        for (const rawLine of block.split('\n')) {
          const line = rawLine.trim();
          if (line.startsWith('worktree ')) {
            wtPath = line.slice('worktree '.length).trim();
          } else if (line.startsWith('prunable')) {
            prunable = true;
          }
        }

        if (!wtPath) continue;
        const resolvedWtPath = path.resolve(wtPath);

        let matches = isSamePath(resolvedWtPath, resolvedTarget);
        if (!matches && realTarget) {
          try {
            matches = isSamePath(fs.realpathSync(resolvedWtPath), realTarget);
          } catch {
            matches = false;
          }
        }

        if (matches) {
          return { registered: true, prunable };
        }
      }

      return { registered: false, prunable: false };
    } catch {
      // An unreadable registry is a REFUSAL, never a licence to delete.
      return { registered: false, prunable: false };
    }
  }

  /**
   * Prunes dangling worktrees via git worktree prune.
   */
  public async pruneWorktrees(options?: PruneWorktreesOptions): Promise<void> {
    const workspace = await this.getRepoRoot(options?.workspaceDir);
    const cmd = options?.expire
      ? `git worktree prune --expire "${options.expire}"`
      : 'git worktree prune';

    await this.commandExecutor.execute(cmd, { cwd: workspace });
  }

  /**
   * Lists active worktrees registered in the git repository.
   */
  public async listWorktrees(options?: ListWorktreesOptions): Promise<readonly WorktreeDescriptor[]> {
    const workspace = await this.getRepoRoot(options?.workspaceDir);
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
    const expectedPrefix = path.join(normalizedRoot, DEFAULT_WORKTREES_DIR) + path.sep;

    for (const block of blocks) {
      const lines = block.split('\n');
      let wtPath = '';
      let branchRef = '';
      let prunable = false;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.substring('worktree '.length).trim();
        } else if (line.startsWith('branch ')) {
          branchRef = line.substring('branch '.length).trim();
        } else if (line.startsWith('prunable')) {
          // #339 (item 5): git's own marker for a dead registration. The parser
          // used to drop it, so `list` called the row "active" while
          // `git worktree list` said `prunable`.
          prunable = true;
        }
      }

      if (!wtPath) continue;

      const normalizedWtPath = path.resolve(wtPath);
      // Skip the root primary workspace
      if (normalizedWtPath === normalizedRoot) {
        continue;
      }

      // Filter out external worktrees unless includeExternal is true
      if (!options?.includeExternal) {
        if (
          normalizedWtPath !== path.join(normalizedRoot, DEFAULT_WORKTREES_DIR) &&
          !normalizedWtPath.startsWith(expectedPrefix)
        ) {
          continue;
        }
      }

      const branch = branchRef.replace(/^refs\/heads\//, '') || 'HEAD';
      const taskId = path.basename(normalizedWtPath);

      // `isIsolated` deliberately stays `true`: these descriptors ARE isolated
      // worktrees (the label defect was "active", not "isolated") and the flag
      // gates commit teardown and abort — widening it would change behaviour no
      // AC asks for.
      descriptors.push(
        new WorktreeDescriptor({
          taskId,
          worktreePath: normalizedWtPath,
          branch,
          baseBranch: 'HEAD',
          isIsolated: true,
          prunable
        })
      );
    }

    return descriptors;
  }

  /**
   * Cleans orphaned or stale worktrees/locks and returns count pruned.
   */
  public async cleanOrphanedWorktrees(options?: CleanOrphanedOptions): Promise<number> {
    const dryRun = options?.dryRun === true;
    const workspace = await this.getRepoRoot(options?.workspaceDir);
    const initialList = await this.listWorktrees({ workspaceDir: workspace, includeExternal: true });
    // #339 (item 5): captured BEFORE any mutation. One shared predicate — a git
    // `prunable` registration — now drives BOTH paths. The old dry run diffed
    // registrations only AFTER the real prune, so a `prunable` row could never
    // be visible to the prediction until it was already gone: predict 0, remove 1.
    const prunableRegs = initialList.filter((w) => w.prunable === true);
    if (!dryRun) {
      await this.pruneWorktrees({ workspaceDir: workspace });
    }

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
            // A dry run COUNTS the orphan it would remove — it never calls
            // `rmSync`, so the directory survives (#248 AC-248.6).
            if (dryRun) {
              cleaned++;
              continue;
            }
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

    // Subagent external worktree pruning & garbage collection
    if (options?.subagents || options?.all) {
      const allWorktrees = await this.listWorktrees({ workspaceDir: workspace, includeExternal: true });
      const currentCwd = path.resolve(process.cwd());

      for (const wt of allWorktrees) {
        const normalizedWtPath = path.resolve(wt.worktreePath);
        // Safeguard current process working directory
        if (normalizedWtPath === currentCwd) {
          continue;
        }

        const isSubagent =
          normalizedWtPath.includes('.gemini/antigravity/brain/') ||
          normalizedWtPath.includes('.system_generated/worktrees/') ||
          options?.all === true;

        if (isSubagent) {
          if (dryRun) {
            cleaned++;
            continue;
          }
          try {
            await this.removeWorktree({
              worktreePath: normalizedWtPath,
              workspaceDir: workspace,
              force: true,
              prune: true,
              // These are REGISTERED external subagent worktrees (they came
              // from `git worktree list`), so the containment default must be
              // waived for them — but only for them (#282).
              allowExternal: true
            });
            cleaned++;
          } catch {
            // Non-fatal if removal fails
          }
        }
      }
    }

    if (dryRun) {
      // The directory/external counters above already counted every directory
      // the real run would `rmSync`; add the dead registrations the real run's
      // `git worktree prune` would clear. Parity holds in both audit shapes:
      // dir gone + `prunable` registration -> 1 and 1; orphan dir only -> 1 and 1.
      return cleaned + prunableRegs.length;
    }
    await this.pruneWorktrees({ workspaceDir: workspace });
    const finalList = await this.listWorktrees({ workspaceDir: workspace, includeExternal: true });
    const diff = Math.max(0, initialList.length - finalList.length);
    const prunableRemoved = prunableRegs.filter(
      (w) => !finalList.some((f) => f.worktreePath === w.worktreePath)
    ).length;
    return Math.max(cleaned + prunableRemoved, diff);
  }

  /**
   * Stashes or quarantines dirty changes in a worktree to prevent data loss.
   *
   * Atomic per worktree and evidence-returning (issue #266 AC-4 / AC-6):
   *
   *   - a failed dirty probe is `failed`, never `clean`;
   *   - a failed `git stash push` is `failed`, never `quarantined`;
   *   - branch mode checks each of its three steps;
   *   - a success returns the ONLY recovery reference an operator can use:
   *     `stash@{n}` for `git stash pop`, or the quarantine branch name.
   *
   * Every interpolated token is shell-quoted, so a task id can never execute.
   */
  public async quarantineWorktree(options: {
    worktreePath: string;
    taskId?: string | number;
    quarantineBranch?: boolean;
    workspaceDir?: string;
  }): Promise<QuarantineWorktreeResult> {
    const wtPath = path.resolve(options.worktreePath);
    if (!fs.existsSync(wtPath)) {
      return { quarantined: false, outcome: 'missing' };
    }

    // Check if worktree is dirty. A probe that FAILS is not "clean": reporting
    // it as clean would silently leave the work where it is (AC-6).
    const statusRes = await this.commandExecutor.execute('git status --porcelain', {
      cwd: wtPath
    });
    if (statusRes.exitCode !== 0) {
      return {
        quarantined: false,
        outcome: 'failed',
        error: (statusRes.stderr || statusRes.stdout || 'git status failed').trim()
      };
    }
    const isDirty = Boolean(statusRes.stdout && statusRes.stdout.trim().length > 0);
    if (!isDirty) {
      return { quarantined: false, outcome: 'clean' };
    }

    const taskId = options.taskId ?? path.basename(wtPath);
    const timestamp = Date.now();

    if (options.quarantineBranch) {
      const qBranch = `quarantine/task-${taskId}-${timestamp}`;
      const checkoutRes = await this.commandExecutor.execute(
        `git checkout -b ${shellQuote(qBranch)}`,
        { cwd: wtPath }
      );
      if (checkoutRes.exitCode !== 0) {
        return {
          quarantined: false,
          outcome: 'failed',
          branch: qBranch,
          error: (checkoutRes.stderr || checkoutRes.stdout || 'git checkout -b failed').trim()
        };
      }
      const addRes = await this.commandExecutor.execute('git add -A', { cwd: wtPath });
      if (addRes.exitCode !== 0) {
        return {
          quarantined: false,
          outcome: 'failed',
          branch: qBranch,
          error: (addRes.stderr || addRes.stdout || 'git add -A failed').trim()
        };
      }
      const commitRes = await this.commandExecutor.execute(
        `git commit -m ${shellQuote(
          `quarantine: automated emergency abort checkpoint for task ${taskId}`
        )}`,
        { cwd: wtPath }
      );
      if (commitRes.exitCode !== 0) {
        return {
          quarantined: false,
          outcome: 'failed',
          branch: qBranch,
          error: (commitRes.stderr || commitRes.stdout || 'git commit failed').trim()
        };
      }
      return { quarantined: true, outcome: 'branch', branch: qBranch };
    }

    // Default: git stash
    const stashMsg = `quarantine-abort-task-${taskId}-${timestamp}`;
    const stashRes = await this.commandExecutor.execute(
      `git stash push -u -m ${shellQuote(stashMsg)}`,
      { cwd: wtPath }
    );
    if (stashRes.exitCode !== 0) {
      return {
        quarantined: false,
        outcome: 'failed',
        stashed: false,
        error: (stashRes.stderr || stashRes.stdout || 'git stash push failed').trim()
      };
    }

    // Resolve the ref the operator can actually `git stash pop`. The stash list
    // is repository-wide, so a concurrent push shifts `stash@{0}`: the message
    // is the only stable handle.
    let stashRef: string | undefined;
    try {
      const list = await this.commandExecutor.execute(
        'git stash list --format="%gd%x00%s"',
        { cwd: wtPath }
      );
      if (list.exitCode === 0) {
        stashRef =
          (list.stdout || '')
            .split('\n')
            .map((line) => line.split('\x00'))
            // `%s` for a stash is `On <branch>: <message>` (or `WIP on …`).
            .find(
              ([, subject]) => typeof subject === 'string' && subject.endsWith(stashMsg)
            )?.[0]
            ?.trim() || undefined;
      }
    } catch {
      // Non-fatal: the message still lets the operator find the stash.
    }

    return {
      quarantined: true,
      outcome: 'stashed',
      stashed: true,
      stashRef,
      stashMessage: stashMsg
    };
  }

  /**
   * Clears stale .git/index.lock if present.
   */
  public async clearIndexLock(workspaceDir?: string): Promise<boolean> {
    const workspace = await this.getRepoRoot(workspaceDir);
    const gitDir = path.join(workspace, '.git');
    let indexLockPath = path.join(gitDir, 'index.lock');

    try {
      if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
        const gitContent = fs.readFileSync(gitDir, 'utf8');
        const match = gitContent.match(/gitdir:\s*(.+)/i);
        if (match && match[1]) {
          indexLockPath = path.join(path.resolve(workspace, match[1].trim()), 'index.lock');
        }
      }

      if (fs.existsSync(indexLockPath)) {
        fs.unlinkSync(indexLockPath);
        return true;
      }
    } catch {
      // Non-fatal
    }

    return false;
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
   * Deletes a local branch (issue #420).
   *
   * Provenance is the caller's responsibility: this method only refuses what it
   * can prove must survive — a blank name and a branch currently checked out in
   * ANY worktree (root included). The worktree probe runs first so a held branch
   * fails with a precise diagnosis instead of git's "used by worktree" text.
   */
  public async deleteBranch(options: DeleteBranchOptions): Promise<void> {
    const branchName = String(options.branchName ?? '').trim();
    if (!branchName) {
      throw new WorktreeError('deleteBranch', 'Branch name is required.');
    }

    const workspace = await this.getRepoRoot(options.workspaceDir);
    const holder = await this.findWorktreeForBranch(workspace, branchName);
    if (holder) {
      throw new WorktreeError(
        'deleteBranch',
        `Branch '${branchName}' is checked out in the worktree at ${holder.worktreePath}; refusing to delete it.`
      );
    }

    const res = await this.commandExecutor.execute(`git branch -D -- ${shellQuote(branchName)}`, {
      cwd: workspace
    });

    if (res.exitCode !== 0) {
      throw new WorktreeError(
        'deleteBranch',
        (res.stderr || res.stdout || `Failed to delete branch '${branchName}'`).trim()
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

    if (res.exitCode !== 0) {
      // Issue #315 (AC-28 / #294): a FAILED `git log` is not an empty range.
      // Returning `[]` here made an unresolvable ref read as "nothing to
      // release" — a success-shaped answer for a git failure. An empty but
      // VALID range still returns `[]` below.
      const detail = (res.stderr || res.stdout || 'git log exited non-zero').trim();
      throw new WorktreeError(
        'getCommitsBetween',
        `Cannot resolve ref range '${options.baseBranch}..${options.headBranch}': ${detail}`
      );
    }

    if (!res.stdout.trim()) {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ancestorBranch = options.ancestorBranch || (options as any).ancestor || '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  private linkAgyloopStateIfPresent(workspace: string, worktreePath: string): void {
    try {
      const rootAgyloop = path.join(workspace, DEFAULT_STATE_DIR);
      const targetAgyloop = path.join(worktreePath, DEFAULT_STATE_DIR);

      // AFTER: Guard self-referential symlinks when root and target are identical
      const resolvedRoot = path.resolve(rootAgyloop);
      const resolvedTarget = path.resolve(targetAgyloop);

      if (resolvedRoot === resolvedTarget) {
        // We are at root / no worktree active: ensure it's a real directory
        // If it's already a symlink (e.g. pre-existing self-referential or broken symlink),
        // fs.existsSync returns false and fs.mkdirSync throws ELOOP unless unlinked.
        try {
          if (fs.lstatSync(resolvedTarget).isSymbolicLink()) {
            fs.unlinkSync(resolvedTarget);
          }
        } catch {
          // Entry doesn't exist, proceed
        }

        if (!fs.existsSync(resolvedTarget)) {
          fs.mkdirSync(resolvedTarget, { recursive: true });
        }
      } else {
        // Ensure root .agyloop exists before symlinking
        if (!fs.existsSync(resolvedRoot)) {
          fs.mkdirSync(resolvedRoot, { recursive: true });
        }

        // In a worktree: safely link target -> root
        if (!fs.existsSync(targetAgyloop)) {
          // If a broken or leftover symlink exists, unlink it first
          try {
            if (fs.lstatSync(targetAgyloop).isSymbolicLink()) {
              fs.unlinkSync(targetAgyloop);
            }
          } catch {
            // Path doesn't exist, proceed
          }

          // Ensure parent directory exists before symlinking
          const parentDir = path.dirname(targetAgyloop);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }

          fs.symlinkSync(rootAgyloop, targetAgyloop, process.platform === 'win32' ? 'junction' : 'dir');
        }
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
