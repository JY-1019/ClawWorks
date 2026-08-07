import { describe, expect, it, vi } from "vitest";
import {
  applyEnterpriseChatStep,
  clearEnterpriseChatRoute,
  loadEnterpriseChatMode,
  loadEnterpriseChatRoute,
  setEnterpriseChatMode,
  type EnterpriseChatState,
} from "./enterprise-chat.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function createState(): {
  state: EnterpriseChatState;
  request: ReturnType<typeof vi.fn<TestRequest>>;
} {
  const request = vi.fn<TestRequest>();
  const state: EnterpriseChatState = {
    client: { request } as unknown as EnterpriseChatState["client"],
    connected: true,
    enterpriseChatMode: null,
    enterpriseChatModeBusy: false,
    enterpriseChatModeError: null,
    enterpriseChatRun: null,
    enterpriseChatRunTree: null,
    enterpriseChatStep: null,
  };
  return { state, request };
}

const runSummary = (executionId: string, sessionKey: string | null) => ({
  executionId,
  runId: `run-${executionId}`,
  sessionKey,
  treeId: "acme.financial-operations",
  treeVersion: "1.0.0",
  mode: "enforce",
  status: "completed" as const,
  requestSummary: "pay the claim",
  activeNodeId: "finops",
  createdAt: Number.MAX_SAFE_INTEGER,
  updatedAt: 2,
  endedAt: 2,
});

describe("loadEnterpriseChatMode", () => {
  it("reads the mode the gateway actually enforces", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ mode: "observe" });
    await loadEnterpriseChatMode(state);
    expect(request).toHaveBeenCalledWith("enterprise.mode.get", {});
    expect(state.enterpriseChatMode).toBe("observe");
  });

  it("leaves the selector absent when the gateway refuses (no operator.read)", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("missing scope: operator.read"));
    await loadEnterpriseChatMode(state);
    // No mode means the selector renders nothing — better than a control that
    // cannot work.
    expect(state.enterpriseChatMode).toBeNull();
  });
});

describe("setEnterpriseChatMode", () => {
  it("persists the mode and keeps what the gateway confirms", async () => {
    const { state, request } = createState();
    state.enterpriseChatMode = "enforce";
    request.mockResolvedValue({ mode: "off" });
    await setEnterpriseChatMode(state, "off");
    expect(request).toHaveBeenCalledWith("enterprise.mode.set", { mode: "off" });
    expect(state.enterpriseChatMode).toBe("off");
    expect(state.enterpriseChatModeBusy).toBe(false);
  });

  it("reverts when the gateway rejects the switch (admin-scoped)", async () => {
    const { state, request } = createState();
    state.enterpriseChatMode = "enforce";
    request.mockRejectedValue(new Error("missing scope: operator.admin"));
    await setEnterpriseChatMode(state, "off");
    // The mode was never persisted, so showing "off" would be a lie.
    expect(state.enterpriseChatMode).toBe("enforce");
    expect(state.enterpriseChatModeError).toContain("operator.admin");
    expect(state.enterpriseChatModeBusy).toBe(false);
  });
});

describe("mode load/write races", () => {
  it("does not let a connect-time read overwrite a mode the operator just set", async () => {
    const { state, request } = createState();
    let releaseRead: ((value: unknown) => void) | undefined;
    request.mockImplementation(async (method) => {
      if (method === "enterprise.mode.get") {
        return await new Promise((resolve) => {
          releaseRead = resolve;
        });
      }
      return { mode: "off" };
    });
    // The connect-time read is still in flight...
    const read = loadEnterpriseChatMode(state);
    // ...when the operator switches the mode, which succeeds.
    await setEnterpriseChatMode(state, "off");
    expect(state.enterpriseChatMode).toBe("off");
    // The stale read now resolves with the PRE-switch value; it must be dropped.
    releaseRead?.({ mode: "enforce" });
    await read;
    expect(state.enterpriseChatMode).toBe("off");
  });
});

