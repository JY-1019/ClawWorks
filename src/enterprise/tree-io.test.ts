import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resetPersistedBundleFoundationsForTest } from "./knowledge-bundle-loader.js";
import { getOntologyObject, upsertOntologyObject } from "./object-store.sqlite.js";
import { hashWorkflowTree } from "./plan.js";
import {
  exportWorkflowTree,
  importWorkflowTreeContent,
  inferWorkflowTreeFileFormat,
  parseWorkflowTreeContent,
  removeImportedWorkflowTree,
  removeImportedWorkflowTreeIfUnchanged,
  serializeWorkflowTree,
} from "./tree-io.js";
import { invalidateWorkflowTreeRegistry, listWorkflowTreesForRuntime } from "./tree-registry.js";
import { listEnterpriseWorkflowTreeVersions } from "./tree-store.sqlite.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-tree-io-"));
const storeOptions = { stateDatabasePath: path.join(tempDir, "openclaw.sqlite") };
const FIXTURE = path.join(process.cwd(), "test/fixtures/enterprise/customer-support.tree.yaml");

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

async function beginConcurrentTreeInsert(
  treeId: string,
  version: string,
): Promise<{ exit: Promise<void> }> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        db.exec("BEGIN IMMEDIATE;");
        db.prepare(
          "INSERT INTO enterprise_workflow_trees (tree_id, version, name, definition_json, source_format, imported_at, updated_at) VALUES (?, ?, ?, ?, 'json', ?, ?)",
        ).run(process.argv[2], process.argv[3], process.argv[4], process.argv[5], Date.now(), Date.now());
        process.stdout.write("locked\\n");
        setTimeout(() => {
          db.exec("COMMIT;");
          db.close();
        }, 250);
      `,
      storeOptions.stateDatabasePath,
      treeId,
      version,
      `Tree ${treeId}`,
      treeContent(treeId, version),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`contention child exited with code ${code}`));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    let locked = false;
    child.stdout.once("data", () => {
      locked = true;
      resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!locked) {
        reject(new Error(`contention child exited before locking with code ${code}`));
      }
    });
  });
  return { exit };
}

afterEach(() => {
  invalidateWorkflowTreeRegistry();
  // import/remove reload the bundle registry and set the once-guard; reset it so a
  // later test in the same worker (--isolate=false) re-hydrates from its fixture.
  resetPersistedBundleFoundationsForTest();
});

afterAll(() => {
  closeOpenClawStateDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("inferWorkflowTreeFileFormat", () => {
  it("maps extensions onto exchange formats", () => {
    expect(inferWorkflowTreeFileFormat("tree.yaml")).toBe("yaml");
    expect(inferWorkflowTreeFileFormat("TREE.YML")).toBe("yaml");
    expect(inferWorkflowTreeFileFormat("tree.json")).toBe("json");
    expect(inferWorkflowTreeFileFormat("tree.txt")).toBeUndefined();
  });
});

describe("parseWorkflowTreeContent", () => {
  it("parses the shipped example fixture", () => {
    const result = parseWorkflowTreeContent(readFileSync(FIXTURE, "utf8"), "yaml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tree.id).toBe("acme.customer-support");
      expect(result.tree.root.children).toHaveLength(3);
      expect(result.tree.root.ontology?.allowedTools).toContain("memory_search");
    }
  });

  it("surfaces syntax errors as a single root issue", () => {
    const result = parseWorkflowTreeContent("{not json", "json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].message).toContain("invalid JSON");
    }
  });

  it("surfaces schema issues with dot paths", () => {
    const result = parseWorkflowTreeContent(
      JSON.stringify({
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "Bad Id",
        version: "1",
        name: "x",
        root: { id: "root", title: "Root" },
      }),
      "json",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("id");
    }
  });
});

describe("import/export roundtrip", () => {
  it("imports, exports, and removes trees with registry refresh", () => {
    const content = readFileSync(FIXTURE, "utf8");
    const imported = importWorkflowTreeContent({ content, format: "yaml" }, storeOptions);
    expect(imported.ok).toBe(true);
    expect(imported.ok && imported.replaced).toBeNull();

    const runtimeTrees = listWorkflowTreesForRuntime(storeOptions);
    expect(runtimeTrees.some((tree) => tree.id === "acme.customer-support")).toBe(true);

    const exportedYaml = exportWorkflowTree(
      { treeId: "acme.customer-support", format: "yaml" },
      storeOptions,
    );
    expect(exportedYaml.ok).toBe(true);
    if (exportedYaml.ok) {
      expect(exportedYaml.source).toBe("imported");
      const reparsed = parseWorkflowTreeContent(exportedYaml.content, "yaml");
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) {
        expect(reparsed.tree).toEqual(imported.ok ? imported.tree : undefined);
      }
    }

    invalidateWorkflowTreeRegistry();
    expect(removeImportedWorkflowTree("acme.customer-support", storeOptions)).toBe(true);
    invalidateWorkflowTreeRegistry();
    expect(
      listWorkflowTreesForRuntime(storeOptions).some((tree) => tree.id === "acme.customer-support"),
    ).toBe(false);
  });

  it("re-import reports replacement and builtin override is reported", () => {
    const content = readFileSync(FIXTURE, "utf8");
    importWorkflowTreeContent({ content, format: "yaml" }, storeOptions);
    invalidateWorkflowTreeRegistry();
    const second = importWorkflowTreeContent({ content, format: "yaml" }, storeOptions);
    expect(second.ok && second.replaced).toBe("imported");

    const builtinOverride = importWorkflowTreeContent(
      {
        content: JSON.stringify({
          schema: "clawworks.workflow-tree",
          schemaVersion: 1,
          id: "clawworks.assist",
          version: "9.0.0",
          name: "Custom assist",
          root: { id: "assist", title: "Custom assist root" },
        }),
        format: "json",
      },
      storeOptions,
    );
    expect(builtinOverride.ok && builtinOverride.replaced).toBe("builtin");
    invalidateWorkflowTreeRegistry();
    const assist = listWorkflowTreesForRuntime(storeOptions).find(
      (tree) => tree.id === "clawworks.assist",
    );
    expect(assist?.version).toBe("9.0.0");

    removeImportedWorkflowTree("clawworks.assist", storeOptions);
    removeImportedWorkflowTree("acme.customer-support", storeOptions);
    invalidateWorkflowTreeRegistry();
    const restored = listWorkflowTreesForRuntime(storeOptions).find(
      (tree) => tree.id === "clawworks.assist",
    );
    expect(restored?.version).toBe("1.0.0");
  });

  it("rejects create-only imports when any current tree uses the id", () => {
    const treeId = "acme.create-only";
    expect(
      importWorkflowTreeContent(
        { content: treeContent(treeId, "1.0.0"), format: "json", createOnly: true },
        storeOptions,
      ).ok,
    ).toBe(true);

    const importedConflict = importWorkflowTreeContent(
      { content: treeContent(treeId, "2.0.0"), format: "json", createOnly: true },
      storeOptions,
    );
    expect(importedConflict).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: expect.stringContaining("already exists") }],
    });
    const unchanged = exportWorkflowTree({ treeId, format: "json" }, storeOptions);
    expect(unchanged.ok && JSON.parse(unchanged.content).version).toBe("1.0.0");

    const builtinConflict = importWorkflowTreeContent(
      {
        content: treeContent("clawworks.assist", "9.0.0"),
        format: "json",
        createOnly: true,
      },
      storeOptions,
    );
    expect(builtinConflict).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: expect.stringContaining("already exists") }],
    });
    removeImportedWorkflowTree(treeId, storeOptions);
  });

  it("requires expectedHash to match an existing current definition", () => {
    const treeId = "acme.expected-hash";
    const missing = importWorkflowTreeContent(
      {
        content: treeContent(treeId, "1.0.0"),
        format: "json",
        expectedHash: "0".repeat(64),
      },
      storeOptions,
    );
    expect(missing).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: expect.stringContaining("changed") }],
    });

    const initial = importWorkflowTreeContent(
      { content: treeContent(treeId, "1.0.0"), format: "json" },
      storeOptions,
    );
    if (!initial.ok) {
      throw new Error("initial tree import must succeed");
    }
    const initialHash = hashWorkflowTree(initial.tree);
    const updated = importWorkflowTreeContent(
      {
        content: treeContent(treeId, "2.0.0"),
        format: "json",
        expectedHash: initialHash,
      },
      storeOptions,
    );
    expect(updated.ok && updated.tree.version).toBe("2.0.0");

    const conflict = importWorkflowTreeContent(
      {
        content: treeContent(treeId, "3.0.0"),
        format: "json",
        expectedHash: initialHash,
      },
      storeOptions,
    );
    expect(conflict).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: expect.stringContaining("discard this edit") }],
    });
    const unchanged = exportWorkflowTree({ treeId, format: "json" }, storeOptions);
    expect(unchanged.ok && JSON.parse(unchanged.content).version).toBe("2.0.0");
    removeImportedWorkflowTree(treeId, storeOptions);

    const builtin = listWorkflowTreesForRuntime(storeOptions).find(
      (tree) => tree.id === "clawworks.assist",
    );
    if (!builtin) {
      throw new Error("assist builtin must exist");
    }
    const builtinOverride = importWorkflowTreeContent(
      {
        content: treeContent(builtin.id, "9.0.0"),
        format: "json",
        expectedHash: hashWorkflowTree(builtin),
      },
      storeOptions,
    );
    expect(builtinOverride.ok && builtinOverride.replaced).toBe("builtin");
    removeImportedWorkflowTree(builtin.id, storeOptions);
  });

  it.each([
    ["createOnly", { createOnly: true }],
    ["expectedHash", { expectedHash: "loaded-tree-hash" }],
  ] as const)(
    "propagates %s store failures instead of reporting an edit conflict",
    (_name, guard) => {
      const invalidDatabasePath = path.join(tempDir, "database-is-a-directory");
      mkdirSync(invalidDatabasePath, { recursive: true });
      try {
        expect(() =>
          importWorkflowTreeContent(
            {
              content: treeContent("acme.unavailable-store", "1.0.0"),
              format: "json",
              ...guard,
            },
            { stateDatabasePath: invalidDatabasePath },
          ),
        ).toThrow();
      } finally {
        rmSync(invalidDatabasePath, { recursive: true, force: true });
      }
    },
  );

  it("rechecks createOnly after a concurrent writer commits", async () => {
    const treeId = "acme.concurrent-create";
    importWorkflowTreeContent(
      { content: treeContent("acme.concurrent-seed", "1.0.0"), format: "json" },
      storeOptions,
    );
    removeImportedWorkflowTree("acme.concurrent-seed", storeOptions);
    const writer = await beginConcurrentTreeInsert(treeId, "1.0.0");

    let result: ReturnType<typeof importWorkflowTreeContent>;
    try {
      result = importWorkflowTreeContent(
        {
          content: treeContent(treeId, "2.0.0"),
          format: "json",
          createOnly: true,
        },
        storeOptions,
      );
    } finally {
      await writer.exit;
    }

    expect(result).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: expect.stringContaining("already exists") }],
    });
    const unchanged = exportWorkflowTree({ treeId, format: "json" }, storeOptions);
    expect(unchanged.ok && JSON.parse(unchanged.content).version).toBe("1.0.0");
    expect(
      listEnterpriseWorkflowTreeVersions(treeId, storeOptions).map((entry) => entry.revision),
    ).toEqual([]);
    removeImportedWorkflowTree(treeId, storeOptions);
  });

  it("rechecks a concurrently-created override after matching a builtin hash", async () => {
    const treeId = "clawworks.assist";
    const builtin = listWorkflowTreesForRuntime(storeOptions).find((tree) => tree.id === treeId);
    if (!builtin) {
      throw new Error("assist builtin must exist");
    }
    // Materialize the schema so the child can create an imported override while
    // the parent continues to see the committed built-in-only state.
    importWorkflowTreeContent(
      { content: treeContent("acme.concurrent-builtin-seed", "1.0.0"), format: "json" },
      storeOptions,
    );
    removeImportedWorkflowTree("acme.concurrent-builtin-seed", storeOptions);
    const historyBefore = listEnterpriseWorkflowTreeVersions(treeId, storeOptions).map(
      (entry) => entry.revision,
    );
    const writer = await beginConcurrentTreeInsert(treeId, "9.0.0");

    let result: ReturnType<typeof importWorkflowTreeContent>;
    try {
      result = importWorkflowTreeContent(
        {
          content: treeContent(treeId, "10.0.0"),
          format: "json",
          expectedHash: hashWorkflowTree(builtin),
        },
        storeOptions,
      );
    } finally {
      await writer.exit;
    }

    expect(result).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: expect.stringContaining("discard this edit") }],
    });
    const unchanged = exportWorkflowTree({ treeId, format: "json" }, storeOptions);
    expect(unchanged.ok && JSON.parse(unchanged.content).version).toBe("9.0.0");
    expect(
      listEnterpriseWorkflowTreeVersions(treeId, storeOptions).map((entry) => entry.revision),
    ).toEqual(historyBefore);
    removeImportedWorkflowTree(treeId, storeOptions);
  });

  it("keeps a changed tree and its data when guarded removal is stale", () => {
    const treeId = "acme.remove-cas";
    const first = importWorkflowTreeContent(
      { content: treeContent(treeId, "1.0.0"), format: "json" },
      storeOptions,
    );
    const second = importWorkflowTreeContent(
      { content: treeContent(treeId, "2.0.0"), format: "json" },
      storeOptions,
    );
    if (!first.ok || !second.ok) {
      throw new Error("remove CAS fixtures must import");
    }
    runOpenClawStateWriteTransaction(
      (database) =>
        upsertOntologyObject(database, {
          treeId,
          entity: "case",
          objectId: "C-1",
          properties: { id: "C-1" },
        }),
      { path: storeOptions.stateDatabasePath },
    );

    expect(
      removeImportedWorkflowTreeIfUnchanged(
        { treeId, expectedHash: hashWorkflowTree(first.tree) },
        storeOptions,
      ),
    ).toEqual({ removed: false, reason: "tree-changed" });
    const unchanged = exportWorkflowTree({ treeId, format: "json" }, storeOptions);
    expect(unchanged.ok && JSON.parse(unchanged.content).version).toBe("2.0.0");
    expect(
      getOntologyObject({ treeId, entity: "case", objectId: "C-1" }, storeOptions),
    ).not.toBeNull();

    expect(
      removeImportedWorkflowTreeIfUnchanged(
        { treeId, expectedHash: hashWorkflowTree(second.tree) },
        storeOptions,
      ),
    ).toEqual({ removed: true });
    expect(getOntologyObject({ treeId, entity: "case", objectId: "C-1" }, storeOptions)).toBeNull();
  });

  it("export fails with a useful reason for unknown trees", () => {
    const result = exportWorkflowTree({ treeId: "nope.missing", format: "yaml" }, storeOptions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('"nope.missing"');
    }
  });

  it("serializes json exports with a trailing newline", () => {
    const parsed = parseWorkflowTreeContent(readFileSync(FIXTURE, "utf8"), "yaml");
    if (!parsed.ok) {
      throw new Error("fixture must parse");
    }
    const json = serializeWorkflowTree(parsed.tree, "json");
    expect(json.endsWith("}\n")).toBe(true);
    expect(JSON.parse(json)).toEqual(parsed.tree);
  });
});
