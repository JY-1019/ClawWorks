// Pure helpers for the operator "add child node" affordance. They operate on the
// parsed nested WorkflowTreeDefinition — what enterprise.trees.export serializes
// and enterprise.trees.import consumes — so creating a node stays a splice-then-
// reimport over the ONE existing write path, with no node-level gateway method.

import {
  ontologyExpressionProperties,
  parseOntologyExpression,
} from "../../../../src/enterprise/ontology-expression.js";

// Dotted lowercase segments, mirroring ENTERPRISE_ID_PATTERN in
// src/enterprise/schema.ts (the import validator rejects anything else). Kept in
// sync by hand: if the core pattern widens, widen here too or valid ids get
// refused in the form before they ever reach the server. Node ids and knowledge
// foundation ids share this contract.
const ENTERPRISE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

/** A node in the nested definition. Unknown fields (ontology) pass through. */
export interface EditableTreeNode {
  id: string;
  title: string;
  description?: string;
  ontology?: unknown;
  children?: EditableTreeNode[];
}

/** The nested definition envelope; non-root keys (schema/id/version/...) pass through. */
export interface EditableTreeDefinition {
  root: EditableTreeNode;
  [key: string]: unknown;
}

/** Every node id in the tree (root + descendants), for uniqueness checks. */
export function collectDefinitionNodeIds(definition: EditableTreeDefinition): Set<string> {
  const ids = new Set<string>();
  const walk = (node: EditableTreeNode): void => {
    ids.add(node.id);
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(definition.root);
  return ids;
}

export type NodeIdIssue = "empty" | "pattern" | "duplicate";

/**
 * Validate a proposed node id against the import contract: non-empty, dotted-
 * lowercase shape, and tree-wide uniqueness (src/enterprise/schema.ts rejects an
 * id that fails any of these). Returns the failing reason, or null when accepted.
 */
export function newNodeIdIssue(id: string, existingIds: ReadonlySet<string>): NodeIdIssue | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if (!ENTERPRISE_ID_PATTERN.test(trimmed)) {
    return "pattern";
  }
  if (existingIds.has(trimmed)) {
    return "duplicate";
  }
  return null;
}

export type InsertChildResult =
  | { ok: true; definition: EditableTreeDefinition }
  | { ok: false; reason: "parent-not-found" | "duplicate-id" };

/**
 * Return a NEW definition with `child` appended under the node identified by
 * `parentId`. Immutable (structuredClone), so a failed splice leaves the caller's
 * definition untouched; every other field — the node's ontology, the envelope
 * keys — is preserved verbatim. The added node is bare (id + title); the operator
 * fills in its ontology in the editor before saving.
 */
export function insertChildNode(
  definition: EditableTreeDefinition,
  parentId: string,
  child: { id: string; title: string },
): InsertChildResult {
  if (collectDefinitionNodeIds(definition).has(child.id)) {
    return { ok: false, reason: "duplicate-id" };
  }
  const next = structuredClone(definition);
  const parent = findNode(next.root, parentId);
  if (!parent) {
    return { ok: false, reason: "parent-not-found" };
  }
  parent.children = [...(parent.children ?? []), { id: child.id, title: child.title }];
  return { ok: true, definition: next };
}

/** Ontology list fields an operator can extend from the selected step. */
export type NodeOntologyListField =
  | "allowedTools"
  | "deniedTools"
  | "skills"
  | "knowledgeFoundations"
  | "mcpServers";

/** True when `id` satisfies the dotted-lowercase contract the tree import enforces. */
export function isValidEnterpriseId(id: string): boolean {
  return ENTERPRISE_ID_PATTERN.test(id);
}

// Flat SKILL.md name contract, mirroring SkillNameSchema in src/enterprise/schema.ts
// (the import validator rejects anything else). Kept in sync by hand, like
// NODE_ID_PATTERN above: a name the runtime refuses must fail in the form, not as a
// save error over an already-spliced definition.
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_NAME_MAX_LENGTH = 64;

/** True when `name` satisfies the declared-skill contract the tree import enforces. */
export function isValidSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name);
}

export type AddNodeOntologyEntryResult =
  | { ok: true; definition: EditableTreeDefinition }
  | { ok: false; reason: "node-not-found" | "duplicate-entry" | "entry-not-found" };

