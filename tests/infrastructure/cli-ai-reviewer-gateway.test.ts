/**
 * agyloop - CliAiReviewerGateway Infrastructure Tests
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const {
  CliAiReviewerGateway,
  loadEnvironmentFile,
  resolveGeminiApiKey
} = require('../../dist/infrastructure');
const {
  RESOLVER_SOURCE_BUNDLED,
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
  test('resolves bundled bin/ai-reviewer.js when present in repo root', () => {
    const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
    const resolution = gateway.resolveReviewer();

    assert.strictEqual(resolution.source, RESOLVER_SOURCE_BUNDLED);
    assert.strictEqual(resolution.isAvailable, true);
    assert.ok(resolution.path && resolution.path.endsWith('bin/ai-reviewer.js'));
  });

  test('resolves correctly for arbitrary cwd', () => {
    const gateway = new CliAiReviewerGateway(new MockCommandExecutor());
    const resolution = gateway.resolveReviewer(process.cwd());
    assert.strictEqual(resolution.source, RESOLVER_SOURCE_BUNDLED);
    assert.strictEqual(resolution.isAvailable, true);
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

  test('handles missing GEMINI_API_KEY with diagnostic report', async () => {
    const mockExecutor = new MockCommandExecutor();
    const gateway = new CliAiReviewerGateway(mockExecutor);

    // Provide an empty environment with no GEMINI_API_KEY
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const report = await gateway.review({
        cwd: '/tmp/nonexistent-agyloop-test-dir',
        env: {}
      });
      assert.strictEqual(report.bypassed, true);
      assert.ok(report.diagnosticMessage && report.diagnosticMessage.includes('GEMINI_API_KEY'));
    } finally {
      if (origKey !== undefined) {
        process.env.GEMINI_API_KEY = origKey;
      }
    }
  });

  test('handles clean working tree with empty diff report', async () => {
    const mockExecutor = new MockCommandExecutor((cmd: string) => {
      // Simulate git diff commands returning empty string
      return {
        command: cmd,
        exitCode: 0,
        stdout: '',
        stderr: '',
        combinedOutput: '',
        durationMs: 5,
        timedOut: false
      };
    });

    const gateway = new CliAiReviewerGateway(mockExecutor);
    const report = await gateway.review({
      env: { GEMINI_API_KEY: 'test-dummy-key' }
    });

    assert.strictEqual(report.findings.length, 0);
    assert.strictEqual(report.confidence.isHigh(), true);
    assert.strictEqual(report.bypassed, false);
  });
});

describe('Environment Discovery', () => {
  test('loadEnvironmentFile parses key-value pairs and ignores comments', () => {
    const tmpEnv = path.join(__dirname, 'test.env');
    fs.writeFileSync(tmpEnv, 'KEY_ONE=val1\nKEY_TWO="val2"\n# Comment\nINVALID LINE\n');

    try {
      const env = loadEnvironmentFile(tmpEnv);
      assert.strictEqual(env.KEY_ONE, 'val1');
      assert.strictEqual(env.KEY_TWO, 'val2');
    } finally {
      if (fs.existsSync(tmpEnv)) {
        fs.unlinkSync(tmpEnv);
      }
    }
  });

  test('resolveGeminiApiKey prioritizes explicit environment variables', () => {
    const explicit = { GEMINI_API_KEY: 'explicit-key' };
    const resolved = resolveGeminiApiKey('/tmp', explicit);
    assert.strictEqual(resolved, 'explicit-key');
  });
});
