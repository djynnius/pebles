// Engine state presentation, shared by the Engines list, the Hosts table and
// the engine detail so one state never reads three ways.
//
// States come from pebblesd's health loop: "available", "in use …",
// "draining …", "stopped" and — after three consecutive failed probes —
// "lost" (REQ-22). "lost" is an alarm, not a resting state: the engine was
// never asked to stop, the main simply cannot reach it, so it gets the error
// treatment while "stopped" stays neutral.

/** Tooltip for an engine the main can no longer reach (3 × 10 s probes). */
export const LOST_HINT = "Unreachable for 30s+ — check the engine host";

export function isLost(state: string): boolean {
  return state.trim().toLowerCase().startsWith("lost");
}

/** StatusDot tone for an engine state. */
export function engineTone(state: string): "ok" | "warn" | "err" | "dim" {
  if (isLost(state)) return "err";
  const s = state.toLowerCase();
  if (s.startsWith("available") || s.startsWith("in use")) return "ok";
  if (s.startsWith("draining")) return "warn";
  return "dim";
}
