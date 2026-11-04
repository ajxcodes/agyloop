function runGit(cwd: string, args: string[]): string {
  return String(gitIn(cwd, args, { stdio: 'pipe', encoding: 'utf8' })).trim();
}

/**
 * agyloop - Test Register contract (issue #432, TR-15..TR-20)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
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
  STAGE_IMPLEMENT,
  findTestIdCollisions
} = require('../../dist/domain');
const { FileSourceReader } = require('../../dist/infrastructure');
const { gitIn } = require('../helpers/sandbox.ts');

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

const TABLE_CONTRADICTING = [
  '# Plan',
  '',
  '- **Acceptance Criteria:**',
  '- AC1: the standard leg parks',
  '',
  '### Test Register',
  '',
  '| Case | Pins | Asserts |',
  '| --- | --- | --- |',
  '| **TR-1** the standard leg | **Pins:** `tests/pinned.test.ts` :: `fresh run halts at PLAN` | **Asserts:** `assert.strictEqual(result.pausedAtGate, GATE_APPROVAL)` |'
].join('\n');

const EMPTY_REGISTER = [
  '# Plan',
  '',
  '### Test Register',
  '',
  '| Case | Assertions |',
  '| --- | --- |',
  '| plain row with no bold id | nothing |'
].join('\n');

const NO_HEADING = [
  '# Plan',
  '',
  '- **Acceptance Criteria:**',
  '- AC1: the correction lands in the tracked suite',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** Update `src/application/run-review.ts`'
].join('\n');

const IT_PIN_CONTRADICTING = [
  '### Test Register',
  '- **TR-1** — **Pins:** `tests/it-alias.test.ts` :: `resolves base branch`',
  '  - **Asserts:** `assert.strictEqual(pausedAtGate, GATE_APPROVAL)`'
].join('\n');

const IT_DUPLICATE_NEW = [
  '### Test Register',
  '- **TR-2** — **New test:** `tests/it-alias.test.ts` :: `resolves base branch`',
  '  - **Asserts:** `assert.strictEqual(pausedAtGate, undefined)`'
].join('\n');

const SCAFFOLD_REGISTER = [
  '# Plan',
  '',
  '### Test Register',
  '<!-- One row per pinned assertion: `- **TR-1** — **Pins:** `path` :: `test title`` (or `**New test:**`) plus a `**Asserts:**` literal. A `Pins:` row must restate the pinned literal exactly; APPROVAL refuses a contradicting row and names `file:line`. -->'
].join('\n');

const EMPTY_HEADING = ['# Plan', '', '### Test Register', ''].join('\n');

const TABLE_MISSING_MARKER = [
  '# Plan',
  '',
  '### Test Register',
  '',
  '| Case | Assertions |',
  '| --- | --- |',
  '| **TR-5** a row with no marker | **Asserts:** `assert.strictEqual(a, 1)` |'
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

const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;


interface GitFixture {
  /** The mkdtemp root; removing it removes the repository and the worktree. */
  readonly root: string;
  /** The pristine repository (base branch `main`). */
  readonly repo: string;
  /** The task worktree holding the implementation's UNCOMMITTED new test. */
  readonly wt: string;
  /** The plan file the guard reads, inside the worktree. */
  readonly planPath: string;
}

/**
 * Issue #489's reported shape, built with real git: `main` holds
 * `tests/base.test.ts` with the title `already on base`; the task worktree
 * `task/489` carries the implementation's own uncommitted
 * `tests/added.test.ts` with the title `added by the implementation`.
 */
