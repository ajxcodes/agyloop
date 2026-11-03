/**
 * agyloop - FileProjectScaffolder Infrastructure Adapter
 *
 * Implements ProjectScaffolderPort using the local filesystem.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ProjectScaffolderPort,
  ProjectMarkers,
  SubprojectMarkers,
  LegacyLayout,
  GitIgnoreChange,
  VerificationConfig,
  VerificationCommandConfig
} from '../ports';
import {
  CODELOOP_STATE_DIR,
  CODELOOP_CONFIG_FILE,
  DEFAULT_SMOKE_TIMEOUT_SECONDS,
  MARKER_PACKAGE_JSON,
  MARKER_PNPM_LOCK,
  MARKER_YARN_LOCK,
  MARKER_BUN_LOCK,
  MARKER_PACKAGE_LOCK,
  MARKER_PNPM_WORKSPACE,
  MARKER_TURBO_JSON,
  MARKER_NX_JSON,
  MARKER_LERNA_JSON,
  PKG_MGR_PNPM,
  PKG_MGR_YARN,
  PKG_MGR_BUN,
  PKG_MGR_NPM,
  ECOSYSTEM_NODE,
  ECOSYSTEM_GO,
  ECOSYSTEM_RUST,
  ECOSYSTEM_PYTHON,
  ECOSYSTEM_GRADLE,
  ECOSYSTEM_MAVEN,
  ECOSYSTEM_DOTNET
} from '../domain';
import {
  classifyDirectory,
  discoverSubprojects,
  scanDirectory,
  withWorkingDirectory
} from './workspace-discovery';

const MONOREPO_FILES = [
  MARKER_PNPM_WORKSPACE,
  MARKER_TURBO_JSON,
  MARKER_NX_JSON,
  MARKER_LERNA_JSON
];
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const MIGRATION_TOOLS: readonly { name: string; markers: readonly string[] }[] = [
  { name: 'prisma', markers: ['prisma'] },
  { name: 'drizzle', markers: ['drizzle', 'drizzle.config.ts', 'drizzle.config.js'] },
  { name: 'alembic', markers: ['alembic', 'alembic.ini'] },
  { name: 'knex', markers: ['knexfile.js', 'knexfile.ts'] },
  { name: 'diesel', markers: ['diesel.toml'] },
  { name: 'flyway', markers: ['flyway.conf'] },
  { name: 'liquibase', markers: ['liquibase.properties'] }
];
const E2E_TOOLS: readonly { name: string; markers: readonly string[] }[] = [
  { name: 'playwright', markers: ['playwright.config.ts', 'playwright.config.js'] },
  { name: 'cypress', markers: ['cypress.config.ts', 'cypress.config.js', 'cypress'] }
];
const E2E_SCRIPT_CANDIDATES = ['test:e2e', 'e2e:smoke', 'e2e'];
const BACKEND_MARKERS = ['backend', 'server', 'api', 'apps/api', 'apps/server', 'services'];
const FRONTEND_MARKERS = ['frontend', 'client', 'web', 'apps/web', 'apps/frontend'];
const IGNORE_HEADER = '# codeloop / agyloop ephemeral runtime state';

/** Ecosystem types present in one directory, in canonical priority order (#334). */
function ecosystemTypesFor(fileNames: ReadonlySet<string>): string[] {
  const markers = classifyDirectory(fileNames);
  const types: string[] = [];
  if (markers.node) types.push(ECOSYSTEM_NODE);
  if (markers.go) types.push(ECOSYSTEM_GO);
  if (markers.rust) types.push(ECOSYSTEM_RUST);
  if (markers.python.length > 0) types.push(ECOSYSTEM_PYTHON);
  if (markers.gradle.length > 0) types.push(ECOSYSTEM_GRADLE);
  if (markers.maven) types.push(ECOSYSTEM_MAVEN);
  if (markers.dotnet.length > 0) types.push(ECOSYSTEM_DOTNET);
  return types;
}

