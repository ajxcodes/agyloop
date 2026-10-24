/**
 * agyloop - FilePromptRepository Infrastructure Adapter
 *
 * Implements PromptRepository to resolve and load subagent system prompts from disk
 * with fallback to immutable domain default prompts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PromptRepository, PromptLoadOptions } from '../ports';
import {
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  ROLE_DISCOVERY,
  ROLE_TRIAGE,
  DEFAULT_PROMPTS_DIR,
  PROMPT_FILE_PLANNER,
  PROMPT_FILE_IMPLEMENTER,
  PROMPT_FILE_GATE,
  PROMPT_FILE_REVIEWER,
  PROMPT_FILE_DISCOVERY,
  PROMPT_FILE_TRIAGE,
  DEFAULT_PLANNER_SYSTEM_PROMPT,
  DEFAULT_IMPLEMENTER_SYSTEM_PROMPT,
  DEFAULT_GATE_SYSTEM_PROMPT,
  DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT,
  DEFAULT_DISCOVERY_SYSTEM_PROMPT,
  buildDefaultTriageSystemPrompt
} from '../domain';


export class FilePromptRepository implements PromptRepository {
  public loadPrompt(role: string, options: PromptLoadOptions = {}): string {
    const cwd = options.cwd || process.cwd();
    let promptFileName: string;

    if (role === ROLE_PLANNER) {
      promptFileName = PROMPT_FILE_PLANNER;
    } else if (role === ROLE_IMPLEMENTER) {
      promptFileName = PROMPT_FILE_IMPLEMENTER;
    } else if (role === ROLE_GATE) {
      promptFileName = PROMPT_FILE_GATE;
    } else if (role === ROLE_REVIEWER) {
      promptFileName = PROMPT_FILE_REVIEWER;
    } else if (role === ROLE_DISCOVERY) {
      promptFileName = PROMPT_FILE_DISCOVERY;
    } else if (role === ROLE_TRIAGE) {
      promptFileName = PROMPT_FILE_TRIAGE;
    } else {
      promptFileName = `${role}.md`;
    }

    const defaultPath = path.resolve(cwd, DEFAULT_PROMPTS_DIR, promptFileName);
    const targetPath = options.promptPath || defaultPath;

    if (fs.existsSync(targetPath)) {
      try {
        return fs.readFileSync(targetPath, 'utf8');
      } catch {
        // Fall back to embedded domain default
      }
    }

    if (role === ROLE_PLANNER) {
      return DEFAULT_PLANNER_SYSTEM_PROMPT;
    }
    if (role === ROLE_IMPLEMENTER) {
      return DEFAULT_IMPLEMENTER_SYSTEM_PROMPT;
    }
    if (role === ROLE_GATE) {
      return DEFAULT_GATE_SYSTEM_PROMPT;
    }
    if (role === ROLE_REVIEWER) {
      return DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT;
    }
    if (role === ROLE_DISCOVERY) {
      return DEFAULT_DISCOVERY_SYSTEM_PROMPT;
    }
    if (role === ROLE_TRIAGE) {
      return buildDefaultTriageSystemPrompt();
    }

    return '';
  }
}

