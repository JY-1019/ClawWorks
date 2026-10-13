/** Local fixture proof: real planner + agent-core loop + governed production tools. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { WorkflowPlanDecision } from "@openclaw/enterprise-planner";
import { selectWorkflowPlan } from "../packages/enterprise-planner/src/route-planner.js";
import { createModelWorkflowPlanner } from "../src/agents/enterprise-route-planner.runtime.js";
import { Agent } from "../src/agents/runtime/index.js";
import { prepareSimpleCompletionModelForAgent } from "../src/agents/simple-completion-runtime.js";
import { prepareModelForSimpleCompletion } from "../src/agents/simple-completion-transport.js";
import { loadConfig } from "../src/config/config.js";
import { BUILTIN_ASSIST_TREE } from "../src/enterprise/builtin-trees.js";
import { parseWorkflowBundleContent } from "../src/enterprise/bundle-io.js";
import {
  assertSharedPrefixAnswer,
  bundlePath,
  executeSharedPrefixScenario,
  fixtureDir,
  openSharedPrefixFixture,
  scenarios,
} from "./lib/enterprise-shared-prefix-fixture.js";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    case: { type: "string" },
  },
});
assert.ok(values.out, "Supply --out /tmp/report.json (outside the repository)");
const selected = values.case
  ? scenarios.filter((scenario) => scenario.id === values.case)
  : scenarios;
assert.ok(selected.length, `Unknown case ${values.case}`);
const cfg = loadConfig();
const parsed = parseWorkflowBundleContent(readFileSync(bundlePath, "utf8"), "yaml");
assert.ok(parsed.ok, JSON.stringify(parsed));
const planner = values.model
  ? createModelWorkflowPlanner({
      cfg,
      agentId: "main",
      modelRef: values.model,
      literalModelRef: true,
    })
  : undefined;
const prepared = values.model
  ? await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      modelRef: values.model,
      literalModelRef: true,
    })
  : undefined;
if (prepared && "error" in prepared) {
  throw new Error(prepared.error);
}
const sourceFiles = [
  bundlePath,
  path.join(fixtureDir, "scenarios.json"),
  path.join(fixtureDir, "records.json"),
  path.join(fixtureDir, "mcp.mjs"),
  ...["evidence", "citations", "refund", "exchange"].map((name) =>
    path.join(fixtureDir, `skills/proof-${name}/SKILL.md`),
  ),
  "scripts/enterprise-shared-prefix-proof.ts",
  "scripts/lib/enterprise-shared-prefix-fixture.ts",
  "src/enterprise/runtime.ts",
  "src/enterprise/ontology-runtime.ts",
  "src/enterprise/run-mediation.ts",
  "src/agents/run-mcp-tools.ts",
  "src/agents/openai-transport-stream.ts",
];
const report = {
  startedAt: new Date().toISOString(),
  model: values.model ?? null,
  scope: values.model
    ? "Live planner then agent-core tool loop; isolated SQLite; real local stdio MCP; no GUI/native Codex harness or real-world payment/shipping"
    : "Scripted actor; production gates/tools; isolated SQLite and real local stdio MCP; no model",
  sourceHashes: Object.fromEntries(
    sourceFiles.map((file) => [
      path.relative(process.cwd(), file),
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  ),
  results: [] as Array<Record<string, unknown>>,
};
mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
const persist = () => writeFileSync(values.out!, JSON.stringify(report, null, 2) + "\n");
let failures = 0;
for (const scenario of selected) {
  let fixture: Awaited<ReturnType<typeof openSharedPrefixFixture>> | undefined;
  let transcript: unknown;
  let decision: WorkflowPlanDecision | undefined;
  let selection: Awaited<ReturnType<typeof selectWorkflowPlan>> | undefined;
  const start = performance.now();
  try {
    // Resolve using the operator's existing auth before switching business state
    // to a temporary DB. Only the returned decision crosses that boundary.
    selection = planner
      ? await selectWorkflowPlan({
          trees: [...parsed.bundle.trees, BUILTIN_ASSIST_TREE],
          defaultTree: BUILTIN_ASSIST_TREE,
          requestText: scenario.request,
          planner: async (input) => {
            decision = await planner(input);
            return decision;
          },
        })
      : undefined;
    if (selection) {
      assert.equal(selection.treeSource, "planner");
      assert.equal(selection.tree.id, scenario.expected.treeId);
      assert.equal(selection.next.kind, "execute");
      assert.deepEqual(selection.route.invalidRoutes, []);
    }
    // The effective selection erases endpoints when they cover the whole tree.
    // Replay the raw model decision, otherwise both tails become an invalid empty selection.
    if (planner) {
      assert.ok(decision, "Planner returned no decision");
    }
    fixture = await openSharedPrefixFixture(scenario, decision);
    if (prepared && !("error" in prepared)) {
      const agent = new Agent({
        initialState: {
          model: prepareModelForSimpleCompletion({ model: prepared.model, cfg }),
          thinkingLevel: "low",
          systemPrompt: `Carry out the user's fictional local assessment through the tools. Follow the workflow and inlined skills below. All necessary skill instructions are already inlined. Call tools until every selected step is actually complete, then answer. Stop on unknown order; do not invent data or mark the failed step complete.\n${fixture.run.promptSection}`,
          tools: fixture.tools,
        },
        getApiKey: () => prepared.auth.apiKey,
        toolExecution: "sequential",
      });
      let toolCalls = 0;
      agent.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          toolCalls += 1;
          if (toolCalls > 100) {
            agent.abort();
          }
          if (event.toolName === "complete_step") {
            console.log(`${scenario.id}: completing ${fixture?.run.plan.activeNodeId}`);
          }
        }
      });
      const timeout = setTimeout(() => agent.abort(), 300_000);
      try {
        await agent.prompt(scenario.request);
      } finally {
        clearTimeout(timeout);
      }
      // Proof exports keep calls/results, not provider reasoning or replay payloads.
      transcript = agent.state.messages.map((message) => {
        if (message.role === "user") {
          return { role: message.role, content: message.content };
        }
        if (message.role === "toolResult") {
          return {
            role: message.role,
            toolName: message.toolName,
            toolCallId: message.toolCallId,
            content: message.content,
            isError: message.isError,
          };
        }
        if (message.role === "assistant") {
          return {
            role: message.role,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
            content: message.content.flatMap((block): Array<Record<string, unknown>> => {
              if (block.type === "text") {
                return [{ type: block.type, text: block.text }];
              }
              if (block.type === "toolCall") {
                return [
                  { type: block.type, id: block.id, name: block.name, arguments: block.arguments },
                ];
              }
              return [];
            }),
          };
        }
        return { role: message.role };
      });
      assert.deepEqual(
        agent.state.messages.filter((message) => message.role === "toolResult" && message.isError),
        [],
        "Agent tool failures (including argument validation) must not count as passing proof",
      );
      assert.ok(!agent.state.errorMessage, agent.state.errorMessage);
      const last = agent.state.messages.at(-1);
      assert.equal(last?.role, "assistant");
      if (last?.role === "assistant") {
        assert.ok(
          last.stopReason !== "aborted" && last.stopReason !== "error",
          "Model did not finish normally",
        );
      }
      const finalText =
        last?.role === "assistant"
          ? last.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n")
          : "";
      assertSharedPrefixAnswer(scenario, finalText);
    } else {
      await executeSharedPrefixScenario(fixture, scenario);
    }
    report.results.push({
      ...fixture.finish(),
      elapsedMs: performance.now() - start,
      ...(selection ? { routes: selection.route.routes, rationale: selection.treeRationale } : {}),
      decision,
      transcript,
    });
    console.log(`${scenario.id}: PASS`);
  } catch (error) {
    failures += 1;
    report.results.push({
      id: scenario.id,
      passed: false,
      error: String(error),
      elapsedMs: performance.now() - start,
      calls: fixture?.calls,
      decision,
      transcript,
    });
    console.error(`${scenario.id}: FAIL ${String(error)}`);
  } finally {
    await fixture?.cleanup();
    persist();
  }
}
console.log(`${selected.length - failures}/${selected.length} execution scenarios passed`);
process.exitCode = failures ? 1 : 0;
