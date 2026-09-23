import { BRIDGE_HOST, BRIDGE_PORT, DEFAULT_BRIDGE_URL } from "./protocol.mjs";

export function assertLoopbackBridgeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error(`Bridge URL is invalid: ${value}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(`Bridge URL must be ${DEFAULT_BRIDGE_URL}.`);
  }
  if (parsed.hostname !== BRIDGE_HOST) {
    throw new Error(
      `Bridge URL host must be ${BRIDGE_HOST}. The extension is pinned to that loopback address and does not follow localhost, other hosts, or custom ports.`
    );
  }
  if ((parsed.port || "80") !== String(BRIDGE_PORT)) {
    throw new Error(
      `Bridge URL port must be ${BRIDGE_PORT}. The extension is pinned to ${DEFAULT_BRIDGE_URL}. Unset CODEX_CHROME_BRIDGE_URL, AGENT_CHROME_BRIDGE_PORT, and CODEX_CHROME_BRIDGE_PORT.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("Bridge URL must not include credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`Bridge URL must be exactly ${DEFAULT_BRIDGE_URL}.`);
  }
  return DEFAULT_BRIDGE_URL;
}
