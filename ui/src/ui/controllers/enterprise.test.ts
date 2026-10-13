import { describe, expect, it, vi } from "vitest";
// Control UI tests cover enterprise inspection controller behavior.
import type { EnterpriseTreeDetail } from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayNotConnectedError, GatewayRequestError } from "../gateway.ts";
import {
  beginAddEnterpriseNode,
  beginEditEnterpriseTree,
  beginEditEnterpriseTreeSettings,
  beginEnterpriseOntologyDraft,
  beginNewEnterpriseTree,
  applyEnterpriseBundle,
  cancelEnterpriseBundlePreview,
  cancelEditEnterpriseTree,
  cancelEnterpriseTreeConfirm,
  removeEnterpriseNode,
  cancelAddEnterpriseNode,
  cancelEnterpriseTreeDraft,
  confirmEnterpriseTreeAction,
  disableEnterpriseMcpGovernance,
  editEnterpriseNodeDraft,
  editEnterpriseNodeGuidance,
  enableEnterpriseMcpGovernance,
  editEnterpriseOntologyDraft,
  editEnterpriseTreeDraft,
  type EnterpriseState,
  exportEnterpriseTree,
  exportEnterpriseBundle,
  importEnterpriseTreeFile,
  previewEnterpriseBundleFile,
  loadEnterprise,
  loadEnterpriseCatalogs,
  loadEnterpriseRunDetail,
  loadEnterpriseTreeDetail,
  loadEnterpriseTreeVersion,
  loadEnterpriseTreeVersions,
  refreshEnterprise,
  reconcileEnterpriseEditAccess,
  requestEnterpriseRunResume,
  requestRemoveEnterpriseTree,
  requestSaveEnterpriseTree,
  selectEnterpriseNode,
  selectEnterpriseTree,
  saveEnterpriseNodeGuidance,
  setEnterpriseTreeEditContent,
  setEnterpriseTreeEditFormat,
  cancelEnterpriseBindingPicker,
  closeEnterpriseBindingDetail,
  openEnterpriseBindingDetail,
  openEnterpriseBindingPicker,
  removeEnterpriseBinding,
  setEnterpriseBindingPickerCustom,
  addEnterpriseMcpHeader,
  beginEnterpriseMcpDraft,
  beginEnterpriseMcpEdit,
  editEnterpriseMcpDraft,
  editEnterpriseMcpHeader,
  submitAddEnterpriseNode,
  submitEnterpriseTreeDraft,
  submitEnterpriseOntologyDraft,
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
    enterpriseHistoryOnlyTreeIds: [],
    enterpriseListErrors: { runs: null, trees: null },
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
    enterpriseNodeObjectsError: null,
    enterpriseTreeEditing: false,
    enterpriseTreeDraft: null,
    enterpriseTreeEditTreeId: null,
    enterpriseTreeEditRevision: null,
    enterpriseTreeEditGuard: null,
    enterpriseTreeEditContent: "",
    enterpriseTreeEditFormat: "yaml",
    enterpriseTreeSaving: false,
    enterpriseTreeSaveIssues: null,
    enterpriseTreeWarnings: null,
    enterpriseTreeSaveError: null,
    enterpriseTreeConfirm: null,
    enterpriseBundleDraft: null,
    enterpriseBundleStatus: null,
    enterpriseTreeVersions: [],
    enterpriseTreeVersionsLoading: false,
    enterpriseTreeVersionsError: null,
    enterpriseNodeDraft: null,
    enterpriseBindingPicker: null,
    enterpriseBindingDetail: null,
    enterpriseGuidanceDraft: null,
    enterpriseOntologyDraft: null,
    enterpriseMcpDraft: null,
    enterpriseMcpRemoveConfirm: null,
    enterpriseCatalogPhase: "unloaded",
    enterpriseCatalogErrors: { tools: null, skills: null, foundations: null },
    enterpriseCatalogAgentId: null,
    enterpriseToolGroups: [],
    enterpriseSkills: [],
    enterpriseFoundations: [],
    enterpriseError: null,
    enterpriseResuming: false,
  };
  return { state, request };
}

