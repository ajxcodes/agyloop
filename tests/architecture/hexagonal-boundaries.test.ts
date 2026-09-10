/**
 * agyloop - Architecture Fitness Tests: Hexagonal Architecture Boundaries
 *
 * Statically inspects source files and module imports across all architectural layers
 * to enforce strict Hexagonal Boundaries, Dependency Inversion, and zero direct I/O leakage:
 * 1. src/domain/        -> Zero dependencies outside domain, zero direct I/O modules.
 * 2. src/ports/         -> Inversion of control interfaces, depends only on src/domain/.
 * 3. src/application/   -> Depends exclusively on src/domain/ and src/ports/ (zero I/O, zero infrastructure).
 * 4. src/infrastructure/-> Implements contracts defined in src/ports/.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

const IO_MODULES = new Set([
  'fs',
  'node:fs',
  'child_process',
  'node:child_process',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'os',
  'node:os',
  'dgram',
  'node:dgram',
  'cluster',
  'node:cluster'
]);

function getSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getSourceFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      results.push(fullPath);
    }
  }
  return results;
}

interface ImportRecord {
  specifier: string;
  line: number;
  resolvedPath: string | null;
}

function parseImports(filePath: string): ImportRecord[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const imports: ImportRecord[] = [];

  const importRegex = /(?:^|\n)\s*import\s+(?:(?:type\s+)?(?:[\w*\s{},$]+)\s+from\s+)?['"]([^'"]+)['"]/g;
  const exportFromRegex = /(?:^|\n)\s*export\s+(?:type\s+)?(?:(?:\*|\{[^}]*\})\s+from\s+)['"]([^'"]+)['"]/g;
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const specifier = match[1];
    const textBefore = content.substring(0, match.index);
    const line = textBefore.split('\n').length;
    let resolvedPath: string | null = null;
    if (specifier.startsWith('.')) {
      resolvedPath = path.resolve(path.dirname(filePath), specifier);
    }
    imports.push({ specifier, line, resolvedPath });
  }

  while ((match = exportFromRegex.exec(content)) !== null) {
    const specifier = match[1];
    const textBefore = content.substring(0, match.index);
    const line = textBefore.split('\n').length;
    let resolvedPath: string | null = null;
    if (specifier.startsWith('.')) {
      resolvedPath = path.resolve(path.dirname(filePath), specifier);
    }
    imports.push({ specifier, line, resolvedPath });
  }

  while ((match = dynamicImportRegex.exec(content)) !== null) {
    const specifier = match[1];
    const textBefore = content.substring(0, match.index);
    const line = textBefore.split('\n').length;
    let resolvedPath: string | null = null;
    if (specifier.startsWith('.')) {
      resolvedPath = path.resolve(path.dirname(filePath), specifier);
    }
    imports.push({ specifier, line, resolvedPath });
  }

  return imports;
}

describe('Hexagonal Architecture Boundaries & Dependency Inversion Fitness Tests', () => {
  const domainFiles = getSourceFiles(path.join(SRC_DIR, 'domain'));
  const portsFiles = getSourceFiles(path.join(SRC_DIR, 'ports'));
  const applicationFiles = getSourceFiles(path.join(SRC_DIR, 'application'));
  const infrastructureFiles = getSourceFiles(path.join(SRC_DIR, 'infrastructure'));

  test('source directories exist and contain TypeScript modules', () => {
    assert.ok(domainFiles.length > 0, 'Domain layer must contain source files');
    assert.ok(portsFiles.length > 0, 'Ports layer must contain source files');
    assert.ok(applicationFiles.length > 0, 'Application layer must contain source files');
    assert.ok(infrastructureFiles.length > 0, 'Infrastructure layer must contain source files');
  });

  test('Domain Layer (src/domain/): Zero dependencies outside domain and zero direct I/O modules', () => {
    const domainDir = path.join(SRC_DIR, 'domain');

    for (const file of domainFiles) {
      const relFile = path.relative(PROJECT_ROOT, file);
      const imports = parseImports(file);

      for (const imp of imports) {
        // Assert no direct Node.js I/O modules
        assert.strictEqual(
          IO_MODULES.has(imp.specifier),
          false,
          `Domain file '${relFile}:${imp.line}' must not import I/O module '${imp.specifier}'`
        );

        // Assert all imports resolve inside src/domain/
        assert.ok(
          imp.specifier.startsWith('.'),
          `Domain file '${relFile}:${imp.line}' must not import external library '${imp.specifier}'`
        );

        if (imp.resolvedPath) {
          const isInsideDomain =
            imp.resolvedPath.startsWith(domainDir) ||
            imp.resolvedPath.startsWith(domainDir + path.sep);
          assert.ok(
            isInsideDomain,
            `Domain file '${relFile}:${imp.line}' leaks boundary to '${imp.specifier}' (must stay within domain)`
          );
        }
      }
    }
  });

  test('Ports Layer (src/ports/): Depends exclusively on src/domain/ with zero direct I/O modules', () => {
    const domainDir = path.join(SRC_DIR, 'domain');
    const portsDir = path.join(SRC_DIR, 'ports');

    for (const file of portsFiles) {
      const relFile = path.relative(PROJECT_ROOT, file);
      const imports = parseImports(file);

      for (const imp of imports) {
        // Assert no direct I/O imports
        assert.strictEqual(
          IO_MODULES.has(imp.specifier),
          false,
          `Ports file '${relFile}:${imp.line}' must not import I/O module '${imp.specifier}'`
        );

        // Assert relative imports only
        assert.ok(
          imp.specifier.startsWith('.'),
          `Ports file '${relFile}:${imp.line}' must not import external package '${imp.specifier}'`
        );

        if (imp.resolvedPath) {
          const isInsidePorts =
            imp.resolvedPath.startsWith(portsDir) ||
            imp.resolvedPath.startsWith(portsDir + path.sep);
          const isInsideDomain =
            imp.resolvedPath.startsWith(domainDir) ||
            imp.resolvedPath.startsWith(domainDir + path.sep);

          assert.ok(
            isInsidePorts || isInsideDomain,
            `Ports file '${relFile}:${imp.line}' violates boundary: imports '${imp.specifier}'. Ports may only depend on domain or other ports.`
          );
        }
      }
    }
  });

  test('Application Layer (src/application/): Strictly decoupled from infrastructure, presentation, and direct I/O', () => {
    const domainDir = path.join(SRC_DIR, 'domain');
    const portsDir = path.join(SRC_DIR, 'ports');
    const appDir = path.join(SRC_DIR, 'application');

    for (const file of applicationFiles) {
      const relFile = path.relative(PROJECT_ROOT, file);
      const imports = parseImports(file);

      for (const imp of imports) {
        // Assert no direct I/O imports (fs, child_process, net, etc.)
        assert.strictEqual(
          IO_MODULES.has(imp.specifier),
          false,
          `Application file '${relFile}:${imp.line}' violates hexagonal rules: direct I/O import '${imp.specifier}'. Application must use Ports for all I/O.`
        );

        // Assert no path import
        assert.strictEqual(
          imp.specifier === 'path' || imp.specifier === 'node:path',
          false,
          `Application file '${relFile}:${imp.line}' must not import 'path'. Filesystem path resolution belongs in Infrastructure adapters.`
        );

        // Assert imports resolve only within application, domain, or ports
        if (imp.resolvedPath) {
          const isInsideApp =
            imp.resolvedPath.startsWith(appDir) || imp.resolvedPath.startsWith(appDir + path.sep);
          const isInsideDomain =
            imp.resolvedPath.startsWith(domainDir) ||
            imp.resolvedPath.startsWith(domainDir + path.sep);
          const isInsidePorts =
            imp.resolvedPath.startsWith(portsDir) ||
            imp.resolvedPath.startsWith(portsDir + path.sep);

          assert.ok(
            isInsideApp || isInsideDomain || isInsidePorts,
            `Application file '${relFile}:${imp.line}' leaks boundary to '${imp.specifier}'. Allowed layers: domain, ports, application.`
          );

          // Explicitly assert zero imports from infrastructure or presentation
          assert.strictEqual(
            imp.resolvedPath.includes('/infrastructure/'),
            false,
            `Application file '${relFile}:${imp.line}' directly couples to infrastructure adapter '${imp.specifier}'. Enforce Dependency Inversion.`
          );
          assert.strictEqual(
            imp.resolvedPath.includes('/presentation/'),
            false,
            `Application file '${relFile}:${imp.line}' leaks to presentation layer '${imp.specifier}'.`
          );
        }
      }
    }
  });

  test('Infrastructure Layer (src/infrastructure/): Explicitly implements Port contracts', () => {
    interface AdapterCheck {
      adapterFile: string;
      className: string;
      portName: string;
      requiredMethods: string[];
    }

    const expectedAdapters: AdapterCheck[] = [
      {
        adapterFile: 'file-state-repository.ts',
        className: 'FileStateRepository',
        portName: 'StateRepository',
        requiredMethods: ['load', 'save', 'reset', 'getStateFilePath']
      },
      {
        adapterFile: 'cli-github-gateway.ts',
        className: 'CliGitHubGateway',
        portName: 'GitHubGateway',
        requiredMethods: ['getCurrentRepo', 'fetchIssue']
      },
      {
        adapterFile: 'file-config-repository.ts',
        className: 'FileConfigRepository',
        portName: 'ConfigRepository',
        requiredMethods: ['loadConfig', 'resolveModel', 'mapModelToTier']
      },
      {
        adapterFile: 'gemini-model-catalog.ts',
        className: 'GeminiModelCatalog',
        portName: 'ModelCatalogPort',
        requiredMethods: ['fetchModels', 'getStaticModels']
      },
      {
        adapterFile: 'file-plan-generator.ts',
        className: 'FilePlanGenerator',
        portName: 'PlanGeneratorPort',
        requiredMethods: [
          'scaffoldPlanDirectory',
          'generatePlan',
          'generateSummaryLog',
          'updateSummaryLog',
          'findPlanDirectory',
          'resolvePlanFile',
          'readPlanDocument'
        ]
      },
      {
        adapterFile: 'file-prompt-repository.ts',
        className: 'FilePromptRepository',
        portName: 'PromptRepository',
        requiredMethods: ['loadPrompt']
      },
      {
        adapterFile: 'process-command-executor.ts',
        className: 'ProcessCommandExecutor',
        portName: 'CommandExecutorPort',
        requiredMethods: ['execute']
      },
      {
        adapterFile: 'file-build-detector.ts',
        className: 'FileBuildDetector',
        portName: 'BuildDetectorPort',
        requiredMethods: ['detect', 'resolveCommands']
      }
    ];


    for (const check of expectedAdapters) {
      const fullPath = path.join(SRC_DIR, 'infrastructure', check.adapterFile);
      assert.ok(fs.existsSync(fullPath), `Infrastructure adapter file '${check.adapterFile}' must exist`);

      const content = fs.readFileSync(fullPath, 'utf8');
      const implementsRegex = new RegExp(
        `class\\s+${check.className}(?:\\s+extends\\s+\\w+)?\\s+implements\\s+([^\\{]+)\\{`
      );
      const match = content.match(implementsRegex);

      assert.ok(
        match !== null,
        `Class '${check.className}' must be declared with an 'implements' clause in '${check.adapterFile}'`
      );

      const implementedPorts = match[1].split(',').map((s: string) => s.trim());
      assert.ok(
        implementedPorts.includes(check.portName),
        `Class '${check.className}' in '${check.adapterFile}' must implement port '${check.portName}' (found: ${implementedPorts.join(', ')})`
      );

      // Verify runtime instantiation and method presence
      const infraModule = require(path.join(PROJECT_ROOT, 'dist', 'infrastructure', check.adapterFile.replace('.ts', '.js')));
      const AdapterConstructor = infraModule[check.className];
      assert.ok(typeof AdapterConstructor === 'function', `Adapter '${check.className}' must be exported as a class/function`);

      const instance = new AdapterConstructor();
      for (const method of check.requiredMethods) {
        assert.strictEqual(
          typeof instance[method],
          'function',
          `Adapter '${check.className}' must implement required port method '${method}'`
        );
      }
    }
  });
});
