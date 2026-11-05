/**
 * codeloop - canonical presentation render fixtures (issue #544)
 *
 * ONE definition of the presentation fixture families this phase measured:
 *
 *   - `checkpointLine(stdout)` — the human `status`/`branch-info`/`next` report
 *     line reader. Render assumption, carried ON the signature by contract:
 *     it expects the human report's line that starts with a literal `Checkpoint`
 *     prefix and returns `''` when no such line exists; it parses the FOLLOWING
 *     text of that line (never the raw stdout). Both byte-equal consumers at
 *     0309f916: `cli-status-resume-task-scope`, `cli-next-and-branch-info`.
 *     The inline `const checkpointLine = human.stdout…` expressions in
 *     `cli-output-truthfulness` are LOCAL usages that parse non-human shapes;
 *     they are not definitions and stay local.
 *
 *   - `buildCritiqueFreePathShadow(shadowRoot)` — a shadow PATH mirroring every
 *     entry while excluding the `critique` binary;
 *     `buildPathShadowWithout(shadowRoot, excluded)` is the same mirror minus
 *     ANY named binary (`gh` for graceful-degradation suites). Real-path
 *     symlinks, per-directory mirrors, dedup — the shape
 *     `CliCritiqueGateway.findInSystemPath` (and the `gh` resolvers) traverse.
 */

const fs = require('node:fs');
const path = require('node:path');

function checkpointLine(stdout: string): string {
  const line = stdout.split('\n').find((l) => l.startsWith('Checkpoint'));
  return line === undefined ? '' : line.slice('Checkpoint'.length).trim();
}

function buildPathShadowWithout(shadowRoot: string, excluded: string): string {
  fs.mkdirSync(shadowRoot, { recursive: true });
  const seen = new Set<string>();
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shadowEntries: string[] = [];
  let idx = 0;

  for (const dir of parts) {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    let entries: string[];
    try {
      entries = fs.readdirSync(real);
    } catch {
      continue;
    }

    const target = path.join(shadowRoot, `d${idx++}`);
    if (!entries.includes(excluded)) {
      try {
        fs.symlinkSync(real, target, 'dir');
        shadowEntries.push(target);
        continue;
      } catch {
        // Fall through to entry-by-entry copy on symlink failure
      }
    }

    fs.mkdirSync(target, { recursive: true });
    for (const entry of entries) {
      if (entry === excluded || entry.startsWith(`${excluded}.`)) continue;
      try {
        fs.symlinkSync(fs.realpathSync(path.join(real, entry)), path.join(target, entry));
      } catch {
        // Skip entries that cannot be resolved
      }
    }
    shadowEntries.push(target);
  }

  return shadowEntries.join(path.delimiter);
}

/** Same shadow as `buildPathShadowWithout(root, 'critique')` — named for the host. */
const CRITIQUE_BINARY = 'critique';

function buildCritiqueFreePathShadow(shadowRoot: string): string {
  return buildPathShadowWithout(shadowRoot, CRITIQUE_BINARY);
}

module.exports = { checkpointLine, buildCritiqueFreePathShadow, buildPathShadowWithout };
