/**
 * Workflow candidate collection and per-run plan construction.
 *
 * Trees advertise the trigger classes they serve, which is filtered here and
 * stays deterministic. WHICH of the surviving trees governs a request is a
 * semantic judgement made by @openclaw/enterprise-planner, not a match hint:
 * keyword matching used to decide it and failed both ways — a request phrased
 * without a tree's keywords escaped its governance, and an unrelated request
 * that happened to contain one was locked into it.
 */
import { createHash } from "node:crypto";
import { countTreeNodes, type EnterpriseRouteSelection } from "@openclaw/enterprise-planner";
import { redactSecrets } from "../logging/redact.js";
import { BUILTIN_ASSIST_TREE, BUILTIN_SYSTEM_TREE } from "./builtin-trees.js";
import type { ResolvedSkillInstructions } from "./skill-instructions.js";
import type {
  EnterpriseRoutePlan,
  EnterpriseMode,
  EnterprisePlanNode,
  EnterpriseRunPlan,
  OntologyBinding,
  WorkflowNodeDefinition,
  WorkflowTreeDefinition,
  WorkflowTreeTrigger,
} from "./types.js";
import { WORKFLOW_STEP_ADVANCE_TOOL } from "./workflow-control.js";

const REQUEST_SUMMARY_MAX_CHARS = 300;
const DIGEST_MAX_HINT_LINES = 8;

/** Map an embedded run trigger + spawn lineage onto tree trigger classes. */
export function classifyWorkflowTrigger(params: {
  trigger?: string;
  spawnedBy?: string | null;
}): WorkflowTreeTrigger {
  if (params.spawnedBy) {
    return "subagent";
  }
  switch (params.trigger) {
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "system";
    default:
      return "user";
  }
}

export type WorkflowTreeCandidates = {
  /**
   * Trees that could govern this trigger, ordered work-maps first (priority
   * desc, then id) with the catch-all default last. The order is the contract
   * the planner package fails closed on: it binds the FIRST candidate when the
   * model cannot be trusted to choose.
   */
  candidates: readonly WorkflowTreeDefinition[];
  /** The catch-all for this trigger; governs when no work-map applies. */
  defaultTree: WorkflowTreeDefinition;
};

/**
 * Collect the trees a request could bind to.
 *
 * Trigger classing stays DETERMINISTIC and is not the model's to decide: a cron
 * or heartbeat run must never bind a user-facing work-map, whatever its text
 * says. Within a trigger class the choice is semantic, so this returns every
 * candidate and lets the planner pick (see selectWorkflowPlan).
 *
 * The default is resolved from the provided list first, so an imported tree that
 * reuses the built-in id keeps governing runs no work-map claims — that is the
 * seam an operator uses to make unmatched runs non-permissive.
 */
export function collectWorkflowTreeCandidates(params: {
  trigger: WorkflowTreeTrigger;
  trees: readonly WorkflowTreeDefinition[];
}): WorkflowTreeCandidates {
  const builtinDefault = params.trigger === "system" ? BUILTIN_SYSTEM_TREE : BUILTIN_ASSIST_TREE;
  const defaultTree = params.trees.find((tree) => tree.id === builtinDefault.id) ?? builtinDefault;
  const matching = params.trees.filter((tree) => {
    // Omitted or empty trigger lists mean user-triggered (the schema rejects
    // empty arrays; this also covers programmatically-built trees).
    const triggers = tree.match?.triggers?.length ? tree.match.triggers : ["user"];
    return triggers.includes(params.trigger);
  });
  const candidates = matching.toSorted((left, right) => {
    const byPriority = (right.match?.priority ?? 0) - (left.match?.priority ?? 0);
    return byPriority !== 0 ? byPriority : left.id.localeCompare(right.id);
  });
  // The default must always be selectable, even when it declares no trigger that
  // matches (or was dropped from the registry): enterprise mode never leaves a
  // run without a bound tree.
  if (!candidates.some((tree) => tree.id === defaultTree.id)) {
    candidates.push(defaultTree);
  }
  return { candidates, defaultTree };
}

