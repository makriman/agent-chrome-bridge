import { browser } from "../../bridge/sdk.mjs";

/**
 * Partner-grade read workflow (no secrets, no submit).
 *
 * Give Grok Bot and other agents your Chrome.
 *
 * Field notes (2026-09-10):
 * - tab.wait is not a function. Use tab.sleep / tab.waitForText / tab.waitForUrl / tab.waitForSelector.
 * - Org ID ≠ Dev Dashboard ID (example pattern only: 4150194 vs 156815189).
 * - Polaris metric tiles are often static text, not inspect interactives. Screenshot first.
 * - Scroll before inspect so offscreen controls get refs.
 * - Prefer click-ref over click-by-label; a nav label is not the drawer it opens.
 * - Quote screenshot paths that contain spaces.
 */
export default async function ({ step }) {
  const tab = await browser.currentTab();

  await step("status", "Confirm armed tab", async () => {
    const status = await tab.status();
    return {
      connected: status.connected,
      url: status.latestExtensionState && status.latestExtensionState.armed
        ? status.latestExtensionState.armed.url
        : null
    };
  });

  await step("warm-url", "Wait for Partners URL substring", async () => {
    return tab.waitForUrl("partners.shopify.com", { timeoutMs: 15000 });
  });

  await step("screenshot-metrics", "Screenshot-first for Polaris static metrics", async () => {
    try {
      return await tab.screenshot("artifacts/partners-metrics.png");
    } catch (error) {
      return { skipped: true, reason: error.message };
    }
  });

  await step("scroll-into-view", "Scroll before inspect", async () => {
    await tab.scroll(800);
    await tab.sleep(400);
    return { scrolled: 800 };
  });

  await step("inspect", "Inspect visible interactives only", async () => {
    const result = await tab.inspect(120);
    return {
      title: result.title,
      url: result.url,
      itemCount: (result.items || []).length,
      note: "Static Polaris metrics may be absent from items. Use the screenshot step."
    };
  });

  await step("visible-text", "Labeled text only; not an a11y tree", async () => {
    return tab.getVisibleText({ limit: 120 });
  });

  await step("choose-ref", "Prefer click-ref over label matching", async () => {
    const result = await tab.inspect(120);
    const candidate = (result.items || []).find((item) => item.ref && item.text);
    return {
      preferred: candidate
        ? { ref: candidate.ref, text: candidate.text, role: candidate.role }
        : null,
      warning: "label ≠ drawer. Do not click a nav label and assume the panel it names is selected."
    };
  });
}
