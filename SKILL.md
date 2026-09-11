---
name: agent-chrome-bridge
description: Give Grok Bot and other agents your Chrome. Control a user-armed Chrome tab through a local loopback bridge — not datacenter Chrome.
---

# Agent Chrome Bridge

**Give Grok Bot and other agents your Chrome.**

Use this skill when the user installed or wants `Agent Chrome Bridge` (repo `makriman/Agent-Chrome-Bridge`; older checkouts may still be named `codex-chrome-bridge`), or when an agent must drive a real signed-in Chrome tab that Cloudflare would block from a datacenter browser.

Canonical clone: `https://github.com/makriman/Agent-Chrome-Bridge.git`

## Core Idea

Cloud Chrome ≠ user Chrome. Hosted / CI / datacenter browsers hit **Verify you are human** and **Access denied**. This bridge does not export cookies and does not stand up a remote relay. The user signs in with normal Chrome, opens the target page, clicks **Arm tab**, and the agent controls only that tab on `127.0.0.1`.

Do not ask for passwords, cookies, tokens, or exported browser data.

There is no MCP server in this repository. Drive the bridge with Mac Shell + `bridge/control.mjs` / `bridge/sdk.mjs`.

## Setup Checklist

1. Confirm a local checkout exists (`Agent-Chrome-Bridge` or an older `codex-chrome-bridge` folder).
2. Start the bridge if it is not already running:

```bash
npm run bridge
```

3. Ask the user to load `extension/` in `chrome://extensions` if they have not installed it yet.
4. Ask the user to open/authenticate the target site in Chrome and click **Arm tab**.
5. Check bridge state:

```bash
node bridge/control.mjs status
```

6. If anything looks off, run:

```bash
node bridge/control.mjs doctor
```

If `armed` is missing or expired, ask the user to arm the tab again. After a bridge restart, **re-arm** — do not assume the previous arm survived.

If `connected` is `false`, wait a few seconds and poll `status` again (extension hello warm-up). Do not declare the install dead on the first false.

## Grok Bot Host Path

On Grok Bot, prefer this order. Details live in [GROK_BOT.md](GROK_BOT.md).

1. `ListMachines` — find the user's Mac. If the turn says **No registered machines were available when this turn started**, retry next turn.
2. Mac Shell — `cd "$HOME/Agent-Chrome-Bridge"` (quote paths that contain spaces).
3. `npm run bridge` if doctor/status cannot reach `127.0.0.1:18474`.
4. `node bridge/control.mjs doctor`
5. `node bridge/control.mjs status`
6. Ask the user to **Arm tab** if needed.
7. `inspect` / `click-ref` / `screenshot` (screenshot-first for Polaris static metrics).

Optional port alias: `AGENT_CHROME_BRIDGE_PORT` (same as `CODEX_CHROME_BRIDGE_PORT`).

## Runtime Version Check

After pulling or updating the repo, always run:

```bash
node bridge/control.mjs doctor
```

If `doctor` returns `Not found`, a protocol mismatch, or a stale bridge warning, the bridge process is still running old code. Restart it, then ask the user to re-arm:

```bash
lsof -ti tcp:18474 | xargs -r kill
npm run bridge
```

## Hard Callouts (2026-09-10 field run)

- **`tab.wait` is not a function.** Use `tab.sleep(ms)`, `tab.waitForText`, `tab.waitForUrl`, or `tab.waitForSelector`. CLI equivalent: `wait-for text|url|selector` or `wait <ms>`.
- **Org ID ≠ Dev Dashboard ID.** Example pattern only: Partners org `4150194` vs Dev Dashboard `156815189`. Do not mix them in URLs.
- **Screenshot-first for Polaris metrics.** `inspect` returns interactives, not static metric tiles.
- **Scroll before inspect** so offscreen controls receive refs.
- **Prefer `click-ref`.** A visible label is not the drawer or panel it names.
- **Quote paths with spaces** in Mac Shell (`"/Users/You/Projects/Agent Chrome Bridge"`).
- **CopyToBox** Mac screenshots after `screenshot` so the agent can see the PNG.
- **Re-arm after bridge restart.**
- **`connected: false` can be warm-up.** Poll `status` before failing the session.
- **Empty-state promo ≠ inventory.** Partners Home **Create your first app** is not the Apps list. Go `/apps` before reporting inventory.
- **CSV export click ≠ download.** Verify the file in Downloads or screenshot the save dialog.
- **One armed tab.** Mac bridge for Partners / Dev Dashboard; Box for non-Cloudflare hosts. Do not swap the armed tab mid-task.
- **No registered machines were available when this turn started** → retry ListMachines next turn. Do not use datacenter Chrome.

Partners-specific cookbook: [docs/partners-cookbook.md](docs/partners-cookbook.md).

## Workflow-First Operation

For multi-step tasks, do not drive the browser one command at a time from chat.

1. Run `doctor`, `status`, and one `inspect` (after a screenshot when the page is metric-heavy).
2. Create a local workflow script under `artifacts/workflows/`.
3. The script should call `bridge/sdk.mjs`, perform the full task, include `sleep` / `waitFor*` assertions, and stop before any sensitive final action unless the user has explicitly approved it.
4. Run the script through the workflow runner and monitor structured output.
5. Use `inspect`, screenshots, queue status, and command lifecycle output only to verify or debug the script.
6. If the script fails, update the script and rerun it; avoid continuing with a long sequence of manual ad hoc clicks.

