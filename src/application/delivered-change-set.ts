/**
 * agyloop - The delivered change set (issue #432, AC5)
 *
 * The review may only certify an AC whose evidence is in the PR that ships.
 * This module MEASURES that set in the reviewed worktree: tracked changes
 * against the base plus untracked, non-ignored files (`git ls-files --others
 * --exclude-standard`). `measured: false` on any git failure — never a guess.
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
