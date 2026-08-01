/**
 * Prepares bundled MCP configuration for CLI runner backends.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  enterpriseRunAttachedMcpServers,
  enterpriseRunBoundableMcpServers,
  resolveEnterpriseMcpServers,
} from "../../enterprise/active-runs.js";
import { tryReadJson } from "../../infra/json-files.js";
import { extractMcpServerMap, type BundleMcpConfig } from "../../plugins/bundle-mcp.js";
import type { CliBundleMcpMode } from "../../plugins/types.js";
import { loadMergedBundleMcpConfig, toCliBundleMcpServerConfig } from "../bundle-mcp-config.js";
import { isRecord } from "./bundle-mcp-adapter-shared.js";
import {
  findClaudeMcpConfigPath,
  injectClaudeMcpConfigArgs,
  writeClaudeMcpCaptureConfig,
} from "./bundle-mcp-claude.js";
import { injectCodexMcpConfigArgs } from "./bundle-mcp-codex.js";
import { writeGeminiMcpCaptureSettings, writeGeminiSystemSettings } from "./bundle-mcp-gemini.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  env?: Record<string, string>;
};

function resolveBundleMcpMode(mode: CliBundleMcpMode | undefined): CliBundleMcpMode {
  return mode ?? "claude-config-file";
}

async function readExternalMcpConfig(configPath: string): Promise<BundleMcpConfig> {
  return { mcpServers: extractMcpServerMap(await tryReadJson<unknown>(configPath)) };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function normalizeOpenClawLoopbackUrl(value: string): string {
  const match =
    /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(\/mcp)$/.exec(value.trim()) ?? undefined;
  if (!match) {
    return value;
  }
  return `${match[1]}:<openclaw-loopback>${match[2]}`;
}

function canonicalizeBundleMcpConfigForResume(config: BundleMcpConfig): BundleMcpConfig {
  // The OpenClaw loopback MCP port changes across runs. Replace it before
  // hashing so resume compatibility tracks config shape, not ephemeral ports.
  const canonicalServers = Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => {
      if (name !== "openclaw" || typeof server.url !== "string") {
        return [name, sortJsonValue(server)];
      }
      return [
        name,
        sortJsonValue({
          ...server,
          url: normalizeOpenClawLoopbackUrl(server.url),
        }),
      ];
    }),
  ) as BundleMcpConfig["mcpServers"];
  return {
    mcpServers: sortJsonValue(canonicalServers) as BundleMcpConfig["mcpServers"],
  };
}

const OPENCLAW_MCP_ENV_TEMPLATE_PATTERN = /\$\{(OPENCLAW_MCP_[A-Z0-9_]+)\}/g;

function resolveOpenClawMcpEnvTemplates(value: unknown, env?: Record<string, string>): unknown {
  if (!env) {
    return value;
  }
  if (typeof value === "string") {
    return value.replace(OPENCLAW_MCP_ENV_TEMPLATE_PATTERN, (match, name: string) => {
      return Object.hasOwn(env, name) ? env[name] : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOpenClawMcpEnvTemplates(entry, env));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveOpenClawMcpEnvTemplates(entry, env)]),
  );
}

async function prepareModeSpecificBundleMcpConfig(params: {
  mode: CliBundleMcpMode;
  backend: CliBackendConfig;
  mergedConfig: BundleMcpConfig;
  env?: Record<string, string>;
}): Promise<PreparedCliBundleMcpConfig> {
  const serializedConfig = `${JSON.stringify(params.mergedConfig, null, 2)}\n`;
  const mcpConfigHash = crypto.createHash("sha256").update(serializedConfig).digest("hex");
  const serializedResumeConfig = `${JSON.stringify(
    canonicalizeBundleMcpConfigForResume(params.mergedConfig),
    null,
    2,
  )}\n`;
  const mcpResumeHash = crypto.createHash("sha256").update(serializedResumeConfig).digest("hex");

  if (params.mode === "codex-config-overrides") {
    return {
      backend: {
        ...params.backend,
        args: injectCodexMcpConfigArgs(params.backend.args, params.mergedConfig),
        resumeArgs: injectCodexMcpConfigArgs(
          params.backend.resumeArgs ?? params.backend.args ?? [],
          params.mergedConfig,
        ),
      },
      mcpConfigHash,
      mcpResumeHash,
      env: params.env,
    };
  }

  if (params.mode === "gemini-system-settings") {
    const settings = await writeGeminiSystemSettings(params.mergedConfig, params.env);
    return {
      backend: params.backend,
      mcpConfigHash,
      mcpResumeHash,
      env: settings.env,
      cleanup: settings.cleanup,
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  const mcpConfigPath = path.join(tempDir, "mcp.json");
  const runtimeConfig = resolveOpenClawMcpEnvTemplates(
    params.mergedConfig,
    params.env,
  ) as BundleMcpConfig;
  await fs.writeFile(mcpConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf-8");
  return {
    backend: {
      ...params.backend,
      args: injectClaudeMcpConfigArgs(params.backend.args, mcpConfigPath),
      resumeArgs: injectClaudeMcpConfigArgs(
        params.backend.resumeArgs ?? params.backend.args ?? [],
        mcpConfigPath,
      ),
    },
    mcpConfigHash,
    mcpResumeHash,
    env: params.env,
    cleanup: async () => {
      // Claude config files are generated per run and should not survive cleanup.
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

/** Prepare backend args/env/cleanup for bundle MCP injection into a CLI run. */
/**
 * Drop the operator-supplied servers the work-map never attaches.
 *
 * `gated` is every server an OPERATOR wired up — the `mcp.servers` registry plus
 * whatever an inherited `--mcp-config` file brought in. Plugin-provided servers
 * are deliberately outside it: they arrive with a plugin's tool surface and are
 * scoped by `allowedTools` like the rest of it, and OpenClaw's own loopback server
 * is merged after this. Applied BEFORE the mode writers so one rule covers every
 * CLI backend rather than one config format.
 */
