/**
 * agyloop - REVIEW directive Tier 1 critique path (issue #314)
 *
 * The gap: `codeloop next` built its REVIEW directive with a
 * `ResolveSubagentUseCase` that had no critique port, so the Tier 1 command
 * fell back to the literal `~/.local/bin/critique` — a path the installer never
 * writes (it writes `<user-data>/critique/bin/critique.js`). The builder was
 * covered by tests, but the WIRING into `GetNextActionUseCase` was not, which is
 * exactly why the bug shipped.
 *
 * RC1 - a resolvable port renders the exact resolved path, through `node` for a
 *       `.js` binary, with no PATH export.
 * RC2 - an unresolvable port renders the discovery instruction, never the dead
 *       hardcoded command.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GetNextActionUseCase } = require('../../dist/application');
const { FileStateRepository } = require('../../dist/infrastructure');

const ISSUE = 314;
const RESOLVED = '/home/reviewer/.local/share/critique/bin/critique.js';

const resolvedPort = {
  resolveReviewer: () => ({ source: 'user_data', path: RESOLVED, isAvailable: true }),
  review: async () => ({})
};

const unresolvedPort = {
  resolveReviewer: () => ({ source: 'none', path: null, isAvailable: false }),
  review: async () => ({})
};

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

function seedCheckpoint(stateFile: string): void {
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
        reviewDispatchCount: 0
      },
      null,
      2
    ),
    'utf8'
  );
}

describe('REVIEW directive Tier 1 quotes the critique path it resolved (issue #314)', () => {
  let sandbox: string;
  let stateFile: string;

  const readDirective = async (critiquePort: any) => {
    const stateRepo = new FileStateRepository({ stateFilePath: stateFile });
    const useCase = new GetNextActionUseCase(
      stateRepo,
      configRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      critiquePort
    );
    const previousCwd = process.cwd();
    try {
      // The repository refuses a save from a foreign task worktree; the sandbox
      // is the workspace under test and therefore the correct cwd.
      process.chdir(sandbox);
      return await useCase.execute({ issue: ISSUE, workspaceDir: sandbox });
    } finally {
      process.chdir(previousCwd);
    }
  };

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-review-critique-path-'));
    stateFile = path.join(sandbox, '.agyloop', 'tasks', `${ISSUE}.json`);
    seedCheckpoint(stateFile);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('RC1: the directive quotes the resolved .js path through node and exports no PATH', async () => {
    const result = await readDirective(resolvedPort);

    assert.strictEqual(result.actionType, 'subagent', `expected a subagent directive, got ${result.actionType}`);
    assert.strictEqual(result.role, 'reviewer');
    const prompt = result.invocationPayload?.Subagents?.[0]?.Prompt ?? '';
    assert.ok(prompt.length > 0, 'the reviewer directive must carry a prompt');
    assert.ok(
      prompt.includes(`node '${RESOLVED}' --json`),
      `AC1: the Tier 1 command must quote the resolved path, got:\n${prompt.slice(0, 3000)}`
    );
    assert.ok(
      !prompt.includes('~/.local/bin/critique --json'),
      'AC3: the dead hardcoded command must not be rendered'
    );
    assert.ok(!prompt.includes('export PATH='), 'AC4: no PATH export may be rendered');
  });

  test('RC2: an unresolvable port renders the resolver instruction, not the dead command', async () => {
    const result = await readDirective(unresolvedPort);

    const prompt = result.invocationPayload?.Subagents?.[0]?.Prompt ?? '';
    assert.ok(prompt.length > 0, 'the reviewer directive must carry a prompt');
    assert.ok(
      prompt.includes('codeloop critique status'),
      `AC2: the fallback must name the resolver, got:\n${prompt.slice(0, 3000)}`
    );
    assert.ok(
      !prompt.includes('~/.local/bin/critique --json'),
      'AC3: the fallback must not quote the dead path as the command'
    );
    assert.ok(!prompt.includes('export PATH='), 'AC4: no PATH export may be rendered');
  });
});
