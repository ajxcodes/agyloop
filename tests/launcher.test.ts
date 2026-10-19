const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

describe('CLI Launchers and Rebranding', () => {
  const rootDir = path.resolve(__dirname, '..');
  const codeloopJs = path.join(rootDir, 'bin', 'codeloop.js');
  const agyloopJs = path.join(rootDir, 'bin', 'agyloop.js');
  const codeloopSh = path.join(rootDir, 'bin', 'codeloop');
  const agyloopSh = path.join(rootDir, 'bin', 'agyloop');

  test('bin/codeloop.js runs --help successfully without deprecation notice', () => {
    const res = spawnSync(process.execPath, [codeloopJs, '--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(!res.stderr.includes('deprecated'), 'Expected stderr not to contain deprecation notice');
  });

  test('bin/agyloop.js runs --help with deprecation notice in stderr', () => {
    const res = spawnSync(process.execPath, [agyloopJs, '--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(
      res.stderr.includes("Warning: The 'agyloop' command is deprecated. Please use 'codeloop' instead."),
      'Expected stderr to contain deprecation notice'
    );
  });

  test('bin/codeloop shell launcher runs --help without deprecation notice', () => {
    const res = spawnSync(codeloopSh, ['--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(!res.stderr.includes('deprecated'), 'Expected stderr not to contain deprecation notice');
  });

  test('bin/agyloop shell launcher runs --help with deprecation notice in stderr', () => {
    const res = spawnSync(agyloopSh, ['--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(
      res.stderr.includes("Warning: The 'agyloop' command is deprecated. Please use 'codeloop' instead."),
      'Expected stderr to contain deprecation notice'
    );
  });

  test('bin/codeloop.js exports main, parseArguments, runCli, checkStaleDist', () => {
    const codeloop = require('../bin/codeloop.js');
    assert.strictEqual(typeof codeloop.main, 'function');
    assert.strictEqual(typeof codeloop.parseArguments, 'function');
    assert.strictEqual(typeof codeloop.runCli, 'function');
    assert.strictEqual(typeof codeloop.checkStaleDist, 'function');
  });
});

// Regression cover for the launchers declaring themselves POSIX while using
// bash-only constructs. On Alpine/BusyBox, Debian/Ubuntu minimal and NixOS
// there is no `bash`, so `#!/usr/bin/env bash` fails with exit 127; on hosts
// where /bin/sh is dash or ash, `${BASH_SOURCE[0]}`, `&>` and `[[ ]]` fail at
// runtime. A static `sh -n` check does NOT catch any of the latter three -- they
// all parse cleanly under dash/ash -- so these tests must execute the scripts.
describe('POSIX Shell Compatibility', () => {
  const rootDir = path.resolve(__dirname, '..');
  // Invoke via the physical path so the scripts' own
  // `cd "$(dirname "$0")" && pwd` derivation matches `realpath` output even when
  // the repository is reached through a symlink.
  const binDir = fs.realpathSync(path.join(rootDir, 'bin'));
  const shellScripts = ['codeloop', 'agyloop', 'setup-symlink.sh', 'verify-install.sh'];

  test('every bin/ shell script declares a POSIX /bin/sh shebang', () => {
    for (const name of shellScripts) {
      const firstLine = fs.readFileSync(path.join(binDir, name), 'utf-8').split('\n')[0];
      assert.strictEqual(
        firstLine,
        '#!/bin/sh',
        `bin/${name} must use '#!/bin/sh', got: ${firstLine}`
      );
    }
  });

  test('every bin/ shell script contains no bash-only syntax', () => {
    // Guards against reintroducing ${BASH_SOURCE[0]}, `set -o pipefail`, `&>`,
    // `[[ ]]` or a bash shebang. `pipefail` parses cleanly under `sh -n` but is
    // not POSIX (dash < 0.5.12, BusyBox < 1.36) and aborts the script at the
    // `set` line on those shells, so only the executing tests can catch it.
    const bashOnly = /\$\{?BASH_SOURCE|\bset\b[^\n]*\bpipefail\b|\bshopt\b|&>|\[\[|#!\/usr\/bin\/env bash|#!\/bin\/bash/;
    for (const name of shellScripts) {
      const source = fs.readFileSync(path.join(binDir, name), 'utf-8');
      const offending = source.split('\n').find((line: string) => bashOnly.test(line));
      assert.strictEqual(
        offending,
        undefined,
        `bin/${name} uses bash-only syntax: ${offending}`
      );
    }
  });

  test('every bin/ shell script parses under a POSIX shell', () => {
    for (const name of shellScripts) {
      const res = spawnSync('sh', ['-n', path.join(binDir, name)], { encoding: 'utf-8' });
      assert.strictEqual(res.status, 0, `sh -n bin/${name} failed: ${res.stderr}`);
    }
  });

  test('bin/codeloop executes correctly when run explicitly under POSIX sh', () => {
    const res = spawnSync('sh', [path.join(binDir, 'codeloop'), '--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(!res.stderr.includes('deprecated'), 'Expected stderr not to contain deprecation notice');
    assert.ok(
      !/Bad substitution|not found/i.test(res.stderr),
      `Expected no POSIX incompatibility in stderr, got: ${res.stderr}`
    );
  });

  test('bin/agyloop executes correctly when run explicitly under POSIX sh', () => {
    const res = spawnSync('sh', [path.join(binDir, 'agyloop'), '--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(
      res.stderr.includes("Warning: The 'agyloop' command is deprecated. Please use 'codeloop' instead."),
      'Expected stderr to contain deprecation notice'
    );
    assert.ok(
      !/Bad substitution|not found/i.test(res.stderr),
      `Expected no POSIX incompatibility in stderr, got: ${res.stderr}`
    );
  });

  // These two scripts are user-facing (documented in README.md) and create
  // symlinks under $HOME. Sandboxing HOME into a throwaway temp dir keeps the
  // side effects contained, which is safe enough to execute and is far
  // stronger coverage than a bare `sh -n`: it is the only way to catch
  // `${BASH_SOURCE[0]}`, `&>` and `[[ ]]`, which parse fine but fail at runtime.
  test('bin/setup-symlink.sh and bin/verify-install.sh execute correctly under POSIX sh', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-shell-'));
    try {
      const env = { ...process.env, HOME: sandboxHome };

      const setup = spawnSync('sh', [path.join(binDir, 'setup-symlink.sh')], {
        encoding: 'utf-8',
        env,
      });
      assert.strictEqual(setup.status, 0, `setup-symlink.sh failed:\n${setup.stdout}\n${setup.stderr}`);

      const linked = path.join(sandboxHome, '.gemini', 'config', 'plugins', 'agyloop');
      assert.ok(fs.lstatSync(linked).isSymbolicLink(), `Expected a symlink at ${linked}`);
      // Compare physical paths on both sides: on macOS a checkout under /tmp
      // lives at /private/tmp, and `resolve_path` in setup-symlink.sh returns the
      // physical path, so comparing against the logical rootDir would fail there.
      assert.strictEqual(fs.realpathSync(linked), fs.realpathSync(rootDir), `Expected ${linked} -> ${rootDir}`);

      // Re-running must stay idempotent (exit 0, "already exists").
      const setupAgain = spawnSync('sh', [path.join(binDir, 'setup-symlink.sh')], {
        encoding: 'utf-8',
        env,
      });
      assert.strictEqual(
        setupAgain.status,
        0,
        `setup-symlink.sh re-run failed:\n${setupAgain.stdout}\n${setupAgain.stderr}`
      );
      assert.ok(
        setupAgain.stdout.includes('Setup complete (idempotent).'),
        `Expected idempotent branch, got:\n${setupAgain.stdout}`
      );

      const verify = spawnSync('sh', [path.join(binDir, 'verify-install.sh')], {
        encoding: 'utf-8',
        env,
      });
      assert.strictEqual(verify.status, 0, `verify-install.sh failed:\n${verify.stdout}\n${verify.stderr}`);
      assert.ok(
        verify.stdout.includes('Verification PASSED'),
        `Expected verification to pass, got:\n${verify.stdout}`
      );
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  // D7 regression (#226): with an empty $HOME there is no plugin symlink, so
  // jq exits 2 on the absent manifest. Under `set -e`, the plain assignment
  // `VAR="$(jq ...)"` used to abort the script with THAT exit status before
  // the FAILED summary ran, so callers saw 2 instead of the documented 1 --
  // and step 3 claimed "Invalid JSON syntax" about a file jq never opened.
  // These tests pin the missing-manifest failure mode on the script's own
  // documented terms. The happy path above must keep passing unchanged.
  function runVerifyInstallWithHome(sandboxHome: string) {
    return spawnSync('sh', [path.join(binDir, 'verify-install.sh')], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: sandboxHome },
    });
  }

  test('bin/verify-install.sh exits 1, not jq exit 2, when the manifest is missing', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-shell-'));
    try {
      const verify = runVerifyInstallWithHome(sandboxHome);
      // jq exits 2 for "no such file"; the script must translate that (and any
      // other jq failure) into its own documented exit 1, never leak jq's code.
      assert.notStrictEqual(
        verify.status,
        2,
        `Expected the script's own exit 1, not jq's exit 2, got:\n${verify.stdout}\n${verify.stderr}`
      );
      assert.strictEqual(
        verify.status,
        1,
        `Expected the documented exit 1 on a failed verification, got ${verify.status}:\n${verify.stdout}\n${verify.stderr}`
      );
      assert.ok(
        verify.stdout.includes('Verification FAILED'),
        `Expected the FAILED summary to be reachable, got:\n${verify.stdout}`
      );
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  test('bin/verify-install.sh leaks no raw jq error and claims no syntax error for an absent manifest', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-shell-'));
    try {
      const verify = runVerifyInstallWithHome(sandboxHome);
      assert.ok(
        !/jq: error/.test(verify.stdout + verify.stderr),
        `Expected no raw jq error to leak, got:\n${verify.stdout}\n${verify.stderr}`
      );
      // Step 2 already proved the manifest is absent; step 3 must not claim a
      // parse bug about a file that was never opened.
      assert.ok(
        !verify.stdout.includes('Invalid JSON syntax'),
        `Expected no "Invalid JSON syntax" for an absent manifest, got:\n${verify.stdout}`
      );
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  test('bin/verify-install.sh prints the actionable symlink hint when the manifest is missing', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-shell-'));
    try {
      const verify = runVerifyInstallWithHome(sandboxHome);
      assert.ok(
        verify.stdout.includes("Run './bin/setup-symlink.sh'"),
        `Expected the setup-symlink.sh hint, got:\n${verify.stdout}`
      );
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });
});
