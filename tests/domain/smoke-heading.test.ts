/**
 * agyloop - the ONE smoke-heading predicate (issue #364, AC-12)
 *
 * SH-1  the SECTION predicate refuses an H1 (#362 Finding 1)
 * SH-2  the TITLE predicate is deliberately level-agnostic
 * SH-3  both consumers agree on a real document, and no module defines a second
 *       private `isSmokeHeading` (the duplicate cannot silently return)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  isManualSmokeTestProtocolTitle,
  isSmokeSectionHeading,
  parseQualityGateTargets,
  SmokeProtocol
} = require('../../dist/domain');

describe('smoke heading predicate (#364)', () => {
  test('SH-1: the section predicate refuses an H1', () => {
    assert.strictEqual(
      isSmokeSectionHeading({ level: 1, title: 'manual smoke test protocol' }),
      false
    );
    for (const level of [2, 3, 4]) {
      assert.strictEqual(
        isSmokeSectionHeading({ level, title: 'manual smoke test protocol' }),
        true,
        `level ${level}`
      );
    }
    assert.strictEqual(
      isSmokeSectionHeading({ level: 2, title: 'automated test targets' }),
      false
    );
  });

  test('SH-2: the title predicate is deliberately level-agnostic', () => {
    // The LEVEL rule belongs to the consumer (quality-gate-targets ends a
    // section at `heading.level <= sectionLevel`); this predicate matches at
    // any level BY CONTRACT.
    assert.strictEqual(isManualSmokeTestProtocolTitle('manual smoke test protocol'), true);
    assert.strictEqual(isManualSmokeTestProtocolTitle('6. manual smoke test protocol — checks'), true);
    assert.strictEqual(isManualSmokeTestProtocolTitle('automated test targets'), false);
  });

  test('SH-3: both consumers agree on a real document', () => {
    const markdown = [
      '# Plan Manual Smoke Test Protocol',
      '',
      '## 4. Verification',
      '',
      '```bash',
      'npm test',
      '```',
      '',
      '### Manual Smoke Test Protocol',
      '',
      '```bash',
      'node --test tests/domain/smoke-protocol.test.ts',
      '```',
      ''
    ].join('\n');

    // The H1 phrase never scopes the section ...
    assert.ok(SmokeProtocol.fromPlan(markdown).headingLine > 1);
    // ... and the gate targets never absorb the smoke section's command.
    const targets = parseQualityGateTargets(markdown).targets.map((target: any) => target.command);
    assert.ok(
      !targets.some((command: string) => command.includes('smoke-protocol.test.ts')),
      JSON.stringify(targets)
    );

    // Source-level pin: neither module may reintroduce a private copy.
    const modules = [
      path.join(__dirname, '..', '..', 'src', 'domain', 'value-objects', 'smoke-protocol.ts'),
      path.join(__dirname, '..', '..', 'src', 'domain', 'value-objects', 'quality-gate-targets.ts')
    ];
    for (const modulePath of modules) {
      const source = fs.readFileSync(modulePath, 'utf8');
      assert.ok(
        !/function isSmokeHeading/.test(source),
        `${path.basename(modulePath)} must not define a second isSmokeHeading`
      );
    }
  });
});
