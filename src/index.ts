/**
 * agyloop - Antigravity Development Lifecycle Orchestrator
 *
 * Clean Hexagonal Architecture foundation:
 * - Domain: Pure StateMachine entity, Value Objects, Sealed Domain Errors
 * - Ports: Inversion of Control interfaces (Storage, GitHub, Config, Models, Plans)
 * - Infrastructure: Adapters for file persistence, GitHub CLI, Gemini discovery
 * - Application: Use cases orchestrating workflows
 * - Presentation: CLI dispatcher and formatting
 */

export * from './domain';
export * from './ports';
export * from './infrastructure';
export * from './application';
export * from './presentation';

import { FileConfigRepository } from './infrastructure/file-config-repository';
import { GeminiModelCatalog } from './infrastructure/gemini-model-catalog';
import { CliGitHubGateway } from './infrastructure/cli-github-gateway';
import { FilePlanGenerator } from './infrastructure/file-plan-generator';
import {
  ConfigLoadOptions,
  AgyLoopConfig,
  FetchModelsOptions,
  DiscoveredModel,
  GitHubGatewayOptions,
  GitHubIssueData,
  ScaffoldParams,
  ScaffoldResult,
  GeneratePlanOptions,
  GeneratePlanResult,
  GenerateSummaryLogOptions,
  GenerateSummaryLogResult,
  SummaryUpdateData
} from './ports';
import { SubagentRoleName, ModelTierName } from './domain';

const defaultConfigFileRepo = new FileConfigRepository();
const defaultModelCatalog = new GeminiModelCatalog({ configRepo: defaultConfigFileRepo });
const defaultGitHubGateway = new CliGitHubGateway();
const defaultPlanGenerator = new FilePlanGenerator();

export function loadConfig(options: ConfigLoadOptions & { workspaceDir?: string } = {}): AgyLoopConfig {
  return defaultConfigFileRepo.loadConfig(options);
}

export function resolveModel(
  role: SubagentRoleName | string,
  config: AgyLoopConfig
): {
  role: string;
  configured: string;
  tier: ModelTierName;
  apiModel: string;
} {
  return defaultConfigFileRepo.resolveModel(role, config);
}

export function mapModelToTier(inputModel: string): ModelTierName {
  return defaultConfigFileRepo.mapModelToTier(inputModel);
}

export async function fetchAvailableModels(
  options: FetchModelsOptions = {}
): Promise<readonly DiscoveredModel[]> {
  return defaultModelCatalog.fetchModels(options);
}

export function getCurrentRepo(cwd: string = process.cwd()): string | null {
  return defaultGitHubGateway.getCurrentRepo(cwd);
}

export function fetchIssueContext(
  issueNumber: number,
  options: GitHubGatewayOptions = {}
): GitHubIssueData | null {
  return defaultGitHubGateway.fetchIssue(issueNumber, options);
}

export function formatIssueForPrompt(issueData: GitHubIssueData | null): string {
  return CliGitHubGateway.formatIssueForPrompt(issueData);
}

export function slugify(text: string): string {
  return defaultPlanGenerator.slugify(text);
}

export function sanitizeFilename(title: string): string {
  return defaultPlanGenerator.sanitizeFilename(title);
}

export function ensurePlanDirectory(projectRoot: string = process.cwd()): string {
  return defaultPlanGenerator.ensurePlanDirectory(projectRoot);
}

export function findPlanDirectory(projectRoot: string, issueNumber: number | string): string | null {
  return defaultPlanGenerator.findPlanDirectory(projectRoot, issueNumber);
}

export function loadTemplate(templateName: string, customTemplatesDir?: string | null): string {
  return defaultPlanGenerator.loadTemplate(templateName, customTemplatesDir);
}

export function renderTemplate(templateContent: string, variables: Record<string, unknown> = {}): string {
  return defaultPlanGenerator.renderTemplate(templateContent, variables);
}

export function detectPlanType(
  titleOrParams: string | { title?: string; labels?: readonly string[] } = {},
  maybeLabels: readonly string[] = []
): 'discovery' | 'implementation' {
  if (typeof titleOrParams === 'string') {
    return defaultPlanGenerator.detectPlanType(titleOrParams, maybeLabels);
  }
  const { title = '', labels = [] } = titleOrParams || {};
  return defaultPlanGenerator.detectPlanType(title, labels);
}

export function generatePlan(options: GeneratePlanOptions): GeneratePlanResult {
  return defaultPlanGenerator.generatePlan(options);
}

export function generateSummaryLog(options: GenerateSummaryLogOptions): GenerateSummaryLogResult {
  return defaultPlanGenerator.generateSummaryLog(options);
}

export function updateSummaryLog(summaryFilePath: string, updateData: SummaryUpdateData): boolean {
  return defaultPlanGenerator.updateSummaryLog(summaryFilePath, updateData);
}

export function scaffoldPlanDirectory(params: ScaffoldParams = {}): ScaffoldResult {
  return defaultPlanGenerator.scaffoldPlanDirectory(params);
}
