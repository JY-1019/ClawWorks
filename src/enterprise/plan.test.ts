import { describe, expect, it } from "vitest";
import {
  BUILTIN_ASSIST_TREE,
  BUILTIN_SUPPORT_EXAMPLE_TREE,
  BUILTIN_SYSTEM_TREE,
  BUILTIN_WORKFLOW_TREES,
} from "./builtin-trees.js";
import {
  buildEnterprisePromptSection,
  buildEnterpriseRunPlan,
  classifyWorkflowTrigger,
  collectWorkflowTreeCandidates,
  enterpriseStepSequence,
  firstUnfinishedStep,
  ontologyHasGuidance,
  planTracksSteps,
  resolvePlanNodePath,
} from "./plan.js";
import { validateWorkflowTreeDefinition } from "./schema.js";
import type { WorkflowTreeDefinition } from "./types.js";

const REFUND_TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "acme.refunds",
  version: "1.0.0",
  name: "Refund handling",
  match: { triggers: ["user"] },
  root: {
    id: "refunds",
    title: "Handle a refund request",
    ontology: {
      allowedTools: ["memory_search", "message"],
      constraints: [{ id: "policy", description: "Only refund within 30 days." }],
      contextHints: ["Refund window: 30 days."],
      expectedOutput: "Refund decision with rationale.",
    },
    children: [
      { id: "refunds.verify", title: "Verify the purchase" },
      { id: "refunds.decide", title: "Decide the refund" },
    ],
  },
};

describe("classifyWorkflowTrigger", () => {
  it("maps triggers onto tree trigger classes", () => {
    expect(classifyWorkflowTrigger({ trigger: "user" })).toBe("user");
    expect(classifyWorkflowTrigger({ trigger: "manual" })).toBe("user");
    expect(classifyWorkflowTrigger({})).toBe("user");
    expect(classifyWorkflowTrigger({ trigger: "cron" })).toBe("system");
    expect(classifyWorkflowTrigger({ trigger: "heartbeat" })).toBe("system");
    expect(classifyWorkflowTrigger({ trigger: "user", spawnedBy: "agent:main:x" })).toBe(
      "subagent",
    );
  });
});

describe("collectWorkflowTreeCandidates", () => {
  const trees = [BUILTIN_ASSIST_TREE, BUILTIN_SYSTEM_TREE, REFUND_TREE];

  it("offers every tree that serves the trigger, work-maps before the default", () => {
    const { candidates, defaultTree } = collectWorkflowTreeCandidates({ trigger: "user", trees });
    // Order is the contract the planner fails closed on: the first candidate is
    // the work-map it binds when the model cannot be trusted to choose.
    expect(candidates.map((tree) => tree.id)).toEqual(["acme.refunds", "clawworks.assist"]);
    expect(defaultTree.id).toBe("clawworks.assist");
  });

  it("keeps trigger classing deterministic: system runs never see user work-maps", () => {
    const { candidates, defaultTree } = collectWorkflowTreeCandidates({ trigger: "system", trees });
    expect(candidates.map((tree) => tree.id)).toEqual(["clawworks.system"]);
    expect(defaultTree.id).toBe("clawworks.system");
  });

  it("always offers the default, even when no tree declares the trigger", () => {
    const { candidates, defaultTree } = collectWorkflowTreeCandidates({
      trigger: "system",
      trees: [REFUND_TREE],
    });
    expect(candidates.map((tree) => tree.id)).toEqual(["clawworks.system"]);
    expect(defaultTree.id).toBe("clawworks.system");
  });

  it("uses an imported override of the default tree, not the static built-in", () => {
    const assistOverride: WorkflowTreeDefinition = {
      ...BUILTIN_ASSIST_TREE,
      version: "9.9.9",
    };
    const { defaultTree } = collectWorkflowTreeCandidates({
      trigger: "user",
      trees: [assistOverride, BUILTIN_SYSTEM_TREE],
    });
    // This is the seam an operator uses to make unmatched runs non-permissive.
    expect(defaultTree.version).toBe("9.9.9");
  });

  it("treats an empty trigger list like user-triggered (programmatic trees)", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      id: "acme.empty-triggers",
      match: { triggers: [] },
    };
    const { candidates } = collectWorkflowTreeCandidates({ trigger: "user", trees: [tree] });
    expect(candidates.map((candidate) => candidate.id)).toContain("acme.empty-triggers");
  });
});

