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

import { isCommitExcludedPath } from '../constants';
import { normaliseLexicalPath } from './smoke-sandbox';

export type PlanEvidenceTarget = 'acceptance criteria' | 'implementation checklist';

export interface PlanEvidenceFinding {
  readonly path: string;
  readonly line: number;
  readonly target: PlanEvidenceTarget;
  readonly reason: string;
}

interface HeadingLine {
  readonly level: number;
  readonly text: string;
}

function parseHeading(line: string): HeadingLine | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
  if (!match) return null;
  return { level: match[1].length, text: match[2].replace(/^\s*\d+[.)]?\s+/, '').trim() };
}

function isFence(line: string): boolean {
  return line.trim().startsWith('```');
}

/** A path-shaped token with an optional `:line` / `:line-range` suffix. */
const PATH_TOKEN = /(?:[A-Za-z0-9_.~$-]+\/)+[A-Za-z0-9_.~$*-]+(:\d+(?:-\d+)?)?/g;

function stripLineSuffix(token: string): string {
  return token.replace(/:\d+(?:-\d+)?$/, '');
}

/** Backticked spans that name a path. */
function backtickedPaths(line: string): string[] {
  const found: string[] = [];
  const pattern = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const value = stripLineSuffix(match[1].trim());
    if (value.includes('/')) {
      found.push(value);
    }
  }
  return found;
}

/** Bare path-shaped tokens (no backticks) on the line. */
function barePaths(line: string): string[] {
  const withoutBackticks = line.replace(/`[^`]*`/g, ' ');
  const found: string[] = [];
  let match: RegExpExecArray | null;
  PATH_TOKEN.lastIndex = 0;
  while ((match = PATH_TOKEN.exec(withoutBackticks)) !== null) {
    found.push(stripLineSuffix(match[0]));
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

    if (isFence(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;

    const heading = parseHeading(line);
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

    if (inAc && isListItem) {
      for (const path of [...backtickedPaths(line), ...barePaths(line)]) {
        const key = `${lineNumber}|${path}|acceptance criteria`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ path, line: lineNumber, target: 'acceptance criteria', reason: '' });
      }
    }

    if (isCheckbox) {
      for (const path of [...backtickedPaths(line), ...barePaths(line)]) {
        const key = `${lineNumber}|${path}|implementation checklist`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ path, line: lineNumber, target: 'implementation checklist', reason: '' });
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
    if (isInCommitExcludedTree(candidate.path)) {
      findings.push({
        path: candidate.path,
        line: candidate.line,
        target: candidate.target,
        reason: 'it is inside a commit-excluded tree (artifacts/, .agyloop/, node_modules/)'
      });
      continue;
    }
    if (isOutsideWorkspace(candidate.path, workspaceRoot)) {
      findings.push({
        path: candidate.path,
        line: candidate.line,
        target: candidate.target,
        reason: 'it lies outside the workspace'
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
 */
export function extractOutOfScopeDeclarations(
  planContent: string | null | undefined
): readonly string[] {
  if (!planContent || typeof planContent !== 'string') return Object.freeze([]);
  const declarations: string[] = [];
  let fence = false;
  for (const line of planContent.split('\n')) {
    if (isFence(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const match = /^\s*[-*+]\s+\*\*Out\s+of\s+Scope:?\*\*\s*(.*)$/i.exec(line);
    if (match && match[1].trim().length > 0) {
      declarations.push(match[1].trim());
    }
  }
  return Object.freeze(declarations);
}
