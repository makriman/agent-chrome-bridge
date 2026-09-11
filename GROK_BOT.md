# Grok Bot playbook

**Give Grok Bot and other agents your Chrome.**

This is the host-side runbook for [Agent Chrome Bridge](https://github.com/makriman/Agent-Chrome-Bridge) on Grok Bot. The agent reaches the user's real Chrome through a Mac, not a datacenter browser.

No MCP. No remote relay. No secrets in chat.

## Why this path

Cloudflare treats hosted Chrome as a bot. **Verify you are human** and **Access denied** are the P0. The user's signed-in Chrome already passed those gates. Grok Bot should `ListMachines` → Mac Shell → local bridge, then work the armed tab.

Shopify Partners is one proof of that gate, not the product. See [docs/partners-cookbook.md](docs/partners-cookbook.md).

## Sequence

```text
ListMachines
  → Mac Shell (quote paths with spaces)
    → cd <checkout>
    → npm run bridge          # if 127.0.0.1:18474 is down
    → node bridge/control.mjs doctor
    → node bridge/control.mjs status
    → user clicks Arm tab     # required after every bridge restart
    → inspect / click-ref / screenshot
```

### 1. ListMachines

Find the Mac that has Chrome and the checkout. Prefer the machine the user already used for this repo.

### 2. Mac Shell

`cd` into the checkout. Canonical folder name is `Agent-Chrome-Bridge`. Older clones may still be `codex-chrome-bridge`.

```bash
cd "$HOME/Agent-Chrome-Bridge"
# or: cd "$HOME/codex-chrome-bridge"
```

Quote any path that contains spaces:

```bash
cd "/Users/you/Projects/Agent Chrome Bridge"
```

### 3. Start the bridge

```bash
npm run bridge
```

Optional port alias (listen port only):

```bash
AGENT_CHROME_BRIDGE_PORT=18474 npm run bridge
```

`CODEX_CHROME_BRIDGE_PORT` still works. Leave the process running in that shell.

### 4. Doctor

```bash
node bridge/control.mjs doctor
```

If doctor cannot connect, the bridge is not up or is bound to another port. If doctor reports a stale protocol or missing process, kill `18474` and start `npm run bridge` again, then **re-arm**.

### 5. Status

```bash
node bridge/control.mjs status
```

Read `connected` and `armed`.

- `connected: false` on the first poll can be extension hello **warm-up**. Wait 2–5s and poll again.
- `armed` missing/expired → ask the user to open the target tab and click **Arm tab**.
- After any bridge restart, status may look healthy while the previous arm is gone. Re-arm.

### 6. Arm

The user must click **Arm tab** in the Agent Chrome Bridge popup. Agents cannot arm a tab remotely. Tell the user which window and URL to arm.

### 7. Inspect, click-ref, screenshot

Default loop:

1. Screenshot if the question is visual (Polaris metrics, charts, banners).
2. Scroll if the control may be below the fold.
3. `inspect` for refs.
4. `click-ref` — do not click a label and assume the drawer it names is selected.
5. `wait-for text|url|selector` or `wait <ms>`. **There is no `tab.wait`.**

```bash
node bridge/control.mjs screenshot artifacts/current.png
node bridge/control.mjs scroll 800
node bridge/control.mjs inspect 120
node bridge/control.mjs click-ref ref_abc123
node bridge/control.mjs wait-for url "partners.shopify.com"
node bridge/control.mjs wait-for text "Apps"
```

Quote screenshot paths that contain spaces:

```bash
node bridge/control.mjs screenshot "artifacts/Partner Home.png"
```

### 8. CopyToBox (Mac screenshots)

After a successful `screenshot`, the PNG lives on the Mac. Use **CopyToBox** so Grok Bot can actually see the image. A path in the command result is not the pixels.

If screenshot fails with a Chrome permission / CDP error but `inspect` still works, continue inspect-only and report the screenshot gap. Do not claim the bridge is down.

## Env compatibility

| Variable | Role |
| --- | --- |
| `CODEX_CHROME_BRIDGE_PORT` | Bridge listen port (legacy name) |
| `AGENT_CHROME_BRIDGE_PORT` | Optional alias for the same port |
| `CODEX_CHROME_BRIDGE_URL` | CLI/SDK base URL, default `http://127.0.0.1:18474` |

Do not rename `x-codex-bridge-token` or the extension message source `codex-chrome-bridge`. Those are wire compatibility, not the product name.

## Safety

- Stay on the armed tab.
- Stop before submit / purchase / delete / permission changes unless the user approved that exact action.
- Do not dump auth files, cookies, or token values into the chat.
- Do not introduce MCP or a remote relay as a workaround for Cloudflare.
