/**
 * agyloop - The delivered change set (issue #432, AC5)
 *
 * The review may only certify an AC whose evidence is in the PR that ships.
 * This module MEASURES that set in the reviewed worktree: tracked changes
 * against the base plus untracked, non-ignored files (`git ls-files --others
 * --exclude-standard`). `measured: false` on any git failure — never a guess.
 *
 * Issue #452: it also names the same change set as CONTENT — one worktree tree
 * hash that the Tier 1 fence and the review use case both compute from the same
 * shell command, so a report produced against a tree that later changed cannot
 * certify it at an unchanged HEAD.
 */

import { CommandExecutorPort } from '../ports';

export interface DeliveredChangeSet {
  /** False when git could not be read; the caller must not fabricate a verdict. */
  readonly measured: boolean;
  readonly paths: readonly string[];
}

export interface ResolveDeliveredChangeSetParams {
  readonly commandExecutor?: CommandExecutorPort;
  readonly cwd: string;
  readonly baseRef?: string | null;
}

function parseNameOnly(stdout: string | undefined): string[] {
  return (stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The ONE shell definition of the reviewed change set as content (issue #452).
 *
 * `git read-tree HEAD` seeds an alternate index with the committed tree, so
 * `git add -A` writes blobs only for what actually changed and `git write-tree`
 * returns a content hash covering tracked modifications/deletions AND every
 * non-ignored untracked file's path and bytes. The tool's own state trees and
 * the commit-excluded artifact tree are removed from the alternate index so
 * checkpoint/report/summary churn during REVIEW cannot invalidate an otherwise
 * unchanged tree. The real index is never touched and the temporary one is
 * always removed.
 *
 * Emitted verbatim into the Tier 1 fence and executed through
 * `CommandExecutorPort`, so both producers run byte-identical text.
 */
export function buildChangeSetDigestCommand(): string {
  return (
    'digest_idx=$(git rev-parse --git-path agyloop-digest-index.$$) && ' +
    'GIT_INDEX_FILE="$digest_idx" git read-tree HEAD && ' +
    'GIT_INDEX_FILE="$digest_idx" git add -A -- . && ' +
    'GIT_INDEX_FILE="$digest_idx" git rm -r -q --cached --ignore-unmatch -- .agyloop .codeloop artifacts node_modules && ' +
    'GIT_INDEX_FILE="$digest_idx" git write-tree; ' +
    'digest_code=$?; rm -f "$digest_idx"; exit $digest_code'
  );
}

export interface ComputeChangeSetDigestParams {
  readonly commandExecutor?: CommandExecutorPort;
  readonly cwd: string;
}

/**
 * The worktree's current change-set digest, or `null` when it cannot be
 * measured (no executor, non-zero exit, unreadable stdout) — never a guess.
 */
export async function computeChangeSetDigest(
  params: ComputeChangeSetDigestParams
): Promise<string | null> {
  const executor = params.commandExecutor;
  if (!executor) return null;
  try {
    const res = await executor.execute(buildChangeSetDigestCommand(), { cwd: params.cwd });
    const digest = (res.stdout ?? '').trim();
    if (res.exitCode !== 0 || !/^[0-9a-f]{7,64}$/i.test(digest)) return null;
    return digest.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolves the change set the reviewed worktree would deliver.
 *
 * Both commands are restricted to `.` so a path outside the worktree can never
 * masquerade as delivered evidence.
 */
export async function resolveDeliveredChangeSet(
  params: ResolveDeliveredChangeSetParams
): Promise<DeliveredChangeSet> {
  const executor = params.commandExecutor;
  if (!executor) {
    return { measured: false, paths: Object.freeze([]) };
  }
  const base = params.baseRef && params.baseRef.trim().length > 0 ? params.baseRef.trim() : 'HEAD';

  try {
    const diff = await executor.execute(`git diff --name-only ${base} -- .`, { cwd: params.cwd });
    if (diff.exitCode !== 0) {
      return { measured: false, paths: Object.freeze([]) };
    }
    const untracked = await executor.execute('git ls-files --others --exclude-standard', {
      cwd: params.cwd
    });
    if (untracked.exitCode !== 0) {
      return { measured: false, paths: Object.freeze([]) };
    }

    const paths = new Set<string>([...parseNameOnly(diff.stdout), ...parseNameOnly(untracked.stdout)]);
    return { measured: true, paths: Object.freeze([...paths]) };
  } catch {
    return { measured: false, paths: Object.freeze([]) };
  }
}
