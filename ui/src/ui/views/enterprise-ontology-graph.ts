// Pure ontology-graph collation for the enterprise inspector. Kept free of lit so
// both the view (rendering) and the controller (picking a default object type)
// can share it without a render↔controller import cycle.
import type {
  EnterpriseTreeDetail,
  EnterpriseTreeNode,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { OntologyEntity, OntologyRelationship } from "../components/ontology-graph.ts";

export type OntologyGraph = { entities: OntologyEntity[]; relationships: OntologyRelationship[] };

/**
 * Union every node's entities + relationships into one graph model. Parent and
 * child nodes often re-declare the same relationship, so edges dedupe by
 * endpoints+id; otherwise the graph would stack identical arcs.
 */
export function collectOntologyGraph(tree: EnterpriseTreeDetail): OntologyGraph {
  return mergeOntologyNodes(tree.nodes);
}

/** Nodes on the root→node path, ancestors first. Empty when the id is unknown. */
export function nodePathTo(tree: EnterpriseTreeDetail, nodeId: string): EnterpriseTreeNode[] {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const path: EnterpriseTreeNode[] = [];
  let current = byId.get(nodeId);
  // Bounded by the node count so a malformed parentId cycle cannot spin.
  while (current && path.length <= tree.nodes.length) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.toReversed();
}

/**
 * The ontology graph for ONE node's scope: its root→node path merged, the same
 * way governance merges the path. This is what an agent AT that node can address,
 * so the operator's node view mirrors the model's — the predictability story
 * P2/P3 built, made inspectable.
 */
export function collectNodeOntologyGraph(
  tree: EnterpriseTreeDetail,
  nodeId: string,
): OntologyGraph {
  return mergeOntologyNodes(nodePathTo(tree, nodeId));
}

/**
 * Object types on a node's scope that can carry INSTANCES, in stable path order.
 * Instance identity is a type's primaryKey value: the seeder skips a type with no
 * primaryKey and action writes reject one (src/enterprise/object-store.sqlite.ts,
 * ontology-actions.ts), so a type without a primaryKey can never have instances —
 * offering it a chip would only ever load "No objects". The view renders one chip
 * per id and the controller loads the first by default, so both must derive the
 * list the same way — hence this single helper.
 */
export function nodeObjectEntityIds(tree: EnterpriseTreeDetail, nodeId: string): string[] {
  return collectNodeOntologyGraph(tree, nodeId)
    .entities.filter((entity) => entity.properties?.some((property) => property.primaryKey))
    .map((entity) => entity.id);
}

/**
 * Object type ids a node's path actually DECLARES, in path order.
 *
 * Not `collectNodeOntologyGraph(...).entities`: that synthesizes an entity for a
 * relationship endpoint nothing declares, so a legacy work-map renders its links
 * completely. Useful for drawing, wrong for editing — offering a synthesized id
 * as a link endpoint produces a save the splicer rejects, because only declared
 * types are in scope.
 */
export function declaredNodePathEntityIds(tree: EnterpriseTreeDetail, nodeId: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const node of nodePathTo(tree, nodeId)) {
    for (const entity of node.ontology.entities ?? []) {
      if (!seen.has(entity.id)) {
        seen.add(entity.id);
        ids.push(entity.id);
      }
    }
  }
  return ids;
}

/**
 * Object types a declaration made at `nodeId` can address when it RUNS.
 *
 * The INTERSECTION across every executable leaf below this node, because the
 * declaration is inherited into all of them and `resolveActiveOntologyScope`
 * merges the path of whichever one is active. A type only one branch declares
 * therefore resolves on that branch and fails on the others, which is exactly
 * what the splicers refuse — offering it here would hand the operator a choice
 * guaranteed to come back `entity-not-found`.
 *
 * DECLARED ones only, matching `declaredNodePathEntityIds`: the graph
 * synthesizes endpoints for a legacy link that names an undeclared type, and
 * offering one would produce a save the splicer refuses.
 */
export function declaredExecutableEntityIds(tree: EnterpriseTreeDetail, nodeId: string): string[] {
  const subtree = new Set([nodeId]);
  // Parents precede children in the flat list, so one forward pass closes it.
  for (const candidate of tree.nodes) {
    if (candidate.parentId && subtree.has(candidate.parentId)) {
      subtree.add(candidate.id);
    }
  }
  const hasChildren = new Set(
    tree.nodes.map((candidate) => candidate.parentId).filter((id) => id !== null),
  );
  // A node with no children below it IS the leaf; that keeps a leaf step's own
  // picker working rather than collapsing to nothing.
  const leaves = [...subtree].filter((id) => !hasChildren.has(id));
  const perLeaf = (leaves.length > 0 ? leaves : [nodeId]).map(
    (id) =>
      new Set(
        nodePathTo(tree, id)
          .flatMap((node) => node.ontology.entities ?? [])
          .map((entity) => entity.id),
      ),
  );
  const [first, ...rest] = perLeaf;
  if (!first) {
    return [];
  }
  // Ordered by the first leaf's path — ancestors before its own declarations —
  // so the picker reads outside-in rather than in set order.
  return [...first].filter((id) => rest.every((scope) => scope.has(id)));
}

