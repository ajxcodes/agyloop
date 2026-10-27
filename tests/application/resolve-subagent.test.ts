/**
 * agyloop - ResolveSubagentUseCase Unit Tests
 *
 * Tests for critique path resolution and two-tier reviewer prompt generation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ResolveSubagentUseCase,
  ManageCritiqueUseCase,
  DIFF_EXCLUDE_ARGS,
  MAX_INLINE_DIFF_LINES,
  ANTI_INCEPTION_GUARDRAIL
} = require('../../dist/application');
const { FileBuildDetector } = require('../../dist/infrastructure');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');
const {
  RESOLVER_SOURCE_USER_DATA,
  RESOLVER_SOURCE_NONE,
  TRIAGE_DISPOSITION_ACTIONS,
  STATE_MUTATING_COMMANDS,
  NOTE_REVIEW_VERDICT_RETURN,
  DISCOVERY_REPORT_MIN_CONTENT_UNITS,
  DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS,
  DISCOVERY_REPORT_MIN_CONTENT_CHARS,
  DISCOVERY_REPORT_MIN_CHARS,
  DISCOVERY_REPORT_MIN_FILLED_KEYS,
  DISCOVERY_REPORT_MAX_UNFILLED_KEYS,
  DISCOVERY_REPORT_MIN_PROSE_SECTIONS,
  DiscoveryReport,
  formatDiscoveryReportContract
} = require('../../dist/domain');

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

  describe('Anti-Inception Guardrails', () => {
    test('appends anti-inception guardrail to all subagent task prompts', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);

      const discoveryPrompt = useCase.buildDiscoveryTaskPrompt({ issueNumber: 203 });
      const planningPrompt = useCase.buildPlanningTaskPrompt({ issueNumber: 203 });
      const implementPrompt = useCase.buildImplementationTaskPrompt({ issueNumber: 203 });
      const gatePrompt = useCase.buildGateTaskPrompt({ issueNumber: 203 });
      const reviewerPrompt = useCase.buildReviewerTaskPrompt({ issueNumber: 203 });
      const triagePrompt = useCase.buildTriageTaskPrompt({ issueNumber: 203 });

      assert.ok(discoveryPrompt.includes(ANTI_INCEPTION_GUARDRAIL));
      assert.ok(planningPrompt.includes(ANTI_INCEPTION_GUARDRAIL));
      assert.ok(implementPrompt.includes(ANTI_INCEPTION_GUARDRAIL));
      assert.ok(gatePrompt.includes(ANTI_INCEPTION_GUARDRAIL));
      assert.ok(reviewerPrompt.includes(ANTI_INCEPTION_GUARDRAIL));
      assert.ok(triagePrompt.includes(ANTI_INCEPTION_GUARDRAIL));

      assert.ok(
        triagePrompt.includes('codeloop triage <action> --issue 203'),
        `the triage directive must name the exact routing command, got:\n${triagePrompt}`
      );
      for (const action of TRIAGE_DISPOSITION_ACTIONS) {
        assert.ok(
          triagePrompt.includes(action),
          `the triage directive must name the action '${action}', got:\n${triagePrompt}`
        );
      }
      assert.ok(
        triagePrompt.includes('posts nothing'),
        `the triage directive must state the non-destructive exit, got:\n${triagePrompt}`
      );
      assert.ok(
        triagePrompt.includes('writes to GitHub'),
        `the triage directive must state the dismissal side effect, got:\n${triagePrompt}`
      );
      assert.strictEqual(
        triagePrompt.includes('AGY_SUBAGENT'),
        false,
        'the triage directive must not require an environment marker'
      );
      assert.strictEqual(
        triagePrompt.includes('bin/agyloop triage <action>'),
        false,
        'the triage directive must not name the old refused command form'
      );
    });
  });

  describe('REVIEW verdict contract (issue #297)', () => {
    test('PS1: the reviewer is read-only and is told to emit, never to file', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const prompt = useCase.buildReviewerTaskPrompt({ issueNumber: 297 });

      // The read-only rules survive, and they are now unopposed.
      assert.ok(prompt.includes('Never attempt to write or edit files'));
      assert.ok(prompt.includes(ANTI_INCEPTION_GUARDRAIL));
      assert.ok(prompt.includes('the orchestrator files it'));
      assert.ok(prompt.includes(NOTE_REVIEW_VERDICT_RETURN));

      // No mutating command may appear anywhere in the payload.
      assert.strictEqual(
        /codeloop\s+review/.test(prompt),
        false,
        `the read-only reviewer must not be told to file its own verdict, got:\n${prompt}`
      );
      const named = (STATE_MUTATING_COMMANDS as readonly (string | null)[])
        .filter((command): command is string => command !== null)
        .filter((command) => new RegExp(`codeloop\\s+${command}\\b`).test(prompt));
      assert.deepStrictEqual(named, [], 'the payload must name zero mutating commands');
    });

    test('PS2: the reviewer keeps its own Tier 1 cross-check methodology', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const prompt = useCase.buildReviewerTaskPrompt({ issueNumber: 297 });

      assert.ok(prompt.includes('### Two-Tier Review Methodology:'));
      assert.ok(
        prompt.includes('Any `critical` or `error` findings mandate `REVIEW_STATUS: CHANGES_REQUESTED`')
      );
    });
  });

  describe('Discovery Subagent Container Execution & Fallback (AC6 - AC8)', () => {
    test('AC6 & AC7: injects container execution capabilities and Strict Container-Only Guardrail when container runtime/daemon is available', () => {
      const mockDetector: any = {
        resolveContainerRuntime: () => 'podman',
        resolveContainerSocket: () => ({ socketPath: 'unix:///run/user/1000/podman/podman.sock', runtime: 'podman' })
      };
      const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, undefined, mockDetector);

      const prompt = useCase.buildDiscoveryTaskPrompt({
        issueNumber: 119
      });

      assert.ok(prompt.includes('Strict Container-Only Guardrail'));
      assert.ok(prompt.includes('Command execution in Discovery can ONLY run containerized invocations (`act`, `podman run`, `docker run`)'));
      assert.ok(prompt.includes('Empirical Verification via Ephemeral Container'));
      assert.ok(prompt.includes('Use podman (`podman run`) or `act` to empirically reproduce'));
    });

    test('AC8: injects graceful fallback to static RCA code tracing when container runtime/daemon is unavailable', () => {
      const mockDetector: any = {
        resolveContainerRuntime: () => null,
        resolveContainerSocket: () => null
      };
      const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, undefined, mockDetector);

      const prompt = useCase.buildDiscoveryTaskPrompt({
        issueNumber: 119
      });

      assert.ok(prompt.includes('Empirical Verification Fallback'));
      assert.ok(prompt.includes('Container runtime/daemon is unavailable. Skip empirical smoke execution and fall back cleanly to static RCA code tracing.'));
      assert.ok(!prompt.includes('Strict Container-Only Guardrail'));
    });

    test('T8: real detector with a dead DOCKER_HOST dispatches the fallback prompt (AC-5 / Issue #232)', () => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-sub-232-'));
      const savedEnv = { DOCKER_HOST: process.env.DOCKER_HOST, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
      const originalExistsSync = fs.existsSync;
      try {
        process.env.DOCKER_HOST = `unix://${path.join(workspaceDir, 'missing.sock')}`;
        process.env.XDG_RUNTIME_DIR = path.join(workspaceDir, 'xdg');
        fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
        // Stub only the standard docker socket for host determinism; delegate everything else
        fs.existsSync = (p: any) => (String(p) === '/var/run/docker.sock' ? false : originalExistsSync(p));

        const detector = new FileBuildDetector();
        const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, undefined, detector);

        const prompt = useCase.buildDiscoveryTaskPrompt({
          issueNumber: 119,
          containerRuntime: 'docker'
        });

        assert.ok(prompt.includes('Empirical Verification Fallback'));
        assert.ok(prompt.includes('Container runtime/daemon is unavailable'));
        assert.ok(!prompt.includes('Strict Container-Only Guardrail'));
      } finally {
        fs.existsSync = originalExistsSync;
        if (savedEnv.DOCKER_HOST === undefined) delete process.env.DOCKER_HOST;
        else process.env.DOCKER_HOST = savedEnv.DOCKER_HOST;
        if (savedEnv.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = savedEnv.XDG_RUNTIME_DIR;
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });
  });
});


describe('Gate prompt evidence contract (issue #298)', () => {
  const { SmokeProtocol, HEADING_QUALITY_GATE_TARGETS, HEADING_MANUAL_SMOKE_TEST_PROTOCOL } =
    require('../../dist/domain');

  const SMOKE_PLAN = [
    '# Plan',
    '',
    '## 6. Manual Smoke Test Protocol',
    '',
    '#### Check 1 — the app starts',
    '',
    '```bash',
    'echo "S1 PASS"',
    '```',
    ''
  ].join('\n');

  function useCase(): any {
    return new ResolveSubagentUseCase(new MockConfigRepo());
  }

  test('RS-G1: the prompt states cwd, source, frozen checks and the edit ban', () => {
    const prompt = useCase().buildGateTaskPrompt({
      issueNumber: 41,
      commands: ['npm run build', 'npm run lint', 'npm test'],
      cwd: '/repo/.worktrees/41',
      commandSource: 'plan',
      commandSourceDetail: 'approved plan Quality Gate Targets from /repo/artifacts/plans/41/implementation_plan.md',
      planPath: '/repo/artifacts/plans/41/implementation_plan.md',
      requiredLint: true,
      smokeProtocol: SmokeProtocol.fromPlan(SMOKE_PLAN),
      planIntegrity: {
        status: 'verified',
        planPath: '/repo/artifacts/plans/41/implementation_plan.md',
        expectedDigest: 'abc',
        actualDigest: 'abc'
      }
    });

    assert.ok(prompt.includes('### Execution Cwd'));
    assert.ok(prompt.includes('/repo/.worktrees/41'));
    assert.match(prompt, /Do not cd to the repository root/i);
    assert.ok(prompt.includes('### Command Source'));
    assert.match(prompt, /Source:\s*plan/);
    assert.match(prompt, /explicit > plan > config > act > auto-detect > default/);
    assert.ok(prompt.includes('Do NOT edit the plan'));
    assert.ok(prompt.includes('frozen at dispatch'));
    assert.ok(prompt.includes('Check 1'));
    assert.ok(prompt.includes('plan line'));
    assert.ok(!prompt.includes('execute those steps automatically'));
    assert.match(prompt, /Command Source:\s*plan/);
    assert.match(prompt, /Smoke Protocol: PASSED \| FAILED \| NOT DECLARED/);
  });

  test('RS-G2: a required lint with no lint command is an invariant violation', () => {
    const prompt = useCase().buildGateTaskPrompt({
      issueNumber: 41,
      commands: ['npm test'],
      cwd: '/repo/.worktrees/41',
      commandSource: 'plan',
      requiredLint: true
    });

    assert.ok(prompt.includes('### Lint Invariant Violation'));
    assert.match(prompt, /MUST be FAILED/);
  });

  test('RS-G3: the planner prompt requires both exact headings and the implementer forbids edits', () => {
    const plannerPrompt = useCase().buildPlanningTaskPrompt({ issueNumber: 41 });
    assert.ok(plannerPrompt.includes(HEADING_QUALITY_GATE_TARGETS));
    assert.ok(plannerPrompt.includes(HEADING_MANUAL_SMOKE_TEST_PROTOCOL));

    const implementerPrompt = useCase().buildImplementationTaskPrompt({
      issueNumber: 41,
      planPath: '/repo/artifacts/plans/41/implementation_plan.md'
    });
    assert.ok(implementerPrompt.includes('Do not edit the approved plan'));
  });

  test('RS-G4: the gate prompt requires the GATE_REPORT_JSON evidence block and forbids running codeloop (#284)', () => {
    const prompt = useCase().buildGateTaskPrompt({
      issueNumber: 41,
      commands: ['npm test'],
      cwd: '/repo/.worktrees/41',
      commandSource: 'plan'
    });

    assert.ok(prompt.includes('### Required Evidence Output'));
    assert.ok(prompt.includes('GATE_REPORT_JSON:'));
    assert.ok(prompt.includes('"testsStatus": "PASSED (N passed)"'));
    assert.ok(prompt.includes('codeloop gate-report'));
    assert.ok(
      prompt.includes('Do not run any `codeloop` command'),
      `the read-only gate must be told not to run codeloop, got:\n${prompt}`
    );
    // The block must be the LAST thing in the response, exactly like the
    // reviewer's verdict block.
    assert.ok(prompt.indexOf('GATE_REPORT_JSON:') > prompt.indexOf('### Required Verdict Output'));
  });

  test('RS-G5: a healthy runtime with no socket selects the container guardrail (#295)', () => {
    const mockDetector: any = {
      probeContainerRuntime: () => ({ runtime: 'podman', socketPath: null, connection: 'fork-exec' }),
      resolveContainerRuntime: () => 'podman',
      resolveContainerSocket: () => null
    };
    const selection = new ResolveSubagentUseCase(
      new MockConfigRepo(),
      undefined,
      undefined,
      undefined,
      mockDetector
    );

    const prompt = selection.buildDiscoveryTaskPrompt({ issueNumber: 119 });

    assert.ok(prompt.includes('Strict Container-Only Guardrail'));
    assert.ok(prompt.includes('Use podman (`podman run`) or `act`'));
  });
});

describe('Discovery evidence contract (issue #306)', () => {
  test('T14: the discovery prompt states the same contract the predicate enforces', () => {
    const useCase = new ResolveSubagentUseCase(new MockConfigRepo());
    const prompt = useCase.buildDiscoveryTaskPrompt({ issueNumber: 306 });
    const contract = formatDiscoveryReportContract();

    assert.ok(prompt.includes(contract), 'the prompt must carry the shared contract verbatim');
    assert.ok(prompt.includes('### Evidence Contract:'), 'the contract must be labelled as such');

    // The numbers are interpolated from the exports, so the prompt and the
    // predicate cannot drift (AC4). Every published rule is asserted by the
    // phrase that carries it, not by a bare digit that could match anything.
    for (const value of [
      DISCOVERY_REPORT_MIN_CONTENT_UNITS,
      DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS,
      DISCOVERY_REPORT_MIN_CONTENT_CHARS
    ]) {
      assert.ok(contract.includes(String(value)), `the contract must state '${value}', got: ${contract}`);
    }
    for (const rule of [
      `${DISCOVERY_REPORT_MIN_CHARS} characters long`,
      `${DISCOVERY_REPORT_MIN_CONTENT_UNITS} content-bearing sections or key values`,
      `each with ${DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS}+ characters`,
      `${DISCOVERY_REPORT_MIN_CONTENT_CHARS} substantive characters`,
      `${DISCOVERY_REPORT_MIN_PROSE_SECTIONS}+ substantive \`##\` sections`,
      `${DISCOVERY_REPORT_MIN_FILLED_KEYS}+ filled key values`,
      `at most ${DISCOVERY_REPORT_MAX_UNFILLED_KEYS} template keys blank`
    ]) {
      assert.ok(contract.includes(rule), `the contract must publish '${rule}', got: ${contract}`);
    }

    // Both accepted shapes are named, so a subagent can satisfy either.
    assert.ok(prompt.includes('- **Key:**'), 'the prompt must name the bullet shape');
    assert.ok(prompt.includes('##'), 'the prompt must name the heading shape');

    // SUFFICIENCY (not just string inclusion): a document built to exactly the
    // published numbers must actually be accepted, so the contract cannot
    // understate a veto the predicate applies (the AC4 defect: the unstated
    // blank-key cap and length floor parked a document that satisfied every
    // sentence the prompt published).
    const perUnit = DISCOVERY_REPORT_MIN_CONTENT_CHARS / DISCOVERY_REPORT_MIN_CONTENT_UNITS;
    const value = (label: string): string => `${label} `.padEnd(perUnit, 'x');
    const publishedNumbers = [
      '# [Discovery] - contract probe',
      '',
      `- **Observed Behavior:** ${value('the login form crashes without a session cookie')}`,
      `- **Identified Failure Mode:** ${value('the session resolver result is dereferenced unguarded')}`,
      `- **Recommended Fix Approach:** ${value('guard the resolver and add a regression test')}`,
      ''
    ].join('\n');
    assert.ok(
      publishedNumbers.length >= DISCOVERY_REPORT_MIN_CHARS,
      'fixture sanity: the contract-minimum document must clear the length floor'
    );
    const published = DiscoveryReport.fromMarkdown(publishedNumbers);
    assert.strictEqual(published.contentUnitCount, DISCOVERY_REPORT_MIN_CONTENT_UNITS);
    assert.ok(published.contentCharCount >= DISCOVERY_REPORT_MIN_CONTENT_CHARS);
    assert.deepStrictEqual(published.unfilledPlaceholderKeys, []);
    assert.strictEqual(
      published.isPopulated,
      true,
      'a report satisfying every published number must be accepted by the predicate'
    );
  });
});
