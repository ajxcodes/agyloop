/**
 * agyloop - Plan evidence paths (issue #432, AC4/AC6)
 *
 * A plan that instructs work on a path the commit can never contain certifies
 * evidence the delivered PR cannot hold (#433). This module extracts the
 * path-shaped tokens the plan's acceptance criteria and checkbox checklist
 * name, and lints them against the SAME commit-exclusion set the commit gate
 * applies (#319) plus a lexical workspace-escape rule.
 *
 * Lexical only — no I/O, and never `path` (application files may not import
 * it; the hexagonal fitness test enforces the domain equivalent here).
 */

import { isCommitExcludedPath } from '../vocabulary';
import { parseHeading as parseHeadingImpl, isFence as isFenceImpl, type HeadingLine } from './markdown';
import { normaliseLexicalPath } from './smoke-sandbox';

export type PlanEvidenceTarget = 'acceptance criteria' | 'implementation checklist';

export interface PlanEvidenceFinding {
  readonly path: string;
  readonly line: number;
  readonly target: PlanEvidenceTarget;
  readonly reason: string;
  /**
   * True when the checklist text mentions the path as a module identifier
   * rather than naming it as a delivery target (issue #436, AC3). AC-region
   * findings are always targets.
   */
  readonly moduleSpecifier: boolean;
}

/** A path-shaped occurrence on one plan line, with its delivery classification. */
interface PathOccurrence {
  readonly path: string;
  /** Offset of the opening backtick or bare token. */
  readonly index: number;
  readonly moduleSpecifier: boolean;
}


/** A path-shaped token with an optional `:line` / `:line-range` suffix. */
const PATH_TOKEN = /(?:[A-Za-z0-9_.~$-]+\/)+[A-Za-z0-9_.~$*-]+(:\d+(?:-\d+)?)?/g;

/**
 * Drops a `:line` / `:line-range` citation suffix (issue #435, D3).
 *
 * Exported so the reviewer-evidence pipeline can compare `src/x.ts:42` against
 * the delivered `src/x.ts` without changing what it reports: the citation is
 * always quoted as the reviewer wrote it.
 */
export function stripLineSuffix(token: string): string {
  return token.replace(/:\d+(?:-\d+)?$/, '');
}

/** A module keyword that turns the following path into an identifier mention. */
const MODULE_CONTEXT =
  /\b(?:require\s*\(\s*['"`]?|from\s+['"`]?|import\s*(?:\(\s*)?['"`]?|requir(?:e|es|ed|ing)\b|import(?:s|ed|ing)?\b)/gi;

/** A verb that asks the implementer to write the named path. */
const WRITE_VERB =
  /\b(?:add|change|correct|create|delete|deliver|edit|extract|fix|implement|introduce|modify|move|patch|place|port|put|refactor|remove|rename|replace|rewrite|ship|split|update|wire|write)\b/gi;

/** The last match of `pattern` in `text`, or null. */
function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  pattern.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    last = match;
  }
  return last;
}

/**
 * True when the token at `index` names an identifier, not a delivery target.
 *
 * A path is a target only when a write verb precedes it and no module keyword
 * (require/import/from) sits after that verb. A step that merely mentions a
 * path — or requires it as a module specifier — is not an instruction.
 */
function isIdentifierOccurrence(line: string, index: number): boolean {
  const prefix = line.slice(0, index);
  const writeVerb = lastMatch(prefix, WRITE_VERB);
  if (!writeVerb) return true;
  const moduleContext = lastMatch(prefix, MODULE_CONTEXT);
  return moduleContext !== null && moduleContext.index > writeVerb.index;
}

/** A whole backticked span that is a `require(...)` / `import(...)` call. */
const MODULE_INVOCATION = /^(?:require|import)\s*\(\s*(['"`])(.+?)\1\s*\)$/;

/** Backticked path-shaped spans, classified as targets or identifiers. */
function backtickedPaths(line: string): PathOccurrence[] {
  const found: PathOccurrence[] = [];
  const pattern = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const span = match[1].trim();
    const invocation = MODULE_INVOCATION.exec(span);
    if (invocation) {
      const value = stripLineSuffix(invocation[2].trim());
      if (value.includes('/')) {
        found.push({ path: value, index: match.index, moduleSpecifier: true });
      }
      continue;
    }
    const value = stripLineSuffix(span);
    if (value.includes('/')) {
      found.push({
        path: value,
        index: match.index,
        moduleSpecifier: isIdentifierOccurrence(line, match.index)
      });
    }
  }
  return found;
}

