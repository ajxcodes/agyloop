/* eslint-disable @typescript-eslint/no-unused-vars */
import { MSG_CRITIQUE_PROVENANCE_DIGEST_MISSING, MSG_CRITIQUE_PROVENANCE_DIGEST_UNBOUND, MSG_CRITIQUE_PROVENANCE_DIGEST_UNMEASURED, MSG_CRITIQUE_PROVENANCE_UNBOUND, NOTE_CRITIQUE_REPORT_EMPTY, NOTE_CRITIQUE_REPORT_INPUT_MISSING, NOTE_CRITIQUE_REPORT_PARSE_FAILURE, NOTE_CRITIQUE_REPORT_UNREADABLE, NOTE_REVIEW_IGNORED_AFFIRMATIONS, critiqueReportLabel } from './messages';

/** The directory holding dispatched-review Tier 1 evidence (issue #397). */
export const CRITIQUE_REPORT_DIRECTORY = 'critique' as const;

/**
 * The provenance sidecar the Tier 1 command publishes beside a report
 * (issue #445). It names the base ref and HEAD the report was produced from, so
 * `codeloop review` can tie a supplied report to the change set it certifies.
 */
export const CRITIQUE_PROVENANCE_SUFFIX = '.provenance.json' as const;

export const CRITIQUE_FLAG_JSON = '--json' as const;

export const CRITIQUE_JS_EXTENSION = '.js' as const;

export const CRITIQUE_FLAG_STAGED = '--staged' as const;

export const CRITIQUE_FLAG_BASE = '--base' as const;

/**
 * `git diff <ref>` — two-dot, so the uncommitted change under review is
 * included (issue #445). `--base` is `git diff <ref>...HEAD`, which is empty at
 * REVIEW time because HEAD IS the reviewed base until the commit gate.
 */
export const CRITIQUE_FLAG_COMMIT = '--commit' as const;

export const CRITIQUE_BUILD_COMMAND = 'npm run build' as const;


export const CRITIQUE_GITHUB_OWNER = 'ajxcodes' as const;

export const CRITIQUE_GITHUB_REPO = 'critique' as const;

export const CRITIQUE_GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/ajxcodes/critique/releases/latest' as const;

export const CRITIQUE_UPDATE_TTL_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms (24 hours)

export const CRITIQUE_CACHE_FILENAME = 'critique-update-cache.json' as const;

export const CRITIQUE_EXECUTABLE_PERMISSIONS = 0o755;

export const CRITIQUE_SUBCOMMAND_STATUS = 'status' as const;

export const CRITIQUE_SUBCOMMAND_INSTALL = 'install' as const;

export const CRITIQUE_SUBCOMMAND_UPDATE = 'update' as const;


export const CRITIQUE_SUBCOMMANDS = Object.freeze([
  CRITIQUE_SUBCOMMAND_STATUS,
  CRITIQUE_SUBCOMMAND_INSTALL,
  CRITIQUE_SUBCOMMAND_UPDATE
] as const);


export type CritiqueSubcommand = typeof CRITIQUE_SUBCOMMANDS[number];

/** The `--critique-report` value that means "read the report from stdin". */
export const CRITIQUE_REPORT_STDIN = '-' as const;

/** The response line a dispatched reviewer uses to name its Tier 1 evidence. */
export const CRITIQUE_REPORT_RETURN_PREFIX = 'CRITIQUE_REPORT:' as const;


/** The placeholder a missing provenance value renders as (issue #445). */
export const CRITIQUE_PROVENANCE_UNMEASURED = '(unmeasured)' as const;


/** The values `formatCritiqueProvenanceUnbound` renders (issues #445, #452). */
export interface CritiqueProvenanceUnboundValues {
  readonly reportBase: string | null;
  readonly reportHead: string | null;
  readonly reviewedBase: string | null;
  readonly reviewedHead: string | null;
  readonly mismatch?: 'no-sidecar' | 'base' | 'head' | 'missing-digest' | 'unmeasured-digest' | 'change-set' | null;
  readonly reportDigest?: string | null;
  readonly reviewedDigest?: string | null;
}


