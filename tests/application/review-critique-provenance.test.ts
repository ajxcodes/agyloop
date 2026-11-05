/**
 * codeloop - Tier 1 critique provenance (issue #445, #452)
 *
 * RCP1-RCP6: a supplied critique report is evidence only when the provenance
 * sidecar beside it names the base ref and HEAD this review certifies. The
 * #439 round certified a report describing the whole 416-file collector while
 * `codeloop review` recorded `critiqueVerified: true`, because any parseable
 * report was trusted. These pin the refusal — and the parsing that makes it
 * impossible to bind on a partial or hand-written sidecar.
 *
 * RCP7-RCP11 pin issue #450 and #452: a checkpoint with no base certifies
 * against `main` everywhere, and the sidecar's change-set digest binds CONTENT,
 * so an edit after Tier 1 ran at an unchanged HEAD cannot certify.
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
const DIGEST = 'c'.repeat(40);
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

/**
 * Every command succeeds; `git rev-parse HEAD` / `git diff --name-only` carry
 * values, and the change-set digest command returns a fixed DIGEST (#452).
 */
function executor(headCommit: string = HEAD_SHA, paths: string[] = ['src/app.ts']) {
  return {
    execute: async (command: string) => ({
      command,
      exitCode: 0,
      stdout: command === 'git rev-parse HEAD'
        ? headCommit
        : command.startsWith('git diff --name-only')
          ? paths.join('\n')
          : command.includes('git write-tree')
            ? DIGEST
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

function buildUseCaseWithCritique(critique: any, headCommit: string = HEAD_SHA) {
  const stateRepo = new MemoryStateRepository();
  const useCase = new RunReviewUseCase(
    stateRepo,
    {
      loadConfig: () => DEFAULT_CONFIG,
      resolveModel: (role: string) => ({ role, configured: 'flash', tier: 'flash', apiModel: 'gemini-3.5-flash' })
    },
    planGenerator,
    undefined,
    critique,
    executor(headCommit)
  );
  return { useCase, stateRepo };
}

function lastMetadata(stateRepo: any) {
  const history = stateRepo.snapshot.history;
  return history[history.length - 1].metadata;
}

function captureWarnings(run: () => Promise<any>): Promise<{ value: any; warnings: string[] }> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: any) => warnings.push(String(message));
  return Promise.resolve()
    .then(run)
    .then((value) => ({ value, warnings }))
    .finally(() => {
      console.warn = originalWarn;
    });
}

test('RCP1 a report whose sidecar names the reviewed base and HEAD is recorded verified (issue #445)', async () => {
  const { useCase, stateRepo } = buildUseCase();
  const result = await useCase.execute({
    reviewOutput: APPROVED_BLOCK,
    priorCritiqueReport: cleanReport(),
    critiqueProvenance: { baseRef: 'main', headCommit: HEAD_SHA, changeSetDigest: DIGEST }
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
      critiqueProvenance: { baseRef: 'phase/6-codeloop', headCommit: HEAD_SHA, changeSetDigest: DIGEST }
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
    critiqueProvenance: { baseRef: 'main', headCommit: OTHER_SHA, changeSetDigest: DIGEST }
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
    critiqueProvenance: { baseRef: 'main', headCommit: HEAD_SHA, changeSetDigest: DIGEST }
  });
  assert.strictEqual(result.critiqueVerified, false);
  assert.strictEqual(result.reviewedBaseCommit, null);
});

test('RCP6 provenance parsing rejects anything that is not a base plus a commit sha (issue #445)', () => {
  assert.strictEqual(parseCritiqueProvenance('{"baseRef":"main"}'), null);
  assert.strictEqual(parseCritiqueProvenance('not json'), null);
  assert.strictEqual(parseCritiqueProvenance(null), null);
  const legacy = parseCritiqueProvenance(JSON.stringify({ baseRef: 'main', headCommit: HEAD_SHA }));
  assert.strictEqual(legacy.baseRef, 'main');
  assert.strictEqual(legacy.changeSetDigest, null);
  assert.strictEqual(isCritiqueProvenanceBound(legacy, 'main', HEAD_SHA, DIGEST), false);
  assert.strictEqual(
    isCritiqueProvenanceBound(
      { baseRef: 'main', headCommit: HEAD_SHA, changeSetDigest: null },
      'main',
      HEAD_SHA,
      DIGEST
    ),
    false
  );
  assert.strictEqual(
    isCritiqueProvenanceBound(
      { baseRef: 'main', headCommit: HEAD_SHA, changeSetDigest: DIGEST },
      'main',
      HEAD_SHA,
      DIGEST
    ),
    true
  );
  assert.strictEqual(isCritiqueProvenanceBound(null, 'main', HEAD_SHA, DIGEST), false);
});

test('RCP7 a checkpoint with no baseBranch pins the Tier 1 gateway to main (#450 AC1)', async () => {
  const critiqueCalls: any[] = [];
  const critique = {
    resolveReviewer: async () => ({ source: 'system_path', path: 'critique', isAvailable: true }),
    review: async (options: any) => {
      critiqueCalls.push(options);
      return cleanReport();
    }
  };
  // `MemoryStateRepository` never calls `setBaseBranch`: the checkpoint carries
  // no base, which is exactly the #450 shape.
  const { useCase } = buildUseCaseWithCritique(critique);
  const result = await useCase.execute({ reviewOutput: APPROVED_BLOCK });

  assert.strictEqual(critiqueCalls[0].baseRef, 'main');
  assert.strictEqual(result.critiqueVerified, true);
  assert.strictEqual(result.acEvidence.baseRef, 'main');
});

test('RCP8 a sidecar whose change-set digest does not match the worktree is not bound, and the note names the digest (#452 AC1)', async () => {
  const { useCase, stateRepo } = buildUseCase();
  const { value: result, warnings } = await captureWarnings(() =>
    useCase.execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: cleanReport(),
      critiqueProvenance: { baseRef: 'main', headCommit: HEAD_SHA, changeSetDigest: OTHER_SHA }
    })
  );

  assert.strictEqual(result.critiqueVerified, false);
  assert.ok(warnings.some((line) => line.includes('produced against change set')), warnings.join('\n'));
  assert.strictEqual(lastMetadata(stateRepo).reviewCritiqueProvenance.mismatch, 'change-set');
});

