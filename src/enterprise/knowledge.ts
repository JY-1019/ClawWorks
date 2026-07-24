/**
 * ClawWorks knowledge foundations: a process-local registry of retrieval
 * adapters (one per foundation id) plus the governed, ontology-scoped retrieval
 * entry point the `knowledge_search` tool calls. Which foundations a step may
 * query is an ontology allow-list (per-node `knowledgeFoundations`); config
 * governance policies then deny/audit/gate the foundations that remain in scope.
 *
 * Adapters are registered by bundled adapter plugins (e.g. LightRAG) through the
 * `plugin-sdk/enterprise-knowledge-host` facade, or directly by tests/examples;
 * the registry is import-light so agent hot paths stay cheap.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { evaluateKnowledgeRetrievalGovernance } from "./governance.js";
import { findPlanNode, resolvePlanNodePath } from "./plan.js";
import { getEnterpriseActiveRun, type EnterpriseRunTraceSink } from "./runtime.js";
import type {
  EnterprisePlanNode,
  KnowledgeDocumentRemovalOutcome,
  KnowledgeDocumentUploadOutcome,
  KnowledgeFoundationAdapter,
  KnowledgeFoundationDescriptor,
  KnowledgeFoundationDocument,
  KnowledgeSnippet,
} from "./types.js";

const DEFAULT_KNOWLEDGE_LIMIT = 5;

const log = createSubsystemLogger("enterprise");

// Symbol-keyed global so duplicated dist chunks share one registry (same
// pattern as the enterprise active-run registry).
const FOUNDATIONS_KEY = Symbol.for("openclaw.enterpriseKnowledgeFoundations");

// Bundle-imported foundations live in a SEPARATE registry from plugin-registered
// ones because their lifecycle owner differs: the plugin loader snapshots,
// clears, restores, and caches the plugin registry as a unit (see loader.ts), so
// a bundle foundation stored there would be dropped on a plugin reload. This map
// is owned by the runtime's startup loader and never touched by the plugin
// lifecycle.
//
// Keyed by OWNING tree, then foundation id. Bundle knowledge is workflow-scoped:
// a run may only retrieve a bundle foundation its own tree imported. Keying by
// tree (not a flat id map with a shared owner set) also keeps each tree's content
// separate, so two bundles reusing an id with different snippets never serve one
// another's corpus.
const BUNDLE_FOUNDATIONS_KEY = Symbol.for("openclaw.enterpriseBundleKnowledgeFoundations");

function foundations(): Map<string, KnowledgeFoundationAdapter> {
  const holder = globalThis as { [FOUNDATIONS_KEY]?: Map<string, KnowledgeFoundationAdapter> };
  holder[FOUNDATIONS_KEY] ??= new Map();
  return holder[FOUNDATIONS_KEY];
}

function bundleFoundationsByTree(): Map<string, Map<string, KnowledgeFoundationAdapter>> {
  const holder = globalThis as {
    [BUNDLE_FOUNDATIONS_KEY]?: Map<string, Map<string, KnowledgeFoundationAdapter>>;
  };
  holder[BUNDLE_FOUNDATIONS_KEY] ??= new Map();
  return holder[BUNDLE_FOUNDATIONS_KEY];
}

/** Resolve an adapter by id (global/inspector): a live plugin foundation, else any tree's bundle one. */
function resolveFoundationAdapter(foundationId: string): KnowledgeFoundationAdapter | undefined {
  const plugin = foundations().get(foundationId);
  if (plugin) {
    return plugin;
  }
  for (const perTree of bundleFoundationsByTree().values()) {
    const adapter = perTree.get(foundationId);
    if (adapter) {
      return adapter;
    }
  }
  return undefined;
}

/**
 * Resolve an adapter for retrieval by a run on `treeId`: a live plugin foundation
 * (global, deployment service), else THIS tree's own bundle foundation — never
 * another tree's, even for the same id.
 */
function resolveRetrievalAdapter(
  treeId: string,
  foundationId: string,
): KnowledgeFoundationAdapter | undefined {
  return (
    foundations().get(foundationId) ?? bundleFoundationsByTree().get(treeId)?.get(foundationId)
  );
}

