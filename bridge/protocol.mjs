export const BRIDGE_VERSION = "0.1.0";
export const PROTOCOL_VERSION = 3;
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 18474;
export const DEFAULT_BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

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