function treeDetail(id: string, source: "builtin" | "imported" = "imported") {
  return {
    id,
    version: "1.0.0",
    hash: `hash-${id}`,
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

function bundlePreview(currentHash: string | null = null) {
  return {
    ok: true as const,
    reviewToken: "a".repeat(64),
    trees: [
      {
        id: "acme.bundle",
        version: "2.0.0",
        replaced: currentHash ? ("imported" as const) : null,
        currentVersion: currentHash ? "1.0.0" : null,
        currentHash,
      },
    ],
    foundations: ["acme.inline"],
    missingFoundations: ["acme.remote"],
    removedFoundations: [],
    replacedFoundations: [],
    shadowedFoundations: [],
    requiredTools: ["read"],
    requiredSkills: ["bundle-skill"],
    requiredMcpServers: ["bundle-mcp"],
    missingMcpServers: ["bundle-mcp"],
    warnings: [],
    missingGovernancePolicies: ["bundle.policy"],
    conflictingGovernancePolicies: [],
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
        importErrors: [{ treeId: "acme.broken", message: "corrupt row", fingerprint: "broken-v1" }],
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
      { treeId: "acme.broken", message: "corrupt row", fingerprint: "broken-v1" },
    ]);
    expect(state.enterpriseError).toBeNull();
    expect(state.enterpriseLoading).toBe(false);
  });

  it("keeps the successful list when its sibling request fails", async () => {
    const { state, request } = createState();
    state.enterpriseImportErrors = [{ treeId: "stale", message: "old", fingerprint: "stale-v1" }];
    state.enterpriseStoreError = "old store error";
    request.mockImplementation(async (method) => {
      if (method === "enterprise.runs.list") {
        return { runs: [runSummary("exec-1", "run-1")] };
      }
      throw new Error("tree registry unavailable");
    });

    await loadEnterprise(state);

    expect(state.enterpriseRuns).toHaveLength(1);
    expect(state.enterpriseListErrors).toEqual({
      runs: null,
      trees: "Error: tree registry unavailable",
    });
    expect(state.enterpriseImportErrors).toEqual([]);
    expect(state.enterpriseStoreError).toBeNull();
    expect(state.enterpriseLoading).toBe(false);
  });

  it("publishes a settled tree list without waiting for a stalled run list", async () => {
    const { state, request } = createState();
    request.mockImplementation((method) => {
      if (method === "enterprise.runs.list") {
        return new Promise(() => {});
      }
      return Promise.resolve({
        trees: [{ id: "ready", version: "1", name: "Ready", source: "imported", nodeCount: 1 }],
        importErrors: [],
      });
    });

    void loadEnterprise(state);

    await vi.waitFor(() => expect(state.enterpriseTrees.map((tree) => tree.id)).toEqual(["ready"]));
    expect(state.enterpriseLoading).toBe(true);
    expect(state.enterpriseListErrors.trees).toBeNull();
    expect(state.enterpriseListErrors.runs).toBeUndefined();
  });

  it("turns synchronous request failures into settled panel errors", async () => {
    const { state, request } = createState();
    request.mockImplementation(() => {
      throw new Error("socket closed");
    });

    await loadEnterprise(state);

    expect(state.enterpriseListErrors.runs).toContain("socket closed");
    expect(state.enterpriseListErrors.trees).toContain("socket closed");
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
    state.enterpriseBundleStatus = { kind: "warning", message: "protected policy id" };
    request.mockRejectedValue(
      new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
    );

    await loadEnterprise(state);

    expect(state.enterpriseRuns).toEqual([]);
    expect(state.enterpriseTrees).toEqual([]);
    expect(state.enterpriseSelectedExecutionId).toBeNull();
    expect(state.enterpriseDetail).toBeNull();
    expect(state.enterpriseBundleStatus).toBeNull();
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
  const mocks =
    (params: { runHash?: string; liveHash?: string; treeIssue?: "import" | "store" }) =>
    async (method: string) => {
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
          ...(params.treeIssue === "import"
            ? {
                importError: "invalid tree",
                importErrorFingerprint: "support-v1",
              }
            : {}),
          ...(params.treeIssue === "store" ? { storeError: "tree store unreadable" } : {}),
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

  it.each(["import", "store"] as const)(
    "withholds an unauthoritative tree with a %s error",
    async (treeIssue) => {
      const { state, request } = createState();
      request.mockImplementation(mocks({ runHash: "abc", liveHash: "abc", treeIssue }));

      await loadEnterpriseRunDetail(state, "exec-1");

      expect(state.enterpriseDetail).not.toBeNull();
      expect(state.enterpriseRunTree).toBeNull();
    },
  );
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

  it("replaces and clears warnings with each authoritative tree snapshot", async () => {
    const { state, request } = createState();
    state.enterpriseTreeWarnings = [{ path: "old", message: "Old warning" }];
    request
      .mockResolvedValueOnce({
        tree: treeDetail("acme.support"),
        warnings: [{ path: "current", message: "Current warning" }],
      })
      .mockResolvedValueOnce({ tree: treeDetail("acme.support") });

    await loadEnterpriseTreeDetail(state, "acme.support");
    expect(state.enterpriseTreeWarnings).toEqual([{ path: "current", message: "Current warning" }]);

    await loadEnterpriseTreeDetail(state, "acme.support");
    expect(state.enterpriseTreeWarnings).toBeNull();
  });

  it("surfaces a load failure for a corrupt imported override (stale built-in returned)", async () => {
    const { state, request } = createState();
    state.enterpriseTreeWarnings = [{ path: "old", message: "Old warning" }];
    request.mockResolvedValue({
      tree: treeDetail("acme.support", "builtin"),
      importError: "definition_json invalid",
      importErrorFingerprint: "support-v1",
    });

    await loadEnterpriseTreeDetail(state, "acme.support");

    // The stale built-in still renders, but the override failure must be shown.
    expect(state.enterpriseTreeDetail?.source).toBe("builtin");
    expect(state.enterpriseTreeIssue).toBe("definition_json invalid");
    expect(state.enterpriseTreeWarnings).toBeNull();
  });

  it("prefers the store-unreadable error over a per-tree import error", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      tree: null,
      importError: "per-tree failure",
      importErrorFingerprint: "support-v1",
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

function treeWithObjectEntity(id: string, entityId: string): EnterpriseTreeDetail {
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
    state.enterpriseTreeDetail = treeDetail("acme.support");
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

  it("keeps a newer editor reseed while a late detail response drops a vanished node", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    state.enterpriseSelectedNodeId = "acme.support.gone";
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.support";
    state.enterpriseTreeEditContent = "id: acme.support\n";
    let resolveDetail: ((value: unknown) => void) | undefined;
    let resolveExport: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === "enterprise.trees.get") {
        return new Promise((resolve) => {
          resolveDetail = resolve;
        });
      }
      if (method === "enterprise.trees.export") {
        return new Promise((resolve) => {
          resolveExport = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });

    const detail = loadEnterpriseTreeDetail(state, "acme.support");
    const reseed = setEnterpriseTreeEditFormat(state, "json");
    resolveDetail?.({ tree: treeDetail("acme.support") });
    await detail;

    expect(state.enterpriseSelectedNodeId).toBeNull();
    resolveExport?.({ content: '{"id":"acme.support"}\n', source: "imported" });
    await reseed;

    expect(state.enterpriseTreeEditFormat).toBe("json");
    expect(state.enterpriseTreeEditContent).toBe('{"id":"acme.support"}\n');
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
      importErrorFingerprint: "support-v1",
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

  it("does not replace a newly selected tree's history after a stale refresh detail settles", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeDetail = treeDetail("acme.a");
    let resolveRefreshDetail: ((value: unknown) => void) | undefined;
    request.mockImplementation((method, params) => {
      if (method === "enterprise.runs.list") {
        return Promise.resolve({ runs: [] });
      }
      if (method === "enterprise.trees.list") {
        return Promise.resolve({ trees: [], importErrors: [] });
      }
      if (method === "enterprise.trees.get") {
        const treeId = (params as { treeId: string }).treeId;
        if (treeId === "acme.a") {
          return new Promise((resolve) => {
            resolveRefreshDetail = resolve;
          });
        }
        return Promise.resolve({ tree: treeDetail(treeId) });
      }
      if (method === "enterprise.trees.history.list") {
        const treeId = (params as { treeId: string }).treeId;
        return Promise.resolve({
          versions: [
            {
              revision: treeId === "acme.b" ? 2 : 1,
              version: "1.0.0",
              name: treeId,
              sourceFormat: "yaml",
              savedAt: 1,
            },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });

    const refresh = refreshEnterprise(state);
    await vi.waitFor(() => expect(resolveRefreshDetail).toBeDefined());
    selectEnterpriseTree(state, "acme.b");
    await vi.waitFor(() => expect(state.enterpriseTreeVersions[0]?.name).toBe("acme.b"));

    resolveRefreshDetail?.({ tree: treeDetail("acme.a") });
    await refresh;

    expect(state.enterpriseSelectedTreeId).toBe("acme.b");
    expect(state.enterpriseTreeDetail?.id).toBe("acme.b");
    expect(state.enterpriseTreeVersions.map((version) => version.name)).toEqual(["acme.b"]);
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.history.list", {
      treeId: "acme.a",
    });
  });

  it("clears an uncertain save error without discarding a raw draft", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.support";
    state.enterpriseTreeEditContent = "unsaved raw draft";
    request.mockRejectedValueOnce(new Error("connection lost after send"));

    requestSaveEnterpriseTree(state);
    await confirmEnterpriseTreeAction(state);
    expect(state.enterpriseTreeSaveError).toContain("may or may not have been applied");

    request.mockImplementation(async (method) => {
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
      throw new Error(`unexpected method ${method}`);
    });

    await refreshEnterprise(state);

    expect(state.enterpriseTreeSaveError).toBeNull();
    expect(state.enterpriseTreeEditing).toBe(true);
    expect(state.enterpriseTreeEditContent).toBe("unsaved raw draft");
  });

  it("clears an uncertain save error without discarding a valid visual draft", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginAddEnterpriseNode(state, "acme.support.root");
    const draft = state.enterpriseNodeDraft;
    state.enterpriseTreeSaveError = "reload before retry";
    request.mockImplementation(async (method) => {
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
      throw new Error(`unexpected method ${method}`);
    });

    await refreshEnterprise(state);

    expect(state.enterpriseTreeSaveError).toBeNull();
    expect(state.enterpriseNodeDraft).toBe(draft);
  });

  it("does not clear a newer same-text save error while an older refresh settles", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.support";
    state.enterpriseTreeSaveError = "outcome unknown";
    let resolveDetail: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === "enterprise.runs.list") {
        return Promise.resolve({ runs: [] });
      }
      if (method === "enterprise.trees.list") {
        return Promise.resolve({ trees: [], importErrors: [] });
      }
      if (method === "enterprise.trees.get") {
        return new Promise((resolve) => {
          resolveDetail = resolve;
        });
      }
      if (method === "enterprise.trees.history.list") {
        return Promise.resolve({ versions: [] });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });

    const refresh = refreshEnterprise(state);
    await vi.waitFor(() => expect(resolveDetail).toBeDefined());
    setEnterpriseTreeEditContent(state, "newer draft");
    state.enterpriseTreeSaveError = "outcome unknown";
    resolveDetail?.({ tree: treeDetail("acme.support") });
    await refresh;

    expect(state.enterpriseTreeSaveError).toBe("outcome unknown");
    expect(state.enterpriseTreeEditContent).toBe("newer draft");
  });

  it("skips the detail reload when nothing is selected", async () => {
    const { state, request } = createState();
    mockListAndTrees(request);

    await refreshEnterprise(state);

    expect(request).not.toHaveBeenCalledWith("enterprise.runs.get", expect.anything());
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.get", expect.anything());
  });

  it("refreshes a selected inspector without waiting for stalled lists", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedExecutionId = "exec-1";
    request.mockImplementation((method) => {
      if (method === "enterprise.runs.get") {
        return Promise.resolve({ run: runDetail("exec-1", "run-1", "support") });
      }
      return new Promise(() => {});
    });

    void refreshEnterprise(state);

    await vi.waitFor(() => expect(state.enterpriseDetail?.executionId).toBe("exec-1"));
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

  it("keeps list failures while still refreshing an independent selected inspector", async () => {
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

    // Both section errors survive, while the usable detail endpoint is not held
    // back by its unrelated list siblings.
    expect(state.enterpriseListErrors.runs).toContain("gateway unavailable");
    expect(state.enterpriseListErrors.trees).toContain("gateway unavailable");
    expect(request).toHaveBeenCalledWith("enterprise.runs.get", { executionId: "exec-1" });
  });
});

describe("enterprise run continuation", () => {
  it("does not show a late refusal on a different selected run", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedExecutionId = "exec-1";
    state.enterpriseDetail = {
      ...runDetail("exec-1", "run-1", "support"),
      sessionId: "session-original",
    };
    let resolveResume: ((value: unknown) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );

    const pending = requestEnterpriseRunResume(state, "exec-1");
    state.enterpriseSelectedExecutionId = "exec-2";
    resolveResume?.({ ok: false, reason: "transcript-rotated" });
    await pending;

    expect(state.enterpriseError).toBeNull();
    expect(state.enterpriseResuming).toBe(false);
    expect(request).toHaveBeenCalledWith("enterprise.runs.resume", {
      executionId: "exec-1",
      sessionId: "session-original",
    });
  });

  it("does not arm a legacy run without transcript identity", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedExecutionId = "exec-1";
    state.enterpriseDetail = runDetail("exec-1", "run-1", "support");

    await requestEnterpriseRunResume(state, "exec-1");

    expect(request).not.toHaveBeenCalled();
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

  it("keeps authoritative warnings while only editor state changes", async () => {
    const { state, request } = createState();
    const warnings = [{ path: "root", message: "Unreachable action" }];
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    state.enterpriseTreeWarnings = warnings;
    request.mockResolvedValue({ content: "id: acme.support\n", source: "imported" });

    await beginEditEnterpriseTree(state);
    await setEnterpriseTreeEditFormat(state, "json");
    beginNewEnterpriseTree(state);
    selectEnterpriseTree(state, "acme.support");

    expect(state.enterpriseTreeWarnings).toEqual(warnings);
  });

  it("discards a new draft when the loaded tree row is selected again", () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginNewEnterpriseTree(state);

    selectEnterpriseTree(state, "acme.support");

    expect(state.enterpriseTreeDraft).toBeNull();
    expect(state.enterpriseTreeDetail?.id).toBe("acme.support");
    expect(request).not.toHaveBeenCalled();
  });

  it("beginEditEnterpriseTree seeds the editor from the tree export", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockResolvedValue({ content: "id: acme.support\n", source: "imported" });

    await beginEditEnterpriseTree(state);

    expect(request).toHaveBeenCalledWith("enterprise.trees.export", {
      treeId: "acme.support",
      format: "yaml",
    });
    expect(state.enterpriseTreeEditContent).toBe("id: acme.support\n");
    expect(state.enterpriseTreeEditGuard).toEqual({ expectedHash: "hash-acme.support" });
    expect(state.enterpriseTreeEditing).toBe(true);
  });

  it("confirms a save: imports, exits edit mode, and reloads the saved tree", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "id: acme.support\n";
    state.enterpriseTreeEditGuard = { expectedHash: "hash-before-edit" };
    const seen: string[] = [];
    let importParams: unknown;
    request.mockImplementation(async (method, params) => {
      seen.push(method);
      if (method === "enterprise.trees.import") {
        importParams = params;
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
    expect(importParams).toMatchObject({ expectedHash: "hash-before-edit" });
    expect(state.enterpriseTreeConfirm).toBeNull();
    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseTreeSaving).toBe(false);
    expect(state.enterpriseTreeDetail?.id).toBe("acme.support");
  });

  it("releases the save lock after the import even when its refresh stalls", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "id: acme.support\n";
    request.mockImplementation((method) => {
      if (method === "enterprise.trees.import") {
        return Promise.resolve({ ok: true, treeId: "acme.support", replaced: null });
      }
      return new Promise(() => {});
    });

    requestSaveEnterpriseTree(state);
    void confirmEnterpriseTreeAction(state);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("enterprise.trees.list", {}));
    expect(state.enterpriseTreeSaving).toBe(false);
    expect(state.enterpriseTreeEditing).toBe(false);
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

    // The list failure remains visible even though the independent detail reload
    // installs the post-save hash.
    expect(state.enterpriseListErrors.trees).toContain("list unavailable");
    expect(request).toHaveBeenCalledWith("enterprise.trees.get", { treeId: "acme.support" });
  });

  it("clears stale validation errors when an imported draft switches format", async () => {
    const { state } = createState();
    await importEnterpriseTreeFile(state, {
      name: "tree.yaml",
      text: async () => "id: old\n",
    });
    state.enterpriseTreeSaveError = "old error";
    state.enterpriseTreeSaveIssues = [{ path: "root", message: "bad" }];

    await setEnterpriseTreeEditFormat(state, "json");

    // The regenerated template must not keep diagnostics for content it replaced.
    expect(state.enterpriseTreeSaveError).toBeNull();
    expect(state.enterpriseTreeSaveIssues).toBeNull();
  });

  it("drops a slow file read after the operator starts another draft", async () => {
    const { state } = createState();
    let resolveText: ((content: string) => void) | undefined;
    const pending = importEnterpriseTreeFile(state, {
      name: "slow.yaml",
      text: () =>
        new Promise((resolve) => {
          resolveText = resolve;
        }),
    });

    beginNewEnterpriseTree(state);
    resolveText?.("id: stale\n");
    await pending;

    expect(state.enterpriseTreeDraft).not.toBeNull();
    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseTreeEditContent).toBe("");
  });

  it("drops a slow file read when the selected row is clicked again", async () => {
    const { state } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let resolveText: ((content: string) => void) | undefined;
    const pending = importEnterpriseTreeFile(state, {
      name: "slow.yaml",
      text: () =>
        new Promise((resolve) => {
          resolveText = resolve;
        }),
    });

    selectEnterpriseTree(state, "acme.support");
    resolveText?.("id: stale\n");
    await pending;

    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseTreeEditContent).toBe("");
  });

  it.each(["export", "file"] as const)(
    "does not open a raw editor from a pending %s seed after admin access is lost",
    async (source) => {
      const { state, request } = createState();
      let releaseSeed: (() => void) | undefined;
      const seedGate = new Promise<void>((resolve) => {
        releaseSeed = resolve;
      });
      let pending: Promise<void>;
      if (source === "export") {
        state.enterpriseSelectedTreeId = "acme.support";
        state.enterpriseTreeDetail = treeDetail("acme.support");
        request.mockImplementation(async () => {
          await seedGate;
          return { content: "id: acme.support\n", source: "imported" };
        });
        pending = beginEditEnterpriseTree(state);
      } else {
        pending = importEnterpriseTreeFile(state, {
          name: "slow.yaml",
          text: async () => {
            await seedGate;
            return "id: acme.support\n";
          },
        });
      }
      expect(state.enterpriseTreeEditing).toBe(false);

      reconcileEnterpriseEditAccess(state, false);
      releaseSeed?.();
      await pending;

      expect(state.enterpriseTreeEditing).toBe(false);
      expect(state.enterpriseTreeEditContent).toBe("");
    },
  );

  it("does not restore history until the current tree hash is loaded", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";

    await loadEnterpriseTreeVersion(state, "acme.support", 1);

    expect(request).not.toHaveBeenCalled();
    expect(state.enterpriseTreeEditing).toBe(false);
  });

  it("reports a local file read failure without an unhandled rejection", async () => {
    const { state } = createState();

    await importEnterpriseTreeFile(state, {
      name: "broken.yaml",
      text: async () => {
        throw new Error("read failed");
      },
    });

    expect(state.enterpriseError).toContain("read failed");
    expect(state.enterpriseTreeEditing).toBe(false);
  });

  it("retains exact bundle bytes through preview and clears them on cancel", async () => {
    const { state, request } = createState();
    const content = '{"schema":"clawworks.workflow-bundle"}\n';
    request.mockResolvedValue(bundlePreview());

    await previewEnterpriseBundleFile(state, {
      name: "portable.bundle.json",
      text: async () => content,
    });

    expect(request).toHaveBeenCalledWith("enterprise.bundles.preview", {
      content,
      format: "json",
    });
    expect(state.enterpriseBundleDraft).toMatchObject({
      fileName: "portable.bundle.json",
      content,
      format: "json",
    });
    expect(request).not.toHaveBeenCalledWith("enterprise.bundles.import", expect.anything());

    cancelEnterpriseBundlePreview(state);
    expect(state.enterpriseBundleDraft).toBeNull();
  });

  it.each([
    { currentHash: null, guard: { createOnly: true } },
    { currentHash: "preview-hash", guard: { expectedHash: "preview-hash" } },
  ])("applies a bundle only with its previewed $guard guard", async ({ currentHash, guard }) => {
    const { state, request } = createState();
    const content = "bundle bytes";
    request.mockResolvedValueOnce(bundlePreview(currentHash)).mockResolvedValueOnce({
      ok: false,
      issues: [{ path: "trees.0.id", message: "changed since preview" }],
    });
    await previewEnterpriseBundleFile(state, {
      name: "portable.yaml",
      text: async () => content,
    });

    await applyEnterpriseBundle(state);

    expect(request).toHaveBeenLastCalledWith("enterprise.bundles.import", {
      content,
      format: "yaml",
      reviewToken: "a".repeat(64),
      ...guard,
    });
    expect(state.enterpriseBundleDraft).toBeNull();
    expect(state.enterpriseBundleStatus).toMatchObject({
      kind: "error",
      message: expect.stringContaining("changed since preview"),
    });
    expect(state.enterpriseTreeSaving).toBe(false);
  });

  it("drops a pending bundle preview after permission reconciliation", async () => {
    const { state, request } = createState();
    let finishPreview: ((value: unknown) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPreview = resolve;
        }),
    );
    const pending = previewEnterpriseBundleFile(state, {
      name: "portable.json",
      text: async () => "private bundle bytes",
    });
    await vi.waitFor(() => expect(finishPreview).toBeDefined());

    reconcileEnterpriseEditAccess(state, false);
    finishPreview?.(bundlePreview());
    await pending;

    expect(state.enterpriseBundleDraft).toBeNull();
  });

  it("downloads a bundle and surfaces portability warnings", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    request.mockResolvedValue({
      ok: true,
      content: "portable bundle",
      source: "imported",
      skippedFoundations: [{ id: "remote.kb", reason: "unsupported" }],
      impliedAllowAllKnowledge: true,
    });
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:mock", configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      await exportEnterpriseBundle(state, "acme.support", "json");
      expect(request).toHaveBeenCalledWith("enterprise.bundles.export", {
        treeId: "acme.support",
        format: "json",
      });
      expect(clickSpy).toHaveBeenCalledOnce();
      expect(state.enterpriseBundleStatus).toMatchObject({
        kind: "warning",
        message: expect.stringContaining("remote.kb"),
      });
    } finally {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
      clickSpy.mockRestore();
    }
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

  it.each([
    {
      label: "unknown",
      error: new Error("connection lost after send"),
      expected: "may or may not have been applied",
    },
    {
      label: "not-sent",
      error: new GatewayNotConnectedError(),
      expected: "gateway connection dropped before this was sent",
    },
    {
      label: "refused",
      error: new GatewayRequestError({ code: "FORBIDDEN", message: "operator.admin required" }),
      expected: "server refused this change, so nothing was saved: operator.admin required",
    },
  ])("keeps the raw editor intact after a $label import failure", async ({ error, expected }) => {
    const { state, request } = createState();
    const content = "id: acme.support\n";
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.support";
    state.enterpriseTreeEditContent = content;
    request.mockRejectedValue(error);

    requestSaveEnterpriseTree(state);
    await confirmEnterpriseTreeAction(state);

    expect(state.enterpriseTreeEditing).toBe(true);
    expect(state.enterpriseTreeEditContent).toBe(content);
    expect(state.enterpriseTreeSaveError).toContain(expected);
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

    await requestRemoveEnterpriseTree(state, "acme.support");
    expect(state.enterpriseTreeConfirm).toEqual({
      kind: "remove",
      treeId: "acme.support",
      guard: { expectedHash: "hash-acme.support" },
    });
    await confirmEnterpriseTreeAction(state);

    expect(request).toHaveBeenCalledWith("enterprise.trees.remove", {
      treeId: "acme.support",
      expectedHash: "hash-acme.support",
    });
    expect(seen).toContain("enterprise.trees.list");
    expect(state.enterpriseSelectedTreeId).toBeNull();
    expect(state.enterpriseTreeDetail).toBeNull();
  });

  it("loadEnterpriseTreeVersion loads a revision into the editor to restore", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
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

  it("loads a removed tree revision with a create-only restore guard", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.removed";
    state.enterpriseHistoryOnlyTreeIds = ["acme.removed"];
    request.mockResolvedValue({ content: "id: acme.removed\nversion: 1.0.0\n" });

    await loadEnterpriseTreeVersion(state, "acme.removed", 3);

    expect(request).toHaveBeenCalledWith("enterprise.trees.history.get", {
      treeId: "acme.removed",
      revision: 3,
      format: "yaml",
    });
    expect(state.enterpriseTreeEditGuard).toEqual({ createOnly: true });
    expect(state.enterpriseTreeEditing).toBe(true);
  });

  it("fetches a missing legacy import fingerprint before offering removal", async () => {
    const { state, request } = createState();
    state.enterpriseImportErrors = [{ treeId: "acme.corrupt", message: "bad row" }];
    request.mockResolvedValue({
      tree: null,
      importError: "bad row",
      importErrorFingerprint: "fingerprint-current",
    });

    await requestRemoveEnterpriseTree(state, "acme.corrupt");

    expect(request).toHaveBeenCalledWith("enterprise.trees.get", { treeId: "acme.corrupt" });
    expect(state.enterpriseTreeConfirm).toEqual({
      kind: "remove",
      treeId: "acme.corrupt",
      guard: { expectedInvalidFingerprint: "fingerprint-current" },
    });
  });

  it("never offers unguarded removal when a legacy gateway has no fingerprint", async () => {
    const { state, request } = createState();
    state.enterpriseImportErrors = [{ treeId: "acme.corrupt", message: "bad row" }];
    request.mockResolvedValue({ tree: null, importError: "bad row" });

    await requestRemoveEnterpriseTree(state, "acme.corrupt");

    expect(state.enterpriseTreeConfirm).toBeNull();
    expect(state.enterpriseError).toContain("Cannot safely remove");
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.remove", expect.anything());
  });

  it("builds a guided definition with its routing settings", async () => {
    const { state } = createState();
    beginNewEnterpriseTree(state);
    editEnterpriseTreeDraft(state, {
      id: "support.intake",
      version: "2.1.0",
      name: "Support intake",
      description: "Triage incoming requests.",
      triggers: ["user", "subagent"],
      priority: "7",
      rootId: "support",
      rootTitle: "Support",
    });
    await submitEnterpriseTreeDraft(state);
    const parsed = JSON.parse(state.enterpriseTreeEditContent) as {
      version?: string;
      match?: { triggers?: string[]; priority?: number };
    };
    // Saving imports the tree, and imported work-maps govern runs. `triggers` is
    // the deterministic gate the model cannot override, so the template must
    // pin it rather than leave a half-finished draft open to system runs.
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.match).toEqual({ triggers: ["user", "subagent"], priority: 7 });
    expect(state.enterpriseTreeEditGuard).toEqual({ createOnly: true });
    expect(state.enterpriseTreeConfirm).toBeNull();
    expect(state.enterpriseTreeEditing).toBe(true);
  });

  it("stages tree settings for a guarded confirmed save", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = {
      ...treeDetail("acme.support"),
      version: "1.0.0",
      name: "Support",
      description: "Old description",
      match: { triggers: ["system"], priority: 2 },
    };
    request.mockImplementation(async (method) => {
      if (method === "enterprise.trees.export") {
        return {
          content: JSON.stringify({
            schema: "clawworks.workflow-tree",
            schemaVersion: 1,
            id: "acme.support",
            version: "1.0.0",
            name: "Support",
            match: { keywords: ["legacy"], triggers: ["system"], priority: 2 },
            root: { id: "acme.support.root", title: "Root" },
          }),
        };
      }
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
      if (method === "tools.catalog") {
        return { groups: [] };
      }
      if (method === "skills.status") {
        return { skills: [] };
      }
      return { foundations: [] };
    });

    beginEditEnterpriseTreeSettings(state);
    expect(state.enterpriseTreeDraft).toMatchObject({
      mode: "settings",
      expectedHash: "hash-acme.support",
      triggers: ["system"],
      priority: "2",
    });
    editEnterpriseTreeDraft(state, {
      version: "2.0.0",
      name: "Support operations",
      description: "Current settings",
      triggers: ["user", "subagent"],
      priority: "0",
    });

    await submitEnterpriseTreeDraft(state);

    expect(request).not.toHaveBeenCalledWith("enterprise.trees.import", expect.anything());
    expect(state.enterpriseTreeEditGuard).toEqual({ expectedHash: "hash-acme.support" });
    const saved = JSON.parse(state.enterpriseTreeEditContent);
    expect(saved).toMatchObject({
      version: "2.0.0",
      name: "Support operations",
      description: "Current settings",
      match: { keywords: ["legacy"], triggers: ["user", "subagent"], priority: 0 },
    });
    expect(state.enterpriseTreeDraft).toBeNull();
  });

  it("closes saved settings before the post-write refresh finishes", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let resolveDetail: ((value: unknown) => void) | undefined;
    let resolveList: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === "enterprise.trees.export") {
        return Promise.resolve({
          content: JSON.stringify({
            schema: "clawworks.workflow-tree",
            schemaVersion: 1,
            id: "acme.support",
            version: "1.0.0",
            name: "Support",
            match: { triggers: ["user"] },
            root: { id: "root", title: "Root" },
          }),
        });
      }
      if (method === "enterprise.trees.import") {
        return Promise.resolve({ ok: true, treeId: "acme.support", replaced: null });
      }
      if (method === "enterprise.trees.get") {
        return new Promise((resolve) => {
          resolveDetail = resolve;
        });
      }
      if (method === "enterprise.trees.list") {
        return new Promise((resolve) => {
          resolveList = resolve;
        });
      }
      if (method === "enterprise.trees.history.list") {
        return Promise.resolve({ versions: [] });
      }
      if (method === "tools.catalog") {
        return Promise.resolve({ agentId: "main", profiles: [], groups: [] });
      }
      if (method === "skills.status") {
        return Promise.resolve({ skills: [] });
      }
      return Promise.resolve({ foundations: [] });
    });

    beginEditEnterpriseTreeSettings(state);
    const pending = submitEnterpriseTreeDraft(state);
    await vi.waitFor(() => expect(state.enterpriseTreeDraft).toBeNull());
    expect(state.enterpriseTreeSaving).toBe(false);

    resolveDetail?.({ tree: treeDetail("acme.support") });
    resolveList?.({ trees: [], importErrors: [] });
    await pending;
  });

  it("lets a submitted settings form close while its write settles", () => {
    const { state } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginEditEnterpriseTreeSettings(state);
    state.enterpriseTreeSaving = true;

    cancelEnterpriseTreeDraft(state);

    expect(state.enterpriseTreeDraft).toBeNull();
    expect(state.enterpriseTreeSaving).toBe(true);
  });

  it("cancels a settings save before its export becomes an import", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let resolveExport: ((value: unknown) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
    );
    beginEditEnterpriseTreeSettings(state);

    const pending = submitEnterpriseTreeDraft(state);
    await vi.waitFor(() => expect(resolveExport).toBeDefined());
    cancelEnterpriseTreeDraft(state);
    resolveExport?.({
      content: JSON.stringify({
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.support",
        version: "1.0.0",
        name: "Support",
        root: { id: "root", title: "Root" },
      }),
    });
    await pending;

    expect(request.mock.calls.map(([method]) => method)).toEqual(["enterprise.trees.export"]);
    expect(state.enterpriseTreeDraft).toBeNull();
    expect(state.enterpriseTreeSaving).toBe(false);
  });

  it("drops hidden write drafts when operator.admin is lost", () => {
    const { state } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginEditEnterpriseTreeSettings(state);
    state.enterpriseGuidanceDraft = {
      treeId: "acme.support",
      nodeId: "acme.support.root",
      expectedHash: "hash-acme.support",
      title: "Root",
      parentId: null,
      position: 0,
      description: "",
      text: "draft",
      contextHints: [],
      expectedOutput: "",
      audit: false,
      error: null,
    };

    reconcileEnterpriseEditAccess(state, false);

    expect(state.enterpriseTreeDraft).toBeNull();
    expect(state.enterpriseGuidanceDraft).toBeNull();
  });

  it("drops credential drafts at every gateway identity boundary", () => {
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      transport: "streamable-http",
      url: "https://mcp.example.test",
      headers: [{ name: "Authorization", value: "secret", stored: false }],
    });
    state.enterpriseMcpRemoveConfirm = "other-server";
    state.enterpriseBundleStatus = { kind: "warning", message: "protected policy id" };

    reconcileEnterpriseEditAccess(state, true);

    expect(state.enterpriseMcpDraft).toBeNull();
    expect(state.enterpriseMcpRemoveConfirm).toBeNull();
    expect(state.enterpriseBundleStatus).toBeNull();
  });

  it("refuses to create a new tree over an existing id", () => {
    const { state } = createState();
    state.enterpriseTrees = [
      { id: "acme.other", version: "1", name: "Other", source: "imported", nodeCount: 1 },
    ];
    beginNewEnterpriseTree(state);
    editEnterpriseTreeDraft(state, {
      id: "acme.other",
      name: "Replacement",
      rootId: "root",
      rootTitle: "Root",
    });
    void submitEnterpriseTreeDraft(state);

    expect(state.enterpriseTreeDraft?.error).toBe("id-duplicate");
    expect(state.enterpriseTreeEditing).toBe(false);
  });

  it("keeps the selection and warns when remove reports nothing was removed", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "clawworks.assist";
    state.enterpriseTreeDetail = treeDetail("clawworks.assist", "builtin");

    await requestRemoveEnterpriseTree(state, "clawworks.assist");
    await confirmEnterpriseTreeAction(state);

    // A built-in cannot be removed; the selection stays and the id is unaffected.
    expect(state.enterpriseSelectedTreeId).toBe("clawworks.assist");
    expect(state.enterpriseTreeDetail).not.toBeNull();
    expect(state.enterpriseTreeIssue).toContain("clawworks.assist");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a changed tree selected and locks edits while guarded removal is pending", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let finishRemove: ((value: unknown) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRemove = resolve;
        }),
    );

    await requestRemoveEnterpriseTree(state, "acme.support");
    const pending = confirmEnterpriseTreeAction(state);
    expect(state.enterpriseTreeSaving).toBe(true);
    selectEnterpriseTree(state, "acme.support");

    finishRemove?.({ removed: false, reason: "tree-changed" });
    await pending;

    expect(state.enterpriseTreeSaving).toBe(false);
    expect(state.enterpriseSelectedTreeId).toBe("acme.support");
    expect(state.enterpriseTreeIssue).toContain("changed since it was loaded");
  });

  it("drops the stale detail when a removal outcome is unknown", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    state.enterpriseTreeWarnings = [{ path: "root", message: "stale warning" }];
    state.enterpriseTreeVersions = [
      { revision: 1, version: "1.0.0", name: "Support", sourceFormat: "yaml", savedAt: 1 },
    ];
    request.mockRejectedValue(new Error("connection lost after send"));

    await requestRemoveEnterpriseTree(state, "acme.support");
    await confirmEnterpriseTreeAction(state);

    expect(state.enterpriseSelectedTreeId).toBe("acme.support");
    expect(state.enterpriseTreeDetail).toBeNull();
    expect(state.enterpriseTreeWarnings).toBeNull();
    expect(state.enterpriseTreeVersions).toEqual([]);
    expect(state.enterpriseTreeIssue).toContain("may or may not have been applied");
    expect(state.enterpriseTreeIssue).toContain("refresh");
  });

  it("re-fetches the historical revision (not export) when a history draft switches format", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
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
    state.enterpriseTreeDetail = treeDetail("acme.support");
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
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
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

  it("does not paint a late export failure onto a newer draft", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    let finishExport: ((value: unknown) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishExport = resolve;
        }),
    );

    const pending = exportEnterpriseTree(state, "acme.support", "yaml");
    beginNewEnterpriseTree(state);
    state.enterpriseTreeSaveError = "newer draft failed";
    finishExport?.({ content: null, reason: "old export failed" });
    await pending;

    expect(state.enterpriseTreeSaveError).toBe("newer draft failed");
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
    await vi.waitFor(() => expect(resolveImport).toBeDefined());
    selectEnterpriseTree(state, "acme.a");
    expect(state.enterpriseTreeEditing).toBe(true);

    // The stale reseed resolves; it must not replace the submitted content.
    resolveExport?.({ content: "reseeded json content", source: "imported" });
    await reseed;
    expect(state.enterpriseTreeEditContent).toBe("id: acme.a\n");

    resolveImport?.({ ok: true, treeId: "acme.a", replaced: null });
    await savePending;
  });

  it("preserves a newer draft error while a superseded save reconcile stalls", async () => {
    const { state } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "id: acme.a\n";
    let resolveImport: ((value: unknown) => void) | undefined;
    let resolveTreeList: ((value: unknown) => void) | undefined;
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
      if (method === "enterprise.trees.list") {
        return new Promise((resolve) => {
          resolveTreeList = resolve;
        });
      }
      return Promise.resolve({ trees: [], importErrors: [] });
    };

    requestSaveEnterpriseTree(state);
    const pending = confirmEnterpriseTreeAction(state); // import in flight
    // The operator starts a new draft during the save.
    beginNewEnterpriseTree(state);
    state.enterpriseError = "newer draft failed";

    resolveImport?.({ ok: true, treeId: "acme.a", replaced: null });
    await vi.waitFor(() => expect(resolveTreeList).toBeDefined());

    // loadEnterprise clears its banner at start; the superseded reconcile must
    // restore the newer screen's error without waiting for the stalled list.
    expect(state.enterpriseError).toBe("newer draft failed");
    resolveTreeList?.({ trees: [], importErrors: [] });
    await pending;

    // The older save must not close the newer guided draft.
    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseTreeDraft).not.toBeNull();
    expect(state.enterpriseError).toBe("newer draft failed");
  });

  it("releases return navigation once a successful import starts its refresh", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeDetail = treeDetail("acme.a");
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.a";
    state.enterpriseTreeEditGuard = { expectedHash: "hash-acme.a" };
    state.enterpriseTreeEditContent = "id: acme.a\n";
    let finishImport: ((value: unknown) => void) | undefined;
    let finishTreeList: ((value: unknown) => void) | undefined;
    request.mockImplementation((method, params) => {
      if (method === "enterprise.trees.import") {
        return new Promise((resolve) => {
          finishImport = resolve;
        });
      }
      if (method === "enterprise.trees.get") {
        return Promise.resolve({ tree: treeDetail((params as { treeId: string }).treeId) });
      }
      if (method === "enterprise.trees.history.list") {
        return Promise.resolve({ versions: [] });
      }
      if (method === "enterprise.trees.list") {
        return new Promise((resolve) => {
          finishTreeList = resolve;
        });
      }
      if (method === "enterprise.runs.list") {
        return Promise.resolve({ runs: [] });
      }
      if (method === "tools.catalog") {
        return Promise.resolve({ agentId: "main", profiles: [], groups: [] });
      }
      if (method === "skills.status") {
        return Promise.resolve({ skills: [] });
      }
      return Promise.resolve({ foundations: [] });
    });

    requestSaveEnterpriseTree(state);
    const pending = confirmEnterpriseTreeAction(state);
    await vi.waitFor(() => expect(finishImport).toBeDefined());
    selectEnterpriseTree(state, "acme.b");
    expect(state.enterpriseSelectedTreeId).toBe("acme.b");
    finishImport?.({ ok: true, treeId: "acme.a", replaced: null });
    await vi.waitFor(() => expect(finishTreeList).toBeDefined());

    selectEnterpriseTree(state, "acme.a");
    expect(state.enterpriseSelectedTreeId).toBe("acme.a");
    expect(request).toHaveBeenCalledWith("enterprise.trees.get", { treeId: "acme.a" });

    finishTreeList?.({ trees: [], importErrors: [] });
    await pending;
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

  it("does not load history or warnings over a draft started during post-save detail", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditContent = "id: acme.a\n";
    let resolveDetail: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === "enterprise.trees.import") {
        return Promise.resolve({
          ok: true,
          treeId: "acme.a",
          replaced: null,
          warnings: [{ path: "root", message: "saved warning" }],
        });
      }
      if (method === "enterprise.runs.list") {
        return Promise.resolve({ runs: [] });
      }
      if (method === "enterprise.trees.list") {
        return Promise.resolve({ trees: [], importErrors: [] });
      }
      if (method === "enterprise.trees.get") {
        return new Promise((resolve) => {
          resolveDetail = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    requestSaveEnterpriseTree(state);
    const pending = confirmEnterpriseTreeAction(state);
    await vi.waitFor(() => expect(resolveDetail).toBeDefined());
    beginNewEnterpriseTree(state);
    resolveDetail?.({ tree: treeDetail("acme.a") });
    await pending;

    expect(state.enterpriseTreeDraft).not.toBeNull();
    expect(state.enterpriseTreeWarnings).toBeNull();
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.history.list", expect.anything());
  });

  it("withholds stale mutations until the saved detail hash reloads", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeDetail = treeDetail("acme.a");
    state.enterpriseTreeEditing = true;
    state.enterpriseTreeEditTreeId = "acme.a";
    state.enterpriseTreeEditGuard = { expectedHash: "hash-acme.a" };
    state.enterpriseTreeEditContent = "id: acme.a\n";
    let resolveTreeList: ((value: unknown) => void) | undefined;
    let resolveDetail: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === "enterprise.trees.import") {
        return Promise.resolve({ ok: true, treeId: "acme.a", replaced: null });
      }
      if (method === "enterprise.trees.get") {
        return new Promise((resolve) => {
          resolveDetail = resolve;
        });
      }
      if (method === "enterprise.runs.list") {
        return Promise.resolve({ runs: [] });
      }
      if (method === "enterprise.trees.list") {
        return new Promise((resolve) => {
          resolveTreeList = resolve;
        });
      }
      if (method === "enterprise.trees.history.list") {
        return Promise.resolve({ versions: [] });
      }
      if (method === "tools.catalog") {
        return Promise.resolve({ agentId: "main", profiles: [], groups: [] });
      }
      if (method === "skills.status") {
        return Promise.resolve({ skills: [] });
      }
      return Promise.resolve({ foundations: [] });
    });

    requestSaveEnterpriseTree(state);
    const savePending = confirmEnterpriseTreeAction(state);
    await vi.waitFor(() => {
      expect(resolveTreeList).toBeDefined();
      expect(resolveDetail).toBeDefined();
    });
    expect(state.enterpriseTreeSaving).toBe(false);
    expect(state.enterpriseTreeDetail).toBeNull();

    // No remove action can capture the old hash while the authoritative detail
    // reload is pending.
    await requestRemoveEnterpriseTree(state, "acme.a");
    expect(state.enterpriseTreeConfirm).toBeNull();
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.remove", expect.anything());

    resolveDetail?.({ tree: { ...treeDetail("acme.a"), hash: "hash-after-save" } });
    resolveTreeList?.({
      trees: [{ id: "acme.a", version: "1", name: "A", source: "imported", nodeCount: 1 }],
      importErrors: [],
    });
    await savePending;

    await requestRemoveEnterpriseTree(state, "acme.a");
    expect(state.enterpriseTreeConfirm).toEqual({
      kind: "remove",
      treeId: "acme.a",
      guard: { expectedHash: "hash-after-save" },
    });
  });

  it("does not clear a newer selection when a slow remove of another tree resolves", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeDetail = treeDetail("acme.a");
    let resolveRemove: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
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
      if (method === "enterprise.runs.list") {
        return Promise.resolve({ runs: [] });
      }
      if (method === "enterprise.trees.list") {
        return Promise.resolve({
          trees: [{ id: "acme.b", version: "1", name: "B", source: "imported", nodeCount: 1 }],
          importErrors: [],
        });
      }
      if (method === "tools.catalog") {
        return Promise.resolve({ agentId: "main", profiles: [], groups: [] });
      }
      if (method === "skills.status") {
        return Promise.resolve({ skills: [] });
      }
      return Promise.resolve({ foundations: [] });
    });

    await requestRemoveEnterpriseTree(state, "acme.a");
    const pending = confirmEnterpriseTreeAction(state); // remove in flight
    // The operator selects tree B while A's remove is still pending.
    selectEnterpriseTree(state, "acme.b");
    expect(state.enterpriseSelectedTreeId).toBe("acme.b");

    resolveRemove?.({ removed: true });
    await pending;

    // B's selection must survive; the slow remove of A must not clear it.
    expect(state.enterpriseSelectedTreeId).toBe("acme.b");
    expect(state.enterpriseTrees.map((tree) => tree.id)).toEqual(["acme.b"]);
    expect(request).toHaveBeenCalledWith("enterprise.trees.list", {});
  });

  it("does not discard a newer draft when a slow remove resolves", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeDetail = treeDetail("acme.a");
    let finishRemove: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === "enterprise.trees.remove") {
        return new Promise((resolve) => {
          finishRemove = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    await requestRemoveEnterpriseTree(state, "acme.a");
    const pending = confirmEnterpriseTreeAction(state);
    beginNewEnterpriseTree(state);
    state.enterpriseError = "newer draft failed";
    finishRemove?.({ removed: true });
    await pending;

    expect(state.enterpriseTreeDraft).not.toBeNull();
    expect(state.enterpriseError).toBe("newer draft failed");
    expect(request).toHaveBeenCalledWith("enterprise.runs.list", {});
  });

  it("keeps an unrelated tree's editor when removing a corrupt row from the banner", async () => {
    const { state, request } = createState();
    state.enterpriseImportErrors = [
      { treeId: "corrupt.b", message: "invalid stored row", fingerprint: "corrupt-b-v1" },
    ];
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

    await requestRemoveEnterpriseTree(state, "corrupt.b");
    await confirmEnterpriseTreeAction(state);

    // Removing corrupt.b must not discard the unsaved draft for acme.a.
    expect(state.enterpriseSelectedTreeId).toBe("acme.a");
    expect(state.enterpriseTreeEditing).toBe(true);
    expect(state.enterpriseTreeEditContent).toBe("unsaved draft");
    expect(request).toHaveBeenCalledWith("enterprise.trees.remove", {
      treeId: "corrupt.b",
      expectedInvalidFingerprint: "corrupt-b-v1",
    });
  });

  it("drops a stale editor seed when a newer edit intent supersedes it", async () => {
    const { state } = createState();
    state.enterpriseSelectedTreeId = "acme.a";
    state.enterpriseTreeDetail = treeDetail("acme.a");
    let resolveExport: ((value: unknown) => void) | undefined;
    (state.client as unknown as { request: () => Promise<unknown> }).request = () =>
      new Promise((resolve) => {
        resolveExport = resolve;
      });

    const pending = beginEditEnterpriseTree(state); // A's export is in flight
    beginNewEnterpriseTree(state); // a newer intent supersedes it

    resolveExport?.({ content: "id: acme.a\n", source: "imported" });
    await pending;

    // The stale export of A must not replace the newer guided draft.
    expect(state.enterpriseTreeDraft).not.toBeNull();
    expect(state.enterpriseTreeEditing).toBe(false);
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

  it("surfaces non-auth object and revision load failures", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeWithObjectEntity("acme.support", "claim");
    request.mockRejectedValue(new Error("read failed"));

    selectEnterpriseNode(state, "acme.support.root");
    await loadEnterpriseTreeVersions(state, "acme.support");
    await flushMicrotasks();

    expect(state.enterpriseNodeObjectsError).toBe("Error: read failed");
    expect(state.enterpriseTreeVersionsError).toBe("Error: read failed");
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

describe("enterprise binding detail card", () => {
  const detail = {
    nodeId: "acme.support.root",
    field: "allowedTools" as const,
    entry: "exec",
    origin: "step" as const,
  };

  it("binds the open card to the selected work-map", () => {
    const { state } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");

    openEnterpriseBindingDetail(state, detail);

    expect(state.enterpriseBindingDetail).toEqual({ treeId: "acme.support", ...detail });
    closeEnterpriseBindingDetail(state);
    expect(state.enterpriseBindingDetail).toBeNull();
  });

  it("opens nothing when no work-map is selected", () => {
    const { state } = createState();

    openEnterpriseBindingDetail(state, detail);

    expect(state.enterpriseBindingDetail).toBeNull();
  });

  it("closes the card on a tree reload rather than leaving it to spring back", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseSelectedNodeId = "acme.support.root";
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.get") {
        return { tree: treeDetail("acme.support") };
      }
      return {};
    });
    openEnterpriseBindingDetail(state, detail);

    await loadEnterpriseTreeDetail(state, "acme.support");

    // Hiding it in the view is not enough: the state would survive the reload and
    // the dialog would reopen on its own once a later reload restored the entry.
    expect(state.enterpriseBindingDetail).toBeNull();
  });

  it("closes the card when the entry it describes is detached", async () => {
    const { state, request } = createState();
    state.enterpriseTreeDetail = treeDetail("acme.support");
    request.mockImplementation(async (method: string) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        return { ok: true, treeId: "acme.support" };
      }
      return {};
    });
    openEnterpriseBindingDetail(state, detail);

    // The Detach the card itself offers: leaving the card up would describe a
    // binding the step no longer has, and offer to remove it again.
    await removeEnterpriseBinding(state, {
      nodeId: detail.nodeId,
      field: detail.field,
      entry: detail.entry,
    });

    expect(state.enterpriseBindingDetail).toBeNull();
  });
});

