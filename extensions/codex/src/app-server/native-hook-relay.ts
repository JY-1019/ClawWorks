/**
 * Bridges Codex native hook callbacks into ClawWorks's native hook relay so
 * app-server tool events can still run ClawWorks policy and diagnostics.
 */
import { createHash } from "node:crypto";
import {
  registerNativeHookRelay,
  getPluginToolMeta,
  type AnyAgentTool,
  type EmbeddedRunAttemptParams,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { MAX_PLUGIN_APPROVAL_TIMEOUT_MS } from "openclaw/plugin-sdk/approval-runtime";
import {
  addTimerTimeoutGraceMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { CodexAppServerClient } from "./client.js";
import { stableStringifyJson, type CodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject, type CodexThreadItem, type JsonObject, type JsonValue } from "./protocol.js";

/** Codex hook events that can be registered through ClawWorks's native relay. */
export const CODEX_NATIVE_HOOK_RELAY_EVENTS: readonly NativeHookRelayEvent[] = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
/** Extra relay lifetime after the expected turn budget, preventing late hook drops. */
export const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS = 250;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS = 1_000;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS = 10_000;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS = 5_000;
const CODEX_NATIVE_HOOK_RELAY_APPROVAL_GATEWAY_GRACE_MS = 10_000;
const CODEX_NATIVE_HOOK_RELAY_APPROVAL_CHAIN_GRACE_MS = 15_000;
const CODEX_NATIVE_HOOK_RELAY_PRE_APPROVAL_STEPS = 4;
const CODEX_NATIVE_HOOK_RELAY_PRE_TIMEOUT_SEC = Math.ceil(
  (CODEX_NATIVE_HOOK_RELAY_PRE_APPROVAL_STEPS *
    (MAX_PLUGIN_APPROVAL_TIMEOUT_MS + CODEX_NATIVE_HOOK_RELAY_APPROVAL_GATEWAY_GRACE_MS) +
    CODEX_NATIVE_HOOK_RELAY_APPROVAL_CHAIN_GRACE_MS) /
    1_000,
);
const CODEX_NATIVE_HOOK_RELAY_PERMISSION_TIMEOUT_SEC = Math.ceil(
  (MAX_PLUGIN_APPROVAL_TIMEOUT_MS +
    CODEX_NATIVE_HOOK_RELAY_APPROVAL_GATEWAY_GRACE_MS +
    CODEX_NATIVE_HOOK_RELAY_APPROVAL_CHAIN_GRACE_MS) /
    1_000,
);
const MCP_TOOL_APPROVAL_QUESTION_ID_PREFIX = "mcp_tool_call_approval";
const MCP_TOOL_APPROVAL_ACCEPT_ANSWERS = new Set([
  "Allow",
  "Allow for this session",
  "Allow and don't ask me again",
]);

export type CodexNativeToolResultRecord = {
  toolCallId: string;
  released: boolean;
  toolInput?: JsonObject;
};

export type CodexNativeToolItemStatus = "completed" | "failed" | "running" | "blocked";

/** Deduplicates app-server tool results and defers successful PostToolUse fallbacks. */
export class CodexNativeToolResultTracker {
  private readonly recordedIds = new Set<string>();
  private readonly deferredItems = new Map<string, CodexThreadItem>();
  private readonly blockedMcpItemIds = new Set<string>();

  recordLegacyMcpApprovalResult(
    requestParams: JsonValue | undefined,
    response: JsonValue | undefined,
  ): void {
    const itemId = readLegacyMcpApprovalItemId(requestParams);
    if (!itemId) {
      return;
    }
    if (isAcceptedLegacyMcpApproval(requestParams, response)) {
      this.blockedMcpItemIds.delete(itemId);
    } else {
      this.blockedMcpItemIds.add(itemId);
    }
  }

  take(
    item: CodexThreadItem,
    options: {
      status?: CodexNativeToolItemStatus;
      nativePostToolUseRelayEnabled?: boolean;
      allowPostToolUseFallback?: boolean;
    } = {},
  ): CodexNativeToolResultRecord | undefined {
    if (this.recordedIds.has(item.id)) {
      return undefined;
    }
    const status = options.status ?? readCodexNativeToolItemStatus(item);
    if (
      options.nativePostToolUseRelayEnabled &&
      isCodexNativeHookRelayToolItem(item) &&
      status === "completed" &&
      !options.allowPostToolUseFallback
    ) {
      this.deferredItems.set(item.id, item);
      return undefined;
    }
    this.deferredItems.delete(item.id);
    this.recordedIds.add(item.id);
    const released = codexNativeToolItemWasReleased(
      item,
      status,
      this.blockedMcpItemIds.has(item.id),
    );
    this.blockedMcpItemIds.delete(item.id);
    return {
      toolCallId: item.id,
      released,
      ...(item.type === "mcpToolCall"
        ? isJsonObject(item.arguments)
          ? { toolInput: item.arguments }
          : item.arguments === null || item.arguments === undefined
            ? {}
            : { toolInput: { value: item.arguments } }
        : {}),
    };
  }

  flushDeferred(): CodexNativeToolResultRecord[] {
    const results: CodexNativeToolResultRecord[] = [];
    for (const item of this.deferredItems.values()) {
      const result = this.take(item, { allowPostToolUseFallback: true });
      if (result) {
        results.push(result);
      }
    }
    return results;
  }
}

function readLegacyMcpApprovalItemId(value: JsonValue | undefined): string | undefined {
  if (!isJsonObject(value) || typeof value.itemId !== "string" || !Array.isArray(value.questions)) {
    return undefined;
  }
  const questionId = `${MCP_TOOL_APPROVAL_QUESTION_ID_PREFIX}_${value.itemId}`;
  return value.questions.some((question) => isJsonObject(question) && question.id === questionId)
    ? value.itemId
    : undefined;
}

function isAcceptedLegacyMcpApproval(
  requestParams: JsonValue | undefined,
  response: JsonValue | undefined,
): boolean {
  const itemId = readLegacyMcpApprovalItemId(requestParams);
  if (!itemId || !isJsonObject(response) || !isJsonObject(response.answers)) {
    return false;
  }
  const answer = response.answers[`${MCP_TOOL_APPROVAL_QUESTION_ID_PREFIX}_${itemId}`];
  return (
    isJsonObject(answer) &&
    Array.isArray(answer.answers) &&
    answer.answers.some(
      (value) => typeof value === "string" && MCP_TOOL_APPROVAL_ACCEPT_ANSWERS.has(value),
    )
  );
}

export function readCodexNativeToolItemStatus(item: CodexThreadItem): CodexNativeToolItemStatus {
  const status = readItemString(item, "status");
  if (status === "failed") {
    return "failed";
  }
  if (status === "declined") {
    return "blocked";
  }
  if (status === "inProgress" || status === "running") {
    return "running";
  }
  return "completed";
}

export function isCodexNativeHookRelayToolItem(item: CodexThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
      return true;
    default:
      return false;
  }
}

function codexNativeToolItemWasReleased(
  item: CodexThreadItem,
  status: CodexNativeToolItemStatus,
  mcpApprovalBlocked: boolean,
): boolean {
  if (status === "blocked") {
    return false;
  }
  if (item.type === "mcpToolCall" && mcpApprovalBlocked) {
    return false;
  }
  if (item.type !== "commandExecution" || status !== "failed") {
    return true;
  }
  // App-server approval failures synthesize an all-null command completion;
  // any runtime field proves the command handler actually ran.
  return (
    item.processId != null ||
    item.aggregatedOutput != null ||
    item.exitCode != null ||
    item.durationMs != null
  );
}

function readItemString(item: CodexThreadItem, key: string): string | undefined {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

type CodexHookEventName = "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop";

type PendingCodexNativeHookRelayUnregister = {
  timeout: ReturnType<typeof setTimeout>;
  unregister: () => void;
};

const pendingCodexNativeHookRelayUnregisters = new Set<PendingCodexNativeHookRelayUnregister>();

/** Defers relay unregister so late native hook subprocesses can still resolve. */
export function scheduleCodexNativeHookRelayUnregister(params: {
  relay: NativeHookRelayRegistrationHandle;
  hookTimeoutSec?: number;
}): void {
  let pending: PendingCodexNativeHookRelayUnregister | undefined;
  const unregister = () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (!pendingCodexNativeHookRelayUnregisters.delete(current)) {
      return;
    }
    params.relay.unregister();
  };
  const timeout = setTimeout(
    unregister,
    resolveCodexNativeHookRelayUnregisterGraceMs(
      params.hookTimeoutSec,
      params.relay.allowedEvents.filter((event) => params.relay.shouldRelayEvent(event)),
    ),
  );
  pending = { timeout, unregister };
  pendingCodexNativeHookRelayUnregisters.add(pending);
  timeout.unref();
}

/** Computes the delayed unregister window from Codex's hook timeout. */
export function resolveCodexNativeHookRelayUnregisterGraceMs(
  hookTimeoutSec: number | undefined,
  events: readonly NativeHookRelayEvent[] = [],
): number {
  const hookTimeoutMs =
    typeof hookTimeoutSec === "number" && Number.isFinite(hookTimeoutSec) && hookTimeoutSec > 0
      ? (finiteSecondsToTimerSafeMilliseconds(Math.ceil(hookTimeoutSec)) ?? 0)
      : (finiteSecondsToTimerSafeMilliseconds(
          Math.max(5, ...events.map(defaultCodexNativeHookRelayTimeoutSec)),
        ) ?? 0);
  return Math.max(
    CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS,
    addTimerTimeoutGraceMs(hookTimeoutMs, CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS) ?? 0,
  );
}

/** Runs all pending unregister callbacks immediately for timer-sensitive tests. */
export function flushPendingCodexNativeHookRelayUnregistersForTests(): void {
  while (pendingCodexNativeHookRelayUnregisters.size > 0) {
    const pending = pendingCodexNativeHookRelayUnregisters.values().next().value;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pending.unregister();
  }
}

/** Clears pending unregister timers without invoking relay unregister callbacks. */
export function clearPendingCodexNativeHookRelayUnregistersForTests(): void {
  for (const pending of pendingCodexNativeHookRelayUnregisters) {
    clearTimeout(pending.timeout);
  }
  pendingCodexNativeHookRelayUnregisters.clear();
}

/** Registers a ClawWorks native hook relay for a Codex app-server turn. */
export function createCodexNativeHookRelay(params: {
  options:
    | {
        enabled?: boolean;
        ttlMs?: number;
        gatewayTimeoutMs?: number;
      }
    | undefined;
  generation?: string;
  generationMismatchGraceMs?: number;
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParams["config"];
  runId: string;
  channelId?: string;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
  hostTools?: readonly AnyAgentTool[];
  signal: AbortSignal;
}): NativeHookRelayRegistrationHandle | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  const mcpTools = new Map(
    (params.hostTools ?? []).flatMap((tool) => {
      const identity = getPluginToolMeta(tool)?.mcp;
      return identity ? [[tool.name, identity] as const] : [];
    }),
  );
  return registerNativeHookRelay({
    provider: "codex",
    relayId: buildCodexNativeHookRelayId({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    }),
    ...(params.generation ? { generation: params.generation } : {}),
    ...(params.generationMismatchGraceMs
      ? { generationMismatchGraceMs: params.generationMismatchGraceMs }
      : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    runId: params.runId,
    ...(params.channelId ? { channelId: params.channelId } : {}),
    allowedEvents: params.events,
    mcpTools,
    ttlMs: resolveCodexNativeHookRelayTtlMs({
      explicitTtlMs: params.options?.ttlMs,
      attemptTimeoutMs: params.attemptTimeoutMs,
      startupTimeoutMs: params.startupTimeoutMs,
      turnStartTimeoutMs: params.turnStartTimeoutMs,
    }),
    signal: params.signal,
    command: {
      // Hook relay subprocesses are observational for most tool events; keep
      // them lower priority so they do not compete with the active reply turn.
      nice: 10,
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  });
}

/** Selects the native hook events Codex should install for the current approval mode. */
export function resolveCodexNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy">;
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents.includes("pre_tool_use") &&
      !params.configuredEvents.includes("post_tool_use")
      ? [...params.configuredEvents, "post_tool_use"]
      : params.configuredEvents;
  }
  // Codex emits PermissionRequest before the app-server approval reviewer has
  // resolved the command. In native approval modes, let Codex's app-server
  // approval bridge own the real escalation instead of surfacing a stale
  // pre-guardian ClawWorks plugin approval prompt.
  return params.appServer.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

/** Derives the native hook relay TTL from the turn budget unless explicitly configured. */
export function resolveCodexNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.attemptTimeoutMs +
    params.startupTimeoutMs +
    params.turnStartTimeoutMs +
    CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}

