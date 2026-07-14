import { z } from "zod";
/**
 * Zod schemas and validation for ClawWorks enterprise definitions.
 * Import/export artifacts (workflow trees) validate against the versioned
 * envelope here; config-declared governance policies share the same shapes.
 */
import {
  expressionTypeOf,
  inferOntologyExpressionType,
  ontologyExpressionProperties,
  parseOntologyExpression,
} from "./ontology-expression.js";
import {
  WORKFLOW_TREE_SCHEMA,
  WORKFLOW_TREE_SCHEMA_VERSION,
  type OntologyValueType,
  type WorkflowTreeDefinition,
} from "./types.js";

/** Dotted stable id: lowercase segments separated by dots (taxonomy style). */
const ENTERPRISE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

// Blank entries are rejected everywhere a value feeds the tool-policy glob
// matcher or keyword scoring: the matcher normalizes whitespace away, so a
// blank selector would silently widen a scoped policy into match-everything.
const NonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");

export const EnterpriseIdSchema = z
  .string()
  .regex(
    ENTERPRISE_ID_PATTERN,
    'must be a dotted lowercase id (e.g. "assist.respond"): segments of [a-z0-9-] separated by dots',
  );

export const OntologyValueTypeSchema = z.enum(["string", "number", "boolean", "date", "id"]);

const OntologyPropertySchema = z
  .object({
    id: EnterpriseIdSchema,
    type: OntologyValueTypeSchema,
    primaryKey: z.boolean().optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

const OntologyEntitySchema = z
  .object({
    id: EnterpriseIdSchema,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    properties: z.array(OntologyPropertySchema).optional(),
  })
  .strict()
  .superRefine((entity, ctx) => {
    // A second primary key makes instance identity ambiguous, and duplicate
    // property ids would silently shadow each other in the digest and the UI.
    const seen = new Set<string>();
    let primaryKeys = 0;
    entity.properties?.forEach((property, index) => {
      if (seen.has(property.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["properties", index, "id"],
          message: `duplicate property id "${property.id}"`,
        });
      }
      seen.add(property.id);
      if (property.primaryKey) {
        primaryKeys += 1;
      }
    });
    if (primaryKeys > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["properties"],
        message: "an object type may declare at most one primaryKey property",
      });
    }
  });

export const OntologyCardinalitySchema = z.enum([
  "one-to-one",
  "one-to-many",
  "many-to-one",
  "many-to-many",
]);

