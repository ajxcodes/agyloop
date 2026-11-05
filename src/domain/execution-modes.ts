/* eslint-disable @typescript-eslint/no-unused-vars */

export const MODE_STANDARD = 'standard' as const;

export const MODE_PLAN = 'plan' as const;

export const MODE_IMPLEMENT = 'implement' as const;

export const MODE_COMMIT = 'commit' as const;

export const MODE_YOLO = 'yolo' as const;


export const EXECUTION_MODES = Object.freeze({
  STANDARD: MODE_STANDARD,
  PLAN: MODE_PLAN,
  IMPLEMENT: MODE_IMPLEMENT,
  COMMIT: MODE_COMMIT,
  YOLO: MODE_YOLO
});


export type ExecutionMode = typeof EXECUTION_MODES[keyof typeof EXECUTION_MODES];