function withdrawUnattachedMcpServers(params: {
  merged: BundleMcpConfig;
  /** `mcp.servers` names: the only ones a work-map can attach. */
  registered: readonly string[];
  /**
   * Servers an inherited `--mcp-config` brought in that config does not register.
   * Operator-supplied, so governed — but not attachable either: the Enterprise MCP
   * screen cannot register them and an attachment naming one is reported as
   * unregistered. Withheld outright rather than satisfiable by an attachment that
   * the operator is told does nothing.
   */
  inheritedOnly: readonly string[];
  attached: ReadonlySet<string> | null | undefined;
  /** Names a PLUGIN bundle supplies; no attachment can grant or withhold them. */
  plugin: readonly string[];
  /** The subset of `plugin` the run's tool ceiling still admits, or null when unjudged. */
  pluginAdmitted: ReadonlySet<string> | null | undefined;
}): BundleMcpConfig {
  const withheld = new Set([
    ...(params.attached
      ? [
          ...params.registered.filter((name) => !params.attached?.has(name)),
          ...params.inheritedOnly,
        ]
      : []),
    ...(params.pluginAdmitted
      ? params.plugin.filter((name) => !params.pluginAdmitted?.has(name))
      : []),
  ]);
  if (withheld.size === 0) {
    return params.merged;
  }
  const servers = Object.fromEntries(
    Object.entries(params.merged.mcpServers ?? {}).filter(([name]) => !withheld.has(name)),
  );
  return { ...params.merged, mcpServers: servers };
}

