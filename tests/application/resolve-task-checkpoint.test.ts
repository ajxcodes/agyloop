/**
 * agyloop - The one shared task-checkpoint resolver's ranking rule (#226 D5/D6)
 *
 * `selectAuthoritativeCheckpoint` is pure: no I/O, no mocks, no clock. That is the
 * whole point of splitting it out of `resolveAuthoritativeCheckpoint` — if the
 * ranking is wrong, `resume` clears the pause of the WRONG task, and the only way
 * to be confident about that is to pin the rule itself exhaustively.
 *
 * The rules under test, in order:
 *   1. in flight (currentStage !== COMPLETED) beats completed;
 *   2. newer `updatedAt` wins;
 *   3. lowest issue number wins, so a tie is deterministic across hosts rather
 *      than "whichever `readdirSync` returned first".
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { selectAuthoritativeCheckpoint, resolveAuthoritativeCheckpoint, resolveCheckpointRepository } = require('../../dist/application/resolve-task-checkpoint');
const { STAGE_COMPLETED, StateStorageError } = require('../../dist/domain');

/**
 * Builds a candidate with only the fields the rule reads. `issue: null` is the
 * root checkpoint (`.agyloop/state.json`), matching the port's own vocabulary.
 */
function candidate(options: {
  readonly issue: number | null;
  readonly stage?: string;
  readonly updatedAt?: string;
  readonly path?: string;
}): any {
  const stage = options.stage ?? 'IMPLEMENT';
  return {
    snapshot: {
      version: '1.0.0',
      currentStage: stage,
      mode: 'standard',
      issue: options.issue,
      createdAt: '2026-10-14T12:00:00.000Z',
      updatedAt: options.updatedAt ?? '2026-10-14T12:00:00.000Z',
      history: []
    },
    issue: options.issue,
    path: options.path ?? `/repo/.agyloop/${options.issue === null ? 'state.json' : `tasks/${options.issue}.json`}`,
    inFlight: stage !== STAGE_COMPLETED,
    updatedAt: Date.parse(options.updatedAt ?? '2026-10-14T12:00:00.000Z')
  };
}

