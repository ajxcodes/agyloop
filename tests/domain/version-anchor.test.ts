/**
 * agyloop - VersionAnchor Value Object Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  VersionAnchor,
  VERSIONING_STRATEGY_PACKAGE_JSON,
  VERSIONING_STRATEGY_GIT_TAG_ONLY,
  VERSIONING_STRATEGY_NONE
} = require('../../dist/domain');

describe('VersionAnchor Value Object', () => {
  test('creates minimal package.json content when none exists', () => {
    const anchor = new VersionAnchor({
      strategy: VERSIONING_STRATEGY_PACKAGE_JSON,
      initialVersion: '0.1.0'
    });

    assert.strictEqual(anchor.strategy, VERSIONING_STRATEGY_PACKAGE_JSON);
    assert.strictEqual(anchor.initialVersion, '0.1.0');
    assert.strictEqual(anchor.shouldAutoCreatePackageJson(false), true);
    assert.strictEqual(anchor.shouldAutoCreatePackageJson(true), false);

    const scaffold = anchor.generateMinimalPackageJson('my-awesome-tool');
    const parsed = JSON.parse(scaffold);

    assert.strictEqual(parsed.name, 'my-awesome-tool');
    assert.strictEqual(parsed.version, '0.1.0');
    assert.strictEqual(parsed.private, true);
  });

  test('reports shouldAutoCreatePackageJson = false when strategy is git_tag_only or none', () => {
    const tagOnly = new VersionAnchor({ strategy: VERSIONING_STRATEGY_GIT_TAG_ONLY });
    assert.strictEqual(tagOnly.strategy, VERSIONING_STRATEGY_GIT_TAG_ONLY);
    assert.strictEqual(tagOnly.shouldAutoCreatePackageJson(false), false);

    const none = new VersionAnchor({ strategy: VERSIONING_STRATEGY_NONE });
    assert.strictEqual(none.strategy, VERSIONING_STRATEGY_NONE);
    assert.strictEqual(none.shouldAutoCreatePackageJson(false), false);
  });

  test('reports shouldAutoCreatePackageJson = false when autoCreate is explicitly false', () => {
    const anchor = new VersionAnchor({ autoCreate: false });
    assert.strictEqual(anchor.shouldAutoCreatePackageJson(false), false);
  });

  test('defaults package name if unspecified', () => {
    const anchor = new VersionAnchor();
    const scaffold = anchor.generateMinimalPackageJson();
    const parsed = JSON.parse(scaffold);
    assert.strictEqual(parsed.name, 'agyloop-project');
    assert.strictEqual(parsed.version, '0.1.0');
  });
});
