/**
 * Tests `openclaw enterprise` command output against a fake runtime: tree
 * validate/import/export/remove flows and run trace inspection.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginEnterpriseRun,
  clearEnterpriseRunMediationForTest,
  endEnterpriseRun,
} from "../enterprise/run-mediation.js";
import { removeImportedWorkflowTree } from "../enterprise/tree-io.js";
import { invalidateWorkflowTreeRegistry } from "../enterprise/tree-registry.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  enterpriseRunsListCommand,
  enterpriseRunsShowCommand,
  enterpriseTreesExportCommand,
  enterpriseTreesImportCommand,
  enterpriseTreesListCommand,
  enterpriseTreesRemoveCommand,
  enterpriseTreesValidateCommand,
} from "./enterprise.js";

const FIXTURE = path.join(process.cwd(), "test/fixtures/enterprise/customer-support.tree.yaml");
const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-cli-"));

type FakeRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
  logs: string[];
  errors: string[];
  exitCodes: number[];
};

function makeRuntime(): FakeRuntime {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  return {
    logs,
    errors,
    exitCodes,
    log: (...args: unknown[]) => logs.push(args.join(" ")),
    error: (...args: unknown[]) => errors.push(args.join(" ")),
    exit: (code: number) => exitCodes.push(code),
  };
}

beforeEach(() => {
  invalidateWorkflowTreeRegistry();
});

afterEach(() => {
  removeImportedWorkflowTree("acme.customer-support");
  clearEnterpriseRunMediationForTest();
  invalidateWorkflowTreeRegistry();
});

afterAll(() => {
  closeOpenClawStateDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("enterprise trees commands", () => {
  it("validates the example fixture", () => {
    const runtime = makeRuntime();
    enterpriseTreesValidateCommand(FIXTURE, runtime);
    expect(runtime.exitCodes).toEqual([]);
    expect(runtime.logs.join("\n")).toContain("acme.customer-support@1.2.0");
  });

  it("rejects invalid files with path-scoped issues and exit 1", () => {
    const badFile = path.join(tempDir, "bad.json");
    writeFileSync(badFile, JSON.stringify({ schema: "clawworks.workflow-tree" }), "utf8");
    const runtime = makeRuntime();
    enterpriseTreesValidateCommand(badFile, runtime);
    expect(runtime.exitCodes).toEqual([1]);
    expect(runtime.errors.join("\n")).toContain("Invalid workflow tree definition");
  });

  it("rejects unsupported extensions", () => {
    const runtime = makeRuntime();
    enterpriseTreesValidateCommand(path.join(tempDir, "tree.txt"), runtime);
    expect(runtime.exitCodes).toEqual([1]);
    expect(runtime.errors.join("\n")).toContain("Unsupported file extension");
  });

  it("imports, lists, exports, and removes a tree end to end", () => {
    const importRuntime = makeRuntime();
    enterpriseTreesImportCommand(FIXTURE, importRuntime);
    expect(importRuntime.exitCodes).toEqual([]);
    expect(importRuntime.logs.join("\n")).toContain("Imported: acme.customer-support@1.2.0");

    const listRuntime = makeRuntime();
    enterpriseTreesListCommand(listRuntime, { json: true });
    const listed = JSON.parse(listRuntime.logs.join("\n")) as {
      trees: Array<{ id: string; source: string }>;
      importErrors: unknown[];
    };
    expect(listRuntime.exitCodes).toEqual([]);
    expect(listed.importErrors).toEqual([]);
    expect(listed.trees.some((entry) => entry.id === "acme.customer-support")).toBe(true);
    expect(listed.trees.some((entry) => entry.id === "clawworks.assist")).toBe(true);

    const outFile = path.join(tempDir, "exported.tree.json");
    const exportRuntime = makeRuntime();
    enterpriseTreesExportCommand("acme.customer-support", exportRuntime, { out: outFile });
    expect(exportRuntime.exitCodes).toEqual([]);
    const exported = JSON.parse(readFileSync(outFile, "utf8")) as { id: string };
    expect(exported.id).toBe("acme.customer-support");

    const removeRuntime = makeRuntime();
    enterpriseTreesRemoveCommand("acme.customer-support", removeRuntime);
    expect(removeRuntime.exitCodes).toEqual([]);
    expect(removeRuntime.logs.join("\n")).toContain("Removed imported workflow tree");
  });

  it("reports export/remove failures with exit 1", () => {
    const exportRuntime = makeRuntime();
    enterpriseTreesExportCommand("nope.missing", exportRuntime, {});
    expect(exportRuntime.exitCodes).toEqual([1]);

    const removeRuntime = makeRuntime();
    enterpriseTreesRemoveCommand("clawworks.assist", removeRuntime);
    expect(removeRuntime.exitCodes).toEqual([1]);
    expect(removeRuntime.errors.join("\n")).toContain("Built-in trees cannot be removed");
  });
});

describe("enterprise runs commands", () => {
  it("shows recorded run traces", () => {
    const runId = "cli-trace-run-1";
    beginEnterpriseRun({ runId, prompt: "hello from cli test" });
    endEnterpriseRun({ runId, status: "completed" });

    const listRuntime = makeRuntime();
    enterpriseRunsListCommand(listRuntime, {});
    expect(listRuntime.logs.join("\n")).toContain(`run=${runId}`);

    const showRuntime = makeRuntime();
    enterpriseRunsShowCommand(runId, showRuntime, {});
    const output = showRuntime.logs.join("\n");
    expect(output).toContain(`Run ${runId}`);
    expect(output).toContain("Tree: clawworks.assist@1.0.0");
    expect(output).toContain("run.started");
    expect(output).toContain("run.ended");
  });

  it("exits 1 for unknown runIds", () => {
    const runtime = makeRuntime();
    enterpriseRunsShowCommand("no-such-run", runtime, {});
    expect(runtime.exitCodes).toEqual([1]);
  });
});
