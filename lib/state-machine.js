/**
 * agyloop - Deterministic Lifecycle State Machine (Legacy Bridge)
 *
 * Re-exports and wraps the compiled Clean Hexagonal Architecture domain entity
 * and infrastructure adapter, providing 100% backward compatibility.
 */

const { StateMachine: DomainStateMachine, STAGES, ALLOWED_TRANSITIONS } = require('../dist/domain');
const { FileStateRepository } = require('../dist/infrastructure/file-state-repository');

class StateMachine {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.stateFile = options.stateFile || null;
    this.mode = options.mode || 'standard';
    this.issue = options.issue || null;
    this.repo = new FileStateRepository({
      workspaceDir: this.workspaceDir,
      stateFilePath: this.stateFile
    });
    this.stateFile = this.repo.getStateFilePath();
    this.load();
  }

  get state() {
    return this.domainSm ? this.domainSm.toSnapshot() : null;
  }

  set state(val) {
    if (val) {
      this.domainSm = DomainStateMachine.fromSnapshot(val);
    }
  }

  load() {
    try {
      const snapshot = this.repo.load();
      if (snapshot) {
        this.domainSm = DomainStateMachine.fromSnapshot(snapshot);
        if (this.domainSm.issue && !this.issue) {
          this.issue = this.domainSm.issue;
        }
        return this.domainSm.toSnapshot();
      }
    } catch (err) {
      console.warn(`Warning: Could not parse state file (${this.stateFile}). Initializing fresh state.`);
    }

    this.domainSm = DomainStateMachine.createInitial({
      mode: this.mode,
      issue: this.issue
    });
    return this.domainSm.toSnapshot();
  }

  save() {
    const snapshot = this.domainSm.toSnapshot();
    this.repo.save(snapshot);
    return snapshot;
  }

  canTransition(targetStage) {
    return this.domainSm.canTransition(targetStage);
  }

  transition(targetStage, metadata = {}) {
    this.domainSm.transition(targetStage, metadata);
    this.save();
    return this.domainSm.toSnapshot();
  }

  reset(deleteFile = false) {
    if (deleteFile) {
      this.repo.reset();
    }
    this.domainSm = DomainStateMachine.createInitial({
      mode: this.mode,
      issue: null
    });
    if (!deleteFile) {
      this.save();
    }
    return this.domainSm.toSnapshot();
  }

  getStatus() {
    const summary = this.domainSm.getStatus();
    return {
      ...summary,
      stateFile: this.stateFile
    };
  }
}

module.exports = {
  STAGES,
  ALLOWED_TRANSITIONS,
  StateMachine
};
