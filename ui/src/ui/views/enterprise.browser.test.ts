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

/**
 * A two-step work-map with the given root and child bindings.
 *
 * The detail card re-checks that its entry is still declared on the step, so a
 * card test has to hand it a tree that really carries the binding — a fixture
 * that only names the entry in `bindingDetail` renders nothing, which is the
 * stale-entry guard doing its job rather than a broken assertion.
 */
function treeWith(
  rootOntology: Record<string, unknown>,
  childOntology: Record<string, unknown>,
): EnterpriseTreeDetail {
  return {
    ...TREE,
    nodes: [
      { ...TREE.nodes[0], ontology: rootOntology },
      { ...TREE.nodes[1], ontology: childOntology },
    ],
  } as EnterpriseTreeDetail;
}

/** A work-map whose child step declares both AIP verbs over an inherited type. */
const VERB_TREE: EnterpriseTreeDetail = {
  ...TREE,
  nodes: [
    {
      ...TREE.nodes[0],
      ontology: {
        allowedTools: ["message"],
        entities: [
          {
            id: "claim",
            properties: [
              { id: "claim-id", type: "id", primaryKey: true },
              { id: "amount", type: "number" },
            ],
          },
        ],
      },
    },
    {
      ...TREE.nodes[1],
      ontology: {
        actions: [
          {
            id: "approve",
            effects: [{ entity: "claim", kind: "update" }],
            // The identity parameter is what makes the action callable: without
            // it planEffect cannot name the object the write touches.
            parameters: [
              { id: "claim-id", type: "id", required: true },
              { id: "rationale", type: "string" },
            ],
          },
        ],
        functions: [
          { id: "doubled", entity: "claim", expression: "$amount * 2", returns: "number" },
        ],
      },
    },
  ],
} as EnterpriseTreeDetail;

