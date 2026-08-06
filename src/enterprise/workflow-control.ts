/**
 * The run's own control surface: the tool that walks a route from one step to the
 * next, and the spellings a harness may present it under.
 *
 * Deliberately dependency-free, and that is the whole reason this is its own
 * module. `active-runs.ts` imports `governance.ts`, and packaged consumers reach
 * that chain through `openclaw/plugin-sdk/agent-harness-runtime` (the Codex
 * harness does). Those consumers cannot resolve the workspace-only
 * `@openclaw/enterprise-planner` that `plan.ts` pulls in, so naming the tool over
 * there would break packaged harness startup before a run even begins.
 */

/** The tool that advances a run through its route. */
export const WORKFLOW_STEP_ADVANCE_TOOL = "complete_step";

/**
 * Is this call the run's own step-advance tool — and provably ours?
 *
 * Matched on the BARE name only, and that narrowing is deliberate: both paths
 * that can legitimately deliver this tool to the gate deliver it bare.
 * - The loopback MCP surface gates inside its own handler, which looks the tool
 *   up by its REGISTERED name (src/gateway/mcp-http.handlers.ts), never a
 *   namespaced one.
 * - The Codex app-server registers it as a DIRECT dynamic tool
 *   (ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES, extensions/codex/src/app-server/dynamic-tools.ts),
 *   so its PreToolUse hook reports the bare name rather than a namespace-flattened
 *   or `mcp__…` one.
 *
 * Accepting `mcp__openclaw__complete_step` too was tried and REVERTED. A
 * Codex-owned MCP server named `openclaw` is reported under exactly that spelling
 * (../codex/codex-rs/core/src/tools/handlers/mcp.rs:47-68), the native relay passes
 * only the name with no registration that could tell the two apart
 * (src/agents/harness/native-hook-relay.ts:1389-1409), and Codex config tables can
 * survive the thread overlay — so the exemption handed a third-party tool a free
 * pass through every allow-list, denial and policy. No provenance exists at this
 * seam to separate them, and a governance bypass is worse than a run that visibly
 * fails to advance.
 *
 * An MCP registration is refused for the same reason: ours never carries one, so
 * anything that does is a server's own tool that merely shares the name.
 *
 * Normalized the way the tool-policy matcher normalizes a name, so casing cannot
 * turn the run's own control surface off.
 */
export function isWorkflowControlTool(params: {
  toolName: string;
  /** The tool's MCP registration, when the dispatcher holds one. */
  mcpTool?: { serverName: string };
}): boolean {
  if (params.mcpTool !== undefined) {
    return false;
  }
  return params.toolName.trim().toLowerCase() === WORKFLOW_STEP_ADVANCE_TOOL;
}
