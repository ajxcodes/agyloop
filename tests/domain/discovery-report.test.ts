/**
 * agyloop - DiscoveryReport value object tests (issue #237)
 *
 * The DISCOVERY park (Defect 1) needs CONTENT evidence that an RCA actually
 * ran, because existence is not evidence: the plan generator always writes the
 * plan file when it scaffolds a fresh directory, so a pristine scaffold still
 * "has a discovery file". These tests pin the template-agnostic predicate that
 * tells the two apart.
 *
 * The predicate is deliberately built from `- **Key:**` bullet shapes rather
 * than named sections, so it survives the repository drifting
 * `templates/discovery-plan.md`. The template-drift guard below re-reads the
 * on-disk template and asserts it is still detected as unpopulated.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DiscoveryReport,
  DISCOVERY_REPORT_MIN_CHARS,
  DISCOVERY_REPORT_MIN_FILLED_KEYS,
  DISCOVERY_REPORT_MAX_UNFILLED_KEYS,
  DISCOVERY_REPORT_MIN_CONTENT_UNITS,
  DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS,
  DISCOVERY_REPORT_MIN_CONTENT_CHARS,
  DISCOVERY_REPORT_MIN_PROSE_SECTIONS,
  formatDiscoveryMissingEvidence
} = require('../../dist/domain');

const TEMPLATE_PATH = path.resolve(__dirname, '../../templates/discovery-plan.md');

/**
 * The two on-disk shapes a discovery subagent produces: the scaffolded
 * `[Discovery] - <title>.md` and the directly-written `discovery_plan.md`.
 */
const DISCOVERY_REPORT_FILE = /^(\[Discovery\].*|discovery[-_]plan)\.md$/;

/**
 * A real discovery report from this repository's own `artifacts/plans`
 * (`169-phase-5-bug-…/[Discovery] - ….md`), trimmed to the two shapes that
 * matter. Why this fixture exists: the synthetic `populatedReport()` above was
 * the ONLY shape the original predicate accepted, which is exactly why the
 * 80% false-negative defect was invisible to its own test suite. Every bold
 * key below writes its value the way planning subagents actually write them —
 * `Relevant Code References` and `Affected Components / Paths` as an indented
 * sub-list, `Investigation Steps` as an indented numbering list — and the
 * document quotes the empty template inside a fence while explaining what it
 * replaced.
 */
const NESTED_SHAPE_REPORT = `# [Discovery] - [Phase 5] [Bug] agyloop: Feature issues bypass Planner Subagent

**Issue:** #169
**Date:** 2026-10-02
**Author:** AgyLoop Planning Subagent (Read-Only)

---

## 1. Problem Statement & Symptoms
- **Observed Behavior:** When processing a "Feature" issue, agyloop skips STAGE_DISCOVERY and advances directly to STAGE_PLAN, pausing at APPROVAL without ever invoking the planner.
- **Expected Behavior:** Even for Feature tasks, the ROLE_PLANNER subagent should be invoked before pausing for human approval.
- **Affected Components / Paths:**
  - \`src/application/start-planning.ts\` (lines ~194-196): Fast-forwards non-bug issues to STAGE_PLAN.
  - \`src/application/get-next-action.ts\` (lines ~210-264): Invokes ROLE_PLANNER ONLY during STAGE_DISCOVERY.

## 2. Root Cause Analysis (RCA)
- **Investigation Steps:**
  1. Reviewed \`src/application/start-planning.ts\` where the state machine initializes the pipeline for a new issue.
  2. Reviewed \`src/application/get-next-action.ts\` which dictates the action for each stage.
  3. Ran the pipeline to trace the logic.
- **Identified Failure Mode:** \`start-planning.ts\` fast-forwards non-bugs to STAGE_PLAN, but \`get-next-action.ts\` only invokes ROLE_PLANNER during STAGE_DISCOVERY, so the planner invocation is bypassed entirely.
- **Relevant Code References:**
  - \`src/application/start-planning.ts\` (lines ~194-196)
  - \`src/application/get-next-action.ts\` (lines ~210-264)

## 3. Reproduction Steps & Verification Protocol
- **Local Reproduction Command:**
  1. Run \`bin/agyloop plan --issue 169\`.
  2. Observe the ROLE_PLANNER subagent never being invoked.
- **Failing Test Target:** \`tests/application/get-next-action.test.ts\`

## 4. Remediation Strategy
- **Recommended Fix Approach:** Move the ROLE_PLANNER invocation into STAGE_PLAN and keep STAGE_DISCOVERY for RCA only.
- **Potential Regressions / Side Effects:** Existing tests asserting STAGE_PLAN returns a human_gate will need updating.

The scaffold this report replaced was:

\`\`\`
## 1. Problem Statement & Symptoms
- **Observed Behavior:**
- **Expected Behavior:**
- **Affected Components / Paths:**

## 2. Root Cause Analysis (RCA)
- **Investigation Steps:**
\`\`\`
`;

/** Every bold key the on-disk discovery template leaves blank. */
const TEMPLATE_PLACEHOLDER_KEYS = Object.freeze([
  'Observed Behavior',
  'Expected Behavior',
  'Affected Components / Paths',
  'Investigation Steps',
  'Identified Failure Mode',
  'Relevant Code References',
  'Local Reproduction Command',
  'Failing Test Target',
  'Recommended Fix Approach',
  'Potential Regressions / Side Effects'
] as const);