const OntologyRelationshipSchema = z
  .object({
    id: EnterpriseIdSchema,
    from: EnterpriseIdSchema,
    to: EnterpriseIdSchema,
    cardinality: OntologyCardinalitySchema.optional(),
    inverse: NonBlankStringSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

const OntologyActionParameterSchema = z
  .object({
    id: EnterpriseIdSchema,
    type: OntologyValueTypeSchema,
    required: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

const OntologyActionEffectSchema = z
  .object({
    entity: EnterpriseIdSchema,
    kind: z.enum(["read", "create", "update", "delete"]),
    description: z.string().optional(),
  })
  .strict();

const OntologyActionSchema = z
  .object({
    id: EnterpriseIdSchema,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    // Omit `tools` to mean "this action covers every tool". An empty array is
    // accepted for load compatibility (it never widens: the governance
    // matcher treats an empty action tool list as covering no tool). Blank
    // entries are still rejected.
    tools: z.array(NonBlankStringSchema).optional(),
    parameters: z.array(OntologyActionParameterSchema).optional(),
    preconditions: z.array(NonBlankStringSchema).optional(),
    effects: z.array(OntologyActionEffectSchema).optional(),
  })
  .strict();

const OntologyFunctionSchema = z
  .object({
    id: EnterpriseIdSchema,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    entity: EnterpriseIdSchema,
    expression: NonBlankStringSchema,
    returns: OntologyValueTypeSchema,
  })
  .strict()
  .superRefine((fn, ctx) => {
    // Parse at import, not at first use: a syntax error must fail the import with
    // a path, not surface mid-run as a computed value that quietly went missing.
    const parsed = parseOntologyExpression(fn.expression);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", path: ["expression"], message: parsed.error });
    }
  });

const OntologyConstraintSchema = z
  .object({
    id: EnterpriseIdSchema,
    description: z.string().min(1),
  })
  .strict();

export const OntologyBindingSchema = z
  .object({
    entities: z.array(OntologyEntitySchema).optional(),
    relationships: z.array(OntologyRelationshipSchema).optional(),
    actions: z.array(OntologyActionSchema).optional(),
    functions: z.array(OntologyFunctionSchema).optional(),
    constraints: z.array(OntologyConstraintSchema).optional(),
    allowedTools: z.array(NonBlankStringSchema).optional(),
    deniedTools: z.array(NonBlankStringSchema).optional(),
    knowledgeFoundations: z.array(EnterpriseIdSchema).optional(),
    contextHints: z.array(NonBlankStringSchema).optional(),
    expectedOutput: z.string().optional(),
    audit: z.boolean().optional(),
  })
  .strict();

type WorkflowNodeShape = {
  id: string;
  title: string;
  description?: string;
  ontology?: z.infer<typeof OntologyBindingSchema>;
  children?: WorkflowNodeShape[];
};

const WorkflowNodeDefinitionSchema: z.ZodType<WorkflowNodeShape> = z.lazy(() =>
  z
    .object({
      id: EnterpriseIdSchema,
      title: z.string().min(1),
      description: z.string().optional(),
      ontology: OntologyBindingSchema.optional(),
      children: z.array(WorkflowNodeDefinitionSchema).optional(),
    })
    .strict(),
);

export const WorkflowTreeTriggerSchema = z.enum(["user", "system", "subagent"]);

const WorkflowTreeMatchSchema = z
  .object({
    // Blank keywords would substring-match every request and hijack selection.
    keywords: z.array(NonBlankStringSchema).min(1).optional(),
    // Empty trigger lists are rejected: omitted means user-triggered, and an
    // empty array would make the tree unselectable for every trigger.
    triggers: z.array(WorkflowTreeTriggerSchema).min(1).optional(),
    priority: z.number().int().optional(),
  })
  .strict();

export const WorkflowTreeDefinitionSchema = z
  .object({
    schema: z.literal(WORKFLOW_TREE_SCHEMA),
    schemaVersion: z.literal(WORKFLOW_TREE_SCHEMA_VERSION),
    id: EnterpriseIdSchema,
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    match: WorkflowTreeMatchSchema.optional(),
    root: WorkflowNodeDefinitionSchema,
  })
  .strict()
  .superRefine((tree, ctx) => {
    // Duplicate node ids silently corrupt plan node attribution and per-node
    // trace grouping, so they are a validation error rather than last-wins.
    const seen = new Set<string>();
    // Object types are declared per node but scoped tree-wide: a deep step may
    // act on a type its ancestor introduced, so collect them all before
    // resolving references.
    //
    // Only action `effects` are checked. Link endpoints are deliberately NOT:
    // trees already imported before this field existed may name an endpoint
    // that was never repeated under `entities` (the UI synthesizes those as
    // implicit object types), and hard-failing them here would make an existing
    // stored tree unloadable — which fails closed in enforce mode. `effects` is
    // a new field, so no stored definition can carry a dangling one, and its
    // reference has to resolve for an action's write scope to be enforceable.
    const declaredEntities = new Set<string>();
    /** Merged shape of each tree-scoped object type, to catch conflicting redeclarations. */
    const entityShapes = new Map<
      string,
      { primaryKey?: string; propertyTypes: Map<string, OntologyValueType> }
    >();
    /** Merged shape of each tree-scoped link type, keyed by "from to id". */
    const relationshipShapes = new Map<string, { cardinality?: string; inverse?: string }>();
    const nodes: { node: WorkflowNodeShape; path: (string | number)[] }[] = [];

    const visit = (node: WorkflowNodeShape, path: (string | number)[]) => {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "id"],
          message: `duplicate workflow node id "${node.id}"`,
        });
      }
      seen.add(node.id);
      nodes.push({ node, path });
      node.ontology?.entities?.forEach((entity, entityIndex) => {
        declaredEntities.add(entity.id);
        // An object type is tree-scoped: redeclaring it on another node adds to
        // the same type rather than making a new one (the graph merges them).
        // So identity and field types must agree ACROSS declarations, not only
        // within one — otherwise a child could redeclare `customer` with a
        // different primaryKey and the merge would pick one arbitrarily.
        const entityPath = [...path, "ontology", "entities", entityIndex];
        const shape = entityShapes.get(entity.id) ?? {
          propertyTypes: new Map<string, OntologyValueType>(),
        };
        for (const property of entity.properties ?? []) {
          const knownType = shape.propertyTypes.get(property.id);
          if (knownType && knownType !== property.type) {
            ctx.addIssue({
              code: "custom",
              path: [...entityPath, "properties"],
              message: `object type "${entity.id}" declares property "${property.id}" as both "${knownType}" and "${property.type}"`,
            });
          }
          shape.propertyTypes.set(property.id, property.type);
          if (property.primaryKey) {
            if (shape.primaryKey && shape.primaryKey !== property.id) {
              ctx.addIssue({
                code: "custom",
                path: [...entityPath, "properties"],
                message: `object type "${entity.id}" declares two primary keys across the tree ("${shape.primaryKey}" and "${property.id}"); its identity would be ambiguous`,
              });
            }
            shape.primaryKey = property.id;
          }
        }
        entityShapes.set(entity.id, shape);
      });
      // Link types are tree-scoped too, and the graph dedupes them by
      // [from, to, id] keeping the first. So a child re-declaring the same link
      // with a different cardinality or inverse would be silently ignored and
      // the UI would show metadata that contradicts the definition.
      node.ontology?.relationships?.forEach((relationship, relationshipIndex) => {
        // Same key the graph dedupes on, so validation and rendering agree.
        const key = JSON.stringify([relationship.from, relationship.to, relationship.id]);
        const known = relationshipShapes.get(key);
        if (!known) {
          relationshipShapes.set(key, {
            cardinality: relationship.cardinality,
            inverse: relationship.inverse,
          });
          return;
        }
        const relationshipPath = [...path, "ontology", "relationships", relationshipIndex];
        for (const field of ["cardinality", "inverse"] as const) {
          const before = known[field];
          const now = relationship[field];
          if (before !== undefined && now !== undefined && before !== now) {
            ctx.addIssue({
              code: "custom",
              path: [...relationshipPath, field],
              message: `link "${relationship.id}" declares ${field} as both "${before}" and "${now}"`,
            });
          }
          if (before === undefined && now !== undefined) {
            known[field] = now;
          }
        }
      });
      node.children?.forEach((child, index) => {
        visit(child, [...path, "children", index]);
      });
    };
    visit(tree.root, ["root"]);

    for (const { node, path } of nodes) {
      node.ontology?.actions?.forEach((action, index) => {
        action.effects?.forEach((effect, effectIndex) => {
          if (!declaredEntities.has(effect.entity)) {
            ctx.addIssue({
              code: "custom",
              path: [...path, "ontology", "actions", index, "effects", effectIndex, "entity"],
              message: `action "${action.id}" effect references undeclared object type "${effect.entity}"`,
            });
          }
        });
      });
      // A function's expression is checked against the MERGED tree-wide shape of
      // its object type, so a deep step may compute over a property its ancestor
      // declared. Resolving refs here (not at call time) is the whole point: an
      // unresolvable `$property` is a definition bug, and finding it at import
      // beats returning a null from compute_function in the middle of a run.
      node.ontology?.functions?.forEach((fn, index) => {
        const functionPath = [...path, "ontology", "functions", index];
        const shape = entityShapes.get(fn.entity);
        if (!shape) {
          ctx.addIssue({
            code: "custom",
            path: [...functionPath, "entity"],
            message: `function "${fn.id}" computes over undeclared object type "${fn.entity}"`,
          });
          return;
        }
        const parsed = parseOntologyExpression(fn.expression);
        if (!parsed.ok) {
          // The field-level refine already reported the syntax error.
          return;
        }
        let refsResolve = true;
        for (const property of ontologyExpressionProperties(parsed.expression)) {
          if (!shape.propertyTypes.has(property)) {
            refsResolve = false;
            ctx.addIssue({
              code: "custom",
              path: [...functionPath, "expression"],
              message: `function "${fn.id}" reads "$${property}", which object type "${fn.entity}" does not declare`,
            });
          }
        }
        if (!refsResolve) {
          // Type-checking an expression with a dangling ref would only restate
          // the error above in a more confusing way.
          return;
        }
        // Type-check against the declared property types, then against `returns`.
        // Skipping this would leave `returns` a label nobody enforces: a boolean
        // expression could claim `returns: string`, and the gateway would project
        // that lie to every client until something finally evaluated it.
        const inferred = inferOntologyExpressionType(parsed.expression, shape.propertyTypes);
        if (!inferred.ok) {
          ctx.addIssue({
            code: "custom",
            path: [...functionPath, "expression"],
            message: `function "${fn.id}": ${inferred.error}`,
          });
          return;
        }
        const declared = expressionTypeOf(fn.returns);
        if (inferred.type !== declared) {
          ctx.addIssue({
            code: "custom",
            path: [...functionPath, "returns"],
            message: `function "${fn.id}" declares returns "${fn.returns}" (${declared}), but its expression yields ${inferred.type}`,
          });
        }
      });
    }
  });

