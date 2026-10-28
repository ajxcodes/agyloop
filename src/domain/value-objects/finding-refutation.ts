/**
 * agyloop - FindingRefutation Value Object (issue #349 / #242 AC4)
 *
 * The EXPLICIT refutation channel: the operator has verified that a critique
 * finding is factually wrong (e.g. "`actions/checkout@v7` does not exist" when
 * the tag exists) and says so, per finding, with a mandatory reason.
 *
 * Why this exists beside content-aware blocking: no lexical predicate can know
 * whether a tag exists without network access, and "does not exist. Revert to
 * @v4." genuinely requests a change. The two mechanisms answer different
 * questions — "does this body ask for a change?" (actionability) versus "is
 * the requested change real?" (refutation).
 *
 * Pure domain: imports only the value objects and constants — no I/O, no
 * subprocess, no environment. Every array produced here is frozen.
 *
 * Precedence is fixed and enforced in `resolveFindingRefutations`:
 * classification FIRST (an affirmation is already non-blocking and cannot be
 * refuted), then refutation over the remaining blocking set.
 */

import {
  FINDING_ACTIONABILITY_AFFIRMATION,
  FLAG_REFUTE,
  FindingActionability,
  NOTE_REFUTATION_ALREADY_NON_BLOCKING,
  NOTE_REFUTATION_ALREADY_REFUTED,
  NOTE_REFUTATION_AMBIGUOUS,
  NOTE_REFUTATION_MALFORMED_TARGET,
  NOTE_REFUTATION_NO_MATCH,
  NOTE_REFUTATION_NO_REPORT,
  NOTE_REFUTATION_REASON_REQUIRED,
  NOTE_REFUTATION_SEVERITY_MISMATCH,
  REFUTATION_REASON_SEPARATOR,
  REFUTATION_SEVERITY_MARKER,
  SEVERITY_CRITICAL,
  SEVERITY_ERROR,
  excerptFindingBody
} from '../constants';
import { ValidationError } from '../errors';
import { AiReviewFinding } from './ai-review-finding';
import { AiReviewReport } from './ai-review-report';

/** Only the two blocking severities may narrow a refutation target. */
export type RefutableSeverity = typeof SEVERITY_CRITICAL | typeof SEVERITY_ERROR;

const REFUTABLE_SEVERITIES: readonly string[] = Object.freeze([SEVERITY_CRITICAL, SEVERITY_ERROR]);

function isRefutableSeverity(value: string): value is RefutableSeverity {
  return REFUTABLE_SEVERITIES.includes(value);
}

function normaliseTarget(path: string, line: number, severity: RefutableSeverity | null): string {
  const base = `${path}:${line}`;
  return severity === null ? base : `${base}${REFUTATION_SEVERITY_MARKER}${severity}`;
}

/**
 * One operator refutation, parsed and normalised from a `--refute` token.
 *
 * Grammar: `<path>:<line>[#<severity>]=<reason>`, split at the FIRST `=`
 * (so the reason may contain `=`, quotes, `@`, `#` and spaces) and the LAST
 * `:` / `#` in the location. The reason is mandatory BY CONSTRUCTION: a token
 * with no `=` (or an empty reason) is refused, so a reason can never be
 * silently attached to a different target.
 */
export class FindingRefutation {
  public readonly path: string;
  public readonly line: number;
  public readonly severity: RefutableSeverity | null;
  public readonly reason: string;

  constructor(props: {
    readonly path: string;
    readonly line: number;
    readonly severity?: RefutableSeverity | null;
    readonly reason: string;
  }) {
    if (typeof props.path !== 'string' || !props.path.trim()) {
      throw new ValidationError('path', props.path, NOTE_REFUTATION_MALFORMED_TARGET);
    }
    if (
      typeof props.line !== 'number' ||
      !Number.isSafeInteger(props.line) ||
      props.line < 0
    ) {
      throw new ValidationError('line', props.line, NOTE_REFUTATION_MALFORMED_TARGET);
    }
    if (typeof props.reason !== 'string' || !props.reason.trim()) {
      throw new ValidationError('reason', props.reason, NOTE_REFUTATION_REASON_REQUIRED);
    }
    const severity = props.severity ?? null;
    if (severity !== null && !isRefutableSeverity(severity)) {
      throw new ValidationError('severity', severity, NOTE_REFUTATION_MALFORMED_TARGET);
    }

    this.path = props.path.trim();
    this.line = props.line;
    this.severity = severity;
    this.reason = props.reason.trim();

    Object.freeze(this);
  }