export async function prepareCliBundleMcpConfig(params: {
  enabled: boolean;
  mode?: CliBundleMcpMode;
  backend: CliBackendConfig;
  workspaceDir: string;
  config?: OpenClawConfig;
  additionalConfig?: BundleMcpConfig;
  env?: Record<string, string>;
  warn?: (message: string) => void;

  /** The run this overlay serves; its projected servers are recorded for the gate. */
  runId?: string;
}): Promise<PreparedCliBundleMcpConfig> {
  if (!params.enabled) {
    return { backend: params.backend, env: params.env };
  }

  const mode = resolveBundleMcpMode(params.mode);
  const existingMcpConfigPath =
    mode === "claude-config-file"
      ? (findClaudeMcpConfigPath(params.backend.resumeArgs) ??
        findClaudeMcpConfigPath(params.backend.args))
      : undefined;
  let mergedConfig: BundleMcpConfig = { mcpServers: {} };
  // Servers an operator wired up rather than a plugin: the inherited config file's
  // entries collect here alongside the `mcp.servers` registry, because governance
  // gates both the same way.
  const configuredServerNames = new Set(Object.keys(params.config?.mcp?.servers ?? {}));
  const operatorServerNames = new Set(configuredServerNames);

  if (existingMcpConfigPath) {
    // Merge any user-provided Claude MCP config first so bundle/plugin config can
    // override intentionally managed server entries.
    const resolvedExistingPath = path.isAbsolute(existingMcpConfigPath)
      ? existingMcpConfigPath
      : path.resolve(params.workspaceDir, existingMcpConfigPath);
    const externalConfig = await readExternalMcpConfig(resolvedExistingPath);
    for (const name of Object.keys(externalConfig.mcpServers ?? {})) {
      operatorServerNames.add(name);
    }
    mergedConfig = applyMergePatch(mergedConfig, externalConfig) as BundleMcpConfig;
  }

  const bundleConfig = loadMergedBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    mapConfiguredServer: toCliBundleMcpServerConfig,
  });
  for (const diagnostic of bundleConfig.diagnostics) {
    params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  // A plugin's own server wins the merge when it shares a name with an inherited
  // entry, and plugin servers are outside the attachment boundary — they arrive
  // with a plugin's tool surface and cannot be attached from the work-map. So the
  // final owner of a name decides: a name the bundle provides is no longer
  // operator-owned, whatever the inherited file called it.
  for (const name of Object.keys(bundleConfig.config.mcpServers ?? {})) {
    if (!configuredServerNames.has(name)) {
      operatorServerNames.delete(name);
    }
    // Whoever supplies the name supplies the WHOLE entry. applyMergePatch descends
    // into objects, so merge-patching would leave the inherited file's command,
    // args, env, url, and headers beside the definition an operator can actually
    // see — an inherited Authorization header riding along to a configured URL, or
    // inherited launch behavior under a key that attachment already approved.
    // Classification (who owns the name) stays separate from replacement.
    delete mergedConfig.mcpServers?.[name];
  }
  mergedConfig = applyMergePatch(mergedConfig, bundleConfig.config) as BundleMcpConfig;
  // A CLI backend connects its servers itself, from a config file it owns, so
  // nothing can be withheld once the process is up: whatever survives here is
  // reachable for the whole run. Both filters below therefore judge namespace
  // collisions against the servers that will REALLY arrive — a clash with one
  // that never ships would withhold a working server for nothing.
  //
  // The plugin half goes FIRST because it does not depend on attachments (the
  // run's tool ceiling decides it), while the attachment half needs to know which
  // plugin servers survive to collide with. Resolving them the other way around
  // would let a plugin server that is about to be dropped take a legitimately
  // attached configured server down with it. The Codex projection resolves them
  // in this same order.
  const loopbackServerNames = Object.keys(params.additionalConfig?.mcpServers ?? {});
  // A plugin's servers cannot be attached — they arrive with the plugin's tool
  // surface — but the run's tool ceiling still applies to them, and this overlay is
  // the only place that can apply it: a hookless CLI judges no call afterwards.
  const pluginServerNames = Object.keys(mergedConfig.mcpServers ?? {}).filter(
    (name) => !operatorServerNames.has(name),
  );
  // Peers here are the operator servers the backend can receive at all: the
  // ENABLED registry plus whatever the inherited config file brought in. A
  // disabled key is skipped by every projection, so treating it as a namespace
  // collision would withhold a working plugin server for a clash that cannot
  // happen. Attachment may still drop some of these, which only makes this
  // conservative — the safe direction for a ceiling.
  const emittedOperatorServerNames = new Set([
    ...resolveEnterpriseMcpServers(params.config),
    ...[...operatorServerNames].filter((name) => !configuredServerNames.has(name)),
  ]);
  const admittedPluginServers = enterpriseRunBoundableMcpServers(params.runId, pluginServerNames, [
    ...emittedOperatorServerNames,
    // The loopback overlay merges later but lands in the same config.
    ...loopbackServerNames,
  ]);
  // Only the plugin servers that survived the ceiling are collision peers for the
  // attachment filter; the rest are never written. The function adds the attached
  // servers themselves.
  const survivingPluginPeers = pluginServerNames.filter(
    (name) => !admittedPluginServers || admittedPluginServers.has(name),
  );
  const attachedMcpServers = enterpriseRunAttachedMcpServers(params.runId, [
    ...survivingPluginPeers,
    ...loopbackServerNames,
  ]);
  mergedConfig = withdrawUnattachedMcpServers({
    merged: mergedConfig,
    registered: [...operatorServerNames].filter((name) => configuredServerNames.has(name)),
    inheritedOnly: [...operatorServerNames].filter((name) => !configuredServerNames.has(name)),
    attached: attachedMcpServers,
    plugin: pluginServerNames,
    pluginAdmitted: admittedPluginServers,
  });
  if (params.additionalConfig) {
    // Same whole-owner rule as the bundle merge above: the loopback overlay owns
    // the names it supplies. Merge-patching onto a server that happens to share a
    // name (`openclaw`) would leave that server's command, args, and env beside the
    // overlay's url — a transport mix Codex refuses to load at all ("url is not
    // supported for stdio", ../codex/codex-rs/config/src/mcp_types.rs:347-392).
    for (const name of Object.keys(params.additionalConfig.mcpServers ?? {})) {
      delete mergedConfig.mcpServers?.[name];
    }
    mergedConfig = applyMergePatch(mergedConfig, params.additionalConfig) as BundleMcpConfig;
  }

  return await prepareModeSpecificBundleMcpConfig({
    mode,
    backend: params.backend,
    mergedConfig,
    env: params.env,
  });
}

/** Prepares a per-attempt capture token without changing resume compatibility hashes. */
export async function prepareCliBundleMcpCaptureAttempt(params: {
  mode?: CliBundleMcpMode;
  backend?: CliBackendConfig;
  env?: Record<string, string>;
  captureKey?: string;
}): Promise<{ env?: Record<string, string>; cleanup?: () => Promise<void> }> {
  if (!params.captureKey) {
    return { env: params.env };
  }
  if (resolveBundleMcpMode(params.mode) === "gemini-system-settings") {
    return await writeGeminiMcpCaptureSettings({
      inheritedEnv: params.env,
      captureKey: params.captureKey,
    });
  }
  if (resolveBundleMcpMode(params.mode) === "claude-config-file") {
    const mcpConfigPath =
      findClaudeMcpConfigPath(params.backend?.args) ??
      findClaudeMcpConfigPath(params.backend?.resumeArgs);
    if (mcpConfigPath) {
      await writeClaudeMcpCaptureConfig({
        mcpConfigPath,
        captureKey: params.captureKey,
      });
    }
  }
  return {
    env: {
      ...params.env,
      OPENCLAW_MCP_CLI_CAPTURE_KEY: params.captureKey,
    },
  };
}