/** Builds a stable relay id scoped to the agent and session identity. */
export function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v1");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}

const CODEX_HOOK_EVENT_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, CodexHookEventName> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  permission_request: "PermissionRequest",
  before_agent_finalize: "Stop",
};

const CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, string> = {
  pre_tool_use: "pre_tool_use",
  post_tool_use: "post_tool_use",
  permission_request: "permission_request",
  before_agent_finalize: "stop",
};

const CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS = [
  "/<session-flags>/config.toml",
  "<session-flags>/config.toml",
] as const;

/** Builds the Codex config overlay that installs trusted command hooks for relay events. */
export function buildCodexNativeHookRelayConfig(params: {
  relay: NativeHookRelayRegistrationHandle;
  events?: readonly NativeHookRelayEvent[];
  hookTimeoutSec?: number;
  clearOmittedEvents?: boolean;
}): JsonObject {
  const events = params.events?.length ? params.events : CODEX_NATIVE_HOOK_RELAY_EVENTS;
  const selectedEvents = new Set<NativeHookRelayEvent>(events);
  const config: JsonObject = {
    // The isolation preflight below only permits trusted/managed sibling hooks.
    // Pin this off so an ambient CLI flag cannot make untrusted hooks runnable.
    bypass_hook_trust: false,
    "features.hooks": true,
  };
  const hookState: JsonObject = {};
  for (const event of CODEX_NATIVE_HOOK_RELAY_EVENTS) {
    const codexEvent = CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event];
    const selected = selectedEvents.has(event);
    const shouldRelay = params.relay.shouldRelayEvent(event);
    // Keep no-policy PreToolUse commands installed with an explicit no-op marker;
    // otherwise a stale relay fallback cannot distinguish no policy from unknown policy.
    const selectedNoopPreToolUse = selected && event === "pre_tool_use" && !shouldRelay;
    if (!selected || (!shouldRelay && !selectedNoopPreToolUse)) {
      if (selected || params.clearOmittedEvents) {
        config[`hooks.${codexEvent}`] = [] satisfies JsonValue;
      }
      if (params.clearOmittedEvents) {
        for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
          hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = {
            enabled: false,
          } satisfies JsonValue;
        }
      }
      continue;
    }
    const timeout = normalizeHookTimeoutSec(params.hookTimeoutSec, event);
    const command = params.relay.commandForEvent(event, {
      timeoutMs: resolveCodexNativeHookRelayCommandTimeoutMs(timeout),
    });
    config[`hooks.${codexEvent}`] = [
      {
        hooks: [
          {
            type: "command",
            command,
            timeout,
            async: false,
            statusMessage: "ClawWorks native hook relay",
          },
        ],
      },
    ] satisfies JsonValue;
    const state = {
      enabled: true,
      trusted_hash: codexCommandHookTrustedHash({
        event,
        command,
        timeout,
        statusMessage: "ClawWorks native hook relay",
      }),
    };
    for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
      hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] =
        state satisfies JsonValue;
    }
  }
  config["hooks.state"] = hookState;
  return config;
}

