/**
 * Pure workflow selection. A route names stopping points; each ancestor is an
 * executable prerequisite, and only explicitly selected branches execute.
 * Invalid routing blocks execution instead of guessing a business operation.
 */
import { z } from "zod";
import type { PlannableNode, PlannableTree } from "./types.js";

/** Alias kept for readability inside this module. */
type EnterpriseId = string;
type WorkflowNodeDefinition = PlannableNode;
type WorkflowTreeDefinition = PlannableTree;

/** Trees this small are cheaper to run whole than to ask a model about. */
const MIN_NODES_TO_PLAN = 2;
/**
 * Keep the candidate digest bounded: it is prompt-cache-sensitive prefix text.
 * One budget per line KIND, because the two carry different weight.
 *
 * A node line is one of many — a 40-node tree renders 40 of them — and it only
 * has to separate siblings the model already sees in context, so 120 chars is
 * enough and the total stays bounded.
 *
 * A tree line is one per candidate and is the ONLY thing that decides whether a
 * request enters that work-map at all. Since keywords retired, this description
 * IS the routing signal, so truncating it discards the domain cue authors write
 * it for — and they write it last, after the summary sentence, which is exactly
 * what a short budget cuts. A shipped work-map lost 298 of its 417 chars this
 * way, silently reverting the routing fix its description documents, along with
 * the clause claiming its own record lookups; a request phrased as `ls` then
 * escaped into the permissive default tree with exec wide open.
 * Bounded, not unbounded: a runaway description would still balloon the prefix.
 */
const SUMMARY_MAX_CHARS = 120;
const TREE_SUMMARY_MAX_CHARS = 600;

/**
 * What the injected planner must return. Outcomes are kept distinct because
 * selectWorkflowPlan treats each differently — collapsing any two of them either
 * drops requests out of governance or drags every request into a work-map:
 *
 * - `decided` — the model answered. `treeId: null` inside it is itself an answer
 *   ("no work-map applies") and is honored.
 * - `clarification` — the domain is known, but intent needs a user answer before
 *   any workflow steps or business tools may execute.
 * - `unavailable` — the planner could not be consulted AT ALL: no model is
 *   configured or authorized for it. That is a property of the install, not of
 *   the request, and no request can provoke it.
 * - `failed` — it WAS consulted and the transport or the answer was unusable.
 *   A crafted request can provoke this, so it must not read as an answer.
 */
export type WorkflowPlanDecision =
  | { kind: "decided"; treeId: string | null; routes: string[]; rationale?: string }
  | { kind: "clarification"; treeId: string; question: string }
  | { kind: "unavailable" }
  | { kind: "failed" };

export type WorkflowPlanner = (params: {
  /** Candidate trees, in the caller's deterministic order. */
  trees: readonly WorkflowTreeDefinition[];
  requestText: string;
  /** The candidates, already rendered. Planners should not re-derive them. */
  candidates: string;
  signal?: AbortSignal;
}) => Promise<WorkflowPlanDecision>;

export type EnterpriseRouteSelection = {
  /** Cut points the planner chose (node ids), empty when the whole tree runs. */
  routes: EnterpriseId[];
  /** Node ids to plan, or null to plan the whole tree. */
  nodeIds: ReadonlySet<EnterpriseId> | null;
  rationale: string;
  source: "planner" | "whole-tree";
  /** Route strings the planner returned that do not exist in the tree. */
  invalidRoutes: string[];
};

/** How the governing tree was chosen, recorded on the plan for audit. */
export type WorkflowTreeSource =
  /** The model picked it from the candidates. */
  | "planner"
  /** Only one tree could apply, so no model call was made. */
  | "only-candidate"
  /** The model judged that no work-map applies; the default tree governs. */
  | "no-match"
  /**
   * No planner could be consulted for this run at all. The default tree governs:
   * an install that can never plan would otherwise put EVERY request, including
   * unrelated ones, under whichever work-map sorts first — see selectWorkflowPlan.
   */
  | "unavailable"
  /**
   * A planner WAS consulted and answered unusably. A domain tree governs rather
   * than the permissive default — see selectWorkflowPlan.
   */
  | "fallback";

export type EnterpriseWorkflowSelection<
  TTree extends WorkflowTreeDefinition = WorkflowTreeDefinition,
> = {
  tree: TTree;
  treeSource: WorkflowTreeSource;
  /** Model text when the model chose; a fixed explanation otherwise. */
  treeRationale: string;
  route: EnterpriseRouteSelection;
  next:
    | { kind: "execute" }
    | { kind: "clarify"; question: string }
    | { kind: "blocked"; reason: string };
};

const planDecisionSchema = z.object({
  treeId: z.string().nullable(),
  routes: z.array(z.string()),
  rationale: z.string().optional(),
});

