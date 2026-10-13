// Control UI view renders the enterprise inspection screen: recent governed
// runs, a per-execution step/trace inspector, and the workflow-tree registry.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
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
import type {
  EnterpriseCatalogErrors,
  EnterpriseCatalogPhase,
  EnterpriseGuidanceDraft,
  EnterpriseListErrors,
  EnterpriseNodeDraft,
  EnterpriseNodeDraftError,
  EnterpriseBindingDetail,
  EnterpriseBindingPicker,
  EnterpriseBindingPickerFailure,
  EnterpriseBundleDraft,
  EnterpriseBundleStatus,
  EnterpriseMcpDraft,
  EnterpriseOntologyDraft,
  EnterpriseOntologyDraftBody,
  EnterpriseOntologyEntryDraftError,
  EnterpriseTreeConfirm,
  EnterpriseTreeDraft,
  EnterpriseTreeDraftError,
  EnterpriseTreeEditFormat,
} from "../controllers/enterprise.ts";
import "../components/modal-dialog.ts";
import "../components/ontology-graph.ts";
import "../components/workflow-tree-graph.ts";
import { parseMcpServerImport } from "../controllers/mcp-server-import.ts";
import { enterpriseResumeRefusalMessage } from "../enterprise-resume.ts";
import type { SkillStatusEntry } from "../types.ts";
import {
  collectNodeOntologyGraph,
  declaredExecutableEntityIds,
  declaredNodePathEntityIds,
  collectOntologyGraph,
  nodePathTo,
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
import { isSkillAvailable, renderSkillStatusChips } from "./skills-shared.ts";

export type EnterpriseProps = {
  loading: boolean;
  runs: EnterpriseRunSummary[];
  trees: EnterpriseTreeSummary[];
  historyOnlyTreeIds: string[];
  listErrors: EnterpriseListErrors;
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
  nodeObjectsError: string | null;
  treeEditing: boolean;
  visualEditing?: boolean;
  treeDraft: EnterpriseTreeDraft | null;
  treeEditContent: string;
  treeEditFormat: EnterpriseTreeEditFormat;
  treeSaving: boolean;
  treeSaveIssues: EnterpriseTreeImportIssue[] | null;
  /** Authoring checks computed from the authoritative selected work-map. */
  treeWarnings: EnterpriseTreeImportIssue[] | null;
  treeSaveError: string | null;
  treeConfirm: EnterpriseTreeConfirm | null;
  bundleDraft: EnterpriseBundleDraft | null;
  bundleStatus: EnterpriseBundleStatus | null;
  treeVersions: EnterpriseTreeVersionSummary[];
  treeVersionsLoading: boolean;
  treeVersionsError: string | null;
  // Whether the session holds operator.admin: tree import/remove are admin-only,
  // so mutation controls are hidden without it (reads stay available).
  canEdit: boolean;
  // Dynamic node creation: the open "add child node" form under a selected node.
  // Submit splices and saves the child through the shared tree-import path.
  nodeDraft: EnterpriseNodeDraft | null;
  error: string | null;
  onRefresh: () => void;
  onSelectRun: (executionId: string) => void;
  onSelectTree: (treeId: string) => void;
  onBeginEdit: () => void;
  onBeginRawEdit?: () => void;
  onBeginSettings: () => void;
  onBeginNew: () => void;
  onEditNew: (patch: Partial<Omit<EnterpriseTreeDraft, "error">>) => void;
  onCancelNew: () => void;
  onSubmitNew: () => void;
  onImportFile: (file: File) => void;
  onPreviewBundleFile: (file: File) => void;
  onCancelBundlePreview: () => void;
  onApplyBundle: () => void;
  onEditContent: (content: string) => void;
  onEditFormat: (format: EnterpriseTreeEditFormat) => void;
  onCancelEdit: () => void;
  onRequestSave: () => void;
  onRequestRemove: (treeId: string) => void;
  onCancelConfirm: () => void;
  onConfirm: () => void;
  onExport: (treeId: string, format: EnterpriseTreeEditFormat) => void;
  onExportBundle: (treeId: string, format: EnterpriseTreeEditFormat) => void;
  onLoadVersion: (treeId: string, revision: number) => void;
  onSelectNode: (nodeId: string | null) => boolean;
  onSelectNodeEntity: (entity: string) => void;
  /** Switch the selected work-map between explicit and inherited capability grants. */
  onToggleCapabilityGrants: () => void;
  /** Remove empty MCP markers after an explicit confirmation. */
  onDisableMcpGovernance: () => void;
  onBeginAddNode: (parentId: string) => void;
  onEditNodeDraft: (patch: { id?: string; title?: string; description?: string }) => void;
  onCancelAddNode: () => void;
  onSubmitAddNode: () => void;
  onRemoveNode: (nodeId: string) => void;
  // The open "grant a tool" / "declare a skill" / "allow a knowledge foundation"
  // picker for the selected step, or null. Confirming applies the picks straight
  // through enterprise.trees.import.
  bindingPicker: EnterpriseBindingPicker | null;
  onOpenBindingPicker: (nodeId: string, field: NodeOntologyListField) => void;
  onEnableMcpGovernance: (nodeId: string) => void;
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
  /** In-progress step-behavior edit, or null when nothing is being edited. */
  guidanceDraft: EnterpriseGuidanceDraft | null;
  onGuidanceDraft: (
    nodeId: string,
    patch: Partial<Omit<EnterpriseGuidanceDraft, "treeId" | "nodeId" | "expectedHash">>,
  ) => void;
  onSaveGuidance: (nodeId: string) => void;
  onCancelGuidance: () => void;
  /** The one open ontology form, or null. */
  ontologyDraft: EnterpriseOntologyDraft | null;
  onOntologyDraft: (draft: EnterpriseOntologyDraftBody) => void;
  onEditOntologyDraft: (patch: Partial<EnterpriseOntologyDraft>) => void;
  onSubmitOntologyDraft: () => void;
  onCancelOntologyDraft: () => void;
  onRemoveOntologyEntity: (nodeId: string, entityId: string, entityIndex?: number) => void;
  onRemoveOntologyProperty: (
    nodeId: string,
    entityId: string,
    propertyId: string,
    entityIndex?: number,
    propertyIndex?: number,
  ) => void;
  onRemoveOntologyRelationship: (
    nodeId: string,
    link: { id: string; from: string; to: string; index?: number },
  ) => void;
  onRemoveOntologyAction: (nodeId: string, actionId: string, actionIndex?: number) => void;
  onRemoveOntologyActionEffect: (
    nodeId: string,
    effect: { actionIndex?: number; effectIndex?: number } & (
      | { actionId: string; entity: string; kind: OntologyEffectKindName }
      | { actionId: string; kind: "call"; tool: string }
      | { actionId: string; kind: "link" | "unlink"; relationship: string }
    ),
  ) => void;
  onRemoveOntologyActionParameter: (
    nodeId: string,
    parameter: {
      actionId: string;
      parameterId: string;
      actionIndex?: number;
      parameterIndex?: number;
    },
  ) => void;
  onRemoveOntologyFunction: (nodeId: string, functionId: string, functionIndex?: number) => void;
  onRemoveOntologyConstraint: (nodeId: string, target: { index: number; id: string }) => void;
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
  error: string | null | undefined,
  emptyMessage: string,
): TemplateResult | typeof nothing {
  if (error) {
    return html`<div class="callout danger" role="alert" style="margin-top: 12px;">${error}</div>`;
  }
  if (error === undefined || phase === "unloaded") {
    return html`<div class="muted" style="margin-top: 12px;">${t("common.loading")}</div>`;
  }
  return html`<div class="muted" style="margin-top: 12px;">${emptyMessage}</div>`;
}

/** One catalog entry the picker can offer, with what it is for. */
type BindingOption = { value: string; description?: string; disabled?: boolean };

/** Match the model-facing snapshot that enterprise mediation can actually grant. */
function isModelUsableSkill(skill: SkillStatusEntry): boolean {
  // `modelVisible` is authoritative on current gateways. Fall back for older
  // status payloads that predate the field instead of hiding every skill.
  return skill.modelVisible ?? isSkillAvailable(skill);
}

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
  error: string | null | undefined;
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
  const canEnableMcpGovernance = field === "mcpServers" && !workMapHasMcpMarker(props);
  return html`
    <section class="binding-group">
      <header class="binding-group__head">
        <span class="binding-group__title">${adder.title}</span>
        <code class="binding-group__key">${BINDING_FIELD_META[field].configKey}</code>
        <span class="chip">${adder.values.length}</span>
        ${props.canEdit && canEnableMcpGovernance
          ? html`<button
              type="button"
              class="btn btn--sm"
              ?disabled=${nodeMutationLocked(props)}
              @click=${() => props.onEnableMcpGovernance(nodeId)}
            >
              ${t("enterprise.entryDraft.requireMcpAttachments")}
            </button>`
          : nothing}
        ${props.canEdit
          ? html`<button
              type="button"
              class="btn btn--sm"
              ?disabled=${nodeMutationLocked(props)}
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
          ? html`<div class="callout">${ancestorGateCallout(adder)}</div>`
          : nothing}
      </div>
    </section>
  `;
}

/**
 * The ancestor-gate callout for a row.
 *
 * Knowledge gets its own wording because the RULE is different, not just the
 * noun: an ancestor's allow-list intersects retrieval away with no approval
 * prompt, no denial record, and no `deniedTools` equivalent to point at — so the
 * tool copy's "otherwise it needs a one-off approval" would send an operator to
 * ship a step whose retrieval silently returns nothing.
 */
function ancestorGateCallout(adder: OntologyEntryAdder): string {
  const nodeIds = (adder.constrainingAncestors ?? []).join(", ");
  return adder.field === "knowledgeFoundations"
    ? t("enterprise.entryDraft.ancestorGateKnowledge", { nodeIds })
    : t("enterprise.entryDraft.ancestorGateApproval", { nodeIds });
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
          ?disabled=${nodeMutationLocked(props)}
          @click=${() => removeBindingFromStep(props, adder, value)}
        >
          ×
        </button>`
      : nothing}</span
  >`;
}

function removeBindingFromStep(
  props: EnterpriseProps,
  adder: OntologyEntryAdder,
  value: string,
): void {
  const removesLastLocalScope = lastLocalScopeRemovalWidens(props, adder, value);
  const warning =
    removesLastLocalScope && adder.field === "allowedTools"
      ? t("enterprise.entryDraft.removeLastAllowedTool")
      : removesLastLocalScope && adder.field === "knowledgeFoundations"
        ? t("enterprise.entryDraft.removeLastKnowledgeFoundation")
        : null;
  if (!warning || window.confirm(warning)) {
    props.onRemoveBinding(adder.nodeId, adder.field, value);
  }
}

/**
 * Whether dropping this step's final local allow-list entry exposes a capability
 * the current path does not admit. Explicit grants can still widen to an ancestor
 * grant, while an inherited path constrained to the same entry does not widen.
 */
function lastLocalScopeRemovalWidens(
  props: EnterpriseProps,
  adder: OntologyEntryAdder,
  value: string,
): boolean {
  if (
    adder.values.length !== 1 ||
    (adder.field !== "allowedTools" && adder.field !== "knowledgeFoundations")
  ) {
    return false;
  }
  const explicit = props.treeDetail?.capabilityGrants === "explicit";
  const ancestorIds = constrainingAncestorIds(props, adder.nodeId, adder.field);
  if (ancestorIds.length === 0) {
    return !explicit && (adder.field === "knowledgeFoundations" || value.trim() !== "*");
  }
  if (adder.field === "knowledgeFoundations") {
    return inheritedKnowledgeFoundations(props, adder.nodeId).some(
      (foundation) => foundation !== value,
    );
  }

  const nodes = props.treeDetail?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const node = byId.get(adder.nodeId);
  if (!node) {
    return false;
  }
  const { allowedTools: _allowedTools, ...ontologyWithoutAllow } = node.ontology;
  const unscopedNode = { ...node, ontology: ontologyWithoutAllow };
  byId.set(node.id, unscopedNode);
  const after = toolPolicyPath(unscopedNode, byId);
  const candidates = new Set([
    ...props.toolGroups.flatMap((group) => group.tools.map((tool) => tool.id)),
    ...after.path.slice(1).flatMap((ancestor) => ancestor.ontology.allowedTools ?? []),
  ]);
  const localPolicy = { allow: [value] };
  const explicitFloor = new Set(["message", "read", "memory_search"]);
  return [...candidates].some((candidate) => {
    const normalized = candidate.trim().toLowerCase();
    if (normalized === "complete_step" || (explicit && explicitFloor.has(normalized))) {
      return false;
    }
    const namedByAncestor = after.path.slice(1).some((ancestor) => {
      const allow = ancestor.ontology.allowedTools ?? [];
      return allow.length > 0 && isToolAllowedByPolicies(candidate, [{ allow }]);
    });
    return (
      (!explicit || namedByAncestor) &&
      isToolAllowedByPolicies(candidate, after.policies) &&
      !isToolAllowedByPolicies(candidate, [...after.policies, localPolicy])
    );
  });
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
    : catalogError === undefined || props.catalogPhase === "unloaded"
      ? "loading"
      : "ready";
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
                    ?disabled=${!idle || option.disabled === true}
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
          ? html`<div class="callout">${ancestorGateCallout(adder)}</div>`
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
      return html`<div class="callout danger" role="alert">
        ${t("enterprise.entryDraft.importRejected")}
      </div>`;
    }
    return html`<div class="callout danger" role="alert">
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
    return html`<div class="callout danger" role="alert">
      ${t("enterprise.entryDraft.importRefused", { message: failure.message })}
    </div>`;
  }
  return html`<div class="callout danger" role="alert">
    ${ontologyEntryErrorMessage(failure.kind)}
  </div>`;
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
function catalogUnavailable(
  props: EnterpriseProps,
  error: string | null | undefined,
): TemplateResult | null {
  if (error) {
    return html`<div class="callout danger" role="alert">${error}</div>`;
  }
  return error !== undefined && props.catalogPhase !== "unloaded"
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
  const { usable, ids: retrievableIds, ownershipKnown } = retrievableFoundations(props);
  const foundation = usable.find((candidate) => candidate.id === entry);
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
                ?disabled=${nodeMutationLocked(props)}
                @click=${() => removeBindingFromStep(props, adder, detail.entry)}
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

/** MCP attachments inherited from ancestors apply to every descendant step. */
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
          ? html`<span class="chip chip-warn"
              >${t("enterprise.bindings.skillNotModelVisible")}</span
            >`
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
 * Does the selected work-map DECLARE the field? Presence, matching the runtime's
 * opt-in (treeDeclaresMcpAttachment): an explicit `mcpServers: []` opts in, so a
 * length test would hide exactly the state an operator needs to see. Independent
 * of mode — adding an attachment changes the tree, never the mode.
 */
function workMapHasMcpMarker(props: EnterpriseProps): boolean {
  return (props.treeDetail?.nodes ?? []).some((node) => node.ontology.mcpServers !== undefined);
}

function workMapDeclaresMcp(props: EnterpriseProps): boolean {
  // Explicit grants imply it, exactly as buildEnterpriseRunPlan does: such a
  // work-map reaches only what it attaches, so its servers are governed even
  // though no step named the field.
  return props.treeDetail?.capabilityGrants === "explicit" || workMapHasMcpMarker(props);
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
        ${props.canEdit && !props.mcpDraft && !props.mcpRemoveConfirm
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
  const controlsBlocked =
    blocked !== null || props.mcpDraft !== null || props.mcpRemoveConfirm !== null;
  return html`<div class="list-item list-item-stacked ${editing ? "list-item-selected" : ""}">
    <div
      class="row"
      style="justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap;"
    >
      <div class="list-main" style="flex: 1 1 240px;">
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
        ? html`<div class="row" style="gap: 8px; flex-wrap: wrap; margin-left: auto;">
            <button
              class="btn btn--sm"
              ?disabled=${controlsBlocked}
              title=${blocked ?? ""}
              @click=${() => props.onToggleMcpServer(server.name, !server.enabled)}
            >
              ${server.enabled ? t("enterprise.mcpTab.disable") : t("enterprise.mcpTab.enable")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${controlsBlocked}
              title=${blocked ?? ""}
              @click=${() => props.onBeginMcpEdit(server.name)}
            >
              ${t("enterprise.mcpTab.edit")}
            </button>
            <button
              class="btn btn--sm danger"
              ?disabled=${controlsBlocked}
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
        <button
          class="btn danger"
          ?disabled=${!props.canEdit || !props.canRegisterMcp || props.mcpDraft !== null}
          title=${props.mcpRegisterBlockedReason ?? ""}
          @click=${props.onConfirmRemoveMcpServer}
        >
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
                aria-pressed=${draft.mode === mode ? "true" : "false"}
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
        ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
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
          aria-pressed=${draft.transport === transport ? "true" : "false"}
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
  const skillsKnown = props.catalogErrors.skills === null;
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
  const refreshBlockedByTreeDraft =
    hasPendingEnterpriseDraft(props) && !props.treeSaveError && !props.treeIssue && !props.error;
  const refreshBlockedByMcp = props.mcpDraft !== null || props.mcpRemoveConfirm !== null;
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("enterprise.title")}</div>
          <div class="card-sub">${t("enterprise.subtitle")}</div>
        </div>
        <button
          class="btn"
          ?disabled=${props.loading ||
          !props.connected ||
          refreshBlockedByTreeDraft ||
          refreshBlockedByMcp}
          @click=${props.onRefresh}
        >
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      ${props.error
        ? html`<div class="callout danger" role="alert" style="margin-top: 12px;">
            ${props.error}
          </div>`
        : nothing}
      ${props.storeError
        ? html`<div class="callout danger" role="alert" style="margin-top: 12px;">
            ${t("enterprise.storeError", { message: props.storeError })}
          </div>`
        : nothing}
      ${props.bundleStatus
        ? html`<div
            class="callout ${props.bundleStatus.kind === "error"
              ? "danger"
              : props.bundleStatus.kind === "warning"
                ? "warn"
                : "success"}"
            role=${props.bundleStatus.kind === "error" ? "alert" : "status"}
            style="margin-top: 12px;"
          >
            ${props.bundleStatus.message}
          </div>`
        : nothing}
      ${props.importErrors.length
        ? html`<div class="callout" role="alert" style="margin-top: 12px;">
            <div>${t("enterprise.importErrors")}</div>
            ${props.importErrors.map(
              (issue) => html`<div class="row" style="justify-content: space-between; gap: 8px;">
                <div class="muted">${issue.treeId}: ${issue.message}</div>
                ${props.canEdit
                  ? html`<button
                      class="btn danger"
                      ?disabled=${props.treeSaving}
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
              ${props.listErrors.runs
                ? html`<div class="callout danger" role="alert">${props.listErrors.runs}</div>`
                : nothing}
              ${props.runs.length === 0
                ? props.listErrors.runs === undefined
                  ? html`<div class="muted">${t("common.loading")}</div>`
                  : props.listErrors.runs
                    ? nothing
                    : html`<div class="muted">${t("enterprise.noRuns")}</div>`
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
            <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
              <div class="card-title">${t("enterprise.treesTitle")}</div>
              ${props.canEdit && props.listErrors.trees === null
                ? html`<div class="row" style="gap: 8px; flex-wrap: wrap;">
                    <label
                      class="btn"
                      style="cursor: pointer;"
                      role="button"
                      tabindex=${props.treeSaving ? "-1" : "0"}
                      aria-disabled=${props.treeSaving ? "true" : "false"}
                      @click=${(event: MouseEvent) => {
                        if (props.treeSaving || !canDiscardEnterpriseDraft(props)) {
                          event.preventDefault();
                        }
                      }}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key !== "Enter" && event.key !== " ") {
                          return;
                        }
                        event.preventDefault();
                        if (!props.treeSaving && canDiscardEnterpriseDraft(props)) {
                          (event.currentTarget as HTMLElement)
                            .querySelector<HTMLInputElement>('input[type="file"]')
                            ?.click();
                        }
                      }}
                    >
                      ${t("enterprise.bundle.import")}
                      <input
                        type="file"
                        accept=".yaml,.yml,.json,application/json,text/yaml"
                        style="display: none;"
                        ?disabled=${props.treeSaving}
                        @click=${(event: MouseEvent) => event.stopPropagation()}
                        @change=${(event: Event) => {
                          const input = event.target as HTMLInputElement;
                          const file = input.files?.[0];
                          if (file) {
                            props.onPreviewBundleFile(file);
                          }
                          input.value = "";
                        }}
                      />
                    </label>
                    <label
                      class="btn"
                      style="cursor: pointer;"
                      role="button"
                      tabindex=${props.treeSaving ? "-1" : "0"}
                      aria-disabled=${props.treeSaving ? "true" : "false"}
                      @click=${(event: MouseEvent) => {
                        if (props.treeSaving || !canDiscardEnterpriseDraft(props)) {
                          event.preventDefault();
                        }
                      }}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key !== "Enter" && event.key !== " ") {
                          return;
                        }
                        event.preventDefault();
                        if (!props.treeSaving && canDiscardEnterpriseDraft(props)) {
                          (event.currentTarget as HTMLElement)
                            .querySelector<HTMLInputElement>('input[type="file"]')
                            ?.click();
                        }
                      }}
                    >
                      ${t("enterprise.importTree")}
                      <input
                        type="file"
                        accept=".yaml,.yml,.json,application/json,text/yaml"
                        style="display: none;"
                        ?disabled=${props.treeSaving}
                        @click=${(event: MouseEvent) => event.stopPropagation()}
                        @change=${(event: Event) => {
                          const input = event.target as HTMLInputElement;
                          const file = input.files?.[0];
                          if (file) {
                            props.onImportFile(file);
                          }
                          input.value = "";
                        }}
                      />
                    </label>
                    <button
                      class="btn"
                      ?disabled=${props.treeSaving}
                      @click=${() => {
                        if (canDiscardEnterpriseDraft(props)) {
                          props.onBeginNew();
                        }
                      }}
                    >
                      ${t("enterprise.newTree")}
                    </button>
                  </div>`
                : nothing}
            </div>
            <div class="list" style="margin-top: 12px;">
              ${props.listErrors.trees
                ? html`<div class="callout danger" role="alert">${props.listErrors.trees}</div>`
                : nothing}
              ${props.trees.length === 0
                ? props.historyOnlyTreeIds.length > 0
                  ? props.historyOnlyTreeIds.map((treeId) =>
                      renderHistoryOnlyTree(treeId, props.selectedTreeId, (selectedId) => {
                        if (canNavigateToEnterpriseTree(props)) {
                          props.onSelectTree(selectedId);
                        }
                      }),
                    )
                  : props.listErrors.trees === undefined
                    ? html`<div class="muted">${t("common.loading")}</div>`
                    : props.listErrors.trees
                      ? nothing
                      : html`<div class="muted">${t("enterprise.noTrees")}</div>`
                : [
                    ...props.trees.map((tree) =>
                      renderTree(tree, props.selectedTreeId, (treeId) => {
                        if (canNavigateToEnterpriseTree(props)) {
                          props.onSelectTree(treeId);
                        }
                      }),
                    ),
                    ...props.historyOnlyTreeIds.map((treeId) =>
                      renderHistoryOnlyTree(treeId, props.selectedTreeId, (selectedId) => {
                        if (canNavigateToEnterpriseTree(props)) {
                          props.onSelectTree(selectedId);
                        }
                      }),
                    ),
                  ]}
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
    ${renderTreeConfirmModal(props)} ${renderBundlePreviewModal(props)}
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
      aria-pressed=${selected ? "true" : "false"}
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
  if (detail.resumeRefusalReason) {
    return detail.status === "completed" && detail.resumeRefusalReason === "route-complete"
      ? nothing
      : html`<div class="muted" style="margin-top: 12px;">
          ${enterpriseResumeRefusalMessage(detail.resumeRefusalReason)}
        </div>`;
  }
  if (detail.resumeRequested) {
    return html`<div class="muted" style="margin-top: 12px;">
      ${t("enterprise.resumeRequested")}
    </div>`;
  }
  // The method is admin-scoped. Read-only operators still see any server-owned
  // refusal above, but never get a button that can only fail on permissions.
  if (!props.canEdit || !detail.resumable) {
    return nothing;
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
            ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
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
      aria-pressed=${selected ? "true" : "false"}
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

function renderHistoryOnlyTree(
  treeId: string,
  selectedTreeId: string | null,
  onSelect: (treeId: string) => void,
): TemplateResult {
  return html`
    <button
      class="list-item list-item-clickable ${treeId === selectedTreeId ? "list-item-selected" : ""}"
      @click=${() => onSelect(treeId)}
    >
      <div class="list-main">
        <div class="list-title">${treeId}</div>
        <div class="list-sub">${t("enterprise.historyOnly")}</div>
      </div>
      <span class="chip">${t("enterprise.historyOnlyBadge")}</span>
    </button>
  `;
}

function renderTreeVisualization(props: EnterpriseProps): TemplateResult {
  if (props.treeDraft) {
    return renderNewTreeForm(props);
  }
  // The raw editor takes over the panel while editing (also for a new tree,
  // which has no selection yet).
  if (props.treeEditing && !props.visualEditing) {
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
  const historyOnly = props.historyOnlyTreeIds.includes(props.selectedTreeId);
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div class="card-title">${t("enterprise.treeTitle")}</div>
        ${renderTreeActions(props)}
      </div>
      ${props.treeIssue
        ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
            ${props.treeIssue}
          </div>`
        : nothing}
      ${props.treeSaveError
        ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
            ${props.treeSaveError}
          </div>`
        : nothing}
      ${props.treeSaveIssues?.length
        ? html`<div class="callout danger" role="alert">
            ${props.treeSaveIssues.map((issue) => html`<div>${issue.path}: ${issue.message}</div>`)}
          </div>`
        : nothing}
      ${tree
        ? renderTreeDetail(tree, props)
        : html`<div class="muted" style="margin-top: 8px;">
            ${props.treeLoading
              ? t("common.loading")
              : historyOnly
                ? t("enterprise.historyOnlyRestore")
                : t("enterprise.treeUnavailable")}
          </div>`}
      ${renderVersionHistory(props)}
    </section>
  `;
}

