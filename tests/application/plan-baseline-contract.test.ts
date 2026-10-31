/**
 * agyloop - Plan baseline contract guard tests (issue #388, Defect 1)
 *
 * PBC1 - the #382 DA-METRICS-1 shape (declared 3, measured 4) is REFUSED, and
 *        the message names the claim id, the declared value, the measured value
 *        and the command
 * PBC2 - a matching claim passes and the command runs from the workspace cwd
 * PBC3 - header claim with no evidence, an incomplete claim and a body drift are
 *        refused structurally, without executing anything
 * PBC3d - the body-drift refusal names BOTH real values and the offending line
 * PBC2c - a row quoting declared X and measured Y passes when X matches
 * PBC4 - a failing command and a timeout are refused, naming the exit code
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertPlanBaselineContract
} = require('../../dist/application');
const {
  BASELINE_DECLARED_SHAPE_SENTENCE,
  ROOT_BUILD_PROHIBITION_SENTENCE,
  ValidationError
} = require('../../dist/domain');

const MISMATCH_COMMAND = "node -e 'console.log(\"{ additions: 4, deletions: 0 }\")'";

function planGeneratorFor(planPath: string): any {
  return {
    readPlanDocument: (target: string) => fs.readFileSync(target, 'utf8')
  };
}

function planWithClaim(declared: string, outputLine: string): string {
  return [
    '# [Implementation] - baseline probe',
    '',
    '## 1. Context & Objectives',
    '- **Feature Overview:** probe',
    '',
    '### Baseline Evidence',
    '',
    '#### DA-METRICS-1',
    '',
    `- **Declared:** \`${declared}\``,
    `- **Command:** \`${MISMATCH_COMMAND}\``,
    `- **Output:** \`${outputLine}\``,
    ''
  ].join('\n');
}

interface ClaimFixture {
  readonly id: string;
  readonly declared: string;
  readonly command: string;
  readonly output: string;
}

function planWithClaims(claims: readonly ClaimFixture[]): string {
  const lines = [
    '# [Implementation] - baseline probe',
    '',
    '## 1. Context & Objectives',
    '- **Feature Overview:** probe',
    '',
    '### Baseline Evidence',
    ''
  ];
  for (const claim of claims) {
    lines.push(
      `#### ${claim.id}`,
      '',
      `- **Declared:** \`${claim.declared}\``,
      `- **Command:** \`${claim.command}\``,
      `- **Output:** \`${claim.output}\``,
      ''
    );
  }
  return lines.join('\n');
}

function executorReturning(result: any): any {
  const calls: any[] = [];
  return {
    calls,
    execute: async (command: string, options: any) => {
      calls.push({ command, options });
      return {
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
        combinedOutput: '',
        durationMs: 1,
        timedOut: false,
        ...result
      };
    }
  };
}

describe('assertPlanBaselineContract (issue #388)', () => {
  let root: string;
  let planPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-baseline-'));
    planPath = path.join(root, 'implementation_plan.md');
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  test('PBC1: the #382 shape is refused, naming the measured value', async () => {
    fs.writeFileSync(
      planPath,
      planWithClaim('{ additions: 3, deletions: 0 }', '{ additions: 4, deletions: 0 }'),
      'utf8'
    );
    const executor = executorReturning({ stdout: '{ additions: 4, deletions: 0 }\n' });

    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('DA-METRICS-1'), err.message);
        assert.ok(err.message.includes('3'), err.message);
        assert.ok(err.message.includes('4'), err.message);
        assert.ok(err.message.includes('additions: 4'), err.message);
        assert.ok(err.message.includes(MISMATCH_COMMAND), err.message);
        return true;
      }
    );

    assert.strictEqual(executor.calls.length, 1, 'the plan command was executed once');
    assert.strictEqual(executor.calls[0].options.cwd, root);
    assert.strictEqual(executor.calls[0].options.timeoutMs, 60_000);
  });

  test('PBC2: a matching baseline passes', async () => {
    fs.writeFileSync(
      planPath,
      planWithClaim('{ additions: 4, deletions: 0 }', '{ additions: 4, deletions: 0 }'),
      'utf8'
    );
    const executor = executorReturning({ stdout: '{ additions: 4, deletions: 0 }\n' });

    await assert.doesNotReject(() =>
      assertPlanBaselineContract({
        planGenerator: planGeneratorFor(planPath),
        planPath,
        workspaceDir: root,
        commandExecutor: executor
      })
    );
    assert.strictEqual(executor.calls.length, 1);
  });

  test('PBC2b: a console.log preface does not cause a false mismatch', async () => {
    fs.writeFileSync(planPath, planWithClaim('4', '4'), 'utf8');
    const executor = executorReturning({ stdout: 'measuring...\n4\n' });

    await assert.doesNotReject(() =>
      assertPlanBaselineContract({
        planGenerator: planGeneratorFor(planPath),
        planPath,
        workspaceDir: root,
        commandExecutor: executor
      })
    );
  });

  test('PBC2c: a declared/measured row passes when its declared span matches', async () => {
    fs.writeFileSync(
      planPath,
      [
        '# [Implementation] - documented row',
        '',
        '## 4. Quality Gate & Test Verification',
        '| ID | Asserts |',
        '|---|---|',
        '| DA-METRICS-1 | declared `{ additions: 3, deletions: 0 }`, measured `{ additions: 4, deletions: 0 }` |',
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `{ additions: 3, deletions: 0 }`',
        "- **Command:** `node -e 'console.log(\"{ additions: 3, deletions: 0 }\")'`",
        '- **Output:** `{ additions: 3, deletions: 0 }`',
        ''
      ].join('\n'),
      'utf8'
    );
    const executor = executorReturning({ stdout: '{ additions: 3, deletions: 0 }\n' });

    await assert.doesNotReject(() =>
      assertPlanBaselineContract({
        planGenerator: planGeneratorFor(planPath),
        planPath,
        workspaceDir: root,
        commandExecutor: executor
      })
    );
    assert.strictEqual(executor.calls.length, 1);
  });

  test('PBC3: an unbacked header claim is refused without executing anything', async () => {
    fs.writeFileSync(
      planPath,
      [
        '# [Implementation] - unbacked',
        '',
        'Every baseline value was reproduced through `dist/` before this plan was written.',
        '',
        '## 1. Context & Objectives',
        '- **Feature Overview:** probe',
        ''
      ].join('\n'),
      'utf8'
    );
    const executor = executorReturning({ stdout: '4\n' });

    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        }),
      (err: any) => {
        assert.strictEqual(err.field, 'planBaseline');
        assert.match(err.message, /baseline evidence/i);
        return true;
      }
    );
    assert.strictEqual(executor.calls.length, 0, 'structural findings never execute a command');
  });

  test('PBC3b: an incomplete claim is refused structurally', async () => {
    fs.writeFileSync(
      planPath,
      [
        '# [Implementation] - incomplete',
        '',
        '## 1. Context & Objectives',
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `3`',
        ''
      ].join('\n'),
      'utf8'
    );
    const executor = executorReturning({ stdout: '3\n' });

    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        }),
      (err: any) => {
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('DA-METRICS-1'), err.message);
        assert.match(err.message, /command/i);
        assert.match(err.message, /output/i);
        return true;
      }
    );
    assert.strictEqual(executor.calls.length, 0);
  });

  test('PBC3c: a body drift from the evidenced value is refused structurally', async () => {
    fs.writeFileSync(
      planPath,
      [
        '# [Implementation] - drift',
        '',
        '## 4. Quality Gate & Test Verification',
        '| ID | Asserts |',
        '|---|---|',
        '| DA-METRICS-1 | totals are `{ additions: 4, deletions: 0 }` |',
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `{ additions: 3, deletions: 0 }`',
        "- **Command:** `node -e 'console.log(3)'`",
        '- **Output:** `{ additions: 3, deletions: 0 }`',
        ''
      ].join('\n'),
      'utf8'
    );
    const executor = executorReturning({ stdout: '3\n' });

    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        }),
      (err: any) => {
        assert.strictEqual(err.field, 'planBaseline');
        assert.strictEqual(err.message.includes('DA-METRICS-1'), true, err.message);
        return true;
      }
    );
    assert.strictEqual(executor.calls.length, 0);
  });

  test('PBC3d: the body-drift refusal names both real values and the offending line', async () => {
    fs.writeFileSync(
      planPath,
      [
        '# [Implementation] - drift message',
        '',
        '## 4. Quality Gate & Test Verification',
        '| ID | Asserts |',
        '|---|---|',
        '| DA-METRICS-1 | totals are `{ additions: 5, deletions: 0 }` |',
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `{ additions: 3, deletions: 0 }`',
        "- **Command:** `node -e 'console.log(3)'`",
        '- **Output:** `{ additions: 3, deletions: 0 }`',
        ''
      ].join('\n'),
      'utf8'
    );
    const executor = executorReturning({ stdout: '3\n' });

    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        }),
      (err: any) => {
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('DA-METRICS-1'), err.message);
        assert.ok(err.message.includes('{ additions: 3, deletions: 0 }'), err.message);
        assert.ok(err.message.includes('{ additions: 5, deletions: 0 }'), err.message);
        assert.ok(err.message.includes('plan line 6'), err.message);
        assert.ok(err.message.includes('totals are'), err.message, 'the offending line is quoted');
        assert.strictEqual(
          err.message.includes('(the value in the evidence section)'),
          false,
          'no placeholder may survive the interpolation'
        );
        return true;
      }
    );
    assert.strictEqual(executor.calls.length, 0);
  });

  test('PBC4: a failing command and a timeout are refused with the mechanism named', async () => {
    fs.writeFileSync(planPath, planWithClaim('4', '4'), 'utf8');

    const failing = executorReturning({ exitCode: 2, stderr: 'boom' });
    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: failing
        }),
      (err: any) => {
        assert.strictEqual(err.field, 'planBaseline');
        assert.match(err.message, /exited 2/i);
        assert.match(err.message, /boom/);
        return true;
      }
    );

    const timedOut = executorReturning({ timedOut: true, exitCode: 124 });
    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: timedOut
        }),
      /timed out/i
    );
  });

  test('PBC5: --dry-run never executes plan code, and a missing plan is left to other guards', async () => {
    fs.writeFileSync(planPath, planWithClaim('4', '4'), 'utf8');
    const executor = executorReturning({ stdout: '4\n' });

    await assert.doesNotReject(() =>
      assertPlanBaselineContract({
        planGenerator: planGeneratorFor(planPath),
        planPath,
        workspaceDir: root,
        commandExecutor: executor,
        dryRun: true
      })
    );
    assert.strictEqual(executor.calls.length, 0, 'a preview must not run plan code');

    // An unreadable plan is not a baseline list.
    await assert.doesNotReject(() =>
      assertPlanBaselineContract({
        planGenerator: planGeneratorFor(planPath),
        planPath: path.join(root, 'missing.md'),
        workspaceDir: root,
        commandExecutor: executor
      })
    );
  });

  test('PBC6: a prose Declared with a verified Output is accepted once and warns to copy the stdout', async () => {
    const measured = 'adhoc-phase-6 adhoc-phase-6 true';
    fs.writeFileSync(
      planPath,
      planWithClaims([
        {
          id: 'base-d1-lossy-collision',
          declared: 'the two CJK titles share one folder',
          command: `node -e 'console.log("${measured}")'`,
          output: measured
        }
      ]),
      'utf8'
    );
    const executor = executorReturning({ stdout: `${measured}\n` });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: any) => {
      warnings.push(String(message));
    };

    try {
      await assert.doesNotReject(() =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        })
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.strictEqual(executor.calls.length, 1, 'each claim is executed exactly once');
    assert.ok(
      warnings.some((warning) => warning.includes('literal stdout')),
      warnings.join('\n')
    );
  });

  test('PBC7: a fabricated Output is refused even when Declared is the measured stdout', async () => {
    const measured = 'adhoc-phase-6 adhoc-phase-6 true';
    const fabricated = 'adhoc-phase-6 adhoc-phase-6 false';
    fs.writeFileSync(
      planPath,
      planWithClaims([
        {
          id: 'base-d1-lossy-collision',
          declared: measured,
          command: `node -e 'console.log("${measured}")'`,
          output: fabricated
        }
      ]),
      'utf8'
    );
    const executor = executorReturning({ stdout: `${measured}\n` });

    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('base-d1-lossy-collision'), err.message);
        assert.ok(err.message.includes(fabricated), err.message);
        assert.ok(err.message.includes(measured), err.message);
        assert.ok(err.message.includes(BASELINE_DECLARED_SHAPE_SENTENCE), err.message);
        return true;
      }
    );
    assert.strictEqual(executor.calls.length, 1);
  });

  test('PBC8: a build-like claim is refused before ANY claim executes', async () => {
    const measured = '4';
    fs.writeFileSync(
      planPath,
      planWithClaims([
        {
          id: 'read-only-claim',
          declared: measured,
          command: `node -e 'console.log("${measured}")'`,
          output: measured
        },
        {
          id: 'root-build-claim',
          declared: 'built',
          command: 'npm run build >/dev/null 2>&1 && node -e "console.log(1)"',
          output: 'built'
        }
      ]),
      'utf8'
    );
    const executor = executorReturning({ stdout: `${measured}\n` });

    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('root-build-claim'), err.message);
        assert.ok(
          err.message.includes('npm run build >/dev/null 2>&1 && node -e "console.log(1)"'),
          err.message
        );
        assert.ok(err.message.includes('npm run build'), err.message);
        assert.ok(err.message.includes(ROOT_BUILD_PROHIBITION_SENTENCE), err.message);
        assert.ok(err.message.includes('npx tsc --outDir'), err.message);
        return true;
      }
    );
    assert.strictEqual(executor.calls.length, 0, 'a refused build-like plan executes nothing');
  });

  test('PBC9: a value-shaped wrong Declared is still refused (the #382 regression pin)', async () => {
    fs.writeFileSync(
      planPath,
      planWithClaims([
        {
          id: 'DA-METRICS-1',
          declared: '{ additions: 3, deletions: 0 }',
          command: `node -e 'console.log("{ additions: 4, deletions: 0 }")'`,
          output: '{ additions: 4, deletions: 0 }'
        }
      ]),
      'utf8'
    );
    const executor = executorReturning({ stdout: '{ additions: 4, deletions: 0 }\n' });

    await assert.rejects(
      () =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor
        }),
      (err: any) => {
        assert.strictEqual(err.field, 'planBaseline');
        assert.ok(err.message.includes('{ additions: 3, deletions: 0 }'), err.message);
        assert.ok(err.message.includes('{ additions: 4, deletions: 0 }'), err.message);
        assert.ok(err.message.includes(BASELINE_DECLARED_SHAPE_SENTENCE), err.message);
        assert.ok(err.message.includes('Copy the measured stdout'), err.message);
        return true;
      }
    );
    assert.strictEqual(executor.calls.length, 1);
  });

  test('PBC10: --dry-run warns about a build-like claim and executes nothing', async () => {
    fs.writeFileSync(
      planPath,
      planWithClaims([
        {
          id: 'root-build-claim',
          declared: 'built',
          command: 'npm run build >/dev/null 2>&1 && node -e "console.log(1)"',
          output: 'built'
        }
      ]),
      'utf8'
    );
    const executor = executorReturning({ stdout: 'built\n' });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: any) => {
      warnings.push(String(message));
    };

    try {
      await assert.doesNotReject(() =>
        assertPlanBaselineContract({
          planGenerator: planGeneratorFor(planPath),
          planPath,
          workspaceDir: root,
          commandExecutor: executor,
          dryRun: true
        })
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.strictEqual(executor.calls.length, 0, 'a preview must not run plan code');
    assert.ok(
      warnings.some((warning) => warning.includes('root-build-claim') && warning.includes('npm run build')),
      warnings.join('\n')
    );
  });

  test('PBC11: each matching claim executes exactly once with the unchanged cwd and timeout', async () => {
    fs.writeFileSync(
      planPath,
      planWithClaims([
        {
          id: 'claim-one',
          declared: '4',
          command: "node -e 'console.log(4)'",
          output: '4'
        },
        {
          id: 'claim-two',
          declared: '5',
          command: "node -e 'console.log(5)'",
          output: '5'
        }
      ]),
      'utf8'
    );
    const stdoutByCommand: Record<string, string> = {
      "node -e 'console.log(4)'": '4\n',
      "node -e 'console.log(5)'": '5\n'
    };
    const calls: any[] = [];
    const executor = {
      execute: async (command: string, options: any) => {
        calls.push({ command, options });
        const stdout = stdoutByCommand[command] ?? '';
        return {
          command,
          exitCode: 0,
          stdout,
          stderr: '',
          combinedOutput: stdout,
          durationMs: 1,
          timedOut: false
        };
      }
    };

    await assert.doesNotReject(() =>
      assertPlanBaselineContract({
        planGenerator: planGeneratorFor(planPath),
        planPath,
        workspaceDir: root,
        commandExecutor: executor
      })
    );

    assert.strictEqual(calls.length, 2, 'one execution per claim');
    assert.deepStrictEqual(
      calls.map((call: any) => call.command),
      ["node -e 'console.log(4)'", "node -e 'console.log(5)'"]
    );
    for (const call of calls) {
      assert.strictEqual(call.options.cwd, root);
      assert.strictEqual(call.options.timeoutMs, 60_000);
    }
  });
});