function shorten(text: string | undefined, maxChars = SUMMARY_MAX_CHARS): string {
  if (!text) {
    return "";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

function walk(
  node: WorkflowNodeDefinition,
  depth: number,
  visit: (node: WorkflowNodeDefinition, depth: number) => void,
): void {
  visit(node, depth);
  for (const child of node.children ?? []) {
    walk(child, depth + 1, visit);
  }
}

export function countTreeNodes(tree: WorkflowTreeDefinition): number {
  let count = 0;
  walk(tree.root, 0, () => {
    count += 1;
  });
  return count;
}

/**
 * Render one tree as an indented list of selectable routes. Only titles and a
 * short description go in: the ontology digest is what the RUN sees, and putting
 * it here would balloon the planning prompt for no selection signal.
 */
export function buildRouteCandidateDigest(tree: WorkflowTreeDefinition): string {
  const lines: string[] = [];
  walk(tree.root, 0, (node, depth) => {
    const summary = shorten(node.description);
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${node.id} — ${node.title}${summary ? `: ${summary}` : ""}`);
  });
  return lines.join("\n");
}

/**
 * Render every candidate tree for one prompt. The model needs each tree's nodes
 * in the same call it picks the tree, because picking a tree without seeing what
 * is inside it is a name-matching exercise — the failure mode this replaces.
 *
 * The tree description carries the domain cue that keywords used to carry, so it
 * has to be here: two work-maps can have equally generic names ("Operations")
 * and be told apart only by what their descriptions claim.
 */
export function buildPlanCandidateDigest(trees: readonly WorkflowTreeDefinition[]): string {
  return trees
    .map((tree) => {
      const summary = shorten(tree.description, TREE_SUMMARY_MAX_CHARS);
      return [
        `# ${tree.id} — ${tree.name}${summary ? `: ${summary}` : ""}`,
        buildRouteCandidateDigest(tree),
      ].join("\n");
    })
    .join("\n\n");
}

/** Select endpoints and all preceding steps, without implicit descendants. */
export function resolveRouteNodeIds(
  tree: WorkflowTreeDefinition,
  routes: readonly string[],
): { nodeIds: Set<EnterpriseId>; invalid: string[] } {
  const parentOf = new Map<string, string | null>();
  const byId = new Map<string, WorkflowNodeDefinition>();
  const collect = (node: WorkflowNodeDefinition, parentId: string | null) => {
    parentOf.set(node.id, parentId);
    byId.set(node.id, node);
    for (const child of node.children ?? []) {
      collect(child, node.id);
    }
  };
  collect(tree.root, null);

  const nodeIds = new Set<EnterpriseId>();
  const invalid: string[] = [];
  for (const raw of routes) {
    const route = raw.trim();
    const node = byId.get(route);
    if (!node) {
      invalid.push(raw);
      continue;
    }
    // Selecting an endpoint runs its predecessors, never unselected successors.
    nodeIds.add(node.id);
    // Parents are prerequisites and must execute before the selected endpoint.
    let parent = parentOf.get(route) ?? null;
    while (parent) {
      nodeIds.add(parent);
      parent = parentOf.get(parent) ?? null;
    }
  }
  return { nodeIds, invalid };
}

/** Whole-tree selection: the pre-planner behavior, and every route fallback. */
function wholeTree(rationale: string, invalidRoutes: string[] = []): EnterpriseRouteSelection {
  return { routes: [], nodeIds: null, rationale, source: "whole-tree", invalidRoutes };
}

/** Reject empty or partially invalid routes; no implicit execution fallback. */
function resolveRoute(
  tree: WorkflowTreeDefinition,
  routes: readonly string[],
  rationale: string | undefined,
): EnterpriseRouteSelection | null {
  const total = countTreeNodes(tree);
  const { nodeIds, invalid } = resolveRouteNodeIds(tree, routes);
  if (nodeIds.size === 0 || invalid.length > 0) {
    return null;
  }
  // A route set that covers the tree anyway is not a narrowing; report it as
  // whole-tree so the trace does not claim a selection that changed nothing.
  if (nodeIds.size === total) {
    return wholeTree(rationale?.trim() || "route planner selected the whole tree", invalid);
  }
  const valid = routes.filter((route) => !invalid.includes(route)).map((route) => route.trim());
  return {
    routes: valid,
    nodeIds,
    rationale: rationale?.trim() || `selected ${valid.join(", ")}`,
    source: "planner",
    invalidRoutes: invalid,
  };
}

function selectionWithoutModel<TTree extends WorkflowTreeDefinition>(
  tree: TTree,
  treeSource: WorkflowTreeSource,
  treeRationale: string,
  routeRationale: string,
): EnterpriseWorkflowSelection<TTree> {
  return {
    tree,
    treeSource,
    treeRationale,
    route: wholeTree(routeRationale),
    next:
      countTreeNodes(tree) > 1
        ? {
            kind: "blocked",
            reason: "This work-map needs a route planner before its steps can execute.",
          }
        : { kind: "execute" },
  };
}

/** Routing or policy preflight failed: return metadata but never execute steps. */
export function failClosedWorkflowSelection<TTree extends WorkflowTreeDefinition>(params: {
  trees: readonly TTree[];
  defaultTree: TTree;
  reason: string;
}): EnterpriseWorkflowSelection<TTree> {
  // Metadata only; a failed selection never opens an active run.
  const firstDomainTree = params.trees.find((tree) => tree.id !== params.defaultTree.id);
  return {
    ...selectionWithoutModel(
      firstDomainTree ?? params.defaultTree,
      "fallback",
      params.reason,
      "no steps executed",
    ),
    next: {
      kind: "blocked",
      reason:
        "Workflow routing failed. No workflow steps were executed. Retry or clarify the intended operation.",
    },
  };
}

/** Choose a work-map and explicit endpoints, or stop for clarification/failure. */
export async function selectWorkflowPlan<TTree extends WorkflowTreeDefinition>(params: {
  /** Candidate trees for this trigger, in deterministic order. */
  trees: readonly TTree[];
  /** The catch-all tree for this trigger; governs when no work-map applies. */
  defaultTree: TTree;
  requestText: string;
  planner?: WorkflowPlanner;
  signal?: AbortSignal;
}): Promise<EnterpriseWorkflowSelection<TTree>> {
  const domainTrees = params.trees.filter((tree) => tree.id !== params.defaultTree.id);
  // Nothing to decide: the default tree is the only thing that could govern.
  // Stock installs land here on every run and pay no model call for it.
  if (domainTrees.length === 0) {
    const only = params.trees[0] ?? params.defaultTree;
    if (!params.planner || countTreeNodes(only) < MIN_NODES_TO_PLAN) {
      return selectionWithoutModel(
        only,
        "only-candidate",
        "no work-map is installed for this trigger",
        !params.planner
          ? "no route planner configured"
          : `tree has ${countTreeNodes(only)} nodes; planning it is not worth a model call`,
      );
    }
  }
  /** No planner at all for this run: the default governs. See the header. */
  const unplanned = (reason: string): EnterpriseWorkflowSelection<TTree> =>
    selectionWithoutModel(
      params.defaultTree,
      "unavailable",
      reason,
      "the default tree has no route to plan",
    );

  if (!params.planner) {
    return unplanned("no workflow planner is wired for this runtime");
  }

  const byId = new Map(params.trees.map((tree) => [tree.id, tree]));
  /** A consulted planner that answered unusably must still be governed. */
  const failClosed = (reason: string): EnterpriseWorkflowSelection<TTree> =>
    failClosedWorkflowSelection({ trees: params.trees, defaultTree: params.defaultTree, reason });

  let decision: WorkflowPlanDecision;
  try {
    decision = await params.planner({
      trees: params.trees,
      requestText: params.requestText,
      candidates: buildPlanCandidateDigest(params.trees),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (err) {
    return failClosed(
      `workflow planner failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (decision.kind === "unavailable") {
    return unplanned("no workflow planner is configured for this run");
  }
  if (decision.kind === "failed") {
    return failClosed("workflow planner returned no decision");
  }
  if (decision.kind === "clarification") {
    const tree = byId.get(decision.treeId.trim());
    const question = decision.question.trim();
    if (!tree || !question || question.length > 1000) {
      return failClosed("workflow planner returned an invalid clarification");
    }
    return {
      ...selectionWithoutModel(tree, "planner", "request needs clarification", "no steps executed"),
      next: { kind: "clarify", question },
    };
  }

  const parsed = planDecisionSchema.safeParse(decision);
  if (!parsed.success) {
    return failClosed("workflow planner returned an unsupported shape");
  }

  // An explicit "none apply" is an ANSWER, not a failure: honor it.
  if (parsed.data.treeId === null) {
    return selectionWithoutModel(
      params.defaultTree,
      "no-match",
      parsed.data.rationale?.trim() || "no work-map applies to this request",
      "the default tree has no route to plan",
    );
  }

  const tree = byId.get(parsed.data.treeId.trim());
  if (!tree) {
    // A named tree that does not exist is the model answering unusably, which is
    // exactly the case a crafted request could provoke. Never read it as "none".
    return failClosed(`workflow planner named an unknown tree (${parsed.data.treeId})`);
  }

  const route = resolveRoute(tree, parsed.data.routes, parsed.data.rationale);
  if (!route) {
    return failClosed("workflow planner selected no valid complete route");
  }
  const treeRationale = parsed.data.rationale?.trim() || `selected ${tree.id}`;
  // The model call has already selected routes. Expanding a small tree here
  // would discard that choice and introduce unrelated steps and tool ceilings.
  return {
    tree,
    treeSource: "planner",
    treeRationale,
    route,
    next: { kind: "execute" },
  };
}
