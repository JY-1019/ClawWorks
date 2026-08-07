// Control UI tests cover enterprise inspection controller behavior.
import { describe, expect, it, vi } from "vitest";
import { GatewayNotConnectedError, GatewayRequestError } from "../gateway.ts";
import {
  beginAddEnterpriseNode,
  beginEditEnterpriseTree,
  beginNewEnterpriseTree,
  cancelAddEnterpriseNode,
  confirmEnterpriseTreeAction,
  editEnterpriseNodeDraft,
  type EnterpriseState,
  exportEnterpriseTree,
  loadEnterprise,
  loadEnterpriseCatalogs,
  loadEnterpriseRunDetail,
  loadEnterpriseTreeDetail,
  loadEnterpriseTreeVersion,
  loadEnterpriseTreeVersions,
  refreshEnterprise,
  requestRemoveEnterpriseTree,
  requestSaveEnterpriseTree,
  selectEnterpriseTree,
  setEnterpriseTreeEditContent,
  setEnterpriseTreeEditFormat,
  cancelEnterpriseBindingPicker,
  openEnterpriseBindingPicker,
  setEnterpriseBindingPickerCustom,
  beginEnterpriseMcpDraft,
  editEnterpriseMcpDraft,
  submitAddEnterpriseNode,
  submitEnterpriseMcpDraft,
  submitEnterpriseBindingPicker,
  toggleEnterpriseBindingPickerValue,
  toggleEnterpriseCapabilityGrants,
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
    enterpriseRunTree: null,
    enterpriseDetailLoading: false,
    enterpriseSelectedTreeId: null,
    enterpriseTreeDetail: null,
    enterpriseTreeLoading: false,
    enterpriseTreeIssue: null,
    enterpriseSelectedNodeId: null,
    enterpriseNodeObjectsEntity: null,
    enterpriseNodeObjects: [],
    enterpriseNodeObjectsLoading: false,
    enterpriseTreeEditing: false,
    enterpriseTreeEditTreeId: null,
    enterpriseTreeEditRevision: null,
    enterpriseTreeEditContent: "",
    enterpriseTreeEditFormat: "yaml",
    enterpriseTreeSaving: false,
    enterpriseTreeSaveIssues: null,
    enterpriseTreeSaveError: null,
    enterpriseTreeConfirm: null,
    enterpriseTreeVersions: [],
    enterpriseTreeVersionsLoading: false,
    enterpriseNodeDraft: null,
    enterpriseBindingPicker: null,
    enterpriseGuidanceDraft: null,
    enterpriseMcpDraft: null,
    enterpriseCatalogPhase: "unloaded",
    enterpriseCatalogErrors: { tools: null, skills: null, foundations: null },
    enterpriseCatalogAgentId: null,
    enterpriseToolGroups: [],
    enterpriseSkills: [],
    enterpriseFoundations: [],
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
    sessionKey: "agent:main:test",
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
    matchedBy: "planner",
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

  it("lets a newer list load supersede an in-flight one (post-mutation reload)", async () => {
    const { state, request } = createState();
    const stalled: Array<(value: unknown) => void> = [];
    // Load A: both requests hang (a tab-load/refresh still in flight).
    request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            stalled.push(resolve);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            stalled.push(resolve);
          }),
      );
    const loadA = loadEnterprise(state);

    // Load B (as after a save) must NOT be skipped, and applies the new tree.
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [] };
      }
      return {
        trees: [{ id: "new.tree", version: "1", name: "New", source: "imported", nodeCount: 1 }],
        importErrors: [],
      };
    });
    await loadEnterprise(state);
    expect(state.enterpriseTrees.map((entry) => entry.id)).toEqual(["new.tree"]);

    // The stale load A resolves last; it must not overwrite B's list.
    stalled.forEach((resolve) => resolve({ runs: [], trees: [], importErrors: [] }));
    await loadA;
    expect(state.enterpriseTrees.map((entry) => entry.id)).toEqual(["new.tree"]);
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

  it("drops an in-flight list load after a scope loss clears governed data", async () => {
    const { state } = createState();
    let resolveRuns: ((value: unknown) => void) | undefined;
    let resolveTrees: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: (method: string) => Promise<unknown> }).request = (
      method,
    ) => {
      if (method === "enterprise.runs.list") {
        return new Promise((resolve) => {
          resolveRuns = resolve;
        });
      }
      if (method === "enterprise.trees.list") {
        return new Promise((resolve) => {
          resolveTrees = resolve;
        });
      }
      // The export read observes the downgraded token.
      return Promise.reject(
        new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
      );
    };

    // A refresh's list load is in flight when an export read loses the scope.
    const listLoad = loadEnterprise(state);
    await exportEnterpriseTree(state, "acme.support", "yaml");
    expect(state.enterpriseError).toContain("operator.read");

    // The stale list load resolves last; it must not repopulate governed data.
    resolveRuns?.({ runs: [runSummary("exec-1", "run-1")] });
    resolveTrees?.({
      trees: [{ id: "t", version: "1", name: "T", source: "builtin", nodeCount: 1 }],
      importErrors: [],
    });
    await listLoad;

    expect(state.enterpriseRuns).toEqual([]);
    expect(state.enterpriseTrees).toEqual([]);
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