describe("built-in support example tree", () => {
  it("is a valid, guidance-bearing multi-leaf tree with per-leaf ontology", () => {
    // Ships by default so the Enterprise UI has a rich tree to inspect and the route
    // planner has something to narrow. Guard the schema + the demo shape.
    expect(validateWorkflowTreeDefinition(BUILTIN_SUPPORT_EXAMPLE_TREE).ok).toBe(true);
    expect(BUILTIN_WORKFLOW_TREES).toContain(BUILTIN_SUPPORT_EXAMPLE_TREE);

    const plan = buildEnterpriseRunPlan({
      runId: "example",
      requestText: "resolve ticket #4471",
      mode: "enforce",
      tree: BUILTIN_SUPPORT_EXAMPLE_TREE,
      matchedBy: "planner",
    });
    expect(plan.treeId).toBe("clawworks.support");
    // More than one leaf (so a route can narrow) and every leaf carries its own
    // ontology guidance (so the planner engages and each node renders in the UI).
    // A plan with no route planner keeps the whole subtree, so leaves are derived
    // from the flattened nodes rather than from plan.route.
    const parentIds = new Set(plan.nodes.map((node) => node.parentId));
    const leaves = plan.nodes.filter((node) => !parentIds.has(node.nodeId));
    expect(leaves.length).toBeGreaterThan(1);
    expect(leaves.every((leaf) => ontologyHasGuidance(leaf.ontology))).toBe(true);
    expect(planTracksSteps(plan)).toBe(true);
  });
});

describe("buildEnterpriseRunPlan", () => {
  it("flattens the subtree depth-first and starts on the root scope", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-1",
      requestText: "please process my refund",
      mode: "enforce",
      tree: REFUND_TREE,
      matchedBy: "planner",
      now: 1000,
    });
    expect(plan.treeId).toBe("acme.refunds");
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([
      "refunds",
      "refunds.verify",
      "refunds.decide",
    ]);
    expect(plan.nodes.map((node) => node.seq)).toEqual([0, 1, 2]);
    expect(plan.nodes[1].parentId).toBe("refunds");
    // A step-tracking plan opens ON its first step: the cursor moves by tool call
    // now, so no runtime needs the root as a holding scope.
    expect(plan.activeNodeId).toBe("refunds.verify");
    expect(plan.createdAt).toBe(1000);
  });

  it("truncates and collapses whitespace in the request summary", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-2",
      requestText: `a  b\n\nc ${"x".repeat(600)}`,
      mode: "enforce",
      tree: BUILTIN_ASSIST_TREE,
      matchedBy: "only-candidate",
    });
    expect(plan.requestSummary.startsWith("a b c ")).toBe(true);
    expect(plan.requestSummary.length).toBeLessThanOrEqual(300);
    expect(plan.requestSummary.endsWith("…")).toBe(true);
  });
});

describe("buildEnterpriseRunPlan route pruning", () => {
  it("plans only the selected route and keeps its ancestors (the governance scope chain)", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Refunds",
        ontology: { deniedTools: ["exec"] },
        children: [
          {
            id: "refunds.intake",
            title: "Intake",
            children: [{ id: "refunds.intake.triage", title: "Triage" }],
          },
          {
            id: "refunds.payout",
            title: "Payout",
            children: [{ id: "refunds.payout.issue", title: "Issue payment" }],
          },
        ],
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-route",
      requestText: "refund",
      mode: "enforce",
      tree,
      matchedBy: "planner",
      route: {
        routes: ["refunds.payout"],
        nodeIds: new Set(["refunds", "refunds.payout", "refunds.payout.issue"]),
        rationale: "the request is about paying out",
        source: "planner",
        invalidRoutes: [],
      },
    });
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([
      "refunds",
      "refunds.payout",
      "refunds.payout.issue",
    ]);
    // The root is kept even though it was not the cut point: governance merges
    // every ancestor's ontology down the path, so dropping it would drop the
    // tool ceiling it declares.
    expect(plan.nodes[0].ontology.deniedTools).toEqual(["exec"]);
    // The cursor opens on the first step OF THE ROUTE, not the tree's first leaf.
    expect(plan.activeNodeId).toBe("refunds.payout.issue");
    expect(plan.route).toMatchObject({
      routes: ["refunds.payout"],
      source: "planner",
      selectedNodes: 3,
      totalNodes: 5,
    });
  });

  it("redacts secrets out of the planner's rationale before it is persisted", () => {
    // The rationale is model text echoing the request. It lands in plan_json, the
    // route.selected trace event, and the chat card — so it must be redacted like
    // requestSummary, or the trace becomes a new secret sink.
    const plan = buildEnterpriseRunPlan({
      runId: "run-redact",
      requestText: "refund",
      mode: "enforce",
      tree: REFUND_TREE,
      matchedBy: "planner",
      route: {
        routes: [],
        nodeIds: null,
        rationale: "the user pasted sk-ant-api03-SUPERSECRETVALUE0000000000 into the prompt",
        source: "whole-tree",
        invalidRoutes: [],
      },
    });
    expect(plan.route?.rationale).not.toContain("SUPERSECRETVALUE");
  });

  it("plans the whole tree when the route selection is whole-tree", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-whole",
      requestText: "refund",
      mode: "enforce",
      tree: REFUND_TREE,
      matchedBy: "planner",
      route: {
        routes: [],
        nodeIds: null,
        rationale: "planner unavailable",
        source: "whole-tree",
        invalidRoutes: [],
      },
    });
    expect(plan.route?.source).toBe("whole-tree");
    expect(plan.route?.selectedNodes).toBe(plan.route?.totalNodes);
  });

  it("ignores a route resolved against a different tree rather than planning nothing", () => {
    // Defensive: a stale/foreign node set must not produce an empty (ungoverned)
    // plan. Planning everything is the safe read.
    const plan = buildEnterpriseRunPlan({
      runId: "run-foreign",
      requestText: "refund",
      mode: "enforce",
      tree: REFUND_TREE,
      matchedBy: "planner",
      route: {
        routes: ["other.tree.node"],
        nodeIds: new Set(["other.tree.node"]),
        rationale: "stale",
        source: "planner",
        invalidRoutes: [],
      },
    });
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(plan.route?.source).toBe("whole-tree");
    expect(plan.route?.routes).toEqual([]);
  });
});

