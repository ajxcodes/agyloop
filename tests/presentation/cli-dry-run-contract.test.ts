/**
 * agyloop - `--dry-run` forwarding contract (#248 Wave 2)
 *
 * Every command that accepts `--dry-run` must MUTATE NOTHING. Each case is
 * asserted twice:
 *
 *   1. the FILESYSTEM contract — the `.agyloop` tree (or the worktree
 *      directory) is byte-identical afterwards;
 *   2. the OUTPUT contract — the success line carries `[dry-run] ` and never a
 *      bare `✓`.
 *
 * Negative controls (the same command without `--dry-run`) are included so a
 * no-op implementation cannot pass.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const SEEDED_AT = '2026-10-01T00:00:00.000Z';

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    currentStage: 'PLAN',
    mode: 'standard',
    issue: null,
    milestoneTitle: null,
    baseBranch: 'main',
    worktree: null,
    planDir: null,
    triagePayload: null,
    triageDisposition: null,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    history: [{ stage: 'PLAN', timestamp: SEEDED_AT }],
    pausedAtGate: null,
    pausedAtTimestamp: null,
    totalHumanWaitMs: 0,
    planRevisionCount: 0,
    implementToGateLoops: 0,
    reviewDispatchCount: 0,
    ...overrides
  };
}

function seedRoot(dir: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agyloop', 'state.json'), JSON.stringify(snapshot(overrides)));
}

function seedTask(dir: string, issue: number, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'tasks', `${issue}.json`),
    JSON.stringify(snapshot({ issue, ...overrides }))
  );
}

function treeHash(root: string): string {
  if (!fs.existsSync(root)) return 'absent';
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(root, full);
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        lines.push(`${rel} ${digest}`);
      }
    }
  };
  walk(root);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function initGitWorkspace(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
}

async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void,
  inspect?: (dir: string) => void
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-dryrun-'));
  let stdout = '';
  let stderr = '';

  try {
    seed?.(tempDir);
    process.chdir(tempDir);
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    const code = await runCli(args);
    inspect?.(tempDir);
    return { code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('reset --dry-run (#248 AC-248.1/2)', () => {
  test('task scope clears nothing and leaves the tree byte-identical', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['reset', '--issue', '888', '--dry-run'],
      (dir) => {
        seedRoot(dir);
        seedTask(dir, 888);
        before = treeHash(path.join(dir, '.agyloop'));
      },
      (dir) => {
        after = treeHash(path.join(dir, '.agyloop'));
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Would clear the checkpoint for issue #888/);
    assert.ok(!result.stdout.includes('✓'), result.stdout);
    assert.strictEqual(after, before);
  });

  test('task scope with no checkpoint predicts the real exit code (1)', async () => {
    const result = await runCliInSandbox(['reset', '--issue', '888', '--dry-run'], seedRoot);
    assert.strictEqual(result.code, 1);
    assert.match(result.stderr, /\[dry-run\] Nothing to clear for issue #888/);
  });

  test('root scope clears nothing (negative control: the real reset deletes it)', async () => {
    let stateAfterDryRunExists = true;
    const dry = await runCliInSandbox(
      ['reset', '--dry-run'],
      seedRoot,
      (dir) => {
        stateAfterDryRunExists = fs.existsSync(path.join(dir, '.agyloop', 'state.json'));
      }
    );
    assert.strictEqual(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /\[dry-run\] Would clear/);
    assert.ok(stateAfterDryRunExists, 'the root checkpoint must survive a dry run');

    let stateAfterRealExists = true;
    const real = await runCliInSandbox(
      ['reset'],
      seedRoot,
      (dir) => {
        stateAfterRealExists = fs.existsSync(path.join(dir, '.agyloop', 'state.json'));
      }
    );
    assert.strictEqual(real.code, 0, real.stderr);
    assert.ok(!stateAfterRealExists, 'the real reset must delete the root checkpoint');
  });

  test('--all purges nothing', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['reset', '--all', '--dry-run'],
      (dir) => {
        seedRoot(dir);
        seedTask(dir, 1);
        seedTask(dir, 2);
        before = treeHash(path.join(dir, '.agyloop'));
      },
      (dir) => {
        after = treeHash(path.join(dir, '.agyloop'));
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Would purge \.agyloop\/state\.json and all task checkpoints\./);
    assert.strictEqual(after, before);
  });
});

describe('sync --dry-run (#248 AC-248.3)', () => {
  test('performs no fetch and prints a proposal', async () => {
    let fetchHeadExists = true;
    const result = await runCliInSandbox(
      ['sync', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
        seedRoot(dir, { currentStage: 'IMPLEMENT' });
      },
      (dir) => {
        fetchHeadExists = fs.existsSync(path.join(dir, '.git', 'FETCH_HEAD'));
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Would fetch origin/);
    assert.ok(!result.stdout.includes('✓ Successfully synced'), result.stdout);
    assert.strictEqual(fetchHeadExists, false, 'a dry run must not run git fetch');
  });
});

describe('abort --dry-run (#248 AC-248.4)', () => {
  test('terminates nothing, clears no lock, and never claims completion', async () => {
    let lockStillExists = false;
    const result = await runCliInSandbox(
      ['abort', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
        seedRoot(dir, { currentStage: 'IMPLEMENT' });
        fs.writeFileSync(path.join(dir, '.git', 'index.lock'), 'seed');
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty\n');
      },
      (dir) => {
        lockStillExists = fs.existsSync(path.join(dir, '.git', 'index.lock'));
        assert.strictEqual(fs.readFileSync(path.join(dir, 'dirty.txt'), 'utf8'), 'dirty\n');
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Emergency abort simulated/);
    assert.ok(!result.stdout.includes('✓ Emergency Abort completed'), result.stdout);
    assert.ok(lockStillExists, 'the seeded .git/index.lock must survive');
  });
});

describe('triage --dry-run (#248 AC-248.5)', () => {
  test('does not transition the checkpoint and creates no worktree', async () => {
    let hashBefore = '';
    let hashAfter = '';
    let worktreeExists = true;
    const result = await runCliInSandbox(
      ['triage', 'implement', '--issue', '901', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
        seedTask(dir, 901, { currentStage: 'TRIAGE', mode: 'standard' });
        hashBefore = treeHash(path.join(dir, '.agyloop'));
      },
      (dir) => {
        hashAfter = treeHash(path.join(dir, '.agyloop'));
        worktreeExists = fs.existsSync(path.join(dir, '.worktrees', '901'));
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Triage Action : IMPLEMENT/);
    assert.match(result.stdout, /\[dry-run\] Would transition to .*IMPLEMENT/);
    assert.match(result.stdout, /\[dry-run\] Nothing was written\./);
    assert.ok(!result.stdout.includes('✓ State Updated'), result.stdout);
    assert.strictEqual(hashAfter, hashBefore, 'the TRIAGE checkpoint must be byte-identical');
    assert.strictEqual(worktreeExists, false, 'a dry run must not provision a worktree');
  });
});

describe('worktree --dry-run (#248 AC-248.6)', () => {
  test('clean leaves an orphaned directory in place', async () => {
    let orphanExists = true;
    const result = await runCliInSandbox(
      ['worktree', 'clean', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
        fs.mkdirSync(path.join(dir, '.worktrees', '4242-orphan'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.worktrees', '4242-orphan', 'file.txt'), 'x\n');
      },
      (dir) => {
        orphanExists = fs.existsSync(path.join(dir, '.worktrees', '4242-orphan'));
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Would remove \d+ orphaned worktree/);
    assert.ok(!result.stdout.includes('✓ Cleaned'), result.stdout);
    assert.ok(orphanExists, 'the orphan directory must survive');
  });

  test('prune leaves the registration count unchanged (negative control prunes it)', async () => {
    let dryCount = 0;
    const dry = await runCliInSandbox(
      ['worktree', 'prune', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
      },
      (dir) => {
        dryCount = git(dir, ['worktree', 'list']).split('\n').filter(Boolean).length;
      }
    );
    assert.strictEqual(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /\[dry-run\] Would remove/);
    assert.strictEqual(dryCount, 1, 'no registration may be pruned');
  });

  test('remove keeps the directory and its registration', async () => {
    let mitExistsAfter = true;
    let registrationCount = 0;
    const result = await runCliInSandbox(
      ['worktree', 'remove', '902', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
        git(dir, ['worktree', 'add', '-q', '--detach', path.join('.worktrees', '902')]);
      },
      (dir) => {
        mitExistsAfter = fs.existsSync(path.join(dir, '.worktrees', '902'));
        registrationCount = git(dir, ['worktree', 'list']).split('\n').filter(Boolean).length;
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Would remove/);
    assert.ok(!result.stdout.includes('✓'), result.stdout);
    assert.ok(mitExistsAfter, 'the worktree directory must survive');
    assert.strictEqual(registrationCount, 2, 'the git registration must survive');
  });
});

describe('critique --dry-run (#248 AC-248.6)', () => {
  /**
   * The ONLY network call a critique dry run may make is the release-metadata
   * GET (needed to say WHICH version would be installed). `globalThis.fetch` is
   * stubbed because the gateway captures it at construction — inside `runCli` —
   * so the outcome is deterministic: a real run would have gone on to download
   * the asset and write it, which the assertions below would catch.
   */
  function stubReleaseMetadata(): { urls: string[]; restore: () => void } {
    const original = globalThis.fetch;
    const urls: string[] = [];
    const stub = async (url: unknown): Promise<Response> => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          tag_name: 'v9.9.9',
          html_url: 'https://example.test/release',
          assets: [{ name: 'critique.js', browser_download_url: 'https://example.test/critique.js' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    globalThis.fetch = stub as unknown as typeof globalThis.fetch;
    return {
      urls,
      restore: () => {
        globalThis.fetch = original;
      }
    };
  }

  for (const sub of ['install', 'update']) {
    test(`${sub} downloads and writes nothing`, async () => {
      const stub = stubReleaseMetadata();
      let before = '';
      let after = '';
      let cacheExists = true;
      try {
        const result = await runCliInSandbox(
          ['critique', sub, '--dry-run'],
          (dir) => {
            // The cache path is resolved against the cwd at construction, so a
            // `.agyloop` here makes any cache write land in the sandbox.
            fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
            before = treeHash(path.join(dir, '.agyloop'));
          },
          (dir) => {
            after = treeHash(path.join(dir, '.agyloop'));
            cacheExists = fs.existsSync(path.join(dir, '.agyloop', 'critique-update-cache.json'));
          }
        );

        assert.strictEqual(result.code, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`\\[dry-run\\] Would ${sub}`));
        assert.match(result.stdout, /v9\.9\.9/);
        assert.match(result.stdout, /Nothing was downloaded or written/);
        assert.ok(!result.stdout.includes('✓ Successfully'), result.stdout);

        assert.strictEqual(stub.urls.length, 1, 'only the release-metadata fetch is permitted');
        assert.ok(stub.urls[0].includes('api.github.com'), stub.urls[0]);
        assert.strictEqual(cacheExists, false, 'no cache manifest may be written');
        assert.strictEqual(after, before, 'the .agyloop tree must be byte-identical');
      } finally {
        stub.restore();
      }
    });
  }
});

