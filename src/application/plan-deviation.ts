/**
 * agyloop - ManagePlanDeviationsUseCase (issue #432, AC1/AC2)
 *
 * The implementer emits `PLAN_DEVIATION:` blocks; the orchestrator files them
 * here. Filing is legal only at IMPLEMENT or QUALITY_GATE — the two stages that
 * can precede REVIEW — and it saves the checkpoint, because the record IS the
 * finding (there is no sidecar/consume cycle to lose it).
 *
 * Acknowledgement is the ONLY thing that releases the REVIEW refusal, and it
 * requires a reason. Routing the plan back to PLAN clears the records instead.
 */

import {
  MSG_PLAN_DEVIATION_STAGE_REFUSAL,
  RecordedPlanDeviation,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  StateMachine,
  ValidationError,
  isUnacknowledged,
  parseBlocks
} from '../domain';
import { StateRepository } from '../ports';

export type PlanDeviationAction = 'filed' | 'acknowledged' | 'listed';

export interface PlanDeviationResult {
  readonly action: PlanDeviationAction;
  /** The id filed/acknowledged, when one was addressed. */
  readonly id?: string;
  readonly planDeviations: readonly RecordedPlanDeviation[];
  /** True on a dry run: nothing was written. */
  readonly dryRun: boolean;
}

export interface FileDeviationParams {
  readonly text: string;
  readonly dryRun?: boolean;
}

export interface AcknowledgeDeviationParams {
  readonly id: string;
  readonly reason: string | null;
  readonly dryRun?: boolean;
}

const LEGAL_STAGES: readonly string[] = Object.freeze([STAGE_IMPLEMENT, STAGE_QUALITY_GATE]);

export class ManagePlanDeviationsUseCase {
  constructor(private readonly stateRepo: StateRepository) {}

  /** Files every parsed block, deduplicating by identity. */
  public async file(params: FileDeviationParams): Promise<PlanDeviationResult> {
    const sm = await this.loadLegalMachine();
    const blocks = parseBlocks(params.text);

    const ids: string[] = [];
    for (const block of blocks) {
      const record = sm.recordPlanDeviation(block);
      ids.push(record.id);
    }

    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());
    }

    return {
      action: 'filed',
      id: ids[ids.length - 1],
      planDeviations: sm.planDeviations,
      dryRun: params.dryRun === true
    };
  }

  /** Acknowledges one record. Unknown ids list the known ids and write nothing. */
  public async acknowledge(params: AcknowledgeDeviationParams): Promise<PlanDeviationResult> {
    const sm = await this.loadLegalMachine();

    const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
    if (reason.length === 0) {
      throw new ValidationError(
        'reason',
        params.reason ?? null,
        'acknowledging a plan deviation requires a reason: pass `--reason "<why the new literal is right>"`'
      );
    }

    const acknowledged = sm.acknowledgePlanDeviation(params.id, reason);
    if (!acknowledged) {
      const known = sm.planDeviations.map((record) => record.id);
      throw new ValidationError(
        'planDeviation',
        params.id,
        known.length === 0
          ? `no plan deviation "${params.id}" is recorded; the checkpoint has none`
          : `no plan deviation "${params.id}" is recorded; known ids: ${known.join(', ')}`
      );
    }

    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());
    }

    return {
      action: 'acknowledged',
      id: params.id,
      planDeviations: sm.planDeviations,
      dryRun: params.dryRun === true
    };
  }

  /** Read-only listing; legal at any stage. */
  public async list(): Promise<PlanDeviationResult> {
    const snapshot = await this.stateRepo.load();
    const sm = snapshot
      ? StateMachine.fromSnapshot(snapshot)
      : StateMachine.createInitial();
    return {
      action: 'listed',
      planDeviations: sm.planDeviations,
      dryRun: true
    };
  }

  private async loadLegalMachine(): Promise<StateMachine> {
    const snapshot = await this.stateRepo.load();
    if (!snapshot) {
      throw new ValidationError(
        'planDeviation',
        null,
        'no pipeline checkpoint was found; run `codeloop plan` first'
      );
    }
    const stage = snapshot.currentStage;
    if (!LEGAL_STAGES.includes(stage)) {
      throw new ValidationError(
        'planDeviation',
        stage,
        MSG_PLAN_DEVIATION_STAGE_REFUSAL.replace('{stage}', stage)
      );
    }
    return StateMachine.fromSnapshot(snapshot);
  }
}

/** The unacknowledged records that block a REVIEW certification. */
export function unacknowledgedDeviations(sm: StateMachine): readonly RecordedPlanDeviation[] {
  return sm.planDeviations.filter(isUnacknowledged);
}