/** Bare path-shaped tokens (no backticks) on the line. */
function barePaths(line: string): PathOccurrence[] {
  // Blank a backticked span with spaces of the SAME length so later offsets stay
  // aligned with `line` (issue #436, D2).
  const withoutBackticks = line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
  const found: PathOccurrence[] = [];
  let match: RegExpExecArray | null;
  PATH_TOKEN.lastIndex = 0;
  while ((match = PATH_TOKEN.exec(withoutBackticks)) !== null) {
    found.push({
      path: stripLineSuffix(match[0]),
      index: match.index,
      moduleSpecifier: isIdentifierOccurrence(withoutBackticks, match.index)
    });
  }
  return found;
}

/** True when the AC label (`- **Acceptance Criteria:**`) opens the region. */
function opensAcRegion(line: string): boolean {
  return /^-\s+\*\*Acceptance\s+Criteria:?\*\*/i.test(line.trim()) ||
    /^\*\*Acceptance\s+Criteria:?\*\*/i.test(line.trim());
}

function isAcHeading(heading: HeadingLine): boolean {
  return /Acceptance\s+Criteria/i.test(heading.text);
}

/** A `- **Out of Scope:**` bullet marker; capture 1 is the declaration body. */
const OUT_OF_SCOPE_MARKER = /^\s*[-*+]\s+\*\*Out\s+of\s+Scope:?\*\*\s*(.*)$/i;
const BULLET_START = /^\s*[-*+]\s+/;
const HEADING_START = /^\s*#{1,6}\s+/;
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Every path-shaped token in the AC region and the checkbox checklist.
 *
 * Fenced blocks are not plan text: plans legitimately embed fixture plans and
 * test sources in their smoke checks, and scanning a fixture as if it were this
 * plan's instructions would refuse the plan for text it never asked anyone to
 * edit.
 */
