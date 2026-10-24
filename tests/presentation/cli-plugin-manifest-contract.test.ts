/**
 * agyloop - Plugin manifest <-> CLI contract (issue #276, absorbed into #241)
 *
 * The shipped Antigravity plugin manifest advertised a `gates` subcommand that
 * was removed two phases earlier. Nothing read the manifest, so the drift was
 * invisible to every gate.
 *
 * PM1 - every manifest subcommand resolves to a documented command AND a `case`
 * PM2 - each usage token set equals its registry key set (and is documented)
 * PM3 - `gates`/`gate` appear nowhere in the manifest
 * PM4 - manifest tokens are a subset of CLI_DOCUMENTED_COMMANDS (narrowed N2),
 *       and `resume`/`opencode` are documented
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { CLI_DOCUMENTED_COMMANDS } = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_FILE = path.join(PROJECT_ROOT, 'plugin.json');
const CLI_SOURCE = path.join(PROJECT_ROOT, 'src', 'presentation', 'cli.ts');
const CONSTANTS_SOURCE = path.join(PROJECT_ROOT, 'src', 'domain', 'constants.ts');

function loadManifest(): any {
  return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
}

/** The command names the CLI switch can resolve (constants + string literal cases). */
function cliCaseNames(): Set<string> {
  const cliSource = fs.readFileSync(CLI_SOURCE, 'utf8');
  const constantsSource = fs.readFileSync(CONSTANTS_SOURCE, 'utf8');

  const constants = new Map<string, string>();
  const constantPattern = /export const (COMMAND_[A-Z_]+)\s*=\s*'([^']+)'/g;
  let constantMatch: RegExpExecArray | null;
  while ((constantMatch = constantPattern.exec(constantsSource)) !== null) {
    constants.set(constantMatch[1], constantMatch[2]);
  }

  const cases = new Set<string>();
  const casePattern = /case\s+(?:'([^']+)'|([A-Z][A-Z0-9_]*))\s*:/g;
  let caseMatch: RegExpExecArray | null;
  while ((caseMatch = casePattern.exec(cliSource)) !== null) {
    if (caseMatch[1]) {
      cases.add(caseMatch[1]);
    } else if (caseMatch[2] && constants.has(caseMatch[2])) {
      cases.add(constants.get(caseMatch[2])!);
    }
  }
  return cases;
}

describe('Plugin manifest <-> CLI contract (issue #276)', () => {
  test('PM1: every manifest subcommand resolves in the CLI', () => {
    const manifest = loadManifest();
    const cases = cliCaseNames();

    for (const [commandName, definition] of Object.entries<any>(manifest.commands)) {
      for (const subcommand of Object.keys(definition.subcommands || {})) {
        assert.ok(
          CLI_DOCUMENTED_COMMANDS.includes(subcommand),
          `plugin.json command '${commandName}' advertises '${subcommand}', which is not a documented CLI command`
        );
        assert.ok(
          cases.has(subcommand),
          `plugin.json command '${commandName}' advertises '${subcommand}', which has no case in src/presentation/cli.ts`
        );
      }
    }
  });

  test('PM2: each usage token set equals its registry key set', () => {
    const manifest = loadManifest();

    for (const [commandName, definition] of Object.entries<any>(manifest.commands)) {
      const usage = String(definition.usage || '');
      const bracket = usage.match(/\[([^\]]+)\]/);
      assert.ok(bracket, `command '${commandName}' must declare its usage tokens in brackets`);

      const usageTokens = bracket![1]
        .split('|')
        .map((token: string) => token.trim())
        .filter(Boolean)
        .sort();
      const registryKeys = Object.keys(definition.subcommands || {}).sort();

      assert.deepStrictEqual(
        usageTokens,
        registryKeys,
        `command '${commandName}' usage '${usage}' disagrees with its registry`
      );

      for (const token of usageTokens) {
        assert.ok(
          CLI_DOCUMENTED_COMMANDS.includes(token),
          `usage token '${token}' of command '${commandName}' is not a documented CLI command`
        );
      }
    }
  });

  test('PM3: gates/gate appear nowhere in the command registries or usage strings', () => {
    const manifest = loadManifest();

    for (const [commandName, definition] of Object.entries<any>(manifest.commands)) {
      const usage = String(definition.usage || '');
      assert.strictEqual(
        /\bgates?\b/.test(usage),
        false,
        `command '${commandName}' still advertises gate/gates in its usage string`
      );

      const subcommandKeys = Object.keys(definition.subcommands || {});
      for (const key of subcommandKeys) {
        assert.ok(!/^gates?$/.test(key), `command '${commandName}' still registers '${key}'`);
      }
    }
  });

  test('PM4: manifest tokens are a subset of the documented commands, and resume/opencode are documented', () => {
    const manifest = loadManifest();
    const tokens = new Set<string>();

    for (const definition of Object.values<any>(manifest.commands)) {
      for (const subcommand of Object.keys(definition.subcommands || {})) {
        tokens.add(subcommand);
      }
    }

    for (const token of tokens) {
      assert.ok(
        CLI_DOCUMENTED_COMMANDS.includes(token),
        `manifest token '${token}' is not in CLI_DOCUMENTED_COMMANDS`
      );
    }

    assert.ok(CLI_DOCUMENTED_COMMANDS.includes('resume'), '`resume` must be documented');
    assert.ok(CLI_DOCUMENTED_COMMANDS.includes('opencode'), '`opencode` must be documented');
  });
});
