# AgyLoop Repository Review Standards

This repository adheres to strict software engineering, hexagonal architecture, and quality gate guidelines:

## 1. Hexagonal Architecture & Dependency Inversion

- **Layer Separation**:
  - `src/domain/`: Pure domain entities (`StateMachine`), value objects, domain errors, and constants. 100% free of Node.js built-in I/O modules (`fs`, `child_process`, `net`, `http`, `os`, `path`), external runtime dependencies, or framework coupling.
  - `src/ports/`: Inversion of control interfaces and contracts. Depends exclusively on `src/domain/` or other ports. Zero direct I/O.
  - `src/application/`: Orchestrating use cases (`StartPlanningUseCase`, `RunLifecycleUseCase`, `RunQualityGateUseCase`, `RunReviewUseCase`, `DraftCommitUseCase`, etc.). Depends strictly on `src/domain/` and `src/ports/`. Never imports from `src/infrastructure/` or `src/presentation/`. All I/O occurs via injected Ports.
  - `src/infrastructure/`: Concrete adapters implementing port contracts (e.g. `CliGitHubGateway`, `CliCritiqueGateway`, `FileBuildDetector`, `FileStateRepository`).
  - `src/presentation/`: CLI entrypoints (`bin/agyloop`, `src/presentation/cli.ts`).
- **Fitness Verification**: All boundary invariants are verified continuously by `tests/architecture/hexagonal-boundaries.test.ts`.

## 2. Code Quality & Domain Invariants

- **Zero Magic Constants**: All stages, modes, role names, model tiers, tool whitelists, error codes, command IDs, flags, timeouts, and regex patterns must be defined as named, immutable constants in `src/domain/constants.ts`.
- **Immutability**: Domain entities, value objects, and constant arrays/records must enforce immutability with `readonly` properties and `Object.freeze()`.
- **Sealed Domain Errors**: Custom error hierarchy extending `AgyLoopError` with strongly-typed error codes (`ErrorCode`).
- **Subagent Safety Invariants**:
  - `planner`: Strict physical write suppression (`enable_write_tools: false`, read-only inspection whitelist).
  - `gate`: Verification-only tooling (`run_command`, `view_file`) with log noise shielding and structured summary reporting.
  - `reviewer`: Read-only inspection with `critique` integration and structured verdict reporting.
  - `implementer`: Fresh context handoff strictly loaded from approved plans.

## 3. Testing & Verification

- **Native Test Runner**: Uses Node.js native test runner (`node --test`). Zero external test framework dependencies.
- **100% Pass Rate**: Zero failing or skipped tests. Run via `npm test` and `npm run typecheck`.
- **Deterministic & Isolated**: Unit and application tests must mock infrastructure gateways and command executors.

## 4. Conventional Commits & Releases

- Commits must strictly adhere to the [Conventional Commits](https://www.conventionalcommits.org/) specification (`feat:`, `fix:`, `refactor:`, `chore:`, etc.).
- Commit drafting is automated via `DraftCommitUseCase` / `DiffAnalyzer` and validated against downstream automated tagging.
