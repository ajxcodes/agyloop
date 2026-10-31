#### Check 1 — the recorded tests cell is PASSED (1 passed)

```bash
SBX="$(mktemp -d "$HOME/.cache/agyloop/smoke-413-fixture-XXXXXX")"
mkdir -p "$SBX/ws"
node -e 'require("fs").writeFileSync(process.argv[1], "GATE_REPORT_JSON: " + JSON.stringify({ verdict: "PASSED", buildSystem: "npm", buildStatus: "PASSED", testsStatus: "PASSED (1 passed)", testsPassed: 1, executedCommands: ["npm test"], commandResults: [{ command: "npm test", passed: 1, failed: 0 }] }, null, 2))' "$SBX/ws/gate.json"
node -e 'const {GateResultReport,normaliseGateTests}=require("./dist/domain");const r=GateResultReport.parseBlock(require("fs").readFileSync(process.argv[1],"utf8"));if(normaliseGateTests(r).testsStatus!=="PASSED (1 passed)")process.exit(1)' "$SBX/ws/gate.json"
rm -rf "$SBX"
```

#### Check 2 — worktree mismatch is refused

```bash
SBX="$(mktemp -d "$HOME/.cache/agyloop/smoke-413-fixture-XXXXXX")"
mkdir -p "$SBX/.worktrees/999/probe"
( cd "$SBX/.worktrees/999/probe" && node bin/codeloop.js transition REVIEW --issue 413 2>&1 | grep -q 'Cannot save state for issue 413 from inside worktree for issue 999' )
rm -rf "$SBX"
```

#### Check 3 — gate-report records a marker-bearing report

```bash
SBX="$(mktemp -d "$HOME/.cache/agyloop/smoke-413-fixture-XXXXXX")"
mkdir -p "$SBX/ws"
node -e 'require("fs").writeFileSync(process.argv[1], "GATE_REPORT_JSON:\n" + JSON.stringify({ verdict: "PASSED", buildSystem: "npm", buildStatus: "PASSED", testsStatus: "PASSED (0 passed)", testsPassed: 0, executedCommands: ["npm test"] }, null, 2))' "$SBX/ws/gate.json"
node bin/codeloop.js gate-report --issue 413 --workspace "$SBX/ws" --report-file "$SBX/ws/gate.json" 2>&1 | grep -q 'npm test'
rm -rf "$SBX"
```
