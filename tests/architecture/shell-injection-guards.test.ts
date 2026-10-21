/**
 * agyloop - Shell Injection Fitness Guards (#262)
 *
 * Three coarse, deliberately structural rules that keep the SHAPE of issue
 * #262 from coming back:
 *
 * - G1: the double-quote escaping idiom (`.replace(/"/g, …)`) is banned — it is
 *   what made the comment body "look quoted" while it stayed executable.
 * - G2: free text never reaches a shell string in the GitHub adapter — the four
 *   free-text methods must use the argv path.
 * - G3: the escaper is SHARED — one definition, promoted to the domain layer,
 *   imported by both the application layer and the adapter.
 *
 * These read SOURCE TEXT, not runtime behaviour, so they are stable across
 * refactors and never depend on a network call.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const GATEWAY_FILE = path.join(SRC_DIR, 'infrastructure', 'cli-github-gateway.ts');
const SHELL_QUOTING_FILE = path.join(SRC_DIR, 'domain', 'value-objects', 'shell-quoting.ts');

function getSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getSourceFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Extracts the body of a method: from `public <name>(` up to the next
 * `\n  public ` (or the end of the class).
 */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`public ${name}(`);
  assert.ok(start !== -1, `method ${name} must exist in the gateway`);
  const rest = source.slice(start);
  const next = rest.indexOf('\n  public ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('Shell injection fitness guards (#262)', () => {
  test('G1: no source file escapes a double quote — the idiom that hid the defect', () => {
    const offenders: string[] = [];
    for (const file of getSourceFiles(SRC_DIR)) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('.replace(/"/g')) {
        offenders.push(path.relative(PROJECT_ROOT, file));
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `the double-quote escaping idiom is banned (it leaves backticks and $() live): ${offenders.join(', ')}`
    );
  });

  test('G2: the free-text gateway methods use the argv path, never a shell string', () => {
    const source = fs.readFileSync(GATEWAY_FILE, 'utf8');
    const freeTextMethods = ['commentOnIssue', 'applyLabels', 'createPullRequest', 'findPullRequest'];

    for (const name of freeTextMethods) {
      const body = methodBody(source, name);
      assert.ok(
        !body.includes('runGh('),
        `${name} must not build a shell command — free text must travel as argv`
      );
      assert.ok(body.includes('runGhArgs('), `${name} must hand its arguments to runGhArgs`);
    }
  });

  test('G3: the escaper is shared — one definition, promoted to the domain layer', () => {
    assert.ok(
      fs.existsSync(SHELL_QUOTING_FILE),
      'src/domain/value-objects/shell-quoting.ts must exist'
    );

    const shellQuoting = fs.readFileSync(SHELL_QUOTING_FILE, 'utf8');
    assert.ok(
      shellQuoting.includes('export function escapeShellQuote'),
      'the shared module must export escapeShellQuote'
    );
    assert.ok(
      shellQuoting.includes('export function shellQuote'),
      'the shared module must export shellQuote'
    );

    const domainIndex = fs.readFileSync(path.join(SRC_DIR, 'domain', 'index.ts'), 'utf8');
    assert.ok(
      domainIndex.includes("export * from './value-objects/shell-quoting'"),
      'the domain layer must re-export the shared escaper'
    );

    // Exactly ONE definition of the escaper in the whole source tree.
    const definitions: string[] = [];
    for (const file of getSourceFiles(SRC_DIR)) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('const escapeShellQuote')) {
        definitions.push(path.relative(PROJECT_ROOT, file));
      }
    }
    assert.deepStrictEqual(
      definitions,
      [],
      `escapeShellQuote must be defined once, in the shared module — found a local definition in: ${definitions.join(', ')}`
    );

    // The application layer imports the shared one.
    const executeCommit = fs.readFileSync(path.join(SRC_DIR, 'application', 'execute-commit.ts'), 'utf8');
    assert.ok(
      /import\s*\{[^}]*escapeShellQuote[^}]*\}\s*from\s*'\.\.\/domain'/.test(executeCommit),
      'execute-commit.ts must import escapeShellQuote from ../domain'
    );

    // The adapter imports the shared one AND never interpolates the repo raw.
    const gateway = fs.readFileSync(GATEWAY_FILE, 'utf8');
    assert.ok(
      /import\s*\{[^}]*shellQuote[^}]*\}\s*from\s*'\.\.\/domain'/.test(gateway),
      'cli-github-gateway.ts must import shellQuote from ../domain'
    );
    assert.ok(
      !gateway.includes('--repo ${repo}'),
      'the repo slug must never be interpolated raw into a shell string'
    );
  });
});
