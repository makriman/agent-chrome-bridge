import { assertNavigationInput, isFinalActionCommand } from "../extension/final-actions.js";
import { confineArtifactsPath } from "./paths.mjs";

export function guardOutgoingCommand(command, { repoRoot } = {}) {
  if (!command || typeof command !== "object") {
    throw new Error("Command must be an object.");
  }
  const next = { ...command };
  const type = next.type || next.op;
  if (next.output != null && next.output !== "") {
    if (typeof next.output !== "string") {
      throw new Error("Output path must be a relative path inside artifacts/.");
    }
    confineArtifactsPath(repoRoot, next.output);
  }
  if (type === "navigate" || type === "nav") {
    assertNavigationInput(next.url);
  }
  if (isFinalActionCommand(next)) {
    const token = typeof next.approvalToken === "string" ? next.approvalToken.trim() : "";
    if (token.length < 32) {
      throw new Error(
        "Final action blocked (submit, purchase, delete, send, post, pay, or Enter). Click Approve final action in the extension popup and pass that token with --approval-token."
      );
    }
    next.approvalToken = token;
  }
  return next;
}