/** The untouched scaffold as `scaffoldPlanDirectory` renders it. */
function pristineScaffold(): string {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return raw
    .replace('{Title}', '[Bug] probe')
    .replace('{IssueNumber}', '237')
    .replace('{Date}', '2026-10-16');
}

/** A realistic populated report: every key bullet carries real content. */
function populatedReport(): string {
  return `# [Discovery] - [Bug] probe

**Issue:** #237  
**Date:** 2026-10-16  
**Author:** AgyLoop Planning Subagent (Read-Only)  

---

## 1. Problem Statement & Symptoms
- **Observed Behavior:** probe crash on login whenever the session cookie is absent
- **Expected Behavior:** no crash; the login form renders with an inline validation error
- **Affected Components / Paths:** src/login.ts, src/session.ts

## 2. Root Cause Analysis (RCA)
- **Investigation Steps:** read src/login.ts end to end, reproduced with a cleared cookie jar
- **Identified Failure Mode:** nil dereference of the session resolver result at src/login.ts:41
- **Relevant Code References:** src/login.ts:41, src/session.ts:12

## 3. Reproduction Steps & Verification Protocol
- **Local Reproduction Command:** npm test -- --grep "login"
- **Failing Test Target:** tests/login.test.ts

## 4. Remediation Strategy
- **Recommended Fix Approach:** guard the resolver result before dereferencing
- **Potential Regressions / Side Effects:** none; the guard only adds an early return
`;
}

/**
 * A report written the way the discovery prompt's own Expected Output
 * Structure asks for: `##` headings and substantive prose, with NO
 * `- **Key:**` bullet anywhere (issue #306's #284 shape).
 *
 * This is the fixture that fails on the pre-fix predicate: `filledKeyCount` is
 * 0, so the old bullet census scored a complete RCA as a scaffold.
 */
const HEADING_SHAPE_REPORT = `# [Discovery] - [Bug] probe: login crash without a session cookie

**Issue:** #306
**Date:** 2026-10-27
**Author:** AgyLoop Discovery Subagent (Read-Only)

## Summary & Symptoms

The login form crashes whenever the session cookie is absent. Reproduced three times in an ephemeral container against the current build with a cleared cookie jar, and once from a fresh browser profile.

## Root Cause Analysis

The session resolver returns null and src/login.ts:41 dereferences it without a guard. The form submit handler reaches that line through the cookie parser, so any request without a cookie takes the same failing path.

## Manual Bug Smoke Test

The reproduction exits 1 with a stack frame at src/login.ts:41. The same run with a seeded cookie exits 0, three times out of three.

## Remediation Strategy

Guard the resolver result before the dereference and add a regression test asserting the form renders an inline validation error instead of crashing.
`;

/**
 * The S4 skeleton: four headings with no prose under them, plus four filled
 * bullets whose values only point at the heading above (`see above`).
 *
 * This scored `isPopulated === true` before the content rule (242 chars, four
 * "filled" keys) — the AC2 false positive that adding formatting-only bullets
 * released a content-free document.
 */
const COSMETIC_BULLETS_ONLY = `## 1. Summary & Symptoms

## 2. Root Cause Analysis

## 3. Manual Bug Smoke Test

## 4. Remediation Strategy

- **Observed Behavior:** see above
- **Identified Failure Mode:** see above
- **Smoke Test:** see above
- **Remediation:** see above
`;

/**
 * The padded AC2 variant the reviewer reproduced: four content-free bullets
 * whose values are long POINTERS, each past the 20-char per-unit floor.
 *
 * These score four units and 200+ characters, so the character floors alone
 * released them. A pointer is a cross-reference, not evidence, however long it
 * is — `isPopulated` must stay false.
 */
const POINTER_PADDED_BULLETS_ONLY = `## 1. Summary & Symptoms

## 2. Root Cause Analysis

## 3. Manual Bug Smoke Test

## 4. Remediation Strategy

- **Observed Behavior:** see the Summary & Symptoms section above for details
- **Identified Failure Mode:** see the Root Cause Analysis section above for details
- **Smoke Test:** see the Manual Bug Smoke Test section above for details
- **Remediation:** see the Remediation Strategy section above for details
`;

/**
 * Four sections whose only body restates the heading as a bullet value. The
 * longest value is 21 characters, so only two of the four clear the per-unit
 * floor — below `DISCOVERY_REPORT_MIN_CONTENT_UNITS`.
 */
const RESTATED_HEADINGS_ONLY = `## 1. Summary & Symptoms
- **Summary & Symptoms:** Summary & Symptoms

## 2. Root Cause Analysis
- **Root Cause Analysis:** Root Cause Analysis

## 3. Manual Bug Smoke Test
- **Manual Bug Smoke Test:** Manual Bug Smoke Test

## 4. Remediation Strategy
- **Remediation Strategy:** Remediation Strategy
`;

/**
 * The workaround operators had to append in #298/#297/#284: six summary
 * bullets bolted onto an already-complete heading report.
 */
const SYNTHETIC_INDEX = [
  '- **Observed Behavior:** login crashes when the session cookie is absent',
  '- **Expected Behavior:** the login form renders an inline validation error',
  '- **Root Cause:** the session resolver result is dereferenced without a guard',
  '- **Smoke Test:** the reproduction exits 1 at src/login.ts:41, seeded cookie exits 0',
  '- **Remediation:** guard the resolver result before the dereference',
  '- **Evidence:** three container runs with a cleared cookie jar'
].join('\n');

