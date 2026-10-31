#### Check 2 — worktree mismatch is refused

```bash
SBX="$(mktemp -d "$HOME/.cache/agyloop/smoke-413-fixture-XXXXXX")"
mkdir -p "$SBX/.worktrees/999-probe"
( cd "$SBX/.worktrees/999-probe" && node bin/codeloop.js transition REVIEW --issue 413 2>&1 | grep -q 'Cannot save state for issue 413 from inside worktree for issue 999' )
rm -rf "$SBX"
```
