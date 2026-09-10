/**
 * agyloop - VerificationCommandSet Value Object
 *
 * Immutable, self-validating value object encapsulating an ordered set of verification commands.
 */

import {
  GateCommandDefinition,
  DEFAULT_GATE_COMMANDS,
  CMD_ID_BUILD,
  CMD_ID_TYPECHECK,
  CMD_ID_TEST,
  CMD_ID_PLAYWRIGHT,
  CMD_ID_E2E,
  KEYWORD_CHECK,
  KEYWORD_VET
} from '../constants';
import { ValidationError } from '../errors';

export class VerificationCommandSet {
  private readonly commandList: readonly GateCommandDefinition[];

  constructor(commands: readonly GateCommandDefinition[] = []) {
    if (!Array.isArray(commands)) {
      throw new ValidationError('commands', commands, 'VerificationCommandSet must receive an array of command definitions.');
    }

    const seenIds = new Set<string>();
    const validated: GateCommandDefinition[] = [];

    for (let i = 0; i < commands.length; i++) {
      const item = commands[i];
      if (!item || typeof item !== 'object') {
        throw new ValidationError(`commands[${i}]`, item, 'Each command definition must be an object.');
      }
      if (typeof item.id !== 'string' || item.id.trim().length === 0) {
        throw new ValidationError(`commands[${i}].id`, item.id, 'Command id must be a non-empty string.');
      }
      if (typeof item.label !== 'string' || item.label.trim().length === 0) {
        throw new ValidationError(`commands[${i}].label`, item.label, 'Command label must be a non-empty string.');
      }
      if (typeof item.command !== 'string' || item.command.trim().length === 0) {
        throw new ValidationError(`commands[${i}].command`, item.command, 'Command string must be a non-empty string.');
      }

      const trimmedId = item.id.trim();
      if (seenIds.has(trimmedId)) {
        throw new ValidationError(`commands[${i}].id`, trimmedId, `Duplicate command ID '${trimmedId}' found in command set.`);
      }
      seenIds.add(trimmedId);

      validated.push(
        Object.freeze({
          id: trimmedId,
          label: item.label.trim(),
          command: item.command.trim()
        })
      );
    }

    this.commandList = Object.freeze(validated);
    Object.freeze(this);
  }

  public isEmpty(): boolean {
    return this.commandList.length === 0;
  }

  public size(): number {
    return this.commandList.length;
  }

  public toArray(): readonly GateCommandDefinition[] {
    return this.commandList;
  }

  public getCommandStrings(): readonly string[] {
    return this.commandList.map((c) => c.command);
  }

  public hasBuild(): boolean {
    return this.commandList.some((c) => {
      const id = c.id.toLowerCase();
      return (
        id.includes(CMD_ID_BUILD) ||
        id.includes(CMD_ID_TYPECHECK) ||
        id.includes(KEYWORD_CHECK) ||
        id.includes(KEYWORD_VET)
      );
    });
  }

  public hasTest(): boolean {
    return this.commandList.some((c) => c.id.toLowerCase().includes(CMD_ID_TEST));
  }

  public hasE2E(): boolean {
    return this.commandList.some((c) => {
      const id = c.id.toLowerCase();
      const label = c.label.toLowerCase();
      return (
        id.includes(CMD_ID_E2E) ||
        id.includes(CMD_ID_PLAYWRIGHT) ||
        label.includes(CMD_ID_PLAYWRIGHT)
      );
    });
  }

  public get(id: string): GateCommandDefinition | undefined {
    return this.commandList.find((c) => c.id === id);
  }

  public static from(commands: readonly GateCommandDefinition[]): VerificationCommandSet {
    return new VerificationCommandSet(commands);
  }

  public static empty(): VerificationCommandSet {
    return new VerificationCommandSet([]);
  }

  public static default(): VerificationCommandSet {
    return new VerificationCommandSet(DEFAULT_GATE_COMMANDS);
  }
}
