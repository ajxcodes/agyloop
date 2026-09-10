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
  ERR_VALIDATION,
  ERR_GATE_TIMEOUT,
  ERR_GATE_EXECUTION,
  ERR_BUILD_DETECTION,
  ERR_GATE_SUMMARY_PARSE
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

export class QualityGateTimeoutError extends AgyLoopError {
  public readonly code = ERR_GATE_TIMEOUT;
  public readonly command: string;
  public readonly timeoutSeconds: number;
  public readonly elapsedMs: number;

  constructor(command: string, timeoutSeconds: number, elapsedMs: number, customMessage?: string) {
    const msg =
      customMessage ||
      `Quality gate command '${command}' timed out after ${timeoutSeconds}s (${elapsedMs}ms elapsed).`;
    super(msg, { command, timeoutSeconds, elapsedMs });
    this.command = command;
    this.timeoutSeconds = timeoutSeconds;
    this.elapsedMs = elapsedMs;
  }
}

export class QualityGateExecutionError extends AgyLoopError {
  public readonly code = ERR_GATE_EXECUTION;
  public readonly command: string;
  public readonly exitCode: number;
  public readonly failureSnippet?: string;

  constructor(command: string, exitCode: number, failureSnippet?: string, customMessage?: string) {
    const msg =
      customMessage ||
      `Quality gate command '${command}' failed with exit code ${exitCode}.`;
    super(msg, { command, exitCode, failureSnippet });
    this.command = command;
    this.exitCode = exitCode;
    this.failureSnippet = failureSnippet;
  }
}

export class BuildDetectionError extends AgyLoopError {
  public readonly code = ERR_BUILD_DETECTION;
  public readonly target: string;
  public readonly reason: string;

  constructor(target: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Build system detection failed for '${target}': ${reason}${causeMsg}`, { target, reason, ...details });
    this.target = target;
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class QualityGateSummaryParseError extends AgyLoopError {
  public readonly code = ERR_GATE_SUMMARY_PARSE;
  public readonly rawContent: string;
  public readonly reason: string;

  constructor(rawContent: string, reason: string, details?: Record<string, unknown>) {
    super(`Failed to parse Quality Gate summary protocol: ${reason}`, { rawContent, reason, ...details });
    this.rawContent = rawContent;
    this.reason = reason;
  }
}


