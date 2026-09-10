/**
 * agyloop - ResetPipelineUseCase
 *
 * Clears the persisted state checkpoint and returns a freshly initialized StateMachine.
 */

import { StateMachine, MODE_STANDARD } from '../domain';
import { StateRepository } from '../ports';

export class ResetPipelineUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(): Promise<StateMachine> {
    await this.stateRepo.reset();
    return StateMachine.createInitial({ mode: MODE_STANDARD });
  }
}
