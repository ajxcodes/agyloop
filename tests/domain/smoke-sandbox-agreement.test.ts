/**
 * agyloop - static ↔ runtime agreement for smoke sandbox paths (issue #364, AC-17)
 *
 * AG-1…AG-4 run the SAME four fixtures through both predicates:
 *
 *   - the STATIC verdict: `SmokeProtocol.fromPlan(...).findings` (the rule that
 *     refuses a plan at approval), and
 *   - the RUNTIME verdict: `FileStateRepository.save()` with the real
 *     `isSmokeSandboxPath` guard (`tests/infrastructure/file-state-repository.test.ts`
 *     `SR1` pattern — `HOME` overridden, `NODE_ENV` non-test).
 *
 * They must agree: a clean plan is a permitted state write, a flagged plan is
 * a refused one. The filesystem is never touched at a path the guard would
 * refuse; only the sandbox dirs a "clean" fixture names are created.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SmokeProtocol,
  StateStorageError,
  MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST
} = require('../../dist/domain');
const { FileStateRepository } = require('../../dist/infrastructure/file-state-repository');

const SMOKE_HEADING = '## 6. Manual Smoke Test Protocol';
const CLI_LINE = 'node bin/codeloop.js transition --issue 364';
const HOOK = '$HOME';

function planOf(lines: string[]): string {
  return ['# Plan', '', SMOKE_HEADING, '', ...lines, ''].join('\n');
}

interface Fixture {
  readonly name: string;
  readonly body: readonly string[];
  /** The directory the command actually runs in, as written. */
  readonly cwd: string;
  /** The created path, relative to `cwd` (may contain `..`). */
  readonly created: string;
  readonly clean: boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'AG-1: a tracked cd into the sandbox makes a relative mkdir permitted (#364 6a)',
    body: [
      '```bash',
      'SANDBOX="$HOME/.cache/agyloop/smoke-364/pause"',
      'cd "$SANDBOX"',
      'mkdir -p artifacts/plans/364-smoke',
      CLI_LINE,
      '```'
    ],
    cwd: `${HOOK}/.cache/agyloop/smoke-364/pause`,
    created: 'artifacts/plans/364-smoke',
    clean: true
  },
  {
    name: 'AG-2: a relative mktemp under the sandbox root is permitted (#364 6b)',
    body: [
      '```bash',
      'cd "$HOME/.cache/agyloop"',
      'SBX="$(mktemp -d smoke-364-XXXXXX)"',
      CLI_LINE,
      '```'
    ],
    cwd: `${HOOK}/.cache/agyloop`,
    created: 'smoke-364-XXXXXX',
    clean: true
  },
  {
    name: 'AG-3: a ..-escaped path is refused (#364 6c)',
    body: [
      '```bash',
      'SBX="$HOME/.cache/agyloop/smoke-364/../../../tmp/evil"',
      CLI_LINE,
      '```'
    ],
    cwd: `${HOOK}/.cache/agyloop`,
    created: '.cache/agyloop/smoke-364/../../../tmp/evil',
    clean: false
  },
  {
    name: 'AG-4: an unanchored relative path is refused (#359 SP15)',
    body: ['```bash', 'mkdir -p artifacts/smoke359', CLI_LINE, '```'],
    cwd: `${HOOK}/work`,
    created: 'artifacts/smoke359',
    clean: false
  }
];

let fakeHome = '';
let originalCwd: () => string;
const savedEnv = new Map<string, string | undefined>();

before(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-sandbox-agreement-'));
  originalCwd = process.cwd;
  for (const key of ['NODE_ENV', 'NODE_TEST_CONTEXT', 'HOME']) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

after(() => {
  process.cwd = originalCwd;
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

/** Runs `fn` with `HOME`, `cwd` and non-test mode set for the guard. */
function withRuntime(env: { readonly home: string; readonly cwd: string }, fn: () => void): void {
  const previousHome = process.env.HOME;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.NODE_ENV = 'production';
  process.env.HOME = env.home;
  process.cwd = () => env.cwd;
  try {
    fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    process.cwd = originalCwd;
  }
}

const isSmokeError = (err: any): boolean =>
  err instanceof StateStorageError && err.message === MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST;

describe('smoke sandbox: static and runtime agree (#364 AC-17)', () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const markdown = planOf([...fixture.body]);
      const staticFindings = SmokeProtocol.fromPlan(markdown).findings.filter(
        (finding: any) => finding.rule === 'sandbox-path'
      );
      assert.strictEqual(
        staticFindings.length === 0,
        fixture.clean,
        `static verdict disagrees with the fixture: ${JSON.stringify(staticFindings)}`
      );

      const runtimeCwd = fixture.cwd.replace(HOOK, fakeHome);
      const resolved = path.resolve(runtimeCwd, fixture.created);
      if (fixture.clean) {
        fs.mkdirSync(resolved, { recursive: true });
      }
      const stateFilePath = path.join(resolved, '.agyloop', 'state.json');
      const repository = new FileStateRepository({ stateFilePath });

      withRuntime({ home: fakeHome, cwd: runtimeCwd }, () => {
        const save = (): void => {
          repository.save({ issue: 364, currentStage: 'PLAN', history: [] } as any);
        };
        if (fixture.clean) {
          assert.doesNotThrow(save, 'the runtime guard must permit a clean sandbox path');
        } else {
          assert.throws(save, isSmokeError, 'the runtime guard must refuse a flagged path');
        }
      });
    });
  }
});
