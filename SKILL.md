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

If `armed` is missing or expired, ask the user to arm the tab again.

## Command Reference

Inspect visible interactive elements:

```bash
node bridge/control.mjs inspect 120
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

## Operating Guidance

- Use `inspect` before forming text or selector commands.
- Prefer text/selector clicks when stable; use coordinate clicks when the page is visual or canvas-like.
- Use screenshots when visual confirmation matters.
- Keep commands scoped to the user's task and the armed tab.
- If an action could submit data, make a purchase, delete data, change settings, or transmit sensitive information, follow Codex browser safety rules and ask for confirmation at action time.
- Do not reveal the local `.bridge-token` in chat.
- Do not commit `.bridge-token`, screenshots, or generated zip files.

## Troubleshooting

- If commands time out, confirm `npm run bridge` is still running.
- If status says the tab is not armed, ask the user to click `Arm tab` again.
- If Chrome shows a debugger banner during commands, that is expected.
- If a click by text misses, run `inspect` and use the exact visible label, `--index`, or coordinates.
- If the extension was edited locally, reload it in `chrome://extensions` before testing.
