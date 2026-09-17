/**
 * agyloop - CritiqueVersion Value Objects (Domain Layer)
 *
 * Defines version structures, cache manifests, installation results,
 * and pure SemVer comparison utilities for the Critique CLI.
 *
 * Strict Hexagonal Boundary: Zero I/O, zero external dependencies.
 */

export interface CritiqueVersionInfo {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly lastCheckedAt: number | null;
  readonly isOutdated: boolean;
  readonly isInstalled: boolean;
  readonly resolvedPath: string | null;
}

export interface CritiqueInstallResult {
  readonly success: boolean;
  readonly version: string | null;
  readonly targetPath: string | null;
  readonly error: string | null;
}

export interface CritiqueCacheManifest {
  readonly latestVersion: string;
  readonly lastCheckedAt: number;
  readonly releaseUrl?: string;
  readonly downloadUrl?: string;
}

/**
 * Cleans a version string by stripping 'critique', 'v' prefixes, and extraneous metadata.
 * Examples: 'critique v0.1.6' -> '0.1.6', 'v1.2.3' -> '1.2.3'
 */
export function cleanVersion(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  const match = trimmed.match(/(?:critique\s+)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i);
  if (match) {
    return match[1];
  }
  return trimmed.replace(/^v/i, '') || null;
}

/**
 * Compares two semantic version strings.
 * Returns:
 *   1 if v1 > v2
 *  -1 if v1 < v2
 *   0 if v1 === v2
 */
export function compareVersions(
  v1: string | null | undefined,
  v2: string | null | undefined
): number {
  const clean1 = cleanVersion(v1);
  const clean2 = cleanVersion(v2);

  if (!clean1 && !clean2) return 0;
  if (!clean1) return -1;
  if (!clean2) return 1;

  const [core1, pre1] = clean1.split('-');
  const [core2, pre2] = clean2.split('-');

  const parts1 = core1.split('.').map((p) => parseInt(p, 10) || 0);
  const parts2 = core2.split('.').map((p) => parseInt(p, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length, 3);
  for (let i = 0; i < maxLen; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  // Pre-release versions have lower precedence than normal version (SemVer spec)
  if (pre1 && !pre2) return -1;
  if (!pre1 && pre2) return 1;
  if (pre1 && pre2) {
    return pre1.localeCompare(pre2);
  }

  return 0;
}

/**
 * Returns true if latest version is strictly greater than current version.
 */
export function isVersionOutdated(
  current: string | null | undefined,
  latest: string | null | undefined
): boolean {
  if (!current || !latest) return false;
  return compareVersions(latest, current) > 0;
}

/**
 * Creates an immutable CritiqueVersionInfo record.
 */
export function createCritiqueVersionInfo(params: {
  currentVersion?: string | null;
  latestVersion?: string | null;
  lastCheckedAt?: number | null;
  resolvedPath?: string | null;
}): CritiqueVersionInfo {
  const current = cleanVersion(params.currentVersion);
  const latest = cleanVersion(params.latestVersion);
  const isInstalled = Boolean(params.resolvedPath);
  const isOutdated = isVersionOutdated(current, latest);

  return Object.freeze({
    currentVersion: current,
    latestVersion: latest,
    lastCheckedAt: params.lastCheckedAt ?? null,
    isOutdated,
    isInstalled,
    resolvedPath: params.resolvedPath ?? null
  });
}

/**
 * Creates an immutable CritiqueInstallResult record.
 */
export function createCritiqueInstallResult(params: {
  success: boolean;
  version?: string | null;
  targetPath?: string | null;
  error?: string | null;
}): CritiqueInstallResult {
  return Object.freeze({
    success: params.success,
    version: cleanVersion(params.version),
    targetPath: params.targetPath ?? null,
    error: params.error ?? null
  });
}
