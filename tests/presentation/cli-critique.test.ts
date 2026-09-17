/**
 * Tests for CLI critique subcommands and flag parsing
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parseArguments, runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS, EXIT_CODE_FAILURE } = require('../../dist/domain');

describe('CLI Critique Subcommands & Flag Parsing', () => {
  describe('Argument Parsing', () => {
    it('defaults to status subcommand when none provided', () => {
      const { command, options } = parseArguments(['critique']);
      assert.strictEqual(command, 'critique');
      assert.strictEqual(options.critiqueSubcommand, 'status');
      assert.strictEqual(options.force, false);
      assert.strictEqual(options.json, false);
    });

    it('parses critique status with --json', () => {
      const { command, options } = parseArguments(['critique', 'status', '--json']);
      assert.strictEqual(command, 'critique');
      assert.strictEqual(options.critiqueSubcommand, 'status');
      assert.strictEqual(options.json, true);
    });

    it('parses critique install with --force and -f', () => {
      const parsed1 = parseArguments(['critique', 'install', '--force']);
      assert.strictEqual(parsed1.command, 'critique');
      assert.strictEqual(parsed1.options.critiqueSubcommand, 'install');
      assert.strictEqual(parsed1.options.force, true);

      const parsed2 = parseArguments(['critique', 'install', '-f']);
      assert.strictEqual(parsed2.command, 'critique');
      assert.strictEqual(parsed2.options.critiqueSubcommand, 'install');
      assert.strictEqual(parsed2.options.force, true);
    });

    it('parses critique update', () => {
      const { command, options } = parseArguments(['critique', 'update']);
      assert.strictEqual(command, 'critique');
      assert.strictEqual(options.critiqueSubcommand, 'update');
    });
  });

  describe('Dispatcher Execution', () => {
    it('runCli critique status --json outputs parseable JSON payload', async () => {
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        const code = await runCli(['critique', 'status', '--json']);
        assert.strictEqual(code, EXIT_CODE_SUCCESS);

        const parsed = JSON.parse(output.trim());
        assert.ok(parsed.resolution);
        assert.ok(parsed.versionInfo);
        assert.strictEqual(typeof parsed.resolution.isAvailable, 'boolean');
      } finally {
        console.log = originalLog;
      }
    });

    it('runCli critique status outputs human-readable status table', async () => {
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        const code = await runCli(['critique', 'status']);
        assert.strictEqual(code, EXIT_CODE_SUCCESS);
        assert.ok(output.includes('Critique CLI Status'));
        assert.ok(output.includes('Resolution Source'));
        assert.ok(output.includes('Update Available'));
      } finally {
        console.log = originalLog;
      }
    });
  });
});
