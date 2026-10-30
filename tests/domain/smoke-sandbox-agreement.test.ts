/**
 * agyloop - static ↔ runtime agreement for smoke sandbox paths (issue #364, AC-17; #383)
 *
 * AG-1…AG-5 run the SAME fixtures through both predicates:
 *
 *   - the STATIC verdict: `SmokeProtocol.fromPlan(...).findings` (the rule that
 *     refuses a plan at approval), and
 *   - the RUNTIME verdict: `FileStateRepository.save()` with the real
 *     `isSmokeSandboxPath` guard (`tests/infrastructure/file-state-repository.test.ts`
 *     `SR1` pattern — `HOME` overridden, `NODE_ENV` non-test).
 *
 * WHICH PREDICATE THIS SUITE PINS (issue #383). AG-3 pins guard **rule 1
 * (ESCAPE)**: its cwd resolves inside a `smoke-*` sandbox and its target
 * resolves OUTSIDE it, and the test proves the target is neither under
 * `os.tmpdir()` nor under `artifacts/smoke`, so rules 3/4 cannot be what
 * refused it. The old fixture's fake `HOME` lived under `os.tmpdir()`, so the
 * `..`-escaped target was refused by the RESERVED rule and a regression that
 * accepted every escaped path would have kept it green.
 *
 * The two predicates may legitimately differ. The static rule is lexical and
 * I/O-free: segment folding on the text, no realpath, no symlink resolution,
 * and it raises `sandbox-path` only for a creation it can recognise as
 * sandbox/temp-related. The runtime rule realpath-normalises and applies four
 * ordered rules (ESCAPE, SANDBOX, RESERVED, TEST ROOT). This suite pins
 * agreement on THESE fixtures, not on every possible path.
 *
 * The filesystem is never touched at a path the guard would refuse; only the
 * sandbox dirs a "clean" fixture names (and AG-5's negative control) are
 * created. AG-0 keeps the fixture `HOME` under the real `$HOME`, so the
 * reserved temp root can never be the reason a fixture is refused.
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
  /**
   * The fixture is about guard rule 1 (ESCAPE): its cwd is a sandbox and its
   * target is not. When set, the test proves no OTHER rule could refuse it
   * (issue #383).
   */
  readonly pinsEscapeRule?: boolean;
}

const FENCE = String.fromCharCode(96, 96, 96);

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
    name: 'AG-3: a ..-escaped path out of the sandbox is refused by ESCAPE (#364 6c, #383)',
    body: [
      FENCE + 'bash',
      'cd "$HOME/.cache/agyloop/smoke-364"',
      'mkdir -p ../shared/smoke-364-escape',
      CLI_LINE,
      FENCE
    ],
    cwd: `${HOOK}/.cache/agyloop/smoke-364`,
    created: '../shared/smoke-364-escape',
    clean: false,
    pinsEscapeRule: true
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
let realHome = '';
let originalCwd: () => string;
const savedEnv = new Map<string, string | undefined>();

before(() => {
  // Capture the REAL home BEFORE the env keys are deleted: the fixture HOME is
  // deliberately created under `$HOME`, never under `os.tmpdir()` (issue #383).
  realHome = os.homedir();
  fs.mkdirSync(path.join(realHome, '.cache', 'agyloop'), { recursive: true });
  fakeHome = fs.mkdtempSync(path.join(realHome, '.cache', 'agyloop', 'smoke-383-agreement-'));
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
  test('AG-0: the fixture HOME is under $HOME, never under os.tmpdir() (#383)', () => {
    const tmpRoot = path.resolve(os.tmpdir());
    assert.ok(
      fakeHome.startsWith(path.join(realHome, '.cache', 'agyloop') + path.sep),
      fakeHome
    );
    assert.ok(
      !(fakeHome === tmpRoot || fakeHome.startsWith(tmpRoot + path.sep)),
      `fixture HOME must be outside ${tmpRoot}: ${fakeHome}`
    );
  });

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
      if (fixture.pinsEscapeRule) {
        // Rule 1 (ESCAPE) is the ONLY rule that may refuse this fixture: the
        // target must not be under the reserved temp root or an
        // `artifacts/smoke` path (issue #383).
        const tmpRoot = path.resolve(os.tmpdir());
        assert.ok(
          resolved !== tmpRoot && !resolved.startsWith(tmpRoot + path.sep),
          `AG-3 must not be refused by the reserved temp root: ${resolved}`
        );
        assert.ok(!resolved.includes(`${path.sep}artifacts${path.sep}smoke`), resolved);
      }
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

  test('AG-5: the same escaped target from a cwd outside any sandbox is permitted (#383)', () => {
    // The negative control for AG-3: the refusal is about the SANDBOXED CWD,
    // not about the path string. Same target text, an unsandboxed cwd.
    const outsideCwd = path.join(fakeHome, 'project');
    const escaped = path.resolve(outsideCwd, '../.cache/agyloop/shared/smoke-364-escape');
    fs.mkdirSync(path.join(escaped, '.agyloop'), { recursive: true });
    const repository = new FileStateRepository({
      stateFilePath: path.join(escaped, '.agyloop', 'state.json')
    });
    withRuntime({ home: fakeHome, cwd: outsideCwd }, () => {
      assert.doesNotThrow(
        () => repository.save({ issue: 383, currentStage: 'PLAN', history: [] } as any),
        'an escaped path is only refused when the CWD is sandboxed'
      );
    });
  });
});
