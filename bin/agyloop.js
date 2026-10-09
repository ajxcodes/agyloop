#!/usr/bin/env node

/**
 * agyloop - Multi-Subagent Development Lifecycle Orchestrator CLI
 *
 * Thin launcher delegating directly to the compiled presentation dispatcher.
 */
const fs = require('fs');
const path = require('path');

function checkStaleDist(baseDir) {
  try {
    const srcDir = path.join(baseDir, 'src');
    if (!fs.existsSync(srcDir)) {
      return;
    }

    const distCliPath = path.join(baseDir, 'dist', 'presentation', 'cli.js');
    if (!fs.existsSync(distCliPath)) {
      return;
    }

    const distStat = fs.statSync(distCliPath);
    let newestSrcMtime = 0;

    function scanDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && fullPath.endsWith('.ts')) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > newestSrcMtime) {
            newestSrcMtime = stat.mtimeMs;
          }
        }
      }
    }

    scanDir(srcDir);

    if (newestSrcMtime > distStat.mtimeMs) {
      console.warn('Notice: src/ contains modifications newer than dist/. Run \'npm run build\' to apply updates.');
    }
  } catch (_err) {
    // Gracefully ignore stat/read errors
  }
}

checkStaleDist(path.join(__dirname, '..'));

const { main, parseArguments, runCli } = require('../dist/presentation/cli');

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { main, parseArguments, runCli, checkStaleDist };