const CODEX_HOOK_EVENT_NAMES = new Set([
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "preCompact",
  "postCompact",
  "sessionStart",
  "sessionEnd",
  "userPromptSubmit",
  "subagentStart",
  "subagentStop",
  "stop",
]);
const CODEX_HOOK_HANDLER_TYPES = new Set(["command", "prompt", "agent"]);
const CODEX_HOOK_TRUST_STATUSES = new Set(["managed", "untrusted", "trusted", "modified"]);

/** Lists enabled sibling PreToolUse hooks that could become runnable during the turn. */
export function findCodexNativePreToolUseHookConflicts(params: {
  response: unknown;
  cwd: string;
}): string[] {
  const response = params.response;
  if (!isJsonObject(response) || !Array.isArray(response.data)) {
    throw new Error("Codex returned an invalid hooks/list response");
  }
  if (response.data.length !== 1) {
    throw new Error("Codex hooks/list did not return the requested workspace");
  }
  const conflicts = new Set<string>();
  const entry = response.data[0];
  if (
    !isJsonObject(entry) ||
    entry.cwd !== params.cwd ||
    !Array.isArray(entry.hooks) ||
    !Array.isArray(entry.warnings) ||
    !Array.isArray(entry.errors)
  ) {
    throw new Error("Codex returned an invalid hooks/list entry");
  }
  if (entry.errors.length > 0) {
    throw new Error("Codex could not inspect hooks for managed approval isolation");
  }
  for (const hook of entry.hooks) {
    if (
      !isJsonObject(hook) ||
      typeof hook.key !== "string" ||
      !hook.key.trim() ||
      typeof hook.eventName !== "string" ||
      !CODEX_HOOK_EVENT_NAMES.has(hook.eventName) ||
      typeof hook.handlerType !== "string" ||
      !CODEX_HOOK_HANDLER_TYPES.has(hook.handlerType) ||
      typeof hook.enabled !== "boolean" ||
      typeof hook.isManaged !== "boolean" ||
      typeof hook.trustStatus !== "string" ||
      !CODEX_HOOK_TRUST_STATUSES.has(hook.trustStatus)
    ) {
      throw new Error("Codex returned invalid hook metadata");
    }
    if (hook.eventName === "preToolUse" && hook.handlerType === "command" && hook.enabled) {
      conflicts.add(hook.key);
    }
  }
  return [...conflicts].toSorted();
}