describe("firstUnfinishedStep", () => {
  const steps = ["a", "b", "c"];

  it("opens on the step after a contiguous completed prefix", () => {
    expect(firstUnfinishedStep(steps, ["a", "b"])).toBe("c");
  });

  it("ignores completions with an unfinished step before them", () => {
    // Advancement is sequential, so this means the route changed between the two
    // runs. Opening on "c" would skip "b" — governed work nobody ran.
    expect(firstUnfinishedStep(steps, ["b"])).toBeUndefined();
  });

  it("carries nothing over when the whole route finished", () => {
    // A route with no work left is a fresh start, not a resume onto a step that
    // does not exist.
    expect(firstUnfinishedStep(steps, ["a", "b", "c"])).toBeUndefined();
  });

  it("does not care what order the earlier run finished them in", () => {
    // A reordered work-map: the earlier run finished b then a. Both are done, so
    // opening on c skips no governed work — refusing would make an operator redo
    // it to satisfy bookkeeping.
    expect(firstUnfinishedStep(steps, ["b", "a"])).toBe("c");
  });

  it("carries nothing over when the earlier run finished nothing here", () => {
    expect(firstUnfinishedStep(steps, [])).toBeUndefined();
    expect(firstUnfinishedStep(steps, ["z"])).toBeUndefined();
  });
});

