/**
 * agyloop - RunnerType Value Object
 *
 * The ONE list of selectable subagent runners (issue #290).
 *
 * The declaration lives in the domain, not in `ports`, because the host tool
 * vocabulary registry is an exhaustive `Record<RunnerType, ...>` and a domain
 * module may not import ports (see `tests/architecture/hexagonal-boundaries`).
 * `src/ports/config-repository.ts` imports and re-exports this type, so every
 * existing `import { RunnerType } from '../ports'` keeps resolving.
 */

export const RUNNER_TYPES = Object.freeze(['auto', 'antigravity', 'opencode'] as const);

export type RunnerType = (typeof RUNNER_TYPES)[number];

/**
 * Narrows an arbitrary string to a known runner name.
 *
 * `'auto'` is a known runner whose host is explicitly UNRESOLVED; this predicate
 * only says the string names a runner, never that it names a host.
 */
export function isRunnerType(value: string): value is RunnerType {
  return (RUNNER_TYPES as readonly string[]).includes(value);
}
