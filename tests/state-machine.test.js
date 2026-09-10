const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StateMachine, STAGES } = require('../lib/state-machine');
const { parseArguments } = require('../bin/agyloop.js');

describe('StateMachine Core', () => {
  let tempDir;
  let stateFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-'));
    stateFile = path.join(tempDir, '.agyloop', 'state.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('initializes with default INITIALIZED stage', () => {
    const sm = new StateMachine({ stateFile, workspaceDir: tempDir });
    assert.strictEqual(sm.state.currentStage, STAGES.INITIALIZED);
    assert.strictEqual(sm.state.mode, 'standard');
    assert.strictEqual(sm.state.history.length, 1);
  });

  test('executes valid full lifecycle transitions', () => {
    const sm = new StateMachine({ stateFile, workspaceDir: tempDir });

    sm.transition(STAGES.DISCOVERY);
    assert.strictEqual(sm.state.currentStage, STAGES.DISCOVERY);

    sm.transition(STAGES.PLAN);
    assert.strictEqual(sm.state.currentStage, STAGES.PLAN);

    sm.transition(STAGES.APPROVAL);
    assert.strictEqual(sm.state.currentStage, STAGES.APPROVAL);

    sm.transition(STAGES.IMPLEMENT);
    assert.strictEqual(sm.state.currentStage, STAGES.IMPLEMENT);

    sm.transition(STAGES.QUALITY_GATE);
    assert.strictEqual(sm.state.currentStage, STAGES.QUALITY_GATE);

    sm.transition(STAGES.REVIEW);
    assert.strictEqual(sm.state.currentStage, STAGES.REVIEW);

    sm.transition(STAGES.COMMIT);
    assert.strictEqual(sm.state.currentStage, STAGES.COMMIT);

    sm.transition(STAGES.COMPLETED);
    assert.strictEqual(sm.state.currentStage, STAGES.COMPLETED);
  });

  test('rejects invalid transitions', () => {
    const sm = new StateMachine({ stateFile, workspaceDir: tempDir });
    assert.throws(
      () => sm.transition(STAGES.IMPLEMENT),
      /Invalid lifecycle transition/
    );
  });

  test('forbids jumping from PLAN to IMPLEMENT without APPROVAL in standard mode', () => {
    const sm = new StateMachine({ stateFile, workspaceDir: tempDir, mode: 'standard' });
    sm.transition(STAGES.DISCOVERY);
    sm.transition(STAGES.PLAN);
    assert.strictEqual(sm.canTransition(STAGES.IMPLEMENT), false);
    assert.throws(
      () => sm.transition(STAGES.IMPLEMENT),
      /Invalid lifecycle transition/
    );
  });

  test('allows jumping from PLAN to IMPLEMENT in yolo mode', () => {
    const sm = new StateMachine({ stateFile, workspaceDir: tempDir, mode: 'yolo' });
    sm.transition(STAGES.DISCOVERY);
    sm.transition(STAGES.PLAN);
    assert.strictEqual(sm.canTransition(STAGES.IMPLEMENT), true);
    sm.transition(STAGES.IMPLEMENT);
    assert.strictEqual(sm.state.currentStage, STAGES.IMPLEMENT);
  });

  test('persists checkpoint to state.json and reloads state cleanly', () => {
    const sm1 = new StateMachine({ stateFile, workspaceDir: tempDir, issue: 42 });
    sm1.transition(STAGES.DISCOVERY, { test: true });
    sm1.transition(STAGES.PLAN);

    assert.ok(fs.existsSync(stateFile));

    // Create fresh instance loading from same stateFile
    const sm2 = new StateMachine({ stateFile, workspaceDir: tempDir });
    assert.strictEqual(sm2.state.currentStage, STAGES.PLAN);
    assert.strictEqual(sm2.state.issue, 42);
    assert.strictEqual(sm2.state.history.length, 3);
  });

  test('resets pipeline checkpoint', () => {
    const sm = new StateMachine({ stateFile, workspaceDir: tempDir });
    sm.transition(STAGES.DISCOVERY);
    assert.strictEqual(sm.state.currentStage, STAGES.DISCOVERY);

    sm.reset(true);
    assert.strictEqual(sm.state.currentStage, STAGES.INITIALIZED);
    assert.strictEqual(fs.existsSync(stateFile), false);
  });
});

describe('CLI Argument Parsing', () => {
  test('parses subcommands and flags correctly', () => {
    const res1 = parseArguments(['plan', '--issue=10', '--dry-run']);
    assert.strictEqual(res1.command, 'plan');
    assert.strictEqual(res1.options.issue, '10');
    assert.strictEqual(res1.options.dryRun, true);

    const res2 = parseArguments(['transition', 'PLAN']);
    assert.strictEqual(res2.command, 'transition');
    assert.strictEqual(res2.options.stageArg, 'PLAN');

    const res3 = parseArguments(['yolo', '--commit-after']);
    assert.strictEqual(res3.command, 'yolo');
    assert.strictEqual(res3.options.commitAfter, true);
  });
});
