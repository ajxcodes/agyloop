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
  STAGE_QUALITY_GATE,
  STATUS_PASSED,
  STATUS_FAILED,
  SMOKE_PROTOCOL_VALUES,
  SMOKE_PROTOCOL_VOCABULARY,
  type SmokeProtocolWireValue
} from '../constants';
import { formatStageDuration } from './run-evidence';

/**
 * The report's smoke-protocol verdict on the wire: `null` means "not reported",
 * which is different from `SMOKE_PROTOCOL_NOT_DECLARED` ("reported: the plan
 * declares no smoke protocol").
 *
 * The accepted values are exactly `SMOKE_PROTOCOL_VALUES` — the same list the
 * gate prompt names (issue #311).
 */
export type SmokeProtocolVerdict = SmokeProtocolWireValue;

/** A declared gate that was NOT executed, with the reason it was skipped. */
export interface GateReportNotRun {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

/**
 * Per-command test accounting (issue #325, AC-16).
 *
 * Optional on purpose: every report filed before this field existed is still
 * valid evidence, and ingest falls back to the aggregate `testsPassed`. When it
 * IS present, ingest can tell a targeted subset apart from the full suite that
 * already contains it, which is the only way `testsPassed` can be normalised to
 * a UNIQUE total instead of trusting a sum.
 */
export interface GateCommandResult {
  readonly command: string;
  readonly passed: number | null;
  readonly failed: number | null;
}

/**
 * A declared smoke check and whether it passed (issue #325, AC-17).
 *
 * `executedCommands` holds COMMANDS only. A smoke check is a protocol step, not
 * a command, so treating its label as one inflated the summary's command count
 * above the plan's target count. `passed: null` means "ran but reported no
 * verdict", never "passed".
 */
export interface GateSmokeCheck {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean | null;
}

/** Entry shape that identifies a smoke-check LABEL inside `executedCommands`. */
const SMOKE_CHECK_ENTRY_PATTERN = /^\s*smoke-check[-:\s]/i;

/** True when an `executedCommands` entry is really a smoke-check label. */
export function isSmokeCheckEntry(entry: string): boolean {
  return typeof entry === 'string' && SMOKE_CHECK_ENTRY_PATTERN.test(entry);
}

/**
 * Splits a legacy `executedCommands` array into commands and smoke checks
 * (issue #325, AC-17).
 *
 * The #311 run filed 5 commands plus 4 `smoke-check-N: …` labels in the same
 * array, so the summary claimed 9 executed commands for a 5-command plan. The
 * partition happens once, at ingest, so every downstream reader sees commands
 * only.
 */
export function splitSmokeChecks(entries: readonly string[]): {
  readonly commands: readonly string[];
  readonly smokeChecks: readonly GateSmokeCheck[];
} {
  const commands: string[] = [];
  const smokeChecks: GateSmokeCheck[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isSmokeCheckEntry(entry)) {
      commands.push(entry);
      continue;
    }
    const label = entry.trim();
    const idMatch = label.match(/^(smoke-check[-:\s]*\d+|smoke-check\b[^-:]*)/i);
    const id = (idMatch ? idMatch[1] : label).replace(/[-:\s]+$/, '').trim() || label;
    const detail = label.slice(id.length).replace(/^\s*[-:]\s*/, '').trim();
    // A verdict is only claimed when the label states one.
    const passed = /(?:\bFAIL(?:ED)?\b|❌|✗|\bnot\s+passed\b)/i.test(label)
      ? false
      : /(?:\bPASS(?:ED)?\b|✅|✓)/i.test(label)
        ? true
        : null;
    smokeChecks.push({ id, label: detail.length > 0 ? detail : id, passed });
  }
  return { commands: Object.freeze(commands), smokeChecks: Object.freeze(smokeChecks) };
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
  /** Per-command test counts, when the gate reported them (issue #325, AC-16). */
  readonly commandResults: readonly GateCommandResult[];
  /** Declared smoke checks with their verdicts (issue #325, AC-17). */
  readonly smokeChecks: readonly GateSmokeCheck[];
  /** `PASSED` | `FAILED` | `NOT_DECLARED` | `null` when not reported. */
  readonly smokeProtocol: SmokeProtocolVerdict | null;
  readonly notRun: readonly GateReportNotRun[];
  /** Which gate round this report certifies (count of QUALITY_GATE entries). */
  readonly gateRound: number;
  /** ISO timestamp of the report. */
  readonly reportedAt: string;
}

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
    const commandResults = GateResultReport.readCommandResults(json.commandResults);
    const smokeChecks = GateResultReport.readSmokeChecks(json.smokeChecks);
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
      commandResults,
      smokeChecks,
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

  /** Per-command test counts (issue #325, AC-16); empty when not reported. */
  public get commandResults(): readonly GateCommandResult[] {
    return this.props.commandResults;
  }

  /** Declared smoke checks with verdicts (issue #325, AC-17); empty when none. */
  public get smokeChecks(): readonly GateSmokeCheck[] {
    return this.props.smokeChecks;
  }

  public get smokeProtocol(): SmokeProtocolVerdict | null {
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
      commandResults: this.props.commandResults.map((entry) => ({ ...entry })),
      smokeChecks: this.props.smokeChecks.map((entry) => ({ ...entry })),
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

  private static readCommandResults(raw: unknown): readonly GateCommandResult[] {
    if (raw === undefined || raw === null) {
      return Object.freeze([]);
    }
    if (!Array.isArray(raw)) {
      throw new ValidationError('commandResults', raw, 'must be an array of {command, passed, failed}');
    }
    return Object.freeze(
      raw.map((entry) => {
        if (!isPlainObject(entry)) {
          throw new ValidationError('commandResults', entry, 'every entry must be an object');
        }
        const command = entry.command;
        if (typeof command !== 'string' || command.trim().length === 0) {
          throw new ValidationError(
            'commandResults.command',
            command,
            'must be a non-empty string'
          );
        }
        return {
          command: command.trim(),
          passed: GateResultReport.readNullableCount('commandResults.passed', entry.passed),
          failed: GateResultReport.readNullableCount('commandResults.failed', entry.failed)
        };
      })
    );
  }

  private static readSmokeChecks(raw: unknown): readonly GateSmokeCheck[] {
    if (raw === undefined || raw === null) {
      return Object.freeze([]);
    }
    if (!Array.isArray(raw)) {
      throw new ValidationError('smokeChecks', raw, 'must be an array of {id, label, passed}');
    }
    return Object.freeze(
      raw.map((entry) => {
        if (!isPlainObject(entry)) {
          throw new ValidationError('smokeChecks', entry, 'every entry must be an object');
        }
        const id = entry.id;
        const label = entry.label;
        if (typeof id !== 'string' || id.trim().length === 0) {
          throw new ValidationError('smokeChecks.id', id, 'must be a non-empty string');
        }
        let passed: boolean | null = null;
        if (entry.passed === true || entry.passed === false) {
          passed = entry.passed;
        } else if (entry.passed !== undefined && entry.passed !== null) {
          throw new ValidationError('smokeChecks.passed', entry.passed, 'must be a boolean, or null');
        }
        return {
          id: id.trim(),
          label:
            typeof label === 'string' && label.trim().length > 0 ? label.trim() : id.trim(),
          passed
        };
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

  private static readSmokeProtocol(raw: unknown): SmokeProtocolVerdict | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    // Issue #311: normalize the legacy spaced spelling (`NOT DECLARED`) so an
    // already-in-flight block is recorded instead of being discarded wholesale.
    // Only the spelling is normalized; an unknown token still fails closed.
    const normalized = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\s+/g, '_') : '';
    if (!SMOKE_PROTOCOL_VALUES.some((value) => value === normalized)) {
      throw new ValidationError(
        'smokeProtocol',
        raw,
        `must be one of ${SMOKE_PROTOCOL_VOCABULARY}`
      );
    }
    return normalized as SmokeProtocolVerdict;
  }
}

/**
 * The gate round a checkpoint is in (issue #311). ONE formula for the filing
 * side (`gate-report`, yolo gate) and the ingest side (`transition REVIEW`):
 * two copies drifted, so a checkpoint with no `QUALITY_GATE` entry filed round
 * `1` and ingested round `0`, discarding a freshly filed report as stale.
 */
export function resolveGateRound(
  history: readonly { readonly stage?: string }[] | null | undefined
): number {
  const entries = Array.isArray(history) ? history : [];
  return Math.max(1, entries.filter((entry) => entry.stage === STAGE_QUALITY_GATE).length);
}

/**
 * Full-suite test runners (issue #325, AC-16).
 *
 * A command matching one of these EXECUTES the other test commands' targets as
 * well, so its count is a unique total by itself and the others must not be
 * added to it. This is the only signal available: `npm test` and
 * `node --test tests/x.test.ts` share no literal string, so plain containment
 * cannot see that the first contains the second.
 */
const FULL_SUITE_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bnpm\s+(?:run\s+)?test\b/,
  /\b(?:pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\s+\.\/\.\.\./,
  /\bmvn(?:w)?\b[^\n]*\btest\b/,
  /\b(?:\.\/gradlew|gradle)\b[^\n]*\btest\b/,
  /\bdotnet\s+test\b/,
  /\b(?:ctest|make\s+test)\b/,
  /\bnode\s+--test\b[^\n]*\*\*/,
  /^\s*(?:python3?\s+-m\s+)?pytest\s*$/
];

function normaliseCommand(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isFullSuiteCommand(command: string): boolean {
  return FULL_SUITE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Targeted test runners that the full-suite list does not already cover
 * (issue #412).
 *
 * The SAME classification feeds two consumers: the evidence floor that refuses
 * a zero-test PASSED block and the in-process gate that refuses an exit-0 test
 * command with no test total.
 */
const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bnode\s+--test\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w.:-]+)?\b/,
  /\b(?:vitest|jest|pytest|phpunit|rspec|ctest)\b/,
  /\bplaywright\s+test\b/,
  /\bdeno\s+test\b/,
  /\b(?:cargo|go|dotnet|mvn(?:w)?|gradlew?|gradle|make|mix)\b[^\n]*\btest\b/
];

/**
 * True when `command` executes tests (issue #412).
 *
 * A `commandResults` entry for `npm run build` is not evidence about tests, and
 * an `executedCommands` entry for `npm test` is. `normaliseGateTests()` and the
 * zero-test floor both use this one predicate.
 */
export function isTestCommand(command: string): boolean {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return false;
  }
  const normalised = normaliseCommand(command);
  return (
    FULL_SUITE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalised)) ||
    TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(normalised))
  );
}

