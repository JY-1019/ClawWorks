/** Executable fixture for shared predecessors and independent two-step tails. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowPlanDecision } from "@openclaw/enterprise-planner";
import { z } from "zod";
import { wrapToolWithBeforeToolCallHook } from "../../src/agents/agent-tools.before-tool-call.js";
import { resolveRunSkillGrant } from "../../src/agents/enterprise-skill-scope.js";
import { createRunMcpTools } from "../../src/agents/run-mcp-tools.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { createKnowledgeSearchTool } from "../../src/agents/tools/knowledge-search-tool.js";
import {
  createComputeFunctionTool,
  createGetNeighborsTool,
  createInvokeActionTool,
  createSearchObjectsTool,
} from "../../src/agents/tools/ontology-tools.js";
import { createCompleteStepTool } from "../../src/agents/tools/workflow-step-tools.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { importWorkflowBundle } from "../../src/enterprise/bundle-io.js";
import { resetPersistedBundleFoundationsForTest } from "../../src/enterprise/knowledge-bundle-loader.js";
import {
  getOntologyObject,
  getOntologyNeighbors,
  searchOntologyObjects,
} from "../../src/enterprise/object-store.sqlite.js";
import { beginEnterpriseRun, endEnterpriseRun } from "../../src/enterprise/run-mediation.js";
import {
  getEnterpriseRunRecord,
  listEnterpriseRunEvents,
} from "../../src/enterprise/trace-store.sqlite.js";
import { invalidateWorkflowTreeRegistry } from "../../src/enterprise/tree-registry.js";
import { loadWorkspaceSkillEntries } from "../../src/skills/loading/workspace.js";
import { closeOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

export const fixtureDir = path.resolve("examples/enterprise/shared-prefix");
export const bundlePath = path.join(fixtureDir, "shared-prefix.clawworks-bundle.yaml");
export const scenarios = z
  .array(
    z.object({
      id: z.string(),
      orderId: z.string(),
      caseId: z.string(),
      request: z.string(),
      expected: z.object({
        kind: z.literal("execute"),
        treeId: z.string(),
        steps: z.array(z.string()),
      }),
    }),
  )
  .parse(JSON.parse(readFileSync(path.join(fixtureDir, "scenarios.json"), "utf8")));
export type Scenario = (typeof scenarios)[number];
const expectedMcpFacts = z
  .record(z.string(), z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number()]))))
  .parse(JSON.parse(readFileSync(path.join(fixtureDir, "records.json"), "utf8")));
const treeId = "demo.shared-prefix";
const serverNames = ["proof-orders", "proof-risk", "proof-stock"];
export type ProofCall = {
  nodeId: string | undefined;
  name: string;
  args: unknown;
  details?: unknown;
  content?: unknown;
  error?: string;
};

const neighborResultSchema = z.object({
  neighbors: z.array(
    z.object({
      relationship: z.string(),
      direction: z.enum(["inbound", "outbound"]),
      entity: z.string(),
      objectId: z.string(),
      properties: z.record(z.string(), z.unknown()),
    }),
  ),
});

function requireNeighbor(
  neighbors: z.infer<typeof neighborResultSchema>["neighbors"],
  relationship: string,
  direction: "inbound" | "outbound",
  entity: string,
  objectId: string,
) {
  const match = neighbors.find(
    (entry) =>
      entry.relationship === relationship &&
      entry.direction === direction &&
      entry.entity === entity &&
      entry.objectId === objectId,
  );
  assert.ok(match, `Missing ${relationship} link to ${objectId}`);
  return match.properties;
}

export async function openSharedPrefixFixture(scenario: Scenario, decision?: WorkflowPlanDecision) {
  const state = await createOpenClawTestState({
    label: `shared-prefix-${scenario.id}`,
    layout: "state-only",
  });
  const runId = `shared-prefix-${scenario.id}`;
  let mcp: Awaited<ReturnType<typeof createRunMcpTools>>;
  let ended = false;
  async function cleanup() {
    if (!ended) {
      endEnterpriseRun({ runId, status: "aborted" });
    }
    await mcp?.dispose();
    invalidateWorkflowTreeRegistry();
    resetPersistedBundleFoundationsForTest();
    closeOpenClawStateDatabase();
    await state.cleanup();
  }
  try {
    invalidateWorkflowTreeRegistry();
    const imported = importWorkflowBundle({
      content: readFileSync(bundlePath, "utf8"),
      format: "yaml",
    });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    if (!imported.ok) {
      throw new Error(JSON.stringify(imported));
    }
    assert.deepEqual(imported.warnings, []);
    assert.deepEqual(imported.missingFoundations, []);
    const config: OpenClawConfig = {
      enterprise: { mode: "enforce" },
      mcp: {
        servers: Object.fromEntries(
          serverNames.map((name) => [
            name,
            {
              command: process.execPath,
              args: [path.join(fixtureDir, "mcp.mjs"), name.slice("proof-".length)],
            },
          ]),
        ),
      },
    };
    const availableSkills = loadWorkspaceSkillEntries(fixtureDir, { workspaceOnly: true }).map(
      (entry) => entry.skill,
    );
    assert.equal(availableSkills.length, 4);
    const run = await beginEnterpriseRun({
      runId,
      prompt: scenario.request,
      config,
      availableSkills,
      routePlanner: async () =>
        decision ?? {
          kind: "decided",
          treeId,
          routes: scenario.expected.steps.filter(
            (id) => !scenario.expected.steps.some((other) => other.startsWith(`${id}.`)),
          ),
        },
    });
    assert.equal(run.kind, "mediated", JSON.stringify(run));
    if (run.kind !== "mediated") {
      throw new Error(JSON.stringify(run));
    }
    const plan = run.plan;
    assert.deepEqual(
      run.plan.nodes.map((node) => node.nodeId),
      scenario.expected.steps,
    );
    const expectedSkills = [
      "proof-evidence",
      "proof-citations",
      ...["refund", "exchange"]
        .filter((kind) => scenario.expected.steps.includes(`case.order.assess.${kind}`))
        .map((kind) => `proof-${kind}`),
    ].toSorted();
    assert.deepEqual([...resolveRunSkillGrant({ runId })!].toSorted(), expectedSkills);
    for (const skill of availableSkills) {
      assert.equal(
        run.promptSection.includes(`### ${skill.name}\n`),
        expectedSkills.includes(skill.name),
      );
    }
    mcp = await createRunMcpTools({
      options: { runId, config, workspaceDir: state.workspaceDir },
      eligibleServerNames: serverNames,
      nativeServerNames: [],
      reservedToolNames: [],
    });
    assert.ok(mcp);
    assert.equal(mcp.tools.filter((tool) => tool.name.endsWith("__lookup")).length, 3);
    const calls: ProofCall[] = [];
    const rawTools = [
      createKnowledgeSearchTool({ runId }),
      createSearchObjectsTool({ runId }),
      createInvokeActionTool({ runId }),
      createComputeFunctionTool({ runId }),
      createGetNeighborsTool({ runId }),
      createCompleteStepTool({ runId }),
      ...mcp.tools,
    ];
    const tools = rawTools.map((tool) => {
      const wrapped = wrapToolWithBeforeToolCallHook(tool, { runId, config });
      // Capture after the production gate/handler; a denial cannot count as a successful call.
      return Object.assign({}, wrapped, {
        execute: async (...args: Parameters<AnyAgentTool["execute"]>) => {
          const entry: ProofCall = {
            nodeId: run.plan.activeNodeId,
            name: tool.name,
            args: args[1],
          };
          calls.push(entry);
          try {
            const result = await wrapped.execute(...args);
            entry.details = result.details;
            entry.content = result.content;
            const details = z.record(z.string(), z.unknown()).safeParse(result.details);
            if (
              details.success &&
              (details.data.error ||
                details.data.status === "blocked" ||
                details.data.status === "error")
            ) {
              entry.error = String(
                details.data.error ?? details.data.reason ?? details.data.status,
              );
            }
            return result;
          } catch (error) {
            entry.error = String(error);
            throw error;
          }
        },
      });
    });
    let callId = 0;
    async function call(name: string, args: Record<string, unknown>) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `missing tool ${name}`);
      return tool.execute(`proof-${++callId}`, args);
    }
    const readObject = (entity: string, objectId: string) =>
      getOntologyObject({ treeId, entity, objectId });
    function finish() {
      const expectedCompleted = scenario.id === "unknown" ? ["case"] : scenario.expected.steps;
      const before = getEnterpriseRunRecord(runId);
      assert.ok(before);
      const events = listEnterpriseRunEvents(before.executionId);
      assert.deepEqual(
        events.filter((event) => event.kind === "node.completed").map((event) => event.nodeId),
        expectedCompleted,
      );
      assert.deepEqual(
        events.filter((event) => event.kind === "node.entered").map((event) => event.nodeId),
        scenario.id === "unknown" ? ["case", "case.order"] : scenario.expected.steps,
      );
      for (const nodeId of expectedCompleted) {
        const nodeCalls = calls.filter((entry) => entry.nodeId === nodeId);
        assert.equal(nodeCalls.filter((entry) => entry.name === "complete_step").length, 1);
        assert.equal(
          nodeCalls.at(-1)?.name,
          "complete_step",
          `${nodeId}: business calls after complete_step`,
        );
      }
      assert.deepEqual(readObject("case", scenario.caseId)?.properties, {
        "case-id": scenario.caseId,
        "order-id": scenario.orderId,
      });
      const knownFacts = expectedMcpFacts[scenario.orderId];
      for (const entry of calls.filter((candidate) => candidate.name.endsWith("__lookup"))) {
        assert.deepEqual(
          entry.args,
          { orderId: scenario.orderId },
          "MCP lookup queried a different order",
        );
        const service = entry.name.slice("proof-".length, -"__lookup".length);
        const content = z
          .array(z.object({ type: z.literal("text"), text: z.string() }))
          .parse(entry.content);
        assert.equal(content.length, 1);
        const returned = JSON.parse(content[0].text);
        assert.deepEqual(
          returned,
          knownFacts?.[service] ?? { error: "order_not_found", orderId: scenario.orderId },
          "MCP returned unexpected facts",
        );
      }
      const eligible = scenario.orderId === "1043";
      const expected = eligible
        ? { total: 129, days: 6, risk: 12, stock: 3 }
        : { total: 310, days: 96, risk: 72, stock: 0 };

      const assessment = readObject("assessment", `${scenario.caseId}-assessment`);
      if (scenario.id === "unknown") {
        // Checking only the requested ID misses fabricated records under other IDs.
        // This isolated abort scenario must leave only the completed intake object.
        const entities = new Set(
          plan.nodes.flatMap((node) => node.ontology.entities?.map((entity) => entity.id) ?? []),
        );
        for (const entity of entities) {
          assert.deepEqual(
            searchOntologyObjects({ treeId, entity, limit: 2 }).map((object) => object.objectId),
            entity === "case" ? [scenario.caseId] : [],
            `Unknown-order abort persisted unexpected ${entity} records`,
          );
        }
        assert.deepEqual(
          calls.filter((entry) => entry.name === "invoke_action").map((entry) => entry.nodeId),
          ["case"],
          "Unknown-order abort attempted collection writes",
        );
        assert.ok(
          calls
            .filter((entry) => entry.error)
            .every(
              (entry) =>
                entry.name.endsWith("__lookup") &&
                entry.nodeId === "case.order" &&
                entry.error === "error",
            ),
          "Unknown-order abort had an unrelated tool failure",
        );
        assert.ok(
          calls.some(
            (entry) =>
              entry.nodeId === "case.order" &&
              entry.name === "proof-orders__lookup" &&
              entry.error === "error",
          ),
        );
      } else {
        assert.ok(assessment);
        assert.ok(knownFacts);
        const facts = { ...knownFacts.orders, ...knownFacts.risk };
        const collection = plan.nodes.find((node) => node.nodeId === "case.order")!;
        for (const entity of collection.ontology.entities ?? []) {
          if (entity.id === "case") {
            continue;
          }
          const key = entity.properties?.find((property) => property.primaryKey)?.id;
          assert.ok(key && facts[key] !== undefined);
          const stored = readObject(entity.id, String(facts[key]));
          const properties = Object.fromEntries(
            (entity.properties ?? []).map((property) => [property.id, facts[property.id]]),
          );
          assert.deepEqual(
            stored?.properties,
            properties,
            `Stored ${entity.id} disagrees with MCP`,
          );
        }

        assert.deepEqual(
          calls.filter((entry) => entry.error),
          [],
          "A successful scenario must have no failed/blocked calls",
        );
        const evidence = readObject("evidence", `${scenario.caseId}-evidence`);
        const policy = readObject("policy", `${scenario.caseId}-policy`);
        assert.ok(evidence && policy);
        assert.equal(
          evidence.properties.source,
          "refund/eligibility.md",
          "Fabricated evidence source",
        );
        assert.equal(
          policy.properties.source,
          evidence.properties.source,
          "Policy/evidence provenance mismatch",
        );
        assert.ok(
          calls.some(
            (entry) =>
              entry.nodeId === "case.order.assess" &&
              entry.name === "knowledge_search" &&
              z
                .object({
                  snippets: z.array(z.object({ foundationId: z.string(), source: z.string() })),
                })
                .parse(entry.details)
                .snippets.some(
                  (snippet) =>
                    snippet.foundationId === "proof.refund" &&
                    snippet.source === evidence.properties.source,
                ),
          ),
          "Stored source was not retrieved by this step",
        );
        for (const [key, value] of Object.entries(expected)) {
          assert.equal(assessment.properties[key], value);
        }
        for (const [entity, id, relationship, target] of [
          ["case", scenario.caseId, "case-order", scenario.orderId],
          ["customer", `C-${scenario.orderId}`, "customer-order", scenario.orderId],
          ["order", scenario.orderId, "order-item", `I-${scenario.orderId}`],
          ["order", scenario.orderId, "order-signal", `S-${scenario.orderId}`],
          ["case", scenario.caseId, "case-assessment", `${scenario.caseId}-assessment`],
          ["assessment", `${scenario.caseId}-assessment`, "assessment-order", scenario.orderId],
          [
            "assessment",
            `${scenario.caseId}-assessment`,
            "assessment-signal",
            `S-${scenario.orderId}`,
          ],
          [
            "assessment",
            `${scenario.caseId}-assessment`,
            "assessment-evidence",
            `${scenario.caseId}-evidence`,
          ],
          [
            "evidence",
            `${scenario.caseId}-evidence`,
            "evidence-policy",
            `${scenario.caseId}-policy`,
          ],
        ]) {
          assert.deepEqual(
            getOntologyNeighbors({ treeId, entity, objectId: id, relationship, limit: 20 }).map(
              (row) => row.object?.objectId,
            ),
            [target],
          );
        }
        for (const kind of ["refund", "exchange"]) {
          const selected = scenario.expected.steps.includes(`case.order.assess.${kind}`);
          const review = readObject(`${kind}-review`, `${scenario.caseId}-${kind}`);
          if (!selected) {
            assert.equal(review, null);
            continue;
          }
          assert.ok(review);
          assert.equal(review.properties.eligible, eligible);
          assert.deepEqual(
            getOntologyNeighbors({
              treeId,
              entity: `${kind}-review`,
              objectId: `${scenario.caseId}-${kind}`,
              relationship: `${kind}-assessment`,
              limit: 20,
            }).map((row) => row.object?.objectId),
            [`${scenario.caseId}-assessment`],
          );
          assert.equal(
            review.properties.status,
            scenario.expected.steps.includes(`case.order.assess.${kind}.finalize`)
              ? "verified"
              : "prepared",
          );
        }
      }
      for (const node of plan.nodes.filter((candidate) =>
        expectedCompleted.includes(candidate.nodeId),
      )) {
        const nodeCalls = calls.filter((entry) => entry.nodeId === node.nodeId && !entry.error);
        const completion = calls.findIndex(
          (entry) => entry.nodeId === node.nodeId && entry.name === "complete_step",
        );
        // Citations can be reused within this run, but later retrievals cannot
        // retroactively prove a completed step had its required evidence.
        const availableCalls = calls.slice(0, completion + 1).filter((entry) => !entry.error);
        for (const foundation of node.ontology.knowledgeFoundations ?? []) {
          assert.ok(
            availableCalls.some(
              (entry) =>
                entry.name === "knowledge_search" &&
                z
                  .object({
                    snippets: z.array(z.object({ foundationId: z.string(), source: z.string() })),
                  })
                  .parse(entry.details)
                  .snippets.some((snippet) => snippet.foundationId === foundation),
            ),
            `${node.nodeId} did not retrieve ${foundation}`,
          );
        }
        const expectedRelations =
          node.nodeId === "case.order"
            ? ["case-order", "customer-order", "order-item", "order-signal"]
            : node.nodeId === "case.order.assess"
              ? [
                  "case-assessment",
                  "assessment-order",
                  "assessment-signal",
                  "assessment-evidence",
                  "evidence-policy",
                ]
              : node.nodeId.endsWith(".finalize")
                ? [
                    node.nodeId.includes(".refund.") ? "refund-assessment" : "exchange-assessment",
                    "assessment-evidence",
                    "evidence-policy",
                    ...(node.nodeId.includes(".refund.") ? ["assessment-signal"] : []),
                  ]
                : [];
        for (const relation of expectedRelations) {
          assert.ok(
            nodeCalls.some(
              (entry) =>
                entry.name === "get_neighbors" &&
                z
                  .object({ neighbors: z.array(z.object({ relationship: z.string() })) })
                  .parse(entry.details)
                  .neighbors.some((neighbor) => neighbor.relationship === relation),
            ),
            `${node.nodeId} did not verify ${relation}`,
          );
        }
        // Fresh-state proofs create the order; GUI replays may instead relink verified facts.
        for (const action of (node.ontology.actions ?? []).filter(
          (entry) => entry.id !== "reuse-order",
        )) {
          const preserved =
            node.nodeId.endsWith(".finalize") &&
            nodeCalls.some(
              (entry) =>
                entry.name === "get_neighbors" &&
                neighborResultSchema
                  .parse(entry.details)
                  .neighbors.some(
                    (neighbor) =>
                      neighbor.objectId ===
                        `${scenario.caseId}-${action.id.slice("finalize-".length)}` &&
                      neighbor.properties.status === "verified",
                  ),
            );
          const actionCalls = nodeCalls.filter(
            (entry) =>
              entry.name === "invoke_action" &&
              z.object({ action: z.string() }).parse(entry.args).action === action.id,
          );
          assert.equal(
            actionCalls.length,
            preserved ? 0 : 1,
            `${node.nodeId}/${action.id} must write only when needed`,
          );
          if (action.id.startsWith("prepare-")) {
            for (const entry of actionCalls) {
              const input = z.object({ args: z.object({ status: z.string() }) }).parse(entry.args);
              assert.equal(
                input.args.status,
                "prepared",
                "Preparation cannot write verified status",
              );
            }
          }
        }
        for (const fn of node.ontology.functions ?? []) {
          const computed = nodeCalls.filter(
            (entry) =>
              entry.name === "compute_function" &&
              z.object({ function: z.string() }).parse(entry.args).function === fn.id,
          );
          assert.ok(computed.length, `${node.nodeId} did not compute ${fn.id}`);
          for (const entry of computed) {
            assert.equal(
              z.object({ value: z.union([z.boolean(), z.number()]) }).parse(entry.details).value,
              fn.id === "net-credit" ? expected.total * 0.9 : eligible,
            );
          }
        }
      }
      // Check calls per node, not just their union: a leaf-only implementation must fail.
      const required: Record<string, string[]> = {
        case: ["knowledge_search", "invoke_action"],
        "case.order": [
          "proof-orders__lookup",
          "proof-risk__lookup",
          "knowledge_search",
          "invoke_action",
          "get_neighbors",
        ],
        "case.order.assess": [
          "proof-stock__lookup",
          "knowledge_search",
          "invoke_action",
          "get_neighbors",
        ],
      };
      for (const nodeId of expectedCompleted) {
        const names =
          required[nodeId] ??
          (nodeId.endsWith(".finalize")
            ? [
                "get_neighbors",
                "compute_function",
                nodeId.includes(".refund.") ? "proof-risk__lookup" : "proof-stock__lookup",
              ]
            : ["search_objects", "compute_function", "invoke_action"]);
        for (const name of names) {
          assert.ok(
            calls.some((entry) => entry.nodeId === nodeId && entry.name === name && !entry.error),
            `${nodeId} did not call ${name}`,
          );
        }
      }
      endEnterpriseRun({ runId, status: scenario.id === "unknown" ? "aborted" : "completed" });
      ended = true;
      return {
        id: scenario.id,
        passed: true,
        steps: expectedCompleted,
        skills: expectedSkills,
        calls,
        assessment,
        reviews: ["refund", "exchange"].map((kind) =>
          readObject(`${kind}-review`, `${scenario.caseId}-${kind}`),
        ),
        events: listEnterpriseRunEvents(before.executionId),
      };
    }
    return { run, tools, calls, call, finish, cleanup, readObject };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Compare every emitted status, so a correct marker cannot mask a contradictory one. */
