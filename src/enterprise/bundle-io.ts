/**
 * Workflow bundle import/export: a portable exchange artifact that carries one
 * workflow tree, snapshot-capable owned knowledge, and manifests naming the
 * external dependencies a recipient must configure. A superset of the tree
 * exchange format in `tree-io.ts`; `trees export`/`import` keep working unchanged.
 *
 * Import is database-first and atomic: the tree and its inlined foundations
 * persist together in the tree store's transaction, so a CLI import survives the
 * process exit and the runtime re-registers the foundations at startup.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEnterpriseMcpServers } from "./active-runs.js";
import {
  getBundledKnowledgeTargetStateForTree,
  listBundledKnowledgeFoundations,
} from "./enterprise-knowledge-store.sqlite.js";
import { policyCanFireInScope } from "./governance.js";
import { reloadPersistedBundleFoundations } from "./knowledge-bundle-loader.js";
import {
  listEnterpriseKnowledgeFoundations,
  snapshotEnterpriseKnowledgeFoundation,
} from "./knowledge.js";
import { hashWorkflowTree } from "./plan.js";
import { resolveEnterpriseMode } from "./runtime.js";
import {
  BundledKnowledgeFoundationSchema,
  GovernancePolicySchema,
  WorkflowTreeDefinitionSchema,
} from "./schema.js";
import {
  collectReferencedFoundationIds,
  collectReferencedMcpServers,
  collectReferencedSkills,
  collectReferencedToolGlobs,
  treeHasUnboundedKnowledgeScope,
} from "./tree-references.js";
import {
  getWorkflowTreeRegistrySnapshot,
  invalidateWorkflowTreeRegistry,
  type WorkflowTreeRegistryEntry,
} from "./tree-registry.js";
import {
  upsertEnterpriseWorkflowTree,
  type EnterpriseTreeStoreOptions,
  type WorkflowTreeSourceFormat,
} from "./tree-store.sqlite.js";
import { collectWorkflowTreeWarnings, type WorkflowTreeWarning } from "./tree-warnings.js";
import {
  WORKFLOW_BUNDLE_SCHEMA,
  WORKFLOW_BUNDLE_SCHEMA_VERSION,
  type BundledKnowledgeFoundation,
  type EnterpriseMode,
  type GovernancePolicy,
  type WorkflowBundle,
  type WorkflowNodeDefinition,
  type WorkflowTreeDefinition,
} from "./types.js";

/**
 * Joins canonicalized policies into one comparable sequence. A control character
 * so it cannot occur inside the JSON forms it separates — written as an escape,
 * never a literal byte, which would make this file binary to `rg` and `grep`.
 */
const SEQUENCE_SEPARATOR = "\u0000";

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
    requiredSkills: z.array(z.string()),
    // Optional: bundles written before MCP attachments existed still load.
    requiredMcpServers: z.array(z.string()).optional(),
    // Same: bundles written before policies travelled still load. Validated with
    // the runtime's own schema so a bundle cannot smuggle a policy shape config
    // would reject.
    governancePolicies: z.array(GovernancePolicySchema).optional(),
    governanceMode: z.enum(["enforce", "observe", "off"]).optional(),
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

/** One parsed tree plus the current state a guarded UI apply must match. */
export type PreviewedBundleTree = ImportedBundleTree & {
  version: string;
  currentVersion: string | null;
  currentHash: string | null;
};

