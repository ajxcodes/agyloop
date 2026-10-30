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
const {
  parseQualityGateTargets,
  lintQualityGateTargets,
  lintGateTargetRejections,
  isCommittedTreeAssertion,
  formatGateTargetContractViolations,
  MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION,
  MSG_GATE_TARGET_UNEXECUTABLE_ENTRY,
  MSG_GATE_TARGET_WORKFLOW_LINT_MISSING
} = require('../../dist/domain');

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

  test('QGT8: every target carries the 1-based plan line it was written on (#348)', () => {
    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '',
      '- `npm run build`',
      '',
      '```bash',
      'npm run typecheck',
      'node --test \\',
      '  tests/a.test.ts \\',
      '  tests/b.test.ts',
      '```',
      ''
    ].join('\n');

    const result = parseQualityGateTargets(markdown);

    assert.deepStrictEqual(
      result.targets.map((target: any) => ({ command: target.command, line: target.line })),
      [
        { command: 'npm run build', line: 5 },
        { command: 'npm run typecheck', line: 8 },
        {
          command: 'node --test tests/a.test.ts tests/b.test.ts',
          line: 9
        }
      ],
      'a continuation reports the line it STARTED on'
    );
    assert.deepStrictEqual(
      result.commands,
      result.targets.map((target: any) => target.command),
      'commands stays derived from targets'
    );
  });

  test('QGT9: the decision table refuses assertions and allows listings (#348, #369)', () => {
    // Each row carries its rationale (§2.1 D1). The verdict is the contract.
    const rows = [
      { command: 'git diff', verdict: 'allowed', why: 'listing; exits 0 on a dirty tree' },
      { command: 'git diff --stat', verdict: 'allowed', why: 'listing' },
      { command: 'git diff --name-only HEAD', verdict: 'allowed', why: 'one-revision listing' },
      { command: 'git diff --check', verdict: 'allowed', why: 'whitespace check, not a change assertion' },
      { command: 'git diff --cached', verdict: 'allowed', why: 'index listing' },
      { command: 'git diff --cached --stat', verdict: 'allowed', why: 'index listing' },
      { command: 'git diff HEAD', verdict: 'allowed', why: 'one-revision listing' },
      { command: 'git status', verdict: 'allowed', why: 'status is a listing' },
      { command: 'git status --porcelain', verdict: 'allowed', why: 'status is a listing' },
      { command: 'git diff HEAD~1 HEAD --exit-code', verdict: 'allowed', why: 'committed pair only' },
      { command: 'git diff --no-index a.json b.json --exit-code', verdict: 'allowed', why: 'file-to-file' },
      { command: 'git log --oneline -1', verdict: 'allowed', why: 'not a diff worktree comparison' },
      { command: 'git diff-tree -r HEAD', verdict: 'allowed', why: 'not a diff worktree comparison' },
      { command: 'git diff --exit-code', verdict: 'refused', why: 'assertion vs worktree' },
      { command: 'git diff --quiet', verdict: 'refused', why: 'assertion vs worktree' },
      {
        command: 'git diff --exit-code -- package-lock.json',
        verdict: 'refused',
        why: 'assertion vs worktree, scoped to one path'
      },
      { command: 'git diff HEAD --exit-code', verdict: 'refused', why: 'one-revision assertion' },
      { command: 'git diff --cached --exit-code', verdict: 'refused', why: 'index assertion' },
      { command: 'git -C . diff --quiet', verdict: 'refused', why: 'global option does not hide the assertion' }
    ];
    const refused = rows.filter((row: any) => row.verdict === 'refused').map((row: any) => row.command);

    for (const row of rows) {
      assert.strictEqual(
        isCommittedTreeAssertion(row.command),
        row.verdict === 'refused',
        `${row.command}: ${row.why}`
      );
    }

    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '```bash',
      ...rows.map((row: any) => row.command),
      '```',
      ''
    ].join('\n');
    const parsed = parseQualityGateTargets(markdown);
    const findings = lintQualityGateTargets(parsed.targets);

    assert.deepStrictEqual(
      findings.map((finding: any) => finding.command),
      refused,
      'every refused shape produces exactly one finding, in plan order'
    );
    assert.strictEqual(findings.length, refused.length);
    for (const finding of findings) {
      assert.strictEqual(finding.rule, 'committed-tree-assertion');
      assert.ok(finding.index >= 1 && finding.index <= parsed.targets.length);
      assert.strictEqual(finding.line, parsed.targets[finding.index - 1].line);
    }
  });

  test('QGT10: the formatter renders the ONE message template for every finding (#348)', () => {
    const findings = [
      {
        rule: 'committed-tree-assertion',
        index: 1,
        line: 5,
        command: 'git diff --exit-code -- package-lock.json'
      },
      {
        rule: 'committed-tree-assertion',
        index: 2,
        line: 7,
        command: 'git status --porcelain'
      }
    ];
    const rendered = formatGateTargetContractViolations(findings);

    const expectedFirst = MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION.replace('{index}', '1')
      .replace('{line}', '5')
      .replace('{command}', 'git diff --exit-code -- package-lock.json');
    const expectedSecond = MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION.replace('{index}', '2')
      .replace('{line}', '7')
      .replace('{command}', 'git status --porcelain');

    assert.strictEqual(rendered, `${expectedFirst} ${expectedSecond}`);
    assert.ok(rendered.includes('git diff --exit-code -- package-lock.json'));
    assert.ok(rendered.includes('can never pass'));
    assert.ok(rendered.includes('UNCOMMITTED'));
  });

  test('QGT11: a flagged target stays a parsed target, never `unparsed` evidence (#348)', () => {
    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '',
      '- `git diff --exit-code -- package-lock.json`',
      ''
    ].join('\n');

    const result = parseQualityGateTargets(markdown);

    assert.strictEqual(result.found, true);
    assert.deepStrictEqual(result.commands, ['git diff --exit-code -- package-lock.json']);
    assert.deepStrictEqual(result.unparsed, [], 'a finding is a refusal, never a silent drop');
  });

  test('QGT14: shell wrappers are unwrapped before classification (#369, was #372)', () => {
    const wrapped = [
      "bash -c 'git diff --exit-code'",
      'sh -c "git diff --quiet"',
      'env git diff --exit-code',
      'env CI=1 git diff --quiet',
      "bash -lc 'git diff HEAD --exit-code'"
    ];
    const notAssertions = ["bash -c 'npm test'", 'env npm test', 'sh scripts/check.sh'];

    for (const command of wrapped) {
      assert.strictEqual(isCommittedTreeAssertion(command), true, `must be refused: ${command}`);
    }
    for (const command of notAssertions) {
      assert.strictEqual(isCommittedTreeAssertion(command), false, `must not be refused: ${command}`);
    }

    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '```bash',
      ...wrapped,
      ...notAssertions,
      '```',
      ''
    ].join('\n');
    const parsed = parseQualityGateTargets(markdown);

    assert.ok(
      parsed.commands.includes("bash -c 'git diff --exit-code'"),
      'the parser keeps the quoted wrapper as ONE target'
    );
    assert.deepStrictEqual(
      lintQualityGateTargets(parsed.targets).map((finding: any) => finding.command),
      wrapped,
      'wrapped assertions are refused by exactly the same rule'
    );
  });

  test('QGT15: polyglot targets outside the old allowlist are executed, not dropped (#369)', () => {
    const commands = [
      'uv run pytest -q',
      './scripts/check.sh',
      'php vendor/bin/phpunit',
      'deno test',
      'node_modules/.bin/tsc -p .',
      'poetry run pytest'
    ];
    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '```bash',
      ...commands,
      '```',
      ''
    ].join('\n');

    const parsed = parseQualityGateTargets(markdown);

    assert.deepStrictEqual(parsed.commands, commands);
    assert.strictEqual(parsed.found, true);
    assert.deepStrictEqual(parsed.rejections, []);
  });

  test('QGT16: an unexecutable entry is a typed rejection and keeps its evidence (#369, was #372)', () => {
    const markdown = [
      '# Plan',
      '',
      '### Quality Gate Targets',
      '```bash',
      'frobnicate build --strict',
      'npm test; rm -rf dist',
      '```',
      ''
    ].join('\n');

    const parsed = parseQualityGateTargets(markdown);

    assert.strictEqual(parsed.found, false);
    assert.deepStrictEqual(parsed.commands, []);
    assert.deepStrictEqual(
      parsed.rejections.map((rejection: any) => ({
        entry: rejection.entry,
        line: rejection.line,
        reason: rejection.reason
      })),
      [
        { entry: 'frobnicate build --strict', line: 5, reason: 'unrecognized-command' },
        { entry: 'npm test; rm -rf dist', line: 6, reason: 'compound-syntax' }
      ]
    );
    assert.ok(
      parsed.unparsed.some((line: string) => line.includes('frobnicate build --strict')),
      'a rejected entry is still `unparsed` evidence'
    );
    assert.ok(
      parsed.unparsed.some((line: string) => line.includes('npm test; rm -rf dist')),
      'a rejected compound entry is still `unparsed` evidence'
    );

    const findings = lintGateTargetRejections(parsed);
    assert.strictEqual(findings.length, 2);
    assert.deepStrictEqual(
      findings.map((finding: any) => ({
        rule: finding.rule,
        line: finding.line,
        command: finding.command,
        detail: finding.detail
      })),
      [
        {
          rule: 'unexecutable-target',
          line: 5,
          command: 'frobnicate build --strict',
          detail: 'unrecognized-command'
        },
        {
          rule: 'unexecutable-target',
          line: 6,
          command: 'npm test; rm -rf dist',
          detail: 'compound-syntax'
        }
      ]
    );
  });

  test('QGT17: the formatter renders all three rules through one join (#369)', () => {
    const findings = [
      {
        rule: 'committed-tree-assertion',
        index: 1,
        line: 5,
        command: 'git diff --exit-code'
      },
      {
        rule: 'unexecutable-target',
        index: 0,
        line: 7,
        command: 'frobnicate build --strict',
        detail: 'unrecognized-command'
      },
      {
        rule: 'workflow-lint-missing',
        index: 0,
        line: 0,
        command: 'actionlint',
        detail: '.github/workflows/ci.yml'
      }
    ];

    const rendered = formatGateTargetContractViolations(findings);
    const expected = [
      MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION.replace('{index}', '1')
        .replace('{line}', '5')
        .replace('{command}', 'git diff --exit-code'),
      MSG_GATE_TARGET_UNEXECUTABLE_ENTRY.replace('{line}', '7')
        .replace('{command}', 'frobnicate build --strict')
        .replace('{detail}', 'unrecognized-command'),
      MSG_GATE_TARGET_WORKFLOW_LINT_MISSING.replace('{detail}', '.github/workflows/ci.yml').replace(
        '{command}',
        'actionlint'
      )
    ].join(' ');

    assert.strictEqual(rendered, expected, 'one join, no separator drift');
    assert.ok(rendered.includes('frobnicate build --strict'));
    assert.ok(rendered.includes('unrecognized-command'));
    assert.ok(rendered.includes('.github/workflows/ci.yml'));
    assert.ok(rendered.includes('actionlint'));
    assert.ok(rendered.includes('can never pass'));
  });

  test('QGT18: structural prose never becomes a rejection, and a deeper target heading re-anchors (#369)', () => {
    const markdown = [
      '# Plan',
      '',
      '## 4. Quality Gate & Test Verification',
      '',
      '| Command | Notes |',
      '|---|---|',
      '| `npm test` | all |',
      '',
      '> A note quoting `npm run lint` must not become a target.',
      '',
      '---',
      '',
      '### Quality Gate Targets',
      '',
      '- `npm run build`',
      '',
      '### 4.1 Decision table',
      '',
      '- `npm run lint`',
      ''
    ].join('\n');

    const parsed = parseQualityGateTargets(markdown);

    assert.deepStrictEqual(parsed.rejections, [], 'tables, blockquotes and rules are prose');
    assert.deepStrictEqual(parsed.commands, ['npm run build']);
    const headingLine = markdown.split('\n').indexOf('### Quality Gate Targets') + 1;
    assert.strictEqual(
      parsed.sectionLine,
      headingLine,
      'the deeper target heading re-anchors the section'
    );
    assert.ok(
      parsed.unparsed.some((line: string) => line.includes('| `npm test` | all |')),
      'a table row stays evidence'
    );
    assert.ok(
      parsed.unparsed.some((line: string) => line.includes('> A note quoting')),
      'a blockquote stays evidence'
    );
    assert.ok(!parsed.commands.includes('npm run lint'), 'the following subheading ends collection');
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
