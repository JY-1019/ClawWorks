import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerEnterpriseActiveRun,
  clearEnterpriseActiveRunsForTest,
  type EnterpriseActiveRun,
} from "../enterprise/active-runs.js";
import { completeEnterpriseStep, reopenEnterpriseStep } from "../enterprise/runtime.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createRunMcpTools } from "./run-mcp-tools.js";

vi.mock("./agent-bundle-mcp-runtime.js", () => ({ createSessionMcpRuntime: vi.fn() }));
afterEach(() => {
  clearEnterpriseActiveRunsForTest();
  vi.resetAllMocks();
});

function setup() {
  const run: EnterpriseActiveRun = {
    executionId: "execution",
    policies: [],
    mcpServers: ["tracker"],
    plan: {
      runId: "run",
      treeId: "returns",
      treeName: "Returns",
      treeVersion: "1",
      matchedBy: "planner",
      requestSummary: "refund",
      createdAt: 0,
      mode: "enforce",
      mcpGoverned: true,
      mcpAttachments: ["tracker"],
      activeNodeId: "triage",
      nodes: [
        { nodeId: "root", parentId: null, seq: 0, title: "Returns", ontology: {} },
        {
          nodeId: "triage",
          parentId: "root",
          seq: 1,
          title: "Triage",
          ontology: { allowedTools: ["knowledge_search"] },
        },
        {
          nodeId: "lookup",
          parentId: "root",
          seq: 2,
          title: "Lookup",
          ontology: { mcpServers: ["tracker"] },
        },
      ],
    },
  };
  registerEnterpriseActiveRun(run);
  const release = vi.fn();
  const runtime: SessionMcpRuntime = {
    sessionId: "session",
    workspaceDir: "/tmp",
    configFingerprint: "test",
    createdAt: 0,
    lastUsedAt: 0,
    acquireLease: () => release,
    markUsed: vi.fn(),
    peekCatalog: () => null,
    getCatalog: vi.fn(async () => ({
      version: 1,
      generatedAt: 0,
      servers: {},
      tools: [
        {
          serverName: "tracker",
          safeServerName: "tracker",
          toolName: "status",
          inputSchema: { type: "object", properties: {} },
          fallbackDescription: "status",
        },
      ],
    })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "delivered" }] })),
    dispose: vi.fn(async () => {}),
  };
  vi.mocked(createSessionMcpRuntime).mockReturnValue(runtime);
  const params: Parameters<typeof createRunMcpTools>[0] = {
    options: {
      runId: "run",
      sessionId: "session",
      workspaceDir: "/tmp",
      config: {
        mcp: {
          servers: { tracker: { transport: "streamable-http", url: "http://localhost:9700/mcp" } },
        },
      },
    },
    eligibleServerNames: ["tracker"],
    nativeServerNames: [],
    reservedToolNames: [],
  };
  return { run, runtime, params, release };
}

describe("host MCP dispatch for multi-step governance", () => {
  it("carries catalog identity through the hook and permits execution only on the attached step", async () => {
    const { run, runtime, params, release } = setup();
    const result = await createRunMcpTools(params);
    expect(result?.tools).toHaveLength(1);
    const tool = result!.tools[0];
    expect(getPluginToolMeta(tool)?.mcp?.serverName).toBe("tracker");
    const wrapped = wrapToolWithBeforeToolCallHook(tool, { runId: "run" });
    const denied = await wrapped.execute("wrong-step", {}, undefined, undefined);
    expect(denied.details).toMatchObject({ status: "blocked" });
    expect(runtime.callTool).not.toHaveBeenCalled();
    expect(completeEnterpriseStep({ runId: "run" }).kind).toBe("advanced");
    await wrapped.execute("lookup", {}, undefined, undefined);
    expect(runtime.callTool).toHaveBeenCalledWith("tracker", "status", {});
    // The same materialized tool must recheck the cursor after a step is reopened;
    // retaining its successful lookup grant would leak the sibling's attachment.
    expect(reopenEnterpriseStep({ runId: "run", nodeId: "triage" }).kind).toBe("reopened");
    const reopened = await wrapped.execute("reopened-triage", {}, undefined, undefined);
    expect(reopened.details).toMatchObject({ status: "blocked" });
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
    expect(completeEnterpriseStep({ runId: "run" }).kind).toBe("advanced");
    run.plan.nodes[0].ontology.deniedTools = ["tracker__status"];
    await wrapped.execute("explicit-deny", {}, undefined, undefined);
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
    await result!.dispose();
    await result!.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });
  it.each(["native", "ineligible", "unattached", "observe"])(
    "does not connect %s servers",
    async (kind) => {
      const { run, params } = setup();
      if (kind === "native") {
        params.nativeServerNames = ["tracker"];
      }
      if (kind === "ineligible") {
        params.eligibleServerNames = [];
      }
      if (kind === "unattached") {
        run.plan.mcpAttachments = [];
      }
      if (kind === "observe") {
        run.plan.mode = "observe";
      }
      expect(await createRunMcpTools(params)).toBeUndefined();
      expect(createSessionMcpRuntime).not.toHaveBeenCalled();
    },
  );
  it("honors global tool deny and run allowlists", async () => {
    const { params } = setup();
    params.options.config!.tools = { deny: ["tracker__status"] };
    expect((await createRunMcpTools(params))?.tools).toEqual([]);
    params.options.config!.tools = {};
    params.toolsAllow = ["knowledge_search"];
    expect((await createRunMcpTools(params))?.tools).toEqual([]);
    params.toolsAllow = ["bundle-mcp"];
    expect((await createRunMcpTools(params))?.tools).toHaveLength(1);
  });
  it("closes the transport when catalog construction fails", async () => {
    const { runtime, params } = setup();
    vi.mocked(runtime.getCatalog).mockRejectedValue(new Error("catalog failed"));
    await expect(createRunMcpTools(params)).rejects.toThrow("catalog failed");
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });
});
