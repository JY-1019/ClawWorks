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
  EnterpriseBindingDetail,
  EnterpriseBindingPicker,
  EnterpriseBindingPickerFailure,
  EnterpriseMcpDraft,
  EnterpriseOntologyDraft,
  EnterpriseOntologyDraftBody,
  EnterpriseOntologyEntryDraftError,
  EnterpriseTreeConfirm,
  EnterpriseTreeEditFormat,
} from "../controllers/enterprise.ts";
import { parseMcpServerImport } from "../controllers/mcp-server-import.ts";
import type { SkillStatusEntry } from "../types.ts";
import {
  collectNodeOntologyGraph,
  declaredExecutableEntityIds,
  declaredNodePathEntityIds,
  collectOntologyGraph,
  nodeObjectEntityIds,
} from "./enterprise-ontology-graph.ts";
import {
  ONTOLOGY_CARDINALITIES,
  ONTOLOGY_EFFECT_KINDS,
  ONTOLOGY_VALUE_TYPES,
  type NodeOntologyListField,
  type OntologyCardinalityName,
  type OntologyEffectKindName,
  type OntologyValueTypeName,
} from "./enterprise-tree-edit.ts";
import type { McpServerRow } from "./mcp.ts";
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
  resuming: boolean;
  onResumeRun: (executionId: string) => void;
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
  /** Switch the selected work-map between explicit and inherited capability grants. */
  onToggleCapabilityGrants: () => void;
  onBeginAddNode: (parentId: string) => void;
  onEditNodeDraft: (patch: { id?: string; title?: string }) => void;
  onCancelAddNode: () => void;
  onSubmitAddNode: () => void;
  // The open "grant a tool" / "declare a skill" / "allow a knowledge foundation"
  // picker for the selected step, or null. Confirming applies the picks straight
  // through enterprise.trees.import.
  bindingPicker: EnterpriseBindingPicker | null;
  onOpenBindingPicker: (nodeId: string, field: NodeOntologyListField) => void;
  /**
   * Detach one entry. Separate from the picker: the picker collects a selection,
   * while this is already a specific entry on a specific step.
   */
  onRemoveBinding: (nodeId: string, field: NodeOntologyListField, entry: string) => void;
  /**
   * The binding chip whose detail card is open, or null. A read-out, not an edit:
   * it answers "what IS this entry" from catalogs the screen already holds.
   */
  bindingDetail: EnterpriseBindingDetail | null;
  onOpenBindingDetail: (detail: {
    nodeId: string;
    field: NodeOntologyListField;
    entry: string;
    origin: "step" | "inherited";
  }) => void;
  onCloseBindingDetail: () => void;
  /** In-progress role-prompt edit, or null when nothing is being edited. */
  guidanceDraft: { treeId: string; nodeId: string; text: string } | null;
  onGuidanceDraft: (nodeId: string, text: string) => void;
  onSaveGuidance: (nodeId: string) => void;
  onCancelGuidance: () => void;
  /** The one open ontology form, or null. */
  ontologyDraft: EnterpriseOntologyDraft | null;
  onOntologyDraft: (draft: EnterpriseOntologyDraftBody) => void;
  onEditOntologyDraft: (patch: Partial<EnterpriseOntologyDraft>) => void;
  onSubmitOntologyDraft: () => void;
  onCancelOntologyDraft: () => void;
  onRemoveOntologyEntity: (nodeId: string, entityId: string) => void;
  onRemoveOntologyProperty: (nodeId: string, entityId: string, propertyId: string) => void;
  onRemoveOntologyRelationship: (
    nodeId: string,
    link: { id: string; from: string; to: string },
  ) => void;
  onRemoveOntologyAction: (nodeId: string, actionId: string) => void;
  onRemoveOntologyActionEffect: (
    nodeId: string,
    effect: { actionId: string; entity: string; kind: OntologyEffectKindName },
  ) => void;
  onRemoveOntologyActionParameter: (
    nodeId: string,
    parameter: { actionId: string; parameterId: string },
  ) => void;
  onRemoveOntologyFunction: (nodeId: string, functionId: string) => void;
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
  /**
   * MCP servers registered in config. Not a catalog request: registration lives in
   * `mcp.servers`, which the Control UI already holds, and the same list drives the
   * MCP screen, the step attachments, and the picker.
   */
  mcpServers: McpServerRow[];
  /**
   * Whether the config that holds `mcp.servers` has actually arrived. An empty
   * list before it does is UNKNOWN, not "nothing registered" — labelling an
   * attachment unregistered on that would accuse a server the gateway has.
   */
  mcpServersKnown: boolean;
  mcpDraft: EnterpriseMcpDraft | null;
  /** Effective `enterprise.mode`; only "enforce" actually withholds a server. */
  enterpriseMode: "enforce" | "observe" | "off";
  /**
   * Whether registering a server here is safe right now. False while config has
   * not arrived (a draft started from `{}` would be saved OVER the real config)
   * and while a raw-mode config draft is pending (registering writes the form,
   * and syncing that form serializes over the raw text the operator is editing).
   */
  canRegisterMcp: boolean;
  mcpRegisterBlockedReason: string | null;
  /** Whether the gateway is reachable; a config write cannot be saved without it. */
  connected: boolean;
  configDirty: boolean;
  configSaving: boolean;
  configApplying: boolean;
  onBeginMcpDraft: () => void;
  onBeginMcpEdit: (name: string) => void;
  onEditMcpDraft: (patch: Partial<Omit<EnterpriseMcpDraft, "error" | "errorDetail">>) => void;
  onEditMcpHeader: (index: number, patch: { name?: string; value?: string } | null) => void;
  onAddMcpHeader: () => void;
  onCancelMcpDraft: () => void;
  onSubmitMcpDraft: () => void;
  onToggleMcpServer: (name: string, enabled: boolean) => void;
  /** Server whose removal is awaiting confirmation, or null. */
  mcpRemoveConfirm: string | null;
  onRequestRemoveMcpServer: (name: string) => void;
  onCancelRemoveMcpServer: () => void;
  onConfirmRemoveMcpServer: () => void;
  onSaveConfig: () => void;
  onApplyConfig: () => void;
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
export const ENTERPRISE_SECTIONS = ["worktree", "history", "tools", "skills", "mcp"] as const;
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
  // Same matcher as the allow-list, so the same shape of example.
  deniedTools: "bash",
  skills: "refund-policy",
  knowledgeFoundations: "acme.runbooks",
};

/** Both tool lists draw from the tool catalog; everything else names an id. */
function isToolBackedField(field: NodeOntologyListField): boolean {
  return field === "allowedTools" || field === "deniedTools";
}

