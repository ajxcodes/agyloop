/**
 * agyloop - `codeloop prompt` / `codeloop config` host vocabulary surfaces (issue #290)
 *
 * CP1 - `codeloop prompt implementer` under opencode prints only OpenCode tool names
 * CP2 - `codeloop prompt implementer` under antigravity prints only Antigravity tool names
 * CP3 - `codeloop prompt discovery` is accepted and prompt triage names the built-in default
 * CP4 - `codeloop config` prints the selected runner and host
 * CP5 - plugin.json system_prompt assets resolve and stay Antigravity-shaped
 * CP6 - no source file outside the vocabulary modules names an Antigravity identifier
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ANTIGRAVITY_TOOL_VOCABULARY, renderSystemPromptForHost } = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CLI_BIN = path.join(PROJECT_ROOT, 'bin', 'codeloop.js');

const AGY_TOOL_IDENTIFIER =
  /\b(view_file|grep_search|find_by_name|list_dir|write_to_file|replace_file_content|multi_replace_file_content|run_command)\b/;
const OC_BACKTICKED_IDENTIFIER = /`(read|grep|glob|list|write|edit|shell)`/;

interface SpawnResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runPrompt(args: string[], runner: string, env: NodeJS.ProcessEnv): SpawnResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_BIN, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...env, CODELOOP_RUNNER: runner },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message)
    };
  }
}

/** A HOME under the test's temp dir, so the operator's config cannot influence the run. */
function withFakeHome(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-290-home-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
  delete env.NODE_TEST_CONTEXT;
  delete env.CODELOOP_RUNNER;
  return {
    env,
    cleanup: () => fs.rmSync(fakeHome, { recursive: true, force: true })
  };
}

