// Control UI view renders the enterprise inspection screen: recent governed
// runs, a per-execution step/trace inspector, and the workflow-tree registry.
import { html, nothing, type TemplateResult } from "lit";
import type {
  EnterpriseKnowledgeFoundationSummary,
  EnterpriseOntologyObject,
  EnterpriseRunDetail,
  EnterpriseRunSummary,
  EnterpriseTreeDetail,
  EnterpriseTreeImportIssue,
  EnterpriseTreeNode,
  EnterpriseTreesListResult,
  EnterpriseTreeSummary,
  EnterpriseTreeVersionSummary,
  ToolsCatalogResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { isToolAllowedByPolicies } from "../../../../src/agents/tool-policy-match.js";
import { t } from "../../i18n/index.ts";
import type { OntologyEntity } from "../components/ontology-graph.ts";
import "../components/modal-dialog.ts";
import "../components/ontology-graph.ts";
import "../components/workflow-tree-graph.ts";
import type {
  EnterpriseCatalogErrors,
  EnterpriseCatalogPhase,
  EnterpriseNodeDraft,
  EnterpriseNodeDraftError,
  EnterpriseBindingPicker,
  EnterpriseBindingPickerFailure,
  EnterpriseOntologyEntryDraftError,
  EnterpriseTreeConfirm,
  EnterpriseTreeEditFormat,
} from "../controllers/enterprise.ts";
import type { SkillStatusEntry } from "../types.ts";
import {
  collectNodeOntologyGraph,
  collectOntologyGraph,
  nodeObjectEntityIds,
} from "./enterprise-ontology-graph.ts";
import type { NodeOntologyListField } from "./enterprise-tree-edit.ts";
import { renderSkillStatusChips } from "./skills-shared.ts";

export type EnterpriseProps = {
  loading: boolean;
  runs: EnterpriseRunSummary[];
  trees: EnterpriseTreeSummary[];
  importErrors: EnterpriseTreesListResult["importErrors"];
  storeError: string | null;
  selectedExecutionId: string | null;
  detail: EnterpriseRunDetail | null;
  detailLoading: boolean;
  /** Full tree the selected run bound to, so its route can be shown in context. */
  runTree: EnterpriseTreeDetail | null;
  selectedTreeId: string | null;
  treeDetail: EnterpriseTreeDetail | null;
  treeLoading: boolean;
  treeIssue: string | null;
  // P4 node inspector: which workflow node is expanded, and the object instances
  // of the entity type currently shown for it (scoped to that node's ontology).
  selectedNodeId: string | null;
  nodeObjectsEntity: string | null;
  nodeObjects: EnterpriseOntologyObject[];
  nodeObjectsLoading: boolean;
  treeEditing: boolean;
  treeEditContent: string;
  treeEditFormat: EnterpriseTreeEditFormat;
  treeSaving: boolean;
  treeSaveIssues: EnterpriseTreeImportIssue[] | null;
  treeSaveError: string | null;
  treeConfirm: EnterpriseTreeConfirm | null;
  treeVersions: EnterpriseTreeVersionSummary[];
  treeVersionsLoading: boolean;
  // Whether the session holds operator.admin: tree import/remove are admin-only,
  // so mutation controls are hidden without it (reads stay available).
  canEdit: boolean;
  // P5 dynamic node creation: the open "add child node" form (under a selected
  // node), or null. Submit splices the child and loads the editor for Save.
  nodeDraft: EnterpriseNodeDraft | null;
  error: string | null;
  onRefresh: () => void;
  onSelectRun: (executionId: string) => void;
  onSelectTree: (treeId: string) => void;
  onBeginEdit: () => void;
  onBeginNew: () => void;
  onEditContent: (content: string) => void;
  onEditFormat: (format: EnterpriseTreeEditFormat) => void;
  onCancelEdit: () => void;
  onRequestSave: () => void;
  onRequestRemove: (treeId: string) => void;
  onCancelConfirm: () => void;
  onConfirm: () => void;
  onExport: (treeId: string, format: EnterpriseTreeEditFormat) => void;
  onLoadVersion: (treeId: string, revision: number) => void;
  onSelectNode: (nodeId: string | null) => void;
  onSelectNodeEntity: (entity: string) => void;
  onBeginAddNode: (parentId: string) => void;
  onEditNodeDraft: (patch: { id?: string; title?: string }) => void;
  onCancelAddNode: () => void;
  onSubmitAddNode: () => void;
  // The open "grant a tool" / "declare a skill" / "allow a knowledge foundation"
  // picker for the selected step, or null. Confirming applies the picks straight
  // through enterprise.trees.import.
  bindingPicker: EnterpriseBindingPicker | null;
  onOpenBindingPicker: (nodeId: string, field: NodeOntologyListField) => void;
  onBindingPickerQuery: (query: string) => void;
  onBindingPickerCustom: (value: string) => void;
  onToggleBindingPickerValue: (value: string) => void;
  onCancelBindingPicker: () => void;
  onSubmitBindingPicker: () => void;
  // What a step can be bound TO: every tool the gateway exposes, every installed
  // skill, and every registered knowledge foundation. The Tools/Skills tabs browse
  // these, and the step binding forms suggest from them.
  catalogPhase: EnterpriseCatalogPhase;
  catalogErrors: EnterpriseCatalogErrors;
  /** The agent whose tools/skills the catalogs describe; both are agent-scoped. */
  catalogAgentId: string | null;
  toolGroups: ToolsCatalogResult["groups"];
  skills: SkillStatusEntry[];
  foundations: EnterpriseKnowledgeFoundationSummary[];
  /** Which enterprise surface to render; chosen by the active sidebar tab. */
  section: EnterpriseSection;
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * Enterprise surfaces, in sidebar order. Each one is its own sidebar tab under the
 * Enterprise group (see navigation.ts), so this view renders exactly the surface the
 * active tab selects rather than owning an in-view sub-tab row.
 */
export const ENTERPRISE_SECTIONS = ["worktree", "history", "tools", "skills"] as const;
export type EnterpriseSection = (typeof ENTERPRISE_SECTIONS)[number];

/** i18n message for a rejected step-binding draft. */
function ontologyEntryErrorMessage(error: EnterpriseOntologyEntryDraftError): string {
  const messages: Record<EnterpriseOntologyEntryDraftError, string> = {
    "entry-empty": t("enterprise.entryDraft.empty"),
    "entry-duplicate": t("enterprise.entryDraft.duplicate"),
    "skill-name-invalid": t("enterprise.entryDraft.skillNameInvalid"),
    "foundation-id-invalid": t("enterprise.entryDraft.foundationIdInvalid"),
    "node-missing": t("enterprise.entryDraft.nodeMissing"),
    "export-failed": t("enterprise.entryDraft.exportFailed"),
    "import-not-sent": t("enterprise.entryDraft.importNotSent"),
    "import-failed": t("enterprise.entryDraft.importFailed"),
  };
  return messages[error];
}

/**
 * Message for a catalog that has nothing to show: distinguishes "still loading"
 * and "the load failed" from the real claim that the deployment has none, which
 * can only be made once an answer arrived.
 */
function renderCatalogEmpty(
  phase: EnterpriseCatalogPhase,
  error: string | null,
  emptyMessage: string,
): TemplateResult | typeof nothing {
  if (error) {
    return html`<div class="callout danger" style="margin-top: 12px;">${error}</div>`;
  }
  if (phase !== "ready") {
    return html`<div class="muted" style="margin-top: 12px;">${t("common.loading")}</div>`;
  }
  return html`<div class="muted" style="margin-top: 12px;">${emptyMessage}</div>`;
}

/** One catalog entry the picker can offer, with what it is for. */
type BindingOption = { value: string; description?: string };

/**
 * Example shape for the picker's typed entry, per binding kind. Only tool scopes
 * take groups and globs; the other two are validated names, so advertising a
 * glob there would invite a value the import rejects.
 */
const CUSTOM_PLACEHOLDER: Partial<Record<NodeOntologyListField, string>> = {
  allowedTools: "group:enterprise",
  skills: "refund-policy",
  knowledgeFoundations: "acme.runbooks",
};

function customEntryLabel(field: NodeOntologyListField): string {
  return field === "allowedTools"
    ? t("enterprise.picker.customToolLabel")
    : t("enterprise.picker.customNameLabel");
}

/**
 * What to say when the list is empty. "Everything is already on this step" is only
 * true for a READY catalog with nothing left to offer — saying it while the
 * catalog is still loading or failed sends the operator to look for a problem
 * that is not there, and the error banner behind the modal is not visible.
 */
function pickerEmptyMessage(params: {
  phase: EnterpriseCatalogPhase;
  error: string | null;
  hasQuery: boolean;
  catalogExhausted: boolean;
}): string {
  if (params.error) {
    return params.error;
  }
  if (params.phase !== "ready") {
    return t("common.loading");
  }
  if (params.hasQuery) {
    return t("enterprise.picker.noQueryMatches");
  }
  return params.catalogExhausted
    ? t("enterprise.picker.allAdded")
    : t("enterprise.picker.emptyCatalog");
}

/** One step-binding row: the field's current values plus the add affordance. */
type OntologyEntryAdder = {
  /** The step being bound. Callers render this inside that node's inspector. */
  nodeId: string;
  field: NodeOntologyListField;
  values: readonly string[];
  /** Row heading, e.g. "Tools — ontology.allowedTools". */
  title: string;
  /** Catalog entries the picker lists, with an optional one-line description. */
  options: readonly BindingOption[];
  /**
   * Warning shown when adding the first entry FLIPS this step into an allow-list:
   * with no local list the step allows everything, so the first entry silently
   * revokes the rest. Told before they do it, not after.
   */
  scopeWarning?: string | null;
  /** Ancestor steps whose own allow-list still gates what is added here. */
  constrainingAncestors?: readonly string[];
  /** Per-value annotation (e.g. a declared skill no install provides), or null. */
  valueNote?: (value: string) => string | null;
};

/**
 * The "add an entry to this step" affordance, rendered inside the selected node's
 * inspector on Worktree. The Tools/Skills tabs browse the whole catalog instead,
 * so the step a change lands on is always the one on screen.
 */
function renderBindingGroup(props: EnterpriseProps, adder: OntologyEntryAdder): TemplateResult {
  const { field, nodeId } = adder;
  return html`
    <section class="binding-group">
      <header class="binding-group__head">
        <span class="binding-group__title">${adder.title}</span>
        <span class="chip">${adder.values.length}</span>
        ${props.canEdit
          ? html`<button
              type="button"
              class="btn"
              @click=${() => props.onOpenBindingPicker(nodeId, field)}
            >
              ${t("enterprise.entryDraft.add")}
            </button>`
          : nothing}
      </header>
      <div class="binding-group__body">
        ${adder.values.length === 0
          ? html`<div class="muted">${t("enterprise.entryDraft.none")}</div>`
          : html`<div class="chip-row">
              ${adder.values.map((value) => {
                const note = adder.valueNote?.(value) ?? null;
                return html`<span class="chip"
                  ><code>${value}</code>${note
                    ? html`<span class="chip chip-warn">${note}</span>`
                    : nothing}</span
                >`;
              })}
            </div>`}
        ${adder.scopeWarning ? html`<div class="callout">${adder.scopeWarning}</div>` : nothing}
        ${adder.constrainingAncestors?.length
          ? html`<div class="callout">
              ${t("enterprise.entryDraft.ancestorGate", {
                nodeIds: adder.constrainingAncestors.join(", "),
              })}
            </div>`
          : nothing}
      </div>
    </section>
  `;
}

/**
 * The search-and-pick dialog behind every binding row's Add button.
 *
 * A dialog rather than an inline field because the operator is choosing from a
 * catalog of hundreds: they need room to search and to see what each entry is,
 * and the answer is a selection, not a remembered string. Confirming applies the
 * picks directly — the tree is spliced and imported — so the entry the operator
 * chose is the thing that lands, with no generated JSON to approve in between.
 */
function renderBindingPicker(
  props: EnterpriseProps,
  adders: readonly OntologyEntryAdder[],
): TemplateResult | typeof nothing {
  const picker = props.bindingPicker;
  // canEdit is checked here, not only on the Add button that opened this: a
  // reconnect can drop operator.admin while the modal is up, and an import is
  // admin-only — leaving it actionable would hand the operator a Confirm the
  // server can only refuse.
  if (!picker || !props.canEdit || picker.treeId !== props.treeDetail?.id) {
    return nothing;
  }
  const adder = adders.find(
    (candidate) => candidate.field === picker.field && candidate.nodeId === picker.nodeId,
  );
  if (!adder) {
    return nothing;
  }
  const query = picker.query.trim().toLowerCase();
  const already = new Set(adder.values);
  // Entries the step already has are dropped rather than shown ticked: adding one
  // twice is the duplicate the import rejects, so offering it is a dead end.
  const matches = adder.options
    .filter((option) => !already.has(option.value))
    .filter(
      (option) =>
        !query ||
        option.value.toLowerCase().includes(query) ||
        (option.description ?? "").toLowerCase().includes(query),
    );
  // Same normalization the submit does: the custom value counts as a pick, and
  // typing one that is also ticked adds one binding, not two.
  const custom = picker.custom.trim();
  const pickedCount = new Set([...picker.selected, ...(custom ? [custom] : [])]).size;
  const idle = picker.phase === "idle";
  // Only a request the server already has is uncancellable; during the export
  // this is still a plain Cancel, and saying otherwise would tell the operator a
  // governance change landed when nothing was written.
  const writing = picker.phase === "writing";
  const canSubmit = idle && pickedCount > 0;
  const catalogError =
    adder.field === "allowedTools"
      ? props.catalogErrors.tools
      : adder.field === "skills"
        ? props.catalogErrors.skills
        : props.catalogErrors.foundations;
  return html`
    <openclaw-modal-dialog
      label=${adder.title}
      description=${t("enterprise.picker.subtitle")}
      wide
      @modal-cancel=${props.onCancelBindingPicker}
    >
      <div class="binding-picker">
        <div class="binding-picker__head">
          <div class="card-title">${adder.title}</div>
          <div class="muted">${t("enterprise.picker.step", { nodeId: picker.nodeId })}</div>
        </div>
        <input
          type="search"
          class="binding-picker__search"
          .value=${picker.query}
          ?disabled=${!idle}
          aria-label=${t("enterprise.picker.searchLabel")}
          placeholder=${t("enterprise.picker.searchLabel")}
          @input=${(event: Event) =>
            props.onBindingPickerQuery((event.target as HTMLInputElement).value)}
        />
        <div class="binding-picker__list">
          ${matches.length === 0
            ? html`<div class="muted">
                ${pickerEmptyMessage({
                  phase: props.catalogPhase,
                  error: catalogError,
                  hasQuery: query.length > 0,
                  catalogExhausted: adder.options.length > 0,
                })}
              </div>`
            : matches.map(
                (option) => html`<label class="binding-picker__option">
                  <input
                    type="checkbox"
                    .checked=${picker.selected.includes(option.value)}
                    ?disabled=${!idle}
                    @change=${() => props.onToggleBindingPickerValue(option.value)}
                  />
                  <span class="binding-picker__option-main">
                    <code>${option.value}</code>
                    ${option.description
                      ? html`<span class="list-sub">${option.description}</span>`
                      : nothing}
                  </span>
                </label>`,
              )}
        </div>
        <!-- Every field keeps a typed entry. Tool scopes are globs and groups no
          catalog can enumerate; skills and foundations are agent-scoped, and this
          catalog answered for one agent while a work-map can govern runs for
          others — so pick-only would make a skill installed elsewhere unaddable.
          What is typed still has to satisfy the import contract. -->
        <label class="binding-picker__custom">
          <span class="muted">${customEntryLabel(adder.field)}</span>
          <input
            type="text"
            .value=${picker.custom}
            ?disabled=${!idle}
            placeholder=${CUSTOM_PLACEHOLDER[adder.field] ?? ""}
            @input=${(event: Event) =>
              props.onBindingPickerCustom((event.target as HTMLInputElement).value)}
          />
        </label>
        <!-- Repeated here, not only on the row behind the dialog: this is where
          the operator confirms, and the row's warning sits after its Add button
          in DOM order, so a keyboard or screen-reader user would reach the
          action before ever hearing that the first entry revokes the rest or
          that an ancestor still gates it. -->
        ${adder.scopeWarning ? html`<div class="callout">${adder.scopeWarning}</div>` : nothing}
        ${adder.constrainingAncestors?.length
          ? html`<div class="callout">
              ${t("enterprise.entryDraft.ancestorGate", {
                nodeIds: adder.constrainingAncestors.join(", "),
              })}
            </div>`
          : nothing}
        ${writing ? html`<div class="callout">${t("enterprise.picker.saving")}</div>` : nothing}
        ${picker.failure ? renderPickerFailure(picker.failure) : nothing}
        <div class="row" style="justify-content: flex-end; gap: 8px;">
          <!-- Never disabled: a stalled request has no client-side timeout, this
            modal does not close on backdrop interaction, and a touch client has
            no Escape key — so disabling this is the difference between a slow
            save and a trapped operator. It CLOSES rather than cancels once the
            write is in flight (there is no way to recall it), and says so, or an
            operator would read a dismissed dialog as an allowlist left alone. -->
          <button type="button" class="btn" @click=${props.onCancelBindingPicker}>
            ${writing ? t("enterprise.picker.close") : t("common.cancel")}
          </button>
          <button
            type="button"
            class="btn primary"
            ?disabled=${!canSubmit}
            @click=${props.onSubmitBindingPicker}
          >
            ${idle
              ? t("enterprise.picker.confirm", { count: String(pickedCount) })
              : t("common.saving")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

/**
 * A stopped apply. A server rejection renders its issue paths: those name the
 * value to change, so collapsing them into one sentence would leave the operator
 * with a refusal and no way to act on it.
 */
function renderPickerFailure(failure: EnterpriseBindingPickerFailure): TemplateResult {
  if (failure.kind === "import-rejected") {
    // A refusal the server sent no issues for still has to read as a refusal, not
    // as an empty list under a heading promising reasons.
    if (failure.issues.length === 0) {
      return html`<div class="callout danger">${t("enterprise.entryDraft.importRejected")}</div>`;
    }
    return html`<div class="callout danger">
      <div>${t("enterprise.saveInvalid")}</div>
      ${failure.issues.map(
        (issue) => html`<div class="muted">
          ${issue.path ? html`<strong>${issue.path}</strong>: ` : nothing}${issue.message}
        </div>`,
      )}
    </div>`;
  }
  if (failure.kind === "import-refused") {
    // The gateway's own message names the reason (permissions, a stale revision);
    // dropping it would leave a refusal with nothing to act on.
    return html`<div class="callout danger">
      ${t("enterprise.entryDraft.importRefused", { message: failure.message })}
    </div>`;
  }
  return html`<div class="callout danger">${ontologyEntryErrorMessage(failure.kind)}</div>`;
}

/**
 * Ancestors of `nodeId` that carry their OWN allow-list for `field`. Governance
 * checks every node on the root->active path as an independent gate
 * (ontologyScopeViolation in src/enterprise/governance.ts for tools,
 * foundationAllowedByPath in knowledge.ts for foundations), so an entry added here
 * is still denied unless each of these ancestors allows it too — the operator has
 * to see that before believing the change took effect.
 */
function constrainingAncestorIds(
  props: EnterpriseProps,
  nodeId: string,
  field: "allowedTools" | "knowledgeFoundations",
): string[] {
  const nodes = props.treeDetail?.nodes;
  if (!nodes) {
    return [];
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids: string[] = [];
  let current = byId.get(nodeId)?.parentId ?? null;
  while (current) {
    const node = byId.get(current);
    if (!node) {
      break;
    }
    if (node.ontology[field]?.length) {
      ids.push(node.id);
    }
    current = node.parentId;
  }
  return ids;
}

/**
 * Core tool sections that exist only for governed steps. CORE_TOOL_SECTION_ORDER
 * (src/agents/tool-catalog.ts) sorts them LAST, so an operator who opens Tools to
 * see what a step can bind scrolls past every stock group to reach the two this
 * product added. Reordered for display only — the catalog order every other
 * surface reads is untouched.
 */
const ENTERPRISE_TOOL_SECTION_IDS: ReadonlySet<string> = new Set([
  "enterprise",
  "enterprise-write",
]);

function isEnterpriseToolGroup(group: ToolsCatalogResult["groups"][number]): boolean {
  return group.source === "core" && ENTERPRISE_TOOL_SECTION_IDS.has(group.id);
}

/** Enterprise groups first; every other group keeps its catalog order. */
function enterpriseToolGroupsFirst(
  groups: ToolsCatalogResult["groups"],
): ToolsCatalogResult["groups"] {
  const enterprise = groups.filter((group) => isEnterpriseToolGroup(group));
  const stock = groups.filter((group) => !isEnterpriseToolGroup(group));
  return [...enterprise, ...stock];
}

/** A step of the selected work-map that binds one catalog entry. */
type CatalogUsage = { nodeId: string; title: string };

function addUsage(usage: Map<string, CatalogUsage[]>, key: string, node: EnterpriseTreeNode): void {
  const steps = usage.get(key);
  const step = { nodeId: node.id, title: node.title };
  if (steps) {
    steps.push(step);
    return;
  }
  usage.set(key, [step]);
}

/**
 * Every tool policy on the root->node path, nearest first. Governance treats each
 * scoped node on that path as an INDEPENDENT gate (ontologyScopeViolation in
 * src/enterprise/governance.ts), so a step that lists `memory_search` under a root
 * that allows only `message` can never call it. Unscoped ancestors contribute no
 * policy — an empty allow-list means "allow everything not denied", which would
 * wrongly widen the composition.
 */
function toolPolicyPath(
  node: EnterpriseTreeNode,
  byId: Map<string, EnterpriseTreeNode>,
): { path: EnterpriseTreeNode[]; policies: Array<{ allow: string[]; deny: string[] }> } {
  const path: EnterpriseTreeNode[] = [];
  const policies: Array<{ allow: string[]; deny: string[] }> = [];
  const seen = new Set<string>();
  let current: EnterpriseTreeNode | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    const allow = current.ontology.allowedTools ?? [];
    const deny = current.ontology.deniedTools ?? [];
    if (allow.length > 0 || deny.length > 0) {
      policies.push({ allow: [...allow], deny: [...deny] });
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return { path, policies };
}

/**
 * `invoke_action` is the one tool the allow-list alone does not grant: governance
 * additionally requires a node on the path to NAME it or `group:enterprise-write`
 * (ONTOLOGY_WRITE_OPT_INS in src/enterprise/runtime.ts). A `*` allow-list has not
 * thought about writes and `group:enterprise` has only ever meant read, so a
 * matcher-only answer would advertise write access every such step is denied.
 * Path-wide `some`, matching activePathAllowsWrites, not the per-node `every` the
 * allow-list uses.
 */
const ONTOLOGY_WRITE_TOOL = "invoke_action";
const ONTOLOGY_WRITE_OPT_INS: ReadonlySet<string> = new Set([
  "invoke_action",
  "group:enterprise-write",
]);

function pathAllowsOntologyWrites(path: readonly EnterpriseTreeNode[]): boolean {
  return path.some((node) =>
    (node.ontology.allowedTools ?? []).some((tool) =>
      ONTOLOGY_WRITE_OPT_INS.has(tool.trim().toLowerCase()),
    ),
  );
}

/**
 * Which steps of the selected work-map put each catalog tool in scope. Delegates
 * to the runtime gate (isToolAllowedByPolicies, the same matcher governance calls)
 * so `group:` selectors and `*` globs resolve to exactly the tools they resolve to
 * at call time — a literal "is this id in the array" check would report a step as
 * unbound while the runtime lets it call, and an own-scope-only check would claim
 * a step can call a tool an ancestor denies it.
 *
 * Steps with no `allowedTools` of their own are skipped: governance leaves them
 * unscoped, so they allow everything their ancestors do, and listing them under
 * every tool would drown the steps that actually made a choice.
 */
function collectToolUsage(
  nodes: readonly EnterpriseTreeNode[] | undefined,
  groups: ToolsCatalogResult["groups"],
): Map<string, CatalogUsage[]> {
  const usage = new Map<string, CatalogUsage[]>();
  const all = nodes ?? [];
  const scoped = all.filter((node) => node.ontology.allowedTools?.length);
  if (scoped.length === 0) {
    return usage;
  }
  const byId = new Map(all.map((node) => [node.id, node]));
  const resolved = new Map(scoped.map((node) => [node.id, toolPolicyPath(node, byId)]));
  for (const group of groups) {
    for (const tool of group.tools) {
      for (const node of scoped) {
        const gate = resolved.get(node.id);
        if (!gate || !isToolAllowedByPolicies(tool.id, gate.policies)) {
          continue;
        }
        if (tool.id === ONTOLOGY_WRITE_TOOL && !pathAllowsOntologyWrites(gate.path)) {
          continue;
        }
        addUsage(usage, tool.id, node);
      }
    }
  }
  return usage;
}

/**
 * Which steps declare each skill. Unlike tools this is an exact-name match: the
 * schema validates every entry with SkillNameSchema (src/enterprise/schema.ts),
 * so a skill list holds names only — no groups and no globs to expand.
 */
function collectSkillUsage(
  nodes: readonly EnterpriseTreeNode[] | undefined,
): Map<string, CatalogUsage[]> {
  const usage = new Map<string, CatalogUsage[]>();
  for (const node of nodes ?? []) {
    for (const name of node.ontology.skills ?? []) {
      addUsage(usage, name, node);
    }
  }
  return usage;
}

/**
 * Where a catalog entry is already used. The catalogs are deployment-wide, so
 * without this the operator cannot tell an entry their work-map depends on from
 * one nothing has bound — which is the only question the catalog cannot answer
 * by itself. Titles go in the tooltip; step ids are what the bindings show.
 */
function renderCatalogUsage(
  usage: readonly CatalogUsage[] | undefined,
  label: string | null,
): TemplateResult | typeof nothing {
  if (!usage?.length || !label) {
    return nothing;
  }
  return html`<div class="chip-row" style="margin-top: 6px;">
    <span class="muted">${label}</span>
    ${usage.map((step) => html`<span class="chip" title=${step.title}>${step.nodeId}</span>`)}
  </div>`;
}

/**
 * Says which work-map the chips are measured against, or why there are none.
 * Silence would read as "nothing uses this" rather than "nothing was asked".
 *
 * A `treeIssue` means enterprise.trees.get fell back to a built-in after an
 * import or store read failed. The chips still come from that fallback and stay
 * shown — under `enterprise.mode: "observe"` the built-in is what runs, so hiding
 * them would be wrong — but the banner says the selection did not load, because
 * under enforce the failed tree governs nothing.
 */
function renderCatalogUsageScope(props: EnterpriseProps): TemplateResult {
  if (props.treeIssue) {
    // A failed load may or may not come with a fallback definition (the protocol
    // allows `tree: null` beside an error, and a rejected request leaves nothing
    // at all). Only the first case has steps on screen to explain, so claiming a
    // fallback in the second would describe rows that are not there.
    return html`<div class="callout" style="margin-top: 8px;">
      ${props.treeDetail
        ? t("enterprise.catalogUsage.treeIssue", { message: props.treeIssue })
        : t("enterprise.catalogUsage.treeUnavailable", { message: props.treeIssue })}
    </div>`;
  }
  const treeName = props.treeDetail?.name ?? null;
  return html`<div class="muted" style="margin-top: 4px;">
    ${treeName
      ? t("enterprise.catalogUsage.scope", { treeName })
      : t("enterprise.catalogUsage.noWorkMap")}
  </div>`;
}

/**
 * Which agent the catalogs answered for. Plugin tools resolve against an agent's
 * workspace and skills against its filter, so a deployment with several agents
 * does not have one catalog — say whose this is instead of implying it is global.
 */
function renderCatalogAgentScope(agentId: string | null): TemplateResult | typeof nothing {
  return agentId
    ? html`<div class="muted" style="margin-top: 4px;">
        ${t("enterprise.catalogAgentScope", { agentId })}
      </div>`
    : nothing;
}

/**
 * Every tool the gateway exposes, grouped as the runtime groups them. This is a
 * catalog to browse, not a step's scope: which of these a step may call is set
 * per node on Worktree.
 */
function renderEnterpriseTools(props: EnterpriseProps): TemplateResult {
  const treeName = props.treeDetail?.name ?? null;
  const usage = collectToolUsage(props.treeDetail?.nodes, props.toolGroups);
  const usageLabel = treeName ? t("enterprise.catalogUsage.usedBy", { treeName }) : null;
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("enterprise.toolsTab.title")}</div>
      <div class="card-sub">${t("enterprise.toolsTab.subtitle")}</div>
      ${renderCatalogAgentScope(props.catalogAgentId)}${renderCatalogUsageScope(props)}
      <div class="muted" style="margin-top: 8px;">${t("enterprise.toolsTab.attachHint")}</div>
      ${props.toolGroups.length === 0
        ? renderCatalogEmpty(
            props.catalogPhase,
            props.catalogErrors.tools,
            t("enterprise.toolsTab.empty"),
          )
        : html`<div class="list" style="margin-top: 12px;">
            ${enterpriseToolGroupsFirst(props.toolGroups).map((group) =>
              renderToolCatalogGroup(group, usage, usageLabel),
            )}
          </div>`}
    </section>
  `;
}

function renderToolCatalogGroup(
  group: ToolsCatalogResult["groups"][number],
  usage: Map<string, CatalogUsage[]>,
  usageLabel: string | null,
): TemplateResult {
  return html`
    <!-- list-item-stacked: this row has no .list-meta, and the default two-column
      .list-item grid would place the expanded body in the 200-260px meta column. -->
    <details class="list-item list-item-stacked" ?open=${isEnterpriseToolGroup(group)}>
      <summary class="catalog-summary">
        <span class="catalog-summary-row">
          <span class="list-title">${group.label}</span>
          <span class="chip"
            >${t("enterprise.toolsTab.toolCount", { count: String(group.tools.length) })}</span
          >
          <!-- Only core sections have a group: selector (CORE_TOOL_GROUPS is built from
            them), so a plugin group shows its owner instead of a selector that would
            not resolve in an allow-list. -->
          ${group.source === "core"
            ? html`<code>group:${group.id}</code>`
            : html`<span class="chip"
                >${t("enterprise.toolsTab.pluginBadge", {
                  pluginId: group.pluginId ?? group.id,
                })}</span
              >`}
        </span>
      </summary>
      <div class="list catalog-children">
        ${group.tools.map(
          (tool) => html`<div class="list-item list-item-stacked">
            <div class="list-main">
              <div class="list-title">
                <code>${tool.id}</code>
                <!-- Declared but conditional: an optional plugin tool is cataloged
                  before its config resolves, so it may not bind at runtime. -->
                ${tool.optional
                  ? html`<span class="chip">${t("enterprise.toolsTab.optionalBadge")}</span>`
                  : nothing}
              </div>
              ${tool.description ? html`<div class="list-sub">${tool.description}</div>` : nothing}
              ${renderCatalogUsage(usage.get(tool.id), usageLabel)}
            </div>
          </div>`,
        )}
      </div>
    </details>
  `;
}

/** One catalog row for an installed skill, with where the work-map declares it. */
function renderSkillCatalogRow(
  skill: SkillStatusEntry,
  usage: Map<string, CatalogUsage[]>,
  usageLabel: string | null,
): TemplateResult {
  return html`<div class="list-item list-item-stacked">
    <div class="list-main">
      <div class="list-title"><code>${skill.name}</code></div>
      ${skill.description ? html`<div class="list-sub">${skill.description}</div>` : nothing}
      ${renderSkillStatusChips({ skill, showBundledBadge: skill.bundled === true })}
      ${renderCatalogUsage(usage.get(skill.name), usageLabel)}
    </div>
  </div>`;
}

/**
 * A skill the work-map declares that the catalog did not return. The row itself
 * is driven by the tree, which is authoritative on its own — without it the tab
 * would show the work-map as fully covered while the step it is declared on can
 * never load it.
 *
 * `installStatusKnown` gates only the verdict: until skills.status answers, an
 * absent entry means unknown, not missing, and a red badge would accuse an
 * install that may well provide it.
 */
function renderDeclaredOnlySkillRow(
  name: string,
  usage: Map<string, CatalogUsage[]>,
  usageLabel: string | null,
  installStatusKnown: boolean,
): TemplateResult {
  return html`<div class="list-item list-item-stacked">
    <div class="list-main">
      <div class="list-title">
        <code>${name}</code>
        ${installStatusKnown
          ? html`<span class="chip chip-warn">${t("enterprise.bindings.skillNotInstalled")}</span>`
          : nothing}
      </div>
      ${renderCatalogUsage(usage.get(name), usageLabel)}
    </div>
  </div>`;
}

/**
 * Every installed skill. Like Tools this is the catalog, not a step's
 * declaration: a step names the skills its work depends on from Worktree. The
 * ones the selected work-map declares are lifted out of the alphabet soup into
 * their own section — that is the set an operator came here to check.
 */
function renderEnterpriseSkills(props: EnterpriseProps): TemplateResult {
  const treeName = props.treeDetail?.name ?? null;
  const usage = collectSkillUsage(props.treeDetail?.nodes);
  // "Declared by", not "Used by": a step's `skills` entry reaches the model (the
  // digest names it under that step as a preference), but it does not install a
  // skill or scope availability — that stays agent-wide. "Used by" would imply
  // this step is where the skill becomes available, which declaring never does.
  const usageLabel = treeName ? t("enterprise.catalogUsage.declaredBy", { treeName }) : null;
  const declared = props.skills.filter((skill) => usage.has(skill.name));
  const rest = props.skills.filter((skill) => !usage.has(skill.name));
  // Declared names the catalog did not return. Listed whatever the catalog did:
  // the work-map declares them either way, and dropping them while skills.status
  // is loading or failed would hide a real dependency behind a transient error.
  // Only the "not installed" verdict waits for a clean answer (same rule as the
  // binding rows): before that, absent means unknown rather than missing.
  const skillsKnown = props.catalogPhase === "ready" && !props.catalogErrors.skills;
  const installed = new Set(props.skills.map((skill) => skill.name));
  const declaredOnly = [...usage.keys()].filter((name) => !installed.has(name));
  const hasDeclaredSection = treeName !== null && declared.length + declaredOnly.length > 0;
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("enterprise.skillsTab.title")}</div>
      <div class="card-sub">${t("enterprise.skillsTab.subtitle")}</div>
      ${renderCatalogAgentScope(props.catalogAgentId)}${renderCatalogUsageScope(props)}
      <div class="muted" style="margin-top: 8px;">${t("enterprise.skillsTab.attachHint")}</div>
      ${hasDeclaredSection
        ? html`<div class="card-title" style="margin-top: 16px;">
              ${t("enterprise.skillsTab.declaredSection", { treeName: treeName ?? "" })}
            </div>
            <div class="list" style="margin-top: 8px;">
              ${declared.map((skill) => renderSkillCatalogRow(skill, usage, usageLabel))}
              ${declaredOnly.map((name) =>
                renderDeclaredOnlySkillRow(name, usage, usageLabel, skillsKnown),
              )}
            </div>`
        : nothing}
      ${props.skills.length === 0
        ? renderCatalogEmpty(
            props.catalogPhase,
            props.catalogErrors.skills,
            t("enterprise.skillsTab.empty"),
          )
        : nothing}
      ${rest.length === 0
        ? nothing
        : html`${hasDeclaredSection
              ? html`<div class="card-title" style="margin-top: 16px;">
                  ${t("enterprise.skillsTab.otherSection")}
                </div>`
              : nothing}
            <div class="list" style="margin-top: 8px;">
              ${rest.map((skill) => renderSkillCatalogRow(skill, usage, usageLabel))}
            </div>`}
    </section>
  `;
}

export function renderEnterprise(props: EnterpriseProps) {
  const section = props.section;
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("enterprise.title")}</div>
          <div class="card-sub">${t("enterprise.subtitle")}</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
      ${props.storeError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${t("enterprise.storeError", { message: props.storeError })}
          </div>`
        : nothing}
      ${props.importErrors.length
        ? html`<div class="callout" style="margin-top: 12px;">
            <div>${t("enterprise.importErrors")}</div>
            ${props.importErrors.map(
              (issue) => html`<div class="row" style="justify-content: space-between; gap: 8px;">
                <div class="muted">${issue.treeId}: ${issue.message}</div>
                ${props.canEdit
                  ? html`<button
                      class="btn danger"
                      @click=${() => props.onRequestRemove(issue.treeId)}
                    >
                      ${t("enterprise.remove")}
                    </button>`
                  : nothing}
              </div>`,
            )}
          </div>`
        : nothing}
    </section>

    ${section === "history"
      ? html`
          <section class="card" style="margin-top: 16px;">
            <div class="card-title">${t("enterprise.runsTitle")}</div>
            <div class="list" style="margin-top: 12px;">
              ${props.runs.length === 0
                ? html`<div class="muted">${t("enterprise.noRuns")}</div>`
                : props.runs.map((run) =>
                    renderRun(run, props.selectedExecutionId, props.onSelectRun),
                  )}
            </div>
          </section>
          ${renderDetailCard(props)}
        `
      : nothing}
    ${section === "worktree"
      ? html`
          <section class="card" style="margin-top: 16px;">
            <div class="row" style="justify-content: space-between;">
              <div class="card-title">${t("enterprise.treesTitle")}</div>
              ${props.canEdit
                ? html`<button class="btn" @click=${props.onBeginNew}>
                    ${t("enterprise.newTree")}
                  </button>`
                : nothing}
            </div>
            <div class="list" style="margin-top: 12px;">
              ${props.trees.length === 0
                ? html`<div class="muted">${t("enterprise.noTrees")}</div>`
                : props.trees.map((tree) =>
                    renderTree(tree, props.selectedTreeId, props.onSelectTree),
                  )}
            </div>
          </section>
          ${renderTreeVisualization(props)}
        `
      : nothing}
    ${section === "tools" ? renderEnterpriseTools(props) : nothing}
    ${section === "skills" ? renderEnterpriseSkills(props) : nothing}
    <!-- Outside the subsection switch: the global Remove action (shown with import
      errors on any tab) sets the confirm state, so its modal must render everywhere. -->
    ${renderTreeConfirmModal(props)}
  `;
}

function renderRun(
  run: EnterpriseRunSummary,
  selectedExecutionId: string | null,
  onSelectRun: (executionId: string) => void,
): TemplateResult {
  const selected = run.executionId === selectedExecutionId;
  return html`
    <div
      class="list-item list-item-clickable ${selected ? "list-item-selected" : ""}"
      role="button"
      tabindex="0"
      @click=${() => onSelectRun(run.executionId)}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectRun(run.executionId);
        }
      }}
    >
      <div class="list-main">
        <div class="list-title">${run.treeId}@${run.treeVersion}</div>
        <div class="list-sub">${run.requestSummary}</div>
        <div class="chip-row">
          <span class="chip">${run.status}</span>
          <span class="chip">${run.mode}</span>
          <span class="chip">${run.activeNodeId}</span>
        </div>
      </div>
      <div class="list-meta">
        <div class="muted">${formatTime(run.createdAt)}</div>
      </div>
    </div>
  `;
}

function renderDetailCard(props: EnterpriseProps): TemplateResult {
  if (!props.selectedExecutionId) {
    return html`
      <section class="card" style="margin-top: 16px;">
        <div class="muted">${t("enterprise.selectRun")}</div>
      </section>
    `;
  }
  const detail = props.detail;
  if (!detail) {
    // detailLoading tracks the runs.get fetch specifically, so a slow detail
    // load shows a spinner rather than a false "no runs" empty state.
    return html`
      <section class="card" style="margin-top: 16px;">
        <div class="muted">
          ${props.detailLoading ? t("common.loading") : t("enterprise.detailUnavailable")}
        </div>
      </section>
    `;
  }
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("enterprise.detailTitle")}</div>
      <div class="card-sub">${detail.treeName} — ${detail.treeId}@${detail.treeVersion}</div>
      <div class="chip-row" style="margin-top: 8px;">
        <span class="chip">${detail.status}</span>
        <span class="chip">${detail.mode}</span>
        <span class="chip">${t("enterprise.activeStep", { node: detail.activeNodeId })}</span>
        <span class="chip"
          >${t("enterprise.executionCount", { count: String(detail.executionCount) })}</span
        >
      </div>

      ${renderRoute(detail, props.runTree)}

      <div class="card-title" style="margin-top: 16px;">${t("enterprise.stepsTitle")}</div>
      <div class="list" style="margin-top: 8px;">
        ${detail.nodes.map((node) => renderStep(node, detail.activeNodeId))}
      </div>

      <div class="card-title" style="margin-top: 16px;">${t("enterprise.traceTitle")}</div>
      <div class="list" style="margin-top: 8px;">
        ${detail.events.length === 0
          ? html`<div class="muted">${t("enterprise.noTrace")}</div>`
          : detail.events.map((event) => renderEvent(event))}
      </div>
    </section>
  `;
}

