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

## ID pattern (no secrets)

```text
Partners org URL piece     →  4150194      (example)
Dev Dashboard URL piece    →  156815189    (example)
```

Treat any ID the user pastes as opaque. Confirm which dashboard they are on from the armed tab URL before navigating.

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
- Do not call `tab.wait(...)`.
- Do not treat a successful label click as proof the drawer opened.
