/** Tests projecting OpenClaw user MCP servers into Codex app-server config. */
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
} from "../../enterprise/runtime.js";
import type { EnterpriseRunPlan } from "../../enterprise/types.js";
import { buildCodexUserMcpServersThreadConfigPatch } from "./bundle-mcp-codex.js";

describe("buildCodexUserMcpServersThreadConfigPatch", () => {
  it("returns undefined when cfg has no mcp.servers (regression: #80814)", () => {
    expect(buildCodexUserMcpServersThreadConfigPatch(undefined)).toBeUndefined();
    expect(buildCodexUserMcpServersThreadConfigPatch({} as OpenClawConfig)).toBeUndefined();
    expect(
      buildCodexUserMcpServersThreadConfigPatch({ mcp: {} } as OpenClawConfig),
    ).toBeUndefined();
    expect(
      buildCodexUserMcpServersThreadConfigPatch({ mcp: { servers: {} } } as OpenClawConfig),
    ).toBeUndefined();
  });

  afterEach(() => {
    clearEnterpriseActiveRunsForTest();
  });

  function registerGovernedRun(params: {
    runId: string;
    attached?: string[];
    /** Names the operator has under `mcp.servers`; only these are attachable. */
    registered?: string[];
    rootAllowedTools?: string[];
    mode?: "enforce" | "observe";
  }): void {
    const plan: EnterpriseRunPlan = {
      runId: params.runId,
      treeId: "acme.support",
      treeVersion: "1.0.0",
      treeName: "Support",
      matchedBy: "planner",
      requestSummary: "help",
      nodes: [
        {
          nodeId: "support",
          parentId: null,
          seq: 0,
          title: "Support",
          ontology: {
            ...(params.attached ? { mcpServers: params.attached } : {}),
            ...(params.rootAllowedTools ? { allowedTools: params.rootAllowedTools } : {}),
          },
        },
      ],
      activeNodeId: "support",
      // The work-map uses the field, which is what turns attachment governance on.
      // The plan carries the definition-wide attachment list, as the builder does.
      ...(params.attached ? { mcpGoverned: true, mcpAttachments: params.attached } : {}),
      mode: params.mode ?? "enforce",
      createdAt: 0,
    };
    registerEnterpriseActiveRun({
      plan,
      policies: [],
      mcpServers: params.registered ?? params.attached ?? [],
    });
  }

  const twoServers = {
    mcp: {
      servers: {
        attached: { transport: "stdio", command: "node", args: ["./attached.mjs"] },
        unattached: { transport: "stdio", command: "node", args: ["./unattached.mjs"] },
      },
    },
  } as unknown as OpenClawConfig;

  it("withholds a server the governing work-map does not attach", () => {
    // The Codex thread config is a session layer that composes BY KEY, so an
    // omitted key is a server OpenClaw did not hand over.
    registerGovernedRun({ runId: "codex-run-1", attached: ["attached"] });

    const patch = buildCodexUserMcpServersThreadConfigPatch(twoServers, {
      runId: "codex-run-1",
    });

    expect(Object.keys(patch?.mcp_servers ?? {})).toEqual(["attached"]);
  });

  it("keeps an attached server whose colliding sibling is scoped to another agent", () => {
    // The sibling is filtered out for this thread, so it cannot collide — and
    // dropping the attached server with it would strip an attachment this thread
    // should receive.
    registerGovernedRun({
      runId: "codex-run-agent-scope",
      attached: ["my server", "my:server"],
      // An explicit allow-list is what makes collisions decidable at all: without
      // one the grant is unconditional and the sibling never matters.
      rootAllowedTools: ["my-server__*", "mcp__my-server__*", "my_server__*", "mcp__my_server__*"],
    });

    const patch = buildCodexUserMcpServersThreadConfigPatch(
      {
        mcp: {
          servers: {
            "my server": { transport: "stdio", command: "node" },
            "my:server": {
              transport: "stdio",
              command: "node",
              codex: { agents: ["other-agent"] },
            },
          },
        },
      } as unknown as OpenClawConfig,
      { runId: "codex-run-agent-scope", agentId: "main" },
    );

    expect(Object.keys(patch?.mcp_servers ?? {})).toEqual(["my server"]);
  });

  it("projects every server when no work-map governs the thread", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch(twoServers, { runId: "not-a-run" });

    expect(Object.keys(patch?.mcp_servers ?? {}).toSorted()).toEqual(["attached", "unattached"]);
  });

  it("projects every server in observe mode", () => {
    // Observe watches without blocking, and withholding a server is physical.
    registerGovernedRun({ runId: "codex-run-2", attached: ["attached"], mode: "observe" });

    const patch = buildCodexUserMcpServersThreadConfigPatch(twoServers, {
      runId: "codex-run-2",
    });

    expect(Object.keys(patch?.mcp_servers ?? {}).toSorted()).toEqual(["attached", "unattached"]);
  });

  it("projects a stdio user MCP server entry into mcp_servers (regression: #80814)", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          outlook: {
            transport: "stdio",
            command: "node",
            args: ["/opt/outlook-mcp/dist/index.js"],
            env: { OUTLOOK_USER: "alice@example.org" },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        outlook: {
          command: "node",
          args: ["/opt/outlook-mcp/dist/index.js"],
          env: { OUTLOOK_USER: "alice@example.org" },
        },
      },
    });
  });

  it("projects a streamable-http user MCP server with bearer auth into mcp_servers", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          notes: {
            transport: "streamable-http",
            url: "https://notes.example.org/mcp",
            headers: {
              Authorization: "Bearer ${NOTES_TOKEN}",
              "x-tenant": "${NOTES_TENANT}",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        notes: {
          url: "https://notes.example.org/mcp",
          bearer_token_env_var: "NOTES_TOKEN",
          env_http_headers: { "x-tenant": "NOTES_TENANT" },
        },
      },
    });
  });

  it("projects Codex-specific default tool approval mode", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          search: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            codex: {
              defaultToolsApprovalMode: "approve",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
          default_tools_approval_mode: "approve",
        },
      },
    });
  });

  it("uses the Codex-native approval spelling when configured", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          search: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            codex: {
              default_tools_approval_mode: "prompt",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch?.mcp_servers.search).toMatchObject({
      url: "https://mcp.example.com/mcp",
      default_tools_approval_mode: "prompt",
    });
  });

  it("filters Codex-scoped user MCP servers by OpenClaw agent id", () => {
    // Agent-scoped MCP servers should follow the active OpenClaw agent, while
    // unscoped servers remain global.
    const cfg = {
      mcp: {
        servers: {
          atlas: {
            transport: "streamable-http",
            url: "https://atlas.example.com/mcp",
            codex: { agents: ["atlas"] },
          },
          apolo: {
            transport: "streamable-http",
            url: "https://apolo.example.com/mcp",
            codex: { agents: ["apolo"] },
          },
          global: {
            transport: "stdio",
            command: "node",
            args: ["global-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const atlasPatch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "atlas" });
    expect(Object.keys(atlasPatch!.mcp_servers).toSorted()).toEqual(["atlas", "global"]);
    expect(atlasPatch!.mcp_servers.atlas).toMatchObject({ url: "https://atlas.example.com/mcp" });
    expect(atlasPatch!.mcp_servers.global).toMatchObject({
      command: "node",
      args: ["global-mcp.js"],
    });

    const apoloPatch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "apolo" });
    expect(Object.keys(apoloPatch!.mcp_servers).toSorted()).toEqual(["apolo", "global"]);
    expect(apoloPatch!.mcp_servers.apolo).toMatchObject({ url: "https://apolo.example.com/mcp" });
  });

  it("returns undefined when all user MCP servers are scoped to other agents", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch(
      {
        mcp: {
          servers: {
            atlas: {
              transport: "streamable-http",
              url: "https://atlas.example.com/mcp",
              codex: { agents: ["atlas"] },
            },
          },
        },
      } as unknown as OpenClawConfig,
      { agentId: "apolo" },
    );
    expect(patch).toBeUndefined();
  });

  it("omits disabled user MCP servers from Codex app-server projection", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          disabled: {
            enabled: false,
            transport: "streamable-http",
            url: "https://disabled.example.com/mcp",
          },
          enabled: {
            transport: "stdio",
            command: "node",
            args: ["enabled-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(patch).toStrictEqual({
      mcp_servers: {
        enabled: {
          command: "node",
          args: ["enabled-mcp.js"],
        },
      },
    });
  });

  it("normalizes Codex agent scopes before matching", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch(
      {
        mcp: {
          servers: {
            atlas: {
              transport: "streamable-http",
              url: "https://atlas.example.com/mcp",
              codex: { agents: ["Atlas"] },
            },
          },
        },
      } as unknown as OpenClawConfig,
      { agentId: "ATLAS" },
    );
    expect(patch?.mcp_servers.atlas).toMatchObject({
      url: "https://atlas.example.com/mcp",
    });
  });

  it("fails closed for empty or invalid Codex agent scopes", () => {
    const cfg = {
      mcp: {
        servers: {
          empty: {
            transport: "streamable-http",
            url: "https://empty.example.com/mcp",
            codex: { agents: [] },
          },
          blank: {
            transport: "streamable-http",
            url: "https://blank.example.com/mcp",
            codex: { agents: ["  "] },
          },
          invalid: {
            transport: "streamable-http",
            url: "https://invalid.example.com/mcp",
            codex: { agents: ["", 1, null, "!!!", "-main-"] },
          },
          global: {
            transport: "stdio",
            command: "node",
            args: ["global-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const patch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "atlas" });
    expect(patch).toStrictEqual({
      mcp_servers: {
        global: {
          command: "node",
          args: ["global-mcp.js"],
        },
      },
    });
  });

  it("omits scoped Codex MCP servers when no OpenClaw agent id is available", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          atlas: {
            transport: "streamable-http",
            url: "https://atlas.example.com/mcp",
            codex: { agents: ["atlas"] },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toBeUndefined();
  });

  it("preserves multiple user MCP servers as independent mcp_servers entries", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          one: { transport: "stdio", command: "one" },
          two: { transport: "stdio", command: "two" },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch?.mcp_servers).toBeDefined();
    expect(Object.keys(patch!.mcp_servers).toSorted()).toEqual(["one", "two"]);
    expect(patch!.mcp_servers.one).toMatchObject({ command: "one" });
    expect(patch!.mcp_servers.two).toMatchObject({ command: "two" });
  });
});
