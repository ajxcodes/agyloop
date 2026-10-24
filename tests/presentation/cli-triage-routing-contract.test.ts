/**
 * agyloop - Triage routing command contract (issue #241, D1)
 *
 * TR1 - the command the DISPATCHED prompt names runs verbatim (from dist/)
 * TR2 - every parser-accepted action appears in the prompt and is accepted
 * TR3 - triage and review have the same (no-marker) requirement
 * TR4 - the payload schema carries no phantom Env field
 * TR5 - routing requires the checkpoint to be at TRIAGE
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');
const { ResolveSubagentUseCase } = require('../../dist/application');
const {
  TRIAGE_DISPOSITION_ACTIONS,
  MSG_TRIAGE_ROUTING_REQUIRES_GATE
} = require('../../dist/domain');

const ISSUE = 241;

const resolveSubagent = new ResolveSubagentUseCase({});

/** A `gh` stub that answers "no pull request" so nothing reaches the network. */
function installGhStub(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'gh');
  fs.writeFileSync(file, '#!/bin/sh\necho "[]"\n', 'utf8');
  fs.chmodSync(file, 0o755);
}

function seedSandbox(stage: string, issue = ISSUE): { dir: string; stateFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-triage-routing-'));
  const stateFile = path.join(dir, '.agyloop', 'tasks', `${issue}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: stage,
        mode: 'standard',
        issue,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history: [{ stage, timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null
      },
      null,
      2
    ),
    'utf8'
  );
  return { dir, stateFile };
}

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runIn(
  dir: string,
  args: string[],
  options: { readonly binDir?: string; readonly env?: Record<string, string | undefined> } = {}
): Promise<CliRun> {
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalPath = process.env.PATH;
  const originalSubagent = process.env.AGY_SUBAGENT;
  let stdout = '';
  let stderr = '';

  try {
    process.chdir(dir);
    if (options.binDir) {
      process.env.PATH = `${options.binDir}${path.delimiter}${originalPath ?? ''}`;
    }
    if (options.env && 'AGY_SUBAGENT' in options.env) {
      if (options.env.AGY_SUBAGENT === undefined) {
        delete process.env.AGY_SUBAGENT;
      } else {
        process.env.AGY_SUBAGENT = options.env.AGY_SUBAGENT;
      }
    } else {
      delete process.env.AGY_SUBAGENT;
    }

    console.log = (...argsOut: any[]) => {
      stdout += argsOut.map(String).join(' ') + '\n';
    };
    console.error = (...argsOut: any[]) => {
      stderr += argsOut.map(String).join(' ') + '\n';
    };

    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
    console.error = originalError;
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalSubagent === undefined) {
      delete process.env.AGY_SUBAGENT;
    } else {
      process.env.AGY_SUBAGENT = originalSubagent;
    }
  }
}

describe('Triage routing command contract (issue #241)', () => {
  let sandboxes: string[] = [];

  beforeEach(() => {
    sandboxes = [];
  });

  afterEach(() => {
    for (const dir of sandboxes) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('TR1: the rendered command runs verbatim without an environment marker', async () => {
    const prompt = resolveSubagent.buildTriageTaskPrompt({ issueNumber: ISSUE });
    assert.strictEqual(
      prompt.includes('AGY_SUBAGENT'),
      false,
      'the dispatched prompt must not require an invisible marker'
    );

    const match = prompt.match(/codeloop triage <action> --issue 241/);
    assert.ok(match, `the prompt must name the exact command, got:\n${prompt}`);

    const { dir, stateFile } = seedSandbox('TRIAGE');
    sandboxes.push(dir);
    const binDir = path.join(dir, 'bin');
    installGhStub(binDir);

    const command = `${match[0]}`.replace('<action>', 'completed');
    const args = command.split(/\s+/).slice(1);
    const run = await runIn(dir, args, { binDir });

    assert.strictEqual(run.code, 0, `the named command must succeed as written:\n${run.stdout}\n${run.stderr}`);
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).currentStage, 'COMPLETED');
  });

  test('TR2: every accepted action appears in the prompt and is accepted by the parser', async () => {
    const prompt = resolveSubagent.buildTriageTaskPrompt({ issueNumber: ISSUE });

    for (const action of TRIAGE_DISPOSITION_ACTIONS) {
      assert.ok(prompt.includes(action), `the prompt must name '${action}'`);

      // A COMPLETED checkpoint turns a parser-rejected action into parity with
      // a stage-refused action; the error text is what distinguishes them.
      const { dir } = seedSandbox('COMPLETED');
      sandboxes.push(dir);
      const run = await runIn(dir, ['triage', action, '--issue', String(ISSUE)]);

      assert.strictEqual(
        run.stderr.includes('Unrecognized triage action'),
        false,
        `the parser must accept '${action}', got:\n${run.stderr}`
      );
      assert.ok(run.stderr.includes(MSG_TRIAGE_ROUTING_REQUIRES_GATE), run.stderr);
    }
  });

  test('TR3: triage and review have the same (no-marker) requirement', async () => {
    const verdictPath = (dir: string): string => {
      const file = path.join(dir, 'verdict.md');
      fs.writeFileSync(
        file,
        'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: smoke\nUNFULFILLED_AC:\n- None\nREMEDIATION_GUIDANCE:\n- None\n',
        'utf8'
      );
      return file;
    };

    for (const marker of [undefined, '1']) {
      const triage = seedSandbox('TRIAGE');
      sandboxes.push(triage.dir);
      const triageRun = await runIn(
        triage.dir,
        ['triage', 'completed', '--issue', String(ISSUE)],
        { env: { AGY_SUBAGENT: marker } }
      );
      assert.strictEqual(
        triageRun.code,
        0,
        `triage must not depend on a marker (AGY_SUBAGENT=${marker}):\n${triageRun.stderr}`
      );

      const review = seedSandbox('REVIEW');
      sandboxes.push(review.dir);
      const reviewRun = await runIn(
        review.dir,
        ['review', '--issue', String(ISSUE), '--verdict-file', verdictPath(review.dir)],
        { env: { AGY_SUBAGENT: marker } }
      );
      assert.strictEqual(
        reviewRun.code,
        0,
        `review must not depend on a marker (AGY_SUBAGENT=${marker}):\n${reviewRun.stderr}`
      );
    }
  });

  test('TR4: the payload subagent carries no Env field', async () => {
    const { dir } = seedSandbox('TRIAGE');
    sandboxes.push(dir);
    const binDir = path.join(dir, 'bin');
    installGhStub(binDir);

    const run = await runIn(dir, ['next', '--issue', String(ISSUE), '--json'], { binDir });
    assert.strictEqual(run.code, 0, run.stderr);

    const payload = JSON.parse(run.stdout);
    const subagent = payload.invocationPayload?.Subagents?.[0];
    assert.ok(subagent, `the directive must carry a subagent payload:\n${run.stdout}`);
    assert.deepStrictEqual(
      Object.keys(subagent).sort(),
      ['Model', 'Prompt', 'Role', 'TypeName', 'Workspace'],
      'no phantom Env field may be added to the harness payload'
    );
  });

  test('TR5: a routing action from a non-TRIAGE checkpoint fails without mutating it', async () => {
    for (const stage of ['DISCOVERY', 'COMPLETED']) {
      const { dir, stateFile } = seedSandbox(stage);
      sandboxes.push(dir);
      const before = fs.readFileSync(stateFile);

      const run = await runIn(dir, ['triage', 'implement', '--issue', String(ISSUE)]);

      assert.strictEqual(run.code, 1, `routing from ${stage} must fail:\n${run.stdout}\n${run.stderr}`);
      assert.ok(run.stderr.includes(MSG_TRIAGE_ROUTING_REQUIRES_GATE), run.stderr);
      assert.deepStrictEqual(fs.readFileSync(stateFile), before, 'the checkpoint must be byte-identical');
    }
  });
});
