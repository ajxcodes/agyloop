/**
 * agyloop - Quality Gate Targets parser tests (issue #298, AC1/AC6)
 *
 * QGT1 - every supported heading variant parses
 * QGT2 - plan order is preserved and `&&` chains split in order
 * QGT3 - the smoke section is never harvested as gate commands
 * QGT4 - prose and table rows are `unparsed` evidence, never commands
 * QGT5 - duplicates are removed; an empty section is `found: false`
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseQualityGateTargets } = require('../../dist/domain');

const FENCED = ['```bash', 'npm run build', 'npm test', '```'].join('\n');

describe('parseQualityGateTargets (issue #298)', () => {
  test('QGT1: every supported heading variant parses its fenced commands', () => {
    const headings = [
      '## 5. Quality Gate Targets',
      '## Automated Test Targets',
      '## Build / Lint Commands',
      '## Quality Gate & Test Verification'
    ];

    for (const heading of headings) {
      const markdown = `# Plan\n\n${heading}\n\n${FENCED}\n\n## 6. Next Section\n`;
      const result = parseQualityGateTargets(markdown);

      assert.strictEqual(result.found, true, `heading '${heading}' must be recognised`);
      assert.deepStrictEqual(result.commands, ['npm run build', 'npm test'], heading);
      assert.ok(result.sectionLine > 0, 'the section line must be reported');
    }
  });

  test('QGT2: plan order is preserved and an && chain splits into ordered targets', () => {
    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '- `npm run build && npm run lint`',
      '- `npm test`',
      ''
    ].join('\n');

    const result = parseQualityGateTargets(markdown);

    assert.deepStrictEqual(result.commands, [
      'npm run build',
      'npm run lint',
      'npm test'
    ]);
  });

  test('QGT3: commands inside the Manual Smoke Test Protocol are not gate targets', () => {
    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '- `npm run build`',
      '',
      '### Manual Smoke Test Protocol',
      '',
      '```bash',
      'node scripts/smoke.js',
      '```',
      ''
    ].join('\n');

    const result = parseQualityGateTargets(markdown);

    assert.deepStrictEqual(result.commands, ['npm run build']);
    assert.ok(
      !result.commands.includes('node scripts/smoke.js'),
      'a smoke check is never executed as a gate target'
    );
  });

  test('QGT4: prose and table rows are unparsed evidence, never commands', () => {
    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      'Run these from the worktree root.',
      '| Command | Notes |',
      '|---|---|',
      '| `npm test` | all |',
      '- `npm run lint`',
      '- `npm test; npm run build`',
      '- `npm test || true`',
      ''
    ].join('\n');

    const result = parseQualityGateTargets(markdown);

    assert.deepStrictEqual(result.commands, ['npm run lint']);
    assert.ok(result.unparsed.some((line: string) => line.includes('Run these from the worktree root')));
    assert.ok(result.unparsed.some((line: string) => line.includes('| Command | Notes |')));
    assert.ok(
      result.unparsed.some((line: string) => line.includes('npm test; npm run build')),
      'a `;` chain is never inferred into an execution plan'
    );
    assert.ok(result.unparsed.some((line: string) => line.includes('npm test || true')));
  });

  test('QGT5: duplicates are removed and an empty section is not found', () => {
    const duplicated = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '- `npm test`',
      '- `npm test`',
      '- `npm run build`',
      '- `npm test`',
      ''
    ].join('\n');
    const deduped = parseQualityGateTargets(duplicated);
    assert.deepStrictEqual(deduped.commands, ['npm test', 'npm run build']);

    const empty = parseQualityGateTargets(
      ['# Plan', '', '### Quality Gate Targets', '- **Target 1:**', '- **Target 2:**', ''].join('\n')
    );
    assert.strictEqual(empty.found, false);
    assert.deepStrictEqual(empty.commands, []);

    const absent = parseQualityGateTargets('# Plan\n\n## Context\n');
    assert.strictEqual(absent.found, false);
    assert.strictEqual(absent.sectionLine, 0);
  });

  test('QGT6: `\\` continuations join into ONE target and prose bullets stay unparsed', () => {
    // The shape of the #283 / #266 approved plans: a fence with a multi-line
    // `node --test` invocation (backslash continuations) followed by a
    // `**Pass criteria**` prose list whose bullets QUOTE the commands.
    const markdown = [
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
      '# 2. Type-level contract across src AND tests',
      'npm run typecheck',
      '',
      '# 3. Focused suites for this change',
      'node --test \\',
      '  tests/domain/plan-directory.test.ts \\',
      '  tests/domain/plan-document-kind.test.ts \\',
      '  tests/presentation/cli-plan-artifacts.test.ts',
      '',
      '# 4. Full suite (the mandatory gate)',
      'npm test',
      '```',
      '',
      '**Pass criteria**',
      '',
      '- `npm run build` exits 0 and emits no new warnings.',
      '- `npm run typecheck` exits 0 (this is where stale mocks fail).',
      '- `npm run lint` exits 0.',
      '- The focused command exits 0 with no skipped tests.',
      '- `npm test` exits 0 with the new tests present and green.',
      '',
      '## 7. Risks, ordering, and rollback',
      ''
    ].join('\n');

    const result = parseQualityGateTargets(markdown);

    assert.deepStrictEqual(result.commands, [
      'npm run build',
      'npm run typecheck',
      'node --test tests/domain/plan-directory.test.ts tests/domain/plan-document-kind.test.ts tests/presentation/cli-plan-artifacts.test.ts',
      'npm test'
    ]);

    for (const command of result.commands) {
      // Every emitted command is a whole-line command: no continuation
      // residue, no sentence tail, no prose clause appended to a script.
      assert.ok(!command.endsWith('\\'), `truncated continuation emitted: ${command}`);
      assert.ok(!/[.!?]$/.test(command), `prose tail emitted: ${command}`);
      assert.ok(!/\bexits?\b/.test(command), `prose clause emitted: ${command}`);
      assert.ok(
        !command.startsWith('tests/'),
        `fragment of a continuation emitted as a target: ${command}`
      );
    }

    assert.ok(
      result.unparsed.some((line: string) =>
        line.includes('`npm run build` exits 0 and emits no new warnings')
      ),
      'a prose pass-criterion is evidence, never a command'
    );
    assert.ok(
      result.unparsed.some((line: string) => line.includes('`npm run lint` exits 0')),
      'a prose lint criterion must not become `npm run lint exits 0`'
    );
    assert.ok(
      !result.unparsed.some((line: string) => line.includes('tests/domain/plan-directory.test.ts')),
      'the continuation lines are joined, not reported as fragments'
    );
  });

  test('QGT7: an unterminated continuation is evidence, never a command', () => {
    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '```bash',
      'npm run build',
      'node --test \\',
      '```',
      ''
    ].join('\n');

    const result = parseQualityGateTargets(markdown);

    assert.deepStrictEqual(result.commands, ['npm run build']);
    assert.ok(!result.commands.some((command: string) => command.includes('node --test')));
    assert.ok(result.unparsed.some((line: string) => line.includes('node --test')));

    // A comment or a blank line ends the continuation: the plan never wrote a
    // command joining the two fragments, so neither may be executed.
    const interrupted = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '```bash',
      'node --test \\',
      '# a note instead of the continuation',
      'npm test',
      '```',
      ''
    ].join('\n');
    const interruptedResult = parseQualityGateTargets(interrupted);

    assert.deepStrictEqual(interruptedResult.commands, ['npm test']);
    assert.ok(
      interruptedResult.unparsed.some((line: string) => line.includes('node --test')),
      'the fragment before the interruption is evidence'
    );
  });
});
