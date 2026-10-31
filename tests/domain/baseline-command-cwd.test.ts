/**
 * agyloop - Baseline command cwd-contract detector tests (issue #418)
 *
 * CWD1 - the issue's exact command (`require("./dist/domain")`) is refused as
 *        `./dist`
 * CWD2 - the positive shapes (`./build`, `node dist/`, `--outDir dist`, `cd
 *        dist`) each return their documented label
 * CWD3 - the negative shapes (the documented scratch out-dir, `--outDir
 *        "$HOME/…"`, `./tmp/dist`, `./src/domain`, `ls dist`, a grep mention, a
 *        bare specifier, `./dist-check/…`) return `null`
 * CWD4 - the plan's OWN evidence command returns `null`: the contract applies to
 *        this plan too
 * CWD5 - the match shape: `excerpt` is the normalised command, truncated with
 *        `…` past 160 characters, and two calls return identical results (no
 *        regex `lastIndex` state leak)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { detectWorkspaceBuildOutputCommand } = require('../../dist/domain');

const ISSUE_COMMAND = `node -e 'console.log(JSON.stringify({ok:typeof require("./dist/domain").SmokeProtocol==="function"}))'`;

/** The BL-1 command this plan declares. */
const OWN_EVIDENCE_COMMAND =
  'node -e \'const fs=require("node:fs");console.log(JSON.stringify({distIgnored:/(^|\\n)dist\\/(\\n|$)/.test(fs.readFileSync(".gitignore","utf8"))}))\'';

const SCRATCH_OUT_DIR = 'npx tsc -p tsconfig.json --outDir "$HOME/.cache/agyloop/baseline-418/dist"';
const SCRATCH_COMMAND = `${SCRATCH_OUT_DIR} && node -e 'require(process.env.HOME+"/.cache/agyloop/baseline-418/dist/domain")'`;

describe('detectWorkspaceBuildOutputCommand (issue #418)', () => {
  test('CWD1: the issue command resolves `./dist`', () => {
    const match = detectWorkspaceBuildOutputCommand(ISSUE_COMMAND);

    assert.ok(match, 'the issue command must be refused');
    assert.strictEqual(match.label, './dist');
    assert.strictEqual(match.excerpt, ISSUE_COMMAND);
  });

  test('CWD2: every workspace-relative build-output shape is named', () => {
    const cases: Array<[string, string]> = [
      ['import("./build/domain.js")', './build'],
      ['node ./dist/index.js', './dist'],
      ['node dist/cli.js', 'node dist/'],
      ['npx tsc -p . --outDir ./dist', './dist'],
      ['npx tsc -p . --outDir dist', '--outDir dist'],
      ['npx tsc -p . --outDir=dist/', '--outDir dist'],
      ['cd dist && node index.js', 'cd dist'],
      ['cd build && node index.js', 'cd build'],
      ['cd ./dist && node index.js', './dist'],
      ['ts-node build/probe.ts', 'ts-node build/'],
      ['tsx dist/cli.tsx', 'tsx dist/']
    ];

    for (const [command, label] of cases) {
      const match = detectWorkspaceBuildOutputCommand(command);
      assert.ok(match, `${command} must be refused`);
      assert.strictEqual(match.label, label, `${command} must be named \`${label}\``);
    }
  });

  test('CWD3: the documented scratch form and non-resolution mentions stay allowed', () => {
    const allowed = [
      SCRATCH_COMMAND,
      SCRATCH_OUT_DIR,
      'npx tsc -p . --outDir "$HOME/.cache/agyloop/baseline-418/dist"',
      'npx tsc -p . --outDir ./tmp/dist',
      'node -e \'require("./src/domain")\'',
      'ls dist',
      'grep -rl "dist/" src',
      'node -e \'require("dist/domain")\'',
      'node ./dist-check/probe.js',
      'node src/cli.ts',
      'cd src && node index.js'
    ];

    for (const command of allowed) {
      assert.strictEqual(
        detectWorkspaceBuildOutputCommand(command),
        null,
        `${command} must stay allowed`
      );
    }
  });

  test("CWD4: the plan's own evidence command resolves no build output", () => {
    assert.strictEqual(detectWorkspaceBuildOutputCommand(OWN_EVIDENCE_COMMAND), null);
  });

  test('CWD5: the match shape is normalised, truncated and stateless', () => {
    const padded = `  node   -e   'require("./dist/domain")'  `;
    const first = detectWorkspaceBuildOutputCommand(padded);

    assert.ok(first, 'the padded command must still be refused');
    assert.strictEqual(first.excerpt, `node -e 'require("./dist/domain")'`, 'whitespace is collapsed');
    assert.strictEqual(first.label, './dist');

    const long = `node -e '${'x'.repeat(200)}require("./dist/domain")'`;
    const truncated = detectWorkspaceBuildOutputCommand(long);
    assert.ok(truncated, 'the long command must be refused');
    assert.strictEqual(truncated.excerpt.length, 161, 'the excerpt carries 160 chars plus …');
    assert.ok(truncated.excerpt.endsWith('…'), truncated.excerpt);

    assert.deepStrictEqual(
      detectWorkspaceBuildOutputCommand(ISSUE_COMMAND),
      detectWorkspaceBuildOutputCommand(ISSUE_COMMAND),
      'two consecutive calls must return identical results'
    );

    assert.strictEqual(detectWorkspaceBuildOutputCommand(''), null);
    assert.strictEqual(detectWorkspaceBuildOutputCommand('   '), null);
  });
});
