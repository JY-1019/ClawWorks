// Control UI view renders the knowledge foundations inspector.
import { html, nothing } from "lit";
import type {
  EnterpriseKnowledgeConnectionStatus,
  EnterpriseKnowledgeDocument,
  EnterpriseKnowledgeFoundationReference,
  EnterpriseKnowledgeFoundationSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import "../components/modal-dialog.ts";
import {
  draftValue,
  foundationsBlockingRemoval,
  foundationText,
  humanizeFieldName,
  preservesStoredValue,
  type KnowledgeAdapterField,
  type KnowledgeAdapterPlugin,
  type KnowledgeFoundationDraft,
} from "../controllers/knowledge-registration.ts";
import type {
  KnowledgeConnectionState,
  KnowledgeDocumentConfirm,
  KnowledgeDocumentsState,
  KnowledgeListPhase,
} from "../controllers/knowledge.ts";

export type KnowledgeProps = {
  phase: KnowledgeListPhase;
  foundations: EnterpriseKnowledgeFoundationSummary[];
  connections: Record<string, KnowledgeConnectionState>;
  error: string | null;
  /** Whether the session may upload/remove documents (operator.admin). */
  canManageFiles: boolean;
  filesOpenFor: string | null;
  documents: Record<string, KnowledgeDocumentsState>;
  uploadingFor: string | null;
  documentConfirm: KnowledgeDocumentConfirm | null;
  documentNotice: string | null;
  onRefresh: () => void;
  onTestConnection: (foundationId: string) => void;
  onOpenFiles: (foundationId: string) => void;
  onCloseFiles: () => void;
  onUpload: (foundationId: string, file: File) => void;
  onRequestRemove: (confirm: KnowledgeDocumentConfirm) => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  /** Adapters whose config can register a foundation, from the config schema. */
  adapters: KnowledgeAdapterPlugin[];
  /**
   * Whether the config schema has answered. An empty `adapters` before it does
   * is "not known yet", not "this deployment has none" — the difference decides
   * whether the operator is told to go install a plugin.
   */
  adaptersKnown: boolean;
  /** Adapter the Connect button opens: the first policy does not deny. */
  defaultAdapterId: string | null;
  /** Plugins whose config schema the gateway dropped from this response. */
  omittedAdapterSchemas: string[];
  /** Whether the session may write config (operator.admin). */
  canRegister: boolean;
  /**
   * Why any config write is unavailable right now, or null. Applies to editing
   * and removing as well as adding.
   */
  registerBlockedReason: string | null;
  /**
   * Why a NEW source cannot be added, or null. Adds the plugin-policy reasons on
   * top of `registerBlockedReason`: an adapter that will never load should not
   * take new sources, but retiring its existing ones stays possible.
   */
  addBlockedReason: string | null;
  draft: KnowledgeFoundationDraft | null;
  /**
   * Config-declared foundations per adapter, flagged with which are unsaved.
   * `pending` is parallel to `foundations`.
   */
  configured: Record<string, { foundations: Record<string, unknown>[]; pending: boolean[] }>;
  configDirty: boolean;
  configSaving: boolean;
  configApplying: boolean;
  connected: boolean;
  /** A source removal awaiting confirmation, or null. */
  sourceConfirm: { pluginId: string; index: number; foundationId: string } | null;
  onBeginDraft: (pluginId: string) => void;
  onBeginEdit: (pluginId: string, index: number) => void;
  onEditDraft: (patch: { pluginId?: string; values?: Record<string, string> }) => void;
  onCancelDraft: () => void;
  onSubmitDraft: () => void;
  onRequestRemoveSource: (pluginId: string, index: number) => void;
  onCancelRemoveSource: () => void;
  onConfirmRemoveSource: () => void;
  onSaveConfig: () => void;
  onApplyConfig: () => void;
};

export function renderKnowledge(props: KnowledgeProps) {
  const loading = props.phase === "loading";
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("knowledge.title")}</div>
          <div class="card-sub">${t("knowledge.subtitle")}</div>
        </div>
        <button class="btn" ?disabled=${loading} @click=${props.onRefresh}>
          ${loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
      ${renderSummary(props)}
    </section>

    ${renderRegistration(props)}

    <section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("knowledge.registeredTitle")}</div>
      <div class="card-sub">${t("knowledge.registeredSubtitle")}</div>
      <div class="list" style="margin-top: 12px;">
        ${props.foundations.length === 0
          ? renderEmpty(props.phase)
          : props.foundations.map((foundation) => renderFoundation(foundation, props))}
      </div>
    </section>
    ${renderRemoveConfirm(props)}${renderSourceRemoveConfirm(props)}
  `;
}

/**
 * What the gateway currently serves, at a glance.
 *
 * Counted from the LIVE registry, not the config draft: these numbers answer
 * "what can a step retrieve right now", which an unsaved edit does not change.
 * Suppressed until the list has answered, so no tile claims zero of something
 * that simply has not loaded.
 */
function renderSummary(props: KnowledgeProps) {
  if (props.phase !== "ready") {
    return nothing;
  }
  const remote = props.foundations.filter((foundation) => foundation.kind !== "local").length;
  const referenced = props.foundations.filter(
    (foundation) => foundation.referencedBy.length > 0,
  ).length;
  const tiles: Array<{ label: string; value: number }> = [
    { label: t("knowledge.statSources"), value: props.foundations.length },
    { label: t("knowledge.statRemote"), value: remote },
    { label: t("knowledge.statReferenced"), value: referenced },
  ];
  return html`<div class="form-grid" style="margin-top: 16px;">
    ${tiles.map(
      (tile) => html`<div class="stat">
        <div class="stat-label">${tile.label}</div>
        <div class="stat-value">${String(tile.value)}</div>
      </div>`,
    )}
  </div>`;
}

/**
 * Connect an external retrieval server as a knowledge foundation, and adjust
 * the ones already configured.
 *
 * The enterprise layer stores no foundations of its own — an adapter plugin
 * registers them from its config — so this card reads and writes that plugin's
 * config draft and leaves Save/Publish to the config controller, exactly as the
 * Enterprise MCP screen does for `mcp.servers`. A change is not live until the
 * config is published and the adapter reloads it.
 */
function renderRegistration(props: KnowledgeProps) {
  if (!props.canRegister) {
    return nothing;
  }
  if (props.adapters.length === 0) {
    // Distinguished from "no foundations": an adapter is what makes registering
    // possible at all, and without one the answer is to install a plugin, not
    // to fill in a form. Only claimed once the schema has answered — and never
    // when the gateway dropped a plugin's schema, because then the adapter may
    // well be installed and simply invisible here.
    return html`<section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("knowledge.register.title")}</div>
      <div class="card-sub">
        ${!props.adaptersKnown
          ? t("common.loading")
          : props.omittedAdapterSchemas.length > 0
            ? t("knowledge.register.schemaOmitted", {
                plugins: props.omittedAdapterSchemas.join(", "),
              })
            : t("knowledge.register.noAdapters")}
      </div>
    </section>`;
  }
  const draft = props.draft;
  return html`<section class="card" style="margin-top: 16px;">
    <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
      <div>
        <div class="card-title">${t("knowledge.register.title")}</div>
        <div class="card-sub">${t("knowledge.register.subtitle")}</div>
      </div>
      ${draft
        ? nothing
        : html`<button
            class="btn primary"
            ?disabled=${props.addBlockedReason !== null}
            title=${props.addBlockedReason ?? ""}
            @click=${() => props.onBeginDraft(props.defaultAdapterId ?? props.adapters[0].pluginId)}
          >
            ${t("knowledge.register.add")}
          </button>`}
    </div>
    ${props.addBlockedReason
      ? html`<div class="callout" style="margin-top: 12px;">${props.addBlockedReason}</div>`
      : nothing}
    <!-- Some adapters may be installed and simply missing from this list. -->
    ${props.omittedAdapterSchemas.length > 0
      ? html`<div class="callout" style="margin-top: 12px;">
          ${t("knowledge.register.schemaOmitted", {
            plugins: props.omittedAdapterSchemas.join(", "),
          })}
        </div>`
      : nothing}
    ${draft ? renderDraft(props, draft) : nothing}
    ${props.adapters.map((adapter) => renderConfiguredSources(props, adapter))}
    ${renderConfigActions(props)}
  </section>`;
}

/** The add/edit form, built from the fields the selected adapter declares. */
function renderDraft(props: KnowledgeProps, draft: KnowledgeFoundationDraft) {
  const adapter = props.adapters.find((entry) => entry.pluginId === draft.pluginId);
  if (!adapter) {
    return nothing;
  }
  const editing = draft.editingIndex !== null;
  const original = editing
    ? props.configured[draft.pluginId]?.foundations[draft.editingIndex ?? 0]
    : undefined;
  return html`<div class="card" style="margin-top: 16px;">
    <div class="card-title">
      ${editing ? t("knowledge.register.editTitle") : t("knowledge.register.addTitle")}
    </div>
    ${
      // The adapter is only a choice while adding: an edit belongs to the list
      // it came from, and moving it to another plugin would be a new source
      // under an old one's index.
      editing || props.adapters.length === 1
        ? html`<div class="card-sub">${adapter.label}</div>`
        : html`<div class="chip-row" style="margin-top: 10px;">
            ${props.adapters.map(
              (entry) => html`<button
                type="button"
                class="chip ${entry.pluginId === draft.pluginId ? "list-item-selected" : ""}"
                @click=${() => props.onEditDraft({ pluginId: entry.pluginId })}
              >
                ${entry.label}
              </button>`,
            )}
          </div>`
    }
    <div class="form-grid" style="margin-top: 12px;">
      ${adapter.fields.map((field) => renderDraftField(props, draft, field, original))}
    </div>
    ${draft.error
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${draftErrorMessage(draft.error)}
        </div>`
      : nothing}
    <div class="row" style="gap: 8px; margin-top: 16px;">
      <button
        class="btn primary"
        ?disabled=${(editing ? props.registerBlockedReason : props.addBlockedReason) !== null}
        title=${(editing ? props.registerBlockedReason : props.addBlockedReason) ?? ""}
        @click=${props.onSubmitDraft}
      >
        ${editing ? t("knowledge.register.saveEntry") : t("knowledge.register.submit")}
      </button>
      <button class="btn" @click=${props.onCancelDraft}>${t("common.cancel")}</button>
    </div>
  </div>`;
}

