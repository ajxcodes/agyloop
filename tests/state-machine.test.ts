const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  StateMachine,
  Stage,
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
  GATE_APPROVAL,
  parseArguments
} = require('../dist');

describe('StateMachine Core & File Repository (TypeScript)', () => {
  let tempDir: string;
  let stateFile: string;
  let repo: any;
  let originalCwd: () => string;

  beforeEach(() => {
    originalCwd = process.cwd;
    process.cwd = () => '/mock/repo/root'; // Prevent IssueNumber.inferFromPath from seeing we're in .worktrees/174

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-'));
    stateFile = path.join(tempDir, '.agyloop', 'state.json');
    repo = new FileStateRepository({ stateFilePath: stateFile });
  });

  afterEach(() => {
    process.cwd = originalCwd;
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

  test('allows QUALITY_GATE -> PLAN recovery but keeps QUALITY_GATE -> APPROVAL illegal (#327)', () => {
    const sm = StateMachine.createInitial({ mode: 'standard' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);

    assert.strictEqual(sm.canTransition(STAGE_PLAN), true, 're-planning is the documented recovery');
    assert.strictEqual(
      sm.canTransition(STAGE_APPROVAL),
      false,
      're-approving without a planning pass would approve the broken bytes'
    );
    assert.strictEqual(sm.canTransition(STAGE_REVIEW), true);

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
    // Issue #223/Defect 2: the old version called `pauseAtGate()` with NO
    // argument, so no pause was ever set, `resumeFromGate()` operated on an
    // empty pause, and `>= 0` was trivially true. It could not fail. A real
    // gate name plus an exact banked-milliseconds assertion fixes that.
    const sm = new StateMachine({
      stage: new Stage(STAGE_APPROVAL),
      pausedAtGate: GATE_APPROVAL,
      pausedAtTimestamp: new Date(Date.now() - 1234).toISOString()
    });

    sm.resumeFromGate();
    assert.ok(sm.totalHumanWaitMs >= 1234, `expected >= 1234ms, got ${sm.totalHumanWaitMs}`);
    assert.ok(sm.totalHumanWaitMs < 10_000);
    assert.strictEqual(sm.pausedAtGate, null);

    // A second resume on an already-resumed machine is a NO-OP — the property
    // the old test could not express.
    const banked = sm.totalHumanWaitMs;
    sm.resumeFromGate();
    assert.strictEqual(sm.totalHumanWaitMs, banked);
  });

  test('a pause timestamp WITHOUT a gate name still banks the wait', () => {
    // Issue #284: this is the second pause shape, and the shape divergence the
    // duration policy has to converge on. `resumeFromGate()` must bank a
    // timestamp-only pause exactly like a named one.
    const sm = new StateMachine({
      stage: new Stage(STAGE_APPROVAL),
      pausedAtGate: null,
      pausedAtTimestamp: new Date(Date.now() - 2000).toISOString()
    });

    sm.resumeFromGate();
    assert.ok(sm.totalHumanWaitMs >= 2000, `expected >= 2000ms, got ${sm.totalHumanWaitMs}`);
    assert.ok(sm.totalHumanWaitMs < 10_000);
    assert.strictEqual(sm.pausedAtTimestamp, null);
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

  test('tracks and serializes milestoneTitle accurately across snapshots', () => {
    const sm = StateMachine.createInitial({
      mode: 'standard',
      issue: 62,
      milestoneTitle: 'v0.6.0'
    });
    assert.strictEqual(sm.milestoneTitle, 'v0.6.0');

    const snap = sm.toSnapshot();
    assert.strictEqual(snap.milestoneTitle, 'v0.6.0');

    const json = sm.toJSON();
    assert.strictEqual(json.milestoneTitle, 'v0.6.0');

    const reloaded = StateMachine.fromSnapshot(snap);
    assert.strictEqual(reloaded.milestoneTitle, 'v0.6.0');

    const fromJsonSm = StateMachine.fromJSON(json);
    assert.strictEqual(fromJsonSm.milestoneTitle, 'v0.6.0');

    // Test setter
    sm.setMilestoneTitle('v0.7.0');
    assert.strictEqual(sm.milestoneTitle, 'v0.7.0');

    // Test getStatus
    const status = sm.getStatus();
    assert.strictEqual(status.milestoneTitle, 'v0.7.0');

    // Test reset clears milestoneTitle
    sm.reset();
    assert.strictEqual(sm.milestoneTitle, null);
  });

  test('tracks and serializes triagePayload accurately across snapshots', () => {
    const sm = StateMachine.createInitial({
      mode: 'standard',
      issue: 190
    });
    
    // Test default null
    assert.strictEqual(sm.triagePayload, null);

    // Test setter
    sm.setTriagePayload('- [ajxcodes]: Fix this bug');
    assert.strictEqual(sm.triagePayload, '- [ajxcodes]: Fix this bug');

    // Test getStatus
    const status = sm.getStatus();
    assert.strictEqual(status.triagePayload, '- [ajxcodes]: Fix this bug');

    // Test toSnapshot & toJSON
    const snap = sm.toSnapshot();
    assert.strictEqual(snap.triagePayload, '- [ajxcodes]: Fix this bug');

    const json = sm.toJSON();
    assert.strictEqual(json.triagePayload, '- [ajxcodes]: Fix this bug');

    // Test fromSnapshot & fromJSON
    const reloaded = StateMachine.fromSnapshot(snap);
    assert.strictEqual(reloaded.triagePayload, '- [ajxcodes]: Fix this bug');

    const fromJsonSm = StateMachine.fromJSON(json);
    assert.strictEqual(fromJsonSm.triagePayload, '- [ajxcodes]: Fix this bug');

    // Test reset clears triagePayload
    sm.reset();
    assert.strictEqual(sm.triagePayload, null);
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

  test('resolves a worktree-local state file when instantiated without options (#244)', () => {
    const defaultRepo = new FileStateRepository();
    // A repo built with no options resolves to an absolute <worktree-root>/.agyloop/state.json path
    assert.ok(defaultRepo.getStateFilePath().endsWith(path.join('.agyloop', 'state.json')));
    // The root IS the caller's own worktree: state must never be redirected to another checkout (#244).
    // NOTE: this runs under the `beforeEach` cwd stub ('/mock/repo/root', a non-git path), so it
    // exercises the cwd-fallback branch; worktree-locality itself is proven in
    // tests/infrastructure/file-state-repository.test.ts (#244).
    assert.ok(path.isAbsolute(defaultRepo.getStateFilePath()));
  });

  test('memoizes successful workspace root resolution avoiding duplicate child processes for identical cwd', () => {
    const childProcess = require('child_process');
    FileStateRepository.clearWorkspaceRootCache();

    // Use a dedicated git workspace owned by the current user so the probe succeeds
    // regardless of host/container ownership quirks (e.g. CI containers mount the
    // checkout as a different owner, which makes git refuse the real repo).
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-root-'));
    childProcess.execFileSync('git', ['init', '-q'], { cwd: repoDir });
    process.cwd = () => repoDir;

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
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('does not cache the cwd fallback when the git probe fails (#221, #244)', () => {
    const childProcess = require('child_process');
    FileStateRepository.clearWorkspaceRootCache();

    let execCallCount = 0;
    const originalExecSync = childProcess.execSync;
    childProcess.execSync = function (...args: any[]) {
      execCallCount++;
      throw new Error('git unavailable');
    };

    try {
      const repo1 = new FileStateRepository();
      const afterFirst = execCallCount;
      assert.ok(afterFirst > 0, 'First instantiation should attempt git');

      // A failed resolution must NOT be memoized, otherwise a transient git failure would
      // permanently pin workspaceRoot to the cwd for the process lifetime.
      const repo2 = new FileStateRepository();
      assert.ok(
        execCallCount > afterFirst,
        'Second instantiation must re-attempt git when the first resolution was unproven'
      );
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

describe('Approved plan digest state (issue #298)', () => {
  function snapshotWithoutDigest(): any {
    return {
      version: '1.0.0',
      currentStage: STAGE_IMPLEMENT,
      mode: 'standard',
      issue: 41,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ stage: STAGE_IMPLEMENT, timestamp: new Date().toISOString() }]
    };
  }

  test('SM-D1: the digest and path round-trip through the snapshot', () => {
    const sm = StateMachine.fromSnapshot(snapshotWithoutDigest());
    sm.recordApprovedPlan('/repo/artifacts/plans/41/implementation_plan.md', 'sha256-abc');

    const snapshot = sm.toSnapshot();
    assert.strictEqual(snapshot.approvedPlanDigest, 'sha256-abc');
    assert.strictEqual(snapshot.approvedPlanPath, '/repo/artifacts/plans/41/implementation_plan.md');

    const reloaded = StateMachine.fromSnapshot(snapshot);
    assert.strictEqual(reloaded.approvedPlanDigest, 'sha256-abc');
    assert.strictEqual(reloaded.approvedPlanPath, '/repo/artifacts/plans/41/implementation_plan.md');
  });

  test('SM-D2: a legacy snapshot without a digest loads as null, never broken', () => {
    const sm = StateMachine.fromSnapshot(snapshotWithoutDigest());
    assert.strictEqual(sm.approvedPlanDigest, null);
    assert.strictEqual(sm.approvedPlanPath, null);
    assert.strictEqual(sm.toSnapshot().approvedPlanDigest, null);
  });

  test('SM-D3: reset clears the approved plan identity', () => {
    const sm = StateMachine.fromSnapshot(snapshotWithoutDigest());
    sm.recordApprovedPlan('/repo/plan.md', 'sha256-abc');
    sm.reset('standard', 41);

    assert.strictEqual(sm.approvedPlanDigest, null);
    assert.strictEqual(sm.approvedPlanPath, null);
  });
});
