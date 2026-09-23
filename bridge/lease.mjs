export function evaluateLease(command, extensionArmSessionId) {
  if (!command || command.status !== "queued") return { action: "skip" };
  if (command.type === "status" || command.type === "stop" || command.type === "disarm") return { action: "lease" };
  if (!command.armSessionId) {
    return {
      action: "stale",
      error: "Command was queued without an armed tab. Arm the tab and enqueue again."
    };
  }
  if (!extensionArmSessionId) return { action: "wait" };
  if (command.armSessionId !== extensionArmSessionId) {
    return {
      action: "stale",
      error: `Command targeted stale arm session ${command.armSessionId}. Active extension session is ${extensionArmSessionId}.`
    };
  }
  return { action: "lease" };
}