/**
 * One field of the form. Labels for the two fields every adapter declares are
 * translated; anything else the adapter added is labelled by its own name and
 * explained by its own schema description, which is the only text that exists
 * for it.
 */
function renderDraftField(
  props: KnowledgeProps,
  draft: KnowledgeFoundationDraft,
  field: KnowledgeAdapterField,
  original: Record<string, unknown> | undefined,
) {
  // The two fields every adapter must declare are the contract, so they get
  // translated labels; anything else is the adapter author's own key.
  const label =
    field.name === "id"
      ? t("knowledge.register.id")
      : field.name === "serverUrl"
        ? t("knowledge.register.serverUrl")
        : humanizeFieldName(field.name);
  // Own-property read: an adapter may legally declare a field named
  // `constructor` or `toString`, and a plain lookup on a fresh draft's `{}`
  // would bind the inherited function into the control.
  const value = draftValue(draft.values, field.name);
  const onInput = (next: string) => props.onEditDraft({ values: { [field.name]: next } });
  // The id is what a work-map step names, and nothing migrates
  // `ontology.knowledgeFoundations`, so an edit cannot change it: every step
  // bound to this source would silently stop retrieving.
  const locked = field.name === "id" && draft.editingIndex !== null;
  // A credential the browser was never given. Shown as blank with a note rather
  // than as placeholder text: a masked box full of dots reads as a real value
  // the operator could edit character by character, and it cannot be.
  // The same rule the builder applies, so the note appears exactly when the
  // stored value is the one that survives a blank field — including a SecretRef,
  // whose sentinel is nested rather than the value itself.
  const keepsStoredSecret =
    original !== undefined &&
    Object.hasOwn(original, field.name) &&
    preservesStoredValue(original[field.name]);
  return html`<label class="field">
    <span>${label}${field.required ? "" : ` ${t("knowledge.register.optional")}`}</span>
    ${field.options.length > 0
      ? html`<select
          .value=${value}
          @change=${(event: Event) => onInput((event.target as HTMLSelectElement).value)}
        >
          <!-- Blank stays selectable: the adapter's own default is a real
            choice, and forcing one of the enum values here would write a value
            the operator never picked. -->
          <option value="">${t("knowledge.register.adapterDefault")}</option>
          ${field.options.map(
            (option) =>
              html`<option value=${option} ?selected=${option === value}>${option}</option>`,
          )}
        </select>`
      : html`<input
          type=${field.sensitive ? "password" : "text"}
          autocomplete="off"
          ?readonly=${locked}
          .value=${value}
          placeholder=${keepsStoredSecret
            ? t("knowledge.register.secretUnchanged")
            : draftPlaceholder(field)}
          @input=${(event: Event) => onInput((event.target as HTMLInputElement).value)}
        />`}
    ${locked ? html`<span class="field-help">${t("knowledge.register.idLocked")}</span>` : nothing}
    ${field.description ? html`<span class="field-help">${field.description}</span>` : nothing}
    ${field.sensitive
      ? html`<span class="field-help">
          ${keepsStoredSecret
            ? t("knowledge.register.secretReplaceHint")
            : t("knowledge.register.secretHint")}
        </span>`
      : nothing}
  </label>`;
}