function createProps(overrides: Partial<EnterpriseProps> = {}): EnterpriseProps {
  return {
    section: "tools",
    loading: false,
    mcpServers: [],
    mcpServersKnown: true,
    mcpDraft: null,
    enterpriseMode: "enforce",
    canRegisterMcp: true,
    mcpRegisterBlockedReason: null,
    connected: true,
    configDirty: false,
    configSaving: false,
    configApplying: false,
    onBeginMcpDraft: () => undefined,
    onBeginMcpEdit: () => undefined,
    onEditMcpDraft: () => undefined,
    onEditMcpHeader: () => undefined,
    onAddMcpHeader: () => undefined,
    onCancelMcpDraft: () => undefined,
    onSubmitMcpDraft: () => undefined,
    onToggleMcpServer: () => undefined,
    mcpRemoveConfirm: null,
    onRequestRemoveMcpServer: () => undefined,
    onCancelRemoveMcpServer: () => undefined,
    onConfirmRemoveMcpServer: () => undefined,
    onSaveConfig: () => undefined,
    onApplyConfig: () => undefined,
    runs: [],
    trees: [],
    importErrors: [],
    storeError: null,
    selectedExecutionId: null,
    detail: null,
    detailLoading: false,
    runTree: null,
    resuming: false,
    onResumeRun: () => {},
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
    onToggleCapabilityGrants: () => undefined,
    onBeginAddNode: () => undefined,
    onEditNodeDraft: () => undefined,
    onCancelAddNode: () => undefined,
    onSubmitAddNode: () => undefined,
    bindingPicker: null,
    onOpenBindingPicker: () => undefined,
    onRemoveBinding: () => undefined,
    bindingDetail: null,
    onOpenBindingDetail: () => undefined,
    onCloseBindingDetail: () => undefined,
    guidanceDraft: null,
    onGuidanceDraft: () => undefined,
    onSaveGuidance: () => undefined,
    onCancelGuidance: () => undefined,
    ontologyDraft: null,
    onOntologyDraft: () => undefined,
    onEditOntologyDraft: () => undefined,
    onSubmitOntologyDraft: () => undefined,
    onCancelOntologyDraft: () => undefined,
    onRemoveOntologyEntity: () => undefined,
    onRemoveOntologyProperty: () => undefined,
    onRemoveOntologyRelationship: () => undefined,
    onRemoveOntologyAction: () => undefined,
    onRemoveOntologyActionEffect: () => undefined,
    onRemoveOntologyActionParameter: () => undefined,
    onRemoveOntologyFunction: () => undefined,
    onBindingPickerQuery: () => undefined,
    onBindingPickerCustom: () => undefined,
    onToggleBindingPickerValue: () => undefined,
    onCancelBindingPicker: () => undefined,
    onSubmitBindingPicker: () => undefined,
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

describe("enterprise capability grants (browser)", () => {
  const EXPLICIT_TREE = { ...TREE, capabilityGrants: "explicit" } as EnterpriseTreeDetail;

  it("names the work-map's grant mode on Worktree and offers the switch", () => {
    const container = renderInto(
      createProps({ section: "worktree", selectedTreeId: TREE.id, treeDetail: TREE }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Inherited scopes");
    expect(text).toContain("Grant explicitly");
  });

  it("hides the switch without admin", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        canEdit: false,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Inherited scopes");
    expect(text).not.toContain("Grant explicitly");
  });

  it("tells the Tools and Skills catalogs that everything unattached is denied", () => {
    const tools = renderInto(
      createProps({ section: "tools", treeDetail: EXPLICIT_TREE, toolGroups: [] }),
    );
    expect(tools.textContent ?? "").toContain("grants tools explicitly");
    const skills = renderInto(
      createProps({ section: "skills", treeDetail: EXPLICIT_TREE, skills: [skill("summarize")] }),
    );
    expect(skills.textContent ?? "").toContain("grants skills explicitly");
  });

  it("claims no restriction while enterprise is only observing", () => {
    // Observe records without blocking, so promising "denied" would describe a
    // rule the runtime is not applying.
    const container = renderInto(
      createProps({ section: "tools", treeDetail: EXPLICIT_TREE, enterpriseMode: "observe" }),
    );
    expect(container.textContent ?? "").not.toContain("grants tools explicitly");
  });

  it("tells a step with no tools that using one needs approval, not that it is unrestricted", () => {
    // The inherited default warns that the first entry NARROWS the step. Under
    // explicit grants the opposite is true: nothing is granted until something is
    // listed, and reaching outside that raises a one-off approval rather than
    // running. The operator must not be shown a stricter boundary than the runtime
    // enforces, nor a looser one.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: EXPLICIT_TREE.id,
        treeDetail: EXPLICIT_TREE,
        selectedNodeId: "support.triage",
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("needs a one-off approval");
    expect(text).not.toContain("it allows every tool except any it denies");
  });

  it("does not claim a step has no knowledge when an ancestor granted one", () => {
    // support.triage lists a foundation itself; a child of a granting step would
    // inherit it, so the ungranted warning must not fire on inheritance.
    const inheritingTree = {
      ...EXPLICIT_TREE,
      nodes: [
        ...EXPLICIT_TREE.nodes,
        {
          id: "support.triage.child",
          parentId: "support.triage",
          depth: 2,
          title: "Child",
          ontology: {},
        },
      ],
    } as EnterpriseTreeDetail;
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: inheritingTree.id,
        treeDetail: inheritingTree,
        selectedNodeId: "support.triage.child",
      }),
    );

    expect(container.textContent ?? "").not.toContain("queries no foundation until one is listed");
  });

  it("warns about knowledge in observe mode too, where that grant still applies", () => {
    // The tool/skill/MCP grants are enforce-only, but the knowledge grant applies
    // while observing as well — claiming "every registered foundation" there
    // would be the opposite of what the run does.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: EXPLICIT_TREE.id,
        treeDetail: EXPLICIT_TREE,
        selectedNodeId: "support",
        enterpriseMode: "observe",
      }),
    );

    expect(container.textContent ?? "").toContain("queries no foundation until one is listed");
  });

  it("still warns when two ancestors' lists leave the step nothing", () => {
    // Every non-empty level is an independent gate: a root granting A and a
    // parent granting B leaves the child with neither, so the union would claim
    // access the runtime refuses.
    const disjointTree = {
      ...EXPLICIT_TREE,
      nodes: [
        { ...EXPLICIT_TREE.nodes[0], ontology: { knowledgeFoundations: ["acme.a"] } },
        {
          id: "support.triage",
          parentId: "support",
          depth: 1,
          title: "Triage",
          ontology: { knowledgeFoundations: ["acme.b"] },
        },
        {
          id: "support.triage.child",
          parentId: "support.triage",
          depth: 2,
          title: "Child",
          ontology: {},
        },
      ],
    } as EnterpriseTreeDetail;
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: disjointTree.id,
        treeDetail: disjointTree,
        selectedNodeId: "support.triage.child",
      }),
    );

    expect(container.textContent ?? "").toContain("queries no foundation until one is listed");
  });

  it("treats an explicit work-map as governing MCP even with no attachment", () => {
    const container = renderInto(
      createProps({ section: "mcp", treeDetail: EXPLICIT_TREE, mcpServers: [] }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("A server no step attaches is registered and unreachable.");
    expect(text).not.toContain("does not govern MCP yet");
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

  it("renders the ontology editor with its own sections, not as bindings", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Object types");
    expect(text).toContain("Links");
    // Its own class: an object type is not a capability grant, and the binding
    // rows are counted elsewhere.
    expect(container.querySelectorAll(".ontology-group").length).toBeGreaterThan(0);
  });

  it("renders the AIP verbs the model can call, with the effects that authorize them", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: VERB_TREE.id,
        treeDetail: VERB_TREE,
        selectedNodeId: "support.triage",
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Actions");
    expect(text).toContain("update claim");
    expect(text).toContain("rationale: string");
    expect(text).toContain("Derived values");
    // The expression, not just the id: it is what the function actually computes.
    expect(text).toContain("$amount * 2");
  });

  it("keeps the callout until a write effect also has its identity parameter", () => {
    // `validateParameters` refuses an undeclared key while `planEffect` requires
    // it, so an action with a write effect and no key parameter is still
    // uncallable — clearing the warning there would call it finished halfway.
    const keyless = {
      ...VERB_TREE,
      nodes: VERB_TREE.nodes.map((node) =>
        node.id === "support.triage"
          ? {
              ...node,
              ontology: {
                ...node.ontology,
                actions: [
                  {
                    id: "approve",
                    effects: [{ entity: "claim", kind: "update" }],
                    parameters: [{ id: "rationale", type: "string" }],
                  },
                ],
              },
            }
          : node,
      ),
    } as EnterpriseTreeDetail;
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: keyless.id,
        treeDetail: keyless,
        selectedNodeId: "support.triage",
      }),
    );
    expect(container.textContent ?? "").toContain("cannot be called yet");
  });

  it("flags an effect on a type only a sibling branch declares", () => {
    // The import validates effects tree-wide, but no scope this action executes
    // in ever contains that type, so planEffect refuses every call.
    const siblingOnly = {
      ...VERB_TREE,
      nodes: [
        ...VERB_TREE.nodes.map((node) =>
          node.id === "support.triage"
            ? {
                ...node,
                ontology: {
                  ...node.ontology,
                  actions: [
                    {
                      id: "approve",
                      effects: [{ entity: "invoice", kind: "update" }],
                      parameters: [{ id: "invoice-id", type: "id", required: true }],
                    },
                  ],
                },
              }
            : node,
        ),
        {
          id: "support.billing",
          parentId: "support",
          depth: 1,
          title: "Billing",
          ontology: {
            entities: [
              { id: "invoice", properties: [{ id: "invoice-id", type: "id", primaryKey: true }] },
            ],
          },
        },
      ],
    } as EnterpriseTreeDetail;
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: siblingOnly.id,
        treeDetail: siblingOnly,
        selectedNodeId: "support.triage",
      }),
    );
    expect(container.textContent ?? "").toContain("cannot be called yet");
  });

  it("keeps the callout when a create leaves a required property unparameterized", () => {
    // planEffect refuses a create that leaves any required property unset, and
    // only a parameter can supply one — so the action fails every call.
    const requiredMissing = {
      ...VERB_TREE,
      nodes: VERB_TREE.nodes.map((node) => {
        if (node.id === "support") {
          return {
            ...node,
            ontology: {
              ...node.ontology,
              entities: [
                {
                  id: "claim",
                  properties: [
                    { id: "claim-id", type: "id", primaryKey: true },
                    { id: "amount", type: "number", required: true },
                  ],
                },
              ],
            },
          };
        }
        return node.id === "support.triage"
          ? {
              ...node,
              ontology: {
                ...node.ontology,
                actions: [
                  {
                    id: "open",
                    effects: [{ entity: "claim", kind: "create" }],
                    parameters: [{ id: "claim-id", type: "id", required: true }],
                  },
                ],
              },
            }
          : node;
      }),
    } as EnterpriseTreeDetail;
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: requiredMissing.id,
        treeDetail: requiredMissing,
        selectedNodeId: "support.triage",
      }),
    );
    expect(container.textContent ?? "").toContain("cannot be called yet");
  });

  it("clears the callout once the identity parameter is declared", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: VERB_TREE.id,
        treeDetail: VERB_TREE,
        selectedNodeId: "support.triage",
      }),
    );
    expect(container.textContent ?? "").not.toContain("cannot be called yet");
  });

  it("calls out an action that declares no write effect, since the write path refuses it", () => {
    const readOnly = {
      ...VERB_TREE,
      nodes: VERB_TREE.nodes.map((node) =>
        node.id === "support.triage"
          ? { ...node, ontology: { ...node.ontology, actions: [{ id: "approve" }] } }
          : node,
      ),
    } as EnterpriseTreeDetail;
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: readOnly.id,
        treeDetail: readOnly,
        selectedNodeId: "support.triage",
      }),
    );
    expect(container.textContent ?? "").toContain("cannot be called yet");
  });

  it("seeds an effect form from the object types the step can actually address", () => {
    const opened: unknown[] = [];
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: VERB_TREE.id,
        treeDetail: VERB_TREE,
        selectedNodeId: "support.triage",
        onOntologyDraft: (draft) => opened.push(draft),
      }),
    );
    const addEffect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add effect",
    );
    expect(addEffect).toBeDefined();
    addEffect?.click();
    expect(opened).toEqual([
      {
        kind: "action-effect",
        nodeId: "support.triage",
        actionId: "approve",
        entity: "claim",
        effectKind: "update",
      },
    ]);
  });

  it("opens one ontology form at a time and reports the id contract", () => {
    const opened: unknown[] = [];
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        onOntologyDraft: (draft) => opened.push(draft),
      }),
    );
    const addEntity = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add object type",
    );
    expect(addEntity).toBeDefined();
    addEntity?.click();
    expect(opened).toEqual([{ kind: "entity", nodeId: "support.triage", id: "", title: "" }]);

    // With a draft open, the form shows — and an invalid id explains the rule
    // rather than failing silently at import time.
    const withDraft = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        ontologyDraft: {
          kind: "entity",
          treeId: TREE.id,
          nodeId: "support.triage",
          id: "not valid!",
          title: "",
          error: "invalid-id",
        },
      }),
    );
    expect(withDraft.textContent ?? "").toContain("Object type id");
    expect(withDraft.textContent ?? "").toContain("lowercase letters");
  });

  it("offers Add per binding kind and no inline text field", () => {
    // The old flow put a text input under each row; picking from a catalog of
    // hundreds belongs in a dialog, so the inspector only carries the buttons.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        skills: [skill("summarize")],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Tools");
    expect(text).toContain("Skills");
    expect(text).toContain("Knowledge");
    expect(text).toContain("MCP servers");
    // Every row names the definition key it writes, so the screen maps onto the
    // file an operator would otherwise edit by hand.
    expect(text).toContain("ontology.allowedTools");
    expect(text).toContain("ontology.deniedTools");
    expect(container.querySelectorAll(".binding-group").length).toBe(5);
    expect(container.querySelector(".binding-group input")).toBeNull();
    // Structural edits live in their own block, not as a fifth binding.
    expect(container.querySelector('.node-section[data-kind="structure"]')).not.toBeNull();
  });

  it("gives each capability kind its own block instead of one flat run of rows", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
      }),
    );
    const kinds = [...container.querySelectorAll(".node-section")].map((section) =>
      section.getAttribute("data-kind"),
    );
    // Allow and deny share the tools block: they are one decision over one
    // catalog, so there is no separate denial section.
    expect(kinds).toEqual([
      "prompt",
      "structure",
      "tools",
      "skills",
      "mcp",
      "knowledge",
      "ontology",
    ]);
    expect(
      container.querySelectorAll('.node-section[data-kind="tools"] .binding-group').length,
    ).toBe(2);
    for (const kind of ["skills", "mcp", "knowledge"]) {
      expect(
        container.querySelectorAll(`.node-section[data-kind="${kind}"] .binding-group`).length,
      ).toBe(1);
    }
  });

  it("puts the role prompt and the sub-step control above the capability blocks", () => {
    // What the step IS and what sits under it are the two shortest decisions on
    // the screen; behind the capability and ontology blocks they took the most
    // scrolling to reach.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
      }),
    );
    const blocks = [
      '.node-section[data-kind="prompt"]',
      '.node-section[data-kind="structure"]',
      '.node-section[data-kind="tools"]',
      '.node-section[data-kind="ontology"]',
    ].map((selector) => container.querySelector(selector));
    for (const block of blocks) {
      expect(block).not.toBeNull();
    }
    // Document order, not just presence: the point of the change is where these
    // sit relative to each other.
    const all = [...container.querySelectorAll("*")];
    const positions = blocks.map((block) => all.indexOf(block as Element));
    expect(positions).toEqual([...positions].toSorted((left, right) => left - right));
  });

  it("states the ontology scope once, not on the section and again on its editor", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
      }),
    );
    const scopeNote = "A step can address the types declared here";
    const text = container.textContent ?? "";
    expect(text.split(scopeNote).length - 1).toBe(1);
  });

  it("opens a detail card from the clicked chip, naming the entry and its step", () => {
    const opened: unknown[] = [];
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        onOpenBindingDetail: (detail) => opened.push(detail),
      }),
    );
    const chip = container.querySelector(".chip-open") as HTMLButtonElement | null;
    expect(chip).not.toBeNull();
    chip?.click();
    expect(opened).toEqual([
      { nodeId: "support.triage", field: "skills", entry: "ticket-triage", origin: "step" },
    ]);
  });

  it("shows a failed catalog load inside the dialog, not a forever-loading line", () => {
    // The error banner lives behind the modal, so reporting a failed load as
    // "still loading" leaves the operator watching a card that never fills in.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        catalogPhase: "ready",
        catalogErrors: { tools: null, skills: "skills catalog exploded", foundations: null },
        bindingDetail: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "skills",
          entry: "ticket-triage",
          origin: "step",
        },
      }),
    );
    const text = container.querySelector(".binding-detail")?.textContent ?? "";
    expect(text).toContain("skills catalog exploded");
    expect(text).not.toContain("has not loaded");
  });

  it("closes itself when a reload removed the entry it describes", () => {
    // A reconnect reloads the same tree but keeps the node selection, so the card
    // can outlive its binding — and would offer Detach for one that is gone.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        bindingDetail: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "skills",
          entry: "detached-elsewhere",
          origin: "step",
        },
      }),
    );
    expect(container.querySelector(".binding-detail")).toBeNull();
  });

  it("does not treat an inherited entry as this step's own", () => {
    // `message` is the ROOT's grant. Recorded as origin "step" it is not in this
    // step's own list, so the card must not render it with a Detach.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        bindingDetail: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "allowedTools",
          entry: "message",
          origin: "step",
        },
      }),
    );
    expect(container.querySelector(".binding-detail")).toBeNull();
  });

  it("describes a named tool from the catalog and defers the reach to the runtime", () => {
    // The card reports catalog facts. What an entry actually reaches is settled by
    // governance — path policies, the deny matcher, MCP ownership, the
    // step-advance carve-out, the explicit-grant floor — and a second copy of that
    // here would drift from it, so a selector gets no invented verdict.
    const tree = treeWith({}, { allowedTools: ["read", "group:enterprise"] });
    const base = {
      section: "worktree" as const,
      selectedTreeId: tree.id,
      treeDetail: tree,
      selectedNodeId: "support.triage",
      catalogPhase: "ready" as const,
      toolGroups: [toolGroup("fs", "Files", ["read"])],
    };
    const named = renderInto(
      createProps({
        ...base,
        bindingDetail: {
          treeId: tree.id,
          nodeId: "support.triage",
          field: "allowedTools",
          entry: "read",
          origin: "step",
        },
      }),
    );
    const namedText = named.querySelector(".binding-detail")?.textContent ?? "";
    expect(namedText).toContain("Files");
    expect(namedText).toContain("core");

    const selector = renderInto(
      createProps({
        ...base,
        bindingDetail: {
          treeId: tree.id,
          nodeId: "support.triage",
          field: "allowedTools",
          entry: "group:enterprise",
          origin: "step",
        },
      }),
    );
    const selectorText = selector.querySelector(".binding-detail")?.textContent ?? "";
    expect(selectorText).toContain("decided when the run starts");
  });

  it("says a declared skill resolves to nothing once the skill catalog answered", () => {
    const detail = {
      treeId: TREE.id,
      nodeId: "support.triage",
      field: "skills" as const,
      entry: "ticket-triage",
      origin: "step" as const,
    };
    const known = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        catalogPhase: "ready",
        skills: [skill("summarize")],
        bindingDetail: detail,
      }),
    );
    // Agent-qualified: the skill set is agent-scoped and the page-level scope
    // banner is hidden behind this modal.
    expect(known.querySelector(".binding-detail")?.textContent ?? "").toContain(
      "installed for agent main",
    );

    // A catalog that failed also returns an empty list, and calling the entry
    // missing on that accuses an install that may well provide it.
    const unknown = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        catalogPhase: "ready",
        catalogErrors: { tools: null, skills: "boom", foundations: null },
        bindingDetail: detail,
      }),
    );
    expect(unknown.querySelector(".binding-detail")?.textContent ?? "").not.toContain(
      "installed for agent",
    );
  });

  it("keeps alternative skill requirements out of the mandatory list", () => {
    // `anyBins` and `os` are satisfied by any one member; listing them beside
    // `bins` would present alternatives as prerequisites.
    const tree = treeWith({}, { skills: ["summarize"] });
    const alt = {
      ...skill("summarize"),
      requirements: {
        bins: ["git"],
        anyBins: ["bun", "deno"],
        env: [],
        config: [],
        os: ["darwin", "linux"],
      },
    };
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: tree.id,
        treeDetail: tree,
        selectedNodeId: "support.triage",
        catalogPhase: "ready",
        skills: [alt],
        bindingDetail: {
          treeId: tree.id,
          nodeId: "support.triage",
          field: "skills",
          entry: "summarize",
          origin: "step",
        },
      }),
    );
    const text = container.querySelector(".binding-detail")?.textContent ?? "";
    expect(text).toContain("Requires any one of");
    expect(text).toContain("Runs on any of");
  });

  it("shows the transport a server is configured with, not the list badge family", () => {
    // The list badge collapses sse and streamable-http into "http"; neither is
    // what config says, and the two behave differently at run time.
    const tree = treeWith({}, { mcpServers: ["jira"] });
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: tree.id,
        treeDetail: tree,
        selectedNodeId: "support.triage",
        mcpServers: [
          {
            name: "jira",
            enabled: true,
            transport: "http",
            configuredTransport: "sse",
            auth: null,
            launch: "https://jira.test/mcp",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
        ],
        bindingDetail: {
          treeId: tree.id,
          nodeId: "support.triage",
          field: "mcpServers",
          entry: "jira",
          origin: "step",
        },
      }),
    );
    const text = container.querySelector(".binding-detail")?.textContent ?? "";
    expect(text).toContain("sse");
  });

  it("offers no Detach on an inherited entry, since it belongs to the ancestor", () => {
    // Denials are one of the two rows that render inherited chips at all, so an
    // ancestor denial is what an operator can actually click here.
    const tree = treeWith({ deniedTools: ["exec"] }, {});
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: tree.id,
        treeDetail: tree,
        selectedNodeId: "support.triage",
        bindingDetail: {
          treeId: tree.id,
          nodeId: "support.triage",
          field: "deniedTools",
          entry: "exec",
          origin: "inherited",
        },
      }),
    );
    const card = container.querySelector(".binding-detail");
    expect(card?.querySelector("button.danger")).toBeNull();
    expect(card?.textContent ?? "").toContain("A parent step");
  });

  it("drops a detail card left open for another work-map", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        bindingDetail: {
          treeId: "other.tree",
          nodeId: "support.triage",
          field: "skills",
          entry: "ticket-triage",
          origin: "step",
        },
      }),
    );
    expect(container.querySelector(".binding-detail")).toBeNull();
  });

  it("searches the catalog in a dialog and confirms the picks", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        skills: [skill("summarize"), skill("weather")],
        bindingPicker: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "skills",
          query: "weath",
          selected: ["weather"],
          custom: "",
          phase: "idle",
          failure: null,
        },
      }),
    );
    const dialog = container.querySelector("openclaw-modal-dialog");
    expect(dialog).not.toBeNull();
    const text = dialog?.textContent ?? "";
    // Filtered by the query, and the already-declared summarize is not offered
    // again — adding a duplicate is what the import rejects.
    expect(text).toContain("weather");
    expect(text).not.toContain("summarize");
    expect(text).toContain("Add 1");
  });

  it("shows the server's rejection paths inside the dialog", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        bindingPicker: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "skills",
          query: "",
          selected: ["weather"],
          custom: "",
          phase: "idle",
          failure: {
            kind: "import-rejected",
            issues: [{ path: "root.ontology.skills.0", message: "unknown skill" }],
          },
        },
      }),
    );
    const text = container.querySelector("openclaw-modal-dialog")?.textContent ?? "";
    // The path is the actionable part; a rejection without it leaves the operator
    // with a refusal and nothing to change.
    expect(text).toContain("root.ontology.skills.0");
    expect(text).toContain("unknown skill");
  });

  it("closes the dialog when the session loses admin access", () => {
    // An import is admin-only. A reconnect can drop operator.admin while this is
    // open, and leaving it up offers a Confirm the server can only refuse.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        canEdit: false,
        bindingPicker: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "skills",
          query: "",
          selected: ["weather"],
          custom: "",
          phase: "idle",
          failure: null,
        },
      }),
    );
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("credits an ancestor's MCP attachment on the selected leaf", () => {
    // Governance grants an attachment down the branch, so a leaf with no local
    // mcpServers is not server-less — saying it can call none would contradict
    // what the run allows.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: {
          ...TREE,
          nodes: [
            { ...TREE.nodes[0], ontology: { mcpServers: ["acme-tracker"] } },
            { ...TREE.nodes[1] },
          ],
        },
        selectedNodeId: "support.triage",
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Inherited from a parent step:");
    expect(text).toContain("acme-tracker");
    expect(text).not.toContain("no MCP server attached");
  });

  it("shows the MCP picker as loading until config arrives", () => {
    // Config is a request too, and the worktree is interactive before it lands —
    // an empty list then is "not here yet", not "nothing registered".
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        mcpServers: [],
        mcpServersKnown: false,
        bindingPicker: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "mcpServers",
          query: "",
          selected: [],
          custom: "",
          phase: "idle",
          failure: null,
        },
      }),
    );
    const text = container.querySelector("openclaw-modal-dialog")?.textContent ?? "";
    expect(text).not.toContain("No MCP servers are registered");
  });

  it("keeps the MCP picker usable while another catalog is failing", () => {
    // MCP options come from config, so a foundations failure is not this picker's
    // failure — and reporting it here sends the operator after the wrong problem.
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        catalogPhase: "unloaded",
        catalogErrors: { tools: null, skills: null, foundations: "foundations exploded" },
        mcpServers: [
          {
            name: "acme-tracker",
            enabled: true,
            transport: "stdio",
            configuredTransport: null,
            auth: null,
            launch: "npx",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
        ],
        bindingPicker: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "mcpServers",
          query: "",
          selected: [],
          custom: "",
          phase: "idle",
          failure: null,
        },
      }),
    );
    const text = container.querySelector("openclaw-modal-dialog")?.textContent ?? "";
    expect(text).toContain("acme-tracker");
    expect(text).not.toContain("foundations exploded");
  });

  it("holds registration back until the config it writes into has arrived", () => {
    // Starting a draft from an empty config would let Save replace the whole
    // persisted config with just this one entry.
    const container = renderInto(
      createProps({
        section: "mcp",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        canRegisterMcp: false,
        mcpRegisterBlockedReason: "Loading the gateway config",
      }),
    );
    const addButton = [...container.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("Register server"),
    );
    expect(addButton?.hasAttribute("disabled")).toBe(true);
    expect(container.textContent ?? "").toContain("Loading the gateway config");
  });

  it("does not call a server unreachable outside enforce mode", () => {
    // Observe records without blocking and off governs nothing, so the runtime
    // withholds nothing — the screen must not claim otherwise.
    const container = renderInto(
      createProps({
        section: "mcp",
        selectedTreeId: TREE.id,
        enterpriseMode: "observe",
        treeDetail: {
          ...TREE,
          nodes: [
            { ...TREE.nodes[0] },
            { ...TREE.nodes[1], ontology: { mcpServers: ["atlassian"] } },
          ],
        },
        mcpServers: [
          {
            name: "github",
            enabled: true,
            transport: "stdio",
            configuredTransport: null,
            auth: null,
            launch: "npx",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
        ],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("github");
    expect(text).not.toContain("not attached to any step");
  });

  it("shows a registered server as unattached until a step attaches it", () => {
    // The state an operator comes to this screen to check: registered is not
    // reachable, and nothing else on the screen says so.
    const container = renderInto(
      createProps({
        section: "mcp",
        selectedTreeId: TREE.id,
        // The work-map attaches SOMETHING, which is what turns attachment
        // governance on; github is registered but attached nowhere.
        treeDetail: {
          ...TREE,
          nodes: [
            { ...TREE.nodes[0] },
            { ...TREE.nodes[1], ontology: { mcpServers: ["atlassian"] } },
          ],
        },
        mcpServers: [
          {
            name: "github",
            enabled: true,
            transport: "stdio",
            configuredTransport: null,
            auth: null,
            launch: "npx",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
        ],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("github");
    expect(text).toContain("not attached to any step");
  });

  it("does not call an attachment unregistered before config arrives", () => {
    // An empty registry before `config.get` answers is UNKNOWN: accusing the
    // attachment would blame a server the gateway may well have.
    const container = renderInto(
      createProps({
        section: "mcp",
        selectedTreeId: TREE.id,
        treeDetail: {
          ...TREE,
          nodes: [
            { ...TREE.nodes[0] },
            { ...TREE.nodes[1], ontology: { mcpServers: ["atlassian"] } },
          ],
        },
        mcpServers: [],
        mcpServersKnown: false,
      }),
    );
    expect(container.textContent ?? "").not.toContain("not registered in mcp.servers");
  });

  it("lists a server the work-map attaches but config does not register", () => {
    // The attachment is inert — nothing launches under that name — so it has to
    // be visible rather than silently dropped.
    const container = renderInto(
      createProps({
        section: "mcp",
        selectedTreeId: TREE.id,
        treeDetail: {
          ...TREE,
          nodes: [
            { ...TREE.nodes[0] },
            { ...TREE.nodes[1], ontology: { mcpServers: ["atlassian"] } },
          ],
        },
        mcpServers: [],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("atlassian");
    expect(text).toContain("not registered in mcp.servers");
  });

  it("counts a custom tool value in the confirm button", () => {
    const container = renderInto(
      createProps({
        section: "worktree",
        selectedTreeId: TREE.id,
        treeDetail: TREE,
        selectedNodeId: "support.triage",
        bindingPicker: {
          treeId: TREE.id,
          nodeId: "support.triage",
          field: "allowedTools",
          query: "",
          selected: [],
          custom: "memory_*",
          phase: "idle",
          failure: null,
        },
      }),
    );
    // A glob-only submit still adds one entry, so the button must not say "Add 0".
    expect(container.querySelector("openclaw-modal-dialog")?.textContent ?? "").toContain("Add 1");
  });

  it("keeps a typed entry for every binding kind", () => {
    const withField = (field: "allowedTools" | "skills") =>
      renderInto(
        createProps({
          section: "worktree",
          selectedTreeId: TREE.id,
          treeDetail: TREE,
          selectedNodeId: "support.triage",
          bindingPicker: {
            treeId: TREE.id,
            nodeId: "support.triage",
            field,
            query: "",
            selected: [],
            custom: "",
            phase: "idle",
            failure: null,
          },
        }),
      );
    // Tools need it for globs and groups; skills and foundations need it because
    // this catalog answered for one agent and a work-map can govern others.
    expect(withField("allowedTools").querySelector(".binding-picker__custom")).not.toBeNull();
    expect(withField("skills").querySelector(".binding-picker__custom")).not.toBeNull();
  });

  it("tells the operator which empty state they are in", () => {
    const pick = (over: Partial<EnterpriseProps>) =>
      renderInto(
        createProps({
          section: "worktree",
          selectedTreeId: TREE.id,
          treeDetail: TREE,
          selectedNodeId: "support.triage",
          bindingPicker: {
            treeId: TREE.id,
            nodeId: "support.triage",
            field: "skills",
            query: "",
            selected: [],
            custom: "",
            phase: "idle",
            failure: null,
          },
          ...over,
        }),
      ).querySelector("openclaw-modal-dialog")?.textContent ?? "";

    // A still-loading catalog must not be reported as an exhausted one.
    expect(pick({ catalogPhase: "loading", skills: [] })).toContain("Loading");
    // Nor must a failed one — the banner behind the modal is not visible.
    expect(
      pick({
        skills: [],
        catalogErrors: { tools: null, skills: "skills unavailable", foundations: null },
      }),
    ).toContain("skills unavailable");
    // A ready but empty deployment is different from "already added".
    expect(pick({ skills: [] })).toContain("none to offer");
  });

  it("renders no binding form without a selected step", () => {
    const container = renderInto(
      createProps({ section: "worktree", selectedTreeId: TREE.id, treeDetail: TREE }),
    );
    expect(container.textContent ?? "").not.toContain("ontology.allowedTools");
  });
});

describe("enterprise MCP registration form (browser)", () => {
  function draft(overrides: Partial<NonNullable<EnterpriseProps["mcpDraft"]>> = {}) {
    return {
      editing: null,
      editingSnapshot: null,
      mode: "fields" as const,
      name: "",
      transport: "stdio" as const,
      command: "",
      args: "",
      argsOriginal: null,
      url: "",
      urlStored: false,
      headers: [],
      oauth: false,
      json: "",
      error: null,
      ...overrides,
    };
  }

  it("offers both halves of the form", () => {
    const container = renderInto(createProps({ section: "mcp", canEdit: true, mcpDraft: draft() }));

    expect(container.textContent).toContain("Type it");
    expect(container.textContent).toContain("Paste JSON");
    // The typed half is the default, so its fields are the ones on screen.
    expect(container.textContent).toContain("Command");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("previews what a pasted snippet would register", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: draft({
          mode: "json",
          json: JSON.stringify({
            mcpServers: {
              github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
              remote: { url: "https://mcp.acme.dev" },
            },
          }),
        }),
      }),
    );

    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.textContent).toContain("github");
    expect(container.textContent).toContain("remote");
    // The transport the import DECIDED is named, because the paste did not.
    expect(container.textContent).toContain("Registered as streamable-http");
  });

  it("says nothing about a half-typed paste", () => {
    // Flagging every keystroke as a parse error would be noise; the refusal is
    // the submit path's to report.
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: draft({ mode: "json", json: "{ mcp" }),
      }),
    );

    expect(container.querySelector(".callout.danger")).toBeNull();
  });

  it("names the snippet entry a refusal was about", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: draft({
          mode: "json",
          json: "{}",
          error: "json-entry-launchless",
          errorDetail: "broken",
        }),
      }),
    );

    expect(container.textContent).toContain("broken");
  });
});

