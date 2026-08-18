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
import type { WorkflowNodeDefinition, WorkflowTreeDefinition } from "./types.js";

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

/** Primary key per object type declared on these nodes; null when it has none. */
function primaryKeys(nodes: readonly WorkflowNodeDefinition[]): Map<string, string | null> {
  const keys = new Map<string, string | null>();
  for (const node of nodes) {
    for (const entity of node.ontology?.entities ?? []) {
      const key = entity.properties?.find((property) => property.primaryKey);
      keys.set(entity.id, key?.id ?? null);
    }
  }
  return keys;
}

/** Collect every unreachable-capability warning in one tree. */
export function collectWorkflowTreeWarnings(tree: WorkflowTreeDefinition): WorkflowTreeWarning[] {
  const warnings: WorkflowTreeWarning[] = [];
  const explicit = tree.capabilityGrants === "explicit";

  const visit = (node: WorkflowNodeDefinition, ancestors: Path) => {
    const path: Path = [...ancestors, node];
    const ontology = node.ontology;
    const paths = executablePaths(path);
    // Object types reachable from here: the scope chain above plus whatever the
    // subtree adds, since the active path runs through one of those leaves.
    const keys = primaryKeys(paths.flat());

    const actions = ontology?.actions ?? [];
    if (actions.length > 0 && !paths.some((candidate) => canWrite(candidate, explicit))) {
      warnings.push({
        path: `node.${node.id}.ontology.actions`,
        message:
          `step "${node.id}" declares ${actions.length === 1 ? "action" : "actions"} ` +
          `${actions.map((action) => `"${action.id}"`).join(", ")} but no step that runs under it ` +
          `can perform an ontology write, so the model is shown an action every call will refuse. ` +
          `Name invoke_action literally in ontology.allowedTools here or on a step beneath it ` +
          `(a glob such as invoke_* does not opt into writes), keep every ancestor's allow-list ` +
          `from excluding it, and do not deny it — or drop the declaration.`,
      });
    }

    for (const action of actions) {
      // The effects ARE the write scope (ontology-actions.ts): invoke_action
      // refuses an action that declares none.
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
      const parameterIds = new Set((action.parameters ?? []).map((parameter) => parameter.id));
      // EVERY write kind, not just create: planEffect resolves and validates the
      // target's primary key before it branches on the kind, so an update or a
      // delete without it fails exactly as a create does.
      for (const effect of writes) {
        if (!keys.has(effect.entity)) {
          continue; // Declared on a sibling branch; the schema checks effects tree-wide.
        }
        const primaryKey = keys.get(effect.entity) ?? null;
        if (primaryKey === null) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.effects`,
            message:
              `action "${action.id}" on step "${node.id}" ${effect.kind}s a "${effect.entity}", but ` +
              `that object type declares no primaryKey, so no action can address an instance of it ` +
              `and every invocation fails. Give "${effect.entity}" a primaryKey property.`,
          });
          continue;
        }
        if (!parameterIds.has(primaryKey)) {
          warnings.push({
            path: `node.${node.id}.ontology.actions.${action.id}.parameters`,
            message:
              `action "${action.id}" on step "${node.id}" ${effect.kind}s a "${effect.entity}" but ` +
              `takes no "${primaryKey}" parameter, so no call can name the object it writes and ` +
              `every invocation fails validation. Add { id: ${primaryKey}, type: id, required: true }.`,
          });
        }
      }
    }

    if (
      (ontology?.knowledgeFoundations?.length ?? 0) > 0 &&
      !paths.some((candidate) => canUseTool(candidate, "knowledge_search", explicit))
    ) {
      warnings.push({
        path: `node.${node.id}.ontology.knowledgeFoundations`,
        message:
          `step "${node.id}" attaches a knowledge foundation but no step that runs under it can ` +
          `reach knowledge_search, so nothing there can retrieve from it.`,
      });
    }

    for (const child of node.children ?? []) {
      visit(child, path);
    }
  };

  visit(tree.root, []);
  return warnings;
}
