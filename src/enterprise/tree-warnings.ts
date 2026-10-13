/**
 * Non-fatal authoring checks for a workflow tree: capabilities a step DECLARES
 * that no run could ever reach.
 *
 * These are not shape errors — every tree here parses, imports, and runs. They
 * are work-maps that cannot do what they say, and the runtime cannot tell the
 * difference: the digest hands the model a step's `Actions:` list, the model
 * calls one, and the gate refuses it. The turn is spent arguing with a
 * declaration nobody could honor. Every shipped example carried it: 31 of the 32
 * declared actions were unreachable, and a live run answered by INVENTING an
 * incident id because the action that would have created one was advertised and
 * then denied.
 *
 * WHAT MAKES THIS SUBTLE. A declaration is inherited DOWN, but the gate judges
 * the root→ACTIVE path, and runs are active on leaves. So an action declared on
 * an interior node is reachable when some executable leaf beneath it supplies
 * the grant — judging the declaring node's own path alone reports working
 * work-maps as broken. Every check therefore asks: does ANY executable leaf path
 * through this node admit the capability?
 *
 * Warnings, never errors. An operator's already-imported work-map must keep
 * loading, and only the author can decide whether the fix is to grant the tool
 * or to drop the declaration.
 */
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import { expressionTypeOf } from "./ontology-expression.js";
import {
  collectTreeRequiredProperties,
  mergeOntologyPath,
  type OntologyPathScope,
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

type Path = readonly WorkflowNodeDefinition[];

function allowList(node: WorkflowNodeDefinition): readonly string[] | undefined {
  const allow = node.ontology?.allowedTools;
  // An empty list neither narrows nor grants — the gate tests `allow?.length` on
  // both sides, so treating [] as a narrowing would invent a denial.
  return allow?.length ? allow : undefined;
}

/** PASS 1: an explicit denial anywhere on the path outranks every allow. */
function pathDenies(path: Path, toolName: string): boolean {
  return path.some((node) => {
    const deny = node.ontology?.deniedTools;
    if (!deny?.length) {
      return false;
    }
    return !isToolAllowedByPolicyName(toolName, { deny: [...deny] });
  });
}

/** PASS 2: allow-lists INTERSECT across the path; a node with none narrows nothing. */
function pathAdmits(path: Path, toolName: string): boolean {
  return path.every((node) => {
    const allow = allowList(node);
    return !allow || isToolAllowedByPolicyName(toolName, { allow: [...allow] });
  });
}

/** PASS 3: under explicit grants, silence denies — some level must NAME it. */
function pathNames(path: Path, toolName: string): boolean {
  return path.some((node) => {
    const allow = allowList(node);
    return Boolean(allow) && isToolAllowedByPolicyName(toolName, { allow: [...(allow ?? [])] });
  });
}

/**
 * The knowledge gate, mirroring foundationAllowedByPath in knowledge.ts: each
 * level that declares a non-empty list is an independent narrowing, so a path
 * admits an id only when every declaring node on it names that id. The
 * existential half of the explicit-grant rule needs no separate pass here — the
 * node under inspection names the id itself, so some level always does.
 */
function pathAdmitsFoundation(path: Path, foundationId: string): boolean {
  return path.every((node) => {
    const declared = node.ontology?.knowledgeFoundations;
    return !declared?.length || declared.includes(foundationId);
  });
}

/** The ontology write opt-in: literal, and existential over the path. */
function pathOptsIntoWrites(path: Path): boolean {
  return path.some((node) =>
    (node.ontology?.allowedTools ?? []).some((tool) =>
      WRITE_OPT_INS.has(tool.trim().toLowerCase()),
    ),
  );
}

function canUseTool(path: Path, toolName: string, grantsExplicitly: boolean): boolean {
  if (pathDenies(path, toolName) || !pathAdmits(path, toolName)) {
    return false;
  }
  return grantsExplicitly ? pathNames(path, toolName) : true;
}

/** Can this path perform an ontology write? Both gates, in the runtime's order. */
function canWrite(path: Path, grantsExplicitly: boolean): boolean {
  return pathOptsIntoWrites(path) && canUseTool(path, "invoke_action", grantsExplicitly);
}

/**
 * Every root→leaf path that can be ACTIVE while this node's declarations apply.
 * A leaf contributes its own path; an interior node contributes one path per
 * descendant leaf, because the run executes on leaves and inherits downward.
 */
function executablePaths(path: Path): Path[] {
  const node = path[path.length - 1];
  const children = node?.children ?? [];
  if (children.length === 0) {
    return [path];
  }
  return children.flatMap((child) => executablePaths([...path, child]));
}

function linkEffectResolves(
  scope: OntologyPathScope,
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
  const treeNodes = executablePaths([tree.root]).flat();
  const treeEntities = mergeOntologyPath(treeNodes).entities;
  const treeRequired = collectTreeRequiredProperties(tree);

  const visit = (node: WorkflowNodeDefinition, ancestors: Path) => {
    const path: Path = [...ancestors, node];
    const ontology = node.ontology;
    const paths = executablePaths(path);
    const scopedPaths = paths.map((candidate) => ({
      path: candidate,
      scope: mergeOntologyPath(candidate),
    }));

    const actions = ontology?.actions ?? [];
    const pathsByAction = new Map(
      actions.map((action) => [
        action,
        scopedPaths.filter(({ scope }) => scope.actions.get(action.id) === action),
      ]),
    );
    // Only the actions that go through invoke_action need the write opt-in. An
    // outward action IS the tool call the model makes, so requiring invoke_action
    // for it would demand a grant it never uses.
    const localActions = actions.filter((action) => {
      const actionPaths = pathsByAction.get(action) ?? [];
      return (
        actionPaths.length > 0 &&
        (action.effects ?? []).some((effect) => effect.kind !== "call") &&
        !actionPaths.some((candidate) => canWrite(candidate.path, explicit))
      );
    });
    if (localActions.length > 0) {
      warnings.push({
        path: `node.${node.id}.ontology.actions`,
        message:
          `step "${node.id}" declares ${localActions.length === 1 ? "action" : "actions"} ` +
          `${localActions.map((action) => `"${action.id}"`).join(", ")} but no step that runs ` +
          `under it can perform an ontology write, so the model is shown an action every call ` +
          `will refuse. Name invoke_action literally in ontology.allowedTools here or on a step ` +
          `beneath it (a glob such as invoke_* does not opt into writes), keep every ancestor's ` +
          `allow-list from excluding it, and do not deny it — or drop the declaration.`,
      });
    }

    for (const action of actions) {
      const actionPaths = pathsByAction.get(action) ?? [];
      if (actionPaths.length === 0) {
        continue;
      }
      const writablePaths = actionPaths.filter((candidate) => canWrite(candidate.path, explicit));
      const candidatePaths = writablePaths.length > 0 ? writablePaths : actionPaths;
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
        if (
          !candidatePaths.some((candidate) =>
            linkEffectResolves(candidate.scope, effect, parameters),
          )
        ) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.effects`,
            message:
              `action "${action.id}" on step "${node.id}" cannot resolve both ends of relationship ` +
              `"${effect.relationship}" on any executable write path. Keep the relationship and both keyed ` +
              `object types on the same path, and declare distinct string/number endpoint parameters when needed.`,
          });
        }
      }
      // EVERY write kind, not just create: planEffect resolves and validates the
      // target's primary key before it branches on the kind.
      for (const effect of writes) {
        const entityPaths = candidatePaths.filter((candidate) =>
          candidate.scope.entities.has(effect.entity),
        );
        if (entityPaths.length === 0) {
          if (writablePaths.length === 0 || !treeEntities.has(effect.entity)) {
            continue; // The schema reports an object type undeclared tree-wide.
          }
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.effects`,
            message:
              `action "${action.id}" on step "${node.id}" ${effect.kind}s a "${effect.entity}", but ` +
              `no executable step under it both allows ontology writes and has that object type in scope, ` +
              `so every invocation fails. Declare "${effect.entity}" on the same root-to-leaf path as ` +
              `the write grant, or move the action to a step where the type is in scope.`,
          });
          continue;
        }
        const primaryKey = entityPaths
          .map((candidate) =>
            candidate.scope.entities
              .get(effect.entity)
              ?.properties?.find((property) => property.primaryKey),
          )
          .find((key) => key !== undefined);
        if (!primaryKey) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.effects`,
            message:
              `action "${action.id}" on step "${node.id}" ${effect.kind}s a "${effect.entity}", but ` +
              `no executable step that can perform the write sees that object type with a primaryKey, ` +
              `so every invocation fails. Give "${effect.entity}" a primaryKey property on the same ` +
              `root-to-leaf path as the write grant.`,
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
          const canSupplyRequired = entityPaths.some((candidate) => {
            const properties = new Map(
              (candidate.scope.entities.get(effect.entity)?.properties ?? []).map((property) => [
                property.id,
                property.type,
              ]),
            );
            return [...required].every((id) => {
              const propertyType = properties.get(id);
              const requiredParameter = parameters.get(id);
              return Boolean(
                propertyType &&
                requiredParameter &&
                expressionTypeOf(requiredParameter.type) === expressionTypeOf(propertyType),
              );
            });
          });
          if (!canSupplyRequired) {
            warnings.push({
              path: `node.${node.id}.ontology.actions.${action.id}.parameters`,
              message:
                `action "${action.id}" on step "${node.id}" cannot supply every required property of ` +
                `"${effect.entity}" on any executable write path. Declare compatible parameters for its required properties.`,
            });
          }
        }
      }
    }

    const attached = ontology?.knowledgeFoundations ?? [];
    if (attached.length > 0) {
      const searchablePaths = paths.filter((candidate) =>
        canUseTool(candidate, "knowledge_search", explicit),
      );
      // Ordered, not both: reaching the tool is the prerequisite for the
      // allow-list to mean anything, so naming two fixes for one declaration
      // would read as two problems. Granting the tool re-runs these checks and
      // surfaces the scope half if it is still wrong.
      if (searchablePaths.length === 0) {
        warnings.push({
          path: `node.${node.id}.ontology.knowledgeFoundations`,
          message:
            `step "${node.id}" attaches a knowledge foundation but no step that runs under it can ` +
            `reach knowledge_search, so nothing there can retrieve from it.`,
        });
      } else {
        const unreachable = [...new Set(attached)].filter(
          (foundationId) =>
            !searchablePaths.some((candidate) => pathAdmitsFoundation(candidate, foundationId)),
        );
        if (unreachable.length > 0) {
          // The allow-list INTERSECTS down the path, so an ancestor that names other
          // sources silently excludes each unreachable attachment. A reachable
          // sibling used to hide that dead source because the check asked whether
          // any attachment worked instead of checking every declared foundation.
          warnings.push({
            path: `node.${node.id}.ontology.knowledgeFoundations`,
            message:
              `step "${node.id}" attaches ${unreachable.map((id) => `"${id}"`).join(", ")}, but no ` +
              `step that runs under it can retrieve ${unreachable.length === 1 ? "that source" : "those sources"} — ` +
              `knowledge allow-lists intersect down the path. Add ${unreachable.length === 1 ? "it" : "them"} ` +
              `to every restricting ancestor's ontology.knowledgeFoundations, or remove the unreachable attachment.`,
          });
        }
      }
    }

    for (const child of node.children ?? []) {
      visit(child, path);
    }
  };

  visit(tree.root, []);
  return warnings;
}