describe("loadEnterpriseRunDetail run tree", () => {
  const mocks = (params: { runHash?: string; liveHash?: string }) => async (method: string) => {
    if (method === "enterprise.runs.get") {
      return {
        run: {
          ...runDetail("exec-1", "run-1", "support"),
          ...(params.runHash ? { treeHash: params.runHash } : {}),
        },
      };
    }
    if (method === "enterprise.trees.get") {
      return {
        tree: {
          id: "acme.support",
          version: "1.0.0",
          hash: params.liveHash,
          name: "S",
          source: "imported",
          nodes: [],
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  };

  it("shows the tree when its CONTENT is the definition the run planned against", async () => {
    const { state, request } = createState();
    request.mockImplementation(mocks({ runHash: "abc", liveHash: "abc" }));
    await loadEnterpriseRunDetail(state, "exec-1");
    await vi.waitFor(() => expect(state.enterpriseRunTree).not.toBeNull());
  });

  it("withholds the tree when the live definition differs, even at the same version", async () => {
    // A re-import at the same version, or removing an imported override to reveal
    // a different built-in: the version matches but the nodes are not the run's.
    const { state, request } = createState();
    request.mockImplementation(mocks({ runHash: "abc", liveHash: "xyz" }));
    await loadEnterpriseRunDetail(state, "exec-1");
    expect(state.enterpriseDetail).not.toBeNull();
    expect(state.enterpriseRunTree).toBeNull();
  });

  it("withholds the tree for a run traced before hashes existed", async () => {
    const { state, request } = createState();
    request.mockImplementation(mocks({ liveHash: "abc" }));
    await loadEnterpriseRunDetail(state, "exec-1");
    expect(state.enterpriseRunTree).toBeNull();
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

function treeWithObjectEntity(id: string, entityId: string) {
  return {
    id,
    version: "1.0.0",
    name: `Tree ${id}`,
    source: "imported" as const,
    nodes: [
      {
        id: `${id}.root`,
        parentId: null,
        depth: 0,
        title: "Root",
        ontology: {
          entities: [{ id: entityId, properties: [{ id: "cid", type: "id", primaryKey: true }] }],
        },
      },
    ],
  };
}

function objectRow(objectId: string) {
  return { objectId, properties: { cid: objectId }, provenance: "seed" as const, updatedAt: 1 };
}

// All request mocks below are pre-resolved, so a few microtask ticks flush the
// fire-and-forget objects.list the reconcile kicks off after the tree renders.
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("loadEnterpriseTreeDetail node-selection reconcile", () => {
  it("reloads the selected node's instances when the same tree is refreshed", async () => {
    const { state, request } = createState();
    const nodeId = "acme.support.root";
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseSelectedNodeId = nodeId;
    state.enterpriseNodeObjectsEntity = "claim";
    state.enterpriseNodeObjects = [objectRow("old-1")];
    request.mockImplementation((method) => {
      if (method === "enterprise.trees.get") {
        return Promise.resolve({ tree: treeWithObjectEntity("acme.support", "claim") });
      }
      return Promise.resolve({ objects: [objectRow("fresh-1")] });
    });

    await loadEnterpriseTreeDetail(state, "acme.support");
    await flushMicrotasks();

    // Node survives the re-import, so the operator's chosen type stays selected
    // but its rows are re-fetched — the stale "old-1" must be gone.
    expect(state.enterpriseSelectedNodeId).toBe(nodeId);
    expect(state.enterpriseNodeObjectsEntity).toBe("claim");
    expect(state.enterpriseNodeObjects.map((object) => object.objectId)).toEqual(["fresh-1"]);
  });

  it("drops the node selection when a refresh removes the selected node", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    // Selected node is absent from the reloaded tree (only *.root survives).
    state.enterpriseSelectedNodeId = "acme.support.gone";
    state.enterpriseNodeObjectsEntity = "claim";
    state.enterpriseNodeObjects = [objectRow("old-1")];
    request.mockResolvedValue({ tree: treeWithObjectEntity("acme.support", "claim") });

    await loadEnterpriseTreeDetail(state, "acme.support");
    await flushMicrotasks();

    expect(state.enterpriseSelectedNodeId).toBeNull();
    expect(state.enterpriseNodeObjectsEntity).toBeNull();
    expect(state.enterpriseNodeObjects).toEqual([]);
    // A vanished node needs no instance fetch.
    expect(request).not.toHaveBeenCalledWith("enterprise.objects.list", expect.anything());
  });

  it("drops the selection when a different tree opens, even on a shared node id", async () => {
    const { state, request } = createState();
    // Prior tree had node "acme.a.root" selected; the newly opened tree also has
    // a "*.root" node, but the selection must NOT carry across.
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseSelectedNodeId = "acme.a.root";
    state.enterpriseNodeObjectsEntity = "claim";
    state.enterpriseNodeObjects = [objectRow("old-1")];
    request.mockResolvedValue({ tree: treeWithObjectEntity("acme.b", "claim") });

    // A save/import flow opens a different tree directly (not via selectEnterpriseTree).
    await loadEnterpriseTreeDetail(state, "acme.b");
    await flushMicrotasks();

    expect(state.enterpriseSelectedNodeId).toBeNull();
    expect(state.enterpriseNodeObjects).toEqual([]);
    expect(request).not.toHaveBeenCalledWith("enterprise.objects.list", expect.anything());
  });

  it("clears the selection eagerly when a tree switch fails to load", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseSelectedNodeId = "acme.a.root";
    state.enterpriseNodeObjects = [objectRow("old-1")];
    request.mockRejectedValue(new Error("network down"));

    // The load fails, but the selection must already be gone: it was cleared
    // before the request so a retry can't mistake a shared id for a same-tree hit.
    await loadEnterpriseTreeDetail(state, "acme.b");

    expect(state.enterpriseSelectedTreeId).toBe("acme.b");
    expect(state.enterpriseSelectedNodeId).toBeNull();
    expect(state.enterpriseNodeObjects).toEqual([]);
  });

  it("does not reconcile a same-tree refresh that returns a non-authoritative fallback", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseSelectedNodeId = "acme.support.root";
    state.enterpriseNodeObjectsEntity = "claim";
    state.enterpriseNodeObjects = [objectRow("old-1")];
    // The override failed to parse: the store returns a stale built-in fallback,
    // whose ontology may not match the selection, so rows must not auto-load.
    request.mockResolvedValue({
      tree: treeWithObjectEntity("acme.support", "claim"),
      importError: "definition_json invalid",
    });

    await loadEnterpriseTreeDetail(state, "acme.support");
    await flushMicrotasks();

    expect(state.enterpriseSelectedNodeId).toBeNull();
    expect(state.enterpriseNodeObjects).toEqual([]);
    expect(request).not.toHaveBeenCalledWith("enterprise.objects.list", expect.anything());
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

describe("enterprise tree editing", () => {
  it("selectEnterpriseTree loads detail + history and clears a prior edit", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "stale edit";
    request.mockImplementation(async (method) => {
      if (method === "enterprise.trees.get") {
        return { tree: treeDetail("acme.support") };
      }
      if (method === "enterprise.trees.history.list") {
        return {
          versions: [
            { revision: 1, version: "1.0.0", name: "T", sourceFormat: "yaml", savedAt: 1 },
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    selectEnterpriseTree(state, "acme.support");
    await Promise.resolve();
    await Promise.resolve();

    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseTreeEditContent).toBe("");
    expect(state.enterpriseSelectedTreeId).toBe("acme.support");
  });

  it("beginEditEnterpriseTree seeds the editor from the tree export", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    request.mockResolvedValue({ content: "id: acme.support\n", source: "imported" });

    await beginEditEnterpriseTree(state);

    expect(request).toHaveBeenCalledWith("enterprise.trees.export", {
      treeId: "acme.support",
      format: "yaml",
    });
    expect(state.enterpriseTreeEditContent).toBe("id: acme.support\n");
    expect(state.enterpriseTreeEditing).toBe(true);
  });

  it("confirms a save: imports, exits edit mode, and reloads the saved tree", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "id: acme.support\n";
    const seen: string[] = [];
    request.mockImplementation(async (method) => {
      seen.push(method);
      if (method === "enterprise.trees.import") {
        return { ok: true, treeId: "acme.support", replaced: null };
      }
      if (method === "enterprise.runs.list") {
        return { runs: [] };
      }
      if (method === "enterprise.trees.list") {
        return { trees: [], importErrors: [] };
      }
      if (method === "enterprise.trees.get") {
        return { tree: treeDetail("acme.support") };
      }
      if (method === "enterprise.trees.history.list") {
        return { versions: [] };
      }
      throw new Error(`unexpected ${method}`);
    });

    requestSaveEnterpriseTree(state);
    expect(state.enterpriseTreeConfirm).toEqual({ kind: "save" });
    await confirmEnterpriseTreeAction(state);

    expect(seen).toContain("enterprise.trees.import");
    expect(state.enterpriseTreeConfirm).toBeNull();
    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseTreeSaving).toBe(false);
    expect(state.enterpriseTreeDetail?.id).toBe("acme.support");
  });

  it("preserves a failed list reload after a save instead of hiding it", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "id: acme.support\n";
    request.mockImplementation(async (method) => {
      if (method === "enterprise.trees.import") {
        return { ok: true, treeId: "acme.support", replaced: null };
      }
      if (method === "enterprise.runs.list" || method === "enterprise.trees.list") {
        throw new Error("list unavailable");
      }
      return { tree: treeDetail("acme.support") };
    });

    requestSaveEnterpriseTree(state);
    await confirmEnterpriseTreeAction(state);

    // The list-reload error must survive; opening the saved tree would clear it.
    expect(state.enterpriseError).toContain("list unavailable");
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.get", expect.anything());
  });

  it("clears stale validation errors when a new-tree draft switches format", async () => {
    const { state } = createState();
    beginNewEnterpriseTree(state);
    state.enterpriseTreeSaveError = "old error";
    state.enterpriseTreeSaveIssues = [{ path: "root", message: "bad" }];

    await setEnterpriseTreeEditFormat(state, "json");

    // The regenerated template must not keep diagnostics for content it replaced.
    expect(state.enterpriseTreeSaveError).toBeNull();
    expect(state.enterpriseTreeSaveIssues).toBeNull();
  });

  it("keeps the editor open and surfaces issues when the definition is invalid", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "{ bad";
    request.mockResolvedValue({
      ok: false,
      issues: [{ path: "root", message: "required" }],
    });

    requestSaveEnterpriseTree(state);
    await confirmEnterpriseTreeAction(state);

    // Invalid content is not a request failure; the editor stays open with issues.
    expect(state.enterpriseTreeEditing).toBe(true);
    expect(state.enterpriseTreeSaveIssues).toEqual([{ path: "root", message: "required" }]);
    expect(state.enterpriseTreeSaving).toBe(false);
  });

  it("confirms a remove: clears the selection and reloads the registry", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    const seen: string[] = [];
    request.mockImplementation(async (method) => {
      seen.push(method);
      if (method === "enterprise.trees.remove") {
        return { removed: true };
      }
      if (method === "enterprise.runs.list") {
        return { runs: [] };
      }
      if (method === "enterprise.trees.list") {
        return { trees: [], importErrors: [] };
      }
      throw new Error(`unexpected ${method}`);
    });

    requestRemoveEnterpriseTree(state, "acme.support");
    expect(state.enterpriseTreeConfirm).toEqual({ kind: "remove", treeId: "acme.support" });
    await confirmEnterpriseTreeAction(state);

    expect(seen).toContain("enterprise.trees.remove");
    expect(state.enterpriseSelectedTreeId).toBeNull();
    expect(state.enterpriseTreeDetail).toBeNull();
  });

  it("loadEnterpriseTreeVersion loads a revision into the editor to restore", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ content: "id: acme.support\nversion: 1.0.0\n" });

    await loadEnterpriseTreeVersion(state, "acme.support", 1);

    expect(request).toHaveBeenCalledWith("enterprise.trees.history.get", {
      treeId: "acme.support",
      revision: 1,
      format: "yaml",
    });
    expect(state.enterpriseTreeEditContent).toContain("version: 1.0.0");
    expect(state.enterpriseTreeEditing).toBe(true);
  });

  it("seeds the new-tree template with an explicit trigger scope", async () => {
    const { state } = createState();
    await setEnterpriseTreeEditFormat(state, "json"); // prefer JSON so we can parse it
    beginNewEnterpriseTree(state);
    const parsed = JSON.parse(state.enterpriseTreeEditContent) as {
      match?: { triggers?: string[] };
    };
    // Saving imports the tree, and imported work-maps govern runs. `triggers` is
    // the deterministic gate the model cannot override, so the template must
    // pin it rather than leave a half-finished draft open to system runs.
    expect(parsed.match?.triggers).toEqual(["user"]);
  });

  it("regenerates the template (not a stale export) when a new-tree format switches", async () => {
    const { state, request } = createState();
    // A prior selection must not leak into a new-tree draft on format switch.
    state.enterpriseSelectedTreeId = "acme.other";
    beginNewEnterpriseTree(state);
    expect(state.enterpriseTreeEditTreeId).toBeNull();
    expect(state.enterpriseTreeEditContent).toContain("schema: clawworks.workflow-tree");

    await setEnterpriseTreeEditFormat(state, "json");

    // The editor now holds a JSON template, not an export of acme.other.
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.export", expect.anything());
    expect(state.enterpriseTreeEditContent.trimStart().startsWith("{")).toBe(true);
    expect(state.enterpriseTreeEditContent).toContain('"schema": "clawworks.workflow-tree"');
  });

  it("keeps the selection and warns when remove reports nothing was removed", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "clawworks.assist";
    state.enterpriseTreeDetail = treeDetail("clawworks.assist", "builtin");
    request.mockResolvedValue({ removed: false });

    requestRemoveEnterpriseTree(state, "clawworks.assist");
    await confirmEnterpriseTreeAction(state);

    // A built-in cannot be removed; the selection stays and the id is unaffected.
    expect(state.enterpriseSelectedTreeId).toBe("clawworks.assist");
    expect(state.enterpriseTreeDetail).not.toBeNull();
    expect(state.enterpriseTreeIssue).toContain("clawworks.assist");
  });

  it("re-fetches the historical revision (not export) when a history draft switches format", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ content: "id: acme.support\nversion: 1.0.0\n" });
    await loadEnterpriseTreeVersion(state, "acme.support", 2);
    expect(state.enterpriseTreeEditRevision).toBe(2);

    const calls: Array<{ method: string; params: unknown }> = [];
    request.mockImplementation(async (method, params) => {
      calls.push({ method, params });
      return { content: '{"id":"acme.support"}' };
    });

    await setEnterpriseTreeEditFormat(state, "json");

    // A history draft must reload that revision, not silently swap in the live tree.
    expect(calls.map((entry) => entry.method)).toEqual(["enterprise.trees.history.get"]);
    expect(calls[0]?.params).toEqual({ treeId: "acme.support", revision: 2, format: "json" });
  });

  it("keeps format and content in sync when a format-switch reseed fails", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    request.mockResolvedValueOnce({ content: "id: acme.support\n", source: "imported" });
    await beginEditEnterpriseTree(state);
    expect(state.enterpriseTreeEditFormat).toBe("yaml");

    // The JSON reseed export fails.
    request.mockResolvedValueOnce({ content: null, reason: "export unavailable" });
    await setEnterpriseTreeEditFormat(state, "json");

    // Format must not flip to json while the content is still YAML — otherwise
    // Save would import YAML text as JSON.
    expect(state.enterpriseTreeEditFormat).toBe("yaml");
    expect(state.enterpriseTreeEditContent).toBe("id: acme.support\n");
    expect(state.enterpriseTreeSaveError).toContain("export unavailable");
  });

  it("clears a stale export error after a successful export", async () => {
    const { state, request } = createState();
    state.enterpriseTreeSaveError = "previous export failed";
    request.mockResolvedValue({ content: "id: acme.support\n", source: "imported" });
    // jsdom does not implement object URLs; stub them + the anchor click so the
    // download path is a no-op for this assertion.
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:mock", configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      await exportEnterpriseTree(state, "acme.support", "yaml");
      expect(state.enterpriseTreeSaveError).toBeNull();
    } finally {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
      clickSpy.mockRestore();
    }
  });

  it("keeps user typing over a late format-switch reseed", async () => {
    const { state } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.support";
    let resolveExport: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: () => Promise<unknown> }).request = () =>
      new Promise((resolve) => {
        resolveExport = resolve;
      });

    // Start a format switch (its export is in flight)...
    const pending = setEnterpriseTreeEditFormat(state, "json");
    // ...then the operator types before it resolves.
    setEnterpriseTreeEditContent(state, "user typed content");

    resolveExport?.({ content: "reseeded content", source: "imported" });
    await pending;

    // The user's newer text must not be clobbered by the stale reseed.
    expect(state.enterpriseTreeEditContent).toBe("user typed content");
  });

  it("cancels a pending reseed when the current format is re-selected", async () => {
    const { state } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.support";
    state.enterpriseTreeEditContent = "id: acme.support\n"; // yaml
    let resolveExport: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: () => Promise<unknown> }).request = () =>
      new Promise((resolve) => {
        resolveExport = resolve;
      });

    // Switch to JSON (reseed in flight; format only flips once it lands)...
    const pending = setEnterpriseTreeEditFormat(state, "json");
    // ...then re-select YAML (still the current format) before it resolves.
    await setEnterpriseTreeEditFormat(state, "yaml");

    resolveExport?.({ content: '{"id":"acme.support"}', source: "imported" });
    await pending;

    // The stale JSON reseed must not override the operator staying on YAML.
    expect(state.enterpriseTreeEditFormat).toBe("yaml");
    expect(state.enterpriseTreeEditContent).toBe("id: acme.support\n");
  });

  it("cancels a pending reseed when Save is clicked so it cannot swap the submitted content", async () => {
    const { state } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.a";
    state.enterpriseTreeEditContent = "id: acme.a\n"; // the draft being submitted
    let resolveExport: ((value: unknown) => void) | undefined;
    let resolveImport: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: (method: string) => Promise<unknown> }).request = (
      method,
    ) => {
      if (method === "enterprise.trees.export") {
        return new Promise((resolve) => {
          resolveExport = resolve;
        });
      }
      if (method === "enterprise.trees.import") {
        return new Promise((resolve) => {
          resolveImport = resolve;
        });
      }
      if (method === "enterprise.runs.list") {
        return Promise.resolve({ runs: [] });
      }
      return Promise.resolve({ trees: [], importErrors: [] });
    };

    // A format-switch reseed is in flight...
    const reseed = setEnterpriseTreeEditFormat(state, "json");
    // ...then the operator saves before it resolves.
    requestSaveEnterpriseTree(state);
    const savePending = confirmEnterpriseTreeAction(state);

    // The stale reseed resolves; it must not replace the submitted content.
    resolveExport?.({ content: "reseeded json content", source: "imported" });
    await reseed;
    expect(state.enterpriseTreeEditContent).toBe("id: acme.a\n");

    resolveImport?.({ ok: true, treeId: "acme.a", replaced: null });
    await savePending;
  });

  it("does not clobber a newer draft when a slow save completes", async () => {
    const { state } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "id: acme.a\n";
    let resolveImport: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: (method: string) => Promise<unknown> }).request = (
      method,
    ) => {
      if (method === "enterprise.trees.import") {
        return new Promise((resolve) => {
          resolveImport = resolve;
        });
      }
      if (method === "enterprise.runs.list") {
        return Promise.resolve({ runs: [] });
      }
      return Promise.resolve({ trees: [], importErrors: [] });
    };

    requestSaveEnterpriseTree(state);
    const pending = confirmEnterpriseTreeAction(state); // import in flight
    // The operator starts a new draft during the save.
    beginNewEnterpriseTree(state);

    resolveImport?.({ ok: true, treeId: "acme.a", replaced: null });
    await pending;

    // The older save must not reset/reopen over the new-tree draft.
    expect(state.enterpriseTreeEditing).toBe(true);
    expect(state.enterpriseTreeEditTreeId).toBeNull();
    expect(state.enterpriseTreeEditContent).toContain("schema: clawworks.workflow-tree");
  });

  it("keeps a selection started during the post-save registry reload", async () => {
    const { state } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "id: acme.a\n";
    let resolveRuns: ((value: unknown) => void) | undefined;
    let resolveTrees: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: (method: string) => Promise<unknown> }).request = (
      method,
    ) => {
      if (method === "enterprise.trees.import") {
        return Promise.resolve({ ok: true, treeId: "acme.a", replaced: null });
      }
      if (method === "enterprise.runs.list") {
        return new Promise((resolve) => {
          resolveRuns = resolve;
        });
      }
      if (method === "enterprise.trees.list") {
        return new Promise((resolve) => {
          resolveTrees = resolve;
        });
      }
      if (method === "enterprise.trees.get") {
        return Promise.resolve({ tree: treeDetail("other.tree") });
      }
      return Promise.resolve({ versions: [] });
    };
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
    };

    requestSaveEnterpriseTree(state);
    const pending = confirmEnterpriseTreeAction(state);
    await flush(); // the save reaches the (hanging) registry reload
    // The operator selects another tree during that reload.
    selectEnterpriseTree(state, "other.tree");
    await flush();
    resolveRuns?.({ runs: [] });
    resolveTrees?.({ trees: [], importErrors: [] });
    await pending;

    // The operator's selection must win; the save must not reopen acme.a.
    expect(state.enterpriseSelectedTreeId).toBe("other.tree");
  });

  it("does not clear a newer selection when a slow remove of another tree resolves", async () => {
    const { state } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeDetail = treeDetail("acme.a");
    let resolveRemove: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: (method: string) => Promise<unknown> }).request = (
      method,
    ) => {
      if (method === "enterprise.trees.remove") {
        return new Promise((resolve) => {
          resolveRemove = resolve;
        });
      }
      if (method === "enterprise.trees.get") {
        return Promise.resolve({ tree: treeDetail("acme.b") });
      }
      if (method === "enterprise.trees.history.list") {
        return Promise.resolve({ versions: [] });
      }
      return Promise.resolve({ runs: [] });
    };

    requestRemoveEnterpriseTree(state, "acme.a");
    const pending = confirmEnterpriseTreeAction(state); // remove in flight
    // The operator selects tree B while A's remove is still pending.
    selectEnterpriseTree(state, "acme.b");
    expect(state.enterpriseSelectedTreeId).toBe("acme.b");

    resolveRemove?.({ removed: true });
    await pending;

    // B's selection must survive; the slow remove of A must not clear it.
    expect(state.enterpriseSelectedTreeId).toBe("acme.b");
  });

  it("keeps an unrelated tree's editor when removing a corrupt row from the banner", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeDetail = treeDetail("acme.a");
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.a";
    state.enterpriseTreeEditContent = "unsaved draft";
    request.mockImplementation(async (method) => {
      if (method === "enterprise.trees.remove") {
        return { removed: true };
      }
      if (method === "enterprise.runs.list") {
        return { runs: [] };
      }
      return { trees: [], importErrors: [] };
    });

    requestRemoveEnterpriseTree(state, "corrupt.b");
    await confirmEnterpriseTreeAction(state);

    // Removing corrupt.b must not discard the unsaved draft for acme.a.
    expect(state.enterpriseSelectedTreeId).toBe("acme.a");
    expect(state.enterpriseTreeEditing).toBe(true);
    expect(state.enterpriseTreeEditContent).toBe("unsaved draft");
  });

  it("drops a stale editor seed when a newer edit intent supersedes it", async () => {
    const { state } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    let resolveExport: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: () => Promise<unknown> }).request = () =>
      new Promise((resolve) => {
        resolveExport = resolve;
      });

    const pending = beginEditEnterpriseTree(state); // A's export is in flight
    beginNewEnterpriseTree(state); // a newer intent supersedes it

    resolveExport?.({ content: "id: acme.a\n", source: "imported" });
    await pending;

    // The stale export of A must not overwrite the new-tree template.
    expect(state.enterpriseTreeEditTreeId).toBeNull();
    expect(state.enterpriseTreeEditContent).toContain("schema: clawworks.workflow-tree");
  });

  it("clears all governed data when history-list is the first read to lose operator.read", async () => {
    const { state, request } = createState();
    state.enterpriseRuns = [runSummary("exec-1", "run-1")];
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockRejectedValue(
      new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
    );

    await loadEnterpriseTreeVersions(state, "acme.support");

    expect(state.enterpriseRuns).toEqual([]);
    expect(state.enterpriseSelectedTreeId).toBeNull();
    expect(state.enterpriseTreeDetail).toBeNull();
    expect(state.enterpriseError).toContain("operator.read");
  });

  it("routes an export scope failure through applyError, not the editor banner", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockRejectedValue(
      new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
    );

    await exportEnterpriseTree(state, "acme.support", "yaml");

    expect(state.enterpriseSelectedTreeId).toBeNull();
    expect(state.enterpriseError).toContain("operator.read");
    // The scope loss cleared governed data; no stale editor error is left behind.
    expect(state.enterpriseTreeSaveError).toBeNull();
  });

  it("clears the prior tree's revisions when a new history load starts", async () => {
    const { state } = createState();
    state.enterpriseTreeVersions = [
      { revision: 3, version: "3.0.0", name: "A", sourceFormat: "yaml", savedAt: 3 },
    ];
    // A never-resolving request leaves the load in flight.
    (state.client as unknown as { request: () => Promise<unknown> }).request = () =>
      new Promise(() => {});

    void loadEnterpriseTreeVersions(state, "acme.b");

    // The stale list is dropped immediately so the panel shows loading, not A's.
    expect(state.enterpriseTreeVersions).toEqual([]);
    expect(state.enterpriseTreeVersionsLoading).toBe(true);
  });
});

