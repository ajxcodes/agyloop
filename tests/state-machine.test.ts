const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  StateMachine,
  FileStateRepository,
  STAGES,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  parseArguments
} = require('../dist');

describe('StateMachine Core & File Repository (TypeScript)', () => {
  let tempDir: string;
  let stateFile: string;
  let repo: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-'));
    stateFile = path.join(tempDir, '.agyloop', 'state.json');
    repo = new FileStateRepository({ stateFilePath: stateFile });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('initializes with default INITIALIZED stage', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    assert.strictEqual(sm.currentStage, STAGE_INITIALIZED);
    assert.strictEqual(sm.mode, 'standard');
    assert.strictEqual(sm.history.length, 1);
  });

  test('executes valid full lifecycle transitions', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });

    sm.transition(STAGE_DISCOVERY);
    assert.strictEqual(sm.currentStage, STAGE_DISCOVERY);

    sm.transition(STAGE_PLAN);
    assert.strictEqual(sm.currentStage, STAGE_PLAN);

    sm.transition(STAGE_APPROVAL);
    assert.strictEqual(sm.currentStage, STAGE_APPROVAL);

    sm.transition(STAGE_IMPLEMENT);
    assert.strictEqual(sm.currentStage, STAGE_IMPLEMENT);

    sm.transition(STAGE_QUALITY_GATE);
    assert.strictEqual(sm.currentStage, STAGE_QUALITY_GATE);

    sm.transition(STAGE_REVIEW);
    assert.strictEqual(sm.currentStage, STAGE_REVIEW);

    sm.transition(STAGE_COMMIT);
    assert.strictEqual(sm.currentStage, STAGE_COMMIT);

    sm.transition(STAGE_COMPLETED);
    assert.strictEqual(sm.currentStage, STAGE_COMPLETED);
  });

  test('rejects invalid transitions', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });

    assert.throws(() => {
      sm.transition(STAGE_IMPLEMENT);
    }, /Invalid lifecycle transition/);

    assert.throws(() => {
      sm.transition('UNKNOWN_STAGE');
    }, /Invalid stage/);
  });

  test('forbids jumping from PLAN to IMPLEMENT without APPROVAL in standard mode', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);

    assert.strictEqual(sm.canTransition(STAGE_IMPLEMENT), false);
    assert.throws(() => {
      sm.transition(STAGE_IMPLEMENT);
    }, /Cannot transition from 'PLAN' to 'IMPLEMENT' in mode 'standard'/);
  });

  test('allows jumping from PLAN to IMPLEMENT in yolo mode', () => {
    const sm = StateMachine.createInitial({ mode: 'yolo' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);

    assert.strictEqual(sm.canTransition(STAGE_IMPLEMENT), true);
    sm.transition(STAGE_IMPLEMENT);
    assert.strictEqual(sm.currentStage, STAGE_IMPLEMENT);
  });

  test('persists checkpoint to state.json and reloads state cleanly', () => {
    const sm = StateMachine.createInitial({ mode: 'standard', issue: 42 });
    sm.transition(STAGE_DISCOVERY);

    repo.save(sm.toSnapshot());
    assert.ok(fs.existsSync(stateFile));

    const loadedSnapshot = repo.load();
    assert.ok(loadedSnapshot !== null);
    const reloadedSm = StateMachine.fromSnapshot(loadedSnapshot!);

    assert.strictEqual(reloadedSm.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(reloadedSm.issue, 42);
    assert.strictEqual(reloadedSm.history.length, 2);
    assert.strictEqual(reloadedSm.history[1].stage, STAGE_DISCOVERY);
  });

  test('resets pipeline checkpoint', () => {
    const sm = StateMachine.createInitial({ mode: 'standard', issue: 99 });
    sm.transition(STAGE_DISCOVERY);
    repo.save(sm.toSnapshot());
    assert.ok(fs.existsSync(stateFile));

    repo.reset();
    assert.strictEqual(fs.existsSync(stateFile), false);
  });

  describe('CLI Argument Parsing', () => {
    test('parses subcommands and flags correctly', () => {
      const parsed = parseArguments(['plan', '--issue', '42', '--dry-run']);
      assert.strictEqual(parsed.command, 'plan');
      assert.strictEqual(parsed.options.issue, '42');
      assert.strictEqual(parsed.options.dryRun, true);

      const parsedEq = parseArguments(['transition', 'PLAN']);
      assert.strictEqual(parsedEq.command, 'transition');
      assert.strictEqual(parsedEq.options.stageArg, 'PLAN');
    });
  });
});
