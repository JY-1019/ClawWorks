/**
 * Resolves command queue lane names for embedded-agent sessions and global work.
 */
import { CommandLane } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  // Cron jobs hold the cron lane slot; inner operations need a dedicated lane
  // to avoid deadlock without widening shared nested flows.
  if (cleaned === CommandLane.Cron) {
    return CommandLane.CronNested;
  }
  return cleaned ? cleaned : CommandLane.Main;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}

/** User work precedes background maintenance in both dispatch and runner admission. */
export function resolveRunSessionQueuePriority(
  trigger?: string,
): "foreground" | "background" | "normal" {
  switch (trigger) {
    case "user":
    case "manual":
      return "foreground";
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "background";
    default:
      return "normal";
  }
}

export const EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS = 30_000;

export function resolveEmbeddedRunLaneTimeoutMs(timeoutMs: number): number | undefined {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs) + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS
    : undefined;
}
