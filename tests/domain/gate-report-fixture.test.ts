/**
 * agyloop - Gate-report fixture parser tests (issue #413)
 *
 * GRF1 - a marker + JSON.stringify({ … }) parses to a GateResultReport; the
 *        span starts at `{` and ends after the balanced `}`
 * GRF2 - single-quoted JS strings and escaped quotes convert to JSON
 * GRF3 - trailing commas and bare keys convert; nested shapes survive
 * GRF4 - template literals, spread, shorthand, identifier values and comments
 *        return null (never guessed)
 * GRF5 - an unbalanced, invalid or incomplete fixture is skipped, not thrown
 * GRF6 - blankFixtureSpans blanks the span and keeps line structure
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  GateResultReport,
  blankFixtureSpans,
  jsObjectLiteralToJson,
  lineOffsetOf,
  parseGateReportFixtures
} = require('../../dist/domain');

const REPORT = {
  verdict: 'PASSED',
  buildSystem: 'npm',
  buildStatus: 'PASSED',
  testsStatus: 'PASSED (1 passed)',
  testsPassed: 1,
  executedCommands: ['npm test'],
  commandResults: [{ command: 'npm test', passed: 1, failed: 0 }]
};

describe('gate-report fixture parser (issue #413)', () => {
  test('GRF1: a marker plus JSON.stringify body parses with a balanced span', () => {
    const body = `GATE_REPORT_JSON:\n${JSON.stringify(REPORT, null, 2)}`;
    const fixtures = parseGateReportFixtures(body);

    assert.strictEqual(fixtures.length, 1, JSON.stringify(fixtures));
    const fixture = fixtures[0];
    assert.ok(fixture.report instanceof GateResultReport);
    assert.strictEqual(fixture.report.testsStatus, 'PASSED (1 passed)');
    assert.strictEqual(body[fixture.span.start], '{');
    assert.strictEqual(body[fixture.span.end - 1], '}');
    assert.strictEqual(body.slice(fixture.span.start, fixture.span.end), JSON.stringify(REPORT, null, 2));
    assert.strictEqual(lineOffsetOf(body, fixture.markerOffset), 0);
  });

  test('GRF2: single-quoted JS strings parse to the same report as JSON', () => {
    const singleQuoted =
      "GATE_REPORT_JSON: { verdict: 'PASSED', buildSystem: 'npm', buildStatus: 'PASSED', " +
      "testsStatus: 'PASSED (1 passed)', testsPassed: 1, " +
      "commandResults: [{ command: 'npm test', passed: 1, failed: 0 }] }";
    const fixtures = parseGateReportFixtures(singleQuoted);

    assert.strictEqual(fixtures.length, 1, JSON.stringify(fixtures));
    assert.strictEqual(fixtures[0].report.testsStatus, 'PASSED (1 passed)');
    assert.strictEqual(fixtures[0].report.testsPassed, 1);
    assert.strictEqual(fixtures[0].report.commandResults[0].command, 'npm test');

    // An escaped quote inside a single-quoted string survives.
    const escaped = jsObjectLiteralToJson("{ note: 'it\\'s \"fine\"' }");
    assert.ok(escaped !== null);
    assert.strictEqual(JSON.parse(escaped).note, 'it\'s "fine"');
  });

  test('GRF3: trailing commas and bare keys convert; nested shapes survive', () => {
    const json = jsObjectLiteralToJson('{ a: 1, b: [1, 2,], c: { d: true, }, }');
    assert.ok(json !== null);
    assert.deepStrictEqual(JSON.parse(json), { a: 1, b: [1, 2], c: { d: true } });
  });

  test('GRF4: shapes the lexer cannot convert return null', () => {
    assert.strictEqual(jsObjectLiteralToJson('{ a: `x` }'), null);
    assert.strictEqual(jsObjectLiteralToJson('{ ...base }'), null);
    assert.strictEqual(jsObjectLiteralToJson('{ a }'), null);
    assert.strictEqual(jsObjectLiteralToJson('{ a: b }'), null);
    assert.strictEqual(jsObjectLiteralToJson('{ a: 1 /* c */ }'), null);
    assert.strictEqual(jsObjectLiteralToJson('{ a: 1 // c\n}'), null);
  });

  test('GRF5: unbalanced, invalid and incomplete fixtures are skipped', () => {
    assert.deepStrictEqual(parseGateReportFixtures('GATE_REPORT_JSON: { "verdict": "PASSED"'), []);
    assert.deepStrictEqual(parseGateReportFixtures('GATE_REPORT_JSON: { not json }'), []);
    assert.deepStrictEqual(parseGateReportFixtures('GATE_REPORT_JSON: { "verdict": "PASSED" }'), []);
    assert.deepStrictEqual(
      parseGateReportFixtures(
        'GATE_REPORT_JSON: { "verdict": "PASSED", "buildSystem": "npm", "buildStatus": "PASSED" }'
      ),
      []
    );
  });

  test('GRF6: blankFixtureSpans keeps line structure and surrounding text', () => {
    const body = `before\nGATE_REPORT_JSON: ${JSON.stringify(REPORT)}\nafter`;
    const fixture = parseGateReportFixtures(body)[0];
    const blanked = blankFixtureSpans(body, [fixture.span]);

    assert.strictEqual(blanked.split('\n').length, body.split('\n').length);
    assert.ok(blanked.startsWith('before\n'));
    assert.ok(blanked.endsWith('\nafter'));
    assert.ok(!blanked.includes(JSON.stringify(REPORT)));
    assert.ok(blanked.includes('GATE_REPORT_JSON:'));
    assert.strictEqual(blanked.split('\n')[1].trim(), 'GATE_REPORT_JSON:');

    // UTF-16 offsets: an astral character before the fixture must not shift
    // the blanked span (a code-point array would).
    const astral = `before 😀\nGATE_REPORT_JSON: ${JSON.stringify(REPORT)}\nafter`;
    const astralFixture = parseGateReportFixtures(astral)[0];
    const astralBlanked = blankFixtureSpans(astral, [astralFixture.span]);
    assert.ok(astralBlanked.includes('😀'));
    assert.ok(!astralBlanked.includes(JSON.stringify(REPORT)));
    assert.strictEqual(astralBlanked.split('\n').length, astral.split('\n').length);
  });
});
