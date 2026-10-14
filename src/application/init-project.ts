/**
 * agyloop - InitProjectUseCase
 *
 * Scaffolds `.codeloop/config.json` with detected git, verification and
 * default runtime settings, migrating legacy `.agyloop` configuration.
 */

import {
  CommandExecutorPort,
  BuildDetectorPort,
  ProjectScaffolderPort,
  ConfirmationPromptPort,
  ConfigRepository,
  AgyLoopConfig,
  GitConfig
} from '../ports';
import {
  FORGE_GITHUB,
  FORGE_GITLAB,
  FORGE_GENERIC,
  INIT_GITIGNORE_RULES,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  TIER_PRO,
  TIER_INHERIT,
  TIER_FLASH_LITE,
  TIER_FLASH,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  DEFAULT_CB_MAX_TURNS_PER_SUBAGENT,
  DEFAULT_CB_MAX_GATE_RETRIES,
  DEFAULT_CB_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_CB_MAX_WALL_CLOCK_DURATION_SECONDS,
  DEFAULT_CB_TOKEN_BUDGET_THRESHOLD,
  CB_ACTION_PAUSE_FOR_HUMAN,
  DEFAULT_OPENCODE_MODEL,
  DEFAULT_BASE_BRANCH,
  DEFAULT_BASE_BRANCH_CANDIDATES
} from '../domain';

export interface InitProjectDeps {
  readonly commandExecutor: CommandExecutorPort;
  readonly buildDetector: BuildDetectorPort;
  readonly scaffolder: ProjectScaffolderPort;
  readonly confirmationPrompt: ConfirmationPromptPort;
  readonly configRepo?: ConfigRepository;
}

export interface InitProjectInput {
  readonly workspaceDir: string;
  readonly yes?: boolean;
  /** True only when a human can answer prompts; defaults to false (never prompt). */
  readonly interactive?: boolean;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface InitProjectResult {
  readonly configPath: string;
  readonly config: AgyLoopConfig | null;
  readonly gitignoreAdded: string[];
  readonly gitignoreReplaced: string[];
  readonly migratedFrom: string | null;
  readonly skipped: boolean;
  readonly dryRun: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge where `preferred` values win over `base`. */
function mergePreferred(base: Record<string, unknown>, preferred: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(preferred)) {
    const p = preferred[key];
    const b = out[key];
    if (isPlainObject(p) && isPlainObject(b)) {
      out[key] = mergePreferred(b, p);
    } else if (p !== undefined) {
      out[key] = p;
    }
  }
  return out;
}

export class InitProjectUseCase {
  constructor(private readonly deps: InitProjectDeps) {}

