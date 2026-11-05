/**
 * codeloop - `sync` reads EVERY merged PR into the collector (#447)
 *
 * The defect this file pins: `gh pr list` returns at most `--limit` items and
 * defaults to 30, so `sync` closed issues for the 30 most recent merges and
 * still printed `Successfully synced … and processed merged PRs.`
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { SyncUseCase } = require('../../dist/application');
const { SYNC_MERGED_PR_PAGE_SIZE, SYNC_MERGED_PR_SCAN_CEILING } = require('../../dist/domain');

/**
 * A `gh pr list` double that MODELS the real flag: it returns at most `--limit`
 * items and falls back to gh's own default of 30 when the flag is absent, so a
 * scan that forgets `--limit` is genuinely blind to the oldest merged PR.
 */
class WindowedExecutor {
  public total: number;
  public failPrList: boolean;
  public prListCalls: string[];
  public limitCalls: number[];

  constructor(total: number, options: { failPrList?: boolean } = {}) {
    this.total = total;
    this.failPrList = options.failPrList === true;
    this.prListCalls = [];
    this.limitCalls = [];
  }

  public async execute(command: string) {
    if (command.startsWith('gh pr list')) {
      this.prListCalls.push(command);
      const limitMatch = /--limit (\d+)/.exec(command);
      const limit = limitMatch ? Number(limitMatch[1]) : 30;
      this.limitCalls.push(limit);
      if (this.failPrList) {
        return { command, exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
      }
      const count = Math.min(limit, this.total);
      const prs = Array.from({ length: count }, (_, index) => {
        const number = this.total - index;
        return { number, title: `delivery ${number}`, body: `Closes #${number + 100}` };
      });
      return { command, exitCode: 0, stdout: JSON.stringify(prs) };
    }
    if (command.startsWith('gh pr view')) {
      return { command, exitCode: 0, stdout: 'src/feature.ts\n' };
    }
    return { command, exitCode: 0, stdout: '' };
  }
}

class GitHubGatewayDouble {
  public closed: number[] = [];
  public comments: { issueId: number; body: string }[] = [];
  public async fetchIssueStrict(issueId: number) {
    return { number: issueId, state: 'OPEN' };
  }
  public async closeIssue(issueId: number) {
    this.closed.push(issueId);
  }
  public async commentOnIssue(issueId: number, body: string) {
    this.comments.push({ issueId, body });
  }
}

function makeUseCase(total: number, options: { failPrList?: boolean } = {}) {
  const executor = new WindowedExecutor(total, options);
  const github = new GitHubGatewayDouble();
  const useCase = new SyncUseCase(
    executor as any,
    github as any,
    { load: async () => null } as any,
    { resolveBaseBranch: async () => 'phase/1' } as any
  );
  return { executor, github, useCase };
}

describe('SyncUseCase merged-PR window (#447)', () => {
  test('MPS1: a merged-PR window wider than the gh default is scanned in full (issue #447)', async () => {
    const { executor, github, useCase } = makeUseCase(45);

    const result = await useCase.execute({ workspaceDir: '/mock' });

    assert.strictEqual(result.scannedMergedPrs, 45);
    assert.strictEqual(
      github.closed.includes(101),
      true,
      'the OLDEST merged PR (issue #101) must be processed'
    );
    assert.strictEqual(github.closed.length, 45);
    assert.strictEqual(result.success, true);
    assert.ok(
      /--limit \d+/.test(executor.prListCalls[0]),
      `the scan must ask for a window: ${executor.prListCalls[0]}`
    );
    assert.ok(executor.limitCalls[0] >= 45, `first page too small: ${executor.limitCalls[0]}`);
  });

  test('MPS2: the scan doubles its page until a short page proves it saw everything (issue #447)', async () => {
    const { executor, github, useCase } = makeUseCase(250);

    const result = await useCase.execute({ workspaceDir: '/mock' });

    assert.deepStrictEqual(executor.limitCalls, [
      SYNC_MERGED_PR_PAGE_SIZE,
      SYNC_MERGED_PR_PAGE_SIZE * 2,
      SYNC_MERGED_PR_PAGE_SIZE * 4
    ]);
    assert.strictEqual(github.closed.length, 250);
    assert.strictEqual(result.scannedMergedPrs, 250);
    assert.strictEqual(result.success, true);
  });

  test('MPS3: a full ceiling page is reported as a truncated scan and refuses every write (issue #447)', async () => {
    const { executor, github, useCase } = makeUseCase(SYNC_MERGED_PR_SCAN_CEILING + 1);

    const result = await useCase.execute({ workspaceDir: '/mock' });

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(github.closed, []);
    assert.deepStrictEqual(github.comments, []);
    assert.match(result.message, /1000-PR ceiling/);
    assert.deepStrictEqual(executor.limitCalls, [100, 200, 400, 800, 1000]);
    assert.ok(
      (result.logs ?? []).some((line: string) => line.includes('Refused to process merged PRs')),
      `the refusal must be logged: ${JSON.stringify(result.logs)}`
    );
  });

  test('MPS4: the success message reports how many merged PRs were scanned (issue #447)', async () => {
    const { useCase } = makeUseCase(3);

    const result = await useCase.execute({ workspaceDir: '/mock' });

    assert.strictEqual(result.message, 'Successfully synced phase/1 and processed 3 merged PRs.');
    assert.strictEqual(result.scannedMergedPrs, 3);
  });

  test('MPS5: a failed gh pr list is an incomplete scan, never a success (issue #447)', async () => {
    const { github, useCase } = makeUseCase(45, { failPrList: true });

    const result = await useCase.execute({ workspaceDir: '/mock' });

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(github.closed, []);
    assert.match(result.message, /gh pr list exited 1: HTTP 502: Bad Gateway/);
  });

  test('MPS6: a dry run forecasts every merged PR and reports the count (issue #447)', async () => {
    const { github, useCase } = makeUseCase(45);

    const result = await useCase.execute({ workspaceDir: '/mock', dryRun: true });

    assert.strictEqual(
      result.message,
      "[dry-run] Would fetch origin and process 45 merged PRs for 'phase/1'. Nothing was fetched, pulled, or closed."
    );
    assert.deepStrictEqual(github.closed, []);
    assert.deepStrictEqual(github.comments, []);
    assert.ok(
      (result.logs ?? []).some((line: string) => line.includes('[dry-run] Would close issue #101')),
      `the oldest merged PR must be forecast: ${JSON.stringify(result.logs)}`
    );
  });
});
