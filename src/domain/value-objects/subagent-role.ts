/**
 * agyloop - SubagentRole Value Object
 *
 * Self-validating value object representing recognized subagent roles.
 */

import {
  SUBAGENT_ROLES,
  SubagentRoleName,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER
} from '../constants';
import { ValidationError } from '../errors';

export class SubagentRole {
  public readonly value: SubagentRoleName;

  constructor(rawRole: string) {
    if (!rawRole || typeof rawRole !== 'string') {
      throw new ValidationError('subagentRole', rawRole, 'Subagent role cannot be empty and must be a string.');
    }

    const normalized = rawRole.toLowerCase().trim() as SubagentRoleName;
    const validRoles = Object.values(SUBAGENT_ROLES);
    if (!validRoles.includes(normalized)) {
      throw new ValidationError(
        'subagentRole',
        rawRole,
        `Invalid subagent role '${rawRole}'. Valid roles are: ${validRoles.join(', ')}.`
      );
    }

    this.value = normalized;
    Object.freeze(this);
  }

  public equals(other: SubagentRole | null | undefined): boolean {
    if (!other) return false;
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }

  public static from(value: string): SubagentRole {
    return new SubagentRole(value);
  }

  public static planner(): SubagentRole {
    return new SubagentRole(ROLE_PLANNER);
  }

  public static implementer(): SubagentRole {
    return new SubagentRole(ROLE_IMPLEMENTER);
  }

  public static gate(): SubagentRole {
    return new SubagentRole(ROLE_GATE);
  }

  public static reviewer(): SubagentRole {
    return new SubagentRole(ROLE_REVIEWER);
  }
}