/**
 * Example values, not translated: a foundation id and a server URL are literals
 * an operator types verbatim, so they do not change per locale.
 */
function draftPlaceholder(field: KnowledgeAdapterField): string {
  if (field.name === "id") {
    return "acme.support-kb";
  }
  return field.name === "serverUrl" ? "https://rag.internal.acme.dev" : "";
}

/**
 * Every source this adapter's config declares, saved or not.
 *
 * Listed here rather than only in the registry above because this is the list
 * the operator can change: the registry reflects what the gateway loaded, which
 * is the previous published config until this draft is saved.
 */
function renderConfiguredSources(props: KnowledgeProps, adapter: KnowledgeAdapterPlugin) {
  const state = props.configured[adapter.pluginId];
  if (!state || state.foundations.length === 0) {
    return nothing;
  }
  return html`<div style="margin-top: 16px;">
    <div class="card-sub">${t("knowledge.register.configured", { adapter: adapter.label })}</div>
    <div class="list" style="margin-top: 8px;">
      ${state.foundations.map((entry, index) =>
        renderConfiguredSource({
          props,
          adapter,
          entry,
          index,
          pending: state.pending[index],
          foundations: state.foundations,
        }),
      )}
    </div>
  </div>`;
}

function renderConfiguredSource(params: {
  props: KnowledgeProps;
  adapter: KnowledgeAdapterPlugin;
  entry: Record<string, unknown>;
  index: number;
  pending: boolean;
  foundations: Record<string, unknown>[];
}) {
  const { props, adapter, entry, index, pending } = params;
  // Removing shifts every later entry into a slot whose stored credential is
  // not theirs, so the control says which source is in the way instead of
  // offering an action that would quietly mismatch a key.
  const blockedBy = foundationsBlockingRemoval({ foundations: params.foundations, index });
  const blocked = blockedBy.length > 0;
  const editing = props.draft?.pluginId === adapter.pluginId && props.draft?.editingIndex === index;
  return html`<div class="list-item ${editing ? "list-item-selected" : ""}">
    <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
      <div class="list-main">
        <div class="list-title">
          <code>${foundationText(entry.id)}</code>
          ${pending
            ? html`<span class="chip chip-warn">${t("knowledge.register.notSaved")}</span>`
            : nothing}
        </div>
        <div class="list-sub">${foundationText(entry.serverUrl)}</div>
        ${foundationText(entry.description)
          ? html`<div class="list-sub">${foundationText(entry.description)}</div>`
          : nothing}
      </div>
      <div class="row" style="gap: 8px;">
        <button
          class="btn btn--sm"
          ?disabled=${props.registerBlockedReason !== null}
          title=${props.registerBlockedReason ?? ""}
          @click=${() => props.onBeginEdit(adapter.pluginId, index)}
        >
          ${t("knowledge.register.edit")}
        </button>
        <button
          class="btn btn--sm danger"
          ?disabled=${blocked || props.registerBlockedReason !== null}
          title=${blocked
            ? t("knowledge.register.removeBlocked", { ids: blockedBy.join(", ") })
            : (props.registerBlockedReason ?? "")}
          @click=${() => props.onRequestRemoveSource(adapter.pluginId, index)}
        >
          ${t("knowledge.register.remove")}
        </button>
      </div>
    </div>
    ${blocked
      ? html`<div class="list-sub" style="margin-top: 6px;">
          ${t("knowledge.register.removeBlocked", { ids: blockedBy.join(", ") })}
        </div>`
      : nothing}
  </div>`;
}

