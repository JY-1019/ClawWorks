/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { type KnowledgeProps, renderKnowledge } from "./knowledge.ts";

function buildProps(overrides?: Partial<KnowledgeProps>): KnowledgeProps {
  const props: KnowledgeProps = {
    phase: "ready",
    foundations: [],
    connections: {},
    error: null,
    canManageFiles: true,
    filesOpenFor: null,
    documents: {},
    uploadingFor: null,
    documentConfirm: null,
    documentNotice: null,
    onRefresh: vi.fn(),
    onTestConnection: vi.fn(),
    onOpenFiles: vi.fn(),
    onCloseFiles: vi.fn(),
    onUpload: vi.fn(),
    onRequestRemove: vi.fn(),
    onCancelRemove: vi.fn(),
    onConfirmRemove: vi.fn(),
    adapters: [],
    adaptersKnown: true,
    defaultAdapterId: null,
    omittedAdapterSchemas: [],
    canRegister: true,
    registerBlockedReason: null,
    addBlockedReason: null,
    draft: null,
    configured: {},
    configDirty: false,
    configSaving: false,
    configApplying: false,
    connected: true,
    onBeginDraft: vi.fn(),
    onEditDraft: vi.fn(),
    onCancelDraft: vi.fn(),
    onSubmitDraft: vi.fn(),
    onBeginEdit: vi.fn(),
    sourceConfirm: null,
    onRequestRemoveSource: vi.fn(),
    onCancelRemoveSource: vi.fn(),
    onConfirmRemoveSource: vi.fn(),
    onSaveConfig: vi.fn(),
    onApplyConfig: vi.fn(),
  };
  return { ...props, ...overrides };
}

function renderInto(props: KnowledgeProps): HTMLElement {
  const container = document.createElement("div");
  render(renderKnowledge(props), container);
  return container;
}

function foundation(overrides: Record<string, unknown> = {}) {
  return {
    id: "acme.kb",
    kind: "remote" as const,
    displayName: "Acme KB",
    referencedBy: [],
    ...overrides,
  } as KnowledgeProps["foundations"][number];
}

describe("renderKnowledge", () => {
  it("shows the empty state once loading has finished", () => {
    const container = renderInto(buildProps());
    expect(container.textContent).toContain("No knowledge foundations are registered");
  });

  it("does not claim there are none while the first load is in flight", () => {
    // Asserting "none registered" before the answer arrives would be wrong.
    const container = renderInto(buildProps({ phase: "loading" }));
    expect(container.textContent).not.toContain("No knowledge foundations are registered");
  });

  it("does not claim there are none before any load has started", () => {
    // Deep-linking to /knowledge renders before the tab dispatches its load.
    const container = renderInto(buildProps({ phase: "unloaded" }));
    expect(container.textContent).not.toContain("No knowledge foundations are registered");
  });

  it("does not claim there are none when the load failed", () => {
    // A failed load says nothing about how many exist; the error explains it.
    const container = renderInto(buildProps({ phase: "failed", error: "nope" }));
    expect(container.textContent).not.toContain("No knowledge foundations are registered");
    expect(container.querySelector(".callout.danger")?.textContent).toContain("nope");
  });

  it("renders the display name, id, detail, and kind badge", () => {
    const container = renderInto(
      buildProps({
        foundations: [foundation({ kind: "local", detail: "http://kb:9621" })],
      }),
    );
    expect(container.textContent).toContain("Acme KB");
    expect(container.textContent).toContain("acme.kb");
    expect(container.textContent).toContain("http://kb:9621");
    expect(container.textContent).toContain("local");
  });

  it("renders the foundation description when one is provided", () => {
    const container = renderInto(
      buildProps({
        foundations: [foundation({ description: "Support policies and macros" })],
      }),
    );
    expect(container.textContent).toContain("Support policies and macros");
  });

  it("calls back with the foundation id when test connection is clicked", () => {
    const onTestConnection = vi.fn();
    const container = renderInto(buildProps({ foundations: [foundation()], onTestConnection }));
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Test connection"),
    );
    button?.click();
    expect(onTestConnection).toHaveBeenCalledWith("acme.kb");
  });

  it("disables the button and shows progress while a probe is in flight", () => {
    const container = renderInto(
      buildProps({
        foundations: [foundation()],
        connections: { "acme.kb": { phase: "testing" } },
      }),
    );
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Testing"),
    );
    expect(button).toBeDefined();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders each probe status with its own label", () => {
    const cases = [
      { status: "ok", label: "Reachable" },
      { status: "failed", label: "Unreachable" },
      { status: "unsupported", label: "Not checkable" },
      { status: "not-registered", label: "No longer registered" },
    ] as const;
    for (const { status, label } of cases) {
      const container = renderInto(
        buildProps({
          foundations: [foundation()],
          connections: { "acme.kb": { phase: "done", status } },
        }),
      );
      expect(container.textContent).toContain(label);
    }
  });

  it("does not color a non-failure status as an error", () => {
    // "cannot check" is not the server being down; red would misreport it.
    const container = renderInto(
      buildProps({
        foundations: [foundation()],
        connections: { "acme.kb": { phase: "done", status: "unsupported" } },
      }),
    );
    const chip = [...container.querySelectorAll("span.chip")].find((candidate) =>
      candidate.textContent?.includes("Not checkable"),
    );
    expect(chip?.getAttribute("style")).not.toContain("--danger");
  });

  it("shows the failure detail next to the status", () => {
    const container = renderInto(
      buildProps({
        foundations: [foundation()],
        connections: { "acme.kb": { phase: "done", status: "failed", detail: "ECONNREFUSED" } },
      }),
    );
    expect(container.textContent).toContain("ECONNREFUSED");
  });

  it("calls out a foundation no workflow step references", () => {
    const container = renderInto(buildProps({ foundations: [foundation()] }));
    expect(container.textContent).toContain("Not referenced by any workflow step");
  });

  it("lists the referencing steps with their tree", () => {
    const container = renderInto(
      buildProps({
        foundations: [
          foundation({
            referencedBy: [
              { treeId: "t.one", treeName: "Support", nodeId: "n.one", nodeTitle: "Answer" },
              { treeId: "t.one", treeName: "Support", nodeId: "n.two", nodeTitle: "Escalate" },
            ],
          }),
        ],
      }),
    );
    expect(container.textContent).toContain("Referenced by 2 step(s)");
    expect(container.textContent).toContain("Answer");
    expect(container.textContent).toContain("Escalate");
  });

  it("surfaces a tab-level error", () => {
    const container = renderInto(buildProps({ error: "boom" }));
    expect(container.querySelector(".callout.danger")?.textContent).toContain("boom");
  });
});

