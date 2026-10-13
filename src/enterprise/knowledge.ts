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
import { findPlanNode } from "./plan.js";
import {
  getEnterpriseActiveRun,
  type EnterpriseActiveRun,
  type EnterpriseRunTraceSink,
} from "./runtime.js";
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

/**
 * Register (or replace) the adapter for one knowledge foundation id.
 *
 * A replacement is warned about rather than refused: the registry is a plain
 * last-write-wins map, and a collision has no single owner to reject it — two
 * adapter plugins can each claim an id in good faith, and the loader's own
 * snapshot/restore legitimately re-registers what is already there. What must not
 * happen silently is the operator case: every step wired to that id now queries a
 * different corpus than the one they scoped it to, and nothing downstream can
 * tell, because both stores answer under the same name.
 */
export function registerEnterpriseKnowledgeFoundation(
  foundationId: string,
  adapter: KnowledgeFoundationAdapter,
): void {
  const registry = foundations();
  const previous = registry.get(foundationId);
  if (previous && previous !== adapter) {
    log.warn(
      `enterprise knowledge foundation "${foundationId}" was registered twice; the later registration wins and every step scoped to that id now queries it`,
    );
  }
  registry.set(foundationId, adapter);
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
  /**
   * The one tree whose bundle owns this row. EMPTY means a plugin registered the
   * id — that registry is global, so every tree can retrieve it. The same id can
   * therefore have several bundle rows with different descriptors, one per tree.
   * Always populated here; omission is reserved for old gateway clients so they
   * can tell "global" from "unknown".
   */
  ownerTreeIds: string[];
};

/**
 * Every registered foundation with a descriptor, sorted by id then owning tree.
 * Bundle rows stay separate because two trees may reuse an id for different
 * corpora and descriptors. A global plugin registration outranks all bundle rows
 * for the same id, matching retrieval. Adapters written against the retrieval-only
 * contract (no `describe`) get a neutral fallback.
 */
