/** Non-fatal checks for declarations this executable step cannot use locally. */
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import {
  expressionTypeOf,
  ontologyExpressionProperties,
  parseOntologyExpression,
} from "./ontology-expression.js";
import {
  collectTreeRequiredProperties,
  mergeOntologyDeclarations,
  type OntologyDeclarations,
} from "./ontology-runtime.js";
import type {
  OntologyActionParameter,
  OntologyLinkEffect,
  OntologyObjectEffect,
  WorkflowNodeDefinition,
  WorkflowTreeDefinition,
} from "./types.js";

export type WorkflowTreeWarning = {
  /** Dot-path to the offending declaration, matching validation issue style. */
  path: string;
  message: string;
};

/**
 * The literal opt-ins that let a step perform an ontology WRITE
 * (runtime.ts ONTOLOGY_WRITE_OPT_INS). Set membership, NOT glob matching: a
 * scope of `invoke_*` satisfies the ordinary tool gate and is still refused
 * here, so the linter has to compare the same way or it blesses a dead action.
 */
const WRITE_OPT_INS = new Set(["invoke_action", "group:enterprise-write"]);

function canUseTool(node: WorkflowNodeDefinition, toolName: string, explicit: boolean): boolean {
  const allow = node.ontology?.allowedTools ?? [];
  const deny = node.ontology?.deniedTools ?? [];
  if (explicit && allow.length === 0) {
    return false;
  }
  return isToolAllowedByPolicyName(toolName, { allow, deny });
}

function canWrite(node: WorkflowNodeDefinition, explicit: boolean): boolean {
  const optedIn = (node.ontology?.allowedTools ?? []).some((tool) =>
    WRITE_OPT_INS.has(tool.trim().toLowerCase()),
  );
  return optedIn && canUseTool(node, "invoke_action", explicit);
}

function treeNodes(node: WorkflowNodeDefinition): WorkflowNodeDefinition[] {
  return [node, ...(node.children ?? []).flatMap(treeNodes)];
}

function linkEffectResolves(
  scope: OntologyDeclarations,
  effect: OntologyLinkEffect,
  parameters: ReadonlyMap<string, OntologyActionParameter>,
): boolean {
  const relationship = scope.relationships.get(effect.relationship);
  if (!relationship) {
    return false;
  }
  const fromKey = scope.entities
    .get(relationship.from)
    ?.properties?.find((property) => property.primaryKey);
  const toKey = scope.entities
    .get(relationship.to)
    ?.properties?.find((property) => property.primaryKey);
  const fromParameterId = effect.from ?? fromKey?.id;
  const toParameterId = effect.to ?? toKey?.id;
  if (relationship.from === relationship.to && fromParameterId === toParameterId) {
    return false;
  }
  return (["from", "to"] as const).every((side) => {
    const key = scope.entities
      .get(relationship[side])
      ?.properties?.find((property) => property.primaryKey);
    const parameter = key ? parameters.get(effect[side] ?? key.id) : undefined;
    return Boolean(
      key &&
      key.type !== "boolean" &&
      parameter &&
      expressionTypeOf(parameter.type) === expressionTypeOf(key.type),
    );
  });
}