describe("renderKnowledge files section", () => {
  const local = (overrides: Record<string, unknown> = {}) =>
    foundation({ kind: "local", ...overrides });

  function findButton(container: HTMLElement, text: string) {
    return [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(text),
    );
  }

  it("offers files only for a foundation this deployment administers", () => {
    // A remote foundation is read-only by contract, so the control would be a
    // dead affordance that fails on click.
    const remote = renderInto(buildProps({ foundations: [foundation({ kind: "remote" })] }));
    expect(findButton(remote, "Show files")).toBeUndefined();

    const localised = renderInto(buildProps({ foundations: [local()] }));
    expect(findButton(localised, "Show files")).toBeDefined();
  });

  it("opens the files section with the foundation id", () => {
    const onOpenFiles = vi.fn();
    const container = renderInto(buildProps({ foundations: [local()], onOpenFiles }));
    findButton(container, "Show files")?.click();
    expect(onOpenFiles).toHaveBeenCalledWith("acme.kb");
  });

  it("does not claim there are no documents while the list is loading", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "loading" } },
      }),
    );
    expect(container.textContent).not.toContain("No documents have been uploaded yet");
  });

  it("renders documents with status, chunk count, and summary", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": {
            phase: "ready",
            documents: [
              {
                id: "d1",
                name: "handbook.pdf",
                status: "indexed",
                summary: "Company handbook",
                chunkCount: 12,
              },
            ],
          },
        },
      }),
    );
    expect(container.textContent).toContain("handbook.pdf");
    expect(container.textContent).toContain("Indexed");
    expect(container.textContent).toContain("12 chunk(s)");
    expect(container.textContent).toContain("Company handbook");
  });

  it("explains that a store exposes no preview instead of rendering blank", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": { phase: "ready", documents: [{ id: "d1", name: "a.md", status: "indexed" }] },
        },
      }),
    );
    expect(container.textContent).toContain("exposes no preview");
  });

  it("shows a failed document's indexing error", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": {
            phase: "ready",
            documents: [{ id: "d1", name: "bad.md", status: "failed", error: "parse error" }],
          },
        },
      }),
    );
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("parse error");
  });

  it("explains each unavailable reason distinctly", () => {
    const cases = [
      { status: "read-only", text: "operated elsewhere" },
      { status: "unsupported", text: "does not expose document management" },
      { status: "not-registered", text: "no longer registered" },
      { status: "failed", text: "Could not load documents" },
    ] as const;
    for (const { status, text } of cases) {
      const container = renderInto(
        buildProps({
          foundations: [local()],
          filesOpenFor: "acme.kb",
          documents: { "acme.kb": { phase: "unavailable", status } },
        }),
      );
      expect(container.textContent).toContain(text);
    }
  });

  it("hides upload and remove controls without admin scope", () => {
    const container = renderInto(
      buildProps({
        canManageFiles: false,
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": { phase: "ready", documents: [{ id: "d1", name: "a.md", status: "indexed" }] },
        },
      }),
    );
    expect(container.textContent).not.toContain("Upload document");
    expect(findButton(container, "Remove")).toBeUndefined();
  });

  it("offers upload for a ready, admin-managed local foundation", () => {
    // Guards the negative cases below from over-correcting into "never shown".
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "ready", documents: [] } },
      }),
    );
    expect(container.textContent).toContain("Upload document");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input?.disabled).toBe(false);
  });

  it("blocks upload while another foundation's upload is in flight", () => {
    // Uploads are serialized tab-wide, so an enabled-looking control on a
    // second foundation would silently no-op when picked.
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "ready", documents: [] } },
        uploadingFor: "other.kb",
      }),
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(true);
    // The busy label belongs to the foundation actually uploading.
    expect(container.textContent).not.toContain("Uploading");
  });

  it("hides upload until the document list has answered", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "loading" } },
      }),
    );
    expect(container.textContent).not.toContain("Upload document");
  });

  it("hides upload when the store reports it cannot manage documents", () => {
    // Offering upload here would hand the user a control whose only outcome is
    // a refusal from the gateway.
    for (const status of ["unsupported", "not-registered", "failed"] as const) {
      const container = renderInto(
        buildProps({
          foundations: [local()],
          filesOpenFor: "acme.kb",
          documents: { "acme.kb": { phase: "unavailable", status } },
        }),
      );
      expect(container.textContent).not.toContain("Upload document");
    }
  });

  it("asks for confirmation before removing rather than deleting on click", () => {
    const onRequestRemove = vi.fn();
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": { phase: "ready", documents: [{ id: "d1", name: "a.md", status: "indexed" }] },
        },
        onRequestRemove,
      }),
    );
    findButton(container, "Remove")?.click();
    expect(onRequestRemove).toHaveBeenCalledWith({
      foundationId: "acme.kb",
      documentId: "d1",
      documentName: "a.md",
    });
  });

  it("warns that removal is irreversible in the confirm dialog", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        documentConfirm: {
          foundationId: "acme.kb",
          documentId: "d1",
          documentName: "handbook.pdf",
        },
      }),
    );
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(container.textContent).toContain("Remove handbook.pdf?");
    expect(container.textContent).toContain("cannot be undone");
  });

  it("surfaces the last file-action notice", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "ready", documents: [] } },
        documentNotice: "Removal of a.md started. It runs in the background.",
      }),
    );
    expect(container.textContent).toContain("started");
  });
});

