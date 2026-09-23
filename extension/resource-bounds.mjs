export const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;
export const MAX_SCREENSHOT_CHARS = 8 * 1024 * 1024;

export function boundScreenshotResult(result, maxChars = MAX_SCREENSHOT_CHARS) {
  if (!result || typeof result !== "object" || typeof result.dataUrl !== "string") return result;
  if (result.dataUrl.length <= maxChars) return result;
  return {
    ...result,
    dataUrl: `[screenshot omitted: ${result.dataUrl.length} chars exceeds ${maxChars} char memory bound]`,
    screenshotOmitted: true
  };
}

export function releaseScreenshotResult(result) {
  if (!result || typeof result !== "object" || typeof result.dataUrl !== "string") return result;
  if (!result.dataUrl.startsWith("data:")) return result;
  const chars = result.dataUrl.length;
  return {
    ...result,
    dataUrl: `[screenshot released: ${chars} chars]`,
    screenshotReleased: true
  };
}
