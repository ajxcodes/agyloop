#### Check 3 — gate-report records a zero-test PASSED block

```bash
SBX="$(mktemp -d "$HOME/.cache/agyloop/smoke-413-fixture-XXXXXX")"
mkdir -p "$SBX/ws"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ verdict: "PASSED", buildSystem: "npm", buildStatus: "PASSED", testsStatus: "PASSED (0 passed)", testsPassed: 0, executedCommands: ["npm test"] }, null, 2))' "$SBX/ws/gate.json"
node bin/codeloop.js gate-report --issue 413 --workspace "$SBX/ws" --report-file "$SBX/ws/gate.json" 2>&1 | grep -q 'npm test'
rm -rf "$SBX"
```