/**
 * Save/Publish for the config draft this card writes into. Shown only while the
 * draft differs, so its presence stays a signal that something is unsaved.
 */
function renderConfigActions(props: KnowledgeProps) {
  if (!props.configDirty) {
    return nothing;
  }
  const busy = props.configSaving || props.configApplying || !props.connected;
  return html`<div class="callout" style="margin-top: 16px;">
    <div>${t("knowledge.register.unsaved")}</div>
    <div class="row" style="gap: 8px; margin-top: 8px;">
      <button class="btn" ?disabled=${busy} @click=${props.onSaveConfig}>
        ${t("knowledge.register.save")}
      </button>
      <button class="btn primary" ?disabled=${busy} @click=${props.onApplyConfig}>
        ${props.configApplying
          ? t("knowledge.register.publishing")
          : t("knowledge.register.publish")}
      </button>
    </div>
  </div>`;
}

/** Removing a source is destructive and cannot be undone from here. */
function renderSourceRemoveConfirm(props: KnowledgeProps) {
  const confirm = props.sourceConfirm;
  if (!confirm) {
    return nothing;
  }
  const title = t("knowledge.register.removeTitle", { id: confirm.foundationId });
  return html`<openclaw-modal-dialog
    label=${title}
    description=${t("knowledge.register.removeBody")}
    @modal-cancel=${props.onCancelRemoveSource}
  >
    <div class="card">
      <div class="card-title">${title}</div>
      <div class="card-sub">${t("knowledge.register.removeBody")}</div>
      <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 12px;">
        <button class="btn" @click=${props.onCancelRemoveSource}>${t("common.cancel")}</button>
        <button class="btn danger" @click=${props.onConfirmRemoveSource}>
          ${t("knowledge.register.remove")}
        </button>
      </div>
    </div>
  </openclaw-modal-dialog>`;
}

