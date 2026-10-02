/**
 * agyloop - BranchInferenceEngine (Domain Layer)
 *
 * Pure domain engine responsible for:
 * 1. Dynamic base branch inference (label priority, title regex fallback)
 * 2. Feature/Phase collector branch resolution and existence verification
 * 3. In-flight bug routing (fix/* -> active phase/*) vs production hotfix (fix/* -> main)
 * 4. Milestone sealed detection for already merged collector branches
 *
 * Strict Hexagonal Boundary: Zero direct I/O, zero external dependencies.
 */

import {
  DEFAULT_TASK_BRANCH_PREFIX,
  DEFAULT_FIX_BRANCH_PREFIX,
  DEFAULT_PHASE_BRANCH_PREFIX,
  DEFAULT_FEATURE_BRANCH_PREFIX
} from '../constants';
import { MilestoneSealedError } from '../errors';
import { WorktreeDescriptor } from './worktree-descriptor';

export interface BranchInferenceContext {
  readonly issueNumber?: number | string | null;
  readonly issueTitle?: string | null;
  readonly issueLabels?: readonly string[];
  readonly milestoneTitle?: string | null;
  readonly availableBranches?: readonly string[];
  readonly mergedBranches?: readonly string[];
  readonly defaultBranch?: string;
}

export interface BranchInferenceResult {
  readonly baseBranch: string;
  readonly taskBranchPrefix: string;
  readonly branchType: 'task' | 'fix';
  readonly suggestedBranch: string;
  readonly isPhaseCollector: boolean;
  readonly isCollectorBranch: boolean;
  readonly isBug: boolean;
  readonly isHotfix: boolean;
  readonly isMilestoneSealed: boolean;
  readonly needsCreation: boolean;
  readonly autoCreatedBaseBranch: boolean;
  readonly autoCreateFrom: string;
  readonly phaseIdentifier: string | null;
  readonly rationale: string;
}

interface PhaseMatchInfo {
  readonly type: 'phase' | 'feature';
  readonly identifier: string;
  readonly prefix: string;
}

export class BranchInferenceEngine {
  /**
   * Infers base branch and routing parameters from issue metadata and branch state.
   */
  public static infer(context: BranchInferenceContext): BranchInferenceResult {
    const defaultBranch = context.defaultBranch || 'main';
    const labels = (context.issueLabels || []).map((l) => l.toLowerCase().trim());
    const title = context.issueTitle || '';
    const availableBranches = (context.availableBranches || []).map((b) =>
      BranchInferenceEngine.cleanBranchRef(b)
    );
    const mergedBranches = new Set(
      (context.mergedBranches || []).map((b) => BranchInferenceEngine.cleanBranchRef(b))
    );

    // 1. Detect if issue is classified as a bug
    const isBug = BranchInferenceEngine.detectBug(labels, title);
    const branchType: 'task' | 'fix' = isBug ? 'fix' : 'task';
    const taskBranchPrefix = isBug ? DEFAULT_FIX_BRANCH_PREFIX : DEFAULT_TASK_BRANCH_PREFIX;
    const slug = WorktreeDescriptor.slugify(title || 'task');
    const issuePart = context.issueNumber ? `${context.issueNumber}-` : '';
    const suggestedBranch = `${taskBranchPrefix}${issuePart}${slug}`;

    // 2. Discover phase or feature identifier (label priority, then milestoneTitle, then title regex)
    const phaseInfo = BranchInferenceEngine.extractPhaseOrFeature(
      labels,
      title,
      context.milestoneTitle
    );

    // 3. If no phase or feature is associated, route to default branch
    if (!phaseInfo) {
      return {
        baseBranch: defaultBranch,
        taskBranchPrefix,
        branchType,
        suggestedBranch,
        isPhaseCollector: false,
        isCollectorBranch: false,
        isBug,
        isHotfix: isBug,
        isMilestoneSealed: false,
        needsCreation: false,
        autoCreatedBaseBranch: false,
        autoCreateFrom: defaultBranch,
        phaseIdentifier: null,
        rationale: isBug
          ? `Production hotfix against default branch '${defaultBranch}'.`
          : `Standard task against default branch '${defaultBranch}'.`
      };
    }

    // 4. Find matching collector branch among available branches
    const matchedCollector = BranchInferenceEngine.findMatchingCollector(
      phaseInfo,
      availableBranches
    );

    if (matchedCollector) {
      // Check if collector is already merged into main
      const isMerged = mergedBranches.has(matchedCollector);

      if (isMerged) {
        if (isBug) {
          // Production Hotfix Routing: Bug against released code targets main
          return {
            baseBranch: defaultBranch,
            taskBranchPrefix: DEFAULT_FIX_BRANCH_PREFIX,
            branchType: 'fix',
            suggestedBranch: `${DEFAULT_FIX_BRANCH_PREFIX}${issuePart}${slug}`,
            isPhaseCollector: false,
            isCollectorBranch: false,
            isBug: true,
            isHotfix: true,
            isMilestoneSealed: false,
            needsCreation: false,
            autoCreatedBaseBranch: false,
            autoCreateFrom: defaultBranch,
            phaseIdentifier: phaseInfo.identifier,
            rationale: `Collector branch '${matchedCollector}' is already merged into '${defaultBranch}'. Routing as production hotfix against '${defaultBranch}'.`
          };
        } else {
          // Milestone Sealed Protection: New tasks cannot target a closed milestone
          return {
            baseBranch: defaultBranch,
            taskBranchPrefix: DEFAULT_TASK_BRANCH_PREFIX,
            branchType: 'task',
            suggestedBranch,
            isPhaseCollector: false,
            isCollectorBranch: false,
            isBug: false,
            isHotfix: false,
            isMilestoneSealed: true,
            needsCreation: false,
            autoCreatedBaseBranch: false,
            autoCreateFrom: defaultBranch,
            phaseIdentifier: phaseInfo.identifier,
            rationale: `Milestone sealed: Collector branch '${matchedCollector}' is already merged into '${defaultBranch}'. Cannot add new task work to a completed milestone.`
          };
        }
      }

      // Active unmerged phase collector found
      return {
        baseBranch: matchedCollector,
        taskBranchPrefix,
        branchType,
        suggestedBranch,
        isPhaseCollector: true,
        isCollectorBranch: true,
        isBug,
        isHotfix: false,
        isMilestoneSealed: false,
        needsCreation: false,
        autoCreatedBaseBranch: false,
        autoCreateFrom: defaultBranch,
        phaseIdentifier: phaseInfo.identifier,
        rationale: isBug
          ? `In-flight bug routing against active phase collector '${matchedCollector}'.`
          : `Task routing against active phase collector '${matchedCollector}'.`
      };
    }

    // 5. Collector branch does not exist on remote or local -> auto-create
    const synthesizedName = BranchInferenceEngine.synthesizeCollectorName(phaseInfo, title);
    return {
      baseBranch: synthesizedName,
      taskBranchPrefix,
      branchType,
      suggestedBranch,
      isPhaseCollector: true,
      isCollectorBranch: true,
      isBug,
      isHotfix: false,
      isMilestoneSealed: false,
      needsCreation: true,
      autoCreatedBaseBranch: true,
      autoCreateFrom: defaultBranch,
      phaseIdentifier: phaseInfo.identifier,
      rationale: `Collector branch '${synthesizedName}' not found on remote or local. Auto-creating from '${defaultBranch}'.`
    };
  }

