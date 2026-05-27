# Codex Chrome Bridge

A local-only Chrome extension bridge for Codex-controlled armed-tab browser automation.

## Mission

Browser automation should be powerful without asking users to export cookies, passwords, or private sessions. This bridge lets a user sign in normally, arm one tab, and allow Codex to inspect and operate only that tab through a local control plane.

## What This Repository Contains

A Chrome extension plus Node bridge that lets Codex interact with a real signed-in Chrome tab through explicit local arming, token-protected commands, screenshots, inspection, and repeatable workflows.

## Highlights

- Arm a single Chrome tab and keep credentials inside Chrome.
- Inspect pages, click, type, scroll, navigate, and capture screenshots.
- Run scripted workflows with dry-run and resume support.
- Local token protection through .bridge-token and explicit tab arming.

## Tech Stack

- Vanilla JavaScript Chrome extension
- Node.js ESM bridge server
- Local HTTP control API on 127.0.0.1
- Workflow scripts for repeatable browser tasks

## Getting Started

```bash
npm install
npm run bridge
node bridge/control.mjs doctor
```

## Quality Checks

```bash
npm run check
```

## Repository Notes

- Do not commit .bridge-token or artifacts containing sensitive screenshots.
- The extension should only be loaded from a trusted local checkout.

## Contributing

Contributions are welcome. The best contributions are specific, tested, and grounded in the product mission. Good places to help include documentation, accessibility, tests, bug reports, UI polish, data validation, and safer AI behavior.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Please do not open public issues for secrets, auth bypasses, data exposure, provider key leaks, or abuse vectors. Follow [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be direct, kind, and useful.

## License

MIT. See [LICENSE](LICENSE).
