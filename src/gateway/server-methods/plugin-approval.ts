// Gateway RPC handlers for plugin approval requests and decisions.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  resolvePluginApprovalRequestAllowedDecisions,
  resolvePluginApprovalTimeoutMs,
} from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  bindApprovalRequesterMetadata,
  buildRequestedApprovalEvent,
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  isApprovalRecordRequestedByClientDevice,
  listVisiblePendingApprovalRequests,
  registerPendingApprovalRecord,
  resolveApprovalDecisionParams,
  respondPendingApprovalLookupError,
} from "./approval-shared.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

/** Create plugin approval handlers backed by the shared approval manager. */
export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: { forwarder?: ExecApprovalForwarder },
): GatewayRequestHandlers {
  // A resolution can race async channel routing. Keep the delivery gate by id so
  // channel forwarding never emits "resolved" before its pending route exists.
  const requestDeliverySettledById = new Map<string, Promise<void>>();
  const resolveApproval = async (params: {
    inputId: string;
    decision: ExecApprovalDecision;
    respond: GatewayRequestHandlerOptions["respond"];
    context: GatewayRequestHandlerOptions["context"];
    client: GatewayRequestHandlerOptions["client"];
    enforceAllowedDecisions?: boolean;
    resolvedByOverride?: string | null;
  }) => {
    await handleApprovalResolve({
      manager,
      inputId: params.inputId,
      decision: params.decision,
      respond: params.respond,
      context: params.context,
      client: params.client,
      resolvedByOverride: params.resolvedByOverride,
      exposeAmbiguousPrefixError: false,
      validateDecision:
        params.enforceAllowedDecisions === false
          ? undefined
          : (snapshot) =>
              resolvePluginApprovalRequestAllowedDecisions(snapshot.request).includes(
                params.decision,
              )
                ? null
                : {
                    message: `${params.decision} is unavailable for this plugin approval`,
                    details: {
                      allowedDecisions: resolvePluginApprovalRequestAllowedDecisions(
                        snapshot.request,
                      ),
                    },
                  },
      resolvedEventName: "plugin.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, resolvedBy, snapshot, nowMs }) => ({
        id: approvalId,
        decision,
        resolvedBy,
        ts: nowMs,
        request: snapshot.request,
      }),
      forwardResolved: opts?.forwarder?.handlePluginApprovalResolved
        ? async (resolvedEvent) => {
            await requestDeliverySettledById.get(resolvedEvent.id);
            await opts.forwarder?.handlePluginApprovalResolved?.(resolvedEvent);
          }
        : undefined,
      forwardResolvedErrorLabel: "plugin approvals: forward resolve failed",
    });
  };

  return {
    "plugin.approval.list": async ({ respond, client }) => {
      respond(true, listVisiblePendingApprovalRequests({ manager, client }), undefined);
    },
    "plugin.approval.request": async ({ params, client, respond, context, signal }) => {
      if (!validatePluginApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.request params: ${formatValidationErrors(
              validatePluginApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        pluginId?: string | null;
        title: string;
        description: string;
        severity?: string | null;
        toolName?: string | null;
        toolCallId?: string | null;
        allowedDecisions?: string[] | null;
        agentId?: string | null;
        sessionKey?: string | null;
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs = resolvePluginApprovalTimeoutMs(p.timeoutMs);

      if (signal?.aborted) {
        return;
      }

      const normalizeTrimmedString = (value?: string | null): string | null =>
        normalizeOptionalString(value) || null;

      const request: PluginApprovalRequestPayload = {
        pluginId: p.pluginId ?? null,
        title: p.title,
        description: p.description,
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: p.toolName ?? null,
        toolCallId: p.toolCallId ?? null,
        ...(Array.isArray(p.allowedDecisions)
          ? {
              allowedDecisions: resolvePluginApprovalRequestAllowedDecisions({
                allowedDecisions: p.allowedDecisions,
              }),
            }
          : {}),
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
        turnSourceChannel: normalizeTrimmedString(p.turnSourceChannel),
        turnSourceTo: normalizeTrimmedString(p.turnSourceTo),
        turnSourceAccountId: normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };

      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      bindApprovalRequesterMetadata({ record, client });

      const decisionPromise = registerPendingApprovalRecord({
        manager,
        record,
        timeoutMs,
        respond,
      });
      if (!decisionPromise) {
        return;
      }

      const requestEvent = buildRequestedApprovalEvent(record);
      let markRequestDeliverySettled = () => {};
      const requestDeliverySettled = new Promise<void>((resolve) => {
        markRequestDeliverySettled = resolve;
      });
      requestDeliverySettledById.set(record.id, requestDeliverySettled);

      try {
        await handlePendingApprovalRequest({
          manager,
          record,
          decisionPromise,
          respond,
          context,
          clientConnId: client?.connId,
          requestEventName: "plugin.approval.requested",
          requestEvent,
          twoPhase,
          approvalKind: "plugin",
          // A normal UI disconnect is not a decision. Only the server-issued
          // approval runtime token may translate its cancelled turn into deny.
          signal: client?.internal?.approvalRuntime === true ? signal : undefined,
          onRequestAborted: () =>
            resolveApproval({
              inputId: record.id,
              decision: "deny",
              respond: () => {},
              context,
              client,
              enforceAllowedDecisions: false,
              resolvedByOverride: "request-aborted",
            }),
          markRequestDeliverySettled,
          deliverRequest: () => {
            if (!opts?.forwarder?.handlePluginApprovalRequested) {
              return false;
            }
            return opts.forwarder
              .handlePluginApprovalRequested(requestEvent)
              .catch((err: unknown) => {
                context.logGateway?.error?.(
                  `plugin approvals: forward request failed: ${String(err)}`,
                );
                return false;
              });
          },
        });
      } finally {
        markRequestDeliverySettled();
        requestDeliverySettledById.delete(record.id);
      }
    },

    "plugin.approval.waitDecision": async ({ params, respond, client, context, signal }) => {
      const inputId = (params as { id?: string }).id;
      // The trusted runtime owns the tool turn; its cancelled wait must close the
      // matching approval without granting plugins a general resolve capability.
      const trustedSignal = client?.internal?.approvalRuntime === true ? signal : undefined;
      await handleApprovalWaitDecision({
        manager,
        inputId,
        client,
        respond,
        signal: trustedSignal,
        onWaitAborted: trustedSignal
          ? () =>
              resolveApproval({
                inputId: inputId ?? "",
                decision: "deny",
                respond: () => {},
                context,
                client,
                enforceAllowedDecisions: false,
                resolvedByOverride: "request-aborted",
              })
          : undefined,
      });
    },

    "plugin.approval.resolve": async ({ params, respond, client, context }) => {
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validatePluginApprovalResolveParams,
        methodName: "plugin.approval.resolve",
        respond,
      });
      if (!resolveParams) {
        return;
      }
      const { inputId, decision } = resolveParams;
      if (client?.internal?.approvalRuntime === true) {
        if (decision !== "deny") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "approval runtime may only cancel plugin approvals with deny",
            ),
          );
          return;
        }
        // The runtime token marks an aborted tool turn, but the persisted device
        // proves this exact approval belongs to that runtime rather than another run.
        const snapshot = manager.getSnapshot(inputId);
        if (
          !snapshot ||
          !isApprovalRecordRequestedByClientDevice({
            record: snapshot,
            client,
          })
        ) {
          respondPendingApprovalLookupError({ respond, response: "missing" });
          return;
        }
        await resolveApproval({
          inputId,
          decision,
          respond,
          context,
          client,
          enforceAllowedDecisions: false,
          resolvedByOverride: "request-aborted",
        });
        return;
      }
      await resolveApproval({
        inputId,
        decision,
        respond,
        context,
        client,
      });
    },
  };
}
