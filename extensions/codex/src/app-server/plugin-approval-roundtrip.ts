/**
 * Routes Codex app-server plugin approval prompts through ClawWorks's gateway
 * approval tool and maps gateway decisions back to Codex outcomes.
 */
import {
  callGatewayTool,
  cancelPluginApprovalForRunAbort,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveCodexGatewayTimeoutWithGraceMs } from "./attempt-timeouts.js";

const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PLUGIN_APPROVAL_TITLE_LENGTH = 80;
export const CODEX_PLUGIN_APPROVAL_DESCRIPTION_MAX_CHARS = 256;

export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

/** Normalized Codex app-server approval outcome after a gateway decision. */
export type AppServerApprovalOutcome =
  | "approved-once"
  | "approved-session"
  | "denied"
  | "unavailable"
  | "cancelled";

type ApprovalRequestResult = {
  id?: string;
  decision?: ExecApprovalDecision | null;
};

type ApprovalWaitResult = {
  id?: string;
  decision?: ExecApprovalDecision | null;
};

/** Starts a two-phase plugin approval request through the ClawWorks gateway. */
export async function requestPluginApproval(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  toolName: string;
  toolCallId?: string;
  allowedDecisions?: ExecApprovalDecision[];
  signal?: AbortSignal;
}): Promise<ApprovalRequestResult | undefined> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  params.signal?.throwIfAborted();
  return callGatewayTool(
    "plugin.approval.request",
    {
      timeoutMs: resolveCodexGatewayTimeoutWithGraceMs(timeoutMs),
      ...(params.signal ? { signal: params.signal } : {}),
    },
    {
      pluginId: "openclaw-codex-app-server",
      title: truncateForGateway(params.title, MAX_PLUGIN_APPROVAL_TITLE_LENGTH),
      description: truncateForGateway(
        params.description,
        CODEX_PLUGIN_APPROVAL_DESCRIPTION_MAX_CHARS,
      ),
      severity: params.severity,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      agentId: params.paramsForRun.agentId,
      sessionKey: params.paramsForRun.sessionKey,
      turnSourceChannel: params.paramsForRun.messageChannel ?? params.paramsForRun.messageProvider,
      turnSourceTo: params.paramsForRun.currentChannelId,
      turnSourceAccountId: params.paramsForRun.agentAccountId,
      turnSourceThreadId: params.paramsForRun.currentThreadTs,
      timeoutMs,
      twoPhase: true,
      ...(params.allowedDecisions ? { allowedDecisions: params.allowedDecisions } : {}),
    },
    { expectFinal: false },
  ) as Promise<ApprovalRequestResult | undefined>;
}

/** Detects the gateway's explicit null-decision marker for unavailable approvals. */
export function approvalRequestExplicitlyUnavailable(result: unknown): boolean {
  if (result === null || result === undefined || typeof result !== "object") {
    return false;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(result, "decision");
  } catch {
    return false;
  }
  return descriptor !== undefined && "value" in descriptor && descriptor.value === null;
}

/** Waits for the gateway's final approval decision, respecting turn aborts. */
export async function waitForPluginApprovalDecision(params: {
  approvalId: string;
  signal?: AbortSignal;
}): Promise<ExecApprovalDecision | null | undefined> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  try {
    const waitResult = await callGatewayTool<ApprovalWaitResult | undefined>(
      "plugin.approval.waitDecision",
      {
        timeoutMs: resolveCodexGatewayTimeoutWithGraceMs(timeoutMs),
        ...(params.signal ? { signal: params.signal } : {}),
      },
      { id: params.approvalId },
    );
    return waitResult?.decision;
  } catch (error) {
    if (params.signal?.aborted) {
      // The request and wait use separate sockets, so abort may land after the
      // request was accepted but before the wait handler can cancel it server-side.
      await cancelPluginApprovalForRunAbort(params.approvalId);
    }
    throw error;
  }
}

/** Converts a gateway exec approval decision into the app-server approval outcome enum. */
export function mapExecDecisionToOutcome(
  decision: ExecApprovalDecision | null | undefined,
): AppServerApprovalOutcome {
  if (decision === "allow-once") {
    return "approved-once";
  }
  if (decision === "allow-always") {
    return "approved-session";
  }
  if (decision === null || decision === undefined) {
    return "unavailable";
  }
  return "denied";
}

function truncateForGateway(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${truncateUtf16Safe(value, Math.max(0, maxLength - 3))}...`;
}
