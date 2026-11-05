const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');
const HELPERS_FAKES = path.join(TESTS_ROOT, 'helpers', 'fakes');

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function extractInterfaceMembers(filePath: string, ifaceName: string): { required: string[]; optional: string[] } {
  const src = stripComments(fs.readFileSync(filePath, 'utf8'));
  const re = new RegExp('interface\\s+' + ifaceName + '\\s*\\{');
  const m = src.match(re);
  if (!m) throw new Error(`interface ${ifaceName} not found in ${filePath}`);
  const start = src.indexOf(m[0]) + m[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  const body = src.slice(start, i - 1);
  const members = [];
  let cur = '';
  let d = 0;
  for (let c of body) {
    if (c === '{') { d++; cur += c; }
    else if (c === '}') { d--; cur += c; }
    else if (c === ';' && d === 0) { members.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) members.push(cur.trim());
  const required = [];
  const optional = [];
  for (const mstr of members) {
    const mm = mstr.match(/^(\w+)\s*(\?)?\s*[\(:<]/);
    if (!mm) continue;
    if (mm[2]) optional.push(mm[1]);
    else required.push(mm[1]);
  }
  return { required, optional };
}

function extractFakeMethods(filePath: string): Set<string> {
  const src = stripComments(fs.readFileSync(filePath, 'utf8'));
  const methods = new Set<string>();
  const r = /public\s+(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/g;
  let mm;
  while ((mm = r.exec(src)) !== null) {
    methods.add(mm[1]);
  }
  return methods;
}

// StateRepository's TR-8 required surface (includes the optional members the
// canonical double deliberately implements, so a drift like getStateFilePath
// missing from one spelling fails here first).
const STATE_REPOSITORY_TR8 = ['load', 'save', 'reset', 'getStateFilePath', 'forIssue', 'resetTask', 'resetAll', 'listAllStates'];

const MAPPING = [
  { fake: 'state-repository.ts', ifaceFile: 'src/ports/state-repository.ts', iface: 'StateRepository', className: 'FakeStateRepository', extra: STATE_REPOSITORY_TR8 },
  { fake: 'config-repository.ts', ifaceFile: 'src/ports/config-repository.ts', iface: 'ConfigRepository', className: 'FakeConfigRepository' },
  { fake: 'plan-generator.ts', ifaceFile: 'src/ports/plan-generator.ts', iface: 'PlanGeneratorPort', className: 'FakePlanGenerator' },
  { fake: 'github-gateway.ts', ifaceFile: 'src/ports/github-gateway.ts', iface: 'GitHubGateway', className: 'FakeGitHubGateway' },
  { fake: 'command-executor.ts', ifaceFile: 'src/ports/command-executor.ts', iface: 'CommandExecutorPort', className: 'FakeCommandExecutor' },
  { fake: 'worktree-manager.ts', ifaceFile: 'src/ports/worktree-manager.ts', iface: 'WorktreeManagerPort', className: 'FakeWorktreeManager' },
  { fake: 'standards-repository.ts', ifaceFile: 'src/ports/standards-repository.ts', iface: 'StandardsRepository', className: 'FakeStandardsRepository' },
  { fake: 'build-detector.ts', ifaceFile: 'src/ports/build-detector.ts', iface: 'BuildDetectorPort', className: 'FakeBuildDetector' },
  { fake: 'critique.ts', ifaceFile: 'src/ports/critique.ts', iface: 'CritiquePort', className: 'FakeCritique' },
  { fake: 'confirmation-prompt.ts', ifaceFile: 'src/ports/confirmation-prompt.ts', iface: 'ConfirmationPromptPort', className: 'FakeConfirmationPrompt' },
  { fake: 'detect-implementation-diff.ts', ifaceFile: 'src/ports/workspace-mutation-probe.ts', iface: 'WorkspaceMutationProbePort', className: 'FakeWorkspaceMutationProbe' },
  { fake: 'detect-implementation-diff.ts', ifaceFile: 'src/application/detect-implementation-diff.ts', iface: 'ImplementationProbe', className: 'FakeImplementationProbe' }
];

test('canonical fakes declare implements for their port', () => {
  for (const entry of MAPPING) {
    const fakePath = path.join(HELPERS_FAKES, entry.fake);
    const src = fs.readFileSync(fakePath, 'utf8');
    const re = new RegExp('class\\s+' + entry.className + '\\s+implements\\s+[^{]*\\b' + entry.iface + '\\b');
    assert.ok(re.test(src), `${entry.fake} (${entry.className}) missing "implements ${entry.iface}"`);
  }
});

test('canonical fakes implement every required port member', () => {
  for (const entry of MAPPING) {
    const fakePath = path.join(HELPERS_FAKES, entry.fake);
    const ifacePath = path.resolve(TESTS_ROOT, '..', entry.ifaceFile);
    const { required } = extractInterfaceMembers(ifacePath, entry.iface);
    const expected = entry.extra ? entry.extra : required;
    const methods = extractFakeMethods(fakePath);
    const missing = expected.filter((m) => !methods.has(m));
    assert.deepStrictEqual(
      missing,
      [],
      `${entry.className} missing port members: ${missing.join(', ')} (expected ${expected.join(', ')})`
    );
  }
});

test('port required members are a subset of the fake surface (drift guard)', () => {
  // Specifically the getStateFilePath drift example from the issue: every
  // required member of StateRepository must resolve on FakeStateRepository.
  const ifacePath = path.join(SRC_ROOT, 'ports', 'state-repository.ts');
  const { required } = extractInterfaceMembers(ifacePath, 'StateRepository');
  const methods = extractFakeMethods(path.join(HELPERS_FAKES, 'state-repository.ts'));
  for (const m of required) {
    assert.ok(methods.has(m), `FakeStateRepository missing required StateRepository member: ${m}`);
  }
  assert.ok(methods.has('getStateFilePath'), 'getStateFilePath must be present (port-drift example)');
});
