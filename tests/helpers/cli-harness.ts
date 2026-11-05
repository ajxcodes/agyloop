/**
 * codeloop - canonical CLI invoke harness (issue #544)
 *
 * ONE definition of the `runIn` / `runCliInSandbox` / `runCliIn` family with an
 * explicit `mode: 'in-process' | 'subprocess'`:
 *
 *   - in-process replicates today's dominant block byte-for-byte: cwd swap +
 *     restore in `finally`, `console.log`/`console.error` capture,
 *     `process.stdin.isTTY`/`process.stdout.isTTY` forced to `false`, seed and
 *     inspect hooks around the call, and the 20s hang-guard timeout the
 *     task-scope suite introduced (an unsettled `runCli` fails LOUDLY instead
 *     of hanging the suite).
 *   - subprocess replicates the `spawnSync(process.execPath, [bin, …])`
 *     suites: arbitrary `bin` (a shadow-bin fixture passes its own), `env` and
 *     `HOME` wiring, no TTY forcing, no caption stripping beyond the option.
 *
 * `runIn`/`runCliIn` retire as NAMES: their call sites become
 * `runCliInSandbox(args, { dir, mode: 'in-process' })`.
 *
 * Stripping: default `stripAnsi: false` (colour-policy classes count ESC
 * bytes); every suite whose pinned literals were computed over STRIPPED output
 * (the #441 register suites among them) passes `stripAnsi: true`, so captured
 * bytes equal what its local copy produced.
 *
 * The process-level side-effect discipline (restore in `finally`, capture only
 * console + cwd + TTY flags) is exactly the restore block of the local copies
 * this module replaces; Node's test runner isolates files into processes, so
 * cross-suite bleed was never possible.
 *
 * Erasable-TS-only: no parameter properties, no enum, no namespace.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** The ANSI-SGR regex all ten local `stripAnsi` copies share. */
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/** The ONE stripAnsi (10 retired local copies). */
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

interface CliHarnessOptions {
  /** Explicit; default 'in-process'. */
  mode?: 'in-process' | 'subprocess';
  /**
   * Force `process.stdin.isTTY` / `process.stdout.isTTY` to `false` around the
   * in-process invoke (the dominant suite shape). `false` keeps whatever the
   * caller set (the colour-policy suites synthesise a TTY attr themselves).
   */
  forceTty?: boolean;
  /** Explicit TTY attrs (the prompt-guard suites set TRUE to open a prompt). */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  /**
   * Pre-built working directory (a sandbox dir the caller owns). Default: a
   * mkdtemp inside this module's own temp root, DELETED in the finally block.
   * A caller-supplied dir is never deleted here — the sandbox owns cleanup.
   */
  dir?: string;
  /** Runs before the invoke (fixture seeding). Default none. */
  seed?: (dir: string) => void;
  /** Runs after the invoke, before state restore. Default none. */
  inspect?: (dir: string) => void;
  /** Move the cwd INSIDE `dir` by this relative path (e.g. '.worktrees/42'). */
  cwdSubdir?: string;
  /**
   * Environment overrides applied around the invoke (in-process) or passed to
   * the spawn (subprocess). `undefined` DELETEs the key (AGY_SUBAGENT etc).
   */
  env?: Record<string, string | undefined>;
  /** HOME override (in-process: restored after the invoke; subprocess: env). */
  home?: string;
  /** Strip the ANSI escape sequences from the captured output. Default false. */
  stripAnsi?: boolean;
  /** Hang-guard timeout for in-process mode, or spawnSync timeout. Default 20000. */
  timeoutMs?: number;
  /** The binary to spawn in subprocess mode. Default the repo's own bin. */
  bin?: string;
}

interface CaptureHandle {
  /** The captured stdout SO FAR. */
  stdout(): string;
  /** The captured stderr SO FAR. */
  stderr(): string;
  /** Restores console.log/console.error. Call exactly once, usually in finally. */
  end(): void;
}

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The working directory the CLI ran in. */
  readonly dir: string;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_TEMP_PREFIX = 'codeloop-harness-';
const DEFAULT_TIMEOUT_MS = 20000;

function defaultBin(): string {
  return path.join(REPO_ROOT, 'bin', 'codeloop.js');
}

