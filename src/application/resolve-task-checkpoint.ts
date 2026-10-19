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
 * Deliberately NOT adopted here: `GetNextActionUseCase` (its read/write contract is
 * pinned by #237's tests and its `--restart` policy already owns issue resolution)
 * and the diagnostic-only `branch-info` path. Both remain known, adjacent
 * inconsistencies, tracked as follow-ups.
 *
 * Purity: this module imports only `../domain` and `../ports`. It never touches
 * `fs`, `path` or `process.cwd()`; all filesystem knowledge is delegated through
 * the `StateRepository` port. `tests/architecture/hexagonal-boundaries.test.ts`
 * enforces that statically.
 */

import { StateMachineSnapshot, STAGE_COMPLETED } from '../domain';
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
 * the caller did not name one (or named something that is not an issue number).
 *
 * `null` means "the operator did not choose", which is what routes the caller into
 * the scan-based branch below rather than at a bogus task file.
 */
function explicitIssue(issue: number | string | null | undefined): number | null {
  if (issue === null || issue === undefined || issue === '') {
    return null;
  }
  const parsed = typeof issue === 'number' ? issue : Number.parseInt(issue.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Collects the checkpoint this call is allowed to treat as authoritative.
 *
 * - **Explicit issue** → `stateRepo.forIssue?.(n)` if available, else `stateRepo`
 *   (which is *already* issue-scoped when the CLI constructed it with `--issue`,
 *   `cli.ts:693`); `load()` from it; `path` from `getStateFilePath()`;
 *   `candidates: []` — no scan needed, the operator named the task.
 * - **No issue** → every checkpoint the workspace holds, ranked by
 *   `selectAuthoritativeCheckpoint`.
 *
 * Returns `null` when nothing readable exists, which callers must still render
 * (an empty repository has to produce a status, not an error).
 */
export async function resolveAuthoritativeCheckpoint(
  stateRepo: StateRepository,
  issue?: number | string | null
): Promise<ResolvedCheckpoint | null> {
  const requested = explicitIssue(issue);

  if (requested !== null) {
    const repo = stateRepo.forIssue ? stateRepo.forIssue(requested) : stateRepo;
    // An operator who NAMED the issue asked about THAT one file. A load that THROWS
    // here (`StateStorageError` from a corrupt parse — saves use a plain
    // `writeFileSync`, so a crash mid-write leaves a truncated file) must surface,
    // not be swallowed into a synthesized snapshot that pretends the stage is
    // something it is not. The error already carries the file path, so this load
    // is deliberately UNwrapped: let it propagate to the caller.
    const snapshot = await repo.load();
    if (!snapshot) {
      return null;
    }
    return {
      snapshot,
      issue: requested,
      path: repo.getStateFilePath(),
      candidates: []
    };
  }

  const candidates = await collectCandidates(stateRepo);
  const winner = selectAuthoritativeCheckpoint(candidates);
  if (!winner) {
    return null;
  }

  return {
    snapshot: winner.snapshot,
    issue: winner.issue,
    path: winner.path,
    candidates
  };
}

/**
 * Returns the repository the caller must BOTH read and write. This is the crux of
 * #226 D6: resolving the right path for display while calling `stateRepo.save()`
 * would write the cleared pause back to `.agyloop/state.json` and leave
 * `tasks/<n>.json` paused — the defect in a new shape.
 *
 * Explicit issue → `forIssue`; otherwise the authoritative winner is re-scoped via
 * `forIssue(resolved.issue)` when it has an issue and `forIssue` exists; a root
 * winner, a missing `forIssue`, or an empty workspace all degrade to `stateRepo`,
 * which is already correct for a root checkpoint.
 */
export async function resolveCheckpointRepository(
  stateRepo: StateRepository,
  issue?: number | string | null
): Promise<StateRepository> {
  const requested = explicitIssue(issue);
  if (requested !== null) {
    return stateRepo.forIssue ? stateRepo.forIssue(requested) : stateRepo;
  }

  if (typeof stateRepo.forIssue === 'function') {
    const resolved = await resolveAuthoritativeCheckpoint(stateRepo);
    if (resolved && resolved.issue !== null) {
      return stateRepo.forIssue(resolved.issue);
    }
  }

  return stateRepo;
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