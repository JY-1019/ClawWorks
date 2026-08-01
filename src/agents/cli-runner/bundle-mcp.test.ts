/** Tests Claude-style bundle-MCP config-file overlays for CLI backends. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
} from "../../enterprise/active-runs.js";
import { writeClaudeBundleManifest } from "../../plugins/bundle-mcp.test-support.js";
import { prepareCliBundleMcpCaptureAttempt, prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  prepareBundleProbeCliConfig,
  requireMcpConfigPath,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

// Runs are process-global; leaking one would govern an unrelated case.
afterEach(() => {
  clearEnterpriseActiveRunsForTest();
});

/**
 * Register a governed run whose work-map attaches exactly `attached`. `registered`
 * is the operator's `mcp.servers` snapshot; attachments outside it are inert.
 */
function governRun(runId: string, attached: readonly string[], registered = attached): void {
  registerEnterpriseActiveRun({
    plan: {
      runId,
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
          ontology: { mcpServers: [...attached] },
        },
      ],
      activeNodeId: "support",
      mcpGoverned: true,
      mcpAttachments: [...attached],
      mode: "enforce",
      createdAt: 0,
    },
    policies: [],
    mcpServers: [...registered],
  });
}

/**
 * A governed run whose ROOT narrows tools and never mentions MCP: attachment
 * governance stays off, and the tool ceiling is the only rule left.
 */
function governRunWithRootTools(
  runId: string,
  allowedTools: readonly string[],
  deniedTools: readonly string[] = [],
): void {
  registerEnterpriseActiveRun({
    plan: {
      runId,
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
            ...(allowedTools.length > 0 ? { allowedTools: [...allowedTools] } : {}),
            ...(deniedTools.length > 0 ? { deniedTools: [...deniedTools] } : {}),
          },
        },
      ],
      activeNodeId: "support",
      ...(deniedTools.length > 0 ? { mcpDeniedTools: [...deniedTools] } : {}),
      mode: "enforce",
      createdAt: 0,
    },
    policies: [],
    mcpServers: [],
  });
}

