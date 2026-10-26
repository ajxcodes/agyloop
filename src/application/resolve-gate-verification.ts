/**
 * agyloop - ResolveGateVerificationUseCase (Application Layer, issue #298)
 *
 * ONE place that turns the approved plan + config + filesystem into the gate's
 * execution contract:
 *
 *   plan artifact ──► targets ─┐
 *                  ──► smoke   ├──► command plan (with provenance)
 *   config/act/fs ─────────────┘
 *   plan bytes ──► digest ──► integrity verdict
 *
 * Both the dispatched gate (`GetNextAction`) and the in-process gate
 * (`RunQualityGate`) call this. There is no second precedence implementation.
 *
 * Zero direct I/O: plan reading and hashing go through `PlanGeneratorPort`,
 * detection through `BuildDetectorPort`.
 */

import {
  DEFAULT_GATE_COMMANDS,
  GateCommandDefinition,
  GateCommandPlan,
  GATE_COMMAND_SOURCE_PLAN,
  GATE_COMMAND_SOURCE_DEFAULT,
  GATE_COMMAND_SOURCE_EXPLICIT,
  GATE_COMMAND_SOURCE_CONFIG,
  GATE_COMMAND_SOURCE_AUTO_DETECT,
  CMD_ID_LINT,
  CMD_ID_PLAN_TARGET_PREFIX,
  CMD_LABEL_PLAN_TARGET,
  CMD_LABEL_CUSTOM,
  CMD_LABEL_CONFIG,
  CMD_PREFIX_CUSTOM,
  CMD_PREFIX_CONFIG,
  PlanIntegrityStatus,
  PLAN_INTEGRITY_VERIFIED,
  PLAN_INTEGRITY_UNVERIFIED,
  PLAN_INTEGRITY_MISMATCH,
  PLAN_INTEGRITY_MISSING,
  QualityGateTargetsResult,
  SmokeProtocol,
  isLintCommand,
  parseQualityGateTargets
} from '../domain';
import {
  AgyLoopConfig,
  BuildDetectorPort,
  PlanGeneratorPort
} from '../ports';

export interface PlanIntegrityVerdict {
  readonly status: PlanIntegrityStatus;
  readonly planPath: string | null;
  readonly expectedDigest: string | null;
  readonly actualDigest: string | null;
}

export interface GateVerificationParams {
  /** Repository root: where plans are resolved from. */
  readonly projectRoot: string;
  /** Execution root: the worktree the gate runs in. */
  readonly workspaceDir: string;
  readonly config?: AgyLoopConfig;
  readonly issue?: number | string | null;
  readonly planPath?: string | null;
  readonly planDir?: string | null;
  readonly stage?: string;
  readonly explicitCommands?: readonly string[] | readonly GateCommandDefinition[];
  readonly planGenerator?: PlanGeneratorPort;
  readonly buildDetector?: BuildDetectorPort;
  readonly approvedPlanDigest?: string | null;
}

export interface GateVerification {
  readonly planPath: string | null;
  readonly planContent: string;
  readonly planTargets: QualityGateTargetsResult;
  readonly smoke: SmokeProtocol;
  readonly commandPlan: GateCommandPlan;
  readonly integrity: PlanIntegrityVerdict;
  /** The cwd the gate must run every command from. */
  readonly cwd: string;
}

export async function resolveGateVerification(
  params: GateVerificationParams
): Promise<GateVerification> {
  const planPath = resolvePlanPath(params);
  const planContent = readPlanContent(params.planGenerator, planPath);
  const planTargets = parseQualityGateTargets(planContent);
  const smoke = SmokeProtocol.fromPlan(planContent);
  const integrity = resolveIntegrity(
    params.planGenerator,
    planPath,
    params.approvedPlanDigest ?? null
  );
  const commandPlan = await resolveCommandPlan(params, planTargets, planPath);

  return {
    planPath,
    planContent,
    planTargets,
    smoke,
    commandPlan,
    integrity,
    cwd: params.workspaceDir
  };
}

function resolvePlanPath(params: GateVerificationParams): string | null {
  if (!params.planGenerator) {
    return params.planPath ?? null;
  }

  const resolved = params.planGenerator.resolvePlanFile({
    projectRoot: params.projectRoot,
    issue: params.issue ?? null,
    planPath: params.planPath ?? undefined,
    planDir: params.planDir ?? undefined,
    stage: params.stage
  });

  return resolved?.planPath ?? params.planPath ?? null;
}

