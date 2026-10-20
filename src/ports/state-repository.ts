/**
 * agyloop - StateRepository Port Interface
 *
 * Inversion of control interface for persisting and restoring StateMachine checkpoints.
 */

import { StateMachineSnapshot } from '../domain';

export interface StateRepository {
  /**
   * Loads the current state snapshot from storage, or null if no snapshot exists.
   */
  load(): Promise<StateMachineSnapshot | null> | StateMachineSnapshot | null;

  /**
   * Persists a state snapshot atomically.
   */
  save(snapshot: StateMachineSnapshot): Promise<void> | void;

  /**
   * Clears or removes the persisted checkpoint file.
   */
  reset(): Promise<void> | void;

  /**
   * Removes a specific task checkpoint (.agyloop/tasks/<issue>.json).
   *
   * The parameter is a NUMBER, not a string: a raw token must never reach a
   * filename template (issue #250) — `tasks/999abc.json` is not an issue
   * checkpoint. The return value reports whether a checkpoint file was ACTUALLY
   * removed, so a caller can tell "cleared" from "there was nothing to clear".
   */
  resetTask?(issue: number): Promise<boolean> | boolean;

  /**
   * Purges root state (.agyloop/state.json) and all task checkpoints (.agyloop/tasks/*.json).
   */
  resetAll?(): Promise<void> | void;

  /**
   * Returns the canonical path/URI of the state checkpoint file.
   */
  getStateFilePath(): string;

  /**
   * Scans and returns all known task snapshots and the singleton root snapshot if present.
   */
  listAllStates?(): Promise<StateMachineSnapshot[]> | StateMachineSnapshot[];

  /**
   * Returns a repository scoped to `issue`'s task checkpoint
   * (.agyloop/tasks/<issue>.json). The returned repository's `load`, `save` and
   * `getStateFilePath` ALL address that file, so a caller that resolves the task
   * first cannot read one file and write another.
   *
   * Optional, exactly like `resetTask` / `resetAll` / `listAllStates`: every
   * consumer must cope with `undefined` and degrade to the repository it already
   * holds.
   */
  forIssue?(issue: number | string): StateRepository;
}
