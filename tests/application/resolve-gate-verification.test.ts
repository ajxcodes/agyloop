/**
 * agyloop - resolveGateVerification tests (issue #298, AC1/AC3/AC7/AC9/AC10)
 *
 * RGV1 - plan targets become the executed list; the ambient list is ignored
 * RGV2 - plan omits lint + detector finds it => appended / lintRequired / last
 * RGV3 - no plan targets => auto-detect with a visible fallback detail
 * RGV4 - explicit commands win over plan targets
 * RGV5 - integrity verified / mismatch / missing / unverified
 * RGV6 - a broken smoke protocol is surfaced as findings
 * RGV7 - a #283-style section yields whole-line commands only (continuations join)
 * RGV8 - a legacy detector's config fallback reports `config` and enforces lint
 * RGV9 - a legacy detector's auto-detect fallback still enforces detected lint
 * RGV10 - the gate path scopes and validates the declared smoke section (#362)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveGateVerification } = require('../../dist/application');

const PLAN_PATH = '/repo/.worktrees/41/artifacts/plans/41-task/implementation_plan.md';

/**
 * The shape of the #283 / #266 approved plans: backslash continuations in the
 * command fence and a `**Pass criteria**` prose list quoting the commands.
 */
const PLAN_283_STYLE = [
  '# Plan',
  '',
  '## 6. Quality Gate Targets',
  '',
  'Run from the repo root. All must pass before REVIEW.',
  '',
  '```bash',
  '# 1. Compile the source the tests import',
  'npm run build',
  '',
  '# 2. Focused suites for this change',
  'node --test \\',
  '  tests/domain/plan-directory.test.ts \\',
  '  tests/presentation/cli-plan-artifacts.test.ts',
  '',
  '# 3. Full suite (the mandatory gate)',
  'npm test',
  '```',
  '',
  '**Pass criteria**',
  '',
  '- `npm run build` exits 0 and emits no new warnings.',
  '- `npm test` exits 0 with the new tests present and green.',
  '',
  '## 7. Risks',
  ''
].join('\n');

const CLEAN_PLAN = [
  '# Plan',
  '',
  '## 5. Quality Gate Targets',
  '',
  '```bash',
  'npm run build',
  'npm test',
  '```',
  ''
].join('\n');

const PLAN_WITHOUT_LINT = CLEAN_PLAN;

const PLAN_WITH_BROKEN_SMOKE = [
  '# Plan',
  '',
  '## 5. Quality Gate Targets',
  '',
  '- `npm test`',
  '',
  '## 6. Manual Smoke Test Protocol',
  '',
  '```bash',
  'node -e \'const m = require("fixture.js"); console.log(m);\'',
  '```',
  ''
].join('\n');

function makePlanGenerator(options: {
  content?: string;
  hasHasher?: boolean;
  hash?: string | null;
} = {}): any {
  const content = options.content ?? CLEAN_PLAN;
  const hasHasher = options.hasHasher !== false;
  const generator: any = {
    content,
    planPath: PLAN_PATH,
    resolvePlanFile: () => ({
      planDir: '/repo/.worktrees/41/artifacts/plans/41-task',
      planPath: PLAN_PATH,
      planFileName: 'implementation_plan.md'
    }),
    readPlanDocument: () => generator.content,
    scaffoldPlanDirectory: () => ({}),
    generatePlan: () => ({}),
    generateSummaryLog: () => ({}),
    updateSummaryLog: () => true,
    findPlanDirectory: () => '/repo/.worktrees/41/artifacts/plans/41-task'
  };
  if (hasHasher) {
    generator.hashPlanDocument = () =>
      options.hash === undefined ? `hash:${generator.content}` : options.hash;
  }
  return generator;
}