function customEntryLabel(field: NodeOntologyListField): string {
  return isToolBackedField(field)
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
  /** Row heading, e.g. "Allowed". The definition key comes from BINDING_FIELD_META. */
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
  /**
   * Entries an ancestor step granted that apply here too. Shown separately from
   * `values` because they are not this step's to remove — editing them means
   * editing the ancestor.
   */
  inheritedValues?: readonly string[];
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
        <code class="binding-group__key">${BINDING_FIELD_META[field].configKey}</code>
        <span class="chip">${adder.values.length}</span>
        ${props.canEdit
          ? html`<button
              type="button"
              class="btn btn--sm"
              ?disabled=${props.treeSaving}
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
              ${adder.values.map((value) =>
                renderBindingChip({ props, adder, value, origin: "step" }),
              )}
            </div>`}
        <!-- Inherited grants sit under the step's own, dimmed and labelled: they
          apply to this step but belong to an ancestor, so removing one means
          editing that step instead of this one. -->
        ${adder.inheritedValues?.length
          ? html`<div class="chip-row" style="margin-top: 6px;">
              <span class="muted">${t("enterprise.bindings.inherited")}</span>
              ${adder.inheritedValues.map((value) =>
                renderBindingChip({ props, adder, value, origin: "inherited" }),
              )}
            </div>`
          : nothing}
        ${adder.scopeWarning ? html`<div class="callout">${adder.scopeWarning}</div>` : nothing}
        ${adder.constrainingAncestors?.length
          ? html`<div class="callout">
              ${t("enterprise.entryDraft.ancestorGateApproval", {
                nodeIds: adder.constrainingAncestors.join(", "),
              })}
            </div>`
          : nothing}
      </div>
    </section>
  `;
}

/**
 * One entry on a binding row.
 *
 * The label is a BUTTON, not text: a chip carries a bare id (`group:enterprise`,
 * `acme.kb`) and the operator's next question is always what that id actually
 * resolves to — a question the catalogs on this screen can answer without a round
 * trip. Detach stays a separate control beside it so the two acts never share a
 * hit target.
 *
 * Inherited entries open the same card but never get a Detach: they belong to the
 * ancestor that declared them, and the card says which one to edit instead.
 */
function renderBindingChip(params: {
  props: EnterpriseProps;
  adder: OntologyEntryAdder;
  value: string;
  origin: "step" | "inherited";
}): TemplateResult {
  const { props, adder, value, origin } = params;
  const note = adder.valueNote?.(value) ?? null;
  const removable = props.canEdit && origin === "step";
  return html`<span class="chip chip-entry ${origin === "inherited" ? "chip-entry--inherited" : ""}"
    ><button
      type="button"
      class="chip-open"
      title=${t("enterprise.bindingDetail.openTitle", { entry: value })}
      @click=${() =>
        props.onOpenBindingDetail({
          nodeId: adder.nodeId,
          field: adder.field,
          entry: value,
          origin,
        })}
    >
      <code>${value}</code>${note ? html`<span class="chip chip-warn">${note}</span>` : nothing}</button
    >${removable
      ? html`<button
          type="button"
          class="chip-remove"
          title=${t("enterprise.entryDraft.removeTitle", { entry: value })}
          aria-label=${t("enterprise.entryDraft.removeTitle", { entry: value })}
          ?disabled=${props.treeSaving}
          @click=${() => props.onRemoveBinding(adder.nodeId, adder.field, value)}
        >
          ×
        </button>`
      : nothing}</span
  >`;
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
  // MCP options come from config, which arrives with the screen — so this field
  // has neither a catalog request to fail nor one to wait for. Falling through to
  // the foundations error (or the shared phase) would report an unrelated
  // catalog's problem as this picker's.
  const configBacked = adder.field === "mcpServers";
  const catalogError = configBacked
    ? null
    : isToolBackedField(adder.field)
      ? props.catalogErrors.tools
      : adder.field === "skills"
        ? props.catalogErrors.skills
        : props.catalogErrors.foundations;
  // Config-backed, but config is a REQUEST too and the worktree becomes
  // interactive while it is still in flight. Hard-coding "ready" would report an
  // empty catalog for servers that are simply not here yet.
  const catalogPhase: EnterpriseCatalogPhase = configBacked
    ? props.mcpServersKnown
      ? "ready"
      : "loading"
    : props.catalogPhase;
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
                  phase: catalogPhase,
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
        <!-- Inherited grants sit under the step's own, dimmed and labelled: they
          apply to this step but belong to an ancestor, so removing one means
          editing that step instead of this one. -->
        ${adder.inheritedValues?.length
          ? html`<div class="chip-row" style="margin-top: 6px;">
              <span class="muted">${t("enterprise.bindings.inherited")}</span>
              ${adder.inheritedValues.map(
                (value) => html`<span class="chip"><code>${value}</code></span>`,
              )}
            </div>`
          : nothing}
        ${adder.scopeWarning ? html`<div class="callout">${adder.scopeWarning}</div>` : nothing}
        ${adder.constrainingAncestors?.length
          ? html`<div class="callout">
              ${t("enterprise.entryDraft.ancestorGateApproval", {
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
 * The definition key each binding row writes, and what to call one of its entries.
 *
 * One table, because both the row header and the detail card print the key: two
 * literals for the same mapping is exactly the pair that drifts when a field is
 * renamed, and a header naming the wrong key is worse than naming none.
 */
const BINDING_FIELD_META: Record<NodeOntologyListField, { labelKey: string; configKey: string }> = {
  allowedTools: {
    labelKey: "enterprise.bindingDetail.kindTool",
    configKey: "ontology.allowedTools",
  },
  deniedTools: {
    labelKey: "enterprise.bindingDetail.kindDeniedTool",
    configKey: "ontology.deniedTools",
  },
  skills: { labelKey: "enterprise.bindingDetail.kindSkill", configKey: "ontology.skills" },
  knowledgeFoundations: {
    labelKey: "enterprise.bindingDetail.kindKnowledge",
    configKey: "ontology.knowledgeFoundations",
  },
  mcpServers: { labelKey: "enterprise.bindingDetail.kindMcp", configKey: "ontology.mcpServers" },
};

/** One label/value line of the detail card. */
function renderDetailRow(label: string, value: unknown): TemplateResult {
  return html`<div class="detail-row">
    <span class="detail-row__label">${label}</span>
    <span class="detail-row__value">${value}</span>
  </div>`;
}

/** A chip row of ids, the shape every "which steps / which tools" answer uses. */
function renderIdChips(ids: readonly string[]): TemplateResult {
  return html`<span class="chip-row"
    >${ids.map((id) => html`<span class="chip"><code>${id}</code></span>`)}</span
  >`;
}

/**
 * Other steps of this work-map that declare the same entry on the same field.
 *
 * An exact-name scan, deliberately: it answers "where else is this written down",
 * which is a question about the definition, not about what governance resolves.
 * The tool rows are the only ones where an entry can be a pattern, and a pattern
 * is still stored verbatim — so a literal match is what the operator would find
 * by opening the file.
 */
function stepsAlsoDeclaring(
  props: EnterpriseProps,
  field: NodeOntologyListField,
  entry: string,
  exceptNodeId: string,
): string[] {
  return (props.treeDetail?.nodes ?? [])
    .filter((node) => node.id !== exceptNodeId && (node.ontology[field] ?? []).includes(entry))
    .map((node) => node.id);
}

/**
 * Why a catalog cannot answer for this entry right now, or null when it can.
 *
 * A failed request and a pending one both leave an EMPTY list, and the detail card
 * is a modal: the error banner behind it (renderBindingCatalogIssues) is not
 * visible, so reporting a failed load as "still loading" leaves the operator
 * watching a dialog that will never fill in.
 */
function catalogUnavailable(props: EnterpriseProps, error: string | null): TemplateResult | null {
  if (error) {
    return html`<div class="callout danger">${error}</div>`;
  }
  return props.catalogPhase === "ready"
    ? null
    : html`<div class="muted">${t("enterprise.bindingDetail.catalogPending")}</div>`;
}

/**
 * What a tool entry IS, read from the catalog this screen already holds.
 *
 * Deliberately NOT "and here is what it grants". An entry's real reach is decided
 * by governance: the root->node policy path, the deny matcher that is not the
 * mirror of the allow one, MCP ownership aliases, the step-advance carve-out that
 * runs before either lane, the explicit-grant floor, and group expansion over
 * CORE_TOOL_GROUPS rather than catalog sections. Restating any of that here means
 * keeping a second copy of governance in the view, and each divergence reads as a
 * confident claim about enforcement that is simply wrong.
 *
 * Same call `nodeBindingAdders` already makes for `denialReachesMcpServer`: the
 * card reports catalog facts and leaves the verdict to the runtime.
 */
function renderToolDetailBody(
  props: EnterpriseProps,
  detail: EnterpriseBindingDetail,
): TemplateResult {
  const exact = props.toolGroups
    .flatMap((group) => group.tools.map((tool) => ({ tool, groupLabel: group.label })))
    .find(({ tool }) => tool.id === detail.entry);
  if (!exact) {
    // A group selector, a glob, or a name this catalog does not carry. Which of
    // the three, and what it reaches, is the runtime's answer to give.
    return (
      catalogUnavailable(props, props.catalogErrors.tools) ??
      html`<div class="callout">${t("enterprise.bindingDetail.toolNotOneTool")}</div>`
    );
  }
  return html`
    ${renderDetailRow(t("enterprise.bindingDetail.toolGroup"), exact.groupLabel)}
    ${renderDetailRow(
      t("enterprise.bindingDetail.toolSource"),
      html`<span class="chip">${exact.tool.source}</span> ${exact.tool.pluginId
          ? html`<code>${exact.tool.pluginId}</code>`
          : nothing}
        ${exact.tool.risk
          ? html`<span class="chip chip-warn"
              >${t("enterprise.bindingDetail.toolRisk", { risk: exact.tool.risk })}</span
            >`
          : nothing}
        ${exact.tool.optional
          ? html`<span class="chip">${t("enterprise.toolsTab.optionalBadge")}</span>`
          : nothing}`,
    )}
    ${exact.tool.description
      ? renderDetailRow(t("enterprise.bindingDetail.description"), exact.tool.description)
      : nothing}
  `;
}

/** What a declared skill resolves to on the agent this catalog describes. */
function renderSkillDetailBody(props: EnterpriseProps, entry: string): TemplateResult {
  const skill = props.skills.find((candidate) => candidate.name === entry);
  if (!skill) {
    // Named per agent, and the page-level scope banner is behind this modal: the
    // skill set is agent-scoped, and a work-map can govern a different agent than
    // the one this catalog answered for, so an unqualified "resolves to nothing"
    // can be false for the agent that actually runs it.
    return (
      catalogUnavailable(props, props.catalogErrors.skills) ??
      html`<div class="callout">
        ${props.catalogAgentId
          ? t("enterprise.bindingDetail.skillMissingForAgent", { agentId: props.catalogAgentId })
          : t("enterprise.bindingDetail.skillMissing")}
      </div>`
    );
  }
  // Three groups, not one list. `bins`/`env`/`config` must ALL be present, while
  // `anyBins` and `os` are satisfied by any one member (resolveMissingAnyBins /
  // resolveMissingOs in src/shared/requirements.ts). Flattening them together
  // would present alternatives as prerequisites.
  const required = [
    ...skill.requirements.bins,
    ...skill.requirements.env,
    ...skill.requirements.config,
  ];
  const anyBins = skill.requirements.anyBins ?? [];
  const anyOs = skill.requirements.os;
  return html`
    ${skill.description
      ? renderDetailRow(t("enterprise.bindingDetail.description"), skill.description)
      : nothing}
    ${renderDetailRow(
      t("enterprise.bindingDetail.skillStatus"),
      renderSkillStatusChips({ skill, showBundledBadge: skill.bundled === true }),
    )}
    ${renderDetailRow(
      t("enterprise.bindingDetail.skillFile"),
      html`<code>${skill.filePath}</code>`,
    )}
    ${required.length > 0
      ? renderDetailRow(t("enterprise.bindingDetail.skillRequires"), renderIdChips(required))
      : nothing}
    ${anyBins.length > 0
      ? renderDetailRow(t("enterprise.bindingDetail.skillRequiresAnyBin"), renderIdChips(anyBins))
      : nothing}
    ${anyOs.length > 0
      ? renderDetailRow(t("enterprise.bindingDetail.skillRequiresAnyOs"), renderIdChips(anyOs))
      : nothing}
  `;
}

/** How an attached MCP server is registered in `mcp.servers`, and whether it runs. */
function renderMcpDetailBody(props: EnterpriseProps, entry: string): TemplateResult {
  const server = props.mcpServers.find((candidate) => candidate.name === entry);
  if (!server) {
    return props.mcpServersKnown
      ? html`<div class="callout">${t("enterprise.bindingDetail.mcpMissing")}</div>`
      : html`<div class="muted">${t("enterprise.bindingDetail.configPending")}</div>`;
  }
  return html`
    ${renderDetailRow(
      t("enterprise.bindingDetail.mcpTransport"),
      // The CONFIGURED value when there is one: the row badge collapses `sse` and
      // `streamable-http` into "http", and a card that claims to explain the
      // server must not hide the setting it is explaining.
      html`<span class="chip">${server.configuredTransport ?? server.transport}</span> ${server.auth
          ? html`<span class="chip">${server.auth}</span>`
          : nothing}
        ${server.tls ? html`<span class="chip chip-warn">${server.tls}</span>` : nothing}`,
    )}
    ${renderDetailRow(t("enterprise.bindingDetail.mcpLaunch"), html`<code>${server.launch}</code>`)}
    ${renderDetailRow(
      t("enterprise.bindingDetail.mcpState"),
      server.enabled
        ? html`<span class="chip chip-ok">${t("common.enabled")}</span>`
        : // A disabled server stays attachable but never answers, so the run gets
          // the grant and none of the tools. Worth saying on the card that claims
          // the step can call it.
          html`<span class="chip chip-warn">${t("enterprise.mcpTab.disabled")}</span>`,
    )}
  `;
}

/** What a knowledge foundation covers, and whether THIS work-map can retrieve it. */
function renderKnowledgeDetailBody(props: EnterpriseProps, entry: string): TemplateResult {
  const foundation = props.foundations.find((candidate) => candidate.id === entry);
  const { ids: retrievableIds, ownershipKnown } = retrievableFoundations(props);
  if (!foundation) {
    return (
      catalogUnavailable(props, props.catalogErrors.foundations) ??
      html`<div class="callout">${t("enterprise.bindingDetail.knowledgeMissing")}</div>`
    );
  }
  const owners = foundation.ownerTreeIds ?? [];
  return html`
    ${renderDetailRow(
      t("enterprise.bindingDetail.knowledgeKind"),
      html`<span class="chip">${foundation.kind}</span> ${foundation.displayName}`,
    )}
    ${foundation.description
      ? renderDetailRow(t("enterprise.bindingDetail.description"), foundation.description)
      : nothing}
    ${foundation.detail
      ? renderDetailRow(
          t("enterprise.bindingDetail.knowledgeLocator"),
          html`<code>${foundation.detail}</code>`,
        )
      : nothing}
    ${renderDetailRow(
      t("enterprise.bindingDetail.knowledgeOwner"),
      // An owner list is the retrieval scope, not a label: a bundle foundation
      // resolves only for its owning work-map, so naming the owners is what tells
      // the operator whether this grant returns anything here.
      ownershipKnown
        ? owners.length === 0
          ? t("enterprise.bindingDetail.knowledgeGlobal")
          : renderIdChips(owners)
        : t("enterprise.bindingDetail.knowledgeOwnerUnknown"),
    )}
    ${ownershipKnown && !retrievableIds.has(entry)
      ? html`<div class="callout">${t("enterprise.bindingDetail.knowledgeUnreachable")}</div>`
      : nothing}
  `;
}

function renderBindingDetailBody(
  props: EnterpriseProps,
  detail: EnterpriseBindingDetail,
): TemplateResult {
  switch (detail.field) {
    case "skills":
      return renderSkillDetailBody(props, detail.entry);
    case "mcpServers":
      return renderMcpDetailBody(props, detail.entry);
    case "knowledgeFoundations":
      return renderKnowledgeDetailBody(props, detail.entry);
    // Allowed and denied read the same catalog, but NOT the same matcher — the
    // tool body branches on the field for that.
    default:
      return renderToolDetailBody(props, detail);
  }
}

/**
 * The read-out behind a binding chip.
 *
 * A step's bindings are bare ids, and every one of them stands for something the
 * operator has to look up somewhere else: a tool's real name and blast radius, a
 * skill that may not be installed, a server that may be disabled, a foundation
 * another work-map owns. The catalogs holding those answers are already loaded
 * for the picker, so this dialog is pure presentation — nothing is fetched, and
 * the only mutation it offers is the Detach the chip itself offers.
 */
function renderBindingDetail(
  props: EnterpriseProps,
  adders: readonly OntologyEntryAdder[],
): TemplateResult | typeof nothing {
  const detail = props.bindingDetail;
  // Same tree guard as the picker: node ids repeat across work-maps, so a card
  // left open across a tree switch would describe a different step's binding.
  if (!detail || detail.treeId !== props.treeDetail?.id) {
    return nothing;
  }
  const adder = adders.find(
    (candidate) => candidate.field === detail.field && candidate.nodeId === detail.nodeId,
  );
  if (!adder) {
    return nothing;
  }
  // A reconnect reloads the same tree while deliberately keeping the node
  // selection, so the card can outlive what it describes. Re-check the entry
  // against the list its ORIGIN claims: an entry that was detached elsewhere, or
  // that moved between local and inherited scope, would otherwise keep its stale
  // read-out and offer a Detach for a binding this step no longer declares.
  const declared = detail.origin === "inherited" ? (adder.inheritedValues ?? []) : adder.values;
  if (!declared.includes(detail.entry)) {
    return nothing;
  }
  const meta = BINDING_FIELD_META[detail.field];
  const kindLabel = t(meta.labelKey);
  const note = adder.valueNote?.(detail.entry) ?? null;
  const alsoOn = stepsAlsoDeclaring(props, detail.field, detail.entry, detail.nodeId);
  // Inherited entries belong to the ancestor that declared them. Offering Detach
  // here would either fail or silently edit a different step.
  const removable = props.canEdit && detail.origin === "step";
  return html`
    <openclaw-modal-dialog
      label=${t("enterprise.bindingDetail.title", { entry: detail.entry })}
      description=${kindLabel}
      @modal-cancel=${props.onCloseBindingDetail}
    >
      <div class="binding-detail">
        <header class="binding-detail__head">
          <div class="binding-detail__kind">${kindLabel}</div>
          <div class="binding-detail__entry"><code>${detail.entry}</code></div>
          ${note ? html`<span class="chip chip-warn">${note}</span>` : nothing}
        </header>
        <div class="binding-detail__rows">
          ${renderDetailRow(
            t("enterprise.bindingDetail.declaredOn"),
            detail.origin === "inherited"
              ? t("enterprise.bindingDetail.declaredInherited")
              : html`<code>${detail.nodeId}</code>`,
          )}
          ${renderDetailRow(
            t("enterprise.bindingDetail.configKey"),
            html`<code>${meta.configKey}</code>`,
          )}
          ${alsoOn.length > 0
            ? renderDetailRow(t("enterprise.bindingDetail.alsoOn"), renderIdChips(alsoOn))
            : nothing}
          ${renderBindingDetailBody(props, detail)}
        </div>
        <div class="binding-detail__actions">
          ${removable
            ? html`<button
                type="button"
                class="btn danger"
                ?disabled=${props.treeSaving}
                @click=${() => props.onRemoveBinding(detail.nodeId, detail.field, detail.entry)}
              >
                ${t("enterprise.bindingDetail.detach")}
              </button>`
            : nothing}
          <button type="button" class="btn" @click=${props.onCloseBindingDetail}>
            ${t("enterprise.bindingDetail.close")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
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
 * MCP servers this step inherits from its ancestors.
 *
 * Governance grants an attachment down the whole branch (pathAttachesMcpServer in
 * src/enterprise/governance.ts), so a leaf with no `mcpServers` of its own is not
 * necessarily server-less — and telling the operator it can call none would
 * contradict what the run actually allows.
 */
/**
 * Foundations the step actually inherits: the INTERSECTION of every ancestor list
 * that declares one, which is what foundationAllowedByPath enforces — each
 * non-empty level is an independent gate, so a root granting A and a parent
 * granting B leaves the child with neither. A union would claim access the
 * runtime refuses.
 */
function inheritedKnowledgeFoundations(props: EnterpriseProps, nodeId: string): string[] {
  const nodes = props.treeDetail?.nodes;
  if (!nodes) {
    return [];
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let inherited: string[] | null = null;
  let current = byId.get(nodeId)?.parentId ?? null;
  while (current) {
    const node = byId.get(current);
    if (!node) {
      break;
    }
    const declared = node.ontology.knowledgeFoundations;
    if (declared?.length) {
      inherited =
        inherited === null ? [...declared] : inherited.filter((id) => declared.includes(id));
    }
    current = node.parentId;
  }
  return inherited ?? [];
}

/**
 * Denials an ancestor step declared, which apply here too.
 *
 * Shown for the same reason as inherited MCP attachments, but it matters more:
 * a denial cannot be taken back further down the path, so a step whose own list
 * is empty can still be unable to call a tool. Without this the operator would
 * see "no denials" on a step that is in fact denied.
 */
function inheritedDeniedTools(props: EnterpriseProps, nodeId: string): string[] {
  const nodes = props.treeDetail?.nodes;
  if (!nodes) {
    return [];
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inherited = new Set<string>();
  let current = byId.get(nodeId)?.parentId ?? null;
  while (current) {
    const node = byId.get(current);
    if (!node) {
      break;
    }
    for (const tool of node.ontology.deniedTools ?? []) {
      inherited.add(tool);
    }
    current = node.parentId;
  }
  return [...inherited].toSorted((a, b) => a.localeCompare(b));
}

function inheritedMcpServers(props: EnterpriseProps, nodeId: string): string[] {
  const nodes = props.treeDetail?.nodes;
  if (!nodes) {
    return [];
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inherited = new Set<string>();
  let current = byId.get(nodeId)?.parentId ?? null;
  while (current) {
    const node = byId.get(current);
    if (!node) {
      break;
    }
    for (const server of node.ontology.mcpServers ?? []) {
      inherited.add(server);
    }
    current = node.parentId;
  }
  return [...inherited].toSorted((a, b) => a.localeCompare(b));
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
 * Which steps attach each MCP server. Exact-name match like skills: an attachment
 * is a config key, never a glob.
 */
function collectMcpUsage(
  nodes: readonly EnterpriseTreeNode[] | undefined,
): Map<string, CatalogUsage[]> {
  const usage = new Map<string, CatalogUsage[]>();
  for (const node of nodes ?? []) {
    for (const name of node.ontology.mcpServers ?? []) {
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
      <div class="muted" style="margin-top: 8px;">
        ${workMapGrantsExplicitly(props)
          ? t("enterprise.toolsTab.attachHintGrantedGated")
          : t("enterprise.toolsTab.attachHint")}
      </div>
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
 * Is the selected work-map's deny-by-default grant actually enforced right now?
 *
 * Declaration plus enforce mode, the same pair workMapGovernsMcp checks: observe
 * records without blocking and off governs nothing, so a catalog that promised
 * "unreachable" there would describe a restriction the runtime is not applying.
 */
function workMapGrantsExplicitly(props: EnterpriseProps): boolean {
  return props.enterpriseMode === "enforce" && props.treeDetail?.capabilityGrants === "explicit";
}

/**
 * Same switch, read for KNOWLEDGE. Observe counts here: unlike the tool, skill,
 * and MCP grants, the knowledge grant applies in observe too (a step's knowledge
 * list has always scoped retrieval in every mode), so an observing screen that
 * claimed "every registered foundation" would say the opposite of what runs.
 * `off` still governs nothing.
 */
function workMapGrantsKnowledgeExplicitly(props: EnterpriseProps): boolean {
  return props.enterpriseMode !== "off" && props.treeDetail?.capabilityGrants === "explicit";
}

/**
 * Does the selected work-map govern MCP by attachment? A tree that never declares
 * one keeps pre-feature behavior (see mcpGoverned in src/enterprise/plan.ts), so
 * calling its servers "unattached and unreachable" would promise a restriction
 * nothing is enforcing.
 */
/**
 * Does the selected work-map DECLARE the field? Presence, matching the runtime's
 * opt-in (treeDeclaresMcpAttachment): an explicit `mcpServers: []` opts in, so a
 * length test would hide exactly the state an operator needs to see. Independent
 * of mode — adding an attachment changes the tree, never the mode.
 */
function workMapDeclaresMcp(props: EnterpriseProps): boolean {
  // Explicit grants imply it, exactly as buildEnterpriseRunPlan does: such a
  // work-map reaches only what it attaches, so its servers are governed even
  // though no step named the field.
  return (
    props.treeDetail?.capabilityGrants === "explicit" ||
    (props.treeDetail?.nodes ?? []).some((node) => node.ontology.mcpServers !== undefined)
  );
}

/**
 * Is attachment actually enforced right now? Declaration plus enforce mode:
 * observe records without blocking and off governs nothing, so "unreachable"
 * would be a claim the runtime is not making.
 */
function workMapGovernsMcp(props: EnterpriseProps): boolean {
  return props.enterpriseMode === "enforce" && workMapDeclaresMcp(props);
}

/**
 * MCP servers registered for this deployment, and which steps may reach them.
 *
 * Registering is the ordinary OpenClaw act — one entry under `mcp.servers` — so
 * this screen writes the same config draft the Settings MCP screen writes. What is
 * enterprise about it is the second column: a registered server is callable only
 * from the steps that attach it, so a server with no attachments is registered and
 * unreachable, which is exactly the state an operator comes here to see.
 */
function renderEnterpriseMcp(props: EnterpriseProps): TemplateResult {
  const treeName = props.treeDetail?.name ?? null;
  const usage = collectMcpUsage(props.treeDetail?.nodes);
  const usageLabel = treeName ? t("enterprise.catalogUsage.attachedTo", { treeName }) : null;
  // Attachments the registry cannot satisfy. Driven by the tree, which is
  // authoritative on its own: without this the screen would show the work-map as
  // covered while the step that names the server can never call it.
  const governed = workMapGovernsMcp(props);
  // Only a KNOWN registry can call an attachment unregistered.
  const attachedOnly = (props.mcpServersKnown ? [...usage.keys()] : [])
    .filter((name) => !props.mcpServers.some((server) => server.name === name))
    .toSorted((a, b) => a.localeCompare(b));
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("enterprise.mcpTab.title")}</div>
          <div class="card-sub">${t("enterprise.mcpTab.subtitle")}</div>
        </div>
        ${props.canEdit && !props.mcpDraft
          ? html`<button
              type="button"
              class="btn"
              ?disabled=${!props.canRegisterMcp}
              title=${props.mcpRegisterBlockedReason ?? ""}
              @click=${props.onBeginMcpDraft}
            >
              ${t("enterprise.mcpTab.add")}
            </button>`
          : nothing}
      </div>
      ${renderCatalogUsageScope(props)}${renderMcpSummary(props, usage, governed)}
      <div class="muted" style="margin-top: 8px;">
        ${governed
          ? t("enterprise.mcpTab.attachHint")
          : t("enterprise.mcpTab.attachHintUngoverned")}
      </div>
      ${governed
        ? html`<div class="muted" style="margin-top: 8px;">
            ${t("enterprise.mcpTab.nativeConfigBoundary")}
          </div>`
        : nothing}
      ${props.canEdit && props.mcpRegisterBlockedReason
        ? html`<div class="callout" style="margin-top: 8px;">
            ${props.mcpRegisterBlockedReason}
          </div>`
        : nothing}
      ${props.canEdit && props.mcpDraft ? renderMcpDraft(props, props.mcpDraft) : nothing}
      ${renderMcpRemoveConfirm(props)} ${props.canEdit ? renderMcpConfigActions(props) : nothing}
      ${props.mcpServers.length === 0 && attachedOnly.length === 0
        ? html`<div class="muted" style="margin-top: 12px;">
            ${props.mcpServersKnown ? t("enterprise.mcpTab.empty") : t("common.loading")}
          </div>`
        : html`<div class="list" style="margin-top: 12px;">
            ${props.mcpServers.map((server) =>
              renderMcpServerRow({ props, server, usage, usageLabel, governed }),
            )}
            ${attachedOnly.map((name) => renderUnregisteredMcpRow(name, usage, usageLabel))}
          </div>`}
    </section>
  `;
}

/**
 * The registry at a glance: how many servers exist, how many are live, and how
 * many a governed work-map can actually reach.
 *
 * Only claimed once config has answered — an empty registry before then is not
 * evidence of zero — and the reach tile only when attachment is enforced, since
 * an ungoverned work-map reaches all of them.
 */
function renderMcpSummary(
  props: EnterpriseProps,
  usage: Map<string, CatalogUsage[]>,
  governed: boolean,
): TemplateResult | typeof nothing {
  if (!props.mcpServersKnown) {
    return nothing;
  }
  const enabled = props.mcpServers.filter((server) => server.enabled).length;
  // `invalid` is a schema-valid entry with no launch, not an HTTP server, so it
  // is not remote — counting it would overstate what this gateway can dial.
  const remote = props.mcpServers.filter((server) => server.transport === "http").length;
  const tiles = [
    { label: t("enterprise.mcpTab.statServers"), value: props.mcpServers.length },
    { label: t("enterprise.mcpTab.statEnabled"), value: enabled },
    { label: t("enterprise.mcpTab.statRemote"), value: remote },
    ...(governed
      ? [
          {
            label: t("enterprise.mcpTab.statAttached"),
            // Attached AND runnable. A disabled or launchless server is dropped
            // before materialization on both the embedded and Codex paths, so
            // counting it as reachable would promise a step something it cannot
            // call.
            value: props.mcpServers.filter(
              (server) =>
                server.enabled &&
                server.transport !== "invalid" &&
                (usage.get(server.name)?.length ?? 0) > 0,
            ).length,
          },
        ]
      : []),
  ];
  return html`<div class="form-grid" style="margin-top: 16px;">
    ${tiles.map(
      (tile) => html`<div class="stat">
        <div class="stat-label">${tile.label}</div>
        <div class="stat-value">${String(tile.value)}</div>
      </div>`,
    )}
  </div>`;
}

/** One registered server: how it launches, which steps may call it, and its controls. */
function renderMcpServerRow(params: {
  props: EnterpriseProps;
  server: McpServerRow;
  usage: Map<string, CatalogUsage[]>;
  usageLabel: string | null;
  governed: boolean;
}): TemplateResult {
  const { props, server, usageLabel, governed } = params;
  const attachments = params.usage.get(server.name);
  const editing = props.mcpDraft?.editing === server.name;
  const blocked = props.mcpRegisterBlockedReason;
  return html`<div class="list-item list-item-stacked ${editing ? "list-item-selected" : ""}">
    <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
      <div class="list-main">
        <div class="list-title">
          <code>${server.name}</code>
          <span class="chip">${server.transport}</span>
          ${server.auth ? html`<span class="chip">${server.auth}</span>` : nothing}
          ${server.enabled
            ? nothing
            : html`<span class="chip chip-warn">${t("enterprise.mcpTab.disabled")}</span>`}
          <!-- Registered and unattached is the default state, not an error, but it
            is the one an operator misreads as "available", so it is labelled — and
            only when the work-map actually governs attachments, or the label would
            claim a restriction that is not being enforced. -->
          ${governed && !attachments?.length
            ? html`<span class="chip">${t("enterprise.mcpTab.unattached")}</span>`
            : nothing}
        </div>
        <div class="list-sub">${server.launch}</div>
        ${renderCatalogUsage(attachments, usageLabel)}
      </div>
      ${props.canEdit
        ? html`<div class="row" style="gap: 8px;">
            <button
              class="btn btn--sm"
              ?disabled=${blocked !== null}
              title=${blocked ?? ""}
              @click=${() => props.onToggleMcpServer(server.name, !server.enabled)}
            >
              ${server.enabled ? t("enterprise.mcpTab.disable") : t("enterprise.mcpTab.enable")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${blocked !== null}
              title=${blocked ?? ""}
              @click=${() => props.onBeginMcpEdit(server.name)}
            >
              ${t("enterprise.mcpTab.edit")}
            </button>
            <button
              class="btn btn--sm danger"
              ?disabled=${blocked !== null}
              title=${blocked ?? ""}
              @click=${() => props.onRequestRemoveMcpServer(server.name)}
            >
              ${t("enterprise.mcpTab.remove")}
            </button>
          </div>`
        : nothing}
    </div>
  </div>`;
}

/** Removing a registered server is destructive and takes its attachments with it. */
function renderMcpRemoveConfirm(props: EnterpriseProps): TemplateResult | typeof nothing {
  const name = props.mcpRemoveConfirm;
  if (!name) {
    return nothing;
  }
  const title = t("enterprise.mcpTab.removeTitle", { name });
  return html`<openclaw-modal-dialog
    label=${title}
    description=${t("enterprise.mcpTab.removeBody")}
    @modal-cancel=${props.onCancelRemoveMcpServer}
  >
    <div class="card">
      <div class="card-title">${title}</div>
      <div class="card-sub">${t("enterprise.mcpTab.removeBody")}</div>
      <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 12px;">
        <button class="btn" @click=${props.onCancelRemoveMcpServer}>${t("common.cancel")}</button>
        <button class="btn danger" @click=${props.onConfirmRemoveMcpServer}>
          ${t("enterprise.mcpTab.remove")}
        </button>
      </div>
    </div>
  </openclaw-modal-dialog>`;
}

/**
 * A server the work-map attaches that config does not register. The attachment is
 * inert — the gate resolves a call by server name, and nothing launches under this
 * one — so it is shown rather than silently dropped.
 */
function renderUnregisteredMcpRow(
  name: string,
  usage: Map<string, CatalogUsage[]>,
  usageLabel: string | null,
): TemplateResult {
  return html`<div class="list-item list-item-stacked">
    <div class="list-main">
      <div class="list-title">
        <code>${name}</code>
        <span class="chip chip-warn">${t("enterprise.bindings.mcpNotRegistered")}</span>
      </div>
      ${renderCatalogUsage(usage.get(name), usageLabel)}
    </div>
  </div>`;
}

/**
 * Save/Publish for the config draft this screen writes into. Shown only while the
 * draft differs: a registration that is still only in the browser is the one thing
 * an operator must not walk away from, and hiding the control when there is
 * nothing to save keeps that signal meaningful.
 */
function renderMcpConfigActions(props: EnterpriseProps): TemplateResult | typeof nothing {
  if (!props.configDirty) {
    return nothing;
  }
  const busy = props.configSaving || props.configApplying || !props.connected;
  return html`<div class="callout" style="margin-top: 12px;">
    <div>${t("enterprise.mcpTab.unsaved")}</div>
    <div class="row" style="gap: 8px; margin-top: 8px;">
      <button type="button" class="btn" ?disabled=${busy} @click=${props.onSaveConfig}>
        ${t("enterprise.mcpTab.save")}
      </button>
      <button type="button" class="btn primary" ?disabled=${busy} @click=${props.onApplyConfig}>
        ${props.configApplying ? t("enterprise.mcpTab.publishing") : t("enterprise.mcpTab.publish")}
      </button>
    </div>
  </div>`;
}

/**
 * Example values for the registration form. Command lines and server names are
 * literals an operator types verbatim, so they live here rather than in the
 * locale bundles — the same reason CUSTOM_PLACEHOLDER above does.
 */
const MCP_DRAFT_PLACEHOLDER = {
  name: "github",
  command: "npx",
  args: "-y @modelcontextprotocol/server-github",
  url: "https://mcp.example.com/sse",
  headerName: "Authorization",
  headerValue: "Bearer …",
  // The envelope vendors publish, so the field the operator pastes into shows
  // the shape it accepts rather than describing it in prose.
  json: `{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"],\n      "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" }\n    }\n  }\n}`,
} as const;

/** i18n message for a rejected MCP registration. */
function mcpDraftErrorMessage(draft: EnterpriseMcpDraft): string {
  const error = draft.error;
  if (error === null) {
    return "";
  }
  // The detail is the only thing that points at a line: a multi-server snippet
  // names which server was refused, and a parse failure carries the parser's
  // own message. Both are values, not translatable text, so they are passed in.
  const detail = draft.errorDetail ?? "";
  const messages: Record<NonNullable<EnterpriseMcpDraft["error"]>, string> = {
    "name-empty": t("enterprise.mcpDraft.nameEmpty"),
    "url-invalid": t("enterprise.mcpDraft.urlInvalid"),
    "name-taken": detail
      ? t("enterprise.mcpDraft.nameTakenNamed", { name: detail })
      : t("enterprise.mcpDraft.nameTaken"),
    "name-unsupported": detail
      ? t("enterprise.mcpDraft.nameUnsupportedNamed", { name: detail })
      : t("enterprise.mcpDraft.nameUnsupported"),
    "launch-missing": t("enterprise.mcpDraft.launchMissing"),
    "header-name-empty": t("enterprise.mcpDraft.headerNameEmpty"),
    "header-name-duplicate": t("enterprise.mcpDraft.headerNameDuplicate"),
    "header-name-invalid": t("enterprise.mcpDraft.headerNameInvalid"),
    "transport-unset": t("enterprise.mcpDraft.transportUnset"),
    "entry-changed": t("enterprise.mcpDraft.entryChanged"),
    "json-name-mismatch": t("enterprise.mcpDraft.jsonNameMismatch", { name: detail }),
    "json-empty": t("enterprise.mcpDraft.jsonEmpty"),
    "json-invalid": t("enterprise.mcpDraft.jsonInvalid", { detail }),
    "json-not-servers": t("enterprise.mcpDraft.jsonNotServers"),
    "json-no-servers": t("enterprise.mcpDraft.jsonNoServers"),
    "json-name-unsupported": t("enterprise.mcpDraft.nameUnsupportedNamed", { name: detail }),
    "json-entry-not-object": t("enterprise.mcpDraft.jsonEntryNotObject", { name: detail }),
    "json-entry-launchless": t("enterprise.mcpDraft.jsonEntryLaunchless", { name: detail }),
    "json-entry-url-invalid": t("enterprise.mcpDraft.jsonEntryUrlInvalid", { name: detail }),
    "json-entry-transport-invalid": t("enterprise.mcpDraft.jsonEntryTransportInvalid", {
      name: detail,
    }),
    "json-entry-transport-conflict": t("enterprise.mcpDraft.jsonEntryTransportConflict", {
      name: detail,
    }),
    "json-entry-name-blank": t("enterprise.mcpDraft.jsonEntryNameBlank"),
    "json-entry-name-duplicate": t("enterprise.mcpDraft.jsonEntryNameDuplicate", { name: detail }),
    "json-entry-alias-unknown": t("enterprise.mcpDraft.jsonEntryAliasUnknown", { name: detail }),
    "json-entry-field-invalid": t("enterprise.mcpDraft.jsonEntryFieldInvalid", { name: detail }),
    "json-entry-header-invalid": t("enterprise.mcpDraft.jsonEntryHeaderInvalid", { name: detail }),
    "json-entry-redacted": t("enterprise.mcpDraft.jsonEntryRedacted", { name: detail }),
  };
  return messages[error];
}

/**
 * What a pasted snippet would register, before it is registered.
 *
 * The paste is the one registration path where the operator cannot see what
 * they are agreeing to — the envelope hides how many servers are in it, and the
 * transport of a URL-only entry is decided by the import rather than read from
 * the text. Both belong on screen before Register, not in the list afterwards.
 */
function renderMcpImportPreview(json: string): TemplateResult | typeof nothing {
  const parsed = parseMcpServerImport(json);
  if (parsed.kind !== "ok") {
    // Errors are the submit path's to report: showing a parse failure under a
    // half-typed paste would flag every keystroke as a mistake.
    return nothing;
  }
  return html`<div class="list" style="margin-top: 8px;">
    ${parsed.entries.map(
      (entry) => html`<div class="list-item">
        <div class="list-main">
          <div class="list-title"><code>${entry.name}</code></div>
          <div class="list-sub">${entry.launch}</div>
          ${entry.assumedTransport
            ? html`<div class="list-sub">
                ${t("enterprise.mcpDraft.jsonAssumedTransport", {
                  transport: entry.assumedTransport,
                })}
              </div>`
            : nothing}
          <!-- Read from the ENTRY, not from the assumed-transport field: a
            snippet that declares sse outright assumes nothing, and would
            otherwise be imported and attached with no warning at all. Same for a
            pasted oauth auth mode, which the typed half explains and this did not. -->
          ${entry.server.transport === "sse"
            ? html`<div class="list-sub">${t("enterprise.mcpDraft.sseCodexWarning")}</div>`
            : nothing}
          ${entry.server.auth === "oauth"
            ? html`<div class="list-sub">${t("enterprise.mcpDraft.oauthHint")}</div>`
            : nothing}
        </div>
      </div>`,
    )}
  </div>`;
}

/**
 * The registration form, in two halves.
 *
 * Typing a name plus one transport covers a server the operator already knows;
 * the fields are deliberately the two shapes `openclaw mcp add` takes and
 * nothing more. Everything richer — env, headers, TLS, OAuth, several servers at
 * once — arrives as the JSON a vendor publishes, so it is pasted rather than
 * retyped into a second, partial config surface.
 */
function renderMcpDraft(props: EnterpriseProps, draft: EnterpriseMcpDraft): TemplateResult {
  return html`
    <section class="card" style="margin-top: 12px;">
      <div class="card-title">
        ${draft.editing
          ? t("enterprise.mcpDraft.editTitle", { name: draft.editing })
          : t("enterprise.mcpDraft.title")}
      </div>
      <div class="muted" style="margin-top: 4px;">${t("enterprise.mcpDraft.subtitle")}</div>
      <!-- The paste half is offered for a NEW registration only. A snippet is
        keyed by server name, so pasting one while editing either repeats the
        entry or quietly registers a second alongside it. -->
      ${draft.editing === null
        ? html`<div class="chip-row" style="margin-top: 12px;">
            ${(["fields", "json"] as const).map(
              (mode) => html`<button
                type="button"
                class="chip ${draft.mode === mode ? "list-item-selected" : ""}"
                @click=${() => props.onEditMcpDraft({ mode })}
              >
                ${mode === "fields"
                  ? t("enterprise.mcpDraft.modeFields")
                  : t("enterprise.mcpDraft.modeJson")}
              </button>`,
            )}
          </div>`
        : nothing}
      ${draft.mode === "json"
        ? renderMcpDraftJson(props, draft)
        : renderMcpDraftFields(props, draft)}
      ${draft.error
        ? html`<div class="callout danger" style="margin-top: 8px;">
            ${mcpDraftErrorMessage(draft)}
          </div>`
        : nothing}
      <div class="row" style="gap: 8px; margin-top: 12px;">
        <!-- Same gate as the Register button: this form survives navigation, so an
          operator can open it, go edit raw config, and come back to a submit that
          would serialize a stale form over their unsaved text. -->
        <button
          type="button"
          class="btn primary"
          ?disabled=${!props.canRegisterMcp}
          title=${props.mcpRegisterBlockedReason ?? ""}
          @click=${props.onSubmitMcpDraft}
        >
          ${draft.editing ? t("enterprise.mcpDraft.saveEntry") : t("enterprise.mcpDraft.submit")}
        </button>
        <button type="button" class="btn" @click=${props.onCancelMcpDraft}>
          ${t("common.cancel")}
        </button>
      </div>
    </section>
  `;
}

/** The paste half: one snippet, and what it would register. */
function renderMcpDraftJson(props: EnterpriseProps, draft: EnterpriseMcpDraft): TemplateResult {
  return html`
    <div class="muted" style="margin-top: 8px;">${t("enterprise.mcpDraft.jsonHint")}</div>
    <label class="field" style="margin-top: 8px;">
      <span>${t("enterprise.mcpDraft.json")}</span>
      <textarea
        rows="10"
        spellcheck="false"
        .value=${draft.json}
        placeholder=${MCP_DRAFT_PLACEHOLDER.json}
        @input=${(event: Event) =>
          props.onEditMcpDraft({ json: (event.target as HTMLTextAreaElement).value })}
      ></textarea>
    </label>
    ${renderMcpImportPreview(draft.json)}
  `;
}

/** The typed half: a name plus one transport. */
function renderMcpDraftFields(props: EnterpriseProps, draft: EnterpriseMcpDraft): TemplateResult {
  const stdio = draft.transport === "stdio";
  return html`
    <label class="field" style="margin-top: 12px;">
      <span>${t("enterprise.mcpDraft.name")}</span>
      <input
        type="text"
        ?readonly=${draft.editing !== null}
        .value=${draft.name}
        placeholder=${MCP_DRAFT_PLACEHOLDER.name}
        @input=${(event: Event) =>
          props.onEditMcpDraft({ name: (event.target as HTMLInputElement).value })}
      />
      ${draft.editing !== null
        ? html`<span class="field-help">${t("enterprise.mcpDraft.nameLocked")}</span>`
        : nothing}
    </label>
    <div class="chip-row" style="margin-top: 8px;">
      ${(["stdio", "streamable-http", "sse"] as const).map(
        (transport) => html`<button
          type="button"
          class="chip ${draft.transport === transport ? "list-item-selected" : ""}"
          @click=${() => props.onEditMcpDraft({ transport })}
        >
          ${transport}
        </button>`,
      )}
    </div>
    <!-- The seeded entry named no transport. Neither value can be assumed on its
      behalf: OpenClaw reads an unset one as SSE and Codex reads a bare URL as
      streamable HTTP, so saving either would repoint the server for one of them.
      The operator resolves it, and the submit refuses until they do. -->
    ${draft.transport === "unset"
      ? html`<div class="callout" style="margin-top: 8px;">
          ${t("enterprise.mcpDraft.transportUnsetHint")}
        </div>`
      : nothing}
    <!-- SSE works on the embedded runtime but not everywhere. The Codex
      projection copies the URL without the transport, and Codex dials every
      URL-only server as streamable HTTP, so an SSE-only endpoint attached to a
      Codex-backed step fails. Warned rather than blocked: SSE is a legitimate
      choice for a deployment that does not route through Codex. -->
    ${draft.transport === "sse"
      ? html`<div class="callout" style="margin-top: 8px;">
          ${t("enterprise.mcpDraft.sseCodexWarning")}
        </div>`
      : nothing}
    ${stdio
      ? html`
          <label class="field" style="margin-top: 8px;">
            <span>${t("enterprise.mcpDraft.command")}</span>
            <input
              type="text"
              .value=${draft.command}
              placeholder=${MCP_DRAFT_PLACEHOLDER.command}
              @input=${(event: Event) =>
                props.onEditMcpDraft({ command: (event.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field" style="margin-top: 8px;">
            <span>${t("enterprise.mcpDraft.args")}</span>
            <input
              type="text"
              .value=${draft.args}
              placeholder=${MCP_DRAFT_PLACEHOLDER.args}
              @input=${(event: Event) =>
                props.onEditMcpDraft({ args: (event.target as HTMLInputElement).value })}
            />
          </label>
        `
      : html`<label class="field" style="margin-top: 8px;">
            <span>${t("enterprise.mcpDraft.url")}</span>
            <input
              type="text"
              .value=${draft.url}
              placeholder=${draft.urlStored
                ? t("enterprise.mcpDraft.headerUnchanged")
                : MCP_DRAFT_PLACEHOLDER.url}
              @input=${(event: Event) =>
                props.onEditMcpDraft({ url: (event.target as HTMLInputElement).value })}
            />
            ${draft.urlStored
              ? html`<span class="field-help">${t("enterprise.mcpDraft.urlStored")}</span>`
              : nothing}
          </label>
          ${renderMcpDraftAuth(props, draft)}`}
  `;
}

/**
 * How a remote server authenticates.
 *
 * Only for the HTTP transports: a stdio server runs here and takes its
 * credentials from `env`, which the paste half carries. A server someone else
 * hosts needs either a header (an API key, a bearer token) or the runtime's
 * OAuth flow, and without one of those the typed half could only ever reach
 * servers that need no auth at all.
 */
function renderMcpDraftAuth(props: EnterpriseProps, draft: EnterpriseMcpDraft): TemplateResult {
  return html`
    <label class="field checkbox" style="margin-top: 10px;">
      <input
        type="checkbox"
        .checked=${draft.oauth}
        @change=${(event: Event) =>
          props.onEditMcpDraft({ oauth: (event.target as HTMLInputElement).checked })}
      />
      <span>${t("enterprise.mcpDraft.oauth")}</span>
    </label>
    <div class="muted" style="margin-top: 4px;">${t("enterprise.mcpDraft.oauthHint")}</div>
    <div class="row" style="justify-content: space-between; margin-top: 12px;">
      <span class="label">${t("enterprise.mcpDraft.headers")}</span>
      <button type="button" class="btn btn--sm" @click=${props.onAddMcpHeader}>
        ${t("enterprise.mcpDraft.headerAdd")}
      </button>
    </div>
    <div class="muted" style="margin-top: 4px;">${t("enterprise.mcpDraft.headersHint")}</div>
    <!-- Name and value carry aria-labels rather than visible ones: repeating
      "Header"/"Value" down every row is noise, and the placeholders already say
      what each column is. -->
    ${draft.headers.map(
      (row, index) => html`<div class="mcp-header-row">
        <!-- A stored header's name is fixed: the gateway restores the redacted
          value by key, so a rename would write a reserved sentinel at a path
          holding nothing and be refused at save. Remove the row to rename it. -->
        <input
          type="text"
          aria-label=${t("enterprise.mcpDraft.headerName")}
          ?readonly=${row.stored}
          title=${row.stored ? t("enterprise.mcpDraft.headerNameLocked") : ""}
          .value=${row.name}
          placeholder=${MCP_DRAFT_PLACEHOLDER.headerName}
          @input=${(event: Event) =>
            props.onEditMcpHeader(index, { name: (event.target as HTMLInputElement).value })}
        />
        <input
          type="password"
          autocomplete="off"
          aria-label=${t("enterprise.mcpDraft.headerValue")}
          .value=${row.value}
          placeholder=${row.stored
            ? t("enterprise.mcpDraft.headerUnchanged")
            : MCP_DRAFT_PLACEHOLDER.headerValue}
          @input=${(event: Event) =>
            props.onEditMcpHeader(index, { value: (event.target as HTMLInputElement).value })}
        />
        <button
          type="button"
          class="btn btn--sm"
          @click=${() => props.onEditMcpHeader(index, null)}
        >
          ${t("enterprise.mcpDraft.headerRemove")}
        </button>
      </div>`,
    )}
  `;
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
      <div class="muted" style="margin-top: 8px;">
        ${workMapGrantsExplicitly(props)
          ? t("enterprise.skillsTab.attachHintGranted")
          : t("enterprise.skillsTab.attachHint")}
      </div>
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
    ${section === "mcp" ? renderEnterpriseMcp(props) : nothing}
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

      ${renderRoute(detail, props.runTree)} ${renderResume(detail, props)}

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
 * Offer to continue a run that stopped partway through its route.
 *
 * Only for a run that ENDED (there is nothing to continue otherwise) and only one
 * that finished a step, which is the same bar the server enforces — a control
 * whose only outcome is a refusal teaches operators to distrust the rest.
 *
 * Read from the trace, which is where the server reads it too, so the two agree
 * on what "finished a step" means.
 */
function renderResume(detail: EnterpriseRunDetail, props: EnterpriseProps) {
  // `resumable` is the server's own answer, so a run whose route is finished (or
  // that never finished a step) offers nothing rather than a button that can only
  // fail. canEdit mirrors the operator.admin scope the method requires: without
  // it, a read-only operator browsing History sees a control they cannot use.
  if (!props.canEdit || !detail.resumable) {
    return nothing;
  }
  if (detail.resumeRequested) {
    return html`<div class="muted" style="margin-top: 12px;">
      ${t("enterprise.resumeRequested")}
    </div>`;
  }
  return html`
    <div style="margin-top: 12px;">
      <button
        class="btn"
        ?disabled=${props.resuming}
        @click=${() => props.onResumeRun(detail.executionId)}
      >
        ${t("enterprise.resume")}
      </button>
      <div class="muted" style="margin-top: 6px;">${t("enterprise.resumeHint")}</div>
    </div>
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
          ${ontology.mcpServers?.length
            ? html`<span class="chip"
                >${t("enterprise.mcpServers", { ids: ontology.mcpServers.join(", ") })}</span
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
    ${renderCapabilityGrants(tree, props)}

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
 * How this work-map hands capabilities to its steps, and the switch between the
 * two modes.
 *
 * Shown on the work-map itself rather than per step because it changes what every
 * step's bindings MEAN: under explicit grants a step with no tools listed reaches
 * none, while the inherited default leaves it unrestricted. An operator reading
 * per-step lists without knowing which mode is on would read them backwards.
 */
function renderCapabilityGrants(
  tree: EnterpriseTreeDetail,
  props: EnterpriseProps,
): TemplateResult {
  // Two different questions, and conflating them inverts the toggle. What the
  // work-map is CONFIGURED as drives the chip and the button: fold the mode in
  // here and an explicit map viewed in observe reads "Inherited scopes" with a
  // "Grant explicitly" button that removes the grant an operator was trying to
  // add. What the run currently ENFORCES drives only the hint, because the
  // approval wording is an enforce-mode claim — observe records without gating
  // and `off` governs nothing.
  const configuredExplicit = tree.capabilityGrants === "explicit";
  const enforcingExplicit = configuredExplicit && props.enterpriseMode === "enforce";
  return html`
    <div class="row" style="justify-content: space-between; gap: 8px; margin-top: 8px;">
      <div class="muted">
        <span class="chip ${configuredExplicit ? "chip-ok" : ""}">
          ${configuredExplicit
            ? t("enterprise.capabilityGrants.explicit")
            : t("enterprise.capabilityGrants.inherited")}
        </span>
        ${enforcingExplicit
          ? t("enterprise.capabilityGrants.explicitHintGated")
          : configuredExplicit
            ? // `off` bypasses mediation entirely, so neither "recorded" nor
              // "knowledge still scopes retrieval" is true there — observe is the
              // only non-enforcing mode where those hold.
              props.enterpriseMode === "off"
              ? t("enterprise.capabilityGrants.explicitHintOff")
              : t("enterprise.capabilityGrants.explicitHintNotEnforcing")
            : t("enterprise.capabilityGrants.inheritedHint")}
      </div>
      ${props.canEdit
        ? html`<button
            type="button"
            class="btn"
            ?disabled=${props.treeSaving}
            @click=${props.onToggleCapabilityGrants}
          >
            ${configuredExplicit
              ? t("enterprise.capabilityGrants.turnOff")
              : t("enterprise.capabilityGrants.turnOn")}
          </button>`
        : nothing}
    </div>
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
  const guidance = renderNodeGuidance(node, props);
  return html`
    <section class="card-nested node-inspector" style="margin-top: 12px;">
      <header class="node-inspector__head">
        <div class="node-inspector__ident">
          <div class="card-sub">${node.title}</div>
          <code class="node-inspector__id">${node.id}</code>
        </div>
      </header>
      ${node.description
        ? html`<div class="muted node-inspector__desc">${node.description}</div>`
        : nothing}
      <!-- Role prompt and sub-steps come FIRST: they are what the step is and
        what sits under it, which an operator settles before deciding what it may
        call. The capability and ontology blocks below are longer, so leaving these
        at the bottom put the two shortest decisions behind the most scrolling. -->
      ${guidance === nothing
        ? nothing
        : renderNodeSection({
            kind: "prompt",
            title: t("enterprise.guidanceEditor.title"),
            hint: t("enterprise.guidanceEditor.guidanceNote"),
            body: guidance,
          })}
      <!-- Adding a CHILD STEP is structural: it changes the workflow shape, not
        what this step may call, so it keeps its own block rather than reading as
        a fifth kind of capability. -->
      ${props.canEdit
        ? renderNodeSection({
            kind: "structure",
            title: t("enterprise.addNodeSectionTitle"),
            hint: t("enterprise.addNodeSectionSubtitle"),
            body: renderAddNode(tree.id, nodeId, props),
          })
        : nothing}
      ${renderNodeCapabilities(adders, props)}
      ${renderNodeSection({
        kind: "ontology",
        title: t("enterprise.nodeInspectorTitle"),
        hint: t("enterprise.ontologyEditor.scopeNote"),
        body: html`
          ${entities.length === 0
            ? html`<div class="muted">${t("enterprise.nodeNoOntology")}</div>`
            : html`
                <openclaw-ontology-graph
                  .entities=${entities}
                  .relationships=${relationships}
                ></openclaw-ontology-graph>
                ${renderNodeObjects(objectEntities, props)}
              `}
          ${renderNodeOntologyEditor(node, props)}
        `,
      })}
    </section>
    ${renderBindingPicker(props, adders)} ${renderBindingDetail(props, adders)}
  `;
}

/**
 * One labelled block of the step inspector.
 *
 * Every per-step setting lives in exactly one of these, and `kind` gives each its
 * own accent and heading. Without that the ontology, the four capability kinds
 * and the structural edit all rendered as the same run of cards, and telling
 * "what MCP servers does this step get" from "what tools" meant reading the body
 * of each one.
 */
function renderNodeSection(params: {
  kind: string;
  title: string;
  hint?: string | null;
  body: unknown;
}): TemplateResult {
  return html`
    <section class="node-section" data-kind=${params.kind}>
      <header class="node-section__head">
        <span class="node-section__title">${params.title}</span>
      </header>
      ${params.hint ? html`<div class="node-section__hint">${params.hint}</div>` : nothing}
      <div class="node-section__body">${params.body}</div>
    </section>
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
  // Config is loaded with the screen rather than fetched per catalog, so an
  // attachment naming a server that is not in `mcp.servers` is known-missing
  // straight away — no phase gate like the two above need.
  const registeredServers = new Set(props.mcpServers.map((server) => server.name));
  const inheritedMcp = inheritedMcpServers(props, node.id);
  const mcpGoverned = workMapGovernsMcp(props);
  const mcpDeclared = workMapDeclaresMcp(props);
  return [
    {
      nodeId: node.id,
      field: "allowedTools",
      values: allowedTools,
      title: t("enterprise.bindings.allowedLabel"),
      options: toolBindingOptions(props),
      // What an empty list MEANS flips with the work-map's grant mode: inherited
      // scopes leave the step wide open (the first entry narrows it), while
      // explicit grants leave it with nothing until some step on the path names a
      // tool. Showing the narrowing warning there would state the opposite and
      // discourage the very first grant the step needs.
      scopeWarning:
        allowedTools.length === 0
          ? workMapGrantsExplicitly(props)
            ? t("enterprise.entryDraft.scopeUngrantedGated")
            : t("enterprise.entryDraft.scopeNarrowingApproval")
          : null,
      constrainingAncestors: constrainingAncestorIds(props, node.id, "allowedTools"),
    },
    {
      nodeId: node.id,
      field: "deniedTools",
      values: ontology.deniedTools ?? [],
      title: t("enterprise.bindings.deniedLabel"),
      // Same catalog as the allow-list: a denial names a tool, and an operator
      // reaching for one is picking from what exists, not inventing a name.
      options: toolBindingOptions(props),
      // Inverted from every other row here: an empty denial list is the normal,
      // permissive state, so this never warns about the list being empty. It
      // explains what an ENTRY does instead, and says so before the first one is
      // added — a denial reaches every step below and no later grant takes it
      // back, which is exactly what an operator wants to know at the picker.
      //
      // Mode-qualified, like the capability-grant chip: outside enforce a denial
      // is recorded, not applied, and claiming a live boundary would be worse
      // than saying nothing.
      scopeWarning:
        props.enterpriseMode === "enforce"
          ? t("enterprise.bindings.deniedToolsWins")
          : props.enterpriseMode === "observe"
            ? t("enterprise.bindings.deniedToolsObserving")
            : // `off` is not "recorded but not applied": mediation is bypassed
              // entirely, so there is no decision and no audit trail to point at.
              t("enterprise.bindings.deniedToolsOff"),
      inheritedValues: inheritedDeniedTools(props, node.id),
      // Deliberately ancestor-only. Denials ARE collected definition-wide for the
      // launch-time MCP ceiling (src/enterprise/plan.ts), but whether a given
      // entry reaches a given server is decided by `denialReachesMcpServer`
      // (src/enterprise/active-runs.ts) — namespaces, `mcp__` spellings,
      // collision aliases, glob policy. Reproducing that here would duplicate
      // governance policy in the UI and drift from it; listing every off-path
      // denial without it would claim restrictions that do not exist.
    },
    {
      nodeId: node.id,
      field: "skills",
      values: ontology.skills ?? [],
      title: t("enterprise.bindings.declaredLabel"),
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
      title: t("enterprise.bindings.allowedLabel"),
      options: [...retrievableIds].toSorted().map((value) => ({ value })),
      // Same path-gate shape as tools: an omitted list lets the step query every
      // registered foundation, so the first entry restricts it.
      // Same inversion as the tool list above: under explicit grants an empty
      // list means the step queries NO foundation, not every one — unless an
      // ancestor already granted one, which the step inherits down the path.
      // Saying "no access" there would prompt a duplicate entry.
      scopeWarning:
        foundations.length === 0
          ? workMapGrantsKnowledgeExplicitly(props)
            ? inheritedKnowledgeFoundations(props, node.id).length > 0
              ? null
              : t("enterprise.entryDraft.knowledgeUngranted")
            : t("enterprise.entryDraft.knowledgeNarrowing")
          : null,
      constrainingAncestors: constrainingAncestorIds(props, node.id, "knowledgeFoundations"),
      valueNote: (value) =>
        foundationsKnown && !retrievableIds.has(value)
          ? t("enterprise.bindings.foundationNotRegistered")
          : null,
    },
    {
      nodeId: node.id,
      field: "mcpServers",
      values: ontology.mcpServers ?? [],
      title: t("enterprise.bindings.attachedLabel"),
      options: props.mcpServers.map((server) => ({
        value: server.name,
        description: server.launch,
      })),
      // The opposite warning to the lists above: those START permissive and the
      // first entry narrows, while no attachment anywhere on the path reaches
      // nothing. Two conditions, though: an ancestor's attachment counts (the run
      // grants it here too), and the rule is only ON for a work-map that uses the
      // field — saying "can call none" about an ungoverned tree would promise a
      // restriction that is not being enforced.
      scopeWarning: mcpDeclared
        ? mcpGoverned && (ontology.mcpServers ?? []).length === 0 && inheritedMcp.length === 0
          ? t("enterprise.entryDraft.mcpNoneAttached")
          : null
        : // Nothing declared yet: the FIRST attachment opts the whole work-map into
          // deny-by-default, so every other step loses its registered servers once
          // the deployment enforces. Worth reading before saving.
          t("enterprise.entryDraft.mcpFirstAttachment"),
      inheritedValues: inheritedMcp,
      valueNote: (value) =>
        props.mcpServersKnown && !registeredServers.has(value)
          ? t("enterprise.bindings.mcpNotRegistered")
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
/**
 * How this step should behave, in the operator's words.
 *
 * Rendered into the step digest as advisory instruction — tool scope and
 * governance still enforce, and if they conflict, enforcement wins. That is why
 * it gets its own block above the bindings rather than sitting among them:
 * everything below GRANTS something, this only tells the model what the step is
 * for.
 *
 * Draft-then-save, not per-keystroke: every write is a whole-tree import and a
 * new revision, so saving on each character would bury the version history and
 * race itself.
 */
function renderNodeGuidance(
  node: EnterpriseTreeNode,
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  const saved = node.ontology.guidance ?? "";
  // Both ids: node ids repeat across trees (roots especially), so a draft from
  // another work-map would otherwise appear under this step.
  const draft =
    props.guidanceDraft?.nodeId === node.id && props.guidanceDraft.treeId === props.treeDetail?.id
      ? props.guidanceDraft
      : null;
  if (!props.canEdit) {
    // A read-only operator still needs to see what the step was told to do.
    return saved ? html`<div class="muted" style="white-space: pre-wrap;">${saved}</div>` : nothing;
  }
  const value = draft ? draft.text : saved;
  const dirty = value !== saved;
  return html`
    <textarea
      class="input"
      style="min-height: 96px; width: 100%;"
      rows="4"
      .value=${value}
      aria-label=${t("enterprise.guidanceEditor.fieldLabel", { nodeId: node.id })}
      placeholder=${t("enterprise.guidanceEditor.placeholder")}
      ?disabled=${props.treeSaving}
      @input=${(event: Event) =>
        props.onGuidanceDraft(node.id, (event.target as HTMLTextAreaElement).value)}
    ></textarea>
    <div class="row" style="margin-top: 6px; gap: 8px;">
      <button
        type="button"
        class="btn"
        ?disabled=${!dirty || props.treeSaving}
        @click=${() => props.onSaveGuidance(node.id)}
      >
        ${t("enterprise.guidanceEditor.save")}
      </button>
      <button
        type="button"
        class="btn"
        ?disabled=${!dirty || props.treeSaving}
        @click=${() => props.onCancelGuidance()}
      >
        ${t("enterprise.guidanceEditor.revert")}
      </button>
    </div>
  `;
}

/**
 * Whether the merged shape of `entityId` already declares an identity field.
 *
 * The schema merges an entity across every declaration, so a child extending an
 * ancestor's type can have an empty local `properties` array while the type is
 * already keyed. Defaulting the checkbox from the local array would open it
 * checked and make the first Save fail.
 */
function mergedEntityHasIdentity(props: EnterpriseProps, entityId: string): boolean {
  // TREE-wide, matching what the edit helper validates. The path view would miss
  // a key declared on a sibling branch and open the box checked, so the first
  // save would always be refused.
  return (props.treeDetail?.nodes ?? []).some((node) =>
    (node.ontology.entities ?? []).some(
      (entity) =>
        entity.id === entityId && (entity.properties ?? []).some((property) => property.primaryKey),
    ),
  );
}

/** One "id — remove" chip, the shape every ontology list row uses. */
function renderOntologyChip(
  label: string,
  removeTitle: string,
  props: EnterpriseProps,
  onRemove: () => void,
): TemplateResult {
  return html`<span class="chip"
    ><code>${label}</code>${props.canEdit
      ? html`<button
          type="button"
          class="chip-remove"
          title=${removeTitle}
          aria-label=${removeTitle}
          ?disabled=${props.treeSaving}
          @click=${onRemove}
        >
          ×
        </button>`
      : nothing}</span
  >`;
}

/**
 * Declare this step's object types, their properties, and the links between them.
 *
 * Editable in place rather than through the raw definition, because an ontology
 * is the part an operator reasons about in domain terms — the whole point of
 * having one. Only ONE form is open at a time (see EnterpriseOntologyDraft): the
 * inspector is narrow, and a form per row would leave half-typed state behind
 * whenever the operator moved on.
 *
 * Actions and derived values are edited here too, and they carry checks the
 * importer does not: both resolve against the RUNNING node's path, so a form
 * that only satisfied the tree-wide schema would save a definition that fails
 * mid-run (see addNodeOntologyActionEffect / addNodeOntologyFunction).
 */
function renderNodeOntologyEditor(
  node: EnterpriseTreeNode,
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  const entities = node.ontology.entities ?? [];
  const relationships = node.ontology.relationships ?? [];
  const actions = node.ontology.actions ?? [];
  const functions = node.ontology.functions ?? [];
  // A node may declare only LINKS, or only an action over types an ancestor gave
  // it — valid and common, so an empty local entity list is not an empty section.
  if (
    !props.canEdit &&
    entities.length === 0 &&
    relationships.length === 0 &&
    actions.length === 0 &&
    functions.length === 0
  ) {
    return nothing;
  }
  // Edit access can be lost while a form is open (a reconnect with only
  // operator.read), and the draft outlives that. Rendering it anyway would offer
  // inputs and a Save the server can only refuse.
  const draft =
    props.canEdit && props.ontologyDraft?.nodeId === node.id ? props.ontologyDraft : null;
  // Link endpoints come from the node's SCOPE, not its own declarations: object
  // types are inherited down the path, so a child that declares none may still
  // link the ones an ancestor gave it — which is what the import accepts.
  // DECLARED ones only: the graph synthesizes endpoints for legacy links that
  // name an undeclared type, and offering one here would produce a save the
  // splicer refuses as out of scope.
  const scopeEntityIds = props.treeDetail
    ? declaredNodePathEntityIds(props.treeDetail, node.id)
    : entities.map((entity) => entity.id);
  // The AIP verbs reach further than a link does: they execute at whatever node
  // is active below here, so a type a DESCENDANT declares is addressable and the
  // splicers accept it. Offering only the path would hide exactly those.
  const verbEntityIds = props.treeDetail
    ? declaredExecutableEntityIds(props.treeDetail, node.id)
    : scopeEntityIds;
  return html`
    <!-- No scope note here: the enclosing ontology section already carries it,
      and repeating it put the same paragraph twice on one screen. -->
    <div class="card-title" style="margin-top: 16px;">${t("enterprise.ontologyEditor.title")}</div>
    ${entities.map((entity) => {
      const properties = entity.properties ?? [];
      const propertyDraft =
        draft?.kind === "property" && draft.entityId === entity.id ? draft : null;
      return html`
        <section class="ontology-group" style="margin-top: 8px;">
          <header class="ontology-group__head">
            <span class="ontology-group__title"
              >${entity.title ? `${entity.title} — ${entity.id}` : entity.id}</span
            >
            ${props.canEdit
              ? html`<button
                    type="button"
                    class="btn"
                    ?disabled=${props.treeSaving}
                    @click=${() =>
                      props.onOntologyDraft({
                        kind: "property",
                        nodeId: node.id,
                        entityId: entity.id,
                        id: "",
                        type: "string",
                        // From the MERGED shape, not this node's array: an
                        // ancestor may already carry the identity field, and
                        // opening the box checked would guarantee a refusal.
                        primaryKey: !mergedEntityHasIdentity(props, entity.id),
                      })}
                  >
                    ${t("enterprise.ontologyEditor.addProperty")}
                  </button>
                  ${renderOntologyChip(
                    t("enterprise.ontologyEditor.removeEntity"),
                    t("enterprise.ontologyEditor.removeEntityTitle", { entity: entity.id }),
                    props,
                    () => props.onRemoveOntologyEntity(node.id, entity.id),
                  )}`
              : nothing}
          </header>
          <div class="ontology-group__body">
            ${properties.length === 0
              ? html`<div class="muted">${t("enterprise.ontologyEditor.noProperties")}</div>`
              : html`<div class="chip-row">
                  ${properties.map((property) =>
                    renderOntologyChip(
                      `${property.id}: ${property.type}${
                        property.primaryKey
                          ? ` ${t("enterprise.ontologyEditor.primaryKeyMark")}`
                          : ""
                      }`,
                      t("enterprise.ontologyEditor.removePropertyTitle", { property: property.id }),
                      props,
                      () => props.onRemoveOntologyProperty(node.id, entity.id, property.id),
                    ),
                  )}
                </div>`}
            ${propertyDraft
              ? renderOntologyDraftForm(propertyDraft, scopeEntityIds, props)
              : nothing}
          </div>
        </section>
      `;
    })}
    <section class="ontology-group" style="margin-top: 8px;">
      <header class="ontology-group__head">
        <span class="ontology-group__title">${t("enterprise.ontologyEditor.links")}</span>
        ${props.canEdit && scopeEntityIds.length >= 1
          ? html`<button
              type="button"
              class="btn"
              ?disabled=${props.treeSaving}
              @click=${() =>
                props.onOntologyDraft({
                  kind: "relationship",
                  nodeId: node.id,
                  id: "",
                  from: scopeEntityIds[0] ?? "",
                  to: scopeEntityIds[Math.min(1, scopeEntityIds.length - 1)] ?? "",
                  cardinality: "many-to-many",
                })}
            >
              ${t("enterprise.entryDraft.add")}
            </button>`
          : nothing}
      </header>
      <div class="ontology-group__body">
        ${relationships.length === 0
          ? html`<div class="muted">${t("enterprise.ontologyEditor.noLinks")}</div>`
          : html`<div class="chip-row">
              ${relationships.map((relationship) =>
                renderOntologyChip(
                  `${relationship.from} → ${relationship.to} (${relationship.id})`,
                  t("enterprise.ontologyEditor.removeLinkTitle", { link: relationship.id }),
                  props,
                  () =>
                    props.onRemoveOntologyRelationship(node.id, {
                      id: relationship.id,
                      from: relationship.from,
                      to: relationship.to,
                    }),
                ),
              )}
            </div>`}
        ${draft?.kind === "relationship"
          ? renderOntologyDraftForm(draft, scopeEntityIds, props)
          : nothing}
      </div>
    </section>
    ${renderNodeOntologyActions(node, actions, verbEntityIds, draft, props)}
    ${renderNodeOntologyFunctions(node, functions, verbEntityIds, draft, props)}
    ${props.canEdit
      ? html`<div class="row" style="margin-top: 8px;">
          <button
            type="button"
            class="btn"
            ?disabled=${props.treeSaving}
            @click=${() =>
              props.onOntologyDraft({ kind: "entity", nodeId: node.id, id: "", title: "" })}
          >
            ${t("enterprise.ontologyEditor.addEntity")}
          </button>
        </div>`
      : nothing}
    ${draft?.kind === "entity" ? renderOntologyDraftForm(draft, scopeEntityIds, props) : nothing}
  `;
}

/**
 * The step's ACTIONS: what `invoke_action` may run here.
 *
 * One group per action, mirroring an object type and its fields, because an
 * action is built the same way — declared, then given the effects that authorize
 * it and the parameters it accepts. An action with no write effect is called out
 * rather than left looking complete: the write path refuses it
 * (src/enterprise/ontology-actions.ts), so it is a half-finished declaration, not
 * a read-only one an operator chose.
 */
function renderNodeOntologyActions(
  node: EnterpriseTreeNode,
  actions: NonNullable<EnterpriseTreeNode["ontology"]["actions"]>,
  scopeEntityIds: readonly string[],
  draft: EnterpriseOntologyDraft | null,
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  if (!props.canEdit && actions.length === 0) {
    return nothing;
  }
  // Identity field per object type this step's actions can REACH: its own path,
  // plus every descendant, since an action is in scope at each of them and
  // resolves at whichever node is active. A type declared only on a sibling
  // branch is absent here on purpose — no scope under this step ever contains
  // it, so an effect naming one can never execute. Built once per node.
  const entityKeys = executableEntityKeys(props.treeDetail, node.id);
  return html`
    <div class="card-title" style="margin-top: 16px;">
      ${t("enterprise.ontologyEditor.actions")}
    </div>
    <div class="muted" style="margin-top: 4px;">${t("enterprise.ontologyEditor.actionsNote")}</div>
    ${actions.map((action) => {
      const effects = action.effects ?? [];
      const parameters = action.parameters ?? [];
      const callable = actionIsCallable(effects, parameters, entityKeys);
      const actionDraft =
        (draft?.kind === "action-effect" || draft?.kind === "action-parameter") &&
        draft.actionId === action.id
          ? draft
          : null;
      return html`
        <section class="ontology-group" style="margin-top: 8px;">
          <header class="ontology-group__head">
            <span class="ontology-group__title"
              >${action.title ? `${action.title} — ${action.id}` : action.id}</span
            >
            ${props.canEdit
              ? html`${scopeEntityIds.length >= 1
                    ? html`<button
                        type="button"
                        class="btn"
                        ?disabled=${props.treeSaving}
                        @click=${() =>
                          props.onOntologyDraft({
                            kind: "action-effect",
                            nodeId: node.id,
                            actionId: action.id,
                            entity: scopeEntityIds[0] ?? "",
                            effectKind: "update",
                          })}
                      >
                        ${t("enterprise.ontologyEditor.addEffect")}
                      </button>`
                    : // With no object type in scope the form could only collect an
                      // empty select and save `endpoint-missing`, whose message is
                      // about links. The function editor already guards this way.
                      nothing}
                  <button
                    type="button"
                    class="btn"
                    ?disabled=${props.treeSaving}
                    @click=${() =>
                      props.onOntologyDraft({
                        kind: "action-parameter",
                        nodeId: node.id,
                        actionId: action.id,
                        id: "",
                        type: "string",
                        required: false,
                      })}
                  >
                    ${t("enterprise.ontologyEditor.addParameter")}
                  </button>
                  ${renderOntologyChip(
                    t("enterprise.ontologyEditor.removeEntity"),
                    t("enterprise.ontologyEditor.removeActionTitle", { action: action.id }),
                    props,
                    () => props.onRemoveOntologyAction(node.id, action.id),
                  )}`
              : nothing}
          </header>
          <div class="ontology-group__body">
            ${effects.length === 0
              ? html`<div class="muted">${t("enterprise.ontologyEditor.noEffects")}</div>`
              : html`<div class="chip-row">
                  ${effects.map((effect) =>
                    renderOntologyChip(
                      `${effect.kind} ${effect.entity}`,
                      t("enterprise.ontologyEditor.removeEffectTitle", {
                        kind: effect.kind,
                        entity: effect.entity,
                      }),
                      props,
                      () =>
                        props.onRemoveOntologyActionEffect(node.id, {
                          actionId: action.id,
                          entity: effect.entity,
                          kind: effect.kind,
                        }),
                    ),
                  )}
                </div>`}
            ${callable
              ? nothing
              : html`<div class="callout">
                  ${t("enterprise.ontologyEditor.incompleteActionDetail")}
                </div>`}
            ${parameters.length === 0
              ? html`<div class="muted">${t("enterprise.ontologyEditor.noParameters")}</div>`
              : html`<div class="chip-row">
                  ${parameters.map((parameter) =>
                    renderOntologyChip(
                      `${parameter.id}: ${parameter.type}${
                        parameter.required ? ` ${t("enterprise.ontologyEditor.requiredMark")}` : ""
                      }`,
                      t("enterprise.ontologyEditor.removeParameterTitle", {
                        parameter: parameter.id,
                      }),
                      props,
                      () =>
                        props.onRemoveOntologyActionParameter(node.id, {
                          actionId: action.id,
                          parameterId: parameter.id,
                        }),
                    ),
                  )}
                </div>`}
            ${actionDraft ? renderOntologyDraftForm(actionDraft, scopeEntityIds, props) : nothing}
          </div>
        </section>
      `;
    })}
    ${props.canEdit
      ? html`<div class="row" style="margin-top: 8px;">
          <button
            type="button"
            class="btn"
            ?disabled=${props.treeSaving}
            @click=${() =>
              props.onOntologyDraft({ kind: "action", nodeId: node.id, id: "", title: "" })}
          >
            ${t("enterprise.ontologyEditor.addAction")}
          </button>
        </div>`
      : nothing}
    ${draft?.kind === "action" ? renderOntologyDraftForm(draft, scopeEntityIds, props) : nothing}
  `;
}

/**
 * Identity field per object type an action declared at `nodeId` can reach.
 *
 * The union over this node's own scope and every descendant's, because the
 * runtime resolves at whichever node is active — so a type a descendant declares
 * is reachable, while a sibling branch's is not, however tree-wide the import
 * validated it. `undefined` marks a reachable type that declares no primaryKey,
 * which is a different failure from being unreachable.
 */
function executableEntityKeys(
  tree: EnterpriseTreeDetail | null,
  nodeId: string,
): Map<string, { primaryKey?: string; required: string[] }> {
  const keys = new Map<string, { primaryKey?: string; required: string[] }>();
  if (!tree) {
    return keys;
  }
  const subtree = new Set([nodeId]);
  // Parents precede children in the flat node list, so one forward pass closes
  // the descendant set without walking the tree per node.
  for (const candidate of tree.nodes) {
    if (candidate.parentId && subtree.has(candidate.parentId)) {
      subtree.add(candidate.id);
    }
  }
  const parents = new Set(tree.nodes.map((candidate) => candidate.parentId));
  const leaves = [...subtree].filter((id) => !parents.has(id));
  // Required properties are TREE-wide, matching `collectTreeRequiredProperties`
  // (src/enterprise/ontology-runtime.ts): the runtime unions them across the
  // whole definition, so a property optional on this branch and required on a
  // sibling still has to be supplied by a create here.
  const treeRequired = new Map<string, Set<string>>();
  for (const candidate of tree.nodes) {
    for (const entity of candidate.ontology.entities ?? []) {
      const required = treeRequired.get(entity.id) ?? new Set<string>();
      for (const property of entity.properties ?? []) {
        if (property.required) {
          required.add(property.id);
        }
      }
      treeRequired.set(entity.id, required);
    }
  }
  const perLeaf = (leaves.length > 0 ? leaves : [nodeId]).map((id) => {
    const shapes = new Map<string, { primaryKey?: string; required: string[] }>();
    for (const entity of collectNodeOntologyGraph(tree, id).entities) {
      shapes.set(entity.id, {
        primaryKey: entity.properties?.find((property) => property.primaryKey)?.id,
        // `planEffect` refuses a create that leaves any required property unset,
        // and only a parameter can supply one — so an action missing that
        // parameter fails every call exactly as a missing key does.
        required: [...(treeRequired.get(entity.id) ?? [])],
      });
    }
    return shapes;
  });
  const [first, ...rest] = perLeaf;
  if (!first) {
    return keys;
  }
  // INTERSECTED, not unioned: the action is inherited into every leaf and
  // planEffect refuses it at whichever one cannot address the type, so a shape
  // only one branch declares must not clear the warning. `required` is unioned
  // within the kept types — a property required on any leaf still has to be
  // supplied there.
  for (const [entityId, shape] of first) {
    if (!rest.every((scope) => scope.has(entityId))) {
      continue;
    }
    const others = rest.map((scope) => scope.get(entityId));
    keys.set(entityId, {
      // Every leaf must be able to address it; one without a key breaks there.
      primaryKey:
        shape.primaryKey && others.every((other) => other?.primaryKey === shape.primaryKey)
          ? shape.primaryKey
          : undefined,
      required: [
        ...new Set([...shape.required, ...others.flatMap((other) => other?.required ?? [])]),
      ],
    });
  }
  return keys;
}

/**
 * Can `invoke_action` actually run this action?
 *
 * The same three conditions `collectWorkflowTreeWarnings` reports
 * (src/enterprise/tree-warnings.ts): it needs a write effect, every written type
 * needs an identity field, and the action needs a parameter naming that field —
 * `validateParameters` refuses an undeclared key while `planEffect` requires it,
 * so an action missing any of them saves and then fails on every call. Flagging
 * only the missing write effect would clear the warning halfway through building
 * one, which is exactly when it is still uncallable.
 */
function actionIsCallable(
  effects: readonly { entity: string; kind: string }[],
  parameters: readonly { id: string }[],
  entityKeys: ReadonlyMap<string, { primaryKey?: string; required: string[] }>,
): boolean {
  const writes = effects.filter((effect) => effect.kind !== "read");
  if (writes.length === 0) {
    return false;
  }
  const declared = new Set(parameters.map((parameter) => parameter.id));
  return writes.every((effect) => {
    // Absent means UNREACHABLE — declared only on a sibling branch — so no scope
    // this action executes in can address it and planEffect refuses every call.
    // That is a broken action, not one to excuse.
    const shape = entityKeys.get(effect.entity);
    if (!shape?.primaryKey || !declared.has(shape.primaryKey)) {
      return false;
    }
    // Only a CREATE has to supply the rest: an update writes the properties it
    // names onto an object that already satisfies its own type.
    return effect.kind !== "create" || shape.required.every((id) => declared.has(id));
  });
}

/**
 * The step's derived values: what `compute_function` may evaluate here.
 *
 * One row each rather than a group per function — a function has no sub-parts to
 * add — with the expression on its own line, because expressions are long and a
 * chip that carried one would push the inspector sideways.
 *
 * The Add button needs an object type in scope: every function is an expression
 * OVER one, so offering the form with an empty select would only ever collect a
 * definition the splicer refuses.
 */
function renderNodeOntologyFunctions(
  node: EnterpriseTreeNode,
  functions: NonNullable<EnterpriseTreeNode["ontology"]["functions"]>,
  scopeEntityIds: readonly string[],
  draft: EnterpriseOntologyDraft | null,
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  if (!props.canEdit && functions.length === 0) {
    return nothing;
  }
  return html`
    <section class="ontology-group" style="margin-top: 8px;">
      <header class="ontology-group__head">
        <span class="ontology-group__title">${t("enterprise.ontologyEditor.functions")}</span>
        ${props.canEdit && scopeEntityIds.length >= 1
          ? html`<button
              type="button"
              class="btn"
              ?disabled=${props.treeSaving}
              @click=${() =>
                props.onOntologyDraft({
                  kind: "function",
                  nodeId: node.id,
                  id: "",
                  title: "",
                  entity: scopeEntityIds[0] ?? "",
                  expression: "",
                  returns: "number",
                })}
            >
              ${t("enterprise.entryDraft.add")}
            </button>`
          : nothing}
      </header>
      <div class="ontology-group__body">
        ${functions.length === 0
          ? html`<div class="muted">${t("enterprise.ontologyEditor.noFunctions")}</div>`
          : functions.map(
              (fn) => html`
                <div>
                  <div class="chip-row">
                    ${renderOntologyChip(
                      `${fn.id}(${fn.entity}) → ${fn.returns}`,
                      t("enterprise.ontologyEditor.removeFunctionTitle", { function: fn.id }),
                      props,
                      () => props.onRemoveOntologyFunction(node.id, fn.id),
                    )}
                  </div>
                  <code class="muted">${fn.expression}</code>
                </div>
              `,
            )}
        ${draft?.kind === "function"
          ? renderOntologyDraftForm(draft, scopeEntityIds, props)
          : nothing}
      </div>
    </section>
  `;
}

/** The open ontology form. One shape per kind, one submit path. */
function renderOntologyDraftForm(
  draft: EnterpriseOntologyDraft,
  entityIds: readonly string[],
  props: EnterpriseProps,
): TemplateResult {
  return html`
    <div class="ontology-draft-form">
      ${draft.kind === "action-effect"
        ? // An effect names an object type and a verb; it has no id of its own.
          nothing
        : html`<label class="field">
            <span class="muted">${t(`enterprise.ontologyEditor.idLabel.${draft.kind}`)}</span>
            <input
              class="input"
              .value=${draft.id}
              ?disabled=${props.treeSaving}
              @input=${(event: Event) =>
                props.onEditOntologyDraft({ id: (event.target as HTMLInputElement).value })}
            />
          </label>`}
      ${draft.kind === "entity" || draft.kind === "action" || draft.kind === "function"
        ? html`<label class="field">
            <span class="muted">${t("enterprise.ontologyEditor.titleLabel")}</span>
            <input
              class="input"
              .value=${draft.title}
              ?disabled=${props.treeSaving}
              @input=${(event: Event) =>
                props.onEditOntologyDraft({ title: (event.target as HTMLInputElement).value })}
            />
          </label>`
        : nothing}
      ${draft.kind === "property" || draft.kind === "action-parameter"
        ? renderValueTypeSelect(
            t("enterprise.ontologyEditor.typeLabel"),
            draft.type,
            props,
            (type) => props.onEditOntologyDraft({ type }),
          )
        : nothing}
      ${draft.kind === "property"
        ? html`<label class="field">
            <input
              type="checkbox"
              .checked=${draft.primaryKey}
              ?disabled=${props.treeSaving}
              @change=${(event: Event) =>
                props.onEditOntologyDraft({
                  primaryKey: (event.target as HTMLInputElement).checked,
                })}
            />
            <span class="muted">${t("enterprise.ontologyEditor.primaryKeyLabel")}</span>
          </label>`
        : nothing}
      ${draft.kind === "action-parameter"
        ? html`<label class="field">
            <input
              type="checkbox"
              .checked=${draft.required}
              ?disabled=${props.treeSaving}
              @change=${(event: Event) =>
                props.onEditOntologyDraft({
                  required: (event.target as HTMLInputElement).checked,
                })}
            />
            <span class="muted">${t("enterprise.ontologyEditor.requiredLabel")}</span>
          </label>`
        : nothing}
      ${draft.kind === "action-effect"
        ? html`${renderEntitySelect(
              t("enterprise.ontologyEditor.effectEntityLabel"),
              draft.entity,
              entityIds,
              props,
              (value) => props.onEditOntologyDraft({ entity: value }),
            )}
            <label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.effectKindLabel")}</span>
              <select
                class="input"
                .value=${draft.effectKind}
                ?disabled=${props.treeSaving}
                @change=${(event: Event) =>
                  props.onEditOntologyDraft({
                    effectKind: (event.target as HTMLSelectElement).value as OntologyEffectKindName,
                  })}
              >
                ${ONTOLOGY_EFFECT_KINDS.map(
                  (kind) => html`<option value=${kind} ?selected=${kind === draft.effectKind}>
                    ${kind}
                  </option>`,
                )}
              </select>
            </label>`
        : nothing}
      ${draft.kind === "function"
        ? html`${renderEntitySelect(
              t("enterprise.ontologyEditor.functionEntityLabel"),
              draft.entity,
              entityIds,
              props,
              (value) => props.onEditOntologyDraft({ entity: value }),
            )}
            <label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.expressionLabel")}</span>
              <input
                class="input"
                .value=${draft.expression}
                ?disabled=${props.treeSaving}
                @input=${(event: Event) =>
                  props.onEditOntologyDraft({
                    expression: (event.target as HTMLInputElement).value,
                  })}
              />
            </label>
            ${renderValueTypeSelect(
              t("enterprise.ontologyEditor.returnsLabel"),
              draft.returns,
              props,
              (returns) => props.onEditOntologyDraft({ returns }),
            )}`
        : nothing}
      ${draft.kind === "relationship"
        ? html`${renderEntitySelect(
              t("enterprise.ontologyEditor.fromLabel"),
              draft.from,
              entityIds,
              props,
              (value) => props.onEditOntologyDraft({ from: value }),
            )}
            ${renderEntitySelect(
              t("enterprise.ontologyEditor.toLabel"),
              draft.to,
              entityIds,
              props,
              (value) => props.onEditOntologyDraft({ to: value }),
            )}
            <label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.cardinalityLabel")}</span>
              <select
                class="input"
                .value=${draft.cardinality}
                ?disabled=${props.treeSaving}
                @change=${(event: Event) =>
                  props.onEditOntologyDraft({
                    cardinality: (event.target as HTMLSelectElement)
                      .value as OntologyCardinalityName,
                  })}
              >
                ${ONTOLOGY_CARDINALITIES.map(
                  (value) => html`<option value=${value} ?selected=${value === draft.cardinality}>
                    ${value}
                  </option>`,
                )}
              </select>
            </label>`
        : nothing}
      ${draft.error
        ? html`<div class="callout">${t(`enterprise.ontologyEditor.error.${draft.error}`)}</div>`
        : nothing}
      <div class="row" style="margin-top: 6px; gap: 8px;">
        <button
          type="button"
          class="btn"
          ?disabled=${props.treeSaving}
          @click=${() => props.onSubmitOntologyDraft()}
        >
          ${t("enterprise.ontologyEditor.save")}
        </button>
        <button
          type="button"
          class="btn"
          ?disabled=${props.treeSaving}
          @click=${() => props.onCancelOntologyDraft()}
        >
          ${t("enterprise.entryDraft.cancel")}
        </button>
      </div>
    </div>
  `;
}

/** The value-type picker, shared by a field, an action parameter, and a function's return. */
function renderValueTypeSelect(
  label: string,
  value: OntologyValueTypeName,
  props: EnterpriseProps,
  onChange: (value: OntologyValueTypeName) => void,
): TemplateResult {
  return html`<label class="field">
    <span class="muted">${label}</span>
    <select
      class="input"
      .value=${value}
      ?disabled=${props.treeSaving}
      @change=${(event: Event) =>
        onChange((event.target as HTMLSelectElement).value as OntologyValueTypeName)}
    >
      ${ONTOLOGY_VALUE_TYPES.map(
        (type) => html`<option value=${type} ?selected=${type === value}>${type}</option>`,
      )}
    </select>
  </label>`;
}

function renderEntitySelect(
  label: string,
  value: string,
  entityIds: readonly string[],
  props: EnterpriseProps,
  onChange: (value: string) => void,
): TemplateResult {
  return html`<label class="field">
    <span class="muted">${label}</span>
    <select
      class="input"
      .value=${value}
      ?disabled=${props.treeSaving}
      @change=${(event: Event) => onChange((event.target as HTMLSelectElement).value)}
    >
      ${entityIds.map((id) => html`<option value=${id} ?selected=${id === value}>${id}</option>`)}
    </select>
  </label>`;
}

/**
 * The kinds of capability a step can be given, and the binding rows each one owns.
 *
 * Grouped rather than listed flat because the five rows answer four different
 * questions, and an operator looking for "which MCP servers does this step get"
 * was scanning a run of identical cards to find the one that answers it.
 *
 * Tools keep allow and deny TOGETHER: they are one decision over one catalog, and
 * a denial only means something next to the grants it overrides.
 */
const CAPABILITY_CATEGORIES = [
  {
    kind: "tools",
    titleKey: "enterprise.capabilities.toolsTitle",
    hintKey: "enterprise.capabilities.toolsHint",
    fields: ["allowedTools", "deniedTools"],
  },
  {
    kind: "skills",
    titleKey: "enterprise.capabilities.skillsTitle",
    hintKey: "enterprise.capabilities.skillsHint",
    fields: ["skills"],
  },
  {
    kind: "mcp",
    titleKey: "enterprise.capabilities.mcpTitle",
    hintKey: "enterprise.capabilities.mcpHint",
    fields: ["mcpServers"],
  },
  {
    kind: "knowledge",
    titleKey: "enterprise.capabilities.knowledgeTitle",
    hintKey: "enterprise.capabilities.knowledgeHint",
    fields: ["knowledgeFoundations"],
  },
] as const satisfies ReadonlyArray<{
  kind: string;
  titleKey: string;
  hintKey: string;
  fields: readonly NodeOntologyListField[];
}>;

function renderNodeCapabilities(
  adders: readonly OntologyEntryAdder[],
  props: EnterpriseProps,
): TemplateResult {
  const byField = new Map(adders.map((adder) => [adder.field, adder]));
  return html`
    <div class="node-capabilities__lead">
      <div class="card-title">${t("enterprise.bindings.title")}</div>
      <div class="muted" style="margin-top: 4px;">${t("enterprise.bindings.subtitle")}</div>
      ${renderCatalogAgentScope(props.catalogAgentId)}${renderBindingCatalogIssues(props)}
    </div>
    ${CAPABILITY_CATEGORIES.map((category) => {
      const rows = category.fields
        .map((field) => byField.get(field))
        .filter((adder): adder is OntologyEntryAdder => Boolean(adder));
      return renderNodeSection({
        kind: category.kind,
        title: t(category.titleKey),
        hint: t(category.hintKey),
        body: html`<div class="binding-groups">
          ${rows.map((adder) => renderBindingGroup(props, adder))}
        </div>`,
      });
    })}
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
      <button type="button" class="btn" @click=${() => props.onBeginAddNode(nodeId)}>
        ${t("enterprise.addNodeButton")}
      </button>
    `;
  }
  const fieldStyle =
    "width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text);";
  return html`
    <div class="card-nested">
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
