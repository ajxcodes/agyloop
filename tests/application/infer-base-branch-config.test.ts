/**
 * agyloop - `config.git.baseBranch` is the configured default base (#333 AC4)
 *
 * Base-branch precedence: explicit caller base → `config.git.baseBranch` →
 * attached HEAD / well-known candidates (`resolveBaseBranch`) → `main`.
 *
 * IBB-333-1 the configured base is the default
 * IBB-333-2 an explicit base still outranks the configured default
 * IBB-333-3 no configured base keeps the resolveBaseBranch probe
 * IBB-333-4 a created collector starts from the configured base
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { InferBaseBranchUseCase } = require('../../dist/application');

/** A worktree manager double that records branch creation. */
function worktreeManagerDouble(options: {
  baseBranch?: string;
  branches?: string[];
  created?: Array<{ branchName: string; startPoint: string }>;
} = {}): any {
  const created = options.created ?? [];
  return {
    created,
    resolveBaseBranch: async () => options.baseBranch ?? 'main',
    listBranches: async () => options.branches ?? [],
    isAncestor: async () => false,
    createBranch: async (params: { branchName: string; startPoint: string }) => {
      created.push({ branchName: params.branchName, startPoint: params.startPoint });
    },
    pushBranch: async () => undefined
  };
}

/** A config repository double returning one fixed config. */
function configRepoDouble(config: unknown): any {
  return {
    loadConfig: () => config,
    resolveModel: () => ({ configured: 'pro', tier: 'pro', apiModel: 'gemini-2.5-pro' }),
    mapModelToTier: (input: string) => input
  };
}

const BASE_CONFIG = {
  models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
  options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true }
};

describe('InferBaseBranchUseCase honours config.git.baseBranch (#333 AC4)', () => {
  test('IBB-333-1 config.git.baseBranch is the default base branch (#333 AC4)', async () => {
    const useCase = new InferBaseBranchUseCase(
      worktreeManagerDouble(),
      undefined,
      undefined,
      configRepoDouble({ ...BASE_CONFIG, git: { baseBranch: 'develop' } })
    );

    const result = await useCase.execute({ issueNumber: 333, workspaceDir: '/repo', persist: false });

    assert.strictEqual(result.baseBranch, 'develop');
    assert.strictEqual(result.autoCreateFrom, 'develop');
  });

  test('IBB-333-2 an explicit base branch outranks the configured default (#333 AC4)', async () => {
    const useCase = new InferBaseBranchUseCase(
      worktreeManagerDouble(),
      undefined,
      undefined,
      configRepoDouble({ ...BASE_CONFIG, git: { baseBranch: 'develop' } })
    );

    const result = await useCase.execute({
      issueNumber: 333,
      workspaceDir: '/repo',
      explicitBaseBranch: 'main',
      persist: false
    });

    assert.strictEqual(result.baseBranch, 'main');
  });

  test('IBB-333-3 no configured base keeps the resolveBaseBranch probe (#333 AC4)', async () => {
    const useCase = new InferBaseBranchUseCase(
      worktreeManagerDouble({ baseBranch: 'trunk' }),
      undefined,
      undefined,
      configRepoDouble({ ...BASE_CONFIG })
    );

    const result = await useCase.execute({ issueNumber: 333, workspaceDir: '/repo', persist: false });

    assert.strictEqual(result.baseBranch, 'trunk');
  });

  test('IBB-333-4 a created collector starts from the configured base (#333 AC4)', async () => {
    const created: Array<{ branchName: string; startPoint: string }> = [];
    const useCase = new InferBaseBranchUseCase(
      worktreeManagerDouble({ branches: [], created }),
      undefined,
      undefined,
      configRepoDouble({ ...BASE_CONFIG, git: { baseBranch: 'develop' } })
    );

    const result = await useCase.execute({
      issueNumber: 333,
      title: 'Phase 6 close-out',
      labels: ['phase:6'],
      workspaceDir: '/repo',
      persist: false
    });

    assert.strictEqual(result.autoCreateFrom, 'develop');
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].startPoint, 'develop');
  });
});
