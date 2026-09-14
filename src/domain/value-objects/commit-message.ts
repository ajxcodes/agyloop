/**
 * agyloop - CommitMessage Value Object
 *
 * Immutable, self-validating value object adhering strictly to the
 * Conventional Commits 1.0.0 specification:
 * <type>[optional scope][optional !]: <description>
 *
 * [optional body]
 *
 * [optional footer(s)]
 */

import {
  ConventionalCommitType,
  CONVENTIONAL_COMMIT_TYPES,
  REGEX_CONVENTIONAL_HEADER,
  REGEX_BREAKING_CHANGE_FOOTER,
  REGEX_ISSUE_NUMBER_REF,
  TOKEN_BREAKING_CHANGE,
  TOKEN_BREAKING_EXCLAMATION
} from '../constants';
import { ValidationError } from '../errors';

export interface CommitMessageProps {
  readonly type: ConventionalCommitType | string;
  readonly scope?: string | null;
  readonly description: string;
  readonly body?: string | null;
  readonly isBreaking?: boolean;
  readonly issueNumber?: number | null;
}

export interface CommitMessageSerialized {
  readonly type: string;
  readonly scope: string | null;
  readonly description: string;
  readonly body: string | null;
  readonly isBreaking: boolean;
  readonly issueNumber: number | null;
  readonly singleLine: string;
  readonly fullMessage: string;
}

export class CommitMessage {
  public readonly type: ConventionalCommitType;
  public readonly scope: string | null;
  public readonly description: string;
  public readonly body: string | null;
  public readonly isBreaking: boolean;
  public readonly issueNumber: number | null;

  constructor(props: CommitMessageProps) {
    if (!props || typeof props !== 'object') {
      throw new ValidationError('props', props, 'CommitMessage properties must be a valid object.');
    }

    const rawType = typeof props.type === 'string' ? props.type.trim().toLowerCase() : '';
    if (!rawType) {
      throw new ValidationError('type', props.type, 'Commit type cannot be empty.');
    }

    if (!CONVENTIONAL_COMMIT_TYPES.includes(rawType as ConventionalCommitType)) {
      throw new ValidationError(
        'type',
        rawType,
        `Invalid conventional commit type '${rawType}'. Expected one of: ${CONVENTIONAL_COMMIT_TYPES.join(', ')}.`
      );
    }
    this.type = rawType as ConventionalCommitType;

    if (props.scope !== undefined && props.scope !== null) {
      const trimmedScope = props.scope.trim().toLowerCase();
      if (trimmedScope.length === 0) {
        this.scope = null;
      } else {
        if (!/^[a-z0-9_.\-\/]+$/.test(trimmedScope)) {
          throw new ValidationError(
            'scope',
            props.scope,
            `Commit scope '${props.scope}' contains invalid characters. Must be alphanumeric with hyphens, underscores, or slashes.`
          );
        }
        this.scope = trimmedScope;
      }
    } else {
      this.scope = null;
    }

    const rawDesc = typeof props.description === 'string' ? props.description.trim() : '';
    if (!rawDesc) {
      throw new ValidationError('description', props.description, 'Commit description cannot be empty.');
    }
    this.description = rawDesc;

    if (props.body !== undefined && props.body !== null) {
      const trimmedBody = props.body.trim();
      this.body = trimmedBody.length > 0 ? trimmedBody : null;
    } else {
      this.body = null;
    }

    this.isBreaking = Boolean(props.isBreaking);

    if (props.issueNumber !== undefined && props.issueNumber !== null) {
      const num = Number(props.issueNumber);
      if (!Number.isInteger(num) || num <= 0) {
        throw new ValidationError(
          'issueNumber',
          props.issueNumber,
          `Invalid issue number '${props.issueNumber}'. Must be a positive integer.`
        );
      }
      this.issueNumber = num;
    } else {
      this.issueNumber = null;
    }

    Object.freeze(this);
  }

  public toSingleLine(): string {
    const scopePart = this.scope ? `(${this.scope})` : '';
    const breakingMark = this.isBreaking ? TOKEN_BREAKING_EXCLAMATION : '';
    let desc = this.description;

    if (this.issueNumber !== null) {
      const issueTokenParen = `(#${this.issueNumber})`;
      const issueTokenHash = `#${this.issueNumber}`;
      if (!desc.includes(issueTokenParen) && !desc.includes(issueTokenHash)) {
        desc = `${desc} ${issueTokenParen}`;
      }
    }

    return `${this.type}${scopePart}${breakingMark}: ${desc}`;
  }

  public toFullMessage(): string {
    const header = this.toSingleLine();
    const parts: string[] = [header];

    if (this.body) {
      parts.push(this.body);
    }

    if (this.isBreaking) {
      const hasBreakingFooter =
        (this.body && REGEX_BREAKING_CHANGE_FOOTER.test(this.body)) || false;

      if (!hasBreakingFooter) {
        parts.push(`${TOKEN_BREAKING_CHANGE} ${this.description}`);
      }
    }

    return parts.join('\n\n');
  }

  public toJSON(): CommitMessageSerialized {
    return {
      type: this.type,
      scope: this.scope,
      description: this.description,
      body: this.body,
      isBreaking: this.isBreaking,
      issueNumber: this.issueNumber,
      singleLine: this.toSingleLine(),
      fullMessage: this.toFullMessage()
    };
  }

  public static create(props: CommitMessageProps): CommitMessage {
    return new CommitMessage(props);
  }

  public static parse(rawMessage: string): CommitMessage {
    if (!rawMessage || typeof rawMessage !== 'string') {
      throw new ValidationError('rawMessage', rawMessage, 'Commit message must be a non-empty string.');
    }

    const trimmed = rawMessage.trim();
    const lines = trimmed.split('\n');
    const headerLine = lines[0].trim();

    const headerMatch = headerLine.match(REGEX_CONVENTIONAL_HEADER);
    if (!headerMatch || !headerMatch.groups) {
      throw new ValidationError(
        'rawMessage',
        rawMessage,
        `Message '${headerLine}' does not adhere to Conventional Commits 1.0.0 format: <type>(scope)!: <description>`
      );
    }

    const type = headerMatch.groups.type.toLowerCase();
    const scope = headerMatch.groups.scope ? headerMatch.groups.scope.toLowerCase() : null;
    const hasExclamation = Boolean(headerMatch.groups.breaking);
    let description = headerMatch.groups.description.trim();

    let issueNumber: number | null = null;
    const issueMatch = description.match(REGEX_ISSUE_NUMBER_REF);
    if (issueMatch && issueMatch[1]) {
      issueNumber = parseInt(issueMatch[1], 10);
    }

    let body: string | null = null;
    let isBreaking = hasExclamation;

    if (lines.length > 1) {
      const remainingLines = lines.slice(1);
      const remainingContent = remainingLines.join('\n').trim();

      if (remainingContent.length > 0) {
        body = remainingContent;
        if (REGEX_BREAKING_CHANGE_FOOTER.test(remainingContent)) {
          isBreaking = true;
        }
      }
    }

    return new CommitMessage({
      type,
      scope,
      description,
      body,
      isBreaking,
      issueNumber
    });
  }
}