describe("enterprise MCP registration", () => {
  it("does not replace an open registration draft with another server", () => {
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, { name: "unsaved-server" });

    beginEnterpriseMcpEdit(state, {
      name: "existing-server",
      server: { command: "existing-command" },
    });

    expect(state.enterpriseMcpDraft).toMatchObject({
      editing: null,
      name: "unsaved-server",
    });
  });

  it("does not open a draft over a pending removal confirmation", () => {
    const { state } = createState();
    state.enterpriseMcpRemoveConfirm = "existing-server";

    beginEnterpriseMcpDraft(state);
    beginEnterpriseMcpEdit(state, {
      name: "existing-server",
      server: { command: "existing-command" },
    });

    expect(state.enterpriseMcpDraft).toBeNull();
  });

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

  it("registers every server in a pasted snippet", () => {
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      mode: "json",
      json: JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
          remote: { type: "http", url: "https://mcp.acme.dev" },
        },
      }),
    });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: (name, server) => written.push([name, server]),
    });

    expect(written).toEqual([
      ["github", { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }],
      ["remote", { url: "https://mcp.acme.dev", transport: "streamable-http" }],
    ]);
    expect(state.enterpriseMcpDraft).toBeNull();
  });

  it("registers none of a snippet when one name is already taken", () => {
    // A paste is one unit: half-registering it would leave the operator
    // believing the server the collision hid is there too.
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      mode: "json",
      json: JSON.stringify({
        mcpServers: { fresh: { command: "a" }, github: { command: "b" } },
      }),
    });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: ["github"],
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("name-taken");
    expect(state.enterpriseMcpDraft?.errorDetail).toBe("github");
  });

  it("names the snippet entry it refused", () => {
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      mode: "json",
      json: JSON.stringify({ mcpServers: { broken: { note: "todo" } } }),
    });

    submitEnterpriseMcpDraft(state, { existingNames: [], apply: () => undefined });

    expect(state.enterpriseMcpDraft?.error).toBe("json-entry-launchless");
    expect(state.enterpriseMcpDraft?.errorDetail).toBe("broken");
  });

  it("clears a stale error detail when the paste is edited", () => {
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, { mode: "json", json: "{ nope" });
    submitEnterpriseMcpDraft(state, { existingNames: [], apply: () => undefined });
    expect(state.enterpriseMcpDraft?.error).toBe("json-invalid");

    editEnterpriseMcpDraft(state, { json: JSON.stringify({ mcpServers: {} }) });

    expect(state.enterpriseMcpDraft?.error).toBeNull();
    expect(state.enterpriseMcpDraft?.errorDetail).toBeUndefined();
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

  it("publishes a settled catalog without waiting for a stalled sibling", async () => {
    const { state, request } = createState();
    request.mockImplementation((method) => {
      if (method === "tools.catalog") {
        return Promise.resolve({
          agentId: "main",
          profiles: [],
          groups: [{ id: "ready", label: "Ready", source: "core", tools: [] }],
        });
      }
      if (method === "skills.status") {
        return new Promise(() => {});
      }
      return Promise.resolve({ foundations: [] });
    });

    void loadEnterpriseCatalogs(state);

    await vi.waitFor(() =>
      expect(state.enterpriseToolGroups.map((group) => group.id)).toEqual(["ready"]),
    );
    expect(state.enterpriseCatalogPhase).toBe("loading");
    expect(state.enterpriseCatalogErrors.tools).toBeNull();
    expect(state.enterpriseCatalogErrors.skills).toBeUndefined();
  });

  it("reloads after a tree import, which can prune bundled foundations", async () => {
    const { state, request } = createState();
    state.enterpriseTreeEditContent = "{}";
    state.enterpriseTreeEditing = true;
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

describe("remote MCP servers", () => {
  const REDACTED = "__OPENCLAW_REDACTED__";

  it("writes headers and OAuth so a hosted server can be reached", () => {
    // Without one of these the typed half could only ever register servers that
    // need no auth at all.
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      name: "acme-remote",
      transport: "streamable-http",
      url: "https://mcp.acme.dev",
      oauth: true,
    });
    addEnterpriseMcpHeader(state);
    editEnterpriseMcpHeader(state, 0, { name: "X-Api-Key", value: "secret" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: (name, server) => written.push([name, server]),
    });

    expect(written).toEqual([
      [
        "acme-remote",
        {
          url: "https://mcp.acme.dev",
          transport: "streamable-http",
          headers: { "X-Api-Key": "secret" },
          auth: "oauth",
        },
      ],
    ]);
  });

  it("refuses a header value with no header name", () => {
    // It would reach nothing and be dropped on save, looking configured.
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      name: "acme-remote",
      transport: "sse",
      url: "https://mcp.acme.dev",
    });
    addEnterpriseMcpHeader(state);
    editEnterpriseMcpHeader(state, 0, { value: "secret" });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("header-name-empty");
  });

  it("seeds an edit from the registered entry without exposing a stored header", () => {
    const { state } = createState();

    beginEnterpriseMcpEdit(state, {
      name: "acme-remote",
      server: {
        url: "https://mcp.acme.dev",
        transport: "sse",
        headers: { Authorization: REDACTED },
        auth: "oauth",
      },
    });

    expect(state.enterpriseMcpDraft).toMatchObject({
      editing: "acme-remote",
      name: "acme-remote",
      transport: "sse",
      url: "https://mcp.acme.dev",
      oauth: true,
      headers: [{ name: "Authorization", value: "", stored: true }],
    });
  });

  it("opens on the canonical transport when a stale `type` alias disagrees", () => {
    // resolveMcpTransportConfig gives `transport` precedence and reads `type`
    // only when it is absent (src/agents/mcp-transport-config.ts). Reading both
    // at once opened this entry on SSE; saving any unrelated field then drops
    // `type` and writes that back as canonical, changing the endpoint protocol.
    const { state } = createState();

    beginEnterpriseMcpEdit(state, {
      name: "acme-remote",
      server: { url: "https://mcp.acme.dev", transport: "streamable-http", type: "sse" },
    });

    expect(state.enterpriseMcpDraft).toMatchObject({ transport: "streamable-http" });
  });

  it("falls back to the `type` alias only when no transport is declared", () => {
    const { state } = createState();

    beginEnterpriseMcpEdit(state, {
      name: "acme-legacy",
      server: { url: "https://mcp.acme.dev", type: "sse" },
    });

    expect(state.enterpriseMcpDraft).toMatchObject({ transport: "sse" });
  });

  it("keeps a stored header when the operator does not retype it", () => {
    // The browser was never given the value; writing the sentinel back is what
    // lets the gateway swap the real one in on save.
    const { state } = createState();
    const server = {
      url: "https://mcp.acme.dev",
      transport: "sse",
      headers: { Authorization: REDACTED },
      toolFilter: { include: ["search"] },
    };
    beginEnterpriseMcpEdit(state, { name: "acme-remote", server });
    editEnterpriseMcpDraft(state, { url: "https://mcp2.acme.dev" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["acme-remote"],
      existingServer: server,
      apply: (name, entry) => written.push([name, entry]),
    });

    expect(written).toEqual([
      [
        "acme-remote",
        {
          url: "https://mcp2.acme.dev",
          transport: "sse",
          headers: { Authorization: REDACTED },
          // Settings this form does not render survive the edit.
          toolFilter: { include: ["search"] },
        },
      ],
    ]);
  });

  it("replaces a stored header once the operator types into it", () => {
    const { state } = createState();
    const server = {
      url: "https://mcp.acme.dev",
      transport: "sse",
      headers: { Authorization: REDACTED },
    };
    beginEnterpriseMcpEdit(state, { name: "acme-remote", server });
    editEnterpriseMcpHeader(state, 0, { value: "Bearer new" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["acme-remote"],
      existingServer: server,
      apply: (name, entry) => written.push([name, entry]),
    });

    expect(written[0]?.[1].headers).toEqual({ Authorization: "Bearer new" });
  });

  it("clears the other transport's launch when an edit switches transport", () => {
    // Leaving both behind would make a command-bearing entry resolve as stdio
    // however the URL is labelled.
    const { state } = createState();
    beginEnterpriseMcpEdit(state, { name: "local", server: { command: "./serve", args: ["--x"] } });
    editEnterpriseMcpDraft(state, { transport: "streamable-http", url: "https://mcp.acme.dev" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["local"],
      existingServer: { command: "./serve", args: ["--x"] },
      apply: (name, server) => written.push([name, server]),
    });

    expect(written).toEqual([
      ["local", { url: "https://mcp.acme.dev", transport: "streamable-http" }],
    ]);
  });

  it("keeps the registered name on an edit rather than offering a rename", () => {
    // The name is the key steps attach by AND the redaction lookup path, so a
    // rename would strand every attachment and orphan any stored header.
    const { state } = createState();
    const server = { command: "./serve" };
    beginEnterpriseMcpEdit(state, { name: "local", server });
    editEnterpriseMcpDraft(state, { name: "renamed" });
    const written: string[] = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["local"],
      existingServer: server,
      apply: (name) => written.push(name),
    });

    expect(written).toEqual(["local"]);
    expect(state.enterpriseMcpDraft).toBeNull();
  });
});

