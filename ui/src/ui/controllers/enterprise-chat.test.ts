import { describe, expect, it, vi } from "vitest";
import {
  clearEnterpriseChatRoute,
  loadEnterpriseChatMode,
  loadEnterpriseChatRoute,
  markEnterpriseChatTurnStart,
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
    enterpriseChatRunBefore: null,
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
        expect(payload).toEqual({ limit: 1, sessionKey: "agent:main:me" });
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

  it("hides the previous run when this turn produced no governed run", async () => {
    // Enterprise switched off mid-thread: the turn traces nothing, so the newest
    // run is still the one already on screen. Identity, not timestamps — a
    // browser-vs-gateway clock comparison would misfire on any skew.
    const { state, request } = createState();
    state.enterpriseChatRun = {
      executionId: "exec-old",
    } as EnterpriseChatState["enterpriseChatRun"];
    markEnterpriseChatTurnStart(state);
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-old", "agent:main:me")] };
      }
      throw new Error("runs.get must not be reached for an unchanged run");
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun).toBeNull();
  });

  it("shows the route when the turn DID produce a new governed run", async () => {
    const { state, request } = createState();
    state.enterpriseChatRun = {
      executionId: "exec-old",
    } as EnterpriseChatState["enterpriseChatRun"];
    markEnterpriseChatTurnStart(state);
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-new", "agent:main:me")] };
      }
      return { run: { executionId: "exec-new", treeName: "T" } };
    });
    await loadEnterpriseChatRoute(state, "agent:main:me");
    expect(state.enterpriseChatRun?.executionId).toBe("exec-new");
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
