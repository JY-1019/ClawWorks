import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { createKnowledgeSearchTool } from "../agents/tools/knowledge-search-tool.js";
import {
  createComputeFunctionTool,
  createGetNeighborsTool,
  createInvokeActionTool,
  createSearchObjectsTool,
} from "../agents/tools/ontology-tools.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import { importWorkflowBundle } from "./bundle-io.js";
import { resetPersistedBundleFoundationsForTest } from "./knowledge-bundle-loader.js";
import {
  beginEnterpriseRun,
  clearEnterpriseRunMediationForTest,
  endEnterpriseRun,
} from "./run-mediation.js";
import { completeEnterpriseStep, evaluateEnterpriseToolCall } from "./runtime.js";
import { getEnterpriseRunRecord, listEnterpriseRunEvents } from "./trace-store.sqlite.js";
import { invalidateWorkflowTreeRegistry } from "./tree-registry.js";

it("executes MCP, knowledge and ontology tools within one deeply routed node", async () => {
  const state = await createOpenClawTestState({ label: "combined-return", layout: "state-only" });
  const client = new Client({ name: "combined-return-proof", version: "1.0.0" });
  const port = await getDeterministicFreePortBlock({ offsets: [0] });
  const server = spawn(process.execPath, ["examples/enterprise/tutorial/mcp/server.mjs"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP startup timeout")), 10_000);
      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`MCP exited ${code}`));
      });
      server.stdout.once("data", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    invalidateWorkflowTreeRegistry();
    const imported = importWorkflowBundle({
      content: readFileSync(
        "examples/enterprise/golden/combined-return.clawworks-bundle.yaml",
        "utf8",
      ),
      format: "yaml",
    });
    expect(imported).toMatchObject({ ok: true, requiredMcpServers: ["acme-tracker"] });
    const assessment = "operations.orders.returns.cases.assess";
    const steps = [
      "operations",
      "operations.orders",
      "operations.orders.returns",
      "operations.orders.returns.cases",
      assessment,
    ];
    for (const { orderId, eligible } of [
      { orderId: "1043", eligible: true },
      { orderId: "1051", eligible: false },
    ]) {
      const runId = `combined-${orderId}`;
      const run = await beginEnterpriseRun({
        runId,
        prompt: `Assess return ${orderId}`,
        // Isolate execution from model quality; routing-cases covers live routing.
        routePlanner: async () => ({
          kind: "decided",
          treeId: "demo.combined-return",
          routes: [assessment],
        }),
      });
      if (run.kind !== "mediated") {
        throw new Error(`Expected mediation, got ${run.kind}`);
      }
      expect(run.plan.nodes.map((node) => node.nodeId)).toEqual(steps);
      expect(run.plan.activeNodeId).toBe(steps[0]);
      for (const [index, nodeId] of steps.slice(0, -1).entries()) {
        expect(
          completeEnterpriseStep({
            runId,
            expectedNodeId: nodeId,
            summary: `Confirmed return assessment for order ${orderId}; no refund or message requested.`,
          }),
        ).toMatchObject({
          kind: "advanced",
          completed: { nodeId },
          next: { nodeId: steps[index + 1] },
        });
      }
      expect(run.plan.activeNodeId).toBe(assessment);
      const gate = (params: Omit<Parameters<typeof evaluateEnterpriseToolCall>[0], "runId">) => {
        expect(evaluateEnterpriseToolCall({ ...params, runId })).toMatchObject({ blocked: false });
        expect(run.plan.activeNodeId).toBe(assessment);
      };
      gate({
        toolName: "acme-tracker__order_status",
        toolParams: { orderId },
        mcpTool: {
          serverName: "acme-tracker",
          safeServerName: "acme_tracker",
          toolName: "order_status",
        },
      });
      const remote = CallToolResultSchema.parse(
        await client.callTool({ name: "order_status", arguments: { orderId } }),
      );
      expect(remote.isError).not.toBe(true);
      const text = remote.content.find((item) => item.type === "text");
      if (!text || text.type !== "text") {
        throw new Error("MCP returned no order");
      }
      const order = z
        .object({
          orderId: z.string(),
          status: z.literal("delivered"),
          daysSinceDelivery: z.number(),
          total: z.number(),
        })
        .parse(JSON.parse(text.text));
      const search = { query: "return eligibility", foundations: ["demo.return-policy"] };
      gate({ toolName: "knowledge_search", toolParams: search });
      const knowledge = (await createKnowledgeSearchTool({ runId }).execute("policy", search))
        .details;
      const policySource = "returns/eligibility.md";
      expect(knowledge).toMatchObject({
        snippets: [expect.objectContaining({ source: policySource })],
      });
      const caseId = `CASE-${orderId}`;
      const noteId = `EVIDENCE-${orderId}`;
      for (const [entity, match] of [
        ["return-case", caseId],
        ["return-evidence", noteId],
      ]) {
        gate({ toolName: "search_objects", toolParams: { entity, match } });
        expect(
          (await createSearchObjectsTool({ runId }).execute("check", { entity, match })).details,
        ).toMatchObject({ count: 0 });
      }
      const action = {
        action: "record-return-assessment",
        args: {
          "case-id": caseId,
          "order-id": order.orderId,
          "days-since-delivery": order.daysSinceDelivery,
          total: order.total,
          "evidence-id": noteId,
          "policy-source": policySource,
          summary: `MCP returned delivered order ${orderId}; ${order.daysSinceDelivery} days; USD ${order.total}.`,
        },
      };
      gate({ toolName: "invoke_action", toolParams: action });
      expect(
        (await createInvokeActionTool({ runId }).execute("record", action)).details,
      ).toMatchObject({
        writes: [
          { entity: "return-case", objectId: caseId, kind: "create" },
          { entity: "return-evidence", objectId: noteId, kind: "create" },
          { relationship: "return-has-evidence", from: caseId, to: noteId, kind: "link" },
        ],
      });
      const compute = { function: "return-eligible", objectId: caseId };
      gate({ toolName: "compute_function", toolParams: compute });
      expect(
        (await createComputeFunctionTool({ runId }).execute("eligibility", compute)).details,
      ).toMatchObject({ value: eligible });
      const neighbor = {
        entity: "return-case",
        objectId: caseId,
        relationship: "return-has-evidence",
      };
      gate({ toolName: "get_neighbors", toolParams: neighbor });
      expect(
        (await createGetNeighborsTool({ runId }).execute("verify", neighbor)).details,
      ).toMatchObject({
        count: 1,
        neighbors: [{ objectId: noteId, properties: { "policy-source": policySource } }],
      });
      expect(evaluateEnterpriseToolCall({ runId, toolName: "exec" })).toMatchObject({
        blocked: true,
      });
      expect(
        completeEnterpriseStep({
          runId,
          expectedNodeId: assessment,
          summary: `Recorded case ${caseId} and verified linked evidence ${noteId}.`,
        }),
      ).toMatchObject({ kind: "route-complete" });
      endEnterpriseRun({ runId, status: "completed" });
      const record = getEnterpriseRunRecord(runId);
      if (!record) {
        throw new Error("Missing persisted run");
      }
      const events = listEnterpriseRunEvents(record.executionId);
      expect(
        events.filter((event) => event.kind === "node.entered").map((event) => event.nodeId),
      ).toEqual(steps);
      expect(
        events.filter((event) => event.kind === "node.completed").map((event) => event.nodeId),
      ).toEqual(steps);
      const auditedTools = events.filter((event) => event.kind === "governance.decision");
      expect(auditedTools.map((event) => event.payload.toolName)).toEqual(
        expect.arrayContaining([
          "acme-tracker__order_status",
          "knowledge_search",
          "search_objects",
          "invoke_action",
          "compute_function",
          "get_neighbors",
        ]),
      );
      expect([
        ...new Set(
          events
            .filter((event) => event.kind === "governance.decision")
            .map((event) => event.nodeId),
        ),
      ]).toEqual([assessment]);
    }
  } finally {
    await client.close().catch(() => {});
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
    clearEnterpriseRunMediationForTest();
    invalidateWorkflowTreeRegistry();
    resetPersistedBundleFoundationsForTest();
    closeOpenClawStateDatabase();
    await state.cleanup();
  }
}, 20_000);