/**
 * Fails before a native turn when another runnable hook could replace approved input.
 * Codex can hot-reload hook trust between turns, so callers run this at the turn boundary.
 */
export async function assertCodexNativePreToolUseIsolation(params: {
  client: CodexAppServerClient;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const requestOptions = { timeoutMs: params.timeoutMs, signal: params.signal };
  const configResponse = await params.client.request(
    "config/read",
    { cwd: params.cwd, includeLayers: false },
    requestOptions,
  );
  const config = isJsonObject(configResponse) ? configResponse.config : undefined;
  if (!isJsonObject(config)) {
    throw new Error("Codex could not verify hook configuration for managed approvals");
  }
  const features = config.features;
  if (features !== undefined && !isJsonObject(features)) {
    throw new Error("Codex returned invalid hook feature configuration");
  }
  const canonicalHooksFeature = isJsonObject(features) ? features.hooks : undefined;
  const legacyHooksFeature = isJsonObject(features) ? features.codex_hooks : undefined;
  if (
    (canonicalHooksFeature !== undefined && typeof canonicalHooksFeature !== "boolean") ||
    (legacyHooksFeature !== undefined && typeof legacyHooksFeature !== "boolean")
  ) {
    throw new Error("Codex returned invalid hook feature configuration");
  }
  const hooksFeature = canonicalHooksFeature ?? legacyHooksFeature;
  if (hooksFeature === false) {
    throw new Error(
      "Codex managed approvals cannot safely override a globally disabled hooks feature",
    );
  }

  const hookInventory = await params.client.request(
    "hooks/list",
    { cwds: [params.cwd] },
    requestOptions,
  );
  const conflicts = findCodexNativePreToolUseHookConflicts({
    response: hookInventory,
    cwd: params.cwd,
  });
  if (conflicts.length > 0) {
    throw new Error(
      `Codex managed approvals require an isolated PreToolUse hook; disable the conflicting Codex hook and retry: ${conflicts.slice(0, 3).join(", ")}`,
    );
  }
}

/** Builds a Codex config overlay that disables native hooks and clears hook arrays. */
export function buildCodexNativeHookRelayDisabledConfig(): JsonObject {
  return {
    "features.hooks": false,
    "hooks.PreToolUse": [],
    "hooks.PostToolUse": [],
    "hooks.PermissionRequest": [],
    "hooks.Stop": [],
  };
}

function normalizeHookTimeoutSec(value: number | undefined, event?: NativeHookRelayEvent): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : event
      ? defaultCodexNativeHookRelayTimeoutSec(event)
      : 5;
}

