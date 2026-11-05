/**
 * codeloop - ONE canonical StateRepository double (issue #544 / AC2)
 *
 * Retires the divergent spellings `StateRepositoryDouble` / `StateRepositoryDouble` /
 * `MockStateStore`-family copies. The one class is declared
 * `implements StateRepository` so the next port-method addition is ONE compile
 * error plus the conformance test at tests/architecture/fake-port-conformance
 * — not 35 silent test files. The drift the issue measured
 * (`getStateFilePath` present in one spelling only) cannot reproduce here.
 *
 * Recording is always on (no second `Recording...` class): every port method
 * logs into `this.calls`, and the fields suites assert are canonical
 * (`saveCount` — the retired `saveCallCount` adverb; `savedSnapshot`).
 *
 * Erasable-TS-only: no parameter properties, no enum, no namespace.
 */

import type { StateRepository } from '../../../src/ports';
import type { StateMachineSnapshot } from '../../../src/domain';

interface FakeStateRepositoryOptions {
  /** The snapshot `load()` returns before any save. */
  initialSnapshot?: StateMachineSnapshot | null;
  /** Canonical checkpoint path `getStateFilePath()` reports. */
  stateFilePath?: string;
  /**
   * Extra task checkpoints for listAllStatements-style reads during reset-all
   * tests: path -> snapshot.
   */
  extraCheckpoints?: Record<string, StateMachineSnapshot | null>;
}

type SnapshotOrNull = StateMachineSnapshot | null;

class FakeStateRepository implements StateRepository {
  /** Every port method records here (`calls.save[0]` = first saved snapshot). */
  public calls: Record<string, unknown[]> = {
    load: [],
    save: [],
    reset: [],
    resetTask: [],
    resetAll: [],
    listAllStates: [],
    forIssue: [],
    getStateFilePath: []
  };

  /** Canonical alias for the retired `saveCallCount`. */
  public saveCount = 0;
  public resetTaskCount = 0;
  public resetAllCount = 0;
  /** What resetTask ACTUALLY removed (the #250 honesty contract). */
  public removedTasks: string[] = [];
  /** path -> snapshot, shared by forIssue-scoped siblings. */
  public readonly store: Map<string, SnapshotOrNull>;
  /** Canonical path the SCOPE of this double addresses. */
  public readonly stateFilePath: string;
  /** The task issue the scope addresses, or null for the root singleton. */
  public readonly scopedIssue: number | string | null = null;

  constructor(options: FakeStateRepositoryOptions = {}, sharedStore?: Map<string, SnapshotOrNull>) {
    this.stateFilePath = options.stateFilePath ?? '/mock/workspace/.agyloop/state.json';
    this.scopedIssue = null;
    this.store = sharedStore ?? new Map<string, SnapshotOrNull>();
    if (options.initialSnapshot !== undefined) {
      this.store.set(this.stateFilePath, options.initialSnapshot ?? null);
    }
    if (options.extraCheckpoints) {
      for (const [file, snapshot] of Object.entries(options.extraCheckpoints)) {
        this.store.set(file, snapshot ?? null);
      }
    }
  }

  /** Canonical snapshot alias — same storage the retired spellings had. */
  public get savedSnapshot(): SnapshotOrNull {
    return this.store.get(this.stateFilePath) ?? null;
  }

  public set savedSnapshot(snapshot: SnapshotOrNull) {
    this.store.set(this.stateFilePath, snapshot);
  }

  public load(): Promise<SnapshotOrNull> {
    this.calls.load.push([]);
    return Promise.resolve(this.savedSnapshot);
  }

  public save(snapshot: StateMachineSnapshot): Promise<void> {
    this.calls.save.push([snapshot]);
    this.saveCount++;
    this.savedSnapshot = snapshot;
    return Promise.resolve();
  }

  public reset(): Promise<void> {
    this.calls.reset.push([]);
    this.store.set(this.stateFilePath, null);
    return Promise.resolve();
  }

  public resetTask(issue: number): Promise<boolean> {
    this.calls.resetTask.push([issue]);
    this.resetTaskCount++;
    const file = `/mock/workspace/.agyloop/tasks/${issue}.json`;
    if (this.store.has(file)) {
      this.store.delete(file);
      this.removedTasks.push(String(issue));
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  public resetAll(): Promise<void> {
    this.calls.resetAll.push([]);
    this.resetAllCount++;
    for (const file of Array.from(this.store.keys())) {
      this.store.delete(file);
    }
    return Promise.resolve();
  }

  public getStateFilePath(): string {
    this.calls.getStateFilePath.push([]);
    return this.stateFilePath;
  }

  public listAllStates(): Promise<StateMachineSnapshot[]> {
    this.calls.listAllStates.push([]);
    const snapshots: StateMachineSnapshot[] = [];
    for (const snapshot of this.store.values()) {
      if (snapshot !== null) snapshots.push(snapshot);
    }
    return Promise.resolve(snapshots);
  }

  /**
   * A repository scoped to `issue`'s task checkpoint — same store, so the
   * resolver's load/write-what-it-reads invariant is observable in tests.
   */
  public forIssue(issue: number | string): FakeStateRepository {
    this.calls.forIssue.push([issue]);
    const scoped = new FakeStateRepository(
      {
        stateFilePath: `/mock/workspace/.agyloop/tasks/${issue}.json`
      },
      this.store
    );
    return scoped;
  }
}

function createFakeStateRepository(options?: FakeStateRepositoryOptions): FakeStateRepository {
  return new FakeStateRepository(options ?? {});
}

module.exports = { FakeStateRepository, createFakeStateRepository };
