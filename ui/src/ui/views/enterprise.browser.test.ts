// Control UI tests cover the enterprise Tools/Skills catalogs and step bindings.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { EnterpriseTreeDetail } from "../../../../packages/gateway-protocol/src/index.js";
import type { SkillStatusEntry } from "../types.ts";
import { renderEnterprise, type EnterpriseProps } from "./enterprise.ts";

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
