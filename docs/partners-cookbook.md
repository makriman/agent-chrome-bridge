# Partners cookbook (example proof)

**Give Grok Bot and other agents your Chrome.**

Shopify Partners is **example proof** that datacenter Chrome dies on Cloudflare. It is not the product. Use this snippet when an agent is already on a user-armed Partners tab. No secrets. No org tokens. No MCP.

Canonical repo: [makriman/Agent-Chrome-Bridge](https://github.com/makriman/Agent-Chrome-Bridge)

## Field callouts (2026-09-10)

1. **Org ID ≠ Dev Dashboard ID.** Example pattern only: Partners org `4150194` vs Dev Dashboard `156815189`. Those are different surfaces. Do not copy an ID from one dashboard into the other URL.
2. **Screenshot-first for Polaris metrics.** App / home tiles often render static text that `inspect` never returns. Capture the viewport, then inspect.
3. **Scroll before inspect.** Offscreen Polaris controls have no refs until they enter the viewport.
4. **Prefer `click-ref`.** `click-text` on a nav label does not open the drawer that label names.
5. **Label ≠ drawer.** After a click, wait for the panel copy or URL you actually need (`waitForText` / `waitForUrl`). Do not assume the label you clicked is the selected view.
6. **Quote paths with spaces** when writing screenshots or `cd`ing the checkout on Mac Shell.
7. **CopyToBox** the PNG after `screenshot` so Grok Bot can read Polaris numbers.
8. **Re-arm after every bridge restart.**
9. **`connected: false` can be warm-up.** Poll `status` once or twice before failing.
10. **`tab.wait` is not a function.** Use `tab.sleep(ms)`, `tab.waitForText`, `tab.waitForUrl`, or `tab.waitForSelector`.
11. **Empty-state promo ≠ inventory.** Partners Home **Create your first app** is a marketing / empty-state tile. It does not mean the org has zero apps. Open `/apps` (or the Apps list) to read inventory.
12. **CSV export click ≠ download.** Clicking Export / CSV may open a dialog or start a download that never lands. Verify the file in Downloads, or screenshot the save/confirm dialog. Do not report “exported” from the click alone.
13. **One armed tab.** Parallel surfaces: Mac bridge for Partners / Dev Dashboard; Box (or CopyToBox) for non-Cloudflare hosts. Do not swap the armed tab mid-task to chase every URL.
14. **No registered machines** on ListMachines / Mac Shell means retry next turn. Do not fall back to datacenter Chrome.

## ID pattern (no secrets)

```text
Partners org URL piece     →  4150194      (example)
Dev Dashboard URL piece    →  156815189    (example)
```

Treat any ID the user pastes as opaque. Confirm which dashboard they are on from the armed tab URL before navigating.

## Empty-state vs inventory

Partners Home can show **Create your first app** even when the org already has apps. That copy is a promo / empty-state, not a count of inventory.

```bash
node bridge/control.mjs screenshot "artifacts/partners-home.png"
# CopyToBox that PNG. Home promo is not inventory — do not conclude "zero apps".
node bridge/control.mjs inspect 120
node bridge/control.mjs click-ref ref_for_apps_nav
node bridge/control.mjs wait-for url "/apps"
node bridge/control.mjs screenshot "artifacts/partners-apps.png"
```

Confirm the Apps list (or an app row) before reporting inventory. Home promo copy is not evidence.

## CSV export

A click on Export / Download CSV is not proof the file exists.

1. Screenshot the control and any save / confirm dialog.
2. After the click, check the Mac **Downloads** folder (or the path Chrome reports).
3. If a dialog is still open, the user may need to confirm it — the agent cannot complete a native save sheet from inspect refs.
4. CopyToBox the CSV only after the file is on disk.

## Suggested loop

```bash
node bridge/control.mjs status
node bridge/control.mjs screenshot "artifacts/partners-metrics.png"
# CopyToBox that PNG on Mac
node bridge/control.mjs scroll 800
node bridge/control.mjs inspect 120
node bridge/control.mjs click-ref ref_from_inspect
node bridge/control.mjs wait-for url "partners.shopify.com"
node bridge/control.mjs wait-for text "Apps"
```

Workflow shape that does not use broken APIs: `docs/examples/` Partner-grade scripts on the SDK-truth PR. Until that merges, write local scripts with `sleep` / `waitFor*` only.

## What inspect will not see

`inspect` lists visible interactives (buttons, links, inputs, labeled controls). Polaris metric values, helper copy, and chart ticks are often plain text. For those, screenshot-first. An a11y tree / `getVisibleText` dump is not the current inspect payload — do not invent one.

## What not to do

- Do not export Partners cookies to a cloud browser to “bypass” Cloudflare.
- Do not put session tokens, `.bridge-token`, or app secrets in the cookbook, skill, or chat.
- Do not paste `.bridge-token` contents.
- Do not call `tab.wait(...)`.
- Do not treat a successful label click as proof the drawer opened.
- Do not treat **Create your first app** on Home as “the org has no apps.”
- Do not treat an Export click as a completed CSV download.
