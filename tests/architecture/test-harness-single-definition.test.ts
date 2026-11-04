const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_ROOT = path.resolve(__dirname, '..');

function collectFiles(dir: string): string[] {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectFiles(full));
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function scan(pattern: RegExp): { file: string; line: string }[] {
  const files = collectFiles(TESTS_ROOT);
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (const line of lines) {
      if (pattern.test(line)) hits.push({ file: path.relative(TESTS_ROOT, f), line });
    }
  }
  return hits;
}

test('every counted helper family is defined exactly once, inside tests/helpers', () => {
  const families = ['makeSandbox','runCliInSandbox','seedCheckpoint','seedTask','seedCorruptTask','seedRootState','checkpointPath','readTaskCheckpoint','readRootState','readCheckpoint','makeMockConfig','stripAnsi','checkpointLine','buildCritiqueFreePathShadow','createStateRepository','createRecordingExecutor','buildRunLifecycle'];
  for (const name of families) {
    const re = new RegExp(`^(async )?function ${name}\\b`);
    const hits = scan(re);
    assert.strictEqual(hits.length, 1, `${name}: expected 1 definition, got ${hits.length} (${JSON.stringify(hits)})`);
    assert.ok(hits[0].file.startsWith('helpers/'), `${name} defined outside helpers: ${hits[0].file}`);
  }
});

test('retired CLI-invoke names have zero definitions', () => {
  for (const name of ['runIn', 'runCliIn']) {
    const re = new RegExp(`^(async )?function ${name}\\b`);
    const hits = scan(re);
    assert.strictEqual(hits.length, 0, `${name}: expected 0 definitions, got ${hits.length}`);
  }
});

test('every retired fake spelling has zero definitions', () => {
  const retired = ['MockStateRepository','MockStateRepo','MockConfigRepository','MockConfigRepo','RecordingConfigRepository','MockPlanGenerator','StubPlanGenerator','MockGitHubGateway','RecordingGitHub','MockCommandExecutor','MockExecutor','RecordingCommandExecutor','MockWorktreeManager','RecordingWorktreeManager','RecordingProvisioner','MockStandardsRepository','MockBuildDetector','MockCritique','MockCritiquePort','MockConfirmationPrompt','FakeProbe','MockDetectImplementationDiffUseCase'];
  for (const name of retired) {
    const re = new RegExp(`^\\s*(export )?class ${name}\\b`);
    const hits = scan(re);
    assert.strictEqual(hits.length, 0, `${name}: expected 0 definitions, got ${hits.length}`);
  }
});

test('the construction factory is the only FileStateRepository site', () => {
  const re = /new FileStateRepository\(/;
  const hits = scan(re);
  assert.strictEqual(hits.length, 0, `new FileStateRepository outside helpers: ${hits.length}`);
});

test('helpers import no other tests/ module (import direction)', () => {
  const helperFiles = collectFiles(path.join(TESTS_ROOT, 'helpers'));
  const helpersRoot = path.join(TESTS_ROOT, 'helpers');
  const offenders = [];
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const importRe = /(?:require|from)\s*\(?['"]([^'"]+)['"]/g;
  for (const f of helperFiles) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      if (spec.includes('tests/') || spec.includes('tests\\')) {
        offenders.push({ file: path.relative(TESTS_ROOT, f), spec });
        continue;
      }
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(f), spec);
        const inTests = resolved === TESTS_ROOT || resolved.startsWith(TESTS_ROOT + path.sep);
        const inHelpers = resolved === helpersRoot || resolved.startsWith(helpersRoot + path.sep);
        if (inTests && !inHelpers) {
          offenders.push({ file: path.relative(TESTS_ROOT, f), spec });
        }
      }
    }
  }
  assert.deepStrictEqual(offenders, [], `helpers import other tests/: ${JSON.stringify(offenders)}`);
});

test('real test titles are unique across the suite (four named fixture artifacts excepted)', () => {
  const keepList = new Set(['fresh run halts at PLAN', 'already on base', 'added by the implementation', 'resolves base branch']);
  const titleRe = /\b(test|it)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
  const groups = new Map();
  for (const f of collectFiles(TESTS_ROOT)) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = titleRe.exec(src)) !== null) {
      const title = m[3];
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push(path.relative(TESTS_ROOT, f));
    }
  }
  const dups = [];
  for (const [title, files] of groups) {
    if (files.length > 1 && !keepList.has(title)) dups.push({ title, files });
  }
  assert.deepStrictEqual(dups, [], `duplicate real test titles: ${JSON.stringify(dups)}`);
});