/**
 * The test commands a report claims to have EXECUTED (issue #412).
 *
 * A command the report lists in `notRun` is excluded by id/label: a declared
 * test target that did not run is not evidence of a test run, and the
 * zero-test floor must not refuse an honest "not run" report.
 */
export function executedTestCommands(report: GateResultReport): readonly string[] {
  const skipped = new Set(
    report.notRun
      .flatMap((entry) => [entry.id, entry.label])
      .map((value) => normaliseCommand(value))
  );
  return report.executedCommands.filter(
    (command) => isTestCommand(command) && !skipped.has(normaliseCommand(command))
  );
}

/**
 * True when running `executedCommand` evidences `declaredTarget` (issue #408).
 *
 * Coverage uses the SAME semantics as unique-test accounting — normalised
 * equality plus the containment / full-suite rule — so a report cannot be
 * certified by a command that `normaliseGateTests` would not treat as running
 * the declared one. `commandCovers` deliberately excludes exact equality, which
 * is why the equality check comes first here.
 */
export function commandCoversTarget(executedCommand: string, declaredTarget: string): boolean {
  if (normaliseCommand(executedCommand) === normaliseCommand(declaredTarget)) return true;
  return commandCovers(executedCommand, declaredTarget);
}

/**
 * True when running `outer` also runs `inner` (issue #325, AC-16).
 *
 * Two shapes count: literal containment after normalisation (a command that
 * names a superset of paths), and a full-suite runner that contains any other
 * test command.
 */