  /**
   * The normalised target — what stderr, `--json` and the checkpoint name, so
   * the operator can copy it straight back onto the command line.
   */
  public get target(): string {
    return normaliseTarget(this.path, this.line, this.severity);
  }

  public describe(): string {
    return `${this.target}${REFUTATION_REASON_SEPARATOR}${this.reason}`;
  }

  public toJSON(): Record<string, unknown> {
    return {
      target: this.target,
      path: this.path,
      line: this.line,
      severity: this.severity,
      reason: this.reason
    };
  }

  /** Parse a `--refute` token. Throws `ValidationError` on every malformed shape. */
  public static parse(spec: string): FindingRefutation {
    const raw = typeof spec === 'string' ? spec : '';

    const separator = raw.indexOf(REFUTATION_REASON_SEPARATOR);
    if (separator === -1) {
      throw new ValidationError('refute', spec, NOTE_REFUTATION_REASON_REQUIRED);
    }

    const location = raw.slice(0, separator).trim();
    const reason = raw.slice(separator + 1).trim();
    if (!reason) {
      throw new ValidationError('refute', spec, NOTE_REFUTATION_REASON_REQUIRED);
    }

    let pathAndLine = location;
    let severity: RefutableSeverity | null = null;
    const marker = location.lastIndexOf(REFUTATION_SEVERITY_MARKER);
    if (marker !== -1) {
      const selector = location.slice(marker + 1).trim();
      pathAndLine = location.slice(0, marker).trim();
      if (!isRefutableSeverity(selector)) {
        throw new ValidationError('refute', spec, NOTE_REFUTATION_MALFORMED_TARGET);
      }
      severity = selector;
    }

    const colon = pathAndLine.lastIndexOf(':');
    if (colon === -1) {
      throw new ValidationError('refute', spec, NOTE_REFUTATION_MALFORMED_TARGET);
    }
    const path = pathAndLine.slice(0, colon).trim();
    const lineText = pathAndLine.slice(colon + 1).trim();
    if (!path || !/^\d+$/.test(lineText)) {
      throw new ValidationError('refute', spec, NOTE_REFUTATION_MALFORMED_TARGET);
    }
    const line = Number(lineText);
    if (!Number.isSafeInteger(line)) {
      throw new ValidationError('refute', spec, NOTE_REFUTATION_MALFORMED_TARGET);
    }

    return new FindingRefutation({ path, line, severity, reason });
  }
}

/**
 * One APPLIED refutation — the audit record.
 *
 * `findingIndex` is the index into the report's `findings`, so the escalation
 * can exclude exactly this finding and no other (never a positional guess).
 */
export interface AppliedFindingRefutation {
  readonly target: string;
  readonly path: string;
  readonly line: number;
  readonly severity: string;
  readonly actionability: FindingActionability;
  readonly bodyExcerpt: string;
  readonly reason: string;
  readonly findingIndex: number;
}

/** The deterministic outcome of resolving every `--refute` against one report. */
export interface RefutationResolution {
  readonly applied: readonly AppliedFindingRefutation[];
  readonly refusals: readonly string[];
  /** The severity-blocking, actionable findings that survive the refutations. */
  readonly remaining: readonly AiReviewFinding[];
  /** Every severity-blocking, actionable finding the report carried. */
  readonly blocking: readonly AiReviewFinding[];
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  let filled = template;
  for (const [key, value] of Object.entries(values)) {
    filled = filled.split(`{${key}}`).join(value);
  }
  return filled;
}

function ambiguityRefusal(
  refutation: FindingRefutation,
  matches: readonly AiReviewFinding[]
): string {
  let message = fill(NOTE_REFUTATION_AMBIGUOUS, {
    target: refutation.target,
    count: String(matches.length)
  });
  // A selector that still matches more than one finding cannot be narrowed
  // further: the report is genuinely ambiguous and no positional tie-break is
  // ever permitted. With no selector, name the per-candidate severities.
  if (refutation.severity === null) {
    for (const finding of matches) {
      message += `\n  ${FLAG_REFUTE} '${normaliseTarget(finding.path, finding.line, finding.severity as RefutableSeverity)}=<reason>'  (${finding.severity}: "${excerptFindingBody(finding.body)}")`;
    }
  } else {
    message += `\n  Ambiguous report: ${matches.length} findings at that path/line/severity. Dedupe the report (or accept the block).`;
  }
  return message;
}

