/**
 * agyloop - REVIEW directive channel tests (issue #272)
 *
 * The gap: `codeloop next` at REVIEW returned the same directive forever and
 * never named the channel that records the verdict. These tests pin the
 * operator-facing fields AND the re-dispatch record.
 *
 * RV1 - the channel + exit condition are named in the operator fields
 * RV2 - three reads name the channel and record counts 1, 2, 3
 * RV3 - the fourth read is the breaker, names the cap AND the way out
 * RV4 - a paused read never increments the counter
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GetNextActionUseCase } = require('../../dist/application');
const { FileStateRepository } = require('../../dist/infrastructure');
const {
  NOTE_REVIEW_GATE_EXIT_CONDITION,
  MAX_REVIEW_DISPATCH_LOOPS
} = require('../../dist/domain');

const ISSUE = 241;

const configRepo = {
  loadConfig: () => ({ options: { enableMcpInPlanner: true } }),
  resolveModel: (role: string) => ({
    role,
    configured: 'flash',
    tier: 'flash',
    apiModel: 'gemini-2.5-flash'
  }),
  mapModelToTier: () => 'flash'
};

function seedCheckpoint(stateFile: string, extra: Record<string, unknown> = {}): void {
  const now = new Date().toISOString();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'REVIEW',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'REVIEW', timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null,
        reviewDispatchCount: 0,
        ...extra
      },
      null,
      2
    ),
    'utf8'
  );
}

function readCheckpoint(stateFile: string): any {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

describe('REVIEW directive names its verdict channel (issue #272)', () => {
  let sandbox: string;
  let stateFile: string;
  let useCase: any;

  const executeRead = () => useCase.execute({ issue: ISSUE, workspaceDir: sandbox });

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-review-channel-'));
    stateFile = path.join(sandbox, '.agyloop', 'tasks', `${ISSUE}.json`);
    seedCheckpoint(stateFile);
    const stateRepo = new FileStateRepository({ stateFilePath: stateFile });
    useCase = new GetNextActionUseCase(stateRepo, configRepo);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('RV1: the operator fields name the filing command and the exit condition', async () => {
    const result = await executeRead();

    assert.ok(result.title.length > 0, 'the directive must keep a title');
    assert.match(result.description, /codeloop review --issue 241 --verdict-file/);
    assert.match(result.humanSummary, /codeloop review --issue 241 --verdict-file/);
    assert.ok(
      result.humanSummary.includes(NOTE_REVIEW_GATE_EXIT_CONDITION),
      `the human summary must state what ends the gate, got:\n${result.humanSummary}`
    );
  });

  test('RV2: three reads all name the channel and record dispatch counts 1, 2, 3', async () => {
    for (let read = 1; read <= 3; read += 1) {
      const result = await executeRead();
      assert.match(result.description, /codeloop review --issue 241 --verdict-file/);
      assert.match(result.humanSummary, /codeloop review --issue 241 --verdict-file/);
      assert.strictEqual(result.reviewDispatchCount, read);
      assert.strictEqual(readCheckpoint(stateFile).reviewDispatchCount, read);
    }
  });

  test('RV3: the fourth read is the breaker and names the cap + the way out', async () => {
    await executeRead();
    await executeRead();
    await executeRead();

    const result = await executeRead();

    assert.strictEqual(result.actionType, 'human_gate');
    assert.strictEqual(result.title, 'Review Verdict Breaker');
    assert.match(result.description, new RegExp(String(MAX_REVIEW_DISPATCH_LOOPS)));
    assert.match(result.description, /codeloop review/);
    assert.strictEqual(result.reviewDispatchCount, MAX_REVIEW_DISPATCH_LOOPS);
    assert.strictEqual(readCheckpoint(stateFile).reviewDispatchCount, MAX_REVIEW_DISPATCH_LOOPS);
  });

  test('RV4: a paused read does not increment the counter', async () => {
    seedCheckpoint(stateFile, { pausedAtGate: 'APPROVAL', pausedAtTimestamp: new Date().toISOString() });

    const result = await executeRead();

    assert.strictEqual(result.reviewDispatchCount, 0);
    assert.strictEqual(readCheckpoint(stateFile).reviewDispatchCount, 0);
    assert.match(result.description, /codeloop review --issue 241 --verdict-file/);
  });
});
