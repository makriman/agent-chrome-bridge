# Extension credential

The Agent Chrome Bridge extension **does not have a credential of its own**.

It polls `http://127.0.0.1:18474` and posts events there with no `x-codex-bridge-extension-token`. The operator token in `.bridge-token` stays with the CLI, the SDK, and the bridge process. The extension cannot read that file, and this build does not issue a separate extension session.

Whoever accepts connections on `127.0.0.1:18474` can hand commands to an armed tab. A fingerprint comparison is the check available without changing the protocol:

1. Start `npm run bridge` and read the token fingerprint in the log.
2. Run `node bridge/control.mjs doctor`. `code` must be `"match"`, and `tokenFingerprint` must equal the log.
3. Open the extension popup. It shows the same listener fingerprint from `GET /hello`.
4. Check **I compared this fingerprint with doctor** only when they match, then click **Arm tab**.
5. If doctor prints `token_mismatch` or `token_unverified`, click **Stop** and do not queue commands. Doctor does not send `.bridge-token` to that listener.

This is a pairing confirmation in the popup. It does not add a header, change command JSON, or bump `PROTOCOL_VERSION`. Poll and event routes are unchanged.

The popup gate is not a cryptographic pairing. A local program can still speak the existing poll protocol. Treat a fingerprint mismatch as "do not arm."

Related doctor codes:

| Code | Meaning |
| --- | --- |
| `match` | Local token fingerprint matches the listener, and `/doctor` accepted the token. |
| `token_mismatch` | Listener fingerprint differs. Token was not sent. |
| `token_unverified` | Listener answered without a fingerprint, or refused public status. Token was not sent. |
| `token_file_drift` | `.bridge-token` on disk does not match the running process. |
| `token_rejected` | Fingerprints matched, then `/doctor` returned 403. |
| `token_unreadable` | Token file is missing, short, or unreadable. The CLI does not overwrite it. |
| `token_probe_limited` | Too many unpaired public probes or rejected token attempts. |
| `bridge_unreachable` | Nothing accepted the loopback connection. |
| `stale_bridge` | The process on the port does not speak this protocol. |
