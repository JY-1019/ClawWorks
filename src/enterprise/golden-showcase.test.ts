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
  return result.plan;
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
  it("creates, computes, updates, links, and reports real local objects on the routed steps", async () => {
    const runId = "showcase-lifecycle";
    const plan = await openRun(runId, ["desk.incidents"]);
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