/** Collect every unreachable-capability warning in one tree. */
export function collectWorkflowTreeWarnings(tree: WorkflowTreeDefinition): WorkflowTreeWarning[] {
  const warnings: WorkflowTreeWarning[] = [];
  const explicit = tree.capabilityGrants === "explicit";
  const treeEntities = mergeOntologyDeclarations(treeNodes(tree.root)).entities;
  const treeRequired = collectTreeRequiredProperties(tree);

  const visit = (node: WorkflowNodeDefinition) => {
    const ontology = node.ontology;
    const scope = mergeOntologyDeclarations([node]);
    const writable = canWrite(node, explicit);
    const actions = [...scope.actions.values()];
    const localActions = actions.filter(
      (action) => !writable && (action.effects ?? []).some((effect) => effect.kind !== "call"),
    );
    if (localActions.length > 0) {
      warnings.push({
        path: `node.${node.id}.ontology.actions`,
        message:
          `step "${node.id}" declares ${localActions.length === 1 ? "action" : "actions"} ` +
          `${localActions.map((action) => `"${action.id}"`).join(", ")} but cannot perform an ontology write. ` +
          `Name invoke_action literally in this step's ontology.allowedTools (invoke_* alone does not opt into writes), ` +
          `and do not deny it — or drop the declaration.`,
      });
    }

    for (const action of actions) {
      const effects = action.effects ?? [];
      const writes = effects
        .filter((effect): effect is OntologyObjectEffect => "entity" in effect)
        .filter((effect) => effect.kind !== "read");
      const linkEffects = effects.filter(
        (effect): effect is OntologyLinkEffect =>
          effect.kind === "link" || effect.kind === "unlink",
      );
      const hasOtherEffect = effects.some(
        (effect) => effect.kind !== "read" && !("entity" in effect),
      );
      if (writes.length === 0 && !hasOtherEffect) {
        warnings.push({
          path: `node.${node.id}.ontology.actions.${action.id}.effects`,
          message:
            `action "${action.id}" on step "${node.id}" declares no write effects, so ` +
            `invoke_action cannot change any object with it. Give it a create/update/delete ` +
            `effect, or describe the work in the step's description instead of as an action.`,
        });
      }
      const parameters = new Map(
        (action.parameters ?? []).map((parameter) => [parameter.id, parameter]),
      );
      if (parameters.size !== (action.parameters ?? []).length) {
        warnings.push({
          path: `node.${node.id}.ontology.actions.${action.id}.parameters`,
          message: `action "${action.id}" on step "${node.id}" declares a parameter id more than once, so every invocation fails validation. Keep one declaration per parameter id.`,
        });
      }
      for (const effect of linkEffects) {
        if (!linkEffectResolves(scope, effect, parameters)) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.effects`,
            message:
              `action "${action.id}" on step "${node.id}" cannot resolve both ends of relationship ` +
              `"${effect.relationship}" on this step. Keep the relationship and both keyed ` +
              `object types on the same step, and declare distinct string/number endpoint parameters when needed.`,
          });
        }
      }
      // EVERY write kind, not just create: planEffect resolves and validates the
      // target's primary key before it branches on the kind.
      for (const effect of writes) {
        const entity = scope.entities.get(effect.entity);
        if (!entity) {
          if (!writable || !treeEntities.has(effect.entity)) {
            continue; // The schema reports undeclared tree-wide types; write opt-in was reported above.
          }
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.effects`,
            message:
              `action "${action.id}" on step "${node.id}" ${effect.kind}s a "${effect.entity}", but ` +
              `this step does not declare that object type locally, ` +
              `so every invocation fails. Declare "${effect.entity}" on the same step as ` +
              `the write grant, or move the action to a step where the type is in scope.`,
          });
          continue;
        }
        const primaryKey = entity.properties?.find((property) => property.primaryKey);
        if (!primaryKey) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.effects`,
            message:
              `action "${action.id}" on step "${node.id}" ${effect.kind}s a "${effect.entity}", but ` +
              `this step does not declare that object type with a primaryKey, ` +
              `so every invocation fails. Give "${effect.entity}" a primaryKey property on the same ` +
              `step as the write grant.`,
          });
          continue;
        }
        const parameter = parameters.get(primaryKey.id);
        if (!parameter) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.parameters`,
            message:
              `action "${action.id}" on step "${node.id}" ${effect.kind}s a "${effect.entity}" but ` +
              `takes no "${primaryKey.id}" parameter, so no call can name the object it writes and ` +
              `every invocation fails validation. Add { id: ${primaryKey.id}, type: ${primaryKey.type}, required: true }.`,
          });
        } else if (
          primaryKey.type === "boolean" ||
          expressionTypeOf(parameter.type) !== expressionTypeOf(primaryKey.type)
        ) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.parameters`,
            message:
              `action "${action.id}" on step "${node.id}" cannot use parameter "${primaryKey.id}" ` +
              `(${parameter.type}) as the ${primaryKey.type} primaryKey of "${effect.entity}". ` +
              `Object identities must be strings or numbers and the parameter must match the property type.`,
          });
        }
        if (effect.kind === "create") {
          const required = treeRequired.get(effect.entity) ?? new Set<string>();
          const properties = new Map(
            (entity.properties ?? []).map((property) => [property.id, property.type]),
          );
          const canSupplyRequired = [...required].every((id) => {
            const propertyType = properties.get(id);
            const requiredParameter = parameters.get(id);
            return (
              propertyType &&
              requiredParameter &&
              expressionTypeOf(requiredParameter.type) === expressionTypeOf(propertyType)
            );
          });
          if (!canSupplyRequired) {
            warnings.push({
              path: `node.${node.id}.ontology.actions.${action.id}.parameters`,
              message:
                `action "${action.id}" on step "${node.id}" cannot supply every required property of ` +
                `"${effect.entity}" on this step. Declare compatible parameters for its required properties.`,
            });
          }
        }
      }
    }

    for (const fn of scope.functions.values()) {
      const entity = scope.entities.get(fn.entity);
      const properties = new Set((entity?.properties ?? []).map((property) => property.id));
      const parsed = parseOntologyExpression(fn.expression);
      if (
        !entity ||
        (parsed.ok &&
          ontologyExpressionProperties(parsed.expression).some((id) => !properties.has(id)))
      ) {
        warnings.push({
          path: `node.${node.id}.ontology.functions.${fn.id}`,
          message: `function "${fn.id}" needs its object type and referenced fields declared on step "${node.id}". Preceding and later steps do not supply its scope.`,
        });
      }
    }

    const attached = ontology?.knowledgeFoundations ?? [];
    if (attached.length > 0) {
      if (!canUseTool(node, "knowledge_search", explicit)) {
        warnings.push({
          path: `node.${node.id}.ontology.knowledgeFoundations`,
          message:
            `step "${node.id}" attaches a knowledge foundation but cannot ` +
            `reach knowledge_search, so nothing there can retrieve from it.`,
        });
      }
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  visit(tree.root);
  return warnings;
}