describe("enterprise MCP registry controls (browser)", () => {
  const SERVER = {
    name: "acme-remote",
    enabled: true,
    transport: "http" as const,
    configuredTransport: null,
    auth: "oauth",
    launch: "https://mcp.acme.dev",
    toolFilter: false,
    parallel: false,
    tls: null,
  };

  it("summarizes the registry and offers per-server controls to an admin", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpServers: [SERVER],
        mcpServersKnown: true,
      }),
    );

    expect(container.textContent).toContain("Servers");
    expect(container.textContent).toContain("Remote");
    expect(container.textContent).toContain("Edit");
    expect(container.textContent).toContain("Disable");
    expect(container.textContent).toContain("Remove");
    // The auth mode is on the row, because it is what makes a hosted server
    // reachable and is otherwise invisible until a call fails.
    expect(container.textContent).toContain("oauth");
  });

  it("shows no controls to a read-only operator", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: false,
        mcpServers: [SERVER],
        mcpServersKnown: true,
      }),
    );

    expect(container.textContent).not.toContain("Disable");
    expect(container.textContent).not.toContain("Remove");
  });

  it("offers header and OAuth fields once the transport is remote", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: {
          editing: "acme-remote",
          editingSnapshot: null,
          mode: "fields",
          name: "acme-remote",
          transport: "streamable-http",
          command: "",
          args: "",
          argsOriginal: null,
          url: "https://mcp.acme.dev",
          urlStored: false,
          headers: [{ name: "Authorization", value: "", stored: true }],
          oauth: false,
          json: "",
          error: null,
        },
      }),
    );

    expect(container.textContent).toContain("Edit acme-remote");
    expect(container.textContent).toContain("Request headers");
    expect(container.textContent).toContain("Authenticate with OAuth");
    // A stored header reads as unchanged rather than as dots standing in for a
    // value the browser was never given.
    const value = container.querySelector('input[type="password"]');
    expect(value?.getAttribute("placeholder")).toBe("Unchanged");
    expect((value as HTMLInputElement | null)?.value).toBe("");
  });

  it("keeps auth fields off a stdio server, which takes credentials from env", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: {
          editing: null,
          editingSnapshot: null,
          mode: "fields",
          name: "",
          transport: "stdio",
          command: "",
          args: "",
          argsOriginal: null,
          url: "",
          urlStored: false,
          headers: [],
          oauth: false,
          json: "",
          error: null,
        },
      }),
    );

    expect(container.textContent).not.toContain("Request headers");
  });

  it("names the server a removal would drop", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpServers: [SERVER],
        mcpServersKnown: true,
        mcpRemoveConfirm: "acme-remote",
      }),
    );

    expect(container.textContent).toContain("Remove acme-remote?");
    expect(container.textContent).toContain("their attachments become inert");
  });
});