/**
 * Return a NEW definition with `entry` appended to `node.ontology[field]` on the
 * node identified by `nodeId`. Same contract as insertChildNode: immutable
 * (structuredClone) so a failed add leaves the caller's definition untouched, and
 * every other field passes through verbatim. Adding a tool grant or a declared
 * skill therefore stays a splice-then-reimport over the ONE existing write path.
 */
export function addNodeOntologyEntry(
  definition: EditableTreeDefinition,
  nodeId: string,
  field: NodeOntologyListField,
  entry: string,
): AddNodeOntologyEntryResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  // `ontology` is typed unknown so unrelated keys pass through untouched; narrow to
  // the one list this add owns and leave the rest of the binding exactly as it was.
  const ontology = (node.ontology ?? {}) as Record<string, unknown>;
  const current = Array.isArray(ontology[field]) ? (ontology[field] as unknown[]) : [];
  if (current.some((value) => value === entry)) {
    return { ok: false, reason: "duplicate-entry" };
  }
  node.ontology = { ...ontology, [field]: [...current, entry] };
  return { ok: true, definition: next };
}

/**
 * Detach one entry from a step's binding.
 *
 * The mirror of `addNodeOntologyEntry`, and it has to exist: a governance
 * surface where grants can only ever be ADDED forces an operator into the raw
 * editor to take one back, which is exactly the edit you least want done by
 * hand-editing YAML.
 *
 * Removing the last entry drops the key entirely rather than leaving `[]`, since
 * those mean different things — an omitted `allowedTools` inherits the path's
 * scope, while an empty one grants nothing.
 *
 * `mcpServers` is the exception and must keep its empty array: the runtime reads
 * PRESENCE, not length (`treeDeclaresMcpAttachment` in src/enterprise/plan.ts),
 * so an absent property marks a tree written before the field existed and leaves
 * every registered server callable. Dropping the last attachment would silently
 * un-govern the whole work-map — the opposite of what the operator asked for.
 */
export function removeNodeOntologyEntry(
  definition: EditableTreeDefinition,
  nodeId: string,
  field: NodeOntologyListField,
  entry: string,
): AddNodeOntologyEntryResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  // Same narrowing as the add: touch one list, pass every other key through.
  const ontology = (node.ontology ?? {}) as Record<string, unknown>;
  const current = Array.isArray(ontology[field]) ? (ontology[field] as unknown[]) : [];
  if (!current.some((value) => value === entry)) {
    return { ok: false, reason: "entry-not-found" };
  }
  const remaining = current.filter((value) => value !== entry);
  const { [field]: _dropped, ...rest } = ontology;
  const keepEmptyMarker = field === "mcpServers";
  node.ontology = remaining.length > 0 || keepEmptyMarker ? { ...rest, [field]: remaining } : rest;
  return { ok: true, definition: next };
}

/**
 * Set (or clear) a step's role prompt.
 *
 * Blank clears the key rather than storing an empty string: `guidance` is
 * optional, and an empty one would render an empty instruction line into the
 * step digest. Same immutable contract as the entry splicers — a failed set
 * leaves the caller's definition untouched, and every other field passes through.
 */
export function setNodeGuidance(
  definition: EditableTreeDefinition,
  nodeId: string,
  guidance: string,
): AddNodeOntologyEntryResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const ontology = (node.ontology ?? {}) as Record<string, unknown>;
  const trimmed = guidance.trim();
  const { guidance: _dropped, ...rest } = ontology;
  node.ontology = trimmed ? { ...rest, guidance: trimmed } : rest;
  return { ok: true, definition: next };
}

/** The value shapes an ontology property may declare (mirrors OntologyValueType). */
export const ONTOLOGY_VALUE_TYPES = ["string", "number", "boolean", "date", "id"] as const;

export type OntologyValueTypeName = (typeof ONTOLOGY_VALUE_TYPES)[number];

/** Link cardinalities, in the order the picker offers them. */
export const ONTOLOGY_CARDINALITIES = [
  "one-to-one",
  "one-to-many",
  "many-to-one",
  "many-to-many",
] as const;

export type OntologyCardinalityName = (typeof ONTOLOGY_CARDINALITIES)[number];

export type OntologyEditResult =
  | { ok: true; definition: EditableTreeDefinition }
  | {
      ok: false;
      reason:
        | "node-not-found"
        | "entity-not-found"
        | "duplicate-entry"
        | "entry-not-found"
        | "invalid-id"
        | "entity-in-use"
        | "entity-referenced"
        | "property-in-use"
        | "seeded-data-in-use"
        | "primary-key-taken";
    };

