/**
 * agyloop - Role prompt smoke path contract (issue #279, absorbed into #241)
 *
 * The role prompts used to mandate `/tmp/smoke-<issue>` — the one directory the
 * storage layer refuses every state mutation in.
 *
 * SP1 - the mandated path is permitted: a state-mutating command succeeds there
 * SP2 - no role prompt names /tmp/smoke; the path token is identical everywhere
 * SP3 - the same command under os.tmpdir() is refused outside test mode
 * SP4 - a sandbox cwd cannot reach the real workspace (escape rule)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ResolveSubagentUseCase } = require('../../dist/application');
const { FilePromptRepository } = require('../../dist/infrastructure');
const {
  ROLE_PLANNER,
  ROLE_GATE,
  SMOKE_SANDBOX_RECOMMENDED_PATH,
  MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST
} = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CLI_BIN = path.join(PROJECT_ROOT, 'bin', 'codeloop.js');
const PATH_TOKEN = /\$HOME\/\.cache\/agyloop\/smoke-<issue>/;

function rolePrompts(): string[] {
  const resolveSubagent = new ResolveSubagentUseCase({});
  const promptRepo = new FilePromptRepository();

  return [
    resolveSubagent.getDiscoverySystemPrompt(),
    resolveSubagent.getPlannerSystemPrompt(),
    resolveSubagent.getGateSystemPrompt(),
    promptRepo.loadPrompt(ROLE_PLANNER, { cwd: PROJECT_ROOT }),
    promptRepo.loadPrompt(ROLE_GATE, { cwd: PROJECT_ROOT })
  ];
}

function makeFakeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-smoke-home-'));
}

function makeGitDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function productionEnv(fakeHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, NODE_ENV: 'production' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

interface SpawnResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runTransition(cwd: string, env: NodeJS.ProcessEnv, extraArgs: string[] = []): SpawnResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [CLI_BIN, 'transition', 'DISCOVERY', '--issue', '241', ...extraArgs],
      { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message)
    };
  }
}

describe('Role prompt smoke path contract (issue #279)', () => {
  test('SP1: the mandated path is permitted and a state mutation succeeds there', () => {
    const fakeHome = makeFakeHome();
    const sandbox = path.join(fakeHome, '.cache', 'agyloop', 'smoke-241');
    try {
      makeGitDir(sandbox);

      const run = runTransition(sandbox, productionEnv(fakeHome));
      assert.strictEqual(run.status, 0, `the mandated path must permit state mutation:\n${run.stderr}`);
      assert.ok(
        fs.existsSync(path.join(sandbox, '.agyloop', 'tasks', '241.json')),
        'the checkpoint must be written'
      );
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test('SP2: no role prompt names /tmp/smoke and every copy carries the identical path token', () => {
    const prompts = rolePrompts();

    for (const prompt of prompts) {
      assert.strictEqual(prompt.includes('/tmp/smoke'), false, 'the old mandated path must be gone');
      const match = prompt.match(PATH_TOKEN);
      assert.ok(match, `the role prompt must name the sandbox path:\n${prompt}`);
      assert.strictEqual(match![0], SMOKE_SANDBOX_RECOMMENDED_PATH);
    }
  });

  test('SP3: the same command under os.tmpdir() is refused outside test mode', () => {
    const tmpSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-241-'));
    try {
      makeGitDir(tmpSandbox);
      const run = runTransition(tmpSandbox, productionEnv(os.homedir()));

      assert.strictEqual(run.status, 1, `a /tmp smoke directory must be refused:\n${run.stdout}`);
      assert.ok(
        run.stderr.includes(MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST),
        `the refusal must name the tool's own sandbox, got:\n${run.stderr}`
      );
      assert.strictEqual(
        fs.existsSync(path.join(tmpSandbox, '.agyloop', 'tasks', '241.json')),
        false,
        'no checkpoint may be written in a refused directory'
      );
    } finally {
      fs.rmSync(tmpSandbox, { recursive: true, force: true });
    }
  });

  test('SP4: a sandbox cwd cannot reach the real workspace', () => {
    const fakeHome = makeFakeHome();
    const sandbox = path.join(fakeHome, '.cache', 'agyloop', 'smoke-241');
    const externalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-real-workspace-'));
    try {
      makeGitDir(sandbox);
      const run = runTransition(sandbox, productionEnv(fakeHome), ['--workspace', externalWorkspace]);

      assert.strictEqual(run.status, 1, `a sandbox must not reach real state:\n${run.stdout}`);
      assert.ok(
        run.stderr.includes('State mutation is forbidden'),
        `the escape rule must refuse, got:\n${run.stderr}`
      );
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(externalWorkspace, { recursive: true, force: true });
    }
  });
});