function defaultCodexNativeHookRelayTimeoutSec(event: NativeHookRelayEvent): number {
  if (event === "pre_tool_use") {
    // The chain can prompt for trusted policy, plugin hook, Skill Workshop, and
    // enterprise approval in sequence. The child deadline fails closed first.
    return CODEX_NATIVE_HOOK_RELAY_PRE_TIMEOUT_SEC;
  }
  return event === "permission_request" ? CODEX_NATIVE_HOOK_RELAY_PERMISSION_TIMEOUT_SEC : 5;
}

export function resolveCodexNativeHookRelayCommandTimeoutMs(
  hookTimeoutSec: number | undefined,
): number {
  const parentTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 5_000;
  const parentMarginMs = Math.min(
    CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS,
    Math.max(CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS, Math.floor(parentTimeoutMs / 5)),
  );
  return Math.max(1, parentTimeoutMs - parentMarginMs);
}

function codexCommandHookTrustedHash(params: {
  event: NativeHookRelayEvent;
  command: string;
  timeout: number;
  statusMessage: string;
}): string {
  // Keep the match-all matcher omitted rather than null. Codex app-server
  // converts JSON null to an empty TOML string before hashing, which changes the
  // trust identity even though both forms match all tools.
  const identity = {
    event_name: CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[params.event],
    hooks: [
      {
        async: false,
        command: params.command,
        statusMessage: params.statusMessage,
        timeout: params.timeout,
        type: "command",
      },
    ],
  };
  const hash = createHash("sha256").update(stableStringifyJson(identity)).digest("hex");
  return `sha256:${hash}`;
}
