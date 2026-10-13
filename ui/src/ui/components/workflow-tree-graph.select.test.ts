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
  node(element, title).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
}

function node(element: OpenClawWorkflowTreeGraph, title: string): SVGRectElement {
  const group = [
    ...(element.shadowRoot?.querySelectorAll<SVGRectElement>("rect.node-action") ?? []),
  ].find((candidate) => candidate.getAttribute("aria-label")?.includes(title));
  if (!group) {
    throw new Error(`no node group for "${title}"`);
  }
  return group;
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

  it("uses ordinary toggle-button semantics and supports keyboard selection", async () => {
    const element = await mount();
    const events: Array<string | null> = [];
    element.addEventListener("node-select", (event) => {
      events.push((event as CustomEvent<{ nodeId: string | null }>).detail.nodeId);
    });
    const root = node(element, "Root");
    const triage = node(element, "Triage");

    expect(element.shadowRoot?.querySelector("svg")?.getAttribute("role")).toBe("list");
    expect([root, triage].map((entry) => entry.getAttribute("role"))).toEqual(["button", "button"]);
    expect(
      [root, triage].map((entry) => {
        const item = entry.closest("g.node-box");
        return [item?.getAttribute("role"), item?.getAttribute("aria-level")];
      }),
    ).toEqual([
      ["listitem", "1"],
      ["listitem", "2"],
    ]);
    expect([root, triage].map((entry) => entry.tabIndex)).toEqual([0, 0]);
    expect([root, triage].map((entry) => entry.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
    ]);

    triage.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await element.updateComplete;
    expect(events).toEqual(["root.triage"]);
    expect(triage.getAttribute("aria-pressed")).toBe("true");

    triage.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await element.updateComplete;
    expect(events).toEqual(["root.triage", null]);
    expect(triage.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the current selection when the parent cancels navigation", async () => {
    const element = await mount();
    clickNode(element, "Triage");
    element.addEventListener("node-select", (event) => {
      if ((event as CustomEvent<{ nodeId: string | null }>).detail.nodeId === "root") {
        event.preventDefault();
      }
    });

    clickNode(element, "Root");

    expect(element.selected).toBe("root.triage");
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

  it("renders attached MCP servers in the inspector", async () => {
    const element = await mount();
    element.nodes = [NODES[0], { ...NODES[1], ontology: { mcpServers: ["github", "atlassian"] } }];
    element.selected = "root.triage";
    await element.updateComplete;

    const text = element.shadowRoot?.querySelector(".inspector")?.textContent ?? "";
    expect(text).toContain("MCP: github, atlassian");
  });

  it("renders call and relationship effect targets", async () => {
    const element = await mount();
    element.nodes = [
      NODES[0],
      {
        ...NODES[1],
        ontology: {
          actions: [
            {
              id: "notify",
              effects: [
                { kind: "call", tool: "message" },
                { kind: "link", relationship: "assigned_to" },
              ],
            },
          ],
        },
      },
    ];
    element.selected = "root.triage";
    await element.updateComplete;

    const text = element.shadowRoot?.querySelector(".inspector")?.textContent ?? "";
    expect(text).toContain("call message");
    expect(text).toContain("link assigned_to");
    expect(text).not.toContain("undefined");
  });

  it("distinguishes actions covering all direct tools from none", async () => {
    const element = await mount();
    element.nodes = [
      NODES[0],
      {
        ...NODES[1],
        ontology: {
          actions: [
            { id: "all-tools", effects: [{ kind: "call", tool: "message" }] },
            { id: "no-tools", tools: [], effects: [{ kind: "call", tool: "message" }] },
          ],
        },
      },
    ];
    element.selected = "root.triage";
    await element.updateComplete;

    const labels = [
      ...(element.shadowRoot?.querySelectorAll<HTMLElement>(".action-tools") ?? []),
    ].map((entry) => entry.textContent?.trim());
    expect(labels).toEqual(["Match all tool calls", "Match no tool calls"]);
  });
});
