/**
 * agyloop - VersionAnchor Value Object (Domain Layer)
 *
 * Models the versioning strategy and configuration for the repository:
 * 1. Strategy: 'package_json' (default) | 'git_tag_only' | 'none'
 * 2. Manages default version anchor templates for ajxcodes/auto-tag@v1 compatibility
 *
 * Strict Hexagonal Boundary: Zero direct I/O, zero external dependencies.
 */

import {
  VERSIONING_STRATEGY_PACKAGE_JSON,
  VERSIONING_STRATEGY_GIT_TAG_ONLY,
  VERSIONING_STRATEGY_NONE,
  VersioningStrategyType
} from '../constants';

export interface VersionAnchorConfig {
  readonly strategy?: VersioningStrategyType | string;
  readonly file?: string;
  readonly autoCreate?: boolean;
  readonly initialVersion?: string;
}

export class VersionAnchor {
  public readonly strategy: VersioningStrategyType;
  public readonly file: string;
  public readonly autoCreate: boolean;
  public readonly initialVersion: string;

  constructor(config?: VersionAnchorConfig) {
    const rawStrat = (config?.strategy || '').toLowerCase().trim();
    if (rawStrat === VERSIONING_STRATEGY_GIT_TAG_ONLY) {
      this.strategy = VERSIONING_STRATEGY_GIT_TAG_ONLY;
    } else if (rawStrat === VERSIONING_STRATEGY_NONE) {
      this.strategy = VERSIONING_STRATEGY_NONE;
    } else {
      this.strategy = VERSIONING_STRATEGY_PACKAGE_JSON;
    }

    this.file = config?.file || 'package.json';
    this.autoCreate = config?.autoCreate ?? true;
    this.initialVersion = config?.initialVersion || '0.1.0';

    Object.freeze(this);
  }

  public shouldAutoCreatePackageJson(exists: boolean): boolean {
    return this.strategy === VERSIONING_STRATEGY_PACKAGE_JSON && this.autoCreate && !exists;
  }

  public generateMinimalPackageJson(repoName: string = 'agyloop-project'): string {
    const manifest = {
      name: repoName,
      version: this.initialVersion,
      private: true
    };
    return JSON.stringify(manifest, null, 2) + '\n';
  }
}