/** The node's ontology as a plain record, or an empty one when it has none. */
function nodeOntologyRecord(node: EditableTreeNode): Record<string, unknown> {
  return (node.ontology ?? {}) as Record<string, unknown>;
}

function ontologyList(ontology: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const current = ontology[key];
  return Array.isArray(current) ? (current as Record<string, unknown>[]) : [];
}

/**
 * Write one ontology list back, dropping the key when it empties.
 *
 * Same reasoning as the binding splicers: an absent list and an empty one are
 * different declarations, and the schema treats absence as "this step declares
 * none" rather than "declares an empty set".
 */
function withOntologyList(
  node: EditableTreeNode,
  key: string,
  next: Record<string, unknown>[],
): void {
  const ontology = nodeOntologyRecord(node);
  const { [key]: _dropped, ...rest } = ontology;
  node.ontology = next.length > 0 ? { ...rest, [key]: next } : rest;
}

/**
 * Ontology scope for one step, as the runtime reads it.
 *
 * An object type is inherited down the path (governance merges root→node the
 * same way), and a type declared on a parent may be EXTENDED by a child. Editing
 * decisions therefore cannot be made from the selected node's own arrays: a child
 * whose types all come from an ancestor would look like it declares none.
 *
 * `relationshipEndpoints` is tree-WIDE on purpose. The schema deliberately
 * tolerates a link whose endpoint is undeclared (legacy definitions), so a
 * removal that only checked this node would quietly leave another branch's link
 * pointing at a type no longer in scope — accepted by import, broken at runtime.
 */
export type DefinitionOntologyScope = {
  /** Object type ids visible at this node, from its root→node path. */
  entityIds: Set<string>;
  /**
   * Property id already marked primaryKey per entity, merged TREE-WIDE.
   *
   * Wider than `entityIds` on purpose: the schema merges an entity's shape across
   * every declaration in the definition, so a key declared on a sibling branch
   * still collides. Checking only the path would send that conflict to the server
   * instead of explaining it at the field.
   */
  primaryKeyByEntity: Map<string, string>;
  /** Every endpoint referenced by a relationship ANYWHERE in the definition. */
  relationshipEndpoints: Set<string>;
};

function nodePathToDefinitionNode(
  node: EditableTreeNode,
  id: string,
  trail: EditableTreeNode[] = [],
): EditableTreeNode[] | null {
  const path = [...trail, node];
  if (node.id === id) {
    return path;
  }
  for (const child of node.children ?? []) {
    const found = nodePathToDefinitionNode(child, id, path);
    if (found) {
      return found;
    }
  }
  return null;
}

function eachDefinitionNode(node: EditableTreeNode): EditableTreeNode[] {
  return [node, ...(node.children ?? []).flatMap((child) => eachDefinitionNode(child))];
}

/** Resolve what the selected step can actually address, plus tree-wide link use. */
export function collectDefinitionOntologyScope(
  definition: EditableTreeDefinition,
  nodeId: string,
): DefinitionOntologyScope {
  const path = nodePathToDefinitionNode(definition.root, nodeId) ?? [];
  const entityIds = new Set<string>();
  for (const node of path) {
    for (const entity of ontologyList(nodeOntologyRecord(node), "entities")) {
      if (typeof entity.id === "string" && entity.id) {
        entityIds.add(entity.id);
      }
    }
  }
  const primaryKeyByEntity = new Map<string, string>();
  for (const node of eachDefinitionNode(definition.root)) {
    for (const entity of ontologyList(nodeOntologyRecord(node), "entities")) {
      const id = typeof entity.id === "string" ? entity.id : "";
      if (!id) {
        continue;
      }
      const properties = Array.isArray(entity.properties)
        ? (entity.properties as Record<string, unknown>[])
        : [];
      const key = properties.find((property) => property.primaryKey === true);
      if (key && typeof key.id === "string" && !primaryKeyByEntity.has(id)) {
        primaryKeyByEntity.set(id, key.id);
      }
    }
  }
  const relationshipEndpoints = new Set<string>();
  for (const node of eachDefinitionNode(definition.root)) {
    for (const relationship of ontologyList(nodeOntologyRecord(node), "relationships")) {
      for (const endpoint of [relationship.from, relationship.to]) {
        if (typeof endpoint === "string") {
          relationshipEndpoints.add(endpoint);
        }
      }
    }
  }
  return { entityIds, primaryKeyByEntity, relationshipEndpoints };
}

