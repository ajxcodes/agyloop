const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  Stage,
  IssueNumber,
  ModelTier,
  SubagentRole,
  ToolWhitelist,
  Ecosystem,
  VerificationCommandSet,
  ValidationError,
  PhysicalWriteViolationError,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  MODE_STANDARD,
  MODE_YOLO,
  TIER_PRO,
  TIER_FLASH,
  TIER_FLASH_LITE,
  TIER_INHERIT,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  ECOSYSTEM_NODE,
  ECOSYSTEM_GO,
  ECOSYSTEM_UNKNOWN
} = require('../../dist/domain');

describe('Domain Value Objects (Pure)', () => {
  describe('Stage Value Object', () => {
    test('creates valid stages and validates invariants', () => {
      const stage = new Stage(STAGE_INITIALIZED);
      assert.strictEqual(stage.value, STAGE_INITIALIZED);
      assert.strictEqual(stage.toString(), STAGE_INITIALIZED);

      const plan = new Stage('plan');
      assert.strictEqual(plan.value, STAGE_PLAN);
    });

    test('throws ValidationError on invalid stage names', () => {
      assert.throws(() => new Stage(''), ValidationError);
      assert.throws(() => new Stage('NOT_A_REAL_STAGE'), ValidationError);
      assert.throws(() => new Stage(null as unknown as string), ValidationError);
    });

    test('enforces transition rules between stages', () => {
      const plan = new Stage(STAGE_PLAN);
      const approval = new Stage(STAGE_APPROVAL);
      const implement = new Stage(STAGE_IMPLEMENT);

      assert.strictEqual(plan.canTransitionTo(approval, MODE_STANDARD), true);
      assert.strictEqual(plan.canTransitionTo(implement, MODE_STANDARD), false);
      assert.strictEqual(plan.canTransitionTo(implement, MODE_YOLO), true);
    });

    test('equals compares identity by value', () => {
      const s1 = new Stage(STAGE_DISCOVERY);
      const s2 = new Stage('discovery');
      const s3 = new Stage(STAGE_PLAN);

      assert.strictEqual(s1.equals(s2), true);
      assert.strictEqual(s1.equals(s3), false);
      assert.strictEqual(s1.equals(null), false);
    });
  });

  describe('IssueNumber Value Object', () => {
    test('accepts valid positive integers as number or string', () => {
      const num1 = new IssueNumber(42);
      assert.strictEqual(num1.value, 42);
      assert.strictEqual(num1.toString(), '42');

      const num2 = new IssueNumber('101');
      assert.strictEqual(num2.value, 101);

      assert.strictEqual(num1.equals(new IssueNumber(42)), true);
      assert.strictEqual(num1.equals(num2), false);
    });

    test('rejects zero, negative numbers, floats, and non-numeric strings', () => {
      assert.throws(() => new IssueNumber(0), ValidationError);
      assert.throws(() => new IssueNumber(-5), ValidationError);
      assert.throws(() => new IssueNumber(3.14), ValidationError);
      assert.throws(() => new IssueNumber('abc'), ValidationError);
      assert.throws(() => new IssueNumber('12a'), ValidationError);
      assert.throws(() => new IssueNumber(''), ValidationError);
    });

    test('tryFrom safely parses or returns null', () => {
      assert.strictEqual(IssueNumber.tryFrom(null), null);
      assert.strictEqual(IssueNumber.tryFrom(''), null);
      assert.strictEqual(IssueNumber.tryFrom('invalid'), null);
      const parsed = IssueNumber.tryFrom(77);
      assert.ok(parsed !== null);
      assert.strictEqual(parsed!.value, 77);
    });
  });

  describe('ModelTier Value Object', () => {
    test('accepts valid model tiers', () => {
      assert.strictEqual(new ModelTier(TIER_PRO).value, TIER_PRO);
      assert.strictEqual(new ModelTier(TIER_FLASH).value, TIER_FLASH);
      assert.strictEqual(new ModelTier(TIER_FLASH_LITE).value, TIER_FLASH_LITE);
      assert.strictEqual(new ModelTier(TIER_INHERIT).value, TIER_INHERIT);

      assert.strictEqual(ModelTier.pro().getDefaultApiModel(), 'gemini-2.5-pro');
      assert.strictEqual(ModelTier.flash().getDefaultApiModel(), 'gemini-3.5-flash');
      assert.strictEqual(ModelTier.flashLite().getDefaultApiModel(), 'gemini-3.5-flash-lite');
      assert.strictEqual(ModelTier.inherit().getDefaultApiModel(), 'inherit');
    });

    test('rejects invalid model tiers', () => {
      assert.throws(() => new ModelTier('gpt-4'), ValidationError);
      assert.throws(() => new ModelTier(''), ValidationError);
    });
  });

  describe('SubagentRole Value Object', () => {
    test('accepts valid subagent roles', () => {
      assert.strictEqual(new SubagentRole(ROLE_PLANNER).value, ROLE_PLANNER);
      assert.strictEqual(new SubagentRole(ROLE_IMPLEMENTER).value, ROLE_IMPLEMENTER);
      assert.strictEqual(new SubagentRole(ROLE_GATE).value, ROLE_GATE);
      assert.strictEqual(new SubagentRole(ROLE_REVIEWER).value, ROLE_REVIEWER);

      assert.strictEqual(SubagentRole.planner().equals(new SubagentRole('PLANNER')), true);
    });

    test('rejects unrecognized roles', () => {
      assert.throws(() => new SubagentRole('architect'), ValidationError);
      assert.throws(() => new SubagentRole(''), ValidationError);
    });
  });

  describe('ToolWhitelist Value Object', () => {
    test('enforces tool permissions and reports write tools', () => {
      const readWhitelist = ToolWhitelist.readOnly();
      assert.strictEqual(readWhitelist.isAllowed('view_file'), true);
      assert.strictEqual(readWhitelist.isAllowed('grep_search'), true);
      assert.strictEqual(readWhitelist.isAllowed('run_command'), false);
      assert.strictEqual(readWhitelist.hasForbiddenWriteTools(), false);

      readWhitelist.assertAllowed('view_file');
      assert.throws(
        () => readWhitelist.assertAllowed('write_to_file'),
        PhysicalWriteViolationError
      );
    });

    test('detects presence of modifying tools in custom whitelist', () => {
      const unsafeList = ToolWhitelist.custom(['view_file', 'write_to_file']);
      assert.strictEqual(unsafeList.hasForbiddenWriteTools(), true);
    });

    test('ToolWhitelist.implementation() includes all read and write tools', () => {
      const implWhitelist = ToolWhitelist.implementation();
      assert.strictEqual(implWhitelist.isAllowed('view_file'), true);
      assert.strictEqual(implWhitelist.isAllowed('write_to_file'), true);
      assert.strictEqual(implWhitelist.isAllowed('replace_file_content'), true);
      assert.strictEqual(implWhitelist.isAllowed('run_command'), true);
      assert.strictEqual(implWhitelist.hasForbiddenWriteTools(), true);
    });

    test('rejects non-array or empty tool inputs', () => {
      assert.throws(() => new ToolWhitelist(null as unknown as string[]), ValidationError);
      assert.throws(() => new ToolWhitelist(['view_file', '']), ValidationError);
    });
  });

  describe('Ecosystem Value Object', () => {
    test('creates valid ecosystem and validates invariants', () => {
      const eco = new Ecosystem({
        type: ECOSYSTEM_NODE,
        markerFiles: ['package.json', 'pnpm-lock.yaml'],
        packageManager: 'pnpm',
        confidence: 0.95,
        priority: 1
      });

      assert.strictEqual(eco.type, ECOSYSTEM_NODE);
      assert.strictEqual(eco.packageManager, 'pnpm');
      assert.strictEqual(eco.hasMarker('package.json'), true);
      assert.strictEqual(eco.hasMarker('nonexistent'), false);
      assert.strictEqual(eco.isNode(), true);
      assert.strictEqual(eco.isGo(), false);
      assert.strictEqual(eco.toString(), 'node (pnpm)');
    });

    test('validates equality across instances', () => {
      const e1 = new Ecosystem({ type: ECOSYSTEM_GO, markerFiles: ['go.mod'] });
      const e2 = new Ecosystem({ type: ECOSYSTEM_GO, markerFiles: ['go.mod'] });
      const e3 = new Ecosystem({ type: ECOSYSTEM_NODE, markerFiles: ['package.json'] });

      assert.strictEqual(e1.equals(e2), true);
      assert.strictEqual(e1.equals(e3), false);
      assert.strictEqual(e1.equals(null), false);
    });

    test('rejects invalid ecosystem types and invalid confidences', () => {
      assert.throws(() => new Ecosystem({ type: 'not-a-real-ecosystem' }), ValidationError);
      assert.throws(() => new Ecosystem({ type: ECOSYSTEM_NODE, confidence: 2.0 }), ValidationError);
      assert.throws(() => new Ecosystem({ type: ECOSYSTEM_NODE, markerFiles: [''] }), ValidationError);
    });

    test('creates unknown ecosystem safely', () => {
      const unk = Ecosystem.unknown();
      assert.strictEqual(unk.type, ECOSYSTEM_UNKNOWN);
      assert.strictEqual(unk.isUnknown(), true);
      assert.strictEqual(unk.confidence, 0);
    });
  });

  describe('VerificationCommandSet Value Object', () => {
    test('validates valid command set and provides helper methods', () => {
      const set = new VerificationCommandSet([
        { id: 'typecheck', label: 'Typecheck', command: 'npm run typecheck' },
        { id: 'test', label: 'Tests', command: 'npm test' },
        { id: 'playwright', label: 'Playwright E2E', command: 'npx playwright test' }
      ]);

      assert.strictEqual(set.isEmpty(), false);
      assert.strictEqual(set.size(), 3);
      assert.strictEqual(set.hasBuild(), true);
      assert.strictEqual(set.hasTest(), true);
      assert.strictEqual(set.hasE2E(), true);
      assert.deepStrictEqual(set.getCommandStrings(), [
        'npm run typecheck',
        'npm test',
        'npx playwright test'
      ]);
      assert.strictEqual(set.get('typecheck')?.command, 'npm run typecheck');
    });

    test('rejects duplicate command IDs and invalid command definitions', () => {
      assert.throws(
        () =>
          new VerificationCommandSet([
            { id: 'cmd', label: 'Label 1', command: 'echo 1' },
            { id: 'cmd', label: 'Label 2', command: 'echo 2' }
          ]),
        ValidationError
      );

      assert.throws(
        () =>
          new VerificationCommandSet([
            { id: '', label: 'Label 1', command: 'echo 1' }
          ]),
        ValidationError
      );

      assert.throws(
        () =>
          new VerificationCommandSet([
            { id: 'c1', label: 'L1', command: '' }
          ]),
        ValidationError
      );
    });

    test('creates default and empty command sets', () => {
      const empty = VerificationCommandSet.empty();
      assert.strictEqual(empty.isEmpty(), true);
      assert.strictEqual(empty.size(), 0);

      const def = VerificationCommandSet.default();
      assert.strictEqual(def.isEmpty(), false);
      assert.strictEqual(def.hasBuild(), true);
      assert.strictEqual(def.hasTest(), true);
    });
  });
});