test('RCP9 an unchanged worktree with a matching change-set digest still binds (#452 AC2)', async () => {
  const { useCase, stateRepo } = buildUseCase();
  const result = await useCase.execute({
    reviewOutput: APPROVED_BLOCK,
    priorCritiqueReport: cleanReport(),
    critiqueProvenance: { baseRef: 'main', headCommit: HEAD_SHA, changeSetDigest: DIGEST }
  });

  assert.strictEqual(result.critiqueVerified, true);
  assert.strictEqual(lastMetadata(stateRepo).reviewCritiqueProvenance.mismatch, null);
});

test('RCP10 a legacy two-field sidecar parses but can never bind, and the note names the missing digest (#452 AC2)', async () => {
  const { useCase, stateRepo } = buildUseCase();
  const legacy = parseCritiqueProvenance(
    JSON.stringify({ baseRef: 'main', headCommit: HEAD_SHA })
  );
  const { value: result, warnings } = await captureWarnings(() =>
    useCase.execute({
      reviewOutput: APPROVED_BLOCK,
      priorCritiqueReport: cleanReport(),
      critiqueProvenance: legacy
    })
  );

  assert.strictEqual(result.critiqueVerified, false);
  assert.ok(warnings.some((line) => line.includes('change-set digest')), warnings.join('\n'));
  assert.strictEqual(lastMetadata(stateRepo).reviewCritiqueProvenance.mismatch, 'missing-digest');
});

test('RCP11 the provenance record names the digest it compared (#452 AC5)', async () => {
  const { useCase, stateRepo } = buildUseCase();
  await useCase.execute({
    reviewOutput: APPROVED_BLOCK,
    priorCritiqueReport: cleanReport(),
    critiqueProvenance: { baseRef: 'main', headCommit: HEAD_SHA, changeSetDigest: DIGEST }
  });

  assert.strictEqual(lastMetadata(stateRepo).reviewCritiqueProvenance.changeSetDigest, DIGEST);
  assert.strictEqual(lastMetadata(stateRepo).reviewCritiqueProvenance.reviewedChangeSetDigest, DIGEST);
});
