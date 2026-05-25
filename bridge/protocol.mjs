export const BRIDGE_VERSION = "0.1.0";
export const PROTOCOL_VERSION = 2;

export const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "stale_arm"
];

export const COMMAND_STATUSES = [
  "queued",
  "leased",
  "running",
  ...TERMINAL_STATUSES
];
