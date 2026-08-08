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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { policyTargetsNode, policyTargetsTree } from "./governance.js";
import { reloadPersistedBundleFoundations } from "./knowledge-bundle-loader.js";
import { snapshotEnterpriseKnowledgeFoundation } from "./knowledge.js";
import { resolveEnterpriseMode } from "./runtime.js";
import {
  EnterpriseIdSchema,
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
  type GovernancePolicy,
  type WorkflowBundle,
  type WorkflowNodeDefinition,
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
      /** Skill ids the imported trees declare, so the recipient can spot any it lacks. */
      requiredSkills: string[];
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
      governanceModeDowngrade?: { from: string; to: string };
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
 * Build a self-contained bundle for one registered tree. Fails closed on a
 * corrupt store/override like `exportWorkflowTree`, and records any referenced
 * foundation it could not snapshot rather than shipping partial content.
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
  // The policies that actually govern this tree. Without them an export looks
  // complete and arrives unenforced, which for a governance artifact is worse
  // than an obviously incomplete one.
  const treeNodeIds = collectTreeNodeIds(entry.tree.root);
  const governancePolicies = (params.config?.enterprise?.governance?.policies ?? []).filter(
    (policy) =>
      policyTargetsTree(policy, entry.tree.id) &&
      // ...and, when it names nodes, at least one of THIS tree's nodes. A policy
      // whose node globs belong to another work-map can never apply here, so
      // carrying it would only produce a bogus missing-policy warning.
      (policy.nodes === undefined ||
        policy.nodes.length === 0 ||
        treeNodeIds.some((nodeId) => policyTargetsNode(policy, nodeId))),
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

/**
 * Validate a bundle, then for each tree persist the tree and the foundations it
 * references in ONE transaction (see upsertEnterpriseWorkflowTree), so a bundle
 * import is atomic and a re-import replaces exactly that tree's foundation set.
 * Also registers every inlined foundation in the process registry for immediate
 * use; a fresh process re-hydrates them from SQLite at startup. Missing tools are
 * surfaced, not fatal.
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
  },
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
  // Same rationale for skills: derive from the trees, not the bundle's stored
  // array, so a stale export cannot misreport the dependency.
  const requiredSkills = new Set<string>();
  // And for MCP: an attachment naming a server the recipient never registered is
  // inert, so the import has to name them rather than look complete.
  const requiredMcpServers = new Set<string>();
  for (const tree of bundle.trees) {
    const existing = getWorkflowTreeRegistryEntry(tree.id, options);
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
    requiredSkills: [...requiredSkills].toSorted(),
    requiredMcpServers: [...requiredMcpServers].toSorted(),
    ...comparePolicies(bundle, params.config),
  };
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
  governanceModeDowngrade?: { from: string; to: string };
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
  const tree = bundle.trees[0];
  const treeNodeIds = tree ? collectTreeNodeIds(tree.root) : [];
  const governsTree = (policy: GovernancePolicy) =>
    tree !== undefined &&
    policyTargetsTree(policy, tree.id) &&
    (policy.nodes === undefined ||
      policy.nodes.length === 0 ||
      treeNodeIds.some((nodeId) => policyTargetsNode(policy, nodeId)));

  // Grouped, not keyed: the schema permits repeated ids, and keeping only the
  // last local definition would report identical configs as conflicting and hide
  // an extra same-id rule that genuinely changes enforcement.
  const configured = new Map<string, GovernancePolicy[]>();
  for (const policy of (config?.enterprise?.governance?.policies ?? []).filter(governsTree)) {
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
    // Whole group against whole group, in order: order is semantic among policies
    // of the same effect.
    const same =
      local.length === group.length &&
      group.every((policy, index) => {
        const counterpart = local[index];
        return (
          counterpart !== undefined && canonicalPolicy(policy) === canonicalPolicy(counterpart)
        );
      });
    if (!same) {
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
  // Grouped by effect before comparing. resolvePolicyDecision applies a FIXED
  // effect precedence (deny, then require_approval, then allow, then audit), so
  // moving a rule past one of a different effect cannot change the winner — only
  // order WITHIN an effect can. Comparing raw order would call an equivalent
  // config a conflict.
  const sequenceOf = (policies: readonly GovernancePolicy[]) =>
    (["deny", "require_approval", "allow", "audit"] as const)
      .flatMap((effect) => policies.filter((policy) => policy.effect === effect))
      .map((policy) => canonicalPolicy(policy))
      .join("\u0000");
  if (sequenceOf(localSequence) !== sequenceOf(carriedSequence)) {
    // Which ids differ: everything the target has here that the bundle did not
    // place identically, plus any carried rule now in a different position.
    const byEffect = (policies: readonly GovernancePolicy[]) =>
      (["deny", "require_approval", "allow", "audit"] as const).flatMap((effect) =>
        policies.filter((policy) => policy.effect === effect),
      );
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
 * not reported as a conflict: object key order, and selector arrays, which are
 * matched as SETS. The same normalization hashGovernanceContract applies.
 */
function canonicalPolicy(policy: GovernancePolicy): string {
  return JSON.stringify(policy, (_key, value: unknown) => {
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return [...value].toSorted();
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
