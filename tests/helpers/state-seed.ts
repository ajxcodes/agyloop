/**
 * codeloop - canonical checkpoint seeding / reading (issue #544)
 *
 * ONE definition of the state-seed family. The write/read pair round-trips
 * through the REAL `FileStateRepository` shape — a seeded checkpoint is a
 * checkpoint the CLI itself would have written, never a bespoke dialect.
 *
 * Naming (the API the migration targets):
 *   - `checkpointPath(dir, issue?)`  — `.agyloop/tasks/<issue>.json`;
 *     omitting issue (or passing null) means the ROOT `.agyloop/state.json`.
 *   - `seedTask(dir, seed)`          — task checkpoint from a `TaskSeed`
 *     (partial `StateMachineSnapshot` + explicit `issue`), FULL field shape.
 *   - `seedCorruptTask(dir, issue)`  — the truncated-JSON bytes from
 *     cli-abort-triage-corrupt-checkpoint (#250).
 *   - `seedCheckpoint(dir, snapshot)`— a raw checkpoint under `.agyloop/tasks/`
 *     (NOT root state); returns its path.
 *   - `seedRootState(dir, snapshot)` — the root `.agyloop/state.json` singleton.
 *   - `readTaskCheckpoint(dir, issue)` / `readRootState(dir)` — parse those.
 *   - `readCheckpoint(stateFile)`    — the raw-parse-of-a-path shape (the 17
 *     local copies' dominant semantics).
 *
 * The `AppState` duck-type in suites like get-next-action-* is a REPO shape,
 * not a disk shape; those suites keep asserting through `readCheckpoint(path)`
 * rather than re-seeding mock state here.
 *
 * Erasable-TS-only: no parameter properties, no enum, no namespace.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The truncated bytes `seedCorruptTask` writes (a crash mid-write shape). */
const CORRUPT_TASK_BYTES = '{"currentStage":';

type TaskSeed = Record<string, unknown> & { issue: number | string };

function checkpointPath(dir: string, issue?: number | string | null): string {
  const agyDir = path.join(dir, '.agyloop');
  if (issue === undefined || issue === null) {
    return path.join(agyDir, 'state.json');
  }
  return path.join(agyDir, 'tasks', `${issue}.json`);
}

function readCheckpoint(stateFile: string): any {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function readTaskCheckpoint(dir: string, issue: number | string): any {
  return readCheckpoint(checkpointPath(dir, issue));
}

function readRootState(dir: string): any {
  return readCheckpoint(path.join(dir, '.agyloop', 'state.json'));
}

/**
 * Writes `.agyloop/tasks/<issue>.json` from a `TaskSeed`. The default shape is
 * the full `StateMachineSnapshot` field set exactly as the lifecycle and the
 * fixtures (`absorbed-contracts`/`resolve-task-checkpoint`) spell it, so a
 * seeded file loads through a real `FileStateRepository#load()` unchanged.
 */
function seedTask(dir: string, seed: TaskSeed): string {
  const taskPath = checkpointPath(dir, seed.issue);
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  const stage = (seed.currentStage as string | undefined) ?? 'INITIALIZED';
  const now = (seed.updatedAt as string | undefined) ?? (seed.createdAt as string | undefined);
  const full: Record<string, unknown> = {
    version: '1.0.0',
    currentStage: stage,
    mode: (seed.mode as string | undefined) ?? 'standard',
    issue: seed.issue,
    baseBranch: (seed.baseBranch as string | undefined) ?? 'main',
    createdAt: (seed.createdAt as string | undefined) ?? now,
    updatedAt: (seed.updatedAt as string | undefined) ?? (seed.createdAt as string | undefined),
    history: [{ stage, timestamp: now }]
  };
  Object.assign(full, seed);
  full.issue = seed.issue;
  if (seed.createdAt === undefined) {
    full.createdAt = full.updatedAt;
  }
  fs.writeFileSync(taskPath, JSON.stringify(full));
  return taskPath;
}

/** Corrupt/truncated task checkpoint fixture (#250: abort must not trust it). */
function seedCorruptTask(dir: string, issue: number | string): string {
  const taskPath = checkpointPath(dir, issue);
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(taskPath, CORRUPT_TASK_BYTES);
  return taskPath;
}

/**
 * Writes `snapshot` as the task checkpoint for its own `issue` field (falls
 * back to `dir`'s root `state.json` when the snapshot carries no issue).
 * `options.file` writes the caller's own absolute checkpoint path instead
 * (fixtures that own the file location); `options.defaults` are merged UNDER
 * the snapshot (the retired local `base` fixtures).
 */
function seedCheckpoint(
  dir: string,
  snapshot: Record<string, unknown>,
  options?: { file?: string; defaults?: Record<string, unknown> }
): string {
  const stateFile =
    options?.file ?? checkpointPath(dir, (snapshot.issue as number | string | null | undefined) ?? undefined);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ ...(options?.defaults ?? {}), ...snapshot }));
  return stateFile;
}

/** Writes the ROOT singleton `.agyloop/state.json`. */
function seedRootState(dir: string, snapshot: Record<string, unknown>): string {
  const stateFile = path.join(dir, '.agyloop', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(snapshot));
  return stateFile;
}

module.exports = {
  checkpointPath,
  readCheckpoint,
  readTaskCheckpoint,
  readRootState,
  seedTask,
  seedCorruptTask,
  seedCheckpoint,
  seedRootState
};
