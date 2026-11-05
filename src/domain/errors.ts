/**
 * codeloop - Sealed Domain Error Hierarchy
 *
 * Provides strongly-typed, discriminated error classes for domain rule
 * violations, storage errors, config issues, and write violations.
 */



export abstract class CodeLoopError extends Error {
  public abstract readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidTransitionError extends CodeLoopError {
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

export class PhysicalWriteViolationError extends CodeLoopError {
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

export class GitHubContextError extends CodeLoopError {
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

export class ConfigResolutionError extends CodeLoopError {
  public readonly code = ERR_CONFIG_RESOLUTION;
  public readonly target: string;

  constructor(target: string, customMessage?: string, details?: Record<string, unknown>) {
    const msg = customMessage || `Failed to resolve configuration for '${target}'.`;
    super(msg, { target, ...details });
    this.target = target;
  }
}

export class CircuitBreakerTrippedError extends CodeLoopError {
  public readonly code = ERR_CIRCUIT_BREAKER_TRIPPED;
  public readonly breaker: string;
  public readonly limit: number;
  public readonly actual: number;
  public readonly action: string;

  constructor(
    breaker: string,
    limit: number,
    actual: number,
    action: string,
    customMessage?: string
  ) {
    const msg =
      customMessage ||
      `Circuit breaker '${breaker}' tripped: exceeded limit ${limit} (actual: ${actual}). Action: ${action}.`;
    super(msg, { breaker, limit, actual, action });
    this.breaker = breaker;
    this.limit = limit;
    this.actual = actual;
    this.action = action;
  }
}

export class EmergencyAbortError extends CodeLoopError {
  public readonly code = ERR_EMERGENCY_ABORT;
  public readonly reason: string;

  constructor(reason: string, details?: Record<string, unknown>) {
    super(`Emergency abort triggered: ${reason}`, details);
    this.reason = reason;
  }
}

export class StateStorageError extends CodeLoopError {
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

export class ValidationError extends CodeLoopError {
  public readonly code = ERR_VALIDATION;
  public readonly field: string;
  public readonly value: unknown;

  constructor(field: string, value: unknown, reason: string) {
    super(`Validation failed for field '${field}': ${reason}`, { field, value, reason });
    this.field = field;
    this.value = value;
  }
}

export class QualityGateTimeoutError extends CodeLoopError {
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

export class QualityGateExecutionError extends CodeLoopError {
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

export class BuildDetectionError extends CodeLoopError {
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

export class QualityGateSummaryParseError extends CodeLoopError {
  public readonly code = ERR_GATE_SUMMARY_PARSE;
  public readonly rawContent: string;
  public readonly reason: string;

  constructor(rawContent: string, reason: string, details?: Record<string, unknown>) {
    super(`Failed to parse Quality Gate summary protocol: ${reason}`, { rawContent, reason, ...details });
    this.rawContent = rawContent;
    this.reason = reason;
  }
}

export class CritiqueError extends CodeLoopError {
  public readonly code = ERR_CRITIQUE;
  public readonly operation: string;
  public readonly reason: string;

  constructor(operation: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Critique error during '${operation}': ${reason}${causeMsg}`, { operation, reason, ...details });
    this.operation = operation;
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

export const AiReviewerError = CritiqueError;
export type AiReviewerError = CritiqueError;

export class CritiqueInstallError extends CodeLoopError {
  public readonly code = ERR_CRITIQUE_INSTALL;
  public readonly operation: string;
  public readonly reason: string;

  constructor(operation: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Critique install error during '${operation}': ${reason}${causeMsg}`, { operation, reason, ...details });
    this.operation = operation;
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class CritiqueUpdateError extends CodeLoopError {
  public readonly code = ERR_CRITIQUE_UPDATE;
  public readonly operation: string;
  public readonly reason: string;

  constructor(operation: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Critique update error during '${operation}': ${reason}${causeMsg}`, { operation, reason, ...details });
    this.operation = operation;
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class ReviewerSubagentError extends CodeLoopError {
  public readonly code = ERR_REVIEWER_SUBAGENT;
  public readonly operation: string;
  public readonly reason: string;

  constructor(operation: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Reviewer subagent error during '${operation}': ${reason}${causeMsg}`, { operation, reason, ...details });
    this.operation = operation;
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * An operator `--refute` that could not be honoured (issue #349).
 *
 * Raised BEFORE any checkpoint write, so a refused refutation leaves the
 * checkpoint byte-identical: every condition in the plan's fail-closed table
 * (no reason, malformed target, unknown/ambiguous/duplicate target, no report,
 * no filed `APPROVED` verdict) is a hard error that records nothing.
 *
 * `refusals` carries one human-readable line per refused spec so the CLI can
 * print every diagnostic rather than just the first.
 */
export class RefutationRefusedError extends CodeLoopError {
  public readonly code = ERR_REFUTATION_REFUSED;
  public readonly operation = 'review' as const;
  public readonly refusals: readonly string[];

  constructor(operation: 'review', refusals: readonly string[]) {
    const lines = refusals.length > 0 ? refusals : ['A refutation was refused.'];
    super(lines.join('; '), { operation, refusals: lines });
    this.operation = operation;
    this.refusals = Object.freeze([...lines]);
  }
}

export class CommitExecutionError extends CodeLoopError {
  public readonly code = ERR_COMMIT_EXECUTION;
  public readonly operation: string;
  public readonly reason: string;

  constructor(operation: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Commit execution error during '${operation}': ${reason}${causeMsg}`, { operation, reason, ...details });
    this.operation = operation;
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class WorktreeError extends CodeLoopError {
  public readonly code = ERR_WORKTREE;
  public readonly operation: string;
  public readonly reason: string;

  constructor(operation: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Worktree error during '${operation}': ${reason}${causeMsg}`, { operation, reason, ...details });
    this.operation = operation;
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class WorktreeCreationError extends WorktreeError {
  constructor(operation: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    super(operation, reason, details, cause);
  }
}

export class WorktreeCleanupError extends WorktreeError {
  constructor(operation: string, reason: string, details?: Record<string, unknown>, cause?: unknown) {
    super(operation, reason, details, cause);
  }
}

export class PreFlightHaltError extends CodeLoopError {
  public readonly code = ERR_PREFLIGHT_HALT;
  public readonly reason: string;
  public readonly haltType: 'CLOSED' | 'MERGED' | string;

  constructor(reason: string, haltType: 'CLOSED' | 'MERGED' | string = 'GENERAL', details?: Record<string, unknown>) {
    super(reason, { haltType, ...details });
    this.reason = reason;
    this.haltType = haltType;
  }
}

export class MilestoneReleaseError extends CodeLoopError {
  public readonly code = ERR_MILESTONE_RELEASE;
  public readonly reason: string;

  constructor(reason: string, details?: Record<string, unknown>, cause?: unknown) {
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Milestone release error: ${reason}${causeMsg}`, details);
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class MilestoneSealedError extends CodeLoopError {
  public readonly code = ERR_MILESTONE_SEALED;
  public readonly phaseBranch: string;

  constructor(phaseBranch: string, customMessage?: string) {
    const msg =
      customMessage ||
      `Milestone sealed: Collector branch '${phaseBranch}' is already merged into 'main'. Cannot add new task work to a completed milestone.`;
    super(msg, { phaseBranch });
    this.phaseBranch = phaseBranch;
  }
}

/* eslint-disable @typescript-eslint/no-unused-vars */


export const ERR_INVALID_TRANSITION = 'ERR_INVALID_TRANSITION' as const;

export const ERR_PHYSICAL_WRITE_VIOLATION = 'ERR_PHYSICAL_WRITE_VIOLATION' as const;

export const ERR_GITHUB_CONTEXT = 'ERR_GITHUB_CONTEXT' as const;

export const ERR_CONFIG_RESOLUTION = 'ERR_CONFIG_RESOLUTION' as const;

export const ERR_STATE_STORAGE = 'ERR_STATE_STORAGE' as const;

export const ERR_VALIDATION = 'ERR_VALIDATION' as const;

export const ERR_GATE_TIMEOUT = 'ERR_GATE_TIMEOUT' as const;

export const ERR_GATE_EXECUTION = 'ERR_GATE_EXECUTION' as const;

export const ERR_BUILD_DETECTION = 'ERR_BUILD_DETECTION' as const;

export const ERR_GATE_SUMMARY_PARSE = 'ERR_GATE_SUMMARY_PARSE' as const;

export const ERR_CRITIQUE = 'ERR_CRITIQUE' as const;

export const ERR_AI_REVIEWER = ERR_CRITIQUE;

export const ERR_CRITIQUE_INSTALL = 'ERR_CRITIQUE_INSTALL' as const;

export const ERR_CRITIQUE_UPDATE = 'ERR_CRITIQUE_UPDATE' as const;

export const ERR_REVIEWER_SUBAGENT = 'ERR_REVIEWER_SUBAGENT' as const;

export const ERR_REFUTATION_REFUSED = 'ERR_REFUTATION_REFUSED' as const;

export const ERR_COMMIT_EXECUTION = 'ERR_COMMIT_EXECUTION' as const;

export const ERR_WORKTREE = 'ERR_WORKTREE' as const;

export const ERR_PREFLIGHT_HALT = 'ERR_PREFLIGHT_HALT' as const;

export const ERR_MILESTONE_RELEASE = 'ERR_MILESTONE_RELEASE' as const;

export const ERR_MILESTONE_SEALED = 'ERR_MILESTONE_SEALED' as const;

export const ERR_CIRCUIT_BREAKER_TRIPPED = 'ERR_CIRCUIT_BREAKER_TRIPPED' as const;

export const ERR_EMERGENCY_ABORT = 'ERR_EMERGENCY_ABORT' as const;

export const ERR_QUOTA_EXHAUSTED = 'ERR_QUOTA_EXHAUSTED' as const;

export const HALT_TYPE_MISSING_PLAN_DIR = 'MISSING_PLAN_DIR' as const;


export const ERROR_CODES = Object.freeze({
  INVALID_TRANSITION: ERR_INVALID_TRANSITION,
  PHYSICAL_WRITE_VIOLATION: ERR_PHYSICAL_WRITE_VIOLATION,
  GITHUB_CONTEXT: ERR_GITHUB_CONTEXT,
  CONFIG_RESOLUTION: ERR_CONFIG_RESOLUTION,
  STATE_STORAGE: ERR_STATE_STORAGE,
  VALIDATION: ERR_VALIDATION,
  GATE_TIMEOUT: ERR_GATE_TIMEOUT,
  GATE_EXECUTION: ERR_GATE_EXECUTION,
  BUILD_DETECTION: ERR_BUILD_DETECTION,
  GATE_SUMMARY_PARSE: ERR_GATE_SUMMARY_PARSE,
  CRITIQUE: ERR_CRITIQUE,
  AI_REVIEWER: ERR_CRITIQUE,
  CRITIQUE_INSTALL: ERR_CRITIQUE_INSTALL,
  CRITIQUE_UPDATE: ERR_CRITIQUE_UPDATE,
  REVIEWER_SUBAGENT: ERR_REVIEWER_SUBAGENT,
  REFUTATION_REFUSED: ERR_REFUTATION_REFUSED,
  COMMIT_EXECUTION: ERR_COMMIT_EXECUTION,
  WORKTREE: ERR_WORKTREE,
  PREFLIGHT_HALT: ERR_PREFLIGHT_HALT,
  MILESTONE_RELEASE: ERR_MILESTONE_RELEASE,
  MILESTONE_SEALED: ERR_MILESTONE_SEALED,
  CIRCUIT_BREAKER_TRIPPED: ERR_CIRCUIT_BREAKER_TRIPPED,
  EMERGENCY_ABORT: ERR_EMERGENCY_ABORT,
  PREFLIGHT_HALT_MISSING_PLAN_DIR: HALT_TYPE_MISSING_PLAN_DIR,
  QUOTA_EXHAUSTED: ERR_QUOTA_EXHAUSTED
});



export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];
