/**
 * agyloop - summary deviations line (issue #432, TR-39/TR-40)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FilePlanGenerator } = require('../../dist/infrastructure');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(REPO_ROOT, 'templates', 'summary-log.md');

function tempSummary(): { dir: string; summaryPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-summary-deviations-'));
  const summaryPath = path.join(dir, 'CodeLoop Summary.md');
  fs.copyFileSync(TEMPLATE, summaryPath);
  return { dir, summaryPath };
}

const RECORD = {
  id: 'PD-1',
  planSection: '§4.2',
  planLiteral: 'a === 1',
  implementedAssertion: 'a === 2',
  acknowledged: false
};

describe('summary deviations (issue #432)', () => {
  test('SD1 renders a deviations line when records exist', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      assert.strictEqual(
        generator.updateSummaryLog(summaryPath, { planDeviations: [RECORD] }),
        true
      );
      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(summary.includes('- **Plan Deviations:**'));
      assert.ok(summary.includes('PD-1'));
      assert.ok(summary.includes('unacknowledged'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('SD2 removes the line for an empty list', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, { planDeviations: [RECORD] });
      generator.updateSummaryLog(summaryPath, { planDeviations: [] });
      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(!summary.includes('- **Plan Deviations:**'));
      assert.ok(!summary.includes('PD-1'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
