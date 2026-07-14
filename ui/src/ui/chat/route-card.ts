// The route card that sits inside the assistant's chat bubble: the branch of the
// governed workflow tree this answer actually took, drawn as a tree.
//
// Two modes, because they answer different questions:
//   - "route"     — only the nodes the run planned. What DID it do?
//   - "full tree" — the whole tree with the route lit and the rest dimmed.
//                   What did it NOT do? That is the governance question, and a
//                   route-only view structurally cannot answer it.
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  EnterpriseRunDetail,
  EnterpriseTreeDetail,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import type { WorkflowTreeNode } from "../components/workflow-tree-graph.ts";
import "../components/workflow-tree-graph.ts";

type CardMode = "route" | "tree";

/**
 * Plan nodes carry parentId but no depth (the plan is a flat list). The tree
 * graph lays out by parent links and needs depth, so derive it from the chain.
 */
function planNodesToTreeNodes(run: EnterpriseRunDetail): WorkflowTreeNode[] {
  const parentOf = new Map<string, string | null>();
  for (const node of run.nodes) {
    parentOf.set(node.nodeId, node.parentId);
  }
  const depthOf = (id: string): number => {
    let depth = 0;
    let parent = parentOf.get(id) ?? null;
    // Bounded by the node count: a malformed parent chain cannot spin here.
    while (parent && depth <= run.nodes.length) {
      depth += 1;
      parent = parentOf.get(parent) ?? null;
    }
    return depth;
  };
  return run.nodes.map((node) => ({
    id: node.nodeId,
    // A route's top node has an ancestor in the TREE but not in the plan, so it
    // must read as the root here or the layout would have nothing to hang from.
    parentId: node.parentId && parentOf.has(node.parentId) ? node.parentId : null,
    depth: depthOf(node.nodeId),
    title: node.title,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ontology: node.ontology,
  }));
}

export class OpenClawChatRouteCard extends LitElement {
  @property({ attribute: false }) run: EnterpriseRunDetail | null = null;
  /** The full tree, when its identity could be proven. Enables the tree mode. */
  @property({ attribute: false }) tree: EnterpriseTreeDetail | null = null;

  @state() private mode: CardMode = "route";

  static override styles = css`
    :host {
      display: block;
      margin-top: 8px;
    }

    .card {
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-accent, var(--card));
      font-size: 12px;
    }

    .head {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .title {
      font-weight: 600;
      color: var(--text-strong);
    }

    .chip {
      padding: 1px 6px;
      font-size: 11px;
      color: var(--muted);
      border: 1px solid var(--border-strong);
      border-radius: 4px;
    }

    .spacer {
      flex: 1;
    }

    .switch {
      display: flex;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      overflow: hidden;
    }

    .switch button {
      padding: 2px 8px;
      font: inherit;
      font-size: 11px;
      color: var(--muted);
      background: transparent;
      border: 0;
      cursor: pointer;
    }

    .switch button[aria-pressed="true"] {
      color: var(--text-strong);
      background: var(--accent-2-subtle, var(--accent-subtle));
    }

    .switch button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .routes {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }

    .routes code {
      padding: 1px 5px;
      color: var(--accent-2, var(--accent));
      background: var(--accent-2-subtle, var(--accent-subtle));
      border-radius: 4px;
    }

    .why {
      margin-top: 6px;
      color: var(--muted);
    }
  `;

  override render() {
    const run = this.run;
    if (!run) {
      return nothing;
    }
    const route = run.route;
    const planned = run.nodes.map((node) => node.nodeId);
    // The tree mode needs a tree whose identity we could prove; without one the
    // switch would offer a view we cannot honestly draw.
    const canShowTree = Boolean(this.tree);
    const mode: CardMode = canShowTree ? this.mode : "route";
    const nodes: WorkflowTreeNode[] =
      mode === "tree" && this.tree
        ? (this.tree.nodes as WorkflowTreeNode[])
        : planNodesToTreeNodes(run);

    return html`
      <div class="card">
        <div class="head">
          <span class="title">${t("enterprise.routeTitle")}</span>
          <span class="chip">${run.treeName}</span>
          ${route
            ? html`<span class="chip">
                ${t("enterprise.routeCoverage", {
                  coverage: `${route.selectedNodes}/${route.totalNodes}`,
                })}
              </span>`
            : nothing}
          <span class="spacer"></span>
          ${this.renderSwitch(canShowTree, mode)}
        </div>
        ${route?.routes.length
          ? html`<div class="routes">${route.routes.map((id) => html`<code>${id}</code>`)}</div>`
          : nothing}
        <openclaw-workflow-tree-graph
          .nodes=${nodes}
          .routeNodeIds=${mode === "tree" ? planned : null}
        ></openclaw-workflow-tree-graph>
        ${route ? html`<div class="why">${route.rationale}</div>` : nothing}
      </div>
    `;
  }

  private renderSwitch(canShowTree: boolean, mode: CardMode): TemplateResult {
    const pick = (next: CardMode) => () => {
      this.mode = next;
    };
    return html`
      <div class="switch" role="group" aria-label=${t("enterprise.routeViewLabel")}>
        <button type="button" aria-pressed=${mode === "route"} @click=${pick("route")}>
          ${t("enterprise.routeViewRoute")}
        </button>
        <button
          type="button"
          aria-pressed=${mode === "tree"}
          ?disabled=${!canShowTree}
          title=${canShowTree ? "" : t("enterprise.routeViewTreeUnavailable")}
          @click=${pick("tree")}
        >
          ${t("enterprise.routeViewTree")}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-route-card")) {
  customElements.define("openclaw-chat-route-card", OpenClawChatRouteCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-route-card": OpenClawChatRouteCard;
  }
}
