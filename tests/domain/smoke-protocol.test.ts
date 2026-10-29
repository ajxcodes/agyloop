/**
 * agyloop - SmokeProtocol tests (issue #298, AC8/AC10)
 *
 * SP1 - the #283 JSON-quoted comparison shape is named at its plan line
 * SP2 - a bare relative module path is named; `node:`/`./`/builtins allowed
 * SP3 - a section with no shell fence is not executable
 * SP4 - the runner emits one marker per check and attributes the failure
 * SP5 - a comment-only check is empty
 * SP6 - a fixture-seeding JSON.stringify does not taint an unrelated comparison (#327)
 * SP7 - only the comparison that calls the JSON-producing helper is flagged (#327)
 * SP8 - an inline JSON.stringify inside the compared substitution is still rejected
 * SP9 - `jq -c` is rejected; `jq -r` (raw text) is accepted
 * SP10 - a /tmp-sandbox check invoking the CLI is rejected at its plan line (#359)
 * SP11 - the #351-shape smoke-<issue> sandbox still validates with 0 findings (#359)
 * SP12 - a file-only mktemp helper is not a sandbox (#359)
 * SP13 - a bare mktemp -d in a CLI check is flagged (implicit OS temp root) (#359)
 * SP14 - mktemp -d staging with NO CLI invocation is not flagged (#359)
 * SP15 - the sandbox rule ignores legit mkdir targets, flags reserved/temp ones (#359)
 * SP16 - an H1 carrying the section phrase does not scope the section (#362 F1)
 * SP17 - an H1-only phrase document declares NO protocol (#362 F1)
 * SP18 - the #359 plan's own S2 shape validates clean, and its script is runnable (#362 F2)
 * SP19 - the sandbox-path probe matrix classifies every documented shape (#362 F2)
 * SP20 - same-check $VAR roots are resolved; a /tmp root cannot be laundered (#362 F2)
 * SP21 - a bare mktemp -d + HOME override stays flagged (accepted limitation) (#362 F2)
 * SP22 - archived plans keep their frozen heading line and check count (#362 AC1.3/AC2.4)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SmokeProtocol } = require('../../dist/domain');

const SMOKE_HEADING = '## 6. Manual Smoke Test Protocol';

function planOf(lines: string[]): string {
  return ['# Plan', '', SMOKE_HEADING, '', ...lines, ''].join('\n');
}

describe('SmokeProtocol.fromPlan (issue #298)', () => {
  test('SP1: a JSON-quoted shell comparison is reported at the comparison line with a label', () => {
    const markdown = planOf([
      '#### Check 1 — RTM state helper',
      '',
      '```bash',
      'state() {',
      '  node -e \'process.stdout.write(JSON.stringify(process.argv[1]))\' "$1"',
      '}',
      'if [ "$(state 283 currentStage)" = "PLAN" ]; then',
      '  echo "PASS"',
      'fi',
      '```'
    ]);

    const protocol = SmokeProtocol.fromPlan(markdown);

    assert.strictEqual(protocol.found, true);
    assert.strictEqual(protocol.checks.length, 1);
    const finding = protocol.findings.find((f: any) => f.rule === 'quoted-json-comparison');
    assert.ok(finding, 'the quoted comparison must be reported');
    assert.strictEqual(finding.checkIndex, 1);
    assert.ok(finding.label.includes('Check 1'), `label=${finding.label}`);
    assert.ok(finding.line > 0);
    assert.ok(finding.excerpt.includes('state 283'), finding.excerpt);
    assert.strictEqual(protocol.executable, false);
  });

  test('SP2: a bare relative module path is reported; node:/./builtins are allowed', () => {
    const broken = SmokeProtocol.fromPlan(
      planOf([
        '```bash',
        'node -e \'const m = require("fixture.js");\'',
        '```'
      ])
    );
    const finding = broken.findings.find((f: any) => f.rule === 'bare-module-path');
    assert.ok(finding, 'a bare `require("fixture.js")` must be reported');
    assert.ok(finding.excerpt.includes('fixture.js'));

    const allowed = SmokeProtocol.fromPlan(
      planOf([
        '```bash',
        'node -e \'const fs = require("fs"); const p = require("node:path"); const x = require("./x.js");\'',
        '```'
      ])
    );
    assert.deepStrictEqual(allowed.findings, []);
    assert.strictEqual(allowed.executable, true);
  });

  test('SP3: a section with zero shell fences is not executable', () => {
    const protocol = SmokeProtocol.fromPlan(
      ['# Plan', '', SMOKE_HEADING, '', 'Run the checks below.', '', '## 7. Next', ''].join('\n')
    );

    assert.strictEqual(protocol.checks.length, 0);
    const finding = protocol.findings.find((f: any) => f.rule === 'no-executable-check');
    assert.ok(finding, 'a zero-check protocol must be rejected');
    assert.strictEqual(finding.line, 3, 'the finding names the section heading line');
    assert.strictEqual(protocol.executable, false);
  });

  test('SP3b: a placeholder-only scaffold section is NOT DECLARED, not broken', () => {
    // The generated plan template (never dispatched through the PLANNER by the
    // yolo fast path) emits exactly this shape. Treating it as a broken
    // protocol would strand every auto-scaffolded plan at IMPLEMENT.
    const protocol = SmokeProtocol.fromPlan(
      [
        '# Plan',
        '',
        SMOKE_HEADING,
        '- **Check 1:** ',
        '',
        '## 7. Next',
        ''
      ].join('\n')
    );

    assert.strictEqual(protocol.found, false);
    assert.strictEqual(protocol.checks.length, 0);
    assert.deepStrictEqual(protocol.findings, []);
    assert.strictEqual(protocol.executable, true);
    assert.strictEqual(protocol.toScript(), null);
  });

  test('SP3c: a section whose only fence is not shell is not executable', () => {
    const protocol = SmokeProtocol.fromPlan(
      ['# Plan', '', SMOKE_HEADING, '', '```text', 'echo not shell', '```', ''].join('\n')
    );

    assert.strictEqual(protocol.found, true);
    assert.strictEqual(protocol.checks.length, 0);
    assert.ok(protocol.findings.some((f: any) => f.rule === 'no-executable-check'));
  });

  test('SP4: toScript emits one marker per check and attributeFailure maps the last one', () => {
    const protocol = SmokeProtocol.fromPlan(
      planOf([
        '#### Check 1 — first',
        '',
        '```bash',
        'echo "C1 PASS"',
        '```',
        '',
        '#### Check 2 — second',
        '',
        '```bash',
        'echo "C2 FAIL: boom"',
        'exit 1',
        '```'
      ])
    );

    assert.strictEqual(protocol.checks.length, 2);
    const script = protocol.toScript();
    assert.ok(script.includes('__AGYLOOP_SMOKE_CHECK_1__'));
    assert.ok(script.includes('__AGYLOOP_SMOKE_CHECK_2__'));
    assert.ok(script.startsWith('set -e'));

    const failure = protocol.attributeFailure(
      [
        '__AGYLOOP_SMOKE_CHECK_1__',
        'C1 PASS',
        '__AGYLOOP_SMOKE_CHECK_2__',
        'C2 FAIL: boom'
      ].join('\n')
    );

    assert.ok(failure);
    assert.strictEqual(failure.checkIndex, 2);
    assert.ok(failure.label.includes('Check 2'), failure.label);
    assert.ok(failure.planLine > 0);
    assert.ok(failure.failLine.includes('C2 FAIL'), failure.failLine);

    assert.strictEqual(protocol.attributeFailure(null), null);
    assert.strictEqual(protocol.attributeFailure('no markers here'), null);
  });

  test('SP5: a comment-only fenced check is empty', () => {
    const protocol = SmokeProtocol.fromPlan(
      planOf([
        '```bash',
        '# nothing to run here',
        '',
        '```'
      ])
    );

    const finding = protocol.findings.find((f: any) => f.rule === 'empty-check');
    assert.ok(finding, 'an empty check must be rejected');
    assert.strictEqual(protocol.executable, false);
  });

  test('an absent section is found:false and executable (nothing to run)', () => {
    const protocol = SmokeProtocol.fromPlan('# Plan\n\n## Context\n');
    assert.strictEqual(protocol.found, false);
    assert.strictEqual(protocol.checks.length, 0);
    assert.deepStrictEqual(protocol.findings, []);
    assert.strictEqual(protocol.toScript(), null);
  });

  // ---------------------------------------------------------------------------
  // Issue #327, Defect 1: attribution is per COMPARISON, not per fence.
  // ---------------------------------------------------------------------------

  function quotedFindings(markdown: string): any[] {
    return SmokeProtocol.fromPlan(markdown).findings.filter(
      (finding: any) => finding.rule === 'quoted-json-comparison'
    );
  }

  test('SP6: a fixture-seeding JSON.stringify does not taint an unrelated comparison (#327)', () => {
    const markdown = planOf([
      '```bash',
      'BEFORE=$(git rev-parse HEAD)',
      `node -e "require('fs').writeFileSync('x.json', JSON.stringify({ a: 1 }))"`,
      '[ "$(git rev-parse HEAD)" = "$BEFORE" ] && echo "PASS unchanged" || echo "FAIL moved"',
      '```'
    ]);

    assert.deepStrictEqual(
      quotedFindings(markdown),
      [],
      'the compared command (git rev-parse) never emits JSON quoting'
    );
    assert.strictEqual(SmokeProtocol.fromPlan(markdown).executable, true);
  });

  test('SP7: only the comparison that calls the JSON-producing helper is flagged (#327)', () => {
    const findings = quotedFindings(
      planOf([
        '```bash',
        'plain() {',
        '  git rev-parse HEAD',
        '}',
        'state() {',
        `  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"`,
        '}',
        '[ "$(plain)" = "$BEFORE" ] && echo "PASS unchanged" || echo "FAIL moved"',
        'if [ "$(state 283 currentStage)" = "PLAN" ]; then echo PASS; fi',
        '```'
      ])
    );

    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.ok(findings[0].excerpt.includes('state 283'), findings[0].excerpt);
    assert.ok(!findings[0].excerpt.includes('plain'), findings[0].excerpt);
  });

  test('SP8: an inline JSON.stringify inside the compared substitution is still rejected (#327)', () => {
    const findings = quotedFindings(
      planOf([
        '```bash',
        `[ "$(node -e 'process.stdout.write(JSON.stringify(1))')" = "1" ] && echo PASS`,
        '```'
      ])
    );

    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
  });

  test('SP9: `jq -c` is still rejected while `jq -r` (raw text) is accepted (#327)', () => {
    const compact = quotedFindings(
      planOf([
        '```bash',
        `[ "$(state 283 | jq -c '.currentStage')" = "PLAN" ] && echo PASS`,
        '```'
      ])
    );
    assert.strictEqual(compact.length, 1, JSON.stringify(compact));

    const raw = quotedFindings(
      planOf([
        '```bash',
        `[ "$(state 283 | jq -r '.currentStage')" = "PLAN" ] && echo PASS`,
        '```'
      ])
    );
    assert.deepStrictEqual(raw, [], 'raw jq output is unquoted text');
  });

  // ---------------------------------------------------------------------------
  // Issue #359: the sandbox-path rule — a CLI check may only sandbox where the
  // state guard recognises its own sandbox ($HOME/.cache/agyloop/smoke-*).
  // ---------------------------------------------------------------------------

  function sandboxFindings(markdown: string): any[] {
    return SmokeProtocol.fromPlan(markdown).findings.filter(
      (finding: any) => finding.rule === 'sandbox-path'
    );
  }

  test('SP10: a /tmp-sandbox check invoking the CLI is rejected at its plan line (#359)', () => {
    // The exact #339-shape protocol: mktemp -d under /tmp, then a state-mutating
    // codeloop call. It used to dispatch with 0 findings and die at gate round 1.
    const markdown = planOf([
      '#### Check 1 - transition in a /tmp sandbox',
      '',
      '```bash',
      'SBX=$(mktemp -d /tmp/opencode/smoke339-XXXXXX)',
      'git clone . "$SBX/repo"',
      'cd "$SBX/repo"',
      'node bin/codeloop.js transition --issue 339 --to IMPLEMENT',
      'rm -rf "$SBX"',
      '```'
    ]);
    const mktempLine = markdown.split('\n').findIndex((line: string) => line.includes('mktemp')) + 1;

    const protocol = SmokeProtocol.fromPlan(markdown);

    assert.strictEqual(protocol.executable, false);
    const findings = sandboxFindings(markdown);
    assert.strictEqual(findings.length, 1, JSON.stringify(protocol.findings));
    const finding = findings[0];
    assert.strictEqual(finding.checkIndex, 1);
    assert.ok(finding.label.includes('Check 1'), finding.label);
    assert.strictEqual(finding.line, mktempLine, 'the finding names the mktemp plan line');
    assert.ok(finding.excerpt.includes('mktemp -d /tmp'), finding.excerpt);
    assert.ok(finding.excerpt.includes('$HOME/.cache/agyloop/smoke-'), finding.excerpt);
  });

  test('SP11: the #351-shape smoke-<issue> sandbox still validates with 0 findings (#359)', () => {
    const markdown = planOf([
      '```bash',
      'mkdir -p "$HOME/.cache/agyloop"',
      'SBX=$(mktemp -d "$HOME/.cache/agyloop/smoke-351-next-XXXXXX")',
      'git clone . "$SBX/repo"',
      'cd "$SBX/repo"',
      'env -u AGY_SUBAGENT node bin/codeloop.js transition --issue 351 --to IMPLEMENT',
      'rm -rf "$SBX"',
      '```'
    ]);

    const protocol = SmokeProtocol.fromPlan(markdown);

    assert.deepStrictEqual(protocol.findings, []);
    assert.strictEqual(protocol.executable, true);
  });

  test('SP12: a file-only mktemp helper is not a sandbox (#359)', () => {
    // The #351 plan's S4 shape: a bare `mktemp` creates a FILE, never a
    // directory sandbox, even though the check invokes the CLI.
    const markdown = planOf([
      '```bash',
      'HELP_FILE=$(mktemp)',
      'node bin/codeloop.js --help > "$HELP_FILE"',
      'rm -f "$HELP_FILE"',
      '```'
    ]);

    assert.deepStrictEqual(sandboxFindings(markdown), []);
    assert.strictEqual(SmokeProtocol.fromPlan(markdown).executable, true);
  });

  test('SP13: a bare mktemp -d in a CLI check is flagged (implicit OS temp root) (#359)', () => {
    const markdown = planOf([
      '```bash',
      'SBX=$(mktemp -d)',
      'git clone . "$SBX/repo"',
      'cd "$SBX/repo"',
      'node bin/codeloop.js transition --issue 359 --to IMPLEMENT',
      'rm -rf "$SBX"',
      '```'
    ]);

    const protocol = SmokeProtocol.fromPlan(markdown);
    assert.strictEqual(protocol.executable, false);
    const findings = sandboxFindings(markdown);
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.ok(findings[0].excerpt.includes('mktemp -d'), findings[0].excerpt);
    assert.ok(findings[0].excerpt.includes('$HOME/.cache/agyloop/smoke-'), findings[0].excerpt);
  });

  test('SP14: mktemp -d staging with NO CLI invocation is not flagged (#359)', () => {
    // I3.1 (negative): the rule is per CHECK — a fixture-staging check that
    // never invokes the CLI may use temp dirs freely (it is never run by the
    // guard's state-mutation path through a codeloop command).
    const markdown = planOf([
      '```bash',
      'A=$(mktemp -d)',
      'B=$(mktemp -d)',
      'cp -r fixtures/x "$A"',
      'diff -ru "$A" "$B" && echo "PASS identical"',
      'rm -rf "$A" "$B"',
      '```'
    ]);

    assert.deepStrictEqual(sandboxFindings(markdown), []);
    assert.strictEqual(SmokeProtocol.fromPlan(markdown).executable, true);
  });

  test('SP15: the sandbox rule ignores legit mkdir targets and flags reserved/temp ones (#359)', () => {
    const findingsFor = (body: string[]): any[] =>
      sandboxFindings(
        planOf(['```bash', ...body, 'node bin/codeloop.js status --issue 359', '```'])
      );

    // Negatives: the sandbox ROOT parent is not a sandbox, nor a fixture dir.
    assert.deepStrictEqual(findingsFor(['mkdir -p "$HOME/.cache/agyloop"']), []);
    assert.deepStrictEqual(findingsFor(['mkdir -p fixtures/x']), []);

    // Positives: a TMPDIR-rooted mktemp, a /var/tmp root, and the reserved
    // in-workspace artifacts/smoke path the guard refuses (rule 3).
    assert.strictEqual(findingsFor(['SBX=$(mktemp -d -p "$TMPDIR" smoke-x)']).length, 1);
    assert.strictEqual(findingsFor(['mkdir -p /var/tmp/smoke359']).length, 1);
    assert.strictEqual(findingsFor(['mkdir -p artifacts/smoke359']).length, 1);
  });

  // ---------------------------------------------------------------------------
  // Issue #362, Finding 1: the document H1 is a TITLE, never a smoke section.
  // ---------------------------------------------------------------------------

  const PHRASE_TITLE =
    '# [Implementation] - [Phase 6] [Bug] the Manual Smoke Test Protocol heading scoping defect';

  /**
   * The #362 Finding-1 shape: the phrase in the H1, a pre-section reproduction
   * fence (`$ node -e …`), an ASCII-art diagram, the gate-target list, and then
   * the real `###` section with three declared checks.
   */
  function phrasePlan(h1: string): string {
    return [
      h1,
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
  }

  test('SP16: an H1 carrying the phrase does not scope the section (#362 F1)', () => {
    const withPhrase = SmokeProtocol.fromPlan(phrasePlan(PHRASE_TITLE));

    assert.ok(withPhrase.headingLine >= 2, `headingLine=${withPhrase.headingLine}`);
    assert.strictEqual(withPhrase.checks.length, 3, JSON.stringify(withPhrase.checks));
    assert.deepStrictEqual(
      withPhrase.checks.map((check: any) => check.label),
      ['S1 one', 'S2 two', 'S3 three']
    );
    assert.deepStrictEqual(withPhrase.findings, []);
    assert.strictEqual(withPhrase.executable, true);

    // SP16b: the H1 phrase changes nothing about extraction.
    const scrubbed = SmokeProtocol.fromPlan(
      phrasePlan('# [Implementation] - normalized title')
    );
    assert.strictEqual(scrubbed.headingLine, withPhrase.headingLine);
    assert.deepStrictEqual(
      scrubbed.checks.map((check: any) => check.label),
      withPhrase.checks.map((check: any) => check.label)
    );
    assert.strictEqual(scrubbed.toScript(), withPhrase.toScript());

    // SP16c: no pre-section fence is frozen into the protocol.
    const bodies = withPhrase.checks.map((check: any) => check.body).join('\n');
    assert.ok(!bodies.includes('npm run lint'), bodies);
    assert.ok(!bodies.includes('+------+'), bodies);
    assert.ok(!/^\s*\$ /m.test(withPhrase.toScript() ?? ''), 'no shell-prompt line');
  });

  test('SP17: an H1-only phrase document declares no protocol (#362 F1)', () => {
    // A title is not a section: the accepted consequence of the level guard is
    // NOT-DECLARED (true for any plan without a smoke section) rather than a
    // frozen whole-document protocol.
    const protocol = SmokeProtocol.fromPlan(
      `${PHRASE_TITLE}\n\nSome prose about the section.\n`
    );

    assert.strictEqual(protocol.found, false);
    assert.strictEqual(protocol.checks.length, 0);
    assert.strictEqual(protocol.toScript(), null);
    assert.deepStrictEqual(protocol.findings, []);
  });

  // ---------------------------------------------------------------------------
  // Issue #362, Finding 2: the `sandbox-path` rule must not reject correct
  // sandboxes. The #359 S1/S2/S3 fence bodies are copied verbatim from
  // `artifacts/plans/359-…/implementation_plan.md`, because the archive is
  // untracked and therefore absent from a fresh worktree.
  // ---------------------------------------------------------------------------

  const SMOKE_359_S1 = [
    'set -u',
    'REPO_ROOT="${REPO_ROOT:-$PWD}"',
    'cd "$REPO_ROOT"',
    "node -e '",
    'const { SmokeProtocol } = require("./dist/domain");',
    'const plan = [',
    '  "# Plan", "",',
    '  "## 6. Manual Smoke Test Protocol", "",',
    '  "#### Check 1 - transition in a /tmp sandbox", "",',
    '  "```bash",',
    '  "SBX=$(mktemp -d /tmp/opencode/smoke339-XXXXXX)",',
    '  "git clone . \\"$SBX/repo\\"",',
    '  "cd \\"$SBX/repo\\"",',
    '  "node bin/codeloop.js transition --issue 339 --to IMPLEMENT",',
    '  "rm -rf \\"$SBX\\"",',
    '  "```", ""',
    '].join("\\n");',
    'const p = SmokeProtocol.fromPlan(plan);',
    'const f = p.findings.find((x) => x.rule === "sandbox-path");',
    'if (p.executable) { console.log("FAIL: the /tmp-sandbox protocol still validates executable"); process.exit(1); }',
    'if (!f) { console.log("FAIL: no sandbox-path finding was emitted"); process.exit(1); }',
    'if (f.checkIndex !== 1) { console.log("FAIL: finding names check " + f.checkIndex + ", expected 1"); process.exit(1); }',
    'if (!(f.line > 0)) { console.log("FAIL: finding carries no plan line"); process.exit(1); }',
    'if (!f.excerpt.includes("mktemp -d /tmp")) { console.log("FAIL: excerpt does not name the offending line: " + f.excerpt); process.exit(1); }',
    'if (!f.excerpt.includes("$HOME/.cache/agyloop/smoke-")) { console.log("FAIL: excerpt does not name the required path: " + f.excerpt); process.exit(1); }',
    'console.log("OK S1: /tmp sandbox protocol rejected - check " + f.checkIndex + ", plan line " + f.line + ", " + f.excerpt);',
    "'"
  ].join('\n');

  const SMOKE_359_S2 = [
    'set -u',
    'REPO_ROOT="${REPO_ROOT:-$PWD}"',
    'cd "$REPO_ROOT"',
    "node -e '",
    'const { SmokeProtocol } = require("./dist/domain");',
    'const correct = [',
    '  "# Plan", "",',
    '  "## 6. Manual Smoke Test Protocol", "",',
    '  "```bash",',
    '  "mkdir -p \\"$HOME/.cache/agyloop\\"",',
    '  "SBX=$(mktemp -d \\"$HOME/.cache/agyloop/smoke-359-check-XXXXXX\\")",',
    '  "git clone . \\"$SBX/repo\\"",',
    '  "cd \\"$SBX/repo\\"",',
    '  "env -u AGY_SUBAGENT node bin/codeloop.js transition --issue 359 --to IMPLEMENT",',
    '  "rm -rf \\"$SBX\\"",',
    '  "```", ""',
    '].join("\\n");',
    'const p = SmokeProtocol.fromPlan(correct);',
    'if (!p.executable || p.findings.length !== 0) {',
    '  console.log("FAIL: the #351-shape protocol now has findings: " + JSON.stringify(p.findings));',
    '  process.exit(1);',
    '}',
    'const fileMktemp = [',
    '  "# Plan", "",',
    '  "## 6. Manual Smoke Test Protocol", "",',
    '  "```bash",',
    '  "HELP_FILE=$(mktemp)",',
    '  "node bin/codeloop.js --help > \\"$HELP_FILE\\"",',
    '  "rm -f \\"$HELP_FILE\\"",',
    '  "```", ""',
    '].join("\\n");',
    'const q = SmokeProtocol.fromPlan(fileMktemp);',
    'const bad = q.findings.filter((x) => x.rule === "sandbox-path");',
    'if (bad.length !== 0) {',
    '  console.log("FAIL: a file-only mktemp was flagged as a sandbox: " + JSON.stringify(bad));',
    '  process.exit(1);',
    '}',
    'console.log("OK S2: the correct smoke-<issue> sandbox and the file-only mktemp both validate clean");',
    "'"
  ].join('\n');

  const SMOKE_359_S3 = [
    'set -u',
    'REPO_ROOT="${REPO_ROOT:-$PWD}"',
    'cd "$REPO_ROOT"',
    "node -e '",
    'const { ResolveSubagentUseCase } = require("./dist/application/resolve-subagent");',
    'const p = new ResolveSubagentUseCase({}).buildPlanningTaskPrompt({',
    '  planDir: "artifacts/plans/359-x/",',
    '  planPath: "artifacts/plans/359-x/implementation_plan.md"',
    '});',
    'if (!(p.match(/\\.cache\\/agyloop\\/smoke-/g) || []).length) {',
    '  console.log("FAIL: the planner prompt never names the required sandbox path");',
    '  process.exit(1);',
    '}',
    'if (!(p.match(/mktemp/g) || []).length) {',
    '  console.log("FAIL: the planner prompt never states the mktemp/sandbox constraint");',
    '  process.exit(1);',
    '}',
    'console.log("OK S3: the planner task prompt names " + ".cache/agyloop/smoke-<issue>" + " and the mktemp constraint (" + p.length + " chars)");',
    "'"
  ].join('\n');

  /** The archived #359 plan's smoke section, title phrase included. */
  function smoke359Replica(): string {
    return [
      '# [Implementation] - [Phase 6] [Bug] the planner can author smoke blocks the state guard refuses the Manual Smoke Test Protocol task prompt and static validator never constrain the sandbox path so gate round 1 fails as it did in 339',
      '',
      '## 4. Verification',
      '',
      '### Manual Smoke Test Protocol',
      '',
      'Run every block from the worktree root, **after `npm run build`**.',
      '',
      '**S1 — the #339-shape protocol is rejected before dispatch**',
      '',
      '```bash',
      SMOKE_359_S1,
      '```',
      '',
      '**S2 — the #351-shape sandbox and the file-only `mktemp` helper validate clean**',
      '',
      '```bash',
      SMOKE_359_S2,
      '```',
      '',
      '**S3 — the planner task prompt constrains where authored blocks may sandbox**',
      '',
      '```bash',
      SMOKE_359_S3,
      '```',
      ''
    ].join('\n');
  }

  test('SP18: the #359 plan S2 shape validates clean and its script is runnable (#362 F2)', () => {
    const protocol = SmokeProtocol.fromPlan(smoke359Replica());

    assert.deepStrictEqual(protocol.findings, [], JSON.stringify(protocol.findings));
    assert.strictEqual(protocol.executable, true);
    assert.strictEqual(protocol.checks.length, 3, 'only the declared fences are checks');
    assert.ok(protocol.headingLine >= 2, `headingLine=${protocol.headingLine}`);

    const script = protocol.toScript() ?? '';
    const markers = script.match(/__AGYLOOP_SMOKE_CHECK_[0-9]+__/g) ?? [];
    assert.strictEqual(markers.length, 3);
    assert.ok(!/^\s*\$ /m.test(script), 'no shell-prompt line');
    assert.ok(!script.includes('+------+'));
    assert.ok(!script.includes('npm run lint'));
  });

  test('SP19: the sandbox-path probe matrix classifies every documented shape (#362 F2)', () => {
    const findingsFor = (body: string[]): any[] => sandboxFindings(planOf(['```bash', ...body, '```']));

    const rows: Array<{ name: string; body: string[]; expected: number }> = [
      {
        name: 'real invocation + recognised sandbox',
        body: [
          'SBX=$(mktemp -d "$HOME/.cache/agyloop/smoke-362-x")',
          'env -u AGY_SUBAGENT node bin/codeloop.js transition --issue 362'
        ],
        expected: 0
      },
      {
        name: 'quoted command text over a /tmp path (I4 baseline)',
        body: [
          'SBX=$(mktemp -d /tmp/opencode/smoke362-XXXXXX)',
          '"node bin/codeloop.js transition --issue 362"'
        ],
        expected: 0
      },
      {
        name: 'quoted env-prefixed text over a /tmp path (I4 complete)',
        body: [
          'SBX=$(mktemp -d /tmp/opencode/smoke362-XXXXXX)',
          '"env -u AGY_SUBAGENT node bin/codeloop.js transition --issue 362"'
        ],
        expected: 0
      },
      {
        name: 'seeded escaped path + env-prefixed text (the #359 S2 pair)',
        body: [
          String.raw`  "SBX=$(mktemp -d \"$HOME/.cache/agyloop/smoke-362-x\")",`,
          '  "env -u AGY_SUBAGENT node bin/codeloop.js transition --issue 362",'
        ],
        expected: 0
      },
      {
        // The F2.1 mechanism on its own: an escaped recognised path in a check
        // that DOES invoke the CLI must be unescaped, not flagged.
        name: 'escaped recognised path in a real invocation check',
        body: [
          String.raw`SBX=$(mktemp -d \"$HOME/.cache/agyloop/smoke-362-x\")`,
          'node bin/codeloop.js status --issue 362'
        ],
        expected: 0
      },
      {
        name: 'explicit non-temp template under PWD (§2.3.4)',
        body: [
          'SBX=$(mktemp -d "$PWD/fixture-XXXXXX")',
          'node bin/codeloop.js status --issue 362'
        ],
        expected: 0
      },
      {
        name: 'bare mktemp -d (implicit OS temp root, SP13 pin)',
        body: ['SBX=$(mktemp -d)', 'node bin/codeloop.js transition --issue 362'],
        expected: 1
      },
      {
        name: 'explicit /tmp root (SP10 pin)',
        body: [
          'SBX=$(mktemp -d /tmp/opencode/smoke362-XXXXXX)',
          'node bin/codeloop.js transition --issue 362'
        ],
        expected: 1
      },
      {
        name: 'control: quoted binary path in a real invocation',
        body: [
          'SBX=$(mktemp -d /tmp/opencode/smoke362-XXXXXX)',
          `( cd "$work" && AGY_SUBAGENT='' node "$root/bin/codeloop.js" sync )`
        ],
        expected: 1
      },
      {
        name: 'control: a command substitution still invokes',
        body: [
          'SBX=$(mktemp -d /tmp/opencode/smoke362-XXXXXX)',
          'OUT="$(codeloop next --json)"'
        ],
        expected: 1
      }
    ];

    for (const row of rows) {
      assert.strictEqual(
        findingsFor(row.body).length,
        row.expected,
        `${row.name}: ${JSON.stringify(findingsFor(row.body))}`
      );
    }
  });

  test('SP20: same-check $VAR roots resolve, and a /tmp root cannot be laundered (#362 F2)', () => {
    // a) The #284 shape: the recognised root arrives through a variable.
    const indirected = planOf([
      '```bash',
      'ROOT="$PWD"; SANDBOX="$HOME/.cache/agyloop"; mkdir -p "$SANDBOX"; WS="$(mktemp -d "$SANDBOX/smoke-284-XXXXXX")"; cd "$WS"',
      'node bin/codeloop.js status --issue 284',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(indirected), []);

    // b) Resolution cannot launder a temp root.
    const tempRoot = planOf([
      '```bash',
      'D=/tmp/opencode; W=$(mktemp -d "$D/smoke-362-XXXXXX")',
      'node bin/codeloop.js status --issue 362',
      '```'
    ]);
    assert.strictEqual(sandboxFindings(tempRoot).length, 1, JSON.stringify(sandboxFindings(tempRoot)));

    // c) The multi-statement line alone (no CLI) stays clean — the statement
    // splitter must not read the trailing `smoke` token as an assignment value.
    const statementsOnly = planOf([
      '```bash',
      'SANDBOX="$HOME/.cache/agyloop"; mkdir -p "$SANDBOX"; WS="$(mktemp -d "$SANDBOX/smoke-284-XXXXXX")"',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(statementsOnly), []);
  });

  test('SP21: a bare mktemp -d + HOME override stays flagged (#362 F2(e), accepted limitation)', () => {
    // §2.3.3 / I3.3 deliberately flag a bare `mktemp -d` in a CLI check. Honoring
    // a per-command `HOME="$home"` override would need execution awareness the
    // value object does not have (it is I/O-free), so this stays a finding.
    const markdown = planOf([
      '```bash',
      'home="$(mktemp -d)"',
      'HOME="$home" node bin/codeloop.js review --issue 349',
      '```'
    ]);

    assert.strictEqual(sandboxFindings(markdown).length, 1, JSON.stringify(sandboxFindings(markdown)));
  });

  test(
    'SP22: archived plans keep their frozen heading line and check count (#362 AC1.3/AC2.4)',
    { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'artifacts', 'plans')) },
    () => {
      const archive = path.join(__dirname, '..', '..', 'artifacts', 'plans');
      const expectedChecks: Record<string, number> = {
        '242': 6,
        '248': 2,
        '283': 1,
        '284': 12,
        '297': 7,
        '298': 4,
        '301': 9,
        '306': 5,
        '311': 4,
        '313': 5,
        '314': 5,
        '315': 15,
        '320': 4,
        '327': 5,
        '328': 3,
        '336': 9,
        '337': 6,
        '338': 4,
        '339': 13,
        '349': 7,
        '351': 4,
        '352': 3,
        '356': 5,
        '359': 3
      };
      const expectedSandbox: Record<string, number> = {
        '284': 0,
        '328': 3,
        '349': 4,
        '352': 2,
        '359': 0
      };

      let scanned = 0;
      for (const entry of fs.readdirSync(archive)) {
        const planPath = path.join(archive, entry, 'implementation_plan.md');
        if (!fs.existsSync(planPath)) continue;
        scanned++;

        const protocol = SmokeProtocol.fromPlan(fs.readFileSync(planPath, 'utf8'));
        assert.notStrictEqual(
          protocol.headingLine,
          1,
          `${entry}: the document H1 is scoped as the section`
        );

        const issue = entry.split('-')[0];
        if (Object.prototype.hasOwnProperty.call(expectedChecks, issue)) {
          assert.strictEqual(
            protocol.checks.length,
            expectedChecks[issue],
            `${entry}: frozen check count`
          );
        }
        if (Object.prototype.hasOwnProperty.call(expectedSandbox, issue)) {
          const count = protocol.findings.filter((finding: any) => finding.rule === 'sandbox-path').length;
          assert.strictEqual(count, expectedSandbox[issue], `${entry}: sandbox findings`);
        }
      }

      assert.ok(scanned > 0, 'the archive exists but no plan was scanned');
    }
  );
});
