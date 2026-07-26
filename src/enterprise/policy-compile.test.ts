import { describe, expect, it } from "vitest";
import { buildPolicyCompileUserPrompt, parsePolicyCompileResponse } from "./policy-compile.js";

describe("parsePolicyCompileResponse", () => {
  it("accepts a bare JSON policy object", () => {
    const res = parsePolicyCompileResponse(
      '{"id":"refund.approval","effect":"require_approval","actions":["issue-refund"]}',
    );
    expect(res.kind).toBe("compiled");
    if (res.kind === "compiled") {
      expect(res.policy.id).toBe("refund.approval");
      expect(res.policy.effect).toBe("require_approval");
    }
  });

  it("unwraps a single ```json fence", () => {
    const res = parsePolicyCompileResponse(
      '```json\n{"id":"deny.shell","effect":"deny","tools":["shell"]}\n```',
    );
    expect(res.kind).toBe("compiled");
  });

  it("rejects surrounding prose so a crafted intent cannot echo a policy back", () => {
    expect(parsePolicyCompileResponse('Sure! Here it is: {"id":"x.y","effect":"deny"}').kind).toBe(
      "failed",
    );
  });

  it("rejects invalid JSON", () => {
    expect(parsePolicyCompileResponse("{ not json").kind).toBe("failed");
  });

  it("rejects a shape the governance schema forbids (unknown effect, empty selector)", () => {
    expect(parsePolicyCompileResponse('{"id":"x.y","effect":"maybe"}').kind).toBe("failed");
    expect(parsePolicyCompileResponse('{"id":"x.y","effect":"deny","tools":[]}').kind).toBe(
      "failed",
    );
  });

  it("accepts a nodes-only policy (run-level, scoped to the plan root)", () => {
    // policyAppliesToRun treats a selector-less-subject policy as run-level and
    // applies it when the plan root matches its nodes, so the compiler keeps it.
    const res = parsePolicyCompileResponse(
      '{"id":"root.deny","effect":"deny","nodes":["clawworks.assist"]}',
    );
    expect(res.kind).toBe("compiled");
  });

  it("rejects a selector carrying control or escape characters", () => {
    // A glob wrapped in ANSI (ESC = char 27) renders as clean text but never matches
    // the real tool, so the schema must refuse it rather than emit a broken policy.
    const esc = String.fromCharCode(27);
    const text = JSON.stringify({
      id: "x.y",
      effect: "deny",
      tools: [`${esc}[31mexec${esc}[0m`],
    });
    expect(parsePolicyCompileResponse(text).kind).toBe("failed");
  });

  it("rejects a selector carrying a Unicode bidi/format spoofing char", () => {
    // U+202E (right-to-left override) can reorder the printed review while stopping
    // the glob from matching its apparent target.
    const rlo = String.fromCharCode(0x202e);
    const text = JSON.stringify({ id: "x.y", effect: "deny", tools: [`exec${rlo}`] });
    expect(parsePolicyCompileResponse(text).kind).toBe("failed");
  });

  it("rejects a selector with an invisible combining/zero-width character", () => {
    // U+034F (combining grapheme joiner) and U+200B (zero-width space) render like a
    // valid id but never match, so the schema must refuse them. Visible names (accents,
    // spaces) stay valid — only invisible/look-alike chars are rejected.
    const cgj = String.fromCharCode(0x034f);
    const zwsp = String.fromCharCode(0x200b);
    for (const glob of [`exec${cgj}`, `exec${zwsp}`]) {
      const text = JSON.stringify({ id: "x.y", effect: "deny", tools: [glob] });
      expect(parsePolicyCompileResponse(text).kind).toBe("failed");
    }
  });

  it("keeps a selector with a valid non-ASCII or whitespace tool name", () => {
    // A plugin tool name may be any non-blank string, so an accented or spaced name is
    // a valid, targetable selector and must compile.
    const res = parsePolicyCompileResponse(
      JSON.stringify({ id: "x.y", effect: "deny", tools: ["café", "my tool"] }),
    );
    expect(res.kind).toBe("compiled");
  });

  it("keeps a selector holding a literal metacharacter (exact plugin tool name)", () => {
    // Non-"*" characters match literally, so an exact tool name like "foo+bar" is a
    // valid, targetable selector and must not be rejected.
    const res = parsePolicyCompileResponse(
      JSON.stringify({ id: "x.y", effect: "deny", tools: ["foo+bar"] }),
    );
    expect(res.kind).toBe("compiled");
  });

  it("sanitizes control/bidi characters out of the compiled description", () => {
    // The description becomes the run-time decision reason once pasted into config, so
    // a hidden char is stripped at the compiler boundary. It is free text (not a
    // matcher), so it is cleaned rather than rejected — config stays permissive. A
    // zero-width/bidi char (RLO) is deleted so it cannot reorder the reason; a control
    // char (bell) becomes a space.
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(7);
    const res = parsePolicyCompileResponse(
      JSON.stringify({
        id: "x.y",
        effect: "deny",
        tools: ["shell"],
        description: `refunds${rlo} over${bell}200`,
      }),
    );
    expect(res.kind).toBe("compiled");
    if (res.kind === "compiled") {
      expect(res.policy.description).not.toContain(rlo);
      expect(res.policy.description).not.toContain(bell);
      expect(res.policy.description).toBe("refunds over 200");
    }
  });
});

describe("buildPolicyCompileUserPrompt", () => {
  it("embeds the intent as quoted inert data", () => {
    expect(buildPolicyCompileUserPrompt("refunds over $200 need approval")).toContain(
      JSON.stringify("refunds over $200 need approval"),
    );
  });
});