async function runInProcess(
  workdir: string,
  args: readonly string[],
  options: CliHarnessOptions
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalHome = process.env.HOME;
  const originalEnvironmentKeys: Array<{ key: string; prev: string | undefined }> = options.env
    ? Object.keys(options.env).map((key) => ({ key, prev: process.env[key] }))
    : [];
  let stdout = '';
  let stderr = '';

  const { runCli } = require(path.join(REPO_ROOT, 'dist', 'presentation', 'cli'));

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    if (options.seed) {
      options.seed(workdir);
    }
    process.chdir(path.join(workdir, options.cwdSubdir ?? ''));
    if (options.stdinIsTTY !== undefined) {
      (process.stdin as { isTTY?: boolean }).isTTY = options.stdinIsTTY;
      (process.stdout as { isTTY?: boolean }).isTTY = options.stdoutIsTTY ?? false;
    } else if (options.forceTty !== false) {
      process.stdin.isTTY = false;
      process.stdout.isTTY = false;
    }
    if (options.home !== undefined) {
      process.env.HOME = options.home;
    }
    for (const entry of Object.entries(options.env ?? {})) {
      const envKey = entry[0];
      const envValue = entry[1];
      if (envValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = envValue;
      }
    }
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    console.warn = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    let code: number;
    try {
      code = await Promise.race([
        Promise.resolve(runCli([...args])),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`HANG: runCli(${JSON.stringify(args)}) never settled.`)),
            timeoutMs
          );
          if (timer && typeof timer.unref === 'function') {
            timer.unref();
          }
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    if (options.inspect) {
      options.inspect(workdir);
    }
    const rawStdout = stdout;
    const rawStderr = stderr;
    return {
      code,
      stdout: options.stripAnsi ? stripAnsi(rawStdout) : rawStdout,
      stderr: options.stripAnsi ? stripAnsi(rawStderr) : rawStderr,
      dir: path.join(workdir, options.cwdSubdir ?? '')
    };
  } finally {
    for (const { key, prev } of originalEnvironmentKeys) {
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
  }
}

function runSubprocess(
  workdir: string,
  args: readonly string[],
  options: CliHarnessOptions
): CaptureResult {
  const bin = options.bin ?? defaultBin();
  const env: Record<string, string | undefined> = { ...process.env, ...(options.env ?? {}) };
  if (options.home !== undefined) {
    env.HOME = options.home;
  }
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: path.join(workdir, options.cwdSubdir ?? ''),
    encoding: 'utf8',
    env,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });
  const code = res.status ?? (res.error ? 1 : 0);
  return {
    code,
    stdout: options.stripAnsi ? stripAnsi(res.stdout ?? '') : (res.stdout ?? ''),
    stderr: options.stripAnsi ? stripAnsi(res.stderr ?? '') : (res.stderr ?? ''),
    dir: path.join(workdir, options.cwdSubdir ?? '')
  };
}

async function runCliInSandbox(
  args: readonly string[],
  options?: CliHarnessOptions
): Promise<CaptureResult> {
  const opts = options ?? {};
  const owned = opts.dir === undefined;
  const workdir = owned ? fs.mkdtempSync(path.join(os.tmpdir(), HARNESS_TEMP_PREFIX)) : (opts.dir as string);

  try {
    if ((opts.mode ?? 'in-process') === 'subprocess') {
      return runSubprocess(workdir, args, opts);
    }
    return await runInProcess(workdir, args, opts);
  } finally {
    if (owned) {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
}

/** Captures the console streams around a synchronous body. */
function captureStreams<T>(body: () => T): { result: T } & CapturedStreams {
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const result = body();
    return { result, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

interface CapturedStreams {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Toggle-style capture for the suites that cannot express their block as one
 * synchronous body. ALWAYS `capture.end()` in a `finally` block.
 */
function beginCapture(): CaptureHandle {
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...a: unknown[]) => {
    stdout += a.map(String).join(' ') + '\n';
  };
  console.error = (...a: unknown[]) => {
    stderr += a.map(String).join(' ') + '\n';
  };
  return {
    stdout(): string {
      return stdout;
    },
    stderr(): string {
      return stderr;
    },
    end(): void {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

module.exports = {
  runCliInSandbox,
  captureStreams,
  beginCapture,
  stripAnsi,
  defaultBin
};
