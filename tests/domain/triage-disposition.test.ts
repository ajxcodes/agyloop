/**
 * agyloop - TriageDisposition Value Object Tests (issue #269, Defect 1)
 *
 * The disposition is the load-bearing part of the fix: it is what turns the
 * TRIAGE livelock into a one-shot gate. These tests pin its validation, its
 * merge semantics, its checkpoint round-trip (in memory AND through the file
 * repository) and its tolerance of legacy/malformed snapshots.
 *
 * TD1 - validation
 * TD2 - merge semantics
 * TD3 - snapshot round-trip
 * TD4 - file repository round-trip
 * TD5 - legacy / malformed snapshots load as null
 * TD6 - reset() clears the disposition
 * TD7 - coversAll is true only when EVERY key is covered
 * TD8 - ONE renderer produces every operator-facing disposition line (R5)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TriageDisposition,
  StateMachine,
  ValidationError,
  MAX_TRIAGE_DISPOSITION_FEEDBACK_KEYS,
  TRIAGE_DISPOSITION_ACTIONS,
  formatTriageDispositionLine
} = require('../../dist/domain');
const { FileStateRepository } = require('../../dist/infrastructure/file-state-repository');

const NOW = '2026-10-21T12:00:00.000Z';

function makeDisposition(overrides: Record<string, unknown> = {}): any {
  return new TriageDisposition({
    prNumber: 7,
    action: 'completed',
    recordedAt: NOW,
    feedbackKeys: ['id:101'],
    ...overrides
  });
}

describe('TriageDisposition value object (issue #269)', () => {
  test('TD1: validates prNumber, action, recordedAt and the feedback keys', () => {
    const disposition = makeDisposition();

    assert.strictEqual(disposition.prNumber, 7);
    assert.strictEqual(disposition.action, 'completed');
    assert.strictEqual(disposition.recordedAt, NOW);
    assert.deepStrictEqual([...disposition.feedbackKeys], ['id:101']);

    assert.throws(
      () => makeDisposition({ prNumber: 0 }),
      (err: any) => err instanceof ValidationError && err.field === 'prNumber'
    );
    assert.throws(
      () => makeDisposition({ prNumber: 1.5 }),
      (err: any) => err instanceof ValidationError && err.field === 'prNumber'
    );
    assert.throws(
      () => makeDisposition({ action: 'nonsense' }),
      (err: any) => err instanceof ValidationError && err.field === 'action'
    );
    assert.throws(
      () => makeDisposition({ recordedAt: '' }),
      (err: any) => err instanceof ValidationError && err.field === 'recordedAt'
    );
    assert.throws(
      () => makeDisposition({ recordedAt: 'not-a-date' }),
      (err: any) => err instanceof ValidationError && err.field === 'recordedAt'
    );
    assert.throws(
      () => makeDisposition({ feedbackKeys: [''] }),
      (err: any) => err instanceof ValidationError && err.field === 'feedbackKeys'
    );

    // Every documented action is accepted.
    for (const action of TRIAGE_DISPOSITION_ACTIONS) {
      assert.strictEqual(makeDisposition({ action }).action, action);
    }
  });

  test('TD2: merge replaces on a different PR and unions on the same PR', () => {
    const first = makeDisposition({ feedbackKeys: ['id:1', 'id:2'] });

    // A different PR is a different subject: the old keys must not mask the
    // new one's.
    const other = TriageDisposition.merge(first, {
      prNumber: 8,
      action: 'implement',
      recordedAt: NOW,
      feedbackKeys: ['id:9']
    });
    assert.strictEqual(other.prNumber, 8);
    assert.strictEqual(other.action, 'implement');
    assert.deepStrictEqual([...other.feedbackKeys], ['id:9']);

    // The same PR: the union of the key sets, and the LATEST action wins.
    const merged = TriageDisposition.merge(first, {
      prNumber: 7,
      action: 'implement',
      recordedAt: '2026-10-21T13:00:00.000Z',
      feedbackKeys: ['id:2', 'id:3']
    });
    assert.strictEqual(merged.prNumber, 7);
    assert.strictEqual(merged.action, 'implement');
    assert.strictEqual(merged.recordedAt, '2026-10-21T13:00:00.000Z');
    assert.deepStrictEqual([...merged.feedbackKeys], ['id:1', 'id:2', 'id:3']);

    // The key set is capped.
    const many = Array.from({ length: MAX_TRIAGE_DISPOSITION_FEEDBACK_KEYS + 25 }, (_, i) => `id:${i}`);
    const capped = TriageDisposition.merge(null, {
      prNumber: 7,
      action: 'completed',
      recordedAt: NOW,
      feedbackKeys: many
    });
    assert.strictEqual(capped.feedbackKeys.length, MAX_TRIAGE_DISPOSITION_FEEDBACK_KEYS);
    // The OLDEST keys are dropped first: the most recent feedback survives.
    assert.strictEqual(capped.feedbackKeys[0], 'id:25');
    assert.strictEqual(
      capped.feedbackKeys[capped.feedbackKeys.length - 1],
      `id:${many.length - 1}`
    );
  });

  test('TD3: the disposition survives a snapshot round-trip', () => {
    const sm = StateMachine.createInitial({ issue: 900 });
    sm.setTriageDisposition(makeDisposition({ feedbackKeys: ['id:101', 'id:102'] }));

    const snapshot = sm.toSnapshot();
    assert.ok(snapshot.triageDisposition, 'the snapshot must carry the disposition');
    assert.strictEqual(snapshot.triageDisposition!.prNumber, 7);
    assert.strictEqual(snapshot.triageDisposition!.action, 'completed');
    assert.deepStrictEqual([...snapshot.triageDisposition!.feedbackKeys], ['id:101', 'id:102']);

    const rehydrated = StateMachine.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const disposition = rehydrated.triageDisposition;
    assert.ok(disposition, 'the disposition must survive the round-trip');
    assert.strictEqual(disposition!.prNumber, 7);
    assert.strictEqual(disposition!.action, 'completed');
    assert.strictEqual(disposition!.recordedAt, NOW);
    assert.deepStrictEqual([...disposition!.feedbackKeys], ['id:101', 'id:102']);
  });

  test('TD4: the disposition survives a FILE repository round-trip', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-triage-disposition-'));
    const originalCwd = process.cwd;
    try {
      const stateFile = path.join(tempDir, '.agyloop', 'state.json');
      const repo = new FileStateRepository({ stateFilePath: stateFile });

      // The repository refuses a save whose issue does not match the worktree
      // the CWD names; the scratch directory names no worktree, so the cwd is
      // pointed at it for the duration of the round-trip.
      process.cwd = () => tempDir;

      const sm = StateMachine.createInitial({ issue: 900 });
      sm.setTriageDisposition(makeDisposition({ feedbackKeys: ['id:101'] }));
      repo.save(sm.toSnapshot());

      const loaded = repo.load();
      assert.ok(loaded, 'the checkpoint must be readable');
      const disposition = StateMachine.fromSnapshot(loaded!).triageDisposition;
      assert.ok(disposition, 'the disposition must survive the file round-trip');
      assert.strictEqual(disposition!.prNumber, 7);
      assert.strictEqual(disposition!.action, 'completed');
      assert.deepStrictEqual([...disposition!.feedbackKeys], ['id:101']);
    } finally {
      process.cwd = originalCwd;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('TD5: a legacy or malformed snapshot loads as null and never throws', () => {
    const legacy: any = {
      version: '1.0.0',
      currentStage: 'COMPLETED',
      mode: 'standard',
      issue: 900,
      createdAt: NOW,
      updatedAt: NOW,
      history: []
    };
    const fromLegacy = StateMachine.fromSnapshot(legacy);
    assert.strictEqual(fromLegacy.triageDisposition, null);

    const malformed: any = { ...legacy, triageDisposition: { prNumber: 'seven' } };
    assert.strictEqual(StateMachine.fromSnapshot(malformed).triageDisposition, null);

    const malformedKeys: any = { ...legacy, triageDisposition: { prNumber: 7, action: 'completed', recordedAt: NOW, feedbackKeys: 'nope' } };
    assert.strictEqual(StateMachine.fromSnapshot(malformedKeys).triageDisposition, null);

    const malformedAction: any = { ...legacy, triageDisposition: { prNumber: 7, action: 'destroy', recordedAt: NOW, feedbackKeys: [] } };
    assert.strictEqual(StateMachine.fromSnapshot(malformedAction).triageDisposition, null);

    // `fromJSON` itself never throws.
    assert.strictEqual(TriageDisposition.fromJSON(undefined), null);
    assert.strictEqual(TriageDisposition.fromJSON('garbage'), null);
    assert.strictEqual(TriageDisposition.fromJSON([]), null);
  });

  test('TD6: reset() clears the disposition', () => {
    const sm = StateMachine.createInitial({ issue: 900 });
    sm.setTriageDisposition(makeDisposition());
    assert.ok(sm.triageDisposition, 'the disposition must be set before the reset');

    sm.reset('standard', 900);
    assert.strictEqual(sm.triageDisposition, null, 'a re-opened task starts with no disposition');
  });

  test('TD7: coversAll is true only when EVERY key is covered', () => {
    const disposition = makeDisposition({ feedbackKeys: ['id:1', 'id:2'] });

    assert.strictEqual(disposition.covers('id:1'), true);
    assert.strictEqual(disposition.covers('id:9'), false);
    assert.strictEqual(disposition.coversAll(['id:1', 'id:2']), true);
    assert.strictEqual(disposition.coversAll(['id:1', 'id:9']), false);
    // An EMPTY key set is NOT covered: "nothing was dispositioned" must never
    // read as "everything was dispositioned".
    assert.strictEqual(disposition.coversAll([]), false);
  });

  test('TD8: ONE renderer produces every operator-facing disposition line (issue #269, R5)', () => {
    // The three surfaces used to hand-render the same four facts, so the
    // wording could drift. They now share ONE renderer, and the wording is
    // UNCHANGED — this pins the exact strings the operator sees.
    const disposition = makeDisposition();

    assert.strictEqual(
      formatTriageDispositionLine(disposition, 'history-note'),
      'Triage disposition recorded: completed (PR #7, 1 feedback item(s) at 2026-10-21T12:00:00.000Z)'
    );
    assert.strictEqual(
      formatTriageDispositionLine(disposition, 'idle-report'),
      'Triage disposition recorded: action=completed, PR #7, 1 feedback item(s), at 2026-10-21T12:00:00.000Z.'
    );
    assert.strictEqual(
      formatTriageDispositionLine(disposition, 'triage-cli'),
      'Triage Disposition : recorded (action=COMPLETED, PR #7, 1 feedback item(s), at 2026-10-21T12:00:00.000Z)'
    );

    // The SERIALIZED form renders identically — the CLI holds the serialized
    // disposition, not the value object.
    assert.strictEqual(
      formatTriageDispositionLine(disposition.toJSON(), 'triage-cli'),
      formatTriageDispositionLine(disposition, 'triage-cli')
    );
  });
});
