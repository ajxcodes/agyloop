/**
 * codeloop - canonical FileStateRepository construction (issue #544)
 *
 * The single chokepoint for `createStateRepository({...})` in tests (83
 * measured construction sites at 0309f916, 74 of them `{ workspaceDir, issue }`
 * shaped). One place for the day the constructor grows. Suites that build a
 * full use-case stack keep composing this factory + the fakes directly — this
 * dedupes CONSTRUCTION, not wiring.
 *
 * Also hosts the seed/read helpers' real-repo companion used by the helpers
 * contract: a repository scoped the way tests actually scope them.
 */

import type { StateRepository } from '../../src/ports';
import type { FileStateRepository } from '../../src/infrastructure/file-state-repository';

const { FileStateRepository: FileStateRepositoryImpl } = require('../../dist/infrastructure/file-state-repository');

interface StateRepoOptions {
  workspaceDir?: string;
  stateFilePath?: string;
  issue?: number | null;
  allowWorktreeIssueMismatch?: boolean;
}

function createStateRepository(options: StateRepoOptions): StateRepository {
  return new FileStateRepositoryImpl(options) as StateRepository;
}

module.exports = { createStateRepository };

