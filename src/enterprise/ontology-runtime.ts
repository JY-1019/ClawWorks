import { findPlanNode } from "./plan.js";
import { getEnterpriseActiveRun } from "./runtime.js";
import type {
  EnterpriseId,
  OntologyAction,
  OntologyBinding,
  OntologyEntity,
  OntologyFunction,
  OntologyRelationship,
  WorkflowNodeDefinition,
  WorkflowTreeDefinition,
} from "./types.js";

export type NodeOntologyScope = {
  treeId: EnterpriseId;
  nodeId: EnterpriseId;
  /** Enforce mode blocks; observe mode records and lets the call through. */
  enforce: boolean;
  entities: Map<EnterpriseId, OntologyEntity>;
  relationships: Map<EnterpriseId, OntologyRelationship>;
  actions: Map<EnterpriseId, OntologyAction>;
  functions: Map<EnterpriseId, OntologyFunction>;
  /**
   * Required property ids per object type, gathered TREE-WIDE rather than along
   * the path.
   *
   * Objects are stored tree-wide, so a create from one branch must satisfy the
   * shape every branch declares: if a sibling marks a property required, an
   * object created without it violates its own type the moment that sibling reads
   * it. This is used ONLY to reject an incomplete create — never to read or return
   * a value — so it cannot leak a sibling's data.
   */
  treeRequiredProperties: Map<EnterpriseId, Set<string>>;
};

export type OntologyDeclarations = Pick<
  NodeOntologyScope,
  "entities" | "relationships" | "actions" | "functions"
>;

/** Collate declarations for a step or a whole-map catalog; callers choose the nodes. */
export function mergeOntologyDeclarations(
  nodes: readonly { ontology?: OntologyBinding }[],
): OntologyDeclarations {
  const scope: OntologyDeclarations = {
    entities: new Map(),
    relationships: new Map(),
    actions: new Map(),
    functions: new Map(),
  };
  for (const node of nodes) {
    for (const entity of node.ontology?.entities ?? []) {
      scope.entities.set(entity.id, mergeEntity(scope.entities.get(entity.id), entity));
    }
    for (const relationship of node.ontology?.relationships ?? []) {
      scope.relationships.set(relationship.id, relationship);
    }
    for (const action of node.ontology?.actions ?? []) {
      scope.actions.set(action.id, action);
    }
    for (const fn of node.ontology?.functions ?? []) {
      scope.functions.set(fn.id, fn);
    }
  }
  return scope;
}

export function resolveActiveOntologyScope(runId: string): NodeOntologyScope | null {
  const run = getEnterpriseActiveRun(runId);
  if (!run) {
    return null;
  }
  const node = findPlanNode(run.plan, run.plan.activeNodeId);
  if (!node) {
    return null;
  }
  const ontology = mergeOntologyDeclarations([node]);
  return {
    treeId: run.plan.treeId,
    nodeId: node.nodeId,
    enforce: run.plan.mode === "enforce",
    ...ontology,
    // Snapshotted when the run was mediated, from the tree it PLANNED against. A
    // per-call registry lookup would drift: a re-import mid-run invalidates the
    // registry, and the run would start judging creates against a tree version it
    // never planned or prompted against.
    treeRequiredProperties: run.treeRequiredProperties ?? new Map(),
  };
}

function mergeEntity(base: OntologyEntity | undefined, extension: OntologyEntity): OntologyEntity {
  if (!base) {
    return extension;
  }
  const properties = new Map((base.properties ?? []).map((property) => [property.id, property]));
  for (const property of extension.properties ?? []) {
    const existing = properties.get(property.id);
    if (!existing) {
      properties.set(property.id, property);
      continue;
    }
    properties.set(property.id, {
      ...existing,
      ...property,
      ...(existing.primaryKey || property.primaryKey ? { primaryKey: true } : {}),
      ...(existing.required || property.required ? { required: true } : {}),
    });
  }
  return {
    ...base,
    ...extension,
    ...(properties.size > 0 ? { properties: [...properties.values()] } : {}),
  };
}

/**
 * Does this run's tree declare an object graph at all?
 *
 * Enterprise mode is on by DEFAULT, and the stock built-in trees are deliberately
 * guidance-free — they exist to keep every run traced, not to model a domain. So
 * "the run is mediated" is not a reason to hand the model ontology tools: it would
 * add three useless tools to the stock tool list, which is exactly the prompt-byte
 * regression the built-ins are shaped to avoid.
 *
 * The plan is fixed for the run, so this is stable from tool construction to the
 * last turn — the model-visible tool list never changes mid-run.
 */
export function runDeclaresOntology(runId: string): boolean {
  const run = getEnterpriseActiveRun(runId);
  if (!run) {
    return false;
  }
  return run.plan.nodes.some(
    (node) =>
      (node.ontology.entities?.length ?? 0) > 0 || (node.ontology.functions?.length ?? 0) > 0,
  );
}

/**
 * Required property ids per object type, across the WHOLE TREE.
 *
 * Taken from the tree DEFINITION, not from plan.nodes: a routed run plans only the
 * nodes on its route, so a pruned sibling's `required` declaration would be
 * invisible — and an object created here without that property would violate its
 * own type the moment a future run on that sibling reads it.
 *
 * Captured once, when the run is mediated, and carried on the active run. Looking
 * it up per call would drift: a re-import mid-run invalidates the registry, and
 * the run would start judging creates against a tree it never planned against.
 */
export function collectTreeRequiredProperties(
  tree: WorkflowTreeDefinition,
): Map<EnterpriseId, Set<string>> {
  const required = new Map<EnterpriseId, Set<string>>();
  const walk = (node: WorkflowNodeDefinition): void => {
    for (const entity of node.ontology?.entities ?? []) {
      for (const property of entity.properties ?? []) {
        if (!property.required) {
          continue;
        }
        const existing = required.get(entity.id) ?? new Set<string>();
        existing.add(property.id);
        required.set(entity.id, existing);
      }
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(tree.root);
  return required;
}

/** The object type's identifying property, or null when it declares none. */
export function primaryKeyOf(entity: OntologyEntity): string | null {
  return entity.properties?.find((property) => property.primaryKey)?.id ?? null;
}

/**
 * A denial the model can act on: it names what it asked for and what it may
 * actually address here. A bare "not found" would read as "the data is missing"
 * and send the model looking for another way in, rather than telling it the type
 * is outside this step's contract.
 */
export function outOfScopeMessage(
  kind: "object type" | "link type" | "function" | "action",
  requested: string,
  available: Iterable<string>,
): string {
  const options = [...available].toSorted();
  return `${kind} "${requested}" is not in the ontology of this workflow step. Available ${kind}s: ${
    options.length > 0 ? options.join(", ") : "(none)"
  }`;
}
