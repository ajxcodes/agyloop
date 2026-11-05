/**
 * codeloop - Architecture Fitness Tests: Pipeline Dedupe (issue #441)
 *
 * Source-text structural tests for the YOLO/standard pipeline dedupe and the
 * CLI command-context resolver. They read the SOURCE files (no dist
 * dependency) with the same `fs.readFileSync` pattern as
 * `tests/architecture/hexagonal-boundaries.test.ts` and assert each extracted
 * block exists EXACTLY ONCE, mechanically:
 *
 *   TR-10 — the quality-gate invocation, the retry-policy read and the
 *           circuit-breaker trip check exist once (AC1, AC6);
 *   TR-11 — the AI-review invocation and the implementation probe run from one
 *           shared implementation each (AC1, AC6);
 *   TR-12 — the CLI command context owns the only strict scope call and all
 *           22 case branches survive (AC2, AC3, AC6).
 *
 * Baselines (plan `Baseline Evidence`): these literals occurred 2x/3x/14x
 * before the refactor; each assertion below pins the post-refactor count and
 * fails before the refactor lands.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const LIFECYCLE_SOURCE = path.join(PROJECT_ROOT, 'src/application/run-lifecycle.ts');
const CLI_SOURCE = path.join(PROJECT_ROOT, 'src/presentation/cli.ts');

function readSource(relativePath: string): string {
  return fs.readFileSync(relativePath, 'utf8');
}

/** Counts non-overlapping literal occurrences. */
function countLiteral(source: string, literal: string): number {
  let count = 0;
  let index = source.indexOf(literal);
  while (index !== -1) {
    count++;
    index = source.indexOf(literal, index + literal.length);
  }
  return count;
}

/** Counts lines matching the anchored `case '` branch pattern. */
function countCaseBranchLines(source: string): number {
  let count = 0;
  for (const line of source.split('\n')) {
    if (/^\s*case '/.test(line)) {
      count++;
    }
  }
  return count;
}

describe('pipeline dedupe (issue #441)', () => {
  test('TR-10: the quality-gate retry policy and trip check exist once across yolo and standard (AC1, AC6)', () => {
    const source = readSource(LIFECYCLE_SOURCE);

    assert.strictEqual(
      countLiteral(source, 'this.runQualityGateUseCase.execute'),
      1,
      'the quality-gate invocation must be executed by exactly one shared helper'
    );
    assert.strictEqual(
      countLiteral(source, 'implementToGateLoops >= maxRetries'),
      1,
      'the circuit-breaker threshold comparison must exist exactly once'
    );
    assert.strictEqual(
      countLiteral(source, "this.handleCircuitBreakerTrip(\n        sm,\n        'qualityGateRetries',"),
      1,
      'the qualityGateRetries trip call must exist exactly once'
    );
    assert.strictEqual(
      countLiteral(source, 'Quality gates failed repeatedly.'),
      1,
      'the trip extra message must be authored once'
    );
  });

  test('TR-11: the AI-review invocation and the implementation probe run from one shared implementation each (AC1, AC6)', () => {
    const source = readSource(LIFECYCLE_SOURCE);

    assert.strictEqual(
      countLiteral(source, 'this.runReviewUseCase.execute'),
      1,
      'the AI-review invocation must be assembled by exactly one shared helper'
    );
    assert.strictEqual(
      countLiteral(source, 'probeImplementationDiff('),
      2,
      'the probe must be defined once and called once, from the shared guard only'
    );
    assert.strictEqual(
      countLiteral(source, 'await this.resolveWorktree('),
      2,
      'worktree resolution: the shared readiness helper plus the untouched implement-mode leg only'
    );
    assert.strictEqual(
      countLiteral(source, 'await this.startImplementationUseCase.execute'),
      2,
      'the implementation-start leg: the shared helper plus the untouched implement-mode leg only'
    );
  });

  test('TR-12: the CLI command context owns the only strict scope call and all 22 case branches survive (AC2, AC3, AC6)', () => {
    const source = readSource(CLI_SOURCE);

    const caseLines = countCaseBranchLines(source);
    assert.strictEqual(
      caseLines,
      22,
      `all 22 case branches must survive the resolver refactor, found ${caseLines}`
    );
    assert.strictEqual(
      countLiteral(source, 'await resolveScope(stateRepo, issueValue)'),
      1,
      'the strict scope resolution must run exactly once, inside resolveCommandContext'
    );
    assert.strictEqual(
      countLiteral(source, 'resolveScopeTolerantly('),
      2,
      'the tolerant resolver must be defined once and called once, from resolveCommandContext'
    );
    assert.strictEqual(
      countLiteral(source, 'resolveCommandContext(stateRepo, issueValue'),
      15,
      'all 14 strict branch sites plus the tolerant abort site must route through the resolver'
    );
    assert.strictEqual(
      countLiteral(source, 'describeWorktreeTruth('),
      3,
      'worktree truth: the definition, the resolver, and the next-directive consumer only'
    );
  });
});