  /**
   * Convenience entry point for inferring base branch with simple inputs.
   */
  public static inferBaseBranch(options: {
    labels?: readonly string[];
    title?: string;
    issueNumber?: string | number;
    existingBranches?: readonly string[];
    isAncestorOfMain?: (branch: string) => boolean;
    milestoneTitle?: string | null;
  }): {
    baseBranch: string;
    isCollectorBranch: boolean;
    autoCreateBaseBranch: boolean;
    branchType: 'task' | 'fix';
    suggestedTaskBranch: string;
  } {
    const merged: string[] = [];
    if (options.isAncestorOfMain && options.existingBranches) {
      for (const b of options.existingBranches) {
        if (options.isAncestorOfMain(b)) {
          merged.push(b);
        }
      }
    }

    const result = BranchInferenceEngine.infer({
      issueNumber: options.issueNumber,
      issueTitle: options.title,
      issueLabels: options.labels,
      milestoneTitle: options.milestoneTitle,
      availableBranches: options.existingBranches,
      mergedBranches: merged
    });

    if (result.isMilestoneSealed) {
      throw new MilestoneSealedError(
        result.baseBranch,
        `Collector branch '${result.phaseIdentifier || result.baseBranch}' has already been merged into main. Cannot add new task work to a completed milestone.`
      );
    }

    return {
      baseBranch: result.baseBranch,
      isCollectorBranch: result.isPhaseCollector,
      autoCreateBaseBranch: result.needsCreation,
      branchType: result.branchType,
      suggestedTaskBranch: result.suggestedBranch
    };
  }

