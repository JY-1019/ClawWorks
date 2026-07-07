// Control UI tests cover enterprise inspection controller behavior.
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../gateway.ts";
import {
  type EnterpriseState,
  loadEnterprise,
  loadEnterpriseRunDetail,
  loadEnterpriseTreeDetail,
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
    enterpriseSelectedTreeId: null,
    enterpriseTreeDetail: null,
    enterpriseTreeLoading: false,
    enterpriseTreeIssue: null,
    enterpriseError: null,
  };
  return { state, request };
}

function treeDetail(id: string, source: "builtin" | "imported" = "imported") {
  return {
    id,
    version: "1.0.0",
    name: `Tree ${id}`,
    source,
    nodes: [
      {
        id: `${id}.root`,
        parentId: null,
        depth: 0,
        title: "Root",
        ontology: { entities: [{ id: "a" }], allowedTools: ["exec"] },
      },
    ],
  };
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

  it("also clears an open tree selection on a missing operator.read error", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "t";
    state.enterpriseTreeDetail = treeDetail("t");
    state.enterpriseTreeIssue = "stale issue";
    request.mockRejectedValue(
      new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
    );

    await loadEnterprise(state);

    expect(state.enterpriseSelectedTreeId).toBeNull();
    expect(state.enterpriseTreeDetail).toBeNull();
    expect(state.enterpriseTreeIssue).toBeNull();
  });
});