export const GovernanceEffectSchema = z.enum(["allow", "deny", "audit", "require_approval"]);

// Empty selector arrays are rejected rather than treated as omitted: the
// evaluator reads missing subject selectors as "run-level policy", so an
// empty array would silently flip a scoped policy into a run-wide one.
const GovernanceSelectorSchema = z
  .array(NonBlankStringSchema)
  .min(1, "omit the selector instead of passing an empty array")
  .optional();

const GovernanceApprovalSettingsSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    timeoutBehavior: z.enum(["allow", "deny"]).optional(),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  })
  .strict()
  .optional();

export const GovernancePolicySchema = z
  .object({
    id: EnterpriseIdSchema,
    description: z.string().optional(),
    effect: GovernanceEffectSchema,
    trees: GovernanceSelectorSchema,
    nodes: GovernanceSelectorSchema,
    tools: GovernanceSelectorSchema,
    actions: GovernanceSelectorSchema,
    knowledge: GovernanceSelectorSchema,
    approval: GovernanceApprovalSettingsSchema,
  })
  .strict();

export type WorkflowTreeValidationIssue = {
  /** Dot-path to the invalid value (config-issue style). */
  path: string;
  message: string;
};

export type WorkflowTreeValidationResult =
  | { ok: true; tree: WorkflowTreeDefinition }
  | { ok: false; issues: WorkflowTreeValidationIssue[] };

/** Validate an untrusted workflow tree definition (import path, tests, config). */
export function validateWorkflowTreeDefinition(value: unknown): WorkflowTreeValidationResult {
  const parsed = WorkflowTreeDefinitionSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, tree: parsed.data as WorkflowTreeDefinition };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}
