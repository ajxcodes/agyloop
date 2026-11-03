const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { parseArguments } = require('../dist/presentation');
const {
  evaluateStaleDist,
  commandFromArgv,
  wantsHelpOrVersion,
  hasCommitAfter,
  writeBuildStamp,
  detectStaleDist,
  VALUE_FLAGS,
} = require('../bin/stale-dist.js');

interface FixtureOptions {
  stale?: boolean;
  git?: 'dir' | 'file' | 'none';
  stamp?: 'match' | 'mismatch' | 'preserved';
}

interface Fixture {
  dir: string;
  sentinel: string;
  gitLog: string;
  stub: string;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-stale-guard-'));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist', 'presentation'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'stub'), { recursive: true });
  for (const name of ['codeloop.js', 'agyloop.js', 'stale-dist.js']) {
    fs.copyFileSync(path.join(ROOT, 'bin', name), path.join(dir, 'bin', name));
  }
  fs.writeFileSync(
    path.join(dir, 'dist', 'presentation', 'cli.js'),
    "const fs=require('node:fs');" +
      "const {execFileSync}=require('node:child_process');" +
      "fs.writeFileSync(process.env.SENTINEL,'dist-loaded');" +
      "function main(){execFileSync('git',['status'],{stdio:'ignore'});" +
      "console.log('STUB-SUCCESS: the compiled CLI ran');return Promise.resolve();}" +
      "module.exports={main,parseArguments:()=>({command:null,options:{},unknownFlags:[]})," +
      "runCli:()=>Promise.resolve(0)};" +
      "if(require.main===module){main();}"
  );
  fs.writeFileSync(path.join(dir, 'src', 'x.ts'), 'export const x = 1;\n');
  const past = new Date(Date.now() - 120_000);
  const now = new Date();
  fs.utimesSync(
    path.join(dir, 'dist', 'presentation', 'cli.js'),
    options.stale === false ? now : past,
    options.stale === false ? now : past
  );
  fs.utimesSync(
    path.join(dir, 'src', 'x.ts'),
    options.stale === false ? past : now,
    options.stale === false ? past : now
  );
  if (options.stamp) {
    writeBuildStamp(dir);
    if (options.stamp !== 'match') {
      fs.appendFileSync(path.join(dir, 'src', 'x.ts'), 'export const y = 2;\n');
    }
    if (options.stamp === 'preserved') {
      // A preserved-timestamp unpack: the content changed, the mtime did not.
      fs.utimesSync(path.join(dir, 'src', 'x.ts'), past, past);
    }
  }
  if (options.git === 'file') {
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nowhere\n');
  } else if (options.git !== 'none') {
    fs.mkdirSync(path.join(dir, '.git'));
  }
  const gitStub = path.join(dir, 'stub', 'git');
  fs.writeFileSync(gitStub, '#!/bin/sh\necho "git $*" >> "$GIT_LOG"\n', { mode: 0o755 });
  return {
    dir,
    sentinel: path.join(dir, 'sentinel'),
    gitLog: path.join(dir, 'git.log'),
    stub: path.join(dir, 'stub'),
  };
}