describe("loadEnterpriseChatRoute", () => {
  it("asks the SERVER for this session's newest run (never filters a limited page)", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method, payload) => {
      if (method === "enterprise.runs.list") {
        // The filter must be server-side: filtering a limited page here would
        // lose this thread's run whenever other sessions ran more recently.
        // Server-side, and chat-visible only: an internal run borrows this
        // session for storage but must not be shown in it.
        expect(payload).toEqual({
          limit: 1,
          sessionKey: "agent:main:me",
          chatVisibleOnly: true,
        });
        return { runs: [runSummary("exec-mine", "agent:main:me")] };
      }
      if (method === "enterprise.runs.get") {
        expect(payload).toEqual({ executionId: "exec-mine" });
        return { run: { executionId: "exec-mine", treeName: "Financial operations" } };
      }
      throw new Error(`unexpected ${method}`);
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun?.executionId).toBe("exec-mine");
  });

  it("clears the card when this session has no governed run", async () => {
    const { state, request } = createState();
    state.enterpriseChatRun = { executionId: "stale" } as EnterpriseChatState["enterpriseChatRun"];
    request.mockResolvedValue({ runs: [] });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun).toBeNull();
  });

  it("keeps the run on its own bubble when this turn produced no governed run", async () => {
    // Enterprise switched off mid-thread: the turn traces nothing, so the newest
    // run is still the one already on screen. It must STAY — the card belongs to
    // the bubble that run wrote, and the group binding keeps it off the newer,
    // ungoverned answer. Dropping it here would blank the correct card until reload.
    const { state, request } = createState();
    state.enterpriseChatRun = {
      executionId: "exec-old",
      status: "completed",
    } as EnterpriseChatState["enterpriseChatRun"];
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-old", "agent:main:me")] };
      }
      throw new Error("runs.get must not be reached for an unchanged run");
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun?.executionId).toBe("exec-old");
  });

  it("refetches the SAME run once it leaves running", async () => {
    // Joining a session mid-run caches the run as `running`, and only a completed
    // run gets a card. Skipping the terminal refetch on id alone would strand it.
    const { state, request } = createState();
    state.enterpriseChatRun = {
      executionId: "exec-1",
      status: "running",
    } as EnterpriseChatState["enterpriseChatRun"];
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-1", "agent:main:me")] };
      }
      return { run: { executionId: "exec-1", status: "completed", treeName: "T" } };
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun?.status).toBe("completed");
  });

  it("shows the route when the turn DID produce a new governed run", async () => {
    const { state, request } = createState();
    state.enterpriseChatRun = {
      executionId: "exec-old",
    } as EnterpriseChatState["enterpriseChatRun"];
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-new", "agent:main:me")] };
      }
      return { run: { executionId: "exec-new", treeName: "T" } };
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun?.executionId).toBe("exec-new");
  });

  it("enables the whole-tree view only for the tree the run actually governed", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-1", "agent:main:me")] };
      }
      if (method === "enterprise.runs.get") {
        return { run: { executionId: "exec-1", treeName: "T", treeId: "t", treeHash: "h1" } };
      }
      return { tree: { id: "t", hash: "h1", nodes: [] } };
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRunTree?.hash).toBe("h1");
  });

  it("refuses a tree the gateway itself reports as unauthoritative", async () => {
    // importError means the imported override failed to load and `tree` may be a
    // stale built-in. Drawing its untaken branches would misstate what the run was
    // governed by, so the card falls back to route-only.
    const { state, request } = createState();
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-1", "agent:main:me")] };
      }
      if (method === "enterprise.runs.get") {
        return { run: { executionId: "exec-1", treeName: "T", treeId: "t", treeHash: "h1" } };
      }
      return { tree: { id: "t", hash: "h1", nodes: [] }, importError: "bad yaml" };
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun?.executionId).toBe("exec-1");
    expect(state.enterpriseChatRunTree).toBeNull();
  });

  it("drops a response superseded by a session switch", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        clearEnterpriseChatRoute(state);
        return { runs: [runSummary("exec-mine", "agent:main:me")] };
      }
      throw new Error("runs.get must not be reached");
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun).toBeNull();
  });
});

