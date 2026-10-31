/**
 * agyloop - Smoke protocol approval guard tests (issue #388, Defect 2)
 *
 * SPA1 - a plan whose frozen smoke block writes `.agyloop/tasks/<n>.json`
 *        without creating the parent is refused at `transition APPROVAL`; the
 *        checkpoint stays at PLAN and nothing is saved
 * SPA2 - the SAME plan with ONE `mkdir -p` line is approved unchanged, so a
 *        gate never needs to edit the frozen script
 * SPA3 - each impossible #413 fixture is refused with ValidationError
 *        (field `smokeProtocol`) before anything is saved (#413 AC-5)
 * SPA4 - the same plan under `--dry-run` warns and saves nothing (#413 AC-5)
 * SPA5 - the corrected #413 protocol is approved unchanged (#413 AC-5)
 * SPA6 - a missing-marker refusal named only in a comment is still refused:
 *        prose cannot disarm Rule C at the shared approval surface (#413 AC-4)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TransitionStageUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  MODE_STANDARD,
  ValidationError
} = require('../../dist/domain');

const ISSUE = 388;
const SEED =
  'node -e \'const fs=require("fs");fs.writeFileSync(".agyloop/tasks/388.json", "{}")\'';

function planWithSmoke(bodyLines: string[]): string {
  return [
    '# [Implementation] - smoke probe',
    '',
    '## 3. Implementation Steps',
    '- [ ] **Step 1:** hold',
    '',
    '### Manual Smoke Test Protocol',
    '',
    '```bash',
    ...bodyLines,
    '```',
    ''
  ].join('\n');
}

class MockStateRepository {
  public snapshot: any;
  public saveCallCount = 0;

  constructor(initial: any) {
    this.snapshot = initial;
  }

  public load(): any {
    return this.snapshot;
  }

  public save(snapshot: any): void {
    this.snapshot = snapshot;
    this.saveCallCount++;
  }

  public reset(): void {
    this.snapshot = null;
  }

  public getStateFilePath(): string {
    return '/mock/state.json';
  }
}

function makePlanGenerator(planDir: string, planPath: string): any {
  return {
    resolvePlanFile: () => ({
      planDir,
      planPath,
      planFileName: path.basename(planPath),
      summaryPath: path.join(planDir, 'AgyLoop Summary.md')
    }),
    readPlanDocument: (target: string) => fs.readFileSync(target, 'utf8'),
    hashPlanDocument: (target: string) => `sha256:${fs.readFileSync(target, 'utf8')}`,
    updateSummaryLog: () => true
  };
}

describe('Smoke protocol approval guard (issue #388)', () => {
  let root: string;
  let planDir: string;
  let planPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-smoke-approval-'));
    planDir = path.join(root, 'artifacts/plans/388-smoke');
    fs.mkdirSync(planDir, { recursive: true });
    planPath = path.join(planDir, 'implementation_plan.md');
    fs.writeFileSync(planPath, planWithSmoke([SEED]), 'utf8');
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  function stateAtPlan(): MockStateRepository {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    return new MockStateRepository(sm.toSnapshot());
  }

  test('SPA1: the seed-broken protocol is refused at APPROVAL and nothing is saved', async () => {
    const stateRepo = stateAtPlan();
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath)
    );

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'smokeProtocol');
        assert.ok(err.message.includes('missing-parent-directory'), err.message);
        assert.ok(err.message.includes('.agyloop/tasks'), err.message);
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_PLAN);
  });

  test('SPA2: one mkdir line makes the same plan approvable unchanged', async () => {
    fs.writeFileSync(planPath, planWithSmoke(['mkdir -p .agyloop/tasks', SEED]), 'utf8');
    const stateRepo = stateAtPlan();
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath)
    );

    const approved = await useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root });
    assert.strictEqual(approved.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.saveCallCount, 1);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_APPROVAL);
  });

  // Issue #413: the fixture-consistency rules are enforced at the same shared
  // approval surface, so an impossible check never reaches a frozen digest.

  const SMOKE_413_DIR = path.join(__dirname, '..', 'fixtures', 'smoke-413');

  function writeFixturePlan(file: string): void {
    const fragment = fs.readFileSync(path.join(SMOKE_413_DIR, file), 'utf8');
    fs.writeFileSync(
      planPath,
      [
        '# [Implementation] - smoke fixture probe',
        '',
        '## 3. Implementation Steps',
        '- [ ] **Step 1:** hold',
        '',
        '### Manual Smoke Test Protocol',
        '',
        fragment,
        ''
      ].join('\n'),
      'utf8'
    );
  }

  test('SPA3: each impossible #413 fixture is refused at APPROVAL and nothing is saved', async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['impossible-gate-tests.checks.md', 'gate-report-fixture-contradiction'],
      ['impossible-worktree.checks.md', 'worktree-fixture-unmatched'],
      ['impossible-marker.checks.md', 'gate-report-marker-missing']
    ];

    for (const [file, rule] of cases) {
      writeFixturePlan(file);
      const stateRepo = stateAtPlan();
      const useCase = new TransitionStageUseCase(
        stateRepo as any,
        undefined,
        undefined,
        makePlanGenerator(planDir, planPath)
      );

      await assert.rejects(
        () => useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root }),
        (err: any) => {
          assert.ok(err instanceof ValidationError, `${file}: expected ValidationError, got ${err}`);
          assert.strictEqual(err.field, 'smokeProtocol', file);
          assert.ok(err.message.includes(rule), `${file}: ${err.message}`);
          assert.ok(/at plan line \d+/.test(err.message), `${file}: ${err.message}`);
          return true;
        }
      );

      assert.strictEqual(stateRepo.saveCallCount, 0, file);
      assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_PLAN, file);
    }
  });

  test('SPA4: the same plan under --dry-run warns and saves nothing', async () => {
    writeFixturePlan('impossible-gate-tests.checks.md');
    const stateRepo = stateAtPlan();
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath)
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnings.push(args.join(' '));
    };
    try {
      await useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root, dryRun: true });
    } finally {
      console.warn = originalWarn;
    }

    assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
    assert.ok(warnings[0].includes('gate-report-fixture-contradiction'), warnings[0]);
    assert.strictEqual(stateRepo.saveCallCount, 0);
  });

  test('SPA5: the corrected #413 protocol is approved unchanged', async () => {
    writeFixturePlan('corrected.checks.md');
    const stateRepo = stateAtPlan();
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath)
    );

    const approved = await useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root });
    assert.strictEqual(approved.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.saveCallCount, 1);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_APPROVAL);
  });

  test('SPA6: a refusal named only in a comment still refuses the markerless plan (#413 AC-4)', async () => {
    fs.writeFileSync(
      planPath,
      planWithSmoke([
        'SBX="$(mktemp -d "$HOME/.cache/agyloop/smoke-413-fixture-XXXXXX")"',
        'mkdir -p "$SBX/ws"',
        '# parseBlock refuses a markerless report with missing GATE_REPORT_JSON: block',
        '// missing GATE_REPORT_JSON is the refusal this check expects',
        'node bin/codeloop.js gate-report --issue 388 --workspace "$SBX/ws" --report-file "$SBX/ws/gate.json"',
        'rm -rf "$SBX"'
      ]),
      'utf8'
    );
    const stateRepo = stateAtPlan();
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath)
    );

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'smokeProtocol');
        assert.ok(err.message.includes('gate-report-marker-missing'), err.message);
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_PLAN);
  });
});
