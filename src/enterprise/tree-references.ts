/**
 * Pure helpers that read what a workflow tree references from its node ontology:
 * knowledge foundation ids and tool globs. Shared by bundle-io (to build/validate
 * a bundle) and the tree store (to keep persisted bundled foundations in sync with
 * the tree's current references), kept in its own module so neither has to import
 * the other.
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

/**
 * Whether the tree can retrieve ANY registered foundation, not just the ids it
 * names. A per-node `knowledgeFoundations` allow-list is a path gate ANDed down
 * root→node (see foundationAllowedByPath): an empty or omitted list is
 * unrestricted (allow-all). The root sits on every path, so it is the upper
 * bound — if the root omits its allow-list, retrieval at the root reads as
 * allow-all and the whole tree is unbounded, however its descendants scope. Used
 * to warn that a bundle export cannot capture the implicit set.
 */
export function treeHasUnboundedKnowledgeScope(tree: WorkflowTreeDefinition): boolean {
  return !tree.root.ontology?.knowledgeFoundations?.length;
}

/**
 * Tool globs the tree's nodes require available (their allow-lists), sorted. Only
 * allowed tools are a portability requirement: they name what the workflow expects
 * the target to provide. Denied tools are constraints — blocking a tool the target
 * lacks is a no-op — so they are not collected.
 */
export function collectReferencedToolGlobs(tree: WorkflowTreeDefinition): string[] {
  const tools = new Set<string>();
  walkWorkflowNodes(tree.root, (node) => {
    for (const tool of node.ontology?.allowedTools ?? []) {
      tools.add(tool);
    }
  });
  return [...tools].toSorted();
}