/**
 * The route the run took. Drawn as the WHOLE tree with the planned nodes lit and
 * everything else dimmed: the branches the run did not take are the information
 * — a plan-only view would just show a small tree and hide what was skipped.
 */
function renderRoute(
  detail: EnterpriseRunDetail,
  runTree: EnterpriseTreeDetail | null,
): TemplateResult | typeof nothing {
  const route = detail.route;
  const plannedIds = detail.nodes.map((node) => node.nodeId);
  if (!route && !runTree) {
    return nothing;
  }
  const coverage = route ? `${route.selectedNodes}/${route.totalNodes}` : null;
  return html`
    <div class="card-title" style="margin-top: 16px;">${t("enterprise.routeTitle")}</div>
    ${route
      ? html`<div class="chip-row" style="margin-top: 8px;">
            <span class="chip">
              ${route.source === "planner"
                ? t("enterprise.routeSource.planner")
                : t("enterprise.routeSource.wholeTree")}
            </span>
            <span class="chip">${t("enterprise.routeCoverage", { coverage: coverage ?? "" })}</span>
            ${route.routes.map((id) => html`<span class="chip">${id}</span>`)}
          </div>
          <div class="muted" style="margin-top: 6px; font-size: 12px;">${route.rationale}</div>
          ${route.invalidRoutes?.length
            ? html`<div class="callout danger" style="margin-top: 8px;">
                ${t("enterprise.routeInvalid", { routes: route.invalidRoutes.join(", ") })}
              </div>`
            : nothing}`
      : nothing}
    ${runTree
      ? html`<openclaw-workflow-tree-graph
          .nodes=${runTree.nodes}
          .routeNodeIds=${plannedIds}
        ></openclaw-workflow-tree-graph>`
      : nothing}
  `;
}

