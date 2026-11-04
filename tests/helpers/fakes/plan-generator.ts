/**
 * agyloop - ONE canonical PlanGeneratorPort double (issue #544 / AC2)
 *
 * Retires `PlanGeneratorDouble` / `PlanGeneratorDouble`. Recording is always on:
 * `scaffoldCalls`, `generateCalls`, `summaryCalls`, `updateSummaryCalls` —
 * plus the assertion surface the largest local copy (run-lifecycle) carried:
 * `planContent`, and result carriers configurable per suite.
 */

import type { PlanGeneratorPort } from '../../../src/ports';

interface FakePlanGeneratorOptions {
  /** `readPlanDocument()` body — default the smallest passing plan. */
  planContent?: string;
  /** `hashPlanDocument()` body (normalized digest, issue #298). */
  planHash?: string | null;
  /** Result `scaffoldPlanDirectory` returns; defaults are the run-lifecycle paths. */
  scaffoldResult?: Record<string, unknown>;
  /** Result `resolvePlanFile` returns; default mirrors the scaffold result. */
  resolvePlanFileResult?: Record<string, unknown> | null;
  /** `findPlanDirectory` result; default the implementation-plan folder. */
  existingPlanDir?: string | null;
  generatePlanResult?: Record<string, unknown>;
  detectPlanType?: (title: string, labels?: readonly string[]) => 'discovery' | 'implementation';
}

class FakePlanGenerator implements PlanGeneratorPort {
  public calls: Record<string, unknown[]> = {
    scaffoldPlanDirectory: [],
    generatePlan: [],
    generateSummaryLog: [],
    updateSummaryLog: [],
    findPlanDirectory: [],
    resolvePlanFile: [],
    readPlanDocument: [],
    hashPlanDocument: [],
    detectPlanType: []
  };

  public scaffoldCalls: unknown[] = [];
  public generateCalls: unknown[] = [];
  public summaryCalls: unknown[] = [];
  public updateSummaryCalls: unknown[] = [];

  public planContent: string;
  public planHash: string | null;
  public scaffoldResult: Record<string, unknown>;
  public resolvePlanFileResult: Record<string, unknown> | null;
  public existingPlanDir: string | null;
  public generatePlanResult: Record<string, unknown>;
  public detectPlanTypeFn: FakePlanGeneratorOptions['detectPlanType'];

  constructor(options: FakePlanGeneratorOptions = {}) {
    const base = {
      folderName: '32-test-feature',
      planDir: '/mock/workspace/artifacts/plans/32-test-feature',
      planPath: '/mock/workspace/artifacts/plans/32-test-feature/implementation-plan.md',
      summaryPath: '/mock/workspace/artifacts/plans/32-test-feature/summary-log.md',
      mirrorPath: null,
      type: 'implementation',
      directoryCreated: true,
      filesCreated: true,
      adoptedExisting: false
    };
    this.planContent =
      options.planContent ??
      '# Test Plan\n\n## Acceptance Criteria\n- [ ] Code compiles\n- [ ] Tests pass\n';
    this.planHash = options.planHash ?? null;
    this.scaffoldResult = { ...base, ...(options.scaffoldResult ?? {}) } as Record<string, unknown>;
    this.scaffoldResult.type = this.scaffoldResult.type ?? 'implementation';
    this.resolvePlanFileResult =
      options.resolvePlanFileResult === undefined
        ? { ...base }
        : options.resolvePlanFileResult;
    this.existingPlanDir = options.existingPlanDir === undefined ? base.planDir : options.existingPlanDir;
    this.generatePlanResult = {
      path: this.scaffoldResult.planPath,
      ...(options.generatePlanResult ?? {})
    } as Record<string, unknown>;
    this.detectPlanTypeFn = options.detectPlanType;
  }

  public scaffoldPlanDirectory(params: never) {
    this.calls.scaffoldPlanDirectory.push([params]);
    this.scaffoldCalls.push(params);
    return this.scaffoldResult as never;
  }

  public detectPlanType(title: string, labels?: readonly string[]) {
    this.calls.detectPlanType.push([title, labels]);
    if (this.detectPlanTypeFn) {
      return this.detectPlanTypeFn(title, labels);
    }
    const name = String(title || '').toLowerCase();
    const labelList = [...(labels ?? [])];
    const discovery = labelList.includes('discovery') || name.includes('discovery');
    return discovery ? 'discovery' : 'implementation';
  }

  public generatePlan(options: never) {
    this.calls.generatePlan.push([options]);
    this.generateCalls.push(options);
    return this.generatePlanResult as never;
  }

  public generateSummaryLog(options: never) {
    this.calls.generateSummaryLog.push([options]);
    this.summaryCalls.push(options);
    return { path: this.scaffoldResult.summaryPath, content: '' } as never;
  }

  public updateSummaryLog(summaryFilePath: string, updateData: never) {
    this.calls.updateSummaryLog.push([summaryFilePath, updateData]);
    this.updateSummaryCalls.push({ path: summaryFilePath, data: updateData });
    return true;
  }

  public findPlanDirectory(projectRoot: string, issueNumber: number | string, title?: string) {
    this.calls.findPlanDirectory.push([projectRoot, issueNumber, title]);
    return this.existingPlanDir;
  }

  public resolvePlanFile(options: never) {
    this.calls.resolvePlanFile.push([options]);
    return (this.resolvePlanFileResult === null ? null : this.resolvePlanFileResult) as never;
  }

  public readPlanDocument(planPath: string): string {
    this.calls.readPlanDocument.push([planPath]);
    return this.planContent;
  }

  public hashPlanDocument(planPath: string): string | null {
    this.calls.hashPlanDocument.push([planPath]);
    return this.planHash;
  }
}

function createFakePlanGenerator(options?: FakePlanGeneratorOptions): FakePlanGenerator {
  return new FakePlanGenerator(options ?? {});
}

module.exports = { FakePlanGenerator, createFakePlanGenerator };
