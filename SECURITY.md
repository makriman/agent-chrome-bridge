# Security Policy

Security matters for this project because public repositories often connect to real users, provider APIs, deployment systems, or operational data.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security problems.

If you find a vulnerability, contact the repository owner privately with:

- A short summary.
- Steps to reproduce.
- The affected route, API, package, or workflow.
- Screenshots or logs with secrets removed.
- The impact you believe it may have.

If you are unsure whether something is security-sensitive, report it privately first.

## Report Privately

- Exposed API keys, OAuth secrets, database URLs, or tokens.
- Authentication or authorization bypasses.
- Cross-user data exposure.
- Prompt or tool behavior that leaks private data.
- Unsafe file, network, or database access.
- Admin route bypasses.
- Production data leaks.

## Local bridge

The Chrome extension does not hold a bridge credential. It polls `http://127.0.0.1:18474` and runs commands from that listener. Before arming, compare the popup fingerprint with `node bridge/control.mjs doctor`. Doctor exits non-zero on `token_mismatch`, `token_file_drift`, `token_rejected`, and `token_unreadable`, and it does not send `.bridge-token` to a listener whose fingerprint differs.

The CLI and SDK do not overwrite `.bridge-token` when the file is missing or unreadable. The bridge itself refuses to replace a token file it cannot read.

`/public-status` publishes a 12-character SHA-256 fingerprint so that comparison can happen before the token is sent. It does not include command text. The fingerprint does not make the 256-bit token guessable.

See [docs/EXTENSION-CREDENTIAL.md](docs/EXTENSION-CREDENTIAL.md) and [docs/MAC-SMOKE-CHECKLIST.md](docs/MAC-SMOKE-CHECKLIST.md).

## Secrets and Data

- Never commit env files, provider keys, tokens, database dumps, or production user data.
- Keep model provider keys and integration credentials outside client bundles.
- Avoid logging personal data, private content, or raw secrets.

## Supported Versions

Security fixes target the current default branch unless maintainers announce a release policy.
