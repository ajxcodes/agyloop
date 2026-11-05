function runGit(cwd: string, args: string[]) {
  return gitStatus(cwd, args, { stdio: 'pipe' });
}

/**
 * codeloop - Review AC evidence (issue #432, TR-27..TR-31)
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
  STAGE_REVIEW,
  REVIEWER_AC_EVIDENCE_STATUS_CONTRACT
} = require('../../dist/domain');
const { ProcessCommandExecutor } = require('../../dist/infrastructure');
const { gitStatus } = require('../helpers/sandbox.ts');


function runGitOk(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
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

function brief(baseBranch: string | null = 'HEAD'): string {
  const sm = StateMachine.createInitial({ issue: 432 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  sm.transition(STAGE_REVIEW);
  sm.setPlanPath(planPath);
  sm.setBaseBranch(baseBranch);
  return sm.toSnapshot();
}

function makeUseCase(options: { commandExecutor?: any; baseBranch?: string | null } = {}) {
  const repo = new MemoryStateRepository(brief(options.baseBranch));
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

/**
 * The #502 shape (issue #506): AC4 is a plan-declared operator step, so no
 * delivered path can exist for it.
 */
function writeOperatorStepPlan(): void {
  fs.writeFileSync(
    planPath,
    [
      '# Plan',
      '',
      '- **Acceptance Criteria:**',
      '- AC1: The release path refuses a label it cannot verify.',
      '- AC4: The phase/6-codeloop PR is opened by the operator after the change merges.',
      '',
      "- **Out of Scope:** Opening the real `phase/6-codeloop` PR during this run. AC4's label provisioning is an operator step (Step 11); the PR itself is opened by the operator after the change merges.",
      ''
    ].join('\n')
  );
}

/**
 * The #502 declaration-3 shape (issue #512): label provisioning is out of scope,
 * and the declaration MENTIONS AC1 only to say AC1's own release path is in
 * scope. It must never steer an AC1 gap to `out-of-scope`.
 */
const IN_SCOPE_MENTION =
  'Provisioning `release:*` labels from `codeloop init`. AC1 only requires the release path to provision-or-refuse; a startup validation in unrelated commands would make `status`/`next` depend on GitHub.';

function writeInScopeMentionPlan(): void {
  fs.writeFileSync(
    planPath,
    [
      '# Plan',
      '',
      '- **Acceptance Criteria:**',
      '- AC1: The release path refuses a label it cannot verify.',
      '- AC4: The phase/6-codeloop PR is opened by the operator after the change merges.',
      '',
      `- **Out of Scope:** ${IN_SCOPE_MENTION}`,
      ''
    ].join('\n')
  );
}