/**
 * Link type ids a declaration made at `nodeId` can relate over when it RUNS.
 *
 * The relationship mirror of `declaredExecutableEntityIds`, and the same
 * intersection for the same reason: a graph effect resolves against whichever
 * leaf is active, so a link type only one branch declares would come back
 * `relationship-not-found` on the others.
 */
export function declaredExecutableRelationshipIds(
  tree: EnterpriseTreeDetail,
  nodeId: string,
): string[] {
  const subtree = new Set([nodeId]);
  for (const candidate of tree.nodes) {
    if (candidate.parentId && subtree.has(candidate.parentId)) {
      subtree.add(candidate.id);
    }
  }
  const hasChildren = new Set(
    tree.nodes.map((candidate) => candidate.parentId).filter((id) => id !== null),
  );
  const leaves = [...subtree].filter((id) => !hasChildren.has(id));
  const perLeaf = (leaves.length > 0 ? leaves : [nodeId]).map(
    (id) =>
      new Set(
        nodePathTo(tree, id)
          .flatMap((node) => node.ontology.relationships ?? [])
          .map((relationship) => relationship.id),
      ),
  );
  const [first, ...rest] = perLeaf;
  if (!first) {
    return [];
  }
  return [...first].filter((id) => rest.every((scope) => scope.has(id)));
}

function mergeOntologyNodes(nodes: readonly EnterpriseTreeNode[]): OntologyGraph {
  const entityById = new Map<string, OntologyEntity>();
  const relationshipByKey = new Map<string, OntologyRelationship>();
  for (const node of nodes) {
    for (const entity of node.ontology.entities ?? []) {
      // An object type is tree-scoped: a deeper step may EXTEND it with more
      // properties (the schema allows exactly that, it only forbids
      // contradicting an existing field). So properties union across
      // declarations — keeping just the first array would hide fields a later
      // step declared. Scalars still take the first non-empty value.
      const merged = entityById.get(entity.id);
      const properties = [...(merged?.properties ?? [])];
      for (const property of entity.properties ?? []) {
        const index = properties.findIndex((existing) => existing.id === property.id);
        if (index < 0) {
          properties.push(property);
          continue;
        }
        // The same field re-declared: fold the two, do NOT keep only the first.
        // The schema lets a later declaration repeat a field (it only forbids a
        // conflicting type), and that later one may be where primaryKey or
        // required is finally marked — dropping it would hide the PK badge.
        const existing = properties[index];
        properties[index] = {
          id: existing.id,
          type: existing.type,
          primaryKey: existing.primaryKey || property.primaryKey,
          required: existing.required || property.required,
          description: existing.description ?? property.description,
        };
      }
      entityById.set(entity.id, {
        id: entity.id,
        title: merged?.title ?? entity.title,
        description: merged?.description ?? entity.description,
        properties: properties.length > 0 ? properties : undefined,
      });
    }
    for (const relationship of node.ontology.relationships ?? []) {
      // Link types are tree-scoped and may be re-declared: the schema lets a
      // deeper step fill in a cardinality or inverse the ancestor omitted (it
      // only forbids contradicting one). Keeping the first declaration outright
      // would render the bare ancestor link and drop that metadata.
      const key = JSON.stringify([relationship.from, relationship.to, relationship.id]);
      const merged = relationshipByKey.get(key);
      relationshipByKey.set(key, {
        id: relationship.id,
        from: relationship.from,
        to: relationship.to,
        cardinality: merged?.cardinality ?? relationship.cardinality,
        inverse: merged?.inverse ?? relationship.inverse,
        description: merged?.description ?? relationship.description,
      });
    }
  }
  const relationships = [...relationshipByKey.values()];
  // Link endpoints must exist as graph nodes even when the tree never declared
  // them as object types (older trees name endpoints they never repeat).
  for (const relationship of relationships) {
    for (const endpoint of [relationship.from, relationship.to]) {
      if (!entityById.has(endpoint)) {
        entityById.set(endpoint, { id: endpoint });
      }
    }
  }
  return { entities: [...entityById.values()], relationships };
}
