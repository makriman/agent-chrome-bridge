import assert from "node:assert/strict";
import test from "node:test";
import { boundScreenshotResult, MAX_JSON_BODY_BYTES, MAX_SCREENSHOT_CHARS, releaseScreenshotResult } from "./resource-bounds.mjs";

test("screenshot data URLs are capped and then released from memory", () => {
  assert.equal(MAX_JSON_BODY_BYTES, 12 * 1024 * 1024);
  assert.equal(MAX_SCREENSHOT_CHARS, 8 * 1024 * 1024);
  const small = { dataUrl: "data:image/png;base64,abcd", method: "cdp.Page.captureScreenshot" };
  assert.equal(boundScreenshotResult(small, 64), small);
  const huge = boundScreenshotResult({ dataUrl: `data:image/png;base64,${"a".repeat(80)}` }, 40);
  assert.equal(huge.screenshotOmitted, true);
  assert.equal(huge.dataUrl.includes("aaaa"), false);
  const released = releaseScreenshotResult(small);
  assert.equal(released.screenshotReleased, true);
  assert.equal(released.dataUrl.startsWith("data:"), false);
  assert.equal(releaseScreenshotResult(huge), huge);
});
