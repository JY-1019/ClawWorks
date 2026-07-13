// Control UI component: an Obsidian/Neo4j-style force-directed ontology graph.
//
// The layout is a deterministic seeded simulation (no Math.random): entities are
// placed on a ring by index and relaxed by the same force loop every time, so the
// same tree always settles into the same picture. That keeps screenshots, visual
// review, and any future snapshot test stable — a randomized layout would redraw
// differently on every load.
import { css, html, LitElement, nothing, svg, type TemplateResult } from "lit";
import { property, query, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";

export type OntologyProperty = {
  id: string;
  type: string;
  primaryKey?: boolean;
  required?: boolean;
  description?: string;
};

export type OntologyEntity = {
  id: string;
  title?: string;
  description?: string;
  properties?: OntologyProperty[];
};

export type OntologyRelationship = {
  id: string;
  from: string;
  to: string;
  cardinality?: string;
  inverse?: string;
  description?: string;
};

type SimNode = {
  id: string;
  title?: string;
  description?: string;
  properties?: OntologyProperty[];
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Dragged nodes stop being integrated so the pointer stays authoritative. */
  pinned: boolean;
};

// Tuned for the size an ontology actually declares (tens of entities, not
// thousands), which is why the O(n^2) repulsion pass below is fine.
const REPULSION = 5600;
const SPRING_LENGTH = 128;
const SPRING_STRENGTH = 0.035;
const CENTER_PULL = 0.012;
const DAMPING = 0.82;
const ALPHA_DECAY = 0.988;
const ALPHA_MIN = 0.004;
const REHEAT_ALPHA = 0.7;
const DRAG_ALPHA_FLOOR = 0.3;
const MAX_STEP = 12;

const MIN_RADIUS = 12;
const MAX_RADIUS = 28;
const VIEW_HEIGHT = 460;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
const LABEL_MAX = 20;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class OpenClawOntologyGraph extends LitElement {
  @property({ attribute: false }) entities: OntologyEntity[] = [];
  @property({ attribute: false }) relationships: OntologyRelationship[] = [];

  @state() private hoveredId: string | null = null;
  @state() private selectedId: string | null = null;
  @state() private zoom = 1;
  @state() private panX = 0;
  @state() private panY = 0;
  /** Bumped every simulation tick to re-render the settled positions. */
  @state() private frame = 0;

  @query("svg") private svgElement?: SVGSVGElement;

  private nodes: SimNode[] = [];
  private nodeById = new Map<string, SimNode>();
  /** Content signature of the last built graph; see willUpdate. */
  private graphKey = "";
  private width = 720;
  private alpha = 1;
  private rafHandle: number | null = null;
  private resizeObserver?: ResizeObserver;
  private draggingId: string | null = null;
  private panning = false;
  private pointerOrigin = { x: 0, y: 0, panX: 0, panY: 0 };

  static override styles = css`
    :host {
      display: block;
    }

    .graph-shell {
      position: relative;
      margin-top: 8px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-accent, var(--card));
      overflow: hidden;
    }

    svg {
      display: block;
      width: 100%;
      height: ${VIEW_HEIGHT}px;
      touch-action: none;
      cursor: grab;
    }

    svg.panning {
      cursor: grabbing;
    }

    .node-hit {
      cursor: pointer;
    }

    .label {
      font-size: 11px;
      fill: var(--muted);
      pointer-events: none;
      user-select: none;
    }

    .label.active {
      fill: var(--text-strong);
    }

    .edge-label {
      font-size: 10px;
      fill: var(--muted);
      pointer-events: none;
      user-select: none;
    }

    /* Always reachable: a user who pans every entity off-canvas needs a way back,
       so this cannot live inside the selection-gated inspector. */
    .reset-view {
      position: absolute;
      top: 8px;
      right: 10px;
      padding: 3px 10px;
      font: inherit;
      font-size: 11px;
      color: var(--text);
      background: var(--card);
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      cursor: pointer;
    }

    .reset-view:hover {
      border-color: var(--border-hover);
    }

    .hint {
      position: absolute;
      right: 10px;
      bottom: 8px;
      font-size: 11px;
      color: var(--muted);
      pointer-events: none;
    }

    .inspector {
      margin-top: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-accent, var(--card));
    }

    .inspector-title {
      font-weight: 600;
      color: var(--text-strong);
    }

    .inspector-sub {
      margin-top: 2px;
      font-size: 12px;
      color: var(--muted);
    }

    .inspector-row {
      margin-top: 6px;
      font-size: 12px;
      color: var(--text);
    }

    .inspector-row .rel {
      color: var(--accent-2, var(--accent));
    }

    .card {
      margin-left: 6px;
      padding: 0 5px;
      font-size: 10px;
      color: var(--muted);
      border: 1px solid var(--border-strong);
      border-radius: 4px;
    }

    .props {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .prop {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 7px;
      font-size: 11px;
      border: 1px solid var(--border);
      border-radius: 6px;
    }

    .prop-name {
      color: var(--text);
    }

    .prop-type {
      color: var(--muted);
    }

    .pk {
      color: var(--accent);
      font-weight: 600;
    }

    .req {
      color: var(--warn);
    }

    .empty {
      margin-top: 8px;
      color: var(--muted);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && Math.abs(next - this.width) > 1) {
        this.width = next;
        this.requestUpdate();
      }
    });
    this.resizeObserver.observe(this);
  }

  override disconnectedCallback() {
    this.stopSimulation();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("entities") && !changed.has("relationships")) {
      return;
    }
    // Rebuild on graph *content*, not array identity. The view derives these
    // arrays inside its render, so a fresh array arrives on every unrelated app
    // re-render; re-seeding on identity would snap the operator's dragged layout
    // back to the ring (and re-target an in-flight drag) on every keystroke.
    // The key must cover every field the graph or its inspector renders, not
    // just the topology: an edited tree that only changes a title, a property
    // type, or a cardinality has the same nodes and edges, and hashing topology
    // alone would skip the rebuild and leave the inspector showing stale fields.
    const key = JSON.stringify([
      this.entities.map((entity) => [
        entity.id,
        entity.title ?? "",
        entity.description ?? "",
        (entity.properties ?? []).map((field) => [
          field.id,
          field.type,
          field.primaryKey ?? false,
          field.required ?? false,
        ]),
      ]),
      this.relationships.map((relationship) => [
        relationship.id,
        relationship.from,
        relationship.to,
        relationship.cardinality ?? "",
        relationship.inverse ?? "",
      ]),
    ]);
    if (key === this.graphKey) {
      return;
    }
    this.graphKey = key;
    this.buildGraph();
  }

  /** Seed positions on a ring by index: deterministic, and never coincident. */
  private buildGraph() {
    const degree = new Map<string, number>();
    for (const relationship of this.relationships) {
      degree.set(relationship.from, (degree.get(relationship.from) ?? 0) + 1);
      degree.set(relationship.to, (degree.get(relationship.to) ?? 0) + 1);
    }
    const count = Math.max(this.entities.length, 1);
    const seedRadius = Math.min(180, 60 + count * 14);
    this.nodes = this.entities.map((entity, index) => {
      const angle = (index / count) * Math.PI * 2;
      return {
        id: entity.id,
        title: entity.title,
        description: entity.description,
        properties: entity.properties,
        degree: degree.get(entity.id) ?? 0,
        x: Math.cos(angle) * seedRadius,
        y: Math.sin(angle) * seedRadius,
        vx: 0,
        vy: 0,
        pinned: false,
      };
    });
    this.nodeById = new Map(this.nodes.map((node) => [node.id, node]));
    if (this.selectedId && !this.nodeById.has(this.selectedId)) {
      this.selectedId = null;
    }
    this.hoveredId = null;
    // Every SimNode was just replaced: a gesture still holding an old node would
    // drag a detached object and keep the rAF loop alive forever.
    this.draggingId = null;
    this.panning = false;
    this.alpha = 1;
    this.startSimulation();
  }

  private startSimulation() {
    if (this.rafHandle !== null || this.nodes.length === 0) {
      return;
    }
    const step = () => {
      this.rafHandle = null;
      this.tick();
      this.frame += 1;
      if (this.alpha > ALPHA_MIN || this.draggingId) {
        this.rafHandle = requestAnimationFrame(step);
      }
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  private stopSimulation() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private tick() {
    const nodes = this.nodes;
    // Repulsion: every pair pushes apart, so disconnected entities still spread.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq < 1) {
          // Coincident nodes have no direction to separate along; nudge them
          // apart deterministically by index so the pair never sticks.
          dx = (j - i) * 0.5;
          dy = 0.5;
          distanceSq = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distanceSq);
        const force = REPULSION / distanceSq;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    // Springs pull related entities together.
    for (const relationship of this.relationships) {
      const source = this.nodeById.get(relationship.from);
      const target = this.nodeById.get(relationship.to);
      if (!source || !target || source === target) {
        continue;
      }
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (distance - SPRING_LENGTH) * SPRING_STRENGTH;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }
    for (const node of nodes) {
      node.vx -= node.x * CENTER_PULL;
      node.vy -= node.y * CENTER_PULL;
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      // Clamp the per-tick step: a large repulsion impulse between two nearly
      // coincident nodes would otherwise fling one off-screen.
      node.x += Math.max(-MAX_STEP, Math.min(MAX_STEP, node.vx * this.alpha));
      node.y += Math.max(-MAX_STEP, Math.min(MAX_STEP, node.vy * this.alpha));
    }
    // While a node is held, keep the simulation warm: otherwise alpha decays to
    // nothing mid-drag and the neighbours freeze while the loop still burns a
    // full O(n^2) pass each frame.
    this.alpha = this.draggingId
      ? Math.max(this.alpha * ALPHA_DECAY, DRAG_ALPHA_FLOOR)
      : this.alpha * ALPHA_DECAY;
  }

  private radiusOf(node: SimNode): number {
    return Math.min(MAX_RADIUS, MIN_RADIUS + node.degree * 3.5);
  }

  private get activeId(): string | null {
    return this.hoveredId ?? this.selectedId;
  }

  /** Entities one hop from the active node stay lit; everything else dims. */
  private neighborsOf(id: string): Set<string> {
    const neighbors = new Set<string>([id]);
    for (const relationship of this.relationships) {
      if (relationship.from === id) {
        neighbors.add(relationship.to);
      }
      if (relationship.to === id) {
        neighbors.add(relationship.from);
      }
    }
    return neighbors;
  }

  private toGraphPoint(event: PointerEvent): { x: number; y: number } {
    const svgElement = this.svgElement;
    if (!svgElement) {
      return { x: 0, y: 0 };
    }
    const rect = svgElement.getBoundingClientRect();
    const viewX = event.clientX - rect.left - this.width / 2 - this.panX;
    const viewY = event.clientY - rect.top - VIEW_HEIGHT / 2 - this.panY;
    return { x: viewX / this.zoom, y: viewY / this.zoom };
  }

  private handleNodePointerDown(event: PointerEvent, id: string) {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    const node = this.nodeById.get(id);
    if (!node) {
      return;
    }
    this.svgElement?.setPointerCapture(event.pointerId);
    this.draggingId = id;
    node.pinned = true;
    this.selectedId = id;
    this.alpha = Math.max(this.alpha, REHEAT_ALPHA);
    this.startSimulation();
  }

  // Arrow property: passed straight to the template as a listener, so it must
  // stay bound to the element (the sibling pointer handlers below are too).
  private handleBackgroundPointerDown = (event: PointerEvent) => {
    // Non-primary buttons open the context menu instead of delivering pointerup,
    // which would leave the view panning with no button held.
    if (event.button !== 0) {
      return;
    }
    this.svgElement?.setPointerCapture(event.pointerId);
    this.panning = true;
    this.pointerOrigin = {
      x: event.clientX,
      y: event.clientY,
      panX: this.panX,
      panY: this.panY,
    };
  };

  private handlePointerMove = (event: PointerEvent) => {
    // A gesture whose button was released off-target (context menu, lost capture)
    // leaves no pointerup behind; drop it rather than tracking a buttonless move.
    if (event.buttons === 0 && (this.draggingId || this.panning)) {
      this.endGesture();
      return;
    }
    if (this.draggingId) {
      const node = this.nodeById.get(this.draggingId);
      if (node) {
        const point = this.toGraphPoint(event);
        node.x = point.x;
        node.y = point.y;
        this.frame += 1;
      }
      return;
    }
    if (this.panning) {
      this.panX = this.pointerOrigin.panX + (event.clientX - this.pointerOrigin.x);
      this.panY = this.pointerOrigin.panY + (event.clientY - this.pointerOrigin.y);
    }
  };

  private handlePointerUp = (event: PointerEvent) => {
    this.endGesture();
    if (this.svgElement?.hasPointerCapture(event.pointerId)) {
      this.svgElement.releasePointerCapture(event.pointerId);
    }
  };

  private endGesture() {
    if (this.draggingId) {
      const node = this.nodeById.get(this.draggingId);
      if (node) {
        // Release the pin so the graph re-settles around the dropped node.
        node.pinned = false;
      }
      this.draggingId = null;
      this.alpha = Math.max(this.alpha, REHEAT_ALPHA);
      this.startSimulation();
    }
    this.panning = false;
  }

  private handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    const next = this.zoom * Math.exp(-event.deltaY * 0.0015);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
  };

  private resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.selectedId = null;
    this.alpha = 1;
    this.startSimulation();
  }

  override render() {
    if (this.entities.length === 0) {
      return nothing;
    }
    const active = this.activeId;
    const lit = active ? this.neighborsOf(active) : null;
    return html`
      <div class="graph-shell">
        <svg
          class=${this.panning ? "panning" : ""}
          viewBox="0 0 ${this.width} ${VIEW_HEIGHT}"
          role="list"
          aria-label=${t("enterprise.ontologyTitle")}
          @pointerdown=${this.handleBackgroundPointerDown}
          @pointermove=${this.handlePointerMove}
          @pointerup=${this.handlePointerUp}
          @pointercancel=${this.handlePointerUp}
          @wheel=${this.handleWheel}
        >
          <defs>
            <marker
              id="onto-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-hover)" />
            </marker>
            <marker
              id="onto-arrow-active"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent-2, var(--accent))" />
            </marker>
          </defs>
          <g
            transform="translate(${this.width / 2 + this.panX}, ${VIEW_HEIGHT / 2 +
            this.panY}) scale(${this.zoom})"
          >
            ${this.relationships.map((relationship) => this.renderEdge(relationship, active))}
            ${this.nodes.map((node) => this.renderNode(node, lit))}
          </g>
        </svg>
        <button class="reset-view" @click=${() => this.resetView()}>
          ${t("enterprise.resetView")}
        </button>
        <div class="hint">${t("enterprise.graphHint")}</div>
      </div>
      ${this.renderInspector()}
    `;
  }

  private renderEdge(
    relationship: OntologyRelationship,
    active_: string | null,
  ): TemplateResult | typeof nothing {
    const source = this.nodeById.get(relationship.from);
    const target = this.nodeById.get(relationship.to);
    if (!source || !target) {
      return nothing;
    }
    // Incidence, not "both endpoints are lit": the neighbour set also contains
    // edges *between* two neighbours, which do not belong to the active entity.
    // Testing incidence also keeps a focused entity's own self-loop lit.
    const active =
      active_ !== null && (relationship.from === active_ || relationship.to === active_);
    const dimmed = active_ !== null && !active;
    const stroke = active ? "var(--accent-2, var(--accent))" : "var(--border-hover)";
    const marker = active ? "url(#onto-arrow-active)" : "url(#onto-arrow)";
    const opacity = dimmed ? 0.18 : 1;

    // Self-relationships are real ontology statements (an entity related to
    // itself); the old renderer dropped them silently. Draw them as a loop.
    if (source === target) {
      const r = this.radiusOf(source);
      const path = `M ${source.x - r * 0.6} ${source.y - r * 0.8}
        C ${source.x - r * 2.4} ${source.y - r * 3.2},
          ${source.x + r * 2.4} ${source.y - r * 3.2},
          ${source.x + r * 0.6} ${source.y - r * 0.8}`;
      return svg`
        <g opacity=${opacity}>
          <path d=${path} fill="none" stroke=${stroke} stroke-width="1.5" marker-end=${marker} />
          ${
            active
              ? svg`<text class="edge-label" x=${source.x} y=${source.y - r * 2.6} text-anchor="middle">${relationship.id}</text>`
              : nothing
          }
        </g>
      `;
    }

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / distance;
    const uy = dy / distance;
    // Stop the line at the circle edges so the arrowhead lands on the rim, not
    // under the target node.
    const x1 = source.x + ux * this.radiusOf(source);
    const y1 = source.y + uy * this.radiusOf(source);
    const x2 = target.x - ux * (this.radiusOf(target) + 4);
    const y2 = target.y - uy * (this.radiusOf(target) + 4);
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    return svg`
      <g opacity=${opacity}>
        <line
          x1=${x1}
          y1=${y1}
          x2=${x2}
          y2=${y2}
          stroke=${stroke}
          stroke-width=${active ? 2 : 1.5}
          marker-end=${marker}
        />
        ${
          active
            ? svg`<text class="edge-label" x=${midX} y=${midY - 5} text-anchor="middle">${relationship.id}</text>`
            : nothing
        }
      </g>
    `;
  }

  private renderNode(node: SimNode, lit: Set<string> | null): TemplateResult {
    const radius = this.radiusOf(node);
    const isActive = lit !== null && lit.has(node.id);
    const isFocus = this.activeId === node.id;
    const dimmed = lit !== null && !isActive;
    const fill = isFocus
      ? "var(--accent-2, var(--accent))"
      : isActive
        ? "var(--accent-2-subtle, var(--accent-subtle))"
        : "var(--bg-hover, var(--panel-strong))";
    const stroke = isActive ? "var(--accent-2, var(--accent))" : "var(--border-strong)";
    return svg`
      <g
        role="listitem"
        tabindex="0"
        aria-label=${node.description ? `${node.id}: ${node.description}` : node.id}
        opacity=${dimmed ? 0.22 : 1}
        @focus=${() => {
          this.hoveredId = node.id;
        }}
        @blur=${() => {
          this.hoveredId = null;
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.selectedId = this.selectedId === node.id ? null : node.id;
          }
        }}
      >
        <circle
          class="node-hit"
          cx=${node.x}
          cy=${node.y}
          r=${radius}
          fill=${fill}
          stroke=${stroke}
          stroke-width=${isFocus ? 2.5 : 1.5}
          @pointerdown=${(event: PointerEvent) => this.handleNodePointerDown(event, node.id)}
          @pointerenter=${() => {
            this.hoveredId = node.id;
          }}
          @pointerleave=${() => {
            this.hoveredId = null;
          }}
        >
          <title>${node.id}${node.description ? ` — ${node.description}` : ""}</title>
        </circle>
        <text
          class="label ${isActive ? "active" : ""}"
          x=${node.x}
          y=${node.y + radius + 13}
          text-anchor="middle"
        >${truncate(node.id, LABEL_MAX)}</text>
      </g>
    `;
  }

  private renderInspector(): TemplateResult | typeof nothing {
    const id = this.selectedId;
    if (!id) {
      return nothing;
    }
    const node = this.nodeById.get(id);
    if (!node) {
      return nothing;
    }
    const outgoing = this.relationships.filter((relationship) => relationship.from === id);
    const incoming = this.relationships.filter(
      (relationship) => relationship.to === id && relationship.from !== id,
    );
    // Incoming links read backwards from the selected type, so show the declared
    // inverse name when there is one: that is the whole point of declaring it.
    const link = (
      relationship: OntologyRelationship,
      from: string,
      to: string,
      reverse = false,
    ) => html`
      <div class="inspector-row">
        ${from}
        <span class="rel">— ${relationship.id} →</span>
        ${to}
        ${relationship.cardinality
          ? html`<span class="card">${relationship.cardinality}</span>`
          : nothing}
        ${reverse && relationship.inverse
          ? html`<span class="card">inverse: ${relationship.inverse}</span>`
          : nothing}
      </div>
    `;
    return html`
      <div class="inspector">
        <div class="inspector-title">${node.title ?? node.id}</div>
        <div class="inspector-sub">${node.id}</div>
        ${node.description ? html`<div class="inspector-sub">${node.description}</div>` : nothing}
        ${node.properties?.length
          ? html`<div class="props">
              ${node.properties.map(
                (field) => html`<div class="prop">
                  <span class="prop-name">${field.id}</span>
                  <span class="prop-type">${field.type}</span>
                  ${field.primaryKey ? html`<span class="pk">PK</span>` : nothing}
                  ${field.required && !field.primaryKey
                    ? html`<span class="req">required</span>`
                    : nothing}
                </div>`,
              )}
            </div>`
          : nothing}
        ${outgoing.map((relationship) => link(relationship, node.id, relationship.to))}
        ${incoming.map((relationship) => link(relationship, relationship.from, node.id, true))}
        ${outgoing.length === 0 && incoming.length === 0
          ? html`<div class="inspector-row">${t("enterprise.noRelationships")}</div>`
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-ontology-graph")) {
  customElements.define("openclaw-ontology-graph", OpenClawOntologyGraph);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-ontology-graph": OpenClawOntologyGraph;
  }
}