/** Foundation ids a run on `treeId` may retrieve: plugin ids + this tree's bundle ids, sorted. */
function retrievalFoundationIds(treeId: string): string[] {
  const ids = new Set<string>(foundations().keys());
  for (const foundationId of bundleFoundationsByTree().get(treeId)?.keys() ?? []) {
    ids.add(foundationId);
  }
  return [...ids].toSorted();
}

/** All registered foundation ids (plugin + every tree's bundle), deduped and sorted. */
function allFoundationIds(): string[] {
  const ids = new Set<string>(foundations().keys());
  for (const perTree of bundleFoundationsByTree().values()) {
    for (const foundationId of perTree.keys()) {
      ids.add(foundationId);
    }
  }
  return [...ids].toSorted();
}

/** Register (or replace) the adapter for one knowledge foundation id. */
export function registerEnterpriseKnowledgeFoundation(
  foundationId: string,
  adapter: KnowledgeFoundationAdapter,
): void {
  foundations().set(foundationId, adapter);
}

/**
 * Register a bundle-imported foundation owned by `treeId`, keyed under that tree so
 * its content stays isolated from other trees that reuse the id. Kept out of the
 * plugin registry so the plugin loader's clear/restore/cache lifecycle cannot drop
 * it; the runtime's startup loader re-hydrates it from SQLite.
 */
export function registerBundleKnowledgeFoundation(
  treeId: string,
  foundationId: string,
  adapter: KnowledgeFoundationAdapter,
): void {
  const perTree = bundleFoundationsByTree().get(treeId);
  if (perTree) {
    perTree.set(foundationId, adapter);
  } else {
    bundleFoundationsByTree().set(treeId, new Map([[foundationId, adapter]]));
  }
}

/** Clear bundle-imported foundations (test isolation; startup re-registers them). */
export function clearBundleKnowledgeFoundations(): void {
  bundleFoundationsByTree().clear();
}

/**
 * All registered foundation ids (plugin + every bundle) in deterministic order.
 * This is the operator/inspector view; retrieval uses the tree-scoped list so
 * bundle knowledge never leaks across workflows.
 */
export function listEnterpriseKnowledgeFoundationIds(): string[] {
  return allFoundationIds();
}

/** One registry entry, used to snapshot/restore across plugin (de)activation. */
export type EnterpriseKnowledgeFoundationRegistration = {
  foundationId: string;
  adapter: KnowledgeFoundationAdapter;
};

/** Snapshot the registry so the plugin loader can restore it on rollback/reload. */
export function listEnterpriseKnowledgeFoundations(): EnterpriseKnowledgeFoundationRegistration[] {
  return [...foundations().entries()].map(([foundationId, adapter]) => ({ foundationId, adapter }));
}

/** Replace the registry with a snapshot (plugin loader rollback/restore path). */
export function restoreEnterpriseKnowledgeFoundations(
  entries: readonly EnterpriseKnowledgeFoundationRegistration[],
): void {
  const map = foundations();
  map.clear();
  for (const entry of entries) {
    map.set(entry.foundationId, entry.adapter);
  }
}

