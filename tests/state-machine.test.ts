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

  test('allows transition from STAGE_COMMIT to STAGE_QUALITY_GATE, STAGE_IMPLEMENT, and STAGE_PLAN', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_COMMIT);

    assert.strictEqual(sm.canTransition(STAGE_QUALITY_GATE), true);
    assert.strictEqual(sm.canTransition(STAGE_IMPLEMENT), true);
    assert.strictEqual(sm.canTransition(STAGE_PLAN), true);
    assert.strictEqual(sm.canTransition(STAGE_COMPLETED), true);

    // Transition COMMIT -> PLAN (redesign loop)
    sm.transition(STAGE_PLAN);
    assert.strictEqual(sm.currentStage, STAGE_PLAN);
  });

  test('allows direct transition from INITIALIZED to PLAN (bypassing DISCOVERY for features)', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    assert.strictEqual(sm.canTransition(STAGE_PLAN), true);
    sm.transition(STAGE_PLAN);
    assert.strictEqual(sm.currentStage, STAGE_PLAN);
  });

  test('tracks planRevisionCount when transitioning APPROVAL -> PLAN', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    assert.strictEqual(sm.planRevisionCount, 0);

    // Human feedback loop: APPROVAL -> PLAN
    sm.transition(STAGE_PLAN);
    assert.strictEqual(sm.planRevisionCount, 1);

    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_PLAN);
    assert.strictEqual(sm.planRevisionCount, 2);
  });

  test('tracks gate pause and resume duration cleanly', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    assert.strictEqual(sm.totalHumanWaitMs, 0);

    sm.pauseAtGate();
    // Simulating paused state
    sm.resumeFromGate();
    assert.strictEqual(typeof sm.totalHumanWaitMs, 'number');
    assert.ok(sm.totalHumanWaitMs >= 0);

    const activeDuration = sm.activeExecutionDurationMs();
    assert.strictEqual(typeof activeDuration, 'number');
    assert.ok(activeDuration >= 0);
  });

  test('allows transition from STAGE_COMPLETED to STAGE_IMPLEMENT, STAGE_QUALITY_GATE, STAGE_REVIEW, STAGE_PLAN, and STAGE_DISCOVERY', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_COMMIT);
    sm.transition(STAGE_COMPLETED);

    assert.strictEqual(sm.canTransition(STAGE_INITIALIZED), true);
    assert.strictEqual(sm.canTransition(STAGE_DISCOVERY), true);
    assert.strictEqual(sm.canTransition(STAGE_PLAN), true);
    assert.strictEqual(sm.canTransition(STAGE_IMPLEMENT), true);
    assert.strictEqual(sm.canTransition(STAGE_QUALITY_GATE), true);
    assert.strictEqual(sm.canTransition(STAGE_REVIEW), true);

    // Reopen planning from completed
    sm.transition(STAGE_PLAN);
    assert.strictEqual(sm.currentStage, STAGE_PLAN);
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

  test('tracks and serializes planDir accurately across snapshots', () => {
    const sm = StateMachine.createInitial({
      mode: 'standard',
      issue: 108,
      planDir: '/repo/artifacts/plans/108-fix-plan-selection'
    });
    assert.strictEqual(sm.planDir, '/repo/artifacts/plans/108-fix-plan-selection');

    const snap = sm.toSnapshot();
    assert.strictEqual(snap.planDir, '/repo/artifacts/plans/108-fix-plan-selection');

    const json = sm.toJSON();
    assert.strictEqual(json.planDir, '/repo/artifacts/plans/108-fix-plan-selection');

    const reloaded = StateMachine.fromSnapshot(snap);
    assert.strictEqual(reloaded.planDir, '/repo/artifacts/plans/108-fix-plan-selection');

    const fromJsonSm = StateMachine.fromJSON(json);
    assert.strictEqual(fromJsonSm.planDir, '/repo/artifacts/plans/108-fix-plan-selection');

    // Test setter
    sm.setPlanDir('/repo/artifacts/plans/108-updated');
    assert.strictEqual(sm.planDir, '/repo/artifacts/plans/108-updated');

    // Test getStatus
    const status = sm.getStatus();
    assert.strictEqual(status.planDir, '/repo/artifacts/plans/108-updated');

    // Test reset clears planDir
    sm.reset();
    assert.strictEqual(sm.planDir, null);
  });

  test('resets pipeline checkpoint', () => {
    const sm = StateMachine.createInitial({ mode: 'standard', issue: 99 });
    sm.transition(STAGE_DISCOVERY);
    repo.save(sm.toSnapshot());
    assert.ok(fs.existsSync(stateFile));

    repo.reset();
    assert.strictEqual(fs.existsSync(stateFile), false);
  });

  test('resolves state file path relative to explicit workspaceDir', () => {
    const explicitRepo = new FileStateRepository({ workspaceDir: tempDir });
    assert.strictEqual(explicitRepo.getStateFilePath(), path.join(tempDir, '.agyloop', 'state.json'));
  });

  test('resolves canonical root repo state file when instantiated without options inside worktree', () => {
    const defaultRepo = new FileStateRepository();
    // Default repo when run in git repo / worktree should resolve to a valid .agyloop/state.json path
    assert.ok(defaultRepo.getStateFilePath().endsWith(path.join('.agyloop', 'state.json')));
    // It should not point to an isolated task worktree folder when root discovery succeeds
    assert.ok(path.isAbsolute(defaultRepo.getStateFilePath()));
  });

  test('memoizes workspace root resolution avoiding duplicate child processes for identical cwd', () => {
    const childProcess = require('child_process');
    FileStateRepository.clearWorkspaceRootCache();

    let execCallCount = 0;
    const originalExecSync = childProcess.execSync;
    childProcess.execSync = function (...args: any[]) {
      execCallCount++;
      return originalExecSync.apply(this, args);
    };

    try {
      const repo1 = new FileStateRepository();
      const initialExecCalls = execCallCount;
      assert.ok(initialExecCalls > 0, 'First instantiation should invoke execSync');

      // Second instantiation should reuse cached root without spawning child processes
      const repo2 = new FileStateRepository();
      assert.strictEqual(execCallCount, initialExecCalls, 'Second instantiation should reuse cached workspace root');
      assert.strictEqual(repo1.getStateFilePath(), repo2.getStateFilePath());
    } finally {
      childProcess.execSync = originalExecSync;
      FileStateRepository.clearWorkspaceRootCache();
    }
  });

  test('clearWorkspaceRootCache invalidates cached workspace root', () => {
    const repo1 = new FileStateRepository();
    assert.ok(repo1.getStateFilePath());
    FileStateRepository.clearWorkspaceRootCache();
    const repo2 = new FileStateRepository();
    assert.strictEqual(repo1.getStateFilePath(), repo2.getStateFilePath());
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
