/**
 * Tests for GithubCritiqueInstallerGateway (Infrastructure Layer)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { GithubCritiqueInstallerGateway } = require('../../dist/infrastructure');
const { CRITIQUE_UPDATE_TTL_MS } = require('../../dist/domain');

describe('GithubCritiqueInstallerGateway (Infrastructure Layer)', () => {
  let tempDir: string;
  let cacheFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-critique-test-'));
    cacheFilePath = path.join(tempDir, 'cache.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('fetches latest version from GitHub API response', async () => {
    const mockFetcher = async () => {
      return {
        ok: true,
        json: async () => ({ tag_name: 'v0.2.0', name: 'v0.2.0' })
      };
    };

    const gateway = new GithubCritiqueInstallerGateway({
      fetcher: mockFetcher,
      cacheFilePath,
      targetBaseDir: tempDir
    });

    const version = await gateway.fetchLatestVersion();
    assert.strictEqual(version, '0.2.0');
  });

  it('degrades gracefully with null when API fetch fails or times out', async () => {
    const mockFetcher = async () => {
      throw new Error('Network offline: ECONNREFUSED');
    };

    const gateway = new GithubCritiqueInstallerGateway({
      fetcher: mockFetcher,
      cacheFilePath,
      targetBaseDir: tempDir
    });

    const version = await gateway.fetchLatestVersion();
    assert.strictEqual(version, null);
  });

  it('caches update check and respects 24h TTL without hitting network', async () => {
    let fetchCalls = 0;
    const mockFetcher = async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v0.1.6',
          html_url: 'https://github.com/ajxcodes/critique/releases/tag/v0.1.6'
        })
      };
    };

    const gateway = new GithubCritiqueInstallerGateway({
      fetcher: mockFetcher,
      cacheFilePath,
      targetBaseDir: tempDir
    });

    // First call: hits network
    const info1 = await gateway.checkUpdateAvailable('0.1.5');
    assert.strictEqual(fetchCalls, 1);
    assert.strictEqual(info1.latestVersion, '0.1.6');
    assert.strictEqual(info1.isOutdated, true);
    assert.ok(info1.lastCheckedAt);

    // Second call: within 24h TTL, uses cache
    const info2 = await gateway.checkUpdateAvailable('0.1.5');
    assert.strictEqual(fetchCalls, 1); // Not incremented
    assert.strictEqual(info2.latestVersion, '0.1.6');
    assert.strictEqual(info2.isOutdated, true);

    // Third call with force: true hits network again
    const info3 = await gateway.checkUpdateAvailable('0.1.5', { force: true });
    assert.strictEqual(fetchCalls, 2);
    assert.strictEqual(info3.latestVersion, '0.1.6');
  });

  it('expires cache after 24 hours TTL', async () => {
    let fetchCalls = 0;
    const mockFetcher = async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({ tag_name: 'v0.2.1' })
      };
    };

    const gateway = new GithubCritiqueInstallerGateway({
      fetcher: mockFetcher,
      cacheFilePath,
      targetBaseDir: tempDir
    });

    // Write stale cache (25 hours ago)
    gateway.writeCache({
      latestVersion: '0.2.0',
      lastCheckedAt: Date.now() - (CRITIQUE_UPDATE_TTL_MS + 3600000)
    });

    const info = await gateway.checkUpdateAvailable('0.2.0');
    assert.strictEqual(fetchCalls, 1);
    assert.strictEqual(info.latestVersion, '0.2.1');
    assert.strictEqual(info.isOutdated, true);
  });

  it('falls back to cached data when network request fails', async () => {
    // Write cache first
    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify({
        latestVersion: '0.1.9',
        lastCheckedAt: Date.now()
      })
    );

    const failingFetcher = async () => {
      throw new Error('ETIMEDOUT');
    };

    const gateway = new GithubCritiqueInstallerGateway({
      fetcher: failingFetcher,
      cacheFilePath,
      targetBaseDir: tempDir
    });

    const info = await gateway.checkUpdateAvailable('0.1.8', { force: true });
    assert.strictEqual(info.latestVersion, '0.1.9');
    assert.strictEqual(info.isOutdated, true);
  });

  it('downloads asset, writes to target bin directory with permissions, and creates wrapper', async () => {
    const jsContent = 'console.log("critique running");';
    const mockFetcher = async (url: string) => {
      if (url.includes('releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v0.3.0',
            html_url: 'https://github.com/ajxcodes/critique/releases/tag/v0.3.0',
            assets: [
              {
                name: 'critique.js',
                browser_download_url: 'https://github.com/ajxcodes/critique/releases/download/v0.3.0/critique.js'
              }
            ]
          })
        };
      }

      if (url.includes('critique.js')) {
        return {
          ok: true,
          text: async () => jsContent
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const gateway = new GithubCritiqueInstallerGateway({
      fetcher: mockFetcher,
      cacheFilePath,
      targetBaseDir: tempDir
    });

    const result = await gateway.install({ targetDir: tempDir });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.version, '0.3.0');
    assert.ok(result.targetPath);

    // Verify files on disk
    const targetJs = path.join(tempDir, 'bin', 'critique.js');
    const targetBin = path.join(tempDir, 'bin', 'critique');

    assert.ok(fs.existsSync(targetJs));
    assert.ok(fs.existsSync(targetBin));

    const writtenContent = fs.readFileSync(targetJs, 'utf8');
    assert.ok(writtenContent.startsWith('#!/usr/bin/env node\n'));
    assert.ok(writtenContent.includes(jsContent));

    // Verify cache updated
    const cached = gateway.readCache();
    assert.strictEqual(cached?.latestVersion, '0.3.0');
  });

  it('handles download network failure gracefully without unhandled exceptions', async () => {
    const mockFetcher = async () => {
      throw new Error('Connection reset by peer');
    };

    const gateway = new GithubCritiqueInstallerGateway({
      fetcher: mockFetcher,
      cacheFilePath,
      targetBaseDir: tempDir
    });

    const result = await gateway.install({ targetDir: tempDir });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.strictEqual(result.version, null);
  });

  it('update delegates to install with force', async () => {
    const mockFetcher = async (url: string) => {
      if (url.includes('releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v0.4.0',
            assets: [{ name: 'critique.js', browser_download_url: 'https://example.com/critique.js' }]
          })
        };
      }
      return {
        ok: true,
        text: async () => 'process.exit(0);'
      };
    };

    const gateway = new GithubCritiqueInstallerGateway({
      fetcher: mockFetcher,
      cacheFilePath,
      targetBaseDir: tempDir
    });

    const result = await gateway.update({ targetDir: tempDir });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.version, '0.4.0');
  });
});
