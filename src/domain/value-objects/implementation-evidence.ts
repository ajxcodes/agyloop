/**
 * agyloop - Implementation Evidence Predicate (Domain Layer)
 *
 * ONE definition of "does this path count as evidence that an implementation
 * happened?" — shared by the YOLO implementation probe (issue #259) and by any
 * other consumer, so the noise filter can never drift between them.
 *
 * Purity note: this module has NO imports outside `src/domain/` — no `node:path`,
 * no `fs`, no process access. The repository's architecture fitness test
 * (`tests/architecture/hexagonal-boundaries.test.ts`) forbids every external
 * import inside `src/domain`, so the path comparison is implemented here as
 * pure string computation.
 *
 * The rule:
 * - A TRACKED change (modified / staged / deleted / renamed) is evidence
 *   unless it is a lock file or lives under `dist/` / `build/` — parity with
 *   `DIFF_EXCLUDE_ARGS`.
 * - An UNTRACKED entry is evidence unless it is one of the tool's own
 *   bookkeeping paths (state, config, plan scaffold) or a symlink the worktree
 *   manager injects into every task worktree.
 */

import {
  DIFF_EXCLUDED_PATTERNS,
  IMPLEMENTATION_EVIDENCE_EXCLUDED_FILES,
  IMPLEMENTATION_EVIDENCE_EXCLUDED_PREFIXES
} from '../constants';

/**
 * True when `filePath` is `prefix` itself or lives underneath it.
 *
 * The prefix may carry a trailing slash (`node_modules/`); the comparison is
 * segment-aware, so `node_modules` (the symlink a worktree reports) and
 * `node_modules/pkg/index.js` both match `node_modules/`, while
 * `node_modules_old/` does not.
 */
function isUnderPrefix(filePath: string, prefix: string): boolean {
  const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (!normalizedPrefix) {
    return false;
  }
  return filePath === normalizedPrefix || filePath.startsWith(`${normalizedPrefix}/`);
}

/**
 * True when `filePath` is evidence that an implementation was produced.
 *
 * @param filePath - The repository-relative path (git porcelain grammar).
 * @param isUntracked - True for `??` entries, false for tracked changes.
 * @returns False for empty/non-string input — absence of evidence is never
 *          evidence.
 */
export function isImplementationEvidencePath(filePath: string, isUntracked: boolean): boolean {
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }

  const normalized = filePath.trim();
  if (!normalized) {
    return false;
  }

  if (isUntracked) {
    // The tool's own bookkeeping (state, config, plan scaffold) and the
    // symlinks every task worktree carries are never an implementation.
    if (
      IMPLEMENTATION_EVIDENCE_EXCLUDED_PREFIXES.some((prefix) =>
        isUnderPrefix(normalized, prefix)
      )
    ) {
      return false;
    }
    if (IMPLEMENTATION_EVIDENCE_EXCLUDED_FILES.includes(normalized)) {
      return false;
    }
    return true;
  }

  // Tracked change: parity with DIFF_EXCLUDE_ARGS (lock files + dist/ + build/).
  // Everything else — including a tracked edit under prompts/ or templates/ —
  // IS a real implementation and is always counted.
  for (const pattern of DIFF_EXCLUDED_PATTERNS) {
    if (pattern.endsWith('/')) {
      if (isUnderPrefix(normalized, pattern)) {
        return false;
      }
    } else if (normalized === pattern) {
      return false;
    }
  }

  return true;
}
