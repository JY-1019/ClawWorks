/**
 * Golden checks for the enterprise execution layer.
 *
 * WHY THIS EXISTS. The prose test cases ask a human to type a request naming a
 * claim or an alert and then eyeball the reply. That cannot separate "the layer
 * works" from "the model happened to answer well".
 *
 * So this runs the REAL mediation path — the same `beginEnterpriseRun` and tool
 * gate production uses — against the SHIPPED example
 * (`examples/enterprise/financial-operations.clawworks-bundle.yaml`), with the
 * planner INJECTED rather than called. No model, no network, no reliance on the
 * machine having planner credentials, and the same answer every run.
 *
 * The fixture and the example are the same file on purpose. A separate golden
 * fixture drifts from what an operator actually imports, and the old split let
 * five of the six shipped examples ship broken — declaring actions no run could
 * call and foundations no run could query — while the golden lane stayed green
 * against a seventh file nobody deployed. Every id, tool scope, attachment and
 * seeded row asserted below is one an operator gets.
 *
 * Three small work-maps are still built INLINE at the end, for semantics one tree
 * cannot carry: the inherited (non-explicit) grant mode, a root tool grant
 * inherited by a step that grants none, and the CLI overlay's plugin/attachment
 * filter order.
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

const FIXTURE = path.resolve("examples/enterprise/financial-operations.clawworks-bundle.yaml");
const TREE_ID = "acme.financial-operations";
const FOUNDATIONS = [
  "acme.kyc-manual",
  "acme.aml-policy",
  "acme.claims-handbook",
  "acme.credit-policy",
  "acme.regulatory-code",
  "acme.privacy-standard",
];

/**
 * The four servers the example attaches, plus one the operator registered and no
 * step attaches. Only a REGISTERED server is gated, so leaving the spare out
 * would let the isolation checks pass on the tool scope alone.
 */
const MCP_CONFIG = {
  mcp: {
    servers: {
      "acme-screening": { command: "npx" },
      "acme-ledger": { command: "npx" },
      "acme-tracker": { command: "npx" },
      "acme-filing": { command: "npx" },
      "other-tracker": { command: "npx" },
    },
  },
};

