import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { proofMatches } from "../extension/extension-credential.mjs";
import { startBridge } from "./server.mjs";

const EXTENSION_ID = "ext_11111111-1111-4111-8111-111111111111";

function request(bridge, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: bridge.port,
        path,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let payload = null;
          try {
            payload = text ? JSON.parse(text) : null;
          } catch (_) {
            payload = { raw: text };
          }
          resolve({ status: res.statusCode, headers: res.headers, text, payload });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function withBridge(fn) {
  const root = await mkdtemp(join(tmpdir(), "agent-chrome-bridge-"));
  const bridge = await startBridge({ port: 0, root, quiet: true });
  try {
    await fn(bridge, root);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function pair(bridge, extensionInstanceId = EXTENSION_ID) {
  const started = await request(bridge, "/pair/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-bridge-token": bridge.token
    },
    body: {}
  });
  assert.equal(started.status, 200);
  assert.equal(started.payload.extensionToken, undefined);
  const redeemed = await request(bridge, "/pair/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { ticket: started.payload.ticket, extensionInstanceId }
  });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.payload.extensionToken, bridge.extensionToken);
  return { ticket: started.payload.ticket, extensionInstanceId, extensionToken: redeemed.payload.extensionToken };
}

function extensionHeaders(extensionToken) {
  return {
    "content-type": "application/json",
    "x-codex-bridge-extension-token": extensionToken
  };
}

test("poll and event reject callers that are not the paired extension", async () => {
  await withBridge(async (bridge) => {
    const queued = await request(bridge, "/command", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-bridge-token": bridge.token
      },
      body: { type: "type", text: "do-not-leak" }
    });
    assert.equal(queued.status, 200);
    const commandId = queued.payload.command.id;

    const barePoll = await request(bridge, `/poll?extensionInstanceId=${EXTENSION_ID}`);
    assert.equal(barePoll.status, 403);
    assert.equal(JSON.stringify(barePoll.payload).includes("do-not-leak"), false);

    const operatorPoll = await request(bridge, `/poll?extensionInstanceId=${EXTENSION_ID}`, {
      headers: { "x-codex-bridge-token": bridge.token }
    });
    assert.equal(operatorPoll.status, 403);

    const queryPoll = await request(
      bridge,
      `/poll?extensionInstanceId=${EXTENSION_ID}&x-codex-bridge-extension-token=${bridge.extensionToken}`
    );
    assert.equal(queryPoll.status, 403);

    const bareEvent = await request(bridge, "/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        type: "arm-state",
        payload: { extensionInstanceId: EXTENSION_ID },
        state: { armed: { url: "https://evil.example/phish", title: "spoof" } }
      }
    });
    assert.equal(bareEvent.status, 403);

    const operatorEvent = await request(bridge, "/event", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-bridge-token": bridge.token
      },
      body: {
        type: "command-result",
        payload: { id: commandId, extensionInstanceId: EXTENSION_ID, status: "succeeded", result: { forged: true } }
      }
    });
    assert.equal(operatorEvent.status, 403);

    const status = await request(bridge, "/status", {
      headers: { "x-codex-bridge-token": bridge.token }
    });
    assert.equal(status.payload.extensionPaired, false);
    assert.equal(status.payload.latestExtensionState, null);
    assert.equal(status.payload.connected, false);
    assert.equal(JSON.stringify(status.payload).includes(bridge.token), false);
    assert.equal(JSON.stringify(status.payload).includes(bridge.extensionToken), false);

    const queue = await request(bridge, "/queue", {
      headers: { "x-codex-bridge-token": bridge.token }
    });
    assert.equal(queue.payload.pending.length, 1);
  });
});

