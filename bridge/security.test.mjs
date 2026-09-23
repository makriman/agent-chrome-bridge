import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { assertLoopbackBridgeUrl } from "./bridge-url.mjs";
import { evaluateLease } from "./lease.mjs";
import { confineArtifactsFile, confineArtifactsPath } from "./paths.mjs";
import { acceptFinalActionGrant, hashApprovalToken, prepareQueuedCommand } from "./queue-policy.mjs";
import { BRIDGE_PORT, DEFAULT_BRIDGE_URL, PROTOCOL_VERSION } from "./protocol.mjs";
import { BrowserClient } from "./sdk.mjs";
import { assertNavigationInput, isFinalActionCommand } from "../extension/final-actions.js";

const repoRoot = "/repo";
const arm = "arm_test";
const origin = "https://example.com";
const token = "a".repeat(64);

function armedContext(extra = {}) {
  return {
    repoRoot,
    armSessionId: arm,
    armedOrigin: origin,
    activeCommands: [],
    grants: new Map(),
    now: 1_000_000,
    ...extra
  };
}

function grantFor(rawToken, context) {
  const expiresAt = context.now + 60_000;
  assert.equal(
    acceptFinalActionGrant(context.grants, {
      tokenHash: hashApprovalToken(rawToken),
      expiresAt,
      armSessionId: context.armSessionId,
      origin: context.armedOrigin
    }, context.now),
    true
  );
}

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}

check("confines screenshot paths to artifacts", () => {
  const saved = confineArtifactsPath(repoRoot, "artifacts/screenshot.png");
  assert.equal(saved, "/repo/artifacts/screenshot.png");
  assert.throws(() => confineArtifactsPath(repoRoot, "/tmp/screenshot.png"), /Absolute paths/);
  assert.throws(() => confineArtifactsPath(repoRoot, "artifacts/../../.ssh/authorized_keys"), /escapes/);
  assert.throws(() => confineArtifactsPath(repoRoot, "../.bridge-token"), /escapes/);
  assert.throws(() => confineArtifactsPath(repoRoot, "artifacts/../README.md"), /escapes/);
  assert.equal(confineArtifactsPath(repoRoot, "artifacts/runs/demo/screenshots/a.png"), "/repo/artifacts/runs/demo/screenshots/a.png");
});

