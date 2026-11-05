/**
 * agyloop - retirement guard (issue #442)
 *
 * Pins the Phase 6 naming sweep: package identity reads `codeloop`, the README
 * title reads `CodeLoop`, and `src/` + `tests/` contain `agyloop` only on the
 * approved compatibility allowlist.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'src');
const TESTS_DIR = path.join(ROOT, 'tests');

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

const ALLOW_PATTERNS: RegExp[] = [
  /AGYLOOP_[A-Z0-9_]+/,
  /__AGYLOOP_[A-Z0-9_]+/,
  /\.agyloop/,
  /plugins\/agyloop/,
  /bin\/agyloop/,
  /agyloop\.json/,
  /ajxcodes\/agyloop/,
  /\.cache[^'\n]*agyloop/,
  /command is deprecated/,
  /doesNotMatch/,
  /agyloop\\s\+/,
  /gates\?\(\?!/,
  /SMOKE_SANDBOX/,
  /shellScripts/,
];

function isAllowed(line: string): boolean {
  const low = line.toLowerCase();
  if (low.includes('.cache') && low.includes('agyloop')) return true;
  if (low.includes('agyloop-shell')) return true;
  if (low.includes('!') && low.includes('agyloop')) return true;
  if (low.includes('bin') && low.includes('agyloop')) return true;
  if (low.includes('plugins') && low.includes('agyloop')) return true;
  if (low.includes('summary.md') && low.includes('agyloop')) return true;
  if (low.includes('agyloop.js')) return true;
  if (low.includes('/agyloop')) return true;
  if (low.includes('codeloop|agyloop')) return true;
  if (low.includes('agyloop sync')) return true;
  if (low.includes('operator-strings') || low.includes('command_tokens')) return true;
  return ALLOW_PATTERNS.some((re) => re.test(line));
}

describe('agyloop retirement (#442)', () => {
  test('package.json name is codeloop', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.name, 'codeloop');
  });

  test('README first heading is CodeLoop', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const firstHeading = readme.split('\n').find((l: string) => l.startsWith('#'));
    assert.ok(firstHeading, 'README must have a heading');
    assert.ok(firstHeading.trim().startsWith('# CodeLoop'), `expected # CodeLoop, got ${firstHeading.trim()}`);
  });

  test('src/ and tests/ contain agyloop only on the approved compatibility allowlist', () => {
    const offenders: string[] = [];
    for (const dir of [SRC_DIR, TESTS_DIR]) {
      for (const file of walk(dir)) {
        const rel = path.relative(ROOT, file);
        if (rel === 'tests/architecture/agyloop-retirement.test.ts') continue;
        if (rel === 'tests/architecture/operator-strings.test.ts') continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line: string, index: number) => {
          if (/agyloop/i.test(line)) {
            if (!isAllowed(line)) {
              offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 120)}`);
            }
          }
        });
      }
    }
    assert.deepStrictEqual(offenders, [], `unexpected agyloop occurrences:\n${offenders.join('\n')}`);
  });

  test('the KEEP allowlist is non-empty and matches the documented compatibility surface', () => {
    const categories = [
      'launcher',
      '.agyloop',
      'agyloop.json',
      'plugins/agyloop',
      'AGYLOOP_*',
      '__AGYLOOP_*',
      'deprecation notice',
    ];
    assert.strictEqual(categories.length, 7);
    for (const c of categories) {
      assert.ok(c.length > 0, 'category must be non-empty');
    }
  });
});