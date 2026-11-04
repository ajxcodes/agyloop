/**
 * agyloop - ONE canonical RunLifecycleUseCase assembly (issue #544 / AC3)
 *
 * Retires the five local `buildLifecycle*` builders in run-lifecycle.test.ts
 * (:494/:1326/:1446/:2200/:2556/:2925) and `run-lifecycle-shared-pipeline`'s
 * `freshDeps` pair. The 10+-wired use-case assembly is built HERE with
 * defaults; every odd value stays explicit at the call site.
 *
 * Folded fixture variants (Step 8 of the plan):
 *   - `seedCheckpointAtImplementationLeg(mode, gateRetries)` /
 *     `seedCheckpointAtImplement(mode, gateRetries)` are the `stage`, `mode`,
 *     `issue` and `implementToGateLoops` options (fake-snapshot setters, NOT
 *     disk seeders — the disk-write seeds live in state-seed.ts);
 *   - `buildLifecycleWithProbe(verdict)` /
 *     `buildLifecycle(verdict, extraDeps)` is `probeVerdict` (+ `deps`);
 *   - `freshDeps()` is the bare defaults call.
 *
 * Erasable-TS-only: no parameter properties, no enum, no namespace.
 */

const { RunLifecycleUseCase, StateMachine } = require('../../dist');
const { STAGE_DISCOVERY, STAGE_PLAN, STAGE_APPROVAL, STAGE_IMPLEMENT, MODE_YOLO, MODE_STANDARD } =
  require('../../dist');

const {
  FakeStateRepository,
  FakeConfigRepository,
  FakePlanGenerator,
  FakeGitHubGateway,
  FakeCommandExecutor,
  FakeBuildDetector,
  FakeWorktreeManager,
  FakeStandardsRepository,
  FakeCritique,
  FakeConfirmationPrompt,
  FakeImplementationProbe
} = require('./fakes/index.ts');

interface RunLifecycleFixtureOptions {
  stateRepo?: unknown;
  configRepo?: unknown;
  planGenerator?: unknown;
  githubGateway?: unknown;
  commandExecutor?: unknown;
  buildDetector?: unknown;
  standardsRepo?: unknown;
  critique?: unknown;
  confirmationPrompt?: unknown;
  worktreeManager?: unknown;
  /** DetectImplementationDiff verdict injection (issue #259 S11 fixtures). */
  probeVerdict?: unknown;
  /** A full fake probe instead of `probeVerdict`. */
  probe?: unknown;
  /** Seed `stateRepo.savedSnapshot` before the run. */
  snapshot?: Record<string, unknown>;
  /** Fake-seed variants: create a real StateMachine snapshot at this stage. */
  stage?: string;
  mode?: string;
  issue?: number;
  /** The IMPLEMENT->QUALITY_LOOP retry counter the breaker guard reads. */
  implementToGateLoops?: number;
  /** Divergent tier-resolution behaviour (explicit per the suite that pins it). */
  mapModelToTier?: (inputModel: string) => string;
  planContent?: string;
  workspaceRoot?: string;
  /** Any other RunLifecycleUseCase constructor seam, spread LAST (wins). */
  deps?: Record<string, unknown>;
}

function buildRunLifecycle(options: RunLifecycleFixtureOptions = {}) {
  const opts = options ?? {};
  const stateRepo =
    opts.stateRepo ??
    new FakeStateRepository({
      stateFilePath: opts.workspaceRoot ? `${opts.workspaceRoot}/.agyloop/state.json` : undefined
    });
  const configRepo = opts.configRepo ?? new FakeConfigRepository({ mapModelToTier: opts.mapModelToTier });
  const planGenerator =
    opts.planGenerator ?? new FakePlanGenerator({ planContent: opts.planContent });
  const githubGateway = opts.githubGateway ?? new FakeGitHubGateway();
  const commandExecutor = opts.commandExecutor ?? new FakeCommandExecutor();
  const buildDetector = opts.buildDetector ?? new FakeBuildDetector();
  const standardsRepo = opts.standardsRepo ?? new FakeStandardsRepository();
  const critique = opts.critique ?? new FakeCritique();
  const confirmationPrompt = opts.confirmationPrompt ?? new FakeConfirmationPrompt();
  const worktreeManager = opts.worktreeManager ?? new FakeWorktreeManager();

  const detectImplementationDiffUseCase =
    (opts.probe as unknown) ??
    (opts.probeVerdict !== undefined ? new FakeImplementationProbe({ result: opts.probeVerdict }) : undefined);

  if (opts.snapshot) {
    (stateRepo as { savedSnapshot: unknown }).savedSnapshot = opts.snapshot;
  } else if (
    opts.stage !== undefined ||
    opts.implementToGateLoops !== undefined ||
    opts.mode !== undefined
  ) {
    const mode = opts.mode ?? (opts.stage === STAGE_APPROVAL ? MODE_STANDARD : MODE_YOLO);
    const sm = StateMachine.createInitial({ mode, issue: opts.issue ?? 32 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    if (opts.stage === STAGE_APPROVAL || opts.stage === STAGE_IMPLEMENT) {
      if (mode === MODE_STANDARD) {
        sm.transition(STAGE_APPROVAL);
      }
    }
    if (opts.stage === STAGE_IMPLEMENT) {
      sm.transition(STAGE_IMPLEMENT);
    }
    (stateRepo as { savedSnapshot: Record<string, unknown> }).savedSnapshot = {
      ...sm.toSnapshot(),
      ...(opts.implementToGateLoops !== undefined
        ? { implementToGateLoops: opts.implementToGateLoops }
        : {}),
      ...(opts.snapshot ?? {})
    };
  }

  const lifecycle = new RunLifecycleUseCase({
    stateRepo,
    configRepo,
    planGenerator,
    githubGateway,
    commandExecutor,
    buildDetector,
    standardsRepo,
    critique,
    confirmationPrompt,
    worktreeManager,
    ...(detectImplementationDiffUseCase !== undefined ? { detectImplementationDiffUseCase } : {}),
    ...(opts.deps ?? {})
  });

  return {
    lifecycle,
    stateRepo,
    configRepo,
    planGenerator,
    githubGateway,
    commandExecutor,
    buildDetector,
    standardsRepo,
    critique,
    confirmationPrompt,
    worktreeManager,
    deps: lifecycle
  };
}

module.exports = { buildRunLifecycle };
