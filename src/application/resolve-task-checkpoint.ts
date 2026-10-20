/**
 * agyloop - ResolveTaskCheckpoint (Application Layer)
 *
 * ONE rule for the question every lifecycle command used to answer differently:
 * *which checkpoint on disk is authoritative right now?*
 *
 * A workspace holds two kinds of checkpoint. The root `.agyloop/state.json` is the
 * singleton for ad-hoc runs; `.agyloop/tasks/<issue>.json` is the one a task run
 * owns. Before this resolver existed, `status`, `resume`, `next`, `branch-info`,
 * `halt`, `transition`, `implement` and `plan` each called `stateRepo.load()` and
 * each re-derived the root-vs-task question on its own. When no `--issue` was given
 * and the cwd carried no worktree/branch hint, every one of them fell back to the
 * root file — so a run checkpointed at `.agyloop/tasks/999.json` was reported by
 * `status` as `[INITIALIZED]`, and a bare `codeloop resume` declared "nothing to
 * resume" while that file stayed paused at `COMMIT` forever (#226 D5/D6).
 *
 * `ResetPipelineUseCase` was the only command that already took an explicit
 * `issue` and routed to `stateRepo.resetTask(issue)` — that is the precedent, and
 * this module generalises it to *reading* as well.
 *
 * Since #250 this module is the ONE answer to "which checkpoint is
 * authoritative, and which repository must be read AND written".
 * Every checkpoint-touching command routes through `resolveCheckpointScope`:
 * `status` and `resume` resolve internally, and `next`, `branch-info`,
 * `transition`, `halt`, `reset`, `implement`, `plan`, `yolo`, `commit`, `abort`,
 * `triage` and `sync` resolve the scope in the CLI and hand `scope.repo` to
 * their use cases. There is no longer a "diagnostic-only" exception.
 *
 * Purity: this module imports only `../domain` and `../ports`. It never touches
 * `fs`, `path` or `process.cwd()`; all filesystem knowledge is delegated through
 * the `StateRepository` port. `tests/architecture/hexagonal-boundaries.test.ts`
 * enforces that statically.
 */

import { StateMachineSnapshot, STAGE_COMPLETED, ValidationError, parseIssueToken } from '../domain';
import { StateRepository } from '../ports';

export interface CheckpointCandidate {
  readonly snapshot: StateMachineSnapshot;
  /** null = the root checkpoint (`.agyloop/state.json`). */
  readonly issue: number | null;
  readonly path: string;
  /** currentStage !== COMPLETED — i.e. this task still has work in flight. */
  readonly inFlight: boolean;
  /** ms epoch, 0 when unparseable — never NaN, which would poison the sort. */
  readonly updatedAt: number;
}

export interface ResolvedCheckpoint {
  readonly snapshot: StateMachineSnapshot;
  readonly issue: number | null;
  readonly path: string;
  readonly candidates: readonly CheckpointCandidate[];
}

/**
 * The ONE answer to "which checkpoint is authoritative, and which repository must
 * be read AND written" (issue #250).
 *
 * `repo` is the repository a caller must use for BOTH the read and the write.
 * Handing a use case the UNSCOPED repository while rendering the resolved path
 * is the defect in a new shape: `status` would advertise `tasks/999.json` while
 * `halt` wrote `.agyloop/state.json`.
 */
export interface CheckpointScope {
  /** The repository to use for BOTH reads and writes. */
  readonly repo: StateRepository;
  /** The authoritative snapshot, or null when no checkpoint exists. */
  readonly snapshot: StateMachineSnapshot | null;
  /** The issue the scope belongs to; null = the root checkpoint. */
  readonly issue: number | null;
  /** The absolute path of the resolved checkpoint. */
  readonly path: string;
  /** Every candidate the scan considered (empty for an explicit issue). */
  readonly candidates: readonly CheckpointCandidate[];
}

/**
 * Parses a snapshot's `updatedAt` into ms epoch, degrading to 0 rather than NaN.
 *
 * `NaN` would be catastrophic here: every comparison against it is false, so a
 * single corrupt timestamp would make the sort non-transitive and silently pick
 * whichever candidate the comparator happened to visit first.
 */
