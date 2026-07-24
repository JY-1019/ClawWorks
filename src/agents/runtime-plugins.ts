/**
 * Ensures runtime plugin registries are loaded for agent execution. Startup
 * plugin IDs from metadata scope the load when available.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureBundleFoundationsLoadedOnce } from "../enterprise/knowledge-bundle-loader.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "../plugins/runtime/standalone-runtime-registry-loader.js";
import { resolveUserPath } from "../utils.js";

type StartupScopedPluginSnapshot = NonNullable<
  ReturnType<typeof getCurrentPluginMetadataSnapshot>
> & {
  startup?: {
    pluginIds?: readonly unknown[];
  };
};

function resolveStartupPluginIdsFromCurrentSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string[] | undefined {
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }) as StartupScopedPluginSnapshot | undefined;
  const pluginIds = snapshot?.startup?.pluginIds;
  if (!Array.isArray(pluginIds)) {
    return undefined;
  }
  return pluginIds.filter((pluginId): pluginId is string => typeof pluginId === "string");
}

/** Ensure standalone runtime plugins are loaded for the current agent context. */
export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  // Persisted bundle foundations are operator-imported data, not plugins (they
  // register into their own registry the plugin lifecycle never clears), so load
  // them even when plugins are disabled, before the early-return below. Guarded to
  // load once per process; the gateway reloads them per lifecycle (see loader).
  ensureBundleFoundationsLoadedOnce();
  if (params.config && !normalizePluginsConfig(params.config.plugins).enabled) {
    return;
  }
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const startupPluginIds = resolveStartupPluginIdsFromCurrentSnapshot({
    config: params.config,
    workspaceDir,
  });
  const allowGatewaySubagentBinding =
    params.allowGatewaySubagentBinding === true ||
    getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  ensureStandaloneRuntimePluginRegistryLoaded({
    requiredPluginIds: startupPluginIds,
    loadOptions: {
      config: params.config,
      workspaceDir,
      ...(startupPluginIds === undefined ? {} : { onlyPluginIds: startupPluginIds }),
      ...(startupPluginIds === undefined ? {} : { forceFullRuntimeForChannelPlugins: true }),
      runtimeOptions: allowGatewaySubagentBinding
        ? { allowGatewaySubagentBinding: true }
        : undefined,
    },
  });
}
