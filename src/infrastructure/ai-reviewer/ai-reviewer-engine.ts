/**
 * agyloop - AiReviewerEngine (Infrastructure Layer)
 *
 * Idiomatic TypeScript implementation of the AI PR Reviewer core engine.
 * Handles environment discovery, diff extraction, prompt assembly, and Gemini API querying.
 * Zero magic strings/numbers; all thresholds and constants referenced from domain/constants.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AI_REVIEWER_MODELS,
  AI_REVIEWER_DEFAULT_TEMPERATURE,
  AI_REVIEWER_DEFAULT_MIME_TYPE,
  AI_REVIEWER_DEFAULT_TIMEOUT_MS,
  AI_REVIEWER_RETRY_DELAY_MS,
  AI_REVIEWER_MAX_DIFF_CHARS,
  GEMINI_API_BASE_URL,
  HTTP_STATUS_OK,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  ENV_FILE_NAME,
  ENV_VAR_GEMINI_API_KEY,
  PATH_WORKFLOW_AI_REVIEWER,
  REGEX_ENV_KEY_VAL,
  REGEX_WORKFLOW_PROMPT,
  DEFAULT_AI_REVIEWER_SYSTEM_INSTRUCTION,
  DEFAULT_NO_UNRESOLVED_THREADS_TEXT,
  MSG_MISSING_API_KEY,
  MSG_CLEAN_DIFF_REVIEW,
  MSG_ALL_MODELS_FAILED
} from '../../domain/constants';
import { AiReviewerError } from '../../domain/errors';
import { AiReviewReport } from '../../domain/value-objects/ai-review-report';
import { AiReviewOptions } from '../../ports/ai-reviewer';
import { CommandExecutorPort } from '../../ports/command-executor';
import { ProcessCommandExecutor } from '../process-command-executor';

export interface AiReviewEngineDependencies {
  readonly commandExecutor?: CommandExecutorPort;
  readonly fetchFn?: typeof fetch;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

export function loadEnvironmentFile(filePath: string): Record<string, string> {
  const envMap: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    return envMap;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(REGEX_ENV_KEY_VAL);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        if (val.length > 0 && val.startsWith('"') && val.endsWith('"')) {
          val = val.replace(/\\n/g, '\n');
        }
        val = val.replace(/(^['"]|['"]$)/g, '').trim();
        envMap[key] = val;
      }
    }
  } catch {
    // Ignore read or parse errors from malformed env files
  }

  return envMap;
}

export function resolveGeminiApiKey(cwd?: string, explicitEnv?: Readonly<Record<string, string | undefined>>): string | null {
  if (explicitEnv && explicitEnv[ENV_VAR_GEMINI_API_KEY]) {
    return explicitEnv[ENV_VAR_GEMINI_API_KEY]!;
  }
  if (process.env[ENV_VAR_GEMINI_API_KEY]) {
    return process.env[ENV_VAR_GEMINI_API_KEY]!;
  }

  // Check ./.env in workspace
  const localEnvPath = path.join(cwd || process.cwd(), ENV_FILE_NAME);
  const localEnv = loadEnvironmentFile(localEnvPath);
  if (localEnv[ENV_VAR_GEMINI_API_KEY]) {
    return localEnv[ENV_VAR_GEMINI_API_KEY];
  }

  // Check ~/.env in home directory
  const homeEnvPath = path.join(os.homedir(), ENV_FILE_NAME);
  const homeEnv = loadEnvironmentFile(homeEnvPath);
  if (homeEnv[ENV_VAR_GEMINI_API_KEY]) {
    return homeEnv[ENV_VAR_GEMINI_API_KEY];
  }

  return null;
}

export async function generateGitDiff(
  options: { cwd?: string; staged?: boolean; baseRef?: string },
  executor: CommandExecutorPort
): Promise<string> {
  const cwd = options.cwd || process.cwd();

  if (options.staged) {
    const res = await executor.execute('git diff --cached', { cwd });
    return truncateDiff(res.stdout);
  }

  if (options.baseRef) {
    const res = await executor.execute(`git diff ${options.baseRef}...HEAD`, { cwd });
    return truncateDiff(res.stdout);
  }

  // Default: check unstaged + staged diff HEAD
  const headRes = await executor.execute('git diff HEAD', { cwd });
  if (headRes.stdout.trim()) {
    return truncateDiff(headRes.stdout);
  }

  // Fallback to origin/main...HEAD
  const originMainRes = await executor.execute('git diff origin/main...HEAD', { cwd });
  if (originMainRes.exitCode === 0 && originMainRes.stdout.trim()) {
    return truncateDiff(originMainRes.stdout);
  }

  // Fallback to origin/master...HEAD
  const originMasterRes = await executor.execute('git diff origin/master...HEAD', { cwd });
  if (originMasterRes.exitCode === 0 && originMasterRes.stdout.trim()) {
    return truncateDiff(originMasterRes.stdout);
  }

  return '';
}

function truncateDiff(diffText: string): string {
  const trimmed = diffText.trim();
  if (trimmed.length > AI_REVIEWER_MAX_DIFF_CHARS) {
    return `${trimmed.substring(0, AI_REVIEWER_MAX_DIFF_CHARS)}\n\n[Diff truncated due to size limit]`;
  }
  return trimmed;
}

export function loadWorkflowSystemInstruction(cwd?: string): string | null {
  const workflowPath = path.join(cwd || process.cwd(), PATH_WORKFLOW_AI_REVIEWER);
  if (!fs.existsSync(workflowPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const match = content.match(REGEX_WORKFLOW_PROMPT);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch {
    // Ignore error
  }
  return null;
}

export function buildReviewPrompt(diffText: string, cwd?: string): string {
  const customPrompt = loadWorkflowSystemInstruction(cwd);
  if (customPrompt) {
    let populated = customPrompt;
    populated = populated.replace(/\$\{previousThreadsText\}/g, DEFAULT_NO_UNRESOLVED_THREADS_TEXT);
    populated = populated.replace(/\$\{diffText\}/g, diffText);
    return populated;
  }

  return `${DEFAULT_AI_REVIEWER_SYSTEM_INSTRUCTION}

Here is the git diff of the changes:
\`\`\`diff
${diffText}
\`\`\``;
}

export async function queryGeminiReview(
  prompt: string,
  apiKey: string,
  dependencies: {
    fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<string> {
  const fetchClient = dependencies.fetchFn || globalThis.fetch;
  const sleep = dependencies.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = dependencies.timeoutMs || AI_REVIEWER_DEFAULT_TIMEOUT_MS;

  for (const model of AI_REVIEWER_MODELS) {
    const url = `${GEMINI_API_BASE_URL}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchClient(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: AI_REVIEWER_DEFAULT_TEMPERATURE,
            responseMimeType: AI_REVIEWER_DEFAULT_MIME_TYPE
          }
        }),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (response.status === HTTP_STATUS_OK) {
        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          return text;
        }
      }

      if (response.status === HTTP_STATUS_SERVICE_UNAVAILABLE) {
        await sleep(AI_REVIEWER_RETRY_DELAY_MS);
      }
    } catch {
      clearTimeout(timer);
      // Try next candidate model
    }
  }

  throw new AiReviewerError('queryGeminiReview', MSG_ALL_MODELS_FAILED);
}

export async function runAiReviewEngine(
  options: AiReviewOptions = {},
  dependencies: AiReviewEngineDependencies = {}
): Promise<AiReviewReport> {
  if (options.bypass) {
    return AiReviewReport.bypassed('Bypassed by option');
  }

  const apiKey = resolveGeminiApiKey(options.cwd, options.env);
  if (!apiKey) {
    return AiReviewReport.bypassed(MSG_MISSING_API_KEY);
  }

  const executor = dependencies.commandExecutor || new ProcessCommandExecutor();
  const diffText = await generateGitDiff(
    {
      cwd: options.cwd,
      staged: options.staged,
      baseRef: options.baseRef
    },
    executor
  );

  if (!diffText || !diffText.trim()) {
    return AiReviewReport.empty(MSG_CLEAN_DIFF_REVIEW);
  }

  const prompt = buildReviewPrompt(diffText, options.cwd);
  const jsonResponse = await queryGeminiReview(prompt, apiKey, {
    fetchFn: dependencies.fetchFn,
    sleepFn: dependencies.sleepFn,
    timeoutMs: options.timeoutMs
  });

  return AiReviewReport.parse(jsonResponse);
}
