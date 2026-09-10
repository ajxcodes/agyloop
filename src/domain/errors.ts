/**
 * agyloop - Sealed Domain Error Hierarchy
 *
 * Provides strongly-typed, discriminated error classes for domain rule
 * violations, storage errors, config issues, and write violations.
 */

import {
  ErrorCode,
  ERR_INVALID_TRANSITION,
  ERR_PHYSICAL_WRITE_VIOLATION,
  ERR_GITHUB_CONTEXT,
  ERR_CONFIG_RESOLUTION,
  ERR_STATE_STORAGE,
  ERR_VALIDATION
} from './constants';

export abstract class AgyLoopError extends Error {
  public abstract readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidTransitionError extends AgyLoopError {
  public readonly code = ERR_INVALID_TRANSITION;
  public readonly fromStage: string;
  public readonly toStage: string;
  public readonly mode: string;

  constructor(fromStage: string, toStage: string, mode: string, customMessage?: string) {
    const msg =
      customMessage ||
      `Invalid lifecycle transition: Cannot transition from '${fromStage}' to '${toStage}' in mode '${mode}'.`;
    super(msg, { fromStage, toStage, mode });
    this.fromStage = fromStage;
    this.toStage = toStage;
    this.mode = mode;
  }
}

export class PhysicalWriteViolationError extends AgyLoopError {
  public readonly code = ERR_PHYSICAL_WRITE_VIOLATION;
  public readonly toolOrCapability: string;

  constructor(toolOrCapability: string, customMessage?: string) {
    const msg =
      customMessage ||
      `Physical write suppression violation: Planning subagent is strictly forbidden from invoking '${toolOrCapability}'.`;
    super(msg, { toolOrCapability });
    this.toolOrCapability = toolOrCapability;
  }
}

export class GitHubContextError extends AgyLoopError {
  public readonly code = ERR_GITHUB_CONTEXT;
  public readonly operation: string;

  constructor(operation: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`GitHub context error during '${operation}'${causeMsg}`, details);
    this.operation = operation;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class ConfigResolutionError extends AgyLoopError {
  public readonly code = ERR_CONFIG_RESOLUTION;
  public readonly target: string;

  constructor(target: string, customMessage?: string, details?: Record<string, unknown>) {
    const msg = customMessage || `Failed to resolve configuration for '${target}'.`;
    super(msg, { target, ...details });
    this.target = target;
  }
}

export class StateStorageError extends AgyLoopError {
  public readonly code = ERR_STATE_STORAGE;
  public readonly filePath: string;
  public readonly operation: string;

  constructor(filePath: string, operation: string, customMessage?: string, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    const msg = customMessage || `State storage failed during '${operation}' on '${filePath}'${causeMsg}`;
    super(msg, { filePath, operation });
    this.filePath = filePath;
    this.operation = operation;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class ValidationError extends AgyLoopError {
  public readonly code = ERR_VALIDATION;
  public readonly field: string;
  public readonly value: unknown;

  constructor(field: string, value: unknown, reason: string) {
    super(`Validation failed for field '${field}': ${reason}`, { field, value, reason });
    this.field = field;
    this.value = value;
  }
}
