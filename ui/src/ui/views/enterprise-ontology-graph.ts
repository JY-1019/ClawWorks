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

/** The ontology declared by this executable step; predecessors grant no scope. */
export function collectNodeOntologyGraph(
  tree: EnterpriseTreeDetail,
  nodeId: string,
): OntologyGraph {
  return mergeOntologyNodes(
    tree.nodes.filter((node) => node.id === nodeId),
    "node-scope",
  );
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
 * Object type ids this step declares, in declaration order.
 *
 * Not `collectNodeOntologyGraph(...).entities`: that synthesizes an entity for a
 * relationship endpoint nothing declares, so a legacy work-map renders its links
 * completely. Useful for drawing, wrong for editing — offering a synthesized id
 * as a link endpoint produces a save the splicer rejects, because only declared
 * types are in scope.
 */
export function declaredNodeEntityIds(tree: EnterpriseTreeDetail, nodeId: string): string[] {
  const node = tree.nodes.find((candidate) => candidate.id === nodeId);
  return [...new Set((node?.ontology.entities ?? []).map((entity) => entity.id))];
}

function mergeOntologyNodes(
  nodes: readonly EnterpriseTreeNode[],
  relationshipMode: "tree-union" | "node-scope" = "tree-union",
): OntologyGraph {
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
      if (relationshipMode === "node-scope") {
        // Step scope keys relationships by id, matching the runtime resolver.
        relationshipByKey.set(relationship.id, relationship);
        continue;
      }
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