describe("prepareCliBundleMcpConfig", () => {
  it("withholds a plugin MCP server the root allow-list cannot admit", async () => {
    // A plugin's server cannot be attached, so nothing grants it — but nothing
    // judges its calls either on a CLI with no pre-tool hook. A root that allows
    // only `message` has to be honored here or the plugin's tools run unjudged.
    governRunWithRootTools("cli-mcp-plugin-ceiling", ["message"]);

    const prepared = await prepareBundleProbeCliConfig({ runId: "cli-mcp-plugin-ceiling" });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual([]);

    await prepared.cleanup?.();
  });

  it("withholds a plugin MCP server a tree denial reaches", async () => {
    // No attachments anywhere and no allow-list — just a denial. A hookless CLI has
    // no later gate, so the denial has to be honored before the subprocess connects.
    governRunWithRootTools("cli-mcp-plugin-denied", [], ["bundleProbe__*"]);

    const prepared = await prepareBundleProbeCliConfig({ runId: "cli-mcp-plugin-denied" });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual([]);

    await prepared.cleanup?.();
  });

  it("keeps a plugin MCP server whose only namespace twin is a disabled registry key", async () => {
    // `BundleProbe` and `bundleProbe` materialize to the same namespace, but a
    // disabled entry is skipped by every projection and never reaches the backend.
    // Counting it as a collision would withhold a plugin server the root grants,
    // for a clash that cannot happen.
    governRunWithRootTools("cli-mcp-plugin-disabled-peer", [
      "message",
      "bundleProbe__*",
      "mcp__bundleProbe__*",
    ]);

    const prepared = await prepareBundleProbeCliConfig({
      runId: "cli-mcp-plugin-disabled-peer",
      mcpServers: { BundleProbe: { command: "node", enabled: false } },
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["bundleProbe"]);

    await prepared.cleanup?.();
  });

  it("keeps a plugin MCP server the root allow-list grants whole", async () => {
    // Both spellings, as the docs require for a native run: the harness picks which
    // name it exposes, so a list covering only one leaves the rest unbounded.
    governRunWithRootTools("cli-mcp-plugin-granted", [
      "message",
      "bundleProbe__*",
      "mcp__bundleProbe__*",
    ]);

    const prepared = await prepareBundleProbeCliConfig({ runId: "cli-mcp-plugin-granted" });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["bundleProbe"]);

    await prepared.cleanup?.();
  });

  it("injects a strict empty --mcp-config overlay for bundle-MCP-enabled backends without servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-empty-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
    });

    expect(prepared.backend.args).toContain("--strict-mcp-config");
    // Even empty overlays force Claude to ignore user/global MCP servers.
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toStrictEqual({});

    await prepared.cleanup?.();
  });

  it("withholds registered MCP servers the governing work-map does not attach", async () => {
    governRun("cli-mcp-unattached", ["attached"]);
    // A CLI backend dials its own servers from this file, so a server handed over
    // here is reachable for the whole run whatever the active step says. The
    // servers no step attached must therefore never be written.
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-enterprise-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      runId: "cli-mcp-unattached",
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            attached: { command: "node", args: ["./attached.mjs"] },
            unattached: { command: "node", args: ["./unattached.mjs"] },
          },
        },
      },
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["attached"]);

    await prepared.cleanup?.();
  });

  it("withholds an inherited server whose registered twin is disabled", async () => {
    // `mcp.servers` holds the name but has it turned off, so the run's registry
    // snapshot excludes it and the attachment is inert. The inherited file supplies
    // a server under that same key, and an enforcing run must not connect it on the
    // strength of an attachment that names a disabled entry.
    governRun("cli-mcp-disabled-twin", ["shared"], []);
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-disabled-twin-",
    );
    const inheritedPath = path.join(workspaceDir, "inherited-mcp.json");
    await fs.writeFile(
      inheritedPath,
      JSON.stringify({ mcpServers: { shared: { command: "node", args: ["./inherited.mjs"] } } }),
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs", "--mcp-config", inheritedPath] },
      workspaceDir,
      runId: "cli-mcp-disabled-twin",
      config: {
        plugins: { enabled: false },
        mcp: { servers: { shared: { enabled: false, command: "node", args: ["./off.mjs"] } } },
      },
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual([]);

    await prepared.cleanup?.();
  });

  it("withholds an inherited --mcp-config server even when a step attaches it", async () => {
    governRun("cli-mcp-inherited", ["attached", "inherited"]);
    // An inherited entry is operator-supplied but NOT registrable: the Enterprise
    // MCP screen cannot list it and reports such an attachment as unregistered. It
    // must not quietly launch on the strength of that attachment.
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-inherited-",
    );
    const inheritedPath = path.join(workspaceDir, "inherited-mcp.json");
    await fs.writeFile(
      inheritedPath,
      JSON.stringify({
        mcpServers: {
          inherited: { command: "node", args: ["./inherited.mjs"] },
          attached: { command: "node", args: ["./attached.mjs"] },
        },
      }),
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs", "--mcp-config", inheritedPath] },
      workspaceDir,
      runId: "cli-mcp-inherited",
      config: {
        plugins: { enabled: false },
        // Only a registered server is attachable; `inherited` exists solely in the
        // inherited file.
        mcp: { servers: { attached: { command: "node", args: ["./attached.mjs"] } } },
      },
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["attached"]);

    await prepared.cleanup?.();
  });

  it("keeps an attached server whose colliding sibling is unattached", async () => {
    // The sibling is dropped by this very filter, so the collision never reaches
    // the backend and must not withhold the attached server.
    governRun("cli-mcp-inert-collision", ["my server"]);
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-inert-collision-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      runId: "cli-mcp-inert-collision",
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            "my server": { command: "node", args: ["./a.mjs"] },
            "my:server": { command: "node", args: ["./b.mjs"] },
          },
        },
      },
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["my server"]);

    await prepared.cleanup?.();
  });

  it("drops inherited launch fields under a registered server's name", async () => {
    // The registered definition is the one an operator can see and attach. An
    // inherited file that happens to use the same key must not smuggle a command,
    // env, or Authorization header in beside it — attachment already approved this
    // name, so anything left here reaches the subprocess unreviewed.
    governRun("cli-mcp-registered-twin", ["shared"]);
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-registered-twin-",
    );
    const inheritedPath = path.join(workspaceDir, "inherited-mcp.json");
    await fs.writeFile(
      inheritedPath,
      JSON.stringify({
        mcpServers: {
          shared: {
            command: "node",
            args: ["./inherited.mjs"],
            env: { INHERITED_TOKEN: "from-inherited-config" },
            headers: { Authorization: "Bearer inherited" },
          },
        },
      }),
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs", "--mcp-config", inheritedPath] },
      workspaceDir,
      runId: "cli-mcp-registered-twin",
      config: {
        plugins: { enabled: false },
        mcp: { servers: { shared: { type: "http", url: "https://registered.example.com/mcp" } } },
      },
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, Record<string, unknown>> };
    const shared = raw.mcpServers?.shared ?? {};
    expect(shared.url).toBe("https://registered.example.com/mcp");
    expect(shared.command).toBeUndefined();
    expect(shared.args).toBeUndefined();
    expect(shared.env).toBeUndefined();
    expect(shared.headers).toBeUndefined();

    await prepared.cleanup?.();
  });

  it("keeps a plugin-provided server that shares a name with an inherited entry", async () => {
    governRun("cli-mcp-plugin-name", []);
    // The bundle wins that merge, and plugin servers are outside the attachment
    // boundary — they cannot be attached from the work-map, so withholding one
    // would take a working plugin away with no way to grant it back.
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-plugin-name-",
    );
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "shared-probe");
    const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
    await fs.mkdir(path.dirname(serverPath), { recursive: true });
    await fs.writeFile(serverPath, "export {};\n", "utf-8");
    await writeClaudeBundleManifest({
      homeDir: workspaceDir,
      pluginId: "shared-probe",
      manifest: { name: "shared-probe" },
    });
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { shared: { command: "node", args: ["./servers/probe.mjs"] } } })}\n`,
      "utf-8",
    );
    const inheritedPath = path.join(workspaceDir, "inherited-mcp.json");
    await fs.writeFile(
      inheritedPath,
      JSON.stringify({
        mcpServers: {
          shared: {
            command: "node",
            args: ["./inherited.mjs"],
            env: { INHERITED_TOKEN: "from-inherited-config" },
            url: "https://inherited.example.com/mcp",
          },
        },
      }),
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs", "--mcp-config", inheritedPath] },
      workspaceDir,
      runId: "cli-mcp-plugin-name",
      config: { plugins: { entries: { "shared-probe": { enabled: true } } } },
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, Record<string, unknown>> };
    expect(Object.keys(raw.mcpServers ?? {})).toContain("shared");
    // Ownership transferred WHOLE: the key is now exempt from attachment
    // withdrawal, so nothing of the inherited entry may ride along under it.
    const shared = raw.mcpServers?.shared ?? {};
    expect(shared.env).toBeUndefined();
    expect(shared.url).toBeUndefined();
    expect(JSON.stringify(shared.args ?? [])).not.toContain("inherited.mjs");

    await prepared.cleanup?.();
  });

  it("writes every registered server when no work-map governs the run", async () => {
    // null means "not governed", not "attach nothing": a stock CLI run must keep
    // the servers it has always had.
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-ungoverned-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: { servers: { attached: { command: "node", args: ["./attached.mjs"] } } },
      },
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["attached"]);

    await prepared.cleanup?.();
  });

  it("injects a merged --mcp-config overlay for bundle-MCP-enabled backends", async () => {
    const prepared = await prepareBundleProbeCliConfig();

    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.bundleProbe?.args).toEqual([
      await fs.realpath(cliBundleMcpHarness.bundleProbeServerPath),
    ]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.mcpResumeHash).toMatch(/^[0-9a-f]{64}$/);

    await prepared.cleanup?.();
  });

  it("loads workspace bundle MCP plugins from the configured workspace root", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-workspace-root-",
    );
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "workspace-probe");
    // Workspace-local plugins should be resolved relative to workspaceDir, not HOME.
    const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
    await fs.mkdir(path.dirname(serverPath), { recursive: true });
    await fs.writeFile(serverPath, "export {};\n", "utf-8");
    await writeClaudeBundleManifest({
      homeDir: workspaceDir,
      pluginId: "workspace-probe",
      manifest: { name: "workspace-probe" },
    });
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            workspaceProbe: {
              command: "node",
              args: ["./servers/probe.mjs"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: {
        plugins: {
          entries: {
            "workspace-probe": { enabled: true },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.workspaceProbe?.args).toEqual([await fs.realpath(serverPath)]);

    await prepared.cleanup?.();
  });

  it("gives the loopback overlay whole ownership of a name it shares", async () => {
    // The overlay lands under a fixed name (`openclaw`). A configured stdio server
    // that happens to use it must be replaced, not merged: leaving its command and
    // args beside the overlay's url is a transport mix Codex refuses to load ("url
    // is not supported for stdio", RawMcpServerConfig conversion in
    // ../codex/codex-rs/config/src/mcp_types.rs:347-392), and Claude and Gemini
    // would be handed the same malformed entry.
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-loopback-name-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: { servers: { openclaw: { command: "node", args: ["./operator-openclaw.mjs"] } } },
      },
      additionalConfig: {
        mcpServers: {
          openclaw: { type: "http", url: "http://127.0.0.1:23119/mcp" },
        },
      },
      env: {},
    });

    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, Record<string, unknown>> };
    const loopback = raw.mcpServers?.openclaw ?? {};
    expect(loopback.url).toBe("http://127.0.0.1:23119/mcp");
    expect(loopback.command).toBeUndefined();
    expect(loopback.args).toBeUndefined();

    await prepared.cleanup?.();
  });

  it("merges loopback overlay config with bundle MCP servers", async () => {
    const additionalConfig = {
      mcpServers: {
        openclaw: {
          type: "http",
          url: "http://127.0.0.1:23119/mcp",
          headers: {
            Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
          },
        },
      },
    };
    const prepared = await prepareBundleProbeCliConfig({
      additionalConfig,
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });
    const otherEnvPrepared = await prepareBundleProbeCliConfig({
      additionalConfig,
      env: {
        OPENCLAW_MCP_TOKEN: "other-loopback-token",
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(Object.keys(raw.mcpServers ?? {}).toSorted()).toEqual(["bundleProbe", "openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer loopback-token-123");
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe("");
    await prepareCliBundleMcpCaptureAttempt({
      mode: "claude-config-file",
      backend: prepared.backend,
      env: prepared.env,
      captureKey: "attempt-123",
    });
    const attemptRaw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(attemptRaw.mcpServers?.openclaw?.headers?.Authorization).toBe(
      "Bearer loopback-token-123",
    );
    expect(attemptRaw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe(
      "attempt-123",
    );
    expect(prepared.mcpConfigHash).toBe(otherEnvPrepared.mcpConfigHash);
    expect(prepared.mcpResumeHash).toBe(otherEnvPrepared.mcpResumeHash);

    await prepared.cleanup?.();
    await otherEnvPrepared.cleanup?.();
  });

  it("preserves extra env values alongside generated MCP config", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-env-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
        OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
      },
    });

    expect(prepared.env).toEqual({
      OPENCLAW_MCP_TOKEN: "loopback-token-123",
      OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
    });

    await prepared.cleanup?.();
  });

  it("leaves args untouched when bundle MCP is disabled", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      backend: {
        command: "node",
        args: ["./fake-cli.mjs"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-disabled",
    });

    expect(prepared.backend.args).toEqual(["./fake-cli.mjs"]);
    expect(prepared.cleanup).toBeUndefined();
  });
});
