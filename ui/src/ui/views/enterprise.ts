// Control UI view renders the enterprise inspection screen: recent governed
// runs, a per-execution step/trace inspector, and the workflow-tree registry.
import { html, nothing, type TemplateResult } from "lit";
import type {
  EnterpriseRunDetail,
  EnterpriseRunSummary,
  EnterpriseTreeDetail,
  EnterpriseTreeImportIssue,
  EnterpriseTreesListResult,
  EnterpriseTreeSummary,
  EnterpriseTreeVersionSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import type { OntologyEntity, OntologyRelationship } from "../components/ontology-graph.ts";
import "../components/modal-dialog.ts";
import "../components/ontology-graph.ts";
import "../components/workflow-tree-graph.ts";
import type { EnterpriseTreeConfirm, EnterpriseTreeEditFormat } from "../controllers/enterprise.ts";

export type EnterpriseProps = {
  loading: boolean;
  runs: EnterpriseRunSummary[];
  trees: EnterpriseTreeSummary[];
  importErrors: EnterpriseTreesListResult["importErrors"];
  storeError: string | null;
  selectedExecutionId: string | null;
  detail: EnterpriseRunDetail | null;
  detailLoading: boolean;
  selectedTreeId: string | null;
  treeDetail: EnterpriseTreeDetail | null;
  treeLoading: boolean;
  treeIssue: string | null;
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
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function renderEnterprise(props: EnterpriseProps) {
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

    <section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("enterprise.runsTitle")}</div>
      <div class="list" style="margin-top: 12px;">
        ${props.runs.length === 0
          ? html`<div class="muted">${t("enterprise.noRuns")}</div>`
          : props.runs.map((run) => renderRun(run, props.selectedExecutionId, props.onSelectRun))}
      </div>
    </section>

    ${renderDetailCard(props)}

    <section class="card" style="margin-top: 16px;">
      <div class="row" style="justify-content: space-between;">
        <div class="card-title">${t("enterprise.treesTitle")}</div>
        ${props.canEdit
          ? html`<button class="btn" @click=${props.onBeginNew}>${t("enterprise.newTree")}</button>`
          : nothing}
      </div>
      <div class="list" style="margin-top: 12px;">
        ${props.trees.length === 0
          ? html`<div class="muted">${t("enterprise.noTrees")}</div>`
          : props.trees.map((tree) => renderTree(tree, props.selectedTreeId, props.onSelectTree))}
      </div>
    </section>

    ${renderTreeVisualization(props)} ${renderTreeConfirmModal(props)}
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
        ? renderTreeDetail(tree)
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

function renderTreeDetail(tree: EnterpriseTreeDetail): TemplateResult {
  const { entities, relationships } = collectOntologyGraph(tree);
  return html`
    <div class="card-sub">${tree.name} — ${tree.id}@${tree.version}</div>
    ${tree.description
      ? html`<div class="muted" style="margin-top: 4px;">${tree.description}</div>`
      : nothing}

    <div class="card-title" style="margin-top: 16px;">${t("enterprise.structureTitle")}</div>
    <openclaw-workflow-tree-graph .nodes=${tree.nodes}></openclaw-workflow-tree-graph>

    <div class="card-title" style="margin-top: 16px;">${t("enterprise.ontologyTitle")}</div>
    ${entities.length === 0
      ? html`<div class="muted" style="margin-top: 8px;">${t("enterprise.noOntology")}</div>`
      : html`<openclaw-ontology-graph
          .entities=${entities}
          .relationships=${relationships}
        ></openclaw-ontology-graph>`}
  `;
}

/**
 * Union every node's entities + relationships into one graph model. Parent and
 * child nodes often re-declare the same relationship, so edges dedupe by
 * endpoints+id; otherwise the graph would stack identical arcs.
 */
function collectOntologyGraph(tree: EnterpriseTreeDetail): {
  entities: OntologyEntity[];
  relationships: OntologyRelationship[];
} {
  const descriptions = new Map<string, string | undefined>();
  const relationshipByKey = new Map<string, OntologyRelationship>();
  for (const node of tree.nodes) {
    for (const entity of node.ontology.entities ?? []) {
      // First non-empty description wins. A `has()` check would treat an entity
      // first declared without a description as already described, dropping a
      // richer re-declaration on a deeper step.
      descriptions.set(entity.id, descriptions.get(entity.id) ?? entity.description);
    }
    for (const relationship of node.ontology.relationships ?? []) {
      const key = JSON.stringify([relationship.from, relationship.to, relationship.id]);
      if (!relationshipByKey.has(key)) {
        relationshipByKey.set(key, relationship);
      }
    }
  }
  const relationships = [...relationshipByKey.values()];
  // Relationship endpoints must exist as nodes even if never declared as entities.
  for (const relationship of relationships) {
    if (!descriptions.has(relationship.from)) {
      descriptions.set(relationship.from, undefined);
    }
    if (!descriptions.has(relationship.to)) {
      descriptions.set(relationship.to, undefined);
    }
  }
  const entities = [...descriptions.entries()].map(([id, description]) => ({ id, description }));
  return { entities, relationships };
}
