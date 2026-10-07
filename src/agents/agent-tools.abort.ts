/**
 * Abort-signal wrapping for agent tools.
 * Combines per-call cancellation with run-level aborts while preserving plugin,
 * channel, and before_tool_call metadata on wrapped tools.
 */
import { copyPluginToolMeta } from "../plugins/tools.js";
import { bindAbortRelay } from "../utils/fetch-timeout.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";

function throwAbortError(): never {
  const err = new Error("Aborted");
  err.name = "AbortError";
  throw err;
}

function combineAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): {
  signal?: AbortSignal;
  cleanup?: () => void;
} {
  if (!a && !b) {
    return {};
  }
  if (a && !b) {
    return { signal: a };
  }
  if (b && !a) {
    return { signal: b };
  }
  if (a?.aborted) {
    return { signal: a };
  }
  if (b?.aborted) {
    return { signal: b };
  }
  if (
    typeof AbortSignal.any === "function" &&
    a instanceof AbortSignal &&
    b instanceof AbortSignal
  ) {
    return { signal: AbortSignal.any([a, b]) };
  }

  const controller = new AbortController();
  const onAbort = bindAbortRelay(controller);
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    // Successful tools never abort. Remove both relays on every terminal path
    // so a long-lived run signal cannot retain each completed call's controller.
    cleanup: () => {
      a?.removeEventListener("abort", onAbort);
      b?.removeEventListener("abort", onAbort);
    },
  };
}

/** Wrap a tool so every execute call observes the supplied run abort signal. */
export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combined = combineAbortSignals(signal, abortSignal);
      try {
        if (combined.signal?.aborted) {
          throwAbortError();
        }
        return await execute(toolCallId, params, combined.signal, onUpdate);
      } finally {
        combined.cleanup?.();
      }
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  copyBeforeToolCallHookMarker(tool, wrappedTool);
  return wrappedTool;
}