describe('Review AC evidence (issue #432)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-review-evidence-'));
    runGitOk(root, ['init', '-q', '-b', 'main']);
    runGitOk(root, ['config', 'user.email', 'smoke@example.com']);
    runGitOk(root, ['config', 'user.name', 'smoke']);
    planPath = path.join(root, 'implementation_plan.md');
    writePlan(['- AC1: verified']);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    runGitOk(root, ['add', '-A']);
    runGitOk(root, ['commit', '-qm', 'init']);
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

  test('RAE6 a blockless APPROVED verdict is refused when the plan declares criteria (issue #435)', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    await assert.rejects(
      () =>
        useCase.execute({
          issue: 432,
          workspaceDir: root,
          baseRef: 'HEAD',
          reviewOutput: 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: ok\n'
        }),
      (error: any) => {
        assert.match(error.message, /AC_EVIDENCE/);
        return true;
      }
    );
    assert.strictEqual(repo.saves, 0);
  });

  test('RAE7 a plan with no acceptance criteria still records a block-less APPROVED verdict (issue #435)', async () => {
    writePlan([]);
    const { useCase } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: ok\n'
    });
    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.strictEqual(result.acEvidence.reported, false);
  });

  test('RAE8 an APPROVED verdict with a malformed block is refused and names the line (issue #435)', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    await assert.rejects(
      () =>
        useCase.execute({
          issue: 432,
          workspaceDir: root,
          baseRef: 'HEAD',
          reviewOutput: [
            'REVIEW_STATUS: APPROVED',
            'REVIEW_SUMMARY: ok',
            'AC_EVIDENCE:',
            '- AC1 looks good'
          ].join('\n')
        }),
      (error: any) => {
        assert.match(error.message, /AC_EVIDENCE/);
        assert.match(error.message, /AC1 looks good/);
        return true;
      }
    );
    assert.strictEqual(repo.saves, 0);
  });

  test('RAE9 a delivered path cited with a line suffix verifies instead of escalating (issue #435)', async () => {
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
        '- AC1: met — `delivered.ts:42`'
      ].join('\n')
    });
    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.deepStrictEqual([...result.acEvidence.verified], ['AC1']);
  });

  test('RAE10 a CHANGES_REQUESTED verdict with a malformed block is recorded, not refused (issue #435)', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: CHANGES_REQUESTED',
        'REVIEW_SUMMARY: needs work',
        'AC_EVIDENCE:',
        '- AC1 looks good'
      ].join('\n')
    });
    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    assert.strictEqual(repo.saves, 1);
  });

  test('RAE11 a verdict evidencing 1 of 2 declared criteria still approves, so the prompt must not demand coverage (issue #439)', async () => {
    writePlan(['- AC1: verified', '- AC2: also declared']);
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const x = 1;\n');
    const { useCase } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: only AC1 was checked',
        'UNFULFILLED_AC:',
        '- None',
        'REMEDIATION_GUIDANCE:',
        '- None',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`'
      ].join('\n')
    });
    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.deepStrictEqual([...result.acEvidence.verified], ['AC1']);
  });

  test('RAE12 the #445 round-1 verdict naming its own critique report records APPROVED (issue #449)', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const x = 1;\n');
    const reportPath = path.join(root, '.agyloop', 'critique', '445.json');
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        `REVIEW_SUMMARY: Both tiers clean; AC1–AC5 are met against the delivered diff. Orchestrator note: the Tier 1 command wrote the report, so \`${reportPath}\` has no sidecar and filing it will record \`critiqueVerified: false\`.`,
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`',
        '- AC2: met — `delivered.ts`',
        '- AC3: met — `delivered.ts`',
        '- AC4: met — `delivered.ts`',
        '- AC5: met — `delivered.ts`'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.strictEqual(result.reviewSource, 'reviewer-output');
    assert.deepStrictEqual([...result.acEvidence.unverifiable], []);
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.strictEqual(last.metadata.reviewerVerdict, 'APPROVED');
    assert.ok(!('reviewAcEvidence' in last.metadata));
  });

  test("RAE13 a CRITIQUE_REPORT line naming the run's own report never escalates, wherever it sits (issue #449)", async () => {
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const x = 1;\n');
    const reportPath = path.join(root, '.agyloop', 'critique', '445.json');
    const block = ['AC_EVIDENCE:', '- AC1: met — `delivered.ts`'];
    const shapes = [
      ['before the block', ['REVIEW_STATUS: APPROVED', 'REVIEW_SUMMARY: Both tiers clean.', `CRITIQUE_REPORT: \`${reportPath}\``, ...block]],
      ['after the block', ['REVIEW_STATUS: APPROVED', 'REVIEW_SUMMARY: Both tiers clean.', ...block, `CRITIQUE_REPORT: \`${reportPath}\``]],
      ['relative', ['REVIEW_STATUS: APPROVED', 'REVIEW_SUMMARY: Both tiers clean.', 'CRITIQUE_REPORT: `.agyloop/critique/445.json`', ...block]],
      ['bare', ['REVIEW_STATUS: APPROVED', 'REVIEW_SUMMARY: Both tiers clean.', `CRITIQUE_REPORT: ${reportPath}`, ...block]]
    ];
    for (const [name, lines] of shapes) {
      const { useCase } = makeUseCase({ commandExecutor: executor() });
      const result = await useCase.execute({
        issue: 432,
        workspaceDir: root,
        baseRef: 'HEAD',
        reviewOutput: (lines as string[]).join('\n')
      });
      assert.strictEqual(result.verdict.status, 'APPROVED', name as string);
      assert.deepStrictEqual([...result.acEvidence.unverifiable], [], name as string);
    }
  });

  test('RAE14 a commit-excluded path in prose outside AC_EVIDENCE never escalates (issue #449)', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const x = 1;\n');
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: Both tiers clean.',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`',
        'The plan row reads (`artifacts/plans/449/implementation_plan.md`) and is unchanged.'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.deepStrictEqual([...result.acEvidence.unverifiable], []);
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.ok(!('reviewAcEvidence' in last.metadata));
  });

  test("RAE15 an AC met on the tool's own .agyloop report path still escalates (issue #449)", async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: Both tiers clean.',
        'AC_EVIDENCE:',
        '- AC2: met — `.agyloop/critique/445.json`'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    assert.strictEqual(result.reviewSource, 'reviewer-output+critique-escalation');
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.deepStrictEqual(last.metadata.reviewAcEvidence.unverifiable, [
      'AC2 — `.agyloop/critique/445.json`'
    ]);
  });

  test('RAE16 a verdict citing a backticked literal beside delivered paths stays APPROVED (issue #464)', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const x = 1;\n');
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: Both tiers clean.',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts` (SCD1 records `protocol-not-declared`)'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.strictEqual(result.reviewSource, 'reviewer-output');
    assert.deepStrictEqual([...result.acEvidence.verified], ['AC1']);
    assert.deepStrictEqual([...result.acEvidence.unverifiable], []);
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.strictEqual(last.metadata.reviewerVerdict, 'APPROVED');
    assert.ok(!('reviewAcEvidence' in last.metadata));
  });

  test('RAE17 a backticked path-shaped citation absent from the diff still escalates, naming it (issue #464)', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const x = 1;\n');
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: Both tiers clean.',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`, `src/domain/missing.ts`'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    assert.strictEqual(result.reviewSource, 'reviewer-output+critique-escalation');
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.deepStrictEqual(last.metadata.reviewAcEvidence.unverifiable, [
      'AC1 — `src/domain/missing.ts`'
    ]);
  });

  test('RAE18 a backtick-quoted node_modules path still escalates (issue #464)', async () => {
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 432,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: Both tiers clean.',
        'AC_EVIDENCE:',
        '- AC1: met — `node_modules/left-pad/index.js`'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.deepStrictEqual(last.metadata.reviewAcEvidence.unverifiable, [
      'AC1 — `node_modules/left-pad/index.js`'
    ]);
  });

  test('RAE19 a #502-shaped operator-step AC reported out-of-scope approves in one round (#506 AC3/AC4)', async () => {
    writeOperatorStepPlan();
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const shipped = 1;\n');
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 506,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: #502-shaped round',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`',
        '- AC4: out-of-scope'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.strictEqual(result.reviewSource, 'reviewer-output');
    assert.deepStrictEqual([...result.acEvidence.outOfScope], ['AC4']);
    assert.deepStrictEqual([...result.acEvidence.unverifiable], []);
    assert.strictEqual(repo.saves, 1);
    const history = repo.snapshot.history;
    assert.strictEqual(history[history.length - 1].stage, 'COMMIT');
    assert.strictEqual(history[history.length - 2].stage, 'REVIEW');
    assert.ok(!('reviewAcEvidence' in history[history.length - 1].metadata));
  });

  test('RAE20 the same plan-declared AC reported unverifiable is refused with out-of-scope and the declaration named (#506 AC2)', async () => {
    writeOperatorStepPlan();
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const shipped = 1;\n');
    const { useCase } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 506,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: #502-shaped round',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`',
        '- AC4: unverifiable — `ajxcodes/agyloop`'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    assert.strictEqual(result.reviewSource, 'reviewer-output+critique-escalation');
    const criteria = result.verdict.unfulfilledCriteria.join('\n');
    assert.ok(criteria.includes('out-of-scope'), criteria);
    assert.ok(criteria.includes("AC4's label provisioning is an operator step"), criteria);
  });

  test('RAE21 the review use case renders the plan\'s out-of-scope declaration into its own AC_EVIDENCE contract (#506 AC1)', async () => {
    writeOperatorStepPlan();
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const shipped = 1;\n');
    const { useCase } = makeUseCase({ commandExecutor: executor() });
    const result = await useCase.execute({
      issue: 506,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: #502-shaped round',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`',
        '- AC4: out-of-scope'
      ].join('\n')
    });

    assert.ok(result.taskPrompt.includes(REVIEWER_AC_EVIDENCE_STATUS_CONTRACT));
    assert.ok(result.taskPrompt.includes("AC4's label provisioning is an operator step"));
  });

  test('RAE22 the #502 declaration shape refuses a real AC1 gap without steering it out-of-scope (#512 AC4)', async () => {
    writeInScopeMentionPlan();
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const shipped = 1;\n');
    const { useCase, repo } = makeUseCase({ commandExecutor: executor() });
    const GAP = 'AC1 — `src/domain/missing.ts`';
    const reviewOutput = [
      'REVIEW_STATUS: APPROVED',
      'REVIEW_SUMMARY: real gap in AC1',
      'AC_EVIDENCE:',
      '- AC1: unverifiable — `src/domain/missing.ts`'
    ].join('\n');

    const result = await useCase.execute({
      issue: 512,
      workspaceDir: root,
      baseRef: 'HEAD',
      reviewOutput
    });

    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    assert.strictEqual(result.reviewSource, 'reviewer-output+critique-escalation');
    const criteria = result.verdict.unfulfilledCriteria.join('\n');
    const remediation = result.verdict.remediationGuidance.join('\n');
    assert.ok(
      criteria.includes(`[Unverifiable evidence] ${GAP} is not in the delivered change set`),
      criteria
    );
    assert.ok(!criteria.includes('out-of-scope'), criteria);
    assert.ok(!remediation.includes('out-of-scope'), remediation);
    assert.ok(!remediation.includes('Report AC1 as'), remediation);
    assert.ok(
      remediation.includes(
        `Cite tracked evidence for [Unverifiable evidence] ${GAP} is not in the delivered change set`
      ),
      remediation
    );
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.deepStrictEqual(last.metadata.reviewAcEvidence.unverifiable, [GAP]);
  });

  function commitDeliveredOnBranch(): void {
    runGitOk(root, ['checkout', '-qb', 'phase/6-codeloop']);
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const delivered = 1;\n');
    runGitOk(root, ['add', '-A']);
    runGitOk(root, ['commit', '-qm', 'feat: delivered']);
  }

  test('RAE23 a committed change in a checkpoint with no baseBranch is recognised as delivered (#450 AC2)', async () => {
    commitDeliveredOnBranch();
    const { useCase } = makeUseCase({ commandExecutor: executor(), baseBranch: null });
    const result = await useCase.execute({
      issue: 523,
      workspaceDir: root,
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: committed change reviewed',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.deepStrictEqual([...result.acEvidence.verified], ['AC1']);
    assert.strictEqual(result.acEvidence.baseRef, 'main');
  });

  test('RAE24 the no-base review record names main, never null, beside the certified base (#450 AC3)', async () => {
    commitDeliveredOnBranch();
    const { useCase, repo } = makeUseCase({ commandExecutor: executor(), baseBranch: null });
    const result = await useCase.execute({
      issue: 523,
      workspaceDir: root,
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: one delivered path, one gap',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts`, `src/domain/missing.ts`'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
    const last = repo.snapshot.history[repo.snapshot.history.length - 1];
    assert.strictEqual(last.metadata.reviewAcEvidence.baseRef, 'main');
    assert.deepStrictEqual(last.metadata.reviewAcEvidence.unverifiable, ['AC1 — `src/domain/missing.ts`']);
  });

  test('RAE25 a verdict citing the reviewed base in backticks beside a delivered path stays APPROVED (#473 AC4)', async () => {
    runGitOk(root, ['checkout', '-qb', 'phase/6-codeloop']);
    fs.writeFileSync(path.join(root, 'delivered.ts'), 'export const delivered = 1;\n');
    const { useCase } = makeUseCase({
      commandExecutor: executor(),
      baseBranch: 'phase/6-codeloop'
    });
    const result = await useCase.execute({
      issue: 523,
      workspaceDir: root,
      baseRef: 'phase/6-codeloop',
      reviewOutput: [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: base ref named in prose',
        'AC_EVIDENCE:',
        '- AC1: met — `delivered.ts` (diff vs `phase/6-codeloop`)'
      ].join('\n')
    });

    assert.strictEqual(result.verdict.status, 'APPROVED');
    assert.deepStrictEqual([...result.acEvidence.unverifiable], []);
  });
});
