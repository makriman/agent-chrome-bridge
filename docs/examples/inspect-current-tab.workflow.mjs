import { browser } from "../../bridge/sdk.mjs";

export default async function ({ step, runDir }) {
  const tab = await browser.currentTab();

  await step("status", "Check bridge status", async () => {
    return browser.status();
  });

  await step("inspect", "Inspect current tab", async () => {
    const result = await tab.inspect(120);
    return {
      title: result.title,
      url: result.url,
      itemCount: result.items.length,
      runDir
    };
  });

  await step("screenshot", "Capture current viewport if available", async () => {
    try {
      return await tab.screenshot();
    } catch (error) {
      return {
        skipped: true,
        reason: error.message
      };
    }
  });
}