describe('selectAuthoritativeCheckpoint', () => {
  test('an empty candidate set resolves to null', () => {
    assert.strictEqual(selectAuthoritativeCheckpoint([]), null);
  });

  test('a single candidate wins regardless of stage', () => {
    const done = candidate({ issue: 7, stage: STAGE_COMPLETED });
    assert.strictEqual(selectAuthoritativeCheckpoint([done]), done);

    const running = candidate({ issue: 7, stage: 'IMPLEMENT' });
    assert.strictEqual(selectAuthoritativeCheckpoint([running]), running);
  });

  test('in flight beats a NEWER completed task', () => {
    // The completed checkpoint is one hour newer. Recency must still not hand the
    // answer to a run that has nothing left to do.
    const stale = candidate({ issue: 1, stage: 'IMPLEMENT', updatedAt: '2026-10-14T10:00:00.000Z' });
    const fresh = candidate({ issue: 2, stage: STAGE_COMPLETED, updatedAt: '2026-10-14T11:00:00.000Z' });

    assert.strictEqual(selectAuthoritativeCheckpoint([fresh, stale]), stale);
    assert.strictEqual(selectAuthoritativeCheckpoint([stale, fresh]), stale);
  });

  test('newer updatedAt wins among equally in-flight candidates', () => {
    const older = candidate({ issue: 1, stage: 'IMPLEMENT', updatedAt: '2026-10-14T10:00:00.000Z' });
    const newer = candidate({ issue: 2, stage: 'IMPLEMENT', updatedAt: '2026-10-14T11:00:00.000Z' });

    assert.strictEqual(selectAuthoritativeCheckpoint([older, newer]), newer);
    assert.strictEqual(selectAuthoritativeCheckpoint([newer, older]), newer);
  });

  test('a tie on updatedAt goes to the lowest issue number, in either array order', () => {
    const low = candidate({ issue: 999, stage: 'IMPLEMENT', updatedAt: '2026-10-14T10:00:00.000Z' });
    const high = candidate({ issue: 1000, stage: 'IMPLEMENT', updatedAt: '2026-10-14T10:00:00.000Z' });

    // Pinning BOTH orders is the determinism claim: the winner must not depend on
    // the order `listAllStates()` happened to return files in.
    assert.strictEqual(selectAuthoritativeCheckpoint([low, high]), low);
    assert.strictEqual(selectAuthoritativeCheckpoint([high, low]), low);
  });

  test('a root candidate competes on the same rules and wins when it is the only in-flight one', () => {
    const root = candidate({ issue: null, stage: 'IMPLEMENT', updatedAt: '2026-10-14T09:00:00.000Z' });
    const done = candidate({ issue: 5, stage: STAGE_COMPLETED, updatedAt: '2026-10-14T11:00:00.000Z' });

    assert.strictEqual(selectAuthoritativeCheckpoint([done, root]), root);
  });

  test('a completed root loses to an in-flight task (root is not special-cased)', () => {
    const root = candidate({ issue: null, stage: STAGE_COMPLETED, updatedAt: '2026-10-14T11:00:00.000Z' });
    const task = candidate({ issue: 3, stage: 'REVIEW', updatedAt: '2026-10-14T10:00:00.000Z' });

    assert.strictEqual(selectAuthoritativeCheckpoint([root, task]), task);
  });

  test('an unparseable updatedAt never outranks a parseable one', () => {
    // NaN compares false against everything, which makes the comparator
    // non-transitive and silently picks whichever candidate it visits first.
    // The epoch parsing itself lives in the collector, proven end-to-end in
    // `resolveAuthoritativeCheckpoint` below; here the point is only that a
    // garbage timestamp cannot win.
    const broken = candidate({ issue: 2, stage: 'IMPLEMENT', updatedAt: 'not-a-timestamp' });
    broken.updatedAt = Number.NaN;
    const good = candidate({ issue: 3, stage: 'IMPLEMENT', updatedAt: '2026-10-14T10:00:00.000Z' });

    assert.strictEqual(selectAuthoritativeCheckpoint([broken, good]), good);
    assert.strictEqual(selectAuthoritativeCheckpoint([good, broken]), good);
  });
});

/**
 * An in-memory StateRepository double. Port-conformant and I/O-free: it proves the
 * collector's parsing and its provenance rules without touching a real workspace.
 */
function memoryRepo(
  entries: readonly { readonly issue: number | null; readonly snapshot: Record<string, unknown> }[],
  options: { readonly withForIssue?: boolean } = {}
): any {
  const byIssue = new Map<number | null, Record<string, unknown>>();
  for (const entry of entries) {
    byIssue.set(entry.issue, entry.snapshot);
  }
  const rootSnapshot = byIssue.get(null) ?? null;
  const rootPath = '/repo/.agyloop/state.json';

  const repo: any = {
    load: () => rootSnapshot,
    save: () => undefined,
    reset: () => undefined,
    getStateFilePath: () => rootPath,
    listAllStates: () => Array.from(byIssue.values()),
    __byIssue: byIssue,
    __rootPath: rootPath
  };

  if (options.withForIssue !== false) {
    repo.forIssue = (issue: number | string) => {
      const snapshot = byIssue.get(Number(issue)) ?? null;
      return {
        load: () => snapshot,
        save: () => undefined,
        reset: () => undefined,
        getStateFilePath: () => `/repo/.agyloop/tasks/${Number(issue)}.json`,
        listAllStates: () => [],
        __saved: [],
        save_(snap: Record<string, unknown>) {
          byIssue.set(Number(issue), snap);
        }
      };
    };
  }

  return repo;
}