/**
 * Declare an object type on a step.
 *
 * The id contract is the import's own (dotted lowercase), checked here so the
 * operator is told at the field rather than by a schema error after the write.
 */
export function addNodeOntologyEntity(
  definition: EditableTreeDefinition,
  nodeId: string,
  entity: { id: string; title?: string },
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const id = entity.id.trim().toLowerCase();
  if (!isValidEnterpriseId(id)) {
    return { ok: false, reason: "invalid-id" };
  }
  const entities = ontologyList(nodeOntologyRecord(node), "entities");
  if (entities.some((existing) => existing.id === id)) {
    return { ok: false, reason: "duplicate-entry" };
  }
  const title = entity.title?.trim();
  withOntologyList(node, "entities", [...entities, { id, ...(title ? { title } : {}) }]);
  return { ok: true, definition: next };
}

/**
 * Remove an object type from a step.
 *
 * Refuses while a relationship still points at it: the import rejects a link
 * whose endpoint is undeclared, so allowing this would produce a definition the
 * operator cannot save and would have to repair by hand.
 */
export function removeNodeOntologyEntity(
  definition: EditableTreeDefinition,
  nodeId: string,
  entityId: string,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const ontology = nodeOntologyRecord(node);
  const entities = ontologyList(ontology, "entities");
  if (!entities.some((entity) => entity.id === entityId)) {
    return { ok: false, reason: "entry-not-found" };
  }
  withOntologyList(
    node,
    "entities",
    entities.filter((entity) => entity.id !== entityId),
  );
  // Judged AFTER the removal, and per referring declaration. "Still declared
  // somewhere" is not enough: an id on an unrelated sibling is not on the
  // referrer's root→node path. Import validates those references TREE-wide, so it
  // would accept what the runtime — which resolves scope per path — cannot.
  const blocker = newBreakageReason(definition, next);
  if (blocker) {
    return { ok: false, reason: blocker };
  }
  return { ok: true, definition: next };
}

/** Add a typed property to one object type. */
export function addNodeOntologyProperty(
  definition: EditableTreeDefinition,
  nodeId: string,
  entityId: string,
  property: { id: string; type: OntologyValueTypeName; primaryKey?: boolean },
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const entities = ontologyList(nodeOntologyRecord(node), "entities");
  const records = entities.filter((candidate) => candidate.id === entityId);
  const entity = records[0];
  if (!entity) {
    return { ok: false, reason: "entity-not-found" };
  }
  const id = property.id.trim().toLowerCase();
  if (!isValidEnterpriseId(id)) {
    return { ok: false, reason: "invalid-id" };
  }
  // Across every record with this id, for the same reason removal searches them
  // all: the node may declare the type twice and the merged card shows the union.
  if (
    records.some((record) =>
      (Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>[])
        : []
      ).some((existing) => existing.id === id),
    )
  ) {
    return { ok: false, reason: "duplicate-entry" };
  }
  const properties = Array.isArray(entity.properties)
    ? (entity.properties as Record<string, unknown>[])
    : [];
  // One primary key per object type, resolved across the whole path: a type
  // declared on a parent may already carry one, and the tree-wide schema rejects
  // a second. Refused rather than silently written without the flag — the
  // operator asked for an identity field and would otherwise get a plain one.
  if (property.primaryKey === true) {
    const existingKey = collectDefinitionOntologyScope(definition, nodeId).primaryKeyByEntity.get(
      entityId,
    );
    if (existingKey !== undefined && existingKey !== id) {
      return { ok: false, reason: "primary-key-taken" };
    }
  }
  entity.properties = [
    ...properties,
    { id, type: property.type, ...(property.primaryKey === true ? { primaryKey: true } : {}) },
  ];
  return { ok: true, definition: next };
}

