/**
 * Shipped EXAMPLE knowledge foundation for the built-in customer-support
 * work-map. Without it the example's `knowledgeFoundations` entry is a dangling
 * reference: the Knowledge screen lists nothing on a fresh install, and an
 * operator who adopts the example gets a `knowledge_search` that can never
 * return a snippet — so there is no way to tell a working retrieval path from an
 * unregistered one.
 *
 * Registered TREE-SCOPED (the bundle registry), never the global plugin
 * registry: a global foundation is retrievable by every workflow whose step
 * omits a `knowledgeFoundations` allow-list, which would expose
 * `knowledge_search` on stock installs and change default prompt bytes. Scoped
 * to the example's own tree id, only a run bound to that tree can retrieve it —
 * and adopting the example means importing it under the same id.
 */
import { BUILTIN_SUPPORT_EXAMPLE_TREE } from "./builtin-trees.js";
import { InMemoryKnowledgeFoundation, registerBundleKnowledgeFoundation } from "./knowledge.js";
import type { KnowledgeSnippet } from "./types.js";

/**
 * Foundation id the built-in support example's nodes name in their allow-list.
 * Example-scoped ON PURPOSE: an operator's production foundation registers under
 * an id of their own, so a plugin that fails to load can never be shadowed by this
 * corpus — retrieval reports their id as unavailable instead of quietly answering
 * with stock refund and escalation policy.
 */
export const BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID = "clawworks.support-kb.example";

// Example policy corpus. Deliberately the kind of unstructured prose a knowledge
// foundation holds (policy, thresholds, escalation paths) rather than the typed
// objects the ontology owns, so the two roles stay distinguishable in the UI.
const SUPPORT_KB_SNIPPETS: readonly KnowledgeSnippet[] = [
  {
    foundationId: BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    title: "Refund window",
    source: "handbook/refunds.md",
    text: "Refunds are issued for any order within 30 days of delivery. Past 30 days, offer store credit instead. A refund over $200 needs human approval before it is issued.",
  },
  {
    foundationId: BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    title: "Damaged and missing deliveries",
    source: "handbook/refunds.md",
    text: "A damaged or missing delivery is refunded in full regardless of the 30-day window. Ask for a photo when the customer reports damage, but never make the refund conditional on receiving one.",
  },
  {
    foundationId: BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    title: "Shipping targets",
    source: "handbook/shipping.md",
    text: "Standard shipping is quoted at 3-5 business days, express at 1-2. An order is late once it passes the quoted window by two business days; late orders get a shipping-cost refund without approval.",
  },
  {
    foundationId: BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    title: "Escalation path",
    source: "handbook/escalation.md",
    text: "Escalate to a human agent when the customer asks for one, when a refund exceeds $200, when the same order has been reopened three times, or when the request involves a chargeback or legal threat.",
  },
  {
    foundationId: BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    title: "Payment data handling",
    source: "handbook/privacy.md",
    text: "Never repeat a full payment card number back to a customer or into a ticket. The last four digits are enough to confirm which card was charged.",
  },
  {
    foundationId: BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    title: "Tone",
    source: "handbook/replies.md",
    text: "Open by naming what went wrong in the customer's own terms, say what you did about it, then say what happens next and when. Keep replies short; do not apologize more than once.",
  },
];

/**
 * Register the shipped example foundations into the bundle registry. Called by
 * the bundle loader, which owns that registry's lifecycle (it clears and rebuilds
 * on reload), so the examples survive a reload exactly like the persisted rows do.
 *
 * `isClaimedByOperator` reports tuples an operator's own import owns. A claimed
 * tuple is skipped even when its persisted content could not be read: serving the
 * stock refund/escalation corpus in place of an operator's unreadable production
 * one would silently answer `knowledge_search` with example policy instead of
 * surfacing the foundation as unavailable.
 */
export function registerBuiltinExampleKnowledgeFoundations(
  isClaimedByOperator: (treeId: string, foundationId: string) => boolean = () => false,
): void {
  if (
    isClaimedByOperator(BUILTIN_SUPPORT_EXAMPLE_TREE.id, BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID)
  ) {
    return;
  }
  registerBundleKnowledgeFoundation(
    BUILTIN_SUPPORT_EXAMPLE_TREE.id,
    BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    new InMemoryKnowledgeFoundation(SUPPORT_KB_SNIPPETS, {
      // "remote" (not "local"): the content ships with the install and is not a
      // store this deployment administers, so the inspector must not offer
      // document upload/removal that has nowhere to write.
      kind: "remote",
      displayName: "Customer support handbook (example)",
      detail: "shipped example content",
      description:
        "Refund windows, shipping targets, and escalation rules for the customer-support example work-map.",
    }),
  );
}
