/**
 * agyloop - Baseline field contract, pinned in ONE place (issue #402, AC1/AC2/AC7)
 *
 * BC1 - `BASELINE_DECLARED_SHAPE_SENTENCE` appears VERBATIM in the planner
 *       directive, the on-disk template, the embedded fallback template and
 *       both measured-refusal messages.
 * BC2 - `ROOT_BUILD_PROHIBITION_SENTENCE` appears VERBATIM in the DISCOVERY
 *       mutation boundary, the planner directive, the CLI help and the
 *       build-refusal message.
 * BC5 - `BASELINE_COMMAND_CWD_CONTRACT` (issue #418) appears VERBATIM in the
 *       planner directive, both template copies, the CLI help and the
 *       workspace-build refusal.
 * BC6 - the workspace-build refusal carries every placeholder it is rendered
 *       with, and every measured/cwd refusal carries `{cwd}`.
 *
 * Re-typing either rule anywhere is drift; both must be interpolated.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  BASELINE_DECLARED_SHAPE_SENTENCE,
  BASELINE_COMMAND_CWD_CONTRACT,
  ROOT_BUILD_PROHIBITION_SENTENCE,
  MSG_PLAN_BASELINE_COMMAND_FAILED,
  MSG_PLAN_BASELINE_MISMATCH,
  MSG_PLAN_BASELINE_OUTPUT_MISMATCH,
  MSG_PLAN_BASELINE_ROOT_BUILD,
  MSG_PLAN_BASELINE_WORKSPACE_BUILD_OUTPUT,
  formatDiscoveryMutationBoundary
} = require('../../dist/domain');
const { ResolveSubagentUseCase } = require('../../dist/application');
const { FALLBACK_TEMPLATES, TEMPLATE_FILES } = require('../../dist');
const { printHelp } = require('../../dist/presentation/cli');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function captureHelp(): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: any[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    printHelp();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('baseline field contract (issue #402)', () => {
  test('BC1: the Declared/Output relationship is stated verbatim by every surface', () => {
    const plannerPrompt = new ResolveSubagentUseCase({}).buildPlanningTaskPrompt({
      userInstructions: 'probe'
    });
    const onDiskTemplate = fs.readFileSync(
      path.join(PROJECT_ROOT, 'templates', 'implementation-plan.md'),
      'utf8'
    );
    const fallbackTemplate = FALLBACK_TEMPLATES[TEMPLATE_FILES.IMPLEMENTATION];

    for (const [name, text] of [
      ['planner directive', plannerPrompt],
      ['templates/implementation-plan.md', onDiskTemplate],
      ['FALLBACK_TEMPLATES[implementation-plan.md]', fallbackTemplate],
      ['MSG_PLAN_BASELINE_MISMATCH', MSG_PLAN_BASELINE_MISMATCH],
      ['MSG_PLAN_BASELINE_OUTPUT_MISMATCH', MSG_PLAN_BASELINE_OUTPUT_MISMATCH]
    ] as Array<[string, string]>) {
      assert.ok(
        text.includes(BASELINE_DECLARED_SHAPE_SENTENCE),
        `${name} must carry BASELINE_DECLARED_SHAPE_SENTENCE verbatim`
      );
    }
  });

  test('BC1b: the template comment is the sentence, and nothing else', () => {
    const onDiskTemplate = fs.readFileSync(
      path.join(PROJECT_ROOT, 'templates', 'implementation-plan.md'),
      'utf8'
    );
    const fallbackTemplate = FALLBACK_TEMPLATES[TEMPLATE_FILES.IMPLEMENTATION];

    assert.ok(
      onDiskTemplate.includes(`<!-- Baseline claim shape: ${BASELINE_DECLARED_SHAPE_SENTENCE} -->`)
    );
    assert.ok(
      fallbackTemplate.includes(`<!-- Baseline claim shape: ${BASELINE_DECLARED_SHAPE_SENTENCE} -->`)
    );
  });

  test('BC2: the root-build prohibition is stated verbatim by every surface', () => {
    const plannerPrompt = new ResolveSubagentUseCase({}).buildPlanningTaskPrompt({
      userInstructions: 'probe'
    });
    const help = captureHelp();

    for (const [name, text] of [
      ['formatDiscoveryMutationBoundary', formatDiscoveryMutationBoundary('artifacts/plans/402')],
      ['planner directive', plannerPrompt],
      ['codeloop --help', help],
      ['MSG_PLAN_BASELINE_ROOT_BUILD', MSG_PLAN_BASELINE_ROOT_BUILD]
    ] as Array<[string, string]>) {
      assert.ok(
        text.includes(ROOT_BUILD_PROHIBITION_SENTENCE),
        `${name} must carry ROOT_BUILD_PROHIBITION_SENTENCE verbatim`
      );
    }
  });

  test('BC3: the build refusal names the matched construct and a runnable workaround', () => {
    assert.ok(MSG_PLAN_BASELINE_ROOT_BUILD.includes('{match}'));
    assert.ok(MSG_PLAN_BASELINE_ROOT_BUILD.includes('npx tsc --outDir'));
    assert.ok(
      MSG_PLAN_BASELINE_ROOT_BUILD.includes('$HOME/.cache/agyloop/baseline-<issue>/dist'),
      'the recipe must point outside the workspace'
    );
  });

  test('BC4: the measured refusal no longer blames the claim vaguely', () => {
    for (const template of [MSG_PLAN_BASELINE_MISMATCH, MSG_PLAN_BASELINE_OUTPUT_MISMATCH]) {
      assert.strictEqual(template.includes('correct the declared value (or the command)'), false);
      assert.ok(template.includes('Copy the measured stdout'), template);
    }
  });

  test('BC5: the command cwd contract is stated verbatim by every surface (#418)', () => {
    const plannerPrompt = new ResolveSubagentUseCase({}).buildPlanningTaskPrompt({
      userInstructions: 'probe'
    });
    const onDiskTemplate = fs.readFileSync(
      path.join(PROJECT_ROOT, 'templates', 'implementation-plan.md'),
      'utf8'
    );
    const fallbackTemplate = FALLBACK_TEMPLATES[TEMPLATE_FILES.IMPLEMENTATION];
    const help = captureHelp();

    for (const [name, text] of [
      ['planner directive', plannerPrompt],
      ['templates/implementation-plan.md', onDiskTemplate],
      ['FALLBACK_TEMPLATES[implementation-plan.md]', fallbackTemplate],
      ['codeloop --help', help],
      ['MSG_PLAN_BASELINE_WORKSPACE_BUILD_OUTPUT', MSG_PLAN_BASELINE_WORKSPACE_BUILD_OUTPUT]
    ] as Array<[string, string]>) {
      assert.ok(
        text.includes(BASELINE_COMMAND_CWD_CONTRACT),
        `${name} must carry BASELINE_COMMAND_CWD_CONTRACT verbatim`
      );
    }
  });

  test('BC6: the cwd refusals carry every placeholder they are rendered with (#418)', () => {
    for (const placeholder of ['{claim}', '{line}', '{match}', '{command}', '{cwd}']) {
      assert.ok(
        MSG_PLAN_BASELINE_WORKSPACE_BUILD_OUTPUT.includes(placeholder),
        `the workspace-build refusal must carry ${placeholder}`
      );
    }
    assert.ok(MSG_PLAN_BASELINE_WORKSPACE_BUILD_OUTPUT.includes('npx tsc --outDir'));
    assert.ok(
      MSG_PLAN_BASELINE_WORKSPACE_BUILD_OUTPUT.includes(
        '$HOME/.cache/agyloop/baseline-<issue>/dist'
      ),
      'the recipe must point outside the workspace'
    );
    assert.ok(MSG_PLAN_BASELINE_COMMAND_FAILED.includes('{cwd}'));
    for (const template of [MSG_PLAN_BASELINE_MISMATCH, MSG_PLAN_BASELINE_OUTPUT_MISMATCH]) {
      assert.ok(template.includes('{cwd}'), template);
      assert.ok(template.includes('measured {measured} with cwd={cwd}'), template);
    }
  });
});
