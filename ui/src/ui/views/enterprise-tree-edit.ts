// Pure helpers for the operator "add child node" affordance. They operate on the
// parsed nested WorkflowTreeDefinition — what enterprise.trees.export serializes
// and enterprise.trees.import consumes — so creating a node stays a splice-then-
// reimport over the ONE existing write path, with no node-level gateway method.

import {
  expressionTypeOf,
  inferOntologyExpressionType,
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

export function insertChildNode(
  definition: EditableTreeDefinition,
  parentId: string,
  child: { id: string; title: string; description?: string },
): InsertChildResult {
  if (collectDefinitionNodeIds(definition).has(child.id)) {
    return { ok: false, reason: "duplicate-id" };
  }
  const next = structuredClone(definition);
  const parent = findNode(next.root, parentId);
  if (!parent) {
    return { ok: false, reason: "parent-not-found" };
  }
  parent.children = [...(parent.children ?? []), child];
  return { ok: true, definition: next };
}

export type EditableTreeTrigger = "user" | "system" | "subagent";

/** Replace guided tree metadata without disturbing raw-only or legacy fields. */
export function setTreeSettings(
  definition: EditableTreeDefinition,
  settings: {
    version: string;
    name: string;
    description: string;
    executionModel?: string;
    triggers: readonly EditableTreeTrigger[];
    priority?: number;
  },
): { ok: true; definition: EditableTreeDefinition } {
  const next = structuredClone(definition);
  next.version = settings.version.trim();
  next.name = settings.name.trim();

  const description = settings.description.trim();
  if (description) {
    next.description = description;
  } else {
    delete next.description;
  }

  if (settings.executionModel !== undefined) {
    const model = settings.executionModel.trim();
    if (model) {
      next.executionModel = model;
    } else {
      delete next.executionModel;
    }
  }

  const currentMatch =
    typeof next.match === "object" && next.match !== null && !Array.isArray(next.match)
      ? (next.match as Record<string, unknown>)
      : {};
  const { triggers: _triggers, priority: _priority, ...preservedMatch } = currentMatch;
  const userOnly = settings.triggers.length === 1 && settings.triggers[0] === "user";
  const match = {
    ...preservedMatch,
    ...(!userOnly ? { triggers: [...settings.triggers] } : {}),
    ...(settings.priority !== undefined ? { priority: settings.priority } : {}),
  };
  if (Object.keys(match).length > 0) {
    next.match = match;
  } else {
    delete next.match;
  }
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

/** Declare MCP attachment governance, including before leaving explicit mode. */
export function enableNodeMcpGovernance(
  definition: EditableTreeDefinition,
  nodeId: string,
): AddNodeOntologyEntryResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const ontology = nodeOntologyRecord(node);
  if (Object.hasOwn(ontology, "mcpServers")) {
    return { ok: false, reason: "duplicate-entry" };
  }
  node.ontology = { ...ontology, mcpServers: [] };
  return { ok: true, definition: next };
}

export function disableTreeMcpGovernance(
  definition: EditableTreeDefinition,
): AddNodeOntologyEntryResult {
  if (definition.capabilityGrants !== undefined) {
    return { ok: false, reason: "entry-not-found" };
  }
  const nodesWithMarker = eachDefinitionNode(definition.root).filter((node) =>
    Object.hasOwn(nodeOntologyRecord(node), "mcpServers"),
  );
  if (
    nodesWithMarker.length === 0 ||
    nodesWithMarker.some((node) => {
      const servers = nodeOntologyRecord(node).mcpServers;
      return !Array.isArray(servers) || servers.length > 0;
    })
  ) {
    return { ok: false, reason: "entry-not-found" };
  }

  const next = structuredClone(definition);
  for (const node of eachDefinitionNode(next.root)) {
    const ontology = nodeOntologyRecord(node);
    if (!Object.hasOwn(ontology, "mcpServers")) {
      continue;
    }
    const { mcpServers: _dropped, ...rest } = ontology;
    node.ontology = rest;
  }
  return { ok: true, definition: next };
}

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

export type EditableNodeBehavior = {
  title?: string;
  description: string;
  guidance: string;
  contextHints: string[];
  expectedOutput: string;
  audit: boolean;
};

export type NodeBehaviorEditResult =
  | { ok: true; definition: EditableTreeDefinition }
  | { ok: false; reason: "node-not-found" }
  | { ok: false; reason: "title-empty" };

/** Replace the operator-authored behavior fields while preserving other ontology keys. */
export function setNodeBehavior(
  definition: EditableTreeDefinition,
  nodeId: string,
  behavior: EditableNodeBehavior,
): NodeBehaviorEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  if (behavior.title !== undefined) {
    const title = behavior.title.trim();
    if (!title) {
      return { ok: false, reason: "title-empty" };
    }
    node.title = title;
  }
  const ontology = (node.ontology ?? {}) as Record<string, unknown>;
  const {
    guidance: _guidance,
    contextHints: _contextHints,
    expectedOutput: _expectedOutput,
    audit: _audit,
    ...rest
  } = ontology;
  const guidance = behavior.guidance.trim();
  const contextHints = behavior.contextHints.map((hint) => hint.trim()).filter(Boolean);
  const expectedOutput = behavior.expectedOutput.trim();
  const updated = {
    ...rest,
    ...(contextHints.length > 0 ? { contextHints } : {}),
    ...(guidance ? { guidance } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(behavior.audit ? { audit: true } : {}),
  };
  const description = behavior.description.trim();
  if (description) {
    node.description = description;
  } else {
    delete node.description;
  }
  if (Object.keys(updated).length > 0) {
    node.ontology = updated;
  } else {
    delete node.ontology;
  }
  return { ok: true, definition: next };
}

/** The value shapes an ontology property may declare (mirrors OntologyValueType). */
export const ONTOLOGY_VALUE_TYPES = ["string", "number", "boolean", "date", "id"] as const;

export type OntologyValueTypeName = (typeof ONTOLOGY_VALUE_TYPES)[number];

/** True when a raw declaration's `type` is one of the ontology's value types. */
function isOntologyValueTypeName(value: unknown): value is OntologyValueTypeName {
  return typeof value === "string" && (ONTOLOGY_VALUE_TYPES as readonly string[]).includes(value);
}

/** Link cardinalities, in the order the picker offers them. */
export const ONTOLOGY_CARDINALITIES = [
  "one-to-one",
  "one-to-many",
  "many-to-one",
  "many-to-many",
] as const;

export type OntologyCardinalityName = (typeof ONTOLOGY_CARDINALITIES)[number];

/**
 * Every reason an ontology edit can be refused.
 *
 * A runtime list rather than a bare union because each reason is rendered
 * through `enterprise.ontologyEditor.error.<reason>`: a reason added without its
 * string puts the raw key on screen, and only a list a test can iterate catches
 * that before an operator reads it.
 */
export const ONTOLOGY_EDIT_REASONS = [
  "node-not-found",
  "entity-not-found",
  "duplicate-entry",
  "entry-not-found",
  "invalid-id",
  "entity-in-use",
  "entity-referenced",
  "property-in-use",
  "primary-key-taken",
  "identity-type-invalid",
  "action-not-found",
  "effect-needs-identity",
  "expression-invalid",
  "expression-property-unknown",
  "expression-type-invalid",
  "returns-mismatch",
  "property-type-conflict",
  "parameter-type-conflict",
  "effect-target-taken",
  "create-required-unreachable",
  "relationship-not-found",
  "effect-mixes-outward",
] as const;

export type OntologyEditReason = (typeof ONTOLOGY_EDIT_REASONS)[number];

export type OntologyEditResult =
  | { ok: true; definition: EditableTreeDefinition }
  | { ok: false; reason: OntologyEditReason };

type OntologyBreakageReason = Extract<
  OntologyEditReason,
  "duplicate-entry" | "entity-in-use" | "entity-referenced" | "property-in-use"
>;

export type TreeStructureEditReason =
  | "node-not-found"
  | "parent-not-found"
  | "root-node"
  | "invalid-parent"
  | "invalid-index"
  | OntologyBreakageReason;

export type TreeStructureEditResult =
  | { ok: true; definition: EditableTreeDefinition }
  | { ok: false; reason: TreeStructureEditReason };

/** Move a non-root subtree to an exact position in its new parent's final child list. */
export function moveTreeNode(
  definition: EditableTreeDefinition,
  nodeId: string,
  target: { parentId: string; index: number },
): TreeStructureEditResult {
  if (nodeId === definition.root.id) {
    return { ok: false, reason: "root-node" };
  }
  const node = findNode(definition.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const parent = findNode(definition.root, target.parentId);
  if (!parent) {
    return { ok: false, reason: "parent-not-found" };
  }
  if (findNode(node, target.parentId)) {
    return { ok: false, reason: "invalid-parent" };
  }
  const currentParent = findNodeParent(definition.root, nodeId);
  const finalChildCount =
    (parent.children?.length ?? 0) - (currentParent?.id === target.parentId ? 1 : 0);
  if (!Number.isSafeInteger(target.index) || target.index < 0 || target.index > finalChildCount) {
    return { ok: false, reason: "invalid-index" };
  }

  const next = structuredClone(definition);
  const moved = detachTreeNode(next.root, nodeId);
  const nextParent = findNode(next.root, target.parentId);
  if (!moved || !nextParent) {
    return { ok: false, reason: "node-not-found" };
  }
  const children = nextParent.children ?? [];
  nextParent.children = [
    ...children.slice(0, target.index),
    moved,
    ...children.slice(target.index),
  ];
  const blocker = newBreakageReason(definition, next);
  return blocker ? { ok: false, reason: blocker } : { ok: true, definition: next };
}

/** Remove a non-root subtree unless doing so newly breaks an ontology consumer. */
export function removeTreeNode(
  definition: EditableTreeDefinition,
  nodeId: string,
): TreeStructureEditResult {
  if (nodeId === definition.root.id) {
    return { ok: false, reason: "root-node" };
  }
  if (!findNode(definition.root, nodeId)) {
    return { ok: false, reason: "node-not-found" };
  }
  const next = structuredClone(definition);
  if (!detachTreeNode(next.root, nodeId)) {
    return { ok: false, reason: "node-not-found" };
  }
  const hadMcpGovernance = eachDefinitionNode(definition.root).some((node) =>
    Object.hasOwn(nodeOntologyRecord(node), "mcpServers"),
  );
  const keepsMcpGovernance = eachDefinitionNode(next.root).some((node) =>
    Object.hasOwn(nodeOntologyRecord(node), "mcpServers"),
  );
  if (hadMcpGovernance && !keepsMcpGovernance) {
    // MCP governance is presence-based. Keep the opt-in on the surviving root or
    // deleting its last declaring subtree would make every registered server callable.
    next.root.ontology = { ...nodeOntologyRecord(next.root), mcpServers: [] };
  }
  const blocker = newBreakageReason(definition, next);
  return blocker ? { ok: false, reason: blocker } : { ok: true, definition: next };
}

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

function optionalTrimmedText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function setOptionalText(
  record: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  const trimmed = optionalTrimmedText(value);
  if (trimmed !== undefined) {
    record[key] = trimmed;
  } else {
    delete record[key];
  }
}

/** Trim a schema non-blank list; null means at least one entry was blank. */
function normalizedNonBlankList(
  values: readonly string[] | undefined,
): string[] | null | undefined {
  if (values === undefined) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim());
  return normalized.some((value) => !value) ? null : normalized;
}

function exactIndexedEntry(
  entries: readonly Record<string, unknown>[],
  index: number,
  matches: (entry: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!Number.isSafeInteger(index) || index < 0) {
    return null;
  }
  const entry = entries[index];
  return entry && matches(entry) ? entry : null;
}

export type DefinitionOntologyScope = {
  nodeEntityShapes: Map<
    string,
    { propertyTypes: Map<string, OntologyValueTypeName>; primaryKey?: string }
  >;
  /**
   * Property id already marked primaryKey per entity, merged TREE-WIDE.
   *
   * Wider than `nodeEntityShapes` on purpose: the schema merges an entity's shape across
   * every declaration in the definition, so a key declared on a sibling branch
   * still collides. Checking only the path would send that conflict to the server
   * instead of explaining it at the field.
   */
  primaryKeyByEntity: Map<string, string>;
  /** Property types merged TREE-WIDE, matching import validation. */
  propertyTypesByEntity: Map<string, Map<string, OntologyValueTypeName>>;
  /**
   * Property ids marked required per entity, merged TREE-WIDE.
   *
   * Tree-wide because `collectTreeRequiredProperties`
   * (src/enterprise/ontology-runtime.ts) is: a create must satisfy every branch's
   * requirement, so a property a SIBLING marks required still blocks a create
   * here — and no parameter on this branch can supply one this branch cannot see.
   */
  requiredByEntity: Map<string, Set<string>>;
  /** Every endpoint referenced by a relationship ANYWHERE in the definition. */
  relationshipEndpoints: Set<string>;
};

function eachDefinitionNode(node: EditableTreeNode): EditableTreeNode[] {
  return [node, ...(node.children ?? []).flatMap((child) => eachDefinitionNode(child))];
}

/** Resolve what the selected step can actually address, plus tree-wide link use. */
export function collectDefinitionOntologyScope(
  definition: EditableTreeDefinition,
  nodeId: string,
): DefinitionOntologyScope {
  const selected = findNode(definition.root, nodeId);
  const path = selected ? [selected] : [];
  const nodeEntityShapes = new Map<
    string,
    { propertyTypes: Map<string, OntologyValueTypeName>; primaryKey?: string }
  >();
  for (const node of path) {
    for (const entity of ontologyList(nodeOntologyRecord(node), "entities")) {
      const id = typeof entity.id === "string" ? entity.id : "";
      if (!id) {
        continue;
      }
      const merged = nodeEntityShapes.get(id) ?? {
        propertyTypes: new Map<string, OntologyValueTypeName>(),
      };
      for (const property of Array.isArray(entity.properties)
        ? (entity.properties as Record<string, unknown>[])
        : []) {
        if (typeof property.id !== "string") {
          continue;
        }
        // A property whose type is not one the ontology declares would be
        // refused by the import anyway; recording it typeless would only make
        // the expression checker below infer against a shape that cannot exist.
        merged.propertyTypes.set(
          property.id,
          isOntologyValueTypeName(property.type) ? property.type : "string",
        );
        // First declaration wins, matching how the schema merges a type across
        // the path: a later node cannot move the identity field.
        if (property.primaryKey === true && merged.primaryKey === undefined) {
          merged.primaryKey = property.id;
        }
      }
      nodeEntityShapes.set(id, merged);
    }
  }
  const primaryKeyByEntity = new Map<string, string>();
  const propertyTypesByEntity = new Map<string, Map<string, OntologyValueTypeName>>();
  const requiredByEntity = new Map<string, Set<string>>();
  for (const node of eachDefinitionNode(definition.root)) {
    for (const entity of ontologyList(nodeOntologyRecord(node), "entities")) {
      const id = typeof entity.id === "string" ? entity.id : "";
      if (!id) {
        continue;
      }
      const properties = Array.isArray(entity.properties)
        ? (entity.properties as Record<string, unknown>[])
        : [];
      const propertyTypes = propertyTypesByEntity.get(id) ?? new Map();
      for (const property of properties) {
        if (typeof property.id === "string" && isOntologyValueTypeName(property.type)) {
          propertyTypes.set(property.id, property.type);
        }
      }
      propertyTypesByEntity.set(id, propertyTypes);
      const key = properties.find((property) => property.primaryKey === true);
      if (key && typeof key.id === "string" && !primaryKeyByEntity.has(id)) {
        primaryKeyByEntity.set(id, key.id);
      }
      const required = requiredByEntity.get(id) ?? new Set<string>();
      for (const property of properties) {
        if (property.required === true && typeof property.id === "string") {
          required.add(property.id);
        }
      }
      requiredByEntity.set(id, required);
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
  return {
    nodeEntityShapes,
    primaryKeyByEntity,
    propertyTypesByEntity,
    requiredByEntity,
    relationshipEndpoints,
  };
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
  entity: { id: string; title?: string; description?: string },
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
  const description = optionalTrimmedText(entity.description);
  withOntologyList(node, "entities", [
    ...entities,
    { id, ...(title ? { title } : {}), ...(description ? { description } : {}) },
  ]);
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
  target: string | IndexedIdTarget,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const ontology = nodeOntologyRecord(node);
  const entities = ontologyList(ontology, "entities");
  const matches = (entity: Record<string, unknown>, index: number) =>
    typeof target === "string"
      ? entity.id === target
      : index === target.index && entity.id === target.id;
  if (!entities.some(matches)) {
    return { ok: false, reason: "entry-not-found" };
  }
  withOntologyList(
    node,
    "entities",
    entities.filter((entity, index) => !matches(entity, index)),
  );
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
  property: {
    id: string;
    type: OntologyValueTypeName;
    primaryKey?: boolean;
    required?: boolean;
    description?: string;
  },
  entityIndex?: number,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const entities = ontologyList(nodeOntologyRecord(node), "entities");
  const records = entities.filter((candidate) => candidate.id === entityId);
  const entity =
    entityIndex === undefined
      ? records[0]
      : exactIndexedEntry(entities, entityIndex, (candidate) => candidate.id === entityId);
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
  const scope = collectDefinitionOntologyScope(definition, nodeId);
  const knownType = scope.propertyTypesByEntity.get(entityId)?.get(id);
  if (knownType !== undefined && knownType !== property.type) {
    return { ok: false, reason: "property-type-conflict" };
  }
  const properties = Array.isArray(entity.properties)
    ? (entity.properties as Record<string, unknown>[])
    : [];
  // One primary key per object type, resolved across the whole path: a type
  // declared on a parent may already carry one, and the tree-wide schema rejects
  // a second. Refused rather than silently written without the flag — the
  // operator asked for an identity field and would otherwise get a plain one.
  if (property.primaryKey === true) {
    if (property.type === "boolean") {
      return { ok: false, reason: "identity-type-invalid" };
    }
    const existingKey = scope.primaryKeyByEntity.get(entityId);
    if (existingKey !== undefined && existingKey !== id) {
      return { ok: false, reason: "primary-key-taken" };
    }
  }
  const description = optionalTrimmedText(property.description);
  entity.properties = [
    ...properties,
    {
      id,
      type: property.type,
      ...(property.primaryKey === true ? { primaryKey: true } : {}),
      ...(property.required === true ? { required: true } : {}),
      ...(description ? { description } : {}),
    },
  ];
  return { ok: true, definition: next };
}

export function removeNodeOntologyProperty(
  definition: EditableTreeDefinition,
  nodeId: string,
  entityId: string,
  propertyId: string,
  location?: { entityIndex: number; propertyIndex: number },
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
  const entities = ontologyList(nodeOntologyRecord(node), "entities");
  const exactEntity = location
    ? exactIndexedEntry(entities, location.entityIndex, (candidate) => candidate.id === entityId)
    : null;
  const records = location
    ? exactEntity
      ? [exactEntity]
      : []
    : entities.filter((candidate) => candidate.id === entityId);
  if (records.length === 0) {
    return { ok: false, reason: "entity-not-found" };
  }
  let removed = false;
  for (const entity of records) {
    const properties = Array.isArray(entity.properties)
      ? (entity.properties as Record<string, unknown>[])
      : [];
    const matches = (property: Record<string, unknown>, index: number) =>
      property.id === propertyId && (!location || index === location.propertyIndex);
    if (!properties.some(matches)) {
      continue;
    }
    removed = true;
    const remaining = properties.filter((property, index) => !matches(property, index));
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
  relationship: {
    id: string;
    from: string;
    to: string;
    cardinality?: OntologyCardinalityName;
    inverse?: string;
    description?: string;
  },
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
  const scope = collectDefinitionOntologyScope(definition, nodeId);
  if (
    !scope.nodeEntityShapes.has(relationship.from) ||
    !scope.nodeEntityShapes.has(relationship.to)
  ) {
    return { ok: false, reason: "entity-not-found" };
  }
  const relationships = ontologyList(ontology, "relationships");
  if (ontologyIdCollidesAtNode(next, nodeId, "relationships", id)) {
    return { ok: false, reason: "duplicate-entry" };
  }
  const inverse = optionalTrimmedText(relationship.inverse);
  const description = optionalTrimmedText(relationship.description);
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
      ...(inverse ? { inverse } : {}),
      ...(description ? { description } : {}),
    },
  ]);
  return { ok: true, definition: next };
}

export function removeNodeOntologyRelationship(
  definition: EditableTreeDefinition,
  nodeId: string,
  link: { id: string; from: string; to: string; index?: number },
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
  const matches = (relationship: Record<string, unknown>, index: number) =>
    relationship.id === link.id &&
    relationship.from === link.from &&
    relationship.to === link.to &&
    (link.index === undefined || index === link.index);
  if (!relationships.some(matches)) {
    return { ok: false, reason: "entry-not-found" };
  }
  withOntologyList(
    node,
    "relationships",
    relationships.filter((relationship, index) => !matches(relationship, index)),
  );
  // A seeded link names this relationship TYPE, so dropping the type would leave
  // a seed the import refuses. Same before/after rule as the other removers.
  const blocker = newBreakageReason(definition, next);
  if (blocker) {
    return { ok: false, reason: blocker };
  }
  return { ok: true, definition: next };
}

/** One effect as the inspector collects it, before the splicer checks it. */
export type OntologyEffectDraft =
  | { kind: OntologyEffectKindName; entity: string; description?: string }
  | { kind: "call"; tool: string; description?: string }
  | {
      kind: "link" | "unlink";
      relationship: string;
      from?: string;
      to?: string;
      description?: string;
    };

/** Append one checked effect, keeping the array the caller already read. */
function appendActionEffect(
  action: Record<string, unknown>,
  declared: readonly Record<string, unknown>[],
  added: Record<string, unknown>,
): void {
  action.effects = [...declared, added];
}

/** Effect kinds an action may declare (mirrors OntologyActionEffect.kind). */
export const ONTOLOGY_EFFECT_KINDS = ["read", "create", "update", "delete"] as const;

export type OntologyEffectKindName = (typeof ONTOLOGY_EFFECT_KINDS)[number];

/** The action records `node` declares, or an empty list when it declares none. */
function nodeOntologyActions(node: EditableTreeNode): Record<string, unknown>[] {
  return ontologyList(nodeOntologyRecord(node), "actions");
}

/** The action with `actionId` on this node, or null when the node declares none. */
function findNodeAction(
  node: EditableTreeNode,
  actionId: string,
  actionIndex?: number,
): Record<string, unknown> | null {
  const actions = nodeOntologyActions(node);
  return actionIndex === undefined
    ? (actions.find((action) => action.id === actionId) ?? null)
    : exactIndexedEntry(actions, actionIndex, (action) => action.id === actionId);
}

/** Action/function/link identifiers are unique within their executable step. */
function ontologyIdCollidesAtNode(
  definition: EditableTreeDefinition,
  nodeId: string,
  key: "actions" | "functions" | "relationships",
  id: string,
): boolean {
  const node = findNode(definition.root, nodeId);
  return (
    node !== null && ontologyList(nodeOntologyRecord(node), key).some((entry) => entry.id === id)
  );
}

export function addNodeOntologyAction(
  definition: EditableTreeDefinition,
  nodeId: string,
  action: {
    id: string;
    title?: string;
    description?: string;
    tools?: string[];
    preconditions?: string[];
  },
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const id = action.id.trim().toLowerCase();
  if (!isValidEnterpriseId(id)) {
    return { ok: false, reason: "invalid-id" };
  }
  if (ontologyIdCollidesAtNode(next, nodeId, "actions", id)) {
    return { ok: false, reason: "duplicate-entry" };
  }
  const tools = normalizedNonBlankList(action.tools);
  const preconditions = normalizedNonBlankList(action.preconditions);
  if (tools === null || preconditions === null) {
    return { ok: false, reason: "invalid-id" };
  }
  const title = action.title?.trim();
  const description = optionalTrimmedText(action.description);
  withOntologyList(node, "actions", [
    ...nodeOntologyActions(node),
    {
      id,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(preconditions?.length ? { preconditions } : {}),
    },
  ]);
  return { ok: true, definition: next };
}

export function removeNodeOntologyAction(
  definition: EditableTreeDefinition,
  nodeId: string,
  actionId: string,
  actionIndex?: number,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const actions = nodeOntologyActions(node);
  const matches = (action: Record<string, unknown>, index: number) =>
    action.id === actionId && (actionIndex === undefined || index === actionIndex);
  if (!actions.some(matches)) {
    return { ok: false, reason: "entry-not-found" };
  }
  withOntologyList(
    node,
    "actions",
    actions.filter((action, index) => !matches(action, index)),
  );
  const blocker = newBreakageReason(definition, next);
  if (blocker) {
    return { ok: false, reason: blocker };
  }
  return { ok: true, definition: next };
}

function executableNodes(
  definition: EditableTreeDefinition,
  nodeId: string,
  action?: Record<string, unknown>,
): EditableTreeNode[] {
  const node = findNode(definition.root, nodeId);
  if (!node) {
    return [];
  }
  if (action && nodeOntologyActions(node).findLast((entry) => entry.id === action.id) !== action) {
    return [];
  }
  return [node];
}

function executableShapeScopes(
  definition: EditableTreeDefinition,
  nodeId: string,
  action?: Record<string, unknown>,
): DefinitionOntologyScope["nodeEntityShapes"][] {
  return executableNodes(definition, nodeId, action).map(
    (candidate) => collectDefinitionOntologyScope(definition, candidate.id).nodeEntityShapes,
  );
}

function executableRelationshipScopes(
  definition: EditableTreeDefinition,
  nodeId: string,
  action?: Record<string, unknown>,
): Set<string>[] {
  return executableNodes(definition, nodeId, action).map((candidate) => {
    const ids = new Set<string>();
    for (const step of [candidate]) {
      for (const relationship of ontologyList(nodeOntologyRecord(step), "relationships")) {
        if (typeof relationship.id === "string") {
          ids.add(relationship.id);
        }
      }
    }
    return ids;
  });
}

function parameterTypeConflicts(
  shapes: DefinitionOntologyScope["nodeEntityShapes"],
  effects: readonly Record<string, unknown>[],
  parameter: { id: string; type: OntologyValueTypeName },
): boolean {
  return effects.some((effect) => {
    if (effect.kind === "read") {
      // A read maps no parameter onto a property.
      return false;
    }
    const shape = typeof effect.entity === "string" ? shapes.get(effect.entity) : undefined;
    // `delete` is included even though planEffect returns before mapping
    // properties: it still resolves its target through the primary-key argument,
    // which validateParameters has already checked against the PARAMETER type, so
    // a key parameter typed against its own property is just as uncallable.
    if (effect.kind === "delete" && shape?.primaryKey !== parameter.id) {
      return false;
    }
    const declared = shape?.propertyTypes.get(parameter.id);
    // Compared by VALUE SHAPE, not by label: `string`, `date`, and `id` are all
    // strings at runtime (expressionTypeOf in ontology-expression.ts), so both
    // validations accept the same values and an `id` property with a `string`
    // parameter is a valid pair the editor must not refuse.
    return (
      declared !== undefined && expressionTypeOf(declared) !== expressionTypeOf(parameter.type)
    );
  });
}

function parameterClashesAnywhere(
  scopes: readonly DefinitionOntologyScope["nodeEntityShapes"][],
  effects: readonly Record<string, unknown>[],
  parameter: { id: string; type: OntologyValueTypeName },
): boolean {
  return effects.some((effect) => {
    if (effect.kind === "read" || typeof effect.entity !== "string") {
      return false;
    }
    const entity = effect.entity;
    return scopes
      .filter((scope) => scope.has(entity))
      .some((scope) => parameterTypeConflicts(scope, [effect], parameter));
  });
}

export function addNodeOntologyActionEffect(
  definition: EditableTreeDefinition,
  nodeId: string,
  actionId: string,
  effect: OntologyEffectDraft,
  actionIndex?: number,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const action = findNodeAction(node, actionId, actionIndex);
  if (!action) {
    return { ok: false, reason: "action-not-found" };
  }
  const declared = Array.isArray(action.effects)
    ? (action.effects as Record<string, unknown>[])
    : [];
  // An action is either outward or local, never both: an external call cannot
  // join the local write transaction, so the import refuses a mixed action
  // (src/enterprise/schema.ts). Refusing here says so at the field instead. The
  // FIRST effect settles which side the action is on, so an empty list accepts
  // either — the clash only exists once something is already declared.
  const mixesOutward =
    effect.kind === "call"
      ? declared.some((existing) => existing.kind !== "call")
      : declared.some((existing) => existing.kind === "call");
  if (mixesOutward) {
    return { ok: false, reason: "effect-mixes-outward" };
  }
  if (effect.kind === "call") {
    const tool = effect.tool.trim();
    if (!tool) {
      return { ok: false, reason: "invalid-id" };
    }
    if (declared.some((existing) => existing.tool === tool)) {
      return { ok: false, reason: "duplicate-entry" };
    }
    const description = optionalTrimmedText(effect.description);
    appendActionEffect(action, declared, {
      kind: "call",
      tool,
      ...(description ? { description } : {}),
    });
    return { ok: true, definition: next };
  }
  // Narrowed by the field, not the kind: the object variant's `kind` is a
  // four-value enum, and excluding all four does not reduce it away. The call
  // lane returned above, so anything without an entity relates two objects.
  if (!("entity" in effect)) {
    const from = optionalTrimmedText(effect.from);
    const to = optionalTrimmedText(effect.to);
    const description = optionalTrimmedText(effect.description);
    if (
      (from !== undefined && !isValidEnterpriseId(from)) ||
      (to !== undefined && !isValidEnterpriseId(to))
    ) {
      return { ok: false, reason: "invalid-id" };
    }
    if (
      !executableRelationshipScopes(next, nodeId, action).every((ids) =>
        ids.has(effect.relationship),
      )
    ) {
      return { ok: false, reason: "relationship-not-found" };
    }
    if (
      declared.some(
        (existing) =>
          existing.kind === effect.kind &&
          existing.relationship === effect.relationship &&
          existing.from === from &&
          existing.to === to,
      )
    ) {
      return { ok: false, reason: "duplicate-entry" };
    }
    appendActionEffect(action, declared, {
      kind: effect.kind,
      relationship: effect.relationship,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(description ? { description } : {}),
    });
    return { ok: true, definition: next };
  }
  const scopes = executableShapeScopes(next, nodeId, action);
  if (!scopes.every((scope) => scope.has(effect.entity))) {
    return { ok: false, reason: "entity-not-found" };
  }
  if (
    effect.kind !== "read" &&
    !scopes.every((scope) => scope.get(effect.entity)?.primaryKey !== undefined)
  ) {
    return { ok: false, reason: "effect-needs-identity" };
  }
  // A create must satisfy every branch's requirements, and a property only a
  // SIBLING marks required is one no parameter here can map — so planEffect
  // refuses the call however the action is written.
  if (effect.kind === "create") {
    const required =
      collectDefinitionOntologyScope(next, nodeId).requiredByEntity.get(effect.entity) ??
      new Set<string>();
    const unreachable = [...required].some((property) =>
      scopes.some((scope) => !scope.get(effect.entity)?.propertyTypes.has(property)),
    );
    if (unreachable) {
      return { ok: false, reason: "create-required-unreachable" };
    }
  }
  const effects = declared;
  if (
    effects.some((existing) => existing.entity === effect.entity && existing.kind === effect.kind)
  ) {
    return { ok: false, reason: "duplicate-entry" };
  }
  // One WRITE per object type. Both effects would derive the same object id from
  // the shared primary-key argument, and invokeOntologyAction refuses an action
  // that touches one object twice (effects carry no order), so the pair saves and
  // then fails on every call. A read alongside a write is still fine.
  if (
    effect.kind !== "read" &&
    effects.some((existing) => existing.entity === effect.entity && existing.kind !== "read")
  ) {
    return { ok: false, reason: "effect-target-taken" };
  }
  const description = optionalTrimmedText(effect.description);
  const added = {
    entity: effect.entity,
    kind: effect.kind,
    ...(description ? { description } : {}),
  };
  // The mirror of the check in addNodeOntologyActionParameter: parameters may be
  // declared before the effect that gives them a target, so the clash has to be
  // caught from whichever side arrives second.
  const declaredParameters = Array.isArray(action.parameters)
    ? (action.parameters as Record<string, unknown>[])
    : [];
  // Checked against the scopes that carry this effect's type, so a descendant
  // contributing the property it writes still counts.
  const clashes = declaredParameters.some(
    (parameter) =>
      typeof parameter.id === "string" &&
      isOntologyValueTypeName(parameter.type) &&
      parameterClashesAnywhere(scopes, [added], { id: parameter.id, type: parameter.type }),
  );
  if (clashes) {
    return { ok: false, reason: "parameter-type-conflict" };
  }
  action.effects = [...effects, added];
  return { ok: true, definition: next };
}

export function removeNodeOntologyActionEffect(
  definition: EditableTreeDefinition,
  nodeId: string,
  actionId: string,
  effect: { actionIndex?: number; effectIndex?: number } & (
    | { entity: string; kind: OntologyEffectKindName }
    | { kind: "call"; tool: string }
    | { kind: "link" | "unlink"; relationship: string }
  ),
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const action = findNodeAction(node, actionId, effect.actionIndex);
  if (!action) {
    return { ok: false, reason: "action-not-found" };
  }
  const effects = Array.isArray(action.effects)
    ? (action.effects as Record<string, unknown>[])
    : [];
  // Each variant is identified by the field it carries: an outward or graph
  // effect has no entity, so the object-effect match would drop every one of them
  // on the action at once.
  const matches = (candidate: Record<string, unknown>, index: number) => {
    if (effect.effectIndex !== undefined && index !== effect.effectIndex) {
      return false;
    }
    if ("entity" in effect) {
      return candidate.entity === effect.entity && candidate.kind === effect.kind;
    }
    if (effect.kind === "call") {
      return candidate.kind === "call" && candidate.tool === effect.tool;
    }
    return candidate.kind === effect.kind && candidate.relationship === effect.relationship;
  };
  if (!effects.some(matches)) {
    return { ok: false, reason: "entry-not-found" };
  }
  const remaining = effects.filter((candidate, index) => !matches(candidate, index));
  if (remaining.length > 0) {
    action.effects = remaining;
  } else {
    delete action.effects;
  }
  return { ok: true, definition: next };
}

/**
 * Declare one input an action accepts.
 *
 * Deliberately NOT restricted to the effect types' properties. A parameter whose
 * id matches a property is written to it, and one that matches nothing is an
 * input to the decision — a rationale, a reason code — that lands in the audit
 * trail instead (src/enterprise/ontology-actions.ts). Refusing the second kind
 * here would block the exact declaration the write path documents.
 */
export function addNodeOntologyActionParameter(
  definition: EditableTreeDefinition,
  nodeId: string,
  actionId: string,
  parameter: {
    id: string;
    type: OntologyValueTypeName;
    required?: boolean;
    description?: string;
  },
  actionIndex?: number,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const action = findNodeAction(node, actionId, actionIndex);
  if (!action) {
    return { ok: false, reason: "action-not-found" };
  }
  const id = parameter.id.trim().toLowerCase();
  if (!isValidEnterpriseId(id)) {
    return { ok: false, reason: "invalid-id" };
  }
  const parameters = Array.isArray(action.parameters)
    ? (action.parameters as Record<string, unknown>[])
    : [];
  // The schema accepts a duplicate id but the write path refuses the CALL
  // (validateParameters), so a second declaration would produce an action nobody
  // can invoke. Caught here instead of at the first invocation.
  if (parameters.some((existing) => existing.id === id)) {
    return { ok: false, reason: "duplicate-entry" };
  }
  const declaredEffects = Array.isArray(action.effects)
    ? (action.effects as Record<string, unknown>[])
    : [];
  if (
    parameterClashesAnywhere(executableShapeScopes(next, nodeId, action), declaredEffects, {
      id,
      type: parameter.type,
    })
  ) {
    return { ok: false, reason: "parameter-type-conflict" };
  }
  const description = optionalTrimmedText(parameter.description);
  action.parameters = [
    ...parameters,
    {
      id,
      type: parameter.type,
      ...(parameter.required === true ? { required: true } : {}),
      ...(description ? { description } : {}),
    },
  ];
  return { ok: true, definition: next };
}

export function removeNodeOntologyActionParameter(
  definition: EditableTreeDefinition,
  nodeId: string,
  actionId: string,
  parameterId: string,
  location?: { actionIndex: number; parameterIndex: number },
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const action = findNodeAction(node, actionId, location?.actionIndex);
  if (!action) {
    return { ok: false, reason: "action-not-found" };
  }
  const parameters = Array.isArray(action.parameters)
    ? (action.parameters as Record<string, unknown>[])
    : [];
  const matches = (parameter: Record<string, unknown>, index: number) =>
    parameter.id === parameterId && (!location || index === location.parameterIndex);
  if (!parameters.some(matches)) {
    return { ok: false, reason: "entry-not-found" };
  }
  const remaining = parameters.filter((parameter, index) => !matches(parameter, index));
  if (remaining.length > 0) {
    action.parameters = remaining;
  } else {
    delete action.parameters;
  }
  return { ok: true, definition: next };
}

/**
 * Declare a derived FUNCTION on a step — the ontology's read verb, the one
 * `compute_function` evaluates.
 *
 * Everything the importer checks tree-wide is checked here against the step's own
 * path, for the reason the module's other adders give: a function resolves at the
 * node it RUNS at, so an expression over a property some other branch declares
 * imports cleanly and then fails mid-run with nothing to point at. The expression
 * is parsed rather than pattern-matched because only the parser can tell a
 * property token from an operator name or a string literal.
 */
export function addNodeOntologyFunction(
  definition: EditableTreeDefinition,
  nodeId: string,
  fn: {
    id: string;
    title?: string;
    description?: string;
    entity: string;
    expression: string;
    returns: OntologyValueTypeName;
  },
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const id = fn.id.trim().toLowerCase();
  if (!isValidEnterpriseId(id)) {
    return { ok: false, reason: "invalid-id" };
  }
  if (ontologyIdCollidesAtNode(next, nodeId, "functions", id)) {
    return { ok: false, reason: "duplicate-entry" };
  }
  const nodeScopes = executableShapeScopes(next, nodeId);
  const shapes = nodeScopes.map((scope) => scope.get(fn.entity));
  if (shapes.length === 0 || shapes.some((shape) => shape === undefined)) {
    return { ok: false, reason: "entity-not-found" };
  }
  const resolvedShapes = shapes.filter((shape) => shape !== undefined);
  const expression = fn.expression.trim();
  const parsed = parseOntologyExpression(expression);
  if (!parsed.ok) {
    return { ok: false, reason: "expression-invalid" };
  }
  const properties = ontologyExpressionProperties(parsed.expression);
  // A descendant may be what completes the type's shape, and the function
  // evaluates in THAT node's merged scope — so one scope carrying every property
  // the expression reads is enough for the definition to be executable.
  if (
    !resolvedShapes.every((shape) =>
      properties.every((property) => shape.propertyTypes.has(property)),
    )
  ) {
    return { ok: false, reason: "expression-property-unknown" };
  }
  // The same two checks the import runs (src/enterprise/schema.ts), in the same
  // order: a dangling property is reported above, because type-checking an
  // expression with one would only restate that in a more confusing way. Without
  // these, a form-valid function such as `$amount >= 10` declared
  // `returns: "number"` saves and then fails the WHOLE-TREE import, so the
  // operator gets a tree-wide error instead of the field that is wrong.
  const typed = resolvedShapes.map((candidate) =>
    inferOntologyExpressionType(parsed.expression, candidate.propertyTypes),
  );
  if (!typed.every((inferred) => inferred.ok)) {
    return { ok: false, reason: "expression-type-invalid" };
  }
  const declaredReturn = expressionTypeOf(fn.returns);
  if (!typed.every((inferred) => inferred.ok && inferred.type === declaredReturn)) {
    return { ok: false, reason: "returns-mismatch" };
  }
  const title = fn.title?.trim();
  const description = optionalTrimmedText(fn.description);
  withOntologyList(node, "functions", [
    ...ontologyList(nodeOntologyRecord(node), "functions"),
    {
      id,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      entity: fn.entity,
      expression,
      returns: fn.returns,
    },
  ]);
  return { ok: true, definition: next };
}

export function removeNodeOntologyFunction(
  definition: EditableTreeDefinition,
  nodeId: string,
  functionId: string,
  functionIndex?: number,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const functions = ontologyList(nodeOntologyRecord(node), "functions");
  const matches = (fn: Record<string, unknown>, index: number) =>
    fn.id === functionId && (functionIndex === undefined || index === functionIndex);
  if (!functions.some(matches)) {
    return { ok: false, reason: "entry-not-found" };
  }
  withOntologyList(
    node,
    "functions",
    functions.filter((fn, index) => !matches(fn, index)),
  );
  const blocker = newBreakageReason(definition, next);
  if (blocker) {
    return { ok: false, reason: blocker };
  }
  return { ok: true, definition: next };
}

export type IndexedIdTarget = { index: number; id: string };

/** Metadata fields that can change without changing an ontology entry's identity. */
export type NodeOntologyMetadataUpdate =
  | {
      kind: "entity";
      target: IndexedIdTarget;
      title?: string;
      description?: string;
    }
  | {
      kind: "property";
      entity: IndexedIdTarget;
      target: IndexedIdTarget & {
        type: OntologyValueTypeName;
        primaryKey: boolean;
      };
      required: boolean;
      description?: string;
    }
  | {
      kind: "relationship";
      target: IndexedIdTarget & {
        from: string;
        to: string;
        cardinality?: OntologyCardinalityName;
      };
      inverse?: string;
      description?: string;
    }
  | {
      kind: "action";
      target: IndexedIdTarget;
      title?: string;
      description?: string;
      tools?: string[];
      preconditions?: string[];
    }
  | {
      kind: "object-effect";
      action: IndexedIdTarget;
      target: { index: number; kind: OntologyEffectKindName; entity: string };
      description?: string;
    }
  | {
      kind: "call-effect";
      action: IndexedIdTarget;
      target: { index: number; kind: "call"; tool: string };
      description?: string;
    }
  | {
      kind: "link-effect";
      action: IndexedIdTarget;
      target: { index: number; kind: "link" | "unlink"; relationship: string };
      description?: string;
      from?: string;
      to?: string;
    }
  | {
      kind: "parameter";
      action: IndexedIdTarget;
      target: IndexedIdTarget & { type: OntologyValueTypeName };
      required: boolean;
      description?: string;
    }
  | {
      kind: "function";
      target: IndexedIdTarget & {
        entity: string;
        expression: string;
        returns: OntologyValueTypeName;
      };
      title?: string;
      description?: string;
    }
  | {
      kind: "constraint";
      target: IndexedIdTarget;
      description: string;
    };

/**
 * Replace only display/governance metadata on one exact ontology record.
 *
 * Index plus immutable identity is deliberate: definitions may contain duplicate
 * ids, and a stale inspector must fail instead of updating whichever duplicate
 * happens to occupy its old array position.
 */
export function updateNodeOntologyMetadata(
  definition: EditableTreeDefinition,
  nodeId: string,
  update: NodeOntologyMetadataUpdate,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const ontology = nodeOntologyRecord(node);
  const actions = nodeOntologyActions(node);
  const exactAction = (target: IndexedIdTarget) =>
    exactIndexedEntry(actions, target.index, (candidate) => candidate.id === target.id);

  switch (update.kind) {
    case "entity": {
      const entity = exactIndexedEntry(
        ontologyList(ontology, "entities"),
        update.target.index,
        (candidate) => candidate.id === update.target.id,
      );
      if (!entity) {
        return { ok: false, reason: "entry-not-found" };
      }
      setOptionalText(entity, "title", update.title);
      setOptionalText(entity, "description", update.description);
      break;
    }
    case "property": {
      const entity = exactIndexedEntry(
        ontologyList(ontology, "entities"),
        update.entity.index,
        (candidate) => candidate.id === update.entity.id,
      );
      const property = entity
        ? exactIndexedEntry(
            Array.isArray(entity.properties)
              ? (entity.properties as Record<string, unknown>[])
              : [],
            update.target.index,
            (candidate) =>
              candidate.id === update.target.id &&
              candidate.type === update.target.type &&
              (candidate.primaryKey === true) === update.target.primaryKey,
          )
        : null;
      if (!property) {
        return { ok: false, reason: "entry-not-found" };
      }
      if (update.required) {
        property.required = true;
      } else {
        delete property.required;
      }
      setOptionalText(property, "description", update.description);
      break;
    }
    case "relationship": {
      const relationship = exactIndexedEntry(
        ontologyList(ontology, "relationships"),
        update.target.index,
        (candidate) =>
          candidate.id === update.target.id &&
          candidate.from === update.target.from &&
          candidate.to === update.target.to &&
          candidate.cardinality === update.target.cardinality,
      );
      if (!relationship) {
        return { ok: false, reason: "entry-not-found" };
      }
      setOptionalText(relationship, "inverse", update.inverse);
      setOptionalText(relationship, "description", update.description);
      break;
    }
    case "action": {
      const action = exactAction(update.target);
      const tools = normalizedNonBlankList(update.tools);
      const preconditions = normalizedNonBlankList(update.preconditions);
      if (!action) {
        return { ok: false, reason: "entry-not-found" };
      }
      if (tools === null || preconditions === null) {
        return { ok: false, reason: "invalid-id" };
      }
      setOptionalText(action, "title", update.title);
      setOptionalText(action, "description", update.description);
      if (tools === undefined) {
        delete action.tools;
      } else {
        action.tools = tools;
      }
      if (preconditions?.length) {
        action.preconditions = preconditions;
      } else {
        delete action.preconditions;
      }
      break;
    }
    case "object-effect": {
      const action = exactAction(update.action);
      const effect = action
        ? exactIndexedEntry(
            Array.isArray(action.effects) ? (action.effects as Record<string, unknown>[]) : [],
            update.target.index,
            (candidate) =>
              candidate.kind === update.target.kind && candidate.entity === update.target.entity,
          )
        : null;
      if (!effect) {
        return { ok: false, reason: "entry-not-found" };
      }
      setOptionalText(effect, "description", update.description);
      break;
    }
    case "call-effect": {
      const action = exactAction(update.action);
      const effect = action
        ? exactIndexedEntry(
            Array.isArray(action.effects) ? (action.effects as Record<string, unknown>[]) : [],
            update.target.index,
            (candidate) =>
              candidate.kind === update.target.kind && candidate.tool === update.target.tool,
          )
        : null;
      if (!effect) {
        return { ok: false, reason: "entry-not-found" };
      }
      setOptionalText(effect, "description", update.description);
      break;
    }
    case "link-effect": {
      const action = exactAction(update.action);
      const effect = action
        ? exactIndexedEntry(
            Array.isArray(action.effects) ? (action.effects as Record<string, unknown>[]) : [],
            update.target.index,
            (candidate) =>
              candidate.kind === update.target.kind &&
              candidate.relationship === update.target.relationship,
          )
        : null;
      if (!effect) {
        return { ok: false, reason: "entry-not-found" };
      }
      const from = optionalTrimmedText(update.from);
      const to = optionalTrimmedText(update.to);
      if (
        (from !== undefined && !isValidEnterpriseId(from)) ||
        (to !== undefined && !isValidEnterpriseId(to))
      ) {
        return { ok: false, reason: "invalid-id" };
      }
      setOptionalText(effect, "description", update.description);
      setOptionalText(effect, "from", from);
      setOptionalText(effect, "to", to);
      break;
    }
    case "parameter": {
      const action = exactAction(update.action);
      const parameter = action
        ? exactIndexedEntry(
            Array.isArray(action.parameters)
              ? (action.parameters as Record<string, unknown>[])
              : [],
            update.target.index,
            (candidate) =>
              candidate.id === update.target.id && candidate.type === update.target.type,
          )
        : null;
      if (!parameter) {
        return { ok: false, reason: "entry-not-found" };
      }
      if (update.required) {
        parameter.required = true;
      } else {
        delete parameter.required;
      }
      setOptionalText(parameter, "description", update.description);
      break;
    }
    case "function": {
      const fn = exactIndexedEntry(
        ontologyList(ontology, "functions"),
        update.target.index,
        (candidate) =>
          candidate.id === update.target.id &&
          candidate.entity === update.target.entity &&
          candidate.expression === update.target.expression &&
          candidate.returns === update.target.returns,
      );
      if (!fn) {
        return { ok: false, reason: "entry-not-found" };
      }
      setOptionalText(fn, "title", update.title);
      setOptionalText(fn, "description", update.description);
      break;
    }
    case "constraint": {
      const constraint = exactIndexedEntry(
        ontologyList(ontology, "constraints"),
        update.target.index,
        (candidate) => candidate.id === update.target.id,
      );
      const description = optionalTrimmedText(update.description);
      if (!constraint) {
        return { ok: false, reason: "entry-not-found" };
      }
      if (!description) {
        return { ok: false, reason: "invalid-id" };
      }
      constraint.description = description;
      break;
    }
  }
  return { ok: true, definition: next };
}

/** Add one operator-readable constraint to this exact step. */
export function addNodeOntologyConstraint(
  definition: EditableTreeDefinition,
  nodeId: string,
  constraint: { id: string; description: string },
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const id = constraint.id.trim().toLowerCase();
  const description = optionalTrimmedText(constraint.description);
  if (!isValidEnterpriseId(id) || !description) {
    return { ok: false, reason: "invalid-id" };
  }
  const constraints = ontologyList(nodeOntologyRecord(node), "constraints");
  if (constraints.some((existing) => existing.id === id)) {
    return { ok: false, reason: "duplicate-entry" };
  }
  withOntologyList(node, "constraints", [...constraints, { id, description }]);
  return { ok: true, definition: next };
}

/** Remove exactly the constraint shown by the inspector, including its array position. */
export function removeNodeOntologyConstraint(
  definition: EditableTreeDefinition,
  nodeId: string,
  target: IndexedIdTarget,
): OntologyEditResult {
  const next = structuredClone(definition);
  const node = findNode(next.root, nodeId);
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }
  const constraints = ontologyList(nodeOntologyRecord(node), "constraints");
  if (!exactIndexedEntry(constraints, target.index, (entry) => entry.id === target.id)) {
    return { ok: false, reason: "entry-not-found" };
  }
  withOntologyList(
    node,
    "constraints",
    constraints.filter((_constraint, index) => index !== target.index),
  );
  return { ok: true, definition: next };
}

