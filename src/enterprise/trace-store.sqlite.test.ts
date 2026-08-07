import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  appendEnterpriseRunEvent,
  abortOrphanedEnterpriseRuns,
  finalizeEnterpriseRun,
  updateEnterpriseRunSessionId,
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

  it("filters by agentId, which sessionKey alone cannot do under global scope", () => {
    // Every agent's store shares the canonical "global" key, so a chat scoped to
    // one agent has to say which one or it can adopt another agent's run.
    persistEnterpriseRunStart(
      {
        executionId: "exec-other-agent",
        plan: makePlan("run-other-agent"),
        sessionKey: "global",
        agentId: "research",
        now: 2000, // newer, so a limit of 1 would return it
      },
      storeOptions,
    );
    persistEnterpriseRunStart(
      {
        executionId: "exec-my-agent",
        plan: makePlan("run-my-agent"),
        sessionKey: "global",
        agentId: "main",
        now: 1000,
      },
      storeOptions,
    );

    const mine = listEnterpriseRunRecords(
      { limit: 1, sessionKey: "global", agentId: "main" },
      storeOptions,
    );
    expect(mine.map((record) => record.executionId)).toEqual(["exec-my-agent"]);

    // Without the agent filter the same query returns the other agent's run,
    // which is exactly the confusion the filter exists to prevent.
    const unscoped = listEnterpriseRunRecords({ limit: 1, sessionKey: "global" }, storeOptions);
    expect(unscoped.map((record) => record.executionId)).toEqual(["exec-other-agent"]);
  });

  it("hides internal runs from chat lookups but keeps them for audit", () => {
    // An internal run borrows a visible session for storage, so it matches the
    // session filter and would otherwise be reconstructed into that chat.
    persistEnterpriseRunStart(
      {
        executionId: "exec-internal",
        // Ordering is by the plan's createdAt, so state it rather than relying
        // on `now` (which only sets updated_at).
        plan: { ...makePlan("run-internal"), createdAt: 3000 }, // newest
        sessionKey: "agent:main:me",
        chatVisible: false,
      },
      storeOptions,
    );
    persistEnterpriseRunStart(
      {
        executionId: "exec-visible",
        plan: { ...makePlan("run-visible"), createdAt: 1000 },
        sessionKey: "agent:main:me",
      },
      storeOptions,
    );

    const chat = listEnterpriseRunRecords(
      { limit: 1, sessionKey: "agent:main:me", chatVisibleOnly: true },
      storeOptions,
    );
    expect(chat.map((record) => record.executionId)).toEqual(["exec-visible"]);

    // The audit screen passes no such filter and still sees the hidden run.
    const audit = listEnterpriseRunRecords({ limit: 1, sessionKey: "agent:main:me" }, storeOptions);
    expect(audit.map((record) => record.executionId)).toEqual(["exec-internal"]);
  });

  it("closes runs a previous process left running, and only those", () => {
    // Mediated runs live only in memory, so a `running` row at startup belongs
    // to a process that is gone.
    persistEnterpriseRunStart(
      { executionId: "exec-orphan", plan: makePlan("run-orphan") },
      storeOptions,
    );
    persistEnterpriseRunStart(
      { executionId: "exec-done", plan: makePlan("run-done") },
      storeOptions,
    );
    finalizeEnterpriseRun({ executionId: "exec-done", status: "completed" }, storeOptions);

    // Count is not asserted exactly: earlier cases in this file share the store
    // and leave their own running rows, which the sweep legitimately closes too.
    // Owner reported dead, so the sweep may close it.
    expect(
      abortOrphanedEnterpriseRuns({ now: 5000, isOwnerGone: () => true }, storeOptions),
    ).toBeGreaterThanOrEqual(1);
    expect(getEnterpriseRunRecord("run-orphan", storeOptions)?.status).toBe("aborted");
    // A run that ended on its own terms keeps the status it ended with.
    expect(getEnterpriseRunRecord("run-done", storeOptions)?.status).toBe("completed");

    // The append-only trace closes too: a summary that says `aborted` above an
    // event list that never ends reads as a run still in flight.
    const orphanEvents = listEnterpriseRunEvents("exec-orphan", storeOptions);
    const terminal = orphanEvents.at(-1);
    expect(terminal?.kind).toBe("run.ended");
    expect(terminal?.payload).toMatchObject({ status: "aborted" });
    // Sequence continues the existing trace rather than colliding with it.
    expect(terminal?.seq).toBeGreaterThan(orphanEvents.at(-2)?.seq ?? -1);

    // Idempotent: a second sweep has nothing left to close.
    expect(abortOrphanedEnterpriseRuns({ now: 6000, isOwnerGone: () => true }, storeOptions)).toBe(
      0,
    );
  });

  it("honors a terminal event written before the process died", () => {
    // Finalization appends `run.ended` and updates the summary in two writes, so
    // a crash between them leaves a terminal event above a `running` row. That
    // run reported its own verdict; recovery must not overwrite it.
    persistEnterpriseRunStart(
      { executionId: "exec-half-final", plan: makePlan("run-half-final") },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-half-final",
        seq: 0,
        nodeId: null,
        kind: "run.ended",
        payload: { status: "completed" },
        createdAt: 100,
      },
      storeOptions,
    );

    abortOrphanedEnterpriseRuns({ now: 9500, isOwnerGone: () => true }, storeOptions);

    expect(getEnterpriseRunRecord("run-half-final", storeOptions)?.status).toBe("completed");
    // And no second, contradictory terminal event.
    const events = listEnterpriseRunEvents("exec-half-final", storeOptions);
    expect(events.filter((event) => event.kind === "run.ended")).toHaveLength(1);
  });

  it("leaves a run alone while its owning process is alive", () => {
    // The state DB is shared: an `openclaw agent --local` run writes these rows
    // too, so sweeping every `running` row would end a live execution's trace.
    persistEnterpriseRunStart(
      { executionId: "exec-live-owner", plan: makePlan("run-live-owner") },
      storeOptions,
    );
    expect(abortOrphanedEnterpriseRuns({ now: 7000, isOwnerGone: () => false }, storeOptions)).toBe(
      0,
    );
    expect(getEnterpriseRunRecord("run-live-owner", storeOptions)?.status).toBe("running");
  });

  // The default owner check is what makes the sweep safe in a container, where a
  // restart hands the new process the same pid. Exercised through the injected
  // predicate so the assertion does not depend on real process ids.
  it("treats a recycled pid as a different owner", () => {
    persistEnterpriseRunStart(
      { executionId: "exec-recycled", plan: makePlan("run-recycled") },
      storeOptions,
    );
    // Same pid, different start time — a new incarnation, so the old run is gone.
    const recycled = (token: string) => {
      const [, startedAt = ""] = token.split(":");
      return startedAt !== "999";
    };
    expect(
      abortOrphanedEnterpriseRuns({ now: 9000, isOwnerGone: recycled }, storeOptions),
    ).toBeGreaterThanOrEqual(1);
    expect(getEnterpriseRunRecord("run-recycled", storeOptions)?.status).toBe("aborted");
  });

  it("follows a transcript rotation on the durable row", () => {
    persistEnterpriseRunStart(
      {
        executionId: "exec-rotate",
        plan: makePlan("run-rotate"),
        sessionId: "transcript-before",
      },
      storeOptions,
    );
    updateEnterpriseRunSessionId(
      { executionId: "exec-rotate", sessionId: "transcript-after", now: 8000 },
      storeOptions,
    );
    expect(getEnterpriseRunRecord("run-rotate", storeOptions)?.sessionId).toBe("transcript-after");
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