describe("buildEnterprisePromptSection", () => {
  it("returns an empty string for guidance-free built-in trees (prompt-neutral default)", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-3",
      requestText: "hello",
      mode: "enforce",
      tree: BUILTIN_ASSIST_TREE,
      matchedBy: "only-candidate",
    });
    expect(buildEnterprisePromptSection(plan)).toBe("");
  });

  it("tells a step-tracking run how to advance even when no node carries guidance", () => {
    // A tree tracked only by a node-scoped governance policy carries no ontology
    // guidance at all, so the digest used to come back empty. Since advancing is
    // now a tool call, an empty digest means the model is never told the tool
    // exists — and the run sits on step 1 forever with the very policy that made
    // it tracked permanently out of reach.
    const plan = buildEnterpriseRunPlan({
      runId: "run-policy-tracked",
      requestText: "go",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.bare",
        version: "1.0.0",
        name: "Bare",
        match: { triggers: ["user"] },
        root: {
          id: "bare",
          title: "Bare",
          children: [
            { id: "bare.one", title: "One" },
            { id: "bare.two", title: "Two" },
          ],
        },
      },
      matchedBy: "planner",
    });
    // Guidance-free: without the caller's answer this plan renders nothing.
    expect(buildEnterprisePromptSection(plan)).toBe("");
    const section = buildEnterprisePromptSection(plan, [], true);
    expect(section).toContain("complete_step");
    expect(section).toContain("[step 1 of 2 · id: bare.one]");
  });

  it("words advancement for observe mode without promising a denial", () => {
    // Observe records out-of-scope calls instead of blocking them, so promising
    // later-step denials would contradict the mode line and steer the model off
    // calls observe deliberately permits.
    const tree = {
      schema: "clawworks.workflow-tree" as const,
      schemaVersion: 1 as const,
      id: "acme.obs",
      version: "1.0.0",
      name: "Obs",
      match: { triggers: ["user" as const] },
      root: {
        id: "obs",
        title: "Obs",
        children: [
          { id: "obs.one", title: "One", ontology: { allowedTools: ["message"] } },
          { id: "obs.two", title: "Two", ontology: { allowedTools: ["read"] } },
        ],
      },
    };
    const observe = buildEnterprisePromptSection(
      buildEnterpriseRunPlan({
        runId: "run-obs",
        requestText: "go",
        mode: "observe",
        tree,
        matchedBy: "planner",
      }),
    );
    expect(observe).toContain("only applies once you reach it");
    expect(observe).not.toContain("stays denied");
    const enforce = buildEnterprisePromptSection(
      buildEnterpriseRunPlan({
        runId: "run-enf",
        requestText: "go",
        mode: "enforce",
        tree,
        matchedBy: "planner",
      }),
    );
    // Must agree with the gate: a later step's tool is approvable, not refused —
    // telling the model it is denied would stop it ever asking.
    expect(enforce).toContain("asks a human to approve that single call");
    expect(enforce).not.toContain("stays denied");
  });

  it("renders a step's declared skills and says what to do with them", () => {
    // Declaring a skill used to reach no runtime surface at all: the operator saw
    // it in the Control UI and the bundle carried it, but the model never heard
    // of it, so the declaration could not change a single turn.
    const plan = buildEnterpriseRunPlan({
      runId: "run-skills",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          ontology: { allowedTools: ["message", "read"] },
          children: [
            {
              id: "desk.triage",
              title: "Triage",
              // Unsorted on purpose: the rendered order must be stable for the
              // prompt cache regardless of authoring order.
              ontology: { skills: ["summarize", "taskflow-inbox-triage"] },
            },
          ],
        },
      },
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Skills: summarize, taskflow-inbox-triage");
    // Names alone read as trivia; the one-time gloss says what to do with them.
    expect(section).toContain("prefer it over improvising");
    // It must restate containment, since the model is being pointed at
    // instructions that could ask for a tool this step withholds.
    expect(section).toContain("never grant a tool the step's scope withholds");
    // And it must NOT order a load: loading means reading SKILL.md with `read`,
    // which a governed step's allowedTools routinely withholds — this step's does.
    expect(section).not.toMatch(/load (those|these) skills/i);
  });

  it("names a step's MCP servers and says they grant nothing elsewhere", () => {
    // MCP denies by default, so the model has to see both WHICH servers a step may
    // call and that the other steps may call none — otherwise it spends a turn
    // discovering the denial.
    const plan = buildEnterpriseRunPlan({
      runId: "run-mcp",
      requestText: "file an issue",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-mcp",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          children: [
            {
              id: "desk.file",
              title: "File",
              ontology: { mcpServers: ["github", "atlassian"] },
            },
          ],
        },
      },
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    // Sorted, like every other list in the digest, for prompt-cache stability.
    expect(section).toContain("MCP servers: atlassian, github");
    expect(section).toContain("only on the steps (or ancestors) that attach them");
  });

  it("carries tree denials on a tree that never mentions MCP", () => {
    // The launch-time ceiling reads this list for servers no attachment can grant —
    // a plugin's — and those trees have no reason to declare `mcpServers`. Keeping
    // the denials inside the attachment branch would leave that ceiling empty.
    const plan = buildEnterpriseRunPlan({
      runId: "run-denied-no-mcp",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-denied",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          ontology: { deniedTools: ["bundleProbe__*"] },
        },
      },
      matchedBy: "planner",
    });

    expect(plan.mcpGoverned).toBeUndefined();
    expect(plan.mcpDeniedTools).toEqual(["bundleProbe__*"]);
  });

  it("treats an explicit empty MCP list as opting in", () => {
    // `mcpServers: []` is an operator saying this step reaches no server. Reading
    // it as a legacy tree would leave every registered server callable instead.
    const plan = buildEnterpriseRunPlan({
      runId: "run-mcp-empty",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-mcp-empty",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: { id: "desk", title: "Handle a request", ontology: { mcpServers: [] } },
      },
      matchedBy: "planner",
    });

    expect(plan.mcpGoverned).toBe(true);
    expect(plan.mcpAttachments).toEqual([]);
  });

  it("keeps the MCP opt-in when a route prunes the step that declares it", () => {
    // The opt-in belongs to the work-map, not to the branch a run happens to take:
    // routing around the attachment must not switch deny-by-default off.
    const plan = buildEnterpriseRunPlan({
      runId: "run-mcp-route",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-mcp-route",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          children: [
            { id: "desk.triage", title: "Triage", ontology: { allowedTools: ["message"] } },
            { id: "desk.file", title: "File", ontology: { mcpServers: ["acme-tracker"] } },
          ],
        },
      },
      matchedBy: "planner",
      route: {
        routes: ["desk.triage"],
        nodeIds: new Set(["desk", "desk.triage"]),
        rationale: "triage",
        source: "planner",
        invalidRoutes: [],
      },
    });

    expect(plan.nodes.map((node) => node.nodeId)).toEqual(["desk", "desk.triage"]);
    // The RULE survives the pruning; the launchable set does not — a branch this
    // run will not enter must not hand its server to a native subprocess.
    expect(plan.mcpGoverned).toBe(true);
    expect(plan.mcpAttachments).toEqual([]);
  });

  it("still states the MCP rule when routing pruned every attachment", () => {
    // The rule is still enforced for the tools the model can see, so a silent
    // digest would cost it a turn discovering the denial.
    const plan = buildEnterpriseRunPlan({
      runId: "run-mcp-route-digest",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-mcp-digest",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          children: [
            { id: "desk.triage", title: "Triage" },
            { id: "desk.file", title: "File", ontology: { mcpServers: ["acme-tracker"] } },
          ],
        },
      },
      matchedBy: "planner",
      route: {
        routes: ["desk.triage"],
        nodeIds: new Set(["desk", "desk.triage"]),
        rationale: "triage",
        source: "planner",
        invalidRoutes: [],
      },
    });

    expect(buildEnterprisePromptSection(plan)).toContain(
      "only on the steps (or ancestors) that attach them",
    );
  });

  it("carries explicit capability grants, the skills they cover, and the MCP rule", () => {
    // One switch governs all three families: the plan records the mode, the skills
    // the ROUTED steps attach, and turns MCP deny-by-default on even though no step
    // named a server.
    const plan = buildEnterpriseRunPlan({
      runId: "run-explicit",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-explicit",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        capabilityGrants: "explicit",
        root: {
          id: "desk",
          title: "Handle a request",
          ontology: { allowedTools: ["message"], skills: ["desk-intake"] },
          children: [
            { id: "desk.triage", title: "Triage", ontology: { skills: ["ticket-triage"] } },
            { id: "desk.file", title: "File", ontology: { skills: ["filing-runbook"] } },
          ],
        },
      },
      matchedBy: "planner",
      route: {
        routes: ["desk.triage"],
        nodeIds: new Set(["desk", "desk.triage"]),
        rationale: "triage",
        source: "planner",
        invalidRoutes: [],
      },
    });

    expect(plan.capabilityGrants).toBe("explicit");
    // Routed steps only: a branch this run will not enter must not widen the
    // catalog the model is shown.
    expect(plan.grantedSkills).toEqual(["desk-intake", "ticket-triage"]);
    expect(plan.mcpGoverned).toBe(true);
    expect(plan.mcpAttachments).toEqual([]);
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("grants capabilities explicitly");
    // The digest must match what the gate actually does: an omission asks a human
    // rather than being refused, and the reply-and-read floor always holds. Telling
    // the model otherwise steers it away from calls the run would have allowed.
    expect(section).toContain("asks a human to approve that one call");
    // Scoped to TOOLS: a skill, MCP server or knowledge source a step omits is
    // simply unavailable, and telling the model to expect an approval for one
    // would have it wait on something that can never arrive.
    expect(section).toContain("do not wait on one");
    expect(section).toContain("a step that lists no tools still has those");
    // The floor is not unconditional: a step can still deny one by name.
    expect(section).toContain("unless a step's Denied tools line names them");
  });

  it("tells an observing run that nothing is blocked", () => {
    // Observe records without blocking, and knowledge retrieval stays whole
    // there — a digest claiming denial would make the model avoid work the run
    // would have allowed.
    const plan = buildEnterpriseRunPlan({
      runId: "run-explicit-observe",
      requestText: "triage",
      mode: "observe",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-explicit-observe",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        capabilityGrants: "explicit",
        root: { id: "desk", title: "Handle a request", ontology: { allowedTools: ["message"] } },
      },
      matchedBy: "planner",
    });

    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("records what falls outside that instead of blocking it");
    // ...while still naming the one family observe does NOT relax.
    expect(section).toContain("except for knowledge, which stays scoped");
    expect(section).not.toContain("Anything not listed is denied");
  });

  it("leaves a work-map without the switch unchanged", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-inherited",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-inherited",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          ontology: { allowedTools: ["message"], skills: ["desk-intake"] },
        },
      },
      matchedBy: "planner",
    });

    expect(plan.capabilityGrants).toBeUndefined();
    expect(plan.grantedSkills).toBeUndefined();
    expect(plan.mcpGoverned).toBeUndefined();
    expect(buildEnterprisePromptSection(plan)).not.toContain("grants capabilities explicitly");
  });

  it("adds no MCP wording to a workflow that attaches none", () => {
    // Prompt-cache parity: a work-map without attachments must keep the exact
    // bytes it had before the field existed.
    const plan = buildEnterpriseRunPlan({
      runId: "run-mcp-none",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-nomcp",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          children: [
            { id: "desk.triage", title: "Triage", ontology: { allowedTools: ["message"] } },
          ],
        },
      },
      matchedBy: "planner",
    });
    expect(buildEnterprisePromptSection(plan)).not.toContain("MCP");
  });

  it("names a step's skills even when its scope withholds read", () => {
    // Gating on `read` would guess: the embedded loop opens a SKILL.md with it,
    // a claude-cli run resolves natively through a plugin directory, and ACP
    // drops the digest entirely. The plan sees none of that, so a gate here
    // would silently drop declarations on the backends that do not need `read`.
    const plan = buildEnterpriseRunPlan({
      runId: "run-skills-noread",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-noread",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          ontology: { allowedTools: ["message"] },
          children: [
            {
              id: "desk.triage",
              title: "Triage",
              ontology: { allowedTools: ["message"], skills: ["summarize"] },
            },
          ],
        },
      },
      matchedBy: "planner",
    });
    expect(buildEnterprisePromptSection(plan)).toContain("Skills: summarize");
  });

  it("carries the declared skill's instructions in the digest", () => {
    // The point of the feature: the model gets the know-how itself, so it does
    // not have to open a SKILL.md the step's tool scope may forbid.
    const plan = buildEnterpriseRunPlan({
      runId: "run-skill-body",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-body",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          // No `read`: the instructions still arrive.
          ontology: { allowedTools: ["message"] },
          children: [
            {
              id: "desk.triage",
              title: "Triage",
              ontology: { allowedTools: ["message"], skills: ["triage-playbook"] },
            },
          ],
        },
      },
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan, [
      { name: "triage-playbook", instructions: "Always confirm the order id first." },
    ]);
    expect(section).toContain("Skills: triage-playbook");
    expect(section).toContain("Skill instructions for the steps above (triage-playbook):");
    expect(section).toContain("### triage-playbook");
    // No host path: mediation runs before sandbox prep, so a location rendered
    // here would be one a sandboxed run cannot use.
    expect(section).not.toContain("/skills/triage-playbook/SKILL.md");
    expect(section).toContain("Always confirm the order id first.");
    // With the text present there is nothing to open, so the gloss says follow
    // rather than sending the model to find it.
    expect(section).toContain("are at the end of this section");
    expect(section).toContain("never grant a tool the step's scope withholds");
  });

  it("falls back to naming the skill when no instructions came with the run", () => {
    // A run with no skills snapshot (or an agent without the skill) must still
    // show the declaration, just without promising text that is not there.
    const plan = buildEnterpriseRunPlan({
      runId: "run-skill-nobody",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.desk-nobody",
        version: "1.0.0",
        name: "Desk",
        match: { triggers: ["user"] },
        root: {
          id: "desk",
          title: "Handle a request",
          ontology: { allowedTools: ["message"] },
          children: [
            {
              id: "desk.triage",
              title: "Triage",
              ontology: { skills: ["triage-playbook"] },
            },
          ],
        },
      },
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Skills: triage-playbook");
    expect(section).not.toContain("Skill instructions for the steps above");
    expect(section).toContain("prefer it over improvising");
  });

  it("keeps the prompt unchanged for a workflow that declares no skills", () => {
    // The skills instruction is conditional: a tree without skills must not gain
    // prompt bytes, or every existing workflow's cached prefix is invalidated.
    const plan = buildEnterpriseRunPlan({
      runId: "run-noskills",
      requestText: "refund",
      mode: "enforce",
      tree: REFUND_TREE,
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).not.toContain("Skills:");
    expect(section).not.toContain("load those skills");
  });

  it("renders the ids the ontology tools take as arguments", () => {
    // Without these the model has the tools but no vocabulary for them: it cannot
    // know this step addresses a "claim", that it links to a "policy", or that a
    // "band" exists to compute — so it would have to guess ids and read back
    // errors. Ids and shapes only; the VALUES are fetched with search_objects.
    const plan = buildEnterpriseRunPlan({
      runId: "run-onto",
      requestText: "triage",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.claims",
        version: "1.0.0",
        name: "Claims",
        match: { triggers: ["user"], priority: 50 },
        root: {
          id: "claims",
          title: "Handle a claim",
          ontology: {
            entities: [
              {
                id: "claim",
                properties: [
                  { id: "claim-id", type: "id", primaryKey: true },
                  { id: "fraud-score", type: "number" },
                ],
              },
              { id: "policy", properties: [{ id: "policy-id", type: "id", primaryKey: true }] },
            ],
            relationships: [
              {
                id: "claim-against-policy",
                from: "claim",
                to: "policy",
                cardinality: "many-to-one",
              },
            ],
            functions: [
              {
                id: "band",
                entity: "claim",
                expression: "$fraud-score >= 80 ? 'refer' : 'auto'",
                returns: "string",
              },
            ],
          },
          children: [{ id: "claims.triage", title: "Triage" }],
        },
      },
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Object types:");
    // The primaryKey is starred: it is the id every other tool takes.
    expect(section).toContain("- claim (claim-id*, fraud-score)");
    expect(section).toContain("Link types:");
    expect(section).toContain("- claim-against-policy: claim -> policy (many-to-one)");
    expect(section).toContain("Derived values:");
    expect(section).toContain("- band: over claim, returns string");
    // Ids and shapes, not values: the object graph lives in the store.
    expect(section).not.toContain("fraud-score >= 80");
    // Tool availability is a RUNTIME fact (opt-in tools; CLI loopback builds tools
    // with no runId at all), while this digest is built from the plan alone. Naming
    // the tools would tell the model to call something the run may never have got.
    expect(section).not.toContain("search_objects");
    expect(section).not.toContain("get_neighbors");
    expect(section).not.toContain("compute_function");
  });

  it("never names a tool in the digest, whatever the tree declares", () => {
    // Tool availability is decided by the RUNTIME, not the tree. A compat tree may
    // declare relationships without ever declaring their endpoint types under
    // `entities` (the schema allows it) and gets no ontology tools at all.
    const plan = buildEnterpriseRunPlan({
      runId: "run-compat",
      requestText: "x",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.compat",
        version: "1.0.0",
        name: "Compat",
        match: { triggers: ["user"], priority: 50 },
        root: {
          id: "compat",
          title: "Compat step",
          ontology: {
            relationships: [{ id: "a-b", from: "a", to: "b" }],
            expectedOutput: "Something.",
          },
          children: [{ id: "compat.leaf", title: "Leaf" }],
        },
      },
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Expected output: Something.");
    // Describing the tree's link types is fine; NAMING a tool is not. This tree
    // gets no ontology tools at all, so an instruction to call one would be a lie.
    expect(section).toContain("Link types:");
    expect(section).not.toContain("get_neighbors");
    expect(section).not.toContain("search_objects");
    expect(section).not.toContain("compute_function");
  });

  it("renders a compact digest for guidance-bearing ontologies", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-4",
      requestText: "refund please",
      mode: "enforce",
      tree: REFUND_TREE,
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("## Enterprise workflow");
    expect(section).toContain('workflow "Refund handling" (acme.refunds@1.0.0)');
    expect(section).toContain("0. Handle a refund request");
    expect(section).toContain("1. Verify the purchase");
    expect(section).toContain("- Only refund within 30 days.");
    expect(section).toContain("- Refund window: 30 days.");
    expect(section).toContain("Allowed tools: memory_search, message");
    expect(section).toContain("Expected output: Refund decision with rationale.");
  });

  it("renders guidance for every step even in large trees (no step-count cap)", () => {
    // 20 leaves; only the last carries scope. Governance still advances into
    // and enforces it, so its rule must appear in the digest.
    const children = Array.from({ length: 20 }, (_, index) => ({
      id: `big.step${index}`,
      title: `Step ${index}`,
      ...(index === 19 ? { ontology: { deniedTools: ["exec"] } } : {}),
    }));
    const tree: WorkflowTreeDefinition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.big",
      version: "1.0.0",
      name: "Big",
      match: { keywords: ["big"], triggers: ["user"] },
      root: { id: "big", title: "Big flow", children },
    };
    const section = buildEnterprisePromptSection(planFor(tree, "big"));
    // The 20th leaf (flattened seq 20) and its rule must both appear.
    expect(section).toContain("20. Step 19");
    expect(section).toContain("Denied tools: exec");
  });

  it("renders guidance for every step, including leaves the run advances into", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        // Root carries no guidance; a leaf does. The digest must still render so
        // the model sees the leaf rule governance will enforce after advancing.
        children: [
          {
            id: "refunds.verify",
            title: "Verify the purchase",
            ontology: {
              allowedTools: ["memory_search"],
              constraints: [{ id: "receipt", description: "Require a receipt id." }],
            },
          },
          { id: "refunds.decide", title: "Decide the refund" },
        ],
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-leaf",
      requestText: "refund please",
      mode: "enforce",
      tree,
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("1. Verify the purchase");
    expect(section).toContain("- Require a receipt id.");
    expect(section).toContain("Allowed tools: memory_search");
  });

  it("renders knowledge sources when the ontology declares them", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: { knowledgeFoundations: ["acme.support-kb", "acme.policy-kb"] },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-6",
      requestText: "refund",
      mode: "enforce",
      tree,
      matchedBy: "planner",
    });
    expect(buildEnterprisePromptSection(plan)).toContain(
      "Knowledge sources: acme.policy-kb, acme.support-kb",
    );
  });

  it("renders free-form step guidance as an advisory instruction line", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: { guidance: "Confirm the order id before issuing a refund." },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-7",
      requestText: "refund",
      mode: "enforce",
      tree,
      matchedBy: "planner",
    });
    expect(buildEnterprisePromptSection(plan)).toContain(
      "Instructions: Confirm the order id before issuing a refund.",
    );
  });

  it("renders action preconditions and write effects (the model must see them before it acts)", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: {
          entities: [{ id: "payment" }, { id: "claim" }],
          actions: [
            {
              id: "issue-payment",
              description: "Settle an approved claim",
              tools: ["memory_search"],
              parameters: [
                { id: "claim-id", type: "id", required: true },
                { id: "amount", type: "number" },
              ],
              preconditions: ["The claim must already be approved."],
              effects: [
                { entity: "payment", kind: "create" },
                { entity: "claim", kind: "update" },
                { entity: "claim", kind: "read" },
              ],
            },
          ],
        },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-effects",
      requestText: "refund",
      mode: "enforce",
      tree,
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("requires: The claim must already be approved.");
    // The model cannot call the action without knowing what it must gather.
    expect(section).toContain("params: claim-id (id, required), amount (number)");
    // Writes are called out; a read-only effect is not a warning and is omitted.
    expect(section).toContain("writes: create payment, update claim");
    expect(section).not.toContain("read claim");
  });

  it("renders action guidance when actions are the only ontology content", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: {
          actions: [
            { id: "lookup-order", description: "Find the purchase", tools: ["memory_search"] },
            { id: "notify" },
          ],
        },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-5",
      requestText: "refund",
      mode: "enforce",
      tree,
      matchedBy: "planner",
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Actions:");
    expect(section).toContain("- lookup-order: Find the purchase — tools: memory_search");
    expect(section).toContain("- notify");
  });
});