function readPlanContent(planGenerator: PlanGeneratorPort | undefined, planPath: string | null): string {
  if (!planGenerator || !planPath) return '';
  try {
    return planGenerator.readPlanDocument(planPath);
  } catch {
    return '';
  }
}

/**
 * Content-only integrity check.
 *
 * The approved digest was taken at the repository root and the gate reads the
 * worktree path; both resolve to the same bytes through the `artifacts`
 * symlink, so PATHS are never compared — only hashes.
 */
function resolveIntegrity(
  planGenerator: PlanGeneratorPort | undefined,
  planPath: string | null,
  approvedPlanDigest: string | null
): PlanIntegrityVerdict {
  const hasExpectedDigest =
    typeof approvedPlanDigest === 'string' && approvedPlanDigest.trim().length > 0;
  const expected = hasExpectedDigest ? approvedPlanDigest : null;
  const canHash =
    Boolean(planGenerator) &&
    typeof planGenerator?.hashPlanDocument === 'function' &&
    Boolean(planPath);
  const actual = canHash && planPath && planGenerator?.hashPlanDocument
    ? planGenerator.hashPlanDocument(planPath)
    : null;

  if (expected === null) {
    // Legacy checkpoint: UNVERIFIED, but the digest we DID observe is still
    // carried so a mid-run edit is detectable.
    return {
      status: PLAN_INTEGRITY_UNVERIFIED,
      planPath,
      expectedDigest: null,
      actualDigest: actual
    };
  }

  if (!canHash || !planGenerator) {
    // Legacy/mock path: no hasher means "cannot verify", never "failed".
    return {
      status: PLAN_INTEGRITY_UNVERIFIED,
      planPath,
      expectedDigest: expected,
      actualDigest: null
    };
  }

  if (actual === null) {
    return {
      status: PLAN_INTEGRITY_MISSING,
      planPath,
      expectedDigest: expected,
      actualDigest: null
    };
  }

  return {
    status: actual === expected ? PLAN_INTEGRITY_VERIFIED : PLAN_INTEGRITY_MISMATCH,
    planPath,
    expectedDigest: expected,
    actualDigest: actual
  };
}

async function resolveCommandPlan(
  params: GateVerificationParams,
  planTargets: QualityGateTargetsResult,
  planPath: string | null
): Promise<GateCommandPlan> {
  const detector = params.buildDetector;

  if (detector && typeof detector.resolveCommandPlan === 'function') {
    return detector.resolveCommandPlan(params.workspaceDir, params.config, {
      explicitCommands: params.explicitCommands,
      planTargets: planTargets.commands,
      planPath
    });
  }

  // Explicit commands and approved plan targets are resolvable without
  // detection, so they are never delegated to a legacy detector.
  if ((params.explicitCommands && params.explicitCommands.length > 0) || planTargets.found) {
    return resolveCommandPlanWithoutDetector(params, planTargets, planPath);
  }

  // Legacy/mock detector without the provenance method. Explicit commands and
  // approved plan targets never reach this point (handled above); a config
  // override still outranks the detector's own list, so that tier is delegated
  // to the single no-detector resolver. The source is reported honestly and a
  // lint command the detector DID find is still enforced.
  if (detector && typeof detector.resolveCommands === 'function') {
    const detectedLint = await detectLintBestEffort(detector, params.workspaceDir, params.config);
    const configured = params.config?.options?.gateCommands;
    const hasConfig = Boolean(configured && Array.isArray(configured) && configured.length > 0);

    if (hasConfig) {
      return withDetectedLint(
        resolveCommandPlanWithoutDetector(params, planTargets, planPath),
        detectedLint
      );
    }

    const legacyCommands = await detector.resolveCommands(
      params.workspaceDir,
      params.config,
      params.explicitCommands
    );

    return withDetectedLint(
      {
        commands: legacyCommands,
        source: GATE_COMMAND_SOURCE_AUTO_DETECT,
        sourceDetail: 'legacy build detector auto-detection',
        appended: [],
        lintRequired: false,
        lintCommand: null,
        planPath
      },
      detectedLint
    );
  }

  return resolveCommandPlanWithoutDetector(params, planTargets, planPath);
}