describe('review --dry-run (#248 AC-248.7)', () => {
  test('never says "recorded" and reports the on-disk stage', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['review', '--issue', '905', '--verdict-file', 'verdict.md', '--critique-report', 'critique.json', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
        seedTask(dir, 905, { currentStage: 'REVIEW' });
        fs.writeFileSync(path.join(dir, 'verdict.md'), 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: ok\n');
        // Issue #297: hermetic Tier 1 evidence — never shell out to a host
        // `critique`, and never let the machine's install state decide.
        fs.writeFileSync(
          path.join(dir, 'critique.json'),
          JSON.stringify({
            summary: 'Clean automated review',
            confidenceLevel: 'High',
            confidenceExplanation: 'diff verified',
            comments: []
          })
        );
        before = fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '905.json'), 'utf8');
      },
      (dir) => {
        after = fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '905.json'), 'utf8');
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /Current Stage\s+: .*REVIEW/);
    assert.match(result.stdout, /\[dry-run\] Would set stage/);
    assert.match(result.stdout, /\[dry-run\] Would record verdict APPROVED/);
    assert.ok(!result.stdout.includes('✓ AI Review recorded.'), result.stdout);
    assert.ok(!result.stdout.includes('Next Stage'), result.stdout);
    assert.strictEqual(after, before, 'the checkpoint must be byte-identical');
  });
});

