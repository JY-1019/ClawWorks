// Control UI tests cover the enterprise Tools/Skills catalogs and step bindings.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type {
  EnterpriseTreeDetail,
  ToolsCatalogResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { SkillStatusEntry } from "../types.ts";
import { renderEnterprise, type EnterpriseProps } from "./enterprise.ts";

function toolGroup(
  id: string,
  label: string,
  toolIds: string[],
): ToolsCatalogResult["groups"][number] {
  return {
    id,
    label,
    source: "core",
    tools: toolIds.map((toolId) => ({
      id: toolId,
      label: toolId,
      description: "",
      source: "core",
      defaultProfiles: [],
    })),
  };
}

function skill(name: string): SkillStatusEntry {
  return {
    name,
    description: `${name} description`,
    source: "bundled",
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    skillKey: name,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { bins: [], env: [], config: [], os: [] },
    missing: { bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}

const TREE: EnterpriseTreeDetail = {
  id: "acme.support",
  version: "1.0.0",
  name: "Support",
  source: "imported",
  nodes: [
    {
      id: "support",
      parentId: null,
      depth: 0,
      title: "Support",
      ontology: { allowedTools: ["message"] },
    },
    {
      id: "support.triage",
      parentId: "support",
      depth: 1,
      title: "Triage",
      ontology: { skills: ["ticket-triage", "summarize"], knowledgeFoundations: ["acme.kb"] },
    },
  ],
} as EnterpriseTreeDetail;

function createProps(overrides: Partial<EnterpriseProps> = {}): EnterpriseProps {
  return {
    section: "tools",
    loading: false,
    runs: [],
    trees: [],
    importErrors: [],
    storeError: null,
    selectedExecutionId: null,
    detail: null,
    detailLoading: false,
    runTree: null,
    selectedTreeId: null,
    treeDetail: null,
    treeLoading: false,
    treeIssue: null,
    selectedNodeId: null,
    nodeObjectsEntity: null,
    nodeObjects: [],
    nodeObjectsLoading: false,
    treeEditing: false,
    treeEditContent: "",
    treeEditFormat: "yaml",
    treeSaving: false,
    treeSaveIssues: null,
    treeSaveError: null,
    treeConfirm: null,
    treeVersions: [],
    treeVersionsLoading: false,
    canEdit: true,
    nodeDraft: null,
    error: null,
    onRefresh: () => undefined,
    onSelectRun: () => undefined,
    onSelectTree: () => undefined,
    onBeginEdit: () => undefined,
    onBeginNew: () => undefined,
    onEditContent: () => undefined,
    onEditFormat: () => undefined,
    onCancelEdit: () => undefined,
    onRequestSave: () => undefined,
    onRequestRemove: () => undefined,
    onCancelConfirm: () => undefined,
    onConfirm: () => undefined,
    onExport: () => undefined,
    onLoadVersion: () => undefined,
    onSelectNode: () => undefined,
    onSelectNodeEntity: () => undefined,
    onBeginAddNode: () => undefined,
    onEditNodeDraft: () => undefined,
    onCancelAddNode: () => undefined,
    onSubmitAddNode: () => undefined,
    ontologyEntryDraft: null,
    onBeginAddOntologyEntry: () => undefined,
    onEditOntologyEntryDraft: () => undefined,
    onCancelAddOntologyEntry: () => undefined,
    onSubmitAddOntologyEntry: () => undefined,
    catalogPhase: "ready",
    catalogErrors: { tools: null, skills: null, foundations: null },
    catalogAgentId: "main",
    toolGroups: [],
    skills: [],
    foundations: [],
    ...overrides,
  };
}

function renderInto(props: EnterpriseProps): HTMLElement {
  const container = document.createElement("div");
  render(renderEnterprise(props), container);
  return container;
}

describe("enterprise Tools tab (browser)", () => {
  it("lists every catalog group, not only the enterprise ones", () => {
    const container = renderInto(
      createProps({
        section: "tools",
        toolGroups: [
          {
            id: "enterprise",
            label: "Enterprise",
            source: "core",
            tools: [
              {
                id: "search_objects",
                label: "search_objects",
                description: "",
                source: "core",
                defaultProfiles: [],
              },
            ],
          },
          {
            id: "fs",
            label: "Files",
            source: "core",
            tools: [
              {
                id: "read",
                label: "read",
                description: "Read file",
                source: "core",
                defaultProfiles: [],
              },
            ],
          },
          {
            id: "acme-plugin",
            label: "Acme",
            source: "plugin",
            pluginId: "acme",
            tools: [
              {
                id: "acme_do",
                label: "acme_do",
                description: "",
                source: "plugin",
                pluginId: "acme",
                defaultProfiles: [],
              },
            ],
          },
        ],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("search_objects");
    expect(text).toContain("read");
    expect(text).toContain("acme_do");
    // Core sections carry a group: selector; a plugin group has none, so it shows
    // its owner instead of a selector that would match nothing in an allow-list.
    expect(text).toContain("group:fs");
    expect(text).not.toContain("group:acme-plugin");
    // Browsing only: attaching happens on the step selected in Worktree.
    expect(container.querySelector("input")).toBeNull();
  });

  it("puts the enterprise groups first, ahead of the stock ones", () => {
    // CORE_TOOL_SECTION_ORDER sorts them last, so the groups that only exist for
    // governed steps were the ones an operator had to scroll furthest to reach.
    const container = renderInto(
      createProps({
        section: "tools",
        toolGroups: [
          toolGroup("fs", "Files", ["read"]),
          toolGroup("memory", "Memory", ["memory_search"]),
          toolGroup("enterprise", "Enterprise", ["search_objects"]),
          toolGroup("enterprise-write", "Enterprise (write)", ["invoke_action"]),
        ],
      }),
    );
    const labels = [...container.querySelectorAll("details > summary .list-title")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(labels.slice(0, 2)).toEqual(["Enterprise", "Enterprise (write)"]);
    expect(labels).toEqual(["Enterprise", "Enterprise (write)", "Files", "Memory"]);
  });

  it("keeps catalog rows out of the reserved meta column", () => {
    // Regression: .list-item reserves a 200-260px second column for .list-meta.
    // These rows have none, so the two-column grid put the expanded group body
    // into that narrow column and squeezed every tool into a sliver on the left.
    const container = renderInto(
      createProps({ section: "tools", toolGroups: [toolGroup("fs", "Files", ["read"])] }),
    );
    for (const row of container.querySelectorAll(".list-item")) {
      expect(row.classList.contains("list-item-stacked")).toBe(true);
    }
  });

  it("chips the steps that put a tool in scope, expanding group: selectors", () => {
    // The runtime gate expands `group:enterprise`, so a literal id match would
    // report this step as not using search_objects while the runtime lets it call.
    const container = renderInto(
      createProps({
        section: "tools",
        toolGroups: [toolGroup("enterprise", "Enterprise", ["search_objects"])],
        treeDetail: {
          ...TREE,
          name: "Support",
          nodes: [
            {
              id: "support.investigate",
              parentId: null,
              depth: 0,
              title: "Investigate",
              ontology: { allowedTools: ["group:enterprise"] },
            },
          ],
        } as EnterpriseTreeDetail,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Used by Support");
    expect(text).toContain("support.investigate");
  });

  it("does not chip a step for a tool an ancestor's allowlist denies it", () => {
    // Governance gates on every node from the root down, so a step listing
    // memory_search under a root that allows only message can never call it.
    // Chipping it would tell the operator a binding works that is denied at run.
    const container = renderInto(
      createProps({
        section: "tools",
        toolGroups: [toolGroup("memory", "Memory", ["memory_search"])],
        treeDetail: {
          ...TREE,
          name: "Gated",
          nodes: [
            {
              id: "root",
              parentId: null,
              depth: 0,
              title: "Root",
              ontology: { allowedTools: ["message"] },
            },
            {
              id: "leaf",
              parentId: "root",
              depth: 1,
              title: "Leaf",
              ontology: { allowedTools: ["memory_search"] },
            },
          ],
        } as EnterpriseTreeDetail,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("memory_search");
    expect(text).not.toContain("leaf");
  });

  it("does not claim a wildcard allowlist grants ontology writes", () => {
    // ONTOLOGY_WRITE_OPT_INS (src/enterprise/runtime.ts): only naming
    // invoke_action or group:enterprise-write consents to writes. `*` has not
    // thought about writes, so a step under it is denied at call time.
    const container = renderInto(
      createProps({
        section: "tools",
        toolGroups: [
          toolGroup("enterprise-write", "Enterprise (write)", ["invoke_action"]),
          toolGroup("memory", "Memory", ["memory_search"]),
        ],
        treeDetail: {
          ...TREE,
          name: "Wildcard",
          nodes: [
            {
              id: "wide",
              parentId: null,
              depth: 0,
              title: "Wide",
              ontology: { allowedTools: ["*"] },
            },
          ],
        } as EnterpriseTreeDetail,
      }),
    );
    const text = container.textContent ?? "";
    // The wildcard does reach ordinary tools...
    expect(text).toContain("memory_search");
    expect(text).toContain("Used by Wildcard");
    // ...but invoke_action must not be chipped for it.
    const writeRow = [...container.querySelectorAll(".list-item")].find((row) =>
      row.querySelector("code")?.textContent?.includes("invoke_action"),
    );
    expect(writeRow).toBeDefined();
    expect(writeRow?.textContent ?? "").not.toContain("wide");
  });

  it("chips a step that explicitly opts into ontology writes", () => {
    const container = renderInto(
      createProps({
        section: "tools",
        toolGroups: [toolGroup("enterprise-write", "Enterprise (write)", ["invoke_action"])],
        treeDetail: {
          ...TREE,
          name: "Writer",
          nodes: [
            {
              id: "settle",
              parentId: null,
              depth: 0,
              title: "Settle",
              ontology: { allowedTools: ["group:enterprise-write"] },
            },
          ],
        } as EnterpriseTreeDetail,
      }),
    );
    expect(container.textContent ?? "").toContain("settle");
  });

  it("flags a work-map that failed to load without hiding what the fallback binds", () => {
    // enterprise.trees.get returns a fallback built-in when an import or store
    // read fails. Under enterprise.mode "observe" that built-in is what actually
    // runs, so the chips stay; the banner is what stops them being read as the
    // selected work-map, which governs nothing under enforce until it loads.
    const container = renderInto(
      createProps({
        section: "tools",
        toolGroups: [toolGroup("memory", "Memory", ["memory_search"])],
        treeDetail: {
          ...TREE,
          nodes: [
            {
              id: "support",
              parentId: null,
              depth: 0,
              title: "Support",
              ontology: { allowedTools: ["memory_search"] },
            },
          ],
        } as EnterpriseTreeDetail,
        treeIssue: "import failed",
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("did not load");
    expect(text).toContain("import failed");
    expect(text).toContain("support");
    // The plain "measured against X" line must give way to the failure banner.
    expect(text).not.toContain("Step usage below is measured against");
  });

  it("does not claim a fallback exists when the tree load returned nothing", () => {
    // enterprise.trees.get may answer `tree: null` beside an error, and a rejected
    // request leaves nothing at all. There are no fallback rows to explain then,
    // so the fallback wording would describe steps that are not on screen.
    const container = renderInto(
      createProps({
        section: "tools",
        toolGroups: [toolGroup("memory", "Memory", ["memory_search"])],
        treeDetail: null,
        treeIssue: "request failed",
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("could not be loaded");
    expect(text).toContain("request failed");
    expect(text).not.toContain("fallback definition");
  });

  it("says no work-map is selected instead of implying nothing uses these tools", () => {
    const container = renderInto(
      createProps({ section: "tools", toolGroups: [toolGroup("fs", "Files", ["read"])] }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("No work-map is selected");
    expect(text).not.toContain("Used by");
  });
});

describe("enterprise Skills tab (browser)", () => {
  it("lists installed skills without needing a selected step", () => {
    const container = renderInto(
      createProps({ section: "skills", skills: [skill("summarize"), skill("weather")] }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("summarize");
    expect(text).toContain("weather");
    expect(container.querySelector("input")).toBeNull();
  });

  it("lifts the skills the work-map declares above the rest of the catalog", () => {
    const container = renderInto(
      createProps({
        section: "skills",
        skills: [skill("weather"), skill("summarize"), skill("clawhub")],
        treeDetail: TREE,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Declared by Support");
    expect(text).toContain("Other installed skills");
    // support.triage declares summarize, so it moves out of the alphabet soup and
    // is chipped with the step that depends on it.
    const names = [...container.querySelectorAll(".list-item code")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(names[0]).toBe("summarize");
    expect(text).toContain("support.triage");
    // "Declared by", not "Used by": ontology.skills does not load or scope skill
    // content to the step, so usage wording would imply an activation it is not.
    expect(text).toContain("Declared by Support:");
    expect(text).not.toContain("Used by Support:");
    // Declared-but-absent stays visible: the work-map depends on it either way.
    expect(text).toContain("ticket-triage");
    expect(text).toContain("not installed");
  });

  it("omits the other-skills heading when the work-map declares every installed skill", () => {
    const container = renderInto(
      createProps({
        section: "skills",
        skills: [skill("summarize")],
        treeDetail: TREE,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Declared by Support");
    expect(text).not.toContain("Other installed skills");
  });

  it("keeps declared skills listed while the install catalog is unknown", () => {
    // The work-map declares these whether or not skills.status answered, so the
    // rows stay; only the "not installed" verdict waits for a clean load, since
    // an empty catalog during loading means unknown rather than absent.
    const container = renderInto(
      createProps({
        section: "skills",
        skills: [],
        treeDetail: TREE,
        catalogPhase: "loading",
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("ticket-triage");
    expect(text).toContain("summarize");
    expect(text).not.toContain("not installed");
  });

  it("marks a declared skill missing once the catalog answered cleanly", () => {
    const container = renderInto(
      createProps({
        section: "skills",
        skills: [skill("summarize")],
        treeDetail: TREE,
        catalogPhase: "ready",
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("ticket-triage");
    expect(text).toContain("not installed");
  });
});

describe("enterprise Worktree step bindings (browser)", () => {
  it("offers tool, skill, and knowledge binding on the selected step", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        skills: [skill("summarize")],
        foundations: [],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("ontology.allowedTools");
    expect(text).toContain("ontology.skills");
    expect(text).toContain("ontology.knowledgeFoundations");
    // Declared values render, and the ones nothing provides are marked so the
    // operator can tell a resolved dependency from a dangling one.
    expect(text).toContain("ticket-triage");
    // Both catalogs are agent/tree scoped; the section names the agent and the
    // knowledge badge names the work-map.
    expect(text).toContain("agent main");
    expect(text).toContain("not installed");
    expect(text).toContain("not retrievable by this work-map");
    // One Add per binding row.
    const addButtons = [...container.querySelectorAll("button")].filter((button) =>
      button.textContent?.trim().startsWith("Add"),
    );
    expect(addButtons.length).toBeGreaterThanOrEqual(3);
  });

  it("treats a foundation owned by another work-map as unavailable here", () => {
    const foundation = (id: string, ownerTreeIds?: string[]) => ({
      id,
      kind: "remote" as const,
      displayName: id,
      referencedBy: [],
      ...(ownerTreeIds ? { ownerTreeIds } : {}),
    });
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        // Retrieval resolves a bundle foundation only for its owning tree, so this
        // id existing in the registry does not make it reachable from acme.support.
        foundations: [foundation("acme.kb", ["other.tree"])],
      }),
    );
    expect(container.textContent ?? "").toContain("not retrievable by this work-map");

    const owned = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        foundations: [foundation("acme.kb", [TREE.id])],
      }),
    );
    expect(owned.textContent ?? "").not.toContain("not retrievable by this work-map");
  });

  it("does not scope by ownership a legacy gateway cannot report", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        // No ownerTreeIds: a gateway older than the field. Unknown is not global,
        // so the value stays suggestible but is never called unavailable.
        foundations: [{ id: "acme.kb", kind: "remote", displayName: "acme.kb", referencedBy: [] }],
      }),
    );
    expect(container.textContent ?? "").not.toContain("not retrievable by this work-map");
  });

  it("shows a failed catalog load instead of leaving the rows silently empty", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        catalogErrors: { tools: null, skills: null, foundations: "foundations unavailable" },
      }),
    );
    expect(container.textContent ?? "").toContain("foundations unavailable");
  });

  it("does not call a value missing when its catalog failed to load", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        // Empty lists here mean "unknown", not "nothing installed/registered".
        catalogErrors: { tools: null, skills: "boom", foundations: "boom" },
      }),
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("not installed");
    expect(text).not.toContain("not retrievable by this work-map");
  });

  it("shows the ancestor gate when a parent step carries its own allowlist", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
      }),
    );
    // The root declares allowedTools, so a grant on the child is still gated by it.
    expect(container.textContent ?? "").toContain("Parent steps (support)");
  });

  it("renders no binding form without a selected step", () => {
    const container = renderInto(
      createProps({ section: "worktree", selectedTreeId: TREE.id, treeDetail: TREE }),
    );
    expect(container.textContent ?? "").not.toContain("ontology.allowedTools");
  });
});
