export function armedOriginPattern(url) {
  if (typeof url !== "string" || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.origin}/*`;
}