export function removeNodeOntologyProperty(
  definition: EditableTreeDefinition,
  nodeId: string,
  entityId: string,
  propertyId: string,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  // Every record with this id, not the first: the schema accepts a node
  // declaring one entity twice with disjoint fields, and the inspector renders
  // them as one merged card — so the field the operator clicked may live in
  // either record.
  const records = ontologyList(nodeOntologyRecord(node), "entities").filter(
    (candidate) => candidate.id === entityId,
  );
  if (records.length === 0) {
    return { ok: false, reason: "entity-not-found" };
  }
  let removed = false;
  for (const entity of records) {
    const properties = Array.isArray(entity.properties)
      ? (entity.properties as Record<string, unknown>[])
      : [];
    if (!properties.some((property) => property.id === propertyId)) {
      continue;
    }
    removed = true;
    const remaining = properties.filter((property) => property.id !== propertyId);
    if (remaining.length > 0) {
      entity.properties = remaining;
    } else {
      delete entity.properties;
    }
  }
  if (!removed) {
    return { ok: false, reason: "entry-not-found" };
  }
  // Same path-versus-tree gap as entity removal: a function reading this field,
  // or a write action whose parameters map onto it, stays valid to the importer
  // while the runtime can no longer resolve it.
  const propertyBlocker = newBreakageReason(definition, next);
  if (propertyBlocker) {
    return { ok: false, reason: propertyBlocker };
  }
  return { ok: true, definition: next };
}

/** Declare a directed link between two object types the step already declares. */
export function addNodeOntologyRelationship(
  definition: EditableTreeDefinition,
  nodeId: string,
  relationship: { id: string; from: string; to: string; cardinality?: OntologyCardinalityName },
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const id = relationship.id.trim().toLowerCase();
  if (!isValidEnterpriseId(id)) {
    return { ok: false, reason: "invalid-id" };
  }
  const ontology = nodeOntologyRecord(node);
  // Endpoints resolve against the node's SCOPE, not its own declarations: object
  // types are inherited down the path, so a child whose types all come from an
  // ancestor may legitimately link them (schema.test.ts covers exactly that).
  const scope = collectDefinitionOntologyScope(definition, nodeId);
  if (!scope.entityIds.has(relationship.from) || !scope.entityIds.has(relationship.to)) {
    return { ok: false, reason: "entity-not-found" };
  }
  const relationships = ontologyList(ontology, "relationships");
  // Unique along the PATH, not just this node: the runtime scope maps links by
  // id (ontology-runtime.ts), so a child reusing an ancestor's id silently
  // replaces it — while the inspector, which keys by endpoints too, shows both.
  const pathHasId = (nodePathToDefinitionNode(next.root, nodeId) ?? []).some((candidate) =>
    ontologyList(nodeOntologyRecord(candidate), "relationships").some(
      (existing) => existing.id === id,
    ),
  );
  if (pathHasId) {
    return { ok: false, reason: "duplicate-entry" };
  }
  withOntologyList(node, "relationships", [
    ...relationships,
    {
      id,
      from: relationship.from,
      to: relationship.to,
      // Omitted means many-to-many (the least-constrained reading), so only a
      // narrower choice is worth writing down.
      ...(relationship.cardinality && relationship.cardinality !== "many-to-many"
        ? { cardinality: relationship.cardinality }
        : {}),
    },
  ]);
  return { ok: true, definition: next };
}

export function removeNodeOntologyRelationship(
  definition: EditableTreeDefinition,
  nodeId: string,
  link: { id: string; from: string; to: string },
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const relationships = ontologyList(nodeOntologyRecord(node), "relationships");
  // Matched on the whole triple. The schema permits one id to appear with
  // different endpoint pairs (the graph keys them that way too), and the editor
  // renders one chip each — so filtering by id alone would delete the others.
  const matches = (relationship: Record<string, unknown>) =>
    relationship.id === link.id && relationship.from === link.from && relationship.to === link.to;
  if (!relationships.some(matches)) {
    return { ok: false, reason: "entry-not-found" };
  }
  withOntologyList(
    node,
    "relationships",
    relationships.filter((relationship) => !matches(relationship)),
  );
  // A seeded link names this relationship TYPE, so dropping the type would leave
  // a seed the import refuses. Same before/after rule as the other removers.
  const blocker = newBreakageReason(definition, next);
  if (blocker) {
    return { ok: false, reason: blocker };
  }
  return { ok: true, definition: next };
}

/**
 * Every ontology reference that does NOT resolve, as stable keys.
 *
 * One scan for all of them, because they share a rule the importer does not
 * enforce: import validates references TREE-wide, while the runtime resolves
 * each declaration through its own root→node path. A link, a derived function,
 * or an action can therefore be accepted on save and fail at execution.
 *
 * Callers compare the set before and after an edit and refuse only when the edit
 * ADDS a break — so a work-map that arrived broken stays editable, and an edit on
 * one branch is not blocked by an unrelated branch's existing problem.
 */
