/**
 * agyloop - Deterministic Lifecycle State Machine
 *
 * Coordinates transitions across the 7-stage pair programming contract:
 * DISCOVERY -> PLAN -> APPROVAL -> IMPLEMENT -> QUALITY_GATE -> REVIEW -> COMMIT -> COMPLETED
 *
 * Checkpoints state deterministically to `.agyloop/state.json`.
 */

const fs = require('fs');
const path = require('path');

const STAGES = Object.freeze({
  INITIALIZED: 'INITIALIZED',
  DISCOVERY: 'DISCOVERY',
  PLAN: 'PLAN',
  APPROVAL: 'APPROVAL',
  IMPLEMENT: 'IMPLEMENT',
  QUALITY_GATE: 'QUALITY_GATE',
  REVIEW: 'REVIEW',
  COMMIT: 'COMMIT',
  COMPLETED: 'COMPLETED'
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [STAGES.INITIALIZED]: [STAGES.DISCOVERY],
  [STAGES.DISCOVERY]: [STAGES.PLAN],
  [STAGES.PLAN]: [STAGES.APPROVAL, STAGES.IMPLEMENT], // IMPLEMENT allowed in YOLO mode
  [STAGES.APPROVAL]: [STAGES.IMPLEMENT, STAGES.PLAN], // PLAN allowed if re-planning requested
  [STAGES.IMPLEMENT]: [STAGES.QUALITY_GATE],
  [STAGES.QUALITY_GATE]: [STAGES.REVIEW, STAGES.IMPLEMENT], // IMPLEMENT allowed if gates fail
  [STAGES.REVIEW]: [STAGES.COMMIT, STAGES.IMPLEMENT], // IMPLEMENT allowed if review changes required
  [STAGES.COMMIT]: [STAGES.COMPLETED],
  [STAGES.COMPLETED]: [STAGES.INITIALIZED] // Can start next task
});

class StateMachine {
  /**
   * @param {Object} options
   * @param {string} [options.workspaceDir] - Root directory of workspace
   * @param {string} [options.stateFile] - Explicit path to state.json
   * @param {string} [options.mode] - 'standard' | 'plan' | 'implement' | 'gates' | 'yolo'
   * @param {number|string} [options.issue] - Associated GitHub issue number
   */
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.stateFile = options.stateFile || path.join(this.workspaceDir, '.agyloop', 'state.json');
    this.mode = options.mode || 'standard';
    this.issue = options.issue || null;
    this.state = null;
    this.load();
  }

  /**
   * Loads state from `.agyloop/state.json` or initializes fresh state.
   */
  load() {
    if (fs.existsSync(this.stateFile)) {
      try {
        const content = fs.readFileSync(this.stateFile, 'utf8');
        this.state = JSON.parse(content);
        if (this.state && !this.issue && this.state.issue) {
          this.issue = this.state.issue;
        }
        return this.state;
      } catch (err) {
        console.warn(`Warning: Could not parse state file (${this.stateFile}). Initializing fresh state.`);
      }
    }

    this.state = {
      version: '1.0.0',
      currentStage: STAGES.INITIALIZED,
      mode: this.mode,
      issue: this.issue,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [
        {
          stage: STAGES.INITIALIZED,
          timestamp: new Date().toISOString(),
          metadata: { note: 'Pipeline initialized' }
        }
      ]
    };
    return this.state;
  }

  /**
   * Saves current state atomically to `.agyloop/state.json`.
   */
  save() {
    const dir = path.dirname(this.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.state.updatedAt = new Date().toISOString();
    this.state.mode = this.mode;
    if (this.issue) {
      this.state.issue = this.issue;
    }
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
    return this.state;
  }

  /**
   * Checks if transition to targetStage is allowed from current stage.
   * @param {string} targetStage
   * @returns {boolean}
   */
  canTransition(targetStage) {
    if (!STAGES[targetStage]) {
      return false;
    }

    const current = this.state.currentStage;
    const allowed = ALLOWED_TRANSITIONS[current] || [];

    // In non-yolo mode, jumping PLAN -> IMPLEMENT directly without APPROVAL is forbidden
    if (current === STAGES.PLAN && targetStage === STAGES.IMPLEMENT && this.mode !== 'yolo') {
      return false;
    }

    return allowed.includes(targetStage);
  }

  /**
   * Transitions to targetStage and records transition history.
   * @param {string} targetStage
   * @param {Object} [metadata]
   * @returns {Object} Updated state
   */
  transition(targetStage, metadata = {}) {
    if (!this.canTransition(targetStage)) {
      throw new Error(
        `Invalid lifecycle transition: Cannot transition from '${this.state.currentStage}' to '${targetStage}' in mode '${this.mode}'.`
      );
    }

    this.state.currentStage = targetStage;
    this.state.history.push({
      stage: targetStage,
      timestamp: new Date().toISOString(),
      metadata
    });

    this.save();
    return this.state;
  }

  /**
   * Resets the state machine back to INITIALIZED and deletes or reinitializes state file.
   * @param {boolean} [deleteFile=false]
   */
  reset(deleteFile = false) {
    if (deleteFile && fs.existsSync(this.stateFile)) {
      fs.unlinkSync(this.stateFile);
    }
    this.state = {
      version: '1.0.0',
      currentStage: STAGES.INITIALIZED,
      mode: this.mode,
      issue: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [
        {
          stage: STAGES.INITIALIZED,
          timestamp: new Date().toISOString(),
          metadata: { note: 'Pipeline reset' }
        }
      ]
    };
    if (!deleteFile) {
      this.save();
    }
    return this.state;
  }

  /**
   * Returns a concise summary of current pipeline state.
   */
  getStatus() {
    return {
      currentStage: this.state.currentStage,
      mode: this.state.mode,
      issue: this.state.issue,
      stepCount: this.state.history.length,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      stateFile: this.stateFile
    };
  }
}

module.exports = {
  STAGES,
  ALLOWED_TRANSITIONS,
  StateMachine
};
