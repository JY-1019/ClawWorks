import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKnowledgeSearchTool } from "../agents/tools/knowledge-search-tool.js";
import {
  createComputeFunctionTool,
  createGetNeighborsTool,
  createInvokeActionTool,
  createSearchObjectsTool,
} from "../agents/tools/ontology-tools.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { importWorkflowBundle } from "./bundle-io.js";
import { resetPersistedBundleFoundationsForTest } from "./knowledge-bundle-loader.js";
import {
  beginEnterpriseRun,
  clearEnterpriseRunMediationForTest,
  endEnterpriseRun,
} from "./run-mediation.js";
import { completeEnterpriseStep, evaluateEnterpriseToolCall } from "./runtime.js";
import { getEnterpriseRunRecord, listEnterpriseRunEvents } from "./trace-store.sqlite.js";
import {
  exportWorkflowTree,
  importWorkflowTreeContent,
  parseWorkflowTreeContent,
} from "./tree-io.js";
import { invalidateWorkflowTreeRegistry } from "./tree-registry.js";
import type { OntologyValue } from "./types.js";

const TREE_ID = "demo.service-incident";
let testState: OpenClawTestState | undefined;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "golden-showcase", layout: "state-only" });
  invalidateWorkflowTreeRegistry();
  const imported = importWorkflowBundle({
    content: readFileSync(
      path.resolve("examples/enterprise/golden/service-incident.clawworks-bundle.yaml"),
      "utf8",
    ),
    format: "yaml",
  });
  expect(imported).toMatchObject({
    ok: true,
    foundations: ["demo.incident-playbook", "demo.communication-policy"],
    missingFoundations: [],
    requiredSkills: [],
    requiredMcpServers: [],
    missingGovernancePolicies: [],
    warnings: [],
  });
});

afterEach(() => {
  clearEnterpriseRunMediationForTest();
});

afterAll(async () => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  resetPersistedBundleFoundationsForTest();
  await testState?.cleanup();
});

async function openRun(runId: string, routes: string[]) {
  const result = await beginEnterpriseRun({
    runId,
    prompt: "Exercise the fictional service incident desk with supplied values only.",
    routePlanner: async () => ({
      kind: "decided",
      treeId: TREE_ID,
      routes,
      rationale: "Deterministic fixture route; no model or network is called.",
    }),
  });
  if (result.kind !== "mediated") {
    throw new Error(`expected a mediated showcase run, got ${result.kind}`);
  }
  expect(result.plan.activeNodeId).toBe("desk");
  // These authored request/context checks execute before the operation. Finish
  // them explicitly so an endpoint fixture cannot silently skip its parents.
  for (const node of result.plan.nodes.slice(0, 2)) {
    expect(
      completeEnterpriseStep({
        runId,
        expectedNodeId: node.nodeId,
        summary: "Confirmed the fictional incident operation and supplied-value-only scope.",
      }),
    ).toMatchObject({ kind: "advanced", completed: { nodeId: node.nodeId } });
  }
  return result;
}

async function invoke(runId: string, action: string, args: Record<string, OntologyValue>) {
  // Tool handlers do not own the before-call gate. Exercise both production
  // layers so a write declaration with a missing tool grant cannot pass here.
  const params = { action, args };
  expect(
    evaluateEnterpriseToolCall({ runId, toolName: "invoke_action", toolParams: params })?.decision
      .effect,
  ).toBe("allow");
  return (await createInvokeActionTool({ runId }).execute(action, params)).details;
}

