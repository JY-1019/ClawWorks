/**
 * Workflow bundle import/export: a self-contained exchange artifact that carries
 * one workflow tree plus everything it references (inlined knowledge foundations
 * and a required-tools manifest), so a recipient can import it and run
 * identically with no extra setup. A superset of the tree exchange format in
 * `tree-io.ts`; `trees export`/`import` keep working unchanged.
 *
 * Import is database-first and atomic: the tree and its inlined foundations
 * persist together in the tree store's transaction, so a CLI import survives the
 * process exit and the runtime re-registers the foundations at startup.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { reloadPersistedBundleFoundations } from "./knowledge-bundle-loader.js";
import { snapshotEnterpriseKnowledgeFoundation } from "./knowledge.js";
import { EnterpriseIdSchema, WorkflowTreeDefinitionSchema } from "./schema.js";
import {
  collectReferencedFoundationIds,
  collectReferencedToolGlobs,
  treeHasUnboundedKnowledgeScope,
} from "./tree-references.js";
import {
  getWorkflowTreeRegistryEntry,
  getWorkflowTreeRegistrySnapshot,
  invalidateWorkflowTreeRegistry,
} from "./tree-registry.js";
import {
  upsertEnterpriseWorkflowTree,
  type EnterpriseTreeStoreOptions,
  type WorkflowTreeSourceFormat,
} from "./tree-store.sqlite.js";
import {
  WORKFLOW_BUNDLE_SCHEMA,
  WORKFLOW_BUNDLE_SCHEMA_VERSION,
  type BundledKnowledgeFoundation,
  type WorkflowBundle,
} from "./types.js";

const KnowledgeFoundationDescriptorSchema = z
  .object({
    kind: z.enum(["remote", "local"]),
    displayName: z.string(),
    detail: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

// The stored foundation id on a snippet is descriptive only — retrieval re-stamps
// it with the querying foundation — so it stays a free string, not a dotted id.
const KnowledgeSnippetSchema = z
  .object({
    foundationId: z.string(),
    title: z.string().optional(),
    text: z.string(),
    score: z.number().optional(),
    source: z.string().optional(),
  })
  .strict();

const BundledKnowledgeFoundationSchema = z
  .object({
    id: EnterpriseIdSchema,
    descriptor: KnowledgeFoundationDescriptorSchema,
    snippets: z.array(KnowledgeSnippetSchema),
  })
  .strict();

const WorkflowBundleSchema = z
  .object({
    schema: z.literal(WORKFLOW_BUNDLE_SCHEMA),
    schemaVersion: z.literal(WORKFLOW_BUNDLE_SCHEMA_VERSION),
    // Exactly one tree: a bundle is one workflow plus its knowledge. One tree
    // keeps import a single atomic transaction (tree + its foundations); the
    // array shape leaves room for a future multi-tree format version.
    trees: z.array(WorkflowTreeDefinitionSchema).length(1),
    knowledgeFoundations: z.array(BundledKnowledgeFoundationSchema),
    requiredTools: z.array(z.string()),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    // Reject duplicate foundation ids: import applies entries by id, so a repeated
    // id would silently last-write-win instead of erroring.
    reportDuplicateIds(
      bundle.knowledgeFoundations.map((foundation) => foundation.id),
      "knowledgeFoundations",
      ctx,
    );
    // Reject an inlined foundation the tree does not reference. Persistence is
    // tree-scoped, so such an entry is never written (no owning reference) and
    // never queryable (retrieval is gated by tree ontology allow-lists) —
    // reporting it as imported would be a lie the next restart exposes. Every
    // inlined foundation must earn its place by being referenced.
    const referenced = new Set(
      bundle.trees.flatMap((tree) => collectReferencedFoundationIds(tree)),
    );
    for (const foundation of bundle.knowledgeFoundations) {
      if (!referenced.has(foundation.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledgeFoundations"],
          message: `foundation "${foundation.id}" is not referenced by any tree`,
        });
      }
    }
  });

function reportDuplicateIds(ids: string[], path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `duplicate id "${id}"` });
    }
    seen.add(id);
  }
}

export type WorkflowBundleValidationIssue = { path: string; message: string };

export type WorkflowBundleParseResult =
  | { ok: true; bundle: WorkflowBundle }
  | { ok: false; issues: WorkflowBundleValidationIssue[] };

/** One foundation the export could not inline, and why (server-backed/unregistered). */
export type SkippedBundleFoundation = { id: string; reason: string };