function makeBuildDetector(options: { ambient?: any[]; lintCommand?: string | null } = {}): any {
  const detector: any = {
    ambient: options.ambient ?? [
      { id: 'ambient', label: 'Ambient Runner', command: 'ambient-command' }
    ],
    lintCommand: options.lintCommand === undefined ? 'npm run lint' : options.lintCommand,
    lastOptions: null,
    lastWorkspace: null,
    detect: async () => ({
      workspaceDir: '/repo/.worktrees/41',
      ecosystems: [],
      primaryEcosystem: { toString: () => 'node (npm)' },
      commands: detector.ambient,
      hasOverrides: false
    }),
    resolveCommands: async () => detector.ambient,
    resolveCommandPlan: async (
      workspaceDir: string,
      _config: unknown,
      resolveOptions: any = {}
    ) => {
      detector.lastOptions = resolveOptions;
      detector.lastWorkspace = workspaceDir;

      let commands: any[];
      let source: string;
      if (resolveOptions.explicitCommands && resolveOptions.explicitCommands.length > 0) {
        source = 'explicit';
        commands = resolveOptions.explicitCommands.map((command: any, idx: number) =>
          typeof command === 'string'
            ? { id: `custom-${idx + 1}`, label: `Custom ${idx + 1}`, command }
            : command
        );
      } else if (resolveOptions.planTargets && resolveOptions.planTargets.length > 0) {
        source = 'plan';
        commands = resolveOptions.planTargets.map((command: string, idx: number) => ({
          id: `plan-${idx + 1}`,
          label: `Plan Target ${idx + 1}`,
          command
        }));
      } else {
        source = 'auto-detect';
        commands = [...detector.ambient];
      }

      const appended: string[] = [];
      let lintRequired = false;
      let lintCommand: string | null = null;
      if (detector.lintCommand) {
        lintRequired = true;
        const existing = commands.find((def: any) =>
          def.command.split(/\s+/).includes('lint')
        );
        if (existing) {
          lintCommand = existing.command;
        } else {
          commands = [
            ...commands,
            { id: 'lint', label: 'Lint (npm)', command: detector.lintCommand }
          ];
          appended.push(detector.lintCommand);
          lintCommand = detector.lintCommand;
        }
      }

      return {
        commands,
        source,
        sourceDetail: `fake ${source}`,
        appended,
        lintRequired,
        lintCommand,
        planPath: resolveOptions.planPath ?? null
      };
    }
  };
  return detector;
}

/**
 * A detector that predates `resolveCommandPlan` (no provenance method): the
 * service must still report an honest source and enforce a detected lint.
 */
function makeLegacyDetector(options: {
  commands?: string[];
  lintCommand?: string | null;
} = {}): any {
  const commands = (options.commands ?? ['legacy-command']).map((command, idx) => ({
    id: `legacy-${idx + 1}`,
    label: `Legacy ${idx + 1}`,
    command
  }));
  const lintCommand = options.lintCommand === undefined ? 'npm run lint' : options.lintCommand;
  const detectedCommands = lintCommand
    ? [...commands, { id: 'lint', label: 'Lint', command: lintCommand }]
    : [...commands];

  return {
    detect: async () => ({
      workspaceDir: '/repo/.worktrees/41',
      ecosystems: [],
      primaryEcosystem: { toString: () => 'node (npm)' },
      commands: detectedCommands,
      hasOverrides: false
    }),
    resolveCommands: async () => commands
  };
}

async function verify(overrides: Record<string, unknown> = {}) {
  return resolveGateVerification({
    projectRoot: '/repo',
    workspaceDir: '/repo/.worktrees/41',
    config: { options: {} },
    issue: 41,
    planGenerator: makePlanGenerator(),
    buildDetector: makeBuildDetector(),
    ...overrides
  } as any);
}

