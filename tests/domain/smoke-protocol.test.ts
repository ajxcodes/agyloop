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
 * SP22 - the COMMITTED corpus keeps its frozen shape (#362 AC1.3/AC2.4, #364 AC-9/10/11)
 * SP23 - a tracked cd into the sandbox makes a relative mkdir clean (#364 6a)
 * SP24 - a relative mktemp under the sandbox root is clean (#364 6b)
 * SP25 - a ..-escaped path is refused; one that normalises back inside is not (#364 6c)
 * SP26 - an unanchored relative path stays flagged; the cwd map is per check (#364)
 * SP27 - cwd tracking cannot launder a temp root (#364)
 * SP28 - the cwd judged is the one BEFORE the creating statement (#364 review)
 * SP34 - the D1 fixture is refused by name at the marker's plan line (#413)
 * SP35 - the corrected #410 fixture stays clean (#413 AC-2)
 * SP36 - a build-only fixture is not normalised, so it stays clean (#413 AC-2)
 * SP37 - a check asserting the RECORDED status is a legitimate normalisation test
 * SP38 - the worktree rule is armed by the assertion, not the directory (#413)
 * SP39 - the marker rule mirrors parseBlock, allowing earlier markers (#413)
 *        and ignoring a marker, marker producer or refusal assertion named
 *        only in a comment, or split across a shell line continuation
 * SP40 - the three committed impossible fixtures each fire exactly once (#413)
 * SP41 - the corpus canaries carry zero fixture-consistency findings (#413)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SmokeProtocol,
  SMOKE_RULE_GATE_REPORT_FIXTURE_CONTRADICTION,
  SMOKE_RULE_GATE_REPORT_MARKER_MISSING,
  SMOKE_RULE_WORKTREE_FIXTURE_UNMATCHED
} = require('../../dist/domain');

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

  // -------------------------------------------------------------------------
  // Issue #364: the corpus is COMMITTED (artifacts/plans is gitignored, so the
  // old environmental SKIP made this pin dead on every fresh clone, including
  // CI). Missing/empty corpus now fails loudly instead of skipping.
  // -------------------------------------------------------------------------

  const CORPUS_DIR = path.join(__dirname, '..', 'fixtures', 'plan-smoke-corpus');

  interface CorpusEntry {
    readonly issue: string;
    readonly file: string;
    readonly headingLine: number;
    readonly checks: number;
    readonly sandboxFindings: number;
    readonly missingParentFindings: number;
  }

  /** Reads + validates the committed corpus; throws loudly when it is absent. */
  function readCorpus(dir: string): { readonly entries: CorpusEntry[] } {
    const manifestPath = path.join(dir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), `corpus missing: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entries: CorpusEntry[] = Array.isArray(manifest.entries) ? manifest.entries : [];
    assert.ok(entries.length > 0, `corpus empty: ${manifestPath} declares no entries`);
    for (const entry of entries) {
      assert.ok(
        fs.existsSync(path.join(dir, entry.file)),
        `corpus entry missing: ${entry.file}`
      );
    }
    return { entries };
  }

  const sandboxCount = (markdown: string): number =>
    SmokeProtocol.fromPlan(markdown).findings.filter(
      (finding: any) => finding.rule === 'sandbox-path'
    ).length;

  const missingParentCount = (markdown: string): number =>
    SmokeProtocol.fromPlan(markdown).findings.filter(
      (finding: any) => finding.rule === 'missing-parent-directory'
    ).length;

  const FIXTURE_RULES = new Set([
    SMOKE_RULE_GATE_REPORT_FIXTURE_CONTRADICTION,
    SMOKE_RULE_WORKTREE_FIXTURE_UNMATCHED,
    SMOKE_RULE_GATE_REPORT_MARKER_MISSING
  ]);

  const fixtureCount = (markdown: string): number =>
    SmokeProtocol.fromPlan(markdown).findings.filter((finding: any) =>
      FIXTURE_RULES.has(finding.rule)
    ).length;

  test('SP22: the committed corpus keeps its frozen shape (#364 AC-9/AC-11, #388, #413)', () => {
    const { entries } = readCorpus(CORPUS_DIR);
    assert.ok(entries.length >= 25, `corpus has only ${entries.length} entries`);

    let scanned = 0;
    for (const entry of entries) {
      const markdown = fs.readFileSync(path.join(CORPUS_DIR, entry.file), 'utf8');
      const protocol = SmokeProtocol.fromPlan(markdown);
      scanned++;

      assert.ok(
        protocol.headingLine >= 2,
        `${entry.file}: the document H1 is scoped as the section`
      );
      assert.strictEqual(protocol.headingLine, entry.headingLine, `${entry.file}: frozen heading line`);
      assert.strictEqual(protocol.checks.length, entry.checks, `${entry.file}: frozen check count`);
      assert.strictEqual(
        sandboxCount(markdown),
        entry.sandboxFindings,
        `${entry.file}: frozen sandbox-path count`
      );
      assert.strictEqual(
        missingParentCount(markdown),
        entry.missingParentFindings,
        `${entry.file}: frozen missing-parent-directory count`
      );
      assert.strictEqual(
        fixtureCount(markdown),
        0,
        `${entry.file}: fixture-consistency findings (#413)`
      );
    }

    // The assertion that was dead behind the old environmental SKIP (AC-11).
    assert.strictEqual(scanned, entries.length, 'every corpus entry was scanned');
  });

  test('SP22b: a level-1 heading rule mutation would break every corpus entry (#364 AC-10)', () => {
    // The corpus H1s either carry the section phrase already (#359) or gain it
    // here. Removing the `level > 1` guard makes the H1 itself the section, so
    // headingLine collapses to 1 and the section never closes — every one of
    // these assertions then differs. That is the deliberate-mutation proof.
    const { entries } = readCorpus(CORPUS_DIR);
    for (const entry of entries) {
      const lines = fs.readFileSync(path.join(CORPUS_DIR, entry.file), 'utf8').split('\n');
      lines[0] = `${lines[0]} — Manual Smoke Test Protocol`;
      const mutated = SmokeProtocol.fromPlan(lines.join('\n'));
      assert.strictEqual(mutated.headingLine, entry.headingLine, `${entry.file}: mutated heading line`);
      assert.strictEqual(mutated.checks.length, entry.checks, `${entry.file}: mutated check count`);
    }
  });

  test('SP22c: a missing or empty corpus fails loudly (#364 AC-11)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-empty-corpus-'));
    try {
      assert.throws(() => readCorpus(empty), /corpus .*(missing|empty)/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Issue #364: the sandbox-path rule tracks `cd` per check.
  // -------------------------------------------------------------------------

  test('SP23: a tracked cd into the sandbox makes a relative mkdir clean (#364 6a)', () => {
    const withCd = planOf([
      '```bash',
      'SANDBOX="$HOME/.cache/agyloop/smoke-354/implement-pause"',
      'cd "$SANDBOX"',
      'mkdir -p artifacts/plans/354-smoke .agyloop/tasks',
      'env -u AGY_SUBAGENT node bin/codeloop.js implement --issue 354',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(withCd), []);
    assert.strictEqual(SmokeProtocol.fromPlan(withCd).executable, true);

    // The same block WITHOUT the cd is the unanchored shape SP15 pins.
    const withoutCd = planOf([
      '```bash',
      'SANDBOX="$HOME/.cache/agyloop/smoke-354/implement-pause"',
      'mkdir -p artifacts/plans/354-smoke .agyloop/tasks',
      'env -u AGY_SUBAGENT node bin/codeloop.js implement --issue 354',
      '```'
    ]);
    assert.strictEqual(
      sandboxFindings(withoutCd).length,
      1,
      JSON.stringify(sandboxFindings(withoutCd))
    );
  });

  test('SP24: a relative mktemp under the sandbox root is clean (#364 6b)', () => {
    const relative = planOf([
      '```bash',
      'cd "$HOME/.cache/agyloop"',
      'SBX="$(mktemp -d smoke-354-XXXXXX)"',
      'node bin/codeloop.js transition --issue 354',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(relative), []);

    // The absolute form is unchanged.
    const absolute = planOf([
      '```bash',
      'SBX="$(mktemp -d "$HOME/.cache/agyloop/smoke-354-XXXXXX")"',
      'node bin/codeloop.js transition --issue 354',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(absolute), []);

    // A relative template nested under an explicit sandbox cd.
    const nested = planOf([
      '```bash',
      'SANDBOX="$HOME/.cache/agyloop/smoke-354"',
      'cd "$SANDBOX"',
      'SBX="$(mktemp -d repo-XXXXXX)"',
      'node bin/codeloop.js transition --issue 354',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(nested), []);
  });

  test('SP25: a ..-escaped path is refused (#364 6c)', () => {
    const escaped = planOf([
      '```bash',
      'SBX="$HOME/.cache/agyloop/smoke-362/../../../tmp/evil"',
      'node bin/codeloop.js transition --issue 362',
      '```'
    ]);
    assert.strictEqual(
      sandboxFindings(escaped).length,
      1,
      JSON.stringify(sandboxFindings(escaped))
    );

    // A `..` that normalises back INSIDE the sandbox matches the runtime guard.
    const inside = planOf([
      '```bash',
      'SBX="$HOME/.cache/agyloop/smoke-362/../smoke-362/x"',
      'node bin/codeloop.js transition --issue 362',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(inside), []);
  });

  test('SP26: an unanchored relative path stays flagged (#359 SP15 preserved)', () => {
    const bare = planOf([
      '```bash',
      'mkdir -p artifacts/smoke359',
      'node bin/codeloop.js status --issue 359',
      '```'
    ]);
    assert.strictEqual(sandboxFindings(bare).length, 1);

    const otherCd = planOf([
      '```bash',
      'cd "$HOME/other"',
      'mkdir -p artifacts/plans/364-smoke',
      'node bin/codeloop.js status --issue 364',
      '```'
    ]);
    assert.strictEqual(sandboxFindings(otherCd).length, 1);

    // The cwd map is per CHECK: check 1's sandbox cd cannot launder check 2.
    const twoChecks = [
      '# Plan',
      '',
      SMOKE_HEADING,
      '',
      '#### Check 1 — sandboxed',
      '',
      '```bash',
      'cd "$HOME/.cache/agyloop/smoke-364"',
      'mkdir -p artifacts/plans/364-smoke',
      'node bin/codeloop.js status --issue 364',
      '```',
      '',
      '#### Check 2 — unanchored',
      '',
      '```bash',
      'mkdir -p artifacts/smoke359',
      'node bin/codeloop.js status --issue 359',
      '```',
      ''
    ].join('\n');
    const findings = sandboxFindings(twoChecks);
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].checkIndex, 2, JSON.stringify(findings[0]));
  });

  test('SP27: cwd tracking cannot launder a temp root', () => {
    const absoluteTmp = planOf([
      '```bash',
      'cd "$HOME/.cache/agyloop/smoke-364"',
      'mkdir -p /tmp/evil',
      'node bin/codeloop.js status --issue 364',
      '```'
    ]);
    assert.strictEqual(sandboxFindings(absoluteTmp).length, 1);

    const tmpdir = planOf([
      '```bash',
      'cd "$HOME/.cache/agyloop"',
      'mkdir -p "$TMPDIR/smoke-x"',
      'node bin/codeloop.js status --issue 364',
      '```'
    ]);
    assert.strictEqual(sandboxFindings(tmpdir).length, 1);
  });

  test('SP28: the cwd in force is the one BEFORE the creating statement (#364 review)', () => {
    // A `cd` that FOLLOWS the mkdir cannot launder it: on one line the mkdir
    // really ran in the old cwd, so the relative path is unanchored.
    for (const separator of ['&&', ';']) {
      const trailingCd = planOf([
        '```bash',
        'SBX="$HOME/.cache/agyloop/smoke-364"',
        `mkdir -p artifacts/smoke364 ${separator} cd "$SBX"`,
        'node bin/codeloop.js status --issue 364',
        '```'
      ]);
      const findings = sandboxFindings(trailingCd);
      assert.strictEqual(findings.length, 1, `${separator}: ${JSON.stringify(findings)}`);
      assert.match(findings[0].excerpt, /artifacts\/smoke364/);
    }

    // The forward order is the shape AC-1 blesses: the cd is in force first.
    const leadingCd = planOf([
      '```bash',
      'SBX="$HOME/.cache/agyloop/smoke-364"',
      'cd "$SBX" && mkdir -p artifacts/plans/364-smoke',
      'node bin/codeloop.js status --issue 364',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(leadingCd), []);

    // An ABSOLUTE sandbox path is clean in either order — nothing depends on
    // the cwd, so the statement index is irrelevant.
    const absoluteThenCd = planOf([
      '```bash',
      'SBX="$HOME/.cache/agyloop/smoke-364"',
      'mkdir -p "$SBX/reports" && cd "$SBX"',
      'node bin/codeloop.js status --issue 364',
      '```'
    ]);
    assert.deepStrictEqual(sandboxFindings(absoluteThenCd), []);
  });

  // -------------------------------------------------------------------------
  // Issue #388: a write must create its parent directory first.
  // -------------------------------------------------------------------------

  const parentFindings = (markdown: string): any[] =>
    SmokeProtocol.fromPlan(markdown).findings.filter(
      (finding: any) => finding.rule === 'missing-parent-directory'
    );

  test('SP29: the #382 Smoke 6/7 checkpoint seed is refused at its write line (#388 D2)', () => {
    const seed = planOf([
      '```bash',
      'node -e \'const fs=require("fs");fs.writeFileSync(".agyloop/tasks/382.json", "{}")\'',
      '```'
    ]);

    const findings = parentFindings(seed);
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].checkIndex, 1);
    assert.ok(findings[0].line > 0);
    assert.ok(findings[0].excerpt.includes('.agyloop/tasks'), findings[0].excerpt);
    assert.strictEqual(SmokeProtocol.fromPlan(seed).executable, false);
  });

  test('SP30: one mkdir line makes the same seed executable (#388 D2)', () => {
    const fixed = planOf([
      '```bash',
      'mkdir -p .agyloop/tasks',
      'node -e \'const fs=require("fs");fs.writeFileSync(".agyloop/tasks/382.json", "{}")\'',
      '```'
    ]);
    assert.deepStrictEqual(parentFindings(fixed), []);
    assert.strictEqual(SmokeProtocol.fromPlan(fixed).executable, true);

    // A seed under a tracked cd resolves against the same cwd.
    const tracked = planOf([
      '```bash',
      'SBX="$HOME/.cache/agyloop/smoke-388/seed"',
      'mkdir -p "$SBX/.agyloop/tasks"',
      'cd "$SBX"',
      'node -e \'require("fs").writeFileSync(".agyloop/tasks/388.json", "{}")\'',
      '```'
    ]);
    assert.deepStrictEqual(parentFindings(tracked), []);
  });

  test('SP31: generic write shapes are classified (#388 D2 AC1)', () => {
    const redirect = planOf(['```bash', 'printf x > artifacts/out.json', '```']);
    assert.strictEqual(parentFindings(redirect).length, 1);

    const redirectFixed = planOf([
      '```bash',
      'mkdir -p artifacts',
      'printf x > artifacts/out.json',
      '```'
    ]);
    assert.deepStrictEqual(parentFindings(redirectFixed), []);

    // A file in the current directory needs no directory.
    const noDirectory = planOf(['```bash', 'printf x > out.json', '```']);
    assert.deepStrictEqual(parentFindings(noDirectory), []);

    // A `..`-escaped parent is not covered by the mkdir below it.
    const escaped = planOf([
      '```bash',
      'SBX="$HOME/.cache/agyloop/smoke-388/escape"',
      'mkdir -p "$SBX/artifacts"',
      'printf x > "$SBX/artifacts/../../escaped/out.json"',
      '```'
    ]);
    assert.strictEqual(parentFindings(escaped).length, 1, JSON.stringify(parentFindings(escaped)));
  });

  test('SP32: always-present roots are exempt and unresolved variables are skipped (#388 D2 AC1)', () => {
    const tmp = planOf(['```bash', 'printf x > /tmp/out.log', '```']);
    assert.deepStrictEqual(parentFindings(tmp), []);

    const smokeRoot = planOf([
      '```bash',
      'printf x > "$HOME/.cache/agyloop/out.log"',
      '```'
    ]);
    assert.deepStrictEqual(parentFindings(smokeRoot), []);

    // `/tmp/sub/out` is NOT exempt: `sub` must be created.
    const tmpSub = planOf(['```bash', 'printf x > /tmp/sub-388/out.log', '```']);
    assert.strictEqual(parentFindings(tmpSub).length, 1);

    // A variable the rule cannot resolve is skipped, never guessed.
    const unresolved = planOf(['```bash', 'printf x > "$n-388/out.json"', '```']);
    assert.deepStrictEqual(parentFindings(unresolved), []);

    // `tee` writes a file too.
    const tee = planOf(['```bash', 'printf x | tee artifacts/out.json', '```']);
    assert.strictEqual(parentFindings(tee).length, 1);
  });

  test('SP32b: a dynamic node path is not guessed (#388 limitation)', () => {
    const dynamic = planOf([
      '```bash',
      'node -e \'require("fs").writeFileSync(require("path").join("a", "b.json"), "{}")\'',
      '```'
    ]);
    assert.deepStrictEqual(parentFindings(dynamic), []);
  });

  test('SP32c: heredoc data is never scanned for writes (#388 D2 AC1)', () => {
    const seededScript = planOf([
      "```bash",
      "node - <<'NODE'",
      'const fs = require("node:fs");',
      'const plan = \'node -e \\\'require("fs").writeFileSync(".agyloop/tasks/x.json", "{}")\\\'\';',
      'console.log(plan);',
      'NODE',
      '```'
    ]);
    assert.deepStrictEqual(parentFindings(seededScript), []);

    const seededCat = planOf([
      '```bash',
      "cat > plan.md <<'PLAN'",
      'node -e \'require("fs").writeFileSync(".agyloop/tasks/x.json", "{}")\'',
      'PLAN',
      '```'
    ]);
    assert.deepStrictEqual(parentFindings(seededCat), []);
  });

  test('SP32d: a multi-line quoted node script is shell data, not shell writes (#388)', () => {
    const multiline = planOf([
      '```bash',
      "node -e '",
      'const strip = (p) => String(p).replace(/^\\.\\//, "");',
      'const start = (line) => /^jobs:\\s*$/.test(line);',
      "console.log(strip('x'), start('jobs:'));",
      "'",
      '```'
    ]);
    assert.deepStrictEqual(parentFindings(multiline), []);
  });

  test('SP33: the #382 corpus entry freezes the two seed findings (#388 D2 AC2)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(CORPUS_DIR, 'manifest.json'), 'utf8')
    );
    const entry = (manifest.entries as CorpusEntry[]).find((candidate) => candidate.file === '382.md');
    if (!entry) {
      throw new Error('the #382 corpus entry is committed');
    }
    assert.strictEqual(entry.checks, 9);
    assert.strictEqual(entry.missingParentFindings, 2);

    const markdown = fs.readFileSync(path.join(CORPUS_DIR, '382.md'), 'utf8');
    const findings = parentFindings(markdown);
    assert.deepStrictEqual(
      findings.map((finding) => finding.checkIndex),
      [6, 7],
      JSON.stringify(findings)
    );
  });

  // -------------------------------------------------------------------------
  // Issue #413: fixture-consistency rules. A check whose OWN fixture makes its
  // assertion impossible must be refused before the plan digest is pinned.
  // -------------------------------------------------------------------------

  const SMOKE_413_DIR = path.join(__dirname, '..', 'fixtures', 'smoke-413');

  const smoke413 = (file: string): string =>
    `${SMOKE_HEADING}\n\n${fs.readFileSync(path.join(SMOKE_413_DIR, file), 'utf8')}`;

  const fixtureFindings = (markdown: string): any[] =>
    SmokeProtocol.fromPlan(markdown).findings.filter((finding: any) =>
      FIXTURE_RULES.has(finding.rule)
    );

  const objectLiteral = (report: Record<string, unknown>): string =>
    `{ ${Object.entries(report)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')} }`;

  const reportFixture = (
    report: Record<string, unknown>,
    assertionStatus: string
  ): string =>
    planOf([
      '```bash',
      `node -e 'require("fs").writeFileSync(process.argv[1], "GATE_REPORT_JSON: " + JSON.stringify(${objectLiteral(report)}))' gate.json`,
      `node -e 'const d=require("./dist/domain");const r=d.GateResultReport.parseBlock(require("fs").readFileSync("gate.json","utf8"));if(d.normaliseGateTests(r).testsStatus!==${JSON.stringify(assertionStatus)})process.exit(1)'`,
      '```'
    ]);

  const D1_REPORT = {
    verdict: 'PASSED',
    buildSystem: 'npm',
    buildStatus: 'PASSED',
    testsStatus: 'PASSED (1 passed)',
    testsPassed: 1,
    executedCommands: ['npm test'],
    commandResults: [{ command: 'npm test', passed: 0, failed: 0 }]
  };

  test('SP34: the D1 fixture is refused by name at its marker line (#413 AC-1)', () => {
    assert.strictEqual(
      SMOKE_RULE_GATE_REPORT_FIXTURE_CONTRADICTION,
      'gate-report-fixture-contradiction'
    );
    assert.strictEqual(SMOKE_RULE_WORKTREE_FIXTURE_UNMATCHED, 'worktree-fixture-unmatched');
    assert.strictEqual(SMOKE_RULE_GATE_REPORT_MARKER_MISSING, 'gate-report-marker-missing');

    const markdown = smoke413('impossible-gate-tests.checks.md');
    const protocol = SmokeProtocol.fromPlan(markdown);
    const findings = fixtureFindings(markdown);

    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].rule, SMOKE_RULE_GATE_REPORT_FIXTURE_CONTRADICTION);
    assert.strictEqual(findings[0].checkIndex, 1);
    assert.ok(findings[0].label.includes('Check 1'), findings[0].label);
    assert.strictEqual(protocol.executable, false);
    const markerLine =
      markdown.split('\n').findIndex((line) => line.includes('GATE_REPORT_JSON:')) + 1;
    assert.strictEqual(findings[0].line, markerLine);
    assert.ok(findings[0].excerpt.includes('PASSED (1 passed)'), findings[0].excerpt);
    assert.ok(findings[0].excerpt.includes('PASSED (0 passed)'), findings[0].excerpt);
  });

  test('SP35: the corrected #410 fixture stays clean (#413 AC-2)', () => {
    const markdown = smoke413('corrected.checks.md');
    assert.deepStrictEqual(fixtureFindings(markdown), []);
    assert.strictEqual(SmokeProtocol.fromPlan(markdown).executable, true);
  });

  test('SP36: a build-only fixture is not normalised, so it stays clean (#413 AC-2)', () => {
    const buildOnly = reportFixture(
      {
        verdict: 'PASSED',
        buildSystem: 'npm',
        buildStatus: 'PASSED',
        testsStatus: 'PASSED (1 passed)',
        testsPassed: 1,
        executedCommands: ['npm run build'],
        commandResults: [{ command: 'npm run build', passed: 0, failed: 0 }]
      },
      'PASSED (1 passed)'
    );
    assert.deepStrictEqual(fixtureFindings(buildOnly), []);
  });

  test('SP37: a check asserting the RECORDED status is a legitimate test (#413 AC-2)', () => {
    const deliberate = reportFixture(D1_REPORT, 'PASSED (0 passed)');
    assert.deepStrictEqual(fixtureFindings(deliberate), []);
  });

  const worktreeCheck = (directory: string, assertMismatch: boolean): string =>
    planOf([
      '```bash',
      `mkdir -p "$SBX/${directory}"`,
      assertMismatch
        ? `( cd "$SBX/${directory}" && node bin/codeloop.js transition REVIEW --issue 413 2>&1 | grep -q 'Cannot save state for issue 413 from inside worktree for issue 999' )`
        : 'echo orphan-cleanup',
      '```'
    ]);

  test('SP38a: an unmatched worktree fixture is refused once, at its line (#413 AC-3)', () => {
    const findings = fixtureFindings(worktreeCheck('.worktrees/999-probe', true));
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].rule, SMOKE_RULE_WORKTREE_FIXTURE_UNMATCHED);
    assert.strictEqual(findings[0].checkIndex, 1);
    assert.ok(findings[0].excerpt.includes('.worktrees/999-probe'), findings[0].excerpt);
  });

  test('SP38b: the correct .worktrees/<n>/ fixture stays clean (#413 AC-3)', () => {
    assert.deepStrictEqual(fixtureFindings(worktreeCheck('.worktrees/999/probe', true)), []);
  });

  test('SP38c: the 248.md S8 orphan fixture is not armed without the assertion (#413 AC-3)', () => {
    assert.deepStrictEqual(fixtureFindings(worktreeCheck('.worktrees/4242-orphan', false)), []);

    // Review round 2: prose that documents the guard beside a legitimate orphan
    // fixture must not arm Rule B either — the assertion must be a real line.
    const documented = planOf([
      '```bash',
      '# Cannot save state for issue 413 from inside worktree for issue 999',
      '// Cannot save state for issue 413 from inside worktree for issue 999',
      'mkdir -p "$SBX/.worktrees/4242-orphan"',
      'echo orphan-cleanup',
      '```'
    ]);
    assert.deepStrictEqual(fixtureFindings(documented), []);
  });

  const gateReportInvocation = (reportFile = 'gate.json'): string =>
    `node bin/codeloop.js gate-report --issue 413 --report-file ${reportFile}`;

  test('SP39a: a markerless --report-file fixture is refused at its line (#413 AC-4)', () => {
    const markdown = planOf(['```bash', gateReportInvocation(), '```']);
    const findings = fixtureFindings(markdown);
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].rule, SMOKE_RULE_GATE_REPORT_MARKER_MISSING);
    const invocationLine =
      markdown.split('\n').findIndex((line) => line.includes('gate-report')) + 1;
    assert.strictEqual(findings[0].line, invocationLine);
  });

  test('SP39b: a marker-bearing heredoc fixture stays clean (#413 AC-4)', () => {
    const markdown = planOf([
      '```bash',
      "cat > gate.json <<'JSON'",
      'GATE_REPORT_JSON:',
      '{ "verdict": "PASSED" }',
      'JSON',
      gateReportInvocation(),
      '```'
    ]);
    assert.deepStrictEqual(fixtureFindings(markdown), []);
  });

  test('SP39c: formatGateReportExample is a marker producer (#413 AC-4)', () => {
    const markdown = planOf([
      '```bash',
      'node -e \'require("fs").writeFileSync("gate.json", require("./dist/domain").formatGateReportExample("PASSED"))\'',
      gateReportInvocation(),
      '```'
    ]);
    assert.deepStrictEqual(fixtureFindings(markdown), []);
  });

  test('SP39d: a deliberate missing-marker refusal check stays clean (#413 AC-4)', () => {
    const markdown = planOf([
      '```bash',
      `${gateReportInvocation()} 2>&1 | grep -q 'missing GATE_REPORT_JSON'`,
      '```'
    ]);
    assert.deepStrictEqual(fixtureFindings(markdown), []);
  });

  test('SP39e: a marker seeded by an earlier check carries forward (#413 AC-4)', () => {
    const markdown = planOf([
      '#### Check 1 — seed the report',
      '```bash',
      "cat > gate.json <<'JSON'",
      'GATE_REPORT_JSON:',
      '{ "verdict": "PASSED" }',
      'JSON',
      '```',
      '',
      '#### Check 2 — file the report',
      '```bash',
      gateReportInvocation(),
      '```'
    ]);
    assert.deepStrictEqual(fixtureFindings(markdown), []);
  });

  test('SP39f: a marker named only in a comment does not satisfy the rule (#413 AC-4)', () => {
    const markdown = planOf([
      '```bash',
      '# The report must carry a GATE_REPORT_JSON: marker.',
      '// GATE_REPORT_JSON: is required by parseBlock.',
      gateReportInvocation(),
      '```'
    ]);
    const findings = fixtureFindings(markdown);
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].rule, SMOKE_RULE_GATE_REPORT_MARKER_MISSING);
    const invocationLine =
      markdown.split('\n').findIndex((line) => line.includes('gate-report')) + 1;
    assert.strictEqual(findings[0].line, invocationLine);
  });

  test('SP39g: a gate-report invocation split across a continuation is refused (#413 AC-4)', () => {
    const markerless = planOf([
      '```bash',
      'node bin/codeloop.js gate-report \\',
      '  --issue 413 --workspace "$SBX/ws" --report-file "$SBX/ws/gate.json"',
      '```'
    ]);
    const findings = fixtureFindings(markerless);
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].rule, SMOKE_RULE_GATE_REPORT_MARKER_MISSING);
    const invocationLine =
      markerless.split('\n').findIndex((line) => line.includes('gate-report')) + 1;
    assert.strictEqual(findings[0].line, invocationLine);

    const marked = planOf([
      '```bash',
      "cat > gate.json <<'JSON'",
      'GATE_REPORT_JSON:',
      '{ "verdict": "PASSED" }',
      'JSON',
      'node bin/codeloop.js gate-report \\',
      '  --issue 413 --report-file gate.json',
      '```'
    ]);
    assert.deepStrictEqual(fixtureFindings(marked), []);
  });

  test('SP39h: a refusal named only in a comment does not exempt a markerless fixture (#413 AC-4)', () => {
    const markdown = planOf([
      '```bash',
      '# parseBlock refuses a markerless report with missing GATE_REPORT_JSON: block',
      '// missing GATE_REPORT_JSON is the refusal this check expects',
      gateReportInvocation(),
      '```'
    ]);
    const protocol = SmokeProtocol.fromPlan(markdown);
    const findings = fixtureFindings(markdown);
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].rule, SMOKE_RULE_GATE_REPORT_MARKER_MISSING);
    assert.strictEqual(protocol.executable, false);
  });

  test('SP39i: a marker producer named only in a comment does not satisfy the rule (#413 AC-4)', () => {
    const markdown = planOf([
      '```bash',
      '# formatGateReportExample is the tool producer',
      '// formatGateReportExample writes the marker',
      gateReportInvocation(),
      '```'
    ]);
    const findings = fixtureFindings(markdown);
    assert.strictEqual(findings.length, 1, JSON.stringify(findings));
    assert.strictEqual(findings[0].rule, SMOKE_RULE_GATE_REPORT_MARKER_MISSING);
  });

  test('SP40: the three committed impossible fixtures each fire exactly once (#413 AC-1)', () => {
    const files = [
      'impossible-gate-tests.checks.md',
      'impossible-worktree.checks.md',
      'impossible-marker.checks.md'
    ];
    const fired = new Set<string>();
    for (const file of files) {
      const protocol = SmokeProtocol.fromPlan(smoke413(file));
      assert.strictEqual(protocol.executable, false, file);
      assert.strictEqual(protocol.findings.length, 1, `${file}: ${JSON.stringify(protocol.findings)}`);
      fired.add(protocol.findings[0].rule);
    }
    assert.deepStrictEqual([...fired].sort(), [...FIXTURE_RULES].sort());

    // D3, D2, D1 in that order: a marker in an earlier check legitimately
    // disarms Rule C, so the markerless check must come first.
    const combined = [
      SMOKE_HEADING,
      '',
      fs.readFileSync(path.join(SMOKE_413_DIR, 'impossible-marker.checks.md'), 'utf8'),
      fs.readFileSync(path.join(SMOKE_413_DIR, 'impossible-worktree.checks.md'), 'utf8'),
      fs.readFileSync(path.join(SMOKE_413_DIR, 'impossible-gate-tests.checks.md'), 'utf8')
    ].join('\n');
    const combinedFindings = fixtureFindings(combined);
    assert.deepStrictEqual(
      combinedFindings.map((finding) => finding.rule).sort(),
      [...FIXTURE_RULES].sort(),
      JSON.stringify(combinedFindings)
    );
  });

  test('SP41: the corpus canaries carry zero fixture findings (#413 AC-6)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(CORPUS_DIR, 'manifest.json'), 'utf8')
    );
    assert.ok(manifest.entries.length >= 25, `corpus has only ${manifest.entries.length} entries`);

    const canaries = ['248.md', '284.md', '311.md', '327.md', '337.md', '338.md'];
    const scanned = new Set<string>();
    for (const entry of manifest.entries as CorpusEntry[]) {
      const markdown = fs.readFileSync(path.join(CORPUS_DIR, entry.file), 'utf8');
      assert.strictEqual(
        fixtureCount(markdown),
        0,
        `${entry.file}: ${JSON.stringify(fixtureFindings(markdown))}`
      );
      scanned.add(entry.file);
    }
    assert.strictEqual(scanned.size, manifest.entries.length);
    for (const canary of canaries) {
      assert.ok(scanned.has(canary), `canary missing from the corpus: ${canary}`);
    }
  });
});
