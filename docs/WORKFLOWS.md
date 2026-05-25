# Workflow Runtime

For non-trivial browser work, Codex should generate and run a workflow instead of driving Chrome one shell command at a time.

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
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --resume
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --approve --resume
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --timeout 60000
```

`--dry-run` emits steps and synthetic command results without sending browser commands.

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
- `waitFor`
- `assert`
- `requireApproval`
- `raw`

## SDK Helpers

```js
const tab = await browser.currentTab();
await tab.assertUrl(/x\.com/);
const inspect = await tab.inspect(120);
const item = await tab.findByText(/Post/i);
await tab.clickRef(item.ref);
await tab.fillRef(item.ref, "text");
await tab.clickByText("Continue");
await tab.clickByRole("button", "Post");
await tab.clickBySelector("button[type='submit']");
await tab.waitForText("Saved");
await tab.waitForSelector(".toast-success");
await tab.waitForUrl("/dashboard");
await tab.screenshot();
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