describe('implement --dry-run (#248 AC-248.8)', () => {
  test('every success line carries the [dry-run] prefix', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['implement', '--issue', '907', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
        seedTask(dir, 907, { currentStage: 'APPROVAL' });
        fs.mkdirSync(path.join(dir, 'artifacts', 'plans', '907-smoke'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'artifacts', 'plans', '907-smoke', 'implementation-plan.md'),
          '# Plan\n\n- do the thing\n'
        );
        before = fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '907.json'), 'utf8');
      },
      (dir) => {
        after = fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '907.json'), 'utf8');
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] (Advanced to|Already at)/);
    assert.ok(!result.stdout.includes('✓ Advanced to'), result.stdout);
    assert.match(result.stdout, /\[dry-run\] Nothing was written\./);
    assert.strictEqual(after, before);
  });
});

describe('halt --dry-run (#248)', () => {
  test('records nothing and never claims a recorded halt', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['halt', '--reason', 'quota', '--dry-run'],
      (dir) => {
        seedRoot(dir, { currentStage: 'IMPLEMENT' });
        before = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      },
      (dir) => {
        after = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      }
    );
    assert.strictEqual(result.code, 2, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Would record a quota halt/);
    assert.ok(!result.stdout.includes('✓ Quota halt recorded'), result.stdout);
    assert.strictEqual(after, before);
  });
});