function draftErrorMessage(error: NonNullable<KnowledgeFoundationDraft["error"]>): string {
  const messages: Record<NonNullable<KnowledgeFoundationDraft["error"]>, string> = {
    "id-empty": t("knowledge.register.idInvalid"),
    "id-taken": t("knowledge.register.idTaken"),
    "url-empty": t("knowledge.register.urlEmpty"),
    "url-invalid": t("knowledge.register.urlInvalid"),
    "adapter-missing": t("knowledge.register.adapterMissing"),
    "entry-missing": t("knowledge.register.entryMissing"),
    "field-required": t("knowledge.register.fieldRequired"),
    "field-invalid": t("knowledge.register.fieldInvalid"),
  };
  return messages[error];
}

function renderEmpty(phase: KnowledgeListPhase) {
  // "No foundations are registered" is a claim about the gateway's answer, so
  // it is only made once an answer arrived. Before that (deep link into the tab
  // before its load starts, or a load still running) the view says nothing, and
  // a failed load is already explained by the error callout above.
  if (phase !== "ready") {
    return phase === "failed" ? nothing : html`<div class="muted">${t("common.loading")}</div>`;
  }
  return html`<div class="muted">
    <div>${t("knowledge.empty")}</div>
    <div style="margin-top: 4px;">${t("knowledge.emptyHint")}</div>
  </div>`;
}