function hasPendingEnterpriseDraft(props: EnterpriseProps): boolean {
  return Boolean(
    props.treeSaving ||
    props.treeEditing ||
    props.treeDraft ||
    props.nodeDraft ||
    props.bindingPicker ||
    props.guidanceDraft ||
    props.ontologyDraft ||
    props.bundleDraft,
  );
}

function canDiscardEnterpriseDraft(props: EnterpriseProps): boolean {
  return !hasPendingEnterpriseDraft(props) || window.confirm(t("enterprise.editorDiscardWarning"));
}

function canNavigateToEnterpriseTree(props: EnterpriseProps): boolean {
  return props.treeSaving
    ? window.confirm(t("enterprise.saveContinuesNavigation"))
    : canDiscardEnterpriseDraft(props);
}

function nodeMutationLocked(props: EnterpriseProps): boolean {
  return (
    props.treeSaving ||
    Boolean(props.nodeDraft || props.bindingPicker || props.guidanceDraft || props.ontologyDraft)
  );
}

function treeDraftErrorMessage(error: EnterpriseTreeDraftError): string {
  const messages: Record<EnterpriseTreeDraftError, string> = {
    "id-empty": t("enterprise.newTreeErrorIdEmpty"),
    "id-pattern": t("enterprise.newTreeErrorIdPattern"),
    "id-duplicate": t("enterprise.newTreeErrorIdDuplicate"),
    "version-empty": t("enterprise.treeSettingsErrorVersionEmpty"),
    "name-empty": t("enterprise.newTreeErrorNameEmpty"),
    "triggers-empty": t("enterprise.treeSettingsErrorTriggersEmpty"),
    "priority-invalid": t("enterprise.treeSettingsErrorPriorityInvalid"),
    "execution-model-invalid": t("enterprise.treeSettingsErrorExecutionModelInvalid"),
    "root-id-empty": t("enterprise.newTreeErrorRootIdEmpty"),
    "root-id-pattern": t("enterprise.newTreeErrorRootIdPattern"),
    "root-title-empty": t("enterprise.newTreeErrorRootTitleEmpty"),
  };
  return messages[error];
}