type ActionParameterMapping = {
  activeId: string;
  actionKey: string;
  entityId: string;
  parameterId: string;
  mapped: boolean;
};

type ScopedOntologyCheck = {
  activeId: string;
  identity: string;
  reason: Exclude<OntologyBreakageReason, "duplicate-entry">;
  broken: boolean;
};

type OntologyReferenceState = {
  collisions: Set<string>;
  checks: ScopedOntologyCheck[];
  actionParameterMappings: ActionParameterMapping[];
};

function ontologyReferenceState(definition: EditableTreeDefinition): OntologyReferenceState {
  const collisions = new Set<string>();
  const checks: ScopedOntologyCheck[] = [];
  const actionParameterMappings: ActionParameterMapping[] = [];
  const nodes = eachDefinitionNode(definition.root);
  const requiredByEntity = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const entity of ontologyList(nodeOntologyRecord(node), "entities")) {
      if (typeof entity.id !== "string") {
        continue;
      }
      const required = requiredByEntity.get(entity.id) ?? new Set<string>();
      for (const property of Array.isArray(entity.properties)
        ? (entity.properties as Record<string, unknown>[])
        : []) {
        if (property.required === true && typeof property.id === "string") {
          required.add(property.id);
        }
      }
      requiredByEntity.set(entity.id, required);
    }
  }
  const activeNodes = nodes;

  const pathOf = new Map<string, EditableTreeNode[]>();
  const scopeOf = new Map<
    string,
    Map<string, { properties: Map<string, OntologyValueTypeName>; primaryKey?: string }>
  >();
  const visit = (node: EditableTreeNode) => {
    const path = [node];
    pathOf.set(node.id, path);
    const scope = new Map<
      string,
      { properties: Map<string, OntologyValueTypeName>; primaryKey?: string }
    >();
    for (const entity of ontologyList(nodeOntologyRecord(node), "entities")) {
      const id = typeof entity.id === "string" ? entity.id : "";
      if (!id) {
        continue;
      }
      const merged = scope.get(id) ?? {
        properties: new Map<string, OntologyValueTypeName>(),
      };
      for (const property of Array.isArray(entity.properties)
        ? (entity.properties as Record<string, unknown>[])
        : []) {
        if (typeof property.id !== "string") {
          continue;
        }
        merged.properties.set(
          property.id,
          isOntologyValueTypeName(property.type) ? property.type : "string",
        );
        if (property.primaryKey === true && merged.primaryKey === undefined) {
          merged.primaryKey = property.id;
        }
      }
      scope.set(id, merged);
    }
    scopeOf.set(node.id, scope);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(definition.root);

  for (const active of activeNodes) {
    const visible = scopeOf.get(active.id) ?? new Map();
    const path = pathOf.get(active.id) ?? [];
    const record = (identity: string, reason: ScopedOntologyCheck["reason"], broken: boolean) =>
      checks.push({ activeId: active.id, identity, reason, broken });
    // These three kinds resolve LAST-WINS per id along the path. Check only the
    // effective declaration, and record a newly introduced collision separately:
    // a reparent must not silently change which action/function/link runs.
    type EffectiveEntry = { declarationKey: string; entry: Record<string, unknown> };
    const effectiveLinks = new Map<string, EffectiveEntry>();
    const effectiveFunctions = new Map<string, EffectiveEntry>();
    const effectiveActions = new Map<string, EffectiveEntry>();
    for (const owner of path) {
      const ontology = nodeOntologyRecord(owner);
      for (const [kind, entries, effective] of [
        ["relationship", ontologyList(ontology, "relationships"), effectiveLinks],
        ["function", ontologyList(ontology, "functions"), effectiveFunctions],
        ["action", ontologyList(ontology, "actions"), effectiveActions],
      ] as const) {
        const remainingById = new Map<string, number>();
        for (const entry of entries) {
          if (typeof entry.id === "string") {
            remainingById.set(entry.id, (remainingById.get(entry.id) ?? 0) + 1);
          }
        }
        for (const entry of entries) {
          if (typeof entry.id !== "string") {
            continue;
          }
          const ordinal = (remainingById.get(entry.id) ?? 1) - 1;
          remainingById.set(entry.id, ordinal);
          const current = {
            declarationKey: `${owner.id}:${entry.id}:${ordinal}`,
            entry,
          };
          const previous = effective.get(entry.id);
          if (previous) {
            collisions.add(`shadow-${kind}:${previous.declarationKey}:${current.declarationKey}`);
          }
          effective.set(entry.id, current);
        }
      }
    }
    for (const { declarationKey, entry: relationship } of effectiveLinks.values()) {
      for (const side of ["from", "to"] as const) {
        const endpoint = relationship[side];
        record(
          `relationship:${declarationKey}:${side}`,
          "entity-in-use",
          typeof endpoint === "string" && !visible.has(endpoint),
        );
      }
    }

    for (const { declarationKey, entry: fn } of effectiveFunctions.values()) {
      const entity = typeof fn.entity === "string" ? visible.get(fn.entity) : undefined;
      record(`function:${declarationKey}:entity`, "entity-referenced", !entity);
      if (!entity) {
        continue;
      }
      if (typeof fn.expression !== "string") {
        continue;
      }
      const parsed = parseOntologyExpression(fn.expression);
      if (!parsed.ok) {
        continue;
      }
      for (const property of ontologyExpressionProperties(parsed.expression)) {
        record(
          `function:${declarationKey}:property:${property}`,
          "property-in-use",
          !entity.properties.has(property),
        );
      }
    }

    for (const { declarationKey: actionKey, entry: action } of effectiveActions.values()) {
      const effects = Array.isArray(action.effects)
        ? (action.effects as Record<string, unknown>[])
        : [];
      const parameters = Array.isArray(action.parameters)
        ? (action.parameters as Record<string, unknown>[])
        : [];
      const declaredParameters = parameters.filter(
        (parameter): parameter is Record<string, unknown> & { id: string } =>
          typeof parameter.id === "string",
      );
      const parameterById = new Map(
        declaredParameters.map((parameter) => [parameter.id, parameter]),
      );
      record(
        `action:${actionKey}:duplicate-parameters`,
        "property-in-use",
        parameterById.size !== declaredParameters.length,
      );
      record(
        `action:${actionKey}:effects`,
        "property-in-use",
        !effects.some((effect) => effect.kind !== "read"),
      );
      const writtenEntities = new Set<string>();
      for (const [effectIndex, effect] of effects.entries()) {
        const effectKey = `action:${actionKey}:effect:${effectIndex}`;
        // Outward calls resolve no local ontology state.
        if (effect.kind === "call") {
          continue;
        }
        if (effect.kind === "link" || effect.kind === "unlink") {
          const relationship =
            typeof effect.relationship === "string"
              ? effectiveLinks.get(effect.relationship)?.entry
              : undefined;
          record(`${effectKey}:relationship`, "entity-referenced", !relationship);
          if (!relationship) {
            continue;
          }
          const fromEntity = visible.get(relationship.from);
          const toEntity = visible.get(relationship.to);
          const fromParameter =
            typeof effect.from === "string" ? effect.from : fromEntity?.primaryKey;
          const toParameter = typeof effect.to === "string" ? effect.to : toEntity?.primaryKey;
          const ambiguousEndpoints =
            relationship.from === relationship.to && fromParameter === toParameter;
          record(`${effectKey}:endpoints`, "property-in-use", ambiguousEndpoints);
          for (const side of ["from", "to"] as const) {
            const entityId = relationship[side];
            const entity = typeof entityId === "string" ? visible.get(entityId) : undefined;
            record(`${effectKey}:${side}:entity`, "entity-referenced", !entity);
            if (!entity) {
              continue;
            }
            record(`${effectKey}:${side}:key`, "property-in-use", !entity.primaryKey);
            if (!entity.primaryKey) {
              continue;
            }
            const explicitParameter = effect[side];
            const parameterId =
              typeof explicitParameter === "string" ? explicitParameter : entity.primaryKey;
            const parameter = parameterById.get(parameterId);
            const primaryKeyType = entity.properties.get(entity.primaryKey);
            record(`${effectKey}:${side}:parameter`, "property-in-use", !parameter);
            record(
              `${effectKey}:${side}:parameter-type`,
              "property-in-use",
              Boolean(parameter) && (primaryKeyType === "boolean" || parameter?.type === "boolean"),
            );
          }
          continue;
        }
        const entity = typeof effect.entity === "string" ? visible.get(effect.entity) : undefined;
        record(`${effectKey}:entity`, "entity-referenced", !entity);
        if (!entity) {
          continue;
        }
        if (effect.kind === "read") {
          continue;
        }
        record(
          `${effectKey}:duplicate-target`,
          "property-in-use",
          writtenEntities.has(String(effect.entity)),
        );
        writtenEntities.add(String(effect.entity));
        record(`${effectKey}:key`, "property-in-use", entity.primaryKey === undefined);
        if (entity.primaryKey !== undefined) {
          const identityParameter = parameterById.get(entity.primaryKey);
          const identityType = entity.properties.get(entity.primaryKey);
          record(`${effectKey}:key-parameter`, "property-in-use", !identityParameter);
          const identityTypeMismatch =
            identityParameter !== undefined &&
            (identityType === "boolean" ||
              (isOntologyValueTypeName(identityParameter.type) &&
                identityType !== undefined &&
                expressionTypeOf(identityParameter.type) !== expressionTypeOf(identityType)));
          record(`${effectKey}:key-parameter-type`, "property-in-use", identityTypeMismatch);
        }
        if (effect.kind === "create") {
          for (const required of requiredByEntity.get(String(effect.entity)) ?? []) {
            const propertyType = entity.properties.get(required);
            record(
              `${effectKey}:required:${required}:property`,
              "property-in-use",
              propertyType === undefined,
            );
            if (propertyType === undefined) {
              continue;
            }
            const parameter = parameterById.get(required);
            const parameterMismatch =
              parameter !== undefined &&
              isOntologyValueTypeName(parameter.type) &&
              expressionTypeOf(parameter.type) !== expressionTypeOf(propertyType);
            record(
              `${effectKey}:required:${required}:parameter`,
              "property-in-use",
              !parameter || parameterMismatch,
            );
          }
        }
        if (effect.kind === "create" || effect.kind === "update") {
          for (const parameter of parameters) {
            if (typeof parameter.id !== "string" || parameter.id === entity.primaryKey) {
              continue;
            }
            const propertyType = entity.properties.get(parameter.id);
            const parameterType = parameter.type;
            const mapped = propertyType !== undefined;
            actionParameterMappings.push({
              activeId: active.id,
              actionKey,
              entityId: String(effect.entity),
              parameterId: parameter.id,
              mapped,
            });
            record(
              `${effectKey}:parameter:${parameter.id}:type`,
              "property-in-use",
              mapped &&
                isOntologyValueTypeName(parameterType) &&
                expressionTypeOf(propertyType) !== expressionTypeOf(parameterType),
            );
          }
        }
      }
    }
  }
  return { collisions, checks, actionParameterMappings };
}

