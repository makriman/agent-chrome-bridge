# Agent Chrome Bridge — agent guide

Canonical public name: **Agent Chrome Bridge**.

Repository: [makriman/Agent-Chrome-Bridge](https://github.com/makriman/Agent-Chrome-Bridge). Older `codex-chrome-bridge` clone URLs redirect here. Wire compatibility still uses the `codex-chrome-bridge` package name, extension message source, `x-codex-bridge-token` header, and `CODEX_CHROME_BRIDGE_*` env vars. Do not rename those.

## Product

Local-only Chrome MV3 extension plus a Node bridge. The user signs in with their normal Chrome profile, arms **one tab**, and a local agent (Grok Bot on the user's Mac, or another process on that machine) drives that tab through `127.0.0.1`.

The session stays in Chrome. This repo has no cookie export, no remote relay, and no MCP server. Datacenter or CI Chrome is the wrong tool when the page is behind a human-check wall.

Read first:

- [SKILL.md](SKILL.md) — operator skill and command reference
- [GROK_BOT.md](GROK_BOT.md) — Grok Bot host path (`ListMachines` → Mac shell → bridge)
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md) — workflow runner and real wait APIs (`tab.sleep`, `tab.waitForText`, `tab.waitForUrl`, `tab.waitForSelector`; there is no `tab.wait`)
- [docs/partners-cookbook.md](docs/partners-cookbook.md) — Shopify Partners is an example gate, not the product
- [docs/ROADMAP.md](docs/ROADMAP.md) — safety modes and intended approval model
- [SECURITY.md](SECURITY.md) and [docs/SECURITY-REVIEW-2026-09-23.md](docs/SECURITY-REVIEW-2026-09-23.md)

## How to run

On the machine that has the user's Chrome:

```bash
npm install
npm run bridge
```

Load `extension/` unpacked at `chrome://extensions` (Developer mode). Open the target site, then click **Arm tab** in the popup. Agents cannot arm a tab for the user.

```bash
node bridge/control.mjs doctor
node bridge/control.mjs status
node bridge/control.mjs inspect
```

Default listen address is `http://127.0.0.1:18474`. Optional port env: `AGENT_CHROME_BRIDGE_PORT` (wins) or `CODEX_CHROME_BRIDGE_PORT`. CLI/SDK base URL: `CODEX_CHROME_BRIDGE_URL`.

Syntax check before a PR:

```bash
npm run check
```

A cloud VM is not the user's Mac. From a cloud agent, do not expect `npm run bridge` to see their Chrome. Do not ask them to paste cookies, a session dump, or `.bridge-token` so you can drive the browser remotely. If no host machine is available, stop and say so.

## Safety

- Never commit or paste `.bridge-token` or `.bridge-token.meta.json`. Both are gitignored. Logs and the status page should keep showing the fingerprint only.
- Never export cookies, `document.cookie`, CDP `Network.getCookies`, or profile session files. Do not add that capability.
- The bridge is localhost-only. Do not bind `0.0.0.0`, add a tunnel, or turn the bridge into a remote control plane.
- One armed tab. Do not add a second concurrent arm target.
- Stop before submit, purchase, delete, send, permission changes, or other irreversible actions unless the user explicitly approved that exact action. SDK `requireApproval` is not a bridge-side guarantee; see the security review.
- Do not pass `--approve` or set `CODEX_CHROME_BRIDGE_APPROVE=1` unless the user just approved the paused action.
- Screenshot and workflow outputs stay under `artifacts/`. Do not write absolute paths or `..` segments outside the repo.
- After a bridge restart, ask the user to arm the tab again.

## Preferred workflow

1. Investigate the tree and the docs above.
2. Keep the change small and reviewable.
3. Open a **draft** pull request against `main`.
4. Do not merge, force-push `main`, or change repository access (no collaborator invites) unless the founder explicitly asks.

Founder review is required before merge.
