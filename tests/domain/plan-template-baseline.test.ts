/**
 * agyloop - Template <-> BaselineEvidence pin (issue #392)
 *
 * `templates/implementation-plan.md` used to seed `- **Claim:**`, a shape
 * `BaselineEvidence.fromPlan` cannot read. A plan authored from the template
 * therefore carried ZERO claims, so D1's guard measured nothing (inert), and
 * the same plan with a reproduction header was falsely refused as
 * `missing-baseline-evidence`.
 *
 * These cases pin the template, the embedded fallback and the parser to ONE
 * shape, in both directions:
 *
 * TP1 - both template copies carry the parser's scaffold and not the bullet
 * TP2 - the FILLED on-disk scaffold parses as exactly one measured claim
 * TP3 - the FILLED fallback scaffold parses identically
 * TP4 - the UNTOUCHED scaffold declares no claim (no new false refusal), while
 *       an armed reproduction header still refuses a stub-only document
 * TP5 - the rendered scaffold stays non-substantive (the YOLO park, #259)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { BaselineEvidence, isPlanContentSubstantive } = require('../../dist/domain');
const { FALLBACK_TEMPLATES, TEMPLATE_FILES } = require('../../dist');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'templates', 'implementation-plan.md');
const CLAIM_ID = 'DA-METRICS-1';
const DECLARED = '{ additions: 4, deletions: 0 }';
const COMMAND = `node -e 'console.log("{ additions: 4, deletions: 0 }")'`;

/** The reproduction-claim header fixture (`baseline-evidence.test.ts`). */
const HEADER_CLAIM =
  '**Revision analysed:** `abc1234`. Every baseline value was reproduced through `dist/` before this plan was written.';

const RENDER_VARIABLES: Record<string, string> = {
  Title: 'probe',
  IssueNumber: '392',
  Date: '2026-10-30'
};

function renderTemplate(content: string, variables: Record<string, string>): string {
  return content.replace(/\{([A-Za-z0-9_]+)\}/g, (match: string, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match
  );
}

/** The template's own Baseline Evidence section, with its placeholders filled in. */
function filledScaffold(source: string): string {
  const start = source.indexOf('### Baseline Evidence');
  assert.ok(start >= 0, 'the scaffold must carry a ### Baseline Evidence section');
  const section = source.slice(start);
  const filled = section
    .replace('#### <claim-id>', `#### ${CLAIM_ID}`)
    .replace(/^- \*\*Declared:\*\*[ \t]*$/m, `- **Declared:** \`${DECLARED}\``)
    .replace(/^- \*\*Command:\*\*[ \t]*$/m, `- **Command:** \`${COMMAND}\``)
    .replace(/^- \*\*Output:\*\*[ \t]*$/m, `- **Output:** \`${DECLARED}\``);
  assert.ok(filled.includes(`#### ${CLAIM_ID}`), `claim heading missing from:\n${section}`);
  assert.ok(filled.includes(`- **Declared:** \`${DECLARED}\``), `Declared label missing from:\n${section}`);
  assert.ok(filled.includes(`- **Command:** \`${COMMAND}\``), `Command label missing from:\n${section}`);
  assert.ok(filled.includes(`- **Output:** \`${DECLARED}\``), `Output label missing from:\n${section}`);
  return `# [Implementation] - probe\n\n${filled}\n`;
}

function bothTemplates(): Array<{ name: string; text: string }> {
  return [
    { name: 'templates/implementation-plan.md', text: fs.readFileSync(TEMPLATE_PATH, 'utf8') },
    {
      name: 'FALLBACK_TEMPLATES[implementation-plan.md]',
      text: FALLBACK_TEMPLATES[TEMPLATE_FILES.IMPLEMENTATION]
    }
  ];
}

describe('Plan template <-> BaselineEvidence pin (issue #392)', () => {
  test('TP1 (AC1, AC3, AC5): both template copies seed the parser shape, never the Claim bullet', () => {
    for (const source of bothTemplates()) {
      assert.ok(source.text.includes('### Baseline Evidence'), `${source.name} must seed the evidence section`);
      assert.ok(source.text.includes('#### <claim-id>'), `${source.name} must seed a claim heading`);
      assert.ok(source.text.includes('- **Declared:**'), `${source.name} must seed Declared`);
      assert.ok(source.text.includes('- **Command:**'), `${source.name} must seed Command`);
      assert.ok(source.text.includes('- **Output:**'), `${source.name} must seed Output`);
      assert.ok(!source.text.includes('- **Claim:**'), `${source.name} must not seed the unparseable Claim bullet`);
    }
  });

  test('TP2 (AC2): the filled on-disk scaffold parses as exactly one claim', () => {
    const source = bothTemplates()[0].text;
    const parsed = BaselineEvidence.fromPlan(filledScaffold(source));

    assert.strictEqual(parsed.found, true, JSON.stringify(parsed));
    assert.strictEqual(parsed.claims.length, 1, JSON.stringify(parsed));
    assert.strictEqual(parsed.claims[0].id, CLAIM_ID);
    assert.strictEqual(parsed.claims[0].declared, DECLARED);
    assert.strictEqual(parsed.claims[0].output, DECLARED);
    assert.ok(parsed.claims[0].command.includes('additions: 4'), parsed.claims[0].command);
    assert.deepStrictEqual(parsed.findings, []);
  });

  test('TP3 (AC5): the filled fallback scaffold parses identically', () => {
    const source = bothTemplates()[1].text;
    const parsed = BaselineEvidence.fromPlan(filledScaffold(source));

    assert.strictEqual(parsed.found, true, JSON.stringify(parsed));
    assert.strictEqual(parsed.claims.length, 1, JSON.stringify(parsed));
    assert.strictEqual(parsed.claims[0].id, CLAIM_ID);
    assert.strictEqual(parsed.claims[0].declared, DECLARED);
    assert.strictEqual(parsed.claims[0].output, DECLARED);
    assert.ok(parsed.claims[0].command.includes('additions: 4'), parsed.claims[0].command);
    assert.deepStrictEqual(parsed.findings, []);
  });

  test('TP4 (AC6): the untouched scaffold declares no claim, but an armed header still refuses a stub-only document', () => {
    const raw = bothTemplates()[0].text;
    const rendered = renderTemplate(raw, RENDER_VARIABLES);

    const untouched = BaselineEvidence.fromPlan(rendered);
    assert.strictEqual(untouched.found, true, JSON.stringify(untouched));
    assert.strictEqual(untouched.claims.length, 0, JSON.stringify(untouched));
    assert.deepStrictEqual(untouched.findings, [], JSON.stringify(untouched.findings));

    const armed = BaselineEvidence.fromPlan(`${HEADER_CLAIM}\n\n${rendered}`);
    assert.ok(
      armed.findings.some((finding: any) => finding.rule === 'missing-baseline-evidence'),
      JSON.stringify(armed.findings)
    );
  });

  test('TP5 (AC4): the rendered scaffold stays non-substantive', () => {
    for (const source of bothTemplates()) {
      const rendered = renderTemplate(source.text, RENDER_VARIABLES);
      assert.strictEqual(
        isPlanContentSubstantive(rendered),
        false,
        `${source.name} must stay non-substantive:\n${rendered}`
      );
    }
  });
});