describe('CLI host vocabulary surfaces (issue #290)', () => {
  test('CP1: codeloop prompt implementer under opencode prints only OpenCode tool names (AC3)', () => {
    const { env, cleanup } = withFakeHome();
    try {
      const run = runPrompt(['prompt', 'implementer'], 'opencode', env);
      assert.strictEqual(run.status, 0, `prompt implementer must exit 0:\n${run.stderr}\n${run.stdout}`);
      assert.ok(run.stdout.includes('Tool Whitelist: read, grep, glob, write, edit, shell'), run.stdout);
      assert.ok(run.stdout.includes('ENABLED (write, edit, shell)'), run.stdout);
      assert.ok(run.stdout.includes('opencode (OpenCode)'), run.stdout);
      assert.ok(run.stdout.includes('in OpenCode'), run.stdout);
      assert.strictEqual(
        AGY_TOOL_IDENTIFIER.test(run.stdout),
        false,
        `an Antigravity tool name survived on the OpenCode surface:\n${run.stdout}`
      );
    } finally {
      cleanup();
    }
  });

  test('CP2: codeloop prompt implementer under antigravity prints only Antigravity tool names (AC3)', () => {
    const { env, cleanup } = withFakeHome();
    try {
      const run = runPrompt(['prompt', 'implementer'], 'antigravity', env);
      assert.strictEqual(run.status, 0, `prompt implementer must exit 0:\n${run.stderr}\n${run.stdout}`);
      assert.ok(
        run.stdout.includes(
          'Tool Whitelist: view_file, grep_search, find_by_name, list_dir, write_to_file, replace_file_content, run_command'
        ),
        run.stdout
      );
      assert.ok(run.stdout.includes('ENABLED (write_to_file, replace_file_content, run_command)'), run.stdout);
      assert.ok(run.stdout.includes('in Google Antigravity'), run.stdout);
      assert.strictEqual(
        OC_BACKTICKED_IDENTIFIER.test(run.stdout),
        false,
        `an OpenCode tool name appeared on the Antigravity surface:\n${run.stdout}`
      );
    } finally {
      cleanup();
    }
  });

  test('CP3: codeloop prompt discovery is accepted and prompt triage names the built-in default (AC6)', () => {
    const { env, cleanup } = withFakeHome();
    try {
      const discovery = runPrompt(['prompt', 'discovery'], 'auto', env);
      assert.strictEqual(discovery.status, 0, `prompt discovery must exit 0:\n${discovery.stderr}`);
      assert.ok(discovery.stdout.includes('Subagent Name : discovery'), discovery.stdout);
      assert.strictEqual(discovery.stdout.includes('Valid prompt roles'), false, discovery.stdout);

      const triage = runPrompt(['prompt', 'triage'], 'auto', env);
      assert.strictEqual(triage.status, 0, `prompt triage must exit 0:\n${triage.stderr}`);
      assert.ok(triage.stdout.includes('built-in default'), triage.stdout);
      assert.strictEqual(triage.stdout.includes('prompts/triage.md'), false, triage.stdout);

      const auto = runPrompt(['prompt', 'implementer'], 'auto', env);
      assert.strictEqual(auto.status, 0, `prompt implementer must exit 0:\n${auto.stderr}`);
      assert.ok(auto.stdout.includes('unresolved'), auto.stdout);
      assert.ok(auto.stdout.includes('in Google Antigravity'), auto.stdout);
      assert.strictEqual(auto.stdout.includes('in OpenCode'), false, auto.stdout);
    } finally {
      cleanup();
    }
  });

  test('CP4: codeloop config prints the selected runner and host (AC6)', () => {
    const { env, cleanup } = withFakeHome();
    try {
      const opencode = runPrompt(['config'], 'opencode', env);
      assert.strictEqual(opencode.status, 0, `config must exit 0:\n${opencode.stderr}`);
      assert.ok(opencode.stdout.includes('opencode (OpenCode)'), opencode.stdout);

      const auto = runPrompt(['config'], 'auto', env);
      assert.strictEqual(auto.status, 0, `config must exit 0:\n${auto.stderr}`);
      assert.ok(auto.stdout.includes('auto'), auto.stdout);
      assert.ok(auto.stdout.includes('unresolved'), auto.stdout);
    } finally {
      cleanup();
    }
  });

  test('CP5: plugin.json system_prompt assets resolve and stay Antigravity-shaped (AC5)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'plugin.json'), 'utf8'));

    for (const role of ['planner', 'implementer', 'gate', 'reviewer']) {
      const entry = manifest.subagents[role];
      assert.ok(entry, `${role} must stay in the Antigravity manifest`);
      const promptPath = entry.system_prompt;
      assert.ok(promptPath, `${role} must declare a system_prompt`);

      const absolute = path.join(PROJECT_ROOT, promptPath);
      assert.strictEqual(fs.existsSync(absolute), true, `${promptPath} must resolve on disk`);

      const content = fs.readFileSync(absolute, 'utf8');
      assert.strictEqual(AGY_TOOL_IDENTIFIER.test(content), true, `${promptPath} must name Antigravity tools`);
      assert.ok(content.includes('in Google Antigravity'), `${promptPath} must keep its host label`);
      assert.strictEqual(
        renderSystemPromptForHost(content, ANTIGRAVITY_TOOL_VOCABULARY),
        content,
        `${promptPath} must render byte-identically under antigravity`
      );
    }

    assert.strictEqual(manifest.subagents.gate.system_prompt, 'prompts/gate.md');
    assert.strictEqual(manifest.subagents.reviewer.system_prompt, 'prompts/reviewer.md');
  });

  test('CP6: no source file outside the vocabulary modules names an Antigravity identifier (AC3)', () => {
    const srcDir = path.join(PROJECT_ROOT, 'src');
    const allowed = new Set([
      path.join(srcDir, 'domain', 'constants.ts'),
      path.join(srcDir, 'domain', 'value-objects', 'host-tool-vocabulary.ts')
    ]);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts') || allowed.has(fullPath)) {
          continue;
        }
        if (AGY_TOOL_IDENTIFIER.test(fs.readFileSync(fullPath, 'utf8'))) {
          offenders.push(path.relative(PROJECT_ROOT, fullPath));
        }
      }
    };
    walk(srcDir);

    assert.deepStrictEqual(
      offenders,
      [],
      `these files must not spell an Antigravity tool identifier: ${offenders.join(', ')}`
    );
  });
});
