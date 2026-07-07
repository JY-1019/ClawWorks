// Control UI tests cover enterprise inspection controller behavior.
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../gateway.ts";
import {
  type EnterpriseState,
  loadEnterprise,
  loadEnterpriseRunDetail,
  refreshEnterprise,
} from "./enterprise.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function createState(): { state: EnterpriseState; request: ReturnType<typeof vi.fn<TestRequest>> } {
  const request = vi.fn<TestRequest>();
  const state: EnterpriseState = {
    client: { request } as unknown as EnterpriseState["client"],
    connected: true,
    enterpriseLoading: false,
    enterpriseRuns: [],
    enterpriseTrees: [],
    enterpriseImportErrors: [],
    enterpriseStoreError: null,
    enterpriseSelectedExecutionId: null,
    enterpriseDetail: null,
    enterpriseDetailLoading: false,
    enterpriseError: null,
  };
  return { state, request };
}

function runSummary(executionId: string, runId: string) {
  return {
    executionId,
    runId,
    treeId: "acme.support",
    treeVersion: "1.0.0",
    mode: "enforce",
    status: "completed" as const,
    requestSummary: "help",
    activeNodeId: "support",
    createdAt: 1,
    updatedAt: 2,
    endedAt: 2,
  };
}

function runDetail(executionId: string, runId: string, activeNodeId: string) {
  return {
    executionId,
    runId,
    sessionKey: null,
    agentId: null,
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    mode: "enforce",
    status: "completed" as const,
    matchedBy: "keywords",
    requestSummary: "help",
    activeNodeId,
    nodes: [],
    events: [],
    executionCount: 1,
    createdAt: 1,
    updatedAt: 2,
    endedAt: 2,
  };
}

function mockListAndTrees(request: ReturnType<typeof vi.fn<TestRequest>>) {
  request.mockImplementation(async (method) => {
    if (method === "enterprise.runs.list") {
      return { runs: [runSummary("exec-1", "run-1")] };
    }
    if (method === "enterprise.trees.list") {
      return {
        trees: [{ id: "t", version: "1", name: "T", source: "builtin", nodeCount: 1 }],
        importErrors: [{ treeId: "acme.broken", message: "corrupt row" }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
}

describe("loadEnterprise", () => {
  it("loads runs and the tree registry", async () => {
    const { state, request } = createState();
    mockListAndTrees(request);

    await loadEnterprise(state);

    expect(state.enterpriseRuns).toHaveLength(1);
    expect(state.enterpriseTrees).toHaveLength(1);
    // Import failures keep the failing treeId + message so operators can act.
    expect(state.enterpriseImportErrors).toEqual([
      { treeId: "acme.broken", message: "corrupt row" },
    ]);
    expect(state.enterpriseError).toBeNull();
    expect(state.enterpriseLoading).toBe(false);
  });

  it("clears prior data on a missing operator.read error", async () => {
    const { state, request } = createState();
    // Seed a prior successful load, plus an open detail selection.
    state.enterpriseRuns = [runSummary("exec-1", "run-1")];
    state.enterpriseTrees = [{ id: "t", version: "1", name: "T", source: "builtin", nodeCount: 1 }];
    state.enterpriseSelectedExecutionId = "exec-1";
    state.enterpriseDetail = runDetail("exec-1", "run-1", "support");
    request.mockRejectedValue(
      new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
    );

    await loadEnterprise(state);

    expect(state.enterpriseRuns).toEqual([]);
    expect(state.enterpriseTrees).toEqual([]);
    expect(state.enterpriseSelectedExecutionId).toBeNull();
    expect(state.enterpriseDetail).toBeNull();
    expect(state.enterpriseError).toContain("operator.read");
  });
});

describe("loadEnterpriseRunDetail", () => {
  it("ignores a stale response after the selection changes mid-request", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    // Select A, then B before A resolves.
    const pendingA = loadEnterpriseRunDetail(state, "exec-A");
    const pendingB = loadEnterpriseRunDetail(state, "exec-B");
    expect(state.enterpriseSelectedExecutionId).toBe("exec-B");

    // A resolves last; its response must not overwrite B's selection.
    resolvers[0]?.({ run: runDetail("exec-A", "run-1", "a") });
    resolvers[1]?.({ run: runDetail("exec-B", "run-2", "b") });
    await Promise.all([pendingA, pendingB]);

    expect(state.enterpriseSelectedExecutionId).toBe("exec-B");
    expect(state.enterpriseDetail?.executionId).toBe("exec-B");
    // The stale A response must not leave the loading indicator stuck.
    expect(state.enterpriseDetailLoading).toBe(false);
  });

  it("ignores an older same-run response that resolves after a newer one", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    // Two loads for the SAME execution id (double-click / refresh while in flight).
    const first = loadEnterpriseRunDetail(state, "exec-1");
    const second = loadEnterpriseRunDetail(state, "exec-1");

    // The newer request resolves first with the fresh snapshot, then the older
    // one resolves last and must not overwrite it (responses can reorder).
    resolvers[1]?.({ run: runDetail("exec-1", "run-1", "support.triage") });
    resolvers[0]?.({ run: runDetail("exec-1", "run-1", "support") });
    await Promise.all([first, second]);

    expect(state.enterpriseDetail?.activeNodeId).toBe("support.triage");
    expect(state.enterpriseDetailLoading).toBe(false);
  });
});

describe("refreshEnterprise", () => {
  it("reloads the list and the currently open run detail", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedExecutionId = "exec-1";
    const seen: string[] = [];
    request.mockImplementation(async (method) => {
      seen.push(method);
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-1", "run-1")] };
      }
      if (method === "enterprise.trees.list") {
        return { trees: [], importErrors: [] };
      }
      if (method === "enterprise.runs.get") {
        return { run: runDetail("exec-1", "run-1", "support") };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await refreshEnterprise(state);

    expect(seen).toContain("enterprise.runs.list");
    expect(seen).toContain("enterprise.runs.get");
    expect(state.enterpriseDetail?.executionId).toBe("exec-1");
  });

  it("skips the detail reload when nothing is selected", async () => {
    const { state, request } = createState();
    mockListAndTrees(request);

    await refreshEnterprise(state);

    expect(request).not.toHaveBeenCalledWith("enterprise.runs.get", expect.anything());
  });

  it("preserves a failed list-refresh error instead of clearing it via detail reload", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedExecutionId = "exec-1";
    // The list/tree refresh fails (non-auth); the detail fetch would succeed.
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.get") {
        return { run: runDetail("exec-1", "run-1", "support") };
      }
      throw new Error("gateway unavailable");
    });

    await refreshEnterprise(state);

    // The banner must survive; the detail reload must not run and wipe it.
    expect(state.enterpriseError).toContain("gateway unavailable");
    expect(request).not.toHaveBeenCalledWith("enterprise.runs.get", expect.anything());
  });
});
