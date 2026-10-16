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
  DISCOVERY_REPORT_MAX_UNFILLED_KEYS
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

  test('CALIBRATION: the repository\u2019s own genuine RCA reports are detected', () => {
    // The verification probe the reviewer asked for, kept as a test so the
    // calibration cannot silently regress.
    //
    // Before this fix the predicate reported 80% false negatives against this
    // corpus: only 3 of 15 genuine reports were recognised, because subagents
    // write key values as nested sub-lists and quote the template inside
    // fences. This test pins that number at (near) zero.
    //
    // `artifacts/` is gitignored, so a fresh clone has no corpus — the probe is
    // meaningful only where the developer actually ran the pipeline. Skip
    // rather than fail there.
    const plansDir = path.resolve(__dirname, '../../artifacts/plans');
    if (!fs.existsSync(plansDir)) {
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
    assert.ok(corpus.length > 0, 'the corpus should contain discovery reports');

    // Ground truth: a document with real RCA prose.
    //
    // Deliberately independent of the predicate under test. An earlier version
    // used `DiscoveryReport.filledKeyCount >= 5` here, which made the test
    // self-referential: a regression that collapsed the key parser would
    // shrink the "genuine" set and hide itself. `TEMPLATE_PLACEHOLDER_KEYS` is
    // a literal list from `templates/discovery-plan.md`, and `carriesContent`
    // is a small hand-rolled scan with its own parser shape (inline value, or
    // any following line indented deeper than its bullet), so no part of the
    // decision routes through the code under test.
    const carriesContent = (text: string, key: string): boolean => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const bullet = new RegExp(`^[-*+][ \\t]*\\*\\*${escaped}:\\*\\*(.*)$`, 'm');
      const match = text.match(bullet);
      if (!match) return false;
      if (match[1].trim() !== '') return true;
      const after = text.slice(text.indexOf(match[0]) + match[0].length).split('\n').slice(1);
      return after.some((line) => line.trim() !== '' && /^[ \t]+\S/.test(line));
    };

    const genuine = corpus.filter((f: string) => {
      const text = fs.readFileSync(f, 'utf8');
      if (text.trim().length < 2000) return false;
      const filled = TEMPLATE_PLACEHOLDER_KEYS.filter((k) => carriesContent(text, k)).length;
      return filled >= 6;
    });
    assert.ok(
      genuine.length >= 5,
      `expected the repository to hold >= 5 genuine RCA reports, found ${genuine.length} — the fixture corpus may have been cleaned up`
    );

    const missed = genuine.filter(
      (f: string) => !DiscoveryReport.fromMarkdown(fs.readFileSync(f, 'utf8')).isPopulated
    );
    assert.deepStrictEqual(
      missed.map((f: string) => path.relative(plansDir, f)),
      [],
      'genuine RCA reports must not be scored as unpopulated scaffolds'
    );

    // And the contrapositive: an untouched template must still be rejected.
    const pristine = DiscoveryReport.fromMarkdown(pristineScaffold());
    assert.strictEqual(pristine.isPopulated, false);
  });
});

/** Small helper so the fence test can compare against a fence-free copy. */
function filledKeyCountOf(markdown: string): number {
  return DiscoveryReport.fromMarkdown(markdown).filledKeyCount;
}