function snapshot(options: {
  readonly issue: number | null;
  readonly stage: string;
  readonly updatedAt: string;
  readonly pausedAtGate?: string;
}): any {
  return {
    version: '1.0.0',
    currentStage: options.stage,
    mode: 'standard',
    issue: options.issue,
    createdAt: options.updatedAt,
    updatedAt: options.updatedAt,
    pausedAtGate: options.pausedAtGate ?? null,
    pausedAtTimestamp: null,
    history: []
  };
}

describe('resolveAuthoritativeCheckpoint', () => {
  test('an empty workspace resolves to null so callers can still render', async () => {
    assert.strictEqual(await resolveAuthoritativeCheckpoint(memoryRepo([])), null);
  });

  test('an explicit issue wins outright and skips the scan', async () => {
    const repo = memoryRepo([
      { issue: null, snapshot: snapshot({ issue: null, stage: 'INITIALIZED', updatedAt: '2026-10-14T12:00:00.000Z' }) },
      { issue: 999, snapshot: snapshot({ issue: 999, stage: 'IMPLEMENT', updatedAt: '2026-10-14T09:00:00.000Z' }) }
    ]);

    const resolved = await resolveAuthoritativeCheckpoint(repo, 999);

    assert.strictEqual(resolved.issue, 999);
    assert.strictEqual(resolved.path, '/repo/.agyloop/tasks/999.json');
    assert.strictEqual(resolved.snapshot.currentStage, 'IMPLEMENT');
    assert.deepStrictEqual(resolved.candidates, [], 'a named task needs no scan');
  });

  test('an explicit issue that does not exist resolves to null', async () => {
    assert.strictEqual(await resolveAuthoritativeCheckpoint(memoryRepo([]), 42), null);
  });

  test('a task checkpoint outranks a root checkpoint that has finished', async () => {
    const repo = memoryRepo([
      { issue: null, snapshot: snapshot({ issue: null, stage: STAGE_COMPLETED, updatedAt: '2026-10-14T12:00:00.000Z' }) },
      { issue: 999, snapshot: snapshot({ issue: 999, stage: 'COMMIT', updatedAt: '2026-10-14T09:00:00.000Z' }) }
    ]);

    const resolved = await resolveAuthoritativeCheckpoint(repo);

    assert.strictEqual(resolved.issue, 999);
    assert.strictEqual(resolved.path, '/repo/.agyloop/tasks/999.json');
    assert.strictEqual(resolved.snapshot.currentStage, 'COMMIT');
  });

  test('a lone task checkpoint wins when the root file does not exist at all', async () => {
    // The #226 D5/D6 headline shape: the workspace holds only `tasks/999.json`.
    const repo = memoryRepo([
      { issue: 999, snapshot: snapshot({ issue: 999, stage: 'COMMIT', updatedAt: '2026-10-14T09:00:00.000Z' }) }
    ]);

    const resolved = await resolveAuthoritativeCheckpoint(repo);

    assert.strictEqual(resolved.issue, 999);
    assert.strictEqual(resolved.path, '/repo/.agyloop/tasks/999.json');
  });

  test('a garbage updatedAt degrades to epoch 0 instead of poisoning the ranking', async () => {
    const repo = memoryRepo([
      { issue: 2, snapshot: snapshot({ issue: 2, stage: 'IMPLEMENT', updatedAt: 'not-a-timestamp' }) },
      { issue: 3, snapshot: snapshot({ issue: 3, stage: 'IMPLEMENT', updatedAt: '2026-10-14T10:00:00.000Z' }) }
    ]);

    const resolved = await resolveAuthoritativeCheckpoint(repo);

    assert.strictEqual(resolved.issue, 3);
    assert.ok(
      resolved.candidates.every((c: any) => Number.isFinite(c.updatedAt)),
      `no candidate may carry NaN: ${JSON.stringify(resolved.candidates.map((c: any) => c.updatedAt))}`
    );
    assert.strictEqual(resolved.candidates.find((c: any) => c.issue === 2).updatedAt, 0);
  });

  test('a ROOT checkpoint carrying an issue number stays the root', async () => {
    // Real shape: a command invoked without `--issue` from the workspace root
    // writes `.agyloop/state.json` while the machine still knows its issue. Keying
    // the root candidate off `snapshot.issue` would address `tasks/<n>.json`,
    // which does not exist, and silently drop the checkpoint that IS there.
    const repo = memoryRepo([
      { issue: null, snapshot: snapshot({ issue: 99, stage: 'IMPLEMENT', updatedAt: '2026-10-14T12:00:00.000Z' }) }
    ]);

    const resolved = await resolveAuthoritativeCheckpoint(repo);

    assert.strictEqual(resolved.issue, null, 'the root checkpoint is not a task checkpoint');
    assert.strictEqual(resolved.path, '/repo/.agyloop/state.json');
    assert.strictEqual(resolved.snapshot.currentStage, 'IMPLEMENT');
  });

  test('degrades to the repository itself when the optional port methods are absent', async () => {
    const repo = memoryRepo(
      [{ issue: null, snapshot: snapshot({ issue: null, stage: 'REVIEW', updatedAt: '2026-10-14T12:00:00.000Z' }) }],
      { withForIssue: false }
    );

    const resolved = await resolveAuthoritativeCheckpoint(repo);

    assert.strictEqual(resolved.issue, null);
    assert.strictEqual(resolved.path, '/repo/.agyloop/state.json');
  });
});

