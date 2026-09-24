/**
 * agyloop - PreFlightCheckEngine (Domain Layer)
 *
 * Pure domain engine evaluating task status prior to worktree provisioning:
 * 1. Anti-Duplicate: halts if task issue is CLOSED on GitHub
 * 2. Anti-Duplicate: halts if an associated PR is already MERGED
 * 3. Resume Mode: re-attaches if an OPEN PR or branch (task/<id>-* or fix/<id>-*) already exists
 *
 * Strict Hexagonal Boundary: Zero direct I/O, zero external dependencies.
 */

import {
  PREFLIGHT_ACTION_PROCEED,
  PREFLIGHT_ACTION_RESUME,
  PREFLIGHT_ACTION_HALT,
  PREFLIGHT_ACTION_HALT_CLOSED,
  PREFLIGHT_ACTION_HALT_PR_MERGED,
  PreFlightActionType
} from '../constants';

export interface PreFlightPrSummary {
  readonly number?: number | null;
  readonly title?: string | null;
  readonly state?: string | null;
  readonly merged?: boolean;
  readonly headRefName?: string | null;
  readonly baseRefName?: string | null;
}

export interface PreFlightCheckContext {
  readonly issueNumber?: number | string | null;
  readonly issueState?: string | null; // e.g. 'OPEN', 'CLOSED'
  readonly prState?: string | null; // e.g. 'OPEN', 'MERGED', 'CLOSED'
  readonly prMerged?: boolean;
  readonly prNumber?: number | null;
  readonly prBaseBranch?: string | null;
  readonly prHeadBranch?: string | null;
  readonly associatedPr?: PreFlightPrSummary | null;
  readonly existingBranch?: string | null;
  readonly existingBranches?: readonly string[];
  readonly existingWorktreePath?: string | null;
  readonly prReviewComments?: readonly {
    readonly author: string;
    readonly body: string;
    readonly path?: string;
    readonly line?: number;
    readonly state?: string;
    readonly createdAt?: string;
    readonly category?: string;
    readonly severity?: string;
  }[];
  readonly prHasChangesRequested?: boolean;
}

export interface PreFlightCheckResult {
  readonly action: PreFlightActionType;
  readonly message: string;
  readonly canProceed: boolean;
  readonly isHalt: boolean;
  readonly isResume: boolean;
  readonly haltReason?: 'CLOSED' | 'MERGED';
  readonly resumeBranch?: string;
  readonly existingBranch?: string | null;
  readonly resumePrNumber?: number;
  readonly baseBranch?: string;
  readonly prReviewComments?: readonly {
    readonly author: string;
    readonly body: string;
    readonly path?: string;
    readonly line?: number;
    readonly state?: string;
    readonly createdAt?: string;
    readonly category?: string;
    readonly severity?: string;
  }[];
  readonly prHasChangesRequested?: boolean;
}

export class PreFlightCheckEngine {
  /**
   * Evaluates pre-flight task status.
   */
  public static evaluate(context: PreFlightCheckContext): PreFlightCheckResult {
    const issueId = context.issueNumber !== null && context.issueNumber !== undefined
      ? String(context.issueNumber).trim()
      : 'unknown';

    // 1. Check if issue is already CLOSED on GitHub
    const issueState = (context.issueState || '').trim().toUpperCase();
    if (issueState === 'CLOSED') {
      return {
        action: PREFLIGHT_ACTION_HALT_CLOSED,
        message: `Task #${issueId} is already closed.`,
        canProceed: false,
        isHalt: true,
        isResume: false,
        haltReason: 'CLOSED',
        existingBranch: null
      };
    }

    // 2. Normalize PR details
    const prState = (
      context.associatedPr?.state ||
      context.prState ||
      ''
    ).trim().toUpperCase();

    const isMerged = Boolean(
      context.associatedPr?.merged ||
      context.prMerged ||
      prState === 'MERGED'
    );

    const prBaseBranch = context.associatedPr?.baseRefName || context.prBaseBranch || null;
    const prHeadBranch = context.associatedPr?.headRefName || context.prHeadBranch || null;
    const prNumber = context.associatedPr?.number || context.prNumber || null;

    if (isMerged) {
      const base = prBaseBranch || 'base branch';
      return {
        action: PREFLIGHT_ACTION_HALT_PR_MERGED,
        message: `PR for task #${issueId} is already merged into ${base}.`,
        canProceed: false,
        isHalt: true,
        isResume: false,
        haltReason: 'MERGED',
        baseBranch: prBaseBranch || undefined,
        existingBranch: null
      };
    }

    // 3. Find matching existing branch if branches list provided
    let discoveredBranch = context.existingBranch || prHeadBranch || null;
    if (!discoveredBranch && context.existingBranches && context.existingBranches.length > 0 && issueId !== 'unknown') {
      const taskPattern = new RegExp(`^(?:task|fix)\\/${issueId}(?:-|$)`, 'i');
      const found = context.existingBranches.find((b) => taskPattern.test(b));
      if (found) {
        discoveredBranch = found;
      }
    }

    // 4. Check if OPEN PR or existing branch exists (Resume Mode)
    const hasOpenPr = prState === 'OPEN';

    if (hasOpenPr || discoveredBranch || context.existingWorktreePath) {
      const branchName = discoveredBranch || `task/${issueId}`;
      const prDetails = prNumber ? ` (PR #${prNumber})` : '';
      return {
        action: PREFLIGHT_ACTION_RESUME,
        message: hasOpenPr
          ? `Found active PR #${prNumber} on branch '${branchName}'. Entering Resume Mode.`
          : `Found existing branch ${branchName}. Entering Resume Mode.`,
        canProceed: true,
        isHalt: false,
        isResume: true,
        resumeBranch: branchName,
        existingBranch: branchName,
        resumePrNumber: prNumber || undefined,
        baseBranch: prBaseBranch || undefined,
        prReviewComments: context.prReviewComments,
        prHasChangesRequested: context.prHasChangesRequested
      };
    }

    // 5. Default: Proceed with fresh execution
    return {
      action: PREFLIGHT_ACTION_PROCEED,
      message: `Pre-flight checks passed for task #${issueId}. Ready for isolated execution.`,
      canProceed: true,
      isHalt: false,
      isResume: false,
      existingBranch: null,
      prReviewComments: context.prReviewComments,
      prHasChangesRequested: context.prHasChangesRequested
    };
  }
}
