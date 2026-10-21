/**
 * agyloop - Shell Quoting Value Object Tests (Domain Layer)
 *
 * The escaper is the ONE place where a value that reaches a shell command
 * string is made safe. These tests pin its semantics and — more importantly —
 * prove that a value survives a REAL /bin/sh byte-for-byte.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const { escapeShellQuote, shellQuote } = require('../../dist/domain');

describe('escapeShellQuote', () => {
  test('leaves a value without single quotes untouched', () => {
    assert.strictEqual(escapeShellQuote('plain'), 'plain');
    assert.strictEqual(escapeShellQuote(''), '');
    assert.strictEqual(escapeShellQuote('phase/6-codeloop'), 'phase/6-codeloop');
  });

  test('turns every single quote into a quoted escape sequence', () => {
    assert.strictEqual(escapeShellQuote("it's"), "it'\\''s");
    assert.strictEqual(escapeShellQuote("'"), "'\\''");
    assert.strictEqual(escapeShellQuote("''"), "'\\'''\\''");
    assert.strictEqual(escapeShellQuote("a'b'c"), "a'\\''b'\\''c");
  });
});

describe('shellQuote', () => {
  test('returns a complete single-quoted word', () => {
    assert.strictEqual(shellQuote('plain'), "'plain'");
    assert.strictEqual(shellQuote(''), "''");
    assert.strictEqual(shellQuote('phase/6-codeloop'), "'phase/6-codeloop'");
  });

  test('escapes the embedded single quote inside the word', () => {
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
  });
});

describe('shellQuote round-trip through a real /bin/sh', () => {
  const POSIX_ONLY = process.platform === 'win32' ? { skip: 'POSIX-only test' } : {};

  const BATTERY = [
    'plain',
    '',
    'backtick `id`',
    'dollar $(id)',
    'semicolon ; id',
    'and && id',
    'pipe | id',
    'redirect > /tmp/agyloop-should-not-exist',
    'double "quote"',
    "single 'quote'",
    'backslash \\ and $HOME',
    'variable ${X}',
    'newline\nhere',
    'tab\there',
    'glob * ? [a-z]',
    'history ! and ~ tilde',
    'subshell (id)',
    'brace {a,b}',
    'the collector branch `phase/6-codeloop`',
    "mixed: it's \"both\" `id` $(id) ; && |"
  ];

  test('delivers every value byte-for-byte', POSIX_ONLY, () => {
    for (const value of BATTERY) {
      const out = execFileSync('/bin/sh', ['-c', "printf '%s' " + shellQuote(value)], {
        encoding: 'utf8'
      });
      assert.strictEqual(out, value, `shellQuote must round-trip ${JSON.stringify(value)}`);
    }
  });

  test('executes nothing while round-tripping the metacharacter battery', POSIX_ONLY, () => {
    const marker = `/tmp/agyloop-shell-quoting-marker-${process.pid}`;
    require('node:fs').rmSync(marker, { force: true });

    for (const value of [`touch ${marker}`, `$(touch ${marker})`, `; touch ${marker}`, `&& touch ${marker}`, `| touch ${marker}`]) {
      const out = execFileSync('/bin/sh', ['-c', "printf '%s' " + shellQuote(value)], {
        encoding: 'utf8'
      });
      assert.strictEqual(out, value);
    }

    assert.ok(
      !require('node:fs').existsSync(marker),
      'no injected command may run while the value is quoted'
    );
  });
});
