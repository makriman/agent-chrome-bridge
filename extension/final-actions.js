export const FINAL_ACTION_TTL_MS = 2 * 60 * 1000;

const FINAL_CLICK_RE = /\b(submit|purchase|buy|delete|send|pay|checkout|post|place[\s-]?order|confirm[\s-]?order)\b/i;
const FINAL_KEY_RE = /^(enter|return|numpadenter)$/i;

export function httpOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

export function assertNavigationInput(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("Navigation URL is required.");
  if (/[\u0000-\u001F]/.test(raw)) throw new Error("Navigation URL contains control characters.");
  const lower = raw.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("file:") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("chrome:") ||
    lower.startsWith("chrome-extension:") ||
    lower.startsWith("view-source:")
  ) {
    throw new Error("Navigation scheme is not allowed. Only http and https URLs are permitted.");
  }
  if (raw.startsWith("//")) {
    throw new Error("Protocol-relative navigation is not allowed.");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      throw new Error("Navigation URL is invalid.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Navigation scheme ${parsed.protocol} is not allowed. Only http and https URLs are permitted.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error("Navigation URLs must not include credentials.");
    }
  }
  return raw;
}

export function assertResolvedNavigation(value, baseUrl) {
  const raw = assertNavigationInput(value);
  let parsed;
  try {
    parsed = new URL(raw, baseUrl);
  } catch (_) {
    throw new Error("Navigation URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Navigation scheme ${parsed.protocol} is not allowed. Only http and https URLs are permitted.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Navigation URLs must not include credentials.");
  }
  return parsed;
}

export function isFinalActionCommand(command) {
  if (!command || typeof command !== "object") return false;
  if (command.finalAction === true || command.risk === "final") return true;
  const type = String(command.type || command.op || "");
  if (type === "key" || type === "keypress") {
    return FINAL_KEY_RE.test(String(command.key || command.value || "").trim());
  }
  if (type !== "click" && type !== "doubleClick" && type !== "dblclick") return false;
  const selector = String(command.selector || "");
  if (/type\s*=\s*["']?submit\b/i.test(selector)) return true;
  const haystack = [command.text, command.role, command.name, command.selector]
    .filter((item) => typeof item === "string" && item)
    .join("\n");
  return FINAL_CLICK_RE.test(haystack);
}
