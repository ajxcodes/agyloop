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
    const targetPath = this.resolvePath(role, options);

    if (targetPath) {
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

  /**
   * Issue #290 (AC6): the ONE resolver `loadPrompt` also uses, so the label the
   * inspection command prints can never disagree with what was read.
   */
  public resolvePromptPath(role: string, options: PromptLoadOptions = {}): string | null {
    return this.resolvePath(role, options);
  }

  private resolvePath(role: string, options: PromptLoadOptions): string | null {
    const cwd = options.cwd || process.cwd();
    const defaultPath = path.resolve(cwd, DEFAULT_PROMPTS_DIR, this.promptFileNameFor(role));
    const targetPath = options.promptPath || defaultPath;
    return fs.existsSync(targetPath) ? targetPath : null;
  }

  private promptFileNameFor(role: string): string {
    if (role === ROLE_PLANNER) {
      return PROMPT_FILE_PLANNER;
    }
    if (role === ROLE_IMPLEMENTER) {
      return PROMPT_FILE_IMPLEMENTER;
    }
    if (role === ROLE_GATE) {
      return PROMPT_FILE_GATE;
    }
    if (role === ROLE_REVIEWER) {
      return PROMPT_FILE_REVIEWER;
    }
    if (role === ROLE_DISCOVERY) {
      return PROMPT_FILE_DISCOVERY;
    }
    if (role === ROLE_TRIAGE) {
      return PROMPT_FILE_TRIAGE;
    }
    return `${role}.md`;
  }
}