describe('resolveCheckpointRepository', () => {
  test('returns a task-scoped repository for an explicit issue', async () => {
    const repo = memoryRepo([
      { issue: 999, snapshot: snapshot({ issue: 999, stage: 'IMPLEMENT', updatedAt: '2026-10-14T12:00:00.000Z' }) }
    ]);

    const scoped = await resolveCheckpointRepository(repo, '999');

    assert.strictEqual(scoped.getStateFilePath(), '/repo/.agyloop/tasks/999.json');
    assert.strictEqual(scoped.load().currentStage, 'IMPLEMENT');
  });

  test('returns a task-scoped repository for the authoritative winner', async () => {
    const repo = memoryRepo([
      { issue: 999, snapshot: snapshot({ issue: 999, stage: 'IMPLEMENT', updatedAt: '2026-10-14T12:00:00.000Z' }) },
      { issue: 1000, snapshot: snapshot({ issue: 1000, stage: STAGE_COMPLETED, updatedAt: '2026-10-14T13:00:00.000Z' }) }
    ]);

    const scoped = await resolveCheckpointRepository(repo);

    assert.strictEqual(scoped.getStateFilePath(), '/repo/.agyloop/tasks/999.json');
  });

  test('returns the given repository when the winner is the root checkpoint', async () => {
    const repo = memoryRepo([
      { issue: null, snapshot: snapshot({ issue: null, stage: 'INITIALIZED', updatedAt: '2026-10-14T12:00:00.000Z' }) },
      { issue: 999, snapshot: snapshot({ issue: 999, stage: STAGE_COMPLETED, updatedAt: '2026-10-14T13:00:00.000Z' }) }
    ]);

    const scoped = await resolveCheckpointRepository(repo);

    assert.strictEqual(scoped.getStateFilePath(), '/repo/.agyloop/state.json');
  });

  test('returns the given repository when `forIssue` is not implemented', async () => {
    const repo = memoryRepo(
      [{ issue: 999, snapshot: snapshot({ issue: 999, stage: 'IMPLEMENT', updatedAt: '2026-10-14T12:00:00.000Z' }) }],
      { withForIssue: false }
    );

    const scoped = await resolveCheckpointRepository(repo);

    assert.strictEqual(scoped, repo, 'an adapter without forIssue can only hand back itself');
  });
});