function toEpoch(updatedAt: string | null | undefined): number {
  if (!updatedAt) {
    return 0;
  }
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Ranks candidates by, in order:
 *   1. in flight (currentStage !== COMPLETED) beats completed — a finished task is
 *      not "work in flight" and must never outrank an active one just by recency;
 *   2. newest `updatedAt` first;
 *   3. lowest issue number first, so ties are deterministic across runs and hosts
 *      (never "whichever `readdirSync` returned first").
 * Root (issue === null) is ranked as a normal candidate — it wins on the same
 * rules, which is exactly what an issue-less run needs.
 *
 * The root sorts as `-1` on rule 3, i.e. ahead of every numbered task on a tie:
 * it is the workspace-wide singleton, and losing every tie to an arbitrarily
 * numbered task file would be strictly worse than the reverse.
 */
export function selectAuthoritativeCheckpoint(
  candidates: readonly CheckpointCandidate[]
): CheckpointCandidate | null {
  let best: CheckpointCandidate | null = null;

  for (const candidate of candidates) {
    if (best === null || outranks(candidate, best)) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Epoch usable for comparison. `toEpoch` already refuses to emit NaN, but the
 * rule re-normalises rather than trusting that: a NaN compares false against
 * everything, which makes the comparator non-transitive and silently picks
 * whichever candidate it visits first.
 */
function rankableEpoch(updatedAt: number): number {
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

/** Strict "candidate beats incumbent" test for the three ranking rules above. */
function outranks(candidate: CheckpointCandidate, incumbent: CheckpointCandidate): boolean {
  if (candidate.inFlight !== incumbent.inFlight) {
    return candidate.inFlight;
  }
  const candidateAt = rankableEpoch(candidate.updatedAt);
  const incumbentAt = rankableEpoch(incumbent.updatedAt);
  if (candidateAt !== incumbentAt) {
    return candidateAt > incumbentAt;
  }
  return (candidate.issue ?? -1) < (incumbent.issue ?? -1);
}

/**
 * Normalises an explicit `issue` parameter to a positive integer, or `null` when
 * the caller did not name one.
 *
 * `null` means "the operator did not choose", which is what routes the caller
 * into the scan-based branch below rather than at a bogus task file.
 *
 * The grammar is the ONE shared grammar (`parseIssueToken`, issue #250). The
 * lenient `Number.parseInt` this replaced took the LEADING digits of a token, so
 * `999abc` silently became issue 999 — indistinguishable from a deliberate
 * `999`, and the reason `status` read `tasks/999.json` while `halt` wrote the
 * root. An invalid token now THROWS (`ValidationError`) instead of degrading to
 * the scan; the CLI rejects such a token before it can reach here, so this is
 * defence in depth for direct use-case callers.
 */
function explicitIssue(issue: number | string | null | undefined): number | null {
  const parsed = parseIssueToken(issue);
  if (parsed.kind === 'invalid') {
    throw new ValidationError('issue', parsed.raw, parsed.message);
  }
  return parsed.kind === 'valid' ? parsed.issue : null;
}

/**
 * The ONE resolution: which checkpoint is authoritative, and which repository
 * must be read AND written (issue #250).
 *
 * | Input | `repo` | `snapshot` | `issue` | `path` |
 * |---|---|---|---|---|
 * | explicit issue `n` | `forIssue(n)` (or the repository itself when the adapter has no `forIssue`) | `await repo.load()` — UNWRAPPED | `n` | `repo.getStateFilePath()` |
 * | no issue, workspace non-empty | `forIssue(winner.issue)` when the winner is a task, else the repository | the winning snapshot | the winner's issue | the winner's path |
 * | no issue, empty workspace | the repository | `null` | `null` | `stateRepo.getStateFilePath()` |
 *
 * An explicit issue whose file does not exist still yields a TASK-SCOPED
 * repository with a `null` snapshot: `next --issue 999` on a fresh workspace
 * must CREATE `tasks/999.json`, exactly as before.
 *
 * > #### ⚠️ INVARIANT (a trap — read before implementing)
 * >
 * > **Every scope MUST be resolved from the SAME repository the CLI
 * > constructed.**
 * >
 * > `collectCandidates` adds the repository's *own* path to the candidate set,
 * > and the ROOT checkpoint is only a candidate when the repository IS the root.
 * > A repository already bound to `tasks/999.json` therefore yields the
 * > candidate set `{tasks/999} ∪ {tasks}` — **the root drops out** — while a
 * > root-bound repository yields `{root} ∪ {tasks}`. The two sets can rank
 * > differently (a newer root vs. an older in-flight task), so resolving a scope
 * > from an *already-scoped* repository can select a **different file** than
 * > `status`/`resume` select — reintroducing exactly the disagreement this
 * > issue removes.
 * >
 * > The repository the CLI constructs is root-capable only OUTSIDE a task
 * > worktree: `FileStateRepository` infers the issue from the cwd, so inside
 * > `.worktrees/<n>` it is bound to `tasks/<n>.json` and the root drops out of
 * > the candidate set for every command alike. That is a property of the ONE
 * > repository, not a disagreement between commands — which is exactly what the
 * > invariant below guarantees.
 * >
 * > Consequences, all mandatory:
 * > 1. `status` and `resume` keep receiving the **same** repository (they
 * >    resolve internally — re-resolving a scoped repository would re-run the
 * >    scan).
 * > 2. Every other command resolves its scope from the **same** `stateRepo` the
 * >    CLI constructs, and then hands `scope.repo` to its use cases.
 * > 3. `scope.repo` is only ever a **write** target; the scope is never
 * >    re-resolved from `scope.repo`.
 */
export async function resolveCheckpointScope(
  stateRepo: StateRepository,
  issue?: number | string | null
): Promise<CheckpointScope> {
  const requested = explicitIssue(issue);

  if (requested !== null) {
    const repo = stateRepo.forIssue ? stateRepo.forIssue(requested) : stateRepo;
    // An operator who NAMED the issue asked about THAT one file. A load that
    // THROWS here (`StateStorageError` from a corrupt parse — saves use a plain
    // `writeFileSync`, so a crash mid-write leaves a truncated file) must surface,
    // not be swallowed into a synthesized snapshot that pretends the stage is
    // something it is not. The error already carries the file path, so this load
    // is deliberately UNwrapped: let it propagate to the caller.
    const snapshot = await repo.load();
    return {
      repo,
      snapshot,
      issue: requested,
      path: repo.getStateFilePath(),
      candidates: []
    };
  }

  const candidates = await collectCandidates(stateRepo);
  const winner = selectAuthoritativeCheckpoint(candidates);
  if (!winner) {
    // An empty workspace still needs an answer: the repository itself, no
    // snapshot, and the repository's own path (the root checkpoint's path).
    return {
      repo: stateRepo,
      snapshot: null,
      issue: null,
      path: stateRepo.getStateFilePath(),
      candidates
    };
  }

  const repo =
    winner.issue !== null && stateRepo.forIssue ? stateRepo.forIssue(winner.issue) : stateRepo;

  return {
    repo,
    snapshot: winner.snapshot,
    issue: winner.issue,
    path: winner.path,
    candidates
  };
}

/**
 * Collects the checkpoint this call is allowed to treat as authoritative.
 *
 * A thin wrapper over `resolveCheckpointScope`, kept for the callers that only
 * need the ANSWER (which file, which snapshot) and not the repository to write
 * through. Its contract is unchanged: `null` when nothing readable exists,
 * which callers must still render (an empty repository has to produce a status,
 * not an error).
 */
export async function resolveAuthoritativeCheckpoint(
  stateRepo: StateRepository,
  issue?: number | string | null
): Promise<ResolvedCheckpoint | null> {
  const scope = await resolveCheckpointScope(stateRepo, issue);
  if (scope.snapshot === null) {
    return null;
  }
  return {
    snapshot: scope.snapshot,
    issue: scope.issue,
    path: scope.path,
    candidates: scope.candidates
  };
}

/**
 * Returns the repository the caller must BOTH read and write. This is the crux of
 * #226 D6: resolving the right path for display while calling `stateRepo.save()`
 * would write the cleared pause back to `.agyloop/state.json` and leave
 * `tasks/<n>.json` paused — the defect in a new shape.
 *
 * A thin wrapper over `resolveCheckpointScope`: explicit issue → `forIssue`;
 * otherwise the authoritative winner is re-scoped via `forIssue(resolved.issue)`
 * when it has an issue and `forIssue` exists; a root winner, a missing
 * `forIssue`, or an empty workspace all degrade to `stateRepo`, which is
 * already correct for a root checkpoint.
 */
export async function resolveCheckpointRepository(
  stateRepo: StateRepository,
  issue?: number | string | null
): Promise<StateRepository> {
  const scope = await resolveCheckpointScope(stateRepo, issue);
  return scope.repo;
}

/**
 * Every checkpoint the workspace holds, each one paired with the file it came from.
 *
 * `listAllStates()` deliberately returns the root snapshot and all task snapshots
 * in ONE array with no provenance — its signature cannot say which file produced
 * which snapshot — and a ROOT checkpoint may itself carry an `issue` number (a run
 * parked at `.agyloop/state.json` before task scoping existed, or any command
 * invoked without `--issue` from the workspace root). So the array's snapshots are
 * treated only as a *list of issue numbers to look for*:
 *
 *   - each task checkpoint is re-read through `forIssue(issue)`, which makes the
 *     snapshot and the path provably the same file;
 *   - the repository's own checkpoint is added on top, and classified as a task
 *     checkpoint by comparing its path against those task paths — string equality
 *     on adapter-provided paths, never path parsing in the application layer.
 *
 * A test double that implements neither optional method still works: step 1 alone
 * contributes the repository's own checkpoint.
 */
async function collectCandidates(stateRepo: StateRepository): Promise<CheckpointCandidate[]> {
  const byPath = new Map<string, CheckpointCandidate>();

  // Task paths first, so the repository's own path can be classified exactly.
  const taskPaths = new Map<number, string>();
  const canScan = typeof stateRepo.forIssue === 'function' &&
    typeof stateRepo.listAllStates === 'function';

  if (canScan) {
    for (const snapshot of (await stateRepo.listAllStates!()) ?? []) {
      const issue = taskIssue(snapshot);
      if (issue !== null && !taskPaths.has(issue)) {
        taskPaths.set(issue, stateRepo.forIssue!(issue).getStateFilePath());
      }
    }
  }

  const ownPath = stateRepo.getStateFilePath();
  // The root checkpoint participates in the same tolerance: a corrupt
  // `.agyloop/state.json` parses to nothing in `listAllStates()`'s terms but
  // THROWS from `load()` here. A candidate we cannot load is not evidence, and
  // one unparseable file must not reject the whole workspace scan.
  let own: StateMachineSnapshot | null = null;
  try {
    own = await stateRepo.load();
  } catch {
    // Corrupt root JSON — drop it on the same terms as an unreadable candidate.
  }
  if (own?.currentStage) {
    const ownIssue = findIssueByPath(taskPaths, ownPath);
    byPath.set(ownPath, toCandidate(own, ownIssue, ownPath));
  }

  for (const [issue, taskPath] of taskPaths) {
    if (byPath.has(taskPath)) {
      // Already covered — this is either the repository's own checkpoint or a path
      // a previous iteration of this loop produced.
      continue;
    }
    let scopedSnapshot: StateMachineSnapshot | null = null;
    try {
      scopedSnapshot = await stateRepo.forIssue!(issue).load();
    } catch {
      // A corrupt task file throws (`StateStorageError`) where a missing one
      // merely returns null below — but the rule is the same for every way a
      // load can fail: a candidate we cannot load is not evidence, so the scan
      // drops this one candidate instead of rejecting everything it proved.
    }
    if (!scopedSnapshot?.currentStage) {
      // `listAllStates` reported an issue whose task file is not readable from
      // here. Dropping it is honest: a candidate we cannot load is not evidence.
      continue;
    }
    byPath.set(taskPath, toCandidate(scopedSnapshot, issue, taskPath));
  }

  return Array.from(byPath.values());
}

/** Task issue number carried by a snapshot, or null when it names none. */
function taskIssue(snapshot: StateMachineSnapshot | null | undefined): number | null {
  return typeof snapshot?.issue === 'number' && Number.isSafeInteger(snapshot.issue)
    ? snapshot.issue
    : null;
}

/** The issue whose task checkpoint lives at exactly `targetPath`, else null. */
function findIssueByPath(taskPaths: ReadonlyMap<number, string>, targetPath: string): number | null {
  for (const [issue, taskPath] of taskPaths) {
    if (taskPath === targetPath) {
      return issue;
    }
  }
  return null;
}

/** Builds one candidate from a raw snapshot and the file it provably came from. */
function toCandidate(snapshot: StateMachineSnapshot, issue: number | null, path: string): CheckpointCandidate {
  return {
    snapshot,
    issue,
    path,
    inFlight: snapshot.currentStage !== STAGE_COMPLETED,
    updatedAt: toEpoch(snapshot.updatedAt)
  };
}