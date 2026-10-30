/**
 * agyloop - Tier 1 evidence path (Application Layer, issue #397)
 *
 * The REVIEW directive and the orchestrator must name the SAME file, or the
 * reviewer's critique report dies inside its session and `codeloop review`
 * pays a second Tier 1 run. The path is derived from the CHECKPOINT's own
 * location: `<state-root>/.agyloop/critique/<issue>.json`, beside `tasks/` and
 * never inside it (`FileStateRepository.listAllStates` parses every
 * `*.json` in `tasks/`).
 *
 * Pure string algebra: the application layer may not import `path` or `fs`
 * (tests/architecture/hexagonal-boundaries.test.ts), and the checkpoint path
 * is already absolute when it comes from the state adapter.
 */

import { CRITIQUE_REPORT_DIRECTORY, DEFAULT_TASKS_STATE_DIR } from '../domain';

const WINDOWS_SEPARATOR = '\\';
const POSIX_SEPARATOR = '/';
const PATH_SEPARATOR_PATTERN = /[\\/]+/;
const CHECKPOINT_FILE_SUFFIX = '.json';
const ADHOC_ISSUE_TOKEN = 'adhoc';

export function critiqueReportPathFor(
  stateFilePath: string,
  issue?: number | string | null
): string {
  const separator =
    stateFilePath.includes(WINDOWS_SEPARATOR) && !stateFilePath.includes(POSIX_SEPARATOR)
      ? WINDOWS_SEPARATOR
      : POSIX_SEPARATOR;

  const segments = stateFilePath.split(PATH_SEPARATOR_PATTERN);
  segments.pop(); // the checkpoint file itself
  if (segments[segments.length - 1] === DEFAULT_TASKS_STATE_DIR) {
    segments.pop();
  }

  const issueToken =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? ADHOC_ISSUE_TOKEN
      : String(issue).trim();

  return [...segments, CRITIQUE_REPORT_DIRECTORY, `${issueToken}${CHECKPOINT_FILE_SUFFIX}`].join(
    separator
  );
}
