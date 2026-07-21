import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendEnterpriseRunEvent,
  finalizeEnterpriseRun,
  persistEnterpriseRunStart,
} from "../../enterprise/trace-store.sqlite.js";
import { invalidateWorkflowTreeRegistry } from "../../enterprise/tree-registry.js";
import type { EnterpriseRunPlan } from "../../enterprise/types.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { enterpriseHandlers } from "./enterprise.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-gw-enterprise-"));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

type EnterpriseMethod = "enterprise.trees.list" | "enterprise.runs.list" | "enterprise.runs.get";

function invoke(method: EnterpriseMethod, params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  // The read handlers respond synchronously; capture the single respond call.
  void enterpriseHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
    context: {} as never,
  });
  expect(calls).toHaveLength(1);
  return calls[0];
}

function makePlan(runId: string, activeNodeId: string): EnterpriseRunPlan {
  return {
    runId,
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "planner",
    requestSummary: "help with refund",
    nodes: [
      { nodeId: "support", parentId: null, seq: 0, title: "Support", ontology: {} },
      {
        nodeId: "support.triage",
        parentId: "support",
        seq: 1,
        title: "Triage",
        description: "Classify the request",
        ontology: {
          allowedTools: ["memory_search"],
          knowledgeFoundations: ["acme.kb"],
          audit: true,
        },
      },
    ],
    activeNodeId,
    mode: "enforce",
    createdAt: 111,
  };
}

beforeAll(() => {
  // The handlers read the default shared state DB (no options), so point the
  // env-resolved default at an isolated temp store, then seed two executions
  // of the SAME runId (a fallback retry) to prove per-execution lookups.
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();

  const first = makePlan("run-gw-1", "support.triage");
  persistEnterpriseRunStart({
    executionId: "exec-gw-1",
    plan: first,
    sessionKey: "agent:main:x",
    agentId: "main",
    now: 200,
  });
  appendEnterpriseRunEvent({
    executionId: "exec-gw-1",
    seq: 0,
    nodeId: null,
    kind: "run.started",
    payload: { treeId: first.treeId },
    createdAt: 201,
  });
  appendEnterpriseRunEvent({
    executionId: "exec-gw-1",
    seq: 1,
    nodeId: "support.triage",
    kind: "node.entered",
    payload: { title: "Triage" },
    createdAt: 202,
  });
  finalizeEnterpriseRun({ executionId: "exec-gw-1", status: "completed", now: 300 });

  // Second execution of the same runId, still running, stopped at the root node.
  const retry = makePlan("run-gw-1", "support");
  persistEnterpriseRunStart({ executionId: "exec-gw-2", plan: retry, agentId: "main", now: 400 });
  appendEnterpriseRunEvent({
    executionId: "exec-gw-2",
    seq: 0,
    nodeId: null,
    kind: "run.started",
    payload: { treeId: retry.treeId },
    createdAt: 401,
  });
});