const NESTED_TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "acme.ops",
  version: "1.0.0",
  name: "Operations",
  match: { keywords: ["deploy"], triggers: ["user"] },
  root: {
    id: "ops",
    title: "Run an operation",
    ontology: { allowedTools: ["memory_search", "message"] },
    children: [
      {
        id: "ops.phase",
        title: "Execution phase",
        ontology: { deniedTools: ["message"] },
        children: [
          { id: "ops.phase.a", title: "Step A" },
          { id: "ops.phase.b", title: "Step B" },
        ],
      },
      { id: "ops.wrap", title: "Wrap up" },
    ],
  },
};

function planFor(tree: WorkflowTreeDefinition, keywords = "deploy") {
  return buildEnterpriseRunPlan({
    runId: "run-path",
    requestText: keywords,
    mode: "enforce",
    tree,
    matchedBy: "planner",
  });
}

describe("resolvePlanNodePath", () => {
  it("returns the root→node chain inclusive", () => {
    const plan = planFor(NESTED_TREE);
    expect(resolvePlanNodePath(plan, "ops.phase.b").map((node) => node.nodeId)).toEqual([
      "ops",
      "ops.phase",
      "ops.phase.b",
    ]);
  });

  it("returns just the root for the root node and [] for a missing node", () => {
    const plan = planFor(NESTED_TREE);
    expect(resolvePlanNodePath(plan, "ops").map((node) => node.nodeId)).toEqual(["ops"]);
    expect(resolvePlanNodePath(plan, "nope")).toEqual([]);
  });
});