describe("editing an MCP server preserves what the form does not own", () => {
  const REDACTED = "__OPENCLAW_REDACTED__";

  it("keeps an entry that declared no transport unresolved until the operator picks", () => {
    // OpenClaw reads an unset transport as SSE and Codex reads a bare URL as
    // streamable HTTP, so writing either on the operator's behalf repoints the
    // server for one of them.
    const { state } = createState();
    const server = { url: "https://mcp.acme.dev" };
    beginEnterpriseMcpEdit(state, { name: "acme-remote", server });
    expect(state.enterpriseMcpDraft?.transport).toBe("unset");
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: ["acme-remote"],
      existingServer: server,
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("transport-unset");
  });

  it("reads the type alias as the transport it already resolves to", () => {
    const { state } = createState();
    beginEnterpriseMcpEdit(state, {
      name: "acme-remote",
      server: { url: "https://mcp.acme.dev", type: "sse" },
    });

    expect(state.enterpriseMcpDraft?.transport).toBe("sse");
  });

  it("writes an untouched argument array back verbatim", () => {
    // Round-tripping through a space-joined string would split
    // ["--label", "hello world"] into three arguments.
    const { state } = createState();
    const server = { command: "./serve", args: ["--label", "hello world"] };
    beginEnterpriseMcpEdit(state, { name: "local", server });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["local"],
      existingServer: server,
      apply: (name, entry) => written.push([name, entry]),
    });

    expect(written).toEqual([["local", { command: "./serve", args: ["--label", "hello world"] }]]);
  });

  it("splits the argument field once the operator actually edits it", () => {
    const { state } = createState();
    const server = { command: "./serve", args: ["--a"] };
    beginEnterpriseMcpEdit(state, { name: "local", server });
    editEnterpriseMcpDraft(state, { args: "--a --b" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["local"],
      existingServer: server,
      apply: (name, entry) => written.push([name, entry]),
    });

    expect(written[0]?.[1].args).toEqual(["--a", "--b"]);
  });

  it("keeps a redacted URL rather than demanding the whole secret be retyped", () => {
    const { state } = createState();
    const server = { url: REDACTED, transport: "sse" };
    beginEnterpriseMcpEdit(state, { name: "acme-remote", server });
    expect(state.enterpriseMcpDraft?.urlStored).toBe(true);
    addEnterpriseMcpHeader(state);
    editEnterpriseMcpHeader(state, 0, { name: "X-Tenant", value: "acme" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["acme-remote"],
      existingServer: server,
      apply: (name, entry) => written.push([name, entry]),
    });

    expect(written[0]?.[1].url).toBe(REDACTED);
  });

  it("refuses to move a stored header to another name", () => {
    // The gateway restores the sentinel by header key, so a rename would write a
    // reserved value at a path holding nothing.
    const { state } = createState();
    beginEnterpriseMcpEdit(state, {
      name: "acme-remote",
      server: {
        url: "https://mcp.acme.dev",
        transport: "sse",
        headers: { Authorization: REDACTED },
      },
    });

    editEnterpriseMcpHeader(state, 0, { name: "X-Api-Key" });

    expect(state.enterpriseMcpDraft?.headers[0]).toEqual({
      name: "Authorization",
      value: "",
      stored: true,
      savedValue: REDACTED,
    });
  });

  it("refuses a pasted snippet that would leave the edited server behind", () => {
    const { state } = createState();
    const server = { command: "./serve" };
    beginEnterpriseMcpEdit(state, { name: "local", server });
    editEnterpriseMcpDraft(state, {
      mode: "json",
      json: JSON.stringify({ mcpServers: { other: { command: "./other" } } }),
    });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: ["local"],
      existingServer: server,
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("json-name-mismatch");
  });
});