/** Clear all registered foundations (plugin loader activation reset + tests). */
export function clearEnterpriseKnowledgeFoundations(): void {
  foundations().clear();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One registered foundation with its operator-facing descriptor. */
export type EnterpriseKnowledgeFoundationEntry = {
  foundationId: string;
  descriptor: KnowledgeFoundationDescriptor;
};

/**
 * Every registered foundation with a descriptor, in the same sorted order as
 * `listEnterpriseKnowledgeFoundationIds`. Adapters written against the
 * retrieval-only contract (no `describe`) get a neutral fallback, so the
 * inspector lists them rather than hiding what it cannot introspect.
 */
export function listEnterpriseKnowledgeFoundationDescriptors(): EnterpriseKnowledgeFoundationEntry[] {
  return listEnterpriseKnowledgeFoundationIds().map((foundationId) => ({
    foundationId,
    descriptor: describeFoundation(foundationId),
  }));
}

// The adapter defaults to the global lookup (inspector view); callers with a
// run/export tree pass the tree-scoped adapter so the descriptor matches the same
// tree's content, never another workflow's for a reused id.
function describeFoundation(
  foundationId: string,
  adapter: KnowledgeFoundationAdapter | undefined = resolveFoundationAdapter(foundationId),
): KnowledgeFoundationDescriptor {
  const fallback: KnowledgeFoundationDescriptor = { kind: "remote", displayName: foundationId };
  if (!adapter?.describe) {
    return fallback;
  }
  try {
    return adapter.describe();
  } catch (err) {
    // A plugin-side describe() fault degrades one row to the fallback instead
    // of blanking the whole inspector list (same containment as retrieval).
    log.warn(
      `enterprise knowledge foundation "${foundationId}" describe failed: ${errorMessage(err)}`,
    );
    return fallback;
  }
}

/**
 * Host-level outcome of a connection probe. Wider than the adapter's own
 * `{ok}` because only the host can know an id is unregistered or that the
 * adapter cannot probe at all — the inspector renders those differently from a
 * server that answered "unreachable".
 */
export type KnowledgeFoundationConnectionStatus = {
  status: "ok" | "failed" | "unsupported" | "not-registered";
  detail?: string;
};

/** Probe one foundation's backing service for the operator inspector. */
export async function testEnterpriseKnowledgeFoundationConnection(
  foundationId: string,
): Promise<KnowledgeFoundationConnectionStatus> {
  const adapter = resolveFoundationAdapter(foundationId);
  if (!adapter) {
    return { status: "not-registered" };
  }
  if (!adapter.testConnection) {
    return { status: "unsupported" };
  }
  try {
    const result = await adapter.testConnection();
    return {
      status: result.ok ? "ok" : "failed",
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    };
  } catch (err) {
    // Keep raw adapter errors (which may carry urls/credentials) out of the
    // operator-facing detail; log the specifics out-of-band like retrieval does.
    log.warn(
      `enterprise knowledge foundation "${foundationId}" connection test failed: ${errorMessage(err)}`,
    );
    return { status: "failed", detail: "connection test failed" };
  }
}

/**
 * Host-level document outcome. Like the connection probe, this is wider than
 * the adapter's own result: only the host knows an id is unregistered or that
 * the adapter manages no documents at all.
 */
export type KnowledgeDocumentsOutcome<TValue> =
  | ({ status: "ok" } & TValue)
  | { status: "unsupported" }
  | { status: "read-only" }
  | { status: "not-registered" }
  | { status: "failed"; detail: string };

/**
 * Resolve an adapter and run one document operation against it, mapping the
 * registry/capability misses and adapter faults onto the shared outcome shape.
 * Raw adapter errors stay in the log: they can carry urls and credentials, and
 * these outcomes cross the gateway to an operator screen.
 */
async function withDocumentAdapter<TValue>(
  foundationId: string,
  operation: string,
  run: (adapter: KnowledgeFoundationAdapter) => Promise<TValue> | undefined,
): Promise<KnowledgeDocumentsOutcome<TValue>> {
  const adapter = resolveFoundationAdapter(foundationId);
  if (!adapter) {
    return { status: "not-registered" };
  }
  // `kind` is the authority on who administers a foundation's content, and an
  // adapter can implement document methods for every server it talks to (the
  // LightRAG one does). Enforcing the read-only reading here means a foundation
  // the operator did not claim stays read-only no matter which adapter backs
  // it, rather than depending on each adapter to police itself.
  if (describeFoundation(foundationId).kind !== "local") {
    return { status: "read-only" };
  }
  try {
    // Invoke inside the try: an adapter that throws synchronously (rather than
    // returning a rejected promise) would otherwise escape this catch entirely
    // and hand the gateway a raw error that can carry urls and credentials.
    const pending = run(adapter);
    if (!pending) {
      return { status: "unsupported" };
    }
    return { status: "ok", ...(await pending) };
  } catch (err) {
    log.warn(
      `enterprise knowledge foundation "${foundationId}" ${operation} failed: ${errorMessage(err)}`,
    );
    return { status: "failed", detail: `${operation} failed` };
  }
}

/** A foundation's inlinable content plus its descriptor, for a workflow bundle. */
export type KnowledgeFoundationSnapshot =
  | { status: "ok"; descriptor: KnowledgeFoundationDescriptor; snippets: KnowledgeSnippet[] }
  | { status: "not-registered" }
  | { status: "unsupported" }
  | { status: "failed"; detail: string };

/**
 * Snapshot a foundation's full content for bundling. Only foundations that own
 * their content in-process implement `snapshot()`; server-backed adapters report
 * "unsupported" so the bundle records them as un-inlined rather than shipping
 * partial content. Adapter faults stay contained (they can carry urls/paths).
 */
export async function snapshotEnterpriseKnowledgeFoundation(
  treeId: string,
  foundationId: string,
): Promise<KnowledgeFoundationSnapshot> {
  // Scope to what `treeId` may retrieve (a live plugin foundation, or a bundle one
  // it OWNS): never snapshot another workflow's bundled content into this tree's
  // export, matching what runtime retrieval hides from the tree.
  const adapter = resolveRetrievalAdapter(treeId, foundationId);
  if (!adapter) {
    return { status: "not-registered" };
  }
  if (!adapter.snapshot) {
    return { status: "unsupported" };
  }
  try {
    const snippets = await adapter.snapshot();
    // Same tree-scoped adapter for both content and descriptor, so an export never
    // pairs this tree's snippets with another tree's descriptor for a reused id.
    return { status: "ok", descriptor: describeFoundation(foundationId, adapter), snippets };
  } catch (err) {
    log.warn(
      `enterprise knowledge foundation "${foundationId}" snapshot failed: ${errorMessage(err)}`,
    );
    return { status: "failed", detail: "snapshot failed" };
  }
}

/**
 * Whether a run's tree can retrieve any foundation (a live plugin foundation or a
 * bundle one it owns). Gates whether `knowledge_search` is exposed to the model,
 * so an unrelated workflow does not receive a dead tool after a bundle import for
 * some other tree.
 */
export function runHasRetrievableKnowledgeFoundations(runId: string): boolean {
  const run = getEnterpriseActiveRun(runId);
  return run ? retrievalFoundationIds(run.plan.treeId).length > 0 : false;
}

/** List the documents a foundation holds, for the operator inspector. */
export function listEnterpriseKnowledgeDocuments(
  foundationId: string,
): Promise<KnowledgeDocumentsOutcome<{ documents: KnowledgeFoundationDocument[] }>> {
  return withDocumentAdapter(foundationId, "document list", (adapter) =>
    adapter.listDocuments?.().then((documents) => ({ documents })),
  );
}

/** Upload one operator-supplied document into a foundation. */
export function uploadEnterpriseKnowledgeDocument(
  foundationId: string,
  file: { name: string; content: Uint8Array },
): Promise<KnowledgeDocumentsOutcome<{ result: KnowledgeDocumentUploadOutcome }>> {
  return withDocumentAdapter(foundationId, "document upload", (adapter) =>
    adapter.uploadDocument?.(file).then((result) => ({ result })),
  );
}

/** Remove one document from a foundation. */
export function removeEnterpriseKnowledgeDocument(
  foundationId: string,
  documentId: string,
): Promise<KnowledgeDocumentsOutcome<{ result: KnowledgeDocumentRemovalOutcome }>> {
  return withDocumentAdapter(foundationId, "document removal", (adapter) =>
    adapter.removeDocument?.(documentId).then((result) => ({ result })),
  );
}

/**
 * Whether the active step's ontology allow-list admits a foundation. Each node
 * on the root→active path that declares a non-empty `knowledgeFoundations` set
 * is an independent gate (like tool scope); nodes that omit it don't restrict.
 */
function foundationAllowedByPath(
  path: readonly EnterprisePlanNode[],
  foundationId: string,
): boolean {
  return path.every((node) => {
    const declared = node.ontology.knowledgeFoundations;
    return !declared?.length || declared.includes(foundationId);
  });
}

/** One knowledge foundation a workflow references, with a short summary for routing. */
export type WorkflowKnowledgeFoundation = {
  foundationId: string;
  /** One-line summary of what it covers, when the adapter descriptor supplies one. */
  description?: string;
};

/**
 * The foundations this workflow's tree references (the union of every step's
 * `knowledgeFoundations`), each with a short summary of what it covers. Feeds the
 * `knowledge_search` tool description as a glossary so the model can route a
 * `foundations` target; which foundation a given step is scoped to stays in the
 * step digest, and retrieval enforces the active step's allow-list.
 *
 * Two deliberate choices: (1) the union over ALL steps — not the active node —
 * keeps the list stable for the run (the active node advances per turn while the
 * tool description is frozen at assembly) and scoped to this workflow rather than
 * the whole registry (no cross-tree id leak); (2) only the descriptor's
 * `description` is surfaced — `displayName` is an operator-facing label that
 * adapters were never asked to keep model-safe. Read at tool-assembly time,
 * after runtime plugins register, so the summaries are populated.
 */
export function describeWorkflowKnowledgeFoundations(runId: string): WorkflowKnowledgeFoundation[] {
  const run = getEnterpriseActiveRun(runId);
  if (!run) {
    return [];
  }
  const referenced = new Set<string>();
  for (const node of run.plan.nodes) {
    for (const foundationId of node.ontology.knowledgeFoundations ?? []) {
      referenced.add(foundationId);
    }
  }
  return [...referenced].toSorted().map((foundationId) => {
    // Tree-scoped adapter so the model-facing glossary never shows another
    // workflow's description for a reused foundation id.
    const { description } = describeFoundation(
      foundationId,
      resolveRetrievalAdapter(run.plan.treeId, foundationId),
    );
    return description !== undefined ? { foundationId, description } : { foundationId };
  });
}

/** A foundation the retrieval skipped, with the governance reason. */
export type SkippedKnowledgeFoundation = {
  foundationId: string;
  reason: string;
};

export type KnowledgeRetrievalResult = {
  snippets: KnowledgeSnippet[];
  /** Foundations denied/blocked by governance (not queried). */
  skipped: SkippedKnowledgeFoundation[];
  /** True when the run is enterprise-mediated; false means no scoping was applied. */
  mediated: boolean;
};

/**
 * Retrieve knowledge for the active workflow step: resolve the ontology-allowed
 * foundations in scope, gate each through config governance, and query the
 * registered adapters. Enforce-mode denials (and, lacking an interactive
 * channel here, require_approval decisions) skip the foundation; observe mode
 * records but still queries. Governance decisions are traced via the run sink.
 */
export async function resolveEnterpriseKnowledge(params: {
  runId: string;
  query: string;
  /**
   * Model-supplied targeting: restrict retrieval to these foundation ids. This
   * is a convenience narrowing, never an authority — the step's ontology
   * allow-list still gates every id, so a requested id the step does not permit
   * is reported as skipped, not queried.
   */
  foundations?: string[];
  limit?: number;
  signal?: AbortSignal;
}): Promise<KnowledgeRetrievalResult> {
  const run = getEnterpriseActiveRun(params.runId);
  if (!run) {
    return { snippets: [], skipped: [], mediated: false };
  }
  const node = findPlanNode(run.plan, run.plan.activeNodeId);
  if (!node) {
    return { snippets: [], skipped: [], mediated: true };
  }
  const path = resolvePlanNodePath(run.plan, node.nodeId);
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_KNOWLEDGE_LIMIT;
  const enforce = run.plan.mode === "enforce";
  // Audit inherits down the path like the tool-call gate: an audited root
  // traces default-allowed retrievals from its leaves.
  const auditEnabled = path.some((step) => step.ontology.audit === true);
  // A requested set narrows which allowed foundations are queried; an omitted
  // (undefined) set queries every allowed foundation (unchanged behavior). An
  // explicit empty set is honored as "narrow to nothing", never widened back to
  // all — targeting is a convenience narrowing that must never broaden scope.
  const requested = params.foundations ? new Set(params.foundations) : undefined;

  const snippets: KnowledgeSnippet[] = [];
  const skipped: SkippedKnowledgeFoundation[] = [];
  // Report requested ids the step's ontology forbids before querying: the
  // targeting arg must surface a denial, never silently widen scope past the
  // allow-list. Sorted for a deterministic model-facing order.
  if (requested) {
    for (const foundationId of [...requested].toSorted()) {
      if (!foundationAllowedByPath(path, foundationId)) {
        skipped.push({ foundationId, reason: "not in this step's knowledge allow-list" });
      }
    }
  }
  // Scope to plugin foundations (deployment-wide) plus bundle foundations THIS
  // run's tree owns. A bundle imported for another workflow is invisible here, so
  // its knowledge never leaks into an unrelated run whose ontology omits an
  // allow-list (which the path gate below reads as allow-all).
  for (const foundationId of retrievalFoundationIds(run.plan.treeId)) {
    if (!foundationAllowedByPath(path, foundationId)) {
      continue; // outside the step's ontology allow-list; not a governance denial
    }
    if (requested && !requested.has(foundationId)) {
      continue; // model narrowed the search to a subset that excludes this one
    }
    const decision = evaluateKnowledgeRetrievalGovernance({
      plan: run.plan,
      node,
      foundationId,
      policies: run.policies,
      path,
    });
    // No interactive approval channel inside retrieval, so approval gates fail
    // closed in enforce mode (and record) like a run-start approval would.
    const blocked =
      enforce && (decision.effect === "deny" || decision.effect === "require_approval");
    const traceable = decision.source !== "default" || auditEnabled;
    if (traceable) {
      recordKnowledgeDecision(run.sink, node.nodeId, {
        foundationId,
        effect: decision.effect,
        enforced: blocked,
        policyId: decision.policyId,
        source: decision.source,
        reason: decision.reason,
      });
    }
    if (blocked) {
      skipped.push({ foundationId, reason: decision.reason });
      continue;
    }
    const adapter = resolveRetrievalAdapter(run.plan.treeId, foundationId);
    if (!adapter) {
      continue;
    }
    try {
      const results = await adapter.retrieve({
        foundationId,
        query: params.query,
        limit,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      // Cap at the host boundary: a misbehaving adapter must not exceed the
      // advertised per-foundation limit in the model-facing output.
      snippets.push(...results.slice(0, limit));
    } catch (err) {
      // One foundation's failure (e.g. a down server) skips that foundation
      // rather than failing the whole tool call — but run cancellation still
      // propagates so an aborted run stops instead of masking the abort.
      if (params.signal?.aborted) {
        throw err;
      }
      // Keep raw adapter errors (which may carry urls/paths/credentials) out of
      // the model-facing skipped reason; log the detail out-of-band.
      log.warn(
        `enterprise knowledge foundation "${foundationId}" retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      skipped.push({ foundationId, reason: "retrieval failed" });
    }
  }
  return { snippets, skipped, mediated: true };
}

function recordKnowledgeDecision(
  sink: EnterpriseRunTraceSink | undefined,
  nodeId: string,
  payload: Record<string, unknown>,
): void {
  try {
    sink?.({ kind: "governance.decision", nodeId, payload: { subject: "knowledge", ...payload } });
  } catch {
    // Trace sinks fail open: a persistence fault must never affect retrieval.
  }
}

/**
 * In-memory reference adapter over a fixed snippet set. Serves examples and
 * tests; production foundations come from adapter plugins. Ranks by naive
 * case-insensitive term overlap so `retrieve` is deterministic.
 */
export class InMemoryKnowledgeFoundation implements KnowledgeFoundationAdapter {
  // Only defined when a descriptor is supplied (e.g. a bundle import), so a
  // descriptor-less foundation still falls back to the host's neutral descriptor
  // exactly as before this adapter gained a `describe`.
  readonly describe?: () => KnowledgeFoundationDescriptor;

  constructor(
    private readonly documents: readonly KnowledgeSnippet[],
    descriptor?: KnowledgeFoundationDescriptor,
  ) {
    if (descriptor) {
      this.describe = () => descriptor;
    }
  }

  /** The full content, for bundling. `retrieve` re-stamps the foundation id, so
   *  the ids stored here are irrelevant once re-imported. */
  snapshot(): KnowledgeSnippet[] {
    return this.documents.map((doc) => ({ ...doc }));
  }

  async retrieve(params: {
    foundationId: string;
    query: string;
    limit: number;
  }): Promise<KnowledgeSnippet[]> {
    const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.documents
      .map((doc) => ({ doc, score: overlapScore(doc.text, terms) }))
      .filter((entry) => entry.score > 0)
      .toSorted((a, b) => b.score - a.score || a.doc.text.localeCompare(b.doc.text));
    return scored
      .slice(0, params.limit)
      .map((entry) => rankedSnippet(entry.doc, params.foundationId, entry.score));
  }
}

/** Re-stamp a document with the querying foundation id + rank, dropping unset fields. */
function rankedSnippet(
  doc: KnowledgeSnippet,
  foundationId: string,
  score: number,
): KnowledgeSnippet {
  const snippet: KnowledgeSnippet = { foundationId, text: doc.text, score };
  if (doc.title !== undefined) {
    snippet.title = doc.title;
  }
  if (doc.source !== undefined) {
    snippet.source = doc.source;
  }
  return snippet;
}

function overlapScore(text: string, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const haystack = text.toLowerCase();
  return terms.reduce((count, term) => (haystack.includes(term) ? count + 1 : count), 0);
}
