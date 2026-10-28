/**
 * agyloop - `status` renders the triage disposition (issue #336, Defect 2)
 *
 * The same checkpoint used to be reported two ways: `next` named the PR
 * recorded in `triageDisposition`, while `status` dropped the field and said
 * "pushed, NOT delivered (no PR recorded)".
 *
 * ST1-ST3 - `status` renders the disposition and `--json` carries the field
 * ST4     - the Delivery line never denies a PR the checkpoint records
 * ST5     - a recorded delivery PR and the disposition PR are both shown
 * ST6     - a disposition at a non-terminal stage is rendered too
 * ST7     - the old wording survives where it is still true
 * ST8     - a corrupt field renders as "not recorded" in BOTH surfaces
 *
 * Every case fails on build a3f1740 and passes after the #336 fix.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ISSUE = 336;
const RECORDED_AT = '2026-10-28T05:16:20.604Z';

function seedCheckpoint(snapshot: Record<string, any>): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-status-disposition-'));
  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  const file = path.join(tasksDir, `${ISSUE}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'COMPLETED',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'TRIAGE', timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null,
        ...snapshot
      },
      null,
      2
    ),
    'utf8'
  );
  return { dir, file };
}

const DISPOSITION = {
  prNumber: 335,
  action: 'dismiss',
  recordedAt: RECORDED_AT,
  feedbackKeys: ['id:1']
};

async function runStatus(dir: string, json: boolean): Promise<{ code: number; stdout: string }> {
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  try {
    process.chdir(dir);
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    const args = ['status', '--issue', String(ISSUE)];
    if (json) {
      args.push('--json');
    }
    const code = await runCli(args);
    return { code, stdout };
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function deliveryLine(text: string): string | undefined {
  return text.split('\n').find((line) => line.trimStart().startsWith('Delivery'));
}

describe('status reports the triage disposition (issue #336)', () => {
  test('ST1 (AC-6): status --json carries triageDisposition under the checkpoint name', async () => {
    const sandbox = seedCheckpoint({ triageDisposition: DISPOSITION, pullRequest: null });
    try {
      const run = await runStatus(sandbox.dir, true);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(run.code, 0);
      assert.ok('triageDisposition' in payload, 'the field must be present');
      assert.deepStrictEqual(payload.triageDisposition, DISPOSITION);
      assert.strictEqual(payload.pullRequest, null);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('ST2 (AC-6): a legacy checkpoint reports triageDisposition null, not absent', async () => {
    const sandbox = seedCheckpoint({ pullRequest: null });
    try {
      const run = await runStatus(sandbox.dir, true);
      const payload = JSON.parse(run.stdout);

      assert.ok('triageDisposition' in payload);
      assert.strictEqual(payload.triageDisposition, null);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('ST3 (AC-6): the text report names the action, the PR and the recorded-at', async () => {
    const sandbox = seedCheckpoint({ triageDisposition: DISPOSITION, pullRequest: null });
    try {
      const run = await runStatus(sandbox.dir, false);

      assert.ok(
        run.stdout.includes('Triage Disposition : recorded (action=DISMISS, PR #335, '),
        run.stdout
      );
      assert.ok(run.stdout.includes(RECORDED_AT), run.stdout);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('ST4 (AC-7): Delivery never denies a PR the checkpoint records', async () => {
    const sandbox = seedCheckpoint({ triageDisposition: DISPOSITION, pullRequest: null });
    try {
      const run = await runStatus(sandbox.dir, false);
      const delivery = deliveryLine(run.stdout);

      assert.ok(delivery, `no Delivery line:\n${run.stdout}`);
      assert.match(delivery!, /NOT delivered/);
      assert.ok(delivery!.includes('PR #335'), `the Delivery line must name the PR: ${delivery}`);
      assert.ok(
        !delivery!.includes('no PR recorded'),
        `the Delivery line must not deny the recorded PR: ${delivery}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('ST5 (AC-7): the delivery PR and the disposition PR are both reported', async () => {
    const sandbox = seedCheckpoint({
      triageDisposition: DISPOSITION,
      pullRequest: { number: 331, url: 'https://example.invalid/pr/331', status: 'created' }
    });
    try {
      const run = await runStatus(sandbox.dir, false);
      const delivery = deliveryLine(run.stdout);

      assert.ok(delivery, `no Delivery line:\n${run.stdout}`);
      assert.ok(
        delivery!.includes('PR #331 (https://example.invalid/pr/331'),
        `the delivery record must be unchanged: ${delivery}`
      );
      assert.ok(run.stdout.includes('PR #335'), 'the disposition line must name its PR');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('ST6 (AC-6): a disposition is rendered at a non-terminal stage too', async () => {
    const sandbox = seedCheckpoint({
      currentStage: 'IMPLEMENT',
      triageDisposition: { ...DISPOSITION, action: 'implement' },
      pullRequest: null
    });
    try {
      const run = await runStatus(sandbox.dir, false);

      assert.ok(run.stdout.includes('Triage Disposition : recorded'), run.stdout);
      assert.ok(run.stdout.includes('action=IMPLEMENT'), run.stdout);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('ST7 (control): with no disposition the old wording survives where it is true', async () => {
    const sandbox = seedCheckpoint({ pullRequest: null });
    try {
      const run = await runStatus(sandbox.dir, false);
      const delivery = deliveryLine(run.stdout);

      assert.ok(delivery);
      assert.strictEqual(delivery!.trim(), 'Delivery      : pushed, NOT delivered (no PR recorded)');
      assert.ok(!run.stdout.includes('Triage Disposition'), run.stdout);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('ST8 (robustness): a corrupt disposition renders as not recorded in both surfaces', async () => {
    const sandbox = seedCheckpoint({
      triageDisposition: { prNumber: 'garbage' },
      pullRequest: null
    });
    try {
      const text = await runStatus(sandbox.dir, false);
      const json = await runStatus(sandbox.dir, true);
      const payload = JSON.parse(json.stdout);

      assert.strictEqual(text.code, 0, 'a corrupt field must not crash status');
      assert.strictEqual(payload.triageDisposition, null);
      assert.ok(
        !text.stdout.includes('Triage Disposition : recorded'),
        `a corrupt field must not render a line:\n${text.stdout}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
