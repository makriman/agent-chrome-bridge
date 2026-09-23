import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assessDoctor, bridgeUrlProblem } from "./doctor-report.mjs";
import { DEFAULT_BRIDGE_URL, PROTOCOL_VERSION } from "./protocol.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const FINGERPRINT = "abc123abc123";

function healthy(overrides = {}) {
  return {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    expectedProtocolVersion: PROTOCOL_VERSION,
    localTokenFile: { exists: true, validLength: true, fingerprint: FINGERPRINT },
    publicStatus: { ok: true, protocolVersion: PROTOCOL_VERSION },
    remote: {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      doctor: {
        bridgeTokenFingerprint: FINGERPRINT,
        tokenFile: {
          exists: true,
          validLength: true,
          matchesRunningBridge: true,
          fingerprint: FINGERPRINT
        },
        listen: { host: "127.0.0.1", port: 18474, pinned: true },
        extensionSession: { paired: true, extensionInstanceId: "ext_11111111-1111-4111-8111-111111111111" }
      }
    },
    transportError: null,
    ...overrides
  };
}

test("doctor accepts a paired listener whose fingerprint matches this checkout", () => {
  const report = assessDoctor(healthy());
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
});

test("doctor fails closed on the wrong port or host before talking to it", () => {
  assert.match(bridgeUrlProblem("http://127.0.0.1:18475"), /18474/);
  assert.match(bridgeUrlProblem("http://localhost:18474"), /127\.0\.0\.1/);
  assert.match(bridgeUrlProblem("https://127.0.0.1:18474"), /http:\/\/127\.0\.0\.1:18474/);
  const report = assessDoctor(healthy({ bridgeUrl: "http://127.0.0.1:18475" }));
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].code, "wrong_port");
});

test("doctor fails closed when the listener is down", () => {
  const report = assessDoctor(healthy({
    transportError: "connect ECONNREFUSED 127.0.0.1:18474",
    remote: null,
    publicStatus: null
  }));
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "listener_unreachable");
  assert.match(report.failures[0].hint, /npm run bridge/);
});

test("doctor fails closed on a protocol mismatch", () => {
  const report = assessDoctor(healthy({
    publicStatus: { ok: true, protocolVersion: 2 },
    remote: {
      ok: true,
      protocolVersion: 2,
      doctor: healthy().remote.doctor
    }
  }));
  assert.equal(report.ok, false);
  assert.equal(report.failures.some((failure) => failure.code === "protocol_mismatch"), true);
});

test("doctor fails closed when the checkout token does not match the listener", () => {
  const remote = healthy().remote;
  remote.doctor.bridgeTokenFingerprint = "ffffffffffff";
  const report = assessDoctor(healthy({ remote }));
  assert.equal(report.ok, false);
  assert.equal(report.failures.some((failure) => failure.code === "token_mismatch"), true);
  assert.doesNotMatch(JSON.stringify(report), /[a-f0-9]{64}/);
});

test("doctor fails closed when the listener file does not match the loaded token", () => {
  const remote = healthy().remote;
  remote.doctor.tokenFile = {
    exists: true,
    validLength: true,
    matchesRunningBridge: false,
    fingerprint: FINGERPRINT
  };
  const report = assessDoctor(healthy({ remote }));
  assert.equal(report.ok, false);
  assert.equal(report.failures.some((failure) => failure.code === "token_file"), true);
});

test("doctor fails closed when the extension session is unpaired", () => {
  const remote = healthy().remote;
  remote.doctor.extensionSession = { paired: false, extensionInstanceId: null };
  const report = assessDoctor(healthy({ remote }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((failure) => failure.code), ["extension_unpaired"]);
  assert.match(report.failures[0].hint, /control\.mjs pair/);
  assert.match(report.failures[0].hint, /reload/i);
});

test("doctor fails closed when the listener reports a different port", () => {
  const remote = healthy().remote;
  remote.doctor.listen = { host: "127.0.0.1", port: 18475, pinned: false };
  const report = assessDoctor(healthy({ remote }));
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "wrong_port");
});

test("doctor CLI exits 1 for a non-pinned URL and does not open that port", async () => {
  const child = spawn(process.execPath, ["bridge/control.mjs", "doctor"], {
    cwd: ROOT,
    env: { ...process.env, CODEX_CHROME_BRIDGE_URL: "http://127.0.0.1:9" }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 1, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.failures[0].code, "wrong_port");
  assert.equal(payload.failures.length, 1);
  assert.doesNotMatch(stdout, /[a-f0-9]{64}/);
});

test("doctor does not treat a missing authenticated payload as success", () => {
  const report = assessDoctor(healthy({ remote: null, publicStatus: { ok: true, protocolVersion: 3 } }));
  assert.equal(report.ok, false);
  assert.equal(report.failures.some((failure) => failure.code === "token_mismatch"), true);
});
