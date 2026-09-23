import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chmodOwnerOnly, secretEquals } from "./token-file.mjs";

test("token comparison is constant-time and ignores unequal lengths", () => {
  const token = "ab".repeat(32);
  assert.equal(secretEquals(token, token), true);
  assert.equal(secretEquals(`${token.slice(0, -1)}c`, token), false);
  assert.equal(secretEquals(token.slice(0, -1), token), false);
  assert.equal(secretEquals("", token), false);
  assert.equal(secretEquals(null, token), false);
  assert.equal(secretEquals(token, undefined), false);
});

test("chmodOwnerOnly sets a token file to mode 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-chrome-bridge-token-"));
  const filePath = join(root, ".bridge-token");
  await writeFile(filePath, `${"ab".repeat(32)}\n`, { mode: 0o644 });
  await chmodOwnerOnly(filePath);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});