type WorkflowBundleImportDiagnostics = {
  /** Inlined foundation ids that were persisted and registered. */
  foundations: string[];
  /**
   * Foundation ids the trees reference but the bundle did not inline (the
   * sender's export skipped them as server-backed). The recipient must
   * configure these separately or `knowledge_search` runs without them.
   */
  missingFoundations: string[];
  /** Existing owned foundations this import deletes because it omits them. */
  removedFoundations: string[];
  /** Existing owned foundations whose persisted rows this import replaces. */
  replacedFoundations: string[];
  /**
   * Inlined ids a global/plugin foundation already owns. Runtime retrieval gives
   * that live registration precedence, so the imported row is stored but unused.
   */
  shadowedFoundations: string[];
  requiredTools: string[];
  /** Skill ids the imported trees declare, so the recipient can spot any it lacks. */
  requiredSkills: string[];
  /**
   * Capabilities a step declares that its own tool scope can never reach, so
   * the recipient learns the work-map is partly inert BEFORE a run spends a
   * turn on a declaration the gate refuses. Derived from the trees, like the
   * manifests above — a stale exported array must not be able to hide one.
   */
  warnings: WorkflowTreeWarning[];
  /**
   * Policy ids the bundle carried that this deployment does NOT configure.
   *
   * Governance lives in `enterprise.governance.policies`, which is operator
   * config — importing a bundle must not write it. Reporting the gap is the
   * whole point: without it the work-map imports cleanly and runs with less
   * enforcement than the sender had, and nothing says so.
   */
  missingGovernancePolicies: string[];
  /**
   * Set when the exporting deployment enforced more than this one does.
   * Policies are only half the contract; the mode is the other half.
   */
  governanceModeDowngrade?: { from: EnterpriseMode; to: EnterpriseMode };
  /**
   * Policy ids this deployment configures DIFFERENTLY from the bundle.
   *
   * A policy id is a stable name, not an immutable definition: the recipient
   * may have an `audit` rule where the sender had a `deny`. Reporting only
   * missing ids would call that configured and enforce less without notice.
   */
  conflictingGovernancePolicies: string[];
  /**
   * `mcp.servers` names the imported trees attach. A server is deployment
   * configuration, so the bundle carries only the name: without this the import
   * looks complete while every attachment on the recipient is inert.
   */
  requiredMcpServers: string[];
  /** Required server names absent from the enabled runtime configuration. */
  missingMcpServers: string[];
};

type WorkflowBundleImportSuccess<TTree> = {
  ok: true;
  trees: TTree[];
} & WorkflowBundleImportDiagnostics;
type WorkflowBundleImportFailure = { ok: false; issues: WorkflowBundleValidationIssue[] };

export type WorkflowBundleImportPreviewResult =
  | (WorkflowBundleImportSuccess<PreviewedBundleTree> & { reviewToken: string })
  | WorkflowBundleImportFailure;

export type WorkflowBundleImportResult =
  | WorkflowBundleImportSuccess<ImportedBundleTree>
  | WorkflowBundleImportFailure;

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
    requiredSkills: [...bundle.requiredSkills].toSorted(),
    // NOT sorted, unlike every other list here. resolvePolicyDecision picks the
    // FIRST policy of the winning effect (src/enterprise/governance.ts), so among
    // two matching `require_approval` rules the order decides which approval
    // settings apply — reordering would turn deny-on-timeout into allow-on-timeout
    // on the recipient. Declaration order is part of the rule set.
    ...(bundle.governancePolicies?.length
      ? { governancePolicies: [...bundle.governancePolicies] }
      : {}),
    ...(bundle.governanceMode ? { governanceMode: bundle.governanceMode } : {}),
    ...(bundle.requiredMcpServers?.length
      ? { requiredMcpServers: [...bundle.requiredMcpServers].toSorted() }
      : {}),
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
  return { ok: true, bundle: result.data };
}

/**
 * Build a portable bundle for one registered tree. Fails closed on a corrupt
 * store/override like `exportWorkflowTree`, and records any referenced foundation
 * it could not snapshot rather than claiming external dependencies are included.
 */