// #339 (item 2 / T2.5): `plan --dry-run` had NO case here — the command whose
// dry run claimed "State is checkpointed" was unpinned. Park and non-park
// paths both leave the checkpoint tree AND the artifacts byte-identical.
describe('plan --dry-run (#339 AC-1.2, T2.5)', () => {
  const PLAN_ISSUE = 33925;

  function combinedHash(dir: string): string {
    return `${treeHash(path.join(dir, '.agyloop'))}|${treeHash(path.join(dir, 'artifacts'))}`;
  }

  function seedPlanTree(dir: string, overrides: Record<string, unknown>): void {
    initGitWorkspace(dir);
    const planDir = path.join(dir, 'artifacts', 'plans', `${PLAN_ISSUE}-smoke`);
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, 'implementation_plan.md'),
      '# [Implementation] - dry run contract\n\n## 3. Implementation Steps\n- [ ] Step 1: hold the line\n',
      'utf8'
    );
    fs.writeFileSync(path.join(planDir, 'CodeLoop Summary.md'), 'summary\n', 'utf8');
    seedTask(dir, PLAN_ISSUE, { planDir, ...overrides });
  }

  test('a park path (DISCOVERY checkpoint) writes nothing', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['plan', '--issue', String(PLAN_ISSUE), '--dry-run'],
      (dir) => {
        seedPlanTree(dir, { currentStage: 'DISCOVERY' });
        before = combinedHash(dir);
      },
      (dir) => {
        after = combinedHash(dir);
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[DRY RUN\]/);
    assert.match(result.stdout, /No checkpoint was written/);
    assert.ok(!result.stdout.includes('State is checkpointed'), result.stdout);
    assert.strictEqual(after, before, 'a dry-run park must write NOTHING');
  });

  test('a non-park path (PLAN checkpoint) writes nothing', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['plan', '--issue', String(PLAN_ISSUE), '--dry-run'],
      (dir) => {
        seedPlanTree(dir, { currentStage: 'PLAN' });
        before = combinedHash(dir);
      },
      (dir) => {
        after = combinedHash(dir);
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[DRY RUN\]/);
    assert.match(result.stdout, /No checkpoint was written/);
    assert.ok(!result.stdout.includes('Pipeline advanced to'), result.stdout);
    assert.strictEqual(after, before, 'a dry run must write NOTHING');
  });
});

describe('plan --dry-run derives bounded names (#364 AC-7)', () => {
  test('CLI-DRY-364.1: a 372-char title previews the derived folder and writes nothing', async () => {
    const { planFolderName } = require('../../dist/domain');
    const title = 'q'.repeat(372);
    let artifactsExist = true;

    const result = await runCliInSandbox(
      ['plan', '--dry-run', '--title', title, '--type', 'implementation'],
      undefined,
      (dir) => {
        artifactsExist = fs.existsSync(path.join(dir, 'artifacts'));
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[DRY RUN\] Would scaffold/);
    assert.ok(
      result.stdout.includes(planFolderName(null, title)),
      `the preview must name the derived folder:\n${result.stdout}`
    );
    assert.strictEqual(artifactsExist, false, 'a dry run must create no artifacts tree');
  });

  test('CLI-DRY-364.2: a legacy over-budget folder is reused by the dry run and adopted by the real run', async () => {
    const issue = 36402;
    // 184 bytes: every pre-#364 plan folder is 154-211 bytes (the live #364
    // folder is 183 B, #359 is 211 B), so re-entry must adopt, never re-derive.
    const legacy = `364-${'legacy-folder-'.repeat(13)}`.slice(0, 184);
    assert.ok(Buffer.byteLength(legacy) > 143);

    const seed = (dir: string): void => {
      initGitWorkspace(dir);
      const planDir = path.join(dir, 'artifacts', 'plans', legacy);
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, 'implementation_plan.md'),
        '# [Implementation] - legacy folder\n\n## 3. Implementation Steps\n- [ ] Step 1: hold the line\n',
        'utf8'
      );
      seedTask(dir, issue, { currentStage: 'PLAN', planDir });
    };

    const dry = await runCliInSandbox(
      ['plan', '--issue', String(issue), '--title', 'legacy folder', '--dry-run'],
      seed
    );
    assert.strictEqual(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Would reuse existing plan directory/, dry.stdout);
    assert.ok(!/Would scaffold/.test(dry.stdout), dry.stdout);

    let planDirs: string[] = [];
    const real = await runCliInSandbox(
      ['plan', '--issue', String(issue), '--title', 'legacy folder'],
      seed,
      (dir) => {
        planDirs = fs.readdirSync(path.join(dir, 'artifacts', 'plans'));
      }
    );
    assert.strictEqual(real.code, 0, real.stderr);
    assert.deepStrictEqual(planDirs, [legacy], 'the real run adopts the legacy folder');
  });
});
