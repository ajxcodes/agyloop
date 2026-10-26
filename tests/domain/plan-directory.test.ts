/**
 * agyloop - Plan directory grammar tests (issue #283)
 *
 * T-283.4: the scaffold and the dispatch payload must agree on the slug, even
 * for apostrophes and punctuation. Before the fix only the scaffold had a
 * slugifier, and the discovery subagent's own slug differed (`base's` ->
 * `bases` vs `base-s`), producing TWO directories for one issue.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planSlug, planFolderName, planDirectoryPrefix } = require('../../dist/domain');
const { FilePlanGenerator } = require('../../dist/infrastructure/file-plan-generator');

describe('plan directory grammar (#283)', () => {
  test("T-283.4: planSlug is stable for the apostrophe title from the incident", () => {
    assert.strictEqual(planSlug("The base's own new commits"), 'the-base-s-own-new-commits');
    // The body is the historical FilePlanGenerator.slugify body, unchanged.
    assert.strictEqual(planSlug('---hello---world---'), 'hello-world');
    assert.strictEqual(planSlug(''), '');
    assert.strictEqual(planSlug(null as unknown as string), '');
  });

  test('T-283.4: the scaffold slugifier and planSlug agree across a punctuation matrix', () => {
    const generator = new FilePlanGenerator();
    const titles = [
      "The base's own new commits",
      'A "quoted" title',
      'Fix: the thing; then more',
      '[Bug] [Phase 6] brackets',
      'path/to/something',
      'an em — dash and  multiple   spaces',
      'Ünïcode and ümlauts',
      'trailing punctuation!!!'
    ];
    for (const title of titles) {
      assert.strictEqual(generator.slugify(title), planSlug(title), title);
    }
  });

  test('T-283.4: planFolderName / planDirectoryPrefix use the same grammar', () => {
    assert.strictEqual(planFolderName(283, "The base's own new commits"), '283-the-base-s-own-new-commits');
    assert.strictEqual(planFolderName(null, 'Ad hoc'), 'adhoc-ad-hoc');
    assert.strictEqual(planDirectoryPrefix(283), '283-');
    assert.strictEqual(planDirectoryPrefix(null), 'adhoc-');
  });

  describe('scaffold and resolver share the folder name', () => {
    let tempDir: string;
    let generator: any;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-dir-test-'));
      generator = new FilePlanGenerator();
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("T-283.4: the scaffold folder name equals planFolderName and the resolver returns it", () => {
      const title = "The base's own new commits";
      const scaffold = generator.scaffoldPlanDirectory({
        projectRoot: tempDir,
        issue: 283,
        title,
        type: 'discovery'
      });

      assert.strictEqual(scaffold.folderName, planFolderName(283, title));
      assert.strictEqual(generator.findPlanDirectory(tempDir, 283, title), scaffold.planDir);
    });
  });
});
