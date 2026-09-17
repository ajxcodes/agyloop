/**
 * agyloop - GithubCritiqueInstallerGateway (Infrastructure Adapter)
 *
 * Implements CritiqueInstallerPort:
 * 1. Checks GitHub Releases API (ajxcodes/critique/releases/latest) with non-blocking timeouts
 * 2. Caches release metadata with a 24-hour TTL in .agyloop/critique-update-cache.json
 * 3. Downloads release assets (bundled JS / executable) into user data directory
 * 4. Sets executable permissions (0o755) and ensures wrapper availability
 * 5. Robust offline handling: catches network errors, uses cached data if available,
 *    and degrades gracefully without throwing unhandled exceptions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CRITIQUE_GITHUB_LATEST_RELEASE_API,
  CRITIQUE_UPDATE_TTL_MS,
  CRITIQUE_CACHE_FILENAME,
  DEFAULT_CRITIQUE_CHECK_TIMEOUT_MS,
  DEFAULT_CRITIQUE_DOWNLOAD_TIMEOUT_MS,
  CRITIQUE_EXECUTABLE_PERMISSIONS,
  BINARY_CRITIQUE,
  PATH_USER_DATA_CRITIQUE_DIR,
  PATH_USER_DATA_CRITIQUE_MAC,
  CLI_VERSION,
  CritiqueVersionInfo,
  CritiqueInstallResult,
  CritiqueCacheManifest,
  cleanVersion,
  createCritiqueVersionInfo,
  createCritiqueInstallResult
} from '../domain';
import {
  CritiqueInstallerPort,
  CritiqueCheckOptions,
  CritiqueInstallOptions,
  CritiqueUpdateOptions
} from '../ports';

export type HttpFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubCritiqueInstallerGatewayOptions {
  readonly apiUrl?: string;
  readonly cacheFilePath?: string;
  readonly targetBaseDir?: string;
  readonly fetcher?: HttpFetcher;
  readonly userAgent?: string;
}

interface GitHubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size?: number;
}

interface GitHubReleaseResponse {
  readonly tag_name?: string;
  readonly name?: string;
  readonly html_url?: string;
  readonly assets?: readonly GitHubReleaseAsset[];
  readonly tarball_url?: string;
  readonly zipball_url?: string;
}

function getDefaultUserDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, BINARY_CRITIQUE)
      : path.join(os.homedir(), 'AppData', 'Local', BINARY_CRITIQUE);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), PATH_USER_DATA_CRITIQUE_MAC);
  }
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, BINARY_CRITIQUE);
  }
  return path.join(os.homedir(), PATH_USER_DATA_CRITIQUE_DIR);
}

export class GithubCritiqueInstallerGateway implements CritiqueInstallerPort {
  private readonly apiUrl: string;
  private readonly cacheFilePath: string;
  private readonly targetBaseDir: string;
  private readonly fetcher: HttpFetcher;
  private readonly userAgent: string;

  constructor(options: GithubCritiqueInstallerGatewayOptions = {}) {
    this.apiUrl = options.apiUrl || CRITIQUE_GITHUB_LATEST_RELEASE_API;
    this.targetBaseDir = options.targetBaseDir || getDefaultUserDataDir();
    this.cacheFilePath =
      options.cacheFilePath ||
      (fs.existsSync('.agyloop')
        ? path.join('.agyloop', CRITIQUE_CACHE_FILENAME)
        : path.join(this.targetBaseDir, CRITIQUE_CACHE_FILENAME));
    this.fetcher = options.fetcher || globalThis.fetch;
    this.userAgent = options.userAgent || `agyloop/${CLI_VERSION}`;
  }

  /**
   * Reads cached release manifest if it exists on disk.
   */
  public readCache(): CritiqueCacheManifest | null {
    try {
      if (!fs.existsSync(this.cacheFilePath)) {
        return null;
      }
      const raw = fs.readFileSync(this.cacheFilePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.latestVersion === 'string' && typeof data.lastCheckedAt === 'number') {
        return {
          latestVersion: cleanVersion(data.latestVersion) || data.latestVersion,
          lastCheckedAt: data.lastCheckedAt,
          releaseUrl: data.releaseUrl,
          downloadUrl: data.downloadUrl
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Writes release manifest to disk cache.
   */
  public writeCache(manifest: CritiqueCacheManifest): void {
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch {
      // Cache write failure is non-fatal
    }
  }

  /**
   * Queries GitHub Releases API for release metadata.
   */
  public async fetchReleaseMetadata(
    timeoutMs: number = DEFAULT_CRITIQUE_CHECK_TIMEOUT_MS
  ): Promise<GitHubReleaseResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await this.fetcher(this.apiUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/vnd.github.v3+json'
        }
      });

      if (!res.ok) {
        return null;
      }

      return (await res.json()) as GitHubReleaseResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Discovers latest critique version tag.
   */
  public async fetchLatestVersion(options?: { timeoutMs?: number }): Promise<string | null> {
    const release = await this.fetchReleaseMetadata(options?.timeoutMs);
    if (!release) return null;
    const rawTag = release.tag_name || release.name;
    return cleanVersion(rawTag);
  }

  /**
   * Checks for updates against local cache or remote release.
   */
  public async checkUpdateAvailable(
    currentVersion: string | null,
    options: CritiqueCheckOptions = {}
  ): Promise<CritiqueVersionInfo> {
    const now = Date.now();
    const cached = this.readCache();

    // 1. Return cached metadata if still fresh and force check not requested
    if (!options.force && cached) {
      const ageMs = now - cached.lastCheckedAt;
      if (ageMs < CRITIQUE_UPDATE_TTL_MS) {
        return createCritiqueVersionInfo({
          currentVersion,
          latestVersion: cached.latestVersion,
          lastCheckedAt: cached.lastCheckedAt,
          resolvedPath: options.resolvedPath
        });
      }
    }

    // 2. Query remote GitHub Releases API
    const timeoutMs = options.timeoutMs ?? DEFAULT_CRITIQUE_CHECK_TIMEOUT_MS;
    const release = await this.fetchReleaseMetadata(timeoutMs);

    if (release) {
      const rawTag = release.tag_name || release.name;
      const latestVer = cleanVersion(rawTag);

      if (latestVer) {
        // Find critique.js asset download URL
        let downloadUrl: string | undefined;
        if (release.assets && Array.isArray(release.assets)) {
          const jsAsset = release.assets.find(
            (a) => a.name === 'critique.js' || a.name === 'critique'
          );
          if (jsAsset) {
            downloadUrl = jsAsset.browser_download_url;
          }
        }

        const manifest: CritiqueCacheManifest = {
          latestVersion: latestVer,
          lastCheckedAt: now,
          releaseUrl: release.html_url,
          downloadUrl
        };

        this.writeCache(manifest);

        return createCritiqueVersionInfo({
          currentVersion,
          latestVersion: latestVer,
          lastCheckedAt: now,
          resolvedPath: options.resolvedPath
        });
      }
    }

    // 3. Graceful degradation: if remote check fails, fallback to stale cache if present
    if (cached) {
      return createCritiqueVersionInfo({
        currentVersion,
        latestVersion: cached.latestVersion,
        lastCheckedAt: cached.lastCheckedAt,
        resolvedPath: options.resolvedPath
      });
    }

    // 4. Default when completely offline and un-cached
    return createCritiqueVersionInfo({
      currentVersion,
      latestVersion: null,
      lastCheckedAt: null,
      resolvedPath: options.resolvedPath
    });
  }

  /**
   * Installs latest critique executable.
   */
  public async install(options: CritiqueInstallOptions = {}): Promise<CritiqueInstallResult> {
    const targetDir = options.targetDir || this.targetBaseDir;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CRITIQUE_DOWNLOAD_TIMEOUT_MS;

    // Resolve target directory path: ensure .../bin
    const binDir =
      targetDir.endsWith('/bin') || targetDir.endsWith('\\bin')
        ? targetDir
        : path.join(targetDir, 'bin');

    try {
      // 1. Fetch release metadata
      const release = await this.fetchReleaseMetadata(timeoutMs);
      if (!release) {
        return createCritiqueInstallResult({
          success: false,
          error: 'Failed to fetch release metadata from GitHub Releases API (offline or rate-limited).'
        });
      }

      const version = cleanVersion(release.tag_name || release.name);
      if (!version) {
        return createCritiqueInstallResult({
          success: false,
          error: 'Release tag was missing or unparseable in GitHub response.'
        });
      }

      // 2. Locate downloadable asset
      let downloadUrl: string | null = null;
      if (release.assets && Array.isArray(release.assets)) {
        const jsAsset = release.assets.find(
          (a) => a.name === 'critique.js' || a.name === 'critique'
        );
        if (jsAsset) {
          downloadUrl = jsAsset.browser_download_url;
        }
      }

      // Fallback: direct GitHub release raw asset URL pattern
      if (!downloadUrl) {
        const rawTag = release.tag_name || `v${version}`;
        downloadUrl = `https://github.com/ajxcodes/critique/releases/download/${rawTag}/critique.js`;
      }

      // 3. Download asset
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let content: string;
      try {
        const res = await this.fetcher(downloadUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': this.userAgent
          }
        });

        if (!res.ok) {
          return createCritiqueInstallResult({
            success: false,
            error: `Failed to download critique asset (${res.status} ${res.statusText}).`
          });
        }

        content = await res.text();
      } catch (err) {
        return createCritiqueInstallResult({
          success: false,
          error: `Download error: ${err instanceof Error ? err.message : String(err)}`
        });
      } finally {
        clearTimeout(timer);
      }

      if (!content || !content.trim()) {
        return createCritiqueInstallResult({
          success: false,
          error: 'Downloaded asset is empty.'
        });
      }

      // 4. Ensure target bin directory exists
      if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
      }

      // 5. Ensure shebang header for standalone Node execution
      let scriptContent = content;
      if (!scriptContent.startsWith('#!/usr/bin/env node')) {
        scriptContent = '#!/usr/bin/env node\n' + scriptContent;
      }

      const jsPath = path.join(binDir, 'critique.js');
      const binPath = path.join(binDir, 'critique');

      fs.writeFileSync(jsPath, scriptContent, { mode: CRITIQUE_EXECUTABLE_PERMISSIONS });
      fs.writeFileSync(binPath, scriptContent, { mode: CRITIQUE_EXECUTABLE_PERMISSIONS });

      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(jsPath, CRITIQUE_EXECUTABLE_PERMISSIONS);
          fs.chmodSync(binPath, CRITIQUE_EXECUTABLE_PERMISSIONS);
        } catch {
          // Non-fatal if chmod fails
        }
      } else {
        // Windows cmd launcher
        const cmdPath = path.join(binDir, 'critique.cmd');
        const cmdContent = `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\critique.js" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\critique.js" %*\r\n)`;
        try {
          fs.writeFileSync(cmdPath, cmdContent, 'utf8');
        } catch {
          // Non-fatal
        }
      }

      // 6. Update cached version metadata
      this.writeCache({
        latestVersion: version,
        lastCheckedAt: Date.now(),
        releaseUrl: release.html_url,
        downloadUrl
      });

      return createCritiqueInstallResult({
        success: true,
        version,
        targetPath: jsPath
      });
    } catch (err) {
      return createCritiqueInstallResult({
        success: false,
        error: `Installation failed: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  /**
   * Updates an existing critique installation to the latest available release.
   */
  public async update(options: CritiqueUpdateOptions = {}): Promise<CritiqueInstallResult> {
    return this.install({
      targetDir: options.targetDir,
      timeoutMs: options.timeoutMs,
      force: true
    });
  }

  /**
   * Retrieves the currently cached critique version metadata without making a network request.
   */
  public async getCachedVersionInfo(): Promise<CritiqueVersionInfo | null> {
    const cached = this.readCache();
    if (!cached) return null;
    return createCritiqueVersionInfo({
      latestVersion: cached.latestVersion,
      lastCheckedAt: cached.lastCheckedAt
    });
  }
}
