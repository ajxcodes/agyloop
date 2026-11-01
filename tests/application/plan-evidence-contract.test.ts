/**
 * agyloop - Plan evidence contract (issue #432, TR-21..TR-26b)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertPlanEvidenceContract } = require('../../dist/application');
const { TransitionStageUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN
} = require('../../dist/domain');

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

function guard(content: string, dryRun = false): void {
  writePlan(content);
  assertPlanEvidenceContract({
    planGenerator: planGenerator() as any,
    planPath,
    workspaceDir: root,
    dryRun
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

const CHECKLIST_EXCLUDED = [
  '# Plan',
  '',
  '- **Acceptance Criteria:**',
  '- AC1: the historical risk row is corrected',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** Correct `artifacts/plans/425-task-plan/implementation_plan.md:162`',
  '',
  '### Quality Gate Targets',
  '- `npm run lint`'
].join('\n');

const AC_EXCLUDED = [
  '# Plan',
  '',
  '- **Acceptance Criteria:**',
  '- AC1: the row at `artifacts/plans/425-task-plan/implementation_plan.md` is corrected'
].join('\n');

const TRACKED = [
  '# Plan',
  '',
  '- **Acceptance Criteria:**',
  '- AC1: the doc comment at `src/infrastructure/git-worktree-manager.ts` is corrected',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** edit `src/infrastructure/git-worktree-manager.ts`'
].join('\n');

const OUT_OF_SCOPE = [
  '# Plan',
  '',
  '- **Acceptance Criteria:**',
  '- AC1: the historical risk row is corrected or declared out of scope',
  '- **Out of Scope:** the #425 historical row is gitignored, so it is not edited',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** edit `src/domain/constants.ts`'
].join('\n');

const OUTSIDE = [
  '# Plan',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** edit `/elsewhere/outside/file.ts`'
].join('\n');

const FENCED = [
  '# Plan',
  '',
  '- **Acceptance Criteria:**',
  '- AC1: the fixture is not scanned',
  '',
  '### Manual Smoke Test Protocol',
  '```bash',
  '- [ ] edit `artifacts/plans/425-task-plan/implementation_plan.md`',
  '```'
].join('\n');

describe('Plan evidence contract (issue #432)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('PE1 refuses a checklist step targeting an excluded tree', () => {
    assert.throws(
      () => guard(CHECKLIST_EXCLUDED),
      (err: any) =>
        /implementation checklist/.test(err.message) &&
        err.message.includes('artifacts/plans/425-task-plan/implementation_plan.md') &&
        /plan line 7/.test(err.message)
    );
  });

  test('PE2 refuses an acceptance criterion targeting an excluded tree', () => {
    assert.throws(
      () => guard(AC_EXCLUDED),
      (err: any) =>
        /acceptance criteria/.test(err.message) &&
        err.message.includes('artifacts/plans/425-task-plan/implementation_plan.md')
    );
  });

  test('PE3 a tracked-doc correction is accepted', () => {
    assert.doesNotThrow(() => guard(TRACKED));
  });

  test('PE4 an out-of-scope declaration satisfies the historical-plan rule', () => {
    assert.doesNotThrow(() => guard(OUT_OF_SCOPE));
  });

  test('PE5 an absolute path outside the workspace is refused', () => {
    assert.throws(
      () => guard(OUTSIDE),
      (err: any) =>
        err.message.includes('/elsewhere/outside/file.ts') &&
        /outside the workspace/.test(err.message)
    );
  });

  test('PE6 --dry-run warns and records nothing', async () => {
    writePlan(CHECKLIST_EXCLUDED);
    const sm = StateMachine.createInitial({ issue: 432 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.setPlanPath(planPath);
    const repo = new MemoryStateRepository(sm.toSnapshot());

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(String(message));
    try {
      await new TransitionStageUseCase(
        repo as any,
        undefined,
        undefined,
        planGenerator() as any
      ).execute({ targetStage: 'APPROVAL', issue: 432, workspaceDir: root, dryRun: true });
    } finally {
      console.warn = original;
    }

    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(repo.snapshot.approvedPlanDigest ?? null, null);
    assert.ok(warnings.some((warning) => warning.includes('artifacts/plans/425-task-plan')));
  });

  test('PE7 a fixture plan inside a smoke fence is not scanned', () => {
    assert.doesNotThrow(() => guard(FENCED));
    const unfenced = FENCED.replace('```bash\n', '').replace('\n```', '');
    assert.throws(() => guard(unfenced), /implementation checklist/);
  });
});