describe("switching an MCP transport clears the other shape's fields", () => {
  it("drops env and cwd when a stdio server becomes an HTTP one", () => {
    // OpenClaw ignores the leftovers, but its Codex projection copies them and
    // Codex rejects env/cwd on a URL transport, so the server would fail to
    // initialize for Codex-backed runs.
    const { state } = createState();
    const server = {
      command: "./serve",
      env: { TOKEN: "x" },
      cwd: "/srv",
      toolFilter: { include: ["a"] },
    };
    beginEnterpriseMcpEdit(state, { name: "local", server });
    editEnterpriseMcpDraft(state, { transport: "streamable-http", url: "https://mcp.acme.dev" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["local"],
      existingServer: server,
      apply: (name, entry) => written.push([name, entry]),
    });

    expect(written).toEqual([
      [
        "local",
        {
          url: "https://mcp.acme.dev",
          transport: "streamable-http",
          // Settings that belong to neither transport still survive.
          toolFilter: { include: ["a"] },
        },
      ],
    ]);
  });

  it("drops HTTP-only fields when an HTTP server becomes stdio", () => {
    const { state } = createState();
    const server = {
      url: "https://mcp.acme.dev",
      transport: "sse",
      sslVerify: false,
      oauth: { scope: "read" },
    };
    beginEnterpriseMcpEdit(state, { name: "remote", server });
    editEnterpriseMcpDraft(state, { transport: "stdio", command: "./serve" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["remote"],
      existingServer: server,
      apply: (name, entry) => written.push([name, entry]),
    });

    expect(written).toEqual([["remote", { command: "./serve" }]]);
  });
});

