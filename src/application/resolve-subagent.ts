/**
 * agyloop - ResolveSubagentUseCase
 *
 * Resolves subagent configuration, model routing, whitelisted tools,
 * and system prompts with strict physical write suppression guarantees.
 */

import {
  SubagentRole,
  ToolWhitelist,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  READ_ONLY_TOOLS,
  PLANNER_TOOLS,
  IMPLEMENTER_TOOLS,
  GATE_TOOLS,
  REVIEWER_TOOLS,
  TRIAGE_TOOLS,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  ROLE_TRIAGE,
  ROLE_DISCOVERY,
  ROLE_TITLE_PLANNER,
  ROLE_TITLE_IMPLEMENTER,
  ROLE_TITLE_GATE,
  ROLE_TITLE_REVIEWER,
  ROLE_TITLE_TRIAGE,
  ROLE_TITLE_DISCOVERY,
  ROLE_DESC_PLANNER,
  ROLE_DESC_IMPLEMENTER,
  ROLE_DESC_GATE,
  ROLE_DESC_REVIEWER,
  ROLE_DESC_TRIAGE,
  ROLE_DESC_DISCOVERY,
  DEFAULT_PLANNER_SYSTEM_PROMPT,
  DEFAULT_IMPLEMENTER_SYSTEM_PROMPT,
  DEFAULT_GATE_SYSTEM_PROMPT,
  DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT,
  DEFAULT_DISCOVERY_SYSTEM_PROMPT,
  PLAN_DEFAULT_SPECIFICATION_TITLE,
  TIER_PRO,
  TIER_INHERIT,
  TIER_FLASH_LITE,
  TIER_FLASH,
  DiagnosticSnippet,
  SECTION_SELF_CORRECTION_TITLE,
  DIFF_EXCLUDED_PATHSPECS,
  DIFF_EXCLUDED_PATTERNS,
  DIFF_EXCLUDE_ARGS,
  MAX_INLINE_DIFF_LINES,
  DiffAnalyzer,
  IssueNumber,
  ANTI_INCEPTION_GUARDRAIL,
  buildDefaultTriageSystemPrompt,
  formatTriageActionList,
  formatTriageActionSideEffects,
  formatTriageRoutingCommand,
  NOTE_REVIEW_VERDICT_RETURN,
  formatCritiqueEvidenceReturnNote,
  formatToolProse,
  TOOL_CAPABILITY_READ,
  TOOL_CAPABILITY_SEARCH,
  TOOL_CAPABILITY_LIST,
  TOOL_CAPABILITY_WRITE,
  TOOL_CAPABILITY_EDIT,
  TOOL_CAPABILITY_SHELL,
  SmokeProtocol,
  GateCommandComposition,
  GateCommandSource,
  GATE_COMMAND_PRECEDENCE,
  GATE_COMMAND_WORKTREE_CONTRACT,
  GATE_COMMAND_SOURCE_PLAN,
  GATE_REPORT_JSON_MARKER,
  NOTE_GATE_REPORT_RETURN,
  hasLintCommand,
  isLintCommand,
  MSG_GATE_LINT_MISSING,
  HEADING_QUALITY_GATE_TARGETS,
  HEADING_MANUAL_SMOKE_TEST_PROTOCOL,
  HEADING_BASELINE_EVIDENCE,
  NOTE_SMOKE_BLOCK_SANDBOX_RULE,
  NOTE_IMPLEMENTER_SMOKE_OWNERSHIP,
  STATUS_PASSED,
  STATUS_FAILED,
  SMOKE_PROTOCOL_NOT_DECLARED,
  SMOKE_PROTOCOL_VOCABULARY,
  formatGateReportExample,
  NOTE_GATE_REPORT_EXAMPLE_PLACEHOLDERS,
  NOTE_GATE_REPORT_EVIDENCE_SHAPES,
  formatDiscoveryReportContract,
  formatDiscoveryExecutionContract,
  formatDiscoveryFallbackContract,
  BASELINE_DECLARED_SHAPE_SENTENCE,
  ROOT_BUILD_PROHIBITION_SENTENCE,
  DISCOVERY_REPRODUCTION_HEADING,
  DISCOVERY_REPRODUCTION_KEY,
  shellQuote,
  CRITIQUE_FLAG_JSON,
  CRITIQUE_JS_EXTENSION,
  NODE_RUNTIME_BINARY,
  NOTE_CRITIQUE_TIER_ONE_UNRESOLVED
} from '../domain';
import type { PlanIntegrityVerdict } from './resolve-gate-verification';

export {
  DIFF_EXCLUDED_PATHSPECS,
  DIFF_EXCLUDED_PATTERNS,
  DIFF_EXCLUDE_ARGS,
  MAX_INLINE_DIFF_LINES,
  ANTI_INCEPTION_GUARDRAIL
};
import {
  ConfigRepository,
  AgyLoopConfig,
  GitHubGateway,
  GitHubIssueData,
  PromptRepository,
  CritiquePort,
  BuildDetectorPort,
  formatIssueForPrompt
} from '../ports';
import { ManageCritiqueUseCase } from './manage-critique';

export const PLANNER_SUBAGENT_DEF = Object.freeze({
  name: ROLE_PLANNER,
  role: ROLE_TITLE_PLANNER,
  description: ROLE_DESC_PLANNER,
  defaultTier: TIER_PRO,
  tools: PLANNER_TOOLS,
  capabilities: Object.freeze({
    enable_write_tools: true,
    enable_subagent_tools: false,
    enable_mcp_tools: true
  })
});

export const DISCOVERY_SUBAGENT_DEF = Object.freeze({
  name: ROLE_DISCOVERY,
  role: ROLE_TITLE_DISCOVERY,
  description: ROLE_DESC_DISCOVERY,
  defaultTier: TIER_PRO,
  tools: PLANNER_TOOLS,
  capabilities: Object.freeze({
    enable_write_tools: true,
    enable_subagent_tools: false,
    enable_mcp_tools: true
  })
});

export const IMPLEMENTER_SUBAGENT_DEF = Object.freeze({
  name: ROLE_IMPLEMENTER,
  role: ROLE_TITLE_IMPLEMENTER,
  description: ROLE_DESC_IMPLEMENTER,
  defaultTier: TIER_INHERIT,
  tools: IMPLEMENTER_TOOLS,
  capabilities: Object.freeze({
    enable_write_tools: true,
    enable_subagent_tools: false,
    enable_mcp_tools: false
  })
});

export const GATE_SUBAGENT_DEF = Object.freeze({
  name: ROLE_GATE,
  role: ROLE_TITLE_GATE,
  description: ROLE_DESC_GATE,
  defaultTier: TIER_FLASH_LITE,
  tools: GATE_TOOLS,
  capabilities: Object.freeze({
    enable_write_tools: false,
    enable_subagent_tools: false,
    enable_mcp_tools: false
  })
});

export const REVIEWER_SUBAGENT_DEF = Object.freeze({
  name: ROLE_REVIEWER,
  role: ROLE_TITLE_REVIEWER,
  description: ROLE_DESC_REVIEWER,
  defaultTier: TIER_FLASH,
  tools: REVIEWER_TOOLS,
  capabilities: Object.freeze({
    enable_write_tools: false,
    enable_subagent_tools: false,
    enable_mcp_tools: false
  })
});

