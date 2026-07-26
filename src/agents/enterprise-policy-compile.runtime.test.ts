import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compileGovernancePolicy } from "./enterprise-policy-compile.runtime.js";

function compile(deps: {
  prepare?: ReturnType<typeof vi.fn>;
  complete?: ReturnType<typeof vi.fn>;
}) {
  const prepare =
    deps.prepare ?? vi.fn(async () => ({ model: { id: "m" }, auth: { apiKey: "k" } }));
  const complete =
    deps.complete ??
    vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: '{"id":"refund.approval","effect":"require_approval","actions":["issue-refund"]}',
        },
      ],
    }));
  return compileGovernancePolicy({
    cfg: {} as OpenClawConfig,
    intent: "refunds over $200 need approval",
    deps: {
      prepareSimpleCompletionModelForAgent: prepare as never,
      completeWithPreparedSimpleCompletionModel: complete as never,
    },
  });
}

describe("compileGovernancePolicy", () => {
  it("returns the parsed policy when the model replies with a valid object", async () => {
    const res = await compile({});
    expect(res.kind).toBe("compiled");
    if (res.kind === "compiled") {
      expect(res.policy.effect).toBe("require_approval");
    }
  });

  it("surfaces a missing model as a plain failure, never a throw", async () => {
    const res = await compile({ prepare: vi.fn(async () => ({ error: "no auth for provider" })) });
    expect(res.kind).toBe("failed");
    if (res.kind === "failed") {
      expect(res.reason).toContain("no completion model");
    }
  });

  it("reports an unparseable reply rather than compiling garbage", async () => {
    const res = await compile({
      complete: vi.fn(async () => ({ content: [{ type: "text", text: "I can't do that." }] })),
    });
    expect(res.kind).toBe("failed");
  });

  it("converts a thrown preparation error into a failed result, never a throw", async () => {
    // Provider runtime-auth (e.g. Microsoft Foundry Entra token refresh) can throw;
    // the compiler owes a result, not an exception.
    const res = await compile({
      prepare: vi.fn(async () => {
        throw new Error("az login failed");
      }),
    });
    expect(res.kind).toBe("failed");
    if (res.kind === "failed") {
      expect(res.reason).toContain("could not prepare a completion model");
    }
  });

  it("converts a thrown completion error into a failed result", async () => {
    const res = await compile({
      complete: vi.fn(async () => {
        throw new Error("network reset");
      }),
    });
    expect(res.kind).toBe("failed");
    if (res.kind === "failed") {
      expect(res.reason).toContain("model call failed");
    }
  });

  it("rejects an over-long reply that ran past the (unenforced) token cap", async () => {
    // The Codex transport strips max_output_tokens, so a runaway reply must be bounded
    // locally by size before it is parsed or rendered.
    const huge = `{"id":"x.y","effect":"deny","description":"${"a".repeat(9000)}"}`;
    const res = await compile({
      complete: vi.fn(async () => ({ content: [{ type: "text", text: huge }] })),
    });
    expect(res.kind).toBe("failed");
    if (res.kind === "failed") {
      expect(res.reason).toContain("too long");
    }
  });

  it("rejects a token-limit-truncated reply even when the JSON parses", async () => {
    // stopReason "length" means the reply was cut at the token cap; the bounded text
    // can still be valid JSON but drop later selectors, so it must not compile.
    const res = await compile({
      complete: vi.fn(async () => ({
        stopReason: "length",
        content: [{ type: "text", text: '{"id":"x.y","effect":"deny","tools":["shell"]}' }],
      })),
    });
    expect(res.kind).toBe("failed");
    if (res.kind === "failed") {
      expect(res.reason).toContain("did not finish cleanly");
    }
  });
});