test("paired extension can lease a command and later callers cannot overwrite the result", async () => {
  await withBridge(async (bridge) => {
    const session = await pair(bridge);
    const queued = await request(bridge, "/command", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-bridge-token": bridge.token
      },
      body: { type: "type", text: "typed-secret" }
    });
    const commandId = queued.payload.command.id;

    const earlyResult = await request(bridge, "/event", {
      method: "POST",
      headers: extensionHeaders(session.extensionToken),
      body: {
        type: "command-result",
        payload: {
          id: commandId,
          extensionInstanceId: session.extensionInstanceId,
          status: "succeeded",
          result: { forged: true }
        }
      }
    });
    assert.equal(earlyResult.status, 200);
    assert.equal(earlyResult.payload.ignored, true);

    const wrongExtension = await request(bridge, `/poll?extensionInstanceId=ext_22222222-2222-4222-8222-222222222222`, {
      headers: { "x-codex-bridge-extension-token": session.extensionToken }
    });
    assert.equal(wrongExtension.status, 403);

    const polled = await request(bridge, `/poll?extensionInstanceId=${session.extensionInstanceId}`, {
      headers: { "x-codex-bridge-extension-token": session.extensionToken }
    });
    assert.equal(polled.status, 200);
    assert.equal(polled.payload.text, "typed-secret");
    assert.equal(polled.payload.status, "leased");

    const empty = await request(bridge, `/poll?extensionInstanceId=${session.extensionInstanceId}`, {
      headers: { "x-codex-bridge-extension-token": session.extensionToken }
    });
    assert.equal(empty.payload.id, undefined);

    const result = await request(bridge, "/event", {
      method: "POST",
      headers: extensionHeaders(session.extensionToken),
      body: {
        type: "command-result",
        payload: {
          id: commandId,
          extensionInstanceId: session.extensionInstanceId,
          status: "succeeded",
          result: { typed: 12 }
        }
      }
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.status, "succeeded");

    const forged = await request(bridge, "/event", {
      method: "POST",
      headers: extensionHeaders(session.extensionToken),
      body: {
        type: "command-result",
        payload: {
          id: commandId,
          extensionInstanceId: session.extensionInstanceId,
          status: "failed",
          error: "forged"
        }
      }
    });
    assert.equal(forged.status, 200);
    assert.equal(forged.payload.ignored, true);

    const unknown = await request(bridge, "/event", {
      method: "POST",
      headers: extensionHeaders(session.extensionToken),
      body: {
        type: "command-result",
        payload: {
          id: "cmd_does_not_exist",
          extensionInstanceId: session.extensionInstanceId,
          status: "succeeded"
        }
      }
    });
    assert.equal(unknown.status, 404);

    const stored = await request(bridge, `/result?id=${encodeURIComponent(commandId)}`, {
      headers: { "x-codex-bridge-token": bridge.token }
    });
    assert.equal(stored.payload.command.status, "succeeded");
    assert.equal(stored.payload.command.result.typed, 12);
    assert.equal(stored.payload.command.error, null);

    const missing = await request(bridge, "/result?id=cmd_does_not_exist", {
      headers: { "x-codex-bridge-token": bridge.token }
    });
    assert.equal(missing.payload.status, "unknown");
    assert.equal(missing.payload.command, null);
  });
});

test("heartbeat cannot extend a lease past the original deadline", async () => {
  await withBridge(async (bridge) => {
    const session = await pair(bridge);
    await request(bridge, "/command", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-bridge-token": bridge.token
      },
      body: { type: "wait", ms: 1, timeoutMs: 1000 }
    });
    const polled = await request(bridge, `/poll?extensionInstanceId=${session.extensionInstanceId}`, {
      headers: { "x-codex-bridge-extension-token": session.extensionToken }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const beat = await request(bridge, "/event", {
      method: "POST",
      headers: extensionHeaders(session.extensionToken),
      body: {
        type: "command-heartbeat",
        payload: { id: polled.payload.id, extensionInstanceId: session.extensionInstanceId }
      }
    });
    assert.equal(beat.status, 200);
    assert.equal(beat.payload.leaseExpiresAt, beat.payload.deadlineAt);
    assert.equal(beat.payload.deadlineAt, polled.payload.deadlineAt);
  });
});

test("pairing ticket is single-use and the extension session survives a bridge restart", async () => {
  await withBridge(async (bridge, root) => {
    const started = await request(bridge, "/pair/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-bridge-token": bridge.token
      },
      body: {}
    });
    const page = await request(bridge, "/pair");
    assert.equal(page.status, 200);
    assert.equal(page.text.includes(started.payload.ticket), false);

    const redeemed = await request(bridge, "/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { ticket: started.payload.ticket, extensionInstanceId: EXTENSION_ID }
    });
    assert.equal(redeemed.status, 200);
    const reused = await request(bridge, "/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { ticket: started.payload.ticket, extensionInstanceId: EXTENSION_ID }
    });
    assert.equal(reused.status, 403);

    const unauthenticatedStart = await request(bridge, "/pair/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {}
    });
    assert.equal(unauthenticatedStart.status, 403);

    const extensionCannotEnqueue = await request(bridge, "/command", {
      method: "POST",
      headers: extensionHeaders(redeemed.payload.extensionToken),
      body: { type: "click", x: 1, y: 1 }
    });
    assert.equal(extensionCannotEnqueue.status, 403);

    const restarted = await startBridge({ port: 0, root, quiet: true });
    try {
      assert.equal(restarted.extensionToken, bridge.extensionToken);
      assert.notEqual(restarted.token, restarted.extensionToken);
      const polled = await request(restarted, `/poll?extensionInstanceId=${EXTENSION_ID}`, {
        headers: { "x-codex-bridge-extension-token": restarted.extensionToken }
      });
      assert.equal(polled.status, 200);
      const status = await request(restarted, "/status", {
        headers: { "x-codex-bridge-token": restarted.token }
      });
      assert.equal(status.payload.extensionPaired, true);
      assert.equal(status.payload.protocolVersion, 3);
    } finally {
      await restarted.close();
    }
  });
});