Prefer reusable scripts and site adapters over raw command sequences. Leave the user with a script that can be reviewed, repeated, and improved.
`artifacts/workflows/` and `artifacts/runs/` are ignored by git, so task-specific workflows and run traces stay local unless the user asks to publish one.

Workflow runner:

```bash
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --dry-run
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --resume
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --resume --approve
```

Minimal workflow shape:

```js
import { browser } from "../../bridge/sdk.mjs";

export default async function ({ step }) {
  const tab = await browser.currentTab();

  await step("inspect", "Inspect current page", async () => {
    return tab.inspect(120);
  });

  await step("draft", "Draft without submitting", async () => {
    const box = await tab.findByText(/reply/i);
    await tab.clickRef(box.ref);
    await tab.type("Draft text");
    await tab.assertText("Draft text");
  });

  await step("approval", "Ask before final action", async () => {
    await tab.requireApproval("Submit drafted reply", { text: "Draft text" });
  });
}
```

There is no `tab.wait`. See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for the real wait APIs.

## Command Reference

Inspect visible interactive elements:

```bash
node bridge/control.mjs inspect 120
```

Prefer `ref` values returned by inspect whenever possible.

Click by ref:

```bash
node bridge/control.mjs click-ref ref_abc123
```

Click by coordinates:

```bash
node bridge/control.mjs click 420 315
```

Click by visible text:

```bash
node bridge/control.mjs click-text "Continue" --exact
```

Click by selector:

```bash
node bridge/control.mjs click-selector "button.primary"
```

Mouse move:

```bash
node bridge/control.mjs move 600 400
```

Scroll:

```bash
node bridge/control.mjs scroll 900
```

Fill by ref:

```bash
node bridge/control.mjs fill-ref ref_abc123 "text"
```

Type into the focused element:

```bash
node bridge/control.mjs type "text"
```

Press a key:

```bash
node bridge/control.mjs key Enter
node bridge/control.mjs key L Meta
```

Navigate:

```bash
node bridge/control.mjs nav "https://example.com"
```

Wait for state (`wait-for`, not a fictional `tab.wait`):

```bash
node bridge/control.mjs wait-for text "Saved"
node bridge/control.mjs wait-for selector ".toast-success"
node bridge/control.mjs wait-for url "/dashboard"
node bridge/control.mjs wait 400
```

History/reload:

```bash
node bridge/control.mjs back
node bridge/control.mjs forward
node bridge/control.mjs reload
```

Screenshot (quote the path if it contains spaces):

```bash
node bridge/control.mjs screenshot artifacts/current.png
node bridge/control.mjs screenshot "artifacts/Partner Home.png"
```

Raw JSON:

```bash
node bridge/control.mjs raw '{"type":"click","x":400,"y":300}'
```

Stop/disarm:

```bash
node bridge/control.mjs stop
```

Queue diagnostics:

```bash
node bridge/control.mjs queue
node bridge/control.mjs cancel cmd_...
node bridge/control.mjs flush
```

## Screenshot Caveat

Screenshots try CDP `Page.captureScreenshot` first, then `tabs.captureVisibleTab`. The fallback needs the window focused and host permission. If `screenshot` fails with a Chrome permission error, keep working with `inspect` and report the screenshot capability failure. Do not treat this as loss of browser access when `status`, `inspect`, and command round-trip still work.

On Grok Bot / Mac, pull the PNG with CopyToBox after a successful screenshot.

## Workflow Failure Debugging

When a workflow fails:

1. Read `artifacts/runs/<run>/summary.md`.
2. Read the last 20 lines of `artifacts/runs/<run>/events.jsonl`.
3. Run `node bridge/control.mjs queue`.
4. If the failed command is `screenshot` but `inspect` works, continue with inspect-only verification and report the screenshot capability issue.
5. Edit the workflow and rerun it with `--resume` when appropriate.

## Operating Guidance

- Use `inspect` before forming text or selector commands. Scroll first if the control may be below the fold.
- Prefer `click-ref` and `fill-ref`; use text/selector clicks when refs are unavailable; use coordinate clicks when the page is visual or canvas-like.
- Use screenshots when visual confirmation matters, especially static Polaris copy.
- Keep commands scoped to the user's task and the armed tab.
- If an action could submit data, make a purchase, delete data, change settings, or transmit sensitive information, ask for confirmation at action time.
- Do not print, commit, or paste local auth files, screenshots of secrets, or generated zip files.
- Treat every non-`succeeded` terminal state as a real failure: `failed`, `timed_out`, `cancelled`, or `stale_arm`.

## Troubleshooting

- If commands time out, confirm `npm run bridge` is still running.
- If commands time out, run `queue`; cancel or flush stale commands if needed.
- If status says the tab is not armed, ask the user to click **Arm tab** again.
- If commands say `stale_arm`, the user armed a newer tab; rerun `status`/`inspect` and use fresh refs.
- If Chrome shows a debugger banner during commands, that is expected.
- If a click by text misses, run `inspect` and use the exact visible label, `--index`, or a ref. Remember: label ≠ drawer.
- If the extension was edited locally, reload it in `chrome://extensions` before testing.
