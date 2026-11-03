#!/usr/bin/env node
'use strict';

/**
 * Writes `dist/build-stamp.json` after `tsc` (package.json `postbuild`).
 *
 * The stamp is the content address the stale-build guard compares against
 * (issue #492): a SHA-256 over every TypeScript file under `src/`. Content, not
 * mtimes, so an npm-installed or extracted copy is never falsely stale, and a
 * preserved-timestamp unpack cannot hide a genuinely stale build.
 *
 * This module must never import `dist/`.
 */
const path = require('path');
const { BUILD_STAMP_RELPATH, writeBuildStamp } = require('./stale-dist');

const baseDir = path.join(__dirname, '..');

try {
  const srcHash = writeBuildStamp(baseDir);
  console.log(`Wrote ${BUILD_STAMP_RELPATH} (src ${srcHash.slice(0, 12)}...)`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`✗ Could not write ${BUILD_STAMP_RELPATH}: ${message}`);
  process.exit(1);
}