describe("MCP header rows", () => {
  it("refuses two rows naming the same header, ignoring case", () => {
    // HTTP header names are case-insensitive, so collapsing them into a record
    // would keep whichever came last and leave the sent value ambiguous.
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      name: "remote",
      transport: "sse",
      url: "https://mcp.acme.dev",
    });
    addEnterpriseMcpHeader(state);
    editEnterpriseMcpHeader(state, 0, { name: "Authorization", value: "a" });
    addEnterpriseMcpHeader(state);
    editEnterpriseMcpHeader(state, 1, { name: "authorization", value: "b" });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("header-name-duplicate");
  });
});

describe("an MCP edit is pinned to the entry it opened on", () => {
  it("refuses when only the redacted config revision changed", () => {
    const { state } = createState();
    const server = {
      url: "https://a.dev",
      transport: "sse",
      headers: { Authorization: "__OPENCLAW_REDACTED__" },
    };
    beginEnterpriseMcpEdit(state, { name: "acme-remote", server, configHash: "before" });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: ["acme-remote"],
      existingServer: server,
      currentConfigHash: "after",
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("entry-changed");
  });

  it("refuses when the registered server changed under the form", () => {
    // Another admin repointing the same name rotates its header too. Staging
    // this draft's URL with the stored-value sentinel would let config.set
    // restore the NEW secret against the OLD address.
    const { state } = createState();
    beginEnterpriseMcpEdit(state, {
      name: "acme-remote",
      server: {
        url: "https://a.dev",
        transport: "sse",
        headers: { Authorization: "__OPENCLAW_REDACTED__" },
      },
    });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: ["acme-remote"],
      existingServer: {
        url: "https://b.dev",
        transport: "sse",
        headers: { Authorization: "__OPENCLAW_REDACTED__" },
      },
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("entry-changed");
  });
});

