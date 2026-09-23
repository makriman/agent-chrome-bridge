import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export function fingerprintToken(token) {
  if (typeof token !== "string" || token.length < 32) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function secretEquals(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function readOperatorToken(tokenPath) {
  let value = "";
  try {
    value = (await readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    const wrapped = new Error(
      "Bridge token is missing or unreadable. Start the bridge with `npm run bridge` so it can create `.bridge-token`. This command does not rewrite the token file."
    );
    wrapped.code = "token_unreadable";
    wrapped.cause = error;
    throw wrapped;
  }
  if (value.length < 32) {
    const error = new Error(
      "Bridge token is missing or invalid. Start/restart the bridge with `npm run bridge` so it can repair `.bridge-token`. This command does not rewrite the token file."
    );
    error.code = "token_unreadable";
    throw error;
  }
  return value;
}