describe("loadEnterpriseTreeDetail", () => {
  it("loads a tree and clears any prior issue", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ tree: treeDetail("acme.support") });

    await loadEnterpriseTreeDetail(state, "acme.support");

    expect(state.enterpriseSelectedTreeId).toBe("acme.support");
    expect(state.enterpriseTreeDetail?.id).toBe("acme.support");
    expect(state.enterpriseTreeIssue).toBeNull();
    expect(state.enterpriseTreeLoading).toBe(false);
  });

  it("clears a stale global error banner on a successful tree load", async () => {
    const { state, request } = createState();
    // A prior transient failure (e.g. runs.get) left the banner set.
    state.enterpriseError = "gateway unavailable";
    request.mockResolvedValue({ tree: treeDetail("acme.support") });

    await loadEnterpriseTreeDetail(state, "acme.support");

    expect(state.enterpriseError).toBeNull();
    expect(state.enterpriseTreeDetail?.id).toBe("acme.support");
  });

  it("surfaces a load failure for a corrupt imported override (stale built-in returned)", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      tree: treeDetail("acme.support", "builtin"),
      importError: "definition_json invalid",
    });

    await loadEnterpriseTreeDetail(state, "acme.support");

    // The stale built-in still renders, but the override failure must be shown.
    expect(state.enterpriseTreeDetail?.source).toBe("builtin");
    expect(state.enterpriseTreeIssue).toBe("definition_json invalid");
  });

  it("prefers the store-unreadable error over a per-tree import error", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      tree: null,
      importError: "per-tree failure",
      storeError: "tree store unreadable",
    });

    await loadEnterpriseTreeDetail(state, "acme.support");

    expect(state.enterpriseTreeDetail).toBeNull();
    expect(state.enterpriseTreeIssue).toBe("tree store unreadable");
  });

  it("ignores a stale response after the tree selection changes mid-request", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    // Select A, then B before A resolves.
    const pendingA = loadEnterpriseTreeDetail(state, "tree-A");
    const pendingB = loadEnterpriseTreeDetail(state, "tree-B");
    expect(state.enterpriseSelectedTreeId).toBe("tree-B");

    // B (the latest) resolves first, then the stale A resolves LAST; without the
    // request-generation guard, A's response would clobber B's detail.
    resolvers[1]?.({ tree: treeDetail("tree-B") });
    resolvers[0]?.({ tree: treeDetail("tree-A") });
    await Promise.all([pendingA, pendingB]);

    expect(state.enterpriseSelectedTreeId).toBe("tree-B");
    expect(state.enterpriseTreeDetail?.id).toBe("tree-B");
    expect(state.enterpriseTreeLoading).toBe(false);
  });

  it("drops a stale tree response that resolves after operator.read is lost", async () => {
    const { state, request } = createState();
    let resolveTreeGet: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === "enterprise.trees.get") {
        return new Promise((resolve) => {
          resolveTreeGet = resolve;
        });
      }
      // A concurrent list refresh observes the downgraded token.
      return Promise.reject(
        new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
      );
    });

    // A tree click is in flight...
    const pendingTree = loadEnterpriseTreeDetail(state, "acme.support");
    expect(state.enterpriseSelectedTreeId).toBe("acme.support");

    // ...while a refresh/reconnect clears governed data on the scope loss.
    await loadEnterprise(state);
    expect(state.enterpriseSelectedTreeId).toBeNull();
    expect(state.enterpriseTreeDetail).toBeNull();

    // The stale tree response resolves last; it must NOT repopulate cleared data.
    resolveTreeGet?.({ tree: treeDetail("acme.support") });
    await pendingTree;

    expect(state.enterpriseTreeDetail).toBeNull();
    expect(state.enterpriseSelectedTreeId).toBeNull();
  });

  it("clears ALL governed data (runs, trees, detail) on a missing operator.read error", async () => {
    const { state, request } = createState();
    // Seed prior governed data plus an open run detail alongside the selection.
    state.enterpriseRuns = [runSummary("exec-1", "run-1")];
    state.enterpriseTrees = [{ id: "t", version: "1", name: "T", source: "builtin", nodeCount: 1 }];
    state.enterpriseSelectedExecutionId = "exec-1";
    state.enterpriseDetail = runDetail("exec-1", "run-1", "support");
    request.mockRejectedValue(
      new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
    );

    await loadEnterpriseTreeDetail(state, "acme.support");

    // A downgraded token must not leave any stale governed data on screen.
    expect(state.enterpriseRuns).toEqual([]);
    expect(state.enterpriseTrees).toEqual([]);
    expect(state.enterpriseSelectedExecutionId).toBeNull();
    expect(state.enterpriseDetail).toBeNull();
    expect(state.enterpriseSelectedTreeId).toBeNull();
    expect(state.enterpriseTreeDetail).toBeNull();
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

  it("reloads the currently open tree detail", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    const seen: string[] = [];
    request.mockImplementation(async (method) => {
      seen.push(method);
      if (method === "enterprise.runs.list") {
        return { runs: [] };
      }
      if (method === "enterprise.trees.list") {
        return { trees: [], importErrors: [] };
      }
      if (method === "enterprise.trees.get") {
        return { tree: treeDetail("acme.support") };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await refreshEnterprise(state);

    expect(seen).toContain("enterprise.trees.get");
    expect(state.enterpriseTreeDetail?.id).toBe("acme.support");
  });

  it("skips the detail reload when nothing is selected", async () => {
    const { state, request } = createState();
    mockListAndTrees(request);

    await refreshEnterprise(state);

    expect(request).not.toHaveBeenCalledWith("enterprise.runs.get", expect.anything());
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.get", expect.anything());
  });

  it("preserves a failed run-detail error instead of clearing it via the tree reload", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedExecutionId = "exec-1";
    state.enterpriseSelectedTreeId = "acme.support";
    // Lists succeed, the run-detail reload fails (non-auth), the tree would succeed.
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [] };
      }
      if (method === "enterprise.trees.list") {
        return { trees: [], importErrors: [] };
      }
      if (method === "enterprise.runs.get") {
        throw new Error("run detail unavailable");
      }
      if (method === "enterprise.trees.get") {
        return { tree: treeDetail("acme.support") };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await refreshEnterprise(state);

    // The run-detail banner must survive; the tree reload must not run and wipe it.
    expect(state.enterpriseError).toContain("run detail unavailable");
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.get", expect.anything());
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