/**
 * #226 regression: a corrupt checkpoint file throws (`StateStorageError`) where a
 * missing one returns null. Saves use a plain `writeFileSync`, so a crash
 * mid-write produces exactly this. The scan must drop a throwing candidate on
 * the same terms as an unreadable one; the EXPLICIT-issue load must still
 * surface the error, because an operator who named the issue asked about THAT
 * file and a synthesized snapshot would be a lie about reality.
 */
describe('corrupt checkpoints: throwing loads (#226 regression)', () => {
  /** Wraps `forIssue` so the scoped re-load of exactly `issue` throws. */
  function withThrowingScope(repo: any, issue: number, error: Error): any {
    const realForIssue = repo.forIssue;
    repo.forIssue = (requested: number | string) => {
      const scoped = realForIssue(requested);
      if (Number(requested) === issue) {
        return { ...scoped, load: () => { throw error; } };
      }
      return scoped;
    };
    return repo;
  }

  function storageError(filePath: string): Error {
    return new StateStorageError(
      filePath,
      'read',
      `Failed to parse state checkpoint at ${filePath}`,
      new Error('Unexpected end of JSON input')
    );
  }

  test('a discovered task whose scoped re-load throws is dropped; the scan resolves from the good candidates', async () => {
    // `tasks/888.json` was readable when `listAllStates()` listed it and corrupt
    // by the time the re-load ran (the crash-mid-write shape). One throwing
    // candidate must not reject the whole scan — it is not evidence.
    const repo = withThrowingScope(
      memoryRepo([
        { issue: 888, snapshot: snapshot({ issue: 888, stage: 'COMMIT', pausedAtGate: 'COMMIT', updatedAt: '2026-10-14T09:00:00.000Z' }) },
        { issue: 999, snapshot: snapshot({ issue: 999, stage: 'COMMIT', pausedAtGate: 'COMMIT', updatedAt: '2026-10-14T11:00:00.000Z' }) }
      ]),
      888,
      storageError('/repo/.agyloop/tasks/888.json')
    );

    const resolved = await resolveAuthoritativeCheckpoint(repo);

    assert.strictEqual(resolved.issue, 999, 'the remaining good candidate wins');
    assert.strictEqual(resolved.path, '/repo/.agyloop/tasks/999.json');
    assert.strictEqual(
      resolved.candidates.find((c: any) => c.issue === 888),
      undefined,
      'the throwing candidate must be dropped, not represented'
    );
  });

  test('a root checkpoint whose own load() throws is dropped like any unreadable candidate', async () => {
    const repo = memoryRepo([
      { issue: 999, snapshot: snapshot({ issue: 999, stage: 'IMPLEMENT', updatedAt: '2026-10-14T11:00:00.000Z' }) }
    ]);
    repo.load = () => { throw storageError('/repo/.agyloop/state.json'); };

    const resolved = await resolveAuthoritativeCheckpoint(repo);

    assert.strictEqual(resolved.issue, 999, 'the scan still answers from the task checkpoint');
    assert.strictEqual(resolved.path, '/repo/.agyloop/tasks/999.json');
  });

  test('an explicit issue whose load() throws surfaces the specific StateStorageError', async () => {
    // Deliberately NOT swallowed: an operator who named the issue asked about
    // that one file, and turning the corrupt file into a synthesized snapshot
    // would be the exact lie #226 exists to stop. The error already names it.
    const repo = withThrowingScope(
      memoryRepo([
        { issue: 888, snapshot: snapshot({ issue: 888, stage: 'COMMIT', pausedAtGate: 'COMMIT', updatedAt: '2026-10-14T11:00:00.000Z' }) }
      ]),
      888,
      storageError('/repo/.agyloop/tasks/888.json')
    );

    await assert.rejects(
      resolveAuthoritativeCheckpoint(repo, 888),
      (err: unknown) => err instanceof StateStorageError &&
        (err as InstanceType<typeof StateStorageError>).filePath === '/repo/.agyloop/tasks/888.json'
    );
  });
});