// The nested definition enterprise.trees.export serializes; its root id matches
// the flat detail node id treeDetail() builds ("<treeId>.root").
function supportExportContent(): string {
  return JSON.stringify({
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "acme.support",
    version: "1.0.0",
    name: "Support",
    root: {
      id: "acme.support.root",
      title: "Root",
      ontology: { entities: [{ id: "a" }] },
    },
  });
}

describe("add child node (P5)", () => {
  it("beginAddEnterpriseNode opens a draft scoped to the current tree", () => {
    const { state } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginAddEnterpriseNode(state, "acme.support.root");
    expect(state.enterpriseNodeDraft).toEqual({
      treeId: "acme.support",
      parentId: "acme.support.root",
      id: "",
      title: "",
      error: null,
    });
  });

  it("does not open a draft when no tree is loaded", () => {
    const { state } = createState();
    beginAddEnterpriseNode(state, "acme.support.root");
    expect(state.enterpriseNodeDraft).toBeNull();
  });

  it("clears an open draft when the operator switches trees", () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockResolvedValue({ tree: treeDetail("acme.other") });
    beginAddEnterpriseNode(state, "acme.support.root");
    selectEnterpriseTree(state, "acme.other");
    expect(state.enterpriseNodeDraft).toBeNull();
  });

  it("editing the draft updates fields and clears a prior error", () => {
    const { state } = createState();
    state.enterpriseNodeDraft = {
      treeId: "acme.support",
      parentId: "acme.support.root",
      id: "bad id",
      title: "",
      error: "id-pattern",
    };
    editEnterpriseNodeDraft(state, { id: "acme.support.step" });
    expect(state.enterpriseNodeDraft).toMatchObject({ id: "acme.support.step", error: null });
    editEnterpriseNodeDraft(state, { title: "Step" });
    expect(state.enterpriseNodeDraft?.title).toBe("Step");
  });

  it("cancel clears the draft", () => {
    const { state } = createState();
    beginAddEnterpriseNode(state, "acme.support.root");
    cancelAddEnterpriseNode(state);
    expect(state.enterpriseNodeDraft).toBeNull();
  });

  it("splices the child into a fresh export and loads it into the editor", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockResolvedValue({ content: supportExportContent() });
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.resolve" });
    editEnterpriseNodeDraft(state, { title: "Resolve" });

    await submitAddEnterpriseNode(state);

    // It re-exported the canonical definition as JSON, not the lossy flat detail.
    expect(request).toHaveBeenCalledWith("enterprise.trees.export", {
      treeId: "acme.support",
      format: "json",
    });
    // The draft closed and the editor opened on the spliced definition.
    expect(state.enterpriseNodeDraft).toBeNull();
    expect(state.enterpriseTreeEditing).toBe(true);
    expect(state.enterpriseTreeEditFormat).toBe("json");
    const parsed = JSON.parse(state.enterpriseTreeEditContent);
    expect(parsed.root.children).toEqual([{ id: "acme.support.resolve", title: "Resolve" }]);
    // The operator has not saved yet — no import happened.
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.import", expect.anything());
  });

  it("rejects an invalid id in the form without re-exporting", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "Bad Id", title: "X" });

    await submitAddEnterpriseNode(state);

    expect(state.enterpriseNodeDraft?.error).toBe("id-pattern");
    expect(state.enterpriseTreeEditing).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a duplicate id (already a node in the tree)", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.root", title: "X" });

    await submitAddEnterpriseNode(state);

    expect(state.enterpriseNodeDraft?.error).toBe("id-duplicate");
    expect(request).not.toHaveBeenCalled();
  });

  it("requires a title", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.resolve", title: "   " });

    await submitAddEnterpriseNode(state);

    expect(state.enterpriseNodeDraft?.error).toBe("title-empty");
    expect(request).not.toHaveBeenCalled();
  });

  it("surfaces an export failure in the form", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockResolvedValue({ content: null, reason: "unavailable" });
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.resolve", title: "Resolve" });

    await submitAddEnterpriseNode(state);

    expect(state.enterpriseNodeDraft?.error).toBe("export-failed");
    expect(state.enterpriseTreeEditing).toBe(false);
  });

  it("abandons a submit whose form was edited during the slow export", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let resolveExport: ((value: unknown) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
    );
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.resolve" });
    editEnterpriseNodeDraft(state, { title: "Resolve" });

    const pending = submitAddEnterpriseNode(state);
    // The operator keeps typing while the export is still in flight.
    editEnterpriseNodeDraft(state, { title: "Renamed" });
    resolveExport?.({ content: supportExportContent() });
    await pending;

    // The stale submit must not close the form or seed the editor with old values.
    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseNodeDraft?.title).toBe("Renamed");
  });
});

