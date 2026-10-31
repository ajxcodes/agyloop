#### Check 1 — the recorded tests cell must be PASSED (1 passed)

```bash
SBX="$(mktemp -d "$HOME/.cache/agyloop/smoke-413-fixture-XXXXXX")"
mkdir -p "$SBX/ws"
node -e 'require("fs").writeFileSync(process.argv[1], "GATE_REPORT_JSON: " + JSON.stringify({ verdict: "PASSED", buildSystem: "npm", buildStatus: "PASSED", testsStatus: "PASSED (1 passed)", testsPassed: 1, executedCommands: ["npm test"], commandResults: [{ command: "npm test", passed: 0, failed: 0 }] }, null, 2))' "$SBX/ws/gate.json"
node -e 'const {GateResultReport,normaliseGateTests}=require("./dist/domain");const r=GateResultReport.parseBlock(require("fs").readFileSync(process.argv[1],"utf8"));if(normaliseGateTests(r).testsStatus!=="PASSED (1 passed)")process.exit(1)' "$SBX/ws/gate.json"
rm -rf "$SBX"
```
