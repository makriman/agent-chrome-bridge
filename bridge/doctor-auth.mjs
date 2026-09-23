export const TOKEN_MISMATCH_HINT =
  "The listener on 127.0.0.1:18474 has a different token fingerprint than this checkout. Do not arm. The doctor command does not send .bridge-token to that process. See who is listening with: lsof -nP -iTCP:18474 -sTCP:LISTEN";

export const TOKEN_UNVERIFIED_HINT =
  "The listener answered without a token fingerprint. Do not arm, and do not send the bridge token to it. Restart `npm run bridge` from this checkout if that process is yours.";

export const TOKEN_FILE_DRIFT_HINT =
  "The running bridge token does not match `.bridge-token` on disk. Do not arm. Restart `npm run bridge` only after you confirm the token file belongs to this checkout.";

export const TOKEN_REJECTED_HINT =
  "The published fingerprint matched, but `/doctor` rejected the token. Restart the bridge so it reloads `.bridge-token`. Do not arm while doctor is failing.";

export const TOKEN_PROBE_LIMITED_HINT =
  "Too many rejected token attempts. Wait a minute and run doctor again. Do not arm.";

export function classifyDoctorAuth({
  localFingerprint = null,
  listenerFingerprint = null,
  doctorStatus = null,
  matchesRunningBridge = null
} = {}) {
  if (localFingerprint && listenerFingerprint && localFingerprint !== listenerFingerprint) {
    return { ok: false, code: "token_mismatch", hint: TOKEN_MISMATCH_HINT };
  }
  if (matchesRunningBridge === false) {
    return { ok: false, code: "token_file_drift", hint: TOKEN_FILE_DRIFT_HINT };
  }
  if (doctorStatus === 429) {
    return { ok: false, code: "token_probe_limited", hint: TOKEN_PROBE_LIMITED_HINT };
  }
  if (doctorStatus === 403) {
    return { ok: false, code: "token_rejected", hint: TOKEN_REJECTED_HINT };
  }
  return {
    ok: true,
    code: "match",
    hint: "Token fingerprint matches the listener."
  };
}
