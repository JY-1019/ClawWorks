/**
 * Golden checks for the enterprise execution layer.
 *
 * WHY THIS EXISTS. The prose test cases ask a human to type a request naming an
 * order or a claim and then eyeball the reply. That cannot separate "the layer
 * works" from "the model happened to answer well", and the shipped examples seed
 * no instances, so the ids in those prompts referred to nothing.
 *
 * So this runs the REAL mediation path — the same `beginEnterpriseRun` and tool
 * gate production uses — against a fixture that ships seeded data
 * (`examples/enterprise/golden-orders.clawworks.yaml`), with the planner INJECTED
 * rather than called. No model, no network, no reliance on the machine having
 * planner credentials, and the same answer every run.
 *
 * It is hermetic: `OPENCLAW_STATE_DIR` points at a fresh temp dir, so it never
 * reads or writes the operator's real state database.
 *
 * Usage:
 *   node --import tsx scripts/enterprise-golden.ts          # run the checks
 *   node --import tsx scripts/enterprise-golden.ts --verbose
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Must be set BEFORE the state database module is imported: it resolves the
// store path once, so a later assignment would still hit the real install.
const stateDir = mkdtempSync(path.join(tmpdir(), "clawworks-golden-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

const verbose = process.argv.includes("--verbose");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  if (verbose) {
    console.log(`${ok ? "pass" : "FAIL"}  ${name}\n      ${detail}`);
  }
}

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(name, a === e, a === e ? a : `expected ${e}, got ${a}`);
}

function printSummary(): void {
  const failed = checks.filter((check) => !check.ok);
  const width = Math.max(...checks.map((check) => check.name.length));
  console.log("");
  for (const check of checks) {
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
}

const FIXTURE = path.resolve("examples/enterprise/golden-orders.clawworks.yaml");
const TREE_ID = "golden.orders";

async function main(): Promise<number> {
  const { importWorkflowTreeContent } = await import("../src/enterprise/tree-io.js");
  const { invalidateWorkflowTreeRegistry, listWorkflowTreeRegistryEntries } =
    await import("../src/enterprise/tree-registry.js");
  const { beginEnterpriseRun, endEnterpriseRun } =
    await import("../src/enterprise/run-mediation.js");
  const {
    evaluateEnterpriseToolCall,
    getEnterpriseActiveRun,
    setEnterpriseStepForTurn,
    recordEnterpriseTurnExecuted,
  } = await import("../src/enterprise/runtime.js");
  const { searchOntologyObjects } = await import("../src/enterprise/object-store.sqlite.js");
  const {
    createComputeFunctionTool,
    createGetNeighborsTool,
    createInvokeActionTool,
    createSearchObjectsTool,
  } = await import("../src/agents/tools/ontology-tools.js");

  // ---- 1. The fixture imports, and its seeded instances land in the store.
  const imported = importWorkflowTreeContent({
    content: readFileSync(FIXTURE, "utf8"),
    format: "yaml",
  });
  record(
    "fixture imports cleanly",
    imported.ok,
    imported.ok ? TREE_ID : JSON.stringify(imported.issues),
  );
  if (!imported.ok) {
    // Print what was captured before bailing: a silent non-zero exit gives CI
    // nothing to act on.
    printSummary();
    return 1;
  }
  invalidateWorkflowTreeRegistry();

  // ---- The seeded data is reachable THROUGH THE PRODUCTION TOOLS. Calling the
  // store and the expression evaluator directly would stay green even if the
  // tools' active-step scoping, argument adapters, or result mapping broke.
  {
    const runId = "golden-reads";
    await beginEnterpriseRun({
      runId,
      prompt: "ORD-5002 조사",
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        // investigate is the step that declares all three read tools.
        routes: ["golden.investigate"],
        rationale: "reads",
      }),
    });
    setEnterpriseStepForTurn(runId);

    const search = await createSearchObjectsTool({ runId }).execute("g1", {
      entity: "order",
      limit: 50,
    });
    const searchText = JSON.stringify(search);
    record(
      "search_objects returns the seeded orders",
      ["ORD-5001", "ORD-5002", "ORD-5003"].every((id) => searchText.includes(id)),
      searchText.slice(0, 110),
    );

    const neighbors = await createGetNeighborsTool({ runId }).execute("g2", {
      entity: "ticket",
      objectId: "TKT-77",
    });
    const neighborText = JSON.stringify(neighbors);
    record(
      "get_neighbors traverses a seeded link to its order",
      neighborText.includes("ORD-5002") && neighborText.includes("concerns"),
      neighborText.slice(0, 110),
    );

    const computed = await createComputeFunctionTool({ runId }).execute("g3", {
      function: "auto-refundable-amount",
      objectId: "ORD-5002",
    });
    // Compare the payload's number, not the rendered text: a regression to 1200
    // or 2000 would still contain "200" as a substring.
    const computedValue = (computed as { details?: { value?: unknown } }).details?.value;
    expectEqual(
      "compute_function caps the refundable amount at the limit",
      // ORD-5002 totals 310 and the expression is min($total, 200).
      computedValue,
      200,
    );
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 2. No planner: the DEFAULT tree governs, not this work-map.
  // A request nothing can judge must not inherit a work-map's tool scope.
  {
    const runId = "golden-unplanned";
    const mediation = await beginEnterpriseRun({ runId, prompt: "주문 ORD-5002 환불해줘" });
    expectEqual(
      "no planner -> default tree governs",
      mediation.kind === "mediated"
        ? { tree: mediation.plan.treeId, matchedBy: mediation.plan.matchedBy }
        : { kind: mediation.kind },
      { tree: "clawworks.assist", matchedBy: "unavailable" },
    );
    // ...and its scope is permissive, so an unrelated request is not restricted.
    const verdict = evaluateEnterpriseToolCall({ runId, toolName: "exec" });
    expectEqual("no planner -> tools stay open", verdict?.blocked ?? false, false);
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 3. Planner picks the work-map and a route: only that branch is planned.
  {
    const runId = "golden-routed";
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "TKT-77 티켓 확인하고 ORD-5002 환불 처리해줘",
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        routes: ["golden.triage", "golden.resolve"],
        rationale: "golden",
      }),
    });
    const planned =
      mediation.kind === "mediated" ? mediation.plan.nodes.map((node) => node.nodeId) : [];
    expectEqual("planner route narrows to the chosen branches", planned.toSorted(), [
      "golden",
      "golden.resolve",
      "golden.triage",
    ]);
    expectEqual(
      "matchedBy records the model chose",
      mediation.kind === "mediated" ? mediation.plan.matchedBy : null,
      "planner",
    );

    // The digest the model sees must match what the gate enforces. It renders
    // step TITLES, so an unrouted step leaking in would tell the model to do work
    // its tools are about to refuse.
    const digest = mediation.kind === "mediated" ? mediation.promptSection : "";
    const routedInDigest =
      digest.includes("Triage the request") && digest.includes("Resolve or refund");
    const unroutedLeaked = digest.includes("Hand off to a human");
    record(
      "digest carries exactly the routed steps",
      routedInDigest && !unroutedLeaked,
      unroutedLeaked
        ? "an unrouted step leaked into the digest"
        : routedInDigest
          ? `${digest.length} chars, escalate omitted`
          : "a routed step is missing from the digest",
    );
    // The seeded types have to reach the model too, or it cannot name a real id.
    const declaresOrder = digest.includes("order (id*");
    const declaresTicket = digest.includes("ticket (id*");
    record(
      "digest declares the seeded object types",
      declaresOrder && declaresTicket,
      // Name both halves: a detail that says "order + ticket declared" next to a
      // FAIL hides which one actually went missing.
      `order=${declaresOrder} ticket=${declaresTicket}`,
    );

    // ---- 4. The tool gate follows the ACTIVE step, inheriting the root denial.
    setEnterpriseStepForTurn(runId); // enters the first routed leaf: golden.triage
    // "blocked" alone would stay green if inheritance regressed, because the leaf
    // excludes exec through its own allowedTools too. The reason names the step
    // that decided, so assert it is the ROOT.
    const execVerdict = evaluateEnterpriseToolCall({ runId, toolName: "exec" });
    record(
      "root denial is inherited by the step",
      Boolean(execVerdict?.blocked) && execVerdict?.decision.reason.includes('step "golden"'),
      execVerdict?.decision.reason ?? "no verdict",
    );
    expectEqual(
      "the step's own tool is allowed",
      evaluateEnterpriseToolCall({ runId, toolName: "search_objects" })?.blocked ?? false,
      false,
    );
    expectEqual(
      "a later step's tool is not allowed yet",
      evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked ?? false,
      true,
    );

    // ---- 5. Advancing the step moves the scope with it.
    recordEnterpriseTurnExecuted(runId);
    setEnterpriseStepForTurn(runId); // advances to golden.resolve
    expectEqual(
      "after advancing, the next step's tool is allowed",
      evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked ?? false,
      false,
    );
    expectEqual(
      "after advancing, the previous step's tool is closed",
      evaluateEnterpriseToolCall({ runId, toolName: "search_objects" })?.blocked ?? false,
      true,
    );
    // ---- 5b. The declared action executes through the PRODUCTION tool and
    // writes its object. Calling the store helper directly would skip the tool's
    // own argument adapter and scope resolution, so a regression that broke the
    // wired-up tool would still leave this green.
    //
    // A `create` effect also needs the target type's primary key among the
    // action's parameters; without it every invocation fails validation, and a
    // fixture that only LOOKS executable lets the ontology path rot unnoticed.
    const invokeAction = createInvokeActionTool({ runId });
    const invoked = await invokeAction.execute("golden-call", {
      action: "issue-refund",
      args: { id: "REF-9100", "order-id": "ORD-5002", amount: 42 },
    });
    const invokedText = JSON.stringify(invoked);
    record(
      "invoke_action runs the declared action",
      !invokedText.includes('"error"'),
      invokedText.slice(0, 120),
    );
    const refunds = searchOntologyObjects({ treeId: TREE_ID, entity: "refund", limit: 50 });
    expectEqual(
      "the refund it created is readable",
      refunds.map((row) => row.objectId).toSorted(),
      ["REF-9001", "REF-9100"],
    );
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 6. A run-level deny blocks the run BEFORE any model contact, even
  // though that same precheck withholds the planner.
  {
    const runId = "golden-denied";
    let deniedPlannerCalls = 0;
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "ORD-5002 환불해줘",
      config: {
        enterprise: {
          governance: { policies: [{ id: "deny.golden", effect: "deny", trees: ["golden.*"] }] },
        },
      } as never,
      routePlanner: async () => {
        deniedPlannerCalls += 1;
        return { kind: "decided", treeId: TREE_ID, routes: [], rationale: "never" };
      },
    });
    expectEqual("a tree-scoped deny still blocks the run", mediation.kind, "blocked");
    // Blocking is not enough: the point of the precheck is that a denied prompt
    // never reaches a provider. A regression that planned first would still end
    // up blocked, so only the call count catches it.
    expectEqual("the denied prompt never reaches the planner", deniedPlannerCalls, 0);
  }

  // ---- 7. Built-in example trees never govern; only imports do.
  {
    const ids = listWorkflowTreeRegistryEntries().map((entry) => entry.tree.id);
    record(
      "the shipped support example stays registered for inspection",
      ids.includes("clawworks.support"),
      ids.join(", "),
    );
    // Wire a planner that WOULD take the built-in example if it were offered.
    // Without one, selection lands on the default tree regardless of whether the
    // example was wrongly admitted, so the check could not see the regression.
    const runId = "golden-builtin";
    let offered: string[] = [];
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "고객 지원 티켓 절차대로 환불 처리해줘",
      routePlanner: async ({ trees }) => {
        offered = trees.map((tree) => tree.id);
        return { kind: "decided", treeId: "clawworks.support", routes: [], rationale: "support" };
      },
    });
    expectEqual(
      "the shipped example is never offered as a candidate",
      offered.includes("clawworks.support"),
      false,
    );
    expectEqual(
      "the shipped example never binds a run",
      mediation.kind === "mediated" ? mediation.plan.treeId : null,
      // The planner named a tree that is not a candidate, so selection fails
      // closed onto the installed work-map rather than the example.
      TREE_ID,
    );
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 8. A declared skill REACHES THE MODEL, in the advisory lane. It travels
  // with the work-map, shows up in the operator surfaces, and is named under its
  // step in the run digest as a preference — but it must never widen the step's
  // tool scope, because guidance that grants capability is not guidance. The
  // rendering is unconditional: whether the skill can actually be opened depends
  // on the dispatching runtime, which the plan cannot see. These checks pin both
  // halves so neither can drift without being noticed.
  {
    const { collectReferencedSkills } = await import("../src/enterprise/tree-references.js");
    const entry = listWorkflowTreeRegistryEntries().find((row) => row.tree.id === TREE_ID);
    const declaredSkills = entry ? collectReferencedSkills(entry.tree) : [];
    expectEqual("the work-map's declared skills travel with it", declaredSkills, [
      "summarize",
      "taskflow-inbox-triage",
    ]);
    // Resolve whatever the FIXTURE declares, not a name repeated here: a check
    // against a constant stays green when the fixture drifts to an id nothing
    // provides, which is the exact regression worth catching. A dangling skill
    // is unresolvable for anyone who imports the work-map and is invisible at
    // runtime — only the operator surfaces show it.
    const unbundled = declaredSkills.filter(
      (name) => !existsSync(path.resolve("skills", name, "SKILL.md")),
    );
    record(
      "every declared skill is one this repo actually bundles",
      declaredSkills.length > 0 && unbundled.length === 0,
      declaredSkills.length === 0
        ? "the fixture declares no skills, so this proves nothing"
        : unbundled.length > 0
          ? `no SKILL.md for: ${unbundled.join(", ")}`
          : declaredSkills.map((name) => `skills/${name}/SKILL.md`).join(", "),
    );

    const runId = "golden-skills";
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "TKT-77 티켓 분류해줘",
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        routes: ["golden.triage"],
        rationale: "skills",
      }),
    });
    setEnterpriseStepForTurn(runId);
    const digest = mediation.kind === "mediated" ? mediation.promptSection : "";
    record(
      "a declared skill reaches the model digest",
      digest.includes("Skills: taskflow-inbox-triage"),
      digest.includes("taskflow-inbox-triage")
        ? "rendered under its step"
        : "the declaration never reached the prompt, so it cannot change a turn",
    );
    // The names alone are trivia; the one-time gloss says what to do with them.
    // It must stay a PREFERENCE and must restate containment — an instruction to
    // load would be unexecutable on a step whose scope withholds `read`, which is
    // every skills-bearing step in the shipped examples.
    record(
      "the digest says what to do with a declared skill, without ordering an unexecutable load",
      digest.includes("prefer it over improvising") &&
        digest.includes("never grant a tool the step's scope withholds") &&
        !/load (those|these) skills/i.test(digest),
      /load (those|these) skills/i.test(digest)
        ? "the digest orders a skill load the step's tool scope cannot perform"
        : digest.includes("prefer it over improvising")
          ? "preference gloss present with the containment clause"
          : "skills are named but nothing tells the model what to do with them",
    );
    // golden.triage declares the skill AND a two-tool allow-list. If declaring
    // ever started granting tools, this is the assertion that would catch it.
    expectEqual(
      "declaring a skill does not widen the step's tool scope",
      evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked ?? false,
      true,
    );
    endEnterpriseRun({ runId, status: "completed" });

    // ---- The instructions themselves, inlined. golden.escalate declares
    // `summarize` and withholds `read`, so this is the case that used to be
    // unreachable: with the body in the prompt the step needs no tool to use it.
    const inlinedId = "golden-skill-instructions";
    const inlined = await beginEnterpriseRun({
      runId: inlinedId,
      prompt: "사람에게 넘겨줘",
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        routes: ["golden.escalate"],
        rationale: "inline",
      }),
      // The runner's already-resolved set; the real one comes from the session
      // skills snapshot. Pointing at the repo's own bundled SKILL.md keeps this
      // honest — it is the same file a run would load.
      availableSkills: [
        {
          name: "summarize",
          filePath: path.resolve("skills", "summarize", "SKILL.md"),
          baseDir: path.resolve("skills", "summarize"),
        },
      ],
    });
    const inlinedDigest = inlined.kind === "mediated" ? inlined.promptSection : "";
    record(
      "a declared skill's instructions are inlined into the digest",
      inlinedDigest.includes("Skill instructions for the steps above (summarize):") &&
        inlinedDigest.includes("### summarize"),
      inlinedDigest.includes("### summarize")
        ? "body carried in the prompt, so the step needs no read to use it"
        : "only the name reached the prompt; the model would still have to open the file",
    );
    record(
      "the inlined body is the SKILL.md content, not its frontmatter",
      inlinedDigest.includes("# Summarize") && !inlinedDigest.includes("homepage:"),
      inlinedDigest.includes("# Summarize")
        ? "frontmatter stripped, body kept"
        : "the body did not survive frontmatter stripping",
    );
    // Containment: naming a skill must not hand the step a tool it lacks.
    setEnterpriseStepForTurn(inlinedId);
    expectEqual(
      "inlining instructions does not widen the step's tool scope",
      evaluateEnterpriseToolCall({ runId: inlinedId, toolName: "read" })?.blocked ?? false,
      true,
    );
    endEnterpriseRun({ runId: inlinedId, status: "completed" });

    // A step can only surface a skill the AGENT already has: the work-map
    // declaration narrows the runner's set, it can never add to it.
    const unknownId = "golden-skill-unknown";
    const unknown = await beginEnterpriseRun({
      runId: unknownId,
      prompt: "사람에게 넘겨줘",
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        routes: ["golden.escalate"],
        rationale: "unknown",
      }),
      availableSkills: [],
    });
    const unknownDigest = unknown.kind === "mediated" ? unknown.promptSection : "";
    record(
      "a skill the agent does not have is named but never inlined",
      unknownDigest.includes("Skills: summarize") &&
        !unknownDigest.includes("Skill instructions for the steps above"),
      unknownDigest.includes("Skill instructions for the steps above")
        ? "instructions appeared for a skill the agent does not have"
        : "declaration shown, nothing fabricated",
    );
    endEnterpriseRun({ runId: unknownId, status: "completed" });

    // Rendering is UNCONDITIONAL, including on a step whose scope withholds
    // `read`. Whether a skill can be opened depends on the dispatching runtime
    // (embedded reads SKILL.md, claude-cli resolves natively, ACP drops the
    // digest) and the plan cannot see which — so gating would guess and silently
    // drop an operator's declaration. golden.escalate is exactly that step.
    const noReadId = "golden-skills-noread";
    const noRead = await beginEnterpriseRun({
      runId: noReadId,
      prompt: "사람에게 넘겨줘",
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        routes: ["golden.escalate"],
        rationale: "no-read",
      }),
    });
    const noReadDigest = noRead.kind === "mediated" ? noRead.promptSection : "";
    record(
      "a step that declares a skill names it even without read in scope",
      noReadDigest.includes("Skills: summarize"),
      noReadDigest.includes("Skills:")
        ? "declared and rendered; loadability is the runtime's business"
        : "the declaration was dropped, which no plan-level fact can justify",
    );
    endEnterpriseRun({ runId: noReadId, status: "completed" });
  }

  // ---- 9. Knowledge foundations, through the bundle an operator actually
  // imports. A tree cannot carry knowledge, so this is the only shipped path
  // where `knowledge_search` returns anything without the operator standing up a
  // retrieval server first — which makes it the only one a golden check can
  // cover end to end.
  {
    const { importWorkflowBundle } = await import("../src/enterprise/bundle-io.js");
    const { createKnowledgeSearchTool } =
      await import("../src/agents/tools/knowledge-search-tool.js");
    const BUNDLE_TREE_ID = "acme.support-desk";
    const FOUNDATION_ID = "acme.support-desk-handbook";
    const bundlePath = path.resolve("examples/enterprise/support-desk.clawworks-bundle.yaml");
    const bundle = importWorkflowBundle({
      content: readFileSync(bundlePath, "utf8"),
      format: "yaml",
    });
    record(
      "the shipped bundle imports cleanly",
      bundle.ok,
      bundle.ok ? bundle.trees.map((tree) => tree.id).join(", ") : JSON.stringify(bundle.issues),
    );
    if (bundle.ok) {
      expectEqual("its knowledge foundation is inlined and registered", bundle.foundations, [
        FOUNDATION_ID,
      ]);
      // A referenced-but-not-inlined id means the recipient has to configure it
      // separately; for a self-contained example that is a broken promise.
      expectEqual("it leaves no foundation unconfigured", bundle.missingFoundations, []);
      invalidateWorkflowTreeRegistry();

      const runId = "golden-knowledge";
      await beginEnterpriseRun({
        runId,
        prompt: "환불 한도가 얼마야?",
        routePlanner: async () => ({
          kind: "decided",
          treeId: BUNDLE_TREE_ID,
          routes: ["desk.answer"],
          rationale: "knowledge",
        }),
      });
      setEnterpriseStepForTurn(runId);
      const knowledge = createKnowledgeSearchTool({ runId });

      const hit = await knowledge.execute("k1", { query: "refund limit approval" });
      const hitText = JSON.stringify(hit);
      record(
        "knowledge_search returns the inlined corpus on a scoped step",
        hitText.includes("$200") && hitText.includes(FOUNDATION_ID),
        hitText.slice(0, 140),
      );

      // Model-supplied targeting is a narrowing, never an authority: an id the
      // step does not allow must be reported as skipped rather than queried.
      const offScope = await knowledge.execute("k2", {
        query: "refund limit",
        foundations: ["acme.not-in-this-scope"],
      });
      const offScopeText = JSON.stringify(offScope);
      record(
        "an out-of-scope foundation is skipped, not queried",
        offScopeText.includes("acme.not-in-this-scope") && offScopeText.includes('"snippets":[]'),
        offScopeText.slice(0, 140),
      );
      endEnterpriseRun({ runId, status: "completed" });

      // The escalation step drops knowledge_search from its allow-list, so the
      // tool gate closes it even though the root still scopes the foundation.
      const escalateRunId = "golden-knowledge-escalate";
      await beginEnterpriseRun({
        runId: escalateRunId,
        prompt: "사람에게 넘겨줘",
        routePlanner: async () => ({
          kind: "decided",
          treeId: BUNDLE_TREE_ID,
          routes: ["desk.escalate"],
          rationale: "escalate",
        }),
      });
      setEnterpriseStepForTurn(escalateRunId);
      // Walk to the escalation leaf. A planner route names the branch but does not
      // move the run into it: the active leaf advances with executed turns, so
      // without these the assertions below would judge the FIRST leaf instead.
      recordEnterpriseTurnExecuted(escalateRunId);
      setEnterpriseStepForTurn(escalateRunId);
      recordEnterpriseTurnExecuted(escalateRunId);
      setEnterpriseStepForTurn(escalateRunId);
      expectEqual(
        "a step that drops knowledge_search cannot retrieve at all",
        evaluateEnterpriseToolCall({ runId: escalateRunId, toolName: "knowledge_search" })
          ?.blocked ?? false,
        true,
      );
      expectEqual(
        "that same step keeps the tool it does allow",
        evaluateEnterpriseToolCall({ runId: escalateRunId, toolName: "message" })?.blocked ?? false,
        false,
      );
      endEnterpriseRun({ runId: escalateRunId, status: "completed" });

      // MCP is the only scope that denies by default, so both directions matter:
      // the step that attaches the server may call it, and its siblings may not —
      // even though the root's allow-list would otherwise pass the tool.
      const mcpRunId = "golden-mcp";
      await beginEnterpriseRun({
        runId: mcpRunId,
        prompt: "사람에게 넘겨줘",
        // BOTH registered: only a registered server is gated, so leaving
        // other-tracker out would have the isolation check below pass on the tool
        // scope alone — green even if one attachment granted every server.
        config: {
          mcp: {
            servers: { "acme-tracker": { command: "npx" }, "other-tracker": { command: "npx" } },
          },
        } as never,
        // Names the tree, like every other run here: two trees are imported, and
        // without a planner this would bind whichever one wins the fallback.
        // The `routes` are inert for THIS fixture and deliberately so: selection
        // skips the planner entirely on a tree this small ("not worth a model
        // call"), so the plan keeps all four nodes and the walk below moves leaf
        // by leaf. Do not read the route as choosing the step under test.
        routePlanner: async () => ({
          kind: "decided",
          treeId: BUNDLE_TREE_ID,
          routes: ["desk.escalate"],
          rationale: "escalate",
        }),
      });
      setEnterpriseStepForTurn(mcpRunId);
      // Name the step this asserts against: if a route ever narrows this tree to
      // the escalation leaf, the check below would silently start testing the step
      // that DOES attach the server and pass for the wrong reason.
      expectEqual(
        "the run starts on the triage step, which attaches nothing",
        getEnterpriseActiveRun(mcpRunId)?.plan.activeNodeId,
        "desk.triage",
      );
      expectEqual(
        "the first step, which attaches nothing, cannot reach the server",
        evaluateEnterpriseToolCall({
          runId: mcpRunId,
          toolName: "acme-tracker__create_issue",
          mcpTool: {
            serverName: "acme-tracker",
            safeServerName: "acme-tracker",
            toolName: "create_issue",
          },
        })?.blocked ?? false,
        true,
      );
      // Walk to desk.escalate, the one step the example attaches the server to.
      recordEnterpriseTurnExecuted(mcpRunId);
      setEnterpriseStepForTurn(mcpRunId);
      recordEnterpriseTurnExecuted(mcpRunId);
      setEnterpriseStepForTurn(mcpRunId);
      expectEqual(
        "the step that attaches an MCP server may call it",
        evaluateEnterpriseToolCall({
          runId: mcpRunId,
          toolName: "acme-tracker__create_issue",
          mcpTool: {
            serverName: "acme-tracker",
            safeServerName: "acme-tracker",
            toolName: "create_issue",
          },
        })?.blocked ?? false,
        false,
      );
      // The attachment grants THAT server, not MCP in general.
      expectEqual(
        "a server no step attached is still denied on the same step",
        evaluateEnterpriseToolCall({
          runId: mcpRunId,
          toolName: "other-tracker__create_issue",
          mcpTool: {
            serverName: "other-tracker",
            safeServerName: "other-tracker",
            toolName: "create_issue",
          },
        })?.blocked ?? false,
        true,
      );
      // Any tool of the attached server, not just the one named above. (That the
      // ATTACHMENT alone grants an embedded call, with no tool-scope entry, is
      // covered by governance.test.ts — this example also carries the globs a
      // native backend needs, so it cannot prove that here.)
      expectEqual(
        "the attached server's other tools are callable from that step",
        JSON.stringify(
          evaluateEnterpriseToolCall({
            runId: mcpRunId,
            toolName: "acme-tracker__anything",
            mcpTool: {
              serverName: "acme-tracker",
              safeServerName: "acme-tracker",
              toolName: "anything",
            },
          })?.decision.effect,
        ),
        JSON.stringify("allow"),
      );
      endEnterpriseRun({ runId: mcpRunId, status: "completed" });
    }
  }

  // ---- The SHIPPED explicit-grants example, end to end. An operator can import
  // this file as-is, so what it promises has to be what the runtime does: all
  // four families deny-by-default, and its knowledge foundation inlined so the
  // import needs nothing else.
  {
    const EXPLICIT_BUNDLE_TREE_ID = "acme.explicit-grants";
    const EXPLICIT_FOUNDATION_ID = "acme.research-handbook";
    const { importWorkflowBundle } = await import("../src/enterprise/bundle-io.js");
    const examplePath = path.resolve("examples/enterprise/explicit-grants.clawworks-bundle.yaml");
    const exampleBundle = importWorkflowBundle({
      content: readFileSync(examplePath, "utf8"),
      format: "yaml",
    });
    record(
      "the shipped explicit-grants example imports cleanly",
      exampleBundle.ok,
      exampleBundle.ok ? EXPLICIT_BUNDLE_TREE_ID : JSON.stringify(exampleBundle.issues),
    );
    if (exampleBundle.ok) {
      // Self-contained: an example that names a foundation it does not carry
      // would retrieve nothing on the recipient's deployment.
      expectEqual("its knowledge foundation ships inline", exampleBundle.foundations, [
        EXPLICIT_FOUNDATION_ID,
      ]);
      expectEqual("it leaves no foundation unconfigured", exampleBundle.missingFoundations, []);
      // The skill it declares has to be one this repo bundles AND one that needs
      // no external binary: a skill whose `requires.bins` is missing on the host
      // is filtered out of the run, which would make the example's skills axis
      // inert on exactly the machines it is meant to demonstrate on.
      expectEqual(
        "its declared skill is bundled here and needs no external binary",
        exampleBundle.requiredSkills.map((name) => {
          const file = path.resolve("skills", name, "SKILL.md");
          if (!existsSync(file)) {
            return `MISSING:${name}`;
          }
          return /"bins"\s*:\s*\[[^\]]/.test(readFileSync(file, "utf8"))
            ? `NEEDS-BIN:${name}`
            : name;
        }),
        ["taskflow-inbox-triage"],
      );
      expectEqual(
        "it names the MCP server an operator must register",
        [...(exampleBundle.requiredMcpServers ?? [])],
        ["acme-tracker"],
      );
      invalidateWorkflowTreeRegistry();

      const exampleRunId = "golden-example-explicit";
      await beginEnterpriseRun({
        runId: exampleRunId,
        prompt: "check the handbook",
        config: { mcp: { servers: { "acme-tracker": { command: "npx" } } } } as never,
        routePlanner: async () => ({
          kind: "decided",
          treeId: EXPLICIT_BUNDLE_TREE_ID,
          routes: [],
          rationale: "example",
        }),
      });
      setEnterpriseStepForTurn(exampleRunId);
      const examplePlan = getEnterpriseActiveRun(exampleRunId)?.plan;
      expectEqual(
        "the example run grants capabilities explicitly",
        examplePlan?.capabilityGrants,
        "explicit",
      );
      // TOOLS: the active step (research.gather) grants `knowledge_search` and
      // nothing else, so the root's wider floor does NOT widen it back — the
      // intersection still applies under explicit grants. (Root-grant
      // inheritance itself is proven below, on a step that grants none.)
      expectEqual(
        "the example's reading step may search the handbook",
        evaluateEnterpriseToolCall({ runId: exampleRunId, toolName: "knowledge_search" })
          ?.blocked ?? false,
        false,
      );
      expectEqual(
        "but not reply, which only its root and a later step grant",
        evaluateEnterpriseToolCall({ runId: exampleRunId, toolName: "message" })?.blocked ?? false,
        true,
      );
      expectEqual(
        "a tool the example never grants is denied",
        evaluateEnterpriseToolCall({ runId: exampleRunId, toolName: "exec" })?.blocked ?? false,
        true,
      );
      // SKILLS: exactly what the steps attach, nothing else.
      expectEqual(
        "the example run's skill catalog is its declared skill",
        examplePlan?.grantedSkills,
        ["taskflow-inbox-triage"],
      );
      // MCP: the tracker is registered here, but the FIRST step attaches nothing.
      expectEqual(
        "the example's first step cannot reach the tracker it registered",
        evaluateEnterpriseToolCall({
          runId: exampleRunId,
          toolName: "acme-tracker__create_issue",
          mcpTool: {
            serverName: "acme-tracker",
            safeServerName: "acme-tracker",
            toolName: "create_issue",
          },
        })?.blocked ?? false,
        true,
      );
      endEnterpriseRun({ runId: exampleRunId, status: "completed" });
    }
  }

  // ---- A work-map that grants capabilities explicitly, through the real path.
  // Written here rather than shipped as an example: the examples deliberately
  // carry the inherited semantics, and this needs a tree where a step grants
  // nothing to prove that silence denies.
  {
    const EXPLICIT_TREE_ID = "golden.explicit";
    const explicitTree = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: EXPLICIT_TREE_ID,
      version: "1.0.0",
      name: "Explicit grants",
      description: "Work-map that grants tools, skills, and MCP servers per step.",
      match: { triggers: ["user"], priority: 50 },
      capabilityGrants: "explicit",
      root: {
        id: "grant",
        title: "Handle the request",
        ontology: { allowedTools: ["message"], skills: ["desk-intake"] },
        children: [
          {
            id: "grant.narrow",
            title: "Work within the root grant",
            ontology: { skills: ["ticket-triage"] },
          },
        ],
      },
    };
    const importedExplicit = importWorkflowTreeContent({
      content: JSON.stringify(explicitTree),
      format: "json",
    });
    record(
      "an explicit-grants work-map imports cleanly",
      importedExplicit.ok,
      importedExplicit.ok ? EXPLICIT_TREE_ID : JSON.stringify(importedExplicit.issues),
    );
    if (importedExplicit.ok) {
      invalidateWorkflowTreeRegistry();
      const explicitRunId = "golden-explicit";
      await beginEnterpriseRun({
        runId: explicitRunId,
        prompt: "handle this",
        // Registered but never attached: the point of the check below.
        config: { mcp: { servers: { "acme-tracker": { command: "npx" } } } } as never,
        routePlanner: async () => ({
          kind: "decided",
          treeId: EXPLICIT_TREE_ID,
          routes: ["grant.narrow"],
          rationale: "explicit",
        }),
      });
      setEnterpriseStepForTurn(explicitRunId);
      expectEqual(
        "a tool the root grants is callable from a step that grants none of its own",
        evaluateEnterpriseToolCall({ runId: explicitRunId, toolName: "message" })?.blocked ?? false,
        false,
      );
      expectEqual(
        "a tool no step grants is denied even though no list excludes it",
        evaluateEnterpriseToolCall({ runId: explicitRunId, toolName: "memory_search" })?.blocked ??
          false,
        true,
      );
      expectEqual(
        "the run's skill catalog is narrowed to what its steps attach",
        getEnterpriseActiveRun(explicitRunId)?.plan.grantedSkills,
        ["desk-intake", "ticket-triage"],
      );
      expectEqual(
        "a registered MCP server is denied to a work-map that attaches none",
        evaluateEnterpriseToolCall({
          runId: explicitRunId,
          toolName: "acme-tracker__create_issue",
          mcpTool: {
            serverName: "acme-tracker",
            safeServerName: "acme-tracker",
            toolName: "create_issue",
          },
        })?.blocked ?? false,
        true,
      );
      // What a plugin-owned harness asks core before it narrows its own surface:
      // the Codex app-server turns off Codex's native skills block on the
      // strength of this answer, and that wire shape lives in the plugin.
      const { resolveRunSkillGrant } = await import("../src/agents/enterprise-skill-scope.js");
      expectEqual(
        "a harness asking core gets this run's skill grant",
        resolveRunSkillGrant({ runId: explicitRunId }),
        ["desk-intake", "ticket-triage"],
      );
      expectEqual(
        "and gets nothing to narrow for a run no work-map governs",
        resolveRunSkillGrant({ runId: "golden-not-a-run" }),
        null,
      );
      endEnterpriseRun({ runId: explicitRunId, status: "completed" });
    }
  }

  // ---- The CLI overlay resolves the PLUGIN half before attachments. A plugin
  // server the run's ceiling rejects must not take a legitimately attached one
  // with it: the two collide only after sanitization, and the denial below names
  // the plugin's raw key, which no spelling of the attached server matches.
  {
    const ORDER_TREE_ID = "golden.mcp-order";
    const orderTree = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: ORDER_TREE_ID,
      version: "1.0.0",
      name: "MCP filter order",
      match: { triggers: ["user"], priority: 60 },
      root: {
        id: "order",
        title: "Handle the request",
        ontology: {
          mcpServers: ["my server"],
          // A root allow-list is what makes the collision check run at all (with
          // none, the ceiling narrows nothing and admits every peer). It grants
          // the attached server whole, in both spellings a runtime can emit.
          allowedTools: ["my_server__*", "mcp__my_server__*", "my-server__*", "mcp__my-server__*"],
          // Names the PLUGIN key only. `my server` materializes to `my_server` /
          // `my-server`, none of which this pattern matches.
          deniedTools: ["my:server"],
        },
      },
    };
    const importedOrder = importWorkflowTreeContent({
      content: JSON.stringify(orderTree),
      format: "json",
    });
    record(
      "the MCP filter-order work-map imports cleanly",
      importedOrder.ok,
      importedOrder.ok ? ORDER_TREE_ID : JSON.stringify(importedOrder.issues),
    );
    if (importedOrder.ok) {
      invalidateWorkflowTreeRegistry();
      const orderRunId = "golden-mcp-order";
      await beginEnterpriseRun({
        runId: orderRunId,
        prompt: "file it",
        config: { mcp: { servers: { "my server": { command: "npx" } } } } as never,
        routePlanner: async () => ({
          kind: "decided",
          treeId: ORDER_TREE_ID,
          routes: [],
          rationale: "order",
        }),
      });
      const { enterpriseRunAttachedMcpServers, enterpriseRunBoundableMcpServers } =
        await import("../src/enterprise/active-runs.js");
      const admittedPlugins = enterpriseRunBoundableMcpServers(orderRunId, ["my:server"], []);
      expectEqual("the denial drops the plugin server first", [...(admittedPlugins ?? [])], []);
      expectEqual(
        "the attachment survives once that doomed peer is out",
        [...(enterpriseRunAttachedMcpServers(orderRunId, [...(admittedPlugins ?? [])]) ?? [])],
        ["my server"],
      );
      expectEqual(
        "counting the doomed peer instead would have withheld both",
        [...(enterpriseRunAttachedMcpServers(orderRunId, ["my:server"]) ?? [])],
        [],
      );
      endEnterpriseRun({ runId: orderRunId, status: "completed" });
    }
  }

  printSummary();
  return checks.every((check) => check.ok) ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`golden run threw: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  const { closeOpenClawStateDatabase } = await import("../src/state/openclaw-state-db.js");
  closeOpenClawStateDatabase();
  rmSync(stateDir, { recursive: true, force: true });
}
// exitCode, not exit(): under CI or `tee` the summary may still be queued, and
// exiting immediately would drop the diagnostics while keeping the status.
process.exitCode = code;
