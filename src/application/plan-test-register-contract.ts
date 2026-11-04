/**
 * agyloop - the ONE Test Register contract guard (issue #432, AC3)
 *
 * A plan whose Test Register pins an existing test but declares a different
 * expected value is refused at APPROVAL, naming the contradicting test and its
 * line. Two approval entry points (`codeloop implement` and
 * `codeloop transition APPROVAL`) must emit the IDENTICAL refusal, so the
 * enforcement lives here and each caller keeps its own plan resolution.
 *
 * A `Pins:` row resolves against the DELIVERED worktree; a `New test:` row is
 * judged against the BASE revision, so a plan re-approved after
 * `IMPLEMENT -> PLAN` is not refused for the tests its own implementation
 * added (issue #489). Only an UNRESOLVABLE base falls back to the worktree.
 *
 * The same guard also refuses a planned test id that already exists in its
 * target file, at the same base revision the title dedupe uses (issue #518,
 * #476).
 *
 * A plan with no `Test Register` section is still checked for planned test ids
 * (a checklist step can plan one); a plan that plans nothing is untouched
 * (legacy plans, AC7).
 */

import {
  MSG_PLAN_TEST_REGISTER_CONTRADICTION,
  MSG_PLAN_TEST_REGISTER_DUPLICATE_ID,
  MSG_PLAN_TEST_REGISTER_DUPLICATE_NEW,
  MSG_PLAN_TEST_REGISTER_DUPLICATE_NEW_BASE,
  MSG_PLAN_TEST_REGISTER_EMPTY,
  MSG_PLAN_TEST_REGISTER_MISSING_MARKER,
  MSG_PLAN_TEST_REGISTER_UNRESOLVABLE,
  ValidationError,
  extractPlannedTestIds,
  extractTestBlock,
  findContradiction,
  findTestIdCollisions,
  readTestRegister,
  type TestRegisterRow
} from '../domain';
import { PlanGeneratorPort, RevisionReadResult, SourceFileReaderPort } from '../ports';

export interface PlanTestRegisterContractParams {
  readonly planGenerator?: PlanGeneratorPort;
  /**
   * Optional so every existing call site/tests keeps compiling. Without it the
   * marker shape is still enforced; reference resolution is reported as
   * unresolvable only when a real workspace read was possible.
   */
  readonly sourceFileReader?: SourceFileReaderPort;
  readonly planPath: string | null;
  readonly workspaceDir: string;
  /**
   * The base reference a `New test:` row is judged against (issue #489). Both
   * approval entry points resolve it through `resolveTestRegisterBaseRef`, so a
   * re-approval over the implementation's dirty worktree compares the title
   * with the base instead of with the implementation's own new tests.
   */
  readonly baseRef?: string | null;
  readonly dryRun?: boolean;
}

/** The reference used when neither the CLI nor the checkpoint supplies one. */
const DEFAULT_TEST_REGISTER_BASE_REF = 'main';

/**
 * The base revision a `New test:` row is judged against (issue #489).
 *
 * Order: an explicit `--base-branch`, the base branch recorded on the
 * checkpoint, the worktree descriptor's base branch, then `main` — the same
 * fallback chain `probeImplementationDiff` uses for the review diff
 * (run-lifecycle.ts `params.baseRef ?? params.baseBranch ?? sm.baseBranch ??
 * 'main'`). ONE owner for the trimming and the default, so the two approval
 * entry points cannot disagree.
 */
export function resolveTestRegisterBaseRef(
  candidates: ReadonlyArray<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const trimmed = String(candidate ?? '').trim();
    if (trimmed.length > 0) return trimmed;
  }
  return DEFAULT_TEST_REGISTER_BASE_REF;
}

function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

function missingMarker(row: TestRegisterRow): string {
  return format(MSG_PLAN_TEST_REGISTER_MISSING_MARKER, { row: row.id });
}

/**
 * Reads `path` at `revision`.
 *
 * `absent` is a VERDICT (the revision resolved and the path is not in it), so
 * only `unavailable` reaches the caller's working-tree fallback. A reader
 * without the capability is `unavailable` too: the guard degrades to the
 * pre-#489 rule, it never widens.
 */
