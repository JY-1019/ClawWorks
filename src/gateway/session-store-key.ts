// Session-store key canonicalization across default agents, main aliases, and legacy keys.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  canonicalizeMainSessionAlias,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";

/** Canonicalize an opaque session key into the agent-scoped store namespace. */
export function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  const lowered = normalizeLowercaseStringOrEmpty(key);
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(key);
  if (normalized.startsWith("agent:")) {
    return normalized;
  }
  return `agent:${normalizeAgentId(agentId)}:${normalized}`;
}

function resolveDefaultStoreAgentId(cfg: OpenClawConfig): string {
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

function shouldRemapLegacyDefaultMainAlias(
  cfg: OpenClawConfig,
  parsed: ParsedAgentSessionKey,
  options?: { storeAgentId?: string },
): boolean {
  const agentId = normalizeAgentId(parsed.agentId);
  if (agentId !== DEFAULT_AGENT_ID || listAgentIds(cfg).includes(DEFAULT_AGENT_ID)) {
    return false;
  }
  const defaultAgentId = resolveDefaultStoreAgentId(cfg);
  if (options?.storeAgentId && normalizeAgentId(options.storeAgentId) !== defaultAgentId) {
    return false;
  }
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  return rest === "main" || rest === mainKey;
}

function resolveParsedSessionStoreKey(
  cfg: OpenClawConfig,
  raw: string,
  parsed: ParsedAgentSessionKey,
  options?: { storeAgentId?: string },
): { agentId: string; sessionKey: string } {
  if (!shouldRemapLegacyDefaultMainAlias(cfg, parsed, options)) {
    return {
      agentId: normalizeAgentId(parsed.agentId),
      sessionKey: normalizeSessionKeyPreservingOpaquePeerIds(raw),
    };
  }
  const agentId = resolveDefaultStoreAgentId(cfg);
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  return { agentId, sessionKey: `agent:${agentId}:${rest}` };
}

/**
 * Which agent owns a requested session key, applying the same legacy-alias
 * remapping `resolveSessionStoreKey` does.
 *
 * Needed where the canonical key alone cannot identify an owner: under
 * `session.scope: "global"` every agent's store shares one key, so a caller
 * filtering by that key must also say whose runs it means. Callers cannot work
 * this out themselves — the answer depends on config (the configured default
 * agent, the main-key alias), which is exactly what the remap consults.
 */
export function resolveSessionOwnerAgentIdForKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  if (!raw) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    return resolveParsedSessionStoreKey(params.cfg, raw, parsed).agentId;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  // The literal keys name no agent. `global` in particular stays ambiguous on
  // purpose: it is shared by every agent, so only the caller's own selection can
  // say whose runs it means.
  if (rawLower === "global" || rawLower === "unknown") {
    return undefined;
  }
  // What is left is a bare main alias (`main`, or the configured main key),
  // which resolveSessionStoreKey maps to the default agent's main session.
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (rawLower !== "main" && rawLower !== mainKey) {
    return undefined;
  }
  return resolveDefaultStoreAgentId(params.cfg);
}

/** Resolve any incoming session key into the canonical key used in persisted session stores. */
export function resolveSessionStoreKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storeAgentId?: string;
}): string {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    const resolved = resolveParsedSessionStoreKey(params.cfg, raw, parsed, {
      storeAgentId: params.storeAgentId,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId: resolved.agentId,
      sessionKey: resolved.sessionKey,
    });
    if (canonical !== resolved.sessionKey) {
      return canonical;
    }
    return resolved.sessionKey;
  }

  const lowered = normalizeLowercaseStringOrEmpty(raw);
  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (lowered === "main" || lowered === rawMainKey) {
    return resolveMainSessionKey(params.cfg);
  }
  const agentId = resolveDefaultStoreAgentId(params.cfg);
  return canonicalizeSessionKeyForAgent(agentId, raw);
}

/** Resolve the agent that owns a canonical session-store key. */
export function resolveSessionStoreAgentId(cfg: OpenClawConfig, canonicalKey: string): string {
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return resolveDefaultStoreAgentId(cfg);
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveDefaultStoreAgentId(cfg);
}

/** Resolve a session key for lookup inside a specific agent's store. */
export function resolveStoredSessionKeyForAgentStore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  if (!raw) {
    return raw;
  }
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  const key = parseAgentSessionKey(raw) ? raw : canonicalizeSessionKeyForAgent(params.agentId, raw);
  return resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
    storeAgentId: params.agentId,
  });
}

/** Resolve the owner agent for a stored session key, returning null for global/unknown keys. */
export function resolveStoredSessionOwnerAgentId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string | null {
  const canonicalKey = resolveStoredSessionKeyForAgentStore(params);
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return null;
  }
  return resolveSessionStoreAgentId(params.cfg, canonicalKey);
}

/** Canonicalize spawned-by parent references while preserving main-session aliases. */
export function canonicalizeSpawnedByForAgent(
  cfg: OpenClawConfig,
  agentId: string,
  spawnedBy?: string,
): string | undefined {
  const raw = normalizeOptionalString(spawnedBy) ?? "";
  if (!raw) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (lower === "global" || lower === "unknown") {
    return lower;
  }
  let result: string;
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (normalized.startsWith("agent:")) {
    result = normalized;
  } else {
    result = `agent:${normalizeAgentId(agentId)}:${normalized}`;
  }
  // Resolve main-alias references (e.g. agent:ops:main -> configured main key).
  const parsed = parseAgentSessionKey(result);
  const resolvedAgent = parsed?.agentId ? normalizeAgentId(parsed.agentId) : agentId;
  return canonicalizeMainSessionAlias({ cfg, agentId: resolvedAgent, sessionKey: result });
}
