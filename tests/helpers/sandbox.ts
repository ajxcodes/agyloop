/**
 * agyloop - canonical test sandbox (issue #544)
 *
 * ONE definition of the `makeSandbox` family: a throwaway git workspace the CLI
 * and use-cases can run in, with the git user config every CLI-based suite
 * needs to actually commit (`smoke@test` / `smoke` — the values the dominant
 * local copies pinned, see the TR-9 contract in
 * tests/architecture/helpers-contract.test.ts).
 *
 * Variant classes this one definition covers (measured at 0309f916):
 *   - `{ base, dir }` string-pair returns -> `sandbox.root` / `sandbox.dir`;
 *   - plain single-dir returns -> `sandbox.dir` (or `sandbox.path()`);
 *   - no-git fixtures -> `initGit: false`;
 *   - `.home`-inside-sandbox fixtures -> compose `seed:` on top;
 *   - custom seed commits (`chore: seed`, `chore: probe init`, …) and bare
 *     `git init` (NO commit) -> `initialCommit`;
 *   - bespoke stub-bin / sibling-worktree / checkpoint fixtures -> `seed:`.
 *
 * `.agyloop` checkpoint placement and task JSON are NOT this module's job:
 * compose `tests/helpers/state-seed.ts` after construction (the data flow
 * direction the plan freezes: `tests/**.test.ts -> tests/helpers/** -> dist`).
 *
 * Erasable-TS-only: no parameter properties, no enum, no namespace.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

/** The git identity the dominant sandbox copies pinned. */
const DEFAULT_USER = { email: 'smoke@test', name: 'smoke' };

interface TestSandboxOptions {
  /** mkdtempSync prefix, default 'agyloop-test-'. */
  prefix?: string;
  /** Subdirectory of the temp root that is the repo root. Default 'repo'; '' means dir === root. */
  dirName?: string;
  /** Default true: `git init -q` plus the user config below. */
  initGit?: boolean;
  /** Default smoke@test / smoke; `false` leaves no user config. */
  userConfig?: { email: string; name: string } | false;
  /**
   * Seed commit message. Default 'chore: sandbox init'; `null` = NO commit
   * (a HEAD-less repo) for the fixtures that relied on bare `git init`.
   */
  initialCommit?: string | null;
  /** Default ['.worktrees/']; `false` writes no .gitignore. */
  gitignore?: string[] | false;
  /**
   * Bespoke fixture hook (stub bins, sibling worktrees, .home trees, extra
   * files), run after git init/config/gitignore and BEFORE the seed commit —
   * so files the seed writes are COMMITTED by `initialCommit` when one is
   * requested. With `initGit: false` the seed is the only construction step.
   */
  seed?: (dir: string) => void;
  /** Initial branch name (`git init -b`); default the host default. */
  initialBranch?: string;
}

interface SandboxGitOptions {
  cwd?: string;
  stdio?: 'discard' | 'pipe';
}

interface TestSandbox {
  /** The mkdtemp'd temp root (sibling-escape targets live here). */
  readonly root: string;
  /** The repo root the CLI runs in. Default `root/repo`; `dirName: ''` -> `root`. */
  readonly dir: string;
  /** The canonical git wrapper: `sandbox.git(['config', ...])`. */
  git(args: readonly string[], options?: SandboxGitOptions): Buffer;
  /**
   * A git wrapper bound to a fixed cwd (the 22 local `function git(dir, args)`
   * / `const git = (args) => execFileSync(...)` copies):
   * `const git = sandbox.gitAt(dir); git(['add', '-A'])`.
   */
  gitAt(cwd: string): (args: readonly string[], options?: SandboxGitOptions) => Buffer;
  /** Absolute path under `dir`. */
  path(relative?: string): string;
  /** rmSync the temp root. */
  cleanup(): void;
}

function gitExec(cwd: string, args: readonly string[], options?: SandboxGitOptions): Buffer {
  return execFileSync('git', args as string[], {
    cwd,
    stdio: options?.stdio === 'pipe' ? 'pipe' : 'ignore'
  });
}

/**
 * The ONE git invocation surface for tests (the family the 22 local
 * `function git(` / `const git =` wrappers duplicated): files without a
 * `makeSandbox` fixture still come here, so the execFileSync semantics live in
 * this module alone. `encoding: 'utf8'` returns the output as a string.
 */
function gitIn(
  cwd: string,
  args: readonly string[],
  options?: SandboxGitOptions & { encoding?: BufferEncoding }
): Buffer | string {
  return execFileSync('git', args as string[], {
    cwd,
    stdio: options?.stdio === 'discard' ? 'ignore' : (options?.stdio ?? 'ignore'),
    ...(options?.encoding ? { encoding: options.encoding } : {})
  });
}

function makeSandbox(options?: TestSandboxOptions): TestSandbox {
  const opts = options ?? {};
  const prefix = opts.prefix ?? 'agyloop-test-';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dirName = opts.dirName === undefined ? 'repo' : opts.dirName;
  const dir = dirName === '' ? root : path.join(root, dirName);
  if (dirName !== '') {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (opts.initGit !== false) {
    const initArgs = ['init', '-q'];
    if (opts.initialBranch) {
      initArgs.push('-b', opts.initialBranch);
    }
    execFileSync('git', initArgs, { cwd: dir, stdio: 'ignore' });
    if (opts.userConfig !== false) {
      const user: { email: string; name: string } = { ...DEFAULT_USER, ...(opts.userConfig ?? {}) };
      execFileSync('git', ['config', 'user.email', user.email], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', user.name], { cwd: dir, stdio: 'ignore' });
    }
    const gitignore: string[] | null =
      opts.gitignore === false ? null : opts.gitignore ?? ['.worktrees/'];
    if (gitignore) {
      fs.writeFileSync(path.join(dir, '.gitignore'), gitignore.join('\n') + '\n', 'utf8');
    }
    if (opts.seed) {
      opts.seed(dir);
    }
    if (opts.initialCommit !== null) {
      const message = opts.initialCommit ?? 'chore: sandbox init';
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-qm', message], { cwd: dir, stdio: 'ignore' });
    }
  } else if (opts.seed) {
    opts.seed(dir);
  }

  const sandbox: TestSandbox = {
    root,
    dir,
    git(args: readonly string[], gitOptions?: SandboxGitOptions): Buffer {
      return gitExec(gitOptions?.cwd ?? dir, args, gitOptions);
    },
    gitAt(cwd: string): (args: readonly string[], gitOptions?: SandboxGitOptions) => Buffer {
      return (args: readonly string[], gitOptions?: SandboxGitOptions) =>
        gitExec(gitOptions?.cwd ?? cwd, args, gitOptions);
    },
    path(relative?: string): string {
      return relative === undefined ? dir : path.join(dir, relative);
    },
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  return sandbox;
}

/**
 * The non-throwing spawn shape the `gitOk`/`check-ignore` fixtures need:
 * `{ status, stdout, stderr }` — never throws on a non-zero git exit.
 */
function gitStatus(
  cwd: string,
  args: readonly string[],
  options?: SandboxGitOptions
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('git', args as string[], {
    cwd,
    stdio: options?.stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8'
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

module.exports = { makeSandbox, gitIn, gitStatus };
