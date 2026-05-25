---
name: codex-chrome-bridge
description: Control a user-armed Chrome tab through a local bridge and Chrome extension for authenticated browser work.
---

# Codex Chrome Bridge

Use this skill when the user says they installed or wants to use `codex-chrome-bridge`, or when they need Codex to control a real authenticated Chrome tab.

## Core Idea

The user authenticates in normal Chrome, opens the target page, then clicks `Arm tab` in the extension popup. Codex controls that armed tab through the local bridge at `127.0.0.1:18474`.

Do not ask for passwords, cookies, tokens, or exported browser data. The whole point is that auth stays in the user's Chrome profile and the user explicitly arms one tab.

## Setup Checklist

1. Confirm the repo is available locally.
2. Start the bridge if it is not already running:

```bash
npm run bridge
```

3. Ask the user to load `extension/` in `chrome://extensions` if they have not installed it yet.
4. Ask the user to open/authenticate the target site in Chrome and click `Arm tab`.
5. Check bridge state:

```bash
node bridge/control.mjs status
```

6. If anything looks off, run:

```bash
node bridge/control.mjs doctor
```

If `armed` is missing or expired, ask the user to arm the tab again. If `doctor` reports token mismatch or invalid length, restart the bridge.

## Runtime Version Check

After pulling or updating the repo, always run:

```bash
node bridge/control.mjs doctor
```

If `doctor` returns `Not found`, a protocol mismatch, or a stale bridge warning, the bridge process is still running old code. Restart it before continuing:

```bash
lsof -ti tcp:18474 | xargs -r kill
npm run bridge
```

## Workflow-First Operation

For multi-step tasks, do not drive the browser one command at a time from chat.

1. Run `doctor`, `status`, and one `inspect` to understand the current page.
2. Create a local workflow script under `artifacts/workflows/`.
3. The script should call `bridge/sdk.mjs`, perform the full task, include waits and assertions, and stop before any sensitive final action unless the user has explicitly approved it.
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

Wait for state:

```bash
node bridge/control.mjs wait-for text "Saved"
node bridge/control.mjs wait-for selector ".toast-success"
node bridge/control.mjs wait-for url "/dashboard"
```

History/reload:

```bash
node bridge/control.mjs back
node bridge/control.mjs forward
node bridge/control.mjs reload
```

Screenshot:

```bash
node bridge/control.mjs screenshot artifacts/current.png
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

Screenshots should work through CDP first, with `tabs.captureVisibleTab` as fallback. If `screenshot` fails with a Chrome permission error, keep working with `inspect`-based verification and report the screenshot capability failure. Do not treat this as loss of browser access when `status`, `inspect`, and command round-trip still work.

## Workflow Failure Debugging

When a workflow fails:

1. Read `artifacts/runs/<run>/summary.md`.
2. Read the last 20 lines of `artifacts/runs/<run>/events.jsonl`.
3. Run `node bridge/control.mjs queue`.
4. If the failed command is `screenshot` but `inspect` works, continue with inspect-only verification and report the screenshot capability issue.
5. Edit the workflow and rerun it with `--resume` when appropriate.

## Operating Guidance

- Use `inspect` before forming text or selector commands.
- Prefer `click-ref` and `fill-ref`; use text/selector clicks when refs are unavailable; use coordinate clicks when the page is visual or canvas-like.
- Use screenshots when visual confirmation matters.
- Keep commands scoped to the user's task and the armed tab.
- If an action could submit data, make a purchase, delete data, change settings, or transmit sensitive information, follow Codex browser safety rules and ask for confirmation at action time.
- Do not reveal the local `.bridge-token` in chat.
- Do not commit `.bridge-token`, screenshots, or generated zip files.
- Treat every non-`succeeded` terminal state as a real failure: `failed`, `timed_out`, `cancelled`, or `stale_arm`.

## Troubleshooting

- If commands time out, confirm `npm run bridge` is still running.
- If commands time out, run `queue`; cancel or flush stale commands if needed.
- If status says the tab is not armed, ask the user to click `Arm tab` again.
- If commands say `stale_arm`, the user armed a newer tab; rerun `status`/`inspect` and use fresh refs.
- If Chrome shows a debugger banner during commands, that is expected.
- If a click by text misses, run `inspect` and use the exact visible label, `--index`, or coordinates.
- If the extension was edited locally, reload it in `chrome://extensions` before testing.