/**
 * Flatten the subtree depth-first. When `keep` is given, only those nodes are
 * planned — the route. `keep` always contains a selected node's ancestors, so a
 * skipped node can never have a kept descendant and pruning its branch is safe.
 *
 * Depth-first is also the run's EXECUTION order, and deliberately so: the planner
 * picks WHICH leaves the run visits, the tree owns the order it visits them in.
 * Honoring a planner-chosen order instead was tried and reverted — it let the
 * model-facing digest (tree order) disagree with enforcement (planner order).
 */
function flattenPlanNodes(
  root: WorkflowNodeDefinition,
  keep?: ReadonlySet<string>,
): EnterprisePlanNode[] {
  const nodes: EnterprisePlanNode[] = [];
  const visit = (node: WorkflowNodeDefinition, parentId: string | null) => {
    if (keep && !keep.has(node.id)) {
      return;
    }
    nodes.push({
      nodeId: node.id,
      parentId,
      seq: nodes.length,
      title: node.title,
      ...(node.description !== undefined ? { description: node.description } : {}),
      ontology: node.ontology ?? {},
    });
    for (const child of node.children ?? []) {
      visit(child, node.id);
    }
  };
  visit(root, null);
  return nodes;
}

const MODEL_TEXT_MAX_CHARS = 300;

/**
 * Redact + bound text the MODEL produced about the request (route rationales,
 * hallucinated route strings). It is persisted to the trace and rendered in the
 * UI, so it gets the same redaction as the request summary — a rationale that
 * quotes the prompt back would otherwise smuggle a secret into the trace.
 */
