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
  EnterpriseTreesListResult,
  EnterpriseTreeSummary,
  EnterpriseTreeVersionSummary,
  ToolsCatalogResult,
} from "../../../../packages/gateway-protocol/src/index.js";
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
  EnterpriseOntologyEntryDraft,
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
  // form on the selected step, or null. Submit splices the entry into that step
  // and loads the editor for Save.
  ontologyEntryDraft: EnterpriseOntologyEntryDraft | null;
  onBeginAddOntologyEntry: (nodeId: string, field: NodeOntologyListField) => void;
  onEditOntologyEntryDraft: (value: string) => void;
  onCancelAddOntologyEntry: () => void;
  onSubmitAddOntologyEntry: () => void;
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

/** One step-binding row: the field's current values plus the add affordance. */
type OntologyEntryAdder = {
  /** The step being bound. Callers render this inside that node's inspector. */
  nodeId: string;
  field: NodeOntologyListField;
  values: readonly string[];
  /** Row heading, e.g. "Tools — ontology.allowedTools". */
  title: string;
  /** Accessible name for the text input; the placeholder is only an example value. */
  inputLabel: string;
  placeholder: string;
  /** Catalog ids offered as completions. Free text stays valid (tool globs/groups). */
  suggestions: readonly string[];
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
function renderOntologyEntryAdder(
  props: EnterpriseProps,
  adder: OntologyEntryAdder,
): TemplateResult {
  const { field, nodeId } = adder;
  // Match on treeId too: a different tree can hold a node with the same id, and a
  // draft carries its own tree, so an id-only match would show a stale form.
  const draft =
    props.ontologyEntryDraft?.treeId === props.treeDetail?.id &&
    props.ontologyEntryDraft?.nodeId === nodeId &&
    props.ontologyEntryDraft.field === field
      ? props.ontologyEntryDraft
      : null;
  const suggestionsId = `enterprise-suggest-${field}`;
  return html`
    <div style="margin-top: 12px;">
      <div class="muted">${adder.title}</div>
      <div class="list" style="margin-top: 8px;">
        ${adder.values.length === 0
          ? html`<div class="list-item muted">${t("enterprise.entryDraft.none")}</div>`
          : adder.values.map((value) => {
              const note = adder.valueNote?.(value) ?? null;
              return html`<div class="list-item">
                <code>${value}</code>
                ${note ? html`<span class="chip chip-warn">${note}</span>` : nothing}
              </div>`;
            })}
      </div>
      ${adder.scopeWarning
        ? html`<div class="callout" style="margin-top: 8px;">${adder.scopeWarning}</div>`
        : nothing}
      ${adder.constrainingAncestors?.length
        ? html`<div class="callout" style="margin-top: 8px;">
            ${t("enterprise.entryDraft.ancestorGate", {
              nodeIds: adder.constrainingAncestors.join(", "),
            })}
          </div>`
        : nothing}
      ${props.canEdit
        ? draft
          ? html`
              <div class="row" style="gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                <input
                  type="text"
                  .value=${draft.value}
                  aria-label=${adder.inputLabel}
                  placeholder=${adder.placeholder}
                  list=${suggestionsId}
                  @input=${(event: Event) =>
                    props.onEditOntologyEntryDraft((event.target as HTMLInputElement).value)}
                />
                <datalist id=${suggestionsId}>
                  ${adder.suggestions.map(
                    (suggestion) => html`<option value=${suggestion}></option>`,
                  )}
                </datalist>
                <button type="button" class="btn primary" @click=${props.onSubmitAddOntologyEntry}>
                  ${t("enterprise.entryDraft.add")}
                </button>
                <button type="button" class="btn" @click=${props.onCancelAddOntologyEntry}>
                  ${t("common.cancel")}
                </button>
              </div>
              ${draft.error
                ? html`<div class="callout danger" style="margin-top: 8px;">
                    ${ontologyEntryErrorMessage(draft.error)}
                  </div>`
                : nothing}
              <div class="muted" style="margin-top: 8px;">
                ${t("enterprise.entryDraft.reviewHint")}
              </div>
            `
          : html`<button
              type="button"
              class="btn"
              style="margin-top: 8px;"
              @click=${() => props.onBeginAddOntologyEntry(nodeId, field)}
            >
              ${t("enterprise.entryDraft.add")}
            </button>`
        : nothing}
    </div>
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
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("enterprise.toolsTab.title")}</div>
      <div class="card-sub">${t("enterprise.toolsTab.subtitle")}</div>
      ${renderCatalogAgentScope(props.catalogAgentId)}
      <div class="muted" style="margin-top: 8px;">${t("enterprise.toolsTab.attachHint")}</div>
      ${props.toolGroups.length === 0
        ? renderCatalogEmpty(
            props.catalogPhase,
            props.catalogErrors.tools,
            t("enterprise.toolsTab.empty"),
          )
        : html`<div class="list" style="margin-top: 12px;">
            ${props.toolGroups.map((group) => renderToolCatalogGroup(group))}
          </div>`}
    </section>
  `;
}

function renderToolCatalogGroup(group: ToolsCatalogResult["groups"][number]): TemplateResult {
  return html`
    <details class="list-item">
      <summary style="cursor: pointer;">
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
      </summary>
      <div class="list" style="margin-top: 8px;">
        ${group.tools.map(
          (tool) => html`<div class="list-item">
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
            </div>
          </div>`,
        )}
      </div>
    </details>
  `;
}

/**
 * Every installed skill. Like Tools this is the catalog, not a step's
 * declaration: a step names the skills its work depends on from Worktree.
 */
function renderEnterpriseSkills(props: EnterpriseProps): TemplateResult {
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("enterprise.skillsTab.title")}</div>
      <div class="card-sub">${t("enterprise.skillsTab.subtitle")}</div>
      ${renderCatalogAgentScope(props.catalogAgentId)}
      <div class="muted" style="margin-top: 8px;">${t("enterprise.skillsTab.attachHint")}</div>
      ${props.skills.length === 0
        ? renderCatalogEmpty(
            props.catalogPhase,
            props.catalogErrors.skills,
            t("enterprise.skillsTab.empty"),
          )
        : html`<div class="list" style="margin-top: 12px;">
            ${props.skills.map(
              (skill) => html`<div class="list-item">
                <div class="list-main">
                  <div class="list-title"><code>${skill.name}</code></div>
                  ${skill.description
                    ? html`<div class="list-sub">${skill.description}</div>`
                    : nothing}
                  ${renderSkillStatusChips({ skill, showBundledBadge: skill.bundled === true })}
                </div>
              </div>`,
            )}
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
      ${renderNodeBindings(node, props)}
      ${props.canEdit ? renderAddNode(tree.id, nodeId, props) : nothing}
    </section>
  `;
}

/**
 * What this step is bound to: its tool scope, the skills it declares, and the
 * knowledge foundations it may query. Read-only without operator.admin; with it,
 * each row can add an entry, which splices into the tree definition and opens the
 * editor for review + Save (the single enterprise.trees.import write path).
 */
function renderNodeBindings(
  node: EnterpriseTreeDetail["nodes"][number],
  props: EnterpriseProps,
): TemplateResult {
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
  const catalogAgentId = props.catalogAgentId;
  return html`
    <div class="card-title" style="margin-top: 16px;">${t("enterprise.bindings.title")}</div>
    <div class="muted" style="margin-top: 4px;">${t("enterprise.bindings.subtitle")}</div>
    ${renderCatalogAgentScope(catalogAgentId)}${renderBindingCatalogIssues(props)}
    ${renderOntologyEntryAdder(props, {
      nodeId: node.id,
      field: "allowedTools",
      values: allowedTools,
      title: t("enterprise.bindings.tools"),
      inputLabel: t("enterprise.entryDraft.toolLabel"),
      placeholder: "group:enterprise",
      suggestions: toolSuggestions(props),
      // No LOCAL allowlist means the step allows everything (minus its denials),
      // so the first entry narrows it either way — a deny-only step converts too.
      scopeWarning: allowedTools.length === 0 ? t("enterprise.entryDraft.scopeNarrowing") : null,
      constrainingAncestors: constrainingAncestorIds(props, node.id, "allowedTools"),
    })}
    ${renderOntologyEntryAdder(props, {
      nodeId: node.id,
      field: "skills",
      values: ontology.skills ?? [],
      title: t("enterprise.bindings.skills"),
      inputLabel: t("enterprise.entryDraft.skillLabel"),
      placeholder: "refund-policy",
      suggestions: props.skills.map((skill) => skill.name),
      // A declared skill is an annotation, so naming one no install provides is
      // legal — but the operator has to see which declarations resolve today.
      // Named per agent: the skill set is agent-scoped, and a tree can govern a
      // different agent than the one this catalog answered for.
      valueNote: (value) =>
        skillsKnown && !installedSkills.has(value)
          ? t("enterprise.bindings.skillNotInstalled")
          : null,
    })}
    ${renderOntologyEntryAdder(props, {
      nodeId: node.id,
      field: "knowledgeFoundations",
      values: foundations,
      title: t("enterprise.bindings.knowledge"),
      inputLabel: t("enterprise.entryDraft.knowledgeLabel"),
      placeholder: "acme.runbooks",
      suggestions: [...retrievableIds],
      // Same path-gate shape as tools: an omitted list lets the step query every
      // registered foundation, so the first entry restricts it.
      scopeWarning: foundations.length === 0 ? t("enterprise.entryDraft.knowledgeNarrowing") : null,
      constrainingAncestors: constrainingAncestorIds(props, node.id, "knowledgeFoundations"),
      valueNote: (value) =>
        foundationsKnown && !retrievableIds.has(value)
          ? t("enterprise.bindings.foundationNotRegistered")
          : null,
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
 * Completions for a tool grant: every catalog tool id, plus the `group:` selector
 * of each core section. Plugin groups have no selector (CORE_TOOL_GROUPS is built
 * from core sections only), so offering one would suggest an entry that matches
 * nothing.
 */
function toolSuggestions(props: EnterpriseProps): string[] {
  const suggestions: string[] = [];
  for (const group of props.toolGroups) {
    if (group.source === "core") {
      suggestions.push(`group:${group.id}`);
    }
    for (const tool of group.tools) {
      suggestions.push(tool.id);
    }
  }
  return suggestions;
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
