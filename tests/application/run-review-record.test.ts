/**
 * agyloop - ONE review record: round, base commit, one note (issue #284, AC3/AC6)
 *
 * The defect: each review round APPENDED its note, so a re-review left two
 * verdicts with no supersede marker and two `Suggested Commit` lines — the
 * latter fabricated from the PLAN FILENAME (`implementation_plan`).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  StateMachine,
  Stage,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT
} = require('../../dist/domain');
const { RunReviewUseCase } = require('../../dist/application');
const { FilePlanGenerator, DEFAULT_CONFIG } = require('../../dist/infrastructure');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ISSUE = 490;

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

const CHANGES_BLOCK = `REVIEW_STATUS: CHANGES_REQUESTED
REVIEW_SUMMARY: The nil dereference is still unfixed.
UNFULFILLED_AC:
- The nil dereference is fixed
REMEDIATION_GUIDANCE:
- Fix the dereference.
`;

class MockStateRepository {
  public savedSnapshot: any;

  constructor(snapshot: any) {
    this.savedSnapshot = snapshot;
  }

  async load(): Promise<any> {
    return this.savedSnapshot;
  }

  async save(snapshot: any): Promise<void> {
    this.savedSnapshot = snapshot;
  }

  async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  getStateFilePath(): string {
    return '/fake/state.json';
  }
}

class MockConfigRepository {
  loadConfig(): any {
    return DEFAULT_CONFIG;
  }

  resolveModel(role: any): any {
    return { role, configured: 'flash', tier: 'flash', apiModel: 'gemini-3.5-flash' };
  }

  mapModelToTier(): any {
    return 'flash';
  }
}

class MockCommandExecutor {
  public headSha: string;
  public rejectRevParse = false;
  public commands: string[] = [];

  constructor(headSha: string) {
    this.headSha = headSha;
  }

  async execute(command: string): Promise<any> {
    this.commands.push(command);
    if (command === 'git rev-parse HEAD') {
      if (this.rejectRevParse) {
        throw new Error('git is unavailable');
      }
      return { command, exitCode: 0, stdout: `${this.headSha}\n`, stderr: '', combinedOutput: '', durationMs: 1, timedOut: false };
    }
    return { command, exitCode: 0, stdout: '', stderr: '', combinedOutput: '', durationMs: 1, timedOut: false };
  }
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeSnapshot(currentStage: any, history: any[]) {
  const sm = new StateMachine({ stage: new Stage(currentStage), issue: ISSUE });
  const snapshot = sm.toSnapshot();
  return { ...snapshot, issue: ISSUE, history };
}

function makeSummary(): { dir: string; summaryPath: string; planPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-review-record-'));
  fs.writeFileSync(
    path.join(dir, 'implementation_plan.md'),
    '# [Implementation] - Probe\n\n- [ ] Step 1\n',
    'utf8'
  );
  const summaryPath = path.join(dir, 'CodeLoop Summary.md');
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', 'summary-log.md'), summaryPath);
  return { dir, summaryPath, planPath: path.join(dir, 'implementation_plan.md') };
}

describe('review record (issue #284, AC3/AC6)', () => {
  test('a re-review leaves exactly ONE note, naming the round and the base commit', async () => {
    const { dir, summaryPath, planPath } = makeSummary();
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-review-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: sandbox, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: sandbox, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: sandbox, stdio: 'ignore' });
      fs.writeFileSync(path.join(sandbox, 'README.md'), 'probe\n', 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: sandbox, stdio: 'ignore' });
      execFileSync('git', ['commit', '-qm', 'chore: probe'], { cwd: sandbox, stdio: 'ignore' });
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sandbox, encoding: 'utf8' }).trim();

      const planGenerator = new FilePlanGenerator();
      planGenerator.resolvePlanFile = () => ({
        planDir: dir,
        planPath,
        planFileName: 'implementation_plan.md',
        summaryPath
      });

      // Round 1: checkpoint at QUALITY_GATE, first review.
      const round1State = new MockStateRepository(
        makeSnapshot(STAGE_QUALITY_GATE, [
          { stage: STAGE_QUALITY_GATE, timestamp: iso(-120_000) }
        ])
      );
      const round1 = new RunReviewUseCase(
        round1State,
        new MockConfigRepository(),
        planGenerator,
        undefined,
        undefined,
        new MockCommandExecutor(headSha)
      );
      const first = await round1.execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK, workspaceDir: sandbox });
      assert.strictEqual(first.reviewRound, 1);
      assert.strictEqual(first.reviewedBaseCommit, headSha);

      // Round 2: the checkpoint was re-entered at REVIEW after the base moved.
      const round2State = new MockStateRepository(
        makeSnapshot(STAGE_REVIEW, [
          { stage: STAGE_QUALITY_GATE, timestamp: iso(-600_000) },
          { stage: STAGE_REVIEW, timestamp: iso(-500_000), metadata: { reviewerVerdict: 'APPROVED' } },
          { stage: STAGE_COMMIT, timestamp: iso(-400_000) },
          { stage: STAGE_QUALITY_GATE, timestamp: iso(-300_000) },
          { stage: STAGE_REVIEW, timestamp: iso(-120_000) }
        ])
      );
      const round2 = new RunReviewUseCase(
        round2State,
        new MockConfigRepository(),
        planGenerator,
        undefined,
        undefined,
        new MockCommandExecutor(headSha)
      );
      const second = await round2.execute({ issue: ISSUE, reviewOutput: CHANGES_BLOCK, workspaceDir: sandbox });

      assert.strictEqual(second.reviewRound, 2, 'the second round must be numbered 2');
      assert.strictEqual(second.reviewedBaseCommit, headSha);
      assert.strictEqual(second.reviewerVerdict, 'CHANGES_REQUESTED');

      const summary = fs.readFileSync(summaryPath, 'utf8');
      const bullets = summary.match(/^- \*\*Round /gm) ?? [];
      assert.strictEqual(bullets.length, 1, `exactly one review note expected, got:\n${summary}`);
      assert.ok(summary.includes('Round 2'), `the note must name round 2, got:\n${summary}`);
      assert.ok(
        summary.includes(`base \`${headSha.slice(0, 7)}\``),
        `the note must name the reviewed base commit, got:\n${summary}`
      );
      assert.ok(
        !summary.includes('Suggested Commit'),
        `no fabricated subject may appear, got:\n${summary}`
      );
      assert.ok(
        !summary.includes('implementation_plan'),
        `the scaffold filename must never be a commit subject, got:\n${summary}`
      );

      const last = second.stateMachine.history[second.stateMachine.history.length - 1];
      assert.strictEqual(last.metadata.reviewRound, 2);
      assert.strictEqual(last.metadata.reviewedBaseCommit, headSha);
      assert.strictEqual(last.stage, 'IMPLEMENT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('reviewedBaseCommit is null when the base cannot be read', async () => {
    const { dir, summaryPath, planPath } = makeSummary();
    try {
      const planGenerator = new FilePlanGenerator();
      planGenerator.resolvePlanFile = () => ({
        planDir: dir,
        planPath,
        planFileName: 'implementation_plan.md',
        summaryPath
      });

      const executor = new MockCommandExecutor('deadbeef');
      executor.rejectRevParse = true;

      const useCase = new RunReviewUseCase(
        new MockStateRepository(
          makeSnapshot(STAGE_QUALITY_GATE, [{ stage: STAGE_QUALITY_GATE, timestamp: iso(-1000) }])
        ),
        new MockConfigRepository(),
        planGenerator,
        undefined,
        undefined,
        executor
      );

      const result = await useCase.execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK, workspaceDir: dir });
      assert.strictEqual(result.reviewedBaseCommit, null);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(
        summary.includes('base `unrecorded`'),
        `an unreadable base must be named as unrecorded, got:\n${summary}`
      );
      const last = result.stateMachine.history[result.stateMachine.history.length - 1];
      assert.ok(!('reviewedBaseCommit' in last.metadata), 'no base may be invented');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an APPROVED round records its own reviewer verdict and a single bullet', async () => {
    const { dir, summaryPath, planPath } = makeSummary();
    try {
      const planGenerator = new FilePlanGenerator();
      planGenerator.resolvePlanFile = () => ({
        planDir: dir,
        planPath,
        planFileName: 'implementation_plan.md',
        summaryPath
      });

      const useCase = new RunReviewUseCase(
        new MockStateRepository(
          makeSnapshot('REVIEW', [{ stage: 'REVIEW', timestamp: iso(-60_000) }])
        ),
        new MockConfigRepository(),
        planGenerator,
        undefined,
        undefined,
        new MockCommandExecutor('abc1234')
      );

      const result = await useCase.execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK, workspaceDir: dir });
      const summary = fs.readFileSync(summaryPath, 'utf8');

      assert.strictEqual(result.reviewerVerdict, 'APPROVED');
      assert.strictEqual(result.currentStage, STAGE_COMMIT);
      assert.ok(summary.includes('· APPROVED ·'), `the note must name the verdict, got:\n${summary}`);
      assert.ok(summary.includes('base `abc1234`'), `the note must name the base, got:\n${summary}`);
      assert.strictEqual((summary.match(/^- \*\*Round /gm) ?? []).length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