describe("enterprise binding picker (tool grants / declared skills)", () => {
  const exportThenImport = (request: ReturnType<typeof createState>["request"]) => {
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        return { ok: true, treeId: "acme.support" };
      }
      return {};
    });
  };

  it("applies the picked tool grants directly, without routing through the editor", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    exportThenImport(request);
    openEnterpriseBindingPicker(state, "acme.support.root", "allowedTools");
    toggleEnterpriseBindingPickerValue(state, "group:enterprise");

    await submitEnterpriseBindingPicker(state);

    expect(request).toHaveBeenCalledWith("enterprise.trees.export", {
      treeId: "acme.support",
      format: "json",
    });
    const importCall = request.mock.calls.find(([method]) => method === "enterprise.trees.import");
    if (!importCall) {
      throw new Error("expected an enterprise.trees.import call");
    }
    const parsed = JSON.parse((importCall[1] as { content: string }).content);
    expect(parsed.root.ontology.allowedTools).toContain("group:enterprise");
    // The operator picked it; there is nothing to review, so no editor opens.
    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseBindingPicker).toBeNull();
  });

  it("writes several picks as one revision", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    exportThenImport(request);
    openEnterpriseBindingPicker(state, "acme.support.root", "allowedTools");
    toggleEnterpriseBindingPickerValue(state, "memory_search");
    toggleEnterpriseBindingPickerValue(state, "message");

    await submitEnterpriseBindingPicker(state);

    const imports = request.mock.calls.filter(([method]) => method === "enterprise.trees.import");
    expect(imports).toHaveLength(1);
    const parsed = JSON.parse((imports[0][1] as { content: string }).content);
    expect(parsed.root.ontology.allowedTools).toEqual(
      expect.arrayContaining(["memory_search", "message"]),
    );
  });

  it("untick removes a pick", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    exportThenImport(request);
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");

    await submitEnterpriseBindingPicker(state);

    expect(state.enterpriseBindingPicker?.failure?.kind).toBe("entry-empty");
    expect(request).not.toHaveBeenCalled();
  });

  it("declares a skill on the selected step", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    exportThenImport(request);
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");

    await submitEnterpriseBindingPicker(state);

    const importCall = request.mock.calls.find(([method]) => method === "enterprise.trees.import");
    if (!importCall) {
      throw new Error("expected an enterprise.trees.import call");
    }
    const parsed = JSON.parse((importCall[1] as { content: string }).content);
    expect(parsed.root.ontology.skills).toEqual(["refund-policy"]);
  });

  it("rejects an empty selection without re-exporting", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");

    await submitEnterpriseBindingPicker(state);

    expect(state.enterpriseBindingPicker?.failure?.kind).toBe("entry-empty");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the skill-name contract on the free-text escape hatch", async () => {
    // Tools accept globs, so the custom field is theirs; a skill or foundation
    // typed there must still satisfy what the import will accept.
    for (const bad of ["Refund Policy", "refund--policy", "-refund", "a".repeat(65)]) {
      const { state, request } = createState();
      state.enterpriseTreeDetail = treeDetail("acme.support");
      openEnterpriseBindingPicker(state, "acme.support.root", "skills");
      setEnterpriseBindingPickerCustom(state, bad);

      await submitEnterpriseBindingPicker(state);

      expect(state.enterpriseBindingPicker?.failure?.kind).toBe("skill-name-invalid");
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("does not apply the skill contract to tool grants", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    exportThenImport(request);
    openEnterpriseBindingPicker(state, "acme.support.root", "allowedTools");
    setEnterpriseBindingPickerCustom(state, "memory_*");

    await submitEnterpriseBindingPicker(state);

    const importCall = request.mock.calls.find(([method]) => method === "enterprise.trees.import");
    if (!importCall) {
      throw new Error("expected an enterprise.trees.import call");
    }
    const parsed = JSON.parse((importCall[1] as { content: string }).content);
    expect(parsed.root.ontology.allowedTools).toContain("memory_*");
  });

  it("rejects a foundation id the import contract would refuse", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    openEnterpriseBindingPicker(state, "acme.support.root", "knowledgeFoundations");
    setEnterpriseBindingPickerCustom(state, "Acme Runbooks");

    await submitEnterpriseBindingPicker(state);

    expect(state.enterpriseBindingPicker?.failure?.kind).toBe("foundation-id-invalid");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a rejected write open with the issue paths the server sent", async () => {
    // A rejection is a definite refusal that wrote nothing, and its paths name the
    // value to change. Collapsing it into the generic "the save did not confirm"
    // would leave the operator with no way to correct the entry.
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        return {
          ok: false,
          issues: [{ path: "root.ontology.skills.0", message: "unknown skill" }],
        };
      }
      return {};
    });
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");

    await submitEnterpriseBindingPicker(state);

    expect(state.enterpriseBindingPicker?.failure).toEqual({
      kind: "import-rejected",
      issues: [{ path: "root.ontology.skills.0", message: "unknown skill" }],
    });
    expect(state.enterpriseBindingPicker?.phase).toBe("idle");
    // The editor owns that field; writing it here would show these issues against
    // a draft they do not describe.
    expect(state.enterpriseTreeSaveIssues).toBeNull();
  });

  it("reports a rejection that lands after the dialog was closed", async () => {
    // Closing during the write says the save still lands. When it does not, the
    // dismissed dialog cannot carry the failure, so the tree banner has to.
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let rejectImport: ((value: unknown) => void) | null = null;
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        return new Promise((resolve) => {
          rejectImport = resolve;
        });
      }
      return {};
    });
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");
    const submitted = submitEnterpriseBindingPicker(state);
    await vi.waitFor(() => expect(state.enterpriseBindingPicker?.phase).toBe("writing"));

    cancelEnterpriseBindingPicker(state);
    if (!rejectImport) {
      throw new Error("expected the import to be in flight");
    }
    (rejectImport as (value: unknown) => void)({
      ok: false,
      issues: [{ path: "root.ontology.skills.0", message: "unknown skill" }],
    });
    await submitted;

    expect(state.enterpriseBindingPicker).toBeNull();
    expect(state.enterpriseTreeSaveError).toContain("root.ontology.skills.0: unknown skill");
  });

  it("drops a late failure once the operator moved to another tree", async () => {
    // The banner renders beside whichever tree is selected, so posting this one
    // there would report a failure of the work-map now on screen.
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let finishImport: ((value: unknown) => void) | null = null;
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        return new Promise((resolve) => {
          finishImport = resolve;
        });
      }
      return {};
    });
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");
    const submitted = submitEnterpriseBindingPicker(state);
    await vi.waitFor(() => expect(state.enterpriseBindingPicker?.phase).toBe("writing"));

    cancelEnterpriseBindingPicker(state);
    state.enterpriseSelectedTreeId = "acme.billing";
    if (!finishImport) {
      throw new Error("expected the import to be in flight");
    }
    (finishImport as (value: unknown) => void)({ ok: false, issues: [] });
    await submitted;

    expect(state.enterpriseTreeSaveError).toBeNull();
  });

  it("says nothing was written when the import never left the client", async () => {
    // GatewayBrowserClient rejects before ws.send when the socket is not open, so
    // this is a definite non-write — telling the operator it may have applied
    // would send them to check a tree that never changed.
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        throw new GatewayNotConnectedError();
      }
      return {};
    });
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");

    await submitEnterpriseBindingPicker(state);

    expect(state.enterpriseBindingPicker?.failure).toEqual({ kind: "import-not-sent" });
  });

  it("keeps the gateway's message when the server refuses the write", async () => {
    // An error frame is a definite refusal whose message names the reason; the
    // generic "may have applied" copy would discard it.
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        throw new GatewayRequestError({ code: "FORBIDDEN", message: "operator.admin required" });
      }
      return {};
    });
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");

    await submitEnterpriseBindingPicker(state);

    const failure = state.enterpriseBindingPicker?.failure;
    expect(failure?.kind).toBe("import-refused");
    expect(failure?.kind === "import-refused" && failure.message).toContain(
      "operator.admin required",
    );
  });

  it("drops a late failure once a newer draft owns the editor", async () => {
    // New Tree keeps the selection but replaces the draft, and the banner renders
    // inside that editor — so this failure would read as a problem with the tree
    // the operator is now writing.
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let finishImport: ((value: unknown) => void) | null = null;
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        return new Promise((resolve) => {
          finishImport = resolve;
        });
      }
      return {};
    });
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");
    const submitted = submitEnterpriseBindingPicker(state);
    await vi.waitFor(() => expect(state.enterpriseBindingPicker?.phase).toBe("writing"));

    cancelEnterpriseBindingPicker(state);
    beginNewEnterpriseTree(state);
    if (!finishImport) {
      throw new Error("expected the import to be in flight");
    }
    (finishImport as (value: unknown) => void)({ ok: false, issues: [] });
    await submitted;

    expect(state.enterpriseTreeSaveError).toBeNull();
  });

  it("cancel works while an import is pending", () => {
    // The client has no per-request timeout, so refusing to close while busy
    // would trap the operator behind a native modal with every control disabled.
    // A late result cannot resurrect it: submit only writes back when this exact
    // picker object is still the one on screen.
    const { state } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    const picker = state.enterpriseBindingPicker;
    if (!picker) {
      throw new Error("expected an open picker");
    }
    state.enterpriseBindingPicker = { ...picker, phase: "writing" };

    cancelEnterpriseBindingPicker(state);

    expect(state.enterpriseBindingPicker).toBeNull();
  });

  it("cancel clears the picker", () => {
    const { state } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");

    cancelEnterpriseBindingPicker(state);

    expect(state.enterpriseBindingPicker).toBeNull();
  });
});

