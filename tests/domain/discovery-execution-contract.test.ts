/**
 * agyloop - DISCOVERY execution contract (issue #389, AC1 / AC4a / AC4c)
 *
 * The DISCOVERY dispatch used to mandate container-only execution while its own
 * evidence contract required a host build, and it named a `### Manual Bug Smoke
 * Test` section the scaffold does not contain. These are contract tests: the
 * directive must describe a MUTATION boundary, offer a runnable container
 * recipe, and name the heading the template actually carries.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  ResolveSubagentUseCase
} = require('../../dist/application');
const {
  DISCOVERY_CONTAINER_IMAGE,
  DISCOVERY_REPRODUCTION_HEADING,
  DISCOVERY_REPRODUCTION_KEY,
  ROOT_BUILD_PROHIBITION_SENTENCE,
  STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE,
  TITLE_DISCOVERY_BOUNDARY_VIOLATION,
  WORKSPACE_MUTATION_WATCHED_ROOTS,
  formatDiscoveryBoundaryFindings,
  formatDiscoveryBoundaryGate,
  formatDiscoveryExecutionContract,
  formatDiscoveryMutationBoundary
} = require('../../dist/domain');

const TEMPLATE_PATH = path.resolve(__dirname, '../../templates/discovery-plan.md');

const CONTAINER_DETECTOR = {
  probeContainerRuntime: () => ({ runtime: 'podman', socketPath: null, connection: 'fork-exec' }),
  resolveContainerRuntime: () => 'podman',
  resolveContainerSocket: () => null
};

const FALLBACK_DETECTOR = {
  resolveContainerRuntime: () => null,
  resolveContainerSocket: () => null
};

const FALLBACK_SENTENCE =
  'Container runtime/daemon is unavailable. Skip empirical smoke execution and fall back cleanly to static RCA code tracing.';

function promptWith(detector: unknown, planDir = 'artifacts/plans/389-smoke'): string {
  const useCase = new ResolveSubagentUseCase({}, undefined, undefined, undefined, detector as never);
  return useCase.buildDiscoveryTaskPrompt({ issueNumber: 389, planDir });
}

describe('D1 — the container-available directive is a mutation boundary (AC1a)', () => {
  test('it states the write boundary and forbids the root rebuild', () => {
    const contract = formatDiscoveryExecutionContract({
      runtime: 'podman',
      planDir: 'artifacts/plans/389-smoke'
    });

    assert.ok(contract.includes('**Mutation Boundary**'));
    assert.ok(contract.includes('every WRITE must land inside `artifacts/plans/389-smoke`'));
    assert.ok(contract.includes('Never rebuild the repository root'));
    assert.ok(contract.includes('the root build is what the installed `codeloop` executes'));
  });

  test('the old container-only mandate is gone from the dispatched prompt', () => {
    const prompt = promptWith(CONTAINER_DETECTOR);

    assert.strictEqual(prompt.includes('can ONLY run containerized invocations'), false);
    assert.strictEqual(prompt.includes('Strict Container-Only Guardrail'), false);
    assert.ok(prompt.includes('**Mutation Boundary**'));
  });
});

describe('D2 — the container workflow is explicit and runnable (AC1b)', () => {
  test('the recipe names the image, a read-only mount and both commands', () => {
    const contract = formatDiscoveryExecutionContract({
      runtime: 'podman',
      planDir: 'artifacts/plans/389-smoke'
    });

    assert.ok(contract.includes(DISCOVERY_CONTAINER_IMAGE));
    assert.ok(contract.includes('-v "$PWD":/repo:ro'));
    assert.ok(
      contract.includes(
        `podman run --rm --network=none -v "$PWD":/repo:ro -w /repo ${DISCOVERY_CONTAINER_IMAGE}`
      )
    );
    assert.ok(
      contract.includes(
        `podman run --rm -v "$PWD":/repo:ro -w /tmp ${DISCOVERY_CONTAINER_IMAGE} bash -lc 'cp -a /repo /tmp/w && cd /tmp/w && npm ci && npm run build'`
      )
    );
    assert.ok(
      contract.includes(
        'If the runtime is unreachable when you run it, fall back to host reads plus static RCA and record why in the report.'
      )
    );
  });

  test('the recipe names the detector runtime rather than a hard-coded one', () => {
    const contract = formatDiscoveryExecutionContract({
      runtime: 'docker',
      planDir: 'artifacts/plans/389-smoke'
    });

    assert.ok(contract.includes('docker run --rm --network=none'));
  });
});

describe('D3 — the deliverable names a heading that exists (AC1c)', () => {
  test('the prompt names the real template heading and key', () => {
    const prompt = promptWith(CONTAINER_DETECTOR);

    assert.ok(prompt.includes(DISCOVERY_REPRODUCTION_HEADING));
    assert.ok(prompt.includes(DISCOVERY_REPRODUCTION_KEY));
    assert.strictEqual(prompt.includes('### Manual Bug Smoke Test'), false);
  });

  test('the template really carries that heading (drift guard)', () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    assert.ok(template.includes(DISCOVERY_REPRODUCTION_HEADING));
    assert.strictEqual(DISCOVERY_REPRODUCTION_HEADING, '## 3. Reproduction Steps & Verification Protocol');
  });
});

describe('D4 — the container-unavailable branch states the SAME boundary (#402 / #295)', () => {
  test('it keeps the fallback wording verbatim AND carries the mutation boundary', () => {
    const planDir = 'artifacts/plans/389-smoke';
    const prompt = promptWith(FALLBACK_DETECTOR);
    const boundary = formatDiscoveryMutationBoundary(planDir);

    // #295's sentence survives verbatim.
    assert.ok(prompt.includes('**Empirical Verification Fallback**'));
    assert.ok(prompt.includes(FALLBACK_SENTENCE));

    // Issue #402, Defect 3: the boundary is stated on the fallback branch too.
    assert.ok(prompt.includes('**Mutation Boundary**'), prompt);
    assert.ok(prompt.includes(boundary), prompt);
    assert.ok(prompt.includes(`every WRITE must land inside \`${planDir}\``), prompt);
    assert.ok(prompt.includes(ROOT_BUILD_PROHIBITION_SENTENCE), prompt);

    // ...without naming the container recipe.
    assert.strictEqual(prompt.includes(DISCOVERY_CONTAINER_IMAGE), false);
    assert.strictEqual(prompt.includes('-v "$PWD":/repo:ro'), false);
    assert.strictEqual(prompt.includes('can ONLY run containerized invocations'), false);
  });
});

describe('D6 — both DISCOVERY branches render one boundary (#402, AC6)', () => {
  test('each branch states read/write scope and the root-build rule; only one carries the recipe', () => {
    const planDir = 'artifacts/plans/402-smoke';
    const containerPrompt = promptWith(CONTAINER_DETECTOR, planDir);
    const hostPrompt = promptWith(FALLBACK_DETECTOR, planDir);
    const boundary = formatDiscoveryMutationBoundary(planDir);

    for (const [label, prompt] of [
      ['container', containerPrompt],
      ['host', hostPrompt]
    ] as Array<[string, string]>) {
      assert.ok(prompt.includes(boundary), `${label}: the shared boundary must be verbatim`);
      assert.ok(prompt.includes('every WRITE must land inside'), label);
      assert.ok(prompt.includes(ROOT_BUILD_PROHIBITION_SENTENCE), label);
      assert.ok(prompt.includes('4. **Deliverable**'), `${label}: numbering must stay contiguous`);
    }

    assert.ok(containerPrompt.includes(DISCOVERY_CONTAINER_IMAGE), 'container branch keeps the recipe');
    assert.ok(containerPrompt.includes('-v "$PWD":/repo:ro'), 'container branch keeps the mount');
    assert.strictEqual(hostPrompt.includes(DISCOVERY_CONTAINER_IMAGE), false);
    assert.strictEqual(hostPrompt.includes('-v "$PWD":/repo:ro'), false);
  });
});

describe('D5 — boundary findings name the installed-CLI consequence (#389, AC3a)', () => {
  test('a dist finding names dist and the root-build consequence', () => {
    const rendered = formatDiscoveryBoundaryFindings([
      {
        rule: STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE,
        path: 'dist/',
        detail: 'root build changed outside the plan directory'
      }
    ]);

    assert.ok(rendered.includes('dist/'));
    assert.ok(rendered.includes('The root build is what the installed `codeloop` executes'));
  });

  test('an artifacts finding does not claim a root-build change', () => {
    const rendered = formatDiscoveryBoundaryFindings([
      {
        rule: STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE,
        path: 'artifacts/',
        detail: 'changed outside the plan directory'
      }
    ]);

    assert.ok(rendered.includes('artifacts/'));
    assert.strictEqual(rendered.includes('The root build is what the installed'), false);
  });

  test('no findings renders nothing at all', () => {
    assert.strictEqual(formatDiscoveryBoundaryFindings([]), '');
  });

  test('the human gate wording names the path and the remediation', () => {
    const gate = formatDiscoveryBoundaryGate([
      {
        rule: 'tracked-write-outside-scope',
        path: 'README.md',
        detail: 'changed outside the plan directory'
      }
    ]);

    assert.ok(gate.includes('README.md'));
    assert.ok(gate.includes('plan directory'));
    assert.ok(gate.includes('codeloop next'));
  });

  test('the gate title and the watched roots are one source of truth', () => {
    assert.strictEqual(TITLE_DISCOVERY_BOUNDARY_VIOLATION, 'Discovery Boundary Violation');
    assert.deepStrictEqual([...WORKSPACE_MUTATION_WATCHED_ROOTS], ['dist', 'build', 'artifacts']);
  });
});
