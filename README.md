# Codex Chrome Bridge

Use your real Chrome session with Codex.

You sign in normally, arm one Chrome tab, and Codex controls that tab through a local bridge. No cookies, passwords, or tokens are exported.

## Quick Start

```bash
git clone https://github.com/makriman/codex-chrome-bridge.git
cd codex-chrome-bridge
npm run bridge
```

Load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this repo's `extension/` folder.

Then:

1. Open the site in Chrome.
2. Sign in yourself.
3. Click the extension icon.
4. Click `Arm tab`.
5. Tell Codex: "Use this repo. The tab is armed."

Codex should read [SKILL.md](./SKILL.md).

## What Codex Can Do

- Inspect the armed page.
- Click by ref, text, selector, or coordinates.
- Fill fields.
- Type and press keys.
- Scroll and navigate.
- Take screenshots.
- Run repeatable workflow scripts.
- Pause before sensitive final actions.

## Everyday Commands

```bash
node bridge/control.mjs doctor
node bridge/control.mjs status
node bridge/control.mjs inspect 50
node bridge/control.mjs screenshot artifacts/current.png
node bridge/control.mjs queue
```

For multi-step tasks, use workflows:

```bash
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --dry-run
node bridge/run-workflow.mjs artifacts/workflows/my-task.mjs --resume
```

See [docs/WORKFLOWS.md](./docs/WORKFLOWS.md).

## Safety

- The bridge listens on `127.0.0.1`.
- Commands require the local `.bridge-token`.
- The extension only acts on an armed tab.
- Arming expires after 30 minutes.
- Arming a new tab replaces the old tab.
- Raw artifacts stay local and are ignored by git.
- Codex should ask before posting, sending, buying, deleting, submitting, or changing sensitive settings.

## Development

```bash
npm run check
npm run zip
```

If you pull new code while the bridge is running, restart it:

```bash
lsof -ti tcp:18474 | xargs -r kill
npm run bridge
```

## Files

```text
extension/        Chrome extension
bridge/           Local bridge, CLI, SDK, workflow runner
docs/             Workflow docs, roadmap, examples
SKILL.md          Instructions for Codex
```

Roadmap: [docs/ROADMAP.md](./docs/ROADMAP.md)
