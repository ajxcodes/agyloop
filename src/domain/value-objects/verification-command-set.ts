/**
 * agyloop - VerificationCommandSet Value Object
 *
 * Immutable, self-validating value object encapsulating an ordered set of verification commands.
 */

import { GateCommandDefinition, DEFAULT_GATE_COMMANDS } from '../constants';
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
    return this.commandList.some(
      (c) =>
        c.id.toLowerCase().includes('build') ||
        c.id.toLowerCase().includes('typecheck') ||
        c.id.toLowerCase().includes('check') ||
        c.id.toLowerCase().includes('vet')
    );
  }

  public hasTest(): boolean {
    return this.commandList.some((c) => c.id.toLowerCase().includes('test'));
  }

  public hasE2E(): boolean {
    return this.commandList.some(
      (c) =>
        c.id.toLowerCase().includes('e2e') ||
        c.id.toLowerCase().includes('playwright') ||
        c.label.toLowerCase().includes('playwright')
    );
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