function newScopedBreakageReasons(
  before: readonly ScopedOntologyCheck[],
  after: readonly ScopedOntologyCheck[],
): Set<ScopedOntologyCheck["reason"]> {
  const reasons = new Set<ScopedOntologyCheck["reason"]>();
  for (const current of after) {
    const previous = before.find(
      (candidate) =>
        candidate.activeId === current.activeId &&
        candidate.identity === current.identity &&
        candidate.reason === current.reason,
    );
    if (current.broken && !previous?.broken) {
      reasons.add(current.reason);
    }
  }
  return reasons;
}

function actionParameterMappingBroke(
  before: readonly ActionParameterMapping[],
  after: readonly ActionParameterMapping[],
): boolean {
  return after.some((current) => {
    if (current.mapped) {
      return false;
    }
    const sameParameter = before.filter(
      (candidate) =>
        candidate.actionKey === current.actionKey &&
        candidate.entityId === current.entityId &&
        candidate.parameterId === current.parameterId,
    );
    if (sameParameter.length === 0) {
      // Never mapped means a rationale/context input, which the runtime keeps in
      // the audit trail rather than writing an object field.
      return false;
    }
    const sameExecution = sameParameter.find(
      (candidate) => candidate.activeId === current.activeId,
    );
    if (sameExecution) {
      return sameExecution.mapped;
    }
    return false;
  });
}