  public static cleanBranchRef(ref: string): string {
    if (!ref) return '';
    return ref
      .replace(/^remotes\/origin\//, '')
      .replace(/^origin\//, '')
      .replace(/^refs\/heads\//, '')
      .trim();
  }

  private static detectBug(labels: readonly string[], title: string): boolean {
    if (labels.some((l) => l === 'bug' || l === 'defect' || l.includes('type: bug') || l.includes('type:bug'))) {
      return true;
    }
    const lowerTitle = title.toLowerCase();
    return (
      lowerTitle.includes('[bug]') ||
      lowerTitle.includes('bug:') ||
      lowerTitle.includes('fix:') ||
      lowerTitle.includes('fixing ') ||
      lowerTitle.includes('defect') ||
      lowerTitle.includes('crash')
    );
  }

  private static extractPhaseOrFeature(
    labels: readonly string[],
    title: string,
    milestoneTitle?: string | null
  ): PhaseMatchInfo | null {
    // Check labels first (Priority 1)
    for (const label of labels) {
      // Phase labels: 'phase:1', 'phase: 2', 'phase/1', 'phase-1'
      const phaseLabelMatch = label.match(/^(?:phase|milestone)[\s:\/-]+([a-z0-9_.-]+)$/i);
      if (phaseLabelMatch) {
        return {
          type: 'phase',
          identifier: phaseLabelMatch[1].toLowerCase(),
          prefix: DEFAULT_PHASE_BRANCH_PREFIX
        };
      }

      // Feature labels: 'feature:auth', 'feat:bridge'
      const featLabelMatch = label.match(/^(?:feature|feat)[\s:\/-]+([a-z0-9_.-]+)$/i);
      if (featLabelMatch) {
        return {
          type: 'feature',
          identifier: featLabelMatch[1].toLowerCase(),
          prefix: DEFAULT_FEATURE_BRANCH_PREFIX
        };
      }
    }

    // Check milestone title first before falling back to issue title
    if (milestoneTitle) {
      const match = BranchInferenceEngine.matchPhaseOrFeaturePattern(milestoneTitle);
      if (match) {
        return match;
      }
    }

    // Check title regex fallback
    if (title) {
      const match = BranchInferenceEngine.matchPhaseOrFeaturePattern(title);
      if (match) {
        return match;
      }
    }

    return null;
  }

  private static matchPhaseOrFeaturePattern(text: string): PhaseMatchInfo | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // Pattern 1: Label-style e.g. 'phase:1', 'phase-1'
    const phaseLabelMatch = trimmed.match(/^(?:phase|milestone)[\s:\/-]+([a-z0-9_.-]+)$/i);
    if (phaseLabelMatch) {
      return {
        type: 'phase',
        identifier: phaseLabelMatch[1].toLowerCase(),
        prefix: DEFAULT_PHASE_BRANCH_PREFIX
      };
    }

    const featLabelMatch = trimmed.match(/^(?:feature|feat)[\s:\/-]+([a-z0-9_.-]+)$/i);
    if (featLabelMatch) {
      return {
        type: 'feature',
        identifier: featLabelMatch[1].toLowerCase(),
        prefix: DEFAULT_FEATURE_BRANCH_PREFIX
      };
    }

    // Pattern 2: Title/Milestone style e.g. 'Phase 1: Bridge', '[Phase 1] Bridge', 'Phase 1 - Bridge', 'Phase 1'
    const phaseTitleMatch = trimmed.match(/(?:\[|\b)(?:Phase|Milestone)\s*([0-9]+[a-z0-9_.-]*)(?:\]|:|\s+-|\s|$)/i);
    if (phaseTitleMatch) {
      return {
        type: 'phase',
        identifier: phaseTitleMatch[1].toLowerCase(),
        prefix: DEFAULT_PHASE_BRANCH_PREFIX
      };
    }

    const featTitleMatch = trimmed.match(/(?:\[|\b)(?:Feature|Feat)\s*[:\/-]?\s*([a-z0-9_.-]+)(?:\]|:|\s+-|\s|$)/i);
    if (featTitleMatch) {
      return {
        type: 'feature',
        identifier: featTitleMatch[1].toLowerCase(),
        prefix: DEFAULT_FEATURE_BRANCH_PREFIX
      };
    }

    return null;
  }

  private static findMatchingCollector(
    phaseInfo: PhaseMatchInfo,
    availableBranches: readonly string[]
  ): string | null {
    const targetId = phaseInfo.identifier.toLowerCase();
    const prefix = phaseInfo.prefix; // e.g. 'phase/'

    for (const branch of availableBranches) {
      if (!branch.startsWith(prefix)) continue;

      const suffix = branch.substring(prefix.length).toLowerCase();
      // Match '1', '1-slug', '1/slug', 'bridge-arch'
      if (
        suffix === targetId ||
        suffix.startsWith(`${targetId}-`) ||
        suffix.startsWith(`${targetId}/`) ||
        suffix.startsWith(`${targetId}_`)
      ) {
        return branch;
      }
    }

    return null;
  }

  private static synthesizeCollectorName(phaseInfo: PhaseMatchInfo, title: string): string {
    const rawSlug = WorktreeDescriptor.slugify(title);
    const id = phaseInfo.identifier;
    const cleanId = WorktreeDescriptor.slugify(id);

    if (!rawSlug || rawSlug === cleanId) {
      return `${phaseInfo.prefix}${cleanId}`;
    }

    return `${phaseInfo.prefix}${cleanId}-${rawSlug}`;
  }
}
