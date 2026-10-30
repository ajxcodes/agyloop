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

const { planSlug, planFolderName, planDirectoryPrefix,
  planArtifactFileName,
  planByteLength,
  sanitizePlanTitle,
  assertPlanNameWithinLimits,
  PLAN_DIR_NAME_MAX_BYTES,
  PLAN_FILE_NAME_MAX_BYTES,
  PLAN_NAME_HASH_HEX,
  PLAN_SLUG_MAX_BYTES,
  VALIDATION_FIELD_PLAN_TITLE,
  ValidationError
} = require('../../dist/domain');
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

    // -----------------------------------------------------------------------
    // Issue #364: bounded, deterministic, collision-free plan names.
    // -----------------------------------------------------------------------

    const LONG = 'x'.repeat(372);
    const CJK = `Phase 6 ${'\u4e2d'.repeat(300)}`;
    const plansDirOf = (root: string): string => path.join(root, 'artifacts', 'plans');

    test('T-364.1: planFolderName bounds a 372-char slug and stamps a hash', () => {
      const folder = planFolderName(364, LONG);
      assert.ok(
        planByteLength(folder) <= PLAN_DIR_NAME_MAX_BYTES,
        `${folder} is ${planByteLength(folder)} bytes`
      );
      assert.ok(folder.startsWith('364-'), folder);
      assert.match(folder, /^364-[a-z0-9-]+-[0-9a-f]{8}$/);
    });

    test('T-364.2: the cut lands on a word boundary when one fits', () => {
      const words = Array.from({ length: 60 }, (_, i) => `segment${String.fromCharCode(97 + (i % 26))}`);
      const folder = planFolderName(364, words.join(' '));
      const slug = folder.slice('364-'.length);
      const lastWord = slug.replace(/-[0-9a-f]{8}$/, '').split('-').pop();
      assert.ok(
        words.includes(lastWord as string),
        `the cut must land on a whole source word, got ${lastWord}`
      );
      assert.ok(
        planByteLength(slug) <= PLAN_SLUG_MAX_BYTES + 1 + PLAN_NAME_HASH_HEX,
        `slug is ${planByteLength(slug)} bytes`
      );
    });

    test('T-364.3: two long titles for one issue never share a folder', () => {
      const a = planFolderName(364, LONG);
      const b = planFolderName(364, `${LONG.slice(0, 371)}y`);
      const c = planFolderName(364, CJK);
      assert.notStrictEqual(a, b);
      assert.notStrictEqual(a, c);
      assert.notStrictEqual(b, c);

      // Ad-hoc runs: distinct titles still never collide.
      const adhocA = planFolderName(null, LONG);
      const adhocB = planFolderName(null, `${LONG.slice(0, 371)}y`);
      assert.notStrictEqual(adhocA, adhocB);
      assert.ok(adhocA.startsWith('adhoc-'), adhocA);
    });

    test('T-364.4: the bound is a documented constant, not a magic number', () => {
      assert.strictEqual(PLAN_DIR_NAME_MAX_BYTES, 143);
      const folder = planFolderName(364, 'y'.repeat(101));
      assert.ok(planByteLength(folder) <= PLAN_DIR_NAME_MAX_BYTES);
    });

    test('T-364.5: planArtifactFileName never exceeds PLAN_FILE_NAME_MAX_BYTES', () => {
      for (const title of [CJK, LONG]) {
        const name = planArtifactFileName('implementation', title);
        assert.ok(
          planByteLength(name) <= PLAN_FILE_NAME_MAX_BYTES,
          `${name} is ${planByteLength(name)} bytes`
        );
        assert.ok(name.startsWith('[Implementation] - '), name);
        assert.ok(name.endsWith('.md'), name);
        assert.ok(!name.includes('\uFFFD'), 'no split code point');
        assert.strictEqual(Buffer.from(name, 'utf8').toString('utf8'), name);
      }
    });

    test('T-364.6: sanitizePlanTitle keeps the legacy body', () => {
      assert.strictEqual(sanitizePlanTitle('A "quoted" title'), 'A quoted title');
      assert.strictEqual(sanitizePlanTitle('path/to/something'), 'path to something');
      assert.strictEqual(sanitizePlanTitle('trailing punctuation!!!'), 'trailing punctuation!!!');
    });

    test('T-364.7: assertPlanNameWithinLimits names folder, limit and --title', () => {
      const overFolder = 'f'.repeat(PLAN_DIR_NAME_MAX_BYTES + 1);
      assert.throws(
        () => assertPlanNameWithinLimits({ folderName: overFolder, fileName: 'x.md', title: 't' }),
        (error: any) => {
          assert.ok(error instanceof ValidationError, 'typed');
          assert.strictEqual(error.field, VALIDATION_FIELD_PLAN_TITLE);
          assert.ok(error.message.includes(overFolder), error.message);
          assert.ok(error.message.includes(String(PLAN_DIR_NAME_MAX_BYTES)), error.message);
          assert.ok(error.message.includes('--title'), error.message);
          return true;
        }
      );

      const overFile = `${'g'.repeat(PLAN_FILE_NAME_MAX_BYTES)}.md`;
      assert.throws(
        () => assertPlanNameWithinLimits({ folderName: '364-x', fileName: overFile, title: 't' }),
        (error: any) => {
          assert.ok(error instanceof ValidationError, 'typed');
          assert.strictEqual(error.field, VALIDATION_FIELD_PLAN_TITLE);
          assert.ok(error.message.includes(overFile), error.message);
          assert.ok(error.message.includes(String(PLAN_FILE_NAME_MAX_BYTES)), error.message);
          assert.ok(error.message.includes('--title'), error.message);
          return true;
        }
      );
    });

    test('T-364.8: a 372-char title scaffolds and planDirectoryPrefix finds it', () => {
      const scaffold = generator.scaffoldPlanDirectory({
        projectRoot: tempDir,
        issue: 364,
        title: LONG
      });

      const entries = fs.readdirSync(plansDirOf(tempDir));
      assert.strictEqual(entries.length, 1, JSON.stringify(entries));
      assert.ok(entries[0].startsWith(planDirectoryPrefix(364)), entries[0]);
      assert.strictEqual(entries[0], planFolderName(364, LONG));
      assert.strictEqual(scaffold.folderName, entries[0]);
      assert.ok(planByteLength(entries[0]) <= PLAN_DIR_NAME_MAX_BYTES);
    });

    test('T-364.9: re-entry adopts the bounded folder', () => {
      const first = generator.scaffoldPlanDirectory({
        projectRoot: tempDir,
        issue: 364,
        title: LONG
      });
      const second = generator.scaffoldPlanDirectory({
        projectRoot: tempDir,
        issue: 364,
        title: LONG
      });

      assert.strictEqual(first.directoryCreated, true);
      assert.strictEqual(second.adoptedExisting, true);
      assert.strictEqual(second.planDir, first.planDir);
      assert.strictEqual(fs.readdirSync(plansDirOf(tempDir)).length, 1);
    });

    test('T-364.10: a CJK title writes a bounded artifact and no second folder', () => {
      const scaffold = generator.scaffoldPlanDirectory({
        projectRoot: tempDir,
        issue: 364,
        title: CJK
      });

      const artifacts = fs
        .readdirSync(scaffold.planDir)
        .filter((name: string) => name.startsWith('[Implementation] - '));
      assert.strictEqual(artifacts.length, 1, JSON.stringify(artifacts));
      assert.ok(
        Buffer.byteLength(artifacts[0]) <= PLAN_FILE_NAME_MAX_BYTES,
        `${artifacts[0]} is ${Buffer.byteLength(artifacts[0])} bytes`
      );
      assert.strictEqual(fs.readdirSync(plansDirOf(tempDir)).length, 1);
    });

    test('T-364.11: a failed write leaves no half-scaffolded folder', () => {
      generator.generateSummaryLog = () => {
        throw new Error('boom');
      };
      const folder = path.join(plansDirOf(tempDir), planFolderName(364, LONG));

      assert.throws(() => generator.scaffoldPlanDirectory({
        projectRoot: tempDir,
        issue: 364,
        title: LONG
      }));
      assert.ok(!fs.existsSync(folder), 'the half-scaffolded folder must not survive');
      assert.deepStrictEqual(fs.readdirSync(plansDirOf(tempDir)), []);
    });

    // -----------------------------------------------------------------------
    // Review round 1 (#364): adoption of pre-bound folder names and one shared
    // issue part.
    // -----------------------------------------------------------------------

    test('T-364.12: planDirectoryPrefix shares planFolderName\u2019s issue part', () => {
      // A padded `--issue` used to make the folder `364-x` while adoption
      // looked for `" 364-"`, so the producer could not find its own directory.
      assert.strictEqual(planFolderName(' 364', 'Some title'), '364-some-title');
      assert.strictEqual(planDirectoryPrefix(' 364'), '364-');
      assert.ok(planFolderName(' 364', 'Some title').startsWith(planDirectoryPrefix(' 364')));

      // A pathological value is clamped the same way on both sides.
      const pathological = `  ${'9'.repeat(40)}  `;
      assert.ok(
        planFolderName(pathological, 't').startsWith(planDirectoryPrefix(pathological)),
        `${planFolderName(pathological, 't')} vs ${planDirectoryPrefix(pathological)}`
      );
      assert.strictEqual(planDirectoryPrefix(null), 'adhoc-');
      assert.strictEqual(planDirectoryPrefix('   '), 'adhoc-');
      assert.strictEqual(planDirectoryPrefix(364), '364-');
    });

    test('T-364.13: a pre-#364 over-budget folder is ADOPTED, not refused', () => {
      const root = path.join(tempDir, 'legacy');
      const plansDir = plansDirOf(root);
      // Every plan folder written before the bound is 154-211 bytes. This is
      // the shape the real #364 (183 B) and #359 (211 B) folders have.
      const legacy = `364-${'legacy-folder-'.repeat(13)}`.slice(0, 184);
      assert.strictEqual(planByteLength(legacy), 184);
      assert.ok(planByteLength(legacy) > PLAN_DIR_NAME_MAX_BYTES);
      fs.mkdirSync(path.join(plansDir, legacy), { recursive: true });
      const legacyPlan = path.join(plansDir, legacy, 'implementation_plan.md');
      fs.writeFileSync(legacyPlan, '# Legacy Plan\n\n- **Step 1:** Ship the existing spec.\n', 'utf8');

      const scaffold = generator.scaffoldPlanDirectory({
        projectRoot: root,
        issue: 364,
        title: 'Phase 6 a brand new title'
      });

      assert.strictEqual(scaffold.planDir, path.join(plansDir, legacy));
      assert.strictEqual(scaffold.folderName, legacy);
      assert.strictEqual(scaffold.adoptedExisting, true);
      assert.strictEqual(fs.readdirSync(plansDir).length, 1, 'no second folder');
      assert.match(fs.readFileSync(legacyPlan, 'utf8'), /Ship the existing spec/);
    });
  });
});