describe("the hands-on service incident golden case", () => {
  it("carries saved step behavior into new runs without changing an active run", async () => {
    const original = exportWorkflowTree({ treeId: TREE_ID, format: "json" });
    if (!original.ok) {
      throw new Error(original.reason);
    }
    const parsed = parseWorkflowTreeContent(original.content, "json");
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.issues));
    }
    const route = "desk.incidents.triage";
    const step = parsed.tree.root.children
      ?.find((node) => node.id === "desk.incidents")
      ?.children?.find((node) => node.id === route);
    if (!step?.ontology) {
      throw new Error("the golden triage step must carry behavior");
    }
    const before = await openRun("behavior-before", [route]);
    expect(before.promptSection).toContain(`Instructions: ${step.ontology.guidance}`);
    expect(before.promptSection).toContain(`Expected output: ${step.ontology.expectedOutput}`);
    expect(before.promptSection).toContain(
      "Elapsed minutes are a supplied snapshot, not a running timer.",
    );
    expect(before.promptSection).not.toContain("UNSENT DRAFT");
    const originalTools = step.ontology.allowedTools;
    try {
      step.title = "Incident priority review";
      step.description = "Review stored incident priority with its policy.";
      step.ontology.guidance = "Explain the priority rule in Korean and cite the retrieved source.";
      step.ontology.contextHints = ["This exercise uses fictional incident records."];
      step.ontology.expectedOutput = "Use sections: Rule, Source, Unknowns.";
      expect(
        importWorkflowTreeContent({ content: JSON.stringify(parsed.tree), format: "json" }).ok,
      ).toBe(true);
      // Reload the persisted definition, not the object just edited: this covers
      // the save/registry boundary used by the UI's tree import RPC.
      invalidateWorkflowTreeRegistry();
      const after = await openRun("behavior-after", [route]);
      expect(after.plan.nodes.find((node) => node.nodeId === route)).toMatchObject({
        title: step.title,
        description: step.description,
        ontology: { ...step.ontology, allowedTools: originalTools },
      });
      for (const text of [
        step.title,
        step.description,
        step.ontology.guidance,
        ...step.ontology.contextHints,
        step.ontology.expectedOutput,
      ]) {
        expect(after.promptSection).toContain(text);
        expect(before.promptSection).not.toContain(text);
      }
      expect(before.plan.nodes.find((node) => node.nodeId === route)?.title).toBe(
        "Compute incident priority",
      );
      expect(
        evaluateEnterpriseToolCall({ runId: "behavior-after", toolName: "exec" })?.blocked,
      ).toBe(true);
      endEnterpriseRun({ runId: "behavior-after", status: "completed" });

      delete step.description;
      delete step.ontology.guidance;
      delete step.ontology.contextHints;
      delete step.ontology.expectedOutput;
      expect(
        importWorkflowTreeContent({ content: JSON.stringify(parsed.tree), format: "json" }).ok,
      ).toBe(true);
      const cleared = await openRun("behavior-cleared", [route]);
      expect(cleared.promptSection).not.toContain("Explain the priority rule in Korean");
      expect(cleared.promptSection).not.toContain("This exercise uses fictional incident records.");
      expect(cleared.promptSection).not.toContain("Use sections: Rule, Source, Unknowns.");
      expect(
        cleared.plan.nodes.find((node) => node.nodeId === route)?.ontology.allowedTools,
      ).toEqual(originalTools);
      endEnterpriseRun({ runId: "behavior-cleared", status: "completed" });
    } finally {
      endEnterpriseRun({ runId: "behavior-before", status: "completed" });
      expect(importWorkflowTreeContent({ content: original.content, format: "json" }).ok).toBe(
        true,
      );
    }
  });

  it.each([
    { rootAudit: true, stepAudit: false, recorded: false },
    { rootAudit: false, stepAudit: true, recorded: true },
    { rootAudit: false, stepAudit: false, recorded: false },
  ])(
    "uses only local audit for default allows with root=$rootAudit and step=$stepAudit",
    async ({ rootAudit, stepAudit, recorded }) => {
      const original = exportWorkflowTree({ treeId: TREE_ID, format: "json" });
      if (!original.ok) {
        throw new Error(original.reason);
      }
      const parsed = parseWorkflowTreeContent(original.content, "json");
      if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
      }
      const route = "desk.incidents.triage";
      const step = parsed.tree.root.children
        ?.find((node) => node.id === "desk.incidents")
        ?.children?.find((node) => node.id === route);
      if (!step?.ontology || !parsed.tree.root.ontology) {
        throw new Error("the golden root and triage step must carry ontology");
      }
      const runId = `behavior-audit-${rootAudit}-${stepAudit}`;
      try {
        parsed.tree.root.ontology.audit = rootAudit;
        step.ontology.audit = stepAudit;
        expect(
          importWorkflowTreeContent({ content: JSON.stringify(parsed.tree), format: "json" }).ok,
        ).toBe(true);
        await openRun(runId, [route]);
        expect(
          evaluateEnterpriseToolCall({
            runId,
            toolName: "search_objects",
            toolCallId: "audit-allow",
          }),
        ).toMatchObject({
          blocked: false,
          decision: { effect: "allow", source: "default" },
        });
        expect(
          evaluateEnterpriseToolCall({ runId, toolName: "exec", toolCallId: "audit-deny" })
            ?.blocked,
        ).toBe(true);
        endEnterpriseRun({ runId, status: "completed" });
        const record = getEnterpriseRunRecord(runId);
        if (!record) {
          throw new Error("the audit run must have a persisted trace");
        }
        const decisions = listEnterpriseRunEvents(record.executionId).filter(
          (event) => event.kind === "governance.decision",
        );
        expect(decisions.some((event) => event.payload.toolName === "search_objects")).toBe(
          recorded,
        );
        expect(decisions).toContainEqual(
          expect.objectContaining({
            nodeId: route,
            payload: expect.objectContaining({ toolName: "exec", effect: "deny" }),
          }),
        );
      } finally {
        expect(importWorkflowTreeContent({ content: original.content, format: "json" }).ok).toBe(
          true,
        );
      }
    },
  );

  it("creates, computes, updates, links, and reports real local objects on the routed steps", async () => {
    const runId = "showcase-lifecycle";
    const { plan } = await openRun(runId, [
      "desk.incidents.intake",
      "desk.incidents.triage",
      "desk.incidents.assign",
      "desk.incidents.evidence",
      "desk.incidents.resolve",
      "desk.incidents.report",
    ]);
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([
      "desk",
      "desk.incidents",
      "desk.incidents.intake",
      "desk.incidents.triage",
      "desk.incidents.assign",
      "desk.incidents.evidence",
      "desk.incidents.resolve",
      "desk.incidents.report",
    ]);
    const incident = {
      "incident-id": "INC-1001",
      service: "Demo checkout",
      title: "Synthetic checkout timeouts",
      status: "open",
      "affected-users": 240,
      "elapsed-minutes": 45,
    };
    expect(await invoke(runId, "open-incident", incident)).toMatchObject({
      writes: [{ entity: "incident", objectId: "INC-1001", kind: "create" }],
    });
    expect(await invoke(runId, "open-incident", incident)).toMatchObject({
      error: expect.stringContaining("already exists"),
    });
    expect(
      await invoke(runId, "open-incident", {
        ...incident,
        "incident-id": "INC-BAD",
        "affected-users": "240",
      }),
    ).toMatchObject({ error: expect.stringContaining('declared "number"') });
    expect(
      (
        await createSearchObjectsTool({ runId }).execute("rejected-create", {
          entity: "incident",
          match: "INC-BAD",
        })
      ).details,
    ).toMatchObject({ count: 0, objects: [] });

    completeEnterpriseStep({ runId });
    expect(plan.activeNodeId).toBe("desk.incidents.triage");
    expect(
      (
        await createComputeFunctionTool({ runId }).execute("priority", {
          function: "incident-priority",
          objectId: "INC-1001",
        })
      ).details,
    ).toMatchObject({ value: "urgent", entity: "incident", objectId: "INC-1001" });
    expect(
      (
        await createKnowledgeSearchTool({ runId }).execute("priority-policy", {
          query: "priority",
          foundations: ["demo.incident-playbook"],
        })
      ).details,
    ).toMatchObject({
      snippets: [expect.objectContaining({ source: "playbook/priority.md" })],
      skipped: [],
    });

    completeEnterpriseStep({ runId });
    expect(
      await invoke(runId, "assign-incident", {
        "incident-id": "INC-1001",
        owner: "Demo on-call",
        status: "investigating",
      }),
    ).toMatchObject({ writes: [{ entity: "incident", objectId: "INC-1001", kind: "update" }] });

    completeEnterpriseStep({ runId });
    expect(
      await invoke(runId, "add-incident-note", {
        "incident-id": "INC-1001",
        "note-id": "NOTE-1001",
        summary: "User-supplied simulation: retry queue drained after a mock rollback.",
      }),
    ).toMatchObject({
      writes: [
        { entity: "incident-note", objectId: "NOTE-1001", kind: "create" },
        { relationship: "incident-has-note", from: "INC-1001", to: "NOTE-1001", kind: "link" },
      ],
    });

    completeEnterpriseStep({ runId });
    expect(
      await invoke(runId, "resolve-incident", {
        "incident-id": "INC-1001",
        status: "resolved",
        resolution: "User reports the simulated checkout recovered; no live health check was run.",
      }),
    ).toMatchObject({ writes: [{ entity: "incident", objectId: "INC-1001", kind: "update" }] });

    completeEnterpriseStep({ runId });
    expect(plan.activeNodeId).toBe("desk.incidents.report");
    expect(
      (
        await createSearchObjectsTool({ runId }).execute("read-back", {
          entity: "incident",
          match: "INC-1001",
        })
      ).details,
    ).toMatchObject({
      count: 1,
      objects: [
        {
          objectId: "INC-1001",
          properties: {
            ...incident,
            status: "resolved",
            owner: "Demo on-call",
            resolution:
              "User reports the simulated checkout recovered; no live health check was run.",
          },
        },
      ],
    });
    expect(
      (
        await createGetNeighborsTool({ runId }).execute("evidence", {
          entity: "incident",
          objectId: "INC-1001",
          relationship: "incident-has-note",
        })
      ).details,
    ).toMatchObject({
      count: 1,
      neighbors: [
        {
          objectId: "NOTE-1001",
          direction: "outbound",
          properties: {
            "incident-id": "INC-1001",
            "note-id": "NOTE-1001",
            summary: "User-supplied simulation: retry queue drained after a mock rollback.",
          },
        },
      ],
    });
    expect(evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked).toBe(true);
    expect(evaluateEnterpriseToolCall({ runId, toolName: "exec" })?.blocked).toBe(true);
    completeEnterpriseStep({ runId });
    endEnterpriseRun({ runId, status: "completed" });
    const record = getEnterpriseRunRecord(runId);
    expect(record?.status).toBe("completed");
    if (!record) {
      throw new Error("the completed run must have a persisted trace");
    }
    const events = listEnterpriseRunEvents(record.executionId);
    const steps = plan.nodes.map((node) => node.nodeId);
    expect(
      events.filter((event) => event.kind === "node.entered").map((event) => event.nodeId),
    ).toEqual(steps);
    expect(
      events.filter((event) => event.kind === "node.completed").map((event) => event.nodeId),
    ).toEqual(steps);
    expect(
      events
        .filter((event) => event.kind === "action.invoked")
        .map((event) => event.payload.actionId),
    ).toEqual(["open-incident", "assign-incident", "add-incident-note", "resolve-incident"]);
  });

  it.each([
    { users: 100, minutes: 0, priority: "urgent" },
    { users: 0, minutes: 30, priority: "urgent" },
    { users: 99, minutes: 29, priority: "standard" },
  ])(
    "computes $priority for $users users and $minutes minutes",
    async ({ users, minutes, priority }) => {
      const runId = `showcase-priority-${users}-${minutes}`;
      const objectId = `INC-${users}-${minutes}`;
      await openRun(runId, ["desk.incidents.intake", "desk.incidents.triage"]);
      await invoke(runId, "open-incident", {
        "incident-id": objectId,
        service: "Demo service",
        title: "Priority boundary exercise",
        status: "open",
        "affected-users": users,
        "elapsed-minutes": minutes,
      });
      completeEnterpriseStep({ runId });
      expect(
        (
          await createComputeFunctionTool({ runId }).execute("boundary", {
            function: "incident-priority",
            objectId,
          })
        ).details,
      ).toMatchObject({ value: priority });
      endEnterpriseRun({ runId, status: "completed" });
    },
  );

  it("withholds internal fields, notes, writes, and the operations corpus from communications", async () => {
    const createId = "showcase-public-setup";
    await openRun(createId, ["desk.incidents.intake"]);
    await invoke(createId, "open-incident", {
      "incident-id": "INC-2001",
      service: "Demo login",
      title: "Internal-only diagnosis",
      status: "open",
      "affected-users": 3,
      "elapsed-minutes": 2,
    });
    endEnterpriseRun({ runId: createId, status: "completed" });
    const runId = "showcase-public-draft";
    await openRun(runId, ["desk.communications.draft"]);
    expect(
      (
        await createSearchObjectsTool({ runId }).execute("public-fields", {
          entity: "incident",
          match: "INC-2001",
        })
      ).details,
    ).toEqual({
      entity: "incident",
      count: 1,
      objects: [
        {
          objectId: "INC-2001",
          properties: { "incident-id": "INC-2001", service: "Demo login", status: "open" },
        },
      ],
    });
    expect(
      (
        await createSearchObjectsTool({ runId }).execute("internal-notes", {
          entity: "incident-note",
        })
      ).details,
    ).toMatchObject({ error: expect.stringContaining("not in the ontology") });
    expect(
      (
        await createKnowledgeSearchTool({ runId }).execute("communication-policy", {
          query: "customer update",
          foundations: ["demo.communication-policy", "demo.incident-playbook"],
        })
      ).details,
    ).toMatchObject({
      snippets: [
        expect.objectContaining({
          foundationId: "demo.communication-policy",
          source: "communications/customer-updates.md",
        }),
      ],
      skipped: [expect.objectContaining({ foundationId: "demo.incident-playbook" })],
    });
    expect(evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked).toBe(true);
    expect(evaluateEnterpriseToolCall({ runId, toolName: "message" })?.blocked).toBe(true);
    endEnterpriseRun({ runId, status: "completed" });
  });
});
