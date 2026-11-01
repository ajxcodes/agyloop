/**
 * agyloop - the ONE Test Register contract guard (issue #432, AC3)
 *
 * A plan whose Test Register pins an existing test but declares a different
 * expected value is refused at APPROVAL, naming the contradicting test and its
 * line. Two approval entry points (`codeloop implement` and
 * `codeloop transition APPROVAL`) must emit the IDENTICAL refusal, so the
 * enforcement lives here and each caller keeps its own plan resolution.
 *
 * A plan with no `Test Register` section is untouched (legacy plans, AC7).
 */

import {
  MSG_PLAN_TEST_REGISTER_CONTRADICTION,
  MSG_PLAN_TEST_REGISTER_DUPLICATE_NEW,
  MSG_PLAN_TEST_REGISTER_MISSING_MARKER,
  MSG_PLAN_TEST_REGISTER_UNRESOLVABLE,
  ValidationError,
  extractTestBlock,
  findContradiction,
  findDuplicateNewTest,
  parseTestRegister,
  type TestRegisterRow
} from '../domain';
import { PlanGeneratorPort, SourceFileReaderPort } from '../ports';

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
  readonly dryRun?: boolean;
}

function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

function missingMarker(row: TestRegisterRow): string {
  return format(MSG_PLAN_TEST_REGISTER_MISSING_MARKER, { row: row.id });
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

  const rows = parseTestRegister(content);
  if (rows.length === 0) return;

  const refusals: string[] = [];
  for (const row of rows) {
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
      const source = sourceFileReader.read(row.newTest.path, params.workspaceDir);
      if (source !== null && findDuplicateNewTest(source, row.newTest.title)) {
        refusals.push(
          format(MSG_PLAN_TEST_REGISTER_DUPLICATE_NEW, {
            row: row.id,
            path: row.newTest.path,
            title: row.newTest.title
          })
        );
      }
    }
  }

  if (refusals.length === 0) return;

  const reason = `${refusals.join(' ')} (plan: ${planPath})`;
  if (params.dryRun) {
    console.warn(`[codeloop] Warning: ${reason}`);
    return;
  }

  throw new ValidationError('testRegister', planPath, reason);
}
