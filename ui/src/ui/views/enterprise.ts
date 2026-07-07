// Control UI view renders the enterprise inspection screen: recent governed
// runs, a per-execution step/trace inspector, and the workflow-tree registry.
import { html, nothing, svg, type TemplateResult } from "lit";
import type {
  EnterpriseRunDetail,
  EnterpriseRunSummary,
  EnterpriseTreeDetail,
  EnterpriseTreesListResult,
  EnterpriseTreeSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";

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
  error: string | null;
  onRefresh: () => void;
  onSelectRun: (executionId: string) => void;
  onSelectTree: (treeId: string) => void;
};

type TreeNode = EnterpriseTreeDetail["nodes"][number];

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
              (issue) => html`<div class="muted">${issue.treeId}: ${issue.message}</div>`,
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
      <div class="card-title">${t("enterprise.treesTitle")}</div>
      <div class="list" style="margin-top: 12px;">
        ${props.trees.length === 0
          ? html`<div class="muted">${t("enterprise.noTrees")}</div>`
          : props.trees.map((tree) => renderTree(tree, props.selectedTreeId, props.onSelectTree))}
      </div>
    </section>

    ${renderTreeVisualization(props)}
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
      <div class="card-title">${t("enterprise.treeTitle")}</div>
      ${props.treeIssue
        ? html`<div class="callout danger" style="margin-top: 8px;">${props.treeIssue}</div>`
        : nothing}
      ${!tree
        ? html`<div class="muted" style="margin-top: 8px;">
            ${props.treeLoading ? t("common.loading") : t("enterprise.treeUnavailable")}
          </div>`
        : renderTreeDetail(tree)}
    </section>
  `;
}

function renderTreeDetail(tree: EnterpriseTreeDetail): TemplateResult {
  return html`
    <div class="card-sub">${tree.name} — ${tree.id}@${tree.version}</div>
    ${tree.description
      ? html`<div class="muted" style="margin-top: 4px;">${tree.description}</div>`
      : nothing}

    <div class="card-title" style="margin-top: 16px;">${t("enterprise.structureTitle")}</div>
    <div class="list" style="margin-top: 8px;">
      ${tree.nodes.map((node) => renderTreeStructureNode(node))}
    </div>

    <div class="card-title" style="margin-top: 16px;">${t("enterprise.ontologyTitle")}</div>
    ${renderOntologyGraph(tree)}
  `;
}

/** One node in the tree structure, indented by depth to show the hierarchy. */
function renderTreeStructureNode(node: TreeNode): TemplateResult {
  const ontology = node.ontology;
  const chips: TemplateResult[] = [];
  if (ontology.allowedTools?.length) {
    chips.push(
      html`<span class="chip"
        >${t("enterprise.allowedTools", { tools: ontology.allowedTools.join(", ") })}</span
      >`,
    );
  }
  if (ontology.deniedTools?.length) {
    chips.push(
      html`<span class="chip"
        >${t("enterprise.deniedTools", { tools: ontology.deniedTools.join(", ") })}</span
      >`,
    );
  }
  if (ontology.knowledgeFoundations?.length) {
    chips.push(
      html`<span class="chip"
        >${t("enterprise.knowledge", { ids: ontology.knowledgeFoundations.join(", ") })}</span
      >`,
    );
  }
  for (const action of ontology.actions ?? []) {
    chips.push(html`<span class="chip">${t("enterprise.action", { id: action.id })}</span>`);
  }
  if (ontology.audit) {
    chips.push(html`<span class="chip">${t("enterprise.audit")}</span>`);
  }
  return html`
    <div class="list-item" style="padding-left: ${8 + node.depth * 20}px;">
      <div class="list-main">
        <div class="list-title">
          ${node.depth > 0 ? html`<span class="muted">${"└ "}</span>` : nothing}${node.title}
        </div>
        ${node.description ? html`<div class="list-sub">${node.description}</div>` : nothing}
        ${chips.length ? html`<div class="chip-row">${chips}</div>` : nothing}
        ${(ontology.constraints ?? []).map(
          (constraint) =>
            html`<div class="muted" style="font-size: 12px;">
              ${t("enterprise.constraint", { text: constraint.description })}
            </div>`,
        )}
      </div>
      <div class="list-meta"><div class="muted">${node.id}</div></div>
    </div>
  `;
}

type OntologyEntity = { id: string; description?: string };
type OntologyRelationship = { id: string; from: string; to: string; description?: string };

/** Union all nodes' entities + relationships into one ontology graph model. */
function collectOntologyGraph(tree: EnterpriseTreeDetail): {
  entities: OntologyEntity[];
  relationships: OntologyRelationship[];
} {
  const descriptions = new Map<string, string | undefined>();
  // Dedupe edges by endpoints+id: parent and child nodes often re-declare the
  // same relationship, which would otherwise stack identical arcs.
  const relationshipByKey = new Map<string, OntologyRelationship>();
  for (const node of tree.nodes) {
    for (const entity of node.ontology.entities ?? []) {
      if (!descriptions.has(entity.id)) {
        descriptions.set(entity.id, entity.description);
      }
    }
    for (const relationship of node.ontology.relationships ?? []) {
      const key = JSON.stringify([relationship.from, relationship.to, relationship.id]);
      if (!relationshipByKey.has(key)) {
        relationshipByKey.set(key, relationship);
      }
    }
  }
  const relationships = [...relationshipByKey.values()];
  // Relationship endpoints must exist as boxes even if never declared.
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

const ENTITY_BOX_WIDTH = 132;
const ENTITY_BOX_HEIGHT = 40;
const ENTITY_GAP_X = 32;
const GRAPH_TOP = 72;
const GRAPH_BOTTOM = 16;

function renderOntologyGraph(tree: EnterpriseTreeDetail): TemplateResult {
  const { entities, relationships } = collectOntologyGraph(tree);
  if (entities.length === 0) {
    return html`<div class="muted" style="margin-top: 8px;">${t("enterprise.noOntology")}</div>`;
  }
  const index = new Map(entities.map((entity, i) => [entity.id, i]));
  const step = ENTITY_BOX_WIDTH + ENTITY_GAP_X;
  const boxCenter = (i: number) => i * step + ENTITY_BOX_WIDTH / 2;
  const width = entities.length * step - ENTITY_GAP_X;
  const height = GRAPH_TOP + ENTITY_BOX_HEIGHT + GRAPH_BOTTOM;

  const boxes = entities.map((entity, i) => {
    const x = i * step;
    return svg`
      <rect
        x=${x}
        y=${GRAPH_TOP}
        width=${ENTITY_BOX_WIDTH}
        height=${ENTITY_BOX_HEIGHT}
        rx="6"
        fill="var(--surface-2, rgba(127,127,127,0.12))"
        stroke="var(--border, rgba(127,127,127,0.5))"
      />
      <text
        x=${x + ENTITY_BOX_WIDTH / 2}
        y=${GRAPH_TOP + ENTITY_BOX_HEIGHT / 2 + 4}
        text-anchor="middle"
        font-size="12"
        fill="currentColor"
      >${entity.id}</text>
    `;
  });

  const arcs = relationships.flatMap((relationship) => {
    const from = index.get(relationship.from);
    const to = index.get(relationship.to);
    if (from === undefined || to === undefined || from === to) {
      return [];
    }
    const x1 = boxCenter(from);
    const x2 = boxCenter(to);
    const midX = (x1 + x2) / 2;
    const ctrlY = GRAPH_TOP - Math.min(56, 20 + Math.abs(to - from) * 12);
    return [
      svg`
        <path
          d="M ${x1} ${GRAPH_TOP} Q ${midX} ${ctrlY} ${x2} ${GRAPH_TOP}"
          fill="none"
          stroke="var(--accent, #6a5acd)"
          stroke-width="1.5"
          marker-end="url(#clawworks-onto-arrow)"
        />
        <text x=${midX} y=${ctrlY - 3} text-anchor="middle" font-size="10" fill="var(--muted, #888)">
          ${relationship.id}
        </text>
      `,
    ];
  });

  return html`
    <div style="overflow-x: auto; margin-top: 8px;">
      <svg
        width=${width}
        height=${height}
        style="display: block; min-width: ${width}px;"
        role="img"
      >
        <defs>
          <marker
            id="clawworks-onto-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent, #6a5acd)" />
          </marker>
        </defs>
        ${arcs} ${boxes}
      </svg>
    </div>
    ${entities.some((entity) => entity.description)
      ? html`<div class="list" style="margin-top: 8px;">
          ${entities
            .filter((entity) => entity.description)
            .map(
              (entity) => html`<div class="muted" style="font-size: 12px;">
                <strong>${entity.id}</strong>: ${entity.description}
              </div>`,
            )}
        </div>`
      : nothing}
  `;
}