export function summarizeModelText(text: string): string {
  const redacted = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (redacted.length <= MODEL_TEXT_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, MODEL_TEXT_MAX_CHARS - 1)}…`;
}

function summarizeRequestText(requestText: string): string {
  const redacted = redactSecrets(requestText).replace(/\s+/g, " ").trim();
  if (redacted.length <= REQUEST_SUMMARY_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, REQUEST_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * Stable content hash of a tree definition. Keys are sorted so an equivalent
 * definition always hashes the same regardless of authoring order.
 */
export function hashWorkflowTree(tree: WorkflowTreeDefinition): string {
  const canonical = JSON.stringify(tree, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .toSorted()
          .map((key) => [key, record[key]]),
      );
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build the prepared execution plan for one enterprise-mode run.
 *
 * The governing tree is passed IN, never re-derived here: selection is a model
 * judgement now, so a second derivation could disagree with the one the run was
 * governed and prompted against.
 */
export function buildEnterpriseRunPlan(params: {
  runId: string;
  requestText: string;
  mode: Exclude<EnterpriseMode, "off">;
  /** The governing tree, already chosen. */
  tree: WorkflowTreeDefinition;
  /** How it was chosen; recorded on the plan for audit. */
  matchedBy: EnterpriseRunPlan["matchedBy"];
  /** Why it was chosen. Model text when the model chose, so it is redacted. */
  treeRationale?: string;
  /** Route through the chosen tree. Omit to plan the whole subtree. */
  route?: EnterpriseRouteSelection;
  now?: number;
}): EnterpriseRunPlan {
  const tree = params.tree;
  const totalNodes = countTreeNodes(tree);
  const capabilityGrants = tree.capabilityGrants;
  // Read from the DEFINITION, before the route prunes anything: the opt-in belongs
  // to the work-map, not to whichever branch this run happens to take.
  // Explicit grants imply it: a work-map that grants only what it attaches must not
  // reach every registered server just because it attached none.
  const mcpGoverned = capabilityGrants === "explicit" || treeDeclaresMcpAttachment(tree.root);
  // Denials are read definition-wide (a rule from any branch should withhold), but
  // ATTACHMENTS come from the routed nodes below: a branch this run will not enter
  // must not hand its server to a subprocess that has no per-step gate.
  // Tree-wide, and not only for MCP-governed trees: the launch-time MCP check
  // honors these for plugin-supplied servers too, which no attachment can grant.
  const mcpDeniedTools = collectTreeOntologyList(tree.root, "deniedTools");
  // A route resolved against a DIFFERENT tree cannot prune this one; ignoring it
  // is the safe read (plan everything) rather than planning an empty run.
  const routeNodeIds =
    params.route?.nodeIds && params.route.nodeIds.has(tree.root.id)
      ? params.route.nodeIds
      : undefined;
  const nodes = flattenPlanNodes(tree.root, routeNodeIds);
  // Where the cursor starts. A step-tracking plan opens ON its first step rather
  // than on the root: advancing is a tool call now (complete_step), not a
  // property of one runtime's loop shape, so every mediated runtime can walk the
  // route and none of them needs the root as a holding scope. A plan with no
  // steps to track keeps the root, which is the only scope it will ever have.
  const stepIds = leafNodeIds(nodes);
  const firstNodeId = nodes[0].nodeId;
  const activeNodeId = nodesTrackSteps(nodes) ? (stepIds[0] ?? firstNodeId) : firstNodeId;
  const route: EnterpriseRoutePlan | undefined = params.route
    ? {
        // Route ids are safe: they were resolved against the tree, so they can
        // only be node ids the definition already contains.
        routes: routeNodeIds ? [...params.route.routes] : [],
        // The rationale and any hallucinated route strings are MODEL TEXT echoing
        // the request, so they get the same treatment as requestSummary. Without
        // this the trace, the plan row, and the chat card become a new sink for
        // whatever secret the user pasted into the prompt.
        rationale: summarizeModelText(params.route.rationale),
        source: routeNodeIds ? params.route.source : "whole-tree",
        selectedNodes: nodes.length,
        totalNodes,
        ...(params.route.invalidRoutes.length > 0
          ? { invalidRoutes: params.route.invalidRoutes.map(summarizeModelText) }
          : {}),
      }
    : undefined;
  return {
    runId: params.runId,
    treeId: tree.id,
    treeVersion: tree.version,
    treeName: tree.name,
    matchedBy: params.matchedBy,
    // Model text about the request, so it gets the same redaction as the route
    // rationale: it is persisted to the trace and rendered to operators.
    ...(params.treeRationale ? { treeRationale: summarizeModelText(params.treeRationale) } : {}),
    treeHash: hashWorkflowTree(tree),
    requestSummary: summarizeRequestText(params.requestText),
    nodes,
    ...(route ? { route } : {}),
    activeNodeId,
    ...(mcpGoverned
      ? {
          mcpGoverned: true,
          mcpAttachments: [
            ...new Set(nodes.flatMap((node) => node.ontology.mcpServers ?? [])),
          ].toSorted((a, b) => a.localeCompare(b)),
        }
      : {}),
    // Outside that branch: the launch-time ceiling honors denials for servers no
    // attachment can grant — a plugin's — and those trees never mention MCP.
    ...(mcpDeniedTools.length > 0 ? { mcpDeniedTools } : {}),
    ...(capabilityGrants
      ? {
          capabilityGrants,
          // Routed nodes, like the MCP attachments: a branch this run will not
          // enter must not widen the catalog the model is shown.
          grantedSkills: [...new Set(nodes.flatMap((node) => node.ontology.skills ?? []))].toSorted(
            (a, b) => a.localeCompare(b),
          ),
        }
      : {}),
    mode: params.mode,
    createdAt: params.now ?? Date.now(),
  };
}

/** One ontology list, gathered across the whole definition. Pre-pruning. */
function collectTreeOntologyList(
  node: WorkflowNodeDefinition,
  field: "mcpServers" | "deniedTools",
): string[] {
  const values = new Set<string>(node.ontology?.[field] ?? []);
  for (const child of node.children ?? []) {
    for (const value of collectTreeOntologyList(child, field)) {
      values.add(value);
    }
  }
  return [...values].toSorted((a, b) => a.localeCompare(b));
}

/** Does any node in the definition attach an MCP server? Pre-pruning opt-in. */
function treeDeclaresMcpAttachment(node: WorkflowNodeDefinition): boolean {
  // PRESENCE, not length: `mcpServers: []` is an operator saying "this step
  // reaches no MCP server", and reading it as a legacy tree would leave every
  // registered server callable — the exact opposite. Compatibility only covers a
  // tree where the property is absent.
  return (
    node.ontology?.mcpServers !== undefined ||
    (node.children ?? []).some((child) => treeDeclaresMcpAttachment(child))
  );
}

export function findPlanNode(
  plan: EnterpriseRunPlan,
  nodeId: string,
): EnterprisePlanNode | undefined {
  return plan.nodes.find((node) => node.nodeId === nodeId);
}

/**
 * Ancestor chain from the subtree root down to `nodeId` (inclusive). Governance
 * evaluates the tool call against every node on this path so a deeper step
 * cannot escape the scope its ancestors declared. Returns [] when the node is
 * missing. The walk is bounded by the node count so a malformed parentId chain
 * can never spin.
 */
export function resolvePlanNodePath(plan: EnterpriseRunPlan, nodeId: string): EnterprisePlanNode[] {
  const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  const path: EnterprisePlanNode[] = [];
  let current = byId.get(nodeId);
  while (current && path.length <= plan.nodes.length) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.toReversed();
}

/**
 * Ordered node ids the run steps through: the depth-first leaf nodes. Interior
 * nodes only provide inherited scope, so the cursor visits leaves (concrete
 * work). A childless root is itself the single leaf/step.
 */
function leafNodeIds(nodes: readonly EnterprisePlanNode[]): string[] {
  const parentIds = new Set(
    nodes.map((node) => node.parentId).filter((id): id is string => id !== null),
  );
  return nodes.filter((node) => !parentIds.has(node.nodeId)).map((node) => node.nodeId);
}

export function enterpriseStepSequence(plan: EnterpriseRunPlan): string[] {
  return leafNodeIds(plan.nodes);
}

/**
 * The step a resumed run should open on: the first one of THIS route that the
 * earlier execution did not finish.
 *
 * The prefix must be contiguous IN THIS ROUTE'S ORDER. Advancement is sequential
 * (completeEnterpriseStep never skips), so a finished step with an unfinished one
 * before it means the route changed between the two runs — a step was inserted,
 * or the earlier run walked a different branch. Opening past that gap would
 * silently skip governed work; stopping at it re-runs a step already done, which
 * the trace shows and a human can read.
 *
 * The order the steps were FINISHED in does not matter, only which ones were:
 * a reordered work-map whose earlier run finished b then a has still done both,
 * and refusing to carry that forward would make an operator redo governed work to
 * satisfy a bookkeeping detail. What is checked is that nothing unfinished sits
 * ahead of where this run would open.
 *
 * Returns undefined when nothing carries over (no prefix matched) and when the
 * whole route is finished — a route with no work left is a fresh start, not a
 * resume onto a step that does not exist.
 */
export function firstUnfinishedStep(
  steps: readonly string[],
  completedNodeIds: readonly string[],
): string | undefined {
  const completed = new Set(completedNodeIds);
  let index = 0;
  while (index < steps.length && completed.has(steps[index])) {
    index += 1;
  }
  return index === 0 ? undefined : steps[index];
}

/** True when an ontology carries model-facing guidance (digest is non-empty). */
export function ontologyHasGuidance(ontology: OntologyBinding): boolean {
  return Boolean(
    ontology.constraints?.length ||
    ontology.contextHints?.length ||
    ontology.guidance ||
    // A step whose ONLY binding is `skills` still has something to tell the
    // model. Omitting it here would leave that node guidance-free, so the step
    // loop would never advance into it and the declaration could never reach a
    // turn — the same footgun the object-graph checks below guard against.
    ontology.skills?.length ||
    ontology.allowedTools?.length ||
    ontology.deniedTools?.length ||
    ontology.actions?.length ||
    ontology.knowledgeFoundations?.length ||
    // Attaching an MCP server is the only way a step reaches it, so a node whose
    // ONLY binding is that attachment must still count as guided — otherwise the
    // step loop never advances into it and the grant can never take effect.
    ontology.mcpServers?.length ||
    ontology.expectedOutput ||
    // The object graph is guidance too. Without these, a tree whose ONLY guidance
    // is its ontology reads as guidance-free: the step loop never advances past
    // the root, so every ontology tool call resolves the root scope and rejects
    // the leaf's own object types for the entire run.
    ontology.entities?.length ||
    ontology.relationships?.length ||
    ontology.functions?.length ||
    ontology.objects?.length ||
    ontology.links?.length,
  );
}

/**
 * Whether a run should advance and trace per-node steps. Only governed trees
 * qualify: the root must have sub-steps (a leaf distinct from the root the
 * cursor enters and enforces — true whenever the plan has more than the root
 * node) and some node must carry guidance or opt into auditing.
 * Guidance-free built-in runs stay step-quiet so the stock path adds no per-run
 * trace writes (slice 1).
 *
 * `description` counts. It is the field the GUI's add-child flow writes and the
 * one an operator reaches for first, so omitting it left a hand-authored node
 * unable to make its own tree step-tracking — the declaration was accepted and
 * then silently never entered.
 */
function nodesTrackSteps(nodes: readonly EnterprisePlanNode[]): boolean {
  if (nodes.length <= 1) {
    return false;
  }
  return nodes.some(
    (node) =>
      ontologyHasGuidance(node.ontology) ||
      node.ontology.audit === true ||
      Boolean(node.description),
  );
}

export function planTracksSteps(plan: EnterpriseRunPlan): boolean {
  return nodesTrackSteps(plan.nodes);
}

/*
 * NOT gated on whether the step could open the skill.
 *
 * That looks tempting — loading a skill means reading its SKILL.md, so a step
 * without `read` seems unable to use one — but it is not knowable here and is
 * wrong for at least one shipped backend. `claude-cli` runs supply skills through
 * Claude's own `--plugin-dir` resolver rather than the OpenClaw `read` tool
 * (src/agents/cli-runner/prepare.ts), embedded runs can narrow tools again at the
 * attempt layer, and ACP discards this digest entirely. The plan carries none of
 * that, so any gate here guesses — and a wrong guess silently withholds a
 * declaration the operator wrote.
 *
 * So the line states the dependency and nothing more. It is a preference, not a
 * load order, which keeps the cost of an unopenable skill bounded to the base
 * prompt's own "if none clearly apply, read none".
 */

/** Append one node's ontology guidance to the digest, indented under its step. */
function appendOntologyGuidance(lines: string[], ontology: OntologyBinding, indent: string): void {
  // The step's addressable ontology: the ids its tools take as arguments. Without
  // these the model has the tools but no vocabulary for them — it cannot know this
  // step addresses a "claim", that a claim links to a "policy", or that a
  // "claim-triage-band" exists to compute, so it would guess ids and read back
  // errors.
  //
  // Deliberately does NOT name the tools. Tool availability is a RUNTIME fact
  // (these are opt-in enterprise tools, and a CLI loopback path builds tools with
  // no runId at all), while this digest is built from the plan alone. Naming them
  // here would tell the model to call something the run may never have been given;
  // the tools introduce themselves through their own descriptions.
  //
  // Ids and shapes only. The VALUES live in the store and are fetched with a tool;
  // restating them here would be the prompt-stuffing this slice exists to replace.
  if (ontology.entities?.length) {
    lines.push(`${indent}Object types:`);
    for (const entity of ontology.entities.slice(0, DIGEST_MAX_HINT_LINES)) {
      const properties = (entity.properties ?? []).map(
        (property) => `${property.id}${property.primaryKey ? "*" : ""}`,
      );
      lines.push(
        `${indent}- ${entity.id}${properties.length ? ` (${properties.join(", ")})` : ""}`,
      );
    }
  }
  if (ontology.relationships?.length) {
    lines.push(`${indent}Link types:`);
    for (const relationship of ontology.relationships.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(
        `${indent}- ${relationship.id}: ${relationship.from} -> ${relationship.to}${
          relationship.cardinality ? ` (${relationship.cardinality})` : ""
        }`,
      );
    }
  }
  if (ontology.functions?.length) {
    lines.push(`${indent}Derived values:`);
    for (const fn of ontology.functions.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(
        `${indent}- ${fn.id}: over ${fn.entity}, returns ${fn.returns}${
          fn.description ? ` — ${fn.description}` : ""
        }`,
      );
    }
  }
  if (ontology.actions?.length) {
    lines.push(`${indent}Actions:`);
    for (const action of ontology.actions.slice(0, DIGEST_MAX_HINT_LINES)) {
      // Effects are the action's write scope. The model has to know it is about
      // to create/update an object type before it calls the tool, not after
      // governance blocks it. Reads are omitted: they carry no such warning.
      const writes = (action.effects ?? [])
        .filter((effect) => effect.kind !== "read")
        .map((effect) => `${effect.kind} ${effect.entity}`);
      // Parameters are what the model must actually gather before it can call
      // the action, so the declaration is only useful if it reaches the prompt.
      const parameters = (action.parameters ?? []).map(
        (parameter) =>
          `${parameter.id} (${parameter.type}${parameter.required ? ", required" : ""})`,
      );
      const detail = [
        action.description,
        action.tools?.length ? `tools: ${action.tools.toSorted().join(", ")}` : undefined,
        parameters.length ? `params: ${parameters.join(", ")}` : undefined,
        writes.length ? `writes: ${writes.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" — ");
      lines.push(`${indent}- ${action.id}${detail ? `: ${detail}` : ""}`);
      // Preconditions gate the action, so they must reach the model before it
      // acts. Accepting the field without rendering it would make it decorative.
      for (const precondition of action.preconditions?.slice(0, DIGEST_MAX_HINT_LINES) ?? []) {
        lines.push(`${indent}  requires: ${precondition}`);
      }
    }
  }
  if (ontology.constraints?.length) {
    lines.push(`${indent}Constraints:`);
    for (const constraint of ontology.constraints.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(`${indent}- ${constraint.description}`);
    }
  }
  if (ontology.contextHints?.length) {
    lines.push(`${indent}Context:`);
    for (const hint of ontology.contextHints.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(`${indent}- ${hint}`);
    }
  }
  // Advisory only: guidance teaches how to work; it never widens the step's tool
  // scope or overrides governance (enforcement wins on conflict).
  if (ontology.guidance) {
    lines.push(`${indent}Instructions: ${ontology.guidance}`);
  }
  // Same advisory lane as `guidance`: naming a skill points the model at know-how
  // it depends on, it does not install or authorize anything. Names only here —
  // the instructions themselves are inlined once at the end, so two steps naming
  // the same skill do not pay for it twice. Sorted for prompt-cache stability.
  if (ontology.skills?.length) {
    lines.push(`${indent}Skills: ${ontology.skills.toSorted().join(", ")}`);
  }
  if (ontology.allowedTools?.length) {
    lines.push(`${indent}Allowed tools: ${ontology.allowedTools.toSorted().join(", ")}`);
  }
  if (ontology.deniedTools?.length) {
    lines.push(`${indent}Denied tools: ${ontology.deniedTools.toSorted().join(", ")}`);
  }
  if (ontology.knowledgeFoundations?.length) {
    // Ids only: which foundation covers what is a RUNTIME fact (the descriptor
    // from the live registry), and this digest is built from the plan alone. The
    // human-readable routing labels live in the `knowledge_search` tool
    // description, which is assembled after runtime plugins register.
    lines.push(
      `${indent}Knowledge sources: ${ontology.knowledgeFoundations.toSorted().join(", ")}`,
    );
  }
  if (ontology.mcpServers?.length) {
    // Named, not glossed per step: MCP is denied unless attached, so the model
    // has to see WHICH servers this step may reach. Sorted for prompt-cache
    // stability, like the lists above.
    lines.push(`${indent}MCP servers: ${ontology.mcpServers.toSorted().join(", ")}`);
  }
  if (ontology.expectedOutput) {
    lines.push(`${indent}Expected output: ${ontology.expectedOutput}`);
  }
}