check("rejects symlink escapes under artifacts", async () => {
  const repo = await mkdtemp(join(tmpdir(), "acb-paths-"));
  try {
    await mkdir(join(repo, "artifacts"));
    await symlink(tmpdir(), join(repo, "artifacts", "escape"));
    await assert.rejects(confineArtifactsFile(repo, "artifacts/escape/pwned.txt"), /escapes/);
    const saved = await confineArtifactsFile(repo, "artifacts/screenshots/ok.png");
    assert.equal(saved, join(repo, "artifacts", "screenshots", "ok.png"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

check("filters navigation schemes", () => {
  assert.equal(assertNavigationInput("https://example.com/path"), "https://example.com/path");
  assert.equal(assertNavigationInput("/dashboard"), "/dashboard");
  assert.throws(() => assertNavigationInput("javascript:alert(1)"), /scheme/i);
  assert.throws(() => assertNavigationInput("file:///etc/passwd"), /scheme/i);
  assert.throws(() => assertNavigationInput("chrome://settings"), /scheme/i);
  assert.throws(() => assertNavigationInput("https://user:pass@example.com/"), /credentials/);
});

check("classifies final actions without flagging typed drafts", () => {
  assert.equal(isFinalActionCommand({ type: "click", text: "Send" }), true);
  assert.equal(isFinalActionCommand({ type: "click", role: "button", text: "Delete" }), true);
  assert.equal(isFinalActionCommand({ type: "click", selector: "button[type=submit]" }), true);
  assert.equal(isFinalActionCommand({ type: "key", key: "Enter" }), true);
  assert.equal(isFinalActionCommand({ type: "click", text: "Reply" }), false);
  assert.equal(isFinalActionCommand({ type: "type", text: "please send the draft" }), false);
  assert.equal(isFinalActionCommand({ type: "fill", text: "delete me later" }), false);
  assert.equal(isFinalActionCommand({ type: "inspect" }), false);
});

check("queue policy requires an arm, a confined path, and a popup grant", () => {
  const context = armedContext();
  assert.throws(() => prepareQueuedCommand({ type: "inspect" }, { ...context, armSessionId: null }), /not armed/);
  const inspect = prepareQueuedCommand({ type: "inspect", queueId: "cli_a" }, context);
  assert.equal(inspect.command.armSessionId, arm);
  assert.equal(inspect.command.approvalToken, undefined);
  assert.throws(() => prepareQueuedCommand({ type: "screenshot", output: "/tmp/x.png" }, context), /Absolute paths/);
  assert.throws(() => prepareQueuedCommand({ type: "navigate", url: "javascript:alert(1)" }, context), /scheme/i);
  assert.throws(() => prepareQueuedCommand({ type: "click", text: "Send", queueId: "cli_a" }, context), /Final action/);
  grantFor(token, context);
  const send = prepareQueuedCommand({ type: "click", text: "Send", queueId: "cli_a", approvalToken: token }, context);
  assert.equal(send.command.approvalToken, undefined);
  assert.equal(send.command.finalActionApproval, "accepted");
  assert.throws(
    () => prepareQueuedCommand(
      { type: "inspect", queueId: "cli_b" },
      { ...context, activeCommands: [{ queueId: "cli_a", type: "inspect", id: "cmd_1" }] }
    ),
    /already has work/
  );
  const stop = prepareQueuedCommand({ type: "stop" }, { ...context, armSessionId: null, activeCommands: [{ queueId: "cli_a", type: "inspect", id: "cmd_1" }] });
  assert.equal(stop.command.type, "stop");
});

check("lease waits for the armed poller and drops null arm ids", () => {
  assert.deepEqual(evaluateLease({ status: "queued", type: "inspect", armSessionId: arm }, null), { action: "wait" });
  assert.equal(evaluateLease({ status: "queued", type: "inspect", armSessionId: null }, arm).action, "stale");
  assert.equal(evaluateLease({ status: "queued", type: "inspect", armSessionId: "arm_other" }, arm).action, "stale");
  assert.equal(evaluateLease({ status: "queued", type: "inspect", armSessionId: arm }, arm).action, "lease");
  assert.equal(evaluateLease({ status: "queued", type: "status", armSessionId: null }, null).action, "lease");
});

check("pins the loopback URL to 127.0.0.1:18474", () => {
  assert.equal(assertLoopbackBridgeUrl(DEFAULT_BRIDGE_URL), DEFAULT_BRIDGE_URL);
  assert.equal(BRIDGE_PORT, 18474);
  assert.throws(() => assertLoopbackBridgeUrl("http://localhost:18474"), /127\.0\.0\.1/);
  assert.throws(() => assertLoopbackBridgeUrl("http://127.0.0.1:18475"), /18474/);
  assert.throws(() => assertLoopbackBridgeUrl("https://127.0.0.1:18474"), /http:\/\/127\.0\.0\.1:18474/);
});

check("env approval does not bypass the SDK pause", async () => {
  const previous = process.env.CODEX_CHROME_BRIDGE_APPROVE;
  process.env.CODEX_CHROME_BRIDGE_APPROVE = "1";
  try {
    const client = new BrowserClient({ offline: true, dryRun: true });
    await assert.rejects(client.requireApproval("Send support reply"), /Approval required/);
    const approved = new BrowserClient({ offline: true, dryRun: true, approve: true });
    const receipt = await approved.requireApproval("Send support reply");
    assert.equal(receipt.bridgeFinalAction, false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHROME_BRIDGE_APPROVE;
    else process.env.CODEX_CHROME_BRIDGE_APPROVE = previous;
  }
});

check("SDK refuses final actions and escaped screenshots before a dry run", async () => {
  const client = new BrowserClient({ offline: true, dryRun: true, root: repoRoot });
  await assert.rejects(client.command({ type: "click", text: "Purchase" }), /Final action/);
  await assert.rejects(client.command({ type: "screenshot", output: "../../.ssh/authorized_keys" }), /escapes/);
  const typed = await client.command({ type: "type", text: "please send the draft" });
  assert.equal(typed.status, "succeeded");
  const granted = new BrowserClient({
    offline: true,
    dryRun: true,
    root: repoRoot,
    approvalToken: token
  });
  const send = await granted.command({ type: "click", text: "Send" });
  assert.equal(send.dryRun, true);
  assert.equal(send.result.command.approvalToken, "[redacted]");
});

check("extension and bridge share the pinned protocol", () => {
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(background, new RegExp(`PROTOCOL_VERSION = ${PROTOCOL_VERSION}`));
  assert.match(background, /BRIDGE_HOST = "127\.0\.0\.1"/);
  assert.match(background, /BRIDGE_PORT = 18474/);
  assert.match(content, /postMessage/);
  assert.match(server, /pathname === "\/poll"/);
  // /poll and /event stay unauthenticated here. That High finding is a separate change.
  const pollHandler = server.slice(server.indexOf('pathname === "/poll"'), server.indexOf('pathname === "/command"'));
  assert.doesNotMatch(pollHandler, /requireToken/);
  assert.equal(PROTOCOL_VERSION, 3);
});

check("offline workflows stay inside artifacts", () => {
  const partners = spawnSync(process.execPath, [
    "bridge/run-workflow.mjs",
    "docs/examples/partners-read.workflow.mjs",
    "--offline",
    "--quiet",
    "--run-dir",
    "artifacts/runs/security-test-partners"
  ], { encoding: "utf8" });
  assert.equal(partners.status, 0, partners.stderr || partners.stdout);

  const escaped = spawnSync(process.execPath, [
    "bridge/run-workflow.mjs",
    "docs/examples/partners-read.workflow.mjs",
    "--offline",
    "--run-dir",
    "../outside"
  ], { encoding: "utf8" });
  assert.notEqual(escaped.status, 0);
  assert.match(`${escaped.stderr}\n${escaped.stdout}`, /escapes|artifacts/);

  const send = spawnSync(process.execPath, [
    "bridge/run-workflow.mjs",
    "docs/examples/draft-support-reply.workflow.json",
    "--offline",
    "--approve",
    "--run-dir",
    "artifacts/runs/security-test-send"
  ], { encoding: "utf8" });
  assert.notEqual(send.status, 0);
  assert.match(`${send.stderr}\n${send.stdout}`, /Final action/);
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}
if (failed > 0) {
  console.error(`${failed} security check(s) failed`);
  process.exit(1);
}
console.log(`ok ${checks.length} security checks`);