export async function exportWorkflowBundle(
  params: {
    treeId: string;
    format: WorkflowTreeSourceFormat;
    /**
     * Config to read `enterprise.governance.policies` from. Passed in rather
     * than read here so a caller can export deterministically in tests, and so
     * this stays a pure function of what it is given.
     */
    config?: OpenClawConfig;
  },
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
  const requiredSkills = collectReferencedSkills(entry.tree);
  const requiredMcpServers = collectReferencedMcpServers(entry.tree);
  const knowledgeFoundations: WorkflowBundle["knowledgeFoundations"] = [];
  const skippedFoundations: SkippedBundleFoundation[] = [];
  let storedFoundations: ReturnType<typeof listBundledKnowledgeFoundations>;
  try {
    storedFoundations = listBundledKnowledgeFoundations(options);
  } catch (error) {
    return {
      ok: false,
      reason: `cannot read bundled knowledge for workflow tree "${entry.tree.id}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const ownedFoundations = new Map(
    storedFoundations.records
      .filter(({ treeId }) => treeId === entry.tree.id)
      .map(({ foundation }) => [foundation.id, foundation]),
  );
  const unreadableOwnedFoundationIds = new Set(
    storedFoundations.rowErrors
      .filter(({ treeId }) => treeId === entry.tree.id)
      .map(({ foundationId }) => foundationId),
  );
  for (const id of foundationIds) {
    // Preserve this tree's persisted bundle row before consulting the live
    // registry. A global/plugin adapter wins at runtime, but exporting that
    // adapter here would silently discard the tree-owned row on re-import.
    if (unreadableOwnedFoundationIds.has(id)) {
      return {
        ok: false,
        reason: `bundled knowledge foundation "${id}" owned by workflow tree "${entry.tree.id}" is invalid`,
      };
    }
    const owned = ownedFoundations.get(id);
    if (owned) {
      knowledgeFoundations.push(owned);
      continue;
    }
    // Scope any live snapshot to the exporting tree: never inline knowledge
    // another workflow owns for the same id.
    const snap = await snapshotEnterpriseKnowledgeFoundation(entry.tree.id, id);
    if (snap.status === "ok") {
      knowledgeFoundations.push({ id, descriptor: snap.descriptor, snippets: snap.snippets });
    } else {
      skippedFoundations.push({ id, reason: snap.status });
    }
  }
  // The policies that actually govern this tree. Without them an export looks
  // complete and arrives unenforced, which for a governance artifact is worse
  // than an obviously incomplete one.
  const governancePolicies = (params.config?.enterprise?.governance?.policies ?? []).filter(
    treeGovernancePredicate(entry.tree),
  );
  const bundle: WorkflowBundle = {
    schema: WORKFLOW_BUNDLE_SCHEMA,
    schemaVersion: WORKFLOW_BUNDLE_SCHEMA_VERSION,
    trees: [entry.tree],
    knowledgeFoundations,
    requiredTools,
    requiredSkills,
    ...(requiredMcpServers.length > 0 ? { requiredMcpServers } : {}),
    ...(governancePolicies.length > 0 ? { governancePolicies } : {}),
    // Independent of whether any policy travels: a work-map governed only by
    // ontology restrictions (deniedTools, explicit grants, MCP attachments) also
    // stops blocking under a weaker mode, and no policy comparison would say so.
    // The RESOLVED mode, not the raw key: `enterprise.mode` is optional and
    // defaults to `enforce`, so a deployment that never set it would otherwise
    // export no mode at all — and importing into `observe` would look like no
    // change when it is exactly the downgrade this exists to catch.
    governanceMode: resolveEnterpriseMode(params.config),
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

type PreparedBundleTree = {
  tree: WorkflowTreeDefinition;
  existing: WorkflowTreeRegistryEntry | undefined;
  bundledFoundations: BundledKnowledgeFoundation[];
  targetKnowledgeFingerprint: string;
  targetFoundationIds: string[];
};

type PreparedWorkflowBundleImport = {
  trees: [PreparedBundleTree];
  diagnostics: WorkflowBundleImportDiagnostics;
};

function bundleImportIssue(message: string): WorkflowBundleImportFailure {
  return { ok: false, issues: [{ path: "trees.0.id", message }] };
}

function preparedBundleTargetState(tree: PreparedBundleTree) {
  return {
    treeId: tree.tree.id,
    expectedSource: tree.existing?.source ?? ("absent" as const),
    treeHash: tree.existing ? hashWorkflowTree(tree.existing.tree) : null,
    knowledgeFingerprint: tree.targetKnowledgeFingerprint,
  };
}

/**
 * Bind the exact file bytes to every fact the operator reviewed. The token is
 * opaque: apply recomputes it from current config/tree/knowledge instead of
 * trusting client-supplied diagnostics or retaining server-side draft state.
 */
function bundleReviewToken(
  params: { content: string; format: WorkflowTreeSourceFormat },
  prepared: PreparedWorkflowBundleImport,
): string {
  const contentHash = createHash("sha256").update(params.content).digest("hex");
  const material = {
    format: params.format,
    contentHash,
    target: preparedBundleTargetState(prepared.trees[0]),
    diagnostics: prepared.diagnostics,
  };
  const canonical = JSON.stringify(material, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .toSorted()
          .map((key) => [key, record[key]]),
      );
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Parse and derive every import effect without mutating either registry or SQLite. */
function prepareWorkflowBundleImport(
  params: { content: string; format: WorkflowTreeSourceFormat; config?: OpenClawConfig },
  options: EnterpriseTreeStoreOptions,
): { ok: true; prepared: PreparedWorkflowBundleImport } | WorkflowBundleImportFailure {
  const parsed = parseWorkflowBundleContent(params.content, params.format);
  if (!parsed.ok) {
    return parsed;
  }
  const bundle = parsed.bundle;
  const snapshot = getWorkflowTreeRegistrySnapshot(options);
  if (snapshot.storeError) {
    return bundleImportIssue(`cannot read the workflow tree store: ${snapshot.storeError}`);
  }
  const targetId = bundle.trees[0]?.id;
  const importError = snapshot.importErrors.find((issue) => issue.treeId === targetId);
  if (importError) {
    return bundleImportIssue(
      `stored workflow tree "${targetId}" is invalid; remove it before importing this bundle`,
    );
  }
  // Index the inlined foundations so each tree can claim the ones it references.
  const foundationsById = new Map(bundle.knowledgeFoundations.map((f) => [f.id, f]));
  const trees: PreparedBundleTree[] = [];
  // Foundation ids the trees reference but the bundle did not inline: the sender's
  // export skipped them as server-backed, so the recipient must configure them
  // separately. Collected across all trees, deduped and sorted for a stable warning.
  const missing = new Set<string>();
  // Derive the required-tools manifest from the trees themselves rather than
  // trusting the bundle's stored array, which a stale export or manual edit could
  // leave inconsistent with what the workflow actually references.
  const requiredTools = new Set<string>();
  // Same rationale for skills: derive from the trees, not the bundle's stored
  // array, so a stale export cannot misreport the dependency.
  const requiredSkills = new Set<string>();
  // And for MCP: an attachment naming a server the recipient never registered is
  // inert, so the import has to name them rather than look complete.
  const requiredMcpServers = new Set<string>();
  const warnings: WorkflowTreeWarning[] = [];
  for (const tree of bundle.trees) {
    const existing = snapshot.entries.find((entry) => entry.tree.id === tree.id);
    let targetKnowledgeState;
    try {
      targetKnowledgeState = getBundledKnowledgeTargetStateForTree(tree.id, options);
    } catch (error) {
      return bundleImportIssue(
        `cannot read bundled knowledge for workflow tree "${tree.id}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    warnings.push(...collectWorkflowTreeWarnings(tree));
    for (const tool of collectReferencedToolGlobs(tree)) {
      requiredTools.add(tool);
    }
    for (const skill of collectReferencedSkills(tree)) {
      requiredSkills.add(skill);
    }
    for (const server of collectReferencedMcpServers(tree)) {
      requiredMcpServers.add(server);
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
    trees.push({
      tree,
      existing,
      bundledFoundations,
      targetKnowledgeFingerprint: targetKnowledgeState.fingerprint,
      targetFoundationIds: targetKnowledgeState.foundationIds,
    });
  }
  const preparedTree = trees[0];
  if (!preparedTree) {
    return bundleImportIssue("bundle must contain exactly one workflow tree");
  }
  const sortedRequiredMcpServers = [...requiredMcpServers].toSorted();
  const availableMcpServers = new Set(resolveEnterpriseMcpServers(params.config));
  const incomingFoundationIds = new Set(
    preparedTree.bundledFoundations.map((foundation) => foundation.id),
  );
  const globalFoundationIds = new Set(
    listEnterpriseKnowledgeFoundations().map(({ foundationId }) => foundationId),
  );
  return {
    ok: true,
    prepared: {
      trees: [preparedTree],
      diagnostics: {
        foundations: bundle.knowledgeFoundations.map((foundation) => foundation.id),
        missingFoundations: [...missing].toSorted(),
        removedFoundations: preparedTree.targetFoundationIds.filter(
          (foundation) => !incomingFoundationIds.has(foundation),
        ),
        replacedFoundations: preparedTree.targetFoundationIds.filter((foundation) =>
          incomingFoundationIds.has(foundation),
        ),
        shadowedFoundations: [...incomingFoundationIds]
          .filter((foundation) => globalFoundationIds.has(foundation))
          .toSorted(),
        requiredTools: [...requiredTools].toSorted(),
        requiredSkills: [...requiredSkills].toSorted(),
        requiredMcpServers: sortedRequiredMcpServers,
        missingMcpServers: sortedRequiredMcpServers.filter(
          (server) => !availableMcpServers.has(server),
        ),
        warnings,
        ...comparePolicies(bundle, params.config),
      },
    },
  };
}

/**
 * Validate a bundle and report its complete write/dependency impact. This is the
 * UI review step: no tree, foundation, history row, or runtime registry changes.
 */
export function previewWorkflowBundleImport(
  params: { content: string; format: WorkflowTreeSourceFormat; config?: OpenClawConfig },
  options: EnterpriseTreeStoreOptions = {},
): WorkflowBundleImportPreviewResult {
  const prepared = prepareWorkflowBundleImport(params, options);
  if (!prepared.ok) {
    return prepared;
  }
  return {
    ok: true,
    reviewToken: bundleReviewToken(params, prepared.prepared),
    trees: prepared.prepared.trees.map(({ tree, existing }) => ({
      id: tree.id,
      version: tree.version,
      replaced: existing?.source ?? null,
      currentVersion: existing?.tree.version ?? null,
      currentHash: existing ? hashWorkflowTree(existing.tree) : null,
    })),
    ...prepared.prepared.diagnostics,
  };
}

/**
 * Validate a bundle, then persist its one tree and referenced foundations in ONE
 * transaction (see upsertEnterpriseWorkflowTree). Gateway callers supply either
 * `createOnly` or the hash returned by preview; the CLI keeps its explicit
 * overwrite behavior by omitting both.
 */
export function importWorkflowBundle(
  params: {
    content: string;
    format: WorkflowTreeSourceFormat;
    /**
     * Config to compare the bundle's carried policies against. Omitted means the
     * caller cannot check, and every carried policy is reported as missing —
     * the safe direction for a governance artifact.
     */
    config?: OpenClawConfig;
    createOnly?: true;
    expectedHash?: string;
    /** Opaque token returned by preview; omitted only by the direct CLI API. */
    reviewToken?: string;
  },
  options: EnterpriseTreeStoreOptions = {},
): WorkflowBundleImportResult {
  if (params.createOnly && params.expectedHash !== undefined) {
    return bundleImportIssue("bundle import accepts one write precondition, not both");
  }
  const outcome = prepareWorkflowBundleImport(params, options);
  if (!outcome.ok) {
    return outcome;
  }
  if (
    params.reviewToken !== undefined &&
    bundleReviewToken(params, outcome.prepared) !== params.reviewToken
  ) {
    return bundleImportIssue(
      "bundle target or deployment diagnostics changed since preview; preview the bundle again before importing",
    );
  }
  const importedTrees: ImportedBundleTree[] = [];
  for (const prepared of outcome.prepared.trees) {
    const { tree, existing, bundledFoundations } = prepared;
    const currentHash = existing ? hashWorkflowTree(existing.tree) : null;
    if (params.createOnly && existing) {
      return bundleImportIssue(`workflow tree "${tree.id}" already exists`);
    }
    if (params.expectedHash !== undefined && currentHash !== params.expectedHash) {
      return bundleImportIssue(
        `workflow tree "${tree.id}" changed since preview; preview the bundle again before importing`,
      );
    }
    const precondition = params.reviewToken
      ? ({ kind: "expected-bundle-state", ...preparedBundleTargetState(prepared) } as const)
      : params.createOnly
        ? ({ kind: "create-only" } as const)
        : params.expectedHash !== undefined
          ? ({
              kind: "expected-hash",
              hash: params.expectedHash,
              expectedSource: existing?.source ?? "imported",
            } as const)
          : undefined;
    const write = upsertEnterpriseWorkflowTree(
      {
        tree,
        sourceFormat: params.format,
        bundledFoundations,
        ...(precondition ? { precondition } : {}),
      },
      options,
    );
    if (!write.upserted) {
      // Another writer won after prepare. Rebuild both process views so the next
      // preview describes the canonical tree and bundle content it will guard.
      reloadPersistedBundleFoundations(options);
      invalidateWorkflowTreeRegistry();
      return bundleImportIssue(
        write.reason === "already-exists"
          ? `workflow tree "${tree.id}" already exists`
          : `workflow tree "${tree.id}" changed since preview; preview the bundle again before importing`,
      );
    }
    importedTrees.push({
      id: tree.id,
      replaced: write.replacedImported
        ? "imported"
        : existing?.source === "builtin"
          ? "builtin"
          : null,
    });
  }
  // Reconcile the live bundle registry with the canonical store (not just add the
  // imported ids): a re-import that dropped a foundation removed its SQLite row,
  // and only a full rebuild evicts the stale in-memory adapter.
  reloadPersistedBundleFoundations(options);
  invalidateWorkflowTreeRegistry();
  return { ok: true, trees: importedTrees, ...outcome.prepared.diagnostics };
}

/**
 * How the bundle's policies compare to what this deployment configures.
 *
 * Two answers, because they need different remedies: an ABSENT rule has to be
 * added, while one that exists under the same id with a different body is the
 * operator's own decision to reconcile. Neither is written automatically —
 * governance is operator config, and importing a work-map must not edit it.
 */
function comparePolicies(
  bundle: WorkflowBundle,
  config?: OpenClawConfig,
): {
  missingGovernancePolicies: string[];
  conflictingGovernancePolicies: string[];
  governanceModeDowngrade?: { from: EnterpriseMode; to: EnterpriseMode };
} {
  // Mode first, and unconditionally: it is not a property of the policy list.
  const sourceMode = bundle.governanceMode;
  // Resolved on this side too, for the same reason.
  const localMode = resolveEnterpriseMode(config);
  // Ranked, because only a DOWNGRADE loses enforcement: importing into a stricter
  // deployment is not a portability problem.
  const strength: Record<string, number> = { off: 0, observe: 1, enforce: 2 };
  const modeDowngrade =
    sourceMode && localMode && (strength[localMode] ?? 0) < (strength[sourceMode] ?? 0)
      ? { governanceModeDowngrade: { from: sourceMode, to: localMode } }
      : {};

  const carried = bundle.governancePolicies ?? [];
  // Only policies that can govern THIS tree take part. A same-id rule aimed at
  // another work-map never competes here, and counting it would fail the group
  // comparison for configurations that are in fact equivalent.
  const governsTree = treeGovernancePredicate(bundle.trees[0]);

  // Grouped by effect before ANY comparison below. resolvePolicyDecision applies
  // a FIXED effect precedence (deny, then require_approval, then allow, then
  // audit), so moving a rule past one of a different effect cannot change the
  // winner — only order WITHIN an effect can. Comparing raw config order would
  // call an equivalent config a conflict.
  const byEffect = (policies: readonly GovernancePolicy[]) =>
    (["deny", "require_approval", "allow", "audit"] as const).flatMap((effect) =>
      policies.filter((policy) => policy.effect === effect),
    );
  const sequenceOf = (policies: readonly GovernancePolicy[]) =>
    byEffect(policies)
      .map((policy) => canonicalPolicy(policy))
      .join(SEQUENCE_SEPARATOR);

  // Grouped, not keyed: the schema permits repeated ids, and keeping only the
  // last local definition would report identical configs as conflicting and hide
  // an extra same-id rule that genuinely changes enforcement.
  //
  // Grouped across the WHOLE local config, unfiltered: relevance decides what
  // ENFORCES, presence decides which remedy the operator is given. A target that
  // defines the id but scopes it at another tree, node, or action is not missing
  // the rule — it has one that does not reach here — and telling it to add a
  // policy it already has points at the wrong line of config.
  const configured = new Map<string, GovernancePolicy[]>();
  for (const policy of config?.enterprise?.governance?.policies ?? []) {
    configured.set(policy.id, [...(configured.get(policy.id) ?? []), policy]);
  }
  const carriedById = new Map<string, GovernancePolicy[]>();
  for (const policy of carried.filter(governsTree)) {
    carriedById.set(policy.id, [...(carriedById.get(policy.id) ?? []), policy]);
  }
  const missing: string[] = [];
  const conflicting = new Set<string>();
  for (const [id, group] of carriedById) {
    const local = configured.get(id);
    if (!local) {
      missing.push(id);
      continue;
    }
    // Whole group against whole group, comparing only what enforces here: order
    // is semantic among policies of the same effect, and only there — a config
    // that repeats an id across effects enforces the same whichever order it
    // lists them in. A local definition scoped out of this tree contributes
    // nothing, so an id present but pointed elsewhere reads as a conflict.
    if (sequenceOf(local.filter(governsTree)) !== sequenceOf(group)) {
      conflicting.add(id);
    }
  }

  // Order matters ACROSS ids too, and so do local rules the bundle never carried.
  // resolvePolicyDecision picks the FIRST policy of the winning effect, so an
  // extra local `require_approval` sitting before an identical carried one
  // changes which timeout behavior applies — while every per-id group still
  // matches. Comparing only carried ids would call that compatible.
  //
  // Scoped to policies that can govern THIS tree: an unrelated rule aimed at
  // another work-map never competes, and flagging it would be noise.
  const localSequence = (config?.enterprise?.governance?.policies ?? []).filter(governsTree);
  const carriedSequence = carried.filter(governsTree);
  if (sequenceOf(localSequence) !== sequenceOf(carriedSequence)) {
    // Which ids differ: everything the target has here that the bundle did not
    // place identically, plus any carried rule now in a different position.
    const localOrdered = byEffect(localSequence);
    const carriedOrdered = byEffect(carriedSequence);
    carriedOrdered.forEach((policy, index) => {
      const local = localOrdered[index];
      if (!local || canonicalPolicy(local) !== canonicalPolicy(policy)) {
        conflicting.add(policy.id);
      }
    });
    localOrdered.forEach((policy, index) => {
      const remote = carriedOrdered[index];
      if (!remote || canonicalPolicy(remote) !== canonicalPolicy(policy)) {
        conflicting.add(policy.id);
      }
    });
  }

  return {
    missingGovernancePolicies: missing.toSorted(),
    // A rule the target simply lacks is reported once, as missing: it needs
    // adding, not reconciling, and listing it twice only muddies the remedy.
    conflictingGovernancePolicies: [...conflicting]
      .filter((id) => !missing.includes(id))
      .toSorted(),
    ...modeDowngrade,
  };
}

/**
 * Form that ignores what does not change enforcement, so a reformatted config is
 * not reported as a conflict: object key order, and selector arrays, which
 * `matchesSelector` evaluates as SETS — hence sorted AND deduplicated, since a
 * glob repeated in one config matches exactly what it matches once.
 */
function canonicalPolicy(policy: GovernancePolicy): string {
  return JSON.stringify(policy, (_key, value: unknown) => {
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return [...new Set(value)].toSorted();
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .toSorted()
          .map((key) => [key, record[key]]),
      );
    }
    return value;
  });
}

