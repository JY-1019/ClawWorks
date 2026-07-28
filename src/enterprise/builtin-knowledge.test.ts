import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
  registerBuiltinExampleKnowledgeFoundations,
} from "./builtin-knowledge.js";
import { BUILTIN_SUPPORT_EXAMPLE_TREE, BUILTIN_WORKFLOW_TREES } from "./builtin-trees.js";
import {
  clearBundleKnowledgeFoundations,
  listEnterpriseKnowledgeFoundationDescriptors,
  snapshotEnterpriseKnowledgeFoundation,
} from "./knowledge.js";
import { collectReferencedFoundationIds, walkWorkflowNodes } from "./tree-references.js";

afterEach(() => {
  clearBundleKnowledgeFoundations();
});

describe("shipped example knowledge foundation", () => {
  it("registers every foundation the built-in trees reference", () => {
    registerBuiltinExampleKnowledgeFoundations();
    const registered = new Set(
      listEnterpriseKnowledgeFoundationDescriptors().map((entry) => entry.foundationId),
    );
    // A referenced-but-unregistered id is an inert example: knowledge_search can
    // never answer for it and the Knowledge screen shows nothing.
    for (const tree of BUILTIN_WORKFLOW_TREES) {
      for (const foundationId of collectReferencedFoundationIds(tree)) {
        expect(registered).toContain(foundationId);
      }
    }
  });

  it("stays scoped to the example tree that references it", async () => {
    registerBuiltinExampleKnowledgeFoundations();
    const own = await snapshotEnterpriseKnowledgeFoundation(
      BUILTIN_SUPPORT_EXAMPLE_TREE.id,
      BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    );
    expect(own.status).toBe("ok");
    if (own.status === "ok") {
      expect(own.snippets.length).toBeGreaterThan(0);
      expect(own.descriptor.kind).toBe("remote");
    }
    // Registered against one tree, so an unrelated workflow cannot retrieve it —
    // this is what keeps knowledge_search off stock runs bound to other trees.
    const other = await snapshotEnterpriseKnowledgeFoundation(
      "acme.unrelated",
      BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    );
    expect(other.status).toBe("not-registered");
  });

  it("reports the owning tree so inspectors do not read it as deployment-wide", () => {
    registerBuiltinExampleKnowledgeFoundations();
    const entry = listEnterpriseKnowledgeFoundationDescriptors().find(
      (candidate) => candidate.foundationId === BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    );
    // Bundle-owned: retrieval resolves it for this tree alone, so a client that
    // treated the flat list as global would offer it to unrelated work-maps.
    expect(entry?.ownerTreeIds).toEqual([BUILTIN_SUPPORT_EXAMPLE_TREE.id]);
  });

  it("gives the support example steps declared skills to inspect", () => {
    const declared: string[] = [];
    walkWorkflowNodes(BUILTIN_SUPPORT_EXAMPLE_TREE.root, (node) => {
      declared.push(...(node.ontology?.skills ?? []));
    });
    // The example exists to be inspected, so it has to show what a skill
    // declaration looks like on a fresh install.
    expect(declared.length).toBeGreaterThan(0);
  });
});