export function extractPlanTargetPaths(
  planContent: string | null | undefined
): readonly PlanEvidenceFinding[] {
  if (!planContent || typeof planContent !== 'string') return Object.freeze([]);
  const lines = planContent.split('\n');
  const findings: PlanEvidenceFinding[] = [];
  const seen = new Set<string>();

  let fence = false;
  let inAc = false;
  let acLevel: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (isFenceImpl(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;

    const heading = parseHeadingImpl(line);
    if (inAc) {
      const closes =
        heading !== null &&
        (acLevel === null ? true : heading.level <= acLevel) &&
        !isAcHeading(heading);
      if (closes) {
        inAc = false;
        acLevel = null;
      }
    }
    if (!inAc && isAcHeading(heading ?? { level: 0, text: '' })) {
      inAc = true;
      acLevel = heading?.level ?? null;
      continue;
    }
    if (!inAc && opensAcRegion(line)) {
      inAc = true;
      acLevel = null;
      continue;
    }

    const isListItem = /^\s*[-*+]\s+/.test(line);
    const isCheckbox = /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line);

    // An `- **Out of Scope:**` bullet is a declaration, not an acceptance
    // criterion: the planner's documented escape names the excluded tree
    // (issue #518, #479).
    if (inAc && isListItem && !OUT_OF_SCOPE_MARKER.test(line)) {
      for (const occurrence of [...backtickedPaths(line), ...barePaths(line)]) {
        const key = `${lineNumber}|${occurrence.path}|acceptance criteria|false`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          path: occurrence.path,
          line: lineNumber,
          target: 'acceptance criteria',
          reason: '',
          moduleSpecifier: false
        });
      }
    }

    if (isCheckbox) {
      for (const occurrence of [...backtickedPaths(line), ...barePaths(line)]) {
        const key = `${lineNumber}|${occurrence.path}|implementation checklist|${occurrence.moduleSpecifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          path: occurrence.path,
          line: lineNumber,
          target: 'implementation checklist',
          reason: '',
          moduleSpecifier: occurrence.moduleSpecifier
        });
      }
    }
  }

  return Object.freeze(findings);
}

function normaliseRoot(workspaceRoot: string): string {
  const text = String(workspaceRoot ?? '').trim();
  if (text.length === 0) return '';
  return normaliseLexicalPath(text);
}

/** True when the path lexically resolves outside `workspaceRoot`. */
export function isOutsideWorkspace(path: string, workspaceRoot: string): boolean {
  const raw = String(path ?? '').trim();
  if (raw.length === 0) return false;
  const root = normaliseRoot(workspaceRoot);
  if (root.length === 0) return false;

  const resolved = raw.startsWith('/')
    ? normaliseLexicalPath(raw)
    : normaliseLexicalPath(`${root}/${raw}`);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return resolved !== root && !resolved.startsWith(prefix);
}

/** True when the path lands in a commit-excluded tree, absolute or relative. */
export function isInCommitExcludedTree(path: string): boolean {
  const raw = String(path ?? '').trim().replace(/\\/g, '/');
  if (raw.length === 0) return false;
  const normalised = normaliseLexicalPath(raw);
  const withoutAnchor = normalised.replace(/^\/+/, '');
  if (isCommitExcludedPath(normalised) || isCommitExcludedPath(withoutAnchor)) {
    return true;
  }
  // An absolute path may sit inside an excluded tree below the workspace root:
  // `/home/…/artifacts/x.md` is excluded even though it does not START with
  // `artifacts/`.
  const segments = withoutAnchor.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = segments.slice(index).join('/');
    if (isCommitExcludedPath(candidate)) {
      return true;
    }
  }
  return false;
}

/**
 * Lints the plan's AC and checklist paths against the delivered change set.
 *
 * A finding is a path that is commit-excluded, or that lexically escapes the
 * workspace root.
 */
export function lintPlanEvidencePaths(
  planContent: string | null | undefined,
  workspaceRoot: string
): readonly PlanEvidenceFinding[] {
  const findings: PlanEvidenceFinding[] = [];
  for (const candidate of extractPlanTargetPaths(planContent)) {
    // The excluded-tree rule is a safety net: it fires even for an identifier
    // mention (issue #436, AC3).
    if (isInCommitExcludedTree(candidate.path)) {
      findings.push({
        path: candidate.path,
        line: candidate.line,
        target: candidate.target,
        reason: 'it is inside a commit-excluded tree (artifacts/, .agyloop/, node_modules/)',
        moduleSpecifier: candidate.moduleSpecifier
      });
      continue;
    }
    if (candidate.moduleSpecifier) continue;
    if (isOutsideWorkspace(candidate.path, workspaceRoot)) {
      findings.push({
        path: candidate.path,
        line: candidate.line,
        target: candidate.target,
        reason: 'it lies outside the workspace',
        moduleSpecifier: candidate.moduleSpecifier
      });
    }
  }
  return Object.freeze(findings);
}

/**
 * The planner's deliberate non-delivery declarations (`- **Out of Scope:** …`).
 *
 * A correction deliberately not delivered must say so; the reviewer renders
 * these so an AC cannot be claimed "met" by an out-of-scope document.
 *
 * A declaration is folded, not truncated (issue #439, D1): each following line
 * that is not a blank line, a new bullet, a heading, a horizontal rule or a
 * fence is a hard-wrapped continuation and joins the declaration with a single
 * space. A blank line is a markdown paragraph break, so it terminates too.
 * Fenced text never contributes a declaration, and the fence toggle flushes.
 */
export function extractOutOfScopeDeclarations(
  planContent: string | null | undefined
): readonly string[] {
  if (!planContent || typeof planContent !== 'string') return Object.freeze([]);
  const declarations: string[] = [];
  let fence = false;
  let pending: string[] | null = null;

  const flush = (): void => {
    if (!pending) return;
    const joined = pending.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length > 0) declarations.push(joined);
    pending = null;
  };

  for (const line of planContent.split('\n')) {
    if (isFenceImpl(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;

    const match = OUT_OF_SCOPE_MARKER.exec(line);
    if (match) {
      flush();
      pending = [match[1].trim()];
      continue;
    }
    if (!pending) continue;

    const trimmed = line.trim();
    if (
      trimmed.length === 0 ||
      BULLET_START.test(line) ||
      HEADING_START.test(line) ||
      HORIZONTAL_RULE.test(line)
    ) {
      flush();
      continue;
    }
    pending.push(trimmed);
  }
  flush();
  return Object.freeze(declarations);
}

/** A path-shaped token inside a declaration; a trailing slash is allowed. */
const DECLARED_PATH_TOKEN = /(?:[A-Za-z0-9_.~$*-]+\/)+[A-Za-z0-9_.~$*-]*/g;

function normaliseDeclaredPath(value: string): string {
  return stripLineSuffix(String(value ?? '').trim())
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function pathsOverlap(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * True when a parsed `- **Out of Scope:**` declaration names `path`.
 *
 * A declaration names a path, or a tree that contains it, in either
 * direction: `artifacts/plans` covers a finding for a file under it, and a
 * declaration for that file covers a finding for the tree (issue #518, #479).
 */
export function isPathDeclaredOutOfScope(
  path: string,
  declarations: readonly string[]
): boolean {
  const target = normaliseDeclaredPath(path);
  if (target.length === 0) return false;
  for (const declaration of declarations) {
    DECLARED_PATH_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DECLARED_PATH_TOKEN.exec(declaration)) !== null) {
      if (pathsOverlap(target, normaliseDeclaredPath(match[0]))) return true;
    }
  }
  return false;
}