describe("enterprise MCP summary accuracy (browser)", () => {
  function statValue(container: HTMLElement, label: string): string | undefined {
    return [...container.querySelectorAll(".stat")]
      .find((tile) => tile.querySelector(".stat-label")?.textContent?.trim() === label)
      ?.querySelector(".stat-value")
      ?.textContent?.trim();
  }

  it("excludes launchless entries from Remote and disabled ones from Reachable", () => {
    // An `invalid` row is a schema-valid entry with no launch rather than an
    // HTTP server, and both runtimes drop disabled servers before
    // materialization — so neither belongs in the count it would inflate.
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpServersKnown: true,
        enterpriseMode: "enforce",
        treeDetail: {
          id: "acme.support",
          version: "1",
          source: "imported",
          name: "Support",
          capabilityGrants: "explicit",
          nodes: [
            {
              id: "root",
              title: "Root",
              parentId: null,
              depth: 0,
              ontology: { mcpServers: ["off", "live"] },
            },
          ],
        },
        mcpServers: [
          {
            name: "off",
            enabled: false,
            transport: "http",
            configuredTransport: null,
            auth: null,
            launch: "https://off.dev",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
          {
            name: "live",
            enabled: true,
            transport: "http",
            configuredTransport: null,
            auth: null,
            launch: "https://live.dev",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
          {
            name: "broken",
            enabled: true,
            transport: "invalid",
            configuredTransport: null,
            auth: null,
            launch: "missing transport",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
        ],
      }),
    );

    expect(statValue(container, "Servers")).toBe("3");
    expect(statValue(container, "Enabled")).toBe("2");
    // Remote describes transport kind, so the disabled HTTP server counts and
    // the launchless one does not.
    expect(statValue(container, "Remote")).toBe("2");
    // Reachable describes what a step can actually call: `off` is attached but
    // disabled, so only `live` counts.
    expect(statValue(container, "Reachable from a step")).toBe("1");
  });
});