async function main(): Promise<number> {
  const { importWorkflowBundle } = await import("../src/enterprise/bundle-io.js");
  const { importWorkflowTreeContent } = await import("../src/enterprise/tree-io.js");
  const { invalidateWorkflowTreeRegistry, listWorkflowTreeRegistryEntries } =
    await import("../src/enterprise/tree-registry.js");
  const { beginEnterpriseRun, endEnterpriseRun } =
    await import("../src/enterprise/run-mediation.js");
  const { evaluateEnterpriseToolCall, getEnterpriseActiveRun, completeEnterpriseStep } =
    await import("../src/enterprise/runtime.js");
  const { resolveEnterpriseKnowledge } = await import("../src/enterprise/knowledge.js");
  const { searchOntologyObjects } = await import("../src/enterprise/object-store.sqlite.js");
  const {
    createComputeFunctionTool,
    createGetNeighborsTool,
    createInvokeActionTool,
    createSearchObjectsTool,
  } = await import("../src/agents/tools/ontology-tools.js");
  const { createKnowledgeSearchTool } =
    await import("../src/agents/tools/knowledge-search-tool.js");

  /** One MCP call at the run's active step, under the embedded runtime's spelling. */
  const mcpVerdict = (runId: string, server: string, tool: string) =>
    evaluateEnterpriseToolCall({
      runId,
      toolName: `${server}__${tool}`,
      mcpTool: { serverName: server, safeServerName: server, toolName: tool },
    });

  /** Open a mediated run on one route of the shipped example. */
  const openRun = (runId: string, prompt: string, routes: string[]) =>
    beginEnterpriseRun({
      runId,
      prompt,
      config: MCP_CONFIG as never,
      routePlanner: async () => ({
        kind: "decided" as const,
        treeId: TREE_ID,
        routes,
        rationale: "golden",
      }),
    });

  // ---- 1. The shipped example imports, and everything it promises arrives with
  // it: the six corpora inlined and registered, no dangling reference, and no
  // step declaring a capability its own scope refuses.
  const imported = importWorkflowBundle({
    content: readFileSync(FIXTURE, "utf8"),
    format: "yaml",
  });
  record(
    "the shipped example imports cleanly",
    imported.ok,
    imported.ok
      ? imported.trees.map((tree) => tree.id).join(", ")
      : JSON.stringify(imported.issues),
  );
  if (!imported.ok) {
    // Print what was captured before bailing: a silent non-zero exit gives CI
    // nothing to act on.
    printSummary();
    return 1;
  }
  expectEqual("its six corpora ship inline and register", imported.foundations, FOUNDATIONS);
  // A referenced-but-not-inlined id means the recipient has to configure it
  // separately; for a self-contained example that is a broken promise.
  expectEqual("it leaves no foundation unconfigured", imported.missingFoundations, []);
  expectEqual("it declares no unreachable capability", imported.warnings, []);
  expectEqual(
    "it names the MCP servers an operator must register",
    [...(imported.requiredMcpServers ?? [])].toSorted(),
    ["acme-filing", "acme-ledger", "acme-screening", "acme-tracker"],
  );
  // A skill whose `requires.bins` is missing on the host is filtered out of the
  // run, which would make the skills axis inert on exactly the machines this
  // example is meant to demonstrate on.
  expectEqual(
    "its declared skills are bundled here and need no external binary",
    imported.requiredSkills.toSorted().map((name) => {
      const file = path.resolve("skills", name, "SKILL.md");
      if (!existsSync(file)) {
        return `MISSING:${name}`;
      }
      return /"bins"\s*:\s*\[[^\]]/.test(readFileSync(file, "utf8")) ? `NEEDS-BIN:${name}` : name;
    }),
    ["taskflow", "taskflow-inbox-triage"],
  );
  invalidateWorkflowTreeRegistry();

  // ---- 2. The seeded data is reachable THROUGH THE PRODUCTION TOOLS, from the
  // step that owns it. Calling the store and the expression evaluator directly
  // would stay green even if the tools' active-step scoping, argument adapters,
  // or result mapping broke.
  {
    const runId = "golden-reads";
    await openRun(runId, "AC-2002 거래 검토", [
      "finops.risk.monitoring.investigation.transaction-review",
    ]);

    const search = await createSearchObjectsTool({ runId }).execute("g1", {
      entity: "transaction",
      limit: 50,
    });
    const searchText = JSON.stringify(search);
    record(
      "search_objects returns the seeded transactions",
      ["TX-4001", "TX-4002", "TX-4003"].every((id) => searchText.includes(id)),
      searchText.slice(0, 110),
    );

    const neighbors = await createGetNeighborsTool({ runId }).execute("g2", {
      entity: "account",
      objectId: "AC-2002",
    });
    const neighborText = JSON.stringify(neighbors);
    record(
      "get_neighbors walks the seeded links off an account",
      neighborText.includes("TX-4001") &&
        neighborText.includes("TX-4002") &&
        neighborText.includes("account-books-transaction"),
      neighborText.slice(0, 110),
    );

    const computed = await createComputeFunctionTool({ runId }).execute("g3", {
      function: "alert-priority",
      objectId: "AL-6002",
    });
    // Compare the payload's value, not the rendered text: a band that regressed
    // to "not urgent" would still contain "urgent" as a substring.
    expectEqual(
      "compute_function bands the alert from its stored score",
      // AL-6002 scores 88, and the expression bands 80+ as urgent.
      (computed as { details?: { value?: unknown } }).details?.value,
      "urgent",
    );

    // Sibling isolation, through the tool an agent would actually call. `payment`
    // is declared one branch away under finops.claims.settlement, so this step
    // cannot address it at all — the ontology, not just the tool scope, is what
    // stops a monitoring step from reading claim money.
    const offBranch = await createSearchObjectsTool({ runId }).execute("g4", {
      entity: "payment",
      limit: 5,
    });
    const offBranchText = JSON.stringify(offBranch);
    record(
      "a sibling domain's object type is not addressable here",
      offBranchText.includes("not in the ontology of this workflow step") &&
        !offBranchText.includes("PM-7101"),
      offBranchText.slice(0, 140),
    );
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 3. No planner: the DEFAULT tree governs, not this work-map.
  // A request nothing can judge must not inherit a work-map's tool scope.
  {
    const runId = "golden-unplanned";
    const mediation = await beginEnterpriseRun({ runId, prompt: "CL-6101 지급해줘" });
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

  // ---- 4. A planner route narrows a 46-node work-map to the branches it chose,
  // the digest carries exactly those steps, and the tool gate follows the ACTIVE
  // one.
  {
    const runId = "golden-routed";
    const mediation = await openRun(runId, "CL-6101 접수 분류하고 지급 처리해줘", [
      "finops.claims.intake.triage",
      "finops.claims.settlement.payment",
    ]);
    const plan = mediation.kind === "mediated" ? mediation.plan : null;
    expectEqual(
      "the route keeps the chosen branches and the ancestors that govern them",
      plan?.nodes.map((node) => node.nodeId),
      [
        // Ancestors are kept on purpose: governance merges every ontology down the
        // root→active path, so dropping one would drop the tool ceiling, the object
        // types and the corpora it declares.
        "finops",
        "finops.claims",
        "finops.claims.intake",
        "finops.claims.intake.triage",
        "finops.claims.settlement",
        "finops.claims.settlement.payment",
      ],
    );
    expectEqual("matchedBy records the model chose", plan?.matchedBy, "planner");
    // The attachments follow the route too: the claims escalation step attaches
    // acme-tracker, and this route never enters it, so the server is not handed to
    // a subprocess that has no per-step gate. This is the route-level UNION; what a
    // hookless runtime actually receives is narrower, and section 8 pins that.
    expectEqual("only the routed branch's MCP attachments travel", plan?.mcpAttachments, [
      "acme-ledger",
    ]);
    // Same for the skill catalog under explicit grants.
    expectEqual("the skill catalog is narrowed to the route", plan?.grantedSkills, [
      "taskflow-inbox-triage",
    ]);

    // The digest the model sees must match what the gate enforces. It renders
    // step TITLES, so an unrouted step leaking in would tell the model to do work
    // its tools are about to refuse.
    const digest = mediation.kind === "mediated" ? mediation.promptSection : "";
    const routedInDigest = digest.includes("Triage the claim") && digest.includes("Pay the claim");
    const unroutedLeaked =
      digest.includes("Dispose of the case") || digest.includes("Screen against the watchlists");
    record(
      "digest carries exactly the routed steps",
      routedInDigest && !unroutedLeaked,
      unroutedLeaked
        ? "an unrouted step leaked into the digest"
        : routedInDigest
          ? `${digest.length} chars, 28 unrouted steps omitted`
          : "a routed step is missing from the digest",
    );
    // The seeded types have to reach the model too, or it cannot name a real id.
    const declaresClaim = digest.includes("claim (claim-id*");
    const declaresPayment = digest.includes("payment (payment-id*");
    record(
      "digest declares the seeded object types of both branches",
      declaresClaim && declaresPayment,
      // Name both halves: a detail that says "claim + payment declared" next to a
      // FAIL hides which one actually went missing.
      `claim=${declaresClaim} payment=${declaresPayment}`,
    );

    // Mediation already opened the run on its first routed leaf.
    expectEqual(
      "the run opens on the first routed step",
      plan?.activeNodeId,
      "finops.claims.intake.triage",
    );
    // "blocked" alone would stay green if inheritance regressed, because the leaf
    // excludes exec through its own allow-list too. The reason names the step that
    // decided, so assert it is the ROOT.
    const execVerdict = evaluateEnterpriseToolCall({ runId, toolName: "exec" });
    record(
      "the root's hard denial is inherited by the step",
      Boolean(execVerdict?.blocked) && execVerdict?.decision.reason.includes('step "finops"'),
      execVerdict?.decision.reason ?? "no verdict",
    );
    expectEqual(
      "the step's own tool is allowed",
      evaluateEnterpriseToolCall({ runId, toolName: "search_objects" })?.blocked ?? false,
      false,
    );
    // The core floor, on a step whose allow-list never mentions it. Under
    // deny-by-default, silence must not take away the ability to answer or to look
    // at anything — see CORE_FLOOR_TOOLS.
    expectEqual(
      "the core floor survives deny-by-default",
      evaluateEnterpriseToolCall({ runId, toolName: "memory_search" })?.decision.effect ?? "none",
      "allow",
    );
    // A write from a step that never opted in is REFUSED, not raised as an
    // approval: an action the step cannot honor is a declaration bug, and a human
    // waving it through would let the model write from a scope that forbids it.
    const writeVerdict = evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" });
    record(
      "a write from a step that does not opt in is refused outright",
      writeVerdict?.decision.effect === "deny" &&
        writeVerdict.decision.reason.includes("does not allow ontology writes"),
      writeVerdict?.decision.reason ?? "no verdict",
    );

    // ---- 5. Advancing the step moves the scope with it.
    completeEnterpriseStep({ runId }); // advances to finops.claims.settlement.payment
    expectEqual(
      "after advancing, the run stands on the next routed step",
      getEnterpriseActiveRun(runId)?.plan.activeNodeId,
      "finops.claims.settlement.payment",
    );
    expectEqual(
      "after advancing, the write step may write",
      evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked ?? false,
      false,
    );
    expectEqual(
      // get_neighbors, not search_objects: the payment step reads the claim it is
      // about to settle and computes the cap it must not exceed, so it carries
      // both of those. Walking the graph stays the earlier step's job, which is
      // what proves the scope MOVES rather than accumulating.
      "after advancing, the previous step's tool is closed",
      evaluateEnterpriseToolCall({ runId, toolName: "get_neighbors" })?.requiresApproval ?? false,
      true,
    );

    // ---- 6. The declared action executes through the PRODUCTION tool and writes
    // its object. Calling the store helper directly would skip the tool's own
    // argument adapter and scope resolution, so a regression that broke the
    // wired-up tool would still leave this green.
    //
    // A `create` effect also needs the target type's primary key among the
    // action's parameters; without it every invocation fails validation, and a
    // fixture that only LOOKS executable lets the ontology path rot unnoticed.
    const invoked = await createInvokeActionTool({ runId }).execute("golden-call", {
      action: "issue-claim-payment",
      args: {
        "payment-id": "PM-7199",
        "claim-id": "CL-6101",
        "paid-amount": 1800,
        status: "settled",
      },
    });
    const invokedText = JSON.stringify(invoked);
    record(
      "invoke_action runs the declared action",
      !invokedText.includes('"error"'),
      invokedText.slice(0, 120),
    );
    expectEqual(
      "the payment it created is readable",
      searchOntologyObjects({ treeId: TREE_ID, entity: "payment", limit: 50 })
        .map((row) => row.objectId)
        .toSorted(),
      ["PM-7101", "PM-7199"],
    );
    // Both effects, and neither crossed into the other. An action writes only what
    // it declares, so a payment-only version would leave the claim `submitted`
    // forever; a shared `amount` property would have let the paid figure overwrite
    // the claim's own. That is why `payment` calls its column `paid-amount`.
    expectEqual(
      "paying settles the claim without rewriting the amount it was filed for",
      searchOntologyObjects({ treeId: TREE_ID, entity: "claim", limit: 50 })
        .filter((row) => row.objectId === "CL-6101")
        .map((row) => `${row.properties.status}:${row.properties.amount}`),
      ["settled:1800"],
    );
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 7. The two UPDATE actions, against the drafts the fixture seeds. A
  // create effect refuses an id that already exists (ontology-actions.ts), so a
  // work-map whose only write for an existing record is a create leaves the model
  // no move but inventing a second one. Both of these write onto the seeded row
  // and merge over it, which is also what proves the stored properties an update
  // does not name survive.
  {
    const sarId = "golden-sar-update";
    await openRun(sarId, "CS-7001 보고서 작성", ["finops.risk.monitoring.sar-filing"]);
    const drafted = await createInvokeActionTool({ runId: sarId }).execute("sar-call", {
      action: "draft-sar",
      args: { "sar-id": "SR-8001", narrative: "Structuring across TX-4001 and TX-4002." },
    });
    record(
      "the drafting action writes onto the report the case already carries",
      !JSON.stringify(drafted).includes('"error"'),
      JSON.stringify(drafted).slice(0, 120),
    );
    expectEqual(
      "the narrative lands and the case link survives the merge",
      searchOntologyObjects({ treeId: TREE_ID, entity: "sar", limit: 10 }).map((row) => [
        row.objectId,
        row.properties["case-id"],
        row.properties.narrative,
      ]),
      [["SR-8001", "CS-7001", "Structuring across TX-4001 and TX-4002."]],
    );
    endEnterpriseRun({ runId: sarId, status: "completed" });

    const filingId = "golden-filing-update";
    await openRun(filingId, "Q3 신고 제출", ["finops.reporting.regulatory.submission"]);
    await createInvokeActionTool({ runId: filingId }).execute("file-call", {
      action: "file-regulatory-report",
      args: { "report-id": "RP-9102", status: "filed" },
    });
    expectEqual(
      "submitting the return moves its status without rewriting its period",
      searchOntologyObjects({ treeId: TREE_ID, entity: "regulatory-report", limit: 10 })
        .map((row) => `${row.objectId}:${row.properties.period}:${row.properties.status}`)
        .toSorted(),
      ["RP-9101:2026-Q2:filed", "RP-9102:2026-Q3:filed"],
    );
    endEnterpriseRun({ runId: filingId, status: "completed" });
  }

  // ---- 8. MCP: four servers, and the attachment is the whole grant. Both
  // directions matter on every one of them — the step that attaches may call it,
  // and its siblings may not, even though nothing in their tool scope says so.
  {
    // The ledger step. One branch away from the two steps that reach the screening
    // provider, and the only step in 30 that can move money.
    const ledgerId = "golden-mcp-ledger";
    await openRun(ledgerId, "CL-6101 지급", ["finops.claims.settlement.payment"]);
    expectEqual(
      "the payment step may call the ledger it attached",
      mcpVerdict(ledgerId, "acme-ledger", "transfer")?.decision.effect,
      "allow",
    );
    // Any tool of the attached server, not just a named one: the attachment grants
    // the server, and requiring the tool names too would make attaching in the UI
    // insufficient.
    expectEqual(
      "the attachment covers the server's other tools too",
      mcpVerdict(ledgerId, "acme-ledger", "anything")?.decision.effect,
      "allow",
    );
    const crossDomain = mcpVerdict(ledgerId, "acme-screening", "lookup");
    record(
      "a server another domain attached is denied here",
      Boolean(crossDomain?.blocked) && crossDomain.decision.reason.includes("is not attached"),
      crossDomain?.decision.reason ?? "no verdict",
    );
    expectEqual(
      "a registered server no step attaches is denied everywhere",
      mcpVerdict(ledgerId, "other-tracker", "create_issue")?.blocked ?? false,
      true,
    );
    endEnterpriseRun({ runId: ledgerId, status: "completed" });

    // The same server, attached in a SECOND domain. An attachment is per-step: the
    // onboarding screening step reaching it says nothing about this one.
    const screeningId = "golden-mcp-screening";
    await openRun(screeningId, "AC-2002 상대방 확인", [
      "finops.risk.monitoring.investigation.link-analysis",
    ]);
    expectEqual(
      "the same server is reachable from the other domain that attached it",
      mcpVerdict(screeningId, "acme-screening", "lookup")?.decision.effect,
      "allow",
    );
    expectEqual(
      "and the ledger is not reachable from there",
      mcpVerdict(screeningId, "acme-ledger", "transfer")?.blocked ?? false,
      true,
    );
    endEnterpriseRun({ runId: screeningId, status: "completed" });

    // The immediate SIBLING of an attaching step. This is the case a tool-scope
    // check cannot catch: adjudicate sits under the same parent as the screening
    // step and inherits everything except the attachment.
    const siblingId = "golden-mcp-sibling";
    await openRun(siblingId, "CU-1002 심사 판정", [
      "finops.customer.onboarding.kyc-review.adjudicate",
    ]);
    expectEqual(
      "the run stands on the sibling that attaches nothing",
      getEnterpriseActiveRun(siblingId)?.plan.activeNodeId,
      "finops.customer.onboarding.kyc-review.adjudicate",
    );
    expectEqual(
      "an attaching step's sibling still cannot reach the server",
      mcpVerdict(siblingId, "acme-screening", "lookup")?.blocked ?? false,
      true,
    );
    endEnterpriseRun({ runId: siblingId, status: "completed" });

    // A denial outranks the attachment. The dispute step attaches the tracker and
    // then takes ONE destructive operation back — refused outright rather than
    // raised as an approval, because writing a `deniedTools` entry is a decision.
    const disputeId = "golden-mcp-denied-op";
    await openRun(disputeId, "TX-4003 분쟁 접수", ["finops.customer.servicing.dispute"]);
    expectEqual(
      "the attached tracker's ordinary operations run",
      mcpVerdict(disputeId, "acme-tracker", "create_issue")?.decision.effect,
      "allow",
    );
    const takenBack = mcpVerdict(disputeId, "acme-tracker", "delete_issue");
    record(
      "a denied operation is refused even on the step that attached the server",
      takenBack?.decision.effect === "deny" &&
        takenBack.decision.reason.includes("ontology.deniedTools"),
      takenBack?.decision.reason ?? "no verdict",
    );
    endEnterpriseRun({ runId: disputeId, status: "completed" });

    // What a HOOKLESS runtime actually receives, which is not the route's union.
    // The server is handed to the subprocess ONCE, before it connects, and nothing
    // judges its calls afterwards — so it is admitted only when EVERY executable
    // path in the plan grants it whole. A route that pairs the ledger step with any
    // sibling therefore withholds the ledger outright rather than handing a
    // hookless run a server one of its steps must never reach. That is the safe
    // direction and it costs a real capability, so both halves are pinned here: an
    // example whose per-step isolation only worked on the embedded runtime would be
    // a much weaker claim than it reads as.
    const { enterpriseRunAttachedMcpServers } = await import("../src/enterprise/active-runs.js");
    const soloId = "golden-mcp-native-solo";
    await openRun(soloId, "CL-6101 지급", ["finops.claims.settlement.payment"]);
    expectEqual(
      "a route that is only the ledger step hands the ledger over at launch",
      [...(enterpriseRunAttachedMcpServers(soloId, []) ?? ["<not governed>"])],
      ["acme-ledger"],
    );
    endEnterpriseRun({ runId: soloId, status: "completed" });

    const mixedId = "golden-mcp-native-mixed";
    await openRun(mixedId, "CL-6101 분류 후 지급", [
      "finops.claims.intake.triage",
      "finops.claims.settlement.payment",
    ]);
    expectEqual(
      "adding a step that must not reach it withholds it from the whole run",
      [...(enterpriseRunAttachedMcpServers(mixedId, []) ?? ["<not governed>"])],
      [],
    );
    endEnterpriseRun({ runId: mixedId, status: "completed" });

    // And the sharper half of the same rule: a server carrying ANY per-operation
    // denial is never handed to a hookless runtime at all. `deniedTools` is read
    // TREE-WIDE, and a native harness renames tools by rules OpenClaw cannot
    // invert, so `acme-tracker__delete_issue` costs the tracker on EVERY route —
    // including this one, which is the tracker's other attaching step and denies
    // nothing itself. That price is the reason the example says so at the denial.
    const trackerId = "golden-mcp-native-partial-deny";
    await openRun(trackerId, "CL-6102 사람에게 넘겨줘", ["finops.claims.intake.escalation"]);
    expectEqual(
      "a partially denied server is withheld from a hookless run on every route",
      [...(enterpriseRunAttachedMcpServers(trackerId, []) ?? ["<not governed>"])],
      [],
    );
    endEnterpriseRun({ runId: trackerId, status: "completed" });

    // The control: same shape, no per-operation denial, so it is handed over.
    // Without this the check above would pass on any bug that withheld everything.
    const filingId = "golden-mcp-native-undenied";
    await openRun(filingId, "Q3 신고 제출", ["finops.reporting.regulatory.submission"]);
    expectEqual(
      "a server with no operation denied is still handed over",
      [...(enterpriseRunAttachedMcpServers(filingId, []) ?? ["<not governed>"])],
      ["acme-filing"],
    );
    endEnterpriseRun({ runId: filingId, status: "completed" });
  }

  // ---- 9. Knowledge: six corpora, each scoped to the steps that may query it.
  // This is the only shipped path where `knowledge_search` returns anything
  // without the operator standing up a retrieval server first — a tree cannot
  // carry knowledge, which is why the example is a bundle.
  {
    // The claims desk. Its handbook answers; the AML policy the risk domain holds
    // is skipped rather than queried, because model-supplied targeting is a
    // narrowing and never an authority.
    const claimsId = "golden-knowledge-claims";
    await openRun(claimsId, "CL-6102 지급 권한", ["finops.claims.settlement.authority"]);
    const hit = await createKnowledgeSearchTool({ runId: claimsId }).execute("k1", {
      query: "settlement authority approver",
    });
    const hitText = JSON.stringify(hit);
    record(
      "knowledge_search answers from the corpus the step was granted",
      hitText.includes("$5,000") && hitText.includes("acme.claims-handbook"),
      hitText.slice(0, 150),
    );
    expectEqual(
      "a corpus another domain holds is skipped, not queried",
      (
        await resolveEnterpriseKnowledge({
          runId: claimsId,
          query: "structuring threshold",
          foundations: ["acme.aml-policy"],
        })
      ).skipped.map((entry) => entry.foundationId),
      ["acme.aml-policy"],
    );

    // The two sources deliberately DISAGREE. The handbook's written figure is the
    // DESK's authority ($5,000); this claim's own derived cap is 2,500. A reply
    // that quotes 5,000 for CL-6102 has answered a record question from a policy
    // passage — the exact confusion this fixture exists to catch, and it is only
    // detectable because the numbers differ.
    const cap = await createComputeFunctionTool({ runId: claimsId }).execute("k2", {
      function: "auto-payable-amount",
      objectId: "CL-6102",
    });
    expectEqual(
      "the record's derived cap is not the handbook's number",
      (cap as { details?: { value?: unknown } }).details?.value,
      2500,
    );
    endEnterpriseRun({ runId: claimsId, status: "completed" });

    // The cross-domain corpus. acme.aml-policy is granted to the whole risk domain
    // AND to reporting, so the filing step answers from it and from the regulatory
    // code — a corpus is granted to the steps that need it, not owned by a domain.
    const filingId = "golden-knowledge-filing";
    await openRun(filingId, "분기 신고 준비", ["finops.reporting.regulatory.submission"]);
    expectEqual(
      "a step granted two corpora answers from both",
      [
        ...new Set(
          (
            await resolveEnterpriseKnowledge({
              runId: filingId,
              query: "suspicious activity report disposition",
            })
          ).snippets.map((snippet) => snippet.foundationId),
        ),
      ].toSorted(),
      ["acme.aml-policy", "acme.regulatory-code"],
    );
    endEnterpriseRun({ runId: filingId, status: "completed" });

    // The other half of the rule: a grant made by an ANCESTOR reaches a step that
    // names no corpus of its own. Every other step here narrows; coverage-check is
    // the one that inherits.
    const inheritId = "golden-knowledge-inherited";
    await openRun(inheritId, "CL-6102 보장 범위", ["finops.claims.adjudication.coverage-check"]);
    expectEqual(
      "a step that names no corpus inherits its domain's grant",
      [
        ...new Set(
          (
            await resolveEnterpriseKnowledge({ runId: inheritId, query: "coverage limit policy" })
          ).snippets.map((snippet) => snippet.foundationId),
        ),
      ],
      ["acme.claims-handbook"],
    );
    expectEqual(
      "including the second corpus that domain granted",
      [
        ...new Set(
          (
            await resolveEnterpriseKnowledge({ runId: inheritId, query: "data minimization" })
          ).snippets.map((snippet) => snippet.foundationId),
        ),
      ],
      ["acme.privacy-standard"],
    );
    endEnterpriseRun({ runId: inheritId, status: "completed" });

    // The step that actually sends customer data to an outside provider holds the
    // standard that says how much may go, and its sibling — which never leaves the
    // building — does not. A step cannot cite a rule its own path narrows away, so
    // an expectedOutput that names one is only honest if the corpus reaches it.
    const outboundId = "golden-knowledge-outbound";
    await openRun(outboundId, "CU-1002 워치리스트 대조", [
      "finops.customer.onboarding.kyc-review.screening",
    ]);
    expectEqual(
      "the step that sends data outside can read the rule that bounds it",
      [
        ...new Set(
          (
            await resolveEnterpriseKnowledge({
              runId: outboundId,
              query: "account number external service",
            })
          ).snippets.map((snippet) => snippet.foundationId),
        ),
      ].toSorted(),
      ["acme.kyc-manual", "acme.privacy-standard"],
    );
    endEnterpriseRun({ runId: outboundId, status: "completed" });

    const inboundId = "golden-knowledge-inbound";
    await openRun(inboundId, "CU-1002 심사 판정", [
      "finops.customer.onboarding.kyc-review.adjudicate",
    ]);
    expectEqual(
      "its sibling, which sends nothing, is narrowed back off that corpus",
      (
        await resolveEnterpriseKnowledge({
          runId: inboundId,
          query: "external service",
          foundations: ["acme.privacy-standard"],
        })
      ).skipped.map((entry) => entry.foundationId),
      ["acme.privacy-standard"],
    );
    endEnterpriseRun({ runId: inboundId, status: "completed" });

    // A step must be able to read the rule its own title rests on. The
    // underwriting branch is the case that proves it: the risk domain's AML corpus
    // covers alerts, structuring and SARs and says nothing about approval bands,
    // so a decision step holding only that could not decide anything the root's
    // no-invented-policy constraint permits.
    const creditId = "golden-knowledge-credit";
    await openRun(creditId, "CU-1002 여신 판단", ["finops.risk.underwriting.decision"]);
    expectEqual(
      "the underwriting step reads the corpus its decision rests on",
      [
        ...new Set(
          (
            await resolveEnterpriseKnowledge({
              runId: creditId,
              query: "subprime applicant declined exception",
            })
          ).snippets.map((snippet) => snippet.foundationId),
        ),
      ],
      ["acme.credit-policy"],
    );
    expectEqual(
      "and the credit corpus stops at that branch",
      (
        await resolveEnterpriseKnowledge({
          runId: creditId,
          query: "coverage limit",
          foundations: ["acme.claims-handbook"],
        })
      ).skipped.map((entry) => entry.foundationId),
      ["acme.claims-handbook"],
    );
    endEnterpriseRun({ runId: creditId, status: "completed" });

    const monitorId = "golden-knowledge-monitoring";
    await openRun(monitorId, "AL-6002 분류", ["finops.risk.monitoring.alert-triage"]);
    expectEqual(
      "a sibling branch of the same domain never sees it",
      (
        await resolveEnterpriseKnowledge({
          runId: monitorId,
          query: "approval bands",
          foundations: ["acme.credit-policy"],
        })
      ).skipped.map((entry) => entry.foundationId),
      ["acme.credit-policy"],
    );
    endEnterpriseRun({ runId: monitorId, status: "completed" });

    // A step that drops knowledge_search cannot retrieve at all, even though its
    // ancestors still scope a corpus to it. The two gates are independent.
    const noRetrievalId = "golden-knowledge-closed";
    await openRun(noRetrievalId, "CL-6101 지급", ["finops.claims.settlement.payment"]);
    expectEqual(
      "a step without knowledge_search cannot retrieve, whatever it was granted",
      evaluateEnterpriseToolCall({ runId: noRetrievalId, toolName: "knowledge_search" })
        ?.requiresApproval ?? false,
      true,
    );
    endEnterpriseRun({ runId: noRetrievalId, status: "completed" });
  }

  // ---- 10. Skills. A declared skill travels with the work-map, is named under its
  // step in the digest as a preference, narrows the run's catalog under explicit
  // grants — and must never widen the step's tool scope, because guidance that
  // grants capability is not guidance.
  {
    const { collectReferencedSkills } = await import("../src/enterprise/tree-references.js");
    const entry = listWorkflowTreeRegistryEntries().find((row) => row.tree.id === TREE_ID);
    const declaredSkills = entry ? collectReferencedSkills(entry.tree) : [];
    expectEqual("the work-map's declared skills travel with it", declaredSkills, [
      "taskflow",
      "taskflow-inbox-triage",
    ]);

    const runId = "golden-skills";
    const mediation = await openRun(runId, "AL-6002 경보 분류", [
      "finops.risk.monitoring.alert-triage",
    ]);
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
    // load would be unexecutable on a step whose scope withholds `read`.
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
    // alert-triage declares the skill AND a five-tool allow-list. If declaring ever
    // started granting tools, this is the assertion that would catch it.
    expectEqual(
      "declaring a skill does not widen the step's tool scope",
      evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked ?? false,
      true,
    );
    // Under explicit grants the catalog follows the ROUTE, so a run that never
    // enters the branches declaring `summarize` is not offered it.
    expectEqual(
      "the run's skill catalog is only what this route reaches",
      getEnterpriseActiveRun(runId)?.plan.grantedSkills,
      ["taskflow-inbox-triage"],
    );
    endEnterpriseRun({ runId, status: "completed" });

    // The instructions themselves, inlined. The claims escalation step declares
    // `taskflow` and never grants `read`, so this is the case that would otherwise
    // be unreachable: with the body in the prompt the step needs no tool to use it.
    const inlinedId = "golden-skill-instructions";
    const inlined = await beginEnterpriseRun({
      runId: inlinedId,
      prompt: "CL-6102 사람에게 넘겨줘",
      config: MCP_CONFIG as never,
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        routes: ["finops.claims.intake.escalation"],
        rationale: "inline",
      }),
      // The runner's already-resolved set; the real one comes from the session
      // skills snapshot. Pointing at the repo's own bundled SKILL.md keeps this
      // honest — it is the same file a run would load.
      availableSkills: [
        {
          name: "taskflow",
          filePath: path.resolve("skills", "taskflow", "SKILL.md"),
          baseDir: path.resolve("skills", "taskflow"),
        },
      ],
    });
    const inlinedDigest = inlined.kind === "mediated" ? inlined.promptSection : "";
    record(
      "a declared skill's instructions are inlined into the digest",
      inlinedDigest.includes("Skill instructions for the steps above (taskflow):") &&
        inlinedDigest.includes("### taskflow"),
      inlinedDigest.includes("### taskflow")
        ? "body carried in the prompt, so the step needs no read to use it"
        : "only the name reached the prompt; the model would still have to open the file",
    );
    record(
      "the inlined body is the SKILL.md content, not its frontmatter",
      // The metadata block is where the emoji and the install recipe live, so its
      // absence is what proves the frontmatter was stripped rather than inlined.
      inlinedDigest.includes("# TaskFlow") && !inlinedDigest.includes('"emoji"'),
      inlinedDigest.includes("# TaskFlow")
        ? "frontmatter stripped, body kept"
        : "the body did not survive frontmatter stripping",
    );
    // Containment: naming a skill must not hand the step a tool it lacks.
    expectEqual(
      "inlining instructions does not widen the step's tool scope",
      evaluateEnterpriseToolCall({ runId: inlinedId, toolName: "read" })?.decision.effect ?? "none",
      // `read` is on the core floor, so it stays available — but only because the
      // floor says so, not because a skill declaration granted it.
      "allow",
    );
    endEnterpriseRun({ runId: inlinedId, status: "completed" });

    // A step can only surface a skill the AGENT already has: the work-map
    // declaration narrows the runner's set, it can never add to it.
    const unknownId = "golden-skill-unknown";
    const unknown = await beginEnterpriseRun({
      runId: unknownId,
      prompt: "CL-6102 사람에게 넘겨줘",
      config: MCP_CONFIG as never,
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        routes: ["finops.claims.intake.escalation"],
        rationale: "unknown",
      }),
      availableSkills: [],
    });
    const unknownDigest = unknown.kind === "mediated" ? unknown.promptSection : "";
    record(
      "a skill the agent does not have is named but never inlined",
      unknownDigest.includes("Skills: taskflow") &&
        !unknownDigest.includes("Skill instructions for the steps above"),
      unknownDigest.includes("Skill instructions for the steps above")
        ? "instructions appeared for a skill the agent does not have"
        : "declaration shown, nothing fabricated",
    );

    // What a plugin-owned harness asks core before it narrows its own surface: the
    // Codex app-server turns off Codex's native skills block on the strength of
    // this answer, and that wire shape lives in the plugin.
    const { resolveRunSkillGrant } = await import("../src/agents/enterprise-skill-scope.js");
    expectEqual(
      "a harness asking core gets this run's skill grant",
      resolveRunSkillGrant({ runId: unknownId }),
      ["taskflow"],
    );
    expectEqual(
      "and gets nothing to narrow for a run no work-map governs",
      resolveRunSkillGrant({ runId: "golden-not-a-run" }),
      null,
    );
    // The same question for a tool the harness never dispatches. Codex's web_search
    // is hosted (the model host runs it), so no PreToolUse hook can reach it and the
    // per-call gate never sees the call — the launch decision is the only place the
    // work-map's scope can still apply.
    const { enterpriseRunAdmitsHostedTool } = await import("../src/enterprise/active-runs.js");
    expectEqual(
      "a hosted tool no step grants is withheld before the harness starts",
      enterpriseRunAdmitsHostedTool(unknownId, "web_search"),
      false,
    );
    expectEqual(
      "and nothing is withheld from a run no work-map governs",
      enterpriseRunAdmitsHostedTool("golden-not-a-run", "web_search"),
      true,
    );
    endEnterpriseRun({ runId: unknownId, status: "completed" });
  }

  // ---- 11. A run-level deny blocks the run BEFORE any model contact, even
  // though that same precheck withholds the planner.
  {
    const runId = "golden-denied";
    let deniedPlannerCalls = 0;
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "CL-6101 지급해줘",
      config: {
        enterprise: {
          governance: { policies: [{ id: "deny.finops", effect: "deny", trees: ["acme.*"] }] },
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

  // ---- 12. Built-in example trees never govern; only imports do.
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
      prompt: "고객 지원 티켓 절차대로 처리해줘",
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

  // ---- 13. The INHERITED grant mode, which the shipped example cannot carry: a
  // work-map declares one mode or the other, and the example is explicit. Built
  // inline because the point is a tree where a step scopes nothing and therefore
  // allows everything — the opposite of every step in the example.
  {
    const INHERITED_TREE_ID = "golden.inherited";
    const inheritedTree = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: INHERITED_TREE_ID,
      version: "1.0.0",
      name: "Inherited grants",
      description: "Work-map that narrows within what an ancestor allowed.",
      match: { triggers: ["user"], priority: 70 },
      root: {
        id: "inherit",
        title: "Handle the request",
        description: "Root scope.",
        ontology: {
          allowedTools: ["search_objects", "compute_function", "message"],
          entities: [
            {
              id: "widget",
              properties: [
                { id: "widget-id", type: "id", primaryKey: true },
                { id: "price", type: "number", required: true },
              ],
            },
          ],
          objects: [{ entity: "widget", properties: { "widget-id": "WG-1", price: 40 } }],
        },
        children: [
          {
            id: "inherit.open",
            title: "Scope nothing",
            description: "A step that declares no tools of its own.",
          },
          {
            id: "inherit.narrow",
            title: "Narrow to replying",
            description: "A step that narrows within the root's list.",
            ontology: { allowedTools: ["message"] },
          },
        ],
      },
    };
    const importedInherited = importWorkflowTreeContent({
      content: JSON.stringify(inheritedTree),
      format: "json",
    });
    record(
      "an inherited-grants work-map imports cleanly",
      importedInherited.ok,
      importedInherited.ok ? INHERITED_TREE_ID : JSON.stringify(importedInherited.issues),
    );
    if (importedInherited.ok) {
      invalidateWorkflowTreeRegistry();
      const runId = "golden-inherited";
      const mediation = await beginEnterpriseRun({
        runId,
        prompt: "look at WG-1",
        routePlanner: async () => ({
          kind: "decided",
          treeId: INHERITED_TREE_ID,
          routes: [],
          rationale: "inherited",
        }),
      });
      expectEqual(
        "the run opens on the step that scopes nothing",
        getEnterpriseActiveRun(runId)?.plan.activeNodeId,
        "inherit.open",
      );
      expectEqual(
        "under inherited grants, a step that scopes nothing keeps the root's list",
        evaluateEnterpriseToolCall({ runId, toolName: "search_objects" })?.blocked ?? false,
        false,
      );
      expectEqual(
        "and is still bounded by it",
        evaluateEnterpriseToolCall({ runId, toolName: "exec" })?.requiresApproval ?? false,
        true,
      );
      // The precedence gloss is CONDITIONAL, so a work-map with only one retrieval
      // family pays no prompt bytes for a choice it never faces. This tree carries
      // objects and no corpus, which is the case the shipped example cannot show —
      // every route through it inherits a domain's knowledge grant.
      record(
        "a work-map with no knowledge source is not given the store-vs-corpus rule",
        !(mediation.kind === "mediated" ? mediation.promptSection : "").includes(
          "Prefer the object store",
        ),
        "objects only, so the ranking would be inert",
      );
      completeEnterpriseStep({ runId }); // advances to inherit.narrow
      expectEqual(
        "a step that narrows drops what it left out",
        evaluateEnterpriseToolCall({ runId, toolName: "search_objects" })?.requiresApproval ??
          false,
        true,
      );
      expectEqual(
        "and keeps what it named",
        evaluateEnterpriseToolCall({ runId, toolName: "message" })?.blocked ?? false,
        false,
      );
      endEnterpriseRun({ runId, status: "completed" });
    }
  }

  // ---- 14. A ROOT tool grant inherited by a step that grants none of its own.
  // Inline, because the shipped example's root deliberately grants no tools: the
  // ontology write opt-in is existential over the root→step path, so an
  // `invoke_action` there would hand write consent to all 30 steps.
  {
    const ROOT_GRANT_TREE_ID = "golden.root-grant";
    const rootGrantTree = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: ROOT_GRANT_TREE_ID,
      version: "1.0.0",
      name: "Root grant",
      description: "Explicit work-map whose root carries the grant its steps rely on.",
      match: { triggers: ["user"], priority: 80 },
      capabilityGrants: "explicit",
      root: {
        id: "grant",
        title: "Handle the request",
        description: "Root scope.",
        ontology: { allowedTools: ["knowledge_search"], skills: ["taskflow-inbox-triage"] },
        children: [
          {
            id: "grant.narrow",
            title: "Work within the root grant",
            description: "A step that attaches nothing of its own.",
            ontology: { skills: ["taskflow"] },
          },
        ],
      },
    };
    const importedRootGrant = importWorkflowTreeContent({
      content: JSON.stringify(rootGrantTree),
      format: "json",
    });
    record(
      "a root-grant work-map imports cleanly",
      importedRootGrant.ok,
      importedRootGrant.ok ? ROOT_GRANT_TREE_ID : JSON.stringify(importedRootGrant.issues),
    );
    if (importedRootGrant.ok) {
      invalidateWorkflowTreeRegistry();
      const runId = "golden-root-grant";
      await beginEnterpriseRun({
        runId,
        prompt: "handle this",
        // Registered but never attached: the point of the check below.
        config: { mcp: { servers: { "acme-tracker": { command: "npx" } } } },
        routePlanner: async () => ({
          kind: "decided",
          treeId: ROOT_GRANT_TREE_ID,
          routes: ["grant.narrow"],
          rationale: "root-grant",
        }),
      });
      expectEqual(
        "a tool the root grants is callable from a step that grants none of its own",
        evaluateEnterpriseToolCall({ runId, toolName: "knowledge_search" })?.blocked ?? false,
        false,
      );
      expectEqual(
        "a tool no step grants cannot just run, even though no list excludes it",
        evaluateEnterpriseToolCall({ runId, toolName: "exec" })?.requiresApproval ?? false,
        true,
      );
      expectEqual(
        "the skill catalog is the union of the path, root included",
        getEnterpriseActiveRun(runId)?.plan.grantedSkills,
        ["taskflow", "taskflow-inbox-triage"],
      );
      expectEqual(
        "explicit grants govern MCP even when the work-map attaches nothing",
        mcpVerdict(runId, "acme-tracker", "create_issue")?.blocked ?? false,
        true,
      );
      endEnterpriseRun({ runId, status: "completed" });
    }
  }

  // ---- 15. The CLI overlay resolves the PLUGIN half before attachments. A plugin
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
      match: { triggers: ["user"], priority: 90 },
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
        config: { mcp: { servers: { "my server": { command: "npx" } } } },
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