describe("enterprise MCP registration", () => {
  it("hands a stdio server to the config writer and closes the form", () => {
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      name: "acme-tracker",
      command: "npx",
      args: "-y @acme/mcp-tracker",
    });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: (name, server) => written.push([name, server]),
    });

    expect(written).toEqual([
      ["acme-tracker", { command: "npx", args: ["-y", "@acme/mcp-tracker"] }],
    ]);
    expect(state.enterpriseMcpDraft).toBeNull();
  });

  it("writes a url for an http server", () => {
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      name: "remote",
      transport: "streamable-http",
      url: "https://mcp.acme.dev",
    });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: (name, server) => written.push([name, server]),
    });

    // The transport is written explicitly: without it the embedded runtime reads
    // the entry as SSE while Codex reads it as streamable HTTP.
    expect(written).toEqual([
      ["remote", { url: "https://mcp.acme.dev", transport: "streamable-http" }],
    ]);
  });

  it("refuses a name that is already registered", () => {
    // Config keys are unique, so this would REPLACE a working server rather than
    // add one — and take every step's attachment somewhere else with it.
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, { name: "github", command: "npx" });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: ["github"],
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("name-taken");
  });

  it("refuses a URL the runtime could never dial", () => {
    // The config schema rejects it only at save time, long after this form closed,
    // leaving a failed Save and nothing to correct it in.
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      name: "remote",
      transport: "sse",
      url: "ftp://example.com",
    });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("url-invalid");
  });

  it("refuses a name the config editor cannot store", () => {
    // setPathValue drops these segments, so the registration would write nothing
    // and the form would close as if it had worked.
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, { name: "constructor", command: "npx" });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("name-unsupported");
  });

  it("refuses a registration with no transport", () => {
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, { name: "acme-tracker" });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("launch-missing");
  });
});

