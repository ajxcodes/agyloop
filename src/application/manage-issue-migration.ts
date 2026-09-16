/**
 * agyloop - ManageIssueMigrationUseCase (Application Layer)
 *
 * Coordinates private vs public issue tracking and migration hooks:
 * 1. Background Issue Management: updates/closes private tracker issues (ajxcodes/projects#ID)
 *    directly via GitHubGateway without leaking URLs in public commits or PRs.
 * 2. Migration Hooks: executes configured migration command (per_task or milestone_only).
 *
 * Strict Hexagonal Architecture: Depends exclusively on Domain and Ports. Zero direct I/O.
 */

import { MIGRATION_MODE_PER_TASK, MIGRATION_MODE_MILESTONE_ONLY } from '../domain';
import { GitHubGateway, CommandExecutorPort, ConfigRepository } from '../ports';

export interface IssueMigrationParams {
  readonly issueNumber?: number | string | null;
  readonly event: 'task_merged' | 'milestone_merged' | 'commit_executed';
  readonly workspaceDir?: string;
  readonly configPath?: string | null;
  readonly comment?: string | null;
  readonly closeIssue?: boolean;
}

export interface IssueMigrationResult {
  readonly executed: boolean;
  readonly hookTriggered: boolean;
  readonly issueUpdated: boolean;
  readonly message: string;
}

export class ManageIssueMigrationUseCase {
  private readonly githubGateway?: GitHubGateway;
  private readonly commandExecutor?: CommandExecutorPort;
  private readonly configRepo?: ConfigRepository;

  constructor(
    githubGateway?: GitHubGateway,
    commandExecutor?: CommandExecutorPort,
    configRepo?: ConfigRepository
  ) {
    this.githubGateway = githubGateway;
    this.commandExecutor = commandExecutor;
    this.configRepo = configRepo;
  }

  public async execute(params: IssueMigrationParams): Promise<IssueMigrationResult> {
    const cwd = params.workspaceDir || process.cwd();
    const config = this.configRepo
      ? this.configRepo.loadConfig({ customPath: params.configPath, cwd })
      : undefined;

    const migrationConfig = config?.migration;
    const mode = migrationConfig?.mode || MIGRATION_MODE_MILESTONE_ONLY;
    const trackerRepo = migrationConfig?.trackerRepo;
    const hookCommand = migrationConfig?.hookCommand;

    let issueUpdated = false;
    let hookTriggered = false;

    // 1. Background Private Issue Management
    if (params.issueNumber && this.githubGateway) {
      const issueNum = Number(params.issueNumber);
      if (Number.isInteger(issueNum) && issueNum > 0) {
        if (params.comment && this.githubGateway.commentOnIssue) {
          try {
            await this.githubGateway.commentOnIssue(issueNum, params.comment, {
              cwd,
              repo: trackerRepo
            });
            issueUpdated = true;
          } catch {
            // Non-fatal background update
          }
        }

        if (params.closeIssue && this.githubGateway.closeIssue) {
          try {
            await this.githubGateway.closeIssue(issueNum, {
              cwd,
              repo: trackerRepo
            });
            issueUpdated = true;
          } catch {
            // Non-fatal
          }
        }
      }
    }

    // 2. Migration Hook Triggering
    const shouldRunHook =
      hookCommand &&
      ((mode === MIGRATION_MODE_PER_TASK && (params.event === 'task_merged' || params.event === 'commit_executed')) ||
        (mode === MIGRATION_MODE_MILESTONE_ONLY && params.event === 'milestone_merged'));

    if (shouldRunHook && this.commandExecutor) {
      try {
        const cmd = params.issueNumber
          ? `${hookCommand} ${params.issueNumber}`
          : hookCommand;
        await this.commandExecutor.execute(cmd, { cwd });
        hookTriggered = true;
      } catch {
        // Non-fatal
      }
    }

    return {
      executed: true,
      hookTriggered,
      issueUpdated,
      message: `Issue migration completed (hook: ${hookTriggered}, updated: ${issueUpdated}).`
    };
  }
}
