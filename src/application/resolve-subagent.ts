/**
 * agyloop - ResolveSubagentUseCase
 *
 * Resolves subagent configuration, model routing, whitelisted tools,
 * and system prompts with strict physical write suppression guarantees.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SubagentRole,
  ToolWhitelist,
  READ_ONLY_TOOLS,
  ROLE_PLANNER,
  TIER_PRO
} from '../domain';
import { ConfigRepository, AgyLoopConfig } from '../ports';
import { CliGitHubGateway } from '../infrastructure/cli-github-gateway';

export const PLANNER_SUBAGENT_DEF = Object.freeze({
  name: ROLE_PLANNER,
  role: 'Architectural Planning Subagent',
  description:
    'Architectural reasoning, deep read-only inspection, and specification generation subagent',
  defaultTier: TIER_PRO,
  tools: READ_ONLY_TOOLS,
  capabilities: Object.freeze({
    enable_write_tools: false,
    enable_subagent_tools: false,
    enable_mcp_tools: true
  })
});

export interface SubagentCapabilities {
  readonly enable_write_tools: boolean;
  readonly enable_subagent_tools: boolean;
  readonly enable_mcp_tools: boolean;
}

export interface SubagentDescriptor {
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly model: string;
  readonly apiModel: string;
  readonly tools: readonly string[];
  readonly capabilities: SubagentCapabilities;
  readonly system_prompt: string;
}

export interface ResolveSubagentOptions {
  readonly role?: string;
  readonly customConfig?: AgyLoopConfig;
  readonly promptPath?: string;
  readonly workspaceDir?: string;
}

export interface PlanningTaskPromptParams {
  readonly issueNumber?: number | string | null;
  readonly repo?: string | null;
  readonly userInstructions?: string | null;
  readonly workspaceDir?: string;
  readonly config?: AgyLoopConfig;
}

export class ResolveSubagentUseCase {
  private readonly configRepo: ConfigRepository;
  private readonly githubGateway: CliGitHubGateway;

  constructor(configRepo: ConfigRepository, githubGateway: CliGitHubGateway = new CliGitHubGateway()) {
    this.configRepo = configRepo;
    this.githubGateway = githubGateway;
  }

  public getPlannerSystemPrompt(options: { promptPath?: string; workspaceDir?: string } = {}): string {
    const cwd = options.workspaceDir || process.cwd();
    const defaultPath = path.resolve(cwd, 'prompts', 'planner.md');
    const targetPath = options.promptPath || defaultPath;

    if (fs.existsSync(targetPath)) {
      try {
        return fs.readFileSync(targetPath, 'utf8');
      } catch {
        // Fall back to embedded prompt
      }
    }

    return `# AgyLoop Planning Subagent System Prompt\n\nYou are the AgyLoop Architectural Planning Subagent, an analytical, read-only software architect.\nYou are equipped strictly with read inspection tools (view_file, grep_search, find_by_name, list_dir).\nYou are physically incapable of modifying files. Your output is comprehensive technical plans following templates/discovery-plan.md and templates/implementation-plan.md.`;
  }

  public execute(options: ResolveSubagentOptions = {}): SubagentDescriptor {
    const roleVo = SubagentRole.from(options.role || ROLE_PLANNER);
    const config = options.customConfig || this.configRepo.loadConfig({ cwd: options.workspaceDir });
    const resolved = this.configRepo.resolveModel(roleVo.value, config);

    const enableMcp =
      config && config.options && typeof config.options.enableMcpInPlanner === 'boolean'
        ? config.options.enableMcpInPlanner
        : true;

    const whitelist = ToolWhitelist.readOnly();

    return {
      name: roleVo.value,
      role: 'Architectural Planning Subagent',
      description:
        'Architectural reasoning, deep read-only inspection, and specification generation subagent',
      model: resolved.tier,
      apiModel: resolved.apiModel,
      tools: whitelist.toArray(),
      capabilities: {
        enable_write_tools: false,
        enable_subagent_tools: false,
        enable_mcp_tools: enableMcp
      },
      system_prompt: this.getPlannerSystemPrompt({
        promptPath: options.promptPath,
        workspaceDir: options.workspaceDir
      })
    };
  }

  public buildPlanningTaskPrompt(params: PlanningTaskPromptParams = {}): string {
    const workspaceDir = params.workspaceDir || process.cwd();
    const repo = params.repo || this.githubGateway.getCurrentRepo(workspaceDir);
    let issueContextBlock = '';

    if (params.issueNumber) {
      const issueVo = parseInt(String(params.issueNumber), 10);
      if (!isNaN(issueVo)) {
        const issueData = this.githubGateway.fetchIssue(issueVo, {
          repo: repo || undefined,
          cwd: workspaceDir
        });
        if (issueData) {
          issueContextBlock = CliGitHubGateway.formatIssueForPrompt(issueData);
        }
      }
    }

    let prompt = `# Task: Architectural Investigation & Plan Generation\n\n`;
    prompt += `You are executing the **PLAN** phase of the AgyLoop pair-programming lifecycle.\n`;
    prompt += `Your goal is to inspect the codebase, perform root-cause analysis (for defects) or architectural design (for features), and produce an actionable specification.\n\n`;

    prompt += `### Operating Constraints:\n`;
    prompt += `1. **Read-Only**: You have access strictly to inspection tools (${READ_ONLY_TOOLS.join(', ')}). Do not attempt to modify or write files.\n`;
    prompt += `2. **Empirical Verification**: Verify all file paths, exports, and call-sites before finalizing your design.\n`;
    prompt += `3. **Deliverable**: Create the technical specification in the \`artifacts/plans/\` directory matching the standard templates:\n`;
    prompt += `   - Defects/Bugs: \`templates/discovery-plan.md\`\n`;
    prompt += `   - Features/Tasks: \`templates/implementation-plan.md\`\n\n`;

    if (issueContextBlock) {
      prompt += `----------------------------------------------------------------------\n`;
      prompt += `${issueContextBlock}\n`;
      prompt += `----------------------------------------------------------------------\n\n`;
    }

    if (params.userInstructions) {
      prompt += `### User / Developer Directives:\n${params.userInstructions}\n\n`;
    }

    prompt += `### Expected Output Structure:\n`;
    prompt += `- **Summary & Acceptance Criteria**: Reiterate scope and clear completion criteria.\n`;
    prompt += `- **Architectural Impact**: Detailed breakdown of components, file paths, and potential regression vectors.\n`;
    prompt += `- **Implementation Checklist**: Numbered steps with file targets for the downstream \`implementer\` subagent.\n`;
    prompt += `- **Quality Gate Targets**: Precise automated test commands to verify the change.\n`;

    return prompt.trim();
  }
}

