/**
 * Pure helpers that read what a workflow tree references from its node ontology:
 * knowledge foundation ids and tool globs. Shared by bundle-io (to build/validate
 * a bundle) and the persisted-foundation loader (to expose only content referenced
 * by a healthy current tree), kept in its own module so neither has to duplicate
 * the traversal.
 */
import type { WorkflowNodeDefinition, WorkflowTreeDefinition } from "./types.js";

/** Visit every node on a tree (root first, then children depth-first). */
export function walkWorkflowNodes(
  node: WorkflowNodeDefinition,
  visit: (node: WorkflowNodeDefinition) => void,
): void {
  visit(node);
  for (const child of node.children ?? []) {
    walkWorkflowNodes(child, visit);
  }
}

/** Knowledge foundation ids the tree's nodes explicitly reference (allow-lists), sorted. */
export function collectReferencedFoundationIds(tree: WorkflowTreeDefinition): string[] {
  const ids = new Set<string>();
  walkWorkflowNodes(tree.root, (node) => {
    for (const id of node.ontology?.knowledgeFoundations ?? []) {
      ids.add(id);
    }
  });
  return [...ids].toSorted();
}

/** Any permissive step without a local list can retrieve unlisted foundations. */
export function treeHasUnboundedKnowledgeScope(tree: WorkflowTreeDefinition): boolean {
  if (tree.capabilityGrants === "explicit") {
    return false;
  }
  let unbounded = false;
  walkWorkflowNodes(tree.root, (node) => {
    unbounded ||= !node.ontology?.knowledgeFoundations?.length;
  });
  return unbounded;
}

/**
 * Tool selectors the tree requires available, sorted: allow-lists plus outward
 * action call effects. Denied tools are constraints — blocking a tool the target
 * lacks is a no-op — so they are not collected.
 */
export function collectReferencedToolGlobs(tree: WorkflowTreeDefinition): string[] {
  const tools = new Set<string>();
  walkWorkflowNodes(tree.root, (node) => {
    for (const tool of node.ontology?.allowedTools ?? []) {
      tools.add(tool);
    }
    for (const action of node.ontology?.actions ?? []) {
      for (const effect of action.effects ?? []) {
        if (effect.kind === "call") {
          tools.add(effect.tool);
        }
      }
    }
  });
  return [...tools].toSorted();
}

/**
 * Skill ids the tree's nodes name as dependencies (their `skills` declarations),
 * sorted. A portability requirement like tool globs: they record the know-how the
 * workflow expects the target to provide. Content is not inlined — the bundle
 * reports the names so a target missing a skill is visible, not silently degraded.
 */
export function collectReferencedSkills(tree: WorkflowTreeDefinition): string[] {
  const skills = new Set<string>();
  walkWorkflowNodes(tree.root, (node) => {
    for (const skill of node.ontology?.skills ?? []) {
      skills.add(skill);
    }
  });
  return [...skills].toSorted();
}

/**
 * MCP servers the tree attaches. A portability dependency like skills: the bundle
 * carries the NAMES so an import can say which `mcp.servers` entries the recipient
 * still has to register — an attachment naming a server nobody configured is inert.
 */
export function collectReferencedMcpServers(tree: WorkflowTreeDefinition): string[] {
  const servers = new Set<string>();
  walkWorkflowNodes(tree.root, (node) => {
    for (const server of node.ontology?.mcpServers ?? []) {
      servers.add(server);
    }
  });
  return [...servers].toSorted();
}