describe('resolveGateVerification (issue #298)', () => {
  test('RGV1: plan targets are the executed list and the ambient list is ignored', async () => {
    const detector = makeBuildDetector();
    const result = await verify({ buildDetector: detector });

    assert.strictEqual(result.commandPlan.source, 'plan');
    assert.deepStrictEqual(
      result.commandPlan.commands.map((cmd: any) => cmd.command),
      ['npm run build', 'npm test', 'npm run lint']
    );
    assert.ok(!result.commandPlan.commands.some((cmd: any) => cmd.command === 'ambient-command'));
    assert.deepStrictEqual(detector.lastOptions.planTargets, ['npm run build', 'npm test']);
    assert.strictEqual(detector.lastWorkspace, '/repo/.worktrees/41');
    assert.strictEqual(result.cwd, '/repo/.worktrees/41');
  });

  test('RGV2: a plan that omits lint gets the detected lint appended last', async () => {
    const result = await verify({
      planGenerator: makePlanGenerator({ content: PLAN_WITHOUT_LINT })
    });

    assert.strictEqual(result.commandPlan.lintRequired, true);
    assert.strictEqual(result.commandPlan.lintCommand, 'npm run lint');
    assert.deepStrictEqual(result.commandPlan.appended, ['npm run lint']);
    const commands = result.commandPlan.commands.map((cmd: any) => cmd.command);
    assert.strictEqual(commands[commands.length - 1], 'npm run lint');
    assert.strictEqual(commands.filter((command: string) => command === 'npm run lint').length, 1);
  });

  test('RGV3: no plan targets falls back to auto-detect with a visible detail', async () => {
    const result = await verify({
      planGenerator: makePlanGenerator({ content: '# Plan\n\n## Context\n' })
    });

    assert.strictEqual(result.commandPlan.source, 'auto-detect');
    assert.ok(result.commandPlan.sourceDetail.includes('auto-detect'));
    assert.deepStrictEqual(
      result.commandPlan.commands.map((cmd: any) => cmd.command),
      ['ambient-command', 'npm run lint']
    );
  });

  test('RGV4: explicit commands win over plan targets', async () => {
    const result = await verify({ explicitCommands: ['echo explicit'] });

    assert.strictEqual(result.commandPlan.source, 'explicit');
    assert.deepStrictEqual(
      result.commandPlan.commands.map((cmd: any) => cmd.command),
      ['echo explicit', 'npm run lint']
    );
  });

  test('RGV5: integrity is verified / mismatch / missing / unverified', async () => {
    const matching = await verify({
      planGenerator: makePlanGenerator(),
      approvedPlanDigest: `hash:${CLEAN_PLAN}`
    });
    assert.strictEqual(matching.integrity.status, 'verified');

    const mismatch = await verify({
      planGenerator: makePlanGenerator(),
      approvedPlanDigest: 'approved-digest'
    });
    assert.strictEqual(mismatch.integrity.status, 'mismatch');
    assert.strictEqual(mismatch.integrity.expectedDigest, 'approved-digest');
    assert.strictEqual(mismatch.integrity.actualDigest, `hash:${CLEAN_PLAN}`);

    const missing = await verify({
      planGenerator: makePlanGenerator({ hash: null }),
      approvedPlanDigest: 'approved-digest'
    });
    assert.strictEqual(missing.integrity.status, 'missing');

    const unverified = await verify({ planGenerator: makePlanGenerator() });
    assert.strictEqual(unverified.integrity.status, 'unverified');

    const noHasher = await verify({
      planGenerator: makePlanGenerator({ hasHasher: false }),
      approvedPlanDigest: 'approved-digest'
    });
    assert.strictEqual(noHasher.integrity.status, 'unverified');
  });

  test('RGV6: a broken smoke protocol is surfaced as findings', async () => {
    const result = await verify({
      planGenerator: makePlanGenerator({ content: PLAN_WITH_BROKEN_SMOKE })
    });

    assert.strictEqual(result.smoke.found, true);
    assert.strictEqual(result.smoke.checks.length, 1);
    assert.ok(result.smoke.findings.length > 0);
    assert.ok(result.smoke.findings.some((finding: any) => finding.rule === 'bare-module-path'));
    assert.strictEqual(result.smoke.executable, false);
  });

  test('RGV7: a #283-style section yields whole-line commands only', async () => {
    const result = await verify({
      planGenerator: makePlanGenerator({ content: PLAN_283_STYLE })
    });

    const commands = result.commandPlan.commands.map((cmd: any) => cmd.command);
    assert.deepStrictEqual(commands, [
      'npm run build',
      'node --test tests/domain/plan-directory.test.ts tests/presentation/cli-plan-artifacts.test.ts',
      'npm test',
      'npm run lint'
    ]);
    for (const command of commands) {
      assert.ok(!command.endsWith('\\'), `truncated continuation resolved: ${command}`);
      assert.ok(!/\bexits?\b/.test(command), `prose bullet resolved as a command: ${command}`);
      assert.ok(!command.startsWith('tests/'), `continuation fragment resolved: ${command}`);
    }
    assert.strictEqual(result.commandPlan.source, 'plan');
    assert.deepStrictEqual(result.commandPlan.appended, ['npm run lint']);
    assert.ok(
      result.planTargets.unparsed.some((line: string) => line.includes('exits 0 and emits no new warnings')),
      'the pass criteria remain evidence, never executed'
    );
  });

  test('RGV8: a legacy detector config fallback reports config and enforces lint', async () => {
    const result = await verify({
      planGenerator: makePlanGenerator({ content: '# Plan\n\n## Context\n' }),
      buildDetector: makeLegacyDetector(),
      config: { options: { gateCommands: ['config-command'] } }
    });

    assert.strictEqual(result.commandPlan.source, 'config');
    assert.match(result.commandPlan.sourceDetail, /configuration gateCommands override/);
    assert.deepStrictEqual(
      result.commandPlan.commands.map((cmd: any) => cmd.command),
      ['config-command', 'npm run lint']
    );
    assert.strictEqual(result.commandPlan.lintRequired, true);
    assert.strictEqual(result.commandPlan.lintCommand, 'npm run lint');
    assert.deepStrictEqual(result.commandPlan.appended, ['npm run lint']);
  });

  test('RGV9: a legacy detector auto-detect fallback still enforces detected lint', async () => {
    const result = await verify({
      planGenerator: makePlanGenerator({ content: '# Plan\n\n## Context\n' }),
      buildDetector: makeLegacyDetector()
    });

    assert.strictEqual(result.commandPlan.source, 'auto-detect');
    assert.match(result.commandPlan.sourceDetail, /legacy build detector auto-detection/);
    assert.deepStrictEqual(
      result.commandPlan.commands.map((cmd: any) => cmd.command),
      ['legacy-command', 'npm run lint']
    );
    assert.strictEqual(result.commandPlan.lintRequired, true);
    assert.deepStrictEqual(result.commandPlan.appended, ['npm run lint']);
  });

  test('RGV10: the gate path scopes and validates the declared section (#362 AC1.4)', async () => {
    // The shape #362 Finding 1 froze: the phrase in the H1, pre-section
    // reproduction/diagram/gate-target fences, then the real section. This is
    // what `get-next-action.ts` reads before dispatching the gate
    // (`verification.smoke.findings.length > 0` blocks the dispatch).
    const plan = [
      '# [Implementation] - [Phase 6] [Bug] the Manual Smoke Test Protocol heading scoping defect',
      '',
      '## 2. Findings',
      '',
      '```bash',
      '$ node -e "console.log(1)"',
      '```',
      '',
      '```bash',
      '+------+',
      '| a    |',
      '+------+',
      '```',
      '',
      '### Quality Gate Targets',
      '',
      '```bash',
      'npm run lint',
      '```',
      '',
      '### Manual Smoke Test Protocol',
      '',
      '**S1 one**',
      '',
      '```bash',
      'echo S1',
      '```',
      '',
      '**S2 two**',
      '',
      '```bash',
      'echo S2',
      '```',
      '',
      '**S3 three**',
      '',
      '```bash',
      'echo S3',
      '```',
      ''
    ].join('\n');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-rgv-362-'));
    try {
      const planDir = path.join(tempDir, 'artifacts', 'plans', '362-h1-phrase');
      fs.mkdirSync(planDir, { recursive: true });
      const planPath = path.join(planDir, 'implementation_plan.md');
      fs.writeFileSync(planPath, plan);

      const planGenerator = makePlanGenerator({ content: plan });
      planGenerator.readPlanDocument = () => fs.readFileSync(planPath, 'utf8');
      planGenerator.resolvePlanFile = () => ({
        planDir,
        planPath,
        planFileName: 'implementation_plan.md'
      });

      const result = await verify({
        projectRoot: tempDir,
        workspaceDir: tempDir,
        planGenerator
      });

      assert.strictEqual(
        result.smoke.checks.length,
        3,
        `frozen checks: ${JSON.stringify(result.smoke.findings)}`
      );
      assert.deepStrictEqual(result.smoke.findings, []);
      assert.ok(result.smoke.headingLine >= 2, `headingLine=${result.smoke.headingLine}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('RGV-347: targetFindings lints the executed plan targets and never filters them (#348)', async () => {
    const clean = await verify({ planGenerator: makePlanGenerator({ content: CLEAN_PLAN }) });
    assert.deepStrictEqual(clean.targetFindings, [], 'a clean plan has no target findings');

    const badPlan = [
      '# Plan',
      '',
      '## 5. Quality Gate Targets',
      '',
      '- `git diff --exit-code -- package-lock.json`',
      ''
    ].join('\n');
    const bad = await verify({
      planGenerator: makePlanGenerator({ content: badPlan }),
      buildDetector: makeBuildDetector({ lintCommand: null })
    });

    assert.strictEqual(bad.targetFindings.length, 1);
    assert.strictEqual(bad.targetFindings[0].command, 'git diff --exit-code -- package-lock.json');
    assert.strictEqual(bad.targetFindings[0].line, 5);
    assert.strictEqual(bad.targetFindings[0].rule, 'committed-tree-assertion');
    // The resolver reports; it does not gate. The command stays in the plan.
    assert.deepStrictEqual(bad.commandPlan.commands.map((def: any) => def.command), [
      'git diff --exit-code -- package-lock.json'
    ]);
  });
});
