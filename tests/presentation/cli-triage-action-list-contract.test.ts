/**
 * agyloop - Triage action-list contract (issue #277, absorbed into #241)
 *
 * TA1 - every action in TRIAGE_DISPOSITION_ACTIONS is documented in every
 *       operator surface AND in both triage prompts
 * TA2 - the parser rejects an action outside the list
 * TA3 - the help distinguishes actions by side effect (completed vs dismiss)
 * TA4 - the TRIAGE operator summary names both completed and dismiss
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli, printHelp } = require('../../dist/presentation/cli');
const { ResolveSubagentUseCase } = require('../../dist/application');
const {
  TRIAGE_DISPOSITION_ACTIONS,
  buildDefaultTriageSystemPrompt
} = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_FILE = path.join(PROJECT_ROOT, 'skills', 'agyloop', 'SKILL.md');
const OPENCODE_SKILL_FILE = path.join(PROJECT_ROOT, 'integrations', 'opencode', 'codeloop-skill.md');

const ISSUE = 277;

function captureConsole(fn: () => void): string {
  const originalLog = console.log;
  let output = '';
  console.log = (...args: any[]) => {
    output += args.map(String).join(' ') + '\n';
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return output;
}

async function runIn(dir: string, args: string[]): Promise<{ code: number; output: string }> {
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let output = '';

  try {
    process.chdir(dir);
    console.log = (...a: any[]) => {
      output += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      output += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, output };
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function seedTriage(dir: string): void {
  const stateFile = path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'TRIAGE',
      mode: 'standard',
      issue: ISSUE,
      baseBranch: 'main',
      createdAt: now,
      updatedAt: now,
      history: [{ stage: 'TRIAGE', timestamp: now }],
      pausedAtGate: null,
      pausedAtTimestamp: null
    }),
    'utf8'
  );
}

describe('Triage action-list contract (issue #277)', () => {
  test('TA1: every action is documented in the help, hint, skills and both prompts', async () => {
    const help = captureConsole(() => printHelp());
    const skill = fs.readFileSync(SKILL_FILE, 'utf8');
    const openCodeSkill = fs.readFileSync(OPENCODE_SKILL_FILE, 'utf8');
    const taskPrompt = new ResolveSubagentUseCase({}).buildTriageTaskPrompt({ issueNumber: ISSUE });
    const systemPrompt = buildDefaultTriageSystemPrompt();

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-triage-actions-'));
    try {
      seedTriage(sandbox);
      const hint = (await runIn(sandbox, ['triage'])).output;

      for (const action of TRIAGE_DISPOSITION_ACTIONS) {
        assert.ok(help.includes(action), `--help must name '${action}'`);
        assert.ok(hint.includes(action), `the read-only hint must name '${action}'`);
        assert.ok(skill.includes(action), `skills/agyloop/SKILL.md must name '${action}'`);
        assert.ok(
          openCodeSkill.includes(action),
          `integrations/opencode/codeloop-skill.md must name '${action}'`
        );
        assert.ok(taskPrompt.includes(action), `the triage task prompt must name '${action}'`);
        assert.ok(systemPrompt.includes(action), `the triage system prompt must name '${action}'`);
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('TA2: the parser rejects an action outside the list', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-triage-actions-'));
    try {
      const run = await runIn(sandbox, ['triage', 'archive', '--issue', String(ISSUE)]);
      assert.strictEqual(run.code, 1);
      assert.match(run.output, /Unrecognized triage action/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('TA3: the help distinguishes completed from dismiss by side effect', () => {
    const help = captureConsole(() => printHelp());
    const completedLine = help
      .split('\n')
      .find((line) => line.includes('triage [action]') && line.includes('completed'));

    assert.ok(completedLine, `the help must document completed, got:\n${help}`);
    assert.match(completedLine, /posts nothing/);
    assert.match(completedLine, /dismiss/);
    assert.match(completedLine, /replies|resolves/);
    assert.match(completedLine, /GitHub/);
  });

  test('TA4: the TRIAGE operator summary names both completed and dismiss', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-triage-actions-'));
    try {
      seedTriage(sandbox);
      const run = await runIn(sandbox, ['next', '--issue', String(ISSUE)]);
      assert.strictEqual(run.code, 0, run.output);
      assert.ok(run.output.includes('completed'), run.output);
      assert.ok(run.output.includes('dismiss'), run.output);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('TA5: the help documents -m as the dismissal notes flag for triage (AC-5)', () => {
    const help = captureConsole(() => printHelp());
    const messageLine = help.split('\n').find((line) => line.includes('-m, --message'));
    const triageLine = help.split('\n').find((line) => line.includes('triage [action]'));

    assert.ok(messageLine, `the help must document -m, got:\n${help}`);
    assert.ok(
      messageLine!.includes('triage dismiss'),
      `the -m line must name triage dismiss: ${messageLine}`
    );
    assert.ok(
      messageLine!.includes('dismissal notes'),
      `the -m line must name the dismissal notes: ${messageLine}`
    );
    assert.ok(triageLine, `the help must document triage [action], got:\n${help}`);
    assert.ok(
      triageLine!.includes('-m "<notes>"'),
      `the triage line must name -m "<notes>": ${triageLine}`
    );
  });

  test('TA6: the shipped skill states the real skip rule and the -m requirement (AC-8)', () => {
    const skill = fs.readFileSync(SKILL_FILE, 'utf8');
    const openCodeSkill = fs.readFileSync(OPENCODE_SKILL_FILE, 'utf8');

    assert.ok(
      skill.includes('dismissal marker'),
      'SKILL.md must name the dismissal marker as the skip proof'
    );
    assert.ok(skill.includes('-m "<notes>"'), 'SKILL.md must document -m "<notes>"');
    assert.ok(
      !/whose review thread is \*\*resolved\*\* was answered by an earlier run/.test(skill),
      'SKILL.md must not claim a resolved thread was answered by an earlier run'
    );
    assert.ok(
      !skill.includes('Failures never block the transition'),
      'SKILL.md must not claim failures never block the transition'
    );
    assert.ok(
      openCodeSkill.includes('-m "<notes>"'),
      'the opencode skill must document -m "<notes>"'
    );
  });
});