function readAtRevision(
  reader: SourceFileReaderPort,
  path: string,
  workspaceDir: string,
  revision: string
): RevisionReadResult {
  if (typeof reader.readAtRevision !== 'function') {
    return { status: 'unavailable', reason: 'the source reader cannot resolve a revision' };
  }
  try {
    return reader.readAtRevision(path, workspaceDir, revision);
  } catch (err: unknown) {
    return { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The target file's content for the id lint: the BASE revision decides
 * (issue #489), `absent` means nothing can collide, and only an unresolvable
 * base falls back to the delivered tree — the same order the title dedupe uses.
 */
function readTargetSource(
  reader: SourceFileReaderPort,
  path: string,
  workspaceDir: string,
  baseRef: string
): string | null {
  const atBase = readAtRevision(reader, path, workspaceDir, baseRef);
  if (atBase.status === 'found') return atBase.content;
  if (atBase.status === 'absent') return null;
  return reader.read(path, workspaceDir);
}

/** One refusal per planned id that already exists in its target file (issue #518, #476). */
function collectPlannedTestIdRefusals(
  content: string,
  params: PlanTestRegisterContractParams,
  reader: SourceFileReaderPort,
  skippedRowIds: ReadonlySet<string>
): string[] {
  const refusals: string[] = [];
  const baseRef = resolveTestRegisterBaseRef([params.baseRef]);
  for (const planned of extractPlannedTestIds(content)) {
    if (planned.rowId !== null && skippedRowIds.has(planned.rowId)) continue;
    const source = readTargetSource(reader, planned.path, params.workspaceDir, baseRef);
    if (source === null) continue;
    const collisions = findTestIdCollisions(source, planned.id);
    if (collisions.length === 0) continue;
    refusals.push(
      format(MSG_PLAN_TEST_REGISTER_DUPLICATE_ID, {
        id: planned.id,
        path: planned.path,
        where:
          planned.rowId !== null
            ? `Test Register row ${planned.rowId} at plan line ${planned.line}`
            : `implementation checklist step at plan line ${planned.line}`,
        lines: collisions
          .map((collision) => `${planned.path}:${collision.line}`)
          .join(', ')
      })
    );
  }
  return refusals;
}

/**
 * Throws `ValidationError('testRegister', …)` unless every row pins a real
 * test that restates its literal, or declares a genuinely new test.
 */
export function assertPlanTestRegisterContract(params: PlanTestRegisterContractParams): void {
  const { planGenerator, planPath, sourceFileReader } = params;
  if (!planGenerator || !planPath) return;

  let content: string;
  try {
    content = planGenerator.readPlanDocument(planPath);
  } catch {
    // An unreadable plan is not a register; other guards report that.
    return;
  }

  const section = readTestRegister(content);

  const refusals: string[] = [];
  if (section.present && section.rows.length === 0) {
    refusals.push(
      format(MSG_PLAN_TEST_REGISTER_EMPTY, {
        line: String(section.headingLine ?? 0)
      })
    );
  }
  // Rows refused for an existing title keep just that refusal: the id pass
  // would otherwise restate the same row (issue #518).
  const refusedRows = new Set<string>();
  if (section.present) {
    for (const row of section.rows) {
      if (!row.pins && !row.newTest) {
        refusals.push(missingMarker(row));
        continue;
      }

      if (row.pins && sourceFileReader) {
        const source = sourceFileReader.read(row.pins.path, params.workspaceDir);
        if (source === null) {
          refusals.push(
            format(MSG_PLAN_TEST_REGISTER_UNRESOLVABLE, {
              row: row.id,
              path: row.pins.path,
              title: row.pins.title,
              reason: 'the file is missing, unreadable, or outside the workspace'
            })
          );
          continue;
        }
        const block = extractTestBlock(source, row.pins.title);
        if (block === null) {
          refusals.push(
            format(MSG_PLAN_TEST_REGISTER_UNRESOLVABLE, {
              row: row.id,
              path: row.pins.path,
              title: row.pins.title,
              reason: `no test('${row.pins.title}') was found in the file`
            })
          );
          continue;
        }
        const contradiction = findContradiction(row.asserts, block.text, block.line);
        if (contradiction) {
          refusals.push(
            format(MSG_PLAN_TEST_REGISTER_CONTRADICTION, {
              row: row.id,
              file: row.pins.path,
              line: String(contradiction.line),
              subject: contradiction.subject,
              rowValue: contradiction.rowValue,
              pinnedValue: contradiction.pinnedValue
            })
          );
        }
        continue;
      }

      if (row.newTest && sourceFileReader) {
        // Issue #489: the base revision decides whether the title already
        // exists. Asking the delivered tree made a plan re-approved after
        // IMPLEMENT -> PLAN refuse the very tests its implementation added.
        const baseRef = resolveTestRegisterBaseRef([params.baseRef]);
        const atBase = readAtRevision(
          sourceFileReader,
          row.newTest.path,
          params.workspaceDir,
          baseRef
        );

        if (atBase.status === 'found') {
          const duplicate = extractTestBlock(atBase.content, row.newTest.title);
          if (duplicate !== null) {
            refusedRows.add(row.id);
            refusals.push(
              format(MSG_PLAN_TEST_REGISTER_DUPLICATE_NEW_BASE, {
                row: row.id,
                path: row.newTest.path,
                title: row.newTest.title,
                base: baseRef,
                line: String(duplicate.line)
              })
            );
          }
          // The base answered: the worktree is the implementation's own work.
          continue;
        }

        if (atBase.status === 'absent') {
          // The revision resolved and does not contain the path: genuinely new.
          continue;
        }

        // `unavailable`: no honest answer from the base (not a repository, an
        // unknown ref, an unreadable object). Fail closed on the pre-#489 rule —
        // the delivered tree decides.
        const source = sourceFileReader.read(row.newTest.path, params.workspaceDir);
        const duplicate = source === null ? null : extractTestBlock(source, row.newTest.title);
        if (duplicate !== null) {
          refusedRows.add(row.id);
          refusals.push(
            format(MSG_PLAN_TEST_REGISTER_DUPLICATE_NEW, {
              row: row.id,
              path: row.newTest.path,
              title: row.newTest.title,
              line: String(duplicate.line)
            })
          );
        }
      }
    }
  }

  if (sourceFileReader) {
    refusals.push(...collectPlannedTestIdRefusals(content, params, sourceFileReader, refusedRows));
  }

  if (refusals.length === 0) return;

  const reason = `${refusals.join(' ')} (plan: ${planPath})`;
  if (params.dryRun) {
    console.warn(`[codeloop] Warning: ${reason}`);
    return;
  }

  throw new ValidationError('testRegister', planPath, reason);
}