export const TRIAGE_SUBAGENT_DEF = Object.freeze({
  name: ROLE_TRIAGE,
  role: ROLE_TITLE_TRIAGE,
  description: ROLE_DESC_TRIAGE,
  defaultTier: TIER_FLASH,
  tools: TRIAGE_TOOLS,
  capabilities: Object.freeze({
    enable_write_tools: false,
    enable_subagent_tools: false,
    enable_mcp_tools: false
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
  readonly issueData?: GitHubIssueData | null;
  readonly userInstructions?: string | null;
  readonly workspaceDir?: string;
  readonly config?: AgyLoopConfig;
  readonly userFeedback?: string | null;
  readonly previousPlanContent?: string | null;
  readonly iterationCount?: number | null;
  readonly planDir?: string | null;
  readonly planPath?: string | null;
  readonly containerRuntime?: 'podman' | 'docker' | null;
  readonly buildDetector?: BuildDetectorPort;
}

export interface ImplementationTaskPromptParams {
  readonly planContent?: string | null;
  readonly planPath?: string | null;
  /**
   * The plan's smoke protocol, FROZEN at dispatch (issue #388, was #386).
   *
   * When absent, `buildImplementationTaskPrompt` parses `planContent`; when the
   * plan is not supplied either, the section renders the explicit prohibition.
   * Backward compatible: every existing call site compiles unchanged.
   */
  readonly smokeProtocol?: SmokeProtocol;
  readonly issueNumber?: number | string | null;
  readonly issueTitle?: string | null;
  readonly issueBody?: string | null;
  readonly repo?: string | null;
  readonly userInstructions?: string | null;
  readonly workspaceDir?: string;
  readonly config?: AgyLoopConfig;
  readonly failureDiagnostics?: string | DiagnosticSnippet | null;
  readonly selfCorrectionPayload?: string | null;
  readonly critiqueFailureSnippet?: string | null;
  readonly prReviewComments?: readonly string[] | string | null;
}

export interface GateTaskPromptParams {
  readonly commands?: readonly string[];
  readonly issueNumber?: number | string | null;
  readonly userInstructions?: string | null;
  readonly workspaceDir?: string;
  readonly config?: AgyLoopConfig;
  readonly planContent?: string | null;
  readonly planPath?: string | null;
  /** The cwd every gate command must run from (issue #298). */
  readonly cwd?: string;
  /** The resolver's provenance for the command list (issue #298). */
  readonly commandSource?: GateCommandSource;
  readonly commandSourceDetail?: string;
  readonly appendedCommands?: readonly string[];
  readonly requiredLint?: boolean;
  /** The composed workflow-lint step, when the change touches workflows (#369). */
  readonly composition?: GateCommandComposition;
  /** The smoke checks FROZEN at dispatch (issue #298). */
  readonly smokeProtocol?: SmokeProtocol;
  readonly planIntegrity?: PlanIntegrityVerdict;
}

export interface ReviewerTaskPromptParams {
  readonly issueNumber?: number | string | null;
  readonly issueTitle?: string | null;
  readonly issueBody?: string | null;
  readonly repo?: string | null;
  readonly baseBranch?: string | null;
  readonly acceptanceCriteria?: readonly string[];
  readonly standardsContent?: string | null;
  readonly workingDiff?: string | null;
  readonly critiqueReport?: string | null;
  /**
   * Untracked implementation-evidence paths measured by the SAME probe the
   * IMPLEMENT boundary uses (issue #356). `git diff <base>` cannot see them, so
   * the reviewer is handed them explicitly. `undefined`/`null`/`[]` render
   * NOTHING: a tracked-only change keeps the pre-#356 prompt byte-for-byte.
   */
  readonly untrackedFiles?: readonly string[] | null;
  /**
   * Where the reviewer writes its Tier 1 evidence (issue #397). When absent the
   * prompt is byte-identical to the pre-#397 wording — no path, no push.
   */
  readonly critiqueReportPath?: string | null;
  /**
   * An authoritative critique binary path (issue #314).
   *
   * `run-review` resolves it asynchronously and passes it here; when present it
   * wins over the port. `undefined` means "resolve through the critique port,
   * else render the discovery instruction".
   */
  readonly critiquePath?: string | null;
  readonly userInstructions?: string | null;
  readonly workspaceDir?: string;
  readonly config?: AgyLoopConfig;
}

export interface TriageTaskPromptParams {
  readonly issueNumber?: number | string | null;
  readonly workspaceDir?: string;
  readonly config?: AgyLoopConfig;
  readonly triagePayload?: string | null;
}

/**
 * Renders the Tier 1 command for a RESOLVED critique binary (issue #314).
 *
 * The installer ships a `critique.js` that the gateway runs through `node`;
 * a native binary runs directly. The path is single-quoted because macOS
 * user-data paths contain spaces (`~/Library/Application Support/...`).
 *
 * No `PATH` export: the path is absolute, and `~/.local/bin` is not where the
 * installer writes.
 */
function formatCritiqueTierOneCommand(binaryPath: string, reportPath?: string | null): string {
  const quoted = shellQuote(binaryPath);
  const command = binaryPath.endsWith(CRITIQUE_JS_EXTENSION)
    ? `${NODE_RUNTIME_BINARY} ${quoted} ${CRITIQUE_FLAG_JSON}`
    : `${quoted} ${CRITIQUE_FLAG_JSON}`;
  if (!reportPath) return command;
  // Issue #397: `tee`, not `>`: the reviewer must still read the findings to
  // reconcile the two tiers. `dirname` is used rather than splitting the path
  // in JS: the evidence path is absolute and may be Windows- or POSIX-shaped,
  // and the shell that runs it is the same shell the reviewer already uses.
  const quotedReport = shellQuote(reportPath);
  return `mkdir -p "$(dirname ${quotedReport})" && ${command} | tee ${quotedReport}`;
}

/**
 * A command that prints ONE untracked path's full content (issue #356).
 *
 * Files use `git diff --no-index`, which renders the whole body as additions and
 * exits 1 ("differences found") — the prompt says so, hence `|| true`.
 *
 * A path ending in `/` is a directory `git status --porcelain` COLLAPSED (every
 * file in it is untracked). `git diff --no-index /dev/null <dir>` fails with
 * "Could not access '<dir>/null'", so directories are expanded with
 * `git ls-files --others --exclude-standard` and printed file by file.
 *
 * The `\\n` inside the printf is load-bearing: a literal newline in the template
 * would break the one-line command.
 */
function formatUntrackedContentCommand(path: string): string {
  const quoted = shellQuote(path);
  if (path.endsWith('/')) {
    return `git ls-files --others --exclude-standard -- ${quoted} | while IFS= read -r f; do printf '\\n===== %s =====\\n' "$f"; cat -- "$f"; done`;
  }
  return `git diff --no-index -- /dev/null ${quoted} || true`;
}

/** Trimmed, de-duplicated, order-preserving; anything that is not a path is dropped. */
function normalizeUntrackedFiles(files: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const file of files ?? []) {
    if (typeof file !== 'string') continue;
    const trimmed = file.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Renders the implementer's frozen-protocol section (issue #388, was #386).
 *
 * The IMPLEMENT directive used to supply the plan path and "run the automated
 * test suite" but never the protocol, so an implementer could claim it ran one
 * that the gate then failed. The checks are copied VERBATIM, with their plan
 * line, and an unrunnable protocol states that the gate owns it.
 */
function formatImplementerSmokeSection(protocol: SmokeProtocol): string {
  if (!protocol.declared) {
    return (
      `### ${HEADING_MANUAL_SMOKE_TEST_PROTOCOL}\n` +
      `${NOTE_IMPLEMENTER_SMOKE_OWNERSHIP}\n` +
      'Do not invent checks, and never run a state-mutating `codeloop` command against the workspace root.\n\n'
    );
  }

  let text = `### ${HEADING_MANUAL_SMOKE_TEST_PROTOCOL} (frozen at dispatch)\n`;

  if (protocol.checks.length === 0) {
    text += 'No executable check was extracted from the approved plan.\n';
  } else {
    for (const check of protocol.checks) {
      const title = check.label.toLowerCase().startsWith(`check ${check.index}`)
        ? check.label
        : `Check ${check.index} — ${check.label}`;
      text += `#### ${title} (plan line ${check.planLine})\n`;
      text += `\`\`\`bash\n${check.body}\n\`\`\`\n\n`;
    }
  }

  if (protocol.executable) {
    text +=
      "Run each check exactly as written, in order, from the worktree root, with the worktree's own `codeloop` build. " +
      'Never edit the plan or a check; report a failure by check label and plan line. ' +
      'A check creates its own sandbox; never point a state-mutating check at the workspace root. ' +
      `${NOTE_IMPLEMENTER_SMOKE_OWNERSHIP} The prohibition is against inventing a check or asserting a result the gate must certify, not against executing the checks above.\n\n`;
    return text;
  }

  text +=
    'This protocol is NOT executable as written, so do not run a check you cannot complete. ' +
    `${NOTE_IMPLEMENTER_SMOKE_OWNERSHIP} ` +
    'The prohibition is against inventing or asserting a result the gate must certify; report the defect instead.\n';
  for (const finding of protocol.findings) {
    text += `- Rule \`${finding.rule}\`, check "${finding.label}" at plan line ${finding.line}: ${finding.excerpt}\n`;
  }
  text += 'Report the defect by check label and plan line; do not edit the frozen check.\n\n';
  return text;
}

export class ResolveSubagentUseCase {
  private readonly configRepo: ConfigRepository;
  private readonly githubGateway?: GitHubGateway;
  private readonly promptRepo?: PromptRepository;
  private readonly critiquePort?: CritiquePort;
  private readonly manageCritiqueUseCase?: ManageCritiqueUseCase;
  private readonly buildDetector?: BuildDetectorPort;

  constructor(
    configRepo: ConfigRepository,
    githubGateway?: GitHubGateway,
    promptRepo?: PromptRepository,
    critiquePortOrManageCritique?: CritiquePort | ManageCritiqueUseCase,
    buildDetector?: BuildDetectorPort
  ) {
    this.configRepo = configRepo;
    this.githubGateway = githubGateway;
    this.promptRepo = promptRepo;
    this.buildDetector = buildDetector;
    if (
      critiquePortOrManageCritique instanceof ManageCritiqueUseCase ||
      (critiquePortOrManageCritique &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeof (critiquePortOrManageCritique as any).getStatus === 'function' &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeof (critiquePortOrManageCritique as any).resolveCritiquePath === 'function')
    ) {
      this.manageCritiqueUseCase = critiquePortOrManageCritique as ManageCritiqueUseCase;
    } else if (critiquePortOrManageCritique) {
      this.critiquePort = critiquePortOrManageCritique as CritiquePort;
    }
  }

  public getPlannerSystemPrompt(options: { promptPath?: string; workspaceDir?: string } = {}): string {
    if (this.promptRepo) {
      return this.promptRepo.loadPrompt(ROLE_PLANNER, {
        promptPath: options.promptPath,
        cwd: options.workspaceDir
      });
    }
    return DEFAULT_PLANNER_SYSTEM_PROMPT;
  }

  public getDiscoverySystemPrompt(options: { promptPath?: string; workspaceDir?: string } = {}): string {
    if (this.promptRepo) {
      return this.promptRepo.loadPrompt(ROLE_DISCOVERY, {
        promptPath: options.promptPath,
        cwd: options.workspaceDir
      });
    }
    return DEFAULT_DISCOVERY_SYSTEM_PROMPT;
  }

  public getImplementerSystemPrompt(options: { promptPath?: string; workspaceDir?: string } = {}): string {
    if (this.promptRepo) {
      return this.promptRepo.loadPrompt(ROLE_IMPLEMENTER, {
        promptPath: options.promptPath,
        cwd: options.workspaceDir
      });
    }
    return DEFAULT_IMPLEMENTER_SYSTEM_PROMPT;
  }

  public getGateSystemPrompt(options: { promptPath?: string; workspaceDir?: string } = {}): string {
    if (this.promptRepo) {
      return this.promptRepo.loadPrompt(ROLE_GATE, {
        promptPath: options.promptPath,
        cwd: options.workspaceDir
      });
    }
    return DEFAULT_GATE_SYSTEM_PROMPT;
  }

  public getReviewerSystemPrompt(options: { promptPath?: string; workspaceDir?: string } = {}): string {
    if (this.promptRepo) {
      return this.promptRepo.loadPrompt(ROLE_REVIEWER, {
        promptPath: options.promptPath,
        cwd: options.workspaceDir
      });
    }
    return DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT;
  }

  public getTriageSystemPrompt(options: { promptPath?: string; workspaceDir?: string } = {}): string {
    if (this.promptRepo) {
      return this.promptRepo.loadPrompt(ROLE_TRIAGE, {
        promptPath: options.promptPath,
        cwd: options.workspaceDir
      });
    }
    return buildDefaultTriageSystemPrompt();
  }

  public execute(options: ResolveSubagentOptions = {}): SubagentDescriptor {
    const roleVo = SubagentRole.from(options.role || ROLE_PLANNER);
    const config = options.customConfig || this.configRepo.loadConfig({ cwd: options.workspaceDir });
    const resolved = this.configRepo.resolveModel(roleVo.value, config);

    if (roleVo.value === ROLE_DISCOVERY) {
      const whitelist = ToolWhitelist.planner();
      return {
        name: roleVo.value,
        role: DISCOVERY_SUBAGENT_DEF.role,
        description: DISCOVERY_SUBAGENT_DEF.description,
        model: resolved.tier,
        apiModel: resolved.apiModel,
        tools: whitelist.toArray(),
        capabilities: {
          enable_write_tools: true,
          enable_subagent_tools: false,
          enable_mcp_tools: true
        },
        system_prompt: this.getDiscoverySystemPrompt({
          promptPath: options.promptPath,
          workspaceDir: options.workspaceDir
        })
      };
    }

    if (roleVo.value === ROLE_IMPLEMENTER) {
      const whitelist = ToolWhitelist.implementation();
      return {
        name: roleVo.value,
        role: IMPLEMENTER_SUBAGENT_DEF.role,
        description: IMPLEMENTER_SUBAGENT_DEF.description,
        model: resolved.tier,
        apiModel: resolved.apiModel,
        tools: whitelist.toArray(),
        capabilities: {
          enable_write_tools: true,
          enable_subagent_tools: false,
          enable_mcp_tools: false
        },
        system_prompt: this.getImplementerSystemPrompt({
          promptPath: options.promptPath,
          workspaceDir: options.workspaceDir
        })
      };
    }

    if (roleVo.value === ROLE_GATE) {
      const whitelist = ToolWhitelist.gate();
      return {
        name: roleVo.value,
        role: GATE_SUBAGENT_DEF.role,
        description: GATE_SUBAGENT_DEF.description,
        model: resolved.tier,
        apiModel: resolved.apiModel,
        tools: whitelist.toArray(),
        capabilities: {
          enable_write_tools: false,
          enable_subagent_tools: false,
          enable_mcp_tools: false
        },
        system_prompt: this.getGateSystemPrompt({
          promptPath: options.promptPath,
          workspaceDir: options.workspaceDir
        })
      };
    }

    if (roleVo.value === ROLE_REVIEWER) {
      const whitelist = ToolWhitelist.reviewer();
      return {
        name: roleVo.value,
        role: REVIEWER_SUBAGENT_DEF.role,
        description: REVIEWER_SUBAGENT_DEF.description,
        model: resolved.tier,
        apiModel: resolved.apiModel,
        tools: whitelist.toArray(),
        capabilities: {
          enable_write_tools: false,
          enable_subagent_tools: false,
          enable_mcp_tools: false
        },
        system_prompt: this.getReviewerSystemPrompt({
          promptPath: options.promptPath,
          workspaceDir: options.workspaceDir
        })
      };
    }

    if (roleVo.value === ROLE_TRIAGE) {
      return {
        name: roleVo.value,
        role: TRIAGE_SUBAGENT_DEF.role,
        description: TRIAGE_SUBAGENT_DEF.description,
        model: resolved.tier,
        apiModel: resolved.apiModel,
        tools: TRIAGE_TOOLS.slice(),
        capabilities: {
          enable_write_tools: false,
          enable_subagent_tools: false,
          enable_mcp_tools: false
        },
        system_prompt: this.getTriageSystemPrompt({
          promptPath: options.promptPath,
          workspaceDir: options.workspaceDir
        })
      };
    }


    const enableMcp =
      config && config.options && typeof config.options.enableMcpInPlanner === 'boolean'
        ? config.options.enableMcpInPlanner
        : true;

    const whitelist = ToolWhitelist.planner();

    return {
      name: roleVo.value,
      role: PLANNER_SUBAGENT_DEF.role,
      description: PLANNER_SUBAGENT_DEF.description,
      model: resolved.tier,
      apiModel: resolved.apiModel,
      tools: whitelist.toArray(),
      capabilities: {
        enable_write_tools: true,
        enable_subagent_tools: false,
        enable_mcp_tools: enableMcp
      },
      system_prompt: this.getPlannerSystemPrompt({
        promptPath: options.promptPath,
        workspaceDir: options.workspaceDir
      })
    };
  }

  public buildDiscoveryTaskPrompt(params: PlanningTaskPromptParams = {}): string {
    const workspaceDir = params.workspaceDir || process.cwd();
    const currentRepo = this.githubGateway ? this.githubGateway.getCurrentRepo(workspaceDir) : null;
    const resolvedRepo = typeof currentRepo === 'string' ? currentRepo : undefined;
    const repo = params.repo || resolvedRepo;
    let issueContextBlock = '';

    const effectiveIssue =
      params.issueNumber ??
      IssueNumber.inferFromPath(workspaceDir) ??
      IssueNumber.inferFromPath(process.cwd());

    if (params.issueData) {
      issueContextBlock = formatIssueForPrompt(params.issueData);
    } else if (effectiveIssue) {
      if (this.githubGateway) {
        const issueVo = parseInt(String(effectiveIssue), 10);
        if (!isNaN(issueVo)) {
          const fetched = this.githubGateway.fetchIssue(issueVo, {
            repo,
            cwd: workspaceDir
          });
          if (fetched && !(fetched instanceof Promise)) {
            issueContextBlock = formatIssueForPrompt(fetched);
          }
        }
      }
      if (!issueContextBlock) {
        issueContextBlock = `### Active Issue: #${effectiveIssue}`;
      }
    }

    let prompt = `# Task: Defect Discovery & Root Cause Analysis\n\n`;
    prompt += `You are executing the **DISCOVERY** phase of the AgyLoop pair-programming lifecycle.\n`;
    prompt += `Your goal is to inspect the codebase, perform root-cause analysis (RCA), manually smoke test the bug, and produce an actionable discovery report.\n\n`;

    // Resolve container runtime and daemon availability
    //
    // Issue #295: prefer the runtime's OWN health probe. Availability by socket
    // file alone reported a working rootless podman absent, so the container
    // guardrail was dropped from the discovery prompt on every run. The
    // runtime+socket pair stays as the fallback for a stub detector that has no
    // probe.
    const detector = params.buildDetector || this.buildDetector;
    const probe = params.containerRuntime === undefined && detector && typeof detector.probeContainerRuntime === 'function'
      ? detector.probeContainerRuntime()
      : null;
    let runtime: 'podman' | 'docker' | null;
    let isContainerAvailable: boolean;
    if (probe) {
      runtime = probe.runtime;
      isContainerAvailable = true;
    } else {
      runtime = params.containerRuntime !== undefined
        ? params.containerRuntime
        : (detector && typeof detector.resolveContainerRuntime === 'function' ? detector.resolveContainerRuntime() : null);
      const socket = detector && typeof detector.resolveContainerSocket === 'function' ? detector.resolveContainerSocket() : null;
      isContainerAvailable = Boolean(runtime && socket);
    }

    const targetDir = params.planDir || 'artifacts/plans/';
    prompt += `### Operating Constraints:\n`;
    prompt += `1. **Scoped Write Access**: You have access to inspection and limited write tools (${formatToolProse([TOOL_CAPABILITY_READ, TOOL_CAPABILITY_SEARCH, TOOL_CAPABILITY_LIST, TOOL_CAPABILITY_WRITE, TOOL_CAPABILITY_EDIT], { plural: true })}). You MUST ONLY modify or write files within the \`${targetDir}\` directory.\n`;

    if (isContainerAvailable) {
      // Issue #389: the boundary is MUTATION, not containment. The old
      // container-only mandate contradicted the evidence contract (empirical
      // reproduction needs a build) and was unenforced anyway, so containment
      // is now an offer with a runnable recipe.
      prompt += `${formatDiscoveryExecutionContract({ runtime: runtime ?? 'docker', planDir: targetDir })}\n`;
    } else {
      // Issue #402, Defect 3: #295's fallback sentence stays verbatim, and the
      // mutation boundary follows it so a host without a container runtime is
      // still told that every write stays in the plan directory and that the
      // root build is never rebuilt.
      prompt += `${formatDiscoveryFallbackContract({ planDir: targetDir })}\n`;
    }

    const reproductionDeliverable =
      `You MUST fill out the \`${DISCOVERY_REPRODUCTION_HEADING}\` section — including its \`${DISCOVERY_REPRODUCTION_KEY}\` key — with the exact steps and observed results.`;

    const deliverableNum = 4;
    if (params.planPath) {
      prompt += `${deliverableNum}. **Deliverable**: Update and complete the scaffolded discovery specification template located precisely at: \`${params.planPath}\`.\n`;
      prompt += `   - Write ONLY this file. Do NOT create another directory under \`artifacts/plans/\` and do NOT create a second discovery artifact.\n`;
      prompt += `   - ${reproductionDeliverable}\n\n`;
    } else if (params.planDir) {
      prompt += `${deliverableNum}. **Deliverable**: Create the discovery specification INSIDE this existing directory: \`${params.planDir}\`, matching \`templates/discovery-plan.md\`.\n`;
      prompt += `   - Do NOT create another directory under \`artifacts/plans/\`.\n`;
      prompt += `   - ${reproductionDeliverable}\n\n`;
    } else {
      prompt += `${deliverableNum}. **Deliverable**: Run \`codeloop plan --issue <n>\` first to scaffold the canonical plan directory, then create the discovery specification there matching \`templates/discovery-plan.md\`.\n`;
      prompt += `   - ${reproductionDeliverable}\n\n`;
    }

    if (issueContextBlock) {
      prompt += `----------------------------------------------------------------------\n`;
      prompt += `${issueContextBlock}\n`;
      prompt += `----------------------------------------------------------------------\n\n`;
    }

    if (params.iterationCount && params.iterationCount > 0) {
      prompt += `### Plan Revision / Redirection Cycle: Iteration #${params.iterationCount}\n\n`;
    }

    if (params.userFeedback && params.userFeedback.trim()) {
      prompt += `### User Redirection Feedback:\n${params.userFeedback.trim()}\n\n`;
    }

    if (params.previousPlanContent && params.previousPlanContent.trim()) {
      prompt += `### Previous Plan Draft:\n\`\`\`markdown\n${params.previousPlanContent.trim()}\n\`\`\`\n\n`;
    }

    if (params.userInstructions) {
      prompt += `### User / Developer Directives:\n${params.userInstructions}\n\n`;
    }

    prompt += `### Expected Output Structure:\n`;
    prompt += `- **Summary & Symptoms**: Reiterate scope and clear completion criteria.\n`;
    prompt += `- **Root Cause Analysis**: Detailed breakdown of failure mechanisms.\n`;
    prompt += `- **Reproduction Steps & Verification Protocol**: Exact reproduction steps and results.\n`;
    prompt += `- **Remediation Strategy**: Cleanest fix approach.\n\n`;

    prompt += `### Evidence Contract:\n`;
    prompt += `${formatDiscoveryReportContract()}\n\n`;

    prompt += `${ANTI_INCEPTION_GUARDRAIL}\n`;

    return prompt.trim();
  }

  public buildPlanningTaskPrompt(params: PlanningTaskPromptParams = {}): string {
    const workspaceDir = params.workspaceDir || process.cwd();
    const currentRepo = this.githubGateway ? this.githubGateway.getCurrentRepo(workspaceDir) : null;
    const resolvedRepo = typeof currentRepo === 'string' ? currentRepo : undefined;
    const repo = params.repo || resolvedRepo;
    let issueContextBlock = '';

    const effectiveIssue =
      params.issueNumber ??
      IssueNumber.inferFromPath(workspaceDir) ??
      IssueNumber.inferFromPath(process.cwd());

    if (params.issueData) {
      issueContextBlock = formatIssueForPrompt(params.issueData);
    } else if (effectiveIssue) {
      if (this.githubGateway) {
        const issueVo = parseInt(String(effectiveIssue), 10);
        if (!isNaN(issueVo)) {
          const fetched = this.githubGateway.fetchIssue(issueVo, {
            repo,
            cwd: workspaceDir
          });
          if (fetched && !(fetched instanceof Promise)) {
            issueContextBlock = formatIssueForPrompt(fetched);
          }
        }
      }
      if (!issueContextBlock) {
        issueContextBlock = `### Active Issue: #${effectiveIssue}`;
      }
    }

    let prompt = `# Task: Architectural Investigation & Plan Generation\n\n`;
    prompt += `You are executing the **PLAN** phase of the AgyLoop pair-programming lifecycle.\n`;
    prompt += `Your goal is to inspect the codebase, perform architectural design, and produce an actionable specification.\n\n`;

    const targetDir = params.planDir || 'artifacts/plans/';
    prompt += `### Operating Constraints:\n`;
    prompt += `1. **Scoped Write Access**: You have access to inspection and limited write tools (${formatToolProse([TOOL_CAPABILITY_READ, TOOL_CAPABILITY_SEARCH, TOOL_CAPABILITY_LIST, TOOL_CAPABILITY_WRITE, TOOL_CAPABILITY_EDIT], { plural: true })}). You MUST ONLY modify or write files within the \`${targetDir}\` directory.\n`;
    prompt += `2. **Empirical Verification**: Verify all file paths, exports, and call-sites before finalizing your design.\n`;
    if (params.planPath) {
      prompt += `3. **Deliverable**: Update and complete the scaffolded technical specification template located precisely at: \`${params.planPath}\`.\n`;
      prompt += `   - Write ONLY this file. Do NOT create another directory under \`artifacts/plans/\` and do NOT write a second plan artifact.\n`;
      prompt += `   - You MUST explicitly define a "Manual Smoke Test Protocol".\n`;
      prompt += `   - You MUST explicitly design and mandate unit tests to meet each Acceptance Criteria defined in the plan.\n\n`;
    } else if (params.planDir) {
      prompt += `3. **Deliverable**: Create the technical specification INSIDE this existing directory: \`${params.planDir}\`, matching \`templates/implementation-plan.md\` (prefer \`implementation_plan.md\`).\n`;
      prompt += `   - Do NOT create another directory under \`artifacts/plans/\`.\n`;
      prompt += `   - You MUST explicitly define a "Manual Smoke Test Protocol".\n`;
      prompt += `   - You MUST explicitly design and mandate unit tests to meet each Acceptance Criteria defined in the plan.\n\n`;
    } else {
      prompt += `3. **Deliverable**: Run \`codeloop plan --issue <n>\` first to scaffold the canonical plan directory, then complete the technical specification there matching \`templates/implementation-plan.md\`.\n`;
      prompt += `   - You MUST explicitly define a "Manual Smoke Test Protocol".\n`;
      prompt += `   - You MUST explicitly design and mandate unit tests to meet each Acceptance Criteria defined in the plan.\n\n`;
    }

    if (issueContextBlock) {
      prompt += `----------------------------------------------------------------------\n`;
      prompt += `${issueContextBlock}\n`;
      prompt += `----------------------------------------------------------------------\n\n`;
    }

    if (params.iterationCount && params.iterationCount > 0) {
      prompt += `### Plan Revision / Redirection Cycle: Iteration #${params.iterationCount}\n\n`;
    }

    if (params.userFeedback && params.userFeedback.trim()) {
      prompt += `### User Redirection Feedback:\n${params.userFeedback.trim()}\n\n`;
    }

    if (params.previousPlanContent && params.previousPlanContent.trim()) {
      prompt += `### Previous Plan Draft:\n\`\`\`markdown\n${params.previousPlanContent.trim()}\n\`\`\`\n\n`;
    }

    if (params.userInstructions) {
      prompt += `### User / Developer Directives:\n${params.userInstructions}\n\n`;
    }

    prompt += `### Expected Output Structure:\n`;
    prompt += `- **Summary & Acceptance Criteria**: Reiterate scope and clear completion criteria.\n`;
    prompt += `- **Architectural Impact**: Detailed breakdown of components, file paths, and potential regression vectors.\n`;
    prompt += `- **Implementation Checklist**: Numbered steps with file targets for the downstream \`implementer\` subagent.\n`;
    prompt += `- **\`### ${HEADING_QUALITY_GATE_TARGETS}\`**: A section with exactly this heading and ONE verification command per line (a fenced \`bash\` block is ideal). These commands ARE the gate's command list, in this order — include lint and every targeted suite the change needs.\n`;
    prompt += `- **\`### ${HEADING_MANUAL_SMOKE_TEST_PROTOCOL}\`**: A section with exactly this heading whose checks are fenced \`bash\` blocks. Each fenced block must be runnable as written from the worktree root (absolute/relative \`.\` module paths, no JSON-quoted shell comparisons). ${NOTE_SMOKE_BLOCK_SANDBOX_RULE}\n`;
    prompt += `- **\`### ${HEADING_BASELINE_EVIDENCE}\`** (required only when you declare a baseline): one \`#### <claim-id>\` per declared number, each carrying \`- **Declared:**\`, \`- **Command:**\` and \`- **Output:**\`. Never declare an unmeasured baseline value; the approval guard executes every command and refuses a mismatch, naming the measured value. ${BASELINE_DECLARED_SHAPE_SENTENCE} A baseline command must never rebuild the workspace root: build-like commands (\`npm run build\`, \`npm test\`, \`tsc\`, \`make\`, …) are refused before anything runs. ${ROOT_BUILD_PROHIBITION_SENTENCE} When a baseline genuinely needs compiled output, compile into a scratch out-dir outside the workspace (\`npx tsc --outDir "$HOME/.cache/agyloop/baseline-<issue>/dist"\`) and require() the module from there.\n\n`;

    prompt += `${ANTI_INCEPTION_GUARDRAIL}\n`;

    return prompt.trim();
  }

  public buildImplementationTaskPrompt(params: ImplementationTaskPromptParams): string {
    let prompt = `# Task: Implementation Execution\n\n`;
    prompt += `You are executing the **IMPLEMENT** phase of the AgyLoop pair-programming lifecycle.\n`;
    prompt += `Your goal is to surgically implement the changes specified in the approved plan, run verification tests, and ensure all quality criteria are met.\n\n`;

    prompt += `### Operating Constraints:\n`;
    prompt += `1. **Plan Fidelity**: Adhere strictly to the approved specification. Do not perform unauthorized refactorings, style drifts, or introduce unrequested dependencies.\n`;
    prompt += `2. **Surgical Modifications**: Use ${formatToolProse([TOOL_CAPABILITY_EDIT])} for targeted edits on existing files. Use ${formatToolProse([TOOL_CAPABILITY_WRITE])} only for new files.\n`;
    prompt += `3. **Empirical Verification**: Run the automated test suite and verification commands via ${formatToolProse([TOOL_CAPABILITY_SHELL])} to validate all code edits before completing.\n`;
    prompt += `4. **No Commits**: Do NOT commit your changes. Leave them staged or unstaged in the worktree. The orchestrator's commit gate handles committing.\n\n`;

    if (params.workspaceDir) {
      prompt += `### Execution Workspace / Worktree:\n**Working Directory**: \`${params.workspaceDir}\`\n\n`;
    }

    const effectiveIssue =
      params.issueNumber ??
      IssueNumber.inferFromPath(params.workspaceDir) ??
      IssueNumber.inferFromPath(process.cwd());

    if (effectiveIssue) {
      if (params.issueTitle || params.issueBody) {
        prompt += `### Issue Context (#${effectiveIssue}):\n`;
        if (params.issueTitle) {
          prompt += `**Title**: ${params.issueTitle}\n`;
        }
        if (params.issueBody) {
          prompt += `**Description**:\n${params.issueBody.trim()}\n\n`;
        } else {
          prompt += `\n`;
        }
      } else {
        let fetchedFormatted = '';
        if (this.githubGateway) {
          const issueVo = parseInt(String(effectiveIssue), 10);
          if (!isNaN(issueVo)) {
            const workspaceDir = params.workspaceDir || process.cwd();
            const currentRepo = this.githubGateway.getCurrentRepo(workspaceDir);
            const resolvedRepo = typeof currentRepo === 'string' ? currentRepo : undefined;
            const repo = params.repo || resolvedRepo;
            const fetched = this.githubGateway.fetchIssue(issueVo, {
              repo,
              cwd: workspaceDir
            });
            if (fetched && !(fetched instanceof Promise)) {
              fetchedFormatted = formatIssueForPrompt(fetched);
            }
          }
        }
        if (fetchedFormatted) {
          prompt += `${fetchedFormatted}\n\n`;
        } else {
          prompt += `### Issue Context (#${effectiveIssue}):\n\n`;
        }
      }
    }

    if (params.userInstructions) {
      prompt += `### Developer Directives:\n${params.userInstructions.trim()}\n\n`;
    }

    if (params.planPath) {
      const planFileName = params.planPath.replace(/^.*[\\/]/, '');
      prompt += `### Approved Technical Plan (${planFileName}):\n`;
      prompt += `The approved technical plan is located at \`${params.planPath}\`.\n`;
      prompt += `You MUST read this file using ${formatToolProse([TOOL_CAPABILITY_READ])} to understand the acceptance criteria and implementation checklist before proceeding.\n`;
      prompt += `Do not edit the approved plan; its digest is verified by the gate. Record progress in the CodeLoop Summary, never in the plan.\n\n`;
    } else if (params.planContent && params.planContent.trim()) {
      prompt += `### Approved Technical Plan (${PLAN_DEFAULT_SPECIFICATION_TITLE}):\n\n`;
      prompt += `${params.planContent.trim()}\n\n`;
    }

    // Issue #388 (was #386): the protocol the gate will execute must reach the
    // implementer, or the implementer must be told the gate owns it.
    const smokeProtocol =
      params.smokeProtocol ?? SmokeProtocol.fromPlan(params.planContent ?? '');
    prompt += formatImplementerSmokeSection(smokeProtocol);

    if (params.selfCorrectionPayload && params.selfCorrectionPayload.trim()) {
      prompt += `${params.selfCorrectionPayload.trim()}\n\n`;
    } else if (params.failureDiagnostics) {
      const diagStr =
        params.failureDiagnostics instanceof DiagnosticSnippet
          ? params.failureDiagnostics.formatForPrompt()
          : typeof params.failureDiagnostics === 'string'
          ? params.failureDiagnostics.trim()
          : '';
      if (diagStr) {
        prompt += `${SECTION_SELF_CORRECTION_TITLE}\n`;
        prompt += `The previous Quality Gate verification failed. Address these errors before proceeding:\n\n`;
        prompt += `${diagStr}\n\n`;
      }
    }

    if (params.critiqueFailureSnippet && params.critiqueFailureSnippet.trim()) {
      prompt += `### Automated Critique Diagnostics (Violations to Remediate):\n`;
      prompt += `The previous review detected standards or architectural violations:\n\`\`\`\n${params.critiqueFailureSnippet.trim()}\n\`\`\`\n\n`;
    }

    if (params.prReviewComments) {
      const formattedComments = Array.isArray(params.prReviewComments)
        ? params.prReviewComments.map((c: string) => `- ${c}`).join('\n')
        : String(params.prReviewComments).trim();
      if (formattedComments) {
        prompt += `### Pull Request Review Comments to Address:\n${formattedComments}\n\n`;
      }
    }

    prompt += `### Definition of Done:\n`;
    prompt += `1. All tasks in the plan checklist are implemented.\n`;
    prompt += `2. All tests pass with 100% pass rate.\n`;
    prompt += `3. No linting or TypeScript compilation errors remain.\n`;
    prompt += `4. The plan's literal assertions are satisfied exactly as written — every row of its IK/decision table and every frozen smoke check. A unit test that disagrees with a frozen assertion is a defect in the test, not a licence to change the assertion; do not restate a literal with different punctuation.\n\n`;

    prompt += `${ANTI_INCEPTION_GUARDRAIL}\n`;

    return prompt.trim();
  }

  public buildGateTaskPrompt(params: GateTaskPromptParams = {}): string {
    let prompt = `# Task: Quality Gate Verification\n\n`;
    prompt += `You are executing the **QUALITY_GATE** phase of the AgyLoop pair-programming lifecycle.\n`;
    prompt += `Your goal is to execute automated build, typecheck, and test suites, isolate diagnostics, and report an objective quality verdict.\n\n`;

    prompt += `### Operating Constraints:\n`;
    prompt += `1. **Verification Only**: You have access strictly to ${formatToolProse([TOOL_CAPABILITY_SHELL, TOOL_CAPABILITY_READ], { plural: true })}. Never attempt to edit source files.\n`;
    prompt += `2. **Log Shielding Mandate**: Do not flood the parent conversation with raw terminal output. Filter noise and extract concise failure summaries.\n`;
    prompt += `3. **Strict Timeout & Exit Code Respect**: Any non-zero exit code or timeout is an immediate gate failure.\n\n`;

    const effectiveIssue =
      params.issueNumber ??
      IssueNumber.inferFromPath(params.workspaceDir) ??
      IssueNumber.inferFromPath(process.cwd());

    if (effectiveIssue) {
      prompt += `### Active Issue: #${effectiveIssue}\n\n`;
    }

    if (params.cwd) {
      prompt += `### Execution Cwd\n`;
      prompt += `\`${params.cwd}\`\n\n`;
      prompt += `Run every command from this directory. Do not cd to the repository root — that tests the root checkout, not this diff. This worktree is the code under test, and a test-run signal (\`NODE_TEST_CONTEXT\`) makes the cross-worktree state guard accept fixtures seeded for another issue.\n\n`;
      prompt += `${GATE_COMMAND_WORKTREE_CONTRACT}\n\n`;
    }

    if (params.commandSource) {
      prompt += `### Command Source\n`;
      prompt += `- Source: ${params.commandSource}\n`;
      if (params.commandSourceDetail) {
        prompt += `- Detail: ${params.commandSourceDetail}\n`;
      }
      prompt += `- Precedence: ${GATE_COMMAND_PRECEDENCE}. Config and auto-detection remain the visible fallback when the approved plan declares no Quality Gate Targets.\n`;
      if (params.appendedCommands && params.appendedCommands.length > 0) {
        prompt += `- Mandatory commands appended: ${params.appendedCommands.map((cmd) => `\`${cmd}\``).join(', ')}\n`;
      }
      prompt += `\n`;
    }

    const composition = params.composition;
    if (composition && composition.required) {
      prompt += `### Workflow Lint Composition\n`;
      if (composition.command !== null) {
        prompt += `- Workflow lint composed: the change touches ${composition.files.map((file) => `\`${file}\``).join(', ')}; appended \`${composition.command}\`.\n`;
        prompt += `This step is MANDATORY: the approved plan declares gate targets, which replace the act container gate, so the workflow diff is only exercised by this linter.\n\n`;
      } else {
        prompt += `- Workflow lint REQUIRED but unavailable: ${composition.unavailableReason ?? 'no workflow linter could be resolved'}.\n`;
        prompt += `The verdict MUST be \`${STATUS_FAILED}\`: the change touches ${composition.files.map((file) => `\`${file}\``).join(', ')} and no resolved command lints it.\n\n`;
      }
    }

    if (params.commands && params.commands.length > 0) {
      prompt += `### Target Verification Commands:\n`;
      params.commands.forEach((cmd, idx) => {
        prompt += `${idx + 1}. \`${cmd}\`\n`;
      });
      prompt += `\n`;
    }

    if (params.userInstructions) {
      prompt += `### Developer Directives:\n${params.userInstructions.trim()}\n\n`;
    }

    const commands = params.commands ?? [];
    const commandDefinitions = commands.map((command, idx) => ({
      id: `command-${idx}`,
      label: '',
      command
    }));

    if (params.requiredLint === true) {
      const lintCommand = commandDefinitions.find(isLintCommand)?.command;
      prompt += `### Lint Gate\n`;
      prompt += lintCommand
        ? `REQUIRED — \`${lintCommand}\`. A passing verdict is impossible without this command succeeding.\n\n`
        : `### Lint Invariant Violation\n${MSG_GATE_LINT_MISSING} The verdict MUST be FAILED.\n\n`;
    } else if (hasLintCommand(commandDefinitions)) {
      prompt += `### Lint Gate\n`;
      prompt += `A lint command is part of the target list. Its failure is a build-class gate failure.\n\n`;
    } else {
      prompt += `### Lint Gate\n`;
      prompt += `Lint is not declared by this project's detector, so it is not mandatory for this run.\n\n`;
    }

    const smoke = params.smokeProtocol;
    if (smoke && smoke.found) {
      prompt += `### ${HEADING_MANUAL_SMOKE_TEST_PROTOCOL} (frozen at dispatch)\n`;
      if (smoke.checks.length === 0) {
        prompt += `No executable check was extracted. A zero-check protocol is a \`FAILED\` verdict.\n\n`;
      } else {
        smoke.checks.forEach((check) => {
          const checkTitle = check.label.toLowerCase().startsWith(`check ${check.index}`)
            ? check.label
            : `Check ${check.index} — ${check.label}`;
          prompt += `#### ${checkTitle} (plan line ${check.planLine})\n`;
          prompt += `\`\`\`bash\n${check.body}\n\`\`\`\n\n`;
        });
      }
      prompt += `Execute each check exactly as written, in order. Do NOT edit the plan. A failing check, a skipped check, a zero-check protocol, or any edit to the plan is a \`FAILED\` verdict naming the check and plan line.\n`;
      if (smoke.findings.length > 0) {
        prompt += `The verdict MUST be \`FAILED\`: this protocol is not executable as written.\n`;
        smoke.findings.forEach((finding) => {
          prompt += `- Rule \`${finding.rule}\`, check "${finding.label}" at plan line ${finding.line}: ${finding.excerpt}\n`;
        });
      }
      prompt += `\n`;
    } else {
      prompt += `### ${HEADING_MANUAL_SMOKE_TEST_PROTOCOL}\n`;
      prompt += `This plan declares no ${HEADING_MANUAL_SMOKE_TEST_PROTOCOL} section. Report \`${SMOKE_PROTOCOL_NOT_DECLARED}\` for it; do not invent checks.\n\n`;
    }

    prompt += `### Plan Immutability\n`;
    prompt += `The approved plan${params.planPath ? ` at \`${params.planPath}\`` : ''} is frozen. You may read it with ${formatToolProse([TOOL_CAPABILITY_READ])}, but editing it is itself a gate failure: report \`FAILED\` and name the path. Annotations belong in the CodeLoop Summary, not in the plan.\n\n`;

    prompt += `### Required Verdict Output:\n`;
    prompt += `- Overall Status: PASSED or FAILED\n`;
    if (params.cwd) {
      prompt += `- Execution Cwd: ${params.cwd}\n`;
    }
    if (params.commandSource) {
      prompt += `- Command Source: ${params.commandSource}${params.planPath && params.commandSource === GATE_COMMAND_SOURCE_PLAN ? ` (${params.planPath})` : ''}\n`;
    }
    if (params.planIntegrity) {
      prompt += `- Plan Integrity: ${params.planIntegrity.status.toUpperCase()}\n`;
    }
    prompt += `- Smoke Protocol: ${SMOKE_PROTOCOL_VOCABULARY}\n`;
    prompt += `- Test Execution Matrix (Command, Exit Code, Duration)\n`;
    prompt += `- Concise Failure Diagnostics (if failed)\n\n`;

    // Issue #284: the ONE result channel. Without it the gate's verdict had no
    // way into the summary, so `Build Status: PENDING` survived every run.
    prompt += `### Required Evidence Output\n`;
    // Issue #311: the example is produced by ONE domain formatter, so what the
    // prompt shows is literally what `GateResultReport.parseBlock` accepts. A
    // plan with no smoke protocol is never shown a false `PASSED`.
    const exampleSmokeToken =
      smoke !== undefined && smoke.found ? STATUS_PASSED : SMOKE_PROTOCOL_NOT_DECLARED;
    prompt += `As the LAST thing in your response, emit a ${GATE_REPORT_JSON_MARKER} block:\n\n`;
    prompt += `${formatGateReportExample(exampleSmokeToken)}\n\n`;
    prompt += `${NOTE_GATE_REPORT_EXAMPLE_PLACEHOLDERS}\n\n`;
    prompt += `${NOTE_GATE_REPORT_EVIDENCE_SHAPES}\n\n`;
    prompt += `${NOTE_GATE_REPORT_RETURN}\n\n`;

    prompt += `${ANTI_INCEPTION_GUARDRAIL}\n`;

    return prompt.trim();
  }

  public buildReviewerTaskPrompt(params: ReviewerTaskPromptParams = {}): string {
    // Issue #314: an explicit path (run-review) is authoritative; otherwise ask
    // the port. Never fall back to a literal home-directory path — the
    // installer writes to the user-data directory, not ~/.local/bin.
    const resolvedCritiquePath =
      params.critiquePath ??
      (this.manageCritiqueUseCase
        ? this.manageCritiqueUseCase.resolveCritiquePath(params.workspaceDir)
        : ManageCritiqueUseCase.resolveCritiquePath(this.critiquePort, params.workspaceDir));

    let prompt = `# Task: Code Review & Standards Verification\n\n`;
    prompt += `You are executing the **REVIEW** phase of the AgyLoop pair-programming lifecycle.\n`;
    prompt += `Your goal is to inspect the code diff, verify architectural alignment, enforce repository standards, and validate all acceptance criteria.\n\n`;

    const critiqueReportPath = params.critiqueReportPath || null;
    const readOnlyRule = critiqueReportPath
      ? 'Never attempt to write or edit files in the repository. The ONE write this review permits is the Tier 1 evidence file named in the Two-Tier section below: it lives outside the worktree and is written by shell redirection. Write nothing else.'
      : 'Never attempt to write or edit files.';

    prompt += `### Operating Constraints:\n`;
    prompt += `1. **Read-Only Whitelist**: You have access strictly to inspection tools (${formatToolProse([TOOL_CAPABILITY_READ, TOOL_CAPABILITY_SEARCH, TOOL_CAPABILITY_LIST, TOOL_CAPABILITY_SHELL], { plural: true })}). ${readOnlyRule}\n`;
    prompt += `2. **Objective Standards Compliance**: Adhere strictly to repository guidelines, zero magic strings/numbers, and clean architecture boundaries.\n`;
    prompt += `3. **Acceptance Criteria Verification**: Confirm every criterion is objectively fulfilled by the working changes.\n\n`;

    prompt += `### Two-Tier Review Methodology:\n`;
    prompt += `1. **Tier 1 (Automated Critique CLI)**: Run automated critique inspection using ${formatToolProse([TOOL_CAPABILITY_SHELL])}:\n`;
    if (resolvedCritiquePath) {
      prompt += `   \`\`\`bash\n`;
      prompt += `   ${formatCritiqueTierOneCommand(resolvedCritiquePath, critiqueReportPath)}\n`;
      prompt += `   \`\`\`\n`;
      prompt += `   - The command above quotes the path resolved for this workspace. Do not substitute a PATH lookup or a guessed location.\n`;
    } else {
      prompt += `${NOTE_CRITIQUE_TIER_ONE_UNRESOLVED}\n`;
    }
    if (critiqueReportPath) {
      prompt += `   - ${formatCritiqueEvidenceReturnNote(critiqueReportPath)}\n`;
      prompt += `   - The path above is authoritative; do not invent another location and do not delete it.\n`;
    }
    prompt += `   - Execute critique CLI against target base branch (\`main\` or phase collector).\n`;
    prompt += `   - Invariant: Any \`critical\` or \`error\` findings mandate \`REVIEW_STATUS: CHANGES_REQUESTED\`.\n`;
    prompt += `2. **Tier 2 (Manual Diff & Standards Inspection)**: Independently inspect working diff against Acceptance Criteria and repository standards (\`.github/critique.md\`, zero magic numbers/strings, clean architecture).\n`;
    prompt += `3. **Consolidated Verdict**: Cross-reference both tiers into the structured verdict block (\`REVIEW_STATUS: APPROVED | CHANGES_REQUESTED\`).\n\n`;

    const effectiveIssue =
      params.issueNumber ??
      IssueNumber.inferFromPath(params.workspaceDir) ??
      IssueNumber.inferFromPath(process.cwd());

    if (effectiveIssue) {
      if (params.issueTitle || params.issueBody) {
        prompt += `### Active Issue: #${effectiveIssue}\n`;
        if (params.issueTitle) {
          prompt += `**Title**: ${params.issueTitle}\n`;
        }
        if (params.issueBody) {
          prompt += `**Description**:\n${params.issueBody.trim()}\n\n`;
        } else {
          prompt += `\n`;
        }
      } else {
        let fetchedFormatted = '';
        if (this.githubGateway) {
          const issueVo = parseInt(String(effectiveIssue), 10);
          if (!isNaN(issueVo)) {
            const workspaceDir = params.workspaceDir || process.cwd();
            const currentRepo = this.githubGateway.getCurrentRepo(workspaceDir);
            const resolvedRepo = typeof currentRepo === 'string' ? currentRepo : undefined;
            const repo = params.repo || resolvedRepo;
            const fetched = this.githubGateway.fetchIssue(issueVo, {
              repo,
              cwd: workspaceDir
            });
            if (fetched && !(fetched instanceof Promise)) {
              fetchedFormatted = formatIssueForPrompt(fetched);
            }
          }
        }
        if (fetchedFormatted) {
          prompt += `${fetchedFormatted}\n\n`;
        } else {
          prompt += `### Active Issue: #${effectiveIssue}\n\n`;
        }
      }
    }

    if (params.acceptanceCriteria && params.acceptanceCriteria.length > 0) {
      prompt += `### Target Acceptance Criteria:\n`;
      params.acceptanceCriteria.forEach((ac, idx) => {
        prompt += `${idx + 1}. ${ac}\n`;
      });
      prompt += `\n`;
    }

    if (params.standardsContent && params.standardsContent.trim()) {
      prompt += `### Repository Standards & Guidelines:\n`;
      prompt += `${params.standardsContent.trim()}\n\n`;
    }

    if (params.critiqueReport && params.critiqueReport.trim()) {
      prompt += `### Automated Code Critique Report\n\`\`\`\n${params.critiqueReport.trim()}\n\`\`\`\n\n`;
      prompt += `**Note**: Any \`critical\` or \`error\` findings from critique mandate \`REVIEW_STATUS: CHANGES_REQUESTED\`.\n\n`;
    }

    const baseBranch = params.baseBranch || '<baseBranch>';
    const diffExcludeArgs = DIFF_EXCLUDE_ARGS;
    const diffInspectionCmd = `git diff ${baseBranch} -- . ${diffExcludeArgs}`;

    let filteredDiff: string | null = null;
    if (params.workingDiff && params.workingDiff.trim()) {
      filteredDiff = DiffAnalyzer.filterDiff(params.workingDiff);
    }

    if (filteredDiff && filteredDiff.trim()) {
      const diffLines = filteredDiff.trim().split('\n');
      if (diffLines.length > MAX_INLINE_DIFF_LINES) {
        const statSummary = DiffAnalyzer.generateDiffStat(filteredDiff);
        prompt += `### Working Code Diff:\n`;
        prompt += `> [!NOTE]\n`;
        prompt += `> Working diff exceeds 1,000 lines (${diffLines.length.toLocaleString()} lines). Full diff omitted to protect subagent context and shield against token bloat.\n\n`;
        if (statSummary) {
          prompt += `#### Diff Stat:\n\`\`\`\n${statSummary}\n\`\`\`\n\n`;
        }
        prompt += `### Working Diff Inspection:\n`;
        prompt += `The filtered diff is unusually large (>1,000 lines). Provide \`git diff --stat\` or inspect specific modified files on demand using ${formatToolProse([TOOL_CAPABILITY_SHELL])}:\n`;
        prompt += `\`\`\`bash\n`;
        prompt += `git diff --stat ${baseBranch} -- . ${diffExcludeArgs}\n`;
        prompt += `git diff ${baseBranch} -- <file_path>\n`;
        prompt += `\`\`\`\n\n`;
      } else {
        prompt += `### Working Code Diff:\n\`\`\`diff\n${filteredDiff.trim()}\n\`\`\`\n\n`;
      }
    } else {
      prompt += `### Working Diff Inspection:\n`;
      prompt += `Inspect the working diff using ${formatToolProse([TOOL_CAPABILITY_SHELL])} with \`${diffInspectionCmd}\`:\n`;
      prompt += `\`\`\`bash\n`;
      prompt += `${diffInspectionCmd}\n`;
      prompt += `\`\`\`\n\n`;
    }

    const untrackedFiles = normalizeUntrackedFiles(params.untrackedFiles);
    if (untrackedFiles.length > 0) {
      prompt += `### Untracked Implementation Files (invisible to \`git diff\`):\n`;
      prompt += `\`${diffInspectionCmd}\` does NOT show untracked files. These paths are NEW and part of this change set, so inspect them with ${formatToolProse([TOOL_CAPABILITY_SHELL])} — the commands below print each one's FULL content:\n`;
      prompt += '```bash\n';
      for (const file of untrackedFiles) {
        prompt += `${formatUntrackedContentCommand(file)}\n`;
      }
      prompt += '```\n';
      prompt += '`git diff --no-index` exits non-zero when the files differ: that means the content WAS printed, and is expected. A path ending in `/` is a whole untracked directory, so its command prints every file inside it.\n';
      prompt += 'These paths are READ-ONLY evidence for your review: do not stage, stash, or modify them — staging changes what the commit draft sees.\n\n';
    }

    if (params.userInstructions) {
      prompt += `### Developer Directives:\n${params.userInstructions.trim()}\n\n`;
    }

    prompt += `### Required Verdict Output:\n`;
    prompt += `You must output a structured review verdict block adhering to this exact format:\n\n`;
    prompt += `\`\`\`markdown\n`;
    prompt += `REVIEW_STATUS: APPROVED | CHANGES_REQUESTED\n`;
    prompt += `REVIEW_SUMMARY: <Summary of review findings>\n`;
    prompt += `UNFULFILLED_AC:\n`;
    prompt += `- <Unfulfilled criterion 1> (or "None" if all criteria are met)\n`;
    prompt += `REMEDIATION_GUIDANCE:\n`;
    prompt += `- <Actionable remediation item 1> (or "None" if approved)\n`;
    prompt += `\`\`\`\n\n`;

    // Issue #297: ONE contract, stated once. The reviewer is a pure block
    // producer; the read-only whitelist above and the anti-inception guardrail
    // below are now unopposed. The filing instruction belongs to the
    // operator-facing directive (`next`), whose reader is the orchestrator.
    prompt += `${NOTE_REVIEW_VERDICT_RETURN}\n`;
    prompt += `Emit the block verbatim as the LAST thing in your response. Do not wrap the \`REVIEW_STATUS:\` line\n`;
    prompt += `in anything else.\n\n`;

    prompt += `${ANTI_INCEPTION_GUARDRAIL}\n`;

    return prompt.trim();
  }

  public buildTriageTaskPrompt(params: TriageTaskPromptParams = {}): string {
    let prompt = `# Task: Triage PR Review Comments\n\n`;
    prompt += `You are executing the **TRIAGE** phase of the AgyLoop pair-programming lifecycle.\n`;
    prompt += `Your goal is to categorize review comments and route the pipeline to the appropriate next stage.\n\n`;

    const effectiveIssue =
      params.issueNumber ??
      IssueNumber.inferFromPath(params.workspaceDir) ??
      IssueNumber.inferFromPath(process.cwd());

    if (effectiveIssue) {
      prompt += `### Active Issue: #${effectiveIssue}\n\n`;
    }

    if (params.triagePayload && params.triagePayload.trim()) {
      prompt += `### Review Comments to Triage:\n${params.triagePayload.trim()}\n\n`;
    }

    prompt += `You are the Triage Subagent. Directly inspect the comments and route the pipeline by executing:\n`;
    prompt += `    ${formatTriageRoutingCommand({ issue: effectiveIssue })}\n`;
    prompt += `Run that command with ${formatToolProse([TOOL_CAPABILITY_SHELL])}.\n`;
    prompt += `Where \`<action>\` is one of: ${formatTriageActionList()}.\n`;
    prompt += `Side effects: ${formatTriageActionSideEffects()}.\n`;
    prompt += `A routing action requires the checkpoint to be at the TRIAGE gate; \`codeloop next\` is the entry path. Do NOT spawn another subagent to do this.\n\n`;
    prompt += `${ANTI_INCEPTION_GUARDRAIL}\n`;

    return prompt.trim();
  }
}