describe('DiscoveryReport Value Object (issue #237)', () => {
  test('an unpopulated template scaffold is NOT populated', () => {
    const report = DiscoveryReport.fromMarkdown(pristineScaffold());
    assert.strictEqual(report.isPopulated, false, 'a pristine scaffold must never release the RCA park');
  });

  test('an unpopulated scaffold reports exactly the template placeholder keys', () => {
    // Guards against template drift: if someone renames a key in
    // templates/discovery-plan.md, the predicate must still see it unfilled.
    const report = DiscoveryReport.fromMarkdown(pristineScaffold());
    assert.deepStrictEqual(report.unfilledPlaceholderKeys, [...TEMPLATE_PLACEHOLDER_KEYS]);
    assert.strictEqual(report.filledKeyCount, 0);
  });

  test('a fully populated report IS populated', () => {
    const report = DiscoveryReport.fromMarkdown(populatedReport());
    assert.strictEqual(report.isPopulated, true);
    assert.strictEqual(report.filledKeyCount, 10);
    assert.deepStrictEqual(report.unfilledPlaceholderKeys, []);
  });

  test('a bounded number of unfilled keys still holds the park (fail-closed)', () => {
    // Regression (BLOCKER 1): the original rule was `unfilled === 0`, which
    // parked 80% of this repository's genuine RCA reports. The allowance is
    // bounded, not removed — one past the bound must still park.
    const blank = (markdown: string, key: string): string =>
      markdown
        .split('\n')
        .map((l) => (l.startsWith(`- **${key}:**`) ? l.replace(/^(\s*[-*+]\s*\*\*[^*]+:\*\*).*/, '$1') : l))
        .join('\n');

    const atBound = blank(blank(populatedReport(), 'Expected Behavior'), 'Failing Test Target');
    const pastBound = blank(atBound, 'Observed Behavior');

    const bound = DiscoveryReport.fromMarkdown(atBound);
    assert.strictEqual(
      bound.unfilledPlaceholderKeys.length,
      DISCOVERY_REPORT_MAX_UNFILLED_KEYS,
      `fixture must blank exactly ${DISCOVERY_REPORT_MAX_UNFILLED_KEYS} keys`
    );
    assert.strictEqual(bound.isPopulated, true, 'at the allowance bound the park must be released');

    const over = DiscoveryReport.fromMarkdown(pastBound);
    assert.strictEqual(over.unfilledPlaceholderKeys.length, DISCOVERY_REPORT_MAX_UNFILLED_KEYS + 1);
    assert.strictEqual(over.isPopulated, false, 'exceeding the allowance must hold the park');
  });

  test('too few filled keys holds the park even when nothing is left blank', () => {
    const sparse = `# [Discovery] - probe

- **Observed Behavior:** probe crash on login
- **Expected Behavior:** no crash at all
`;
    // Short, only two filled keys, nothing unfilled.
    assert.ok(sparse.length < DISCOVERY_REPORT_MIN_CHARS);
    const report = DiscoveryReport.fromMarkdown(sparse);
    assert.strictEqual(report.filledKeyCount, 2);
    assert.ok(report.filledKeyCount < DISCOVERY_REPORT_MIN_FILLED_KEYS);
    assert.strictEqual(report.isPopulated, false);
  });

  test('a document shorter than the minimum char budget is not populated', () => {
    const short = '- **Observed Behavior:** short\n- **Expected Behavior:** shorter\n- **Affected Components / Paths:** tiny\n';
    assert.ok(short.length < DISCOVERY_REPORT_MIN_CHARS);
    const report = DiscoveryReport.fromMarkdown(short);
    assert.strictEqual(report.isPopulated, false);
  });

  test('null, undefined and empty markdown are never populated', () => {
    assert.strictEqual(DiscoveryReport.fromMarkdown(null).isPopulated, false);
    assert.strictEqual(DiscoveryReport.fromMarkdown(undefined).isPopulated, false);
    assert.strictEqual(DiscoveryReport.fromMarkdown('').isPopulated, false);
    assert.deepStrictEqual(DiscoveryReport.fromMarkdown(null).unfilledPlaceholderKeys, []);
    assert.strictEqual(DiscoveryReport.fromMarkdown(null).filledKeyCount, 0);
  });

  test('non-bullet bold prose (the title header) is not mistaken for a placeholder', () => {
    // The template opens with `**Issue:** #237` / `**Date:** …` outside any
    // bullet. Neither key regex may match them, or every scaffold would be
    // misread as carrying content.
    const report = DiscoveryReport.fromMarkdown(pristineScaffold());
    assert.strictEqual(report.filledKeyCount, 0);
    assert.ok(!report.unfilledPlaceholderKeys.includes('Issue'));
    assert.ok(!report.unfilledPlaceholderKeys.includes('Date'));
  });

  test('isPopulated is stable across repeated reads on the same instance', () => {
    // The key-bullet regexes carry the `g` flag, so `RegExp.prototype.test()`
    // would be STATEFUL and alternate false/true across calls. `isPopulated`
    // must return the same answer every time (issue #237 §2.2 hazard).
    const populated = DiscoveryReport.fromMarkdown(populatedReport());
    assert.strictEqual(populated.isPopulated, true);
    assert.strictEqual(populated.isPopulated, true);
    assert.strictEqual(populated.isPopulated, true);
    assert.strictEqual(populated.filledKeyCount, 10);
    assert.strictEqual(populated.filledKeyCount, 10);

    const scaffold = DiscoveryReport.fromMarkdown(pristineScaffold());
    assert.strictEqual(scaffold.isPopulated, false);
    assert.strictEqual(scaffold.isPopulated, false);
    assert.strictEqual(scaffold.unfilledPlaceholderKeys.length, TEMPLATE_PLACEHOLDER_KEYS.length);
    assert.strictEqual(scaffold.unfilledPlaceholderKeys.length, TEMPLATE_PLACEHOLDER_KEYS.length);
  });

  test('the on-disk template is still unpopulated (drift guard)', () => {
    // If this fails, templates/discovery-plan.md changed shape and the
    // placeholder key list above must be refreshed with it.
    const report = DiscoveryReport.fromMarkdown(pristineScaffold());
    assert.ok(
      report.unfilledPlaceholderKeys.length >= 3,
      `expected the template to still expose >= ${DISCOVERY_REPORT_MIN_FILLED_KEYS} placeholders, got ${report.unfilledPlaceholderKeys.length}`
    );
    assert.strictEqual(report.isPopulated, false);
  });

  test('REGRESSION: a nested-sub-list key value counts as filled (the 80% false-negative)', () => {
    // The shape planning subagents actually write (see NESTED_SHAPE_REPORT's
    // provenance note). The original predicate recognised only
    // `- **Key:** value` on one line and scored every key whose value was an
    // indented sub-list as blank, so real RCA reports parked at DISCOVERY.
    const report = DiscoveryReport.fromMarkdown(NESTED_SHAPE_REPORT);

    assert.deepStrictEqual(
      report.continuationFilledKeys,
      ['Affected Components / Paths', 'Investigation Steps', 'Relevant Code References', 'Local Reproduction Command'],
      'a value written as an indented sub-list must count as filled'
    );
    assert.deepStrictEqual(report.unfilledPlaceholderKeys, []);
    assert.strictEqual(report.filledKeyCount, 10);
    assert.strictEqual(report.isPopulated, true, 'a genuine report in nested shape must release the park');
  });

  test('REGRESSION: a quoted scaffold inside a fenced code block is not scored', () => {
    // NESTED_SHAPE_REPORT quotes the pristine template inside a fence while
    // explaining what it replaced (issue #237's own discovery_plan.md does the
    // same). Those quoted `- **Key:**` lines are code the report is citing, not
    // sections it left blank, and must not park it.
    const withoutFence = NESTED_SHAPE_REPORT.replace(
      /The scaffold this report replaced was:[\s\S]*$/,
      ''
    );
    const fenced = DiscoveryReport.fromMarkdown(NESTED_SHAPE_REPORT);
    const bare = DiscoveryReport.fromMarkdown(withoutFence);

    assert.ok(bare.isPopulated, 'sanity: the report without its citation is populated');
    assert.strictEqual(
      fenced.unfilledPlaceholderKeys.length,
      bare.unfilledPlaceholderKeys.length,
      'quoted template keys inside a fence must not be counted as unfilled'
    );
    assert.strictEqual(filledKeyCountOf(NESTED_SHAPE_REPORT), bare.filledKeyCount);
  });

  test('a blank key followed by a same-indent sibling is NOT a continuation (scaffold guard)', () => {
    // Consecutive blank keys at the same indent are ten separate unfilled
    // sections, not one key with a nested value. This is what keeps the
    // pristine `templates/discovery-plan.md` scaffold scored as unpopulated —
    // without it, one nested continuation would swallow the whole list.
    const doc = `# [Discovery] - probe
- **Observed Behavior:**
- **Expected Behavior:**
- **Affected Components / Paths:** src/login.ts, src/session.ts
`;
    const report = DiscoveryReport.fromMarkdown(doc);
    assert.deepStrictEqual(report.continuationFilledKeys, []);
    assert.deepStrictEqual(report.unfilledPlaceholderKeys, ['Observed Behavior', 'Expected Behavior']);
    assert.strictEqual(report.filledKeyCount, 1);
  });

  test('T7 CALIBRATION: genuine reports are detected regardless of shape', (t: any) => {
    // The verification probe the reviewer asked for, kept as a test so the
    // calibration cannot silently regress.
    //
    // Before the #306 fix the predicate reported false negatives against this
    // corpus whenever a subagent wrote the prompt's own heading-shaped output:
    // `filledKeyCount` was 0, so a complete RCA was scored as a scaffold. The
    // ground truth below therefore accepts EITHER shape, and is deliberately
    // independent of the code under test (a hand-rolled scanner, not
    // `DiscoveryReport`): a regression that collapsed the predicate must show
    // up as missed reports, not shrink the "genuine" set.
    //
    // `artifacts/` is gitignored, so a fresh clone has no corpus — the probe is
    // meaningful only where the developer actually ran the pipeline. Skip
    // rather than fail there.
    const plansDir = path.resolve(__dirname, '../../artifacts/plans');
    if (!fs.existsSync(plansDir)) {
      t.skip('artifacts/plans is absent (fresh clone); calibration needs a real corpus');
      return;
    }

    const corpus: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
        } else if (DISCOVERY_REPORT_FILE.test(entry)) {
          corpus.push(full);
        }
      }
    };
    walk(plansDir);
    if (corpus.length === 0) {
      t.skip('no discovery reports in artifacts/plans yet');
      return;
    }

    /**
     * Section bodies whose NON-bullet prose is substantive. The bullet filter
     * keeps the heading shape distinct from the key shape: a section whose only
     * body is `- **Key:** value` is not heading-style evidence.
     */
    const substantiveSectionBodies = (text: string): string[] => {
      const bodies: string[] = [];
      let current: string[] | null = null;
      for (const line of text.split('\n')) {
        if (/^[ \t]{0,3}#{2,6}[ \t]+\S/.test(line)) {
          if (current !== null) bodies.push(current.join('\n'));
          current = [];
        } else if (current !== null) {
          current.push(line);
        }
      }
      if (current !== null) bodies.push(current.join('\n'));
      return bodies.filter(
        (body) =>
          body
            .split('\n')
            .filter((line) => !/^[ \t]*[-*+][ \t]*\*\*[^*\n]+?(?::\*\*|\*\*:)/.test(line))
            .join(' ')
            .replace(/\s/g, '').length >= 100
      );
    };

    const filledKeyValues = (text: string): number =>
      (text.match(/^[ \t]*[-*+][ \t]*\*\*[^*\n]+?(?::\*\*|\*\*:)[ \t]*\S/gm) ?? []).length;

    // Ground truth: a long document with real RCA content in EITHER accepted
    // shape. Heading-style reports are explicitly admitted here — that is the
    // #306 AC6 regression this test pins.
    const isGenuine = (text: string): boolean =>
      text.trim().length >= 2000 &&
      (filledKeyValues(text) >= 3 || substantiveSectionBodies(text).length >= 2);

    const genuine = corpus.filter((f: string) => isGenuine(fs.readFileSync(f, 'utf8')));
    assert.ok(genuine.length > 0, 'the corpus must contain at least one genuine RCA report');

    // The calibration is meaningful only where the developer actually ran the
    // pipeline enough times.
    if (genuine.length < 5) {
      t.skip(`corpus too small to calibrate (${genuine.length} genuine reports)`);
      return;
    }

    const missed = genuine.filter(
      (f: string) => !DiscoveryReport.fromMarkdown(fs.readFileSync(f, 'utf8')).isPopulated
    );
    assert.deepStrictEqual(
      missed.map((f: string) => path.relative(plansDir, f)),
      [],
      'genuine RCA reports must not be scored as unpopulated scaffolds'
    );

    // AC6: a genuine report with ZERO key bullets is heading-shaped, and the
    // ground truth must SYMBOLISE it as genuine rather than filter it out.
    const headingOnly = genuine.filter((f: string) => filledKeyValues(fs.readFileSync(f, 'utf8')) === 0);
    for (const file of headingOnly) {
      assert.strictEqual(
        DiscoveryReport.fromMarkdown(fs.readFileSync(file, 'utf8')).isPopulated,
        true,
        `${path.relative(plansDir, file)} is heading-shaped and must be accepted`
      );
    }

    // And the contrapositive: an untouched template must still be rejected.
    const pristine = DiscoveryReport.fromMarkdown(pristineScaffold());
    assert.strictEqual(pristine.isPopulated, false);
  });
});