export function assertSharedPrefixAnswer(scenario: Scenario, text: string) {
  const completed = scenario.id !== "unknown";
  assert.equal(text.includes("EVIDENCE: linked-policy-verified"), completed);
  const expected = completed
    ? ["refund", "exchange"]
        .filter((kind) => scenario.expected.steps.includes(`case.order.assess.${kind}`))
        .map(
          (kind) =>
            `${kind.toUpperCase()}-REVIEW: ${scenario.expected.steps.includes(`case.order.assess.${kind}.finalize`) ? "verified" : "prepared"}`,
        )
    : [];
  const actual = [...text.matchAll(/\b(REFUND|EXCHANGE)-REVIEW:\s*([A-Za-z-]+)/g)].map(
    (match) => `${match[1]}-REVIEW: ${match[2]}`,
  );
  assert.deepEqual(
    [...new Set(actual)].toSorted(),
    expected.toSorted(),
    "Wrong branch status markers",
  );
}

/** Scripted actor supplies independent deterministic regression proof beside live-model proof. */
export async function executeSharedPrefixScenario(
  fixture: Awaited<ReturnType<typeof openSharedPrefixFixture>>,
  scenario: Scenario,
) {
  const { call } = fixture;
  const action = async (actionName: string, args: Record<string, unknown>) => {
    const result = await call("invoke_action", { action: actionName, args });
    assert.ok(!fixture.calls.at(-1)?.error, JSON.stringify(result.details));
    return result;
  };
  const retrievedFoundations = new Set<string>();
  const search = async (ids: string[]) => {
    const missing = ids.filter((id) => !retrievedFoundations.has(id));
    if (missing.length === 0) {
      return undefined;
    }
    const result = await call("knowledge_search", {
      query: "eligibility evidence",
      foundations: missing,
    });
    const { snippets } = z
      .object({ snippets: z.array(z.object({ foundationId: z.string() })) })
      .parse(result.details);
    for (const snippet of snippets) {
      retrievedFoundations.add(snippet.foundationId);
    }
    return result;
  };
  const neighbors = async (entity: string, objectId: string) => {
    const result = await call("get_neighbors", { entity, objectId, limit: 50 });
    return neighborResultSchema.parse(result.details).neighbors;
  };
  const compute = async (fn: string) => {
    const result = await call("compute_function", {
      function: fn,
      objectId: `${scenario.caseId}-assessment`,
    });
    const { value } = z.object({ value: z.union([z.boolean(), z.number()]) }).parse(result.details);
    return value;
  };
  const lookup = async (service: string) => {
    const result = await call(`proof-${service}__lookup`, { orderId: scenario.orderId });
    const text = result.content.find((block) => block.type === "text");
    assert.ok(text && text.type === "text");
    return z.record(z.string(), z.union([z.string(), z.number()])).parse(JSON.parse(text.text));
  };
  let collectedFacts: Record<string, string | number> | undefined;
  for (const nodeId of scenario.expected.steps) {
    assert.equal(fixture.run.plan.activeNodeId, nodeId);
    if (nodeId === "case") {
      await search(["proof.intake", "proof.privacy"]);
      await call("search_objects", { entity: "case", match: scenario.caseId });
      await action("open-case", { "case-id": scenario.caseId, "order-id": scenario.orderId });
    } else if (nodeId === "case.order") {
      const order = await lookup("orders");
      if (order.error) {
        return;
      }
      const risk = await lookup("risk");
      collectedFacts = { ...order, ...risk };
      await search(["proof.evidence", "proof.privacy"]);
      await call("search_objects", { entity: "order", match: scenario.orderId });
      await action("record-order", { "case-id": scenario.caseId, ...order, ...risk });
      await neighbors("order", scenario.orderId);
    } else if (nodeId === "case.order.assess") {
      assert.ok(collectedFacts);
      const stock = await lookup("stock");
      const knowledge = await search(["proof.refund", "proof.exchange", "proof.evidence"]);
      assert.ok(knowledge);
      const snippets = z
        .object({ snippets: z.array(z.object({ source: z.string(), foundationId: z.string() })) })
        .parse(knowledge.details).snippets;
      const source = snippets.find((snippet) => snippet.foundationId === "proof.refund")?.source;
      assert.equal(source, "refund/eligibility.md");
      await call("search_objects", {
        entity: "assessment",
        match: `${scenario.caseId}-assessment`,
      });
      await action("record-assessment", {
        "case-id": scenario.caseId,
        "order-id": scenario.orderId,
        "assessment-id": `${scenario.caseId}-assessment`,
        "evidence-id": `${scenario.caseId}-evidence`,
        "policy-id": `${scenario.caseId}-policy`,
        total: collectedFacts.total,
        days: collectedFacts.days,
        risk: collectedFacts.risk,
        stock: stock.stock,
        "signal-id": collectedFacts["signal-id"],
        source,
        summary: `Returned order ${scenario.orderId}: total=${collectedFacts.total}, days=${collectedFacts.days}, risk=${collectedFacts.risk}, stock=${stock.stock}`,
      });
      await neighbors("assessment", `${scenario.caseId}-assessment`);
      await neighbors("evidence", `${scenario.caseId}-evidence`);
    } else {
      const kind = nodeId.includes(".refund") ? "refund" : "exchange";
      const id = `${scenario.caseId}-${kind}`;
      await search([`proof.${kind}`, "proof.evidence"]);
      if (nodeId.endsWith(".finalize")) {
        const fresh = await lookup(kind === "refund" ? "risk" : "stock");
        const assessmentLinks = await neighbors("assessment", `${scenario.caseId}-assessment`);
        const evidenceLinks = await neighbors("evidence", `${scenario.caseId}-evidence`);
        // Validate returned state BEFORE writing, so finalization cannot hide
        // corrupt review status, eligibility, or evidence by overwriting it.
        const review = requireNeighbor(
          assessmentLinks,
          `${kind}-assessment`,
          "inbound",
          `${kind}-review`,
          id,
        );
        assert.ok(
          ["prepared", "verified"].includes(String(review.status)),
          "Invalid review status",
        );
        const evidence = requireNeighbor(
          assessmentLinks,
          "assessment-evidence",
          "outbound",
          "evidence",
          `${scenario.caseId}-evidence`,
        );
        const policy = requireNeighbor(
          evidenceLinks,
          "evidence-policy",
          "outbound",
          "policy",
          `${scenario.caseId}-policy`,
        );
        assert.equal(evidence.source, "refund/eligibility.md");
        assert.equal(policy.source, evidence.source);
        const allowedFoundations = fixture.run.plan.nodes.find((node) => node.nodeId === nodeId)
          ?.ontology.knowledgeFoundations;
        assert.ok(
          fixture.calls.some(
            (entry) =>
              entry.name === "knowledge_search" &&
              z
                .object({
                  snippets: z.array(z.object({ source: z.string(), foundationId: z.string() })),
                })
                .parse(entry.details)
                .snippets.some(
                  (snippet) =>
                    snippet.source === evidence.source &&
                    allowedFoundations?.includes(snippet.foundationId),
                ),
          ),
          "Final evidence source is not cited within the active knowledge scope",
        );
        const assessment = requireNeighbor(
          evidenceLinks,
          "assessment-evidence",
          "inbound",
          "assessment",
          `${scenario.caseId}-assessment`,
        );
        const expected = expectedMcpFacts[scenario.orderId];
        assert.deepEqual(assessment, {
          "assessment-id": `${scenario.caseId}-assessment`,
          total: expected.orders.total,
          days: expected.orders.days,
          risk: expected.risk.risk,
          stock: expected.stock.stock,
        });
        const field = kind === "refund" ? "risk" : "stock";
        assert.equal(fresh[field], assessment[field]);
        if (kind === "refund") {
          const signalId = fresh["signal-id"];
          assert.equal(typeof signalId, "string");
          const signal = requireNeighbor(
            assessmentLinks,
            "assessment-signal",
            "outbound",
            "risk-signal",
            String(signalId),
          );
          assert.equal(signal.risk, fresh.risk);
        }
        assert.equal(review.eligible, await compute(`${kind}-eligible`));
        await compute("net-credit");
        if (review.status === "prepared") {
          await action(`finalize-${kind}`, { [`${kind}-id`]: id, status: "verified" });
        }
      } else {
        await call("search_objects", { entity: `${kind}-review`, match: id });
        const eligible = await compute(`${kind}-eligible`);
        assert.ok(typeof eligible === "boolean");
        await action(`prepare-${kind}`, {
          [`${kind}-id`]: id,
          "assessment-id": `${scenario.caseId}-assessment`,
          eligible,
          status: "prepared",
        });
      }
    }
    await call("complete_step", {
      step: nodeId,
      summary: `Verified ${nodeId} against actual tool results.`,
    });
  }
}
