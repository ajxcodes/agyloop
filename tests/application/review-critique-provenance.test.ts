/**
 * agyloop - Tier 1 critique provenance (issue #445)
 *
 * RCP1-RCP6: a supplied critique report is evidence only when the provenance
 * sidecar beside it names the base ref and HEAD this review certifies. The
 * #439 round certified a report describing the whole 416-file collector while
 * `codeloop review` recorded `critiqueVerified: true`, because any parseable
 * report was trusted. These pin the refusal — and the parsing that makes it
 * impossible to bind on a partial or hand-written sidecar.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  StateMachine, Stage, IssueNumber, STAGE_REVIEW,
  AiReviewReport, ReviewConfidence, parseCritiqueProvenance, isCritiqueProvenanceBound
} = require('../../dist/domain');
const { RunReviewUseCase } = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const APPROVED_BLOCK = [
  'REVIEW_STATUS: APPROVED',
  'REVIEW_SUMMARY: smoke',
  'UNFULFILLED_AC:',
  '- None',
  'REMEDIATION_GUIDANCE:',
  '- None',
  'AC_EVIDENCE:',
  '- AC1: met — `src/app.ts`'
].join('\n');

class MemoryStateRepository {
  public snapshot: any;

  constructor() {
    const sm = new StateMachine({ stage: new Stage(STAGE_REVIEW), issue: new IssueNumber(445) });
    this.snapshot = sm.toSnapshot();
  }
  async load(): Promise<any> { return this.snapshot; }
  async save(snapshot: any): Promise<void> { this.snapshot = snapshot; }
  getStateFilePath(): string { return '/fake/.agyloop/tasks/445.json'; }
}

const planGenerator = {
  resolvePlanFile: () => null,
  readPlanDocument: () => '',
  updateSummaryLog: () => true
};

/** Every command succeeds; `git diff --name-only` / `git rev-parse HEAD` carry values. */
function executor(headCommit: string = HEAD_SHA, paths: string[] = ['src/app.ts']) {
  return {
    execute: async (command: string) => ({
      command,
      exitCode: 0,
      stdout: command === 'git rev-parse HEAD'
        ? headCommit
        : command.startsWith('git diff --name-only')
          ? paths.join('\n')
          : '',
      stderr: '',
      combinedOutput: '',
      durationMs: 0,
      timedOut: false
    })
  };
}

const cleanReport = () => new AiReviewReport({
  summary: 'Clean automated review',
  confidence: ReviewConfidence.high('Diff verified.'),
  findings: []
});

function buildUseCase(headCommit: string = HEAD_SHA) {
  const stateRepo = new MemoryStateRepository();
  const useCase = new RunReviewUseCase(
    stateRepo,
    {
      loadConfig: () => DEFAULT_CONFIG,
      // The reviewer descriptor is resolved before anything is measured; only
      // `tier` is read from it (same shape the sibling use-case tests stub).
      resolveModel: (role: string) => ({ role, configured: 'flash', tier: 'flash', apiModel: 'gemini-3.5-flash' })
    },
    planGenerator,
    undefined,
    undefined,
    executor(headCommit)
  );
  return { useCase, stateRepo };
}

function lastMetadata(stateRepo: any) {
  const history = stateRepo.snapshot.history;
  return history[history.length - 1].metadata;
}

test('RCP1 a report whose sidecar names the reviewed base and HEAD is recorded verified (issue #445)', async () => {
  const { useCase, stateRepo } = buildUseCase();
  const result = await useCase.execute({
    reviewOutput: APPROVED_BLOCK,
    priorCritiqueReport: cleanReport(),
    critiqueProvenance: { baseRef: 'main', headCommit: HEAD_SHA }
  });
  assert.strictEqual(result.critiqueVerified, true);
  assert.strictEqual(lastMetadata(stateRepo).reviewCritiqueProvenance.bound, true);
});

test('RCP2 a report describing another base is not verified and the note names both bases (issue #445)', async () => {
  const { useCase, stateRepo } = buildUseCase();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: any) => warnings.push(String(message));
  let result: any;
  try {
    result = await useCase.execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: cleanReport(),
      critiqueProvenance: { baseRef: 'phase/6-codeloop', headCommit: HEAD_SHA }
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(result.critiqueVerified, false);
  assert.strictEqual(result.verdict.status, 'APPROVED');
  assert.strictEqual(lastMetadata(stateRepo).critiqueVerified, false);
  assert.strictEqual(lastMetadata(stateRepo).reviewCritiqueProvenance.bound, false);
  assert.ok(warnings.some((line) => line.includes('phase/6-codeloop') && line.includes('main')), warnings.join('\n'));
});

test('RCP3 a report describing another HEAD is not verified (issue #445)', async () => {
  const { useCase } = buildUseCase();
  const result = await useCase.execute({
    reviewOutput: APPROVED_BLOCK,
    priorCritiqueReport: cleanReport(),
    critiqueProvenance: { baseRef: 'main', headCommit: OTHER_SHA }
  });
  assert.strictEqual(result.critiqueVerified, false);
});

test('RCP4 a report with no provenance sidecar is not verified (issue #445)', async () => {
  const { useCase } = buildUseCase();
  const result = await useCase.execute({
    reviewOutput: APPROVED_BLOCK,
    priorCritiqueReport: cleanReport()
  });
  assert.strictEqual(result.critiqueVerified, false);
});

test('RCP5 an unmeasurable HEAD can never bind a supplied report (issue #445)', async () => {
  const { useCase } = buildUseCase('');
  const result = await useCase.execute({
    reviewOutput: APPROVED_BLOCK,
    priorCritiqueReport: cleanReport(),
    critiqueProvenance: { baseRef: 'main', headCommit: HEAD_SHA }
  });
  assert.strictEqual(result.critiqueVerified, false);
  assert.strictEqual(result.reviewedBaseCommit, null);
});

test('RCP6 provenance parsing rejects anything that is not a base plus a commit sha (issue #445)', () => {
  assert.strictEqual(parseCritiqueProvenance('{"baseRef":"main"}'), null);
  assert.strictEqual(parseCritiqueProvenance('not json'), null);
  assert.strictEqual(parseCritiqueProvenance(null), null);
  assert.strictEqual(parseCritiqueProvenance(JSON.stringify({ baseRef: 'main', headCommit: HEAD_SHA })).baseRef, 'main');
  assert.strictEqual(isCritiqueProvenanceBound(null, 'main', HEAD_SHA), false);
  assert.strictEqual(isCritiqueProvenanceBound({ baseRef: 'main', headCommit: HEAD_SHA }, 'main', null), false);
  assert.strictEqual(isCritiqueProvenanceBound({ baseRef: 'main', headCommit: HEAD_SHA }, 'main', HEAD_SHA), true);
});