  public async execute(input: InitProjectInput): Promise<InitProjectResult> {
    const { workspaceDir } = input;
    const dryRun = Boolean(input.dryRun);
    const { scaffolder } = this.deps;
    const targetPath = scaffolder.getConfigPath(workspaceDir);

    const existing = scaffolder.findExistingConfig(workspaceDir);
    const existingIsCodeloop =
      existing !== null && !scaffolder.getLegacyConfigPaths(workspaceDir).includes(existing);

    if (existingIsCodeloop && !input.force) {
      let proceed = false;
      if (input.interactive && !input.yes && !dryRun) {
        proceed = await this.deps.confirmationPrompt.confirm(
          `Existing config found at ${existing}. Overwrite?`,
          false
        );
      }
      if (!proceed) {
        return {
          configPath: existing as string,
          config: null,
          gitignoreAdded: [],
          gitignoreReplaced: [],
          migratedFrom: null,
          skipped: true,
          dryRun
        };
      }
    }

    const git = await this.detectGit(workspaceDir);
    const detected = await this.deps.buildDetector.detect(workspaceDir);
    const markers = await scaffolder.detectMarkers(workspaceDir);
    const verification = scaffolder.buildVerificationProfile(
      markers,
      String(detected.primaryEcosystem),
      detected.commands
    );

    let generated: Record<string, unknown> = {
      runner: 'auto',
      opencode: { model: DEFAULT_OPENCODE_MODEL },
      models: {
        [ROLE_PLANNER]: TIER_PRO,
        [ROLE_IMPLEMENTER]: TIER_INHERIT,
        [ROLE_GATE]: TIER_FLASH_LITE,
        [ROLE_REVIEWER]: TIER_FLASH
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
        autoApproveInYolo: true,
        enableMcpInPlanner: true
      },
      circuitBreakers: {
        maxTurnsPerSubagent: DEFAULT_CB_MAX_TURNS_PER_SUBAGENT,
        maxGateRetries: DEFAULT_CB_MAX_GATE_RETRIES,
        maxConcurrentSubagents: DEFAULT_CB_MAX_CONCURRENT_SUBAGENTS,
        maxWallClockDurationSeconds: DEFAULT_CB_MAX_WALL_CLOCK_DURATION_SECONDS,
        tokenBudgetThreshold: DEFAULT_CB_TOKEN_BUDGET_THRESHOLD,
        actionOnTrip: CB_ACTION_PAUSE_FOR_HUMAN
      },
      git,
      verification
    };

    let migratedFrom: string | null = null;
    const legacy = scaffolder.detectLegacyLayout(workspaceDir);
    const legacyPath = existing !== null && !existingIsCodeloop ? existing : null;
    // With --force, the previous .codeloop config is merged in so the user's values win.
    const migrationSource = legacyPath ?? (existing === null ? legacy.legacyConfigPath : null);
    if (existingIsCodeloop && existing) {
      const previous = scaffolder.readConfig(existing);
      if (previous) {
        generated = mergePreferred(generated, previous);
      }
    }
    if (migrationSource) {
      const legacyConfig = scaffolder.readConfig(migrationSource);
      if (legacyConfig) {
        generated = mergePreferred(generated, legacyConfig);
        migratedFrom = migrationSource;
      }
    }

    const config = generated as unknown as AgyLoopConfig;
    if (dryRun) {
      const preview = scaffolder.previewGitIgnore(workspaceDir, INIT_GITIGNORE_RULES);
      return {
        configPath: targetPath,
        config,
        gitignoreAdded: preview.added,
        gitignoreReplaced: preview.replaced,
        migratedFrom,
        skipped: false,
        dryRun: true
      };
    }

    const configPath = scaffolder.writeConfig(workspaceDir, config);
    const ignoreChange = scaffolder.updateGitIgnore(workspaceDir, INIT_GITIGNORE_RULES);
    return {
      configPath,
      config,
      gitignoreAdded: ignoreChange.added,
      gitignoreReplaced: ignoreChange.replaced,
      migratedFrom,
      skipped: false,
      dryRun: false
    };
  }

  private async detectGit(workspaceDir: string): Promise<GitConfig> {
    const run = async (cmd: string): Promise<string> => {
      try {
        const res = await this.deps.commandExecutor.execute(cmd, { cwd: workspaceDir, timeoutMs: 10000 });
        return res.exitCode === 0 ? res.stdout.trim() : '';
      } catch {
        return '';
      }
    };

    const remotes = (await run('git remote')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0] || 'origin';

    // Staged base-branch probe (issue #218 / AC5). `run()` returns '' on a non-zero
    // exit and swallows throws, so every stage below is total and cheap.
    let baseBranch: string = DEFAULT_BASE_BRANCH;

    // 1. Remote HEAD of the RESOLVED remote — never a hardcoded 'origin'.
    const head = await run(`git symbolic-ref refs/remotes/${remote}/HEAD`);
    const headMatch = head.match(/refs\/remotes\/[^/]+\/(.+)$/);
    const headBranch = headMatch && headMatch[1] !== 'HEAD' ? headMatch[1] : null;

    if (headBranch) {
      baseBranch = headBranch;
    } else {
      // 2. Current local branch — empty on a detached HEAD.
      const currentBranch = await run('git branch --show-current');
      if (currentBranch && currentBranch !== 'HEAD') {
        baseBranch = currentBranch;
      } else {
        // 3. Well-known candidates, most preferred first. String concatenation only —
        //    the application layer must not import 'path'.
        for (const candidate of DEFAULT_BASE_BRANCH_CANDIDATES) {
          const verified = await run(`git rev-parse --verify refs/heads/${candidate}`);
          if (verified) {
            baseBranch = candidate;
            break;
          }
        }
        // 4. Otherwise DEFAULT_BASE_BRANCH stands as the terminal fallback.
      }
    }

    let forge: string = FORGE_GENERIC;
    if (remotes.length > 0) {
      const url = await run(`git remote get-url ${remote}`);
      if (url.includes('github.com')) forge = FORGE_GITHUB;
      else if (url.includes('gitlab')) forge = FORGE_GITLAB;
    }

    return { remote, baseBranch, forge };
  }
}
