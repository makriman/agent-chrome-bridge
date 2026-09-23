import { createHash } from "node:crypto";
import { FINAL_ACTION_TTL_MS, assertNavigationInput, isFinalActionCommand } from "../extension/final-actions.js";
import { confineArtifactsPath } from "./paths.mjs";

export class QueueRejected extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "QueueRejected";
    this.statusCode = statusCode;
  }
}

export function hashApprovalToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function acceptFinalActionGrant(grants, payload, now = Date.now()) {
  if (!payload || typeof payload.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(payload.tokenHash)) return false;
  const expiresAt = Number(payload.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  const ttl = expiresAt - now;
  if (ttl <= 0 || ttl > FINAL_ACTION_TTL_MS + 5000) return false;
  if (!payload.armSessionId || !payload.origin) return false;
  while (grants.size >= 20) {
    const oldest = grants.keys().next().value;
    grants.delete(oldest);
  }
  grants.set(payload.tokenHash, {
    expiresAt,
    armSessionId: String(payload.armSessionId),
    origin: String(payload.origin),
    bridgeInstanceId: payload.bridgeInstanceId || null,
    used: false
  });
  return true;
}

export function prepareQueuedCommand(command, context) {
  if (!command || typeof command !== "object") {
    throw new QueueRejected("Missing command.");
  }
  const type = command.type || command.op;
  if (!type) throw new QueueRejected("Missing command type/op.");
  const armSessionId = context.armSessionId || null;
  const armedOrigin = context.armedOrigin || null;
  const controlType = type === "status" || type === "stop" || type === "disarm";
  if (!controlType && !armSessionId) {
    throw new QueueRejected("Bridge tab is not armed. Arm the tab, then retry.", 409);
  }
  if (!controlType && command.armSessionId && armSessionId && command.armSessionId !== armSessionId) {
    throw new QueueRejected(
      `Command targeted stale arm session ${command.armSessionId}. Active arm is ${armSessionId}.`,
      409
    );
  }
  if (type === "navigate" || type === "nav") {
    try {
      assertNavigationInput(command.url);
    } catch (error) {
      throw new QueueRejected(error.message);
    }
  }
  if (command.output != null && command.output !== "") {
    if (typeof command.output !== "string") {
      throw new QueueRejected("Screenshot output must be a relative path inside artifacts/.");
    }
    try {
      confineArtifactsPath(context.repoRoot, command.output);
    } catch (error) {
      throw new QueueRejected(error.message);
    }
  }

  const queueId = command.queueId || null;
  if (!controlType) {
    const foreign = (context.activeCommands || []).find((item) => (item.queueId || null) !== queueId);
    if (foreign) {
      throw new QueueRejected(
        `This arm already has work from queue ${foreign.queueId || "(untagged)"} (${foreign.type} ${foreign.id}). Wait for it to finish or flush the queue.`,
        409
      );
    }
  }

  let grantHash = null;
  if (isFinalActionCommand(command)) {
    const token = typeof command.approvalToken === "string" ? command.approvalToken.trim() : "";
    if (token.length < 32) {
      throw new QueueRejected(
        "Final action blocked. Approve it in the extension popup and pass that approval token.",
        403
      );
    }
    grantHash = hashApprovalToken(token);
    const grant = context.grants ? context.grants.get(grantHash) : null;
    const now = context.now || Date.now();
    if (!grant || grant.used || !(grant.expiresAt > now)) {
      throw new QueueRejected(
        "Final action approval is missing or expired. Click Approve final action in the extension popup and retry.",
        403
      );
    }
    if (grant.armSessionId !== armSessionId || (grant.origin && armedOrigin && grant.origin !== armedOrigin)) {
      throw new QueueRejected("Final-action approval does not match the armed tab.", 403);
    }
  }

  const stored = { ...command, type, op: command.op || type };
  delete stored.approvalToken;
  stored.armSessionId = armSessionId;
  if (grantHash) stored.finalActionApproval = "accepted";
  return { command: stored, grantHash };
}
