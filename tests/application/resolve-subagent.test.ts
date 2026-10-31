/**
 * agyloop - ResolveSubagentUseCase Unit Tests
 *
 * Tests for critique path resolution and two-tier reviewer prompt generation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

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
  formatDiscoveryReportContract,
  GATE_COMMAND_WORKTREE_CONTRACT,
  WORKTREE_GUARD_SIGNAL,
  ENV_NODE_TEST_CONTEXT,
  ENV_NODE_ENV,
  ENV_NODE_VALUE_TEST,
  ENV_ALLOW_WORKTREE_ISSUE_MISMATCH,
  NOTE_WORKTREE_GUARD_ESCAPE_HATCH,
  NOTE_SMOKE_FIXTURE_ISSUE_RULE,
  SmokeProtocol
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
    assert.ok(prompt.includes("'/opt/custom/bin/critique' --json"));
    assert.ok(!prompt.includes('export PATH='), 'AC4: no PATH export may be rendered');
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

    assert.ok(prompt.includes("'/home/user/.local/share/agyloop/tools/critique' --json"));
    assert.ok(!prompt.includes('export PATH='), 'AC4: no PATH export may be rendered');
  });

  test('resolves critique path from injected CritiquePort', () => {
    const critiquePort = new MockCritiquePort({
      source: RESOLVER_SOURCE_USER_DATA,
      path: '/usr/bin/critique',
      isAvailable: true
    });

    const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, critiquePort);
    const prompt = useCase.buildReviewerTaskPrompt();

    assert.ok(prompt.includes("'/usr/bin/critique' --json"));
    assert.ok(!prompt.includes('export PATH='), 'AC4: no PATH export may be rendered');
  });

  test('names the resolver, not a hardcoded path, when critique is unresolvable (issue #314)', () => {
    const critiquePort = new MockCritiquePort({
      source: RESOLVER_SOURCE_NONE,
      path: null,
      isAvailable: false
    });

    const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, critiquePort);
    const prompt = useCase.buildReviewerTaskPrompt();

    assert.ok(prompt.includes('codeloop critique status'), 'AC2: the fallback must name the resolver');
    assert.ok(
      prompt.includes('~/.local/share/critique'),
      'AC2: the fallback must name the real search locations'
    );
    assert.ok(
      !prompt.includes('~/.local/bin/critique --json'),
      'AC3: the fallback must not quote the dead path as the command'
    );
    assert.ok(!prompt.includes('export PATH='), 'AC4: no PATH export');
    assert.ok(prompt.includes('Any `critical` or `error` findings mandate `REVIEW_STATUS: CHANGES_REQUESTED`'));
  });

  test('runs a resolved .js critique binary through node (issue #314)', () => {
    const critiquePort = new MockCritiquePort({
      source: RESOLVER_SOURCE_USER_DATA,
      path: '/home/user/.local/share/critique/bin/critique.js',
      isAvailable: true
    });

    const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, critiquePort);
    const prompt = useCase.buildReviewerTaskPrompt();

    assert.ok(
      prompt.includes("node '/home/user/.local/share/critique/bin/critique.js' --json"),
      `AC3: a resolved .js binary must render through node, got:\n${prompt.slice(0, 2000)}`
    );
    assert.ok(!prompt.includes('export PATH='), 'AC4: no PATH export');
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

  /**
   * Issue #356, Defect 2: `git diff <base>` cannot see an untracked file, so the
   * reviewer's ONLY inspection command printed nothing for a change whose
   * load-bearing part was a NEW file. The dispatch now hands the reviewer the
   * probe's measured `untrackedFiles`, each with a command that prints its FULL
   * content — without staging anything.
   */
  describe('Untracked implementation files (issue #356)', () => {
    const HEADING = '### Untracked Implementation Files';

    test('UT1: names an untracked file and gives a command that prints its full content', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const prompt = useCase.buildReviewerTaskPrompt({
        issueNumber: 356,
        baseBranch: 'main',
        untrackedFiles: ['.github/actionlint.yaml']
      });

      assert.ok(prompt.includes(`${HEADING} (invisible to \`git diff\`):`), 'the heading must render');
      assert.ok(prompt.includes('.github/actionlint.yaml'), 'the untracked path must be named');
      assert.ok(
        prompt.includes("git diff --no-index -- /dev/null '.github/actionlint.yaml' || true"),
        `the content command must render, got:\n${prompt}`
      );
      assert.ok(prompt.includes('READ-ONLY evidence'), 'the reviewer must be told it is read-only');
      assert.strictEqual(prompt.includes('git add'), false, 'the prompt must not name a staging command');
      assert.strictEqual(prompt.includes('git stash'), false, 'the prompt must not name a stash command');
    });

    test('UT2: a collapsed untracked directory expands via ls-files instead of --no-index', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      // `git status --porcelain` collapses a wholly-untracked directory to
      // `?? src/newdir/`, and `git diff --no-index /dev/null src/newdir/` fails
      // with "Could not access 'src/newdir//null'".
      const prompt = useCase.buildReviewerTaskPrompt({
        issueNumber: 356,
        baseBranch: 'main',
        untrackedFiles: ['src/newdir/']
      });

      assert.ok(
        prompt.includes(
          "git ls-files --others --exclude-standard -- 'src/newdir/' | while IFS= read -r f; do"
        ),
        `the directory entry must expand, got:\n${prompt}`
      );
      assert.ok(prompt.includes('cat -- "$f"'), 'the directory command must print file content');
      assert.ok(
        !prompt.includes("--no-index -- /dev/null 'src/newdir/'"),
        'a directory must never be handed to git diff --no-index'
      );
    });

    test('UT3: a path containing a space is shell-quoted', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const prompt = useCase.buildReviewerTaskPrompt({
        issueNumber: 356,
        baseBranch: 'main',
        untrackedFiles: ['docs/my note.md']
      });

      assert.ok(
        prompt.includes("git diff --no-index -- /dev/null 'docs/my note.md' || true"),
        `a space-containing path must be one quoted word, got:\n${prompt}`
      );
    });

    test('UT4: an embedded single quote is escaped by shellQuote, not naively interpolated', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const prompt = useCase.buildReviewerTaskPrompt({
        issueNumber: 356,
        baseBranch: 'main',
        untrackedFiles: ["docs/it's a note.md"]
      });

      assert.ok(
        prompt.includes("git diff --no-index -- /dev/null 'docs/it'\\''s a note.md' || true"),
        `the embedded quote must be escaped, got:\n${prompt}`
      );
    });

    test('UT5: a tracked-only change keeps the prompt byte-identical', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const baseline = useCase.buildReviewerTaskPrompt({ issueNumber: 356, baseBranch: 'main' });

      const variants = [
        useCase.buildReviewerTaskPrompt({
          issueNumber: 356,
          baseBranch: 'main',
          untrackedFiles: undefined
        }),
        useCase.buildReviewerTaskPrompt({
          issueNumber: 356,
          baseBranch: 'main',
          untrackedFiles: null
        }),
        useCase.buildReviewerTaskPrompt({
          issueNumber: 356,
          baseBranch: 'main',
          untrackedFiles: []
        })
      ];

      for (const variant of variants) {
        assert.strictEqual(variant, baseline, 'an empty untracked list must render nothing');
        assert.strictEqual(variant.includes(HEADING), false);
      }
    });

    test('UT6: the >1,000-line branch renders the untracked section too', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const largeDiff = [
        'diff --git a/src/heavy.ts b/src/heavy.ts',
        '--- a/src/heavy.ts',
        '+++ b/src/heavy.ts',
        '@@ -1,1 +1,1500 @@'
      ]
        .concat(Array.from({ length: 1500 }, (_, i) => `+const line_${i} = ${i};`))
        .join('\n');

      const prompt = useCase.buildReviewerTaskPrompt({
        issueNumber: 356,
        baseBranch: 'main',
        workingDiff: largeDiff,
        untrackedFiles: ['.github/actionlint.yaml']
      });

      assert.ok(prompt.includes('Working diff exceeds 1,000 lines'));
      assert.ok(prompt.includes(HEADING), 'the omitted-diff branch must still name untracked files');
      assert.ok(
        prompt.includes("git diff --no-index -- /dev/null '.github/actionlint.yaml' || true"),
        'the omitted-diff branch must carry the content command'
      );
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

    test('PS3: a named Tier 1 evidence path is staged and published only on success (issue #397/#400)', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const reportPath = '/repo/.agyloop/critique/397.json';
      const prompt = useCase.buildReviewerTaskPrompt({
        issueNumber: 397,
        critiquePath: '/opt/custom/bin/critique',
        critiqueReportPath: reportPath
      });

      assert.ok(prompt.includes(reportPath), 'the prompt must name the exact evidence path');
      assert.ok(prompt.includes('mkdir -p'), 'the Tier 1 command must create the evidence directory');
      // Issue #400: the command stages beside the report, publishes with `mv`
      // only after critique succeeds, and echoes the report for Tier 1 reading.
      assert.ok(
        prompt.includes('.critique-report.$$.tmp'),
        `the Tier 1 command must stage to a transient sibling, got:\n${prompt}`
      );
      assert.ok(
        prompt.includes(`mv "$tmp" '${reportPath}'`),
        `the report must be published by mv, got:\n${prompt}`
      );
      assert.ok(
        prompt.includes(`cat '${reportPath}'`),
        `the published report must still be readable by the reviewer, got:\n${prompt}`
      );
      assert.ok(
        prompt.includes('exit $code'),
        `the Tier 1 command must propagate critique's exit code, got:\n${prompt}`
      );
      assert.strictEqual(
        prompt.includes('| tee'),
        false,
        `a pipeline reports tee's status, not critique's, got:\n${prompt}`
      );
      assert.ok(prompt.includes('exits non-zero'), 'the return note must key omission on the exit status');
      assert.ok(prompt.includes('CRITIQUE_REPORT:'), 'the prompt must require the return line');
      assert.ok(
        prompt.includes('The ONE write this review permits is the Tier 1 evidence file'),
        'the carve-out must name the evidence file as the only permitted write'
      );
      assert.strictEqual(
        /codeloop\s+review/.test(prompt),
        false,
        'the read-only reviewer must not be told to file its own verdict'
      );
    });

    test('PS4: without a report path the prompt stays byte-identical to the pre-#397 wording', () => {
      const useCase = new ResolveSubagentUseCase(configRepo);
      const prompt = useCase.buildReviewerTaskPrompt({
        issueNumber: 397,
        critiquePath: '/opt/custom/bin/critique'
      });

      assert.strictEqual(prompt.includes('CRITIQUE_REPORT:'), false);
      assert.strictEqual(prompt.includes('tee '), false);
      assert.ok(prompt.includes('Never attempt to write or edit files'));
      assert.ok(prompt.includes(NOTE_REVIEW_VERDICT_RETURN));
    });

    test('PS5: the rendered Tier 1 command propagates a critique failure and publishes no report (issue #400)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-tier1-'));
      try {
        const critiqueStub = path.join(dir, 'critique-stub.js');
        const reportPath = path.join(dir, 'critique', '397.json');
        const prompt = new ResolveSubagentUseCase(configRepo).buildReviewerTaskPrompt({
          issueNumber: 400,
          critiquePath: critiqueStub,
          critiqueReportPath: reportPath
        });
        const fence = /```bash\n([\s\S]*?)\n\s*```/.exec(prompt);
        assert.ok(fence, `the reviewer prompt must carry a Tier 1 bash fence, got:\n${prompt}`);
        const command = fence![1].trim();
        assert.strictEqual(command.includes('| tee'), false, `still a tee pipeline:\n${command}`);

        const runStub = (body: string) => {
          fs.writeFileSync(critiqueStub, body, 'utf8');
          return spawnSync('sh', ['-c', command], { encoding: 'utf8' });
        };
        const stagingDebris = (): string[] =>
          fs.existsSync(path.dirname(reportPath))
            ? fs.readdirSync(path.dirname(reportPath)).filter((name: string) => name.includes('.tmp'))
            : [];

        // Clean run: exit 0, a parseable report on disk, and JSON on stdout.
        const clean = runStub(`process.stdout.write('{"summary":"ok","comments":[]}');`);
        assert.strictEqual(clean.status, 0, clean.stderr);
        assert.ok(fs.existsSync(reportPath), 'a successful Tier 1 must publish the report');
        assert.strictEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')).summary, 'ok');
        assert.ok(clean.stdout.includes('"summary":"ok"'), clean.stdout);
        assert.deepStrictEqual(stagingDebris(), [], 'no staging file may survive success');

        // Crash before any output: critique's exit code must survive, nothing published.
        fs.rmSync(reportPath, { force: true });
        const crash = runStub('process.exit(2);');
        assert.strictEqual(crash.status, 2, crash.stderr);
        assert.strictEqual(fs.existsSync(reportPath), false, 'a crash must publish nothing');
        assert.ok(crash.stderr.includes('critique failed (exit 2)'), crash.stderr);
        assert.deepStrictEqual(stagingDebris(), [], 'no staging file may survive a crash');

        // Partial output then crash: the truncated payload must never be published.
        const partial = runStub(`process.stdout.write('{"findings":['); process.exit(2);`);
        assert.strictEqual(partial.status, 2, partial.stderr);
        assert.strictEqual(fs.existsSync(reportPath), false, 'a partial payload must publish nothing');

        // Silent success: an empty file is not evidence.
        const silent = runStub('process.exit(0);');
        assert.strictEqual(silent.status, 1, silent.stderr);
        assert.strictEqual(fs.existsSync(reportPath), false, 'an empty run must publish nothing');
        assert.ok(silent.stderr.includes('wrote no evidence'), silent.stderr);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    const renderTierOneCommand = (reportPath: string, critiquePath: string): string => {
      const prompt = new ResolveSubagentUseCase(configRepo).buildReviewerTaskPrompt({
        issueNumber: 405,
        critiquePath,
        critiqueReportPath: reportPath
      });
      const fence = /```bash\n([\s\S]*?)\n\s*```/.exec(prompt);
      assert.ok(fence, `the reviewer prompt must carry a Tier 1 bash fence, got:\n${prompt}`);
      return fence![1].trim();
    };

    test('PS6: a pre-existing report is cleared before critique, so a crashed round leaves no evidence (issue #405, D2)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-tier1-'));
      try {
        const critiqueStub = path.join(dir, 'critique-stub.js');
        const reportPath = path.join(dir, 'critique', '405.json');
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, '{"round":1,"summary":"STALE_ROUND_1"}', 'utf8');

        const command = renderTierOneCommand(reportPath, critiqueStub);
        const clearIndex = command.indexOf(`rm -f '${reportPath}'`);
        assert.ok(clearIndex !== -1, `the destination must be cleared, got:\n${command}`);
        assert.ok(clearIndex < command.indexOf(critiqueStub), 'the clear must precede the critique invocation');

        fs.writeFileSync(critiqueStub, 'process.exit(2);', 'utf8');
        const crashed = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
        assert.strictEqual(crashed.status, 2, crashed.stderr);
        assert.strictEqual(
          fs.existsSync(reportPath),
          false,
          'a crashed round must not leave round 1 evidence at the named path'
        );
        assert.ok(crashed.stderr.includes('critique failed (exit 2)'), crashed.stderr);
        const debris = fs
          .readdirSync(path.dirname(reportPath))
          .filter((name: string) => name.endsWith('.tmp'));
        assert.deepStrictEqual(debris, [], 'no staging file may survive a crash');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('PS7: a failed publish removes the staging sibling (issue #405, D3)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-tier1-'));
      try {
        const critiqueStub = path.join(dir, 'critique-stub.js');
        const reportPath = path.join(dir, 'critique', '405.json');
        const command = renderTierOneCommand(reportPath, critiqueStub);
        assert.ok(
          command.includes(`if ! mv "$tmp" '${reportPath}'; then`),
          `the publish must have an explicit failure branch, got:\n${command}`
        );

        // A PATH-shadowed mv is deterministic and works when the suite runs as
        // root; permission tricks on the destination do not.
        const binDir = path.join(dir, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        fs.writeFileSync(
          critiqueStub,
          `process.stdout.write('{"summary":"fresh","comments":[]}');`,
          'utf8'
        );

        const failed = spawnSync('sh', ['-c', command], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` }
        });
        assert.notStrictEqual(failed.status, 0, 'a failed publish must exit non-zero');
        assert.ok(failed.stderr.includes('publish failed; no report written'), failed.stderr);
        assert.strictEqual(fs.existsSync(reportPath), false, 'a failed publish must publish nothing');
        const debris = fs.existsSync(path.dirname(reportPath))
          ? fs.readdirSync(path.dirname(reportPath)).filter((name: string) => name.endsWith('.tmp'))
          : [];
        assert.deepStrictEqual(debris, [], 'a failed publish must remove its staging sibling');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Discovery Subagent Container Execution & Fallback (AC6 - AC8)', () => {
    test('AC6 & AC7: injects the mutation boundary and a runnable container recipe when container runtime/daemon is available', () => {
      const mockDetector: any = {
        resolveContainerRuntime: () => 'podman',
        resolveContainerSocket: () => ({ socketPath: 'unix:///run/user/1000/podman/podman.sock', runtime: 'podman' })
      };
      const useCase = new ResolveSubagentUseCase(configRepo, undefined, undefined, undefined, mockDetector);

      const prompt = useCase.buildDiscoveryTaskPrompt({
        issueNumber: 119
      });

      // Issue #389: the boundary is MUTATION, not containment — a host-run
      // harness cannot satisfy "container-only" and "reproduce empirically" at
      // the same time, so the mandate became a boundary plus an offer.
      assert.ok(prompt.includes('**Mutation Boundary**'));
      assert.ok(prompt.includes('every WRITE must land inside'));
      assert.ok(prompt.includes('Never rebuild the repository root'));
      assert.ok(prompt.includes('the root build is what the installed `codeloop` executes'));
      assert.ok(prompt.includes('**Container-Preferred Empirical Verification**'));
      assert.ok(prompt.includes('docker.io/library/node:24-bookworm-slim'));
      assert.ok(prompt.includes('-v "$PWD":/repo:ro'));
      assert.ok(prompt.includes('podman run --rm --network=none'));
      assert.ok(
        prompt.includes(
          'If the runtime is unreachable when you run it, fall back to host reads plus static RCA and record why in the report.'
        )
      );
      assert.strictEqual(prompt.includes('can ONLY run containerized invocations'), false);
      assert.strictEqual(prompt.includes('Strict Container-Only Guardrail'), false);
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

describe('State-guard escape hatch parity (issue #405, D1)', () => {
  const configRepo = new MockConfigRepo();
  const WORKTREE = '/repo/.worktrees/405';

  const signalOf = (text: string): string => {
    const match = /tool-owned `([^`]+)`/.exec(text);
    assert.ok(match, `the dispatch must name the state-guard escape hatch, got:\n${text}`);
    return match![1];
  };

  test('PS8: IMPLEMENT and QUALITY_GATE name the SAME guard signal from one shared note', () => {
    const useCase = new ResolveSubagentUseCase(configRepo);
    const implementer = useCase.buildImplementationTaskPrompt({
      issueNumber: 405,
      workspaceDir: WORKTREE
    });
    const gate = useCase.buildGateTaskPrompt({ issueNumber: 405, cwd: WORKTREE });

    assert.strictEqual(WORKTREE_GUARD_SIGNAL, ENV_ALLOW_WORKTREE_ISSUE_MISMATCH);
    assert.notStrictEqual(WORKTREE_GUARD_SIGNAL, ENV_NODE_TEST_CONTEXT);
    assert.strictEqual(signalOf(implementer), WORKTREE_GUARD_SIGNAL);
    assert.strictEqual(signalOf(gate), WORKTREE_GUARD_SIGNAL);
    assert.ok(implementer.includes(NOTE_WORKTREE_GUARD_ESCAPE_HATCH), implementer);
    assert.ok(gate.includes(NOTE_WORKTREE_GUARD_ESCAPE_HATCH), gate);
    assert.strictEqual(
      implementer.includes(ENV_NODE_TEST_CONTEXT),
      false,
      'the implementer must not advertise the Node runner marker'
    );
    assert.strictEqual(
      gate.includes(ENV_NODE_TEST_CONTEXT),
      false,
      'the gate must not advertise the Node runner marker'
    );
    assert.ok(
      implementer.indexOf(NOTE_WORKTREE_GUARD_ESCAPE_HATCH) <
        implementer.indexOf('### Manual Smoke Test Protocol'),
      'the guard note must precede the frozen protocol'
    );
    assert.strictEqual(
      implementer.includes(`${ENV_NODE_ENV}=${ENV_NODE_VALUE_TEST}`),
      false,
      'the implementer must not name a second hatch'
    );
  });

  test('PS9: the planner states the fixture-issue override in the check itself', () => {
    const planner = new ResolveSubagentUseCase(configRepo).buildPlanningTaskPrompt({ issueNumber: 405 });
    assert.ok(planner.includes(NOTE_SMOKE_FIXTURE_ISSUE_RULE), planner);
    assert.ok(planner.includes('fixture issue number other than the worktree'), planner);
    assert.ok(planner.includes(`${WORKTREE_GUARD_SIGNAL}=1`), planner);
    assert.strictEqual(planner.includes(ENV_NODE_TEST_CONTEXT), false);
  });

  test('PS10: the static smoke validator accepts the documented override (no new rule)', () => {
    const plan = [
      '### Manual Smoke Test Protocol',
      '',
      '```bash',
      `${WORKTREE_GUARD_SIGNAL}=1 node -e 'console.log("fixture 9405")'`,
      '```',
      ''
    ].join('\n');
    const protocol = SmokeProtocol.fromPlan(plan);
    assert.strictEqual(protocol.declared, true);
    assert.strictEqual(protocol.executable, true, JSON.stringify(protocol.findings));
    assert.deepStrictEqual(protocol.findings, []);
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
    assert.match(prompt, /Smoke Protocol: PASSED \| FAILED \| NOT_DECLARED/);
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

  test('RS-G3a (#348): the gate prompt states the dirty-worktree gate-command contract', () => {
    const prompt = useCase().buildGateTaskPrompt({
      issueNumber: 41,
      commands: ['npm test'],
      cwd: '/repo/.worktrees/348'
    });

    assert.ok(prompt.includes(GATE_COMMAND_WORKTREE_CONTRACT));
    assert.ok(prompt.includes('UNCOMMITTED'));
    assert.ok(prompt.includes('before the commit gate'));
    assert.ok(prompt.includes('No synthetic commit'));
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

  test('RS-G5: a healthy runtime with no socket selects the container recipe (#295)', () => {
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

    // #295's rule survives: a working fork-exec runtime is still detected and
    // still yields the explicit recipe. Only the MANDATE (#389) is gone.
    assert.ok(prompt.includes('**Mutation Boundary**'));
    assert.ok(prompt.includes('podman run --rm --network=none'));
    assert.ok(prompt.includes('docker.io/library/node:24-bookworm-slim'));
  });

  test('RS-G6: the planner prompt names the sandbox path for AUTHORED smoke blocks (#359)', () => {
    const prompt = useCase().buildPlanningTaskPrompt({
      issueNumber: 359,
      planDir: 'artifacts/plans/359/',
      planPath: 'artifacts/plans/359/implementation_plan.md'
    });
    // The requirement lives in the TASK prompt (dispatch payload), not only in
    // the self-directed system-prompt mandate.
    assert.ok(prompt.includes('.cache/agyloop/smoke-'), 'the required sandbox path must be named');
    assert.ok(prompt.includes('mktemp'), 'the refusal rule must name mktemp');
    assert.ok(prompt.includes('rejected at dispatch'), 'the consequence must be stated');
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

describe('Gate prompt → parser vocabulary contract (issue #311)', () => {
  const {
    GateResultReport,
    GATE_REPORT_JSON_MARKER,
    SMOKE_PROTOCOL_VALUES,
    SMOKE_PROTOCOL_VOCABULARY,
    SMOKE_PROTOCOL_NOT_DECLARED,
    SmokeProtocol
  } = require('../../dist/domain');

  const CONTRACT_SMOKE_PLAN = [
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

  function gatePrompt(params: any = {}): string {
    return new ResolveSubagentUseCase(new MockConfigRepo()).buildGateTaskPrompt({
      issueNumber: 311,
      commands: ['npm test'],
      cwd: '/repo/.worktrees/311',
      ...params
    });
  }

  function emittedExample(prompt: string): string {
    const marker = prompt.lastIndexOf(GATE_REPORT_JSON_MARKER);
    assert.ok(marker >= 0, 'the gate prompt must emit a GATE_REPORT_JSON example');
    return prompt.slice(marker);
  }

  test('#311 P1: a no-protocol plan emits an example the parser accepts as NOT_DECLARED', () => {
    const prompt = gatePrompt();
    const example = emittedExample(prompt);

    const report = GateResultReport.parseBlock(example, 1);
    assert.strictEqual(report.smokeProtocol, SMOKE_PROTOCOL_NOT_DECLARED);

    assert.ok(
      prompt.includes(`Report \`${SMOKE_PROTOCOL_NOT_DECLARED}\` for it`),
      'the prose must name the canonical wire token'
    );
    assert.ok(
      !prompt.includes('NOT DECLARED'),
      'the prompt must never emit the spaced spelling the parser used to reject'
    );
    assert.ok(
      prompt.includes(`- Smoke Protocol: ${SMOKE_PROTOCOL_VOCABULARY}`),
      'the verdict list must be the parser vocabulary'
    );
  });

  test('#311 P2: a declared protocol emits an example the parser accepts as PASSED', () => {
    const prompt = gatePrompt({ smokeProtocol: SmokeProtocol.fromPlan(CONTRACT_SMOKE_PLAN) });
    const report = GateResultReport.parseBlock(emittedExample(prompt), 1);
    assert.strictEqual(report.smokeProtocol, 'PASSED');
  });

  test('#311 P3: the example token and the verdict list come from one vocabulary', () => {
    for (const params of [{}, { smokeProtocol: SmokeProtocol.fromPlan(CONTRACT_SMOKE_PLAN) }]) {
      const prompt = gatePrompt(params);
      const report = GateResultReport.parseBlock(emittedExample(prompt), 1);
      assert.ok(
        SMOKE_PROTOCOL_VALUES.includes(report.smokeProtocol),
        `the example token ${report.smokeProtocol} must be a vocabulary member`
      );
      const verdictLine =
        prompt
          .split('\n')
          .find((line: string) => line.startsWith('- Smoke Protocol: ')) ?? '';
      assert.ok(verdictLine.length > 0, 'the prompt must carry the verdict line');
      assert.ok(verdictLine.endsWith(SMOKE_PROTOCOL_VOCABULARY));
    }
  });

  /**
   * The published evidence shapes (#338, absorbing #343).
   *
   * The prompt is the contract: a gate that follows it must emit exactly what
   * `GateResultReport.parseBlock` files. These cases assert the literals the
   * gate is shown, in BOTH smoke-protocol branches, and then parse the very
   * prompt text — so the example and the parser cannot drift apart again.
   */
  const SMOKE_CHECKS_SHAPE =
    '"smokeChecks": [{ "id": "<check-id>", "label": "<check label>", "passed": true }]';
  const NOT_RUN_SHAPE =
    '"notRun": [{ "id": "<gate-id>", "label": "<gate label>", "reason": "<why it did not run>" }]';

  function fillPromptExample(example: string): string {
    return example
      .replaceAll('<id>', 'node')
      .replaceAll('<command>', 'npm test')
      .replaceAll('<check-id>', 'check-1')
      .replaceAll('<check label>', 'app boots')
      .replaceAll('<gate-id>', 'e2e')
      .replaceAll('<gate label>', 'e2e suite')
      .replaceAll('<why it did not run>', 'no fixtures');
  }

  test('#338 T2.1: the prompt example publishes both object shapes', () => {
    const prompt = gatePrompt({ smokeProtocol: SmokeProtocol.fromPlan(CONTRACT_SMOKE_PLAN) });
    assert.ok(prompt.includes(SMOKE_CHECKS_SHAPE), 'the example must show the smokeChecks shape');
    assert.ok(prompt.includes(NOT_RUN_SHAPE), 'the example must show the notRun shape');
  });

  test('#338 T2.2: the prose names the accepted types', () => {
    const prompt = gatePrompt({ smokeProtocol: SmokeProtocol.fromPlan(CONTRACT_SMOKE_PLAN) });
    for (const token of [
      'BOOLEAN or `null`',
      '"PASSED" is rejected',
      'defaults to `id`',
      'never collapsed into `true`',
      'array of bare strings is rejected'
    ]) {
      assert.ok(prompt.includes(token), `the prompt is missing: ${token}`);
    }
  });

  test('#338 T2.3: the no-protocol branch publishes the shapes too', () => {
    const smokeEntryShape = `{ "id": "<check-id>", "label": "<check label>", "passed": true }`;
    const notRunEntryShape = `{ "id": "<gate-id>", "label": "<gate label>", "reason": "<why it did not run>" }`;
    for (const params of [{}, { smokeProtocol: SmokeProtocol.fromPlan(CONTRACT_SMOKE_PLAN) }]) {
      const prompt = gatePrompt(params);
      assert.ok(prompt.includes(smokeEntryShape), 'the smokeChecks shape is never optional');
      assert.ok(prompt.includes(notRunEntryShape), 'the notRun shape is never optional');
      assert.ok(
        !prompt.includes('NOT DECLARED'),
        'the prompt must never emit the spaced spelling the parser used to reject'
      );
    }
  });

  test('#338 T2.4: the emitted example parses through the parser', () => {
    for (const params of [{}, { smokeProtocol: SmokeProtocol.fromPlan(CONTRACT_SMOKE_PLAN) }]) {
      const report = GateResultReport.parseBlock(
        fillPromptExample(emittedExample(gatePrompt(params))),
        1
      );
      const expectedChecks = params.smokeProtocol ? 1 : 0;
      assert.strictEqual(report.smokeChecks.length, expectedChecks);
      if (expectedChecks > 0) {
        assert.strictEqual(report.smokeChecks[0].passed, true);
      }
      assert.strictEqual(report.notRun.length, 1);
      assert.strictEqual(report.notRun[0].reason, 'no fixtures');
    }
  });
});
