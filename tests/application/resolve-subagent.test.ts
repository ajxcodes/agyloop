/**
 * agyloop - ResolveSubagentUseCase Unit Tests
 *
 * Tests for critique path resolution and two-tier reviewer prompt generation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ResolveSubagentUseCase,
  ManageCritiqueUseCase,
  DIFF_EXCLUDE_ARGS,
  MAX_INLINE_DIFF_LINES
} = require('../../dist/application');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');
const { RESOLVER_SOURCE_USER_DATA, RESOLVER_SOURCE_NONE } = require('../../dist/domain');

import type { ConfigRepository, CritiquePort, CritiqueResolution } from '../../src/ports';

class MockConfigRepo implements ConfigRepository {
  public loadConfig(): any {
    return DEFAULT_CONFIG;
  }
  public resolveModel(role: string): any {
    return {
      role,
      configured: 'flash',
      tier: 'flash',
      apiModel: 'gemini-2.5-flash'
    };
  }
  public mapModelToTier(): any {
    return 'flash';
  }
}

class MockCritiquePort implements CritiquePort {
  private readonly resolution: CritiqueResolution;

  constructor(resolution?: CritiqueResolution) {
    this.resolution = resolution ?? {
      source: RESOLVER_SOURCE_NONE,
      path: null,
      isAvailable: false
    };
  }

  public resolveReviewer(): CritiqueResolution {
    return this.resolution;
  }

  public async review(): Promise<any> {
    return {} as any;
  }
}

describe('ResolveSubagentUseCase - Reviewer Prompt & Critique Resolution', () => {
  const configRepo = new MockConfigRepo();

  test('injects explicitly provided params.critiquePath and two-tier instructions into reviewer prompt', () => {
    const useCase = new ResolveSubagentUseCase(configRepo);
    const prompt = useCase.buildReviewerTaskPrompt({
      critiquePath: '/opt/custom/bin/critique',
      issueNumber: 52,
      acceptanceCriteria: ['AC 1: Standardize critique resolution']
    });

    assert.ok(prompt.includes('### Two-Tier Review Methodology:'));
    assert.ok(prompt.includes('export PATH="$HOME/.local/bin:$PATH" && /opt/custom/bin/critique --json'));
    assert.ok(prompt.includes('Tier 1 (Automated Critique CLI)'));
    assert.ok(prompt.includes('Tier 2 (Manual Diff & Standards Inspection)'));
    assert.ok(prompt.includes('Consolidated Verdict'));
    assert.ok(prompt.includes('REVIEW_STATUS: CHANGES_REQUESTED'));
    assert.ok(prompt.includes('AC 1: Standardize critique resolution'));
  });

  test('resolves critique path from injected ManageCritiqueUseCase', () => {
    const critiquePort = new MockCritiquePort({
      source: RESOLVER_SOURCE_USER_DATA,
      path: '/home/user/.local/share/agyloop/tools/critique',
      isAvailable: true
    });
    const mockInstaller: any = {
      checkUpdateAvailable: async () => ({ isOutdated: false })
    };
    const manageCritique = new ManageCritiqueUseCase(critiquePort, mockInstaller);

    const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, manageCritique);
    const prompt = useCase.buildReviewerTaskPrompt({
      issueNumber: 52
    });

    assert.ok(
      prompt.includes(
        'export PATH="$HOME/.local/bin:$PATH" && /home/user/.local/share/agyloop/tools/critique --json'
      )
    );
  });

  test('resolves critique path from injected CritiquePort', () => {
    const critiquePort = new MockCritiquePort({
      source: RESOLVER_SOURCE_USER_DATA,
      path: '/usr/bin/critique',
      isAvailable: true
    });

    const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, critiquePort);
    const prompt = useCase.buildReviewerTaskPrompt();

    assert.ok(prompt.includes('export PATH="$HOME/.local/bin:$PATH" && /usr/bin/critique --json'));
  });

  test('falls back to ~/.local/bin/critique when critique path is unresolvable', () => {
    const critiquePort = new MockCritiquePort({
      source: RESOLVER_SOURCE_NONE,
      path: null,
      isAvailable: false
    });

    const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, critiquePort);
    const prompt = useCase.buildReviewerTaskPrompt();

    assert.ok(prompt.includes('export PATH="$HOME/.local/bin:$PATH" && ~/.local/bin/critique --json'));
    assert.ok(prompt.includes('Any `critical` or `error` findings mandate `REVIEW_STATUS: CHANGES_REQUESTED`'));
  });

  describe('Token Optimization & Context Shielding in Reviewer Task Prompt', () => {
    test('generates diff inspection command with default <baseBranch> and exclusion pathspecs', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const prompt = useCase.buildReviewerTaskPrompt();

      const expectedCmd =
        "git diff <baseBranch> -- . ':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock' ':!bun.lockb' ':!dist/' ':!build/'";
      assert.ok(prompt.includes(expectedCmd));
    });

    test('generates diff inspection command interpolating explicit baseBranch', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const prompt = useCase.buildReviewerTaskPrompt({
        baseBranch: 'phase/5-orchestrator-hardening'
      });

      const expectedCmd =
        "git diff phase/5-orchestrator-hardening -- . ':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock' ':!bun.lockb' ':!dist/' ':!build/'";
      assert.ok(prompt.includes(expectedCmd));
    });

    test('strips lockfiles and build artifacts when workingDiff is supplied', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const rawDiff = `diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,5 +1,5 @@
-old-lock-entry
+new-lock-entry
diff --git a/src/index.ts b/src/index.ts
index 3333333..4444444 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+export const FEATURE_READY = true;
diff --git a/dist/bundle.min.js b/dist/bundle.min.js
index 5555555..6666666 100644
--- a/dist/bundle.min.js
+++ b/dist/bundle.min.js
@@ -1,1 +1,1 @@
-var a=1;
+var a=2;
`;

      const prompt = useCase.buildReviewerTaskPrompt({
        workingDiff: rawDiff
      });

      assert.ok(!prompt.includes('package-lock.json'));
      assert.ok(!prompt.includes('old-lock-entry'));
      assert.ok(!prompt.includes('dist/bundle.min.js'));
      assert.ok(!prompt.includes('var a=2;'));
      assert.ok(prompt.includes('### Working Code Diff:'));
      assert.ok(prompt.includes('src/index.ts'));
      assert.ok(prompt.includes('export const FEATURE_READY = true;'));
    });

    test('triggers >1,000 line guardrail with diff stat summary and on-demand inspection instructions', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);

      // Create a large synthetic diff (>1,000 lines)
      const largeDiffLines = [
        'diff --git a/src/heavy-module.ts b/src/heavy-module.ts',
        'index 1111111..2222222 100644',
        '--- a/src/heavy-module.ts',
        '+++ b/src/heavy-module.ts',
        '@@ -1,1 +1,1050 @@'
      ];
      for (let i = 0; i < 1050; i++) {
        largeDiffLines.push(`+const line_${i} = ${i};`);
      }
      const largeDiff = largeDiffLines.join('\n');

      const prompt = useCase.buildReviewerTaskPrompt({
        baseBranch: 'main',
        workingDiff: largeDiff
      });

      // Assert guardrail warnings and omit full diff
      assert.ok(prompt.includes('Working diff exceeds 1,000 lines'));
      assert.ok(prompt.includes('Full diff omitted to protect subagent context and shield against token bloat.'));
      assert.ok(prompt.includes('#### Diff Stat:'));
      assert.ok(prompt.includes('src/heavy-module.ts'));
      assert.ok(prompt.includes('The filtered diff is unusually large (>1,000 lines).'));
      assert.ok(
        prompt.includes(
          "git diff --stat main -- . ':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock' ':!bun.lockb' ':!dist/' ':!build/'"
        )
      );
      assert.ok(prompt.includes('git diff main -- <file_path>'));

      // Ensure the thousands of repetitive lines are NOT embedded directly in the prompt
      assert.ok(!prompt.includes('const line_1049 = 1049;'));
    });

    test('retains full diff inline when filtered diff is under 1,000 lines', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const smallDiff = `diff --git a/src/small.ts b/src/small.ts
index 1111111..2222222 100644
--- a/src/small.ts
+++ b/src/small.ts
@@ -1,2 +1,3 @@
+const small = true;
`;

      const prompt = useCase.buildReviewerTaskPrompt({
        workingDiff: smallDiff
      });

      assert.ok(!prompt.includes('Working diff exceeds 1,000 lines'));
      assert.ok(prompt.includes('### Working Code Diff:\n```diff'));
      assert.ok(prompt.includes('+const small = true;'));
    });
  });
});
