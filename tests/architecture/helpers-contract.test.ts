const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeSandbox } = require('../helpers/sandbox.ts');
const { seedTask, checkpointPath, readTaskCheckpoint } = require('../helpers/state-seed.ts');
const { createStateRepository } = require('../helpers/state-repo.ts');
const { runCliInSandbox } = require('../helpers/cli-harness.ts');
const { makeMockConfig } = require('../helpers/config.ts');
const { checkpointLine } = require('../helpers/render.ts');

test('makeSandbox seeds a real git repo with the pinned config and removes itself on cleanup', () => {
  const sb = makeSandbox();
  try {
    assert.ok(fs.existsSync(sb.path('.git')));
    const email = sb.git(['config', 'user.email'], { stdio: 'pipe' }).toString().trim();
    const name = sb.git(['config', 'user.name'], { stdio: 'pipe' }).toString().trim();
    assert.strictEqual(email, 'smoke@test');
    assert.strictEqual(name, 'smoke');
    const gi = fs.readFileSync(sb.path('.gitignore'), 'utf8');
    assert.ok(gi.includes('.worktrees/'));
  } finally {
    sb.cleanup();
  }
  assert.ok(!fs.existsSync(sb.root));
});

test('state-seed round-trips a task checkpoint through the real FileStateRepository shape', async () => {
  const sb = makeSandbox();
  try {
    const issue = 999;
    const seedPath = seedTask(sb.dir, { issue, currentStage: 'IMPLEMENT', mode: 'standard' });
    assert.ok(seedPath.endsWith(path.join('.agyloop', 'tasks', '999.json')));
    const repo = createStateRepository({ workspaceDir: sb.dir, issue });
    const loaded = await repo.load();
    assert.ok(loaded);
    assert.strictEqual(loaded.currentStage, 'IMPLEMENT');
    assert.strictEqual(loaded.issue, issue);
    const cp = checkpointPath(sb.dir, issue);
    assert.strictEqual(cp, seedPath);
    const read = readTaskCheckpoint(sb.dir, issue);
    assert.strictEqual(read.currentStage, 'IMPLEMENT');
  } finally {
    sb.cleanup();
  }
});

test('runCliInSandbox in-process and subprocess modes agree on code/stdout/stderr', async () => {
  const r1 = await runCliInSandbox(['--version'], { mode: 'in-process', stripAnsi: true });
  const r2 = await runCliInSandbox(['--version'], { mode: 'subprocess', stripAnsi: true });
  assert.strictEqual(r1.code, r2.code);
  assert.strictEqual(r1.stdout, r2.stdout);
  assert.strictEqual(r1.stderr, r2.stderr);
  assert.strictEqual(r1.stderr, '');
  // stripAnsi: true equals procedurally stripped raw output
  const raw = await runCliInSandbox(['--version'], { mode: 'in-process', stripAnsi: false });
  assert.strictEqual(raw.stdout, r1.stdout);
});

test('makeMockConfig merges overrides over defaults', () => {
  const cfg = makeMockConfig({ config: { models: { planner: 'x', implementer: 'y', gate: 'z', reviewer: 'w' } } });
  const loaded = cfg.loadConfig();
  assert.strictEqual(loaded.models.planner, 'x');
  assert.strictEqual(loaded.models.gate, 'z');
  // options default retained when not overridden
  assert.strictEqual(loaded.options.commitAfter, false);
  assert.strictEqual(loaded.options.gateTimeoutSeconds, 300);
  const cfg2 = makeMockConfig({ config: { options: { commitAfter: true, gateTimeoutSeconds: 5, autoApproveInYolo: false, enableMcpInPlanner: false } } });
  const loaded2 = cfg2.loadConfig();
  assert.strictEqual(loaded2.options.commitAfter, true);
  assert.strictEqual(loaded2.options.gateTimeoutSeconds, 5);
  // models default retained
  assert.strictEqual(loaded2.models.planner, 'pro');
  assert.strictEqual(loaded2.models.gate, 'flash_lite');
});

test('checkpointLine renders the two shapes', () => {
  assert.strictEqual(checkpointLine('foo\nCheckpoint /a/b/tasks/999.json\nbar'), '/a/b/tasks/999.json');
  assert.strictEqual(checkpointLine('no checkpoint here'), '');
});