function commandCovers(outer: string, inner: string): boolean {
  const normalisedOuter = normaliseCommand(outer);
  const normalisedInner = normaliseCommand(inner);
  if (normalisedOuter === normalisedInner) {
    return false;
  }
  if (normalisedOuter.includes(normalisedInner)) {
    return true;
  }
  return isFullSuiteCommand(normalisedOuter) && /\btest\b/.test(normalisedInner);
}

/** The `(N passed)` total a status string declares, or null. */
function readDeclaredPassedCount(testsStatus: string): number | null {
  const match = /\((\d[\d,]*)\s+passed/i.exec(testsStatus);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rewrites the `(N passed)` total of a status string, keeping its verdict text. */
function rewriteTestsStatus(testsStatus: string, uniqueTests: number): string {
  const match = /^(.*?)\((\s*\d[\d,]*\s+passed\s*)\)(.*)$/i.exec(testsStatus);
  if (!match) {
    return testsStatus;
  }
  return `${match[1].trimEnd()} (${uniqueTests} passed)${match[3]}`;
}

export interface GateTestsNormalisation {
  /** UNIQUE tests across the whole run — the contract's meaning of `testsPassed`. */
  readonly testsPassed: number | null;
  /** The status string to record: rewritten only when it contradicted the total. */
  readonly testsStatus: string;
  /** True when the report's own numbers were inconsistent and got corrected. */
  readonly rewritten: boolean;
  /**
   * True when the command list contains a covering pair but no per-command
   * counts exist, so the total could not be checked. The aggregate is still
   * trusted, but the caller must warn: this is exactly the shape that produced
   * `1953 = 1867 + 86`.
   */
  readonly suspectDoubleCount: boolean;
}

/**
 * Normalises a gate report's test accounting to UNIQUE tests (issue #325,
 * AC-16).
 *
 * `testsPassed` is DEFINED as the number of unique tests across the whole run.
 * A gate that runs a targeted subset (86) and then the full suite (1867) and
 * reports the SUM (1953) has counted 86 tests twice. With a per-command
 * breakdown the covering command's count wins; disjoint suites still sum
 * (correct by construction); with no breakdown the aggregate is trusted, but a
 * `testsStatus` that contradicts it is rewritten from `testsPassed`.
 */
export function normaliseGateTests(report: GateResultReport): GateTestsNormalisation {
  const counted = report.commandResults.filter(
    (entry): entry is GateCommandResult & { readonly passed: number } =>
      typeof entry.passed === 'number'
  );
  // Issue #412: only TEST commands may drive the unique test total. The #410
  // record carried `{ command: 'npm run build', passed: 0 }` and normalisation
  // rewrote a real 1-test report to `PASSED (0 passed)`.
  const testCounted = counted.filter((entry) => isTestCommand(entry.command));

  let uniqueTests = report.testsPassed;
  if (testCounted.length > 0) {
    const covering = testCounted.filter((entry) =>
      testCounted.some((other) => other !== entry && commandCovers(entry.command, other.command))
    );
    uniqueTests =
      covering.length > 0
        ? Math.max(...covering.map((entry) => entry.passed))
        : testCounted.reduce((sum, entry) => sum + entry.passed, 0);
  }

  const declared = readDeclaredPassedCount(report.testsStatus);
  const testsStatus =
    uniqueTests !== null && declared !== null && declared !== uniqueTests
      ? rewriteTestsStatus(report.testsStatus, uniqueTests)
      : report.testsStatus;

  const suspectDoubleCount =
    counted.length === 0 &&
    report.executedCommands.length > 1 &&
    report.executedCommands.some((outer) =>
      report.executedCommands.some((inner) => commandCovers(outer, inner))
    );

  return {
    testsPassed: uniqueTests,
    testsStatus,
    rewritten:
      testsStatus !== report.testsStatus ||
      (uniqueTests !== null &&
        report.testsPassed !== null &&
        uniqueTests !== report.testsPassed),
    suspectDoubleCount
  };
}

/**
 * The test commands that make a `PASSED` report certifiable only if the
 * normalised total is positive (issue #412).
 *
 * Returns the executed test commands when the report claims `PASSED`, at least
 * one test command ran (and is not in `notRun`), and the unique test total is
 * `0`. An empty array means "not refused by this rule": a `FAILED` report is a
 * "go fix it" exit, and a build-only plan has no test command by construction.
 *
 * `normaliseGateTests()` is the SAME arithmetic recorded in the summary, so the
 * guard and the recorded number cannot disagree.
 */
export function zeroTestEvidenceCommands(report: GateResultReport): readonly string[] {
  if (report.verdict !== STATUS_PASSED) {
    return Object.freeze([]);
  }
  if (normaliseGateTests(report).testsPassed !== 0) {
    return Object.freeze([]);
  }
  return executedTestCommands(report);
}
