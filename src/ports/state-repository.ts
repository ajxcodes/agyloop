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
   */
  resetTask?(issue: number | string): Promise<void> | void;

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
}
