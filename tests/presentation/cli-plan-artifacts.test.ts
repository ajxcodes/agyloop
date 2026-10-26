/**
 * agyloop - Plan artifact CLI behaviour (issues #283, #299, #240/Defect 5)
 *
 * T-283.1: discovery-then-plan produces exactly ONE directory and advances to
 *          PLAN without manual intervention.
 * T-283.5: no duplicate directory when one already exists.
 * T-240.D5: `Initialized` is printed only when a directory was created.
 * T-299.4: a discovery scaffold labels the RCA report AND the spec separately.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 283;
const TITLE = "[Bug] The base's own new commits";

/** A discovery report `DiscoveryReport.isPopulated` accepts. */
const POPULATED_REPORT = [
  `# [Discovery] - ${TITLE.replace('[Bug] ', '')}`,
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:** plan scaffolds a second directory and parks falsely',
  '- **Expected Behavior:** one directory per issue',
  '- **Affected Components / Paths:** src/infrastructure/file-plan-generator.ts',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:** ran transition DISCOVERY then plan',
  '- **Identified Failure Mode:** the slug was re-derived',
  '- **Relevant Code References:** scaffoldPlanDirectory',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '- **Local Reproduction Command:** codeloop transition DISCOVERY --issue 283',
  '- **Failing Test Target:** tests/generator.test.ts',
  '',
  '## 4. Remediation Strategy',
  '- **Recommended Fix Approach:** one slug grammar, populated-first adoption',
  '- **Potential Regressions / Side Effects:** deterministic selection'
].join('\n');

function stateFile(dir: string): string {
  return path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
}

function readState(dir: string): any {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
  } catch {
    return null;
  }
}

function planDirectories(dir: string): string[] {
  const plans = path.join(dir, 'artifacts', 'plans');
  if (!fs.existsSync(plans)) return [];
  return fs
    .readdirSync(plans, { withFileTypes: true })
    .filter((entry: any) => entry.isDirectory())
    .map((entry: any) => entry.name)
    .sort();
}

function discoveryArtifacts(dir: string): string[] {
  const found: string[] = [];
  for (const name of planDirectories(dir)) {
    const planDir = path.join(dir, 'artifacts', 'plans', name);
    for (const file of fs.readdirSync(planDir)) {
      if (file.startsWith('[Discovery] - ')) found.push(path.join(planDir, file));
    }
  }
  return found.sort();
}

describe('plan artifacts end to end (#283, #299, #240/5)', () => {
  test('T-283.1/T-283.5/T-299.4: discovery-then-plan keeps ONE directory and advances to PLAN', async () => {
    // This test needs the sandbox to survive several CLI invocations, so it
    // builds its own temp dir instead of using runInSandbox's teardown.
    const prevCwd = process.cwd();
    const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-plan-e2e-'));
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    let stderr = '';
    const run = async (args: readonly string[]) => {
      stdout = '';
      stderr = '';
      const code = await runCli(args);
      return { code, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
    };

    try {
      process.chdir(tempDir);
      console.log = (...a: any[]) => {
        stdout += a.map(String).join(' ') + '\n';
      };
      console.error = (...a: any[]) => {
        stderr += a.map(String).join(' ') + '\n';
      };

      const transition = await run(['transition', 'DISCOVERY', '--issue', String(ISSUE), '--title', TITLE]);
      assert.strictEqual(transition.code, 0, `${transition.stdout}\n${transition.stderr}`);
      assert.strictEqual(planDirectories(tempDir).length, 1, 'transition DISCOVERY scaffolds one directory');

      const [reportPath] = discoveryArtifacts(tempDir);
      assert.ok(reportPath, 'the discovery artifact must exist');
      fs.writeFileSync(reportPath, POPULATED_REPORT, 'utf8');

      const plan = await run(['plan', '--issue', String(ISSUE), '--title', TITLE]);
      assert.strictEqual(plan.code, 0, `${plan.stdout}\n${plan.stderr}`);
      assert.strictEqual(planDirectories(tempDir).length, 1, 'plan must NOT create a second directory');
      assert.strictEqual(discoveryArtifacts(tempDir).length, 1, 'exactly one discovery artifact');
      assert.match(plan.stdout, /Using existing plan directory/);
      assert.doesNotMatch(plan.stdout, /Initialized plan directory/);
      assert.match(plan.stdout, /Discovery Report \(discovery\): \[Discovery\] - /);
      assert.match(plan.stdout, /Specification \(implementation\): implementation_plan\.md/);

      const persisted = readState(tempDir);
      assert.strictEqual(persisted.currentStage, 'PLAN');
      assert.ok(fs.readFileSync(reportPath, 'utf8').includes('plan scaffolds a second directory'));
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('T-240.D5: the first plan prints Initialized, the second prints Using existing', async () => {
    const prevCwd = process.cwd();
    const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-plan-resume-'));
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    let stderr = '';
    const run = async (args: readonly string[]) => {
      stdout = '';
      stderr = '';
      const code = await runCli(args);
      return { code, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
    };

    try {
      process.chdir(tempDir);
      console.log = (...a: any[]) => {
        stdout += a.map(String).join(' ') + '\n';
      };
      console.error = (...a: any[]) => {
        stderr += a.map(String).join(' ') + '\n';
      };

      const first = await run(['plan', '--issue', '904', '--title', '[Bug] fresh scaffold']);
      assert.match(first.stdout, /Initialized plan directory/);
      assert.strictEqual(planDirectories(tempDir).length, 1);

      const second = await run(['plan', '--issue', '904', '--title', '[Bug] fresh scaffold']);
      assert.match(second.stdout, /Using existing plan directory/);
      assert.doesNotMatch(second.stdout, /Initialized plan directory/);
      assert.strictEqual(planDirectories(tempDir).length, 1);
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('T-299.1: a discovery scaffold never puts the RCA template in the spec mirror', async () => {
    const prevCwd = process.cwd();
    const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-plan-mirror-'));
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    let stderr = '';
    try {
      process.chdir(tempDir);
      console.log = (...a: any[]) => {
        stdout += a.map(String).join(' ') + '\n';
      };
      console.error = (...a: any[]) => {
        stderr += a.map(String).join(' ') + '\n';
      };
      const code = await runCli(['plan', '--issue', '905', '--title', '[Bug] mirror probe']);
      const output = stdout.replace(ANSI_ESCAPE, '');
      const errors = stderr.replace(ANSI_ESCAPE, '');
      assert.strictEqual(code, 0, `${output}\n${errors}`);
      assert.match(output, /Specification \(implementation\): implementation_plan\.md/);

      const [dirName] = planDirectories(tempDir);
      const planDir = path.join(tempDir, 'artifacts', 'plans', dirName);
      const mirror = fs.readFileSync(path.join(planDir, 'implementation_plan.md'), 'utf8');
      const [report] = discoveryArtifacts(tempDir);
      const reportContent = fs.readFileSync(report, 'utf8');

      assert.ok(mirror.startsWith('# [Implementation] - '), mirror.split('\n')[0]);
      assert.doesNotMatch(mirror, /Root Cause Analysis/);
      assert.ok(reportContent.startsWith('# [Discovery] - '), reportContent.split('\n')[0]);
      assert.notStrictEqual(mirror, reportContent, 'the two artifacts must not be byte-identical');
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
