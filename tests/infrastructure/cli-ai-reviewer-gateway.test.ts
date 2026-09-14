/**
 * agyloop - CliAiReviewerGateway Infrastructure Tests
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { CliAiReviewerGateway } = require('../../dist/infrastructure');
const {
  RESOLVER_SOURCE_SIBLING,
  RESOLVER_SOURCE_BUNDLED,
  RESOLVER_SOURCE_USER_DATA,
  RESOLVER_SOURCE_USER_LOCAL,
  RESOLVER_SOURCE_SYSTEM_PATH,
  RESOLVER_SOURCE_NONE
} = require('../../dist/domain');

interface ExecCall {
  command: string;
  options?: unknown;
}

type ExecHandler = (command: string, options?: unknown) => unknown;

class MockCommandExecutor {
  public handler?: ExecHandler;
  public calls: ExecCall[];

  constructor(handler?: ExecHandler) {
    this.handler = handler;
    this.calls = [];
  }

  async execute(command: string, options?: unknown) {
    this.calls.push({ command, options });
    if (this.handler) {
      return this.handler(command, options);
    }
    return {
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
      combinedOutput: '',
      durationMs: 10,
      timedOut: false
    };
  }
}

describe('CliAiReviewerGateway Resolution Hierarchy', () => {
  test('prioritizes critique resolution when present in repository workspace', () => {
    const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
    const resolution = gateway.resolveReviewer();

    assert.strictEqual(resolution.isAvailable, true);
    assert.ok(resolution.path && resolution.path.includes('critique'));
  });

  test('resolves sibling ../critique when present', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-res-sibling-'));
    try {
      const workspace = path.join(tempDir, 'repo');
      const siblingCritique = path.join(tempDir, 'critique');
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(path.join(siblingCritique, 'bin'), { recursive: true });
      const critiqueJs = path.join(siblingCritique, 'bin', 'critique.js');
      fs.writeFileSync(critiqueJs, '// critique binary');

      const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
      const resolution = gateway.resolveReviewer(workspace);

      assert.strictEqual(resolution.source, RESOLVER_SOURCE_SIBLING);
      assert.strictEqual(resolution.isAvailable, true);
      assert.strictEqual(resolution.path, critiqueJs);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resolves bundled bin/critique.js in workspace root when no sibling exists', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-res-bundled-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const critiqueJs = path.join(binDir, 'critique.js');
      fs.writeFileSync(critiqueJs, '// bundled critique');

      const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
      const resolution = gateway.resolveReviewer(tempDir);

      assert.strictEqual(resolution.source, RESOLVER_SOURCE_BUNDLED);
      assert.strictEqual(resolution.isAvailable, true);
      assert.strictEqual(resolution.path, critiqueJs);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resolves user data tool dir critique when present', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-res-userdata-'));
    const origXdg = process.env.XDG_DATA_HOME;
    const origHomedir = os.homedir;
    try {
      const dataDir = path.join(tempDir, 'data');
      process.env.XDG_DATA_HOME = dataDir;
      const critiqueDataDir = path.join(dataDir, 'critique', 'bin');
      fs.mkdirSync(critiqueDataDir, { recursive: true });
      const critiqueJs = path.join(critiqueDataDir, 'critique.js');
      fs.writeFileSync(critiqueJs, '// user data critique');

      const isolatedWorkspace = path.join(tempDir, 'workspace');
      fs.mkdirSync(isolatedWorkspace, { recursive: true });

      os.homedir = () => path.join(tempDir, 'home');

      const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
      const resolution = gateway.resolveReviewer(isolatedWorkspace);

      assert.strictEqual(resolution.source, RESOLVER_SOURCE_USER_DATA);
      assert.strictEqual(resolution.isAvailable, true);
      assert.strictEqual(resolution.path, critiqueJs);
    } finally {
      os.homedir = origHomedir;
      if (origXdg !== undefined) {
        process.env.XDG_DATA_HOME = origXdg;
      } else {
        delete process.env.XDG_DATA_HOME;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resolves user-local critique when present in ~/.local/bin', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-user-local-'));
    const origHomedir = os.homedir;
    try {
      const fakeHome = path.join(tempDir, 'fakehome');
      const userLocalBin = path.join(fakeHome, '.local', 'bin');
      fs.mkdirSync(userLocalBin, { recursive: true });
      const critiqueExec = path.join(userLocalBin, 'critique');
      fs.writeFileSync(critiqueExec, '#!/usr/bin/env node');

      os.homedir = () => fakeHome;
      const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
      const resolution = gateway.resolveReviewer(path.join(tempDir, 'workspace'));

      assert.strictEqual(resolution.source, RESOLVER_SOURCE_USER_LOCAL);
      assert.strictEqual(resolution.isAvailable, true);
      assert.strictEqual(resolution.path, critiqueExec);
    } finally {
      os.homedir = origHomedir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resolves system $PATH critique when present', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-sys-path-'));
    const origPath = process.env.PATH;
    const origHomedir = os.homedir;
    try {
      const binDir = path.join(tempDir, 'sysbin');
      fs.mkdirSync(binDir, { recursive: true });
      const critiqueExec = path.join(binDir, 'critique');
      fs.writeFileSync(critiqueExec, '#!/usr/bin/env node');

      os.homedir = () => path.join(tempDir, 'emptyhome');
      process.env.PATH = binDir;

      const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
      const resolution = gateway.resolveReviewer(path.join(tempDir, 'workspace'));

      assert.strictEqual(resolution.source, RESOLVER_SOURCE_SYSTEM_PATH);
      assert.strictEqual(resolution.isAvailable, true);
      assert.strictEqual(resolution.path, critiqueExec);
    } finally {
      os.homedir = origHomedir;
      process.env.PATH = origPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns RESOLVER_SOURCE_NONE when critique is not present in isolated workspace', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-empty-ws-'));
    const origPath = process.env.PATH;
    const origHomedir = os.homedir;
    try {
      os.homedir = () => path.join(tempDir, 'home');
      process.env.PATH = '';
      const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
      const resolution = gateway.resolveReviewer(tempDir);

      assert.strictEqual(resolution.source, RESOLVER_SOURCE_NONE);
      assert.strictEqual(resolution.path, null);
      assert.strictEqual(resolution.isAvailable, false);
    } finally {
      os.homedir = origHomedir;
      process.env.PATH = origPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('CliAiReviewerGateway Execution & Diagnostics', () => {
  test('handles explicit bypass gracefully without querying external services', async () => {
    const mockExecutor = new MockCommandExecutor();
    const gateway = new CliAiReviewerGateway(mockExecutor);

    const report = await gateway.review({ bypass: true });
    assert.strictEqual(report.bypassed, true);
    assert.strictEqual(report.isPassing(), false);
    assert.strictEqual(mockExecutor.calls.length, 0);
  });

  test('handles missing critique binary with diagnostic bypassed report', async () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-nobin-ws-'));
    const origPath = process.env.PATH;
    const origHomedir = os.homedir;
    try {
      os.homedir = () => path.join(tempDir, 'home');
      process.env.PATH = '';
      const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
      const report = await gateway.review({ cwd: tempDir });

      assert.strictEqual(report.bypassed, true);
      assert.ok(report.diagnosticMessage && report.diagnosticMessage.includes('Critique CLI binary not found'));
    } finally {
      os.homedir = origHomedir;
      process.env.PATH = origPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('executes critique with --json, --staged, and --base flags', async () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-exec-critique-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const critiqueJs = path.join(binDir, 'critique.js');
      fs.writeFileSync(critiqueJs, '// critique');

      const mockReviewOutput = JSON.stringify({
        summary: 'Review completed by critique.',
        confidenceLevel: 'High',
        confidenceExplanation: 'Diff verified.',
        comments: []
      });

      const mockExecutor = new MockCommandExecutor((cmd: string) => {
        return {
          command: cmd,
          exitCode: 0,
          stdout: mockReviewOutput,
          stderr: '',
          combinedOutput: mockReviewOutput,
          durationMs: 15,
          timedOut: false
        };
      });

      const gateway = new CliAiReviewerGateway(mockExecutor);
      const report = await gateway.review({
        cwd: tempDir,
        staged: true,
        baseRef: 'origin/main'
      });

      assert.strictEqual(mockExecutor.calls.length, 1);
      const call = mockExecutor.calls[0];
      assert.ok(call.command.includes('--json'));
      assert.ok(call.command.includes('--staged'));
      assert.ok(call.command.includes('--base origin/main'));
      assert.strictEqual(report.isPassing(), true);
      assert.strictEqual(report.summary, 'Review completed by critique.');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('compiles critique via npm run build when src files are newer than bin/critique.js', async () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-build-critique-'));
    try {
      const workspace = path.join(tempDir, 'app');
      const siblingCritique = path.join(tempDir, 'critique');
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(path.join(siblingCritique, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(siblingCritique, 'src'), { recursive: true });

      fs.writeFileSync(
        path.join(siblingCritique, 'package.json'),
        JSON.stringify({ name: 'critique' })
      );

      const critiqueJs = path.join(siblingCritique, 'bin', 'critique.js');
      fs.writeFileSync(critiqueJs, '// old build');
      const oldTime = new Date(Date.now() - 50000);
      fs.utimesSync(critiqueJs, oldTime, oldTime);

      const srcFile = path.join(siblingCritique, 'src', 'index.ts');
      fs.writeFileSync(srcFile, '// source code');

      const mockReviewOutput = JSON.stringify({
        summary: 'Review after compile.',
        confidenceLevel: 'High',
        confidenceExplanation: 'Fresh build verified.',
        comments: []
      });

      const mockExecutor = new MockCommandExecutor((cmd: string) => {
        if (cmd === 'npm run build') {
          fs.writeFileSync(critiqueJs, '// newly built');
          return { command: cmd, exitCode: 0, stdout: 'Build OK', stderr: '', combinedOutput: '', durationMs: 20, timedOut: false };
        }
        return {
          command: cmd,
          exitCode: 0,
          stdout: mockReviewOutput,
          stderr: '',
          combinedOutput: mockReviewOutput,
          durationMs: 15,
          timedOut: false
        };
      });

      const gateway = new CliAiReviewerGateway(mockExecutor);
      const report = await gateway.review({ cwd: workspace });

      const buildCalls = mockExecutor.calls.filter((c) => c.command === 'npm run build');
      assert.strictEqual(buildCalls.length, 1);
      assert.strictEqual((buildCalls[0].options as any)?.cwd, siblingCritique);
      assert.strictEqual(report.summary, 'Review after compile.');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns diagnostic report when critique binary execution fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'test-fallback-critique-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'critique.js'), '// broken critique');

      const mockExecutor = new MockCommandExecutor((cmd: string) => {
        return {
          command: cmd,
          exitCode: 1,
          stdout: '',
          stderr: 'Fatal crash in critique',
          combinedOutput: 'Fatal crash',
          durationMs: 10,
          timedOut: false
        };
      });

      const gateway = new CliAiReviewerGateway(mockExecutor);
      const report = await gateway.review({ cwd: tempDir });

      assert.strictEqual(report.bypassed, true);
      assert.ok(report.diagnosticMessage && report.diagnosticMessage.includes('Critique CLI execution failed'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