export type WorkflowBundleExportResult =
  | {
      ok: true;
      content: string;
      source: "builtin" | "imported";
      /** Referenced foundations that could not be snapshotted (see reason). */
      skippedFoundations: SkippedBundleFoundation[];
      /**
       * The tree declares no explicit `knowledgeFoundations` anywhere, so at
       * runtime it reads as allow-all (every configured foundation). The bundle
       * cannot capture that implicit set, so it carries no inlined knowledge; the
       * caller should warn that an explicit allow-list is needed to bundle it.
       */
      impliedAllowAllKnowledge: boolean;
    }
  | { ok: false; reason: string };

/** One tree the import upserted, and which prior entry (if any) it replaced. */
export type ImportedBundleTree = { id: string; replaced: "builtin" | "imported" | null };

export type WorkflowBundleImportResult =
  | {
      ok: true;
      trees: ImportedBundleTree[];
      /** Inlined foundation ids that were persisted and registered. */
      foundations: string[];
      /**
       * Foundation ids the trees reference but the bundle did not inline (the
       * sender's export skipped them as server-backed). The recipient must
       * configure these separately or `knowledge_search` runs without them.
       */
      missingFoundations: string[];
      requiredTools: string[];
    }
  | { ok: false; issues: WorkflowBundleValidationIssue[] };

