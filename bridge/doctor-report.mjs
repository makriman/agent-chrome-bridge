import { BRIDGE_HOST, BRIDGE_PORT, DEFAULT_BRIDGE_URL, PROTOCOL_VERSION } from "./protocol.mjs";

export function bridgeUrlProblem(bridgeUrl) {
  let parsed;
  try {
    parsed = new URL(bridgeUrl);
  } catch (_) {
    return `Bridge URL must be ${DEFAULT_BRIDGE_URL}.`;
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== BRIDGE_HOST || parsed.port !== String(BRIDGE_PORT)) {
    return `Bridge URL must be ${DEFAULT_BRIDGE_URL}. The extension is pinned to that loopback address and does not follow localhost, other hosts, or custom ports. Unset CODEX_CHROME_BRIDGE_URL, AGENT_CHROME_BRIDGE_PORT, and CODEX_CHROME_BRIDGE_PORT.`;
  }
  return null;
}

function fail(failures, code, message, hint) {
  failures.push({ code, message, hint });
}

export function assessDoctor({
  bridgeUrl,
  expectedProtocolVersion = PROTOCOL_VERSION,
  localTokenFile = null,
  publicStatus = null,
  remote = null,
  transportError = null
} = {}) {
  const failures = [];
  const urlProblem = bridgeUrlProblem(bridgeUrl);
  if (urlProblem) {
    fail(
      failures,
      "wrong_port",
      urlProblem,
      `Run doctor against ${DEFAULT_BRIDGE_URL}. Start the bridge with npm run bridge from this checkout.`
    );
    return { ok: false, failures };
  }

  if (transportError) {
    fail(
      failures,
      "listener_unreachable",
      String(transportError),
      `Nothing accepted ${DEFAULT_BRIDGE_URL}. Start it with npm run bridge. See who holds the port with: lsof -nP -iTCP:${BRIDGE_PORT} -sTCP:LISTEN`
    );
    return { ok: false, failures };
  }

  const protocolSource = remote && remote.protocolVersion !== undefined ? remote : publicStatus;
  const protocol = protocolSource ? protocolSource.protocolVersion : undefined;
  if (protocol === undefined || protocol === null) {
    fail(
      failures,
      "protocol_mismatch",
      "The listener did not report protocolVersion.",
      "Restart from this checkout: lsof -ti tcp:18474 | xargs -r kill && npm run bridge. Then reload the extension and pair again."
    );
  } else if (Number(protocol) !== Number(expectedProtocolVersion)) {
    fail(
      failures,
      "protocol_mismatch",
      `Listener protocol v${protocol} does not match this checkout v${expectedProtocolVersion}.`,
      "Restart npm run bridge from this checkout, reload the extension, and pair again."
    );
  }

  if (!remote || !remote.doctor) {
    fail(
      failures,
      "token_mismatch",
      "This checkout could not read authenticated /doctor from the live listener.",
      "The process on 127.0.0.1:18474 does not hold this checkout's .bridge-token. Restart npm run bridge from this repo. Do not print or copy the token."
    );
    return { ok: false, failures };
  }

  const remoteFingerprint = remote.doctor.bridgeTokenFingerprint || null;
  const localFingerprint = localTokenFile && localTokenFile.fingerprint;
  if (!localFingerprint || !remoteFingerprint || localFingerprint !== remoteFingerprint) {
    fail(
      failures,
      "token_mismatch",
      "This checkout's token fingerprint does not match the live listener.",
      "Restart npm run bridge in this checkout so the listener reloads .bridge-token. Do not copy token files between checkouts."
    );
  }

  const tokenFile = remote.doctor.tokenFile;
  if (!tokenFile || tokenFile.exists !== true || tokenFile.validLength !== true || tokenFile.matchesRunningBridge !== true) {
    fail(
      failures,
      "token_file",
      "The listener's token file does not match the token that process loaded.",
      "Restart npm run bridge from this checkout. A replaced .bridge-token is ignored until restart."
    );
  } else if (localFingerprint && tokenFile.fingerprint && tokenFile.fingerprint !== localFingerprint) {
    fail(
      failures,
      "token_mismatch",
      "The listener's token file fingerprint does not match this checkout.",
      "Doctor is talking to a bridge started from a different checkout. Stop that process and start npm run bridge here."
    );
  }

  const listen = remote.doctor.listen;
  if (!listen || listen.host !== BRIDGE_HOST || Number(listen.port) !== BRIDGE_PORT) {
    fail(
      failures,
      "wrong_port",
      `Listener reports ${listen ? `${listen.host}:${listen.port}` : "no listen block"}.`,
      `The extension only connects to ${DEFAULT_BRIDGE_URL}. Unset port overrides and restart npm run bridge.`
    );
  }

  const session = remote.doctor.extensionSession;
  if (!session || session.paired !== true) {
    fail(
      failures,
      "extension_unpaired",
      "The extension has no paired session with this bridge.",
      "Run `node bridge/control.mjs pair`. Paste the code into the popup, or open the printed http://127.0.0.1:18474/pair#… page and click Pair from tab. Reloading the unpacked extension clears chrome.storage.session; pair again after every reload. Do not paste the pairing code into chat."
    );
  }

  return { ok: failures.length === 0, failures };
}