function renderStep(
  node: EnterpriseRunDetail["nodes"][number],
  activeNodeId: string,
): TemplateResult {
  const ontology = node.ontology;
  return html`
    <div class="list-item ${node.nodeId === activeNodeId ? "list-item-selected" : ""}">
      <div class="list-main">
        <div class="list-title">
          ${node.seq}. ${node.title}
          ${node.nodeId === activeNodeId
            ? html`<span class="chip">${t("enterprise.activeBadge")}</span>`
            : nothing}
        </div>
        ${node.description ? html`<div class="list-sub">${node.description}</div>` : nothing}
        ${ontology.guidance
          ? html`<div class="list-sub">
              ${t("enterprise.guidance", { text: ontology.guidance })}
            </div>`
          : nothing}
        <div class="chip-row">
          ${ontology.allowedTools?.length
            ? html`<span class="chip"
                >${t("enterprise.allowedTools", { tools: ontology.allowedTools.join(", ") })}</span
              >`
            : nothing}
          ${ontology.deniedTools?.length
            ? html`<span class="chip"
                >${t("enterprise.deniedTools", { tools: ontology.deniedTools.join(", ") })}</span
              >`
            : nothing}
          ${ontology.knowledgeFoundations?.length
            ? html`<span class="chip"
                >${t("enterprise.knowledge", {
                  ids: ontology.knowledgeFoundations.join(", "),
                })}</span
              >`
            : nothing}
          ${ontology.skills?.length
            ? html`<span class="chip"
                >${t("enterprise.skills", { ids: ontology.skills.join(", ") })}</span
              >`
            : nothing}
          ${ontology.audit ? html`<span class="chip">${t("enterprise.audit")}</span>` : nothing}
        </div>
      </div>
      <div class="list-meta">
        <div class="muted">${node.nodeId}</div>
      </div>
    </div>
  `;
}

