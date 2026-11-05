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

import { ConventionalCommitType, CONVENTIONAL_COMMIT_TYPES, COMMIT_SUBJECT_MAX_LENGTH } from '../vocabulary';
import { REGEX_CONVENTIONAL_HEADER, REGEX_BREAKING_CHANGE_FOOTER, REGEX_ISSUE_NUMBER_REF } from '../regexes';
import { TOKEN_BREAKING_CHANGE, TOKEN_BREAKING_EXCLAMATION } from '../cli-contract';
import { ValidationError } from '../errors';
import { stripOwnIssueToken, truncateSubjectDescription } from './subject-truncation';

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
        // eslint-disable-next-line no-useless-escape
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

  /**
   * The conventional-commit SUBJECT (`type(scope): description (#N)`).
   *
   * #345 in #339 (AC-4.4): never longer than `COMMIT_SUBJECT_MAX_LENGTH` (72).
   * The bound lives HERE — not in the drafter — so the drafted subject and the
   * committed subject agree by construction: `toFullMessage()` headers with
   * this method. An explicit `-m` message IS parsed into this value object
   * (`draft-commit.ts:181-193`, `execute-commit.ts:172-173`) and is bounded
   * here too — which is exactly why the `(#N)` token must be reserved rather
   * than left inside the description where the cut can slice it off (#400).
   *
   * The cut is boundary-aware (issue #376, Defect 2): this issue's own token is
   * normalised out of the description first, ` (#N)` is always appended as the
   * suffix when an issue is associated (so its budget is always reserved), and
   * an over-long description is bounded by `truncateSubjectDescription` — exact
   * boundary → clause separator → last space — then trimmed of a dangling
   * article/preposition/conjunction/possessive/adverb, trailing label
   * punctuation and an unmatched opening quote or bracket.
   */
  public toSingleLine(): string {
    const scopePart = this.scope ? `(${this.scope})` : '';
    const breakingMark = this.isBreaking ? TOKEN_BREAKING_EXCLAMATION : '';
    const baseDescription = stripOwnIssueToken(this.description, this.issueNumber);
    const issueSuffix = this.issueNumber !== null ? ` (#${this.issueNumber})` : '';

    const prefix = `${this.type}${scopePart}${breakingMark}: `;
    const budget = COMMIT_SUBJECT_MAX_LENGTH - prefix.length - issueSuffix.length;

    // budget < 1 is only reachable with a pathological (near-72-char) explicit
    // scope; refusing to truncate there keeps the tail tokens intact rather
    // than emitting a malformed empty description.
    let boundedDesc = baseDescription;
    if (
      budget > 0 &&
      prefix.length + baseDescription.length + issueSuffix.length > COMMIT_SUBJECT_MAX_LENGTH
    ) {
      boundedDesc = truncateSubjectDescription(baseDescription, budget);
    }

    return `${prefix}${boundedDesc}${issueSuffix}`;
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
     
    const description = headerMatch.groups.description.trim();

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
