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
  LegacyLayout,
  GitIgnoreChange,
  VerificationConfig,
  VerificationCommandConfig
} from '../ports';
import {
  CODELOOP_STATE_DIR,
  CODELOOP_CONFIG_FILE,
  DEFAULT_SMOKE_TIMEOUT_SECONDS
} from '../domain';

const MONOREPO_FILES = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'];
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
const BACKEND_MARKERS = ['backend', 'server', 'api', 'apps/api', 'apps/server', 'services'];
const FRONTEND_MARKERS = ['frontend', 'client', 'web', 'apps/web', 'apps/frontend'];
const IGNORE_HEADER = '# codeloop / agyloop ephemeral runtime state';

export class FileProjectScaffolder implements ProjectScaffolderPort {
  public async detectMarkers(workspaceDir: string): Promise<ProjectMarkers> {
    const has = (rel: string): boolean => fs.existsSync(path.join(workspaceDir, rel));
    const firstMatch = (list: readonly { name: string; markers: readonly string[] }[]): string | null => {
      for (const item of list) {
        if (item.markers.some(has)) return item.name;
      }
      return null;
    };

    let packageScripts: Record<string, string> = {};
    let deps: Record<string, unknown> = {};
    let hasWorkspaces = false;
    const pkgPath = path.join(workspaceDir, 'package.json');
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

    let migrationTool = firstMatch(MIGRATION_TOOLS);
    if (!migrationTool && (deps.prisma || deps['@prisma/client'])) migrationTool = 'prisma';
    let e2eTool = firstMatch(E2E_TOOLS);
    if (!e2eTool && deps['@playwright/test']) e2eTool = 'playwright';
    if (!e2eTool && deps.cypress) e2eTool = 'cypress';

    return {
      monorepo: hasWorkspaces || MONOREPO_FILES.some(has),
      dockerCompose: COMPOSE_FILES.some(has),
      migrationTool,
      e2eTool,
      hasBackendMarkers: BACKEND_MARKERS.some(has),
      hasFrontendMarkers: FRONTEND_MARKERS.some(has),
      packageScripts
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

    const hasServices = markers.dockerCompose || markers.migrationTool !== null || markers.e2eTool !== null;
    if (hasServices) {
      if (markers.dockerCompose) {
        setup = 'docker compose up -d';
        teardown = 'docker compose down';
      }
      if (markers.migrationTool) {
        const migrate = this.migrationCommand(markers.migrationTool);
        setup = setup ? `${setup} && ${migrate.apply}` : migrate.apply;
        steps.push({ id: 'db-status', label: 'Database migration status', command: migrate.status });
      }
      if (markers.hasBackendMarkers || markers.dockerCompose) {
        steps.push({
          id: 'api-health',
          label: 'API Health (placeholder: adjust URL)',
          command: markers.packageScripts['health'] ? 'npm run health' : 'curl -fsS http://localhost:3000/health'
        });
      }
      if (markers.e2eTool) {
        const scriptKey = ['test:e2e', 'e2e:smoke', 'e2e'].find((k) => markers.packageScripts[k]);
        steps.push({
          id: 'e2e-smoke',
          label: 'E2E smoke test',
          command: scriptKey
            ? `npm run ${scriptKey}`
            : markers.e2eTool === 'cypress'
              ? 'npx cypress run'
              : 'npx playwright test --grep @smoke'
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

    return { ecosystem, fastCheck, smoke, gates };
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
    const isBlanket = (l: string): string | null => {
      const k = key(l).replace(/\/\*$/, '');
      return blanketDirs.includes(k) && !l.trim().startsWith('!') && !l.trim().startsWith('#') ? k : null;
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
