/**
 * agyloop - ProjectScaffolderPort Interface
 *
 * Inversion of control contract for filesystem concerns of `codeloop init`:
 * marker discovery, config persistence and .gitignore hygiene.
 */

import { VerificationConfig } from './config-repository';

export interface ProjectMarkers {
  readonly monorepo: boolean;
  readonly dockerCompose: boolean;
  readonly migrationTool: string | null;
  readonly e2eTool: string | null;
  readonly hasBackendMarkers: boolean;
  readonly hasFrontendMarkers: boolean;
  readonly packageScripts: Readonly<Record<string, string>>;
}

export interface LegacyLayout {
  readonly legacyConfigPath: string | null;
  readonly legacyStateDirExists: boolean;
}

export interface GitIgnoreChange {
  /** Rules newly appended (including negations that protect config files). */
  readonly added: string[];
  /** Pre-existing blanket lines that were replaced by granular rules. */
  readonly replaced: string[];
  /** Optional warnings when broad or indirect ignore rules might affect tracked config. */
  readonly warnings?: string[];
}

export interface ProjectScaffolderPort {
  /** Scans the workspace for fullstack/monorepo/service/migration/e2e markers. */
  detectMarkers(workspaceDir: string): Promise<ProjectMarkers>;

  /** Derives a multi-tier verification profile from detected markers and gate commands. */
  buildVerificationProfile(markers: ProjectMarkers, ecosystem: string, gateCommands: readonly { id: string; label: string; command: string }[]): VerificationConfig;

  /** Returns the existing config location (codeloop first, then legacy agyloop) or null. */
  findExistingConfig(workspaceDir: string): string | null;

  /** Absolute path of the canonical `.codeloop/config.json`. */
  getConfigPath(workspaceDir: string): string;

  /** Absolute paths of legacy agyloop config candidates. */
  getLegacyConfigPaths(workspaceDir: string): string[];

  /** Reports legacy .agyloop layout details. */
  detectLegacyLayout(workspaceDir: string): LegacyLayout;

  /** Atomically writes `.codeloop/config.json`; returns its absolute path. */
  writeConfig(workspaceDir: string, config: unknown): string;

  /** Reads a JSON config file or returns null when unreadable. */
  readConfig(configPath: string): Record<string, unknown> | null;

  /** Adds granular ignore rules and reconciles blanket ignores that hide config files. */
  updateGitIgnore(workspaceDir: string, rules: readonly string[]): GitIgnoreChange;

  /** Computes what updateGitIgnore would change, without writing anything. */
  previewGitIgnore(workspaceDir: string, rules: readonly string[]): GitIgnoreChange;
}