function renderEvent(event: EnterpriseRunDetail["events"][number]): TemplateResult {
  const chips = Object.entries(event.payload)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 6)
    .map(([key, value]) => html`<span class="chip">${key}: ${String(value)}</span>`);
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${event.kind}</div>
        ${event.nodeId ? html`<div class="list-sub">${event.nodeId}</div>` : nothing}
        ${chips.length ? html`<div class="chip-row">${chips}</div>` : nothing}
      </div>
      <div class="list-meta">
        <div class="muted">#${event.seq}</div>
      </div>
    </div>
  `;
}

function renderTree(
  tree: EnterpriseTreeSummary,
  selectedTreeId: string | null,
  onSelectTree: (treeId: string) => void,
): TemplateResult {
  const selected = tree.id === selectedTreeId;
  return html`
    <div
      class="list-item list-item-clickable ${selected ? "list-item-selected" : ""}"
      role="button"
      tabindex="0"
      @click=${() => onSelectTree(tree.id)}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectTree(tree.id);
        }
      }}
    >
      <div class="list-main">
        <div class="list-title">${tree.id}@${tree.version}</div>
        <div class="list-sub">${tree.name}</div>
        <div class="chip-row">
          <span class="chip">${tree.source}</span>
          <span class="chip">${t("enterprise.nodeCount", { count: String(tree.nodeCount) })}</span>
        </div>
      </div>
    </div>
  `;
}

function renderTreeVisualization(props: EnterpriseProps): TemplateResult {
  // The raw editor takes over the panel while editing (also for a new tree,
  // which has no selection yet).
  if (props.treeEditing) {
    return renderTreeEditor(props);
  }
  if (!props.selectedTreeId) {
    return html`
      <section class="card" style="margin-top: 16px;">
        <div class="muted">${t("enterprise.selectTree")}</div>
      </section>
    `;
  }
  const tree = props.treeDetail;
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="row" style="justify-content: space-between;">
        <div class="card-title">${t("enterprise.treeTitle")}</div>
        ${renderTreeActions(props)}
      </div>
      ${props.treeIssue
        ? html`<div class="callout danger" style="margin-top: 8px;">${props.treeIssue}</div>`
        : nothing}
      ${props.treeSaveError
        ? html`<div class="callout danger" style="margin-top: 8px;">${props.treeSaveError}</div>`
        : nothing}
      ${tree
        ? renderTreeDetail(tree, props)
        : html`<div class="muted" style="margin-top: 8px;">
            ${props.treeLoading ? t("common.loading") : t("enterprise.treeUnavailable")}
          </div>`}
      ${renderVersionHistory(props)}
    </section>
  `;
}