describe("SSE transport warning (browser)", () => {
  function sseDraft(transport: "sse" | "streamable-http") {
    return {
      editing: null,
      editingSnapshot: null,
      mode: "fields" as const,
      name: "remote",
      transport,
      command: "",
      args: "",
      argsOriginal: null,
      url: "https://mcp.acme.dev",
      urlStored: false,
      headers: [],
      oauth: false,
      json: "",
      error: null,
    };
  }

  it("warns that a Codex-backed run cannot dial an SSE-only server", () => {
    // The Codex projection copies the URL without the transport, and Codex
    // dials every URL-only server as streamable HTTP.
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: sseDraft("sse"),
      }),
    );

    expect(container.textContent).toContain("dialed by the embedded runtime only");
  });

  it("says nothing about it for streamable-http", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: sseDraft("streamable-http"),
      }),
    );

    expect(container.textContent).not.toContain("dialed by the embedded runtime only");
  });
});

describe("MCP import preview caveats (browser)", () => {
  function importDraft(json: string) {
    return {
      editing: null,
      editingSnapshot: null,
      mode: "json" as const,
      name: "",
      transport: "stdio" as const,
      command: "",
      args: "",
      argsOriginal: null,
      url: "",
      urlStored: false,
      headers: [],
      oauth: false,
      json,
      error: null,
    };
  }

  it("warns about an explicitly declared sse transport, not only an assumed one", () => {
    // A snippet that says sse outright assumes nothing, so a preview keyed on
    // the assumed-transport field would attach it to a Codex step in silence.
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: importDraft(
          JSON.stringify({ mcpServers: { remote: { url: "https://a.dev", transport: "sse" } } }),
        ),
      }),
    );

    expect(container.textContent).toContain("dialed by the embedded runtime only");
  });

  it("carries the OAuth login caveat into the pasted half", () => {
    const container = renderInto(
      createProps({
        section: "mcp",
        canEdit: true,
        mcpDraft: importDraft(
          JSON.stringify({
            mcpServers: {
              remote: { url: "https://a.dev", transport: "streamable-http", auth: "oauth" },
            },
          }),
        ),
      }),
    );

    expect(container.textContent).toContain("openclaw mcp login");
  });
});
