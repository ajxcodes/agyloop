/**
 * agyloop - CliAiReviewerGateway (Infrastructure Adapter)
 *
 * Implements AiReviewerPort with a 3-tier resolution hierarchy:
 * 1. Bundled bin/ai-reviewer.js in agyloop repository/plugin root.
 * 2. ~/.local/bin/ai-reviewer.
 * 3. System $PATH.
 *
 * Enforces Dependency Inversion, graceful diagnostics for missing keys,
 * and zero uncaught exceptions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  RESOLVER_SOURCE_BUNDLED,
  RESOLVER_SOURCE_USER_LOCAL,
  RESOLVER_SOURCE_SYSTEM_PATH,
  RESOLVER_SOURCE_NONE,
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

export class CliAiReviewerGateway implements AiReviewerPort {
  private readonly commandExecutor: CommandExecutorPort;

  constructor(commandExecutor: CommandExecutorPort = new ProcessCommandExecutor()) {
    this.commandExecutor = commandExecutor;
  }

  public resolveReviewer(cwd: string = process.cwd()): AiReviewerResolution {
    // 1. Check bundled in agyloop repository root (dist/infrastructure -> root is ../..)
    const repoRootCandidate = path.resolve(__dirname, '../../', PATH_BUNDLED_REVIEWER_JS);
    if (fs.existsSync(repoRootCandidate)) {
      return {
        source: RESOLVER_SOURCE_BUNDLED,
        path: repoRootCandidate,
        isAvailable: true
      };
    }

    // Check cwd/bin/ai-reviewer.js if running in an external workspace with local bin
    const cwdCandidate = path.resolve(cwd, PATH_BUNDLED_REVIEWER_JS);
    if (fs.existsSync(cwdCandidate)) {
      return {
        source: RESOLVER_SOURCE_BUNDLED,
        path: cwdCandidate,
        isAvailable: true
      };
    }

    // 2. Check ~/.local/bin/ai-reviewer
    const userLocalCandidate = path.join(os.homedir(), PATH_USER_LOCAL_REVIEWER);
    if (fs.existsSync(userLocalCandidate)) {
      return {
        source: RESOLVER_SOURCE_USER_LOCAL,
        path: userLocalCandidate,
        isAvailable: true
      };
    }

    // 3. Check system $PATH
    const pathCandidate = findInSystemPath('ai-reviewer');
    if (pathCandidate) {
      return {
        source: RESOLVER_SOURCE_SYSTEM_PATH,
        path: pathCandidate,
        isAvailable: true
      };
    }

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

    // If resolution is bundled or none, run via pure TypeScript engine directly
    if (resolution.source === RESOLVER_SOURCE_BUNDLED || resolution.source === RESOLVER_SOURCE_NONE) {
      return runAiReviewEngine(options, {
        commandExecutor: this.commandExecutor
      });
    }

    // If external binary resolved (~/.local/bin/ai-reviewer or system $PATH), invoke via commandExecutor
    const execPath = resolution.path!;
    const flags: string[] = ['--json'];
    if (options.staged) flags.push('--staged');
    if (options.baseRef) flags.push(`--base ${options.baseRef}`);

    const command = execPath.endsWith('.js')
      ? `node "${execPath}" ${flags.join(' ')}`
      : `"${execPath}" ${flags.join(' ')}`;

    try {
      const result = await this.commandExecutor.execute(command, {
        cwd,
        timeoutMs: options.timeoutMs,
        env: options.env
      });

      if (result.stdout.trim()) {
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
