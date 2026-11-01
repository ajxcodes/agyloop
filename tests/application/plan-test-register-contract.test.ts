/**
 * agyloop - Test Register contract (issue #432, TR-15..TR-20)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertPlanTestRegisterContract
} = require('../../dist/application');
const {
  StartImplementationUseCase,
  TransitionStageUseCase
} = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT
} = require('../../dist/domain');
const { FileSourceReader } = require('../../dist/infrastructure');

const SOURCE = [
  "const assert = require('node:assert');",
  "test('fresh run halts at PLAN', () => {",
  '  const result = { pausedAtGate: undefined };',
  '  assert.strictEqual(result.pausedAtGate, undefined);',
  '});'
].join('\n');

const CONTRADICTING = [
  '# Plan',
  '',
  '- **Acceptance Criteria:**',
  '- AC1: the standard leg parks',
  '',
  '### Test Register',
  '- **TR-1** — the fresh run',
  '  - **Pins:** `tests/application/run-lifecycle.test.ts` :: `fresh run halts at PLAN`',
  '  - **Asserts:** `assert.strictEqual(result.pausedAtGate, GATE_APPROVAL)`'
].join('\n');

const CONSISTENT = CONTRADICTING.replace(
  'assert.strictEqual(result.pausedAtGate, GATE_APPROVAL)',
  'assert.strictEqual(result.pausedAtGate, undefined)'
);

const MISSING_MARKER = [
  '### Test Register',
  '- **TR-7** — a row with no marker',
  '  - **Asserts:** `assert.strictEqual(a, 1)`'
].join('\n');

const DUPLICATE_NEW = [
  '### Test Register',
  '- **TR-8** — **New test:** `tests/application/run-lifecycle.test.ts` :: `fresh run halts at PLAN`',
  '  - **Asserts:** `assert.strictEqual(a, 1)`'
].join('\n');

let root: string;
let planPath: string;

function writePlan(content: string): void {
  planPath = path.join(root, 'implementation_plan.md');
  fs.writeFileSync(planPath, content);
}

function planGenerator() {
  return {
    readPlanDocument: (p: string) => fs.readFileSync(p, 'utf8'),
    resolvePlanFile: (options: any) => ({ planPath: options.planPath ?? planPath })
  };
}

function guard(content: string): void {
  writePlan(content);
  assertPlanTestRegisterContract({
    planGenerator: planGenerator() as any,
    sourceFileReader: new FileSourceReader() as any,
    planPath,
    workspaceDir: root
  });
}

class MemoryStateRepository {
  public snapshot: any;
  public saves = 0;
  constructor(snapshot: any) {
    this.snapshot = snapshot;
  }
  load() {
    return this.snapshot;
  }
  save(snapshot: any) {
    this.snapshot = snapshot;
    this.saves += 1;
  }
  reset() {
    this.snapshot = null;
  }
  getStateFilePath() {
    return '/mock/state.json';
  }
}

function planCheckpoint(): any {
  const sm = StateMachine.createInitial({ issue: 432 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.setPlanPath(planPath);
  return sm;
}

describe('Test Register contract (issue #432)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-register-'));
    fs.mkdirSync(path.join(root, 'tests', 'application'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'application', 'run-lifecycle.test.ts'), SOURCE);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('PTR1 a contradicting pinned literal is refused with file:line', () => {
    assert.throws(
      () => guard(CONTRADICTING),
      (err: any) =>
        /run-lifecycle\.test\.ts:4/.test(err.message) &&
        err.message.includes('GATE_APPROVAL') &&
        err.message.includes('undefined')
    );
  });

  test('PTR2 a consistent pin is accepted', () => {
    assert.doesNotThrow(() => guard(CONSISTENT));
  });

  test('PTR3 a row with neither Pins nor New test is refused', () => {
    assert.throws(
      () => guard(MISSING_MARKER),
      (err: any) => err.message.includes('TR-7') && /Pins/.test(err.message) && /New test/.test(err.message)
    );
  });

  test('PTR4 a New test whose title already exists is refused', () => {
    assert.throws(
      () => guard(DUPLICATE_NEW),
      (err: any) =>
        err.message.includes('fresh run halts at PLAN') &&
        err.message.includes('tests/application/run-lifecycle.test.ts')
    );
  });

  test('PTR5 both approval entry points emit the identical refusal', async () => {
    writePlan(CONTRADICTING);
    const transitionRepo = new MemoryStateRepository(planCheckpoint().toSnapshot());
    let transitionMessage = '';
    try {
      await new TransitionStageUseCase(
        transitionRepo as any,
        undefined,
        undefined,
        planGenerator() as any,
        undefined,
        undefined,
        new FileSourceReader() as any
      ).execute({ targetStage: STAGE_APPROVAL, issue: 432, workspaceDir: root });
    } catch (err: any) {
      transitionMessage = err.message;
    }

    writePlan(CONTRADICTING);
    const implementRepo = new MemoryStateRepository(
      (() => {
        const sm = StateMachine.createInitial({ issue: 432 });
        sm.transition(STAGE_DISCOVERY);
        sm.transition(STAGE_PLAN);
        sm.transition(STAGE_APPROVAL);
        sm.setPlanPath(planPath);
        return sm;
      })().toSnapshot()
    );
    let implementMessage = '';
    try {
      await new StartImplementationUseCase(
        implementRepo as any,
        {
          loadConfig: () => ({ models: {}, options: {} })
        } as any,
        planGenerator() as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new FileSourceReader() as any
      ).execute({ issue: 432, planPath, workspaceDir: root, noWorktree: true });
    } catch (err: any) {
      implementMessage = err.message;
    }

    assert.ok(transitionMessage.length > 0, 'the transition entry must refuse');
    assert.strictEqual(transitionMessage, implementMessage);
  });

  test('PTR6 --dry-run warns instead of throwing', async () => {
    writePlan(CONTRADICTING);
    const repo = new MemoryStateRepository(planCheckpoint().toSnapshot());
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(String(message));
    try {
      const sm = await new TransitionStageUseCase(
        repo as any,
        undefined,
        undefined,
        planGenerator() as any,
        undefined,
        undefined,
        new FileSourceReader() as any
      ).execute({ targetStage: STAGE_APPROVAL, issue: 432, workspaceDir: root, dryRun: true });
      assert.strictEqual(sm.currentStage, STAGE_APPROVAL);
    } finally {
      console.warn = original;
    }
    assert.strictEqual(repo.saves, 0);
    assert.ok(
      warnings.some((warning) => warning.includes('tests/application/run-lifecycle.test.ts')),
      `the warning must name the file: ${warnings.join('\n')}`
    );
  });
});
