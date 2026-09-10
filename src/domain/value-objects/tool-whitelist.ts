/**
 * agyloop - ToolWhitelist Value Object
 *
 * Immutable, self-validating value object enforcing allowed and forbidden toolsets.
 */

import {
  READ_ONLY_TOOLS,
  FORBIDDEN_WRITE_TOOLS,
  IMPLEMENTER_TOOLS
} from '../constants';
import { PhysicalWriteViolationError, ValidationError } from '../errors';

export class ToolWhitelist {
  private readonly toolSet: ReadonlySet<string>;

  constructor(tools: readonly string[]) {
    if (!Array.isArray(tools)) {
      throw new ValidationError('tools', tools, 'Tools whitelist must be an array of strings.');
    }

    // Defensive check: ensure non-empty strings
    for (const tool of tools) {
      if (typeof tool !== 'string' || tool.trim().length === 0) {
        throw new ValidationError('tool', tool, 'Each tool in the whitelist must be a non-empty string.');
      }
    }

    this.toolSet = Object.freeze(new Set(tools.map((t) => t.trim())));
    Object.freeze(this);
  }

  public isAllowed(toolName: string): boolean {
    return this.toolSet.has(toolName);
  }

  public assertAllowed(toolName: string): void {
    if (!this.isAllowed(toolName)) {
      throw new PhysicalWriteViolationError(toolName);
    }
  }

  public toArray(): readonly string[] {
    return Array.from(this.toolSet);
  }

  public hasForbiddenWriteTools(): boolean {
    return (FORBIDDEN_WRITE_TOOLS as readonly string[]).some((tool) => this.toolSet.has(tool));
  }

  public static readOnly(): ToolWhitelist {
    return new ToolWhitelist(READ_ONLY_TOOLS);
  }

  public static implementation(): ToolWhitelist {
    return new ToolWhitelist(IMPLEMENTER_TOOLS);
  }

  public static custom(tools: readonly string[]): ToolWhitelist {
    return new ToolWhitelist(tools);
  }
}