describe("enterprise catalogs", () => {
  function mockCatalogs(request: ReturnType<typeof vi.fn<TestRequest>>) {
    request.mockImplementation(async (method) => {
      if (method === "tools.catalog") {
        return {
          agentId: "main",
          profiles: [],
          groups: [{ id: "enterprise", label: "Enterprise", source: "core", tools: [] }],
        };
      }
      if (method === "skills.status") {
        return {
          workspaceDir: "/w",
          managedSkillsDir: "/w/skills",
          skills: [{ name: "summarize" }],
        };
      }
      return { foundations: [{ id: "clawworks.support-kb" }] };
    });
  }

  it("loads tools, skills, and foundations for the enterprise surfaces", async () => {
    const { state, request } = createState();
    mockCatalogs(request);

    await loadEnterpriseCatalogs(state);

    // No agent id: these are deployment-wide reference lists, not one agent's
    // effective set.
    expect(request).toHaveBeenCalledWith("tools.catalog", { includePlugins: true });
    expect(request).toHaveBeenCalledWith("skills.status", {});
    expect(state.enterpriseToolGroups.map((group) => group.id)).toEqual(["enterprise"]);
    expect(state.enterpriseSkills.map((skill) => skill.name)).toEqual(["summarize"]);
    expect(state.enterpriseFoundations.map((entry) => entry.id)).toEqual(["clawworks.support-kb"]);
    expect(state.enterpriseCatalogPhase).toBe("ready");
    expect(state.enterpriseCatalogErrors).toEqual({ tools: null, skills: null, foundations: null });
    // Both catalogs are agent-scoped server-side; keep whose they are so the
    // surfaces can say so instead of implying one deployment-wide list.
    expect(state.enterpriseCatalogAgentId).toBe("main");
  });

  it("keeps the other catalogs usable when one fails", async () => {
    const { state, request } = createState();
    mockCatalogs(request);
    request.mockImplementation(async (method) => {
      if (method === "skills.status") {
        throw new Error("skill probe failed");
      }
      if (method === "tools.catalog") {
        return {
          agentId: "main",
          profiles: [],
          groups: [{ id: "fs", label: "Files", source: "core", tools: [] }],
        };
      }
      return { foundations: [] };
    });

    await loadEnterpriseCatalogs(state);

    expect(state.enterpriseToolGroups).toHaveLength(1);
    expect(state.enterpriseSkills).toEqual([]);
    // The failure lands only on the surface that asked for it.
    expect(state.enterpriseCatalogErrors.skills).toContain("skill probe failed");
    expect(state.enterpriseCatalogErrors.tools).toBeNull();
    expect(state.enterpriseCatalogPhase).toBe("ready");
  });

  it("reloads after a tree import, which can prune bundled foundations", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditContent = "{}";
    request.mockImplementation(async (method) => {
      if (method === "enterprise.trees.import") {
        return { ok: true, treeId: "acme.support" };
      }
      if (method === "enterprise.knowledge.foundations.list") {
        return { foundations: [] };
      }
      if (method === "tools.catalog") {
        return { agentId: "main", profiles: [], groups: [] };
      }
      if (method === "skills.status") {
        return { workspaceDir: "/w", managedSkillsDir: "/w/skills", skills: [] };
      }
      return { runs: [], trees: [], importErrors: [] };
    });
    requestSaveEnterpriseTree(state);

    await confirmEnterpriseTreeAction(state);
    // The import rebuilds the server's bundle knowledge registry, so a catalog
    // kept from before the save would keep suggesting a pruned foundation.
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("enterprise.knowledge.foundations.list", {}),
    );
  });

  it("drops a superseded load so two generations cannot mix", async () => {
    const { state, request } = createState();
    let releaseFirst: (() => void) | undefined;
    request.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ agentId: "main", profiles: [], groups: [] });
        }),
    );
    const stale = loadEnterpriseCatalogs(state);
    mockCatalogs(request);
    await loadEnterpriseCatalogs(state);
    releaseFirst?.();
    await stale;

    expect(state.enterpriseToolGroups.map((group) => group.id)).toEqual(["enterprise"]);
  });
});

