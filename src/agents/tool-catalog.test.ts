/**
 * Regression coverage for core tool catalog profile defaults.
 * Verifies built-in profile allowlists include expected core tool groups.
 */
import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

function requireCoreToolProfilePolicy(profile: Parameters<typeof resolveCoreToolProfilePolicy>[0]) {
  const policy = resolveCoreToolProfilePolicy(profile);
  if (!policy) {
    throw new Error(`expected ${profile} tool profile policy`);
  }
  return policy;
}

function requirePolicyAllow(profile: Parameters<typeof resolveCoreToolProfilePolicy>[0]) {
  const allow = requireCoreToolProfilePolicy(profile).allow;
  if (!allow) {
    throw new Error(`expected ${profile} tool profile allow list`);
  }
  return allow;
}

describe("tool-catalog", () => {
  it("includes code_execution, web_search, x_search, web_fetch, and update_plan in the coding profile policy", () => {
    const policy = requireCoreToolProfilePolicy("coding");
    expect(policy.allow).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "code_execution",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_spawn",
      "sessions_yield",
      "subagents",
      "session_status",
      "cron",
      // Run machinery, not a capability: a profile that filtered it out would
      // strand every governed work-map on its opening step.
      "complete_step",
      "get_goal",
      "create_goal",
      "update_goal",
      "update_plan",
      "skill_workshop",
      "image",
      "image_generate",
      "music_generate",
      "video_generate",
      "bundle-mcp",
    ]);
  });

  it("includes bundle MCP tools in coding and messaging profile policies", () => {
    expect(requirePolicyAllow("coding").at(-1)).toBe("bundle-mcp");
    expect(requirePolicyAllow("messaging")).toEqual([
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "session_status",
      "message",
      "complete_step",
      "bundle-mcp",
    ]);
    // complete_step joins every profile: it is inert without a bound work-map
    // (the factory only builds it for a step-tracking run), and a profile that
    // withheld it would break how a governed run executes rather than narrow it.
    expect(requirePolicyAllow("minimal")).toEqual(["session_status", "complete_step"]);
  });

  it("full profile uses wildcard to grant all tools (#76507)", () => {
    const policy = requireCoreToolProfilePolicy("full");
    expect(policy.allow).toEqual(["*"]);
  });
});
