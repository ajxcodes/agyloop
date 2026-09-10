/**
 * agyloop - TestMetrics Value Object
 *
 * Immutable representation of test execution metrics (passed, failed, skipped, total).
 * Pure domain value object: 100% free of filesystem, child processes, or external I/O.
 */

import {
  TOKEN_TEST_METRICS,
  REGEX_ANSI_ESCAPE,
  REGEX_TEST_METRICS_TOKEN,
  REGEX_METRIC_PASSED,
  REGEX_METRIC_FAILED,
  REGEX_METRIC_SKIPPED,
  REGEX_METRIC_TOTAL,
  REGEX_TAP_TESTS,
  REGEX_TAP_PASS,
  REGEX_TAP_FAIL,
  REGEX_TAP_SKIPPED
} from '../constants';
import { ValidationError } from '../errors';

export interface TestMetricsProps {
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly total?: number;
}

export class TestMetrics {
  public readonly passed: number;
  public readonly failed: number;
  public readonly skipped: number;
  public readonly total: number;

  constructor(props: TestMetricsProps = {}) {
    const passed = props.passed ?? 0;
    const failed = props.failed ?? 0;
    const skipped = props.skipped ?? 0;
    const sum = passed + failed + skipped;
    const total = props.total ?? sum;

    TestMetrics.validateMetric('passed', passed);
    TestMetrics.validateMetric('failed', failed);
    TestMetrics.validateMetric('skipped', skipped);
    TestMetrics.validateMetric('total', total);

    if (total < sum) {
      throw new ValidationError(
        'total',
        total,
        `Total tests (${total}) cannot be less than sum of passed, failed, and skipped (${sum}).`
      );
    }

    this.passed = passed;
    this.failed = failed;
    this.skipped = skipped;
    this.total = total;
    Object.freeze(this);
  }

  private static validateMetric(fieldName: string, value: unknown): void {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new ValidationError(
        fieldName,
        value,
        `Test metric '${fieldName}' must be a non-negative integer.`
      );
    }
  }

  public isAllPassed(): boolean {
    return this.failed === 0 && this.total > 0;
  }

  public hasFailures(): boolean {
    return this.failed > 0;
  }

  public format(): string {
    return `${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped (${this.total} total)`;
  }

  public formatSummary(): string {
    if (this.hasFailures()) {
      return ` (${this.passed} passed, ${this.failed} failed)`;
    }
    if (this.passed > 0) {
      return ` (${this.passed} passed)`;
    }
    return '';
  }

  public toTokenString(): string {
    return `${TOKEN_TEST_METRICS}: ${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped`;
  }

  public equals(other: TestMetrics | null | undefined): boolean {
    if (!other || !(other instanceof TestMetrics)) {
      return false;
    }
    return (
      this.passed === other.passed &&
      this.failed === other.failed &&
      this.skipped === other.skipped &&
      this.total === other.total
    );
  }

  public toJSON(): TestMetricsProps {
    return {
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      total: this.total
    };
  }

  public static create(props: TestMetricsProps = {}): TestMetrics {
    return new TestMetrics(props);
  }

  public static parse(text: string | null | undefined): TestMetrics | null {
    if (!text || typeof text !== 'string') {
      return null;
    }

    const clean = text.replace(REGEX_ANSI_ESCAPE, '');

    // 1. Check for structured token line: TEST_METRICS: ... or TEST_COUNT: ...
    const tokenMatch = clean.match(REGEX_TEST_METRICS_TOKEN);
    const textToSearch = tokenMatch ? tokenMatch[1] : clean;

    let passed: number | undefined;
    let failed: number | undefined;
    let skipped: number | undefined;
    let total: number | undefined;

    // Check standard runner outputs (e.g. Node TAP)
    const tapTotalMatch = textToSearch.match(REGEX_TAP_TESTS);
    const tapPassMatch = textToSearch.match(REGEX_TAP_PASS);
    const tapFailMatch = textToSearch.match(REGEX_TAP_FAIL);
    const tapSkipMatch = textToSearch.match(REGEX_TAP_SKIPPED);

    if (tapTotalMatch) total = parseInt(tapTotalMatch[1], 10);
    if (tapPassMatch) passed = parseInt(tapPassMatch[1], 10);
    if (tapFailMatch) failed = parseInt(tapFailMatch[1], 10);
    if (tapSkipMatch) skipped = parseInt(tapSkipMatch[1], 10);

    // Check regex metric matches (Playwright, Jest, Pytest, Go)
    if (passed === undefined) {
      const passMatch = textToSearch.match(REGEX_METRIC_PASSED);
      if (passMatch) passed = parseInt(passMatch[1], 10);
    }
    if (failed === undefined) {
      const failMatch = textToSearch.match(REGEX_METRIC_FAILED);
      if (failMatch) failed = parseInt(failMatch[1], 10);
    }
    if (skipped === undefined) {
      const skipMatch = textToSearch.match(REGEX_METRIC_SKIPPED);
      if (skipMatch) skipped = parseInt(skipMatch[1], 10);
    }
    if (total === undefined) {
      const totalMatch = textToSearch.match(REGEX_METRIC_TOTAL);
      if (totalMatch) total = parseInt(totalMatch[1], 10);
    }

    const hasAnyMetric =
      passed !== undefined ||
      failed !== undefined ||
      skipped !== undefined ||
      total !== undefined;

    if (!hasAnyMetric) {
      return null;
    }

    const resolvedPassed = passed ?? 0;
    const resolvedFailed = failed ?? 0;
    const resolvedSkipped = skipped ?? 0;
    const sum = resolvedPassed + resolvedFailed + resolvedSkipped;
    const resolvedTotal = total !== undefined ? Math.max(total, sum) : sum;

    return new TestMetrics({
      passed: resolvedPassed,
      failed: resolvedFailed,
      skipped: resolvedSkipped,
      total: resolvedTotal
    });
  }
}