function adapter(overrides: Partial<KnowledgeProps["adapters"][number]> = {}) {
  return {
    pluginId: "lightrag",
    label: "LightRAG Knowledge",
    fields: [
      { name: "id", options: [], required: true, sensitive: false },
      { name: "serverUrl", options: [], required: true, sensitive: false },
      { name: "kind", options: ["remote", "local"], required: false, sensitive: false },
      { name: "apiKey", options: [], required: false, sensitive: true },
    ],
    ...overrides,
  } as KnowledgeProps["adapters"][number];
}

describe("renderKnowledge registration", () => {
  it("offers to connect a source when an adapter can take one", () => {
    const container = renderInto(buildProps({ adapters: [adapter()] }));
    expect(container.textContent).toContain("Connect a knowledge source");
    expect(container.textContent).toContain("Connect a source");
  });

  it("hides the whole card from a session that cannot write config", () => {
    const container = renderInto(buildProps({ adapters: [adapter()], canRegister: false }));
    expect(container.textContent).not.toContain("Connect a knowledge source");
  });

  it("tells the operator to install an adapter only once the schema answered", () => {
    // Before that, an empty adapter list is "not known yet", and sending them to
    // install a plugin they already have would be wrong.
    const pending = renderInto(buildProps({ adaptersKnown: false }));
    expect(pending.textContent).not.toContain("No installed plugin can register");

    const answered = renderInto(buildProps({ adaptersKnown: true }));
    expect(answered.textContent).toContain("No installed plugin can register");
  });

  it("builds the form from the fields the adapter declares", () => {
    const container = renderInto(
      buildProps({
        adapters: [adapter()],
        draft: {
          pluginId: "lightrag",
          editingIndex: null,
          editingSnapshot: null,
          values: {},
          error: null,
        },
      }),
    );

    expect(container.querySelector("select")).toBeTruthy();
    // A credential is masked, because the same path is redacted on the way out.
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
    expect(container.textContent).toContain("Foundation id");
    expect(container.textContent).toContain("Server URL");
  });

  it("lists every configured source with edit and remove, marking the unsaved ones", () => {
    const container = renderInto(
      buildProps({
        adapters: [adapter()],
        configDirty: true,
        configured: {
          lightrag: {
            pending: [false, true],
            foundations: [
              { id: "acme.orders-kb", serverUrl: "http://a" },
              { id: "acme.support-kb", serverUrl: "http://b" },
            ],
          },
        },
      }),
    );

    // The list an operator can change is the config list, not the live registry.
    expect(container.textContent).toContain("acme.orders-kb");
    expect(container.textContent).toContain("acme.support-kb");
    expect(container.textContent).toContain("Not saved");
    expect(container.textContent).toContain("Edit");
    expect(container.textContent).toContain("exist only in this browser");
    expect(container.textContent).toContain("Save & Publish");
  });

  it("refuses to remove a source that would displace a later credential", () => {
    // The gateway matches stored credentials by array position, so removing
    // would hand the later source the wrong key.
    const container = renderInto(
      buildProps({
        adapters: [adapter()],
        configured: {
          lightrag: {
            pending: [false, false],
            foundations: [
              { id: "acme.orders-kb", serverUrl: "http://a" },
              { id: "acme.support-kb", serverUrl: "http://b", apiKey: "__OPENCLAW_REDACTED__" },
            ],
          },
        },
      }),
    );

    expect(container.textContent).toContain("acme.support-kb still holds a stored credential");
    const remove = [...container.querySelectorAll("button")].filter((entry) =>
      entry.textContent?.trim().startsWith("Remove"),
    );
    // The first source is blocked; the last one shifts nothing and stays usable.
    expect(remove[0]?.disabled).toBe(true);
    expect(remove[1]?.disabled).toBe(false);
  });

  it("shows an edited source's stored credential as unchanged rather than as dots", () => {
    const container = renderInto(
      buildProps({
        adapters: [adapter()],
        configured: {
          lightrag: {
            pending: [false],
            foundations: [
              { id: "acme.kb", serverUrl: "http://a", apiKey: "__OPENCLAW_REDACTED__" },
            ],
          },
        },
        draft: {
          pluginId: "lightrag",
          editingIndex: 0,
          editingSnapshot: null,
          values: { id: "acme.kb", serverUrl: "http://a" },
          error: null,
        },
      }),
    );

    expect(container.textContent).toContain("Edit source");
    expect(container.textContent).toContain("Type here only to replace it");
    expect(container.querySelector('input[type="password"]')?.getAttribute("placeholder")).toBe(
      "Unchanged",
    );
  });

  it("blocks registering while the config draft cannot be written", () => {
    const container = renderInto(
      buildProps({
        adapters: [adapter()],
        registerBlockedReason: "A config save is in flight.",
        addBlockedReason: "A config save is in flight.",
      }),
    );

    expect(container.textContent).toContain("A config save is in flight.");
    const button = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Connect a source"),
    );
    expect(button?.disabled).toBe(true);
  });
});

