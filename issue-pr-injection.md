## Description
During `bin/agyloop commit -y`, the application generates a shell script to help the user create a PR (`Next Step (Create PR)`). This script is built via string concatenation in `src/application/execute-commit.ts`:
```typescript
prCommandCore += ` --title "${sanitizedTitle}" --body "${sanitizedBody}"`;
```
While double quotes are escaped using `.replace(/"/g, '\"')`, backticks (\`) and unescaped dollar signs (`$`) are not. If the commit message body contains these shell-special characters, evaluating the generated script will cause bash to execute them, leading to arbitrary command injection on the user's host machine.

## Impact
If an AI agent or a user includes backticks in a commit message (e.g., formatting code), the resulting `gh pr create` script outputted by the orchestrator will contain those backticks unescaped within double quotes, causing bash to evaluate them when the script is executed.

## Recommended Fix
Similar to issue #150, avoid relying on double-quoted string concatenation for shell scripts that include arbitrary text. For the PR creation script, consider recommending `-F <file>` to pass the body, or generating a script that uses single quotes and properly escapes inner single quotes.