test("loopback responses do not enable cross-origin or private-network reads", async () => {
  await withBridge(async (bridge) => {
    const hello = await request(bridge, "/hello");
    assert.equal(hello.status, 200);
    assert.equal(hello.payload.protocolVersion, 3);
    assert.equal(hello.headers["access-control-allow-origin"], undefined);
    assert.equal(hello.headers["access-control-allow-private-network"], undefined);

    const status = await request(bridge, "/public-status");
    assert.equal(status.headers["access-control-allow-origin"], undefined);
    assert.equal(status.headers["access-control-allow-private-network"], undefined);

    const preflight = await request(bridge, "/poll", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
    assert.equal(preflight.headers["access-control-allow-private-network"], undefined);

    const rebinding = await request(bridge, "/poll", { headers: { host: "evil.example" } });
    assert.equal(rebinding.status, 403);
    assert.equal(rebinding.payload.error, "Rejected host.");

    const armed = await request(bridge, "/event", {
      method: "POST",
      headers: {
        host: "evil.example",
        "content-type": "application/json",
        "x-codex-bridge-extension-token": bridge.extensionToken
      },
      body: { type: "hello", payload: { extensionInstanceId: EXTENSION_ID } }
    });
    assert.equal(armed.status, 403);
  });
});

test("public status hides the token fingerprint and active command", async () => {
  await withBridge(async (bridge) => {
    const status = await request(bridge, "/public-status");
    assert.equal(status.status, 200);
    assert.equal(Object.hasOwn(status.payload, "tokenFingerprint"), false);
    assert.equal(Object.hasOwn(status.payload, "activeCommand"), false);
    assert.equal(status.payload.protocolVersion, 3);
    assert.equal(JSON.stringify(status.payload).includes(bridge.token), false);
    assert.equal(JSON.stringify(status.payload).includes(bridge.extensionToken), false);

    const doctor = await request(bridge, "/doctor", {
      headers: { "x-codex-bridge-token": bridge.token }
    });
    assert.equal(doctor.status, 200);
    assert.equal(doctor.payload.doctor.extensionSession.paired, false);
    assert.equal(doctor.payload.doctor.extensionSession.header, "x-codex-bridge-extension-token");
    assert.equal(doctor.payload.doctor.listen.host, "127.0.0.1");
    assert.equal(doctor.payload.doctor.listen.pinned, false);
    assert.equal(doctor.payload.tokenFingerprint, doctor.payload.doctor.bridgeTokenFingerprint);
  });
});

test("paired poll proves the session and session-proof does not echo the extension token", async () => {
  await withBridge(async (bridge) => {
    const denied = await request(bridge, `/poll?extensionInstanceId=${EXTENSION_ID}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["x-codex-bridge-extension-session"], undefined);

    const session = await pair(bridge);
    const nonce = "ab".repeat(32);
    const proof = await request(bridge, `/session-proof?nonce=${nonce}`);
    assert.equal(proof.status, 200);
    assert.equal(JSON.stringify(proof.payload).includes(bridge.extensionToken), false);
    assert.equal(await proofMatches(session.extensionToken, nonce, proof.payload.proof), true);
    assert.equal(proof.payload.extensionToken, undefined);

    const polled = await request(bridge, `/poll?extensionInstanceId=${EXTENSION_ID}`, {
      headers: { "x-codex-bridge-extension-token": session.extensionToken }
    });
    assert.equal(polled.status, 200);
    assert.equal(polled.headers["x-codex-bridge-protocol"], "3");
    assert.equal(polled.headers["x-codex-bridge-extension-session"], "paired");

    const doctor = await request(bridge, "/doctor", {
      headers: { "x-codex-bridge-token": bridge.token }
    });
    assert.equal(doctor.payload.doctor.extensionSession.paired, true);
    assert.equal(doctor.payload.extensionPaired, true);
  });
});
