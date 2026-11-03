/**
 * agyloop - Release-label value object tests (issue #502)
 *
 * Pins the ONE owner of the `release:major|minor|patch` metadata and the exact
 * `gh label create` command the refusal text quotes.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  releaseLabelCreateCommand,
  releaseLabelDefinition,
  RELEASE_LABEL_DEFINITIONS,
  RELEASE_LABELS,
  RELEASE_LABEL_MINOR
} = require('../../dist/domain');

describe('Release label definitions (#502)', () => {
  test('releaseLabelCreateCommand names the exact gh command that provisions a label (#502 AC1)', () => {
    assert.strictEqual(
      releaseLabelCreateCommand(RELEASE_LABEL_MINOR),
      'gh label create release:minor --color 0e8a16 --description "SemVer minor release (auto-tag)" --force'
    );
    assert.strictEqual(
      releaseLabelCreateCommand(RELEASE_LABEL_MINOR, 'ajxcodes/agyloop'),
      'gh label create release:minor --repo ajxcodes/agyloop --color 0e8a16 --description "SemVer minor release (auto-tag)" --force'
    );
    for (const definition of Object.values(RELEASE_LABEL_DEFINITIONS) as Array<{ color: string }>) {
      assert.match(definition.color, /^[0-9a-f]{6}$/);
    }
  });

  test('releaseLabelDefinition covers the whole release vocabulary (#502 AC1)', () => {
    const labels = Object.values(RELEASE_LABELS) as string[];
    for (const label of labels) {
      const definition = releaseLabelDefinition(label);
      assert.ok(definition, `${label} must have a definition`);
      assert.strictEqual(definition.name, label);
      assert.ok(definition.description.length > 0, `${label} must carry a description`);
      assert.match(definition.color, /^[0-9a-f]{6}$/);
    }
  });

  test('an unknown label still yields a runnable command (#502 AC1)', () => {
    const command = releaseLabelCreateCommand('release:rc');
    assert.ok(command.includes('gh label create release:rc'));
    assert.ok(command.endsWith('--force'));
  });
});