/**
 * Per-run system prompt section describing the whole bound workflow. The run
 * advances through steps at execution time and governance enforces each step's
 * ontology, so the model must see every step's guidance up front — otherwise a
 * later step's denial or approval fires for instructions it never received.
 * Returns an empty string when no node carries guidance so the built-in
 * permissive trees add zero prompt bytes (prompt-cache/back-compat).
 */
export function buildEnterprisePromptSection(
  plan: EnterpriseRunPlan,
  /**
   * SKILL.md bodies for the skills the plan declares, already intersected with
   * what the agent has (see resolveEnterpriseSkillInstructions). Empty when the
   * caller had no skills snapshot — the digest then names the skills without
   * carrying them.
   */
  skillInstructions: readonly ResolvedSkillInstructions[] = [],
  /**
   * Whether the RUN advances steps. Passed in rather than derived, because a
   * node-scoped governance policy can make a guidance-free tree step-tracking and
   * the plan alone cannot see the policies. It must agree with the predicate that
   * decides tool exposure (enterpriseRunTracksSteps), or the model is told to
   * call a tool it was never given — or given one it was never told about.
   */
  tracksSteps: boolean = planTracksSteps(plan),
): string {
  // A governed work-map always says so, even when the route it took pruned away
  // every attachment: deny-by-default still applies to the tools the model can
  // see, and a silent rule costs it a turn discovering the denial.
  //
  // A step-tracking run always says so too, whatever its nodes declare. Without
  // this a description-only tree, or one tracked solely by a node-scoped policy,
  // would render nothing — and since advancing is now a tool call, a model that
  // is never told about the tool leaves the run on step 1 forever, with every
  // later step's scope and policies out of reach.
  if (
    !tracksSteps &&
    plan.mcpGoverned !== true &&
    !plan.nodes.some((node) => ontologyHasGuidance(node.ontology))
  ) {
    return "";
  }
  const lines: string[] = [
    "## Enterprise workflow",
    `This run is governed by workflow "${plan.treeName}" (${plan.treeId}@${plan.treeVersion}). Work the steps in order and respect each step's constraints and tool scope.`,
  ];
  // One-time gloss for a step's `Skills:` line, added only when some step
  // declares one — conditional so a workflow without skills keeps the exact
  // prompt bytes it had before (prompt cache, stock parity).
  //
  // Which sentence depends on whether any instructions came with the run. When
  // some did there is nothing to open for those — they are below. The wording
  // stays true under PARTIAL resolution (a declared skill the agent lacks, or one
  // the size budget dropped, is still named on its step but has no body): it
  // points at what is actually included rather than promising every name has
  // text. With none resolved the line is a pointer and nothing more, because an
  // instruction to load would be unexecutable on a step that withholds `read`.
  const declaresSkills = plan.nodes.some((node) => node.ontology.skills?.length);
  if (declaresSkills) {
    lines.push(
      skillInstructions.length > 0
        ? "A step's Skills line names the know-how that step depends on. The instructions that came with this run are at the end of this section — follow the ones for the step you are working. Paths they mention are relative to that skill's own directory. They teach how to do the work; they never grant a tool the step's scope withholds."
        : "A step's Skills line names the know-how that step depends on: when one of them applies and is available to you, prefer it over improvising. Skills teach how to do the work; they never grant a tool the step's scope withholds.",
    );
  }
  // Both retrieval families in scope on one run, so the model has to CHOOSE. Say
  // which wins, once: the object store answers from typed records with a primary
  // key, so its answer is exact and checkable, while retrieval returns prose that
  // happens to mention a value. Asked "what is this order's total", a model with
  // both will often reach for the handbook and quote a policy number instead of
  // the record's own field — a wrong answer that reads as a sourced one.
  //
  // Conditional on both being present: a run with only one of them needs no rule,
  // and the gloss would cost prompt bytes for a choice it never faces.
  const declaresObjectTypes = plan.nodes.some(
    (node) => node.ontology.entities?.length || node.ontology.functions?.length,
  );
  const declaresKnowledge = plan.nodes.some((node) => node.ontology.knowledgeFoundations?.length);
  if (declaresObjectTypes && declaresKnowledge) {
    lines.push(
      "This workflow carries both an object store and knowledge sources. Prefer the object store: any fact about a named record — its fields, its links, a derived value — comes from the ontology tools, because those return the stored value rather than a passage that mentions one. Use knowledge sources for what is written down rather than stored: policy, thresholds, wording, and when a human must decide. When a request needs both, read the record first and let the policy judge it; never answer a question about a specific record from a knowledge passage, and never state a policy from an object's field.",
    );
  }
  // MCP is the one scope that denies by default, so say it once: without this the
  // model reads an attachment as decoration and tries a server from a step that
  // never got one, spending a turn on a denial. Conditional like the skills gloss
  // so a workflow with no attachment keeps its exact prompt bytes.
  if (plan.mcpGoverned === true) {
    lines.push(
      "A step's MCP servers line names the servers that step may call. MCP tools are available only on the steps (or ancestors) that attach them; on any other step they are denied.",
    );
  }
  // Explicit grants change what SILENCE means — a step with no Tools line reaches
  // no tool at all — so the model has to be told once. Without it a step that
  // grants nothing reads as unrestricted and every call spends a turn on a denial.
  if (plan.capabilityGrants === "explicit") {
    lines.push(
      plan.mode === "enforce"
        ? "This workflow grants capabilities explicitly: each step lists the tools, skills, MCP servers, and knowledge sources it is meant to use, on it or on a step above it. A skill, MCP server or knowledge source a step does not list is simply not available to it — do not wait on one. An unlisted TOOL is usually different: calling it asks a human to approve that one call, so prefer what the step lists and expect a wait if you go outside it. Two exceptions are refused outright rather than asked about — an ontology action from a step that does not opt into writes, and an MCP server no step on your path attached. Replying and reading (message, read, memory_search) stay available unless a step's Denied tools line names them or a governance policy denies them; a step that lists no tools still has those."
        : // Observe records decisions without blocking, so the deny-by-default
          // half is not in force. A step's own knowledge list still scopes
          // retrieval here, as it does in every mode — promising otherwise would
          // have the model ask for a foundation the tool then refuses.
          "This workflow grants capabilities explicitly: each step names the tools, skills, MCP servers, and knowledge sources it is meant to use. This run records what falls outside that instead of blocking it, except for knowledge, which stays scoped to what each step names.",
    );
  }
  // Only the leaves are executed; interior nodes lend their scope to the steps
  // beneath them. The model needs to tell the two apart to know what it is being
  // asked to do, and it needs the node ID because that is the name complete_step
  // takes and the name every denial, trace event and operator screen uses. One
  // vocabulary across prompt, cursor and UI — see enterpriseStepSequence.
  const stepOrdinals = new Map(
    enterpriseStepSequence(plan).map((nodeId, index) => [nodeId, index + 1] as const),
  );
  if (tracksSteps) {
    // Observe mode records what falls outside a step's scope instead of blocking
    // it, so promising a denial there would contradict the mode line above and
    // steer the model away from calls observe deliberately permits. What is true
    // in BOTH modes is that the run stays on this step until the tool is called.
    const laterStepScope =
      plan.mode === "enforce"
        ? "a tool granted only on a later step is not yours yet — calling an ordinary one before you get there asks a human to approve that single call, while the two exceptions above stay refused"
        : "a later step's scope only applies once you reach it";
    // Where this run actually opens. Saying "step 1" while the cursor sits on
    // step 3 is the one thing that would make a resumed run redo finished work.
    const openingOrdinal = stepOrdinals.get(plan.activeNodeId) ?? 1;
    lines.push(
      `This run walks ${stepOrdinals.size} step${stepOrdinals.size === 1 ? "" : "s"} in the order below, starting on step ${openingOrdinal}. Call ${WORKFLOW_STEP_ADVANCE_TOOL} when a step's work is actually done — that call is the only thing that advances the run, so ${laterStepScope}. Do not call it merely because you replied.`,
    );
  }
  lines.push("Steps:");
  // Render every step: governance advances into and enforces each one, so a
  // later step must not have its rules omitted (only per-category hint lists are
  // bounded). Trees are operator-authored, so total size stays reasonable.
  for (const node of plan.nodes) {
    const ordinal = stepOrdinals.get(node.nodeId);
    // Scope containers are labelled too, so a node with no marker reads as
    // deliberate rather than as a rendering gap.
    const marker = ordinal
      ? ` [step ${ordinal} of ${stepOrdinals.size} · id: ${node.nodeId}]`
      : " [scope only]";
    lines.push(
      `${node.seq}. ${node.title}${node.description ? ` — ${node.description}` : ""}${marker}`,
    );
    appendOntologyGuidance(lines, node.ontology, "   ");
  }
  // The instructions themselves, once, after the steps that name them. Kept out
  // of the per-step blocks so a skill two steps depend on is not duplicated, and
  // last so the workflow structure is read first.
  if (skillInstructions.length > 0) {
    // Named explicitly so a partially resolved set is self-describing: the model
    // can see which declarations have text here and which only have a name.
    lines.push(
      "",
      `Skill instructions for the steps above (${skillInstructions.map((skill) => skill.name).join(", ")}):`,
    );
    for (const skill of skillInstructions) {
      lines.push(`### ${skill.name}`, skill.instructions);
    }
  }
  return lines.join("\n");
}
