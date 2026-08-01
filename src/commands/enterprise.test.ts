/**
 * Tests `openclaw enterprise` command output against a fake runtime: tree
 * validate/import/export/remove flows and run trace inspection.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  beginEnterpriseRun,
  clearEnterpriseRunMediationForTest,
  endEnterpriseRun,
} from "../enterprise/run-mediation.js";
import { removeImportedWorkflowTree } from "../enterprise/tree-io.js";
import { invalidateWorkflowTreeRegistry } from "../enterprise/tree-registry.js";
import type { GovernancePolicy } from "../enterprise/types.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  enterpriseBundleImportCommand,
  enterprisePolicyCompileCommand,
  enterpriseRunsListCommand,
  enterpriseRunsShowCommand,
  enterpriseTreesExportCommand,
  enterpriseTreesImportCommand,
  enterpriseTreesListCommand,
  enterpriseTreesRemoveCommand,
  enterpriseTreesValidateCommand,
} from "./enterprise.js";

// The compiler's model call is exercised in enterprise-policy-compile.runtime.test.ts;
// here we mock it to assert the command's output routing and field sanitization.
vi.mock("../agents/enterprise-policy-compile.runtime.js", () => ({
  compileGovernancePolicy: vi.fn(),
}));
import { compileGovernancePolicy } from "../agents/enterprise-policy-compile.runtime.js";

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
  it("shows recorded run traces", async () => {
    const runId = "cli-trace-run-1";
    // Awaited: mediation persists the run row asynchronously, so the assertions
    // below ran against an empty store while this was fire-and-forget.
    await beginEnterpriseRun({ runId, prompt: "hello from cli test" });
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

describe("enterprise policy compile output", () => {
  type OutputRuntime = FakeRuntime & {
    writeStdout: (value: string) => void;
    writeJson: (value: unknown) => void;
    stdout: string[];
    jsons: unknown[];
  };

  function makeOutputRuntime(): OutputRuntime {
    const base = makeRuntime();
    const stdout: string[] = [];
    const jsons: unknown[] = [];
    return {
      ...base,
      stdout,
      jsons,
      writeStdout: (value: string) => stdout.push(value),
      writeJson: (value: unknown) => jsons.push(value),
    };
  }

  const cfg = {} as OpenClawConfig;

  afterEach(() => {
    vi.mocked(compileGovernancePolicy).mockReset();
  });

  it("writes the raw policy to stdout (not console.log) in --json mode", async () => {
    const policy = {
      id: "refund.approval",
      effect: "require_approval",
      actions: ["issue-refund"],
    } satisfies GovernancePolicy;
    vi.mocked(compileGovernancePolicy).mockResolvedValue({ kind: "compiled", policy });
    const runtime = makeOutputRuntime();
    await enterprisePolicyCompileCommand("intent", runtime, { json: true, cfg, agentId: "main" });
    // --json routes console output to stderr, so the machine contract must go
    // through the stdout writer, never runtime.log.
    expect(runtime.jsons).toEqual([policy]);
    expect(runtime.logs).toEqual([]);
    // The unconditional limitation warning still reaches the operator, on stderr, so
    // stdout stays pure JSON for jq/config tooling.
    expect(runtime.errors.join("\n")).toContain("Selectors match ids");
  });

  it("quotes selectors and shows the full description so the caveat is never truncated", async () => {
    const longNote = `${"x".repeat(220)} THRESHOLD-CAVEAT-END`;
    vi.mocked(compileGovernancePolicy).mockResolvedValue({
      kind: "compiled",
      policy: {
        id: "x.y",
        effect: "deny",
        tools: ["exec, shell", "run"],
        description: longNote,
      } satisfies GovernancePolicy,
    });
    const runtime = makeOutputRuntime();
    await enterprisePolicyCompileCommand("intent", runtime, { cfg, agentId: "main" });
    const summary = runtime.logs.join("\n");
    // A comma-containing glob stays one quoted token, distinct from two globs.
    expect(summary).toContain('"exec, shell"');
    expect(summary).toContain('"run"');
    // The description is shown in full so an appended threshold caveat at the end is
    // never truncated out of the operator's review.
    expect(summary).toContain("THRESHOLD-CAVEAT-END");
  });

  it("marks a no-selector policy as governing every enterprise run", async () => {
    // A selector-less policy is a run-level rule matching every run; the summary must
    // surface that scope so a broad deny is not mistaken for a narrow one.
    vi.mocked(compileGovernancePolicy).mockResolvedValue({
      kind: "compiled",
      policy: { id: "block.all", effect: "deny" } satisfies GovernancePolicy,
    });
    const runtime = makeOutputRuntime();
    await enterprisePolicyCompileCommand("intent", runtime, { cfg, agentId: "main" });
    expect(runtime.logs.join("\n")).toContain("every enterprise run");
  });

  it("strips Unicode format controls from a compile failure reason", async () => {
    const rlo = String.fromCharCode(0x202e);
    vi.mocked(compileGovernancePolicy).mockResolvedValue({
      kind: "failed",
      reason: `bad${rlo}reason`,
    });
    const runtime = makeOutputRuntime();
    await enterprisePolicyCompileCommand("intent", runtime, { cfg, agentId: "main" });
    // The failure reason is raw provider text that never passes the schema, so the
    // command must strip the reordering char before printing it.
    expect(runtime.errors.join("\n")).not.toContain(rlo);
    expect(runtime.exitCodes).toEqual([1]);
  });
});

describe("enterprise bundle import dependencies", () => {
  const BUNDLE_TREE_ID = "acme.import-deps";
  const bundle = {
    schema: "clawworks.workflow-bundle",
    schemaVersion: 1,
    trees: [
      {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: BUNDLE_TREE_ID,
        version: "1.0.0",
        name: "Import deps",
        root: {
          id: "desk",
          title: "Handle a request",
          ontology: { allowedTools: ["message"], mcpServers: ["acme-tracker"] },
        },
      },
    ],
    knowledgeFoundations: [],
    // Recomputed from the tree on import; the manifest is for the reader.
    requiredTools: ["message"],
    requiredSkills: [],
    requiredMcpServers: ["acme-tracker"],
  };

  function importBundleWithConfig(config: OpenClawConfig | null): FakeRuntime {
    const file = path.join(tempDir, "deps.clawworks-bundle.json");
    writeFileSync(file, JSON.stringify(bundle), "utf8");
    if (config) {
      setRuntimeConfigSnapshot(config);
    } else {
      clearRuntimeConfigSnapshot();
    }
    const runtime = makeRuntime();
    enterpriseBundleImportCommand(file, runtime);
    return runtime;
  }

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    removeImportedWorkflowTree(BUNDLE_TREE_ID);
  });

  it("warns only about MCP servers this deployment has not registered", () => {
    const runtime = importBundleWithConfig(null);

    expect(runtime.errors.join("\n")).toContain("acme-tracker");
    expect(runtime.errors.join("\n")).toContain("must be registered under mcp.servers");
  });

  it("still warns when the registered server is disabled", () => {
    // A disabled entry is skipped by every projection, so the attachment stays as
    // inert as a missing registration — calling it satisfied would be backwards.
    const runtime = importBundleWithConfig({
      mcp: { servers: { "acme-tracker": { command: "npx", enabled: false } } },
    } as OpenClawConfig);

    expect(runtime.errors.join("\n")).toContain("must be registered under mcp.servers");
    expect(runtime.logs.join("\n")).not.toContain("Required MCP servers");
  });

  it("reports a registered server as a satisfied dependency, not a problem", () => {
    // A clean import must not read as misconfigured: the attachment resolves.
    const runtime = importBundleWithConfig({
      mcp: { servers: { "acme-tracker": { command: "npx" } } },
    } as OpenClawConfig);

    expect(runtime.errors.join("\n")).not.toContain("must be registered");
    expect(runtime.logs.join("\n")).toContain("Required MCP servers: acme-tracker");
  });
});