function renderFoundation(foundation: EnterpriseKnowledgeFoundationSummary, props: KnowledgeProps) {
  const connection = props.connections[foundation.id];
  const testing = connection?.phase === "testing";
  const onTestConnection = props.onTestConnection;
  return html`<div class="list-item">
    <div class="row" style="justify-content: space-between; gap: 8px; align-items: flex-start;">
      <div class="list-main">
        <div class="list-title">
          ${foundation.displayName}
          <span class="chip" title=${kindTitle(foundation.kind)}
            >${kindLabel(foundation.kind)}</span
          >
        </div>
        ${foundation.description
          ? html`<div class="list-sub">${foundation.description}</div>`
          : nothing}
        <div class="list-sub">${foundation.id}</div>
        ${foundation.detail ? html`<div class="list-sub">${foundation.detail}</div>` : nothing}
      </div>
      <div class="row" style="gap: 8px; align-items: center;">
        ${renderConnectionStatus(connection)}
        <button class="btn" ?disabled=${testing} @click=${() => onTestConnection(foundation.id)}>
          ${testing ? t("knowledge.testing") : t("knowledge.testConnection")}
        </button>
      </div>
    </div>
    ${renderReferences(foundation.referencedBy)}${renderFiles(foundation, props)}
  </div>`;
}

/**
 * The Files section only exists for foundations this deployment administers.
 * A remote foundation is read-only by contract, so offering the controls and
 * then refusing the call would be a dead affordance.
 */
function renderFiles(foundation: EnterpriseKnowledgeFoundationSummary, props: KnowledgeProps) {
  if (foundation.kind !== "local") {
    return nothing;
  }
  const open = props.filesOpenFor === foundation.id;
  return html`<div style="margin-top: 8px;">
    <button
      class="btn"
      @click=${() => (open ? props.onCloseFiles() : props.onOpenFiles(foundation.id))}
    >
      ${open ? t("knowledge.filesHide") : t("knowledge.filesShow")}
    </button>
    ${open ? renderFilesPanel(foundation, props) : nothing}
  </div>`;
}

function renderFilesPanel(foundation: EnterpriseKnowledgeFoundationSummary, props: KnowledgeProps) {
  const state = props.documents[foundation.id];
  const uploadingThis = props.uploadingFor === foundation.id;
  // Uploads are serialized across the whole tab, so a request for a different
  // foundation still blocks this one. Disabling only the in-flight foundation's
  // control would leave the others looking usable while a pick silently no-ops.
  const uploadBlocked = props.uploadingFor !== null;
  // Only offer upload once the list has actually answered. While it is loading
  // we do not yet know the store accepts documents, and an "unsupported" or
  // "not-registered" answer means a pick would just come back refused.
  const canUpload = props.canManageFiles && state?.phase === "ready";
  return html`<div style="margin-top: 8px;">
    <div class="row" style="justify-content: space-between; align-items: center;">
      <div class="card-sub">${t("knowledge.files")}</div>
      ${canUpload
        ? html`<label class="btn" style=${uploadBlocked ? "opacity: 0.6;" : nothing}>
            ${uploadingThis ? t("knowledge.uploading") : t("knowledge.upload")}
            <input
              type="file"
              style="display: none;"
              ?disabled=${uploadBlocked}
              @change=${(event: Event) => {
                const input = event.target as HTMLInputElement;
                const file = input.files?.[0];
                if (file) {
                  props.onUpload(foundation.id, file);
                }
                // Reset so re-picking the same file fires change again.
                input.value = "";
              }}
            />
          </label>`
        : nothing}
    </div>
    ${props.documentNotice
      ? html`<div class="callout" style="margin-top: 8px;">${props.documentNotice}</div>`
      : nothing}
    ${renderDocuments(foundation, state, props)}
  </div>`;
}

