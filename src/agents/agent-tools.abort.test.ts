/** Tool cancellation relays must not outlive their execution. */
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

// Exercise the existing fallback used when native signal composition is unavailable.
const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;

describe.each(["native", "fallback"])("tool abort relay cleanup (%s)", (mode) => {
  beforeEach(() => {
    if (mode === "fallback") {
      Object.defineProperty(AbortSignal, "any", { ...anyDescriptor, value: undefined });
    }
  });
  afterEach(() => {
    Object.defineProperty(AbortSignal, "any", anyDescriptor);
  });

  it.each(["success", "failure", "abort"] as const)(
    "releases listeners after %s",
    async (outcome) => {
      const run = new AbortController();
      const call = new AbortController();
      const tool: AnyAgentTool = {
        name: "cleanup_probe",
        label: "Cleanup probe",
        description: "Probe tool cancellation",
        parameters: { type: "object", properties: {} },
        execute: async (_id, _params, signal) => {
          expect(signal?.aborted).toBe(false);
          if (outcome === "abort") {
            call.abort();
            expect(signal?.aborted).toBe(true);
          }
          if (outcome !== "success") {
            throw new Error(outcome);
          }
          return { content: [{ type: "text", text: "done" }], details: {} };
        },
      };
      const wrapped = wrapToolWithAbortSignal(tool, run.signal);
      const result = wrapped.execute("call", {}, call.signal);
      if (outcome === "success") {
        await expect(result).resolves.toMatchObject({ details: {} });
      } else {
        await expect(result).rejects.toThrow(outcome);
      }
      expect(getEventListeners(run.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(call.signal, "abort")).toHaveLength(0);
    },
  );
});
