// Covers conversion from OpenClaw bundle-MCP config into Codex app-server
// thread config patches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
} from "../enterprise/runtime.js";
import { buildCodexMcpServersConfig, loadCodexBundleMcpThreadConfig } from "./codex-mcp-config.js";

const mocks = vi.hoisted(() => ({
  bundleMcp: {
    config: {
      mcpServers: {},
    },
    diagnostics: [],
  },
}));

vi.mock("../plugins/bundle-mcp.js", () => ({
  loadEnabledBundleMcpConfig: () => mocks.bundleMcp,
}));

beforeEach(() => {
  mocks.bundleMcp = {
    config: {
      mcpServers: {},
    },
    diagnostics: [],
  };
});

describe("buildCodexMcpServersConfig", () => {
  it("normalizes OpenClaw MCP servers into Codex app-server mcp_servers shape", () => {
    // Authorization is represented as Codex's bearer env var, while other env
    // placeholders become env_http_headers for per-thread substitution.
    expect(
      buildCodexMcpServersConfig({
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
              "x-static": "static-value",
            },
          },
        },
      }),
    ).toEqual({
      openclaw: {
        url: "http://127.0.0.1:23119/mcp",
        default_tools_approval_mode: "approve",
        bearer_token_env_var: "OPENCLAW_MCP_TOKEN",
        http_headers: {
          "x-static": "static-value",
        },
        env_http_headers: {
          "x-session-key": "OPENCLAW_MCP_SESSION_KEY",
        },
      },
    });
  });

  it("preserves Codex-specific MCP approval mode metadata", () => {
    expect(
      buildCodexMcpServersConfig({
        mcpServers: {
          search: {
            url: "https://mcp.example.com/mcp",
            codex: {
              defaultToolsApprovalMode: "prompt",
            },
          },
        },
      }),
    ).toEqual({
      search: {
        url: "https://mcp.example.com/mcp",
        default_tools_approval_mode: "prompt",
      },
    });
  });
});

describe("loadCodexBundleMcpThreadConfig", () => {
  afterEach(() => {
    clearEnterpriseActiveRunsForTest();
  });

  it("withholds a plugin server the run's tool ceiling cannot bound", () => {
    // The app-server thread has no per-call gate that could recognize an MCP tool
    // (Codex's hook carries no provenance), so a denial that reaches this server has
    // to be honored before the thread starts — exactly as the CLI overlay does.
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          bundleProbe: { type: "http", url: "https://plugin.example.com/mcp" },
        },
      },
      diagnostics: [],
    };
    registerEnterpriseActiveRun({
      plan: {
        runId: "codex-ceiling-run",
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
            ontology: { deniedTools: ["bundleProbe__*"] },
          },
        ],
        activeNodeId: "support",
        // No attachment governance at all: just a denial, as a tree that never
        // mentions MCP would carry it.
        mcpDeniedTools: ["bundleProbe__*"],
        mode: "enforce",
        createdAt: 0,
      },
      policies: [],
      mcpServers: [],
    });

    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      runId: "codex-ceiling-run",
      cfg: {},
    });

    expect(loaded.configPatch).toBeUndefined();
  });

  it("keeps a plugin server whose namespace twin never reaches Codex", () => {
    // `my:server` and `my server` both sanitize to `my_server`, but the configured
    // one is disabled and the caller therefore does not list it as emitted. Codex
    // hashes only the servers it really has, so treating an absent key as a
    // collision would withhold a plugin server for a clash that cannot happen.
    mocks.bundleMcp = {
      config: {
        mcpServers: { "my server": { type: "http", url: "https://plugin.example.com/mcp" } },
      },
      diagnostics: [],
    };
    registerEnterpriseActiveRun({
      plan: {
        runId: "codex-peer-run",
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
            // A narrowed root, so the ceiling really is consulted for the plugin
            // half; it grants this server whole under every spelling a runtime can
            // emit (Codex folds punctuation to `_`, OpenClaw to `-`, either with
            // the legacy prefix).
            ontology: {
              allowedTools: [
                "my_server__*",
                "mcp__my_server__*",
                "my-server__*",
                "mcp__my-server__*",
              ],
            },
          },
        ],
        activeNodeId: "support",
        mode: "enforce",
        createdAt: 0,
      },
      policies: [],
      mcpServers: [],
    });

    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      runId: "codex-peer-run",
      cfg: { mcp: { servers: { "my:server": { command: "node", enabled: false } } } },
      emittedUserMcpServerNames: [],
    });

    expect(Object.keys(loaded.configPatch?.mcp_servers ?? {})).toEqual(["my server"]);
  });

  it("drops a bundle entry under a registered name even when the work-map attaches it", () => {
    // Codex deep-merges this patch with the user projection, so keeping both halves
    // of a shared name composes them: bundle url and headers beside the configured
    // command. That mix is not even loadable ("url is not supported for stdio",
    // RawMcpServerConfig conversion in ../codex/codex-rs/config/src/mcp_types.rs:347-392).
    // The configured projection owns registered names, attachment included.
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          shared: {
            type: "http",
            url: "https://bundle.example.com/mcp",
            headers: { Authorization: "Bearer bundle" },
          },
          pluginOnly: { type: "http", url: "https://plugin.example.com/mcp" },
        },
      },
      diagnostics: [],
    };

    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: { servers: { shared: { command: "node", args: ["./shared.mjs"] } } },
      },
    });

    expect(Object.keys(loaded.configPatch?.mcp_servers ?? {})).toEqual(["pluginOnly"]);
  });

  it("loads enabled bundled MCP servers as a Codex thread config patch", () => {
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          search: {
            type: "http",
            url: "https://mcp.example.com/mcp",
          },
        },
      },
      diagnostics: [],
    };

    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });

    expect(loaded.configPatch).toEqual({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
        },
      },
    });
    expect(loaded.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("leaves user mcp.servers to the Codex user MCP projection path", () => {
    // User MCP config is projected elsewhere; this loader only injects bundled
    // MCP servers so the same server does not appear twice in Codex.
    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            search: {
              transport: "streamable-http",
              url: "https://mcp.example.com/mcp",
            },
          },
        },
      },
      toolsEnabled: true,
    });

    expect(loaded.configPatch).toBeUndefined();
    expect(loaded.fingerprint).toBeUndefined();
    expect(loaded.evaluated).toBe(true);
  });

  it("returns an evaluated empty MCP config when no bundle MCP runtime is needed", () => {
    const cfg = {
      mcp: {
        servers: {
          search: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
          },
        },
      },
    } as const;

    for (const params of [
      { toolsEnabled: false },
      { toolsEnabled: true, disableTools: true },
      { toolsEnabled: true, toolsAllow: [] },
      { toolsEnabled: true, toolsAllow: ["memory_search"] },
    ]) {
      const loaded = loadCodexBundleMcpThreadConfig({
        workspaceDir: "/workspace",
        cfg,
        ...params,
      });

      expect(loaded.configPatch).toBeUndefined();
      expect(loaded.fingerprint).toBeUndefined();
      expect(loaded.evaluated).toBe(true);
    }
  });

  it("omits the config patch when no MCP servers are configured", () => {
    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {},
      toolsEnabled: true,
    });

    expect(loaded.configPatch).toBeUndefined();
    expect(loaded.fingerprint).toBeUndefined();
    expect(loaded.evaluated).toBe(true);
  });
});