/** Renders the unbound-report note; a `null` value reads as `(unmeasured)`. */
export function formatCritiqueProvenanceUnbound(
  values: CritiqueProvenanceUnboundValues
): string {
  const render = (value: string | null | undefined): string =>
    value === null || value === undefined || String(value).trim().length === 0
      ? CRITIQUE_PROVENANCE_UNMEASURED
      : String(value);
  const shortDigest = (value: string | null | undefined): string =>
    value === null || value === undefined || String(value).trim().length === 0
      ? CRITIQUE_PROVENANCE_UNMEASURED
      : String(value).trim().slice(0, 8);
  if (values.mismatch === 'change-set') {
    return MSG_CRITIQUE_PROVENANCE_DIGEST_UNBOUND
      .replace('{reportDigest}', () => shortDigest(values.reportDigest))
      .replace('{reviewedDigest}', () => shortDigest(values.reviewedDigest))
      .replace('{reviewedBase}', () => render(values.reviewedBase))
      .replace('{reviewedHead}', () => render(values.reviewedHead));
  }
  if (values.mismatch === 'missing-digest') return MSG_CRITIQUE_PROVENANCE_DIGEST_MISSING;
  if (values.mismatch === 'unmeasured-digest') return MSG_CRITIQUE_PROVENANCE_DIGEST_UNMEASURED;
  return MSG_CRITIQUE_PROVENANCE_UNBOUND
    .replace('{reportBase}', () => render(values.reportBase))
    .replace('{reportHead}', () => render(values.reportHead))
    .replace('{reviewedBase}', () => render(values.reviewedBase))
    .replace('{reviewedHead}', () => render(values.reviewedHead));
}


/**
 * The reviewer-side instruction that carries the Tier 1 artifact (issue #397).
 *
 * The dispatched reviewer already runs critique. Without a named path the
 * report died inside its session and `codeloop review` spawned a SECOND run;
 * this note makes the evidence transferable, and names the fallback so an
 * absent report is never mistaken for a clean one.
 *
 * Issue #400 (D2b): the contract keys on the command's EXIT STATUS. The Tier 1
 * command now stages its output and publishes nothing when critique fails, so a
 * non-zero exit is the only signal needed — and the only one a pipeline's
 * `tee` used to mask.
 *
 * Issue #445: the command publishes the report AND its provenance sidecar, so
 * this note names both as the one permitted write.
 */
export function formatCritiqueEvidenceReturnNote(reportPath: string): string {
  return (
    `The command writes the critique JSON to \`${reportPath}\` and its ` +
    `\`${reportPath}${CRITIQUE_PROVENANCE_SUFFIX}\` sidecar (the only files you may write; ` +
    `they live outside the worktree) and prints the report back to you. On success, name the ` +
    `report on a line of ` +
    `its own: \`${CRITIQUE_REPORT_RETURN_PREFIX} ${reportPath}\`. The command exits non-zero and ` +
    `publishes NO file when critique fails: a non-zero exit means you MUST say the Tier 1 run ` +
    `failed and OMIT that line — the orchestrator will run Tier 1 itself.`
  );
}


export function formatCritiqueIgnoredAffirmations(n: number): string {
  return NOTE_REVIEW_IGNORED_AFFIRMATIONS.replace('{n}', String(n));
}


export function formatCritiqueReportInputMissing(flag: string): string {
  return NOTE_CRITIQUE_REPORT_INPUT_MISSING.replace('{flag}', flag);
}


export function formatCritiqueReportParseFailure(reason: string): string {
  return NOTE_CRITIQUE_REPORT_PARSE_FAILURE.replace('{reason}', reason);
}


/** Renders a `--critique-report` location for the operator (`-` is stdin). */

export function formatCritiqueReportUnreadable(reportPath: string, reason: string): string {
  return NOTE_CRITIQUE_REPORT_UNREADABLE.replace('{path}', critiqueReportLabel(reportPath)).replace(
    '{reason}',
    reason
  );
}


export function formatCritiqueReportEmpty(reportPath: string): string {
  return NOTE_CRITIQUE_REPORT_EMPTY.replace('{path}', critiqueReportLabel(reportPath));
}
