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
  requestEnterpriseRunResume,
  takeEnterpriseRunResume,
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

/**
 * A route with TWO steps, so finishing the first leaves something to resume onto.
 * `makePlan` has a single leaf, where completing it finishes the whole route.
 */
function makeTwoStepPlan(runId: string): EnterpriseRunPlan {
  const base = makePlan(runId);
  return {
    ...base,
    nodes: [
      ...base.nodes,
      {
        nodeId: "support.resolve",
        parentId: "support",
        seq: 2,
        title: "Resolve",
        ontology: {},
      },
    ],
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

  it("marks a finished execution for resume and hands it over exactly once", () => {
    const plan = makeTwoStepPlan("run-resume-1");
    persistEnterpriseRunStart(
      {
        executionId: "exec-resume",
        plan,
        sessionKey: "agent:main:resume",
        sessionId: "t-resume",
        now: 900,
      },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-resume",
        seq: 0,
        nodeId: "support.triage",
        kind: "node.completed",
        payload: { seq: 1, title: "Triage" },
        createdAt: 901,
      },
      storeOptions,
    );
    // Still running: there is nothing to continue yet.
    expect(requestEnterpriseRunResume("exec-resume", { now: 8000 }, storeOptions)).toEqual({
      ok: false,
      reason: "still-running",
    });
    finalizeEnterpriseRun(
      { executionId: "exec-resume", status: "aborted", now: 950 },
      storeOptions,
    );
    expect(requestEnterpriseRunResume("exec-resume", { now: 8000 }, storeOptions)).toEqual({
      ok: true,
      sessionKey: "agent:main:resume",
      treeId: "acme.support",
    });
    expect(getEnterpriseRunRecord("run-resume-1", storeOptions)?.resumeRequested).toBe(true);

    // A different tree in the same session is not the work the operator named.
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:resume",
          sessionId: "t-resume",
          agentId: null,
          treeId: "acme.other",
          startedAt: 9000,
        },
        storeOptions,
      ),
    ).toBeNull();
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:resume",
          sessionId: "t-resume",
          agentId: null,
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      ),
    ).toEqual({ executionId: "exec-resume", completedNodeIds: ["support.triage"] });
    // One-shot: a second run in the same session starts fresh.
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:resume",
          sessionId: "t-resume",
          agentId: null,
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      ),
    ).toBeNull();
  });

  it("refuses to mark a run that finished no step", () => {
    const plan = makeTwoStepPlan("run-resume-2");
    persistEnterpriseRunStart(
      {
        executionId: "exec-resume-empty",
        plan,
        sessionKey: "agent:main:empty",
        sessionId: "t-empty",
        now: 960,
      },
      storeOptions,
    );
    finalizeEnterpriseRun(
      { executionId: "exec-resume-empty", status: "aborted", now: 970 },
      storeOptions,
    );
    // Resuming it would open exactly where a fresh run does, so the marker would
    // only add a claim to the trace that nothing acts on.
    expect(requestEnterpriseRunResume("exec-resume-empty", { now: 8000 }, storeOptions)).toEqual({
      ok: false,
      reason: "no-steps-completed",
    });
  });

  it("keeps one pending resume per session", () => {
    for (const [runId, executionId] of [
      ["run-resume-3", "exec-pending-a"],
      ["run-resume-4", "exec-pending-b"],
    ]) {
      persistEnterpriseRunStart(
        {
          executionId,
          plan: makeTwoStepPlan(runId),
          sessionKey: "agent:main:one",
          sessionId: "t-one",
          now: 980,
        },
        storeOptions,
      );
      appendEnterpriseRunEvent(
        {
          executionId,
          seq: 0,
          nodeId: "support.triage",
          kind: "node.completed",
          payload: {},
          createdAt: 981,
        },
        storeOptions,
      );
      finalizeEnterpriseRun({ executionId, status: "aborted", now: 985 }, storeOptions);
      expect(requestEnterpriseRunResume(executionId, { now: 8000 }, storeOptions).ok).toBe(true);
    }
    // The second request replaces the first: two marked rows would leave whichever
    // one mediation read first deciding where the next run opens.
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:one",
          sessionId: "t-one",
          agentId: null,
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      )?.executionId,
    ).toBe("exec-pending-b");
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:one",
          sessionId: "t-one",
          agentId: null,
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      ),
    ).toBeNull();
  });

  it("refuses to mark a run that finished its whole route", () => {
    const plan = makePlan("run-resume-5");
    persistEnterpriseRunStart(
      {
        executionId: "exec-resume-done",
        plan,
        sessionKey: "agent:main:done",
        sessionId: "t-done",
        now: 1100,
      },
      storeOptions,
    );
    // "support.triage" is this plan's only leaf, so completing it finishes the
    // route. The run can still end `aborted` — the provider dropped after the
    // last step — which is why status alone cannot answer this.
    appendEnterpriseRunEvent(
      {
        executionId: "exec-resume-done",
        seq: 0,
        nodeId: "support.triage",
        kind: "node.completed",
        payload: {},
        createdAt: 1101,
      },
      storeOptions,
    );
    finalizeEnterpriseRun(
      { executionId: "exec-resume-done", status: "aborted", now: 1110 },
      storeOptions,
    );
    // Accepting it would let mediation fall back to step 1 and rerun everything.
    expect(requestEnterpriseRunResume("exec-resume-done", { now: 8000 }, storeOptions)).toEqual({
      ok: false,
      reason: "route-complete",
    });
  });

  it("keeps one agent's pending resume out of another's reach on a shared session key", () => {
    // Under `session.scope: "global"` every agent shares one session_key, so the
    // lane is (session, agent) — not the session alone.
    const lanes = [
      { agentId: "main", executionId: "exec-lane-main", runId: "run-lane-1" },
      { agentId: "research", executionId: "exec-lane-research", runId: "run-lane-2" },
    ];
    for (const lane of lanes) {
      persistEnterpriseRunStart(
        {
          executionId: lane.executionId,
          plan: makeTwoStepPlan(lane.runId),
          sessionKey: "global",
          sessionId: "t-lane",
          agentId: lane.agentId,
          now: 1200,
        },
        storeOptions,
      );
      appendEnterpriseRunEvent(
        {
          executionId: lane.executionId,
          seq: 0,
          nodeId: "support.triage",
          kind: "node.completed",
          payload: {},
          createdAt: 1201,
        },
        storeOptions,
      );
      finalizeEnterpriseRun(
        { executionId: lane.executionId, status: "aborted", now: 1210 },
        storeOptions,
      );
      expect(requestEnterpriseRunResume(lane.executionId, { now: 8000 }, storeOptions).ok).toBe(
        true,
      );
    }
    // Both stay pending: the second request must not have cleared the first, and
    // each agent's next run picks up its own.
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "global",
          sessionId: "t-lane",
          agentId: "main",
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      )?.executionId,
    ).toBe("exec-lane-main");
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "global",
          sessionId: "t-lane",
          agentId: "research",
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      )?.executionId,
    ).toBe("exec-lane-research");
  });

  it("carries progress across a chain of resumes", () => {
    // a -> b -> c interrupted twice. Execution 2 finished only `b`; read alone
    // that is not a prefix of the route, so the route would look finished and `c`
    // could never be reached without redoing `a`.
    const plan: EnterpriseRunPlan = {
      ...makePlan("run-chain"),
      nodes: [
        { nodeId: "root", parentId: null, seq: 0, title: "Root", ontology: {} },
        { nodeId: "a", parentId: "root", seq: 1, title: "A", ontology: {} },
        { nodeId: "b", parentId: "root", seq: 2, title: "B", ontology: {} },
        { nodeId: "c", parentId: "root", seq: 3, title: "C", ontology: {} },
      ],
    };
    persistEnterpriseRunStart(
      {
        executionId: "exec-chain-1",
        plan,
        sessionKey: "agent:main:chain",
        sessionId: "t-chain",
        now: 1300,
      },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-chain-1",
        seq: 0,
        nodeId: "a",
        kind: "node.completed",
        payload: {},
        createdAt: 1301,
      },
      storeOptions,
    );
    finalizeEnterpriseRun(
      { executionId: "exec-chain-1", status: "aborted", now: 1310 },
      storeOptions,
    );

    // Execution 2 continues it: the resume event records the inherited prefix.
    persistEnterpriseRunStart(
      {
        executionId: "exec-chain-2",
        plan,
        sessionKey: "agent:main:chain",
        sessionId: "t-chain",
        now: 1320,
      },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-chain-2",
        seq: 0,
        nodeId: null,
        kind: "run.resumed",
        payload: { resumedFrom: "exec-chain-1", carriedSteps: ["a"], openedOn: "b" },
        createdAt: 1321,
      },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-chain-2",
        seq: 1,
        nodeId: "b",
        kind: "node.completed",
        payload: {},
        createdAt: 1322,
      },
      storeOptions,
    );
    finalizeEnterpriseRun(
      { executionId: "exec-chain-2", status: "aborted", now: 1330 },
      storeOptions,
    );

    expect(requestEnterpriseRunResume("exec-chain-2", { now: 8000 }, storeOptions).ok).toBe(true);
    // Both steps carry forward, so the third run opens on `c`.
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:chain",
          sessionId: "t-chain",
          agentId: null,
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      ),
    ).toEqual({ executionId: "exec-chain-2", completedNodeIds: ["a", "b"] });
  });

  it("drops the whole suffix a reopen invalidated so the carried set stays a prefix", () => {
    // Route [a,b,c]: `a` and `b` finished, then a steered correction sent the run
    // back to `a` and the run died before redoing it. Dropping only `a` would leave
    // `[b]` — not a prefix — and firstUnfinishedStep reads the gap at index 0 as a
    // finished route, so the operator would be told a run that completed neither
    // `a` nor `c` was done. The suffix goes with it, because `b` was built on `a`.
    const plan: EnterpriseRunPlan = {
      ...makePlan("run-reopen"),
      nodes: [
        { nodeId: "root", parentId: null, seq: 0, title: "Root", ontology: {} },
        { nodeId: "a", parentId: "root", seq: 1, title: "A", ontology: {} },
        { nodeId: "b", parentId: "root", seq: 2, title: "B", ontology: {} },
        { nodeId: "c", parentId: "root", seq: 3, title: "C", ontology: {} },
      ],
    };
    persistEnterpriseRunStart(
      {
        executionId: "exec-reopen-1",
        plan,
        sessionKey: "agent:main:reopen",
        sessionId: "t-reopen",
        now: 1500,
      },
      storeOptions,
    );
    const events = [
      { nodeId: "a", kind: "node.completed", payload: {} },
      { nodeId: "b", kind: "node.completed", payload: {} },
      { nodeId: "a", kind: "node.reopened", payload: { invalidated: ["a", "b", "c"] } },
      { nodeId: "a", kind: "node.completed", payload: {} },
    ];
    for (const [seq, event] of events.entries()) {
      appendEnterpriseRunEvent(
        {
          executionId: "exec-reopen-1",
          seq,
          nodeId: event.nodeId,
          kind: event.kind as "node.completed",
          payload: event.payload,
          createdAt: 1501 + seq,
        },
        storeOptions,
      );
    }
    finalizeEnterpriseRun(
      { executionId: "exec-reopen-1", status: "aborted", now: 1510 },
      storeOptions,
    );

    // `a` was redone after the reopen, so the run is resumable and the next one
    // opens on `b` — the first step whose work the correction invalidated.
    expect(requestEnterpriseRunResume("exec-reopen-1", { now: 8000 }, storeOptions).ok).toBe(true);
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:reopen",
          sessionId: "t-reopen",
          agentId: null,
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      ),
    ).toEqual({ executionId: "exec-reopen-1", completedNodeIds: ["a"] });
  });

  it("refuses resume while a reopened step is still unfinished", () => {
    // Same correction, but the run died BEFORE redoing `a`. Nothing is finished, so
    // there is no prefix to continue from and the refusal must say exactly that
    // rather than claim the route completed.
    const plan: EnterpriseRunPlan = {
      ...makePlan("run-reopen-2"),
      nodes: [
        { nodeId: "root", parentId: null, seq: 0, title: "Root", ontology: {} },
        { nodeId: "a", parentId: "root", seq: 1, title: "A", ontology: {} },
        { nodeId: "b", parentId: "root", seq: 2, title: "B", ontology: {} },
      ],
    };
    persistEnterpriseRunStart(
      {
        executionId: "exec-reopen-2",
        plan,
        sessionKey: "agent:main:reopen2",
        sessionId: "t-reopen2",
        now: 1600,
      },
      storeOptions,
    );
    const events = [
      { nodeId: "a", kind: "node.completed", payload: {} },
      { nodeId: "a", kind: "node.reopened", payload: { invalidated: ["a", "b"] } },
    ];
    for (const [seq, event] of events.entries()) {
      appendEnterpriseRunEvent(
        {
          executionId: "exec-reopen-2",
          seq,
          nodeId: event.nodeId,
          kind: event.kind as "node.completed",
          payload: event.payload,
          createdAt: 1601 + seq,
        },
        storeOptions,
      );
    }
    finalizeEnterpriseRun(
      { executionId: "exec-reopen-2", status: "aborted", now: 1610 },
      storeOptions,
    );

    expect(requestEnterpriseRunResume("exec-reopen-2", { now: 8000 }, storeOptions)).toMatchObject({
      ok: false,
      reason: "no-steps-completed",
    });
  });

  it("reads back every event kind it can write", () => {
    // The write side is unvalidated — appendEnterpriseRunEvent inserts the kind
    // straight into SQLite — so a kind missing from the read side's table would
    // surface only here, throwing for the run inspector and `runs show` alike.
    const plan = makeTwoStepPlan("run-kinds");
    persistEnterpriseRunStart(
      {
        executionId: "exec-kinds",
        plan,
        sessionKey: "agent:main:kinds",
        sessionId: "t-kinds",
        now: 1700,
      },
      storeOptions,
    );
    const kinds = [
      "run.started",
      "route.selected",
      "governance.decision",
      "node.entered",
      "node.completed",
      "node.reopened",
      "run.steered",
      "run.resumed",
      "action.invoked",
      "run.ended",
    ] as const;
    for (const [seq, kind] of kinds.entries()) {
      appendEnterpriseRunEvent(
        {
          executionId: "exec-kinds",
          seq,
          nodeId: null,
          kind,
          payload: {},
          createdAt: 1701 + seq,
        },
        storeOptions,
      );
    }
    expect(listEnterpriseRunEvents("exec-kinds", storeOptions).map((event) => event.kind)).toEqual([
      ...kinds,
    ]);
  });

  it("will not hand a resume to another transcript or to a turn that predates it", () => {
    const plan = makeTwoStepPlan("run-resume-6");
    persistEnterpriseRunStart(
      {
        executionId: "exec-resume-bind",
        plan,
        sessionKey: "agent:main:bind",
        sessionId: "t-before",
        now: 1400,
      },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-resume-bind",
        seq: 0,
        nodeId: "support.triage",
        kind: "node.completed",
        payload: {},
        createdAt: 1401,
      },
      storeOptions,
    );
    finalizeEnterpriseRun(
      { executionId: "exec-resume-bind", status: "aborted", now: 1410 },
      storeOptions,
    );
    expect(requestEnterpriseRunResume("exec-resume-bind", { now: 8000 }, storeOptions).ok).toBe(
      true,
    );

    // `/new` rebinds the session key to a fresh transcript. That conversation
    // never saw the completed steps, so the marker must not follow it there.
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:bind",
          sessionId: "t-after-reset",
          agentId: null,
          treeId: "acme.support",
          startedAt: 9000,
        },
        storeOptions,
      ),
    ).toBeNull();

    // A turn already in flight when the operator clicked began before they asked,
    // so "the next request" cannot mean this one.
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:bind",
          sessionId: "t-before",
          agentId: null,
          treeId: "acme.support",
          startedAt: 7999,
        },
        storeOptions,
      ),
    ).toBeNull();

    // The operator's actual next request in that transcript takes it.
    expect(
      takeEnterpriseRunResume(
        {
          sessionKey: "agent:main:bind",
          sessionId: "t-before",
          agentId: null,
          treeId: "acme.support",
          startedAt: 8001,
        },
        storeOptions,
      )?.executionId,
    ).toBe("exec-resume-bind");
  });

  it("refuses a run whose conversation was replaced after it", () => {
    const plan = makeTwoStepPlan("run-resume-7");
    persistEnterpriseRunStart(
      {
        executionId: "exec-rotated",
        plan: { ...plan, createdAt: 1500 },
        sessionKey: "agent:main:rotate",
        sessionId: "t-old",
        now: 1500,
      },
      storeOptions,
    );
    appendEnterpriseRunEvent(
      {
        executionId: "exec-rotated",
        seq: 0,
        nodeId: "support.triage",
        kind: "node.completed",
        payload: {},
        createdAt: 1501,
      },
      storeOptions,
    );
    finalizeEnterpriseRun(
      { executionId: "exec-rotated", status: "aborted", now: 1510 },
      storeOptions,
    );
    // `/new` under the same key: a later run in this lane carries a different
    // transcript, so nothing can ever consume a marker bound to the old one.
    persistEnterpriseRunStart(
      {
        executionId: "exec-after-reset",
        plan: { ...makeTwoStepPlan("run-resume-8"), createdAt: 1600 },
        sessionKey: "agent:main:rotate",
        sessionId: "t-new",
        now: 1600,
      },
      storeOptions,
    );

    // Accepting it would leave the screen waiting on something that cannot happen.
    expect(requestEnterpriseRunResume("exec-rotated", { now: 8000 }, storeOptions)).toEqual({
      ok: false,
      reason: "transcript-rotated",
    });
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
