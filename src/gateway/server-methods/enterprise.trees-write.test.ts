import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashWorkflowTree } from "../../enterprise/plan.js";
import {
  getWorkflowTreeRegistrySnapshot,
  invalidateWorkflowTreeRegistry,
} from "../../enterprise/tree-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { enterpriseHandlers } from "./enterprise.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-trees-write-"));
const stateDatabasePath = path.join(tempDir, "state", "openclaw.sqlite");
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

// Write a row whose definition_json fails validation, so it surfaces as an
// import load failure (rowError) rather than a usable tree definition.
function insertCorruptTreeRow(treeId: string, marker = 1): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(stateDatabasePath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO enterprise_workflow_trees
         (tree_id, version, name, definition_json, source_format, imported_at, updated_at)
       VALUES (?, ?, ?, ?, 'json', ?, ?)`,
    ).run(
      treeId,
      `${marker}.0.0`,
      `Corrupt ${marker}`,
      JSON.stringify({ not: "a valid tree", marker }),
      marker,
      marker,
    );
  } finally {
    db.close();
  }
}

function invoke(method: string, params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
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

async function invokeAsync(method: string, params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await enterpriseHandlers[method]?.({
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

function treeContent(id: string, version: string): string {
  return JSON.stringify({
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id,
    version,
    name: `Tree ${id}`,
    root: { id: "root", title: "Root" },
  });
}

function bundleContent(id: string, version: string): string {
  return JSON.stringify({
    schema: "clawworks.workflow-bundle",
    schemaVersion: 1,
    trees: [
      {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id,
        version,
        name: `Bundle ${id}`,
        root: {
          id: "root",
          title: "Root",
          ontology: {
            allowedTools: ["read_*"],
            skills: ["bundle-skill"],
            knowledgeFoundations: ["bundle.kb", "remote.kb"],
            mcpServers: ["bundle-mcp"],
          },
        },
      },
    ],
    knowledgeFoundations: [
      {
        id: "bundle.kb",
        descriptor: { kind: "local", displayName: "Bundle KB" },
        snippets: [{ foundationId: "bundle.kb", text: "Portable content" }],
      },
    ],
    requiredTools: ["read_*"],
    requiredSkills: ["bundle-skill"],
    requiredMcpServers: ["bundle-mcp"],
    governanceMode: "enforce",
    governancePolicies: [{ id: "bundle.deny", effect: "deny", tools: ["danger"] }],
  });
}

// Each test seeds its own tree id so the suite is independent of execution order
// (a Vitest name filter runs one `it` in isolation).
function importTree(
  id: string,
  version: string,
  precondition?: { createOnly: true } | { expectedHash: string },
) {
  const current = getWorkflowTreeRegistrySnapshot().entries.find((entry) => entry.tree.id === id);
  const guard =
    precondition ??
    (current ? { expectedHash: hashWorkflowTree(current.tree) } : { createOnly: true as const });
  return invoke("enterprise.trees.import", {
    content: treeContent(id, version),
    format: "json",
    ...guard,
  });
}

function treeHash(id: string): string {
  const { tree } = invoke("enterprise.trees.get", { treeId: id }).payload as {
    tree: { hash: string } | null;
  };
  if (!tree) {
    throw new Error(`tree ${id} must exist`);
  }
  return tree.hash;
}

function invalidTreeFingerprint(id: string): string {
  const { importErrors } = invoke("enterprise.trees.list", {}).payload as {
    importErrors: Array<{ treeId: string; fingerprint: string }>;
  };
  const fingerprint = importErrors.find((issue) => issue.treeId === id)?.fingerprint;
  if (!fingerprint) {
    throw new Error(`invalid tree ${id} must have a fingerprint`);
  }
  return fingerprint;
}

beforeAll(() => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();
});

afterAll(() => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("enterprise tree write + history gateway methods", () => {
  it("previews, guarded-imports, exports, and rejects a stale bundle apply", async () => {
    const treeId = "w.bundle-flow";
    const content = bundleContent(treeId, "1.0.0");
    const previewCall = invoke("enterprise.bundles.preview", { content, format: "json" });
    expect(previewCall.ok).toBe(true);
    const preview = previewCall.payload as {
      ok: boolean;
      reviewToken: string;
      trees: Array<{ currentHash: string | null }>;
      missingFoundations: string[];
      removedFoundations: string[];
      replacedFoundations: string[];
      shadowedFoundations: string[];
      requiredSkills: string[];
      requiredMcpServers: string[];
      missingMcpServers: string[];
      missingGovernancePolicies: string[];
    };
    expect(preview).toMatchObject({
      ok: true,
      trees: [{ id: treeId, replaced: null, currentHash: null }],
      missingFoundations: ["remote.kb"],
      removedFoundations: [],
      replacedFoundations: [],
      shadowedFoundations: [],
      requiredSkills: ["bundle-skill"],
      requiredMcpServers: ["bundle-mcp"],
      missingMcpServers: ["bundle-mcp"],
      missingGovernancePolicies: ["bundle.deny"],
    });
    expect(invoke("enterprise.trees.get", { treeId }).payload).toEqual({ tree: null });

    expect(
      invoke("enterprise.bundles.import", {
        content,
        format: "json",
        reviewToken: preview.reviewToken,
        createOnly: true,
      }).payload,
    ).toMatchObject({ ok: true, trees: [{ id: treeId, replaced: null }] });

    const exported = await invokeAsync("enterprise.bundles.export", { treeId, format: "json" });
    expect(exported.ok).toBe(true);
    const exportResult = exported.payload as { ok: boolean; content: string };
    expect(exportResult.ok).toBe(true);
    const bundle = JSON.parse(exportResult.content) as {
      schema: string;
      knowledgeFoundations: Array<{ snippets: Array<{ text: string }> }>;
    };
    expect(bundle.schema).toBe("clawworks.workflow-bundle");
    expect(bundle.knowledgeFoundations[0]?.snippets[0]?.text).toBe("Portable content");

    const updatePreview = invoke("enterprise.bundles.preview", {
      content: bundleContent(treeId, "2.0.0"),
      format: "json",
    }).payload as { ok: boolean; reviewToken: string; trees: Array<{ currentHash: string }> };
    expect(updatePreview.ok).toBe(true);
    const staleHash = updatePreview.trees[0]?.currentHash;
    expect(staleHash).toBeTruthy();
    importTree(treeId, "3.0.0");
    const conflict = invoke("enterprise.bundles.import", {
      content: bundleContent(treeId, "2.0.0"),
      format: "json",
      reviewToken: updatePreview.reviewToken,
      expectedHash: staleHash,
    });
    expect(conflict.ok).toBe(true);
    expect(conflict.payload).toMatchObject({
      ok: false,
      issues: [{ message: expect.stringContaining("changed since preview") }],
    });
    const current = invoke("enterprise.trees.export", { treeId, format: "json" }).payload as {
      content: string;
    };
    expect(JSON.parse(current.content).version).toBe("3.0.0");
    expect(
      invoke("enterprise.trees.remove", { treeId, expectedHash: treeHash(treeId) }).payload,
    ).toEqual({ removed: true });
  });

  it("requires a create or preview-hash guard for bundle apply", () => {
    const content = bundleContent("w.bundle-unguarded", "1.0.0");
    expect(invoke("enterprise.bundles.import", { content, format: "json" }).ok).toBe(false);
    expect(
      invoke("enterprise.bundles.import", {
        content,
        format: "json",
        reviewToken: "0".repeat(64),
        createOnly: true,
        expectedHash: "0".repeat(64),
      }).ok,
    ).toBe(false);
  });

  it("imports a new tree, then records the overwrite as a replacement", () => {
    const first = importTree("w.import", "1.0.0");
    expect(first.ok).toBe(true);
    expect(first.payload).toEqual({ ok: true, treeId: "w.import", replaced: null });

    const second = importTree("w.import", "2.0.0");
    expect(second.payload).toEqual({ ok: true, treeId: "w.import", replaced: "imported" });
  });

  it("forwards createOnly and rejects an existing id without overwriting", () => {
    expect(importTree("w.create-only", "1.0.0", { createOnly: true }).payload).toMatchObject({
      ok: true,
    });

    const conflict = importTree("w.create-only", "2.0.0", { createOnly: true });
    expect(conflict.ok).toBe(true);
    expect(conflict.payload).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: expect.stringContaining("already exists") }],
    });
    const exported = invoke("enterprise.trees.export", {
      treeId: "w.create-only",
      format: "json",
    }).payload as { content: string };
    expect(JSON.parse(exported.content).version).toBe("1.0.0");
  });

  it("rejects contradictory import preconditions at the protocol boundary", () => {
    expect(
      importTree("w.invalid-import-guard", "1.0.0", {
        createOnly: true,
        expectedHash: "0".repeat(64),
      }).ok,
    ).toBe(false);
    expect(
      invoke("enterprise.trees.import", {
        content: treeContent("w.invalid-create-only", "1.0.0"),
        format: "json",
        createOnly: false,
      }).ok,
    ).toBe(false);
  });

  it("forwards expectedHash and rejects stale writes without overwriting", () => {
    expect(importTree("w.expected-hash", "1.0.0").payload).toMatchObject({ ok: true });
    const detail = invoke("enterprise.trees.get", { treeId: "w.expected-hash" }).payload as {
      tree: { hash: string };
    };

    expect(
      importTree("w.expected-hash", "2.0.0", { expectedHash: detail.tree.hash }).payload,
    ).toMatchObject({ ok: true, replaced: "imported" });

    const conflict = importTree("w.expected-hash", "3.0.0", {
      expectedHash: detail.tree.hash,
    });
    expect(conflict.ok).toBe(true);
    expect(conflict.payload).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: expect.stringContaining("discard this edit") }],
    });
    const exported = invoke("enterprise.trees.export", {
      treeId: "w.expected-hash",
      format: "json",
    }).payload as { content: string };
    expect(JSON.parse(exported.content).version).toBe("2.0.0");
  });

  it("fails guarded imports closed when the current row cannot be loaded", () => {
    // Materialize the schema even when this test is run alone by name.
    importTree("w.guard-corrupt-seed", "1.0.0");
    insertCorruptTreeRow("w.guard-corrupt");
    invalidateWorkflowTreeRegistry();
    try {
      const create = importTree("w.guard-corrupt", "2.0.0", { createOnly: true });
      expect(create.payload).toMatchObject({ ok: false, issues: expect.any(Array) });

      const update = importTree("w.guard-corrupt", "2.0.0", {
        expectedHash: "0".repeat(64),
      });
      expect(update.payload).toMatchObject({ ok: false, issues: expect.any(Array) });

      const exported = invoke("enterprise.trees.export", {
        treeId: "w.guard-corrupt",
        format: "json",
      }).payload as { content: string | null };
      expect(exported.content).toBeNull();
    } finally {
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(stateDatabasePath);
      try {
        db.prepare("DELETE FROM enterprise_workflow_trees WHERE tree_id = ?").run(
          "w.guard-corrupt",
        );
      } finally {
        db.close();
      }
      invalidateWorkflowTreeRegistry();
    }
  });

  it("reports schema-invalid content as ok:false issues, not a request error", () => {
    const { ok, payload } = invoke("enterprise.trees.import", {
      content: '{"schema":"clawworks.workflow-tree"}',
      format: "json",
    });
    // The request succeeds; the editor renders the validation issues inline.
    expect(ok).toBe(true);
    const result = payload as { ok: boolean; issues?: Array<{ path: string; message: string }> };
    expect(result.ok).toBe(false);
    expect(result.issues?.length).toBeGreaterThan(0);
  });

  it("rejects invalid import params with a request error", () => {
    const { ok, error } = invoke("enterprise.trees.import", { format: "json" });
    expect(ok).toBe(false);
    expect(error).toBeDefined();
  });

  it("lists the saved revisions newest-first", () => {
    importTree("w.history", "1.0.0");
    importTree("w.history", "2.0.0");
    const { payload } = invoke("enterprise.trees.history.list", { treeId: "w.history" });
    const { versions } = payload as {
      versions: Array<{ revision: number; version: string }>;
    };
    expect(versions.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ revision: 2, version: "2.0.0" });
  });

  it("bounds the history listing by the limit param", () => {
    importTree("w.limit", "1.0.0");
    importTree("w.limit", "2.0.0");
    const { payload } = invoke("enterprise.trees.history.list", { treeId: "w.limit", limit: 1 });
    const { versions } = payload as { versions: Array<{ revision: number }> };
    expect(versions.map((entry) => entry.revision)).toEqual([2]);
  });

  it("loads a prior revision serialized in the requested format", () => {
    importTree("w.revget", "1.0.0");
    importTree("w.revget", "2.0.0");
    const { payload } = invoke("enterprise.trees.history.get", {
      treeId: "w.revget",
      revision: 1,
      format: "json",
    });
    const { content } = payload as { content: string | null };
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content ?? "{}") as { version: string };
    expect(parsed.version).toBe("1.0.0");
  });

  it("returns null content for an unknown revision", () => {
    importTree("w.revnull", "1.0.0");
    const { payload } = invoke("enterprise.trees.history.get", {
      treeId: "w.revnull",
      revision: 99,
      format: "json",
    });
    expect(payload).toEqual({ content: null });
  });

  it("exports the current definition and reports the source", () => {
    importTree("w.export", "1.0.0");
    importTree("w.export", "2.0.0");
    const { payload } = invoke("enterprise.trees.export", { treeId: "w.export", format: "yaml" });
    const result = payload as { content: string | null; source?: string };
    expect(result.source).toBe("imported");
    expect(result.content).toContain("w.export");
    // The exported current definition is the latest overwrite (2.0.0).
    expect(result.content).toContain("2.0.0");
  });

  it("returns null content with a reason when exporting an unknown tree", () => {
    const { payload } = invoke("enterprise.trees.export", {
      treeId: "does.not.exist",
      format: "json",
    });
    const result = payload as { content: string | null; reason?: string };
    expect(result.content).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it("fails closed exporting an id whose imported override failed to load", () => {
    // Materialize the store schema so the raw corrupt-row inserts have a table.
    importTree("w.corrupt.seed", "1.0.0");
    // A corrupt override of a built-in must not silently export the stale
    // built-in: the editor could then save/restore the wrong definition.
    insertCorruptTreeRow("clawworks.system");
    insertCorruptTreeRow("corrupt.export");
    invalidateWorkflowTreeRegistry();
    try {
      const overridden = invoke("enterprise.trees.export", {
        treeId: "clawworks.system",
        format: "json",
      }).payload as { content: string | null; reason?: string };
      expect(overridden.content).toBeNull();
      expect(overridden.reason).toBeTruthy();

      const importedOnly = invoke("enterprise.trees.export", {
        treeId: "corrupt.export",
        format: "yaml",
      }).payload as { content: string | null; reason?: string };
      expect(importedOnly.content).toBeNull();
      expect(importedOnly.reason).toBeTruthy();
    } finally {
      // Remove the corrupt rows so later tests see a healthy registry.
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(stateDatabasePath);
      try {
        db.prepare(
          "DELETE FROM enterprise_workflow_trees WHERE tree_id IN ('clawworks.system', 'corrupt.export')",
        ).run();
      } finally {
        db.close();
      }
      invalidateWorkflowTreeRegistry();
    }
  });

  it("removes only the imported tree version the caller saw", () => {
    importTree("w.remove", "1.0.0");
    const expectedHash = treeHash("w.remove");
    expect(invoke("enterprise.trees.remove", { treeId: "w.remove", expectedHash }).payload).toEqual(
      {
        removed: true,
      },
    );
    expect(invoke("enterprise.trees.remove", { treeId: "w.remove", expectedHash }).payload).toEqual(
      { removed: false, reason: "not-found" },
    );
  });

  it("rejects stale removal without deleting the replacement", () => {
    importTree("w.remove-stale", "1.0.0");
    const staleHash = treeHash("w.remove-stale");
    importTree("w.remove-stale", "2.0.0");

    expect(
      invoke("enterprise.trees.remove", {
        treeId: "w.remove-stale",
        expectedHash: staleHash,
      }).payload,
    ).toEqual({ removed: false, reason: "tree-changed" });
    const exported = invoke("enterprise.trees.export", {
      treeId: "w.remove-stale",
      format: "json",
    }).payload as { content: string };
    expect(JSON.parse(exported.content).version).toBe("2.0.0");
  });

  it("removes an invalid row only through its explicit precondition", () => {
    importTree("w.remove-invalid", "1.0.0");
    insertCorruptTreeRow("w.remove-invalid");
    invalidateWorkflowTreeRegistry();
    const expectedInvalidFingerprint = invalidTreeFingerprint("w.remove-invalid");

    expect(
      invoke("enterprise.trees.remove", {
        treeId: "w.remove-invalid",
        expectedHash: "0".repeat(64),
      }).payload,
    ).toEqual({ removed: false, reason: "tree-unavailable" });
    expect(
      invoke("enterprise.trees.remove", {
        treeId: "w.remove-invalid",
        expectedInvalidFingerprint,
      }).payload,
    ).toEqual({ removed: true });
    const { versions } = invoke("enterprise.trees.history.list", {
      treeId: "w.remove-invalid",
    }).payload as { versions: Array<{ revision: number }> };
    expect(versions.map((entry) => entry.revision)).toEqual([1]);
  });

  it("does not delete a repaired row through a stale invalid-state precondition", () => {
    importTree("w.remove-repaired-seed", "1.0.0");
    insertCorruptTreeRow("w.remove-repaired");
    invalidateWorkflowTreeRegistry();
    const expectedInvalidFingerprint = invalidTreeFingerprint("w.remove-repaired");
    expect(
      invoke("enterprise.trees.remove", {
        treeId: "w.remove-repaired",
        expectedInvalidFingerprint,
      }).payload,
    ).toEqual({ removed: true });
    importTree("w.remove-repaired", "2.0.0", { createOnly: true });

    expect(
      invoke("enterprise.trees.remove", {
        treeId: "w.remove-repaired",
        expectedInvalidFingerprint,
      }).payload,
    ).toEqual({ removed: false, reason: "tree-changed" });
    expect(treeHash("w.remove-repaired")).toBeTruthy();
  });

  it("does not delete a different invalid row through a stale fingerprint", () => {
    const treeId = "w.remove-invalid-replaced";
    importTree("w.remove-invalid-replaced-seed", "1.0.0");
    insertCorruptTreeRow(treeId, 1);
    invalidateWorkflowTreeRegistry();
    const staleFingerprint = invalidTreeFingerprint(treeId);

    insertCorruptTreeRow(treeId, 2);
    invalidateWorkflowTreeRegistry();
    const replacementFingerprint = invalidTreeFingerprint(treeId);
    expect(replacementFingerprint).not.toBe(staleFingerprint);

    expect(
      invoke("enterprise.trees.remove", {
        treeId,
        expectedInvalidFingerprint: staleFingerprint,
      }).payload,
    ).toEqual({ removed: false, reason: "tree-changed" });
    expect(invalidTreeFingerprint(treeId)).toBe(replacementFingerprint);
    expect(
      invoke("enterprise.trees.remove", {
        treeId,
        expectedInvalidFingerprint: replacementFingerprint,
      }).payload,
    ).toEqual({ removed: true });
  });

  it("refuses unguarded and contradictory removals without deleting the tree", () => {
    importTree("w.remove-invalid-params", "1.0.0");
    const expectedHash = treeHash("w.remove-invalid-params");
    expect(
      invoke("enterprise.trees.remove", { treeId: "w.remove-invalid-params" }).payload,
    ).toEqual({ removed: false, reason: "precondition-required" });
    expect(
      invoke("enterprise.trees.remove", {
        treeId: "w.remove-invalid-params",
        expectedHash,
        expectedInvalidFingerprint: "1".repeat(64),
      }).payload,
    ).toEqual({ removed: false, reason: "precondition-required" });
    expect(treeHash("w.remove-invalid-params")).toBe(expectedHash);
  });

  it("retains version history after removal (append-only audit trail)", () => {
    importTree("w.retain", "1.0.0");
    importTree("w.retain", "2.0.0");
    expect(
      invoke("enterprise.trees.remove", {
        treeId: "w.retain",
        expectedHash: treeHash("w.retain"),
      }).payload,
    ).toEqual({ removed: true });
    const { payload } = invoke("enterprise.trees.history.list", { treeId: "w.retain" });
    const { versions } = payload as { versions: Array<{ revision: number }> };
    expect(versions.map((entry) => entry.revision)).toEqual([2, 1]);
    const list = invoke("enterprise.trees.list", {}).payload as { historyOnlyTreeIds?: string[] };
    expect(list.historyOnlyTreeIds).toContain("w.retain");
  });
});

describe("enterprise.trees.import warnings", () => {
  it("reports declarations no run can reach on a tree that imported cleanly", () => {
    // The GUI authoring path only ever saw `issues`, so a work-map that saved
    // fine but attaches a knowledge source every path excludes shipped silently.
    const content = JSON.stringify({
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "warn.knowledge",
      version: "1.0.0",
      name: "Warned",
      root: {
        id: "root",
        title: "Root",
        ontology: { knowledgeFoundations: ["acme.handbook"] },
        children: [
          {
            id: "billing",
            title: "Billing",
            description: "Billing work",
            ontology: { knowledgeFoundations: ["acme.invoices"] },
          },
        ],
      },
    });
    const { payload } = invoke("enterprise.trees.import", {
      content,
      format: "json",
      createOnly: true,
    });
    const result = payload as {
      ok: boolean;
      warnings?: Array<{ path: string; message: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.warnings?.map((warning) => warning.path)).toEqual([
      "node.root.ontology.knowledgeFoundations",
      "node.billing.ontology.knowledgeFoundations",
    ]);
  });

  it("omits the field entirely for a work-map with nothing to flag", () => {
    const { payload } = invoke("enterprise.trees.import", {
      content: treeContent("warn.clean", "1.0.0"),
      format: "json",
      createOnly: true,
    });
    expect((payload as { ok: boolean; warnings?: unknown }).warnings).toBeUndefined();
  });
});
