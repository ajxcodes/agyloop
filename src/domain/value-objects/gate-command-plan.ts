/**
 * agyloop - GateCommandPlan Value Object (issue #298)
 *
 * The resolved verification command list WITH its provenance. The source is a
 * fact produced by the resolver, never inferred by a consumer: a dispatched
 * gate prompt and an in-process gate both quote this record.
 *
 * Pure domain: no I/O, no external imports.
 */

import {
  GateCommandDefinition,
  CMD_ID_LINT,
  GATE_COMMAND_SOURCE_EXPLICIT,
  GATE_COMMAND_SOURCE_PLAN,
  GATE_COMMAND_SOURCE_CONFIG,
  GATE_COMMAND_SOURCE_ACT,
  GATE_COMMAND_SOURCE_AUTO_DETECT,
  GATE_COMMAND_SOURCE_DEFAULT,
  GATE_TARGET_RULE_WORKFLOW_LINT_MISSING,
  WORKFLOW_LINT_BINARY
} from '../constants';
import { GateTargetFinding } from './quality-gate-targets';

/** Where the executed command list came from. */
export type GateCommandSource =
  | typeof GATE_COMMAND_SOURCE_EXPLICIT
  | typeof GATE_COMMAND_SOURCE_PLAN
  | typeof GATE_COMMAND_SOURCE_CONFIG
  | typeof GATE_COMMAND_SOURCE_ACT
  | typeof GATE_COMMAND_SOURCE_AUTO_DETECT
  | typeof GATE_COMMAND_SOURCE_DEFAULT;

/**
 * The workflow-lint step COMPOSED onto a plan-sourced list (#369, was #368).
 *
 * Plan targets replace the act container gate, so a change that edits
 * `.github/workflows/**` needs the workflow linter appended with provenance —
 * or the gate must refuse, naming the file and the missing command.
 */
export interface GateCommandComposition {
  /** True when the change touches workflows and the chosen list omits a workflow linter. */
  readonly required: boolean;
  /** Changed `.github/workflows/**` paths, relative to the workspace. */
  readonly files: readonly string[];
  /** The appended command, or null when none could be resolved. */
  readonly command: string | null;
  /** Why no command was appended (null when not required or when `command` is set). */
  readonly unavailableReason: string | null;
}

export interface GateCommandPlan {
  /** Commands in execution order. Plan order is never reordered. */
  readonly commands: readonly GateCommandDefinition[];
  /** The precedence tier that produced the list. */
  readonly source: GateCommandSource;
  /** Human-readable detail (the config file, the plan path, the detection). */
  readonly sourceDetail: string;
  /** Commands appended by the resolver after the chosen list (lint). */
  readonly appended: readonly string[];
  /** True when the project is Node and a lint command was detected. */
  readonly lintRequired: boolean;
  /** The lint command the gate must run, or null when lint is not required. */
  readonly lintCommand: string | null;
  /** The plan path the targets were read from, when any. */
  readonly planPath: string | null;
  /** The composed workflow-lint step, when a plan-sourced list was checked (#369). */
  readonly composition?: GateCommandComposition;
}

/**
 * True when a definition IS a lint command.
 *
 * Matched on the id, or on a standalone `lint` token in the command. `eslint`
 * is deliberately NOT a match on its own: `npx eslint .` does lint, but the
 * canonical script the Node detector emits is `<pkgMgr> run lint`, and a bare
 * `eslint` binary invocation is not what the invariant protects.
 */
export function isLintCommand(def: GateCommandDefinition): boolean {
  if (def.id === CMD_ID_LINT) {
    return true;
  }
  return def.command
    .split(/\s+/)
    .some((token) => token === CMD_ID_LINT);
}

/** True when at least one resolved command is a lint command. */
export function hasLintCommand(commands: readonly GateCommandDefinition[]): boolean {
  return commands.some((def) => isLintCommand(def));
}

/** True when a path is a GitHub Actions workflow file (#369). */
export function isWorkflowPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('.github/workflows/')) return false;
  return /\.ya?ml$/i.test(normalized);
}

/**
 * True when a command runs a workflow linter: an `actionlint` token (including
 * `npx actionlint` and `docker … rhysd/actionlint`), or `act` as the command.
 */
export function isWorkflowLintCommand(command: string): boolean {
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (
    tokens.some((token) => token === WORKFLOW_LINT_BINARY || token.endsWith(`/${WORKFLOW_LINT_BINARY}`))
  ) {
    return true;
  }
  let index = 0;
  if (tokens[index] === 'env') {
    index += 1;
    while (
      index < tokens.length &&
      (tokens[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))
    ) {
      index += 1;
    }
  }
  return tokens[index] === 'act';
}

/**
 * A required composition with no resolved command fails the gate CLOSED (#369).
 *
 * The finding is consumed by the same fail-closed preflight as the other gate
 * target rules, BEFORE any command runs.
 */
export function lintWorkflowGateComposition(
  plan: GateCommandPlan
): readonly GateTargetFinding[] {
  const composition = plan.composition;
  if (!composition || !composition.required || composition.command !== null) {
    return [];
  }
  return [
    {
      rule: GATE_TARGET_RULE_WORKFLOW_LINT_MISSING,
      index: 0,
      line: 0,
      command: WORKFLOW_LINT_BINARY,
      detail: composition.files.join(', ')
    }
  ];
}
