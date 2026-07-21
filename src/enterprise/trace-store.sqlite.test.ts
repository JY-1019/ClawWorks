import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  appendEnterpriseRunEvent,
  finalizeEnterpriseRun,
  getEnterpriseRunRecord,
  listEnterpriseRunEvents,
  listEnterpriseRunExecutions,
  listEnterpriseRunRecords,
  persistEnterpriseRunStart,
} from "./trace-store.sqlite.js";
import type { EnterpriseRunPlan } from "./types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-trace-"));
const storeOptions = { stateDatabasePath: path.join(tempDir, "openclaw.sqlite") };

afterAll(() => {
  closeOpenClawStateDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

function makePlan(runId: string): EnterpriseRunPlan {
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
        ontology: { allowedTools: ["memory_search"] },
      },
    ],
    activeNodeId: "support",
    mode: "enforce",
    createdAt: 111,
  };
}

describe("enterprise trace store", () => {
  it("returns empty results before the database exists", () => {
    const missing = { stateDatabasePath: path.join(tempDir, "missing.sqlite") };
    expect(getEnterpriseRunRecord("nope", missing)).toBeNull();
    expect(listEnterpriseRunRecords({}, missing)).toEqual([]);
    expect(listEnterpriseRunExecutions("nope", missing)).toEqual([]);
    expect(listEnterpriseRunEvents("nope", missing)).toEqual([]);
  });

  it("persists and finalizes an execution with its event log", () => {
    const plan = makePlan("run-trace-1");
    persistEnterpriseRunStart(
      { executionId: "exec-1", plan, sessionKey: "agent:main:x", agentId: "main", now: 200 },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-1",
        seq: 0,
        nodeId: null,
        kind: "run.started",
        payload: { treeId: plan.treeId },
        createdAt: 201,
      },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-1",
        seq: 1,
        nodeId: "support",
        kind: "governance.decision",
        payload: { toolName: "exec", effect: "deny" },
        createdAt: 202,
      },
      storeOptions,
    );

    const running = getEnterpriseRunRecord(plan.runId, storeOptions);
    expect(running?.executionId).toBe("exec-1");
    expect(running?.status).toBe("running");
    expect(running?.sessionKey).toBe("agent:main:x");
    expect(running?.agentId).toBe("main");
    expect(running?.plan.nodes).toHaveLength(2);
    expect(running?.plan.nodes[1].ontology.allowedTools).toEqual(["memory_search"]);

    finalizeEnterpriseRun({ executionId: "exec-1", status: "completed", now: 300 }, storeOptions);
    const completed = getEnterpriseRunRecord(plan.runId, storeOptions);
    expect(completed?.status).toBe("completed");
    expect(completed?.endedAt).toBe(300);

    const events = listEnterpriseRunEvents("exec-1", storeOptions);
    expect(events.map((event) => event.kind)).toEqual(["run.started", "governance.decision"]);
    expect(events[1].nodeId).toBe("support");
    expect(events[1].payload).toEqual({ toolName: "exec", effect: "deny" });
  });

  it("keeps one row per execution for recurring runIds (latest wins for lookup)", () => {
    const first = { ...makePlan("run-trace-2"), createdAt: 400 };
    const second = { ...makePlan("run-trace-2"), createdAt: 500 };
    persistEnterpriseRunStart({ executionId: "exec-2a", plan: first, now: 400 }, storeOptions);
    finalizeEnterpriseRun({ executionId: "exec-2a", status: "failed", now: 410 }, storeOptions);
    persistEnterpriseRunStart({ executionId: "exec-2b", plan: second, now: 500 }, storeOptions);

    const executions = listEnterpriseRunExecutions("run-trace-2", storeOptions);
    expect(executions.map((record) => record.executionId)).toEqual(["exec-2b", "exec-2a"]);
    expect(executions[1].status).toBe("failed");

    const latest = getEnterpriseRunRecord("run-trace-2", storeOptions);
    expect(latest?.executionId).toBe("exec-2b");
    expect(latest?.status).toBe("running");
  });

  it("filters by sessionKey in SQL, before the limit", () => {
    // Chat asks for one run for one thread. If the filter ran after the limit,
    // a thread whose newest run is older than the page would look ungoverned.
    for (let i = 0; i < 5; i++) {
      persistEnterpriseRunStart(
        {
          executionId: `exec-other-${i}`,
          plan: makePlan(`run-other-${i}`),
          sessionKey: "agent:main:other",
          now: 1000 + i,
        },
        storeOptions,
      );
    }
    persistEnterpriseRunStart(
      {
        executionId: "exec-mine",
        plan: makePlan("run-mine"),
        sessionKey: "agent:main:me",
        now: 500, // older than every other-session run
      },
      storeOptions,
    );

    // A limit of 1 without the filter would return an other-session run.
    const mine = listEnterpriseRunRecords({ limit: 1, sessionKey: "agent:main:me" }, storeOptions);
    expect(mine.map((record) => record.executionId)).toEqual(["exec-mine"]);
  });

  it("lists executions newest-first with a bounded limit", () => {
    const older = { ...makePlan("run-trace-3"), createdAt: 500 };
    const newer = { ...makePlan("run-trace-4"), createdAt: 600 };
    persistEnterpriseRunStart({ executionId: "exec-3", plan: older }, storeOptions);
    persistEnterpriseRunStart({ executionId: "exec-4", plan: newer }, storeOptions);
    const runs = listEnterpriseRunRecords({ limit: 2 }, storeOptions);
    expect(runs).toHaveLength(2);
    expect(runs[0].createdAt).toBeGreaterThanOrEqual(runs[1].createdAt);
  });
});
