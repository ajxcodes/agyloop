/**
 * agyloop - FileGateReportRepository (issue #284)
 *
 * Persists the gate subagent's evidence beside the checkpoint it certifies:
 * `<workspace>/.agyloop/tasks/<issue>.gate.json`.
 *
 * Deliberately no cross-worktree discovery: the file is a SIBLING of the
 * checkpoint, and both `gate-report` and `transition` are run by the
 * orchestrator from the same workspace. There is exactly one evidence file per
 * issue, so a second filing replaces the first — and `clear()` is how an
 * ingested report is consumed.
 *
 * A corrupt or unreadable file reads as `null`: the caller then reports the
 * gate as "not recorded", which is honest, instead of throwing out of the
 * advance step.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_STATE_DIR,
  DEFAULT_TASKS_STATE_DIR,
  GateResultReport
} from '../domain';
import { GateReportRepositoryPort } from '../ports';

/** The suffix that distinguishes gate evidence from a checkpoint. */
export const GATE_REPORT_FILE_SUFFIX = '.gate.json' as const;

export class FileGateReportRepository implements GateReportRepositoryPort {
  private readonly workspaceDir: string;
  private readonly issue: number | string | null;

  constructor(options: { workspaceDir?: string; issue?: number | string | null } = {}) {
    this.workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    this.issue = options.issue ?? null;
  }

  /** The absolute evidence path for this issue (never the root `state.json`). */
  public getEvidencePath(issue?: number | string | null): string {
    const resolved = issue ?? this.issue;
    const token =
      resolved === null || resolved === undefined || String(resolved).trim().length === 0
        ? 'root'
        : String(resolved).trim();
    return path.join(
      this.workspaceDir,
      DEFAULT_STATE_DIR,
      DEFAULT_TASKS_STATE_DIR,
      `${token}${GATE_REPORT_FILE_SUFFIX}`
    );
  }

  public load(issue?: number | string | null): GateResultReport | null {
    const file = this.getEvidencePath(issue);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return GateResultReport.fromJSON(JSON.parse(raw));
    } catch {
      // Corrupt or absent evidence is not evidence. The caller re-reports it as
      // "not recorded"; it never inherits a value.
      return null;
    }
  }

  public save(issue: number | string | null, report: GateResultReport): string {
    const file = this.getEvidencePath(issue);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report.toJSON(), null, 2)}\n`, 'utf8');
    return file;
  }

  public clear(issue?: number | string | null): void {
    try {
      fs.rmSync(this.getEvidencePath(issue), { force: true });
    } catch {
      // Consume-on-ingest is best effort: an unremovable file is re-reported
      // next round rather than failing the advance step.
    }
  }
}