/** Actions for the selected tree: export is read-only; edit/remove need admin. */
function renderTreeActions(props: EnterpriseProps): TemplateResult | typeof nothing {
  const tree = props.treeDetail;
  const treeId = props.selectedTreeId;
  if (!treeId) {
    return nothing;
  }
  // Removable = a persisted import row exists to delete: a healthy imported tree,
  // or an id the registry reports as a corrupt import (whose row remove clears,
  // even though trees.get returned a fallback built-in or null). Use the
  // authoritative importErrors list, NOT treeIssue, which also holds transient
  // trees.get request failures that must not expose a destructive Remove.
  const hasCorruptImport = props.importErrors.some((issue) => issue.treeId === treeId);
  const removable = props.canEdit && (tree?.source === "imported" || hasCorruptImport);
  const buttons: TemplateResult[] = [];
  if (tree && props.canEdit) {
    buttons.push(
      html`<button class="btn" @click=${props.onBeginEdit}>${t("enterprise.edit")}</button>`,
    );
  }
  if (tree) {
    buttons.push(
      html`<button class="btn" @click=${() => props.onExport(treeId, "yaml")}>
        ${t("enterprise.exportYaml")}
      </button>`,
      html`<button class="btn" @click=${() => props.onExport(treeId, "json")}>
        ${t("enterprise.exportJson")}
      </button>`,
    );
  }
  if (removable) {
    buttons.push(
      html`<button class="btn danger" @click=${() => props.onRequestRemove(treeId)}>
        ${t("enterprise.remove")}
      </button>`,
    );
  }
  return buttons.length === 0 ? nothing : html`<div class="row" style="gap: 8px;">${buttons}</div>`;
}