/** The kind of the first break an edit introduced, or null when it introduced none. */
function newBreakageReason(
  before: EditableTreeDefinition,
  after: EditableTreeDefinition,
): OntologyBreakageReason | null {
  const beforeState = ontologyReferenceState(before);
  const afterState = ontologyReferenceState(after);
  const collisionAdded = [...afterState.collisions].some((key) => !beforeState.collisions.has(key));
  if (collisionAdded) {
    return "duplicate-entry";
  }
  const reasons = newScopedBreakageReasons(beforeState.checks, afterState.checks);
  const mappingBroke = actionParameterMappingBroke(
    beforeState.actionParameterMappings,
    afterState.actionParameterMappings,
  );
  if (mappingBroke) {
    reasons.add("property-in-use");
  }
  // A link is the dependency an operator can clear from this editor, so it wins
  // the message; the rest have to be resolved by re-importing the work-map.
  if (reasons.has("entity-in-use")) {
    return "entity-in-use";
  }
  if (reasons.has("entity-referenced")) {
    return "entity-referenced";
  }
  return reasons.has("property-in-use") ? "property-in-use" : null;
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

function findNodeParent(node: EditableTreeNode, id: string): EditableTreeNode | null {
  for (const child of node.children ?? []) {
    if (child.id === id) {
      return node;
    }
    const found = findNodeParent(child, id);
    if (found) {
      return found;
    }
  }
  return null;
}

function detachTreeNode(root: EditableTreeNode, id: string): EditableTreeNode | null {
  const parent = findNodeParent(root, id);
  const index = parent?.children?.findIndex((child) => child.id === id) ?? -1;
  if (!parent?.children || index < 0) {
    return null;
  }
  const [detached] = parent.children.splice(index, 1);
  if (parent.children.length === 0) {
    delete parent.children;
  }
  return detached ?? null;
}
