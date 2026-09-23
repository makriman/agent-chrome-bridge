import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyDoctorAuth } from "./doctor-auth.mjs";
import { AUTH_FAIL_LIMIT, createProbeLimiter, PUBLIC_PROBE_LIMIT } from "./probe-limit.mjs";
import { fingerprintToken, readOperatorToken, secretEquals } from "./token-file.mjs";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

test("secret compare accepts only the same token bytes", () => {
  assert.equal(secretEquals(TOKEN_A, TOKEN_A), true);
  assert.equal(secretEquals(TOKEN_A, TOKEN_B), false);
  assert.equal(secretEquals(TOKEN_A, TOKEN_A.slice(0, 32)), false);
  assert.equal(secretEquals("", TOKEN_A), false);
  assert.equal(secretEquals(TOKEN_A, null), false);
});

test("fingerprint is 12 hex chars and ignores short files", () => {
  assert.match(fingerprintToken(TOKEN_A), /^[a-f0-9]{12}$/);
  assert.equal(fingerprintToken("short"), null);
  assert.notEqual(fingerprintToken(TOKEN_A), fingerprintToken(TOKEN_B));
});

test("reading a token never creates or truncates the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-token-"));
  const missing = join(dir, ".bridge-token");
  await assert.rejects(readOperatorToken(missing), /does not rewrite/);
  await assert.rejects(stat(missing));

  const path = join(dir, "existing");
  await writeFile(path, `${TOKEN_A}\n`, { mode: 0o600 });
  assert.equal(await readOperatorToken(path), TOKEN_A);
  assert.equal((await readFile(path, "utf8")).trim(), TOKEN_A);

  await writeFile(path, "tiny\n");
  await assert.rejects(readOperatorToken(path), /does not rewrite/);
  assert.equal((await readFile(path, "utf8")).trim(), "tiny");
  await rm(dir, { recursive: true, force: true });
});

test("doctor fails closed on a mismatched listener fingerprint", () => {
  const mismatch = classifyDoctorAuth({
    localFingerprint: "aaaaaaaaaaaa",
    listenerFingerprint: "bbbbbbbbbbbb"
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "token_mismatch");

  const drift = classifyDoctorAuth({
    localFingerprint: "aaaaaaaaaaaa",
    listenerFingerprint: "aaaaaaaaaaaa",
    matchesRunningBridge: false
  });
  assert.equal(drift.code, "token_file_drift");

  const rejected = classifyDoctorAuth({
    localFingerprint: "aaaaaaaaaaaa",
    listenerFingerprint: "aaaaaaaaaaaa",
    doctorStatus: 403
  });
  assert.equal(rejected.code, "token_rejected");

  const limited = classifyDoctorAuth({
    localFingerprint: "aaaaaaaaaaaa",
    listenerFingerprint: "aaaaaaaaaaaa",
    doctorStatus: 429
  });
  assert.equal(limited.code, "token_probe_limited");

  const match = classifyDoctorAuth({
    localFingerprint: "aaaaaaaaaaaa",
    listenerFingerprint: "aaaaaaaaaaaa",
    doctorStatus: 200,
    matchesRunningBridge: true
  });
  assert.equal(match.ok, true);
  assert.equal(match.code, "match");
});

test("public probe budget covers extension hello and then rejects a burst", () => {
  let ts = 1_000;
  const limiter = createProbeLimiter({
    limit: PUBLIC_PROBE_LIMIT,
    windowMs: 10_000,
    now: () => ts
  });
  for (let i = 0; i < 5; i += 1) {
    ts += 2_000;
    assert.equal(limiter.allow(), true);
  }
  ts += 10_000;
  for (let i = 0; i < PUBLIC_PROBE_LIMIT; i += 1) assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
  ts += 10_000;
  assert.equal(limiter.allow(), true);
});

test("poll and event stay on the existing unauthenticated protocol", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const poll = source.slice(source.indexOf('pathname === "/poll"'), source.indexOf('pathname === "/command"'));
  const event = source.slice(source.indexOf('pathname === "/event"'), source.indexOf('pathname === "/result"'));
  assert.equal(poll.includes("requireToken"), false);
  assert.equal(poll.includes("leaseNextCommand"), true);
  assert.equal(event.includes("requireToken"), false);
  assert.equal(event.includes("updateFromEvent"), true);
  assert.equal(source.includes("PROTOCOL_VERSION"), true);
});

test("rejected token attempts are limited separately from a matched doctor call", () => {
  let ts = 0;
  const limiter = createProbeLimiter({
    limit: AUTH_FAIL_LIMIT,
    windowMs: 60_000,
    now: () => ts
  });
  for (let i = 0; i < AUTH_FAIL_LIMIT; i += 1) assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
  ts = 60_000;
  assert.equal(limiter.allow(), true);
});