/** Package manager declared by a directory's own lockfile, or null (#334). */
function lockfilePackageManager(fileNames: ReadonlySet<string>): string | null {
  if (fileNames.has(MARKER_PNPM_LOCK)) return PKG_MGR_PNPM;
  if (fileNames.has(MARKER_YARN_LOCK)) return PKG_MGR_YARN;
  if (fileNames.has(MARKER_BUN_LOCK)) return PKG_MGR_BUN;
  if (fileNames.has(MARKER_PACKAGE_LOCK)) return PKG_MGR_NPM;
  return null;
}

/** Reads one directory's `package.json` scripts, tolerating malformed JSON. */
function readPackageScriptsAt(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, MARKER_PACKAGE_JSON), 'utf8')
    ) as Record<string, unknown>;
    const scripts = pkg?.scripts;
    if (scripts && typeof scripts === 'object') {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(scripts)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    }
  } catch {
    // A malformed or absent package.json contributes no scripts.
  }
  return {};
}

export class FileProjectScaffolder implements ProjectScaffolderPort {
  public async detectMarkers(workspaceDir: string): Promise<ProjectMarkers> {
    const rootFileNames = scanDirectory(workspaceDir);
    const has = (rel: string): boolean => fs.existsSync(path.join(workspaceDir, rel));
    const findTool = (
      list: readonly { name: string; markers: readonly string[] }[],
      dir: string
    ): string | null => {
      for (const item of list) {
        if (item.markers.some((marker) => fs.existsSync(path.join(dir, marker)))) {
          return item.name;
        }
      }
      return null;
    };

    let packageScripts: Record<string, string> = {};
    let deps: Record<string, unknown> = {};
    let hasWorkspaces = false;
    const pkgPath = path.join(workspaceDir, MARKER_PACKAGE_JSON);
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
        const scripts = pkg.scripts as Record<string, unknown> | undefined;
        if (scripts && typeof scripts === 'object') {
          for (const [k, v] of Object.entries(scripts)) {
            if (typeof v === 'string') packageScripts[k] = v;
          }
        }
        deps = {
          ...((pkg.dependencies as Record<string, unknown>) || {}),
          ...((pkg.devDependencies as Record<string, unknown>) || {})
        };
        hasWorkspaces = Boolean(pkg.workspaces);
      } catch {
        packageScripts = {};
      }
    }

    // Discovery is shared with the build detector, so the gate list and the
    // marker verdict can never disagree about what the repository contains.
    let discovered: ReturnType<typeof discoverSubprojects>;
    try {
      discovered = discoverSubprojects(workspaceDir, rootFileNames);
    } catch {
      discovered = [];
    }

    const subprojects: SubprojectMarkers[] = discovered.map((subproject) => ({
      path: subproject.relDir,
      ecosystems: ecosystemTypesFor(subproject.fileNames),
      packageManager: lockfilePackageManager(subproject.fileNames),
      scripts: readPackageScriptsAt(subproject.dir),
      e2eTool: findTool(E2E_TOOLS, subproject.dir),
      migrationTool: findTool(MIGRATION_TOOLS, subproject.dir)
    }));

    let migrationTool = findTool(MIGRATION_TOOLS, workspaceDir);
    let migrationPath: string | null = null;
    if (!migrationTool && (deps.prisma || deps['@prisma/client'])) migrationTool = 'prisma';
    let e2eTool = findTool(E2E_TOOLS, workspaceDir);
    let e2ePath: string | null = null;
    if (!e2eTool && deps['@playwright/test']) e2eTool = 'playwright';
    if (!e2eTool && deps.cypress) e2eTool = 'cypress';

    // Root first, then discovered subprojects in sorted path order: first hit wins.
    if (!migrationTool) {
      const hit = subprojects.find((subproject) => subproject.migrationTool !== null);
      if (hit) {
        migrationTool = hit.migrationTool;
        migrationPath = hit.path;
      }
    }
    if (!e2eTool) {
      const hit = subprojects.find((subproject) => subproject.e2eTool !== null);
      if (hit) {
        e2eTool = hit.e2eTool;
        e2ePath = hit.path;
      }
    }

    return {
      monorepo: hasWorkspaces || MONOREPO_FILES.some((file) => rootFileNames.has(file)) || subprojects.length >= 2,
      dockerCompose: COMPOSE_FILES.some(has),
      migrationTool,
      migrationPath,
      e2eTool,
      e2ePath,
      packageManager:
        lockfilePackageManager(rootFileNames) ??
        (rootFileNames.has(MARKER_PNPM_WORKSPACE) ? PKG_MGR_PNPM : null),
      hasBackendMarkers: BACKEND_MARKERS.some(has),
      hasFrontendMarkers: FRONTEND_MARKERS.some(has),
      packageScripts,
      subprojects
    };
  }

  public buildVerificationProfile(
    markers: ProjectMarkers,
    ecosystem: string,
    gateCommands: readonly { id: string; label: string; command: string }[]
  ): VerificationConfig {
    const gates: VerificationCommandConfig[] = gateCommands.map((g) => ({
      id: g.id,
      label: g.label,
      command: g.command
    }));
    const fastCheck = gates.filter((g) => /typecheck|tsc|lint|check|clippy|vet/i.test(`${g.id} ${g.command}`));

    const testGate = gates.find((g) => /test/i.test(`${g.id} ${g.command}`));
    const steps: VerificationCommandConfig[] = [];
    let setup: string | undefined;
    let teardown: string | undefined;

    const subprojects = markers.subprojects ?? [];
    const subprojectAt = (relDir: string | null): SubprojectMarkers | null =>
      relDir === null ? null : subprojects.find((subproject) => subproject.path === relDir) ?? null;
    const packageManagerAt = (relDir: string | null): string =>
      subprojectAt(relDir)?.packageManager ?? markers.packageManager ?? PKG_MGR_NPM;
    const scriptsAt = (relDir: string | null): Readonly<Record<string, string>> =>
      subprojectAt(relDir)?.scripts ?? markers.packageScripts;

    const hasServices = markers.dockerCompose || markers.migrationTool !== null || markers.e2eTool !== null;
    if (hasServices) {
      if (markers.dockerCompose) {
        setup = 'docker compose up -d';
        teardown = 'docker compose down';
      }
      if (markers.migrationTool) {
        const migrate = this.migrationCommand(markers.migrationTool);
        const migrationPath = markers.migrationPath ?? null;
        const apply = withWorkingDirectory(migrationPath ?? '', migrate.apply);
        setup = setup ? `${setup} && ${apply}` : apply;
        steps.push({
          id: 'db-status',
          label: 'Database migration status',
          command: withWorkingDirectory(migrationPath ?? '', migrate.status)
        });
      }
      if (markers.hasBackendMarkers || markers.dockerCompose) {
        steps.push({
          id: 'api-health',
          label: 'API Health (placeholder: adjust URL)',
          command: markers.packageScripts['health'] ? 'npm run health' : 'curl -fsS http://localhost:3000/health'
        });
      }
      if (markers.e2eTool) {
        const e2ePath = markers.e2ePath ?? null;
        const scriptKey = E2E_SCRIPT_CANDIDATES.find((key) => scriptsAt(e2ePath)[key]);
        const e2eCommand = scriptKey
          ? `${packageManagerAt(e2ePath)} run ${scriptKey}`
          : markers.e2eTool === 'cypress'
            ? 'npx cypress run'
            : 'npx playwright test --grep @smoke';
        steps.push({
          id: 'e2e-smoke',
          label: 'E2E smoke test',
          command: withWorkingDirectory(e2ePath ?? '', e2eCommand)
        });
      }
    } else if (testGate) {
      steps.push({ id: testGate.id, label: testGate.label, command: testGate.command });
    }

    const smoke = {
      ...(setup ? { setup } : {}),
      ...(teardown ? { teardown } : {}),
      timeoutSeconds: DEFAULT_SMOKE_TIMEOUT_SECONDS,
      steps
    };

    return {
      ecosystem,
      monorepo: markers.monorepo,
      markers: {
        dockerCompose: markers.dockerCompose,
        migrationTool: markers.migrationTool,
        e2eTool: markers.e2eTool
      },
      ...(subprojects.length > 0
        ? {
            subprojects: subprojects.map((subproject) => ({
              path: subproject.path,
              ecosystems: subproject.ecosystems
            }))
          }
        : {}),
      fastCheck,
      smoke,
      gates
    };
  }

  private migrationCommand(tool: string): { apply: string; status: string } {
    switch (tool) {
      case 'prisma':
        return { apply: 'npx prisma migrate deploy', status: 'npx prisma migrate status' };
      case 'drizzle':
        return { apply: 'npx drizzle-kit migrate', status: 'npx drizzle-kit check' };
      case 'alembic':
        return { apply: 'alembic upgrade head', status: 'alembic current' };
      case 'knex':
        return { apply: 'npx knex migrate:latest', status: 'npx knex migrate:status' };
      case 'diesel':
        return { apply: 'diesel migration run', status: 'diesel migration list' };
      case 'flyway':
        return { apply: 'flyway migrate', status: 'flyway info' };
      default:
        return { apply: 'liquibase update', status: 'liquibase status' };
    }
  }

  public getConfigPath(workspaceDir: string): string {
    return path.join(workspaceDir, CODELOOP_STATE_DIR, CODELOOP_CONFIG_FILE);
  }

  public getLegacyConfigPaths(workspaceDir: string): string[] {
    return [path.join(workspaceDir, '.agyloop', 'config.json'), path.join(workspaceDir, '.agyloop.json')];
  }

  public findExistingConfig(workspaceDir: string): string | null {
    const candidates = [
      path.join(workspaceDir, CODELOOP_STATE_DIR, CODELOOP_CONFIG_FILE),
      path.join(workspaceDir, '.codeloop.json'),
      path.join(workspaceDir, '.agyloop', 'config.json'),
      path.join(workspaceDir, '.agyloop.json')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  public detectLegacyLayout(workspaceDir: string): LegacyLayout {
    const legacyCandidates = [
      path.join(workspaceDir, '.agyloop', 'config.json'),
      path.join(workspaceDir, '.agyloop.json')
    ];
    return {
      legacyConfigPath: legacyCandidates.find((c) => fs.existsSync(c)) || null,
      legacyStateDirExists: fs.existsSync(path.join(workspaceDir, '.agyloop'))
    };
  }

  public writeConfig(workspaceDir: string, config: unknown): string {
    const dir = path.join(workspaceDir, CODELOOP_STATE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, CODELOOP_CONFIG_FILE);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return target;
  }

  public readConfig(configPath: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  public updateGitIgnore(workspaceDir: string, rules: readonly string[]): GitIgnoreChange {
    const plan = this.planGitIgnore(workspaceDir, rules);
    if (plan.content !== null) {
      fs.writeFileSync(path.join(workspaceDir, '.gitignore'), plan.content, 'utf8');
    }
    return {
      added: plan.added,
      replaced: plan.replaced,
      ...(plan.warnings && plan.warnings.length > 0 ? { warnings: plan.warnings } : {})
    };
  }

  public previewGitIgnore(workspaceDir: string, rules: readonly string[]): GitIgnoreChange {
    const plan = this.planGitIgnore(workspaceDir, rules);
    return {
      added: plan.added,
      replaced: plan.replaced,
      ...(plan.warnings && plan.warnings.length > 0 ? { warnings: plan.warnings } : {})
    };
  }

  private planGitIgnore(
    workspaceDir: string,
    rules: readonly string[]
  ): { content: string | null; added: string[]; replaced: string[]; warnings?: string[] } {
    const giPath = path.join(workspaceDir, '.gitignore');
    const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const key = (l: string): string => l.trim().replace(/^\//, '').replace(/\/$/, '');
    const safeRules = rules.filter((r) => !/config\.json$/.test(r));
    const blanketDirs = ['.codeloop', '.agyloop'];
    // Managed symlink-safe pairs (#221): a bare state-dir entry the rule set pairs with a
    // `!<dir>/` re-inclusion. That bare entry is deliberate (it matches the `.agyloop`
    // symlink git stores as mode 120000), and the negation keeps `config.json` trackable,
    // so it must not be treated as a user blanket to swap out.
    const pairedNegations = new Set(
      rules
        .map((r) => r.trim())
        .filter((r) => r.startsWith('!') && r.endsWith('/'))
        .map((r) => key(r))
    );
    const isBlanket = (l: string): string | null => {
      const k = key(l).replace(/\/\*$/, '');
      if (!blanketDirs.includes(k)) return null;
      if (l.trim().startsWith('!') || l.trim().startsWith('#')) return null;
      if (pairedNegations.has(`!${k}`)) return null;
      return k;
    };

    const isIndirectIgnore = (line: string): boolean => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('!')) return false;
      const k = key(line);
      if (k === '.*') return true;
      if (/^\.?(?:codeloop|agyloop)\*/.test(k)) return true;
      if (k.includes('**/.codeloop') || k.includes('**/.agyloop')) return true;
      if (/^\.?(?:codeloop|agyloop)\/\*\*/.test(k)) return true;
      return false;
    };

    const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const present = new Set(lines.map(key).filter(Boolean));

    const indirectMatches: string[] = [];
    for (const l of lines) {
      if (isIndirectIgnore(l)) {
        indirectMatches.push(l.trim());
      }
    }
    const hasIndirect = indirectMatches.length > 0;
    const dirNegations = ['!.codeloop/', '!.agyloop/'];

    const added: string[] = [];
    const replaced: string[] = [];
    const outLines: string[] = [];
    for (const line of lines) {
      const dir = isBlanket(line);
      if (dir === null) {
        outLines.push(line);
        continue;
      }
      // A negation cannot re-include a file whose parent directory is ignored: swap for granular rules.
      replaced.push(line.trim());
      if (hasIndirect) {
        for (const neg of dirNegations) {
          if (!present.has(key(neg))) {
            outLines.push(neg);
            present.add(key(neg));
            added.push(neg);
          }
        }
      }
      for (const r of safeRules) {
        if (r.startsWith(`${dir}/`) && !present.has(key(r))) {
          outLines.push(r);
          present.add(key(r));
          added.push(r);
        }
      }
    }

    const tail: string[] = [];
    if (hasIndirect) {
      for (const neg of dirNegations) {
        // Skip a negation the managed rule set already carries: `safeRules` emits it in
        // rule order so it lands *after* its bare `.agyloop` counterpart. Emitting it here
        // would place it before that bare entry, which then re-excludes the directory and
        // hides `.agyloop/config.json` again (#221).
        if (safeRules.includes(neg)) continue;
        if (!present.has(key(neg))) {
          tail.push(neg);
          present.add(key(neg));
          added.push(neg);
        }
      }
    }
    for (const r of safeRules) {
      if (!present.has(key(r))) {
        tail.push(r);
        present.add(key(r));
        added.push(r);
      }
    }

    // Bare config.json / *.json / **/config.json ignores: lowest-risk fix is re-including the tracked config files.
    const broad = lines.some((l) => ['config.json', '*.json', '**/config.json'].includes(key(l)) && !l.trim().startsWith('!'));
    if (broad) {
      for (const neg of ['!.codeloop/config.json', '!.agyloop/config.json']) {
        if (!lines.some((l) => l.trim() === neg)) {
          tail.push(neg);
          added.push(neg);
        }
      }
    }

    if (added.length === 0 && replaced.length === 0) {
      return { content: null, added, replaced };
    }

    const warnings: string[] = [];
    if (hasIndirect) {
      warnings.push(
        `Detected broad or indirect ignore pattern(s) (${indirectMatches.join(', ')}). Appended !.codeloop/ and !.agyloop/ negations before granular rules to prevent config loss.`
      );
    }

    let out = outLines.join(eol);
    if (tail.length > 0) {
      const header = lines.includes(IGNORE_HEADER) ? [] : [IGNORE_HEADER];
      out += (out.length > 0 ? eol + eol : '') + [...header, ...tail].join(eol);
    }
    return {
      content: out + eol,
      added,
      replaced,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }
}
