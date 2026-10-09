/**
 * agyloop - ResetPipelineUseCase
 *
 * Clears the persisted state checkpoint and returns a freshly initialized StateMachine.
 */

import { StateMachine, MODE_STANDARD } from '../domain';
import { StateRepository } from '../ports';

export interface ResetPipelineOptions {
  readonly issue?: number | string | null;
  readonly all?: boolean;
}

export class ResetPipelineUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(options: ResetPipelineOptions = {}): Promise<StateMachine> {
    if (options.all) {
      if (this.stateRepo.resetAll) {
        await this.stateRepo.resetAll();
      } else {
        await this.stateRepo.reset();
      }
      return StateMachine.createInitial({ mode: MODE_STANDARD });
    }

    if (options.issue !== undefined && options.issue !== null) {
      if (this.stateRepo.resetTask) {
        await this.stateRepo.resetTask(options.issue);
      } else {
        await this.stateRepo.reset();
      }
      return StateMachine.createInitial({ mode: MODE_STANDARD, issue: Number(options.issue) });
    }

    await this.stateRepo.reset();
    return StateMachine.createInitial({ mode: MODE_STANDARD });
  }
}
