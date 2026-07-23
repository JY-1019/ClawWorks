/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawWorkflowTreeGraph, WorkflowTreeNode } from "./workflow-tree-graph.ts";
import "./workflow-tree-graph.ts";

const NODES: WorkflowTreeNode[] = [
  { id: "root", parentId: null, depth: 0, title: "Root", ontology: {} },
  { id: "root.triage", parentId: "root", depth: 1, title: "Triage", ontology: {} },
];

let container: HTMLDivElement | undefined;

async function mount(): Promise<OpenClawWorkflowTreeGraph> {
  container = document.createElement("div");
  document.body.append(container);
  render(
    html`<openclaw-workflow-tree-graph .nodes=${NODES}></openclaw-workflow-tree-graph>`,
    container,
  );
  const element = container.querySelector<OpenClawWorkflowTreeGraph>(
    "openclaw-workflow-tree-graph",
  );
  if (!element) {
    throw new Error("component did not mount");
  }
  await element.updateComplete;
  return element;
}

function clickNode(element: OpenClawWorkflowTreeGraph, title: string): void {
  const groups = [...(element.shadowRoot?.querySelectorAll<SVGGElement>("g.node-box") ?? [])];
  const group = groups.find((candidate) => candidate.getAttribute("aria-label")?.includes(title));
  if (!group) {
    throw new Error(`no node group for "${title}"`);
  }
  group.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
}

afterEach(() => {
  container?.remove();
  container = undefined;
});

describe("openclaw-workflow-tree-graph node selection", () => {
  it("emits node-select with the clicked node id", async () => {
    const element = await mount();
    const events: Array<string | null> = [];
    element.addEventListener("node-select", (event) => {
      events.push((event as CustomEvent<{ nodeId: string | null }>).detail.nodeId);
    });

    clickNode(element, "Triage");
    expect(events).toEqual(["root.triage"]);
  });

  it("emits null when the same node is clicked again (toggle off)", async () => {
    const element = await mount();
    const events: Array<string | null> = [];
    element.addEventListener("node-select", (event) => {
      events.push((event as CustomEvent<{ nodeId: string | null }>).detail.nodeId);
    });

    clickNode(element, "Triage");
    clickNode(element, "Triage");
    expect(events).toEqual(["root.triage", null]);
  });

  it("emits null when the selected node is pruned from the tree", async () => {
    const element = await mount();
    clickNode(element, "Triage");
    const events: Array<string | null> = [];
    element.addEventListener("node-select", (event) => {
      events.push((event as CustomEvent<{ nodeId: string | null }>).detail.nodeId);
    });

    // A route change / re-import drops the selected node: the panel must not linger.
    element.nodes = [{ id: "root", parentId: null, depth: 0, title: "Root", ontology: {} }];
    await element.updateComplete;
    expect(events).toEqual([null]);
  });

  it("renders step guidance in the inspector (not 'no step scope')", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const nodes: WorkflowTreeNode[] = [
      { id: "root", parentId: null, depth: 0, title: "Root", ontology: {} },
      {
        id: "root.triage",
        parentId: "root",
        depth: 1,
        title: "Triage",
        // A node whose only scope is guidance must still show it, not fall
        // through to the "no step scope" placeholder.
        ontology: { guidance: "Confirm the order id first." },
      },
    ];
    render(
      html`<openclaw-workflow-tree-graph
        .nodes=${nodes}
        .selected=${"root.triage"}
      ></openclaw-workflow-tree-graph>`,
      container,
    );
    const element = container.querySelector<OpenClawWorkflowTreeGraph>(
      "openclaw-workflow-tree-graph",
    );
    if (!element) {
      throw new Error("component did not mount");
    }
    await element.updateComplete;
    const text = element.shadowRoot?.querySelector(".inspector")?.textContent ?? "";
    expect(text).toContain("Confirm the order id first.");
  });
});
