import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  exportWorkflowTree,
  importWorkflowTreeContent,
  inferWorkflowTreeFileFormat,
  parseWorkflowTreeContent,
  removeImportedWorkflowTree,
  serializeWorkflowTree,
} from "./tree-io.js";
import { invalidateWorkflowTreeRegistry, listWorkflowTreesForRuntime } from "./tree-registry.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-tree-io-"));
const storeOptions = { stateDatabasePath: path.join(tempDir, "openclaw.sqlite") };
const FIXTURE = path.join(process.cwd(), "test/fixtures/enterprise/customer-support.tree.yaml");

afterEach(() => {
  invalidateWorkflowTreeRegistry();
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
