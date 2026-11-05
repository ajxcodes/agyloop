/**
 * codeloop - the canonical fake barrel (issue #544): one require for a migrated
 * suite: `const { FakeStateRepository, FakePlanGenerator } = require('../helpers/fakes/index.ts');`
 */

module.exports = {
  ...require('./state-repository.ts'),
  ...require('./config-repository.ts'),
  ...require('./plan-generator.ts'),
  ...require('./github-gateway.ts'),
  ...require('./command-executor.ts'),
  ...require('./worktree-manager.ts'),
  ...require('./standards-repository.ts'),
  ...require('./build-detector.ts'),
  ...require('./critique.ts'),
  ...require('./confirmation-prompt.ts'),
  ...require('./detect-implementation-diff.ts')
};