describe("applyEnterpriseChatStep", () => {
  const SESSION = "agent:main:chat";
  const SESSION_ID = "transcript-1";
  // Stands in for the host's agent-aware matcher; the controller only asks.
  const matches =
    (viewKey: string) => (sessionKey: string | undefined, _agentId: string | undefined) =>
      sessionKey === viewKey;
  const inView = matches(SESSION);
  const validEvent = {
    runId: "run-1",
    executionId: "exec-1",
    sessionId: SESSION_ID,
    ts: 5_000,
    sessionKey: SESSION,
    nodeId: "research.gather",
    title: "Gather sources",
    ordinal: 2,
    total: 4,
    kind: "entered",
  };

  it("applies a well-formed step", () => {
    const { state } = createState();
    expect(applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent)).toBe(true);
    expect(state.enterpriseChatStep).toEqual({
      runId: "run-1",
      executionId: "exec-1",
      stamp: 5_000,
      nodeId: "research.gather",
      title: "Gather sources",
      ordinal: 2,
      total: 4,
      kind: "entered",
    });
  });

  it("falls back to the node id when the title is missing", () => {
    const { state } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, { ...validEvent, title: "" });
    expect(state.enterpriseChatStep?.title).toBe("research.gather");
  });

  it("treats any non-completed kind as entered", () => {
    const { state } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, { ...validEvent, kind: "bogus" });
    expect(state.enterpriseChatStep?.kind).toBe("entered");
  });

  // The wire is not trusted: a malformed event must leave the previous step
  // alone rather than paint a broken counter into the chat.
  it.each([
    ["not an object", "nope"],
    ["missing runId", { ...validEvent, runId: "" }],
    ["missing nodeId", { ...validEvent, nodeId: 123 }],
    ["non-positive total", { ...validEvent, total: 0 }],
    ["missing executionId", { ...validEvent, executionId: "" }],
    ["another session's run", { ...validEvent, sessionKey: "agent:main:other" }],
    ["a run with no session", { ...validEvent, sessionKey: undefined }],
    ["another agent's global run", { ...validEvent, sessionKey: "global", agentId: "other" }],
  ])("rejects %s", (_label, payload) => {
    const { state } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent);
    const before = state.enterpriseChatStep;
    expect(applyEnterpriseChatStep(state, inView, SESSION_ID, null, payload)).toBe(false);
    expect(state.enterpriseChatStep).toBe(before);
  });

  // A cron or subagent run broadcasts to every read client; adopting its steps
  // would overwrite the progress for the conversation actually on screen.
  it("keeps this session's step when another run reports progress", () => {
    const { state } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent);
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      runId: "cron-run",
      sessionKey: "agent:cron:nightly",
      nodeId: "cron.step",
      ordinal: 1,
    });
    expect(state.enterpriseChatStep?.nodeId).toBe("research.gather");
  });

  it("rejects every step when the view matches nothing", () => {
    const { state } = createState();
    expect(applyEnterpriseChatStep(state, matches(""), SESSION_ID, null, validEvent)).toBe(false);
    expect(state.enterpriseChatStep).toBeNull();
  });

  // A run that aborts or times out mid-route publishes no closing transition, so
  // the reload after the turn is what retires the chip.
  it("retires the live step once the session's newest run is no longer running", async () => {
    const { state, request } = createState();
    // The chip belongs to the run that then died, which is the case that matters.
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-dead",
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        // Terminal update lands after the chip's last event, as it must.
        return {
          runs: [{ ...runSummary("exec-dead", SESSION), status: "failed", updatedAt: 8_000 }],
        };
      }
      if (method === "enterprise.runs.get") {
        return { run: null };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toBeNull();
  });

  it("keeps a live step that is newer than the terminal run just listed", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-mine",
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-other", SESSION), status: "failed" }] };
      }
      if (method === "enterprise.runs.get") {
        return { run: null };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep?.executionId).toBe("exec-mine");
  });

  // A tab that disconnected across a run boundary: A's chip is still up, but B
  // started and finished meanwhile, so nothing in this session is live anymore.
  it("clears a chip superseded by a newer terminal run", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-a",
      ts: 1_000,
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return {
          runs: [{ ...runSummary("exec-b", SESSION), status: "completed", updatedAt: 9_000 }],
        };
      }
      if (method === "enterprise.runs.get") {
        return { run: null };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toBeNull();
  });

  // Step events are process-local: a run owned by `openclaw agent --local` or a
  // second gateway can never deliver its transitions (or its `ended`) here, so a
  // chip seeded from it would never move and never close.
  it("does not seed a running run owned by another process", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-foreign", SESSION), status: "running" }] };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-foreign", SESSION),
            status: "running",
            // No locallyActive: this gateway is not executing it.
            updatedAt: 9_000,
            activeNodeId: "a",
            events: [],
            nodes: [{ nodeId: "a", parentId: null, seq: 0, title: "First", ontology: {} }],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toBeNull();
  });

  it("drops a stale chip when the newest run is owned by another process", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, { ...validEvent, ts: 1_000 });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-foreign", SESSION), status: "running" }] };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-foreign", SESSION),
            status: "running",
            updatedAt: 9_000,
            activeNodeId: "a",
            events: [],
            nodes: [{ nodeId: "a", parentId: null, seq: 0, title: "First", ontology: {} }],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toBeNull();
  });

  // Reconnect holding A's chip; the list reports newer run B as running, but B
  // finishes before the detail call returns. B's `ended` is ignored (different
  // execution), so this is the only place A can be retired.
  it("clears an older chip when the detail comes back terminal", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-a",
      ts: 1_000,
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-b", SESSION), status: "running" }] };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-b", SESSION),
            status: "completed",
            updatedAt: 9_000,
            activeNodeId: "a",
            events: [],
            nodes: [{ nodeId: "a", parentId: null, seq: 0, title: "First", ontology: {} }],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toBeNull();
  });

  // Both clocks are millisecond Date.now(), so run B's first step can tie run A's
  // in-flight fetch. Across executions the pushed event wins: it happened after
  // this request went out.
  it("keeps a live step that ties a racing snapshot from another execution", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-b",
      nodeId: "b-step",
      ts: 5_000,
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-a", SESSION), status: "completed" }] };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-a", SESSION),
            status: "completed",
            updatedAt: 5_000,
            activeNodeId: "a",
            events: [],
            nodes: [{ nodeId: "a", parentId: null, seq: 0, title: "First", ontology: {} }],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep?.nodeId).toBe("b-step");
  });

  it("clears the chip when route loading fails", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent);
    request.mockImplementation(async () => {
      throw new Error("operator.read revoked");
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toBeNull();
  });

  it("keeps the live step while the run is still going", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent);
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return {
          runs: [{ ...runSummary("exec-live", SESSION), status: "running", updatedAt: 1_000 }],
        };
      }
      if (method === "enterprise.runs.get") {
        return { run: null };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep?.nodeId).toBe("research.gather");
  });

  // The feed publishes transitions only, so a client that joins or reconnects
  // mid-run has to read the current position out of the run detail instead.
  it("seeds the live step from a run already under way", async () => {
    const { state, request } = createState();
    const runDetail = {
      ...runSummary("exec-live", SESSION),
      status: "running",
      locallyActive: true,
      updatedAt: 9_000,
      treeName: "Ops",
      matchedBy: "planner",
      activeNodeId: "b",
      executionCount: 1,
      events: [],
      nodes: [
        { nodeId: "root", parentId: null, seq: 0, title: "Root", ontology: {} },
        { nodeId: "a", parentId: "root", seq: 1, title: "First", ontology: {} },
        { nodeId: "b", parentId: "root", seq: 2, title: "Second", ontology: {} },
      ],
    };
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return {
          runs: [{ ...runSummary("exec-live", SESSION), status: "running", updatedAt: 1_000 }],
        };
      }
      if (method === "enterprise.runs.get") {
        return { run: runDetail };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    // Leaves only: `root` is a parent, so the route is a -> b and b is step 2.
    expect(state.enterpriseChatStep).toMatchObject({
      nodeId: "b",
      title: "Second",
      ordinal: 2,
      total: 2,
      kind: "entered",
    });
  });

  it("keeps a live step that is newer than the fetched snapshot", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-live",
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return {
          runs: [{ ...runSummary("exec-live", SESSION), status: "running", updatedAt: 1_000 }],
        };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-live", SESSION),
            status: "running",
            locallyActive: true,
            updatedAt: 1_000,
            activeNodeId: "stale",
            events: [],
            nodes: [{ nodeId: "stale", parentId: null, seq: 0, title: "Stale", ontology: {} }],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    // The live event is newer than any snapshot of the run it belongs to.
    expect(state.enterpriseChatStep?.nodeId).toBe("research.gather");
  });

  // Offline across a run boundary: B's opening event was missed, so holding A's
  // position would strand the chip on a run that is already over.
  it("replaces a step left over from an older execution", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-old",
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return {
          runs: [{ ...runSummary("exec-new", SESSION), status: "running", updatedAt: 9_000 }],
        };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-new", SESSION),
            status: "running",
            locallyActive: true,
            updatedAt: 9_000,
            activeNodeId: "fresh",
            events: [],
            nodes: [{ nodeId: "fresh", parentId: null, seq: 0, title: "Fresh", ontology: {} }],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toMatchObject({
      executionId: "exec-new",
      nodeId: "fresh",
      ordinal: 1,
      total: 1,
    });
  });

  // Reconnect after a disconnect: transitions during the gap were never
  // delivered, so the snapshot is ahead and the chip has to catch up.
  it("refreshes a stale step for the same execution", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-live",
      nodeId: "a",
      ordinal: 1,
      ts: 1_000,
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-live", SESSION), status: "running" }] };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-live", SESSION),
            status: "running",
            locallyActive: true,
            updatedAt: 8_000,
            activeNodeId: "b",
            events: [{ seq: 1, kind: "node.entered", nodeId: "b", payload: {}, createdAt: 8_000 }],
            nodes: [
              { nodeId: "a", parentId: null, seq: 0, title: "First", ontology: {} },
              { nodeId: "b", parentId: null, seq: 1, title: "Second", ontology: {} },
            ],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toMatchObject({ nodeId: "b", ordinal: 2, total: 2 });
  });

  // The status can flip between the list call and the detail call; the detail is
  // the later observation and must win.
  it("clears progress when only the detail shows the run is over", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-live",
      ts: 1_000,
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-live", SESSION), status: "running" }] };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-live", SESSION),
            status: "failed",
            updatedAt: 8_000,
            activeNodeId: "a",
            events: [],
            nodes: [{ nodeId: "a", parentId: null, seq: 0, title: "First", ontology: {} }],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toBeNull();
  });

  // The cursor stays on the last node while the agent writes its answer, so the
  // trace, not the cursor, says whether the route finished.
  it("reports a finished route when the final node already completed", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-tail", SESSION), status: "running" }] };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-tail", SESSION),
            status: "running",
            locallyActive: true,
            updatedAt: 8_000,
            activeNodeId: "b",
            events: [
              { seq: 1, kind: "node.entered", nodeId: "b", payload: {}, createdAt: 7_000 },
              { seq: 2, kind: "node.completed", nodeId: "b", payload: {}, createdAt: 8_000 },
            ],
            nodes: [
              { nodeId: "a", parentId: null, seq: 0, title: "First", ontology: {} },
              { nodeId: "b", parentId: null, seq: 1, title: "Second", ontology: {} },
            ],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toMatchObject({ ordinal: 2, total: 2, kind: "completed" });
  });

  // The trace row is only re-persisted on `node.entered`, so a run whose final
  // step COMPLETED still reports the earlier enter as `updatedAt`. Judging
  // freshness on that alone would keep a stale chip that missed the completion.
  it("uses the newest event, not updatedAt, to judge snapshot freshness", async () => {
    const { state, request } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-tail",
      nodeId: "b",
      ordinal: 2,
      total: 2,
      ts: 7_500, // after the last `entered`, before the completion it never saw
    });
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.runs.list") {
        return { runs: [{ ...runSummary("exec-tail", SESSION), status: "running" }] };
      }
      if (method === "enterprise.runs.get") {
        return {
          run: {
            ...runSummary("exec-tail", SESSION),
            status: "running",
            locallyActive: true,
            updatedAt: 7_000, // stale: never advanced for the completion
            activeNodeId: "b",
            events: [
              { seq: 1, kind: "node.entered", nodeId: "b", payload: {}, createdAt: 7_000 },
              { seq: 2, kind: "node.completed", nodeId: "b", payload: {}, createdAt: 9_000 },
            ],
            nodes: [
              { nodeId: "a", parentId: null, seq: 0, title: "First", ontology: {} },
              { nodeId: "b", parentId: null, seq: 1, title: "Second", ontology: {} },
            ],
          },
        };
      }
      return {};
    });
    await loadEnterpriseChatRoute(state, SESSION);
    expect(state.enterpriseChatStep).toMatchObject({ kind: "completed", ordinal: 2, total: 2 });
  });

  // sessions.reset rotates the transcript UUID but keeps the session key, so the
  // key alone cannot tell the previous conversation's run from this one.
  // Overflow/compaction rotates a LIVE run's transcript, and the UI's own id lags
  // because history loading is deferred while a run is active.
  it("keeps following a run whose transcript rotated mid-run", () => {
    const { state } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent);
    expect(
      applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
        ...validEvent,
        sessionId: "transcript-rotated",
        nodeId: "next",
        ordinal: 2,
      }),
    ).toBe(true);
    expect(state.enterpriseChatStep?.nodeId).toBe("next");
  });

  // The freshness policy can rotate the transcript at chat.send, so the OPENING
  // step already carries an id the UI has not learned. Nothing is on screen yet,
  // so the run this tab started is the only thing that can vouch for it.
  it("accepts the opening step of a run this client started after rotation", () => {
    const { state } = createState();
    expect(
      applyEnterpriseChatStep(state, inView, SESSION_ID, "run-1", {
        ...validEvent,
        sessionId: "transcript-rotated-at-send",
      }),
    ).toBe(true);
    expect(state.enterpriseChatStep?.runId).toBe("run-1");
  });

  it("still rejects a rotated transcript for a run this client did not start", () => {
    const { state } = createState();
    expect(
      applyEnterpriseChatStep(state, inView, SESSION_ID, "some-other-run", {
        ...validEvent,
        sessionId: "transcript-2",
      }),
    ).toBe(false);
  });

  it("rejects a run from a rotated transcript", () => {
    const { state } = createState();
    expect(applyEnterpriseChatStep(state, inView, "transcript-2", null, validEvent)).toBe(false);
    expect(state.enterpriseChatStep).toBeNull();
  });

  // An older gateway sends no transcript id; matching on the key alone is then
  // the best available and must not regress to rejecting everything.
  it("still matches when the event carries no transcript id", () => {
    const { state } = createState();
    const { sessionId: _omitted, ...noTranscript } = validEvent;
    expect(applyEnterpriseChatStep(state, inView, SESSION_ID, null, noTranscript)).toBe(true);
  });

  // The only close signal for a route abandoned mid-step, or for a run started
  // by another tab or channel that this client never owned.
  it("clears its own run's progress on the terminal event", () => {
    const { state } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent);
    expect(
      applyEnterpriseChatStep(state, inView, SESSION_ID, null, { ...validEvent, kind: "ended" }),
    ).toBe(true);
    expect(state.enterpriseChatStep).toBeNull();
  });

  it("ignores a terminal event for a run it is not showing", () => {
    const { state } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent);
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, {
      ...validEvent,
      executionId: "exec-other",
      kind: "ended",
    });
    expect(state.enterpriseChatStep?.executionId).toBe("exec-1");
  });

  it("is cleared with the route card so a finished step never reads as current", () => {
    const { state } = createState();
    applyEnterpriseChatStep(state, inView, SESSION_ID, null, validEvent);
    clearEnterpriseChatRoute(state);
    expect(state.enterpriseChatStep).toBeNull();
  });
});
