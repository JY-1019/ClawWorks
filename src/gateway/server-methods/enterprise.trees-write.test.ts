import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateWorkflowTreeRegistry } from "../../enterprise/tree-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { enterpriseHandlers } from "./enterprise.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-trees-write-"));
const stateDatabasePath = path.join(tempDir, "state", "openclaw.sqlite");
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

// Write a row whose definition_json fails validation, so it surfaces as an
// import load failure (rowError) rather than a usable tree definition.
function insertCorruptTreeRow(treeId: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(stateDatabasePath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO enterprise_workflow_trees
         (tree_id, version, name, definition_json, source_format, imported_at, updated_at)
       VALUES (?, '1.0.0', 'Corrupt', '{"not":"a valid tree"}', 'json', 1, 1)`,
    ).run(treeId);
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

// Each test seeds its own tree id so the suite is independent of execution order
// (a Vitest name filter runs one `it` in isolation).
function importTree(id: string, version: string) {
  return invoke("enterprise.trees.import", { content: treeContent(id, version), format: "json" });
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
  it("imports a new tree, then records the overwrite as a replacement", () => {
    const first = importTree("w.import", "1.0.0");
    expect(first.ok).toBe(true);
    expect(first.payload).toEqual({ ok: true, treeId: "w.import", replaced: null });

    const second = importTree("w.import", "2.0.0");
    expect(second.payload).toEqual({ ok: true, treeId: "w.import", replaced: "imported" });
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

  it("removes an imported tree and is idempotent", () => {
    importTree("w.remove", "1.0.0");
    expect(invoke("enterprise.trees.remove", { treeId: "w.remove" }).payload).toEqual({
      removed: true,
    });
    expect(invoke("enterprise.trees.remove", { treeId: "w.remove" }).payload).toEqual({
      removed: false,
    });
  });

  it("retains version history after removal (append-only audit trail)", () => {
    importTree("w.retain", "1.0.0");
    importTree("w.retain", "2.0.0");
    expect(invoke("enterprise.trees.remove", { treeId: "w.retain" }).payload).toEqual({
      removed: true,
    });
    const { payload } = invoke("enterprise.trees.history.list", { treeId: "w.retain" });
    const { versions } = payload as { versions: Array<{ revision: number }> };
    expect(versions.map((entry) => entry.revision)).toEqual([2, 1]);
  });
});