function renderDocuments(
  foundation: EnterpriseKnowledgeFoundationSummary,
  state: KnowledgeDocumentsState | undefined,
  props: KnowledgeProps,
) {
  if (!state || state.phase === "loading") {
    return html`<div class="muted" style="margin-top: 8px;">${t("common.loading")}</div>`;
  }
  if (state.phase === "unavailable") {
    return html`<div class="muted" style="margin-top: 8px;">
      ${documentsUnavailableLabel(state.status)}
    </div>`;
  }
  if (state.documents.length === 0) {
    return html`<div class="muted" style="margin-top: 8px;">${t("knowledge.filesEmpty")}</div>`;
  }
  return html`<div class="list" style="margin-top: 8px;">
    ${state.documents.map((document) => renderDocument(foundation, document, props))}
  </div>`;
}

function renderDocument(
  foundation: EnterpriseKnowledgeFoundationSummary,
  document: EnterpriseKnowledgeDocument,
  props: KnowledgeProps,
) {
  return html`<div class="list-item">
    <div class="row" style="justify-content: space-between; gap: 8px; align-items: flex-start;">
      <div class="list-main">
        <div class="list-title">${document.name}</div>
        <div class="chip-row" style="margin-top: 4px;">
          <span class="chip" style=${`color: ${documentStatusColor(document.status)};`}>
            ${documentStatusLabel(document.status)}
          </span>
          ${document.chunkCount !== undefined
            ? html`<span class="chip"
                >${t("knowledge.docChunks", { count: String(document.chunkCount) })}</span
              >`
            : nothing}
        </div>
        ${document.error
          ? html`<div class="list-sub" style="color: var(--danger);">${document.error}</div>`
          : nothing}
      </div>
      ${props.canManageFiles
        ? html`<button
            class="btn danger"
            @click=${() =>
              props.onRequestRemove({
                foundationId: foundation.id,
                documentId: document.id,
                documentName: document.name,
              })}
          >
            ${t("knowledge.remove")}
          </button>`
        : nothing}
    </div>
    <details style="margin-top: 4px;">
      <summary class="list-sub">${t("knowledge.docSummary")}</summary>
      <div class="muted" style="margin-top: 4px; white-space: pre-wrap;">
        ${document.summary ?? t("knowledge.docNoSummary")}
      </div>
    </details>
  </div>`;
}

function renderRemoveConfirm(props: KnowledgeProps) {
  const confirm = props.documentConfirm;
  if (!confirm) {
    return nothing;
  }
  const title = t("knowledge.removeTitle", { name: confirm.documentName });
  return html`<openclaw-modal-dialog
    label=${title}
    description=${t("knowledge.removeBody")}
    @modal-cancel=${props.onCancelRemove}
  >
    <div class="card">
      <div class="card-title">${title}</div>
      <div class="card-sub">${t("knowledge.removeBody")}</div>
      <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 12px;">
        <button class="btn" @click=${props.onCancelRemove}>${t("common.cancel")}</button>
        <button class="btn danger" @click=${props.onConfirmRemove}>${t("knowledge.remove")}</button>
      </div>
    </div>
  </openclaw-modal-dialog>`;
}

type DocumentsUnavailableStatus = Extract<
  KnowledgeDocumentsState,
  { phase: "unavailable" }
>["status"];

function documentsUnavailableLabel(status: DocumentsUnavailableStatus) {
  switch (status) {
    case "read-only":
      return t("knowledge.filesReadOnly");
    case "unsupported":
      return t("knowledge.filesUnsupported");
    case "not-registered":
      return t("knowledge.filesNotRegistered");
    default:
      return t("knowledge.filesFailed");
  }
}

