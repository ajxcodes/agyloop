## Description
When running `bin/agyloop <issue>` for a Feature task, the orchestrator is supposed to bypass the `DISCOVERY` stage and transition to the `PLAN` stage so the Planner subagent can be invoked. However, in `src/application/start-planning.ts`, the code transitions to `STAGE_PLAN` and immediately transitions to `STAGE_APPROVAL` in the same execution tick:

```typescript
if (!isBug) {
  sm.transition(STAGE_PLAN, { note: NOTE_GENERATING_SPECS });
  sm.transition(STAGE_APPROVAL, { note: NOTE_AWAITING_REVIEW });
}
```

## Observed Impact
Because the pipeline state machine never pauses at `PLAN`, the orchestrator agent querying `bin/agyloop next --json` never sees the `PLAN` stage. Thus, the `planner` subagent is completely skipped for feature tasks, leaving the generated `implementation_plan.md` empty.

## Expected Behavior
The pipeline should transition to `PLAN` and pause there for non-bug tasks, so the Planner subagent can be correctly invoked.