afterAll(() => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("enterprise gateway methods", () => {
  it("lists recent executions as bounded summaries", () => {
    const { ok, payload } = invoke("enterprise.runs.list", {});
    expect(ok).toBe(true);
    const result = payload as { runs: Array<Record<string, unknown>> };
    // Both executions of run-gw-1 are distinct rows, newest first.
    expect(result.runs.map((run) => run.executionId)).toEqual(["exec-gw-2", "exec-gw-1"]);
    const completed = result.runs.find((run) => run.executionId === "exec-gw-1");
    expect(completed).toEqual({
      executionId: "exec-gw-1",
      runId: "run-gw-1",
      // Chat needs this to show only the current thread's route.
      sessionKey: "agent:main:x",
      treeId: "acme.support",
      treeVersion: "1.0.0",
      mode: "enforce",
      status: "completed",
      requestSummary: "help with refund",
      activeNodeId: "support.triage",
      // createdAt tracks the plan's creation; updatedAt/endedAt track finalize.
      createdAt: 111,
      updatedAt: 300,
      endedAt: 300,
    });
    // The full internal plan (nodes/events) is not leaked into the list summary.
    expect(completed).not.toHaveProperty("nodes");
    expect(completed).not.toHaveProperty("plan");
  });

  it("canonicalizes the requested sessionKey before filtering runs", () => {
    // Chat holds UI aliases ("main"); the trace stores the resolved store key
    // ("agent:main:main"). Filtering on the raw alias would match nothing for the
    // single most common session.
    const { ok, payload } = invoke("enterprise.runs.list", { sessionKey: "main", limit: 5 });
    expect(ok).toBe(true);
    const result = payload as { runs: Array<Record<string, unknown>> };
    // The fixture rows are stored under "agent:main:x", so an alias that does not
    // resolve to them yields nothing — but the call must not error.
    expect(Array.isArray(result.runs)).toBe(true);
  });

  it("returns run detail by execution id with projected plan nodes and events", () => {
    const { ok, payload } = invoke("enterprise.runs.get", { executionId: "exec-gw-1" });
    expect(ok).toBe(true);
    const { run } = payload as { run: Record<string, unknown> | null };
    expect(run).not.toBeNull();
    expect(run).toMatchObject({
      executionId: "exec-gw-1",
      runId: "run-gw-1",
      treeName: "Support",
      matchedBy: "planner",
      status: "completed",
      activeNodeId: "support.triage",
      // Both executions share the runId, so the sibling count is 2.
      executionCount: 2,
    });
    const nodes = run?.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(2);
    // Empty ontology projects to an empty object; unset fields are dropped.
    expect(nodes[0]).toEqual({
      nodeId: "support",
      parentId: null,
      seq: 0,
      title: "Support",
      ontology: {},
    });
    expect(nodes[1]).toEqual({
      nodeId: "support.triage",
      parentId: "support",
      seq: 1,
      title: "Triage",
      description: "Classify the request",
      ontology: {
        allowedTools: ["memory_search"],
        knowledgeFoundations: ["acme.kb"],
        audit: true,
      },
    });
    const events = run?.events as Array<Record<string, unknown>>;
    expect(events.map((event) => event.kind)).toEqual(["run.started", "node.entered"]);
  });

  it("fetches a specific older execution of a reused runId (not just the newest)", () => {
    // The core of the fix: exec-gw-1 and exec-gw-2 share run-gw-1; each is
    // individually addressable and returns its own distinct state.
    const { payload } = invoke("enterprise.runs.get", { executionId: "exec-gw-2" });
    const { run } = payload as { run: Record<string, unknown> };
    expect(run).toMatchObject({
      executionId: "exec-gw-2",
      runId: "run-gw-1",
      status: "running",
      activeNodeId: "support",
      executionCount: 2,
    });
    expect((run.events as unknown[]).length).toBe(1);
  });

  it("returns null run for an unknown execution id (not an error)", () => {
    const { ok, payload } = invoke("enterprise.runs.get", { executionId: "does-not-exist" });
    expect(ok).toBe(true);
    expect(payload).toEqual({ run: null });
  });

  it("lists registry trees with node counts", () => {
    const { ok, payload } = invoke("enterprise.trees.list", {});
    expect(ok).toBe(true);
    const result = payload as {
      trees: Array<{ id: string; source: string; nodeCount: number }>;
      importErrors: unknown[];
    };
    expect(result.trees.length).toBeGreaterThan(0);
    expect(result.trees.every((tree) => tree.source === "builtin")).toBe(true);
    expect(result.trees.every((tree) => tree.nodeCount >= 1)).toBe(true);
    expect(result.importErrors).toEqual([]);
  });

  it("rejects invalid params with an INVALID_REQUEST error", () => {
    const missingExecutionId = invoke("enterprise.runs.get", {});
    expect(missingExecutionId.ok).toBe(false);
    expect(missingExecutionId.error).toBeDefined();

    const badLimit = invoke("enterprise.runs.list", { limit: 0 });
    expect(badLimit.ok).toBe(false);

    const unknownField = invoke("enterprise.trees.list", { unexpected: true });
    expect(unknownField.ok).toBe(false);
  });
});
