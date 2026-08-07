// Gateway MCP loopback JSON-RPC handlers.
// Implements initialize, tools/list, tools/call, and notification handling.
import crypto from "node:crypto";
import { runBeforeToolCallHook, type HookContext } from "../agents/agent-tools.before-tool-call.js";
import { enterpriseRunTracksSteps } from "../enterprise/runtime.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  MCP_LOOPBACK_SERVER_NAME,
  MCP_LOOPBACK_SERVER_VERSION,
  MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_LOOPBACK_TOOL_CALL_ID_PREFIX,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcRequest,
} from "./mcp-http.protocol.js";
import {
  readMcpLoopbackToolName,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";

type McpTextContent = {
  type: "text";
  text: string;
};

// Tool implementations may return MCP content blocks, plain strings, or
// arbitrary JSON. Normalize them into text blocks for consistent loopback output.
function normalizeToolCallContent(result: unknown): McpTextContent[] {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map((block: { type?: string; text?: string }) => ({
      type: (block.type ?? "text") as "text",
      text: block.text ?? (typeof block === "string" ? block : JSON.stringify(block)),
    }));
  }
  return [
    {
      type: "text",
      text: typeof result === "string" ? result : JSON.stringify(result),
    },
  ];
}

/**
 * In-flight loopback call chain per governed run. Keyed by runId, and dropped as
 * soon as a run's last call settles so finished runs cannot accumulate.
 */
const loopbackRunChains = new Map<string, Promise<void>>();

/** Run `execute` after every earlier call for this run has settled. */
async function serializeLoopbackRunCall<T>(runId: string, execute: () => Promise<T>): Promise<T> {
  const previous = loopbackRunChains.get(runId) ?? Promise.resolve();
  // Both arms run `execute`: a previous call that FAILED still finished, and
  // must not cancel the calls queued behind it.
  const settled = previous.then(execute, execute);
  const tail = settled.then(
    () => {},
    () => {},
  );
  loopbackRunChains.set(runId, tail);
  void tail.then(() => {
    // Only the last queued call clears the entry; an earlier one finishing would
    // otherwise release the chain while its successors are still waiting on it.
    if (loopbackRunChains.get(runId) === tail) {
      loopbackRunChains.delete(runId);
    }
  });
  return await settled;
}

/** Handles one MCP loopback JSON-RPC message and returns a response or notification null. */
export async function handleMcpJsonRpc(params: {
  message: JsonRpcRequest;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  hookContext?: HookContext;
  signal?: AbortSignal;
  onToolCallResult?: (call: {
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
    isError: boolean;
  }) => void;
  onToolCallPrepared?: (call: { toolName: string; args: Record<string, unknown> }) => void;
}): Promise<object | null> {
  const { id, method, params: methodParams } = params.message;

  switch (method) {
    case "initialize": {
      const clientVersion = (methodParams?.protocolVersion as string) ?? "";
      // Prefer the client-requested protocol when supported, otherwise fall
      // back to the newest/first supported version advertised by this server.
      const negotiated =
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === clientVersion) ??
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: {
          name: MCP_LOOPBACK_SERVER_NAME,
          version: MCP_LOOPBACK_SERVER_VERSION,
        },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "tools/list":
      return jsonRpcResult(id, { tools: params.toolSchema });
    case "tools/call": {
      const toolName = typeof methodParams?.name === "string" ? methodParams.name.trim() : "";
      const toolArgs = (methodParams?.arguments ?? {}) as Record<string, unknown>;
      if (!toolName) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: "Tool not available: unknown" }],
          isError: true,
        });
      }
      if (!params.toolSchema.some((tool) => tool.name === toolName)) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const tool = params.tools.find(
        (candidate) => readMcpLoopbackToolName(candidate) === toolName,
      );
      if (!tool) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const toolCallId = `${MCP_LOOPBACK_TOOL_CALL_ID_PREFIX}${crypto.randomUUID()}`;
      let executedToolArgs = toolArgs;
      // A governed run's loopback calls execute in arrival order.
      //
      // complete_step moves the run's active step, while the ontology and
      // knowledge tools resolve their scope when they EXECUTE. MCP carries no
      // execution-order hint — buildMcpToolSchema projects name, description and
      // input schema, and there is no field for more — and a CLI client issues
      // `tools/call` concurrently. So a sibling emitted for the previous step
      // could resolve its scope after the cursor moved and run under the NEXT
      // step's ontology, which is exactly the boundary this layer exists to hold.
      // Only step-tracking runs pay for it, and the loopback is a callback
      // surface rather than a throughput path.
      const serializeRunId =
        params.hookContext?.runId && enterpriseRunTracksSteps(params.hookContext.runId)
          ? params.hookContext.runId
          : undefined;
      const reportToolCallResult = (result: unknown, isError: boolean) => {
        try {
          params.onToolCallResult?.({
            toolName,
            args: executedToolArgs,
            result,
            isError,
          });
        } catch {
          // Observability callbacks must never alter the tool result returned to the MCP client.
        }
      };
      const runToolCall = async (): Promise<object> => {
        try {
          // Gateway before-tool hooks still run for loopback MCP calls so policy
          // and audit behavior matches native tool calls from normal chat runs.
          const hookResult = await runBeforeToolCallHook({
            toolName,
            params: toolArgs,
            toolCallId,
            ctx: params.hookContext,
            signal: params.signal,
          });
          if (hookResult.blocked) {
            return jsonRpcResult(id, {
              content: [{ type: "text", text: hookResult.reason }],
              isError: true,
            });
          }
          executedToolArgs = hookResult.params as Record<string, unknown>;
          try {
            params.onToolCallPrepared?.({ toolName, args: executedToolArgs });
          } catch {
            // Observability callbacks must never alter the tool result returned to the MCP client.
          }
          const result = await tool.execute(toolCallId, hookResult.params, params.signal);
          reportToolCallResult(result, false);
          return jsonRpcResult(id, {
            content: normalizeToolCallContent(result),
            isError: false,
          });
        } catch (error) {
          reportToolCallResult(error, true);
          const message = formatErrorMessage(error);
          return jsonRpcResult(id, {
            content: [{ type: "text", text: message || "tool execution failed" }],
            isError: true,
          });
        }
      };
      // Authorization and execution are serialized TOGETHER: gating one call
      // while another is mid-execution is what keeps "the active step decided
      // this call" true.
      //
      // The abort check belongs INSIDE the queued callback, not before queuing: a
      // request can disconnect while it waits its turn, and complete_step never
      // inspects the signal — so without this a cancelled call would still advance
      // the workflow and append completion events once the queue reached it.
      return serializeRunId
        ? await serializeLoopbackRunCall(serializeRunId, async () => {
            if (params.signal?.aborted) {
              return jsonRpcResult(id, {
                content: [{ type: "text", text: "tool call cancelled" }],
                isError: true,
              });
            }
            return await runToolCall();
          })
        : await runToolCall();
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}