function documentStatusLabel(status: EnterpriseKnowledgeDocument["status"]) {
  switch (status) {
    case "pending":
      return t("knowledge.docStatusPending");
    case "processing":
      return t("knowledge.docStatusProcessing");
    case "indexed":
      return t("knowledge.docStatusIndexed");
    case "failed":
      return t("knowledge.docStatusFailed");
    case "unknown":
      return t("knowledge.docStatusUnknown");
  }
  const unreachable: never = status;
  return unreachable;
}

function documentStatusColor(status: EnterpriseKnowledgeDocument["status"]) {
  switch (status) {
    case "indexed":
      return "var(--ok)";
    case "failed":
      return "var(--danger)";
    default:
      // Pending/processing/unknown are in-progress or unclassified, not errors.
      return "var(--muted)";
  }
}

function renderConnectionStatus(connection: KnowledgeConnectionState | undefined) {
  if (!connection || connection.phase === "testing") {
    return nothing;
  }
  const title = statusTitle(connection.status);
  return html`<span
    class="chip"
    style=${`color: ${statusColor(connection.status)};`}
    title=${title ?? nothing}
    >${statusLabel(connection.status)}${connection.detail ? html` — ${connection.detail}` : nothing}
  </span>`;
}

function renderReferences(references: readonly EnterpriseKnowledgeFoundationReference[]) {
  if (references.length === 0) {
    // An unreferenced foundation is registered but unreachable by any step, so
    // it is called out rather than silently rendered as an empty section.
    return html`<div class="list-meta" style="margin-top: 8px;">
      ${t("knowledge.referencedByNone")}
    </div>`;
  }
  return html`<details style="margin-top: 8px;">
    <summary class="list-meta">
      ${t("knowledge.referencedBy", { count: String(references.length) })}
    </summary>
    <div class="muted" style="margin-top: 4px;">${t("knowledge.referencedByHint")}</div>
    <div class="chip-row" style="margin-top: 4px;">
      ${references.map(
        (reference) =>
          html`<span class="chip" title=${`${reference.treeId} / ${reference.nodeId}`}>
            ${reference.treeName} · ${reference.nodeTitle}
          </span>`,
      )}
    </div>
  </details>`;
}

function kindLabel(kind: EnterpriseKnowledgeFoundationSummary["kind"]) {
  return kind === "local" ? t("knowledge.kindLocal") : t("knowledge.kindRemote");
}

function kindTitle(kind: EnterpriseKnowledgeFoundationSummary["kind"]) {
  return kind === "local" ? t("knowledge.kindLocalTitle") : t("knowledge.kindRemoteTitle");
}

function statusLabel(status: EnterpriseKnowledgeConnectionStatus) {
  switch (status) {
    case "ok":
      return t("knowledge.statusOk");
    case "failed":
      return t("knowledge.statusFailed");
    case "unsupported":
      return t("knowledge.statusUnsupported");
    case "not-registered":
      return t("knowledge.statusNotRegistered");
  }
  // Keeps the switch exhaustiveness-checked: a new status becomes a type error
  // here rather than silently rendering as a blank chip.
  const unreachable: never = status;
  return unreachable;
}

/** Extra context for the two statuses that are neither reachable nor down. */
function statusTitle(status: EnterpriseKnowledgeConnectionStatus) {
  switch (status) {
    case "unsupported":
      return t("knowledge.statusUnsupportedTitle");
    case "not-registered":
      return t("knowledge.statusNotRegisteredTitle");
    default:
      return undefined;
  }
}

function statusColor(status: EnterpriseKnowledgeConnectionStatus) {
  switch (status) {
    case "ok":
      return "var(--ok)";
    case "failed":
      return "var(--danger)";
    // "cannot check" and "gone from the registry" are not failures of the
    // server, so they must not read as red.
    default:
      return "var(--muted)";
  }
}