/**
 * Resolve operator refutations against one report (issue #349 §2.5.3/§2.5.4).
 *
 * ORDERED: refutations are applied in command-line order against a `consumed`
 * set, so two refutations can never consume the same finding — the second is
 * refused. Every refusal is collected (not thrown) so the caller can raise one
 * `RefutationRefusedError` naming all of them, before any checkpoint write.
 */
export function resolveFindingRefutations(
  report: AiReviewReport | null | undefined,
  refutations: readonly FindingRefutation[]
): RefutationResolution {
  const requested = refutations ?? [];
  const blocking = report && !report.bypassed ? report.blockingFindings() : Object.freeze([]);

  if (requested.length === 0) {
    return Object.freeze({
      applied: Object.freeze([]),
      refusals: Object.freeze([]),
      remaining: Object.freeze([...blocking]),
      blocking: Object.freeze([...blocking])
    });
  }

  if (!report || report.bypassed) {
    return Object.freeze({
      applied: Object.freeze([]),
      refusals: Object.freeze([NOTE_REFUTATION_NO_REPORT]),
      remaining: Object.freeze([]),
      blocking: Object.freeze([])
    });
  }

  const applied: AppliedFindingRefutation[] = [];
  const refusals: string[] = [];
  const consumed = new Set<number>();

  const severityBlocking = report.findings.filter((finding) => finding.isBlocking());

  for (const refutation of requested) {
    const atLocation = severityBlocking.filter(
      (finding) => finding.path === refutation.path && finding.line === refutation.line
    );

    if (atLocation.length === 0) {
      refusals.push(fill(NOTE_REFUTATION_NO_MATCH, { target: refutation.target }));
      continue;
    }

    let selected = atLocation;
    if (refutation.severity !== null) {
      selected = atLocation.filter((finding) => finding.severity === refutation.severity);
      if (selected.length === 0) {
        const actual = [...new Set(atLocation.map((finding) => finding.severity))].join("', '");
        refusals.push(
          fill(NOTE_REFUTATION_SEVERITY_MISMATCH, {
            target: refutation.target,
            actual,
            suggestion: normaliseTarget(
              atLocation[0].path,
              atLocation[0].line,
              atLocation[0].severity as RefutableSeverity
            )
          })
        );
        continue;
      }
    }

    const refutable = selected.filter(
      (finding) => finding.actionability() !== FINDING_ACTIONABILITY_AFFIRMATION
    );
    if (refutable.length === 0) {
      refusals.push(fill(NOTE_REFUTATION_ALREADY_NON_BLOCKING, { target: refutation.target }));
      continue;
    }

    const unconsumed = refutable.filter(
      (finding) => !consumed.has(report.findings.indexOf(finding))
    );
    if (unconsumed.length === 0) {
      refusals.push(fill(NOTE_REFUTATION_ALREADY_REFUTED, { target: refutation.target }));
      continue;
    }

    if (unconsumed.length > 1) {
      refusals.push(ambiguityRefusal(refutation, unconsumed));
      continue;
    }

    const finding = unconsumed[0];
    const findingIndex = report.findings.indexOf(finding);
    consumed.add(findingIndex);
    applied.push(
      Object.freeze({
        // The normalised target is what the OPERATOR wrote (the location plus
        // its optional selector), so stderr, `--json` and the checkpoint all
        // name a string they can paste straight back onto the command line.
        target: refutation.target,
        path: finding.path,
        line: finding.line,
        severity: finding.severity,
        actionability: finding.actionability(),
        bodyExcerpt: excerptFindingBody(finding.body),
        reason: refutation.reason,
        findingIndex
      })
    );
  }

  return Object.freeze({
    applied: Object.freeze(applied),
    refusals: Object.freeze(refusals),
    remaining: Object.freeze(
      blocking.filter((finding) => !consumed.has(report.findings.indexOf(finding)))
    ),
    blocking: Object.freeze([...blocking])
  });
}