function makeGitFixture(): GitFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-489-register-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  runGit(repo, ['init', '-q', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(
    path.join(repo, 'tests', 'base.test.ts'),
    [
      "const assert = require('node:assert');",
      "test('already on base', () => {",
      '  assert.strictEqual(1, 1);',
      '});'
    ].join('\n')
  );
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-qm', 'base: the pre-change tree']);
  runGit(repo, ['worktree', 'add', '-q', '-b', 'task/489', wt, 'main']);
  fs.writeFileSync(
    path.join(wt, 'tests', 'added.test.ts'),
    [
      "const assert = require('node:assert');",
      "test('added by the implementation', () => {",
      '  assert.strictEqual(2, 2);',
      '});'
    ].join('\n')
  );
  return { root, repo, wt, planPath: path.join(wt, 'implementation_plan.md') };
}

const NEW_IN_WORKTREE = [
  '# Plan',
  '',
  '### Test Register',
  '- **TR-1** — the case under test',
  '  - **New test:** `tests/added.test.ts` :: `added by the implementation`',
  '  - **Asserts:** `assert.strictEqual(2, 2)`'
].join('\n');

const NEW_ON_BASE = NEW_IN_WORKTREE.replace(
  '`tests/added.test.ts` :: `added by the implementation`',
  '`tests/base.test.ts` :: `already on base`'
).replace('assert.strictEqual(2, 2)', 'assert.strictEqual(1, 1)');

const PIN_IN_WORKTREE = [
  '# Plan',
  '',
  '### Test Register',
  '- **TR-1** — the delivered case',
  '  - **Pins:** `tests/added.test.ts` :: `added by the implementation`',
  '  - **Asserts:** `assert.strictEqual(2, 2)`'
].join('\n');

const PIN_BASE_ONLY = PIN_IN_WORKTREE.replace(
  '`tests/added.test.ts` :: `added by the implementation`',
  '`tests/base.test.ts` :: `already on base`'
).replace('assert.strictEqual(2, 2)', 'assert.strictEqual(1, 1)');

const ID_FIXTURE_SOURCE = [
  "const assert = require('node:assert');",
  "test('PBC15: the existing case', () => {",
  '  assert.strictEqual(1, 1);',
  '});'
].join('\n');

const FRESH_ID_ROW = [
  '### Test Register',
  '- **TR-1** — a fresh case',
  '  - **New test:** `tests/application/run-lifecycle.test.ts` :: `PBC16: a fresh case`',
  '  - **Asserts:** `assert.strictEqual(1, 1)`'
].join('\n');

const FRESH_ID_CHECKLIST = [
  '# Plan',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** Add `PBC16` to `tests/application/run-lifecycle.test.ts`'
].join('\n');

const REUSED_ID_ROW = [
  '### Test Register',
  '- **TR-1** — a reused id',
  '  - **New test:** `tests/application/id-fixture.test.ts` :: `PBC15: a reused case`',
  '  - **Asserts:** `assert.strictEqual(1, 1)`'
].join('\n');

const REUSED_ID_TITLE_ROW = [
  '### Test Register',
  '- **TR-1** — a duplicated title',
  '  - **New test:** `tests/application/id-fixture.test.ts` :: `PBC15: the existing case`',
  '  - **Asserts:** `assert.strictEqual(1, 1)`'
].join('\n');

const REUSED_ID_CHECKLIST = [
  '# Plan',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** Add `PBC15` to `tests/application/id-fixture.test.ts`'
].join('\n');

/** Runs the guard at `workspace` with an explicit base reference. */
function guardAt(
  workspace: string,
  planFile: string,
  content: string,
  baseRef?: string | null
): void {
  fs.writeFileSync(planFile, content);
  assertPlanTestRegisterContract({
    planGenerator: planGenerator() as any,
    sourceFileReader: new FileSourceReader() as any,
    planPath: planFile,
    workspaceDir: workspace,
    baseRef
  });
}

/** A plan generator bound to one file, for the use-case-level parity case. */
function boundPlanGenerator(file: string) {
  return {
    readPlanDocument: (p: string) => fs.readFileSync(p, 'utf8'),
    resolvePlanFile: () => ({ planPath: file })
  };
}

/** A checkpoint parked at PLAN with `baseBranch: main` recorded (issue #489). */
function gitPlanCheckpoint(planFile: string): any {
  const sm = StateMachine.createInitial({ issue: 489 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.setPlanPath(planFile);
  sm.setBaseBranch('main');
  return sm.toSnapshot();
}

/** The same checkpoint one approval further on, for `codeloop implement`. */
function gitApprovalCheckpoint(planFile: string): any {
  const sm = StateMachine.createInitial({ issue: 489 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.setPlanPath(planFile);
  sm.setBaseBranch('main');
  return sm.toSnapshot();
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
    fs.writeFileSync(
      path.join(root, 'tests', 'pinned.test.ts'),
      [
        "const assert = require('node:assert');",
        "test('fresh run halts at PLAN', () => {",
        '  const result = { pausedAtGate: undefined };',
        '  assert.strictEqual(result.pausedAtGate, undefined);',
        '});'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(root, 'tests', 'it-alias.test.ts'),
      [
        "const assert = require('node:assert');",
        "it('resolves base branch', () => {",
        '  const pausedAtGate = undefined;',
        '  assert.strictEqual(pausedAtGate, undefined);',
        '});'
      ].join('\n')
    );
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

  test('PTR7 a table register that contradicts its pinned test is refused with file:line', () => {
    assert.throws(
      () => guard(TABLE_CONTRADICTING),
      (err: any) => {
        assert.strictEqual(/pinned\.test\.ts:4/.test(err.message), true);
        assert.strictEqual(err.message.includes('GATE_APPROVAL'), true);
        return true;
      }
    );
  });

  test('PTR8 a register heading with zero parsable rows is refused naming the heading line', () => {
    assert.throws(
      () => guard(EMPTY_REGISTER),
      (err: any) => {
        assert.strictEqual(err.message.includes('plan line 3'), true);
        assert.strictEqual(err.message.includes('**Pins:**'), true);
        return true;
      }
    );
  });

  test('PTR9 a plan with no Test Register heading still passes', () => {
    assert.doesNotThrow(() => guard(NO_HEADING));
    let refused = false;
    try {
      guard(NO_HEADING);
    } catch {
      refused = true;
    }
    assert.strictEqual(refused, false);
  });

  test('PTR10 an it-declared pin contradicts and is refused with file:line', () => {
    assert.throws(
      () => guard(IT_PIN_CONTRADICTING),
      (err: any) => {
        assert.strictEqual(/it-alias\.test\.ts:4/.test(err.message), true);
        return true;
      }
    );
  });

  test('PTR11 a New test row for an existing it-declared case is refused naming the line', () => {
    assert.throws(
      () => guard(IT_DUPLICATE_NEW),
      (err: any) => {
        assert.strictEqual(/\(line 2\)/.test(err.message), true);
        return true;
      }
    );
  });

  test('PTR12 the scaffold comment-only heading is accepted, but an empty heading is refused', () => {
    assert.doesNotThrow(() => guard(SCAFFOLD_REGISTER));
    assert.throws(
      () => guard(EMPTY_HEADING),
      (err: any) =>
        err.message.includes('plan line 3') && err.message.includes('**Pins:**')
    );
    assert.throws(() => guard(EMPTY_REGISTER), /plan line 3/);
  });

  test('PTR13 a table row with only Asserts is refused as missing a marker', () => {
    assert.throws(
      () => guard(TABLE_MISSING_MARKER),
      (err: any) =>
        err.message.includes('TR-5') &&
        /Pins/.test(err.message) &&
        /New test/.test(err.message)
    );
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

  test('PTR14 a New test in a dirty worktree is accepted when it is absent at the base (AC1, issue #489)', () => {
    if (!GIT_AVAILABLE) return;
    const fixture = makeGitFixture();
    try {
      assert.doesNotThrow(() => guardAt(fixture.wt, fixture.planPath, NEW_IN_WORKTREE, 'main'));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('PTR15 a New test that exists at the base is refused from the dirty worktree (AC2, issue #489)', () => {
    if (!GIT_AVAILABLE) return;
    const fixture = makeGitFixture();
    try {
      assert.throws(
        () => guardAt(fixture.wt, fixture.planPath, NEW_ON_BASE, 'main'),
        (err: any) => {
          assert.strictEqual(/tests\/base\.test\.ts/.test(err.message), true);
          assert.strictEqual(/\(line 2\)/.test(err.message), true);
          return true;
        }
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('PTR16 a Pins row still resolves against the delivered worktree (AC3, issue #489)', () => {
    if (!GIT_AVAILABLE) return;
    const fixture = makeGitFixture();
    try {
      assert.doesNotThrow(() => guardAt(fixture.wt, fixture.planPath, PIN_IN_WORKTREE, 'main'));
      fs.rmSync(path.join(fixture.wt, 'tests', 'base.test.ts'));
      assert.throws(
        () => guardAt(fixture.wt, fixture.planPath, PIN_BASE_ONLY, 'main'),
        /cannot be resolved inside the workspace/
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('PTR17 a first approval on a pristine worktree refuses a base duplicate (AC2, AC4, issue #489)', () => {
    if (!GIT_AVAILABLE) return;
    const fixture = makeGitFixture();
    try {
      fs.rmSync(path.join(fixture.wt, 'tests', 'added.test.ts'));
      assert.throws(() => guardAt(fixture.wt, fixture.planPath, NEW_ON_BASE, 'main'), /already on base/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('PTR18 both approval entry points agree on the base-revision verdict (AC4, issue #489)', async () => {
    if (!GIT_AVAILABLE) return;
    const fixture = makeGitFixture();
    try {
      fs.writeFileSync(fixture.planPath, NEW_IN_WORKTREE);
      const planGen = boundPlanGenerator(fixture.planPath);

      let transitionVerdict = 'ACCEPTED';
      try {
        await new TransitionStageUseCase(
          new MemoryStateRepository(gitPlanCheckpoint(fixture.planPath)) as any,
          undefined,
          undefined,
          planGen as any,
          undefined,
          undefined,
          new FileSourceReader() as any
        ).execute({ targetStage: STAGE_APPROVAL, issue: 489, workspaceDir: fixture.wt });
      } catch (err: any) {
        transitionVerdict = err.message;
      }

      let implementVerdict = 'ACCEPTED';
      try {
        await new StartImplementationUseCase(
          new MemoryStateRepository(gitApprovalCheckpoint(fixture.planPath)) as any,
          // The guard must PASS here, so the use case continues into
          // `ResolveSubagentUseCase` — the config double therefore needs the
          // model seam, not just `loadConfig` (measured: without it the case
          // fails with `this.configRepo.resolveModel is not a function`).
          {
            loadConfig: () => ({ models: {}, options: {} }),
            resolveModel: () => ({ configured: 'inherit', tier: 'inherit', apiModel: 'inherit' }),
            mapModelToTier: () => 'inherit'
          } as any,
          planGen as any,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          new FileSourceReader() as any
        ).execute({ issue: 489, planPath: fixture.planPath, workspaceDir: fixture.wt, noWorktree: true });
      } catch (err: any) {
        implementVerdict = err.message;
      }

      assert.strictEqual(transitionVerdict, 'ACCEPTED');
      assert.strictEqual(implementVerdict, 'ACCEPTED');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('PTR19 an unresolvable base revision falls back to the working-tree check (issue #489)', () => {
    if (!GIT_AVAILABLE) return;
    const fixture = makeGitFixture();
    try {
      assert.throws(
        () => guardAt(fixture.wt, fixture.planPath, NEW_IN_WORKTREE, 'no-such-branch'),
        /is not new/
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('PTR20 a planned test id absent from the target file passes (#518 AC4)', () => {
    assert.doesNotThrow(() => guard(FRESH_ID_ROW));
    assert.doesNotThrow(() => guard(FRESH_ID_CHECKLIST));
  });

  test('PTR21 an existing test id is refused naming the colliding file:line (#518 AC5)', () => {
    fs.writeFileSync(path.join(root, 'tests', 'application', 'id-fixture.test.ts'), ID_FIXTURE_SOURCE);
    assert.throws(
      () => guard(REUSED_ID_ROW),
      (err: any) => /id-fixture\.test\.ts:2/.test(err.message) && err.message.includes('PBC15')
    );

    let message = '';
    try {
      guard(REUSED_ID_TITLE_ROW);
    } catch (err: any) {
      message = err.message;
    }
    assert.ok(/that exact title/.test(message), `the title refusal must stand: ${message}`);
    assert.strictEqual(
      /A test id must be unique inside its file/.test(message),
      false,
      'one row must not produce two refusals'
    );
  });

  test('PTR22 the checklist channel refuses a reused id and the live duplicate is detected (#518 AC5/AC6)', () => {
    fs.writeFileSync(path.join(root, 'tests', 'application', 'id-fixture.test.ts'), ID_FIXTURE_SOURCE);
    assert.throws(
      () => guard(REUSED_ID_CHECKLIST),
      (err: any) => /id-fixture\.test\.ts:2/.test(err.message)
    );

    const live = fs.readFileSync(
      path.join(__dirname, '..', '..', 'tests/application/plan-baseline-contract.test.ts'),
      'utf8'
    );
    assert.deepStrictEqual(
      findTestIdCollisions(live, 'PBC15').map((collision: any) => collision.line),
      [859, 905]
    );
    assert.strictEqual(findTestIdCollisions(live, 'PBC2b').length, 1);
    assert.strictEqual(findTestIdCollisions(live, 'PBC2c').length, 1);
    assert.strictEqual(findTestIdCollisions(live, 'PBC3c').length, 1);
    assert.strictEqual(findTestIdCollisions(live, 'PBC2').length, 1);
  });
});
