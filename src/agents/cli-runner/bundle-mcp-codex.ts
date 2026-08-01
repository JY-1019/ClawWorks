/**
 * Codex CLI and app-server bundle MCP projection helpers.
 */
import { normalizeConfiguredMcpServers } from "../../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { enterpriseRunAttachedMcpServers } from "../../enterprise/active-runs.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { isValidAgentId, normalizeAgentId } from "../../routing/session-key.js";
import { buildCodexMcpServersConfig, normalizeCodexMcpServerConfig } from "../codex-mcp-config.js";
import { isRecord } from "./bundle-mcp-adapter-shared.js";
import { serializeTomlInlineValue } from "./toml-inline.js";

// Mutable JSON shape structurally compatible with the bundled Codex
// app-server thread-config JsonObject (see the protocol module in the codex
// plugin). Defined locally so this projection result stays assignable to
// mergeCodexThreadConfigs without pulling plugin-local types across the
// extensions boundary.
type CodexThreadConfigValue =
  | string
  | number
  | boolean
  | null
  | CodexThreadConfigValue[]
  | { [key: string]: CodexThreadConfigValue };
type CodexThreadConfigObject = { [key: string]: CodexThreadConfigValue };

type CodexUserMcpServersProjectionOptions = {
  agentId?: string;
  /**
   * The run this thread serves. Under enterprise governance the servers no step
   * attaches are withheld, exactly as the CLI overlay withholds them.
   */
  runId?: string;
  /**
   * Server names the OTHER half of this thread's config carries (the bundle
   * patch). Codex deep-merges both into one `mcp_servers` map, so a namespace
   * collision across them is a collision in the thread — and the collision rule
   * fails closed only if it can see both halves.
   */
  peerServerNames?: readonly string[];
};

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => isValidAgentId(entry))
    .map((entry) => normalizeAgentId(entry));
}

function readCodexProjectionConfig(server: BundleMcpServerConfig): Record<string, unknown> {
  return isRecord(server.codex) ? server.codex : {};
}

function isCodexMcpServerAllowedForAgent(
  server: BundleMcpServerConfig,
  options: CodexUserMcpServersProjectionOptions | undefined,
): boolean {
  const codex = readCodexProjectionConfig(server);
  if (!Object.hasOwn(codex, "agents")) {
    return true;
  }
  const agentIds = normalizeAgentIds(codex.agents);
  if (agentIds.length === 0 || !options?.agentId) {
    return false;
  }
  return agentIds.includes(normalizeAgentId(options.agentId));
}

/** Returns Codex CLI args with TOML MCP server overrides injected. */
export function injectCodexMcpConfigArgs(
  args: string[] | undefined,
  config: BundleMcpConfig,
): string[] {
  const overrides = serializeTomlInlineValue(buildCodexMcpServersConfig(config));
  return [...(args ?? []), "-c", `mcp_servers=${overrides}`];
}

/**
 * Codex app-server runtime (extensions/codex) receives its thread config as a
 * JSON object through JSON-RPC `thread/start`/`thread/resume`, not as `-c` CLI
 * args. This returns a thread-config patch projecting user-configured
 * `cfg.mcp.servers` entries into Codex's `mcp_servers` table using the same
 * per-server normalization the CLI path uses, so app-server agents see the
 * same user MCP servers the CLI runtime exposes via `injectCodexMcpConfigArgs`.
 *
 * Only user-configured servers (`cfg.mcp.servers`) are projected. Plugin-
 * curated app-server apps are already attached separately through the codex
 * plugin thread-config `apps` patch, so they must not be re-projected here.
 *
 * Under an enforcing enterprise run, a server no workflow step attaches is not
 * projected at all. Codex composes `mcp_servers` by KEY across config layers and
 * a thread patch is the session layer (ConfigLayerSource::SessionFlags, above
 * User/Project — codex-rs/config/src/config_layer_source.rs), so omitting a key
 * withholds what OpenClaw would have injected. It does not remove a server the
 * operator declared in Codex's own config: layers merge table by table
 * (merge_toml_values_at_path, ../codex/codex-rs/config/src/merge.rs:94-119), so an
 * overlay can add and change keys but never delete a lower one — and `enabled =
 * false` is applied only AFTER the transport conversion (mcp_types.rs:354-403), so
 * it cannot stand in for a delete either. That layer belongs to the harness; the
 * docs state the boundary where operators look.
 */
export function buildCodexUserMcpServersThreadConfigPatch(
  cfg: OpenClawConfig | undefined,
  options?: CodexUserMcpServersProjectionOptions,
): { mcp_servers: CodexThreadConfigObject } | undefined {
  const emitted = new Set(resolveCodexEmittedUserMcpServerNames(cfg, options));
  const mcp_servers: CodexThreadConfigObject = {};
  for (const [name, server] of Object.entries(normalizeConfiguredMcpServers(cfg?.mcp?.servers))) {
    if (!emitted.has(name)) {
      continue;
    }
    mcp_servers[name] = normalizeCodexMcpServerConfig(
      name,
      server as BundleMcpServerConfig,
    ) as CodexThreadConfigObject;
  }
  if (Object.keys(mcp_servers).length === 0) {
    return undefined;
  }
  return { mcp_servers };
}

/**
 * The `mcp.servers` names this thread will actually receive: enabled, allowed for
 * this agent, and attached by the work-map.
 *
 * Exported because the OTHER half of the same thread config — the plugin bundle —
 * judges namespace collisions against it. Codex hashes a callable name only when
 * two servers it really has collide, so a key that is disabled, scoped to another
 * agent, or left unattached is not a collision and must not withhold a plugin
 * server that works. One definition rather than two, or the halves drift.
 */
export function resolveCodexEmittedUserMcpServerNames(
  cfg: OpenClawConfig | undefined,
  options?: CodexUserMcpServersProjectionOptions,
): string[] {
  const entries = Object.entries(normalizeConfiguredMcpServers(cfg?.mcp?.servers));
  if (entries.length === 0) {
    return [];
  }
  // Eligibility FIRST, attachment second: a disabled or agent-scoped entry never
  // reaches this thread, so letting it into the collision set would withhold the
  // very server that does. Only the bundle half is a peer here — a configured
  // server the work-map leaves unattached is dropped below and never emitted.
  const eligible = entries.filter(
    ([, server]) =>
      server.enabled !== false &&
      isCodexMcpServerAllowedForAgent(server as BundleMcpServerConfig, options),
  );
  const attached = enterpriseRunAttachedMcpServers(
    options?.runId,
    options?.peerServerNames ?? [],
    eligible.map(([name]) => name),
  );
  return eligible.map(([name]) => name).filter((name) => !attached || attached.has(name));
}