/** Raw YAML/JSON editor for creating or overwriting a tree definition. */
function renderTreeEditor(props: EnterpriseProps): TemplateResult {
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="row" style="justify-content: space-between;">
        <div class="card-title">${t("enterprise.editorTitle")}</div>
        <div class="chip-row">
          ${(["yaml", "json"] as const).map(
            (format) => html`<button
              class="chip ${props.treeEditFormat === format ? "list-item-selected" : ""}"
              ?disabled=${props.treeSaving}
              @click=${() => props.onEditFormat(format)}
            >
              ${format.toUpperCase()}
            </button>`,
          )}
        </div>
      </div>
      <div class="muted" style="margin-top: 4px;">${t("enterprise.editorHint")}</div>
      <textarea
        class="input"
        style="margin-top: 8px; width: 100%; min-height: 320px; font-family: monospace; white-space: pre;"
        .value=${props.treeEditContent}
        ?disabled=${props.treeSaving}
        @input=${(event: Event) => props.onEditContent((event.target as HTMLTextAreaElement).value)}
      ></textarea>
      ${props.treeSaveError
        ? html`<div class="callout danger" style="margin-top: 8px;">${props.treeSaveError}</div>`
        : nothing}
      ${props.treeSaveIssues?.length
        ? html`<div class="callout danger" style="margin-top: 8px;">
            <div>${t("enterprise.saveInvalid")}</div>
            ${props.treeSaveIssues.map(
              (issue) => html`<div class="muted">
                ${issue.path ? html`<strong>${issue.path}</strong>: ` : nothing}${issue.message}
              </div>`,
            )}
          </div>`
        : nothing}
      <div class="row" style="gap: 8px; margin-top: 12px;">
        <button class="btn primary" ?disabled=${props.treeSaving} @click=${props.onRequestSave}>
          ${props.treeSaving ? t("enterprise.saving") : t("enterprise.save")}
        </button>
        <button class="btn" ?disabled=${props.treeSaving} @click=${props.onCancelEdit}>
          ${t("common.cancel")}
        </button>
      </div>
    </section>
  `;
}

/** Saved-revision list; selecting one loads it into the editor to restore. */
function renderVersionHistory(props: EnterpriseProps): TemplateResult {
  const treeId = props.selectedTreeId;
  return html`
    <div class="card-title" style="margin-top: 16px;">${t("enterprise.historyTitle")}</div>
    ${props.treeVersions.length === 0
      ? html`<div class="muted" style="margin-top: 8px;">
          ${props.treeVersionsLoading ? t("common.loading") : t("enterprise.noHistory")}
        </div>`
      : html`<div class="list" style="margin-top: 8px;">
          ${props.treeVersions.map((version) =>
            renderVersionRow(version, treeId, props.canEdit ? props.onLoadVersion : null),
          )}
        </div>`}
  `;
}

function renderVersionRow(
  version: EnterpriseTreeVersionSummary,
  treeId: string | null,
  // Null when the session lacks admin: revisions are shown but not loadable
  // into the editor (restoring is a mutation).
  onLoadVersion: ((treeId: string, revision: number) => void) | null,
): TemplateResult {
  const body = html`
    <div class="list-main">
      <div class="list-title">
        ${t("enterprise.revision", { revision: String(version.revision) })} — ${version.version}
      </div>
      <div class="chip-row">
        <span class="chip">${version.sourceFormat}</span>
        <span class="chip">${formatTime(version.savedAt)}</span>
      </div>
    </div>
  `;
  // A read-only row is plain (no listeners): passing lit's `nothing` sentinel to
  // @click/@keydown is treated as a real listener and throws on interaction.
  if (onLoadVersion === null || treeId === null) {
    return html`<div class="list-item">${body}</div>`;
  }
  const load = () => onLoadVersion(treeId, version.revision);
  return html`
    <div
      class="list-item list-item-clickable"
      role="button"
      tabindex="0"
      @click=${load}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          load();
        }
      }}
    >
      ${body}
    </div>
  `;
}

/** Save/Remove confirmation dialog reusing the shared modal component. */
function renderTreeConfirmModal(props: EnterpriseProps): TemplateResult | typeof nothing {
  const confirm = props.treeConfirm;
  if (!confirm) {
    return nothing;
  }
  const isRemove = confirm.kind === "remove";
  const title = isRemove ? t("enterprise.confirmRemoveTitle") : t("enterprise.confirmSaveTitle");
  const body = isRemove
    ? t("enterprise.confirmRemoveBody", { treeId: confirm.treeId })
    : t("enterprise.confirmSaveBody");
  return html`
    <openclaw-modal-dialog
      label=${title}
      description=${body}
      @modal-cancel=${props.onCancelConfirm}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${body}</div>
          </div>
        </div>
        ${isRemove
          ? html`<div class="callout danger" style="margin-top: 12px;">
              ${t("enterprise.confirmRemoveWarning")}
            </div>`
          : nothing}
        <div class="exec-approval-actions">
          <button class="btn ${isRemove ? "danger" : "primary"}" @click=${props.onConfirm}>
            ${isRemove ? t("enterprise.remove") : t("enterprise.save")}
          </button>
          <button class="btn" @click=${props.onCancelConfirm}>${t("common.cancel")}</button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderTreeDetail(tree: EnterpriseTreeDetail, props: EnterpriseProps): TemplateResult {
  return html`
    <div class="card-sub">${tree.name} — ${tree.id}@${tree.version}</div>
    ${tree.description
      ? html`<div class="muted" style="margin-top: 4px;">${tree.description}</div>`
      : nothing}

    <div class="card-title" style="margin-top: 16px;">${t("enterprise.structureTitle")}</div>
    <openclaw-workflow-tree-graph
      .nodes=${tree.nodes}
      .selected=${props.selectedNodeId}
      @node-select=${(event: CustomEvent<{ nodeId: string | null }>) =>
        props.onSelectNode(event.detail.nodeId)}
    ></openclaw-workflow-tree-graph>
    ${renderNodeInspector(tree, props)} ${renderWholeTreeOverview(tree, props)}
  `;
}

