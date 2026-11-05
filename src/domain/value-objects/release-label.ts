/**
 * agyloop - Release-label definitions (issue #502)
 *
 * The `release:major|minor|patch` vocabulary is the contract with
 * `ajxcodes/auto-tag`, so the label is a PROVISIONED resource, not a string
 * that only exists in an argv. ONE owner for the colour, the description and
 * the exact `gh label create` command, so the refusal text and the adapter
 * argv cannot drift.
 *
 * Pure: no I/O, no ports.
 */

import { RELEASE_LABEL_MAJOR, RELEASE_LABEL_MINOR, RELEASE_LABEL_PATCH, type ReleaseLabelName } from '../vocabulary';

export interface ReleaseLabelDefinition {
  readonly name: ReleaseLabelName;
  readonly color: string;
  readonly description: string;
}

/** Colour used when a label outside the declared vocabulary is provisioned. */
export const DEFAULT_RELEASE_LABEL_COLOR = 'ededed' as const;

export const RELEASE_LABEL_DEFINITIONS: Readonly<Record<ReleaseLabelName, ReleaseLabelDefinition>> =
  Object.freeze({
    [RELEASE_LABEL_MAJOR]: Object.freeze({
      name: RELEASE_LABEL_MAJOR,
      color: 'b60205',
      description: 'SemVer major release (auto-tag)'
    }),
    [RELEASE_LABEL_MINOR]: Object.freeze({
      name: RELEASE_LABEL_MINOR,
      color: '0e8a16',
      description: 'SemVer minor release (auto-tag)'
    }),
    [RELEASE_LABEL_PATCH]: Object.freeze({
      name: RELEASE_LABEL_PATCH,
      color: 'fbca04',
      description: 'SemVer patch release (auto-tag)'
    })
  });

export function releaseLabelDefinition(label: string): ReleaseLabelDefinition | null {
  if (!Object.prototype.hasOwnProperty.call(RELEASE_LABEL_DEFINITIONS, label)) return null;
  return RELEASE_LABEL_DEFINITIONS[label as ReleaseLabelName];
}

/**
 * The exact, copy-pasteable command that provisions `label`. The error
 * message and the docs quote this string verbatim.
 */
export function releaseLabelCreateCommand(label: string, repo?: string | null): string {
  const definition = releaseLabelDefinition(label);
  const color = definition?.color ?? DEFAULT_RELEASE_LABEL_COLOR;
  const description = definition?.description ?? `SemVer release label (${label})`;
  const parts = ['gh', 'label', 'create', label];
  if (repo) parts.push('--repo', repo);
  parts.push('--color', color, '--description', `"${description}"`, '--force');
  return parts.join(' ');
}