/** Every node id in the tree, for matching a policy's node selectors. */
function collectTreeNodeIds(node: WorkflowNodeDefinition): string[] {
  return [node.id, ...(node.children ?? []).flatMap((child) => collectTreeNodeIds(child))];
}

/** Every ontology action id the tree declares, for a policy's action selectors. */
function collectTreeActionIds(node: WorkflowNodeDefinition): string[] {
  return [
    ...(node.ontology?.actions ?? []).map((action) => action.id),
    ...(node.children ?? []).flatMap((child) => collectTreeActionIds(child)),
  ];
}

/**
 * Can this policy ever govern a run of this tree?
 *
 * The scope a tree declares, judged by the runtime's own `policyCanFireInScope`
 * so export, import, and step tracking agree on which policies matter. Carrying
 * one that cannot fire produces a missing- or conflicting-policy warning whose
 * remedy changes no enforcement, and a governance warning nobody can act on is
 * the kind that gets ignored.
 */
function treeGovernancePredicate(
  tree: WorkflowTreeDefinition | undefined,
): (policy: GovernancePolicy) => boolean {
  if (!tree) {
    return () => false;
  }
  const scope = {
    treeId: tree.id,
    nodeIds: collectTreeNodeIds(tree.root),
    actionIds: collectTreeActionIds(tree.root),
  };
  return (policy) => policyCanFireInScope(policy, scope);
}
