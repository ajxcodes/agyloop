/**
 * agyloop - Baseline command cwd-contract detector (issue #418)
 *
 * `assertPlanBaselineContract` executes every `### Baseline Evidence` command
 * with `cwd = params.workspaceDir`, and the two surfaces that call it pass
 * directories on opposite sides of the worktree boundary:
 *
 *   - `transition APPROVAL` / `transition IMPLEMENT` measure in the operator's
 *     workspace (`params.workspaceDir || process.cwd()`) — no worktree exists
 *     yet, because worktrees are provisioned on entering IMPLEMENT;
 *   - `codeloop implement` measures in the task worktree, which is a pristine
 *     checkout with NO build output (`dist/` and `build/` are git-ignored).
 *
 * A claim that resolves the workspace's build output (`require("./dist/domain")`,
 * `node ./dist/…`, `--outDir ./dist`) therefore passes at the operator's root —
 * where `dist/` exists because it is the build the installed `codeloop` runs —
 * and is refused moments later in the worktree. The approval gate certifies a
 * plan the next stage refuses, and the only recovery is to hand-edit the
 * APPROVED artifact.
 *
 * This is the cheapest fix that holds: a PURE text detector that refuses a
 * build-output-resolving command BEFORE anything executes, so the verdict is a
 * function of the command alone and is identical at both call sites. It mirrors
 * `root-build-command.ts` and names the matched construct so the refusal can
 * tell the author which part of the command to rewrite.
 *
 * Conservative by design. It matches workspace-RELATIVE build output only:
 *
 *   - `./dist`, `./build` as a path token (`require("./dist/domain")`);
 *   - a workspace-relative `--outDir dist` / `--outDir=./build/`;
 *   - `cd dist`, `cd ./build`;
 *   - `node dist/…`, `ts-node build/…`, `tsx dist/…`.
 *
 * Residual, NAMED rather than silently claimed as covered: a claim can still
 * depend on the directory without naming build output — `ls dist`,
 * `grep -rl "dist/" src`, a bare specifier (`require("dist/domain")`),
 * `./dist-check/…`, a variable-indirected path (`D=dist; node $D/x.js`), a
 * build hidden behind `node scripts/build.mjs`, or an absolute path that
 * differs per checkout. `BASELINE_COMMAND_CWD_CONTRACT` states the rule for
 * those; this detector only enforces the enumerated shapes.
 *
 * No imports, no I/O.
 */

export interface WorkspaceBuildOutputMatch {
  /** The offending construct, e.g. `./dist`, `--outDir dist`, `cd dist`, `node dist/`. */
  readonly label: string;
  /** The normalised command, truncated for a refusal message. */
  readonly excerpt: string;
}

const MAX_EXCERPT_LENGTH = 160;

/** A workspace-relative `./dist` / `./build` path token. */
const RELATIVE_BUILD_OUTPUT = /(?:^|[\s'"=:(])\.\/(dist|build)(?=[/\s'"`);&|]|$)/;
/** A workspace-relative `--outDir dist` / `--outDir=./build/`. */
const WORKSPACE_OUT_DIR = /--outDir(?:=|\s+)['"]?(?:\.\/)?(dist|build)(?=[/\s'"`);&|]|$)/;
/** `cd dist` / `cd ./build`. */
const CD_INTO_BUILD_OUTPUT = /\bcd\s+(?:\.\/)?(dist|build)(?=[/\s'"`);&|]|$)/;
/** `node dist/…`, `ts-node build/…`, `tsx dist/…` (no `./` prefix). */
const EXECUTABLE_IN_BUILD_OUTPUT = /\b(node|ts-node|tsx)\s+(?:\.\/)?(dist|build)\//;

function normalise(command: string): string {
  return String(command ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string): string {
  return text.length > MAX_EXCERPT_LENGTH ? `${text.slice(0, MAX_EXCERPT_LENGTH)}…` : text;
}

/**
 * Returns the workspace build-output construct the command resolves, or `null`.
 *
 * The expressions are non-global (no `lastIndex` state) and are tested in the
 * documented order, so two consecutive calls on the same command always return
 * the same result.
 */
export function detectWorkspaceBuildOutputCommand(
  command: string
): WorkspaceBuildOutputMatch | null {
  const normalised = normalise(command);
  if (normalised.length === 0) return null;

  const relative = RELATIVE_BUILD_OUTPUT.exec(normalised);
  if (relative) return { label: `./${relative[1]}`, excerpt: truncate(normalised) };

  const outDir = WORKSPACE_OUT_DIR.exec(normalised);
  if (outDir) return { label: `--outDir ${outDir[1]}`, excerpt: truncate(normalised) };

  const cd = CD_INTO_BUILD_OUTPUT.exec(normalised);
  if (cd) return { label: `cd ${cd[1]}`, excerpt: truncate(normalised) };

  const executable = EXECUTABLE_IN_BUILD_OUTPUT.exec(normalised);
  if (executable) {
    return { label: `${executable[1]} ${executable[2]}/`, excerpt: truncate(normalised) };
  }

  return null;
}