describe("MCP headers the text form cannot represent", () => {
  it("writes a scalar header back rather than blanking it", () => {
    // Config allows boolean and number headers; rendering one as "" and saving
    // an unrelated change would silently rewrite it.
    const { state } = createState();
    const server = {
      url: "https://mcp.acme.dev",
      transport: "sse",
      headers: { "X-Retries": 3, "X-Debug": true },
    };
    beginEnterpriseMcpEdit(state, { name: "acme-remote", server });
    editEnterpriseMcpDraft(state, { url: "https://mcp2.acme.dev" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: ["acme-remote"],
      existingServer: server,
      apply: (name, entry) => written.push([name, entry]),
    });

    expect(written[0]?.[1].headers).toEqual({ "X-Retries": 3, "X-Debug": true });
  });
});

describe("MCP header names the server would refuse", () => {
  it("rejects a name outside the HTTP token grammar", () => {
    // The config schema accepts any string, but the MCP SDK builds a Headers
    // from these and throws, so Save would succeed and the server would not start.
    for (const name of ["Authorization:", "Bad Header", "X\u00e9"]) {
      const { state } = createState();
      beginEnterpriseMcpDraft(state);
      editEnterpriseMcpDraft(state, {
        name: "remote",
        transport: "sse",
        url: "https://mcp.acme.dev",
      });
      addEnterpriseMcpHeader(state);
      editEnterpriseMcpHeader(state, 0, { name, value: "x" });

      submitEnterpriseMcpDraft(state, { existingNames: [], apply: () => undefined });

      expect(state.enterpriseMcpDraft?.error).toBe("header-name-invalid");
    }
  });
});

describe("a JSON-mode edit is pinned like the typed one", () => {
  it("refuses a paste when the registered entry changed under the form", () => {
    // A paste can carry a redaction sentinel too, so bypassing the check would
    // combine the latest secret with a stale URL.
    const { state } = createState();
    beginEnterpriseMcpEdit(state, { name: "local", server: { command: "./serve" } });
    editEnterpriseMcpDraft(state, {
      mode: "json",
      json: JSON.stringify({ mcpServers: { local: { command: "./other" } } }),
    });
    let applied = 0;

    submitEnterpriseMcpDraft(state, {
      existingNames: ["local"],
      existingServer: { command: "./changed" },
      apply: () => {
        applied += 1;
      },
    });

    expect(applied).toBe(0);
    expect(state.enterpriseMcpDraft?.error).toBe("entry-changed");
  });
});

