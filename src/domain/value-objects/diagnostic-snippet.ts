/**
 * agyloop - DiagnosticSnippet Value Object
 *
 * Immutable representation of an actionable failure diagnostic snippet.
 * Surgically extracts root-cause error lines, failing assertions, and file locations
 * while stripping boilerplate and strictly bounding output to <= 25 lines.
 *
 * Pure domain value object: 100% free of filesystem, child processes, or external I/O.
 */

import {
  MAX_DIAGNOSTIC_LINES,
  MAX_DIAGNOSTIC_CHARS,
  DIAGNOSTIC_TRUNCATION_MARKER,
  TOKEN_FAILURE_FILE,
  TOKEN_FAILING_ASSERTION,
  TOKEN_DIAGNOSTIC_SNIPPET,
  LABEL_FAILURE_FILE,
  LABEL_FAILING_ASSERTION,
  REGEX_ANSI_ESCAPE,
  REGEX_FILE_LOCATION,
  REGEX_ASSERTION_FAILURE,
  REGEX_ERROR_BANNER,
  REGEX_NOISE_NODE_INTERNAL,
  REGEX_NOISE_NPM_ERR,
  REGEX_NOISE_PASSING,
  MSG_COMMAND_FAILED_NO_OUTPUT
} from '../constants';
import { ValidationError } from '../errors';

export interface DiagnosticSnippetProps {
  readonly rawContent: string;
  readonly lines?: readonly string[];
  readonly fileLocation?: string | null;
  readonly failingAssertion?: string | null;
  readonly rootCause?: string | null;
}

export class DiagnosticSnippet {
  public readonly rawContent: string;
  public readonly lines: readonly string[];
  public readonly fileLocation: string | null;
  public readonly failingAssertion: string | null;
  public readonly rootCause: string | null;
  public readonly lineCount: number;

  constructor(props: DiagnosticSnippetProps) {
    if (typeof props.rawContent !== 'string') {
      throw new ValidationError('rawContent', props.rawContent, 'Diagnostic rawContent must be a string.');
    }

    this.rawContent = props.rawContent;
    const computedLines = props.lines ? [...props.lines] : this.rawContent.split('\n');

    // Strict boundary enforcement: at most MAX_DIAGNOSTIC_LINES (25)
    let boundedLines: string[];
    if (computedLines.length > MAX_DIAGNOSTIC_LINES) {
      boundedLines = computedLines.slice(0, MAX_DIAGNOSTIC_LINES);
      boundedLines[boundedLines.length - 1] = DIAGNOSTIC_TRUNCATION_MARKER;
    } else {
      boundedLines = computedLines;
    }

    this.lines = Object.freeze(boundedLines);
    this.lineCount = this.lines.length;
    this.fileLocation = props.fileLocation ?? null;
    this.failingAssertion = props.failingAssertion ?? null;
    this.rootCause = props.rootCause ?? null;

    Object.freeze(this);
  }

  public toString(): string {
    let output = this.lines.join('\n');
    if (output.length > MAX_DIAGNOSTIC_CHARS) {
      output = `${output.substring(0, MAX_DIAGNOSTIC_CHARS - DIAGNOSTIC_TRUNCATION_MARKER.length)}\n${DIAGNOSTIC_TRUNCATION_MARKER}`;
    }
    return output.trim();
  }

  public formatForPrompt(): string {
    let section = '';
    if (this.fileLocation) {
      section += `- **${LABEL_FAILURE_FILE}**: \`${this.fileLocation}\`\n`;
    }
    if (this.failingAssertion) {
      section += `- **${LABEL_FAILING_ASSERTION}**: \`${this.failingAssertion}\`\n`;
    }
    section += `\`\`\`\n${this.toString()}\n\`\`\``;
    return section;
  }

  public toTokenString(): string {
    let tokens = '';
    if (this.fileLocation) {
      tokens += `${TOKEN_FAILURE_FILE}: ${this.fileLocation}\n`;
    }
    if (this.failingAssertion) {
      tokens += `${TOKEN_FAILING_ASSERTION}: ${this.failingAssertion}\n`;
    }
    tokens += `${TOKEN_DIAGNOSTIC_SNIPPET}:\n${this.toString()}`;
    return tokens;
  }

  public toJSON(): DiagnosticSnippetProps & { lineCount: number } {
    return {
      rawContent: this.rawContent,
      lines: this.lines,
      fileLocation: this.fileLocation,
      failingAssertion: this.failingAssertion,
      rootCause: this.rootCause,
      lineCount: this.lineCount
    };
  }

  public static fromRaw(content: string, props: Partial<DiagnosticSnippetProps> = {}): DiagnosticSnippet {
    return new DiagnosticSnippet({
      rawContent: content,
      ...props
    });
  }

  public static extract(combinedOutput: string, stderr?: string): DiagnosticSnippet | null {
    const raw = (stderr && stderr.trim().length > 0 ? stderr : combinedOutput) || '';
    if (!raw.trim()) {
      return new DiagnosticSnippet({
        rawContent: MSG_COMMAND_FAILED_NO_OUTPUT,
        lines: [MSG_COMMAND_FAILED_NO_OUTPUT]
      });
    }

    const clean = raw.replace(REGEX_ANSI_ESCAPE, '');
    const allLines = clean.split('\n');

    // 1. Surgical noise stripping: filter out passing tests, npm lifecycle headers, and blank noise
    const filteredLines = allLines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (REGEX_NOISE_PASSING.test(trimmed)) return false;
      if (REGEX_NOISE_NPM_ERR.test(trimmed)) return false;
      if (REGEX_NOISE_NODE_INTERNAL.test(trimmed)) return false;
      return true;
    });

    if (filteredLines.length === 0) {
      return new DiagnosticSnippet({
        rawContent: clean.slice(-MAX_DIAGNOSTIC_LINES).trim(),
        lines: clean.split('\n').slice(-MAX_DIAGNOSTIC_LINES)
      });
    }

    // 2. Identify key failure indicators: failure banner, failing assertion, and file location
    let failingAssertion: string | null = null;
    let fileLocation: string | null = null;
    let rootCause: string | null = null;
    let firstErrorIndex = -1;

    for (let i = 0; i < filteredLines.length; i++) {
      const line = filteredLines[i];

      if (!rootCause && REGEX_ERROR_BANNER.test(line)) {
        rootCause = line.trim();
        if (firstErrorIndex === -1) firstErrorIndex = i;
      }

      if (!failingAssertion && REGEX_ASSERTION_FAILURE.test(line)) {
        failingAssertion = line.trim();
        if (firstErrorIndex === -1) firstErrorIndex = i;
      }

      if (!fileLocation) {
        const fileMatch = line.match(REGEX_FILE_LOCATION);
        if (fileMatch) {
          const loc = fileMatch[1] || fileMatch[2] || fileMatch[3];
          if (loc && !REGEX_NOISE_NODE_INTERNAL.test(loc)) {
            fileLocation = loc.trim();
          }
        }
      }
    }

    // 3. Slice bounded window of lines around the first error or from end
    const startIndex = firstErrorIndex >= 0 ? firstErrorIndex : Math.max(0, filteredLines.length - MAX_DIAGNOSTIC_LINES);
    const candidateLines = filteredLines.slice(startIndex, startIndex + MAX_DIAGNOSTIC_LINES);

    return new DiagnosticSnippet({
      rawContent: candidateLines.join('\n'),
      lines: candidateLines,
      fileLocation,
      failingAssertion,
      rootCause
    });
  }
}
