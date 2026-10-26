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
  GATE_COMMAND_SOURCE_DEFAULT
} from '../constants';

/** Where the executed command list came from. */
export type GateCommandSource =
  | typeof GATE_COMMAND_SOURCE_EXPLICIT
  | typeof GATE_COMMAND_SOURCE_PLAN
  | typeof GATE_COMMAND_SOURCE_CONFIG
  | typeof GATE_COMMAND_SOURCE_ACT
  | typeof GATE_COMMAND_SOURCE_AUTO_DETECT
  | typeof GATE_COMMAND_SOURCE_DEFAULT;

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
