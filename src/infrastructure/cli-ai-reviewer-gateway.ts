/**
 * agyloop - CliAiReviewerGateway (Infrastructure Adapter)
 *
 * Implements AiReviewerPort with resolution hierarchy:
 * 1. Sibling ../critique (bin/critique or bin/critique.js)
 * 2. Bundled / local in agyloop repository root / cwd: bin/critique, bin/critique.js
 * 3. User data tool dir (LOCALAPPDATA/critique on Windows, ~/.local/share/critique on Linux/macOS)
 * 4. User-local: ~/.local/bin/critique
 * 5. System $PATH: critique executable on $PATH
 * 6. Fallback: ai-reviewer (bin/ai-reviewer.js, ~/.local/bin/ai-reviewer, $PATH ai-reviewer)
 * 7. None found: RESOLVER_SOURCE_NONE
 *
 * Enforces Dependency Inversion, graceful diagnostics for missing keys,
 * automatic compilation of critique source repos, and zero uncaught exceptions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  RESOLVER_SOURCE_SIBLING,
  RESOLVER_SOURCE_BUNDLED,
  RESOLVER_SOURCE_USER_DATA,
  RESOLVER_SOURCE_USER_LOCAL,
  RESOLVER_SOURCE_SYSTEM_PATH,
  RESOLVER_SOURCE_NONE,
  BINARY_CRITIQUE,
  BINARY_AI_REVIEWER,
  PATH_BUNDLED_CRITIQUE,
  PATH_BUNDLED_CRITIQUE_JS,
  PATH_USER_LOCAL_CRITIQUE,
  PATH_SIBLING_CRITIQUE_DIR,
  CRITIQUE_FLAG_JSON,
  CRITIQUE_FLAG_STAGED,
  CRITIQUE_FLAG_BASE,
  CRITIQUE_BUILD_COMMAND,
  PATH_BUNDLED_REVIEWER_JS,
  PATH_USER_LOCAL_REVIEWER
} from '../domain/constants';
import { AiReviewReport } from '../domain/value-objects/ai-review-report';
import {
  AiReviewerPort,
  AiReviewOptions,
  AiReviewerResolution
} from '../ports/ai-reviewer';
import { CommandExecutorPort } from '../ports/command-executor';
import { ProcessCommandExecutor } from './process-command-executor';
import { runAiReviewEngine } from './ai-reviewer/ai-reviewer-engine';

function findInSystemPath(binaryName: string, envPath?: string): string | null {
  const p = envPath !== undefined ? envPath : (process.env.PATH || '');
  const dirs = p.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, `${binaryName}${ext}`);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return fullPath;
        }
      } catch {
        // Continue searching
      }
    }
  }
  return null;
}

function isCritiqueSourceDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && pkg.name === BINARY_CRITIQUE) return true;
      } catch {
        // Ignore parse error
      }
    }
    return fs.existsSync(path.join(dir, 'src'));
  } catch {
    return false;
  }
}

function isBuildRequired(critiqueDir: string): boolean {
  const targetJs = path.join(critiqueDir, PATH_BUNDLED_CRITIQUE_JS);
  if (!fs.existsSync(targetJs)) {
    return true;
  }
  let targetMtime: number;
  try {
    targetMtime = fs.statSync(targetJs).mtimeMs;
  } catch {
    return true;
  }

  const srcDir = path.join(critiqueDir, 'src');
  if (!fs.existsSync(srcDir)) {
    return false;
  }

  function hasNewerFiles(dir: string): boolean {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (hasNewerFiles(full)) return true;
        } else if (entry.isFile()) {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > targetMtime) return true;
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
    return false;
  }

  return hasNewerFiles(srcDir);
}

function resolveUserDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, BINARY_CRITIQUE)
      : path.join(os.homedir(), 'AppData', 'Local', BINARY_CRITIQUE);
  }
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, BINARY_CRITIQUE)
    : path.join(os.homedir(), '.local', 'share', BINARY_CRITIQUE);
}

export class CliAiReviewerGateway implements AiReviewerPort {
  private readonly commandExecutor: CommandExecutorPort;

  constructor(commandExecutor: CommandExecutorPort = new ProcessCommandExecutor()) {
    this.commandExecutor = commandExecutor;
  }

  public resolveReviewer(cwd: string = process.cwd()): AiReviewerResolution {
    const repoRoot = path.resolve(__dirname, '../../');

    // 1. Sibling ../critique (../critique/bin/critique or ../critique/bin/critique.js)
    const siblingDir = path.resolve(cwd, PATH_SIBLING_CRITIQUE_DIR);
    try {
      if (fs.existsSync(siblingDir)) {
        const jsCandidate = path.join(siblingDir, PATH_BUNDLED_CRITIQUE_JS);
        if (fs.existsSync(jsCandidate)) {
          return {
            source: RESOLVER_SOURCE_SIBLING,
            path: jsCandidate,
            isAvailable: true
          };
        }
        const binCandidate = path.join(siblingDir, PATH_BUNDLED_CRITIQUE);
        if (fs.existsSync(binCandidate)) {
          return {
            source: RESOLVER_SOURCE_SIBLING,
            path: binCandidate,
            isAvailable: true
          };
        }
        if (isCritiqueSourceDir(siblingDir)) {
          return {
            source: RESOLVER_SOURCE_SIBLING,
            path: jsCandidate,
            isAvailable: true
          };
        }
      }
    } catch {
      // Continue searching
    }

    // 2. Bundled / local in agyloop repository root / cwd: bin/critique, bin/critique.js
    const bundledDirs = [path.resolve(cwd)];
    if (path.resolve(cwd) !== repoRoot) {
      bundledDirs.push(repoRoot);
    }
    for (const baseDir of bundledDirs) {
      try {
        const jsCandidate = path.resolve(baseDir, PATH_BUNDLED_CRITIQUE_JS);
        if (fs.existsSync(jsCandidate)) {
          return {
            source: RESOLVER_SOURCE_BUNDLED,
            path: jsCandidate,
            isAvailable: true
          };
        }
        const binCandidate = path.resolve(baseDir, PATH_BUNDLED_CRITIQUE);
        if (fs.existsSync(binCandidate)) {
          return {
            source: RESOLVER_SOURCE_BUNDLED,
            path: binCandidate,
            isAvailable: true
          };
        }
      } catch {
        // Continue searching
      }
    }

    // 3. User data tool dir (LOCALAPPDATA/critique on Windows, ~/.local/share/critique on Linux/macOS)
    try {
      const userDataDir = resolveUserDataDir();
      if (fs.existsSync(userDataDir)) {
        const jsCandidate = path.join(userDataDir, PATH_BUNDLED_CRITIQUE_JS);
        if (fs.existsSync(jsCandidate)) {
          return {
            source: RESOLVER_SOURCE_USER_DATA,
            path: jsCandidate,
            isAvailable: true
          };
        }
        const binCandidate = path.join(userDataDir, PATH_BUNDLED_CRITIQUE);
        if (fs.existsSync(binCandidate)) {
          return {
            source: RESOLVER_SOURCE_USER_DATA,
            path: binCandidate,
            isAvailable: true
          };
        }
        if (isCritiqueSourceDir(userDataDir)) {
          return {
            source: RESOLVER_SOURCE_USER_DATA,
            path: jsCandidate,
            isAvailable: true
          };
        }
      }
    } catch {
      // Continue searching
    }

    // 4. User-local: ~/.local/bin/critique (or .cmd/.bat/.exe on Windows)
    try {
      const userLocalBase = path.join(os.homedir(), PATH_USER_LOCAL_CRITIQUE);
      const userLocalCandidates = process.platform === 'win32'
        ? [userLocalBase, `${userLocalBase}.cmd`, `${userLocalBase}.bat`, `${userLocalBase}.exe`]
        : [userLocalBase];

      for (const cand of userLocalCandidates) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          return {
            source: RESOLVER_SOURCE_USER_LOCAL,
            path: cand,
            isAvailable: true
          };
        }
      }
    } catch {
      // Continue searching
    }

    // 5. System $PATH: critique executable on $PATH
    const critiquePath = findInSystemPath(BINARY_CRITIQUE);
    if (critiquePath) {
      return {
        source: RESOLVER_SOURCE_SYSTEM_PATH,
        path: critiquePath,
        isAvailable: true
      };
    }

    // 6. Fallback: ai-reviewer (bin/ai-reviewer.js, ~/.local/bin/ai-reviewer, $PATH ai-reviewer)
    // 6a. Bundled in cwd or repo root
    const cwdAiCandidate = path.resolve(cwd, PATH_BUNDLED_REVIEWER_JS);
    if (fs.existsSync(cwdAiCandidate)) {
      return {
        source: RESOLVER_SOURCE_BUNDLED,
        path: cwdAiCandidate,
        isAvailable: true
      };
    }

    if (path.resolve(cwd) === repoRoot) {
      const repoAiCandidate = path.resolve(repoRoot, PATH_BUNDLED_REVIEWER_JS);
      if (fs.existsSync(repoAiCandidate)) {
        return {
          source: RESOLVER_SOURCE_BUNDLED,
          path: repoAiCandidate,
          isAvailable: true
        };
      }
    }

    // 6b. User-local ~/.local/bin/ai-reviewer
    try {
      const userLocalAiBase = path.join(os.homedir(), PATH_USER_LOCAL_REVIEWER);
      const userLocalAiCandidates = process.platform === 'win32'
        ? [userLocalAiBase, `${userLocalAiBase}.cmd`, `${userLocalAiBase}.bat`, `${userLocalAiBase}.exe`]
        : [userLocalAiBase];

      for (const cand of userLocalAiCandidates) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          return {
            source: RESOLVER_SOURCE_USER_LOCAL,
            path: cand,
            isAvailable: true
          };
        }
      }
    } catch {
      // Continue searching
    }

    // 6c. System $PATH ai-reviewer
    const aiPath = findInSystemPath(BINARY_AI_REVIEWER);
    if (aiPath) {
      return {
        source: RESOLVER_SOURCE_SYSTEM_PATH,
        path: aiPath,
        isAvailable: true
      };
    }

    // 7. None found
    return {
      source: RESOLVER_SOURCE_NONE,
      path: null,
      isAvailable: false
    };
  }

  public async review(options: AiReviewOptions = {}): Promise<AiReviewReport> {
    if (options.bypass) {
      return AiReviewReport.bypassed('Bypassed by option');
    }

    const cwd = options.cwd || process.cwd();
    const resolution = this.resolveReviewer(cwd);

    // If none found or legacy bundled ai-reviewer.js, invoke internal TypeScript engine directly
    if (
      resolution.source === RESOLVER_SOURCE_NONE ||
      !resolution.path ||
      (resolution.source === RESOLVER_SOURCE_BUNDLED && resolution.path.endsWith(PATH_BUNDLED_REVIEWER_JS))
    ) {
      return runAiReviewEngine(options, {
        commandExecutor: this.commandExecutor
      });
    }

    let execPath = resolution.path;

    // If resolved to a critique source directory (e.g. ../critique or user data dir)
    // and bin/critique.js is missing or source files in src/ are newer than bin/critique.js, compile it
    const potentialDir = path.dirname(path.dirname(execPath));
    const isSourceDir =
      (resolution.source === RESOLVER_SOURCE_SIBLING || resolution.source === RESOLVER_SOURCE_USER_DATA) &&
      isCritiqueSourceDir(potentialDir);

    if (isSourceDir && isBuildRequired(potentialDir)) {
      try {
        await this.commandExecutor.execute(CRITIQUE_BUILD_COMMAND, { cwd: potentialDir });
      } catch {
        // Fallback or continue execution if build fails
      }
      const builtJs = path.join(potentialDir, PATH_BUNDLED_CRITIQUE_JS);
      if (fs.existsSync(builtJs)) {
        execPath = builtJs;
      }
    }

    const flags: string[] = [CRITIQUE_FLAG_JSON];
    if (options.staged) flags.push(CRITIQUE_FLAG_STAGED);
    if (options.baseRef) flags.push(`${CRITIQUE_FLAG_BASE} ${options.baseRef}`);

    const command = execPath.endsWith('.js')
      ? `node "${execPath}" ${flags.join(' ')}`
      : `"${execPath}" ${flags.join(' ')}`;

    try {
      const result = await this.commandExecutor.execute(command, {
        cwd,
        timeoutMs: options.timeoutMs,
        env: options.env
      });

      if (result.stdout && result.stdout.trim()) {
        try {
          return AiReviewReport.parse(result.stdout);
        } catch {
          // Fallback to internal engine on parse failure
        }
      }
    } catch {
      // Fallback to internal engine on command failure
    }

    return runAiReviewEngine(options, {
      commandExecutor: this.commandExecutor
    });
  }
}