describe("toggleEnterpriseCapabilityGrants", () => {
  const exportThenImport = (request: ReturnType<typeof createState>["request"]) => {
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        return { ok: true, treeId: "acme.support" };
      }
      return {};
    });
  };

  it("writes the flag onto the exported definition", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    exportThenImport(request);

    await toggleEnterpriseCapabilityGrants(state);

    const importCall = request.mock.calls.find(([method]) => method === "enterprise.trees.import");
    if (!importCall) {
      throw new Error("expected an enterprise.trees.import call");
    }
    const parsed = JSON.parse((importCall[1] as { content: string }).content);
    expect(parsed.capabilityGrants).toBe("explicit");
    // Whole-tree replace through the ONE write path: the steps come back untouched.
    expect(parsed.root.id).toBe("acme.support.root");
    expect(state.enterpriseTreeSaveError).toBeNull();
  });

  it("removes the key rather than writing a second mode", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = { ...treeDetail("acme.support"), capabilityGrants: "explicit" };
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return {
          content: JSON.stringify({
            ...JSON.parse(supportExportContent()),
            capabilityGrants: "explicit",
          }),
        };
      }
      if (method === "enterprise.trees.import") {
        return { ok: true, treeId: "acme.support" };
      }
      return {};
    });

    await toggleEnterpriseCapabilityGrants(state);

    const importCall = request.mock.calls.find(([method]) => method === "enterprise.trees.import");
    if (!importCall) {
      throw new Error("expected an enterprise.trees.import call");
    }
    const parsed = JSON.parse((importCall[1] as { content: string }).content);
    expect("capabilityGrants" in parsed).toBe(false);
  });

  it("reports a refused write instead of leaving the mode ambiguous", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      throw new GatewayRequestError({
        code: "UNAUTHORIZED",
        message: "missing scope: operator.admin",
      });
    });

    await toggleEnterpriseCapabilityGrants(state);

    expect(state.enterpriseTreeSaveError).toContain("missing scope: operator.admin");
    expect(state.enterpriseTreeSaving).toBe(false);
  });

  it("does nothing without a selected work-map", async () => {
    const { state, request } = createState();

    await toggleEnterpriseCapabilityGrants(state);

    expect(request).not.toHaveBeenCalled();
  });
});