describe("renderKnowledge field binding", () => {
  it("shows a nested SecretRef as unchanged, not as absent", () => {
    // A SecretRef's sentinel is nested, so a shallow check would call the
    // credential missing and hide the replacement guidance.
    const container = renderInto(
      buildProps({
        adapters: [adapter()],
        configured: {
          lightrag: {
            pending: [false],
            foundations: [
              {
                id: "acme.kb",
                serverUrl: "http://a",
                apiKey: { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" },
              },
            ],
          },
        },
        draft: {
          pluginId: "lightrag",
          editingIndex: 0,
          editingSnapshot: null,
          values: { id: "acme.kb", serverUrl: "http://a" },
          error: null,
        },
      }),
    );

    expect(container.textContent).toContain("Type here only to replace it");
    expect(container.querySelector('input[type="password"]')?.getAttribute("placeholder")).toBe(
      "Unchanged",
    );
  });

  it("renders an adapter field named like a prototype key as empty", () => {
    // A plain lookup on a fresh draft's {} would bind the inherited function
    // into the control.
    const container = renderInto(
      buildProps({
        adapters: [
          adapter({
            fields: [
              { name: "id", options: [], required: true, sensitive: false },
              { name: "serverUrl", options: [], required: true, sensitive: false },
              { name: "constructor", options: [], required: false, sensitive: false },
            ],
          }),
        ],
        draft: {
          pluginId: "lightrag",
          editingIndex: null,
          editingSnapshot: null,
          values: {},
          error: null,
        },
      }),
    );

    const inputs = [...container.querySelectorAll("input")];
    expect(inputs.every((input) => input.value === "")).toBe(true);
  });
});
