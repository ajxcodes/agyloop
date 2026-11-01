/**
 * agyloop - `implement` wires the lifecycle warning channel (issue #426, AC7)
 *
 * `RunLifecycleParams.onProgress` is the ONLY channel the #420 refusal teardown
 * writes to, and before this change no call site passed a callback: a retained
 * branch was reported to nobody. The pin is a source contract because the wiring
 * is the whole fix — a behavioural test cannot observe an unreachable callback.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function readDoc(relativePath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

/** The `case '<name>':` arm body, from its label to the next same-indent case. */
function caseSlice(source: string, name: string): string {
  const start = source.indexOf(`\n    case '${name}':`);
  assert.notStrictEqual(start, -1, `the CLI must have a \`case '${name}':\` arm`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\n    case ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('implement wires onProgress to stderr (issue #426 WIRE-426-1)', () => {
  const cli = readDoc(path.join('src', 'presentation', 'cli.ts'));

  test('WIRE-426-1: the implement entry point forwards onProgress to stderr', () => {
    const implement = caseSlice(cli, 'implement');
    assert.match(implement, /onProgress:\s*\(?\s*\w+\s*\)?\s*=>/, implement.slice(0, 400));
    assert.match(implement, /console\.error\(/, 'the warning must reach stderr');

    for (const other of ['plan', 'yolo', 'commit', 'gates']) {
      const slice = caseSlice(cli, other);
      assert.ok(
        !slice.includes('onProgress'),
        `only the implement entry point writes to onProgress; \`${other}\` must not wire it`
      );
    }
  });
});