/**
 * The merged whole-tree ontology, shown only while no node is selected. Selecting
 * a node swaps in that node's root→node scope via renderNodeInspector, so the two
 * graphs never render together (the always-on merged graph used to read as a
 * step's "default ontology" and be mistaken for a node's own scope). Labeled to
 * make its whole-tree meaning explicit.
 */
function renderWholeTreeOverview(
  tree: EnterpriseTreeDetail,
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  if (props.selectedNodeId) {
    return nothing;
  }
  const { entities, relationships } = collectOntologyGraph(tree);
  return html`
    <div class="card-title" style="margin-top: 16px;">
      ${t("enterprise.wholeTreeOverviewTitle")}
    </div>
    ${entities.length === 0
      ? html`<div class="muted" style="margin-top: 8px;">${t("enterprise.noOntology")}</div>`
      : html`<openclaw-ontology-graph
          .entities=${entities}
          .relationships=${relationships}
        ></openclaw-ontology-graph>`}
  `;
}

/**
 * The clicked node's own scope: the ontology it can address (root→node path) and
 * the live object instances of its entity types. This is the operator-facing
 * mirror of what the agent sees at that node — the point of P4.
 */
function renderNodeInspector(
  tree: EnterpriseTreeDetail,
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  const nodeId = props.selectedNodeId;
  if (!nodeId) {
    return nothing;
  }
  const node = tree.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return nothing;
  }
  const { entities, relationships } = collectNodeOntologyGraph(tree, nodeId);
  // Chip list must match what the controller loads by default: only object types
  // that can actually carry instances (a primaryKey). Derive both from the one
  // helper so the view never offers a chip the controller would refuse to load.
  const objectEntityIds = new Set(nodeObjectEntityIds(tree, nodeId));
  const objectEntities = entities.filter((entity) => objectEntityIds.has(entity.id));
  // Built once: the groups render from them and the picker dialog resolves the
  // row it was opened for out of the same list, so the two cannot disagree.
  const adders = nodeBindingAdders(node, props);
  return html`
    <section class="card-nested" style="margin-top: 12px;">
      <div class="card-sub">${t("enterprise.nodeInspectorTitle")}: ${node.title} — ${node.id}</div>
      ${node.description
        ? html`<div class="muted" style="margin-top: 4px;">${node.description}</div>`
        : nothing}
      ${entities.length === 0
        ? html`<div class="muted" style="margin-top: 8px;">${t("enterprise.nodeNoOntology")}</div>`
        : html`
            <openclaw-ontology-graph
              .entities=${entities}
              .relationships=${relationships}
            ></openclaw-ontology-graph>
            ${renderNodeObjects(objectEntities, props)}
          `}
      ${renderNodeBindings(adders, props)}
      <!-- Adding a CHILD STEP is structural: it changes the workflow shape, not
        what this step may call. Kept in its own block, behind a rule, so it is
        not read as a fourth kind of binding. -->
      ${props.canEdit
        ? html`<div class="node-structure">
            <div class="card-title">${t("enterprise.addNodeSectionTitle")}</div>
            <div class="muted" style="margin-top: 4px;">
              ${t("enterprise.addNodeSectionSubtitle")}
            </div>
            ${renderAddNode(tree.id, nodeId, props)}
          </div>`
        : nothing}
    </section>
    ${renderBindingPicker(props, adders)}
  `;
}

/**
 * What this step is bound to: its tool scope, the skills it declares, and the
 * knowledge foundations it may query. Read-only without operator.admin; with it,
 * each row can add an entry, which splices into the tree definition and opens the
 * editor for review + Save (the single enterprise.trees.import write path).
 */
function nodeBindingAdders(
  node: EnterpriseTreeDetail["nodes"][number],
  props: EnterpriseProps,
): OntologyEntryAdder[] {
  const ontology = node.ontology;
  const allowedTools = ontology.allowedTools ?? [];
  const foundations = ontology.knowledgeFoundations ?? [];
  const installedSkills = new Set(props.skills.map((skill) => skill.name));
  const { ids: retrievableIds, ownershipKnown } = retrievableFoundations(props);
  // Only claim something is missing once ITS catalog answered without error:
  // a failed request also leaves an empty list, which would otherwise mark every
  // declared value unresolved.
  const skillsKnown = props.catalogPhase === "ready" && !props.catalogErrors.skills;
  // Ownership is part of the claim: without it a value cannot be called
  // unavailable, only unverified.
  const foundationsKnown =
    props.catalogPhase === "ready" && !props.catalogErrors.foundations && ownershipKnown;
  return [
    {
      nodeId: node.id,
      field: "allowedTools",
      values: allowedTools,
      title: t("enterprise.bindings.tools"),
      options: toolBindingOptions(props),
      // No LOCAL allowlist means the step allows everything (minus its denials),
      // so the first entry narrows it either way — a deny-only step converts too.
      scopeWarning: allowedTools.length === 0 ? t("enterprise.entryDraft.scopeNarrowing") : null,
      constrainingAncestors: constrainingAncestorIds(props, node.id, "allowedTools"),
    },
    {
      nodeId: node.id,
      field: "skills",
      values: ontology.skills ?? [],
      title: t("enterprise.bindings.skills"),
      options: props.skills.map((skill) => ({
        value: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
      })),
      // A declared skill resolves to instructions only when the agent has it, so
      // the operator has to see which declarations resolve today. Named per agent:
      // the skill set is agent-scoped, and a tree can govern a different agent
      // than the one this catalog answered for.
      valueNote: (value) =>
        skillsKnown && !installedSkills.has(value)
          ? t("enterprise.bindings.skillNotInstalled")
          : null,
    },
    {
      nodeId: node.id,
      field: "knowledgeFoundations",
      values: foundations,
      title: t("enterprise.bindings.knowledge"),
      options: [...retrievableIds].toSorted().map((value) => ({ value })),
      // Same path-gate shape as tools: an omitted list lets the step query every
      // registered foundation, so the first entry restricts it.
      scopeWarning: foundations.length === 0 ? t("enterprise.entryDraft.knowledgeNarrowing") : null,
      constrainingAncestors: constrainingAncestorIds(props, node.id, "knowledgeFoundations"),
      valueNote: (value) =>
        foundationsKnown && !retrievableIds.has(value)
          ? t("enterprise.bindings.foundationNotRegistered")
          : null,
    },
  ];
}