describe("enterpriseStepSequence", () => {
  it("lists the depth-first leaves, skipping interior parents", () => {
    const plan = planFor(NESTED_TREE);
    expect(enterpriseStepSequence(plan)).toEqual(["ops.phase.a", "ops.phase.b", "ops.wrap"]);
  });

  it("yields a single-step sequence for a childless root", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-single",
      requestText: "hello",
      mode: "enforce",
      tree: {
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.single",
        version: "1.0.0",
        name: "Single",
        match: { keywords: ["hello"], triggers: ["user"] },
        root: { id: "solo", title: "Do it", ontology: { allowedTools: ["message"] } },
      },
      matchedBy: "planner",
    });
    expect(enterpriseStepSequence(plan)).toEqual(["solo"]);
  });
});

describe("ontologyHasGuidance / planTracksSteps", () => {
  it("flags ontologies that carry model-facing guidance", () => {
    expect(ontologyHasGuidance({})).toBe(false);
    expect(ontologyHasGuidance({ audit: true })).toBe(false);
    expect(ontologyHasGuidance({ allowedTools: ["message"] })).toBe(true);
    expect(ontologyHasGuidance({ expectedOutput: "a summary" })).toBe(true);
    // A node whose only guidance is a `guidance` field must still count, or the
    // step loop never advances into it and its digest stays empty.
    expect(ontologyHasGuidance({ guidance: "confirm the order id first" })).toBe(true);
    // Same for a skills-only node: without this the step loop never enters it, so
    // the declaration could not reach a turn no matter what the digest renders.
    expect(ontologyHasGuidance({ skills: ["taskflow-inbox-triage"] })).toBe(true);
    expect(ontologyHasGuidance({ skills: [] })).toBe(false);
  });

  it("tracks steps only for governed trees with a leaf to advance into", () => {
    expect(planTracksSteps(planFor(NESTED_TREE))).toBe(true);
    expect(planTracksSteps(planFor(REFUND_TREE, "refund"))).toBe(true);
    // Guidance-free built-in trees stay step-quiet (stock path adds no writes).
    expect(planTracksSteps(planFor(BUILTIN_ASSIST_TREE, "hello"))).toBe(false);
  });

  it("tracks a root with a single guidance-bearing leaf step", () => {
    const tree: WorkflowTreeDefinition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.approval",
      version: "1.0.0",
      name: "Approval",
      match: { keywords: ["approve"], triggers: ["user"] },
      root: {
        id: "approval",
        title: "Approval flow",
        children: [
          {
            id: "approval.act",
            title: "Act",
            ontology: { deniedTools: ["exec"] },
          },
        ],
      },
    };
    // The lone leaf carries scope the hook must enter to enforce, so the run
    // must track even though there is nothing to advance between.
    expect(planTracksSteps(planFor(tree, "approve"))).toBe(true);
  });
});
