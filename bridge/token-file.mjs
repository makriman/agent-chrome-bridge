import { timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";

export function secretEquals(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function chmodOwnerOnly(filePath) {
  try {
    await chmod(filePath, 0o600);
    return true;
  } catch (_) {
    // Mode is best-effort when the filesystem ignores it.
    return false;
  }
}
