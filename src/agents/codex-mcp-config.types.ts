/**
 * Shared types for projecting bundle MCP config into Codex app-server threads.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic } from "../plugins/bundle-mcp.js";

/** Codex app-server `mcp_servers` config map. */
export type CodexMcpServersConfig = Record<string, Record<string, unknown>>;

/** Loaded Codex thread-config patch plus diagnostics and cache metadata. */
export type CodexBundleMcpThreadConfig = {
  configPatch?: {
    mcp_servers: CodexMcpServersConfig;
  };
  diagnostics: BundleMcpDiagnostic[];
  evaluated: boolean;
  fingerprint?: string;
};

/** Inputs used to load a Codex bundle-MCP thread config patch. */
export type LoadCodexBundleMcpThreadConfigParams = {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  toolsEnabled?: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
  /**
   * The run this thread serves. Its tool ceiling decides which plugin-supplied MCP
   * servers may be handed over: nothing recognizes their calls afterwards, because
   * Codex's hook carries no MCP provenance.
   */
  runId?: string;
  /**
   * `mcp.servers` names the user projection will emit into the SAME merged
   * `mcp_servers` map (resolveCodexEmittedUserMcpServerNames). They are the
   * collision peers for the plugin servers above; a configured key that never
   * reaches Codex is not a collision. Omitted means "no configured peers", which
   * is what a thread with the user projection disabled has.
   */
  emittedUserMcpServerNames?: readonly string[];
};
