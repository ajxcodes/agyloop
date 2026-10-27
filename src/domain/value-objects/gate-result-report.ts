/**
 * agyloop - GateResultReport value object (issue #284)
 *
 * The gate subagent's evidence block, validated before it is persisted.
 *
 * The block is the ONLY record of a gate run: `PENDING` survived every summary
 * for six runs because nothing the gate produced ever reached the writer. This
 * object makes an unvalidated or half-valid block impossible to record — it
 * fails closed with a `ValidationError` naming the field.
 *
 * Pure domain: no I/O, no clock. `reportedAt` defaults to the caller's clock at
 * construction time only; parsing never invents evidence.
 */

import { ValidationError } from '../errors';
import {
  GATE_REPORT_JSON_MARKER,
  STATUS_PASSED,
  STATUS_FAILED
} from '../constants';
import { formatStageDuration } from './run-evidence';

/** A declared gate that was NOT executed, with the reason it was skipped. */
export interface GateReportNotRun {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

export interface GateResultReportProps {
  readonly verdict: 'PASSED' | 'FAILED';
  readonly buildSystem: string;
  readonly buildStatus: string;
  readonly testsStatus: string;
  readonly testsPassed: number | null;
  readonly testsFailed: number | null;
  readonly durationMs: number | null;
  readonly executedCommands: readonly string[];
  /** `PASSED` | `FAILED` | `NOT_DECLARED` | `null` when not reported. */
  readonly smokeProtocol: 'PASSED' | 'FAILED' | 'NOT_DECLARED' | null;
  readonly notRun: readonly GateReportNotRun[];
  /** Which gate round this report certifies (count of QUALITY_GATE entries). */
  readonly gateRound: number;
  /** ISO timestamp of the report. */
  readonly reportedAt: string;
}

const SMOKE_PROTOCOL_VALUES: readonly string[] = Object.freeze([
  STATUS_PASSED,
  STATUS_FAILED,
  'NOT_DECLARED'
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the first balanced `{ … }` object starting at or after `from`.
 *
 * String literals are skipped so a brace inside a command string cannot
 * terminate the object early. Returns `null` when no balanced object exists.
 */
function sliceBalancedObject(raw: string, from: number): string | null {
  const start = raw.indexOf('{', from);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
}

export class GateResultReport {
  private readonly props: GateResultReportProps;

  private constructor(props: GateResultReportProps) {
    this.props = Object.freeze(props);
  }

  /**
   * Parses the `GATE_REPORT_JSON:` block a gate subagent emits.
   *
   * A missing marker is a hard failure: "the gate emitted nothing" must never
   * be silently recorded as a passing gate.
   */
  public static parseBlock(raw: string, gateRound?: number): GateResultReport {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new ValidationError('gateReport', raw, 'the gate report block is empty');
    }
    const markerIndex = raw.indexOf(GATE_REPORT_JSON_MARKER);
    if (markerIndex === -1) {
      throw new ValidationError('gateReport', raw, `missing ${GATE_REPORT_JSON_MARKER} block`);
    }
    const json = sliceBalancedObject(raw, markerIndex + GATE_REPORT_JSON_MARKER.length);
    if (json === null) {
      throw new ValidationError('gateReport', raw, 'the GATE_REPORT_JSON block has no balanced object');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err: unknown) {
      throw new ValidationError(
        'gateReport',
        json,
        `the GATE_REPORT_JSON block is not valid JSON (${err instanceof Error ? err.message : String(err)})`
      );
    }
    return GateResultReport.fromJSON(parsed, gateRound);
  }

  /** Validates a decoded JSON payload. */
  public static fromJSON(json: unknown, gateRound?: number): GateResultReport {
    if (!isPlainObject(json)) {
      throw new ValidationError('gateReport', json, 'the gate report must be a JSON object');
    }

    const verdict = json.verdict;
    if (verdict !== STATUS_PASSED && verdict !== STATUS_FAILED) {
      throw new ValidationError(
        'verdict',
        verdict,
        `must be one of ${STATUS_PASSED} | ${STATUS_FAILED}`
      );
    }

    const buildSystem = json.buildSystem;
    if (typeof buildSystem !== 'string' || buildSystem.trim().length === 0) {
      throw new ValidationError('buildSystem', buildSystem, 'must be a non-empty string');
    }

    const buildStatus = json.buildStatus;
    if (typeof buildStatus !== 'string' || buildStatus.trim().length === 0) {
      throw new ValidationError('buildStatus', buildStatus, 'must be a non-empty string');
    }

    const testsStatus = json.testsStatus;
    if (typeof testsStatus !== 'string' || testsStatus.trim().length === 0) {
      throw new ValidationError('testsStatus', testsStatus, 'must be a non-empty string');
    }

    const testsPassed = GateResultReport.readNullableCount('testsPassed', json.testsPassed);
    const testsFailed = GateResultReport.readNullableCount('testsFailed', json.testsFailed);

    // A PASSED verdict that also reports a failing test contradicts itself.
    if (verdict === STATUS_PASSED && testsFailed !== null && testsFailed !== 0) {
      throw new ValidationError(
        'testsFailed',
        testsFailed,
        `a ${STATUS_PASSED} verdict cannot report failing tests`
      );
    }

    const rawDuration = json.durationMs;
    let durationMs: number | null = null;
    if (rawDuration !== undefined && rawDuration !== null) {
      if (typeof rawDuration !== 'number' || !Number.isFinite(rawDuration) || rawDuration < 0) {
        throw new ValidationError('durationMs', rawDuration, 'must be a finite number >= 0, or null');
      }
      durationMs = rawDuration;
    }

    const executedCommands = GateResultReport.readStringArray('executedCommands', json.executedCommands);
    const notRun = GateResultReport.readNotRun(json.notRun);

    let resolvedRound: number;
    if (gateRound !== undefined) {
      if (!Number.isInteger(gateRound) || gateRound < 0) {
        throw new ValidationError('gateRound', gateRound, 'must be an integer >= 0');
      }
      const declared = json.gateRound;
      if (declared !== undefined && declared !== null) {
        const declaredRound = typeof declared === 'number' ? declared : NaN;
        if (!Number.isInteger(declaredRound) || declaredRound < 0) {
          throw new ValidationError('gateRound', declared, 'must be an integer >= 0');
        }
        if (declaredRound !== gateRound) {
          throw new ValidationError(
            'gateRound',
            declared,
            `the block certifies round ${declaredRound} but the checkpoint is at round ${gateRound}`
          );
        }
      }
      resolvedRound = gateRound;
    } else {
      const declared = json.gateRound;
      if (declared === undefined || declared === null) {
        resolvedRound = 0;
      } else if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
        throw new ValidationError('gateRound', declared, 'must be an integer >= 0');
      } else {
        resolvedRound = declared;
      }
    }

    const smokeProtocol = GateResultReport.readSmokeProtocol(json.smokeProtocol);

    let reportedAt: string;
    if (json.reportedAt === undefined || json.reportedAt === null) {
      reportedAt = new Date().toISOString();
    } else if (typeof json.reportedAt !== 'string' || Number.isNaN(new Date(json.reportedAt).getTime())) {
      throw new ValidationError('reportedAt', json.reportedAt, 'must parse as a date');
    } else {
      reportedAt = json.reportedAt;
    }

    return new GateResultReport({
      verdict,
      buildSystem: buildSystem.trim(),
      buildStatus: buildStatus.trim(),
      testsStatus: testsStatus.trim(),
      testsPassed,
      testsFailed,
      durationMs,
      executedCommands,
      smokeProtocol,
      notRun,
      gateRound: resolvedRound,
      reportedAt
    });
  }

  public get verdict(): 'PASSED' | 'FAILED' {
    return this.props.verdict;
  }

  public get buildSystem(): string {
    return this.props.buildSystem;
  }

  public get buildStatus(): string {
    return this.props.buildStatus;
  }

  public get testsStatus(): string {
    return this.props.testsStatus;
  }

  public get testsPassed(): number | null {
    return this.props.testsPassed;
  }

  public get testsFailed(): number | null {
    return this.props.testsFailed;
  }

  public get durationMs(): number | null {
    return this.props.durationMs;
  }

  public get executedCommands(): readonly string[] {
    return this.props.executedCommands;
  }

  public get smokeProtocol(): 'PASSED' | 'FAILED' | 'NOT_DECLARED' | null {
    return this.props.smokeProtocol;
  }

  public get notRun(): readonly GateReportNotRun[] {
    return this.props.notRun;
  }

  public get gateRound(): number {
    return this.props.gateRound;
  }

  public get reportedAt(): string {
    return this.props.reportedAt;
  }

  public toJSON(): GateResultReportProps {
    return {
      ...this.props,
      executedCommands: [...this.props.executedCommands],
      notRun: this.props.notRun.map((entry) => ({ ...entry }))
    };
  }

  /** Renders the one-line confirmation `gate-report` prints. */
  public formatConfirmation(): string {
    const duration = this.props.durationMs === null ? '-' : formatStageDuration(this.props.durationMs);
    return `${this.props.verdict} — ${this.props.buildSystem} — ${this.props.testsStatus} — ${duration}`;
  }

  private static readNullableCount(field: string, raw: unknown): number | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw new ValidationError(field, raw, 'must be an integer >= 0, or null');
    }
    return raw;
  }

  private static readStringArray(field: string, raw: unknown): readonly string[] {
    if (raw === undefined || raw === null) {
      return Object.freeze([]);
    }
    if (!Array.isArray(raw)) {
      throw new ValidationError(field, raw, 'must be an array of commands');
    }
    return Object.freeze(
      raw.map((entry) => {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
          throw new ValidationError(field, entry, 'every command must be a non-empty string');
        }
        return entry.trim();
      })
    );
  }

  private static readNotRun(raw: unknown): readonly GateReportNotRun[] {
    if (raw === undefined || raw === null) {
      return Object.freeze([]);
    }
    if (!Array.isArray(raw)) {
      throw new ValidationError('notRun', raw, 'must be an array');
    }
    return Object.freeze(
      raw.map((entry) => {
        if (!isPlainObject(entry)) {
          throw new ValidationError('notRun', entry, 'every entry must be an object');
        }
        const id = entry.id;
        const label = entry.label;
        const reason = entry.reason;
        if (typeof id !== 'string' || id.trim().length === 0) {
          throw new ValidationError('notRun.id', id, 'must be a non-empty string');
        }
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          throw new ValidationError('notRun.reason', reason, 'must be a non-empty string');
        }
        return {
          id: id.trim(),
          label: typeof label === 'string' && label.trim().length > 0 ? label.trim() : id.trim(),
          reason: reason.trim()
        };
      })
    );
  }

  private static readSmokeProtocol(raw: unknown): 'PASSED' | 'FAILED' | 'NOT_DECLARED' | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== 'string' || !SMOKE_PROTOCOL_VALUES.includes(raw.toUpperCase())) {
      throw new ValidationError(
        'smokeProtocol',
        raw,
        `must be one of ${SMOKE_PROTOCOL_VALUES.join(' | ')}`
      );
    }
    return raw.toUpperCase() as 'PASSED' | 'FAILED' | 'NOT_DECLARED';
  }
}
