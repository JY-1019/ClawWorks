import { describe, expect, it } from "vitest";
import { resolveGovernedCodexSkillsThreadConfig } from "./governed-skills.js";

describe("resolveGovernedCodexSkillsThreadConfig", () => {
  it("turns Codex's own skills block off for a governed run", () => {
    // Codex scans its own roots, which narrowing OpenClaw's catalog cannot
    // touch, so a work-map that grants skills explicitly would still be offered
    // every native one.
    expect(resolveGovernedCodexSkillsThreadConfig(["taskflow-inbox-triage"])).toEqual({
      skills: { include_instructions: false },
    });
  });

  it("turns it off even when the work-map grants no skill at all", () => {
    expect(resolveGovernedCodexSkillsThreadConfig([])).toEqual({
      skills: { include_instructions: false },
    });
  });

  it("leaves the block alone for a run no work-map governs", () => {
    expect(resolveGovernedCodexSkillsThreadConfig(null)).toBeUndefined();
  });
});