export function listEnterpriseKnowledgeFoundationDescriptors(): EnterpriseKnowledgeFoundationEntry[] {
  const entries: EnterpriseKnowledgeFoundationEntry[] = [];
  const bundleTrees = [...bundleFoundationsByTree()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const foundationId of listEnterpriseKnowledgeFoundationIds()) {
    const plugin = foundations().get(foundationId);
    if (plugin) {
      entries.push({
        foundationId,
        descriptor: describeFoundation(foundationId, plugin),
        ownerTreeIds: [],
      });
      continue;
    }
    for (const [treeId, perTree] of bundleTrees) {
      const adapter = perTree.get(foundationId);
      if (adapter) {
        entries.push({
          foundationId,
          descriptor: describeFoundation(foundationId, adapter),
          ownerTreeIds: [treeId],
        });
      }
    }
  }
  return entries;
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

function routableFoundationIds(run: EnterpriseActiveRun): string[] {
  const grantsExplicitly = run.plan.capabilityGrants === "explicit";
  const paths = run.plan.nodes.map((node) => [node]);
  // retrievalFoundationIds is sorted and filter preserves order, so the glossary
  // and the gate stay deterministic without re-sorting.
  return retrievalFoundationIds(run.plan.treeId).filter((foundationId) =>
    paths.some((path) => foundationAllowedByPath(path, foundationId, grantsExplicitly)),
  );
}

/**
 * Whether a run can retrieve any foundation. Gates whether `knowledge_search` is
 * exposed to the model, so an unrelated workflow does not receive a dead tool
 * after a bundle import for some other tree, and a work-map whose every step
 * excludes what is registered does not receive one that can only come back empty.
 */
export function runHasRetrievableKnowledgeFoundations(runId: string): boolean {
  const run = getEnterpriseActiveRun(runId);
  return run ? routableFoundationIds(run).length > 0 : false;
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

function foundationAllowedByPath(
  path: readonly EnterprisePlanNode[],
  foundationId: string,
  grantsExplicitly = false,
): boolean {
  const narrowed = path.every((node) => {
    const declared = node.ontology.knowledgeFoundations;
    return !declared?.length || declared.includes(foundationId);
  });
  if (!narrowed || !grantsExplicitly) {
    return narrowed;
  }
  return path.some((node) => node.ontology.knowledgeFoundations?.includes(foundationId) === true);
}

/** One knowledge foundation a workflow references, with a short summary for routing. */
export type WorkflowKnowledgeFoundation = {
  foundationId: string;
  /** One-line summary of what it covers, when the adapter descriptor supplies one. */
  description?: string;
};

/**
 * The foundations this run can route to, each with a short summary of what it
 * covers. Feeds the `knowledge_search` tool description as a glossary so the
 * model can pick a `foundations` target per query; which of them a given step is
 * scoped to stays in the step digest, and retrieval enforces the active step's
 * allow-list.
 *
 * The ROUTABLE set (registry ∩ what some executable path admits), not the union
 * of what the steps name. Naming is not the same as reaching: a step that
 * declares no allow-list can query every registered foundation, so reading the
 * declarations alone left a multi-store deployment with an empty glossary and no
 * way for the model to target anything — while a declaration nobody registered
 * advertised a source every call would come back empty from. Same list the tool
 * gate uses, so the model is never shown a source the run cannot query.
 *
 * Only the descriptor's `description` is surfaced — `displayName` is an
 * operator-facing label adapters were never asked to keep model-safe. Read at
 * tool-assembly time, after runtime plugins register, so the summaries are
 * populated and stay frozen for the run (prompt cache).
 */
export function describeWorkflowKnowledgeFoundations(runId: string): WorkflowKnowledgeFoundation[] {
  const run = getEnterpriseActiveRun(runId);
  if (!run) {
    return [];
  }
  return routableFoundationIds(run).map((foundationId) => {
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
  /**
   * Foundations that were queried and answered, sorted. Empty snippets alone are
   * ambiguous once a run has several sources: the model cannot tell a source it
   * searched that holds nothing from one it never reached, so it either retries
   * the same target or stops looking. Naming what was searched is what makes a
   * second, differently-targeted call the obvious next move.
   */
  searched: string[];
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
  params.signal?.throwIfAborted();
  const run = getEnterpriseActiveRun(params.runId);
  if (!run) {
    return { snippets: [], searched: [], skipped: [], mediated: false };
  }
  const node = findPlanNode(run.plan, run.plan.activeNodeId);
  if (!node) {
    return { snippets: [], searched: [], skipped: [], mediated: true };
  }
  const path = [node];
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_KNOWLEDGE_LIMIT;
  const enforce = run.plan.mode === "enforce";
  const auditEnabled = path.some((step) => step.ontology.audit === true);
  // A requested set narrows which allowed foundations are queried; an omitted
  // (undefined) set queries every allowed foundation (unchanged behavior). An
  // explicit empty set is honored as "narrow to nothing", never widened back to
  // all — targeting is a convenience narrowing that must never broaden scope.
  const requested = params.foundations ? new Set(params.foundations) : undefined;
  // The work-map grants capabilities explicitly, so an unattached foundation is
  // out of scope rather than merely unnarrowed.
  //
  // Mode-independent ON PURPOSE, unlike the skill/MCP withholding. Knowledge scope
  // has never been something observe relaxes: a step's own `knowledgeFoundations`
  // list has always filtered retrieval in every mode, and this is the same field
  // read under the same rule. Splitting it by mode made an observing dry run show
  // a result enforce would not produce, which is the opposite of what observe is
  // for.
  const grantsExplicitly = run.plan.capabilityGrants === "explicit";

  const snippets: KnowledgeSnippet[] = [];
  const searched: string[] = [];
  const skipped: SkippedKnowledgeFoundation[] = [];
  // Include authored sources even when their adapter is missing: unavailable
  // knowledge must not look like a successful search with no matching facts.
  // The path and policy gates still decide access before adapter resolution.
  const candidates =
    requested ??
    new Set([
      ...retrievalFoundationIds(run.plan.treeId),
      ...path.flatMap((step) => step.ontology.knowledgeFoundations ?? []),
    ]);
  for (const foundationId of [...candidates].toSorted()) {
    params.signal?.throwIfAborted();
    if (!foundationAllowedByPath(path, foundationId, grantsExplicitly)) {
      if (requested) {
        skipped.push({ foundationId, reason: "not in this step's knowledge allow-list" });
      }
      continue;
    }
    const decision = evaluateKnowledgeRetrievalGovernance({
      plan: run.plan,
      node,
      foundationId,
      policies: run.policies,
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
      skipped.push({ foundationId, reason: "knowledge foundation unavailable" });
      continue;
    }
    try {
      const results = await adapter.retrieve({
        foundationId,
        query: params.query,
        limit,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      // Adapters may ignore cancellation. Do not publish their late results or
      // start another foundation's retrieval after the caller has cancelled.
      params.signal?.throwIfAborted();
      // Recorded only once the adapter ANSWERED: a foundation whose retrieval threw
      // lands in `skipped` below, so the two lists never both claim it.
      searched.push(foundationId);
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
  // Candidate ids are sorted, including unavailable and explicitly requested ids.
  return { snippets, searched, skipped, mediated: true };
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