export function serializeWorkflowBundle(
  bundle: WorkflowBundle,
  format: WorkflowTreeSourceFormat,
): string {
  // Canonical field order + sorted arrays give stable diffs across exports.
  const canonical: WorkflowBundle = {
    schema: bundle.schema,
    schemaVersion: bundle.schemaVersion,
    trees: [...bundle.trees].toSorted((a, b) => a.id.localeCompare(b.id)),
    knowledgeFoundations: [...bundle.knowledgeFoundations].toSorted((a, b) =>
      a.id.localeCompare(b.id),
    ),
    requiredTools: [...bundle.requiredTools].toSorted(),
  };
  if (format === "yaml") {
    return stringifyYaml(canonical);
  }
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function parseWorkflowBundleContent(
  content: string,
  format: WorkflowTreeSourceFormat,
): WorkflowBundleParseResult {
  let raw: unknown;
  try {
    raw = format === "yaml" ? parseYaml(content) : JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          path: "",
          message: `invalid ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const result = WorkflowBundleSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  return { ok: true, bundle: result.data as WorkflowBundle };
}

/**
 * Build a self-contained bundle for one registered tree. Fails closed on a
 * corrupt store/override like `exportWorkflowTree`, and records any referenced
 * foundation it could not snapshot rather than shipping partial content.
 */
export async function exportWorkflowBundle(
  params: { treeId: string; format: WorkflowTreeSourceFormat },
  options: EnterpriseTreeStoreOptions = {},
): Promise<WorkflowBundleExportResult> {
  const snapshot = getWorkflowTreeRegistrySnapshot(options);
  if (snapshot.storeError !== undefined) {
    return { ok: false, reason: snapshot.storeError };
  }
  const importError = snapshot.importErrors.find((issue) => issue.treeId === params.treeId);
  if (importError) {
    return { ok: false, reason: importError.message };
  }
  const entry = snapshot.entries.find((candidate) => candidate.tree.id === params.treeId);
  if (!entry) {
    return { ok: false, reason: `no workflow tree registered with id "${params.treeId}"` };
  }
  const foundationIds = collectReferencedFoundationIds(entry.tree);
  const requiredTools = collectReferencedToolGlobs(entry.tree);
  const knowledgeFoundations: WorkflowBundle["knowledgeFoundations"] = [];
  const skippedFoundations: SkippedBundleFoundation[] = [];
  for (const id of foundationIds) {
    // Scope the snapshot to the exporting tree: never inline knowledge another
    // workflow owns for the same id (runtime retrieval hides it from this tree too).
    const snap = await snapshotEnterpriseKnowledgeFoundation(entry.tree.id, id);
    if (snap.status === "ok") {
      knowledgeFoundations.push({ id, descriptor: snap.descriptor, snippets: snap.snippets });
    } else {
      skippedFoundations.push({ id, reason: snap.status });
    }
  }
  const bundle: WorkflowBundle = {
    schema: WORKFLOW_BUNDLE_SCHEMA,
    schemaVersion: WORKFLOW_BUNDLE_SCHEMA_VERSION,
    trees: [entry.tree],
    knowledgeFoundations,
    requiredTools,
  };
  return {
    ok: true,
    content: serializeWorkflowBundle(bundle, params.format),
    source: entry.source,
    skippedFoundations,
    // The tree can retrieve beyond its explicit references (root allow-all scope);
    // the bundle cannot capture that implicit set, so the caller warns even when
    // some ids were inlined.
    impliedAllowAllKnowledge: treeHasUnboundedKnowledgeScope(entry.tree),
  };
}

/**
 * Validate a bundle, then for each tree persist the tree and the foundations it
 * references in ONE transaction (see upsertEnterpriseWorkflowTree), so a bundle
 * import is atomic and a re-import replaces exactly that tree's foundation set.
 * Also registers every inlined foundation in the process registry for immediate
 * use; a fresh process re-hydrates them from SQLite at startup. Missing tools are
 * surfaced, not fatal.
 */
export function importWorkflowBundle(
  params: { content: string; format: WorkflowTreeSourceFormat },
  options: EnterpriseTreeStoreOptions = {},
): WorkflowBundleImportResult {
  const parsed = parseWorkflowBundleContent(params.content, params.format);
  if (!parsed.ok) {
    return parsed;
  }
  const bundle = parsed.bundle;
  // Index the inlined foundations so each tree can claim the ones it references.
  const foundationsById = new Map(bundle.knowledgeFoundations.map((f) => [f.id, f]));
  const trees: ImportedBundleTree[] = [];
  // Foundation ids the trees reference but the bundle did not inline: the sender's
  // export skipped them as server-backed, so the recipient must configure them
  // separately. Collected across all trees, deduped and sorted for a stable warning.
  const missing = new Set<string>();
  // Derive the required-tools manifest from the trees themselves rather than
  // trusting the bundle's stored array, which a stale export or manual edit could
  // leave inconsistent with what the workflow actually references.
  const requiredTools = new Set<string>();
  for (const tree of bundle.trees) {
    const existing = getWorkflowTreeRegistryEntry(tree.id, options);
    for (const tool of collectReferencedToolGlobs(tree)) {
      requiredTools.add(tool);
    }
    const bundledFoundations: BundledKnowledgeFoundation[] = [];
    for (const id of collectReferencedFoundationIds(tree)) {
      const foundation = foundationsById.get(id);
      if (foundation) {
        bundledFoundations.push(foundation);
      } else {
        missing.add(id);
      }
    }
    upsertEnterpriseWorkflowTree(
      { tree, sourceFormat: params.format, bundledFoundations },
      options,
    );
    trees.push({ id: tree.id, replaced: existing?.source ?? null });
  }
  // Reconcile the live bundle registry with the canonical store (not just add the
  // imported ids): a re-import that dropped a foundation removed its SQLite row
  // above, and only a full rebuild evicts the stale in-memory adapter so
  // same-process retrieval and export stop serving it. The rebuild also registers
  // the imported foundations for immediate use this process.
  reloadPersistedBundleFoundations(options);
  invalidateWorkflowTreeRegistry();
  return {
    ok: true,
    trees,
    foundations: bundle.knowledgeFoundations.map((foundation) => foundation.id),
    missingFoundations: [...missing].toSorted(),
    requiredTools: [...requiredTools].toSorted(),
  };
}