function spawnLauncher(fixture: Fixture, launcher: string, argv: string[]) {
  return spawnSync(process.execPath, [path.join(fixture.dir, 'bin', launcher), ...argv], {
    cwd: fixture.dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${fixture.stub}${path.delimiter}${process.env.PATH ?? ''}`,
      SENTINEL: fixture.sentinel,
      GIT_LOG: fixture.gitLog,
    },
  });
}

function assertRefused(
  fixture: Fixture,
  res: { status: number | null; stdout: string; stderr: string },
  command: string
) {
  assert.strictEqual(res.status, 1, `Expected exit 1 for '${command}':\n${res.stdout}\n${res.stderr}`);
  assert.ok(res.stderr.includes('npm run build'), `Refusal must name 'npm run build':\n${res.stderr}`);
  assert.ok(
    res.stderr.includes(`Refusing to run '${command}'`),
    `Refusal must name '${command}':\n${res.stderr}`
  );
  assert.ok(!res.stderr.includes('Notice:'), `Refusal must replace the notice:\n${res.stderr}`);
  assert.strictEqual(fs.existsSync(fixture.sentinel), false, 'dist/presentation/cli.js must not load');
  assert.strictEqual(fs.existsSync(fixture.gitLog), false, 'no git command may run');
}

describe('Stale build refusal', () => {
  test("refuses sync on a stale source checkout before dist loads (AC1)", () => {
    const fixture = makeFixture();
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['sync']);
      assertRefused(fixture, res, 'sync');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('refuses sync --dry-run on a stale source checkout (AC1)', () => {
    const fixture = makeFixture();
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['sync', '--dry-run']);
      assertRefused(fixture, res, 'sync');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('refuses release on a stale source checkout before dist loads (AC2)', () => {
    const fixture = makeFixture();
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['release', 'phase/6-codeloop']);
      assertRefused(fixture, res, 'release');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('refuses commit on a stale source checkout before dist loads (AC2)', () => {
    const fixture = makeFixture();
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['commit']);
      assertRefused(fixture, res, 'commit');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('runs read-only commands on a stale source checkout with the notice (AC3)', () => {
    const fixture = makeFixture();
    try {
      for (const argv of [['next'], ['status'], ['triage', 'list']]) {
        const res = spawnLauncher(fixture, 'codeloop.js', argv);
        assert.strictEqual(res.status, 0, `'${argv.join(' ')}' must succeed:\n${res.stderr}`);
        assert.ok(
          res.stderr.includes('Notice: src/ contains modifications newer than dist/'),
          `'${argv.join(' ')}' must keep the notice:\n${res.stderr}`
        );
        assert.ok(
          res.stdout.includes('STUB-SUCCESS'),
          `'${argv.join(' ')}' must run the command body:\n${res.stdout}`
        );
        assert.ok(fs.existsSync(fixture.sentinel), 'dist must load for a read-only command');
        fs.rmSync(fixture.sentinel, { force: true });
      }
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('runs --help and --version on a stale source checkout (AC3)', () => {
    const fixture = makeFixture();
    try {
      for (const argv of [['--help'], ['--version'], ['release', '--help']]) {
        const res = spawnLauncher(fixture, 'codeloop.js', argv);
        assert.strictEqual(res.status, 0, `'${argv.join(' ')}' must succeed:\n${res.stderr}`);
        assert.ok(fs.existsSync(fixture.sentinel), `'${argv.join(' ')}' must load dist`);
        fs.rmSync(fixture.sentinel, { force: true });
      }
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('runs sync when dist/ is newer than src/ (no false refusal)', () => {
    const fixture = makeFixture({ stale: false });
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['sync']);
      assert.strictEqual(res.status, 0, `sync must succeed on a fresh build:\n${res.stderr}`);
      assert.ok(!res.stderr.includes('Notice:'), `A fresh build must print no notice:\n${res.stderr}`);
      assert.ok(fs.existsSync(fixture.sentinel), 'dist must load for a fresh build');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('treats a git worktree .git file as a source checkout', () => {
    const fixture = makeFixture({ git: 'file' });
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['sync']);
      assert.strictEqual(res.status, 1, `A worktree .git file is still a source checkout:\n${res.stderr}`);
      assert.strictEqual(fs.existsSync(fixture.sentinel), false, 'dist must not load in a stale worktree');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('never refuses an in-process caller (require.main !== module)', () => {
    const fixture = makeFixture();
    try {
      assert.strictEqual(evaluateStaleDist(['sync'], fixture.dir, { isMain: false }).refuse, false);
      assert.strictEqual(evaluateStaleDist(['sync'], fixture.dir, { isMain: true }).refuse, true);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('classifies the same command as parseArguments', () => {
    const argvs = [
      ['sync'],
      ['release', 'phase/6-codeloop'],
      ['466', 'sync'],
      ['sync', '466'],
      ['--workspace', '/tmp/x', 'sync'],
      ['-m', 'sync', 'commit'],
      ['--', 'sync'],
      ['--issue', '466', 'release', 'phase/6'],
      ['--base-branch', 'main', 'release'],
      ['--dry-run', 'sync'],
      ['--yolo', '--commit-after'],
      ['#466', 'sync'],
      ['commit', '-y'],
      ['--help'],
      ['--version'],
      ['next'],
      ['triage', 'list'],
    ];
    for (const argv of argvs) {
      assert.strictEqual(
        commandFromArgv(argv),
        parseArguments(argv).command,
        `Classifier disagrees with parseArguments for: ${JSON.stringify(argv)}`
      );
    }
  });

  test('refuses yolo <issue> --commit-after on a stale checkout before dist loads (AC1, issue #492)', () => {
    const fixture = makeFixture();
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['yolo', '467', '--commit-after']);
      assertRefused(fixture, res, 'yolo');
      assert.ok(
        res.stderr.includes("then re-run 'codeloop yolo 467 --commit-after'"),
        `The refusal must name the full invocation to re-run:\n${res.stderr}`
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('refuses a bare continuous run carrying --commit-after in any position (AC1, issue #492)', () => {
    const fixture = makeFixture();
    try {
      for (const argv of [['467', '--commit-after'], ['--commit-after', '467'], ['--commit-after']]) {
        const res = spawnLauncher(fixture, 'codeloop.js', argv);
        assertRefused(fixture, res, '--commit-after');
      }
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('refuses the --yolo flag with --commit-after on a stale checkout (AC1, issue #492)', () => {
    const fixture = makeFixture();
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['--yolo', '--commit-after']);
      assertRefused(fixture, res, '--commit-after');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('keeps yolo <issue> usable on a stale checkout with the notice (AC2, issue #492)', () => {
    const fixture = makeFixture();
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['yolo', '467']);
      assert.strictEqual(res.status, 0, `Plain yolo must not be refused:\n${res.stderr}`);
      assert.ok(
        res.stderr.includes('Notice: src/ contains modifications newer than dist/'),
        `Plain yolo must keep the notice:\n${res.stderr}`
      );
      assert.ok(res.stdout.includes('STUB-SUCCESS'), `Plain yolo must run:\n${res.stdout}`);
      assert.ok(fs.existsSync(fixture.sentinel), 'dist must load for plain yolo');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('keeps yolo --help a read-only success on a stale checkout (AC2, issue #492)', () => {
    const fixture = makeFixture();
    try {
      for (const argv of [['yolo', '--help'], ['yolo', '--help', '--commit-after'], ['--commit-after', '--help']]) {
        const res = spawnLauncher(fixture, 'codeloop.js', argv);
        assert.strictEqual(res.status, 0, `'${argv.join(' ')}' must succeed:\n${res.stderr}`);
        assert.ok(
          !res.stderr.includes('Refusing to run'),
          `'${argv.join(' ')}' must not be refused:\n${res.stderr}`
        );
        assert.ok(fs.existsSync(fixture.sentinel), `'${argv.join(' ')}' must load dist`);
        fs.rmSync(fixture.sentinel, { force: true });
      }
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('does not treat --commit-after after -- as a flag (AC3, issue #492)', () => {
    const fixture = makeFixture();
    try {
      assert.strictEqual(hasCommitAfter(['yolo', '467', '--', '--commit-after']), false);
      const res = spawnLauncher(fixture, 'codeloop.js', ['yolo', '467', '--', '--commit-after']);
      assert.strictEqual(res.status, 0, `A post-terminator --commit-after is a positional:\n${res.stderr}`);
      assert.ok(res.stdout.includes('STUB-SUCCESS'), res.stdout);
      assert.ok(fs.existsSync(fixture.sentinel), 'dist must load when the flag is positional');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('classifies --commit-after like parseArguments in every position (AC3, issue #492)', () => {
    const argvs = [
      ['--commit-after'],
      ['--commit-after', '467'],
      ['467', '--commit-after'],
      ['yolo', '467', '--commit-after'],
      ['--yolo', '--commit-after'],
      ['yolo', '467'],
      ['yolo', '--help'],
      ['yolo', '467', '--', '--commit-after'],
      ['--', '--commit-after'],
      ['--critique-report', '--commit-after', 'commit'],
      ['--workspace', '--commit-after', 'sync'],
      ['-m', '--commit-after', 'commit'],
      ['--commit-after=1'],
    ];
    for (const argv of argvs) {
      assert.strictEqual(
        hasCommitAfter(argv),
        parseArguments(argv).options.commitAfter,
        `commit-after parity: ${JSON.stringify(argv)}`
      );
    }
  });

  test('refuses sync without .git when the build is genuinely stale (AC4, issue #492)', () => {
    const fixture = makeFixture({ git: 'none', stamp: 'mismatch' });
    const legacy = makeFixture({ git: 'none' });
    try {
      for (const argv of [['sync'], ['release', 'phase/6-codeloop'], ['commit']]) {
        const res = spawnLauncher(fixture, 'codeloop.js', argv);
        assertRefused(fixture, res, argv[0]);
      }
      assertRefused(legacy, spawnLauncher(legacy, 'codeloop.js', ['sync']), 'sync');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
      fs.rmSync(legacy.dir, { recursive: true, force: true });
    }
  });

  test('keeps an extracted copy without .git usable when the build stamp matches (AC4, issue #492)', () => {
    const fixture = makeFixture({ git: 'none', stamp: 'match' });
    try {
      const res = spawnLauncher(fixture, 'codeloop.js', ['sync']);
      assert.strictEqual(res.status, 0, `A matching build stamp is a fresh build:\n${res.stderr}`);
      assert.ok(!res.stderr.includes('Notice:'), `A fresh build must print no notice:\n${res.stderr}`);
      assert.ok(res.stdout.includes('STUB-SUCCESS'), res.stdout);
      assert.ok(fs.existsSync(fixture.sentinel), 'dist must load when the stamp matches');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('detects staleness from the build stamp despite preserved mtimes (AC4, issue #492)', () => {
    const fixture = makeFixture({ stamp: 'preserved' });
    try {
      const detected = detectStaleDist(fixture.dir);
      assert.strictEqual(detected.method, 'stamp');
      assert.strictEqual(detected.stale, true);
      const res = spawnLauncher(fixture, 'codeloop.js', ['sync']);
      assertRefused(fixture, res, 'sync');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('refuses sync -- --help on a stale source checkout (AC1, issue #471)', () => {
    const fixture = makeFixture();
    try {
      assert.strictEqual(wantsHelpOrVersion(['sync', '--', '--help']), false);
      const res = spawnLauncher(fixture, 'codeloop.js', ['sync', '--', '--help']);
      assertRefused(fixture, res, 'sync');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('refuses commit behind a stdin - value flag (AC2, issue #471)', () => {
    const fixture = makeFixture();
    try {
      for (const flag of ['--critique-report', '--report-file', '--deviation-file']) {
        const res = spawnLauncher(fixture, 'codeloop.js', [flag, '-', 'commit']);
        assertRefused(fixture, res, 'commit');
      }
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('keeps a bare - positional for a value flag that rejects stdin (AC2, issue #471)', () => {
    const fixture = makeFixture();
    try {
      assert.strictEqual(commandFromArgv(['--ack', '-', 'commit']), '-');
      assert.strictEqual(commandFromArgv(['--reason', '-', 'commit']), '-');
      const res = spawnLauncher(fixture, 'codeloop.js', ['--ack', '-', 'commit']);
      assert.strictEqual(res.status, 0, 'A non-stdin - value must not refuse');
      assert.ok(
        res.stderr.includes('Notice: src/ contains modifications newer than dist/'),
        res.stderr
      );
      assert.ok(res.stdout.includes('STUB-SUCCESS'), res.stdout);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('stops help/version detection at -- like parseArguments (AC3, issue #471)', () => {
    const argvs = [
      ['sync', '--', '--help'],
      ['release', '--', '--version'],
      ['sync', '--', '-h'],
      ['--', '--help'],
      ['release', '--help'],
    ];
    for (const argv of argvs) {
      const parsed = parseArguments(argv);
      assert.strictEqual(
        commandFromArgv(argv),
        parsed.command,
        `Classifier disagrees with parseArguments for: ${JSON.stringify(argv)}`
      );
      assert.strictEqual(
        wantsHelpOrVersion(argv),
        Boolean(parsed.options.help || parsed.options.version),
        `Help detection disagrees with parseArguments for: ${JSON.stringify(argv)}`
      );
    }
    assert.strictEqual(wantsHelpOrVersion(['sync', '--', '--help']), false);
  });

  test('classifies a - value for every VALUE_FLAGS entry like parseArguments (AC3, issue #471)', () => {
    for (const flag of VALUE_FLAGS as Set<string>) {
      const argv = [flag, '-', 'commit'];
      assert.strictEqual(
        commandFromArgv(argv),
        parseArguments(argv).command,
        `Classifier disagrees for a '-' value of ${flag}: ${JSON.stringify(argv)}`
      );
    }
    assert.strictEqual(commandFromArgv(['--critique-report', '-', 'commit']), 'commit');
    assert.strictEqual(commandFromArgv(['--report-file', '-', 'commit']), 'commit');
    assert.strictEqual(commandFromArgv(['--deviation-file', '-', 'commit']), 'commit');
    assert.strictEqual(commandFromArgv(['--ack', '-', 'commit']), '-');
  });

  test('refuses sync through bin/agyloop.js (parity)', () => {
    const fixture = makeFixture();
    try {
      const res = spawnLauncher(fixture, 'agyloop.js', ['sync']);
      assert.strictEqual(res.status, 1, `Expected exit 1 for agyloop sync:\n${res.stdout}\n${res.stderr}`);
      assert.ok(
        res.stderr.includes("Warning: The 'agyloop' command is deprecated. Please use 'codeloop' instead."),
        `Expected the deprecation warning:\n${res.stderr}`
      );
      assert.ok(res.stderr.includes("Refusing to run 'sync'"), `Expected the refusal:\n${res.stderr}`);
      assert.strictEqual(fs.existsSync(fixture.sentinel), false, 'dist must not load');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("every bin/*.ps1 launcher propagates node's exit code", () => {
    for (const name of ['codeloop.ps1', 'agyloop.ps1']) {
      const source = fs.readFileSync(path.join(ROOT, 'bin', name), 'utf-8');
      assert.match(source, /&\s+node\b[\s\S]*exit \$LASTEXITCODE/, `bin/${name} must propagate node's exit code`);
    }
  });
});
