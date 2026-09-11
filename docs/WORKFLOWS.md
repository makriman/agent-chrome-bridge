# Workflow Runtime

For non-trivial browser work, generate and run a workflow instead of driving Chrome one shell command at a time.

**Give Grok Bot and other agents your Chrome.** There is no `tab.wait` method. Use the wait APIs below.

The workflow runner gives each run:

- a per-run artifact directory under `artifacts/runs/`
- `events.jsonl`
- `command-log.jsonl`
- `state.json`
- `summary.md`
- screenshots and inspect snapshots on failure
- approval request files under `approvals/`

## Run A Workflow

```bash
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs
```

Useful options:

```bash
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --dry-run
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --offline
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --plan
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --resume
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --approve --resume
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --timeout 60000
```

`--dry-run` emits steps and synthetic command/read results without sending browser commands.

`--offline` is stricter language for the same no-bridge expectation and is useful in scripts that want to be explicit.

`--plan` records workflow metadata without executing steps.

`--resume` skips completed step IDs from `state.json`.

`--approve` grants approval gates for the current run. In normal use, do not pass this until the user has approved the paused final action.

## JavaScript Workflows

Workflow scripts can import the SDK:

```js
import { browser } from "../../bridge/sdk.mjs";

export default async function ({ step }) {
  const tab = await browser.currentTab();

  await step("check-url", "Check current page", async () => {
    await tab.assertUrl(/example\.com/);
  });

  await step("inspect", "Inspect page", async () => {
    return tab.inspect(120);
  });

  await step("draft", "Draft text", async () => {
    const box = await tab.findByText(/reply/i);
    await tab.clickRef(box.ref);
    await tab.type("Thanks for the context. I am checking this now.");
    await tab.assertText("Thanks for the context");
  });

  await step("approval", "Ask before sending", async () => {
    await tab.requireApproval("Send support reply", {
      text: "Thanks for the context. I am checking this now."
    });
  });

  await step("send", "Send reply", async () => {
    await tab.clickByRole("button", "Send");
  });
}
```

## JSON Workflows

Simple plans can be written as JSON:

```json
{
  "name": "draft-support-reply",
  "profile": "default",
  "steps": [
    { "id": "inspect", "op": "inspect", "saveAs": "initial" },
    { "id": "click-reply", "op": "click", "by": { "text": "Reply" } },
    { "id": "draft", "op": "type", "text": "Thanks for the context. I am checking this now." },
    { "id": "assert-draft", "op": "assert", "text": "Thanks for the context" },
    { "id": "approval", "op": "requireApproval", "reason": "Send support reply" },
    { "id": "send", "op": "click", "by": { "role": "button", "name": "Send" } }
  ]
}
```

Supported JSON ops:

- `inspect`
- `screenshot`
- `click`
- `fill`
- `type`
- `key` / `press`
- `scroll`
- `navigate`
- `waitFor` (`kind`: `text` | `url` | `selector`)
- `sleep` / `wait` (milliseconds; not `tab.wait()`)
- `assert`
- `requireApproval`
- `raw`

JSON steps can include `"optional": true` to record a skipped result instead of failing the whole workflow.

## SDK wait APIs (truth)

`tab.wait` **is not a function.** Workflows that call it throw. Real methods:

| Method | What it does |
| --- | --- |
| `tab.waitForText(text, options?)` | Polls visible interactive/label text until it matches |
| `tab.waitForUrl(urlPart, options?)` | Polls `chrome.tabs` URL with **`String.includes`** — not a regex |
| `tab.waitForSelector(selector, options?)` | Polls a CSS selector in the armed tab |
| `tab.sleep(ms)` | Bridge `wait` command; pause without asserting UI |
| `tab.assertText` / `tab.assertSelector` | Aliases of the `waitFor*` helpers |
| `tab.assertUrl(pattern)` | Immediate check of the armed URL (`RegExp` or substring) |

CLI equivalents:

```bash
node bridge/control.mjs wait-for text "Saved"
node bridge/control.mjs wait-for url "/dashboard"
node bridge/control.mjs wait-for selector ".toast-success"
node bridge/control.mjs wait 400
```

### `waitForUrl` notes

- Match is substring `includes`, not `RegExp`. Pass `"partners.shopify.com"` or `"/apps"`, not `/partners\.shopify\.com/`.
- The value is the full tab URL (scheme, host, path, query, hash).
- After `navigate`, wait with `waitForUrl` before `inspect`.
- SPA route changes can lag; combine with `waitForText` or a short `sleep` if the URL updates before the Polaris view does.

### Polaris / a11y

`inspect` (and `tab.getVisibleText()`) only see **interactive / labeled** nodes. Static Polaris metric tiles, helper copy, and chart ticks often never appear. Screenshot-first for those. There is no accessibility-tree command in this tree yet.

### Screenshots (CDP vs `captureVisibleTab`)

1. Extension tries CDP `Page.captureScreenshot` (debugger banner is expected).
2. Falls back to `tabs.captureVisibleTab` (needs the window focused and host permission).
3. If both fail, `inspect` can still work — treat it as a screenshot capability gap, not a dead bridge.

Quote paths that contain spaces. On Grok Bot / Mac, CopyToBox the PNG after a successful capture.

```bash
node bridge/control.mjs screenshot "artifacts/Partner Home.png"
```

### Batch large captures

- One screenshot per decision, not per command.
- Viewport only unless you pass `fullPage` through a raw screenshot command (experimental).
- Keep `inspect` limits around `120`. Do not dump huge trees into chat.
- Scroll, then inspect; do not screenshot every scroll tick.

Partner-grade read example (no `tab.wait`): [examples/partners-read.workflow.mjs](examples/partners-read.workflow.mjs).

## SDK Helpers

```js
const tab = await browser.currentTab();
await tab.assertUrl(/x\.com/);
await tab.sleep(400);
await tab.waitForUrl("/dashboard");
const inspect = await tab.inspect(120);
const item = await tab.findByText(/Post/i);
await tab.clickRef(item.ref);
await tab.fillRef(item.ref, "text");
await tab.clickByText("Continue");
await tab.clickByRole("button", "Post");
await tab.clickBySelector("button[type='submit']");
await tab.waitForText("Saved");
await tab.waitForSelector(".toast-success");
await tab.screenshot("artifacts/current.png");
await tab.requireApproval("Publish post", { text: "..." });
```

## Failure Artifacts

When a step fails, the runner tries to write:

```text
artifacts/runs/<run>/
  screenshots/failure-<step>.png
  inspect/failure-<step>.json
```

These artifacts are local and ignored by git.

## Approval Gates

`requireApproval` pauses the run and writes an approval request:

```text
artifacts/runs/<run>/approvals/approval_....json
```

After the user approves, rerun:

```bash
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --resume --approve
```

The current implementation uses runner-level approval for Milestone 1. A future side panel will display approval requests and issue short-lived approval tokens.