describe("MCP header names that collide with Object prototype keys", () => {
  it("stores a header literally named __proto__", () => {
    // Assignment would invoke the legacy setter and drop it while the form
    // closed as though it had been saved. It is a valid HTTP field name.
    const { state } = createState();
    beginEnterpriseMcpDraft(state);
    editEnterpriseMcpDraft(state, {
      name: "remote",
      transport: "sse",
      url: "https://mcp.acme.dev",
    });
    addEnterpriseMcpHeader(state);
    editEnterpriseMcpHeader(state, 0, { name: "__proto__", value: "x" });
    const written: Array<[string, Record<string, unknown>]> = [];

    submitEnterpriseMcpDraft(state, {
      existingNames: [],
      apply: (name, entry) => written.push([name, entry]),
    });

    const headers = written[0]?.[1].headers as Record<string, unknown>;
    expect(Object.hasOwn(headers, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(headers, "__proto__")?.value).toBe("x");
  });
});

describe("a blank command is not a stdio launch", () => {
  it("opens such an entry as the HTTP server the resolver treats it as", () => {
    // The embedded resolver ignores a blank command; seeding stdio would hide
    // the URL and auth fields and then fail as launch-missing.
    const { state } = createState();

    beginEnterpriseMcpEdit(state, {
      name: "remote",
      server: { command: "   ", url: "https://mcp.acme.dev", transport: "sse" },
    });

    expect(state.enterpriseMcpDraft?.transport).toBe("sse");
    expect(state.enterpriseMcpDraft?.url).toBe("https://mcp.acme.dev");
  });
});

describe("visual tree edit transaction", () => {
  async function setup() {
    const { state, request } = createState();
    const tree = treeDetail("acme.support");
    state.enterpriseSelectedTreeId = tree.id;
    state.enterpriseTreeDetail = tree;
    request.mockImplementation(async (method) => {
      if (method === "enterprise.trees.export") {
        return { content: supportExportContent() };
      }
      if (method === "enterprise.trees.import") {
        return { ok: true, treeId: tree.id };
      }
      if (method === "enterprise.trees.get") {
        return { tree };
      }
      if (method === "enterprise.trees.list") {
        return { trees: [], importErrors: [] };
      }
      if (method === "enterprise.trees.history.list") {
        return { versions: [] };
      }
      if (method === "tools.catalog") {
        return { groups: [] };
      }
      if (method === "skills.status") {
        return { skills: [] };
      }
      return { foundations: [] };
    });
    await beginEditEnterpriseTree(state, true);
    request.mockClear();
    return { state, request, tree };
  }

  it("requires edit mode before opening forms or removing bindings", async () => {
    const { state, request } = createState();
    state.enterpriseSelectedTreeId = "acme.support";
    state.enterpriseTreeDetail = treeDetail("acme.support");
    beginAddEnterpriseNode(state, "acme.support.root");
    openEnterpriseBindingPicker(state, "acme.support.root", "allowedTools");
    editEnterpriseNodeGuidance(state, "acme.support.root", { title: "Changed" });
    await removeEnterpriseBinding(state, {
      nodeId: "acme.support.root",
      field: "allowedTools",
      entry: "read",
    });
    expect(state.enterpriseNodeDraft).toBeNull();
    expect(state.enterpriseBindingPicker).toBeNull();
    expect(state.enterpriseGuidanceDraft).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("combines additions and removals locally and imports only after Save confirmation", async () => {
    const { state, request, tree } = await setup();
    openEnterpriseBindingPicker(state, "acme.support.root", "allowedTools");
    toggleEnterpriseBindingPickerValue(state, "knowledge_search");
    toggleEnterpriseBindingPickerValue(state, "read");
    await submitEnterpriseBindingPicker(state);
    await removeEnterpriseBinding(state, {
      nodeId: "acme.support.root",
      field: "allowedTools",
      entry: "read",
    });
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.child", title: "Child" });
    await submitAddEnterpriseNode(state);
    expect(state.enterpriseTreeDetail?.nodes.map((node) => node.id)).toContain(
      "acme.support.child",
    );
    expect(request).not.toHaveBeenCalled();
    const draft = JSON.parse(state.enterpriseTreeEditContent);
    expect(draft.root.ontology.allowedTools).toContain("knowledge_search");
    expect(draft.root.ontology.allowedTools).not.toContain("read");
    requestSaveEnterpriseTree(state);
    expect(state.enterpriseTreeConfirm).toEqual({ kind: "save" });
    expect(request).not.toHaveBeenCalled();
    cancelEnterpriseTreeConfirm(state);
    expect(state.enterpriseTreeEditing).toBe(true);
    requestSaveEnterpriseTree(state);
    await confirmEnterpriseTreeAction(state);
    const imports = request.mock.calls.filter(([method]) => method === "enterprise.trees.import");
    expect(imports).toHaveLength(1);
    expect(imports[0][1]).toMatchObject({ expectedHash: tree.hash, format: "json" });
    expect(JSON.parse((imports[0][1] as { content: string }).content)).toEqual(draft);
    expect(state.enterpriseTreeEditing).toBe(false);
    expect(state.enterpriseVisualEditOriginal).toBeNull();
  });

  it("cancel restores every local edit without a write", async () => {
    const { state, request, tree } = await setup();
    editEnterpriseNodeGuidance(state, "acme.support.root", { title: "Changed" });
    await saveEnterpriseNodeGuidance(state, "acme.support.root");
    await toggleEnterpriseCapabilityGrants(state);
    await enableEnterpriseMcpGovernance(state, "acme.support.root");
    await toggleEnterpriseCapabilityGrants(state);
    await disableEnterpriseMcpGovernance(state);
    expect(state.enterpriseTreeDetail?.nodes[0].title).toBe("Changed");
    cancelEditEnterpriseTree(state);
    expect(state.enterpriseTreeDetail).toEqual(tree);
    expect(state.enterpriseTreeEditContent).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps staged changes when the server rejects the original hash", async () => {
    const { state, request } = await setup();
    await toggleEnterpriseCapabilityGrants(state);
    const content = state.enterpriseTreeEditContent;
    request.mockResolvedValue({
      ok: false,
      issues: [{ path: "id", message: "changed since it was loaded" }],
    });
    requestSaveEnterpriseTree(state);
    await confirmEnterpriseTreeAction(state);
    expect(state.enterpriseTreeEditing).toBe(true);
    expect(state.enterpriseTreeEditContent).toBe(content);
    expect(state.enterpriseTreeSaveIssues?.[0].message).toContain("changed since");
  });

  it("preserves the visible draft and save error across sidebar refreshes", async () => {
    const { state, request } = await setup();
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.child", title: "Child" });
    await submitAddEnterpriseNode(state);
    selectEnterpriseNode(state, "acme.support.child");
    state.enterpriseTreeSaveError = "Save was refused";
    const content = state.enterpriseTreeEditContent;
    await refreshEnterprise(state);
    expect(state.enterpriseTreeDetail?.nodes.map((node) => node.id)).toContain(
      "acme.support.child",
    );
    expect(state.enterpriseSelectedNodeId).toBe("acme.support.child");
    expect(state.enterpriseTreeEditContent).toBe(content);
    expect(state.enterpriseTreeSaveError).toBe("Save was refused");
    expect(request).not.toHaveBeenCalledWith("enterprise.trees.get", expect.anything());
    editEnterpriseNodeGuidance(state, "acme.support.child", { title: "Renamed child" });
    await saveEnterpriseNodeGuidance(state, "acme.support.child");
    expect(state.enterpriseTreeDetail?.nodes[1].title).toBe("Renamed child");
  });

  it("requires inline forms to be applied before Save and discards them on cancel", async () => {
    const { state, request } = await setup();
    editEnterpriseNodeGuidance(state, "acme.support.root", { title: "Pending" });
    requestSaveEnterpriseTree(state);
    expect(state.enterpriseTreeConfirm).toBeNull();
    cancelEditEnterpriseTree(state);
    expect(state.enterpriseGuidanceDraft).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["skills", "Refund Policy", "skill-name-invalid"],
    ["knowledgeFoundations", "Acme Runbooks", "foundation-id-invalid"],
  ] as const)("validates %s before changing the draft", async (field, value, failure) => {
    const { state, request } = await setup();
    const content = state.enterpriseTreeEditContent;
    openEnterpriseBindingPicker(state, "acme.support.root", field);
    setEnterpriseBindingPickerCustom(state, value);
    await submitEnterpriseBindingPicker(state);
    expect(state.enterpriseBindingPicker?.failure?.kind).toBe(failure);
    expect(state.enterpriseTreeEditContent).toBe(content);
    expect(request).not.toHaveBeenCalled();
  });

  it("can remove a newly added step and cancel a binding picker without persisting", async () => {
    const { state, request } = await setup();
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.child", title: "Child" });
    await submitAddEnterpriseNode(state);
    await removeEnterpriseNode(state, "acme.support.child");
    expect(state.enterpriseTreeDetail?.nodes).toHaveLength(1);
    openEnterpriseBindingPicker(state, "acme.support.root", "skills");
    toggleEnterpriseBindingPickerValue(state, "refund-policy");
    cancelEnterpriseBindingPicker(state);
    expect(JSON.parse(state.enterpriseTreeEditContent).root.ontology.skills).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("checks duplicate steps and ontology errors against the current draft", async () => {
    const { state, request } = await setup();
    beginAddEnterpriseNode(state, "acme.support.root");
    editEnterpriseNodeDraft(state, { id: "acme.support.root", title: "Duplicate" });
    await submitAddEnterpriseNode(state);
    expect(state.enterpriseNodeDraft?.error).toBe("id-duplicate");
    cancelAddEnterpriseNode(state);
    beginEnterpriseOntologyDraft(state, {
      kind: "constraint",
      nodeId: "acme.support.root",
      id: "receipt",
      description: "   ",
    });
    await submitEnterpriseOntologyDraft(state);
    expect(state.enterpriseOntologyDraft?.error).toBe("description-empty");
    editEnterpriseOntologyDraft(state, { description: "Keep the receipt." });
    await submitEnterpriseOntologyDraft(state);
    expect(JSON.parse(state.enterpriseTreeEditContent).root.ontology.constraints).toEqual([
      { id: "receipt", description: "Keep the receipt." },
    ]);
    expect(request).not.toHaveBeenCalled();
  });
});