function renderNewTreeForm(props: EnterpriseProps): TemplateResult {
  const draft = props.treeDraft;
  if (!draft) {
    return html``;
  }
  const invalidField =
    draft.error === "execution-model-invalid"
      ? "executionModel"
      : draft.error?.startsWith("id-")
        ? "id"
        : draft.error === "version-empty"
          ? "version"
          : draft.error === "name-empty"
            ? "name"
            : draft.error === "triggers-empty"
              ? "triggers"
              : draft.error === "priority-invalid"
                ? "priority"
                : draft.error?.startsWith("root-id-")
                  ? "rootId"
                  : draft.error === "root-title-empty"
                    ? "rootTitle"
                    : null;
  const errorId = "enterprise-new-tree-error";
  return html`
    <section class="card" data-enterprise-new-tree style="margin-top: 16px;">
      <div class="card-title">
        ${draft.mode === "create"
          ? t("enterprise.newTreeTitle")
          : t("enterprise.treeSettingsTitle")}
      </div>
      <form
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          props.onSubmitNew();
          requestAnimationFrame(() =>
            form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
          );
        }}
      >
        <fieldset
          ?disabled=${props.treeSaving || !props.canEdit}
          style="border: 0; padding: 0; margin: 0; min-width: 0;"
        >
          <div class="form-grid" style="margin-top: 12px;">
            <label class="field">
              <span>${t("enterprise.newTreeIdLabel")}</span>
              <input
                class="input"
                .value=${draft.id}
                placeholder=${t("enterprise.newTreeIdPlaceholder")}
                ?readonly=${draft.mode === "settings"}
                aria-invalid=${invalidField === "id" ? "true" : nothing}
                aria-describedby=${invalidField === "id" ? errorId : nothing}
                @input=${(event: Event) =>
                  props.onEditNew({ id: (event.target as HTMLInputElement).value })}
              />
            </label>
            <label class="field">
              <span>${t("enterprise.treeSettingsVersionLabel")}</span>
              <input
                class="input"
                .value=${draft.version}
                aria-invalid=${invalidField === "version" ? "true" : nothing}
                aria-describedby=${invalidField === "version" ? errorId : nothing}
                @input=${(event: Event) =>
                  props.onEditNew({ version: (event.target as HTMLInputElement).value })}
              />
            </label>
            <label class="field">
              <span>${t("enterprise.newTreeNameLabel")}</span>
              <input
                class="input"
                .value=${draft.name}
                aria-invalid=${invalidField === "name" ? "true" : nothing}
                aria-describedby=${invalidField === "name" ? errorId : nothing}
                @input=${(event: Event) =>
                  props.onEditNew({ name: (event.target as HTMLInputElement).value })}
              />
            </label>
            ${draft.mode === "create"
              ? html`<label class="field">
                    <span>${t("enterprise.newTreeRootIdLabel")}</span>
                    <input
                      class="input"
                      .value=${draft.rootId}
                      placeholder=${t("enterprise.newTreeRootIdPlaceholder")}
                      aria-invalid=${invalidField === "rootId" ? "true" : nothing}
                      aria-describedby=${invalidField === "rootId" ? errorId : nothing}
                      @input=${(event: Event) =>
                        props.onEditNew({ rootId: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label class="field">
                    <span>${t("enterprise.newTreeRootTitleLabel")}</span>
                    <input
                      class="input"
                      .value=${draft.rootTitle}
                      aria-invalid=${invalidField === "rootTitle" ? "true" : nothing}
                      aria-describedby=${invalidField === "rootTitle" ? errorId : nothing}
                      @input=${(event: Event) =>
                        props.onEditNew({ rootTitle: (event.target as HTMLInputElement).value })}
                    />
                  </label>`
              : nothing}
            <label class="field" style="grid-column: 1 / -1;">
              <span>${t("enterprise.newTreeDescriptionLabel")}</span>
              <textarea
                class="input"
                .value=${draft.description}
                @input=${(event: Event) =>
                  props.onEditNew({ description: (event.target as HTMLTextAreaElement).value })}
              ></textarea>
            </label>
            <label class="field" style="grid-column: 1 / -1;">
              <span>${t("enterprise.treeExecutionModel")}</span>
              <input
                class="input"
                .value=${draft.executionModel ?? ""}
                placeholder=${t("enterprise.routingDefault")}
                aria-invalid=${invalidField === "executionModel" ? "true" : nothing}
                aria-describedby=${invalidField === "executionModel" ? errorId : nothing}
                @input=${(event: Event) =>
                  props.onEditNew({ executionModel: (event.target as HTMLInputElement).value })}
              />
              <span class="muted">${t("enterprise.treeExecutionModelHint")}</span>
            </label>
            <fieldset
              class="field"
              style="grid-column: 1 / -1;"
              aria-invalid=${invalidField === "triggers" ? "true" : nothing}
              aria-describedby=${invalidField === "triggers" ? errorId : nothing}
            >
              <legend>${t("enterprise.treeSettingsTriggersLabel")}</legend>
              <div class="row" style="gap: 12px; flex-wrap: wrap;">
                ${(["user", "system", "subagent"] as const).map(
                  (trigger) => html`<label class="row" style="gap: 6px;">
                    <input
                      type="checkbox"
                      .checked=${draft.triggers.includes(trigger)}
                      @change=${(event: Event) => {
                        const checked = (event.target as HTMLInputElement).checked;
                        props.onEditNew({
                          triggers: checked
                            ? [...draft.triggers, trigger]
                            : draft.triggers.filter((candidate) => candidate !== trigger),
                        });
                      }}
                    />
                    <span>${t(`enterprise.treeSettingsTrigger.${trigger}`)}</span>
                  </label>`,
                )}
              </div>
            </fieldset>
            <label class="field">
              <span>${t("enterprise.treeSettingsPriorityLabel")}</span>
              <input
                class="input"
                type="number"
                step="1"
                .value=${draft.priority}
                aria-invalid=${invalidField === "priority" ? "true" : nothing}
                aria-describedby=${invalidField === "priority" ? errorId : nothing}
                @input=${(event: Event) =>
                  props.onEditNew({ priority: (event.target as HTMLInputElement).value })}
              />
            </label>
          </div>
        </fieldset>
        ${draft.error
          ? html`<div id=${errorId} class="callout danger" role="alert" style="margin-top: 8px;">
              ${treeDraftErrorMessage(draft.error)}
            </div>`
          : nothing}
        ${props.treeSaveError
          ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
              ${props.treeSaveError}
            </div>`
          : nothing}
        <div class="row" style="gap: 8px; margin-top: 12px;">
          <button type="submit" class="btn primary" ?disabled=${props.treeSaving || !props.canEdit}>
            ${props.treeSaving
              ? t("common.saving")
              : draft.mode === "create"
                ? t("enterprise.newTreeReview")
                : t("common.save")}
          </button>
          <button type="button" class="btn" @click=${props.onCancelNew}>
            ${props.treeSaving ? t("common.dismiss") : t("common.cancel")}
          </button>
        </div>
      </form>
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
  const removable =
    props.canEdit &&
    Boolean(props.visualEditing) &&
    (tree?.source === "imported" || hasCorruptImport);
  const buttons: TemplateResult[] = [];
  if (props.visualEditing) {
    buttons.push(html`
      <button
        class="btn primary"
        ?disabled=${nodeMutationLocked(props) || !props.connected}
        @click=${props.onRequestSave}
      >
        ${t("enterprise.save")}
      </button>
      <button class="btn" ?disabled=${props.treeSaving} @click=${props.onCancelEdit}>
        ${t("common.cancel")}
      </button>
    `);
  }
  if (tree && props.canEdit && !props.visualEditing) {
    buttons.push(
      html`<button
        class="btn"
        ?disabled=${props.treeSaving || !props.canEdit}
        @click=${() => {
          if (canDiscardEnterpriseDraft(props)) {
            props.onBeginSettings();
          }
        }}
      >
        ${t("enterprise.treeSettingsButton")}
      </button>`,
      html`<button
        class="btn"
        ?disabled=${props.treeSaving}
        @click=${() => {
          if (canDiscardEnterpriseDraft(props)) {
            props.onBeginEdit();
          }
        }}
      >
        ${t("enterprise.edit")}
      </button>`,
    );
  }
  if (tree && props.canEdit && !props.visualEditing && props.onBeginRawEdit) {
    buttons.push(
      html`<button
        class="btn"
        ?disabled=${props.treeSaving}
        @click=${() => {
          if (canDiscardEnterpriseDraft(props)) {
            props.onBeginRawEdit?.();
          }
        }}
      >
        YAML / JSON
      </button>`,
    );
  }
  if (tree) {
    buttons.push(
      html`<button
        class="btn"
        ?disabled=${!props.connected}
        @click=${() => props.onExport(treeId, "yaml")}
      >
        ${t("enterprise.exportYaml")}
      </button>`,
      html`<button
        class="btn"
        ?disabled=${!props.connected}
        @click=${() => props.onExport(treeId, "json")}
      >
        ${t("enterprise.exportJson")}
      </button>`,
    );
    if (props.canEdit) {
      buttons.push(
        html`<button
          class="btn"
          ?disabled=${!props.connected || props.treeSaving}
          @click=${() => props.onExportBundle(treeId, "yaml")}
        >
          ${t("enterprise.bundle.exportYaml")}
        </button>`,
        html`<button
          class="btn"
          ?disabled=${!props.connected || props.treeSaving}
          @click=${() => props.onExportBundle(treeId, "json")}
        >
          ${t("enterprise.bundle.exportJson")}
        </button>`,
      );
    }
  }
  if (removable) {
    buttons.push(
      html`<button
        class="btn danger"
        ?disabled=${props.treeSaving}
        @click=${() => props.onRequestRemove(treeId)}
      >
        ${t("enterprise.remove")}
      </button>`,
    );
  }
  return buttons.length === 0
    ? nothing
    : html`<div class="row" style="gap: 8px; flex-wrap: wrap;">${buttons}</div>`;
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
              type="button"
              class="chip ${props.treeEditFormat === format ? "list-item-selected" : ""}"
              aria-pressed=${props.treeEditFormat === format ? "true" : "false"}
              ?disabled=${nodeMutationLocked(props) || !props.canEdit}
              @click=${() => {
                if (
                  format === props.treeEditFormat ||
                  window.confirm(t("enterprise.editorFormatWarning"))
                ) {
                  props.onEditFormat(format);
                }
              }}
            >
              ${format.toUpperCase()}
            </button>`,
          )}
        </div>
      </div>
      <div class="muted" style="margin-top: 4px;">${t("enterprise.editorHint")}</div>
      <textarea
        class="input"
        aria-label=${t("enterprise.editorTitle")}
        style="margin-top: 8px; width: 100%; min-height: 320px; font-family: monospace; white-space: pre;"
        .value=${props.treeEditContent}
        ?disabled=${props.treeSaving || !props.canEdit}
        @input=${(event: Event) => props.onEditContent((event.target as HTMLTextAreaElement).value)}
      ></textarea>
      ${props.treeSaveError
        ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
            ${props.treeSaveError}
          </div>`
        : nothing}
      ${props.treeSaveIssues?.length
        ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
            <div>${t("enterprise.saveInvalid")}</div>
            ${props.treeSaveIssues.map(
              (issue) => html`<div class="muted">
                ${issue.path ? html`<strong>${issue.path}</strong>: ` : nothing}${issue.message}
              </div>`,
            )}
          </div>`
        : nothing}
      <div class="row" style="gap: 8px; margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${props.treeSaving || !props.canEdit}
          @click=${props.onRequestSave}
        >
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
  const canLoadVersion = Boolean(
    props.canEdit &&
    !hasPendingEnterpriseDraft(props) &&
    !props.treeLoading &&
    treeId &&
    ((props.treeDetail?.id === treeId && props.treeDetail.hash) ||
      props.historyOnlyTreeIds.includes(treeId ?? "")),
  );
  return html`
    <div class="card-title" style="margin-top: 16px;">${t("enterprise.historyTitle")}</div>
    ${props.treeVersionsError
      ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
          ${props.treeVersionsError}
        </div>`
      : props.treeVersions.length === 0
        ? html`<div class="muted" style="margin-top: 8px;">
            ${props.treeVersionsLoading ? t("common.loading") : t("enterprise.noHistory")}
          </div>`
        : html`<div class="list" style="margin-top: 8px;">
            ${props.treeVersions.map((version) =>
              renderVersionRow(version, treeId, canLoadVersion ? props.onLoadVersion : null),
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
              ${t("enterprise.confirmRemoveDataLossWarning")}
            </div>`
          : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn ${isRemove ? "danger" : "primary"}"
            ?disabled=${!props.canEdit}
            @click=${props.onConfirm}
          >
            ${isRemove ? t("enterprise.remove") : t("enterprise.save")}
          </button>
          <button class="btn" @click=${props.onCancelConfirm}>${t("common.cancel")}</button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderBundleItems(label: string, items: readonly string[], warning = false) {
  if (items.length === 0) {
    return nothing;
  }
  return html`<div style="margin-top: 10px;">
    <div class="muted">${label}</div>
    <div class="chip-row" style="margin-top: 4px;">
      ${items.map((item) => html`<span class="chip ${warning ? "chip-warn" : ""}">${item}</span>`)}
    </div>
  </div>`;
}

/** Preview-before-apply review for the exact local bundle bytes retained in state. */
function renderBundlePreviewModal(props: EnterpriseProps): TemplateResult | typeof nothing {
  const draft = props.bundleDraft;
  const tree = draft?.preview.trees[0];
  if (!draft || !tree || !props.canEdit) {
    return nothing;
  }
  const preview = draft.preview;
  const skillsKnown = props.catalogErrors.skills === null;
  const availableSkills = new Set(
    props.skills.filter(isModelUsableSkill).map((skill) => skill.name),
  );
  const missingSkills = skillsKnown
    ? preview.requiredSkills.filter((skill) => !availableSkills.has(skill))
    : [];
  const { ownershipKnown } = retrievableFoundations(props);
  const foundationsKnown = props.catalogErrors.foundations === null && ownershipKnown;
  const globalFoundations = new Set(
    props.foundations
      .filter((foundation) => foundation.ownerTreeIds?.length === 0)
      .map((foundation) => foundation.id),
  );
  const missingFoundations = foundationsKnown
    ? preview.missingFoundations.filter((foundation) => !globalFoundations.has(foundation))
    : [];
  const unverifiedDependencies = [
    !skillsKnown && preview.requiredSkills.length > 0
      ? t("enterprise.bundle.requiredSkills")
      : null,
    !foundationsKnown && preview.missingFoundations.length > 0
      ? t("enterprise.bundle.requiredKnowledge")
      : null,
  ].filter((label): label is string => label !== null);
  const replacement = tree.replaced
    ? t("enterprise.bundle.replace", {
        source: tree.replaced,
        version: tree.currentVersion ?? "?",
      })
    : t("enterprise.bundle.create");
  return html`
    <openclaw-modal-dialog
      label=${t("enterprise.bundle.previewTitle")}
      description=${t("enterprise.bundle.previewBody")}
      wide
      @modal-cancel=${props.onCancelBundlePreview}
    >
      <div class="exec-approval-card">
        <div class="muted">${t("enterprise.bundle.previewBody")}</div>
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${tree.id} · ${tree.version}</div>
            <div class="exec-approval-sub">${draft.fileName} · ${replacement}</div>
          </div>
        </div>
        ${renderBundleItems(t("enterprise.bundle.inlinedKnowledge"), preview.foundations)}
        ${renderBundleItems(t("enterprise.bundle.requiredTools"), preview.requiredTools)}
        ${renderBundleItems(t("enterprise.bundle.requiredSkills"), preview.requiredSkills)}
        ${renderBundleItems(t("enterprise.bundle.requiredMcp"), preview.requiredMcpServers)}
        ${renderBundleItems(t("enterprise.bundle.missingSkills"), missingSkills, true)}
        ${renderBundleItems(t("enterprise.bundle.missingMcp"), preview.missingMcpServers, true)}
        ${!foundationsKnown
          ? renderBundleItems(
              t("enterprise.bundle.unverifiedKnowledge"),
              preview.missingFoundations,
              true,
            )
          : nothing}
        ${renderBundleItems(t("enterprise.bundle.missingKnowledge"), missingFoundations, true)}
        ${renderBundleItems(
          t("enterprise.bundle.removedKnowledge"),
          preview.removedFoundations,
          true,
        )}
        ${renderBundleItems(
          t("enterprise.bundle.replacedKnowledge"),
          preview.replacedFoundations,
          true,
        )}
        ${renderBundleItems(
          t("enterprise.bundle.shadowedKnowledge"),
          preview.shadowedFoundations,
          true,
        )}
        ${renderBundleItems(
          t("enterprise.bundle.verificationUnavailable"),
          unverifiedDependencies,
          true,
        )}
        ${renderBundleItems(
          t("enterprise.bundle.missingPolicies"),
          preview.missingGovernancePolicies,
          true,
        )}
        ${renderBundleItems(
          t("enterprise.bundle.conflictingPolicies"),
          preview.conflictingGovernancePolicies,
          true,
        )}
        ${preview.governanceModeDowngrade
          ? html`<div class="callout warn" role="alert" style="margin-top: 10px;">
              ${t("enterprise.bundle.modeDowngrade", preview.governanceModeDowngrade)}
            </div>`
          : nothing}
        ${preview.warnings.length
          ? html`<div class="callout warn" role="alert" style="margin-top: 10px;">
              <div>${t("enterprise.bundle.authorWarnings")}</div>
              ${preview.warnings.map(
                (warning) => html`<div class="muted">
                  ${warning.path
                    ? html`<strong>${warning.path}</strong>: `
                    : nothing}${warning.message}
                </div>`,
              )}
            </div>`
          : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${props.treeSaving || !props.connected}
            @click=${props.onApplyBundle}
          >
            ${props.treeSaving ? t("common.saving") : t("enterprise.bundle.apply")}
          </button>
          <button class="btn" ?disabled=${props.treeSaving} @click=${props.onCancelBundlePreview}>
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderTreeDetail(tree: EnterpriseTreeDetail, options: EnterpriseProps): TemplateResult {
  const props = { ...options, canEdit: options.canEdit && Boolean(options.visualEditing) };
  return html`
    <div class="card-sub">${tree.name} — ${tree.id}@${tree.version}</div>
    ${props.visualEditing ? nothing : renderTreeWarnings(props)}
    ${tree.description
      ? html`<div class="muted" style="margin-top: 4px;">${tree.description}</div>`
      : nothing}
    ${renderCapabilityGrants(tree, props)}

    <div class="card-title" style="margin-top: 16px;">${t("enterprise.structureTitle")}</div>
    <openclaw-workflow-tree-graph
      .nodes=${tree.nodes}
      .showInspector=${false}
      .selected=${props.selectedNodeId}
      ?inert=${props.treeSaving}
      aria-disabled=${props.treeSaving ? "true" : "false"}
      @node-select=${(event: CustomEvent<{ nodeId: string | null }>) => {
        if (props.treeSaving || !canDiscardEnterpriseDraft({ ...props, treeEditing: false })) {
          event.preventDefault();
          return;
        }
        if (!props.onSelectNode(event.detail.nodeId)) {
          event.preventDefault();
        }
      }}
    ></openclaw-workflow-tree-graph>
    ${renderNodeInspector(tree, props)} ${renderWholeTreeOverview(tree, props)}
  `;
}

/**
 * Declarations on the saved work-map that no run could reach — an action no step
 * can invoke, a knowledge source every path excludes.
 *
 * Shown beside the authoritative tree rather than in the editor: these are not
 * why a save failed, they are what the current work-map says and cannot do.
 * Until this landed only `openclaw enterprise import`
 * printed them, so a work-map built entirely in the node inspector — the surface
 * that makes it easiest to declare a grant an ancestor excludes — never showed
 * one.
 */
function renderTreeWarnings(props: EnterpriseProps): TemplateResult | typeof nothing {
  if (!props.treeWarnings?.length) {
    return nothing;
  }
  return html`
    <div class="callout warn" role="status" style="margin-top: 8px;">
      <div>${t("enterprise.treeWarnings")}</div>
      ${props.treeWarnings.map(
        (warning) => html`<div class="muted">
          ${warning.path ? html`<strong>${warning.path}</strong>: ` : nothing}${warning.message}
        </div>`,
      )}
    </div>
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
  // This opt-out is tree-wide and only safe once every real attachment is gone;
  // otherwise removing the marker would also discard an operator's grant.
  const canDisableMcpGovernance =
    !configuredExplicit &&
    workMapHasMcpMarker(props) &&
    !tree.nodes.some((node) => (node.ontology.mcpServers?.length ?? 0) > 0);
  return html`
    <div
      class="row capability-grants"
      style="justify-content: space-between; gap: 8px; margin-top: 8px;"
    >
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
        ? html`<div class="row" style="gap: 8px;">
            ${canDisableMcpGovernance
              ? html`<button
                  type="button"
                  class="btn danger"
                  ?disabled=${nodeMutationLocked(props)}
                  @click=${() => {
                    if (window.confirm(t("enterprise.capabilityGrants.stopMcpWarning"))) {
                      props.onDisableMcpGovernance();
                    }
                  }}
                >
                  ${t("enterprise.capabilityGrants.stopMcp")}
                </button>`
              : nothing}
            <button
              type="button"
              class="btn"
              ?disabled=${nodeMutationLocked(props)}
              @click=${() => {
                if (
                  !configuredExplicit ||
                  window.confirm(t("enterprise.capabilityGrants.turnOffWarning"))
                ) {
                  props.onToggleCapabilityGrants();
                }
              }}
            >
              ${configuredExplicit
                ? t("enterprise.capabilityGrants.turnOff")
                : t("enterprise.capabilityGrants.turnOn")}
            </button>
          </div>`
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
      <!-- Structure stays next to the map. The longer prompt and capability
        editors must not push add/remove controls below the fold. -->
      <!-- Adding a CHILD STEP is structural: it changes the workflow shape, not
        what this step may call, so it keeps its own block rather than reading as
        a fifth kind of capability. -->
      ${props.canEdit
        ? renderNodeSection({
            kind: "structure",
            title: t("enterprise.addNodeSectionTitle"),
            hint: t("enterprise.addNodeSectionSubtitle"),
            body: html`
              ${renderAddNode(tree.id, nodeId, props)}
              ${node.parentId !== null
                ? html`<button
                    type="button"
                    class="btn danger"
                    style="margin-top: 8px;"
                    ?disabled=${nodeMutationLocked(props)}
                    @click=${() => {
                      if (
                        window.confirm(
                          t("enterprise.removeNodeWarning", {
                            node: node.title,
                          }),
                        )
                      ) {
                        props.onRemoveNode(node.id);
                      }
                    }}
                  >
                    ${t("enterprise.removeNode")}
                  </button>`
                : nothing}
            `,
          })
        : nothing}
      ${guidance === nothing
        ? nothing
        : renderNodeSection({
            kind: "prompt",
            title: t("enterprise.guidanceEditor.title"),
            hint: t("enterprise.guidanceEditor.guidanceNote"),
            body: guidance,
          })}
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
  const usableSkills = new Set(props.skills.filter(isModelUsableSkill).map((skill) => skill.name));
  const {
    usable: retrievableFoundationEntries,
    ids: retrievableIds,
    ownershipKnown,
  } = retrievableFoundations(props);
  // Only claim something is missing once ITS catalog answered without error:
  // a failed request also leaves an empty list, which would otherwise mark every
  // declared value unresolved.
  const skillsKnown = props.catalogErrors.skills === null;
  // Ownership is part of the claim: without it a value cannot be called
  // unavailable, only unverified.
  const foundationsKnown = props.catalogErrors.foundations === null && ownershipKnown;
  // Config is loaded with the screen rather than fetched per catalog, so an
  // attachment naming a server that is not in `mcp.servers` is known-missing
  // straight away — no phase gate like the two above need.
  const registeredServers = new Set(props.mcpServers.map((server) => server.name));
  const enabledServers = new Set(
    props.mcpServers.filter((server) => server.enabled).map((server) => server.name),
  );
  const inheritedMcp = inheritedMcpServers(props, node.id);
  // The knowledge allow-list INTERSECTS down the path, so an ancestor that names
  // other sources silently excludes what is attached here. Both halves are
  // needed: the ancestor ids say whether anything narrows at all, and the
  // inherited set says what survives — an ancestor chain that intersects to
  // nothing leaves the second empty while the first is not.
  const knowledgeAncestors = constrainingAncestorIds(props, node.id, "knowledgeFoundations");
  const inheritedFoundations = inheritedKnowledgeFoundations(props, node.id);
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
      options: props.skills.map((skill) => {
        const usable = isModelUsableSkill(skill);
        const description = [
          skill.description,
          usable ? null : t("enterprise.bindings.skillNotModelVisible"),
        ]
          .filter((part): part is string => Boolean(part))
          .join(" — ");
        return {
          value: skill.name,
          ...(description ? { description } : {}),
          ...(usable ? {} : { disabled: true }),
        };
      }),
      // A declared skill resolves to instructions only when the agent has it, so
      // the operator has to see which declarations resolve today. Named per agent:
      // the skill set is agent-scoped, and a tree can govern a different agent
      // than the one this catalog answered for.
      valueNote: (value) =>
        skillsKnown && !usableSkills.has(value)
          ? t("enterprise.bindings.skillNotModelVisible")
          : null,
    },
    {
      nodeId: node.id,
      field: "knowledgeFoundations",
      values: foundations,
      title: t("enterprise.bindings.allowedLabel"),
      // The summary, not a bare id: picking which store belongs on which step is
      // the whole point of this row, and among several dotted ids the id alone
      // does not say what a store covers. Falls back to the display name so a
      // descriptionless adapter still reads as something.
      options: retrievableFoundationEntries
        .map((foundation) => {
          const description = foundation.description ?? foundation.displayName;
          return description && description !== foundation.id
            ? { value: foundation.id, description }
            : { value: foundation.id };
        })
        .toSorted((a, b) => a.value.localeCompare(b.value)),
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
      constrainingAncestors: knowledgeAncestors,
      // "Not registered" first: an id nobody serves is dead whatever the path
      // allows, and telling the operator to widen an ancestor for it would send
      // them to fix the wrong file.
      valueNote: (value) =>
        foundationsKnown && !retrievableIds.has(value)
          ? t("enterprise.bindings.foundationNotRegistered")
          : knowledgeAncestors.length > 0 && !inheritedFoundations.includes(value)
            ? t("enterprise.bindings.foundationExcludedByAncestor")
            : null,
    },
    {
      nodeId: node.id,
      field: "mcpServers",
      values: ontology.mcpServers ?? [],
      title: t("enterprise.bindings.attachedLabel"),
      options: props.mcpServers.map((server) => ({
        value: server.name,
        description: [server.launch, server.enabled ? null : t("enterprise.bindings.mcpDisabled")]
          .filter((part): part is string => Boolean(part))
          .join(" — "),
        ...(server.enabled ? {} : { disabled: true }),
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
          : props.mcpServersKnown && !enabledServers.has(value)
            ? t("enterprise.bindings.mcpDisabled")
            : null,
    },
  ];
}

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
function isNodeInSubtree(tree: EnterpriseTreeDetail, rootId: string, candidateId: string): boolean {
  const parentById = new Map(tree.nodes.map((node) => [node.id, node.parentId]));
  let current: string | null | undefined = candidateId;
  while (current) {
    if (current === rootId) {
      return true;
    }
    current = parentById.get(current);
  }
  return false;
}

function renderNodeGuidance(
  node: EnterpriseTreeNode,
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  const tree = props.treeDetail;
  const siblings = tree?.nodes.filter((candidate) => candidate.parentId === node.parentId) ?? [];
  const saved = {
    title: node.title,
    parentId: node.parentId,
    position: Math.max(
      0,
      siblings.findIndex((candidate) => candidate.id === node.id),
    ),
    description: node.description ?? "",
    text: node.ontology.guidance ?? "",
    contextHints: [...(node.ontology.contextHints ?? [])],
    expectedOutput: node.ontology.expectedOutput ?? "",
    audit: node.ontology.audit ?? false,
  };
  // Both ids: node ids repeat across trees (roots especially), so a draft from
  // another work-map would otherwise appear under this step.
  const draft =
    props.guidanceDraft?.nodeId === node.id && props.guidanceDraft.treeId === props.treeDetail?.id
      ? props.guidanceDraft
      : null;
  const locked =
    props.treeSaving ||
    Boolean(
      props.nodeDraft ||
      props.bindingPicker ||
      props.ontologyDraft ||
      (props.guidanceDraft && !draft),
    );
  if (!props.canEdit) {
    const hasBehavior =
      saved.text || saved.contextHints.length > 0 || saved.expectedOutput || saved.audit;
    return hasBehavior
      ? html`
          ${saved.text
            ? html`<div class="muted" style="white-space: pre-wrap;">${saved.text}</div>`
            : nothing}
          ${saved.contextHints.length > 0
            ? html`<div class="muted" style="white-space: pre-wrap;">
                ${saved.contextHints.join("\n")}
              </div>`
            : nothing}
          ${saved.expectedOutput
            ? html`<div class="muted" style="white-space: pre-wrap;">
                ${t("enterprise.expectedOutput", { text: saved.expectedOutput })}
              </div>`
            : nothing}
          ${saved.audit ? html`<span class="chip">${t("enterprise.audit")}</span>` : nothing}
        `
      : nothing;
  }
  const value = draft ?? { treeId: "", nodeId: node.id, ...saved, error: null };
  const dirty =
    value.title !== saved.title ||
    value.parentId !== saved.parentId ||
    value.position !== saved.position ||
    value.description !== saved.description ||
    value.text !== saved.text ||
    JSON.stringify(value.contextHints) !== JSON.stringify(saved.contextHints) ||
    value.expectedOutput !== saved.expectedOutput ||
    value.audit !== saved.audit;
  return html`
    <div class="form-grid node-guidance-form">
      <label class="field">
        <span>${t("enterprise.guidanceEditor.titleLabel")}</span>
        <input
          class="input"
          .value=${value.title}
          ?disabled=${locked}
          @input=${(event: Event) =>
            props.onGuidanceDraft(node.id, {
              title: (event.target as HTMLInputElement).value,
            })}
        />
      </label>
      ${node.parentId !== null && tree
        ? html`<label class="field">
              <span>${t("enterprise.guidanceEditor.parentLabel")}</span>
              <select
                class="input"
                .value=${value.parentId ?? ""}
                ?disabled=${locked}
                @change=${(event: Event) => {
                  const parentId = (event.target as HTMLSelectElement).value;
                  const childCount = tree.nodes.filter(
                    (candidate) => candidate.parentId === parentId,
                  ).length;
                  const position = Math.max(0, childCount - (parentId === saved.parentId ? 1 : 0));
                  props.onGuidanceDraft(node.id, { parentId, position });
                }}
              >
                ${tree.nodes
                  .filter((candidate) => !isNodeInSubtree(tree, node.id, candidate.id))
                  .map(
                    (candidate) => html`<option
                      value=${candidate.id}
                      ?selected=${candidate.id === value.parentId}
                    >
                      ${candidate.title} — ${candidate.id}
                    </option>`,
                  )}
              </select>
            </label>
            <label class="field">
              <span>${t("enterprise.guidanceEditor.positionLabel")}</span>
              <input
                class="input"
                type="number"
                min="1"
                step="1"
                .value=${String(value.position + 1)}
                ?disabled=${locked}
                @input=${(event: Event) =>
                  props.onGuidanceDraft(node.id, {
                    position: Number((event.target as HTMLInputElement).value) - 1,
                  })}
              />
            </label>`
        : nothing}
      <label class="field">
        <span>${t("enterprise.guidanceEditor.descriptionLabel")}</span>
        <input
          class="input"
          .value=${value.description}
          ?disabled=${locked}
          @input=${(event: Event) =>
            props.onGuidanceDraft(node.id, {
              description: (event.target as HTMLInputElement).value,
            })}
        />
      </label>
      <label class="field full">
        <span>${t("enterprise.guidanceEditor.fieldLabel", { nodeId: node.id })}</span>
        <textarea
          class="input"
          rows="4"
          .value=${value.text}
          placeholder=${t("enterprise.guidanceEditor.placeholder")}
          ?disabled=${locked}
          @input=${(event: Event) =>
            props.onGuidanceDraft(node.id, {
              text: (event.target as HTMLTextAreaElement).value,
            })}
        ></textarea>
      </label>
      <fieldset class="field full" style="border: 0; padding: 0; margin: 0; min-width: 0;">
        <legend>${t("enterprise.guidanceEditor.contextHintsLabel")}</legend>
        ${(value.contextHints.length > 0 ? value.contextHints : [""]).map(
          (hint, index) => html`
            <div class="row" style="gap: 6px;">
              <input
                class="input"
                data-list-entry=${String(index)}
                style="flex: 1;"
                aria-label=${`${t("enterprise.guidanceEditor.contextHintsLabel")} ${index + 1}`}
                .value=${hint}
                placeholder=${t("enterprise.guidanceEditor.contextHintsPlaceholder")}
                ?disabled=${locked}
                @input=${(event: Event) => {
                  const contextHints = [...value.contextHints];
                  contextHints[index] = (event.target as HTMLInputElement).value;
                  props.onGuidanceDraft(node.id, { contextHints });
                }}
              />
              ${value.contextHints.length > 0
                ? html`<button
                    type="button"
                    class="btn"
                    title=${`${t("enterprise.guidanceEditor.removeContextHint")} ${index + 1}`}
                    aria-label=${`${t("enterprise.guidanceEditor.removeContextHint")} ${index + 1}`}
                    ?disabled=${locked}
                    @click=${(event: Event) => {
                      const fieldset = (event.currentTarget as HTMLElement).closest("fieldset");
                      props.onGuidanceDraft(node.id, {
                        contextHints: value.contextHints.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      });
                      requestAnimationFrame(() => {
                        const inputs = fieldset?.querySelectorAll<HTMLElement>("[data-list-entry]");
                        (
                          inputs?.[Math.min(index, inputs.length - 1)] ??
                          fieldset?.querySelector<HTMLElement>("[data-list-add]")
                        )?.focus();
                      });
                    }}
                  >
                    ×
                  </button>`
                : nothing}
            </div>
          `,
        )}
        <button
          type="button"
          class="btn"
          data-list-add
          ?disabled=${locked}
          @click=${(event: Event) => {
            const fieldset = (event.currentTarget as HTMLElement).closest("fieldset");
            props.onGuidanceDraft(node.id, { contextHints: [...value.contextHints, ""] });
            requestAnimationFrame(() =>
              fieldset
                ?.querySelector<HTMLElement>(`[data-list-entry="${value.contextHints.length}"]`)
                ?.focus(),
            );
          }}
        >
          ${t("enterprise.guidanceEditor.addContextHint")}
        </button>
      </fieldset>
      <label class="field full">
        <span>${t("enterprise.guidanceEditor.expectedOutputLabel")}</span>
        <textarea
          class="input"
          rows="3"
          .value=${value.expectedOutput}
          placeholder=${t("enterprise.guidanceEditor.expectedOutputPlaceholder")}
          ?disabled=${locked}
          @input=${(event: Event) =>
            props.onGuidanceDraft(node.id, {
              expectedOutput: (event.target as HTMLTextAreaElement).value,
            })}
        ></textarea>
      </label>
      <label class="field checkbox full">
        <input
          type="checkbox"
          .checked=${value.audit}
          ?disabled=${locked}
          @change=${(event: Event) =>
            props.onGuidanceDraft(node.id, {
              audit: (event.target as HTMLInputElement).checked,
            })}
        />
        <span>${t("enterprise.guidanceEditor.auditLabel")}</span>
      </label>
    </div>
    ${value.error
      ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
          ${t(`enterprise.guidanceEditor.error.${value.error}`)}
        </div>`
      : nothing}
    <div class="row" style="margin-top: 6px; gap: 8px;">
      <button
        type="button"
        class="btn"
        ?disabled=${!dirty || locked}
        @click=${() => {
          if (
            value.parentId === saved.parentId ||
            window.confirm(t("enterprise.guidanceEditor.reparentWarning"))
          ) {
            props.onSaveGuidance(node.id);
          }
        }}
      >
        ${t("enterprise.guidanceEditor.save")}
      </button>
      <button
        type="button"
        class="btn"
        ?disabled=${!draft || locked}
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

function declarationIsShadowed(entries: readonly { id: string }[], index: number): boolean {
  return entries.findLastIndex((entry) => entry.id === entries[index]?.id) > index;
}

/** One "id — remove" chip, the shape every ontology list row uses. */
function renderOntologyChip(
  label: string,
  removeTitle: string,
  props: EnterpriseProps,
  onRemove: () => void,
  onEdit?: () => void,
): TemplateResult {
  return html`<span class="chip"
    ><code>${label}</code>${props.canEdit && onEdit
      ? html`<button
          type="button"
          class="chip-open"
          title=${t("enterprise.ontologyEditor.editTitle", { item: label })}
          aria-label=${t("enterprise.ontologyEditor.editTitle", { item: label })}
          ?disabled=${nodeMutationLocked(props)}
          @click=${onEdit}
        >
          ${t("enterprise.edit")}
        </button>`
      : nothing}${props.canEdit
      ? html`<button
          type="button"
          class="chip-remove"
          title=${removeTitle}
          aria-label=${removeTitle}
          ?disabled=${nodeMutationLocked(props)}
          @click=${onRemove}
        >
          ×
        </button>`
      : nothing}</span
  >`;
}

function renderOntologyMetadata(
  rows: ReadonlyArray<{ label: string; value: string | undefined }>,
): TemplateResult | typeof nothing {
  const visible = rows.filter((row) => row.value);
  return visible.length === 0
    ? nothing
    : html`<div class="muted">
        ${visible.map((row) => html`<div>${row.label}: ${row.value}</div>`)}
      </div>`;
}

function renderOntologyTextList(
  label: string,
  values: readonly string[],
  props: EnterpriseProps,
  onChange: (values: string[]) => void,
): TemplateResult {
  return html`<fieldset class="field">
    <legend>${label}</legend>
    ${values.map(
      (value, index) => html`<div class="row" style="gap: 6px; margin-top: 6px;">
        <input
          class="input"
          data-list-entry=${String(index)}
          aria-label="${label} ${index + 1}"
          .value=${value}
          ?disabled=${props.treeSaving}
          @input=${(event: Event) => {
            const next = [...values];
            next[index] = (event.target as HTMLInputElement).value;
            onChange(next);
          }}
        />
        <button
          type="button"
          class="btn"
          aria-label=${t("enterprise.ontologyEditor.removeListItem", {
            item: `${label} ${index + 1}`,
          })}
          ?disabled=${props.treeSaving}
          @click=${(event: Event) => {
            const fieldset = (event.currentTarget as HTMLElement).closest("fieldset");
            onChange(values.filter((_entry, at) => at !== index));
            requestAnimationFrame(() => {
              const inputs = fieldset?.querySelectorAll<HTMLElement>("[data-list-entry]");
              (
                inputs?.[Math.min(index, inputs.length - 1)] ??
                fieldset?.querySelector<HTMLElement>("[data-list-add]")
              )?.focus();
            });
          }}
        >
          ${t("enterprise.remove")}
        </button>
      </div>`,
    )}
    <button
      type="button"
      class="btn"
      data-list-add
      style="margin-top: 6px;"
      ?disabled=${props.treeSaving}
      @click=${(event: Event) => {
        const fieldset = (event.currentTarget as HTMLElement).closest("fieldset");
        onChange([...values, ""]);
        requestAnimationFrame(() =>
          fieldset?.querySelector<HTMLElement>(`[data-list-entry="${values.length}"]`)?.focus(),
        );
      }}
    >
      ${t("enterprise.ontologyEditor.addListItem", { item: label })}
    </button>
  </fieldset>`;
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
  const constraints = node.ontology.constraints ?? [];
  // A node may declare only LINKS, or only an action over types an ancestor gave
  // it — valid and common, so an empty local entity list is not an empty section.
  if (
    !props.canEdit &&
    entities.length === 0 &&
    relationships.length === 0 &&
    actions.length === 0 &&
    functions.length === 0 &&
    constraints.length === 0
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
    ${entities.map((entity, entityIndex) => {
      const properties = entity.properties ?? [];
      const propertyDraft =
        draft?.kind === "property" &&
        draft.entityId === entity.id &&
        draft.entityIndex === entityIndex
          ? draft
          : null;
      const entityDraft =
        draft?.kind === "entity" &&
        draft.metadataUpdate?.kind === "entity" &&
        draft.metadataUpdate.target.index === entityIndex &&
        draft.metadataUpdate.target.id === entity.id
          ? draft
          : null;
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
                    title=${t("enterprise.ontologyEditor.editTitle", { item: entity.id })}
                    aria-label=${t("enterprise.ontologyEditor.editTitle", { item: entity.id })}
                    ?disabled=${nodeMutationLocked(props)}
                    @click=${() =>
                      props.onOntologyDraft({
                        kind: "entity",
                        nodeId: node.id,
                        id: entity.id,
                        title: entity.title ?? "",
                        description: entity.description ?? "",
                        metadataUpdate: {
                          kind: "entity",
                          target: { index: entityIndex, id: entity.id },
                        },
                      })}
                  >
                    ${t("enterprise.edit")}
                  </button>
                  <button
                    type="button"
                    class="btn"
                    ?disabled=${nodeMutationLocked(props)}
                    @click=${() =>
                      props.onOntologyDraft({
                        kind: "property",
                        nodeId: node.id,
                        entityId: entity.id,
                        entityIndex,
                        id: "",
                        type: "string",
                        // From the MERGED shape, not this node's array: an
                        // ancestor may already carry the identity field, and
                        // opening the box checked would guarantee a refusal.
                        primaryKey: !mergedEntityHasIdentity(props, entity.id),
                        required: false,
                        description: "",
                      })}
                  >
                    ${t("enterprise.ontologyEditor.addProperty")}
                  </button>
                  ${renderOntologyChip(
                    t("enterprise.ontologyEditor.removeEntity"),
                    t("enterprise.ontologyEditor.removeEntityTitle", { entity: entity.id }),
                    props,
                    () => props.onRemoveOntologyEntity(node.id, entity.id, entityIndex),
                  )}`
              : nothing}
          </header>
          <div class="ontology-group__body">
            ${renderOntologyMetadata([
              {
                label: t("enterprise.ontologyEditor.descriptionLabel"),
                value: entity.description,
              },
            ])}
            ${properties.length === 0
              ? html`<div class="muted">${t("enterprise.ontologyEditor.noProperties")}</div>`
              : html`<div class="chip-row">
                  ${properties.map((property, propertyIndex) =>
                    renderOntologyChip(
                      `${property.id}: ${property.type}${
                        property.primaryKey
                          ? ` ${t("enterprise.ontologyEditor.primaryKeyMark")}`
                          : ""
                      }${
                        property.required ? ` ${t("enterprise.ontologyEditor.requiredMark")}` : ""
                      }`,
                      t("enterprise.ontologyEditor.removePropertyTitle", { property: property.id }),
                      props,
                      () =>
                        props.onRemoveOntologyProperty(
                          node.id,
                          entity.id,
                          property.id,
                          entityIndex,
                          propertyIndex,
                        ),
                      () =>
                        props.onOntologyDraft({
                          kind: "property",
                          nodeId: node.id,
                          entityId: entity.id,
                          entityIndex,
                          id: property.id,
                          type: property.type,
                          primaryKey: property.primaryKey ?? false,
                          required: property.required ?? false,
                          description: property.description ?? "",
                          metadataUpdate: {
                            kind: "property",
                            entity: { index: entityIndex, id: entity.id },
                            target: {
                              index: propertyIndex,
                              id: property.id,
                              type: property.type,
                              primaryKey: property.primaryKey ?? false,
                            },
                            required: property.required ?? false,
                          },
                        }),
                    ),
                  )}
                </div>`}
            ${properties.map((property) =>
              renderOntologyMetadata([
                {
                  label: property.id,
                  value: property.description,
                },
              ]),
            )}
            ${entityDraft ? renderOntologyDraftForm(entityDraft, scopeEntityIds, props) : nothing}
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
              ?disabled=${nodeMutationLocked(props)}
              @click=${() =>
                props.onOntologyDraft({
                  kind: "relationship",
                  nodeId: node.id,
                  id: "",
                  from: scopeEntityIds[0] ?? "",
                  to: scopeEntityIds[Math.min(1, scopeEntityIds.length - 1)] ?? "",
                  cardinality: "many-to-many",
                  inverse: "",
                  description: "",
                })}
            >
              ${t("enterprise.entryDraft.add")}
            </button>`
          : nothing}
      </header>
      <div class="ontology-group__body">
        ${relationships.length === 0
          ? html`<div class="muted">${t("enterprise.ontologyEditor.noLinks")}</div>`
          : html`<div class="list">
              ${relationships.map(
                (relationship, relationshipIndex) => html`
                  <div>
                    <div class="chip-row">
                      ${renderOntologyChip(
                        `${relationship.from} → ${relationship.to} (${relationship.id})${
                          declarationIsShadowed(relationships, relationshipIndex)
                            ? ` — ${t("enterprise.ontologyEditor.shadowedDeclaration")}`
                            : ""
                        }`,
                        t("enterprise.ontologyEditor.removeLinkTitle", { link: relationship.id }),
                        props,
                        () =>
                          props.onRemoveOntologyRelationship(node.id, {
                            index: relationshipIndex,
                            id: relationship.id,
                            from: relationship.from,
                            to: relationship.to,
                          }),
                        () =>
                          props.onOntologyDraft({
                            kind: "relationship",
                            nodeId: node.id,
                            id: relationship.id,
                            from: relationship.from,
                            to: relationship.to,
                            cardinality: relationship.cardinality ?? "many-to-many",
                            inverse: relationship.inverse ?? "",
                            description: relationship.description ?? "",
                            metadataUpdate: {
                              kind: "relationship",
                              target: {
                                index: relationshipIndex,
                                id: relationship.id,
                                from: relationship.from,
                                to: relationship.to,
                                ...(relationship.cardinality
                                  ? { cardinality: relationship.cardinality }
                                  : {}),
                              },
                            },
                          }),
                      )}
                    </div>
                    ${renderOntologyMetadata([
                      {
                        label: t("enterprise.ontologyEditor.inverseLabel"),
                        value: relationship.inverse,
                      },
                      {
                        label: t("enterprise.ontologyEditor.descriptionLabel"),
                        value: relationship.description,
                      },
                    ])}
                  </div>
                `,
              )}
            </div>`}
        ${draft?.kind === "relationship"
          ? renderOntologyDraftForm(draft, scopeEntityIds, props)
          : nothing}
      </div>
    </section>
    ${renderNodeOntologyActions(node, actions, verbEntityIds, draft, props)}
    ${renderNodeOntologyFunctions(node, functions, verbEntityIds, draft, props)}
    ${renderNodeOntologyConstraints(node, constraints, draft, props)}
    ${props.canEdit
      ? html`<div class="row" style="margin-top: 8px;">
          <button
            type="button"
            class="btn"
            ?disabled=${nodeMutationLocked(props)}
            @click=${() =>
              props.onOntologyDraft({
                kind: "entity",
                nodeId: node.id,
                id: "",
                title: "",
                description: "",
              })}
          >
            ${t("enterprise.ontologyEditor.addEntity")}
          </button>
        </div>`
      : nothing}
    ${draft?.kind === "entity" && !draft.metadataUpdate
      ? renderOntologyDraftForm(draft, scopeEntityIds, props)
      : nothing}
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
  return html`
    <div class="card-title" style="margin-top: 16px;">
      ${t("enterprise.ontologyEditor.actions")}
    </div>
    <div class="muted" style="margin-top: 4px;">
      ${t("enterprise.ontologyEditor.actionsSummary")}
    </div>
    ${actions.map((action, actionIndex) => {
      const effects = action.effects ?? [];
      const parameters = action.parameters ?? [];
      const executableScopes = executableOntologyScopes(
        props.treeDetail,
        node.id,
        action.id,
        actionIndex,
      );
      const [firstScope, ...remainingScopes] = executableScopes;
      const actionEntityIds = firstScope
        ? [...firstScope.entities.keys()].filter((id) =>
            remainingScopes.every((scope) => scope.entities.has(id)),
          )
        : [];
      const actionRelationshipIds = firstScope
        ? [...firstScope.relationships.keys()].filter((id) =>
            remainingScopes.every((scope) => scope.relationships.has(id)),
          )
        : [];
      const fullyShadowed = executableScopes.length === 0;
      const callable = fullyShadowed || actionIsCallable(effects, parameters, executableScopes);
      const shadowed = fullyShadowed || declarationIsShadowed(actions, actionIndex);
      // An action is either outward or local, never both: the call cannot join
      // the local write transaction, so the import refuses a mixed one. The Add
      // buttons offer only the side this action is already on.
      const outward = effects.some((effect) => effect.kind === "call");
      const local = effects.some((effect) => effect.kind !== "call");
      const actionDraft =
        draft?.kind === "action" &&
        draft.metadataUpdate?.kind === "action" &&
        draft.metadataUpdate.target.index === actionIndex &&
        draft.metadataUpdate.target.id === action.id
          ? draft
          : (draft?.kind === "action-effect" ||
                draft?.kind === "action-parameter" ||
                draft?.kind === "action-call" ||
                draft?.kind === "action-link") &&
              draft.actionId === action.id &&
              draft.actionIndex === actionIndex
            ? draft
            : null;
      return html`
        <section class="ontology-group" style="margin-top: 8px;">
          <header class="ontology-group__head">
            <span class="ontology-group__title"
              >${action.title ? `${action.title} — ${action.id}` : action.id}
              ${shadowed
                ? html`<span class="chip chip-warn">
                    ${t("enterprise.ontologyEditor.shadowedDeclaration")}
                  </span>`
                : nothing}</span
            >
            ${props.canEdit
              ? html`<button
                    type="button"
                    class="btn"
                    title=${t("enterprise.ontologyEditor.editTitle", { item: action.id })}
                    aria-label=${t("enterprise.ontologyEditor.editTitle", { item: action.id })}
                    ?disabled=${nodeMutationLocked(props)}
                    @click=${() =>
                      props.onOntologyDraft({
                        kind: "action",
                        nodeId: node.id,
                        id: action.id,
                        title: action.title ?? "",
                        description: action.description ?? "",
                        toolsMode:
                          action.tools === undefined
                            ? "all"
                            : action.tools.length === 0
                              ? "none"
                              : "selected",
                        tools: [...(action.tools ?? [])],
                        preconditions: [...(action.preconditions ?? [])],
                        metadataUpdate: {
                          kind: "action",
                          target: { index: actionIndex, id: action.id },
                        },
                      })}
                  >
                    ${t("enterprise.edit")}
                  </button>
                  ${actionEntityIds.length >= 1 && !outward
                    ? html`<button
                        type="button"
                        class="btn"
                        ?disabled=${nodeMutationLocked(props)}
                        @click=${() =>
                          props.onOntologyDraft({
                            kind: "action-effect",
                            nodeId: node.id,
                            actionId: action.id,
                            actionIndex,
                            entity: actionEntityIds[0] ?? "",
                            effectKind: "update",
                            description: "",
                          })}
                      >
                        ${t("enterprise.ontologyEditor.addEffect")}
                      </button>`
                    : // With no object type in scope the form could only collect an
                      // empty select and save `endpoint-missing`, whose message is
                      // about links. The function editor already guards this way.
                      // An outward action is hidden from this button for a second
                      // reason: it may hold no local effect at all, so the splicer
                      // would refuse whatever the form collected.
                      nothing}
                  ${actionRelationshipIds.length >= 1 && !outward
                    ? html`<button
                        type="button"
                        class="btn"
                        ?disabled=${nodeMutationLocked(props)}
                        @click=${() =>
                          props.onOntologyDraft({
                            kind: "action-link",
                            nodeId: node.id,
                            actionId: action.id,
                            actionIndex,
                            relationship: actionRelationshipIds[0] ?? "",
                            linkKind: "link",
                            from: "",
                            to: "",
                            description: "",
                          })}
                      >
                        ${t("enterprise.ontologyEditor.addLinkEffect")}
                      </button>`
                    : nothing}
                  ${local
                    ? // The mirror of the two above: an action already writing
                      // locally cannot also call out, because the call cannot join
                      // that write's transaction.
                      nothing
                    : html`<button
                        type="button"
                        class="btn"
                        ?disabled=${nodeMutationLocked(props)}
                        @click=${() =>
                          props.onOntologyDraft({
                            kind: "action-call",
                            nodeId: node.id,
                            actionId: action.id,
                            actionIndex,
                            tool: "",
                            description: "",
                          })}
                      >
                        ${t("enterprise.ontologyEditor.addCallEffect")}
                      </button>`}
                  <button
                    type="button"
                    class="btn"
                    ?disabled=${nodeMutationLocked(props)}
                    @click=${() =>
                      props.onOntologyDraft({
                        kind: "action-parameter",
                        nodeId: node.id,
                        actionId: action.id,
                        actionIndex,
                        id: "",
                        type: "string",
                        required: false,
                        description: "",
                      })}
                  >
                    ${t("enterprise.ontologyEditor.addParameter")}
                  </button>
                  ${renderOntologyChip(
                    t("enterprise.ontologyEditor.removeEntity"),
                    t("enterprise.ontologyEditor.removeActionTitle", { action: action.id }),
                    props,
                    () => props.onRemoveOntologyAction(node.id, action.id, actionIndex),
                  )}`
              : nothing}
          </header>
          <div class="ontology-group__body">
            ${renderOntologyMetadata([
              {
                label: t("enterprise.ontologyEditor.descriptionLabel"),
                value: action.description,
              },
              {
                label: t("enterprise.ontologyEditor.toolsLabel"),
                value:
                  action.tools === undefined
                    ? t("enterprise.ontologyEditor.toolsMode.all")
                    : action.tools.length === 0
                      ? t("enterprise.ontologyEditor.toolsMode.none")
                      : action.tools.join(", "),
              },
              {
                label: t("enterprise.ontologyEditor.preconditionsLabel"),
                value: action.preconditions?.join(", "),
              },
            ])}
            ${effects.length === 0
              ? html`<div class="muted">${t("enterprise.ontologyEditor.noEffects")}</div>`
              : html`<div>
                  ${effects.map((effect, effectIndex) => {
                    // Each variant names a different target: an object type, the
                    // tool an outward call goes to, or the relationship a graph
                    // effect relates over. The chip has to say which.
                    const removal =
                      "entity" in effect
                        ? {
                            actionId: action.id,
                            actionIndex,
                            effectIndex,
                            entity: effect.entity,
                            kind: effect.kind,
                          }
                        : effect.kind === "call"
                          ? {
                              actionId: action.id,
                              actionIndex,
                              effectIndex,
                              kind: "call" as const,
                              tool: effect.tool,
                            }
                          : {
                              actionId: action.id,
                              actionIndex,
                              effectIndex,
                              kind: effect.kind,
                              relationship: effect.relationship,
                            };
                    const target =
                      "entity" in effect
                        ? effect.entity
                        : effect.kind === "call"
                          ? effect.tool
                          : effect.relationship;
                    const onEdit = () => {
                      if ("entity" in effect) {
                        props.onOntologyDraft({
                          kind: "action-effect",
                          nodeId: node.id,
                          actionId: action.id,
                          actionIndex,
                          entity: effect.entity,
                          effectKind: effect.kind,
                          description: effect.description ?? "",
                          metadataUpdate: {
                            kind: "object-effect",
                            action: { index: actionIndex, id: action.id },
                            target: {
                              index: effectIndex,
                              kind: effect.kind,
                              entity: effect.entity,
                            },
                          },
                        });
                        return;
                      }
                      if (effect.kind === "call") {
                        props.onOntologyDraft({
                          kind: "action-call",
                          nodeId: node.id,
                          actionId: action.id,
                          actionIndex,
                          tool: effect.tool,
                          description: effect.description ?? "",
                          metadataUpdate: {
                            kind: "call-effect",
                            action: { index: actionIndex, id: action.id },
                            target: { index: effectIndex, kind: "call", tool: effect.tool },
                          },
                        });
                        return;
                      }
                      props.onOntologyDraft({
                        kind: "action-link",
                        nodeId: node.id,
                        actionId: action.id,
                        actionIndex,
                        relationship: effect.relationship,
                        linkKind: effect.kind,
                        from: effect.from ?? "",
                        to: effect.to ?? "",
                        description: effect.description ?? "",
                        metadataUpdate: {
                          kind: "link-effect",
                          action: { index: actionIndex, id: action.id },
                          target: {
                            index: effectIndex,
                            kind: effect.kind,
                            relationship: effect.relationship,
                          },
                        },
                      });
                    };
                    return html`<div style="margin-top: 4px;">
                      ${renderOntologyChip(
                        `${effect.kind} ${target}`,
                        t("enterprise.ontologyEditor.removeEffectTitle", {
                          kind: effect.kind,
                          entity: target,
                        }),
                        props,
                        () => props.onRemoveOntologyActionEffect(node.id, removal),
                        onEdit,
                      )}
                      ${renderOntologyMetadata([
                        {
                          label: t("enterprise.ontologyEditor.linkEndpointsLabel"),
                          value:
                            effect.kind === "link" || effect.kind === "unlink"
                              ? `${effect.from || t("enterprise.ontologyEditor.defaultIdentity")} → ${effect.to || t("enterprise.ontologyEditor.defaultIdentity")}`
                              : undefined,
                        },
                        {
                          label: t("enterprise.ontologyEditor.descriptionLabel"),
                          value: effect.description,
                        },
                      ])}
                    </div>`;
                  })}
                </div>`}
            ${callable
              ? nothing
              : html`<div class="callout">
                  ${t("enterprise.ontologyEditor.incompleteActionDetail")}
                </div>`}
            ${parameters.length === 0
              ? html`<div class="muted">${t("enterprise.ontologyEditor.noParameters")}</div>`
              : html`<div>
                  ${parameters.map(
                    (parameter, parameterIndex) => html`<div style="margin-top: 4px;">
                      ${renderOntologyChip(
                        `${parameter.id}: ${parameter.type}${
                          parameter.required
                            ? ` ${t("enterprise.ontologyEditor.requiredMark")}`
                            : ""
                        }`,
                        t("enterprise.ontologyEditor.removeParameterTitle", {
                          parameter: parameter.id,
                        }),
                        props,
                        () =>
                          props.onRemoveOntologyActionParameter(node.id, {
                            actionId: action.id,
                            actionIndex,
                            parameterId: parameter.id,
                            parameterIndex,
                          }),
                        () =>
                          props.onOntologyDraft({
                            kind: "action-parameter",
                            nodeId: node.id,
                            actionId: action.id,
                            actionIndex,
                            id: parameter.id,
                            type: parameter.type,
                            required: parameter.required ?? false,
                            description: parameter.description ?? "",
                            metadataUpdate: {
                              kind: "parameter",
                              action: { index: actionIndex, id: action.id },
                              target: {
                                index: parameterIndex,
                                id: parameter.id,
                                type: parameter.type,
                              },
                              required: parameter.required ?? false,
                            },
                          }),
                      )}
                      ${renderOntologyMetadata([
                        {
                          label: t("enterprise.ontologyEditor.descriptionLabel"),
                          value: parameter.description,
                        },
                      ])}
                    </div>`,
                  )}
                </div>`}
            ${actionDraft
              ? renderOntologyDraftForm(
                  actionDraft,
                  actionEntityIds,
                  props,
                  actionRelationshipIds,
                  parameters.map((parameter) => parameter.id),
                )
              : nothing}
          </div>
        </section>
      `;
    })}
    ${props.canEdit
      ? html`<div class="row" style="margin-top: 8px;">
          <button
            type="button"
            class="btn"
            ?disabled=${nodeMutationLocked(props)}
            @click=${() =>
              props.onOntologyDraft({
                kind: "action",
                nodeId: node.id,
                id: "",
                title: "",
                description: "",
                toolsMode: "all",
                tools: [],
                preconditions: [],
              })}
          >
            ${t("enterprise.ontologyEditor.addAction")}
          </button>
        </div>`
      : nothing}
    ${draft?.kind === "action" && !draft.metadataUpdate
      ? renderOntologyDraftForm(draft, scopeEntityIds, props)
      : nothing}
  `;
}

/**
 * Runtime ontology shapes for every leaf where an action declared at `nodeId`
 * may execute.
 *
 * Kept per leaf because link ids are last-wins and may resolve to different
 * endpoint types on different branches. Flattening them would bless an action
 * that works on one executable path and fails on another.
 */
function executableOntologyScopes(
  tree: EnterpriseTreeDetail | null,
  nodeId: string,
  actionId: string,
  actionIndex: number,
): Array<{
  entities: Map<
    string,
    {
      primaryKey?: { id: string; type: OntologyValueTypeName };
      properties: Map<string, OntologyValueTypeName>;
      required: string[];
    }
  >;
  relationships: Map<string, { from: string; to: string }>;
}> {
  if (!tree) {
    return [];
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
  const effectiveLeaves = (leaves.length > 0 ? leaves : [nodeId]).filter((id) => {
    let ownerId: string | undefined;
    let ownerIndex: number | undefined;
    for (const step of nodePathTo(tree, id)) {
      for (const [index, action] of (step.ontology.actions ?? []).entries()) {
        if (action.id === actionId) {
          ownerId = step.id;
          ownerIndex = index;
        }
      }
    }
    return ownerId === nodeId && ownerIndex === actionIndex;
  });
  return effectiveLeaves.map((id) => {
    const path = nodePathTo(tree, id);
    const declaredEntityIds = new Set(
      path.flatMap((step) => (step.ontology.entities ?? []).map((entity) => entity.id)),
    );
    const entities = new Map<
      string,
      {
        primaryKey?: { id: string; type: OntologyValueTypeName };
        properties: Map<string, OntologyValueTypeName>;
        required: string[];
      }
    >();
    for (const entity of collectNodeOntologyGraph(tree, id).entities) {
      if (!declaredEntityIds.has(entity.id)) {
        continue;
      }
      const primaryKey = entity.properties?.find((property) => property.primaryKey);
      entities.set(entity.id, {
        ...(primaryKey
          ? {
              primaryKey: {
                id: primaryKey.id,
                type: primaryKey.type as OntologyValueTypeName,
              },
            }
          : {}),
        properties: new Map<string, OntologyValueTypeName>(
          (entity.properties ?? []).map((property) => [
            property.id,
            property.type as OntologyValueTypeName,
          ]),
        ),
        // `planEffect` refuses a create that leaves any required property unset,
        // and only a parameter can supply one — so an action missing that
        // parameter fails every call exactly as a missing key does.
        required: [...(treeRequired.get(entity.id) ?? [])],
      });
    }
    const relationships = new Map<string, { from: string; to: string }>();
    for (const step of path) {
      for (const relationship of step.ontology.relationships ?? []) {
        relationships.set(relationship.id, {
          from: relationship.from,
          to: relationship.to,
        });
      }
    }
    return { entities, relationships };
  });
}

/**
 * Can `invoke_action` actually run this action?
 *
 * Mirrors `planEffect` and `planLinkEffect`: every executable leaf must resolve
 * each local effect, its endpoint identity fields, and the parameters that carry
 * them. Flagging only the presence of an effect would clear the warning halfway
 * through building an action that still fails on every call.
 */
function actionIsCallable(
  effects: readonly (
    | { entity: string; kind: string }
    | { kind: "call"; tool: string }
    | { kind: "link" | "unlink"; relationship: string; from?: string; to?: string }
  )[],
  parameters: readonly { id: string; type: OntologyValueTypeName; required?: boolean }[],
  scopes: ReadonlyArray<{
    entities: ReadonlyMap<
      string,
      {
        primaryKey?: { id: string; type: OntologyValueTypeName };
        properties: ReadonlyMap<string, OntologyValueTypeName>;
        required: string[];
      }
    >;
    relationships: ReadonlyMap<string, { from: string; to: string }>;
  }>,
): boolean {
  const parameterIds = parameters.map((parameter) => parameter.id);
  const declared = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  if (declared.size !== parameterIds.length) {
    return false;
  }
  // An outward action executes as the tool call itself and governance checks its
  // parameters when the call goes out.
  if (effects.some((effect) => effect.kind === "call")) {
    return true;
  }
  const stringLike = (value: OntologyValueTypeName) =>
    value === "string" || value === "date" || value === "id";
  const compatible = (left: OntologyValueTypeName, right: OntologyValueTypeName) =>
    left === right || (stringLike(left) && stringLike(right));
  const links = effects.filter(
    (
      effect,
    ): effect is {
      kind: "link" | "unlink";
      relationship: string;
      from?: string;
      to?: string;
    } => effect.kind === "link" || effect.kind === "unlink",
  );
  const writes = effects.filter(
    (effect): effect is { entity: string; kind: string } =>
      "entity" in effect && effect.kind !== "read",
  );
  if (writes.length === 0 && links.length === 0) {
    return false;
  }
  return (
    scopes.length > 0 &&
    scopes.every((scope) => {
      const linksResolve = links.every((effect) => {
        const relationship = scope.relationships.get(effect.relationship);
        if (!relationship) {
          return false;
        }
        const fromPrimaryKey = scope.entities.get(relationship.from)?.primaryKey;
        const toPrimaryKey = scope.entities.get(relationship.to)?.primaryKey;
        const fromParameterId = effect.from ?? fromPrimaryKey?.id;
        const toParameterId = effect.to ?? toPrimaryKey?.id;
        if (relationship.from === relationship.to && fromParameterId === toParameterId) {
          return false;
        }
        return (["from", "to"] as const).every((side) => {
          const primaryKey = scope.entities.get(relationship[side])?.primaryKey;
          const parameter = primaryKey ? declared.get(effect[side] ?? primaryKey.id) : undefined;
          return Boolean(
            primaryKey &&
            primaryKey.type !== "boolean" &&
            parameter &&
            parameter.type !== "boolean",
          );
        });
      });
      const writtenEntities = writes.map((effect) => effect.entity);
      if (new Set(writtenEntities).size !== writtenEntities.length) {
        return false;
      }
      return (
        linksResolve &&
        writes.every((effect) => {
          const shape = scope.entities.get(effect.entity);
          const identityParameter = shape?.primaryKey
            ? declared.get(shape.primaryKey.id)
            : undefined;
          if (
            !shape?.primaryKey ||
            !identityParameter ||
            shape.primaryKey.type === "boolean" ||
            !compatible(identityParameter.type, shape.primaryKey.type)
          ) {
            return false;
          }
          if (
            parameters.some((parameter) => {
              const propertyType = shape.properties.get(parameter.id);
              return (
                parameter.required === true &&
                propertyType !== undefined &&
                !compatible(parameter.type, propertyType)
              );
            })
          ) {
            return false;
          }
          return (
            effect.kind !== "create" ||
            shape.required.every((id) => {
              const propertyType = shape.properties.get(id);
              const parameter = declared.get(id);
              return Boolean(propertyType && parameter && compatible(parameter.type, propertyType));
            })
          );
        })
      );
    })
  );
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
              ?disabled=${nodeMutationLocked(props)}
              @click=${() =>
                props.onOntologyDraft({
                  kind: "function",
                  nodeId: node.id,
                  id: "",
                  title: "",
                  entity: scopeEntityIds[0] ?? "",
                  expression: "",
                  returns: "number",
                  description: "",
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
              (fn, functionIndex) => html`
                <div>
                  <div class="chip-row">
                    ${renderOntologyChip(
                      `${fn.id}(${fn.entity}) → ${fn.returns}${
                        declarationIsShadowed(functions, functionIndex)
                          ? ` — ${t("enterprise.ontologyEditor.shadowedDeclaration")}`
                          : ""
                      }`,
                      t("enterprise.ontologyEditor.removeFunctionTitle", { function: fn.id }),
                      props,
                      () => props.onRemoveOntologyFunction(node.id, fn.id, functionIndex),
                      () =>
                        props.onOntologyDraft({
                          kind: "function",
                          nodeId: node.id,
                          id: fn.id,
                          title: fn.title ?? "",
                          entity: fn.entity,
                          expression: fn.expression,
                          returns: fn.returns,
                          description: fn.description ?? "",
                          metadataUpdate: {
                            kind: "function",
                            target: {
                              index: functionIndex,
                              id: fn.id,
                              entity: fn.entity,
                              expression: fn.expression,
                              returns: fn.returns,
                            },
                          },
                        }),
                    )}
                  </div>
                  ${renderOntologyMetadata([
                    {
                      label: t("enterprise.ontologyEditor.titleLabel"),
                      value: fn.title,
                    },
                    {
                      label: t("enterprise.ontologyEditor.descriptionLabel"),
                      value: fn.description,
                    },
                  ])}
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

function renderNodeOntologyConstraints(
  node: EnterpriseTreeNode,
  constraints: NonNullable<EnterpriseTreeNode["ontology"]["constraints"]>,
  draft: EnterpriseOntologyDraft | null,
  props: EnterpriseProps,
): TemplateResult | typeof nothing {
  if (!props.canEdit && constraints.length === 0) {
    return nothing;
  }
  return html`<section class="ontology-group" style="margin-top: 8px;">
    <header class="ontology-group__head">
      <span class="ontology-group__title">${t("enterprise.ontologyEditor.constraints")}</span>
      ${props.canEdit
        ? html`<button
            type="button"
            class="btn"
            ?disabled=${nodeMutationLocked(props)}
            @click=${() =>
              props.onOntologyDraft({
                kind: "constraint",
                nodeId: node.id,
                id: "",
                description: "",
              })}
          >
            ${t("enterprise.ontologyEditor.addConstraint")}
          </button>`
        : nothing}
    </header>
    <div class="ontology-group__body">
      ${constraints.length === 0
        ? html`<div class="muted">${t("enterprise.ontologyEditor.noConstraints")}</div>`
        : constraints.map(
            (constraint, constraintIndex) => html`<div>
              ${renderOntologyChip(
                constraint.id,
                t("enterprise.ontologyEditor.removeConstraintTitle", {
                  constraint: constraint.id,
                }),
                props,
                () =>
                  props.onRemoveOntologyConstraint(node.id, {
                    index: constraintIndex,
                    id: constraint.id,
                  }),
                () =>
                  props.onOntologyDraft({
                    kind: "constraint",
                    nodeId: node.id,
                    id: constraint.id,
                    description: constraint.description,
                    metadataUpdate: {
                      kind: "constraint",
                      target: { index: constraintIndex, id: constraint.id },
                      description: constraint.description,
                    },
                  }),
              )}
              ${renderOntologyMetadata([
                {
                  label: t("enterprise.ontologyEditor.descriptionLabel"),
                  value: constraint.description,
                },
              ])}
            </div>`,
          )}
      ${draft?.kind === "constraint" ? renderOntologyDraftForm(draft, [], props) : nothing}
    </div>
  </section>`;
}

/** The open ontology form. One shape per kind, one submit path. */
function renderOntologyDraftForm(
  draft: EnterpriseOntologyDraft,
  entityIds: readonly string[],
  props: EnterpriseProps,
  relationshipIds: readonly string[] = [],
  parameterIds: readonly string[] = [],
): TemplateResult {
  const immutable = props.treeSaving || Boolean(draft.metadataUpdate);
  const ownerIndex =
    draft.kind === "property"
      ? draft.entityIndex
      : draft.kind === "action-effect" ||
          draft.kind === "action-call" ||
          draft.kind === "action-link" ||
          draft.kind === "action-parameter"
        ? draft.actionIndex
        : "";
  const focusKey = `${draft.kind}:${draft.nodeId}:${ownerIndex}:${draft.metadataUpdate?.target.index ?? "new"}`;
  return html`
    <form
      class="ontology-draft-form"
      aria-label=${t("enterprise.ontologyEditor.formLabel")}
      ${ref((element) => {
        const form = element instanceof HTMLFormElement ? element : null;
        if (!form || form.dataset.focusKey === focusKey) {
          return;
        }
        form.dataset.focusKey = focusKey;
        requestAnimationFrame(() =>
          form
            .querySelector<HTMLElement>(
              "input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
            )
            ?.focus(),
        );
      })}
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        props.onSubmitOntologyDraft();
      }}
    >
      ${draft.kind === "action-effect" ||
      draft.kind === "action-call" ||
      draft.kind === "action-link"
        ? // An effect names its target and a verb; it has no id of its own.
          nothing
        : html`<label class="field">
            <span class="muted">${t(`enterprise.ontologyEditor.idLabel.${draft.kind}`)}</span>
            <input
              class="input"
              .value=${draft.id}
              ?disabled=${immutable}
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
            (type) =>
              props.onEditOntologyDraft({
                type,
                ...(draft.kind === "property" && type === "boolean" ? { primaryKey: false } : {}),
              }),
            immutable,
          )
        : nothing}
      ${draft.kind === "property"
        ? html`<label class="field">
            <input
              type="checkbox"
              .checked=${draft.primaryKey}
              ?disabled=${immutable || draft.type === "boolean"}
              @change=${(event: Event) =>
                props.onEditOntologyDraft({
                  primaryKey: (event.target as HTMLInputElement).checked,
                })}
            />
            <span class="muted">${t("enterprise.ontologyEditor.primaryKeyLabel")}</span>
          </label>`
        : nothing}
      ${draft.kind === "property" || draft.kind === "action-parameter"
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
              immutable,
            )}
            <label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.effectKindLabel")}</span>
              <select
                class="input"
                .value=${draft.effectKind}
                ?disabled=${immutable}
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
      ${draft.kind === "action-call"
        ? html`<label class="field">
            <span class="muted">${t("enterprise.ontologyEditor.callToolLabel")}</span>
            <input
              class="input"
              .value=${draft.tool}
              placeholder=${t("enterprise.ontologyEditor.callToolPlaceholder")}
              ?disabled=${immutable}
              @input=${(event: Event) =>
                props.onEditOntologyDraft({ tool: (event.target as HTMLInputElement).value })}
            />
            <span class="muted">${t("enterprise.ontologyEditor.callToolHint")}</span>
          </label>`
        : nothing}
      ${draft.kind === "action-link"
        ? html`<label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.linkRelationshipLabel")}</span>
              <select
                class="input"
                .value=${draft.relationship}
                ?disabled=${immutable}
                @change=${(event: Event) =>
                  props.onEditOntologyDraft({
                    relationship: (event.target as HTMLSelectElement).value,
                  })}
              >
                ${relationshipIds.map(
                  (id) => html`<option value=${id} ?selected=${id === draft.relationship}>
                    ${id}
                  </option>`,
                )}
              </select>
            </label>
            <label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.effectKindLabel")}</span>
              <select
                class="input"
                .value=${draft.linkKind}
                ?disabled=${immutable}
                @change=${(event: Event) =>
                  props.onEditOntologyDraft({
                    linkKind: (event.target as HTMLSelectElement).value as "link" | "unlink",
                  })}
              >
                ${(["link", "unlink"] as const).map(
                  (kind) => html`<option value=${kind} ?selected=${kind === draft.linkKind}>
                    ${kind}
                  </option>`,
                )}
              </select>
            </label>
            ${renderActionParameterSelect(
              t("enterprise.ontologyEditor.linkFromParameterLabel"),
              draft.from,
              parameterIds,
              props,
              (from) => props.onEditOntologyDraft({ from }),
            )}
            ${renderActionParameterSelect(
              t("enterprise.ontologyEditor.linkToParameterLabel"),
              draft.to,
              parameterIds,
              props,
              (to) => props.onEditOntologyDraft({ to }),
            )}`
        : nothing}
      ${draft.kind === "function"
        ? html`${renderEntitySelect(
              t("enterprise.ontologyEditor.functionEntityLabel"),
              draft.entity,
              entityIds,
              props,
              (value) => props.onEditOntologyDraft({ entity: value }),
              immutable,
            )}
            <label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.expressionLabel")}</span>
              <input
                class="input"
                .value=${draft.expression}
                ?disabled=${immutable}
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
              immutable,
            )}`
        : nothing}
      ${draft.kind === "relationship"
        ? html`${renderEntitySelect(
              t("enterprise.ontologyEditor.fromLabel"),
              draft.from,
              entityIds,
              props,
              (value) => props.onEditOntologyDraft({ from: value }),
              immutable,
            )}
            ${renderEntitySelect(
              t("enterprise.ontologyEditor.toLabel"),
              draft.to,
              entityIds,
              props,
              (value) => props.onEditOntologyDraft({ to: value }),
              immutable,
            )}
            <label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.cardinalityLabel")}</span>
              <select
                class="input"
                .value=${draft.cardinality}
                ?disabled=${immutable}
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
      ${draft.kind === "relationship"
        ? html`<label class="field">
            <span class="muted">${t("enterprise.ontologyEditor.inverseLabel")}</span>
            <input
              class="input"
              .value=${draft.inverse}
              ?disabled=${props.treeSaving}
              @input=${(event: Event) =>
                props.onEditOntologyDraft({ inverse: (event.target as HTMLInputElement).value })}
            />
          </label>`
        : nothing}
      ${draft.kind === "action"
        ? html`<label class="field">
              <span class="muted">${t("enterprise.ontologyEditor.toolsModeLabel")}</span>
              <select
                class="input"
                .value=${draft.toolsMode}
                ?disabled=${props.treeSaving}
                @change=${(event: Event) => {
                  const toolsMode = (event.target as HTMLSelectElement).value as
                    | "all"
                    | "selected"
                    | "none";
                  props.onEditOntologyDraft({
                    toolsMode,
                    ...(toolsMode === "selected" && draft.tools.length === 0
                      ? { tools: [""] }
                      : {}),
                  });
                }}
              >
                ${(["all", "selected", "none"] as const).map(
                  (mode) => html`<option value=${mode} ?selected=${mode === draft.toolsMode}>
                    ${t(`enterprise.ontologyEditor.toolsMode.${mode}`)}
                  </option>`,
                )}
              </select>
              <span class="muted">${t("enterprise.ontologyEditor.toolsModeHint")}</span>
            </label>
            ${draft.toolsMode === "selected"
              ? renderOntologyTextList(
                  t("enterprise.ontologyEditor.toolsLabel"),
                  draft.tools,
                  props,
                  (tools) => props.onEditOntologyDraft({ tools }),
                )
              : nothing}
            ${renderOntologyTextList(
              t("enterprise.ontologyEditor.preconditionsLabel"),
              draft.preconditions,
              props,
              (preconditions) => props.onEditOntologyDraft({ preconditions }),
            )}`
        : nothing}
      <label class="field">
        <span class="muted">${t("enterprise.ontologyEditor.descriptionLabel")}</span>
        <textarea
          class="input"
          .value=${draft.description}
          ?disabled=${props.treeSaving}
          @input=${(event: Event) =>
            props.onEditOntologyDraft({
              description: (event.target as HTMLTextAreaElement).value,
            })}
        ></textarea>
      </label>
      ${draft.error
        ? html`<div class="callout" role="alert">
            ${t(`enterprise.ontologyEditor.error.${draft.error}`)}
          </div>`
        : nothing}
      <div class="row" style="margin-top: 6px; gap: 8px;">
        <button type="submit" class="btn" ?disabled=${props.treeSaving}>
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
    </form>
  `;
}

/** The value-type picker, shared by a field, an action parameter, and a function's return. */
function renderValueTypeSelect(
  label: string,
  value: OntologyValueTypeName,
  props: EnterpriseProps,
  onChange: (value: OntologyValueTypeName) => void,
  disabled = false,
): TemplateResult {
  return html`<label class="field">
    <span class="muted">${label}</span>
    <select
      class="input"
      .value=${value}
      ?disabled=${props.treeSaving || disabled}
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
  disabled = false,
): TemplateResult {
  return html`<label class="field">
    <span class="muted">${label}</span>
    <select
      class="input"
      .value=${value}
      ?disabled=${props.treeSaving || disabled}
      @change=${(event: Event) => onChange((event.target as HTMLSelectElement).value)}
    >
      ${entityIds.map((id) => html`<option value=${id} ?selected=${id === value}>${id}</option>`)}
    </select>
  </label>`;
}

function renderActionParameterSelect(
  label: string,
  value: string,
  parameterIds: readonly string[],
  props: EnterpriseProps,
  onChange: (value: string) => void,
): TemplateResult {
  const unavailable = value !== "" && !parameterIds.includes(value);
  return html`<label class="field">
    <span class="muted">${label}</span>
    <select
      class="input"
      .value=${value}
      ?disabled=${props.treeSaving}
      @change=${(event: Event) => onChange((event.target as HTMLSelectElement).value)}
    >
      ${unavailable
        ? html`<option value=${value} selected>
            ${t("enterprise.ontologyEditor.unavailableParameter", { parameter: value })}
          </option>`
        : nothing}
      <option value="" ?selected=${value === ""}>
        ${t("enterprise.ontologyEditor.defaultIdentity")}
      </option>
      ${parameterIds.map(
        (id) => html`<option value=${id} ?selected=${id === value}>${id}</option>`,
      )}
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
  usable: EnterpriseKnowledgeFoundationSummary[];
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
  // Both shapes, because the two questions differ: the picker needs each entry's
  // summary to be choosable among several stores, the detail card only needs
  // membership.
  return { usable, ids: new Set(usable.map((foundation) => foundation.id)), ownershipKnown };
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
  return html`<div class="callout danger" role="alert" style="margin-top: 8px;">
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
  };
  return messages[error];
}

/**
 * The "add child node" affordance under the selected node: a button that opens an
 * inline form. Submitting splices the child and saves through the same whole-tree
 * import path as every other visual edit. Admin-only (the caller gates on canEdit).
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
        ?disabled=${nodeMutationLocked(props)}
        @click=${() => props.onBeginAddNode(nodeId)}
      >
        ${t("enterprise.addNodeButton")}
      </button>
    `;
  }
  const fieldStyle =
    "width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text);";
  const invalidField = draft.error?.startsWith("id-")
    ? "id"
    : draft.error === "title-empty"
      ? "title"
      : null;
  const errorId = "enterprise-add-node-error";
  return html`
    <form
      class="card-nested"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        props.onSubmitAddNode();
        requestAnimationFrame(() =>
          form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        );
      }}
    >
      <div class="card-sub">${t("enterprise.addNodeTitle")}</div>
      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 8px;">
        <label style="display: flex; flex-direction: column; gap: 4px;">
          <span class="muted">${t("enterprise.addNodeIdLabel")}</span>
          <input
            style=${fieldStyle}
            .value=${draft.id}
            placeholder=${`${nodeId}.step`}
            autofocus
            ?disabled=${props.treeSaving}
            aria-invalid=${invalidField === "id" ? "true" : nothing}
            aria-describedby=${invalidField === "id" ? errorId : nothing}
            @input=${(event: Event) =>
              props.onEditNodeDraft({ id: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label style="display: flex; flex-direction: column; gap: 4px;">
          <span class="muted">${t("enterprise.addNodeTitleLabel")}</span>
          <input
            style=${fieldStyle}
            .value=${draft.title}
            ?disabled=${props.treeSaving}
            aria-invalid=${invalidField === "title" ? "true" : nothing}
            aria-describedby=${invalidField === "title" ? errorId : nothing}
            @input=${(event: Event) =>
              props.onEditNodeDraft({ title: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label style="display: flex; flex-direction: column; gap: 4px;">
          <span class="muted">${t("enterprise.addNodeDescriptionLabel")}</span>
          <textarea
            style=${fieldStyle}
            .value=${draft.description}
            ?disabled=${props.treeSaving}
            @input=${(event: Event) =>
              props.onEditNodeDraft({
                description: (event.target as HTMLTextAreaElement).value,
              })}
          ></textarea>
        </label>
        ${draft.error
          ? html`<div id=${errorId} class="callout danger" role="alert">
              ${nodeDraftErrorMessage(draft.error)}
            </div>`
          : nothing}
        <div class="row" style="gap: 8px;">
          <button type="submit" class="btn primary" ?disabled=${props.treeSaving}>
            ${props.treeSaving ? t("common.saving") : t("enterprise.addNodeSubmit")}
          </button>
          <button
            type="button"
            class="btn"
            ?disabled=${props.treeSaving}
            @click=${props.onCancelAddNode}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </form>
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
      : props.nodeObjectsError
        ? html`<div class="callout danger" role="alert" style="margin-top: 8px;">
            ${props.nodeObjectsError}
          </div>`
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