function brokenOntologyReferences(definition: EditableTreeDefinition): Set<string> {
  const broken = new Set<string>();
  const nodes = eachDefinitionNode(definition.root);

  // Seeded data is validated TREE-wide by the schema, unlike the runtime-scoped
  // consumers below, so it gets one merged view rather than a per-path one.
  const treeWide = new Map<string, { properties: Set<string>; primaryKey?: string }>();
  const treeWideLinkIds = new Set<string>();
  for (const node of nodes) {
    const ontology = nodeOntologyRecord(node);
    for (const entity of ontologyList(ontology, "entities")) {
      const id = typeof entity.id === "string" ? entity.id : "";
      if (!id) {
        continue;
      }
      const merged = treeWide.get(id) ?? { properties: new Set<string>() };
      for (const property of Array.isArray(entity.properties)
        ? (entity.properties as Record<string, unknown>[])
        : []) {
        if (typeof property.id !== "string") {
          continue;
        }
        merged.properties.add(property.id);
        if (property.primaryKey === true && merged.primaryKey === undefined) {
          merged.primaryKey = property.id;
        }
      }
      treeWide.set(id, merged);
    }
    for (const relationship of ontologyList(ontology, "relationships")) {
      if (typeof relationship.id === "string") {
        treeWideLinkIds.add(relationship.id);
      }
    }
  }

  for (const node of nodes) {
    const ontology = nodeOntologyRecord(node);
    for (const seed of ontologyList(ontology, "objects")) {
      const entity = typeof seed.entity === "string" ? treeWide.get(seed.entity) : undefined;
      if (!entity) {
        broken.add(`seed-entity:${String(seed.entity)}`);
        continue;
      }
      // A seeded instance carries values keyed by property id, and the schema
      // requires the type's primaryKey among them.
      if (entity.primaryKey === undefined) {
        broken.add(`seed-key:${String(seed.entity)}`);
      }
      for (const property of seed.properties && typeof seed.properties === "object"
        ? Object.keys(seed.properties)
        : []) {
        if (!entity.properties.has(property)) {
          broken.add(`seed-property:${String(seed.entity)}:${property}`);
        }
      }
    }
    for (const seed of ontologyList(ontology, "links")) {
      if (typeof seed.relationship === "string" && !treeWideLinkIds.has(seed.relationship)) {
        broken.add(`seed-link:${seed.relationship}`);
      }
    }
  }

  // Consumers, by contrast, resolve at the node they RUN at. Iterated as
  // active-node candidates because declarations inherit downward: a function on
  // an ancestor executes at any descendant against THAT node's merged scope,
  // which is what resolveActiveOntologyScope does.
  //
  // Paths and scopes are built once per node, top-down, so a deep chain costs one
  // pass rather than a rescan per owner.
  const pathOf = new Map<string, EditableTreeNode[]>();
  const scopeOf = new Map<string, Map<string, { properties: Set<string>; primaryKey?: string }>>();
  const visit = (node: EditableTreeNode, parentPath: EditableTreeNode[]) => {
    const path = [...parentPath, node];
    pathOf.set(node.id, path);
    const parentScope =
      parentPath.length > 0 ? scopeOf.get(parentPath.at(-1)?.id ?? "") : undefined;
    const scope = new Map<string, { properties: Set<string>; primaryKey?: string }>();
    for (const [id, entity] of parentScope ?? []) {
      scope.set(id, { properties: new Set(entity.properties), primaryKey: entity.primaryKey });
    }
    for (const entity of ontologyList(nodeOntologyRecord(node), "entities")) {
      const id = typeof entity.id === "string" ? entity.id : "";
      if (!id) {
        continue;
      }
      const merged = scope.get(id) ?? { properties: new Set<string>() };
      for (const property of Array.isArray(entity.properties)
        ? (entity.properties as Record<string, unknown>[])
        : []) {
        if (typeof property.id !== "string") {
          continue;
        }
        merged.properties.add(property.id);
        if (property.primaryKey === true && merged.primaryKey === undefined) {
          merged.primaryKey = property.id;
        }
      }
      scope.set(id, merged);
    }
    scopeOf.set(node.id, scope);
    for (const child of node.children ?? []) {
      visit(child, path);
    }
  };
  visit(definition.root, []);

  for (const active of nodes) {
    const visible = scopeOf.get(active.id) ?? new Map();
    const path = pathOf.get(active.id) ?? [];
    // Links resolve LAST-WINS per id along the path: resolveActiveOntologyScope
    // maps them by id alone, and the schema permits one id to name two endpoint
    // pairs. Checking every declaration would let a dangling earlier link hide
    // behind a valid later one — its break would already be in the before-set, so
    // removing the later link would look harmless while exposing the broken one.
    const effectiveLinks = new Map<string, Record<string, unknown>>();
    for (const owner of path) {
      for (const relationship of ontologyList(nodeOntologyRecord(owner), "relationships")) {
        if (typeof relationship.id === "string") {
          effectiveLinks.set(relationship.id, relationship);
        }
      }
    }
    for (const [linkId, relationship] of effectiveLinks) {
      for (const endpoint of [relationship.from, relationship.to]) {
        if (typeof endpoint === "string" && !visible.has(endpoint)) {
          broken.add(`link:${active.id}:${linkId}:${endpoint}`);
        }
      }
    }

    for (const owner of path) {
      const ownerOntology = nodeOntologyRecord(owner);

      for (const fn of ontologyList(ownerOntology, "functions")) {
        const entity = typeof fn.entity === "string" ? visible.get(fn.entity) : undefined;
        if (!entity) {
          broken.add(`fn-entity:${active.id}:${String(fn.id)}`);
          continue;
        }
        if (typeof fn.expression !== "string") {
          continue;
        }
        // Parsed, not pattern-matched: only the parser knows which occurrences
        // are property tokens rather than op names or string literals. An
        // expression that will not parse is the importer's problem.
        const parsed = parseOntologyExpression(fn.expression);
        if (!parsed.ok) {
          continue;
        }
        for (const property of ontologyExpressionProperties(parsed.expression)) {
          if (!entity.properties.has(property)) {
            broken.add(`fn-property:${active.id}:${String(fn.id)}:${property}`);
          }
        }
      }

      for (const action of ontologyList(ownerOntology, "actions")) {
        const effects = Array.isArray(action.effects)
          ? (action.effects as Record<string, unknown>[])
          : [];
        const parameters = Array.isArray(action.parameters)
          ? (action.parameters as Record<string, unknown>[])
          : [];
        for (const effect of effects) {
          const entity = typeof effect.entity === "string" ? visible.get(effect.entity) : undefined;
          if (!entity) {
            broken.add(`action-entity:${active.id}:${String(action.id)}:${String(effect.entity)}`);
            continue;
          }
          // A read needs nothing more; a write needs the identity field to say
          // which instance it acts on.
          if (effect.kind === "read") {
            continue;
          }
          if (entity.primaryKey === undefined) {
            broken.add(`action-key:${active.id}:${String(action.id)}:${String(effect.entity)}`);
          }
          // Parameters map onto properties for create and update only: the delete
          // branch returns before property mapping
          // (src/enterprise/ontology-actions.ts), so it needs the key alone.
          if (effect.kind !== "create" && effect.kind !== "update") {
            continue;
          }
          for (const parameter of parameters) {
            if (
              typeof parameter.id === "string" &&
              parameter.id !== entity.primaryKey &&
              !entity.properties.has(parameter.id)
            ) {
              broken.add(
                `action-param:${active.id}:${String(action.id)}:${String(effect.entity)}:${parameter.id}`,
              );
            }
          }
        }
      }
    }
  }
  return broken;
}

/** The kind of the first break an edit introduced, or null when it introduced none. */
function newBreakageReason(
  before: EditableTreeDefinition,
  after: EditableTreeDefinition,
): "entity-in-use" | "entity-referenced" | "property-in-use" | "seeded-data-in-use" | null {
  const existing = brokenOntologyReferences(before);
  const added = [...brokenOntologyReferences(after)].filter((key) => !existing.has(key));
  if (added.length === 0) {
    return null;
  }
  // A link is the dependency an operator can clear from this editor, so it wins
  // the message; the rest have to be resolved by re-importing the work-map.
  if (added.some((key) => key.startsWith("link:"))) {
    return "entity-in-use";
  }
  if (added.some((key) => key.startsWith("seed-"))) {
    return "seeded-data-in-use";
  }
  if (added.some((key) => key.startsWith("fn-entity:") || key.startsWith("action-entity:"))) {
    return "entity-referenced";
  }
  return "property-in-use";
}

function findNode(node: EditableTreeNode, id: string): EditableTreeNode | null {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return null;
}
