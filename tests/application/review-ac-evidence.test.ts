/**
 * agyloop - Review AC evidence (issue #432, TR-27..TR-31)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RunReviewUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW
} = require('../../dist/domain');
const { ProcessCommandExecutor } = require('../../dist/infrastructure');

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function gitOk(cwd: string, args: string[]) {
  const result = git(cwd, args);
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`
  );
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

const CONFIG = {
  models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
  options: { commitAfter: false, gateTimeoutSeconds: 600, autoApproveInYolo: true }
};

let root: string;
let planPath: string;

function brief(): string {
  const sm = StateMachine.createInitial({ issue: 432 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  sm.transition(STAGE_REVIEW);
  sm.setPlanPath(planPath);
  sm.setBaseBranch('HEAD');
  return sm.toSnapshot();
}

function makeUseCase(options: { commandExecutor?: any } = {}) {
  const repo = new MemoryStateRepository(brief());
  const planGenerator = {
    resolvePlanFile: (opts: any) => ({ planPath: opts.planPath ?? planPath, summaryPath: null }),
    readPlanDocument: () => fs.readFileSync(planPath, 'utf8'),
    updateSummaryLog: () => true
  };
  const useCase = new RunReviewUseCase(
    repo as any,
    {
      loadConfig: () => CONFIG,
      resolveModel: (role: string) => ({
        role,
        configured: 'inherit',
        tier: 'inherit',
        apiModel: 'inherit'
      })
    } as any,
    planGenerator as any,
    undefined,
    undefined,
    options.commandExecutor,
    undefined,
    undefined,
    undefined
  );
  return { useCase, repo };
}

function writePlan(criteria: string[]): void {
  fs.writeFileSync(
    planPath,
    ['# Plan', '', '- **Acceptance Criteria:**', ...criteria, ''].join('\n')
  );
}

describe('Review AC evidence (issue #432)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-review-evidence-'));
    gitOk(root, ['init', '-q', '-b', 'main']);
    gitOk(root, ['config', 'user.email', 'smoke@example.com']);
    gitOk(root, ['config', 'user.name', 'smoke']);
    planPath = path.join(root, 'implementation_plan.md');
    writePlan(['- AC1: verified']);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    gitOk(root, ['add', '-A']);
    gitOk(root, ['commit', '-qm', 'init']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function executor() {
    return new ProcessCommandExecutor();
  }

  test('RAE1 an AC met on an excluded path escalates to CHANGES_REQUESTED', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: ok',
        'AC_EVIDENCE:',
        '- AC1: met — `artifacts/plans/425-task-plan/implementation_plan.md`'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    assert.ok(
      result.verdict.unfulfilledCriteria.some((criterion: string) =>
        criterion.includes('artifacts/plans/425-task-plan/implementation_plan.md')
      )
    );
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.deepStrictEqual(last.metadata.reviewAcEvidence.unverifiable, [
      'AC1 — `artifacts/plans/425-task-plan/implementation_plan.md`'
    ]);
  });

  test('RAE2 an AC met on a path outside the worktree is unverifiable', async () => {
    const { useCase } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: ok',
        'AC_EVIDENCE:',
        '- AC1: met — `/elsewhere/notes.md`'
      ].join('\n')
    });
    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    assert.ok(
      result.verdict.unfulfilledCriteria.some((criterion: string) =>
        criterion.includes('not in the delivered change set')
      )
    );
  });

  test('RAE3 an AC met on a changed or untracked path is accepted', async () => {
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const x = 1;\n');
    const { useCase } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: ok',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`'
      ].join('\n')
    });
    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.deepStrictEqual([...result.acEvidence.verified], ['AC1']);
  });

  test('RAE4 a verdict with no AC_EVIDENCE block records exactly as before', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: ok\n'
    });
    assert.strictEqual(result.verdict.status, 'APPROVED');
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(last.metadata, 'reviewAcEvidence'),
      false
    );
  });

  test('RAE5 an unmeasured change set does not fabricate unverifiability', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'main',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: ok',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`'
      ].join('\n')
    });
    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.strictEqual(result.acEvidence.measured, false);
    assert.ok((result.acEvidence.note ?? '').includes('main'));
  });
});