/**
 * What this step is bound to: its tool scope, the skills it declares, and the
 * knowledge foundations it may query.
 *
 * Three separate cards, not one run-on list: they are three different kinds of
 * binding with different rules, and an operator scanning for "what can this step
 * call" should not have to parse where one ends and the next begins.
 */
function renderNodeBindings(
  adders: readonly OntologyEntryAdder[],
  props: EnterpriseProps,
): TemplateResult {
  return html`
    <div class="card-title" style="margin-top: 16px;">${t("enterprise.bindings.title")}</div>
    <div class="muted" style="margin-top: 4px;">${t("enterprise.bindings.subtitle")}</div>
    ${renderCatalogAgentScope(props.catalogAgentId)}${renderBindingCatalogIssues(props)}
    <div class="binding-groups">${adders.map((adder) => renderBindingGroup(props, adder))}</div>
  `;
}

/**
 * Foundation ids the SELECTED tree can actually retrieve: plugin-registered ones
 * (global, reported as an EMPTY owner list) plus the bundle foundations this tree
 * owns. The registry list is deployment-wide, but retrieval resolves a bundle
 * foundation only for its owning tree (resolveRetrievalAdapter in
 * src/enterprise/knowledge.ts), so suggesting or accepting another workflow's id
 * would promise a `knowledge_search` that returns nothing here.
 *
 * A gateway older than `ownerTreeIds` omits it entirely, which is UNKNOWN, not
 * global: nothing can be scoped or contradicted, so every id stays suggestible
 * (as before the field existed) and `ownershipKnown` is false so no value is
 * labelled unavailable on a guess.
 */
function retrievableFoundations(props: EnterpriseProps): {
  ids: Set<string>;
  ownershipKnown: boolean;
} {
  const treeId = props.treeDetail?.id;
  const ownershipKnown = props.foundations.every(
    (foundation) => foundation.ownerTreeIds !== undefined,
  );
  const usable = ownershipKnown
    ? props.foundations.filter((foundation) => {
        const owners = foundation.ownerTreeIds ?? [];
        return owners.length === 0 || (treeId ? owners.includes(treeId) : false);
      })
    : props.foundations;
  return { ids: new Set(usable.map((foundation) => foundation.id)), ownershipKnown };
}

/**
 * Catalog failures the binding rows depend on. Without this the operator sees
 * empty completions and unverified declarations with no hint that a load failed —
 * the Tools and Skills tabs show their own errors, so this surface must too.
 */
function renderBindingCatalogIssues(props: EnterpriseProps): TemplateResult | typeof nothing {
  const messages = [
    props.catalogErrors.tools,
    props.catalogErrors.skills,
    props.catalogErrors.foundations,
  ].filter((message): message is string => Boolean(message));
  if (messages.length === 0) {
    return nothing;
  }
  return html`<div class="callout danger" style="margin-top: 8px;">
    ${messages.map((message) => html`<div>${message}</div>`)}
  </div>`;
}

/**
 * Pickable tool grants: each core section's `group:` selector, then every catalog
 * tool. Plugin groups have no selector (CORE_TOOL_GROUPS is built from core
 * sections only), so offering one would list an entry that matches nothing.
 * Groups come first because granting a whole section is the coarser, more common
 * choice and the search box handles the rest.
 */
function toolBindingOptions(props: EnterpriseProps): BindingOption[] {
  const groups: BindingOption[] = [];
  const tools: BindingOption[] = [];
  for (const group of props.toolGroups) {
    if (group.source === "core") {
      groups.push({
        value: `group:${group.id}`,
        description: t("enterprise.picker.groupOption", {
          label: group.label,
          count: String(group.tools.length),
        }),
      });
    }
    for (const tool of group.tools) {
      tools.push({
        value: tool.id,
        ...(tool.description ? { description: tool.description } : {}),
      });
    }
  }
  return [...groups, ...tools];
}

/** i18n message for a rejected node-add draft. */
function nodeDraftErrorMessage(error: EnterpriseNodeDraftError): string {
  const messages: Record<EnterpriseNodeDraftError, string> = {
    "id-empty": t("enterprise.addNodeErrorIdEmpty"),
    "id-pattern": t("enterprise.addNodeErrorIdPattern"),
    "id-duplicate": t("enterprise.addNodeErrorIdDuplicate"),
    "title-empty": t("enterprise.addNodeErrorTitleEmpty"),
    "parent-missing": t("enterprise.addNodeErrorParentMissing"),
    "export-failed": t("enterprise.addNodeErrorExportFailed"),
  };
  return messages[error];
}

/**
 * The "add child node" affordance under the selected node: a button that opens an
 * inline form (new-node id + title). Submitting splices a bare child into the
 * tree definition and loads the editor to review + Save, so creation reuses the
 * existing import path. Admin-only (the caller gates on canEdit).
 */
function renderAddNode(treeId: string, nodeId: string, props: EnterpriseProps): TemplateResult {
  // Match the tree too: a draft under a node id shared by another tree (e.g. a
  // root named "root") must not resurface here after a tree switch.
  const draft =
    props.nodeDraft?.treeId === treeId && props.nodeDraft.parentId === nodeId
      ? props.nodeDraft
      : null;
  if (!draft) {
    return html`
      <button
        type="button"
        class="btn"
        style="margin-top: 12px;"
        @click=${() => props.onBeginAddNode(nodeId)}
      >
        ${t("enterprise.addNodeButton")}
      </button>
    `;
  }
  const fieldStyle =
    "width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text);";
  return html`
    <div class="card-nested" style="margin-top: 12px;">
      <div class="card-sub">${t("enterprise.addNodeTitle")}</div>
      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 8px;">
        <label style="display: flex; flex-direction: column; gap: 4px;">
          <span class="muted">${t("enterprise.addNodeIdLabel")}</span>
          <input
            style=${fieldStyle}
            .value=${draft.id}
            placeholder=${`${nodeId}.step`}
            @input=${(event: Event) =>
              props.onEditNodeDraft({ id: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label style="display: flex; flex-direction: column; gap: 4px;">
          <span class="muted">${t("enterprise.addNodeTitleLabel")}</span>
          <input
            style=${fieldStyle}
            .value=${draft.title}
            @input=${(event: Event) =>
              props.onEditNodeDraft({ title: (event.target as HTMLInputElement).value })}
          />
        </label>
        ${draft.error
          ? html`<div class="callout danger">${nodeDraftErrorMessage(draft.error)}</div>`
          : nothing}
        <div class="row" style="gap: 8px;">
          <button type="button" class="btn primary" @click=${props.onSubmitAddNode}>
            ${t("enterprise.addNodeSubmit")}
          </button>
          <button type="button" class="btn" @click=${props.onCancelAddNode}>
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderNodeObjects(
  objectEntities: OntologyEntity[],
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  if (objectEntities.length === 0) {
    return nothing;
  }
  const active = props.nodeObjectsEntity ?? objectEntities[0]?.id ?? null;
  return html`
    <div class="card-title" style="margin-top: 12px;">${t("enterprise.nodeObjectsTitle")}</div>
    <div class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 8px;">
      ${objectEntities.map(
        (entity) => html`
          <button
            type="button"
            class="chip ${entity.id === active ? "chip-active" : ""}"
            @click=${() => props.onSelectNodeEntity(entity.id)}
          >
            ${entity.title ?? entity.id}
          </button>
        `,
      )}
    </div>
    ${props.nodeObjectsLoading
      ? html`<div class="muted" style="margin-top: 8px;">${t("common.loading")}</div>`
      : renderObjectTable(props.nodeObjects)}
  `;
}

function renderObjectTable(objects: EnterpriseOntologyObject[]): TemplateResult {
  if (objects.length === 0) {
    return html`<div class="muted" style="margin-top: 8px;">${t("enterprise.nodeNoObjects")}</div>`;
  }
  // The property union across the returned rows is the column set: instances of
  // one type may carry different optional fields, and a fixed column list would
  // hide whichever the first row happened to omit.
  const columns = [...new Set(objects.flatMap((object) => Object.keys(object.properties)))];
  return html`
    <div class="table-scroll" style="margin-top: 8px;">
      <table class="mini-table">
        <thead>
          <tr>
            <th>id</th>
            ${columns.map((column) => html`<th>${column}</th>`)}
            <th>source</th>
          </tr>
        </thead>
        <tbody>
          ${objects.map(
            (object) => html`
              <tr>
                <td><code>${object.objectId}</code></td>
                ${columns.map(
                  (column) => html`<td>${formatOntologyValue(object.properties[column])}</td>`,
                )}
                <td><span class="muted">${object.provenance}</span></td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function formatOntologyValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  return String(value);
}