/** Re-stamps a resolved plan with the lint provenance detection found. */
function withDetectedLint(
  plan: GateCommandPlan,
  detectedLint: GateCommandDefinition | null
): GateCommandPlan {
  const merged = mergeDetectedLint(plan.commands, detectedLint);
  return {
    ...plan,
    commands: merged.commands,
    appended: merged.appended,
    lintRequired: merged.lintRequired,
    lintCommand: merged.lintCommand
  };
}

/**
 * Best-effort lint probe for a legacy detector. A probe failure must not turn
 * a resolved list into an exception; it only means lint cannot be enforced.
 */
async function detectLintBestEffort(
  detector: BuildDetectorPort,
  workspaceDir: string,
  config?: AgyLoopConfig
): Promise<GateCommandDefinition | null> {
  if (typeof detector.detect !== 'function') return null;
  try {
    const detected = await detector.detect(workspaceDir, config);
    return (
      detected.commands.find((def) => def.id === CMD_ID_LINT || isLintCommand(def)) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Appends the detected lint command when the chosen list omits it, and records
 * the provenance the gate later enforces.
 */
function mergeDetectedLint(
  commands: readonly GateCommandDefinition[],
  detectedLint: GateCommandDefinition | null
): {
  commands: readonly GateCommandDefinition[];
  appended: readonly string[];
  lintRequired: boolean;
  lintCommand: string | null;
} {
  const merged = [...commands];
  const appended: string[] = [];
  let lintRequired = false;
  let lintCommand: string | null = null;

  if (detectedLint !== null) {
    lintRequired = true;
    const existing = merged.find((def) => isLintCommand(def));
    if (existing) {
      lintCommand = existing.command;
    } else {
      merged.push(detectedLint);
      appended.push(detectedLint.command);
      lintCommand = detectedLint.command;
    }
  }

  return { commands: merged, appended, lintRequired, lintCommand };
}

/**
 * Fallback used when no detector is injected (mocks / degraded wiring).
 *
 * Mirrors the adapter's precedence for the tiers that are resolvable without
 * filesystem inspection: explicit > plan > config > default.
 */
function resolveCommandPlanWithoutDetector(
  params: GateVerificationParams,
  planTargets: QualityGateTargetsResult,
  planPath: string | null
): GateCommandPlan {
  const base = {
    appended: [] as readonly string[],
    lintRequired: false,
    lintCommand: null,
    planPath
  };

  if (params.explicitCommands && params.explicitCommands.length > 0) {
    return {
      ...base,
      commands: normalizeDefinitions(params.explicitCommands, CMD_PREFIX_CUSTOM, CMD_LABEL_CUSTOM),
      source: GATE_COMMAND_SOURCE_EXPLICIT,
      sourceDetail: 'explicit commands (CLI --commands / caller parameter)'
    };
  }

  if (planTargets.found) {
    return {
      ...base,
      commands: planTargets.commands.map((command, idx) => ({
        id: `${CMD_ID_PLAN_TARGET_PREFIX}${idx + 1}`,
        label: `${CMD_LABEL_PLAN_TARGET} ${idx + 1}`,
        command
      })),
      source: GATE_COMMAND_SOURCE_PLAN,
      sourceDetail: planPath
        ? `approved plan Quality Gate Targets from ${planPath}`
        : 'approved plan Quality Gate Targets'
    };
  }

  const configured = params.config?.options?.gateCommands;
  if (configured && Array.isArray(configured) && configured.length > 0) {
    return {
      ...base,
      commands: normalizeDefinitions(configured, CMD_PREFIX_CONFIG, CMD_LABEL_CONFIG),
      source: GATE_COMMAND_SOURCE_CONFIG,
      sourceDetail: 'configuration gateCommands override'
    };
  }

  return {
    ...base,
    commands: DEFAULT_GATE_COMMANDS,
    source: GATE_COMMAND_SOURCE_DEFAULT,
    sourceDetail: 'safe default; no plan targets and no detector available'
  };
}

function normalizeDefinitions(
  commands: readonly (string | GateCommandDefinition)[],
  prefix: string,
  labelPrefix: string
): readonly GateCommandDefinition[] {
  return commands.map((cmd, idx) => {
    if (typeof cmd === 'string') {
      return { id: `${prefix}-cmd-${idx + 1}`, label: `${labelPrefix} ${idx + 1}`, command: cmd };
    }
    return cmd;
  });
}
