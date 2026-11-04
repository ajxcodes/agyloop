/**
 * agyloop - configuration surface fitness test (#333 AC5)
 *
 * A knob that is declared but never consumed looks functional while doing
 * nothing: `GitConfig.collectorPrefix` / `taskPrefix` were exactly that, and the
 * `phase/` + `feature/` prefixes are domain constants instead. This test keeps
 * the surface honest: no branch-prefix property on `GitConfig`, and no source
 * reference to the retired identifiers.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const CONFIG_PORT = path.join(SRC_DIR, 'ports', 'config-repository.ts');
const RETIRED_IDENTIFIERS = ['collectorPrefix', 'taskPrefix'];

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('configuration surface (#333 AC5)', () => {
  test('CFGS-333-1 GitConfig declares no branch-prefix knob without a consumer (#333 AC5)', () => {
    const offenders: string[] = [];

    const portSource = fs.readFileSync(CONFIG_PORT, 'utf8');
    const gitConfigBlock = portSource.match(/export interface GitConfig \{([\s\S]*?)\n\}/);
    if (!gitConfigBlock) {
      offenders.push('src/ports/config-repository.ts: GitConfig interface not found');
    } else {
      for (const rawLine of gitConfigBlock[1].split('\n')) {
        const property = rawLine.match(/readonly\s+([A-Za-z0-9_]+)\??:/);
        if (property && /Prefix/.test(property[1])) {
          offenders.push(`src/ports/config-repository.ts: GitConfig.${property[1]} is declared`);
        }
      }
    }

    for (const file of walk(SRC_DIR)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line: string, index: number) => {
        for (const identifier of RETIRED_IDENTIFIERS) {
          if (new RegExp(`\\b${identifier}\\b`).test(line)) {
            offenders.push(`${path.relative(path.join(SRC_DIR, '..'), file)}:${index + 1} references ${identifier}`);
          }
        }
      });
    }

    assert.deepStrictEqual(offenders, []);
  });
});
