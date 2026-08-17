/**
 * Non-fatal authoring checks for a workflow tree: capabilities a step DECLARES
 * that its own tool scope can never reach.
 *
 * These are separate from schema validation because they are not shape errors —
 * every tree here parses, imports, and runs. They are work-maps that cannot do
 * what they say, and the runtime cannot tell the difference: the digest hands
 * the model a step's `Actions:` list, the model calls one, and the gate refuses
 * it. The turn is spent arguing with a declaration nobody could honor.
 *
 * That is not hypothetical. Every shipped example carried it: 31 of the 32
 * declared actions across them were unreachable, and a live run on the incident
 * example answered by INVENTING an incident id, because the action that would
 * have created one was advertised but denied.
 *
 * Warnings, never errors. An operator's already-imported work-map must keep
 * loading, and only the author can decide whether the fix is to grant the tool
 * or to drop the declaration.
 */
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import type { WorkflowNodeDefinition, WorkflowTreeDefinition } from "./types.js";

export type WorkflowTreeWarning = {
  /** Dot-path to the offending declaration, matching validation issue style. */
  path: string;
  message: string;
};

/**
 * Does every allow-list on this root→node path admit `toolName`?
 *
 * Mirrors the gate's PASS 2 (governance.ts): an allow-list is an INTERSECTION
 * across the whole path, so an ancestor that narrows without naming the tool
 * closes it for every descendant, no matter what the leaf grants. A node with
 * no list narrows nothing.
 *
 * Deliberately ignores the core floor and `deniedTools`: the floor never covers
 * the tools checked here, and a denial can only make the answer more negative.
 */
function pathAdmitsTool(path: readonly WorkflowNodeDefinition[], toolName: string): boolean {
  for (const node of path) {
    const allow = node.ontology?.allowedTools;
    if (allow?.length && !isToolAllowedByPolicyName(toolName, { allow: [...allow] })) {
      return false;
    }
  }
  return true;
}

/**
 * Under `capabilityGrants: "explicit"`, silence denies: some level has to NAME
 * the tool. Without it, a tree whose steps declare no allow-lists at all would
 * look permissive here and deny at runtime.
 */
function pathNamesTool(path: readonly WorkflowNodeDefinition[], toolName: string): boolean {
  return path.some((node) => {
    const allow = node.ontology?.allowedTools;
    return Boolean(allow?.length && isToolAllowedByPolicyName(toolName, { allow: [...allow] }));
  });
}

function canUseTool(
  path: readonly WorkflowNodeDefinition[],
  toolName: string,
  grantsExplicitly: boolean,
): boolean {
  if (!pathAdmitsTool(path, toolName)) {
    return false;
  }
  return grantsExplicitly ? pathNamesTool(path, toolName) : true;
}

/**
 * The primary-key property of each object type this node can address: its own
 * declarations merged with every ancestor's, which is how governance merges the
 * root→node path. Entities are declared by the domain that owns them, so a
 * node's own list is rarely the whole scope.
 */
function primaryKeysInScope(path: readonly WorkflowNodeDefinition[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const node of path) {
    for (const entity of node.ontology?.entities ?? []) {
      const primaryKey = entity.properties?.find((property) => property.primaryKey);
      if (primaryKey) {
        keys.set(entity.id, primaryKey.id);
      }
    }
  }
  return keys;
}

/** Collect every unreachable-capability warning in one tree. */
export function collectWorkflowTreeWarnings(tree: WorkflowTreeDefinition): WorkflowTreeWarning[] {
  const warnings: WorkflowTreeWarning[] = [];
  const grantsExplicitly = tree.capabilityGrants === "explicit";

  const visit = (node: WorkflowNodeDefinition, ancestors: readonly WorkflowNodeDefinition[]) => {
    const path = [...ancestors, node];
    const ontology = node.ontology;
    const primaryKeys = primaryKeysInScope(path);

    const actions = ontology?.actions ?? [];
    if (actions.length > 0 && !canUseTool(path, "invoke_action", grantsExplicitly)) {
      warnings.push({
        path: `node.${node.id}.ontology.actions`,
        message:
          `step "${node.id}" declares ${actions.length === 1 ? "action" : "actions"} ` +
          `${actions.map((action) => `"${action.id}"`).join(", ")} but its tool scope cannot ` +
          `reach invoke_action, so the model is shown an action every call will refuse. ` +
          `Add invoke_action to this step's ontology.allowedTools (and to every ancestor ` +
          `that narrows tools), or drop the declaration.`,
      });
    }

    for (const action of actions) {
      // The effects ARE the write scope (ontology-actions.ts): invoke_action
      // refuses an action that declares none, so such an action can only ever
      // be an instruction the model cannot carry out.
      const writes = (action.effects ?? []).filter((effect) => effect.kind !== "read");
      if (writes.length === 0) {
        warnings.push({
          path: `node.${node.id}.ontology.actions.${action.id}.effects`,
          message:
            `action "${action.id}" on step "${node.id}" declares no write effects, so ` +
            `invoke_action cannot change any object with it. Give it a create/update/delete ` +
            `effect, or describe the work in the step's description instead of as an action.`,
        });
      }
      // A create effect mints a NEW object, so the call has to be able to name
      // it. Without the target type's primary key among the parameters there is
      // no id to write under and every invocation fails validation — an action
      // that only LOOKS executable.
      const parameterIds = new Set((action.parameters ?? []).map((parameter) => parameter.id));
      for (const effect of writes) {
        if (effect.kind !== "create") {
          continue;
        }
        const primaryKey = primaryKeys.get(effect.entity);
        if (primaryKey && !parameterIds.has(primaryKey)) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.parameters`,
            message:
              `action "${action.id}" on step "${node.id}" creates a "${effect.entity}" but takes ` +
              `no "${primaryKey}" parameter, so no call can name the object it creates and every ` +
              `invocation fails validation. Add { id: ${primaryKey}, type: id, required: true }.`,
          });
        }
      }
    }

    if (
      (ontology?.knowledgeFoundations?.length ?? 0) > 0 &&
      !canUseTool(path, "knowledge_search", grantsExplicitly)
    ) {
      warnings.push({
        path: `node.${node.id}.ontology.knowledgeFoundations`,
        message:
          `step "${node.id}" attaches a knowledge foundation but its tool scope cannot reach ` +
          `knowledge_search, so nothing on this step can retrieve from it.`,
      });
    }

    for (const child of node.children ?? []) {
      visit(child, path);
    }
  };

  visit(tree.root, []);
  return warnings;
}
