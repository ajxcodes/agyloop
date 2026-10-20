/**
 * agyloop - The ONE `--issue` token grammar (issue #250)
 *
 * Before this module existed, FOUR parsers read the same token and disagreed
 * about what it meant:
 *
 *   1. `IssueNumber.tryFrom()` — digits only; a failure was swallowed to `null`.
 *   2. `Number.parseInt()` in the resolver — took the LEADING digits, so
 *      `999abc` became issue 999.
 *   3. `Number()` in the CLI's `branch-info` — `999abc` became `NaN`.
 *   4. a bare filename template in the file adapter — `999abc` became the
 *      literal FILE `tasks/999abc.json`.
 *
 * The grammar is now STRICT: a token that is not a positive integer is
 * REJECTED, never clamped.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseIssueToken,
  invalidIssueTokenMessage,
  ISSUE_TOKEN_INVALID_MESSAGE
} = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

describe('parseIssueToken — valid tokens', () => {
  const valid: Array<[unknown, number]> = [
    ['250', 250],
    ['#250', 250],
    [250, 250],
    [' 250 ', 250],
    ['  #250  ', 250],
    ['1', 1]
  ];

  for (const [raw, expected] of valid) {
    test(`accepts ${JSON.stringify(raw)} as issue ${expected}`, () => {
      const result = parseIssueToken(raw as any);
      assert.strictEqual(result.kind, 'valid');
      assert.strictEqual((result as any).issue, expected);
    });
  }
});

describe('parseIssueToken — invalid tokens', () => {
  const invalid: unknown[] = ['999abc', 'abc', '25 0', '2.5', '-1', '0', '1e3', NaN, Infinity, -5, 0, 1.5, '#', '#0'];

  for (const raw of invalid) {
    test(`rejects ${String(raw)}`, () => {
      const result = parseIssueToken(raw as any);
      assert.strictEqual(result.kind, 'invalid');
      assert.strictEqual((result as any).message, invalidIssueTokenMessage(raw));
    });
  }
});

describe('parseIssueToken — absent tokens', () => {
  for (const raw of [null, undefined, '', '   ', '\t\n']) {
    test(`treats ${JSON.stringify(raw)} as "nothing named"`, () => {
      assert.strictEqual(parseIssueToken(raw as any).kind, 'absent');
    });
  }
});

describe('the rejection message', () => {
  test('names the offending token', () => {
    const message = invalidIssueTokenMessage('999abc');
    assert.ok(message.includes('999abc'), message);
    assert.ok(message.includes('--issue'), message);
  });

  test('is single-sourced from the domain constant', () => {
    assert.strictEqual(
      invalidIssueTokenMessage('999abc'),
      ISSUE_TOKEN_INVALID_MESSAGE.replace('{raw}', '999abc')
    );
    assert.strictEqual(
      invalidIssueTokenMessage('999abc'),
      "Invalid --issue '999abc'. Expected a positive integer (digits only), e.g. --issue 250."
    );
  });

  test('the invalid result carries the same message', () => {
    const result = parseIssueToken('999abc');
    assert.strictEqual(result.kind, 'invalid');
    assert.strictEqual((result as any).raw, '999abc');
    assert.strictEqual((result as any).message, invalidIssueTokenMessage('999abc'));
  });
});

/**
 * T-B1 (AC B1): ONE grammar, ONE choke point.
 *
 * Four parsers used to read the same `--issue` token and disagreed about what
 * it meant. A static scan over `src/` is the only way to prove that no second
 * parser has crept back: the behaviour tests can only observe the parser that
 * happens to be on the path under test.
 */
describe('no second --issue parser survives in src/ (AC B1)', () => {
  // Comments are stripped first: the modules that DOCUMENT the parsers this
  // change removed necessarily name them, and a doc comment is not a parser.
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  function read(relative: string): string {
    return stripComments(fs.readFileSync(path.join(SRC_DIR, relative), 'utf8'));
  }

  test('the resolver no longer parses the token with parseInt', () => {
    const source = read(path.join('application', 'resolve-task-checkpoint.ts'));

    assert.ok(
      !source.includes('Number.parseInt'),
      'the resolver must use the shared parseIssueToken, not parseInt'
    );
    assert.ok(
      source.includes('parseIssueToken'),
      'the resolver must route the token through the shared grammar'
    );
  });

  test('the CLI no longer parses the token with Number()', () => {
    const source = read(path.join('presentation', 'cli.ts'));

    assert.ok(
      !source.includes('Number(options.issue)'),
      'the CLI must use the shared parseIssueToken, not Number()'
    );
    assert.ok(
      source.includes('parseIssueToken(options.issue)'),
      'the CLI must parse the token exactly once, at the choke point'
    );
  });

  test('the reset use case no longer parses the token with Number()', () => {
    const source = read(path.join('application', 'reset-pipeline.ts'));

    assert.ok(
      !source.includes('Number(options.issue)'),
      'the reset use case must use the shared parseIssueToken, not Number()'
    );
  });

  test('the file adapter never turns a raw token into a filename', () => {
    const source = read(path.join('infrastructure', 'file-state-repository.ts'));

    assert.ok(
      !source.includes('Number(issue)'),
      'forIssue must not coerce an unparsed argument (that produced tasks/NaN.json)'
    );
    assert.ok(
      source.includes('resetTask(issue: number)'),
      'resetTask must take a strictly parsed number'
    );
    assert.ok(
      source.includes('parseIssueToken(issue)'),
      'forIssue must validate through the shared grammar'
    );
  });

  test('the next-action use case no longer uses the lenient IssueNumber.tryFrom for the token', () => {
    const source = read(path.join('application', 'get-next-action.ts'));

    assert.ok(
      !source.includes('IssueNumber.tryFrom(params.issue)'),
      'the fourth parser must be gone'
    );
    assert.ok(source.includes('parseIssueToken(params.issue)'));
  });

  test('no source file parses an --issue token outside the shared grammar', () => {
    const offenders: string[] = [];

    // Only the shapes that parse an ISSUE TOKEN are offenders. `Number.parseInt`
    // on a PR number out of a git log message is a different concern entirely.
    const ISSUE_TOKEN_PARSERS = [
      'Number(options.issue)',
      'Number.parseInt(options.issue',
      'Number.parseInt(issue',
      'parseInt(options.issue',
      'IssueNumber.tryFrom(params.issue)',
      'IssueNumber.tryFrom(options.issue)'
    ];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const relative = path.relative(SRC_DIR, full);
          if (relative === path.join('domain', 'value-objects', 'issue-token.ts')) {
            // The grammar itself documents the parsers it replaced.
            continue;
          }
          if (relative.startsWith('domain' + path.sep)) {
            // The domain owns `IssueNumber`, a VALUE OBJECT: reading a
            // snapshot's issue out of it is not token parsing.
            continue;
          }
          const source = stripComments(fs.readFileSync(full, 'utf8'));
          const hits = ISSUE_TOKEN_PARSERS.filter((pattern) => source.includes(pattern));
          if (hits.length > 0) {
            offenders.push(`${relative} [${hits.join(', ')}]`);
          }
        }
      }
    };

    walk(SRC_DIR);

    assert.deepStrictEqual(offenders, [], `unexpected --issue parsers in: ${offenders.join(', ')}`);
  });
});
