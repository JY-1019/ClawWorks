/** Live routing evaluation; never starts a business workflow or invokes its tools. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { z } from "zod";
import { selectWorkflowPlan } from "../packages/enterprise-planner/src/route-planner.js";
import { createModelWorkflowPlanner } from "../src/agents/enterprise-route-planner.runtime.js";
import { loadConfig } from "../src/config/config.js";
import { BUILTIN_ASSIST_TREE } from "../src/enterprise/builtin-trees.js";
import { buildEnterpriseRunPlan, enterpriseStepSequence } from "../src/enterprise/plan.js";
import { WorkflowTreeDefinitionSchema } from "../src/enterprise/schema.js";

const expectation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clarify"), treeId: z.string() }),
  z.object({
    kind: z.literal("execute"),
    treeId: z.string(),
    steps: z.array(z.string()).min(1).optional(),
  }),
]);
const suiteSchema = z.object({
  schema: z.literal("clawworks.routing-cases"),
  schemaVersion: z.literal(1),
  trees: z.array(z.string()).min(1),
  cases: z
    .array(
      z.object({
        id: z.string(),
        category: z.string(),
        request: z.string(),
        expected: expectation,
      }),
    )
    .min(1),
});
const treeFileSchema = z.union([
  WorkflowTreeDefinitionSchema,
  z.object({ trees: z.array(WorkflowTreeDefinitionSchema).min(1) }),
]);
const { values } = parseArgs({
  options: {
    cases: { type: "string", default: "examples/enterprise/golden/routing-cases.yaml" },
    out: { type: "string" },
    repeat: { type: "string", default: "3" },
    model: { type: "string", default: "openai/gpt-5.5" },
  },
});
if (!values.out) {
  throw new Error("Supply --out <report.json> outside the product repository.");
}
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
  throw new Error("--repeat must be an integer from 1 to 10.");
}
const sourceHashes: Record<string, string> = {};
function readSource(file: string): string {
  const text = readFileSync(file, "utf8");
  sourceHashes[file] = createHash("sha256").update(text).digest("hex");
  return text;
}
const suite = suiteSchema.parse(YAML.parse(readSource(values.cases)));
const trees = suite.trees.flatMap((file) => {
  const parsed = treeFileSchema.parse(YAML.parse(readSource(file)));
  return "trees" in parsed ? parsed.trees : [parsed];
});
trees.push(BUILTIN_ASSIST_TREE);
if (new Set(trees.map((tree) => tree.id)).size !== trees.length) {
  throw new Error("Candidate tree ids must be unique.");
}
if (new Set(suite.cases.map((entry) => entry.id)).size !== suite.cases.length) {
  throw new Error("Case ids must be unique.");
}
// Reject a stale answer key before spending any model calls. Evaluate steps,
// not endpoint spelling: all required predecessors must be included.
for (const entry of suite.cases) {
  const expected = entry.expected;
  const tree = trees.find((candidate) => candidate.id === expected.treeId);
  if (!tree) {
    throw new Error(`${entry.id}: unknown expected tree ${expected.treeId}`);
  }
  if (expected.kind === "execute" && expected.steps) {
    const plan = buildEnterpriseRunPlan({
      runId: "validate",
      requestText: entry.request,
      mode: "enforce",
      tree,
      matchedBy: "planner",
    });
    const expectedSteps = expected.steps;
    const steps = enterpriseStepSequence(plan).filter((id) => expectedSteps.includes(id));
    const ids = new Set(expectedSteps);
    if (
      plan.nodes.some((node) => ids.has(node.nodeId) && node.parentId && !ids.has(node.parentId))
    ) {
      throw new Error(`${entry.id}: expected steps omit a predecessor`);
    }
    if (JSON.stringify(steps) !== JSON.stringify(expected.steps)) {
      throw new Error(`${entry.id}: expected steps must be unique, real, and in tree order`);
    }
  }
}
for (const file of [
  "packages/enterprise-planner/src/route-planner.ts",
  "src/agents/enterprise-route-planner.runtime.ts",
  "src/enterprise/plan.ts",
  "src/enterprise/builtin-trees.ts",
  "scripts/enterprise-routing-eval.ts",
]) {
  readSource(file);
}
const planner = createModelWorkflowPlanner({
  cfg: loadConfig(),
  agentId: "main",
  modelRef: values.model,
  literalModelRef: true,
});
const results: Array<Record<string, unknown>> = [];
const report = {
  startedAt: new Date().toISOString(),
  model: values.model,
  repeat,
  sourceHashes,
  scope: "Live planner only; no business tools, answer generation, or GUI test",
  results,
};
mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
let failures = 0;
for (let round = 1; round <= repeat; round += 1) {
  for (const entry of suite.cases) {
    const start = performance.now();
    const selection = await selectWorkflowPlan({
      trees,
      defaultTree: BUILTIN_ASSIST_TREE,
      requestText: entry.request,
      planner,
    });
    const elapsedMs = performance.now() - start;
    const steps =
      selection.next.kind !== "execute"
        ? []
        : enterpriseStepSequence(
            buildEnterpriseRunPlan({
              runId: `${entry.id}-${round}`,
              requestText: entry.request,
              mode: "enforce",
              tree: selection.tree,
              matchedBy: selection.treeSource,
              route: selection.route,
            }),
          );
    // Compare the effective workflow: an explicit no-match decision legitimately
    // resolves to the default tree. Keep its origin in `source` for auditing.
    const actual =
      selection.next.kind === "clarify"
        ? { kind: "clarify", treeId: selection.tree.id }
        : selection.next.kind === "blocked"
          ? { kind: "blocked", treeId: selection.tree.id }
          : { kind: "execute", treeId: selection.tree.id, steps };
    const modelAnswered = selection.treeSource === "planner" || selection.treeSource === "no-match";
    const passed =
      modelAnswered &&
      selection.route.invalidRoutes.length === 0 &&
      actual.kind === entry.expected.kind &&
      actual.treeId === entry.expected.treeId &&
      (entry.expected.kind !== "execute" ||
        !entry.expected.steps ||
        ("steps" in actual &&
          JSON.stringify(actual.steps) === JSON.stringify(entry.expected.steps)));
    if (!passed) {
      failures += 1;
    }
    results.push({
      ...entry,
      round,
      actual,
      passed,
      elapsedMs,
      source: selection.treeSource,
      routes: selection.route.routes,
      invalidRoutes: selection.route.invalidRoutes,
      rationale: selection.treeRationale,
      ...(selection.next.kind === "clarify" ? { question: selection.next.question } : {}),
    });
    // Persist after every call so interruption preserves the original failures.
    writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
    console.log(`${entry.id} #${round}: ${passed ? "PASS" : "FAIL"} ${elapsedMs.toFixed(0)}ms`);
  }
}
console.log(`${results.length - failures}/${results.length} routing decisions matched`);
process.exitCode = failures > 0 ? 1 : 0;
