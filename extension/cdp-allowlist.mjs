export const CDP_ALLOWED_METHODS = Object.freeze([
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.enable",
  "Page.captureScreenshot"
]);

const ALLOWED = new Set(CDP_ALLOWED_METHODS);

export function assertCdpMethodAllowed(method) {
  if (typeof method !== "string" || /cookie/i.test(method) || !ALLOWED.has(method)) {
    const error = new Error(`CDP method is not allowed: ${String(method)}`);
    error.code = "cdp_method_denied";
    throw error;
  }
}
