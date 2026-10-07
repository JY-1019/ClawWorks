/** Host-dispatched MCP tools for governed harnesses whose native MCP surface cannot gate each step. */
import { getEnterpriseActiveRun } from "../enterprise/active-runs.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { BundleMcpToolRuntime } from "./agent-bundle-mcp-types.js";
import type { createOpenClawCodingTools } from "./agent-tools.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";

type ToolOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

export async function createRunMcpTools(params: {
  options: ToolOptions;
  eligibleServerNames: readonly string[];
  nativeServerNames: readonly string[];
  reservedToolNames: readonly string[];
  toolsAllow?: string[];
}): Promise<BundleMcpToolRuntime | undefined> {
  const { options } = params;
  const run = options.runId ? getEnterpriseActiveRun(options.runId) : undefined;
  if (!run || run.plan.mode !== "enforce" || !run.plan.mcpGoverned || !options.workspaceDir) {
    return undefined;
  }
  const attached = new Set(run.plan.mcpAttachments ?? []);
  const native = new Set(params.nativeServerNames);
  const servers = Object.fromEntries(
    params.eligibleServerNames
      .filter((name) => attached.has(name) && !native.has(name))
      .flatMap((name) => {
        const server = options.config?.mcp?.servers?.[name];
        return server && server.enabled !== false ? [[name, server]] : [];
      }),
  );
  if (Object.keys(servers).length === 0) {
    return undefined;
  }
  // Native servers remain on their existing ceiling-bound path. Only the attached
  // remainder is connected here; trusted catalog metadata lets the host gate each
  // invocation without attempting to reverse the harness's hashed tool names.
  const runtime = createSessionMcpRuntime({
    sessionId: options.sessionId ?? options.runId!,
    workspaceDir: options.workspaceDir,
    cfg: { ...options.config, mcp: { ...options.config?.mcp, servers } },
    manifestRegistry: { plugins: [] },
  });
  try {
    const materialized = await materializeBundleMcpToolsForRun({
      runtime,
      reservedToolNames: params.reservedToolNames,
      disposeRuntime: () => runtime.dispose(),
    });
    materialized.tools = applyFinalEffectiveToolPolicy({
      ...options,
      messageProvider: options.toolPolicyMessageProvider ?? options.messageProvider,
      sandboxToolPolicy: options.sandbox?.tools,
      bundledTools: applyEmbeddedAttemptToolsAllow(materialized.tools, params.toolsAllow, {
        toolMeta: getPluginToolMeta,
      }),
      warn: logWarn,
    });
    return materialized;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