// ============================================================================
// Content predicate (issue #306)
// ============================================================================

describe('DiscoveryReport content predicate (issue #306)', () => {
  test('T1 REGRESSION: a heading-style RCA with zero key bullets is populated', () => {
    // The #284/#298/#297 shape: the prompt's four sections, prose under each,
    // no `- **Key:**` grammar at all. Before #306 this scored filled 0 and was
    // parked as an "unpopulated scaffold".
    const report = DiscoveryReport.fromMarkdown(HEADING_SHAPE_REPORT);

    assert.strictEqual(report.filledKeyCount, 0, 'the fixture proves the bullet scanner sees nothing');
    assert.deepStrictEqual(report.unfilledPlaceholderKeys, []);
    assert.strictEqual(report.isPopulated, true, 'a prompt-shaped RCA must release the park');
    assert.ok(
      report.substantiveSectionHeadings.length >= 3,
      `expected >= 3 substantive sections, got ${report.substantiveSectionHeadings.join(', ')}`
    );
    assert.ok(report.contentUnitCount >= DISCOVERY_REPORT_MIN_CONTENT_UNITS);
  });

  test('T2 a pristine scaffold stays unpopulated under the content rule', () => {
    const report = DiscoveryReport.fromMarkdown(pristineScaffold());

    assert.strictEqual(report.isPopulated, false, 'headings alone are not content');
    assert.strictEqual(report.contentUnitCount, 0, 'a pristine scaffold has no substantive unit');
    assert.strictEqual(report.contentCharCount, 0, 'a pristine scaffold has no substantive characters');
    assert.strictEqual(report.unfilledPlaceholderKeys.length, TEMPLATE_PLACEHOLDER_KEYS.length);
  });

  test('T3 REGRESSION: cosmetic bullets cannot release a content-free skeleton', () => {
    // AC2's reverse direction: adding formatting-only bullets to an empty
    // document must not release the park. On the pre-#306 predicate this
    // fixture scored `isPopulated === true` (four "filled" keys, 242 chars).
    const report = DiscoveryReport.fromMarkdown(COSMETIC_BULLETS_ONLY);

    assert.strictEqual(report.filledKeyCount, 4, 'the bullets are syntactically filled…');
    assert.strictEqual(report.contentUnitCount, 0, '…but carry no substantive value');
    assert.strictEqual(report.isPopulated, false, 'cosmetic bullets must not release a skeleton');

    // AC2, padded form: a pointer long enough to clear the 20-char per-unit
    // floor still carries no evidence. On the first #306 predicate this scored
    // four units / 200+ characters and released the park.
    const padded = DiscoveryReport.fromMarkdown(POINTER_PADDED_BULLETS_ONLY);
    assert.strictEqual(padded.filledKeyCount, 4, 'sanity: the padded bullets are syntactically filled');
    assert.strictEqual(padded.contentUnitCount, 0, 'pointer-only values are not substantive units');
    assert.strictEqual(padded.contentCharCount, 0, 'pointer-only values contribute no content characters');
    assert.strictEqual(padded.isPopulated, false, 'padded pointer filler must not release a skeleton');
    assert.ok(
      POINTER_PADDED_BULLETS_ONLY.includes('see the Summary & Symptoms section above for details'),
      'the fixture must actually use the long pointer form'
    );
  });

  test('T4 REGRESSION: restating the headings as bullets does not release the gate', () => {
    const report = DiscoveryReport.fromMarkdown(RESTATED_HEADINGS_ONLY);

    assert.strictEqual(report.isPopulated, false);
    assert.ok(
      report.contentUnitCount < DISCOVERY_REPORT_MIN_CONTENT_UNITS,
      `restated headings scored ${report.contentUnitCount} units; the floor is ${DISCOVERY_REPORT_MIN_CONTENT_UNITS}`
    );
  });

  test('T5 missing evidence names the empty sections and blank keys', () => {
    const pristine = DiscoveryReport.fromMarkdown(pristineScaffold());
    const pristineMissing = pristine.describeMissingEvidence();
    assert.match(pristineMissing, /content-bearing/);
    assert.match(pristineMissing, /content characters/);
    assert.ok(
      pristineMissing.includes('1. Problem Statement & Symptoms'),
      `the park must name the empty section, got: ${pristineMissing}`
    );
    assert.ok(
      pristineMissing.includes('Observed Behavior'),
      `the park must name a blank template key, got: ${pristineMissing}`
    );

    // Every blank key is named (up to the truncation bound) when only a few
    // remain — the ten-key pristine scaffold is deliberately truncated.
    const threeBlank = `# [Discovery] - probe

## 1. Problem Statement & Symptoms
- **Alpha Key:**
- **Beta Key:**
- **Gamma Key:**
`;
    const threeMissing = DiscoveryReport.fromMarkdown(threeBlank).describeMissingEvidence();
    for (const key of ['Alpha Key', 'Beta Key', 'Gamma Key']) {
      assert.ok(threeMissing.includes(key), `the park must name '${key}', got: ${threeMissing}`);
    }

    // A partially filled scaffold must NOT be told its filled section is empty:
    // the section's only body is a substantive `- **Key:**` value, which is a
    // KEY unit, not prose — but it is evidence and the section is not blank.
    const partiallyFilled = pristineScaffold().replace(
      '- **Observed Behavior:**',
      '- **Observed Behavior:** The login form crashes whenever the session cookie is absent, reproduced three times in a cleared container.'
    );
    const partialMissing = DiscoveryReport.fromMarkdown(partiallyFilled).describeMissingEvidence();
    assert.ok(
      !partialMissing.includes('1. Problem Statement & Symptoms'),
      `a section carrying a filled key must not be called empty, got: ${partialMissing}`
    );
    assert.ok(
      partialMissing.includes('2. Root Cause Analysis (RCA)'),
      `the genuinely empty sections must still be named, got: ${partialMissing}`
    );

    // A populated report has nothing missing to report.
    assert.strictEqual(DiscoveryReport.fromMarkdown(populatedReport()).describeMissingEvidence(), '');
    assert.strictEqual(DiscoveryReport.fromMarkdown(HEADING_SHAPE_REPORT).describeMissingEvidence(), '');
  });

  test('T5b describeMissingEvidence names every failing dimension (AC3)', () => {
    // Review repro (a): ONLY the shape-evidence requirement fails — 1
    // substantive section + 2 substantive key values = 3 units, 400+ chars,
    // long enough, nothing blank. The first #306 formatter returned ''.
    const shapeEvidenceOnly = [
      '# [Discovery] - shape probe',
      '',
      '## Summary & Symptoms',
      '',
      'The login form crashes whenever the session cookie is absent. Reproduced three times in an ephemeral container against the current build with a cleared cookie jar and a fresh profile.',
      '',
      '## Remediation Strategy',
      '- **Recommended Fix Approach:** guard the resolver result before the dereference and add a regression test for the inline error path.',
      '- **Potential Regressions / Side Effects:** none, the guard only adds an early return before the existing submit handler continues.'
    ].join('\n');
    const shapeReport = DiscoveryReport.fromMarkdown(shapeEvidenceOnly);
    assert.strictEqual(shapeReport.contentUnitCount, DISCOVERY_REPORT_MIN_CONTENT_UNITS);
    assert.ok(shapeReport.contentCharCount >= DISCOVERY_REPORT_MIN_CONTENT_CHARS);
    assert.ok(shapeEvidenceOnly.length >= DISCOVERY_REPORT_MIN_CHARS);
    assert.strictEqual(shapeReport.isPopulated, false, 'one section + two keys is not shape evidence');
    const shapeMissing = shapeReport.describeMissingEvidence();
    assert.ok(shapeMissing.length > 0, 'a parked report must never produce an empty diagnostic');
    assert.match(shapeMissing, /no accepted shape/);
    assert.match(shapeMissing, new RegExp(`${DISCOVERY_REPORT_MIN_PROSE_SECTIONS} substantive ## sections`));
    assert.match(shapeMissing, new RegExp(`${DISCOVERY_REPORT_MIN_FILLED_KEYS} filled key values`));

    // Review repro (b): ONLY the document-length floor fails — three 50-char
    // sections clear the unit and content-character floors. The first #306
    // formatter also returned '' here.
    const fifty = 'x'.repeat(DISCOVERY_REPORT_MIN_CONTENT_CHARS / DISCOVERY_REPORT_MIN_CONTENT_UNITS);
    const shortDoc = `## A\n${fifty}\n\n## B\n${fifty}\n\n## C\n${fifty}\n`;
    const shortReport = DiscoveryReport.fromMarkdown(shortDoc);
    assert.strictEqual(shortReport.contentUnitCount, DISCOVERY_REPORT_MIN_CONTENT_UNITS);
    assert.strictEqual(shortReport.contentCharCount, DISCOVERY_REPORT_MIN_CONTENT_CHARS);
    assert.ok(shortDoc.trim().length < DISCOVERY_REPORT_MIN_CHARS);
    assert.strictEqual(shortReport.isPopulated, false, 'the length floor alone must hold the park');
    const shortMissing = shortReport.describeMissingEvidence();
    assert.ok(shortMissing.length > 0, 'a length-floor park must never produce an empty diagnostic');
    assert.ok(
      shortMissing.includes(
        `${shortDoc.trim().length} of ${DISCOVERY_REPORT_MIN_CHARS} characters in the report`
      ),
      `the park must state the measured document length, got: ${shortMissing}`
    );

    // Only the blank-key cap fails: three substantive values (3 units, enough
    // characters) but four blank template keys veto the bullet branch.
    const cappedDoc = `# [Discovery] - cap probe

- **Observed Behavior:** the login form crashes whenever the session cookie is absent, reproduced three times.
- **Identified Failure Mode:** the session resolver result is dereferenced without a guard at src/login.ts line 41.
- **Recommended Fix Approach:** guard the resolver result before the dereference and add an inline-error regression test.
- **Expected Behavior:**
- **Affected Components / Paths:**
- **Relevant Code References:**
- **Failing Test Target:**
`;
    const cappedReport = DiscoveryReport.fromMarkdown(cappedDoc);
    assert.strictEqual(cappedReport.contentUnitCount, DISCOVERY_REPORT_MIN_CONTENT_UNITS);
    assert.ok(cappedReport.contentCharCount >= DISCOVERY_REPORT_MIN_CONTENT_CHARS);
    assert.ok(cappedDoc.length >= DISCOVERY_REPORT_MIN_CHARS);
    assert.ok(cappedReport.unfilledPlaceholderKeys.length > DISCOVERY_REPORT_MAX_UNFILLED_KEYS);
    assert.strictEqual(cappedReport.isPopulated, false, 'the blank-key cap must hold the park');
    const capMissing = cappedReport.describeMissingEvidence();
    assert.match(capMissing, /no accepted shape/);
    assert.ok(
      capMissing.includes(`blank template keys (max ${DISCOVERY_REPORT_MAX_UNFILLED_KEYS})`),
      `the park must state the blank-key cap, got: ${capMissing}`
    );
  });

  test('T6 the verdict is invariant to adding a bullet index to a heading report', () => {
    // The #298/#284 workaround must be a no-op: the report was already
    // populated, so adding (or removing) the synthetic index changes nothing.
    const withIndex = `${HEADING_SHAPE_REPORT}\n\n${SYNTHETIC_INDEX}\n`;
    const withoutIndex = withIndex.replace(SYNTHETIC_INDEX, '');

    const heading = DiscoveryReport.fromMarkdown(HEADING_SHAPE_REPORT);
    const indexed = DiscoveryReport.fromMarkdown(withIndex);
    const stripped = DiscoveryReport.fromMarkdown(withoutIndex);

    assert.strictEqual(heading.isPopulated, true, 'the RCA alone is populated');
    assert.strictEqual(indexed.isPopulated, true, 'adding the index must not change the verdict');
    assert.strictEqual(stripped.isPopulated, true, 'removing it must not change the verdict either');
    assert.ok(indexed.filledKeyCount > heading.filledKeyCount, 'sanity: the index adds key bullets');
  });

  test('T8 both bold-key spellings yield the same key and the same verdict', () => {
    // The discovery prompt writes `- **Summary & Symptoms**: value` (colon
    // outside the bold); the scaffold writes `- **Key:** value`. Both are
    // evidence, and both must yield the bare key name.
    const outsideColon = `# [Discovery] - probe

## 1. Summary & Symptoms
- **Summary & Symptoms**: the login form crashes whenever the session cookie is absent, reproduced three times.
- **Root Cause Analysis**: the session resolver returns null and src/login.ts:41 dereferences it without a guard.
- **Manual Bug Smoke Test**: the reproduction exits 1 with a stack frame at src/login.ts:41; a seeded cookie exits 0.
`;
    const report = DiscoveryReport.fromMarkdown(outsideColon);

    assert.strictEqual(report.filledKeyCount, 3);
    assert.deepStrictEqual(report.unfilledPlaceholderKeys, []);
    assert.strictEqual(report.isPopulated, true);
    assert.ok(report.contentCharCount >= DISCOVERY_REPORT_MIN_CONTENT_CHARS);

    // The template spelling recovers the same bare key (no trailing colon).
    const insideColon = `# [Discovery] - probe

- **Observed Behavior:** probe crash on login
- **Expected Behavior:** no crash at all
- **Affected Components / Paths:** src/login.ts
`;
    const inside = DiscoveryReport.fromMarkdown(insideColon);
    assert.strictEqual(inside.filledKeyCount, 3);
    assert.deepStrictEqual(inside.unfilledPlaceholderKeys, []);
    assert.strictEqual(inside.isPopulated, false, 'three short values are still below the content floors');

    // Same keys, same bare names, either spelling of the delimiter.
    const insideBlank = DiscoveryReport.fromMarkdown('# [Discovery] - probe\n\n- **Alpha Key:**\n- **Beta Key:**\n');
    const outsideBlank = DiscoveryReport.fromMarkdown('# [Discovery] - probe\n\n- **Alpha Key**:\n- **Beta Key**:\n');
    assert.deepStrictEqual(insideBlank.unfilledPlaceholderKeys, ['Alpha Key', 'Beta Key']);
    assert.deepStrictEqual(outsideBlank.unfilledPlaceholderKeys, ['Alpha Key', 'Beta Key']);
  });

  test('T9 REGRESSION: CRLF reports score exactly like their LF form', () => {
    // Every section/key rule is `$`-anchored without the `m` flag, so a line
    // ending in `\r` never matched: a CRLF report collapsed to zero sections,
    // zero units and an evidence-free park, and its blank keys were invisible
    // to the handler's placeholder diagnostic (issue #306 review). The
    // constructor normalises line endings before partitioning.
    const toCrlf = (text: string): string => text.replace(/\n/g, '\r\n');

    const lfHeading = DiscoveryReport.fromMarkdown(HEADING_SHAPE_REPORT);
    const crlfHeading = DiscoveryReport.fromMarkdown(toCrlf(HEADING_SHAPE_REPORT));
    assert.strictEqual(crlfHeading.isPopulated, true, 'a CRLF heading RCA must still release the park');
    assert.deepStrictEqual(
      crlfHeading.substantiveSectionHeadings,
      lfHeading.substantiveSectionHeadings,
      'the same sections must be substantive in either encoding'
    );
    assert.strictEqual(crlfHeading.contentUnitCount, lfHeading.contentUnitCount);
    assert.strictEqual(crlfHeading.contentCharCount, lfHeading.contentCharCount);
    assert.strictEqual(crlfHeading.describeMissingEvidence(), lfHeading.describeMissingEvidence());

    const lfScaffold = DiscoveryReport.fromMarkdown(pristineScaffold());
    const crlfScaffold = DiscoveryReport.fromMarkdown(toCrlf(pristineScaffold()));
    assert.strictEqual(crlfScaffold.isPopulated, false, 'a CRLF scaffold must still park');
    assert.strictEqual(crlfScaffold.contentUnitCount, 0);
    assert.strictEqual(crlfScaffold.contentCharCount, 0);
    assert.deepStrictEqual(
      crlfScaffold.unfilledPlaceholderKeys,
      lfScaffold.unfilledPlaceholderKeys,
      'blank keys must parse identically in either encoding'
    );
    assert.strictEqual(crlfScaffold.unfilledPlaceholderKeys.length, TEMPLATE_PLACEHOLDER_KEYS.length);
    assert.deepStrictEqual(
      crlfScaffold.emptySectionHeadings,
      lfScaffold.emptySectionHeadings,
      'the park must name the same sections without substantive prose'
    );
    assert.ok(
      crlfScaffold.emptySectionHeadings.includes('1. Problem Statement & Symptoms'),
      `expected the first section to be named, got ${crlfScaffold.emptySectionHeadings.join(', ')}`
    );
    assert.strictEqual(
      crlfScaffold.describeMissingEvidence(),
      lfScaffold.describeMissingEvidence(),
      'the diagnostic must not depend on the line ending'
    );
  });

  test('T10 the missing-evidence wording is owned by formatDiscoveryMissingEvidence', () => {
    // AC3's diagnostic fragments live beside `formatDiscoveryParkAwaitingRca`
    // in the domain constants, not inline in the value object. Every failing
    // dimension must render, and a section with 1–19 characters is described
    // as lacking substantive prose, never as "empty".
    const rendered = formatDiscoveryMissingEvidence({
      markdownChars: 10,
      contentUnitCount: 1,
      contentCharCount: 20,
      hasShapeEvidence: false,
      blankKeys: ['Alpha Key', 'Beta Key', 'Gamma Key'],
      sectionsWithoutSubstantiveProse: ['Summary & Symptoms']
    });

    assert.match(rendered, /10 of 200 characters in the report/);
    assert.match(rendered, /1 of 3 content-bearing sections or key values/);
    assert.match(rendered, /20 of 150 content characters/);
    assert.match(rendered, /no accepted shape/);
    assert.match(rendered, /3 blank template keys \(max 2\): Alpha Key, Beta Key, Gamma Key/);
    assert.match(rendered, /sections without substantive prose: "Summary & Symptoms"/);
    assert.doesNotMatch(rendered, /empty sections/);

    // Nothing failing → no diagnostic, so the park never invents a gap.
    assert.strictEqual(
      formatDiscoveryMissingEvidence({
        markdownChars: DISCOVERY_REPORT_MIN_CHARS,
        contentUnitCount: DISCOVERY_REPORT_MIN_CONTENT_UNITS,
        contentCharCount: DISCOVERY_REPORT_MIN_CONTENT_CHARS,
        hasShapeEvidence: true,
        blankKeys: [],
        sectionsWithoutSubstantiveProse: []
      }),
      ''
    );
  });
});


/** Small helper so the fence test can compare against a fence-free copy. */
function filledKeyCountOf(markdown: string): number {
  return DiscoveryReport.fromMarkdown(markdown).filledKeyCount;
}
