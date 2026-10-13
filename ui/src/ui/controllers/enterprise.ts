// Control UI controller manages the enterprise inspection gateway state.
import type {
  EnterpriseBundlesExportResult,
  EnterpriseBundlesImportResult,
  EnterpriseBundlesPreviewResult,
  EnterpriseKnowledgeFoundationsListResult,
  EnterpriseKnowledgeFoundationSummary,
  EnterpriseObjectsListResult,
  EnterpriseOntologyObject,
  EnterpriseRunDetail,
  EnterpriseRunsGetResult,
  EnterpriseRunsResumeResult,
  EnterpriseRunsListResult,
  EnterpriseRunSummary,
  EnterpriseTreeDetail,
  EnterpriseTreeImportIssue,
  EnterpriseTreesExportResult,
  EnterpriseTreesGetResult,
  EnterpriseTreesHistoryGetResult,
  EnterpriseTreesHistoryListResult,
  EnterpriseTreesImportResult,
  EnterpriseTreesListResult,
  EnterpriseTreesRemoveResult,
  EnterpriseTreeSummary,
  EnterpriseTreeVersionSummary,
  ToolsCatalogResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { enterpriseResumeRefusalMessage } from "../enterprise-resume.ts";
import { GatewayNotConnectedError, GatewayRequestError } from "../gateway.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { nodeObjectEntityIds } from "../views/enterprise-ontology-graph.ts";
import {
  addNodeOntologyAction,
  addNodeOntologyActionEffect,
  addNodeOntologyActionParameter,
  addNodeOntologyConstraint,
  addNodeOntologyEntry,
  addNodeOntologyEntity,
  addNodeOntologyFunction,
  addNodeOntologyProperty,
  addNodeOntologyRelationship,
  disableTreeMcpGovernance,
  enableNodeMcpGovernance,
  removeNodeOntologyAction,
  removeNodeOntologyActionEffect,
  removeNodeOntologyActionParameter,
  removeNodeOntologyConstraint,
  removeNodeOntologyEntity,
  removeNodeOntologyEntry,
  removeNodeOntologyFunction,
  removeNodeOntologyProperty,
  removeNodeOntologyRelationship,
  removeTreeNode,
  setTreeSettings,
  setNodeBehavior,
  moveTreeNode,
  updateNodeOntologyMetadata,
  ONTOLOGY_EDIT_REASONS,
  type OntologyCardinalityName,
  type OntologyEditReason,
  type OntologyEffectKindName,
  type OntologyValueTypeName,
  type TreeStructureEditReason,
  isValidEnterpriseId,
  isValidSkillName,
  type EditableTreeDefinition,
  insertChildNode,
  newNodeIdIssue,
  type NodeOntologyListField,
  type NodeOntologyMetadataUpdate,
} from "../views/enterprise-tree-edit.ts";
import { parseMcpServerImport, type McpServerImportError } from "./mcp-server-import.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type EnterpriseTreeRemoveGuard =
  | { expectedHash: string }
  | { expectedInvalidFingerprint: string };

/** The pending confirmation the Save/Remove modal is asking the operator about. */
export type EnterpriseTreeConfirm =
  | { kind: "save" }
  | { kind: "remove"; treeId: string; guard: EnterpriseTreeRemoveGuard };

export type EnterpriseTreeEditFormat = "yaml" | "json";

export type EnterpriseTreeImportGuard = { createOnly: true } | { expectedHash: string } | null;

type EnterpriseBundlePreviewSuccess = Extract<EnterpriseBundlesPreviewResult, { ok: true }>;

/** Exact local bytes and the server review that must be confirmed together. */
export type EnterpriseBundleDraft = {
  fileName: string;
  content: string;
  format: EnterpriseTreeEditFormat;
  preview: EnterpriseBundlePreviewSuccess;
};

export type EnterpriseBundleStatus = {
  kind: "error" | "warning" | "success";
  message: string;
};

export type EnterpriseGuidanceDraft = {
  treeId: string;
  nodeId: string;
  expectedHash: string | null;
  title: string;
  parentId: string | null;
  position: number;
  description: string;
  text: string;
  contextHints: string[];
  expectedOutput: string;
  audit: boolean;
  error: "title-empty" | "move-refused" | null;
};

export type EnterpriseTreeDraftError =
  | "id-empty"
  | "id-pattern"
  | "id-duplicate"
  | "version-empty"
  | "name-empty"
  | "triggers-empty"
  | "priority-invalid"
  | "execution-model-invalid"
  | "root-id-empty"
  | "root-id-pattern"
  | "root-title-empty";

export type EnterpriseTreeTrigger = "user" | "system" | "subagent";

export type EnterpriseTreeDraft = {
  mode: "create" | "settings";
  expectedHash: string | null;
  id: string;
  version: string;
  name: string;
  description: string;
  executionModel?: string;
  triggers: EnterpriseTreeTrigger[];
  priority: string;
  rootId: string;
  rootTitle: string;
  error: EnterpriseTreeDraftError | null;
};

/** Why a node-add draft was rejected; the view maps each to an i18n message. */
export type EnterpriseNodeDraftError =
  | "id-empty"
  | "id-pattern"
  | "id-duplicate"
  | "title-empty"
  | "parent-missing";

/**
 * An in-progress "add child node" form. Bound to `treeId` so a draft can never be
 * applied to a different tree that happens to share the parent node id (e.g. a
 * root named `root`); `parentId` is the node the child is added under. null when
 * no form is open. On submit the tree is re-exported, spliced, and saved through
 * the same whole-tree import path as the other visual editors.
 */
export type EnterpriseNodeDraft = {
  treeId: string;
  parentId: string;
  id: string;
  title: string;
  description: string;
  error: EnterpriseNodeDraftError | null;
};

export type EnterpriseOntologyEntryDraftError =
  | "entry-empty"
  | "entry-duplicate"
  | "skill-name-invalid"
  | "foundation-id-invalid"
  | "node-missing"
  | "export-failed"
  | "import-not-sent"
  | "import-failed";

/**
 * Why a binding apply stopped. A shape rather than a bare reason because a
 * server REJECTION carries the issue paths that say what to change, and those
 * only exist for that one case — a rejected write is not the same event as one
 * whose outcome is unknown, and telling the operator "this may have applied"
 * about a definite refusal hides the fix.
 */
export type EnterpriseBindingPickerFailure =
  | { kind: EnterpriseOntologyEntryDraftError }
  | { kind: "import-rejected"; issues: EnterpriseTreeImportIssue[] }
  | { kind: "import-refused"; message: string };

/**
 * Which failure a rejected value reports, per field. Tool globs have no name
 * contract, so they are absent — those fields only reject blanks, which the empty
 * check above already caught.
 */
const INVALID_ENTRY_FAILURE: Partial<
  Record<NodeOntologyListField, EnterpriseOntologyEntryDraftError>
> = {
  skills: "skill-name-invalid",
  knowledgeFoundations: "foundation-id-invalid",
};

/**
 * An in-progress step-binding form (a tool grant, a declared skill, or an allowed
 * knowledge foundation) on the step selected in the Worktree inspector.
 *
 * A PICKER, not a text field: the operator searches the catalog the screen
 * already loaded and ticks entries, so a binding is chosen from what exists
 * instead of typed from memory. Tools additionally accept a free-text value,
 * because a tool scope is globs and groups (`group:enterprise`, `memory_*`) that
 * no catalog can enumerate.
 *
 * Bound to `treeId` + `nodeId` so it cannot be applied to a different tree. On
 * submit the tree is re-exported, spliced, and imported directly — the operator
 * asked for the entry, so making them review generated JSON to confirm it added
 * a step they already picked was ceremony, not safety. It is still the same
 * enterprise.trees.import write path.
 */
export type EnterpriseBindingPicker = {
  treeId: string;
  nodeId: string;
  field: NodeOntologyListField;
  /** Search text filtering the catalog list. */
  query: string;
  /** Ticked catalog entries, in click order. */
  selected: string[];
  /** Free-text entry (tools only); added alongside the ticked ones. */
  custom: string;
  /**
   * How far the apply has got. A closed shape rather than a boolean because the
   * two busy phases mean opposite things to the operator: closing during
   * `preparing` (the export) genuinely abandons the change, while closing during
   * `writing` cannot recall a request the server already has.
   */
  phase: "idle" | "preparing" | "writing";
  failure: EnterpriseBindingPickerFailure | null;
};

/**
 * The one binding an operator clicked open on the step inspector, or null.
 *
 * A chip carries a bare id — `group:enterprise`, `summarize`, `acme.kb` — and an
 * operator reading a governed step needs the thing BEHIND it: what the tool
 * actually is, whether the skill is installed, how the server launches, who owns
 * the foundation. That answer lives in catalogs the screen already holds, so this
 * is pure view state: which entry to describe, and whether it belongs to this
 * step or an ancestor (an inherited one has no Detach here — it is edited on the
 * step that declared it).
 *
 * Bound to `treeId` + `nodeId` like the picker: node ids repeat across work-maps,
 * so an unbound one would resurface over a same-named step after a tree switch.
 */
export type EnterpriseBindingDetail = {
  treeId: string;
  nodeId: string;
  field: NodeOntologyListField;
  entry: string;
  /** Declared on this step, or granted by an ancestor and only shown here. */
  origin: "step" | "inherited";
};

/**
 * The "register or adjust an MCP server" form on the Enterprise MCP screen.
 *
 * Registration is the same act as anywhere else in OpenClaw — one entry under
 * `mcp.servers` in config — so this form writes the config draft the Settings
 * screens write and leaves Save/Publish to them. What is enterprise-specific is
 * not the registration but the reach: a registered server stays unreachable until
 * a step attaches it (OntologyBinding.mcpServers).
 */
export type EnterpriseMcpDraft = {
  /**
   * The registered server this form rewrites, or null when it adds one. Editing
   * is safe to do in place because `mcp.servers` is keyed by name: the gateway
   * restores a stored header by key, not by position.
   */
  editing: string | null;
  /**
   * That server's config as it stood when this form opened, serialized.
   *
   * A Refresh — or another admin saving — can repoint the same server name at a
   * new URL and rotate its header. The draft would then stage ITS url with the
   * stored-value sentinel, and `config.set` restores that sentinel from the
   * LATEST snapshot, sending the new credential to the old endpoint. Submit
   * refuses unless the entry is byte-identical to what was opened.
   */
  editingSnapshot: string | null;
  /** Config revision that supplied an edited entry, including its redacted values. */
  editingConfigHash: string | null;
  /**
   * Which half of the form submits. Typing the fields is the path for a server
   * an operator knows; `json` takes the snippet vendors actually publish, which
   * is where the arguments and env vars a retyped entry loses live.
   */
  mode: "fields" | "json";
  name: string;
  /**
   * Stored verbatim as the server's `transport`. HTTP is not one transport:
   * OpenClaw resolves an entry with no `transport` as SSE
   * (src/agents/mcp-transport-config.ts) while Codex reads a bare URL as
   * streamable HTTP, so a server added here has to say which one it is.
   *
   * `unset` is edit-only: an entry that declared no transport keeps that
   * ambiguity until the operator resolves it, because writing either value
   * would change how one of the two runtimes dials a server they only came here
   * to rename a header on.
   */
  transport: "stdio" | "streamable-http" | "sse" | "unset";
  /** stdio: the executable to spawn. */
  command: string;
  /** stdio: whitespace-separated arguments. Anything quoted belongs in the config editor. */
  args: string;
  /**
   * stdio: the argument array this draft was seeded from. An untouched edit
   * writes it back verbatim — round-tripping through a space-joined string
   * would split `"hello world"` into two arguments.
   */
  argsOriginal: readonly string[] | null;
  /** http: the server URL. */
  url: string;
  /**
   * http: whether `url` stands in for a stored value the browser never got. A
   * credential-bearing URL is redacted like a header, so it is blanked and
   * written back untouched unless the operator types a replacement.
   */
  urlStored: boolean;
  /**
   * http: request headers, as ordered rows rather than a record, so a half-typed
   * name does not collapse two rows into one while the operator is still typing.
   * This is how a remote server is authenticated without OAuth.
   */
  headers: McpHeaderRow[];
  /** http: whether the runtime should run its OAuth flow for this server. */
  oauth: boolean;
  /** json: the pasted snippet, parsed by parseMcpServerImport on submit. */
  json: string;
  error: EnterpriseMcpDraftError | null;
  /**
   * Which value the error is about — a server name from a multi-server snippet,
   * or the parser's own message. Without it a rejected paste names no line to fix.
   */
  errorDetail?: string;
};

/**
 * One header row. `stored` marks a value the gateway redacted: the browser was
 * never given it, so the row shows as unchanged and writes the sentinel back
 * unless the operator types a replacement.
 */
export type McpHeaderRow = {
  name: string;
  value: string;
  /** The row still carries its saved value, which this form is not showing. */
  stored: boolean;
  /**
   * That saved value, written back verbatim while `stored` holds. Covers both a
   * redaction sentinel and a scalar the text input cannot represent — config
   * allows boolean and number headers, and rendering one as "" would rewrite it.
   */
  savedValue?: unknown;
};

export type EnterpriseMcpDraftError =
  | "name-empty"
  | "name-taken"
  | "name-unsupported"
  | "launch-missing"
  | "url-invalid"
  | "header-name-empty"
  | "header-name-duplicate"
  | "header-name-invalid"
  | "transport-unset"
  | "entry-changed"
  | "json-name-mismatch"
  | McpServerImportError;

/**
 * A valid HTTP field name (RFC 7230 token). The config schema accepts any
 * string, but the MCP SDK builds a `Headers` from these and throws on an
 * invalid one — so Save/Publish would succeed and the server would refuse to
 * start, with nothing on this screen pointing at the cause.
 */
const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Names the config form's path writer refuses, so the form must refuse them first. */
const UNWRITABLE_SERVER_NAMES = new Set(["__proto__", "prototype", "constructor"]);

/**
 * The gateway replaces every stored credential with this before sending config
 * to the browser and swaps the real value back in on save, so a header value the
 * form never received round-trips untouched.
 */
const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/**
 * The transport an existing entry already resolves to.
 *
 * Canonical `transport` wins outright, and the legacy `type` alias is read only
 * when it is absent — the precedence `resolveMcpTransportConfig` applies
 * (src/agents/mcp-transport-config.ts). Consulting both at once would let an
 * entry carrying `transport: "streamable-http"` alongside a stale `type: "sse"`
 * open on SSE; saving an unrelated field then drops `type` and writes that
 * reading back as canonical, silently changing the endpoint's protocol.
 */
function resolveDraftTransport(declared: string, alias: string): EnterpriseMcpDraft["transport"] {
  const effective = declared || alias;
  if (effective === "sse") {
    return "sse";
  }
  if (effective === "streamable-http" || effective === "http") {
    return "streamable-http";
  }
  return "unset";
}

function emptyMcpDraft(): EnterpriseMcpDraft {
  return {
    editing: null,
    editingSnapshot: null,
    editingConfigHash: null,
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
  };
}

export function beginEnterpriseMcpDraft(state: EnterpriseState) {
  // The form owns unsaved credentials and launch settings. A second open action
  // must not replace that draft before the operator explicitly cancels it.
  if (state.enterpriseMcpDraft || state.enterpriseMcpRemoveConfirm) {
    return;
  }
  state.enterpriseMcpDraft = emptyMcpDraft();
}

/**
 * Open the same form on a server already in `mcp.servers`.
 *
 * Seeded from the config draft, so a server registered but not yet saved can be
 * corrected without publishing it first. A redacted header comes back blank with
 * its `stored` flag set rather than as placeholder text: a masked box full of
 * dots reads as a value the operator could edit character by character, and it
 * cannot be.
 */
export function beginEnterpriseMcpEdit(
  state: EnterpriseState,
  params: { name: string; server: Record<string, unknown>; configHash?: string | null },
) {
  // Lit updates after the click handler returns, so another still-visible row
  // can be activated before its controls disable. Keep the draft at this boundary.
  if (state.enterpriseMcpDraft || state.enterpriseMcpRemoveConfirm) {
    return;
  }
  const { server } = params;
  // Trimmed, matching resolveStdioMcpServerLaunchConfig: the embedded resolver
  // ignores a blank command and treats such an entry as HTTP, so seeding stdio
  // here would hide the URL and auth fields and then fail as launch-missing.
  const command = typeof server.command === "string" ? server.command.trim() : "";
  // Normalized like the alias below, matching getRequestedTransport in
  // src/agents/mcp-transport-config.ts: the runtime lowercases both, so a
  // config spelling "SSE" must open the same draft here as "sse".
  const declared =
    typeof server.transport === "string" ? server.transport.trim().toLowerCase() : "";
  const alias = typeof server.type === "string" ? server.type.trim().toLowerCase() : "";
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : null;
  const url = typeof server.url === "string" ? server.url : "";
  const headers =
    server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
      ? Object.entries(server.headers as Record<string, unknown>).map(([name, value]) =>
          // A plain string is editable text. A sentinel or a non-string scalar
          // is not: the form shows the row as unchanged and writes the saved
          // value straight back unless the operator types over it.
          typeof value === "string" && value !== REDACTED_SENTINEL
            ? { name, value, stored: false }
            : { name, value: "", stored: true, savedValue: value },
        )
      : [];
  state.enterpriseMcpDraft = {
    ...emptyMcpDraft(),
    editing: params.name,
    // Serialized identity, so a refresh that repoints this name is caught even
    // though the name itself did not move.
    editingSnapshot: JSON.stringify(server),
    editingConfigHash: params.configHash ?? null,
    name: params.name,
    // A command wins however the entry is labelled, matching
    // resolveMcpTransportConfig. Otherwise the transport this entry ALREADY
    // resolves to, and `unset` when it declares none, so an unrelated edit
    // cannot silently repoint the server.
    transport: command ? "stdio" : resolveDraftTransport(declared, alias),
    command,
    args: args ? args.join(" ") : "",
    argsOriginal: args,
    url: url === REDACTED_SENTINEL ? "" : url,
    urlStored: url === REDACTED_SENTINEL,
    headers,
    oauth: server.auth === "oauth",
  };
}

export function editEnterpriseMcpDraft(
  state: EnterpriseState,
  patch: Partial<Omit<EnterpriseMcpDraft, "error" | "errorDetail">>,
) {
  const draft = state.enterpriseMcpDraft;
  if (!draft) {
    return;
  }
  // Clearing the error on every edit: the operator is answering it, and a stale
  // "name taken" under a name they just changed reads as a second failure.
  const { errorDetail: _errorDetail, ...rest } = draft;
  state.enterpriseMcpDraft = { ...rest, ...patch, error: null };
}

/** Add, change, or drop one header row without touching the rest of the draft. */
export function editEnterpriseMcpHeader(
  state: EnterpriseState,
  index: number,
  patch: { name?: string; value?: string } | null,
) {
  const draft = state.enterpriseMcpDraft;
  if (!draft) {
    return;
  }
  const headers =
    patch === null
      ? draft.headers.filter((_row, at) => at !== index)
      : draft.headers.map((row, at) => {
          if (at !== index) {
            return row;
          }
          // A stored row's NAME is fixed: the gateway restores the sentinel by
          // header key, so moving it would write a reserved value under a path
          // holding nothing and be refused at save. The view makes it readonly;
          // this is the same rule at the state layer.
          const replaced = patch.value !== undefined;
          const next: McpHeaderRow = {
            name: row.stored ? row.name : (patch.name ?? row.name),
            value: patch.value ?? row.value,
            // Typing into a stored value replaces it, so the row stops standing
            // in for a value the browser never saw.
            stored: replaced ? false : row.stored,
          };
          // The saved value only travels while the row still stands in for it.
          if (!replaced && row.savedValue !== undefined) {
            next.savedValue = row.savedValue;
          }
          return next;
        });
  editEnterpriseMcpDraft(state, { headers });
}

export function addEnterpriseMcpHeader(state: EnterpriseState) {
  const draft = state.enterpriseMcpDraft;
  if (!draft) {
    return;
  }
  editEnterpriseMcpDraft(state, {
    headers: [...draft.headers, { name: "", value: "", stored: false }],
  });
}

export function cancelEnterpriseMcpDraft(state: EnterpriseState) {
  state.enterpriseMcpDraft = null;
}

/**
 * Validate the form and hand the new entry to `apply`, which owns the config
 * write. The write stays with the config controller so this screen cannot grow a
 * second way to save config; this function owns only the form's contract.
 */
export function submitEnterpriseMcpDraft(
  state: EnterpriseState,
  params: {
    existingNames: readonly string[];
    /** The registered entry being edited, so config this form does not render survives. */
    existingServer?: Record<string, unknown>;
    /** Current config revision, used to detect changes hidden by redaction. */
    currentConfigHash?: string | null;
    apply: (name: string, server: Record<string, unknown>) => void;
  },
) {
  const draft = state.enterpriseMcpDraft;
  if (!draft) {
    return;
  }
  const fail = (error: EnterpriseMcpDraftError, detail?: string) => {
    state.enterpriseMcpDraft = { ...draft, error, ...(detail ? { errorDetail: detail } : {}) };
  };
  // Checked before the mode dispatch: a paste can carry a redaction sentinel
  // too, so a JSON-mode edit against a changed entry combines the latest secret
  // with a stale URL exactly as the typed half would.
  const configChanged =
    draft.editingConfigHash !== null &&
    params.currentConfigHash !== undefined &&
    params.currentConfigHash !== draft.editingConfigHash;
  if (
    draft.editing &&
    (configChanged || JSON.stringify(params.existingServer ?? null) !== draft.editingSnapshot)
  ) {
    fail("entry-changed");
    return;
  }
  if (draft.mode === "json") {
    submitMcpImport(state, draft, params, fail);
    return;
  }
  // An edit keeps the registered name. It is the key steps attach by
  // (`ontology.mcpServers`), and nothing migrates them — and it is also the
  // redaction lookup path, so a stored header could not restore under a new
  // key. Renaming means removing and registering again.
  const name = draft.editing ?? draft.name.trim();
  if (!name) {
    fail("name-empty");
    return;
  }
  // Config keys are unique, so a repeated name would REPLACE a working server
  // rather than add one — and take its steps' attachments somewhere else with it.
  if (!draft.editing && params.existingNames.some((existing) => existing === name)) {
    fail("name-taken");
    return;
  }
  // The config form writes through a path setter that refuses these segments
  // (isForbiddenKey in controllers/config/form-utils.ts), so registering one would
  // write nothing and close as if it had worked.
  if (UNWRITABLE_SERVER_NAMES.has(name)) {
    fail("name-unsupported");
    return;
  }
  const entry = buildMcpServerEntry(draft, params.existingServer);
  if (entry.kind !== "ok") {
    fail(entry.kind);
    return;
  }
  params.apply(name, entry.server);
  state.enterpriseMcpDraft = null;
}

/**
 * Register every server in a pasted snippet, or none of them.
 *
 * The name check runs across the whole snippet before the first write: a paste
 * is one unit, and half-registering it would leave the operator believing the
 * server the collision hid is there too.
 */
function submitMcpImport(
  state: EnterpriseState,
  draft: EnterpriseMcpDraft,
  params: {
    existingNames: readonly string[];
    apply: (name: string, server: Record<string, unknown>) => void;
  },
  fail: (error: EnterpriseMcpDraftError, detail?: string) => void,
) {
  const parsed = parseMcpServerImport(draft.json);
  if (parsed.kind !== "ok") {
    fail(parsed.kind, parsed.detail);
    return;
  }
  const taken = new Set(params.existingNames);
  if (draft.editing) {
    // An edit's own name is not a collision: pasting a corrected snippet over
    // the server being edited is the point of the paste half. But the snippet
    // has to CARRY that name — otherwise the paste registers new servers and
    // silently leaves the edited one behind, under a button saying "Update".
    if (!parsed.entries.some((entry) => entry.name === draft.editing)) {
      fail("json-name-mismatch", draft.editing);
      return;
    }
    taken.delete(draft.editing);
  }
  const collision = parsed.entries.find((entry) => taken.has(entry.name));
  if (collision) {
    fail("name-taken", collision.name);
    return;
  }
  for (const entry of parsed.entries) {
    params.apply(entry.name, entry.server);
  }
  state.enterpriseMcpDraft = null;
}

/**
 * The config entry for a draft, or why it cannot be one. The URL is checked here
 * rather than left to the config schema: the schema rejects it only at save time,
 * long after this form closed, leaving a failed Save and nothing to correct it in.
 */
function buildMcpServerEntry(
  draft: EnterpriseMcpDraft,
  existing?: Record<string, unknown>,
):
  | { kind: "ok"; server: Record<string, unknown> }
  | { kind: "launch-missing" }
  | { kind: "url-invalid" }
  | { kind: "transport-unset" }
  | { kind: "header-name-empty" }
  | { kind: "header-name-duplicate" }
  | { kind: "header-name-invalid" } {
  // Start from the registered entry so settings this form does not render —
  // toolFilter, timeouts, tool policy — are not dropped by an edit that never
  // touched them. Every field the form DOES own is cleared first, so switching
  // transport cannot leave both launches behind.
  const server: Record<string, unknown> = { ...existing };
  for (const key of ["command", "args", "url", "transport", "type", "headers", "auth"]) {
    delete server[key];
  }
  // ...and so is every field belonging to the transport being switched AWAY
  // from. OpenClaw would quietly ignore the leftovers, but its Codex projection
  // copies them (src/agents/cli-runner/bundle-mcp-adapter-shared.ts) and Codex
  // rejects `env`/`cwd` on a URL transport and URL fields on stdio
  // (../codex/codex-rs/config/src/mcp_types.rs), so the saved server would fail
  // to initialize for Codex-backed runs.
  const stdioOnlyKeys = ["env", "cwd", "workingDirectory"];
  const httpOnlyKeys = [
    "oauth",
    "sslVerify",
    "ssl_verify",
    "clientCert",
    "clientKey",
    "client_cert",
    "client_key",
  ];
  for (const key of draft.transport === "stdio" ? httpOnlyKeys : stdioOnlyKeys) {
    delete server[key];
  }
  if (draft.transport !== "stdio") {
    // The seeded entry declared no transport and the operator did not resolve
    // it. Both values are wrong to guess: OpenClaw reads an unset one as SSE
    // and Codex reads a bare URL as streamable HTTP, so saving either would
    // repoint the server for one of them.
    if (draft.transport === "unset") {
      return { kind: "transport-unset" };
    }
    const typed = draft.url.trim();
    // A blank URL on an entry whose stored one is redacted means "leave it":
    // the browser was never given the value, so it is written straight back.
    const url = !typed && draft.urlStored ? REDACTED_SENTINEL : typed;
    if (!url) {
      return { kind: "launch-missing" };
    }
    if (url !== REDACTED_SENTINEL && !isHttpUrl(url)) {
      return { kind: "url-invalid" };
    }
    const headers = buildMcpHeaders(draft.headers);
    if (headers.kind !== "ok") {
      return headers;
    }
    server.url = url;
    // `transport` is written explicitly: the two HTTP transports are not
    // interchangeable, and leaving it out makes each runtime guess differently.
    server.transport = draft.transport;
    if (Object.keys(headers.headers).length > 0) {
      server.headers = headers.headers;
    }
    if (draft.oauth) {
      server.auth = "oauth";
    }
    return { kind: "ok", server };
  }
  const command = draft.command.trim();
  if (!command) {
    return { kind: "launch-missing" };
  }
  server.command = command;
  const args = resolveMcpArgs(draft);
  if (args.length > 0) {
    server.args = args;
  }
  return { kind: "ok", server };
}

/**
 * The argument array an edit should write.
 *
 * An untouched field writes the seeded array back verbatim. This form joins
 * arguments with spaces and splits them the same way, so a round trip would
 * turn `["--label", "hello world"]` into three arguments — an edit that only
 * changed a URL must not rewrite the subprocess invocation.
 */
function resolveMcpArgs(draft: EnterpriseMcpDraft): string[] {
  const original = draft.argsOriginal;
  if (original && draft.args === original.join(" ")) {
    return [...original];
  }
  return draft.args.split(/\s+/).filter((arg) => arg.length > 0);
}

/**
 * The header record a draft's rows describe, or why they do not make one.
 *
 * A row still marked `stored` writes the sentinel back, which is what tells the
 * gateway to keep the credential the browser was never given. A blank value on
 * an un-stored row is a real empty header, not a deletion — removing a header is
 * removing its row.
 */
function buildMcpHeaders(
  rows: readonly McpHeaderRow[],
):
  | { kind: "ok"; headers: Record<string, unknown> }
  | { kind: "header-name-empty" }
  | { kind: "header-name-duplicate" }
  | { kind: "header-name-invalid" } {
  const headers: Record<string, unknown> = {};
  // HTTP header names are case-insensitive, so `Authorization` and
  // `authorization` are one header in two object keys. Collapsing them into a
  // record would keep whichever came last and leave what the server actually
  // receives ambiguous, so the form refuses instead.
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    // A value with no header name reaches nothing and would be silently dropped
    // on save, so the form refuses rather than letting it look configured.
    if (!name) {
      if (row.value.trim() || row.stored) {
        return { kind: "header-name-empty" };
      }
      continue;
    }
    if (!HTTP_FIELD_NAME.test(name)) {
      return { kind: "header-name-invalid" };
    }
    if (seen.has(name.toLowerCase())) {
      return { kind: "header-name-duplicate" };
    }
    seen.add(name.toLowerCase());
    // defineProperty, not assignment: `__proto__` is a valid HTTP field name,
    // and `headers.__proto__ = x` invokes the legacy setter instead of storing
    // it — the form would close having silently dropped the header.
    Object.defineProperty(headers, name, {
      value: row.stored ? (row.savedValue ?? REDACTED_SENTINEL) : row.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { kind: "ok", headers };
}

/** MCP over HTTP means http(s); anything else cannot be dialed by the runtime. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Load state of the tool/skill/knowledge catalogs the enterprise screens browse. */
export type EnterpriseCatalogPhase = "unloaded" | "loading" | "ready";

/**
 * Per-catalog load failure. Kept separate rather than one shared message because
 * the three come from independent gateway methods and land on different surfaces:
 * a failed skill probe must not put an error banner on the Tools tab.
 */
export type EnterpriseCatalogErrors = {
  /** undefined while unresolved, null after success, otherwise the failure. */
  tools: string | null | undefined;
  skills: string | null | undefined;
  foundations: string | null | undefined;
};

export type EnterpriseListErrors = {
  /** undefined while unresolved, null after success, otherwise the failure. */
  runs: string | null | undefined;
  trees: string | null | undefined;
};

export type EnterpriseState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enterpriseLoading: boolean;
  enterpriseRuns: EnterpriseRunSummary[];
  enterpriseTrees: EnterpriseTreeSummary[];
  enterpriseHistoryOnlyTreeIds: string[];
  enterpriseListErrors: EnterpriseListErrors;
  enterpriseImportErrors: EnterpriseTreesListResult["importErrors"];
  enterpriseStoreError: string | null;
  enterpriseSelectedExecutionId: string | null;
  enterpriseDetail: EnterpriseRunDetail | null;
  enterpriseDetailLoading: boolean;
  /**
   * The tree the SELECTED RUN bound to. Held separately from the registry
   * selection (enterpriseTreeDetail) so opening a run cannot clobber the tree
   * the operator is browsing, and so the run inspector can draw the full tree
   * with the run's route lit against the branches it did not take.
   */
  enterpriseRunTree: EnterpriseTreeDetail | null;
  enterpriseSelectedTreeId: string | null;
  enterpriseTreeDetail: EnterpriseTreeDetail | null;
  enterpriseTreeLoading: boolean;
  enterpriseTreeIssue: string | null;
  // P4 node inspector: the expanded workflow node, which entity type's instances
  // are shown for it, and those rows. Cleared on tree switch/reload.
  enterpriseSelectedNodeId: string | null;
  enterpriseNodeObjectsEntity: string | null;
  enterpriseNodeObjects: EnterpriseOntologyObject[];
  enterpriseNodeObjectsLoading: boolean;
  enterpriseNodeObjectsError: string | null;
  enterpriseTreeEditing: boolean;
  enterpriseVisualEditOriginal?: EnterpriseTreeDetail | null;
  enterpriseTreeDraft: EnterpriseTreeDraft | null;
  // The id being edited, or null for a brand-new tree — distinguishes create
  // from edit so format switches reseed from the right source.
  enterpriseTreeEditTreeId: string | null;
  // The historical revision being edited, or null when editing the current
  // definition or a new tree — so format switches reseed from history.get.
  enterpriseTreeEditRevision: number | null;
  enterpriseTreeEditGuard: EnterpriseTreeImportGuard;
  enterpriseTreeEditContent: string;
  enterpriseTreeEditFormat: EnterpriseTreeEditFormat;
  enterpriseTreeSaving: boolean;
  enterpriseTreeSaveIssues: EnterpriseTreeImportIssue[] | null;
  enterpriseTreeWarnings: EnterpriseTreeImportIssue[] | null;
  enterpriseTreeSaveError: string | null;
  enterpriseTreeConfirm: EnterpriseTreeConfirm | null;
  enterpriseBundleDraft: EnterpriseBundleDraft | null;
  enterpriseBundleStatus: EnterpriseBundleStatus | null;
  enterpriseTreeVersions: EnterpriseTreeVersionSummary[];
  enterpriseTreeVersionsLoading: boolean;
  enterpriseTreeVersionsError: string | null;
  // P5 dynamic node creation: the open "add child node" form, or null. Splices a
  // child into the tree definition and reuses the editor's import-to-save flow.
  enterpriseNodeDraft: EnterpriseNodeDraft | null;
  enterpriseBindingPicker: EnterpriseBindingPicker | null;
  /** The binding chip whose detail card is open, or null. Pure view state. */
  enterpriseBindingDetail: EnterpriseBindingDetail | null;
  /**
   * Unsaved behavior edit for one step. Held outside the tree detail because
   * that is a fetched snapshot the reload replaces; a draft has to survive it.
   * Carries its treeId: node ids are only unique WITHIN a tree (roots collide
   * constantly), so without it a draft from tree A would show under — and save
   * into — the same-named step of tree B.
   */
  enterpriseGuidanceDraft: EnterpriseGuidanceDraft | null;
  /**
   * The one open ontology form. A single slot rather than one per kind: only one
   * can be filled in at a time, and a slot per kind would leave half-typed forms
   * hanging around the inspector after the operator moved on.
   */
  enterpriseOntologyDraft: EnterpriseOntologyDraft | null;
  enterpriseMcpDraft: EnterpriseMcpDraft | null;
  enterpriseMcpRemoveConfirm: string | null;
  // Catalogs of what a step can be bound TO: every tool the gateway exposes,
  // every installed skill, and every registered knowledge foundation. Read-only
  // reference data, loaded independently of the run/tree state.
  enterpriseCatalogPhase: EnterpriseCatalogPhase;
  enterpriseCatalogErrors: EnterpriseCatalogErrors;
  /**
   * The agent the tool/skill catalogs describe. Both are agent-scoped server-side
   * (plugin tools resolve against an agent's workspace, skills against its filter),
   * so the surfaces must name it rather than imply a deployment-wide list.
   */
  enterpriseCatalogAgentId: string | null;
  enterpriseToolGroups: ToolsCatalogResult["groups"];
  enterpriseSkills: SkillStatusEntry[];
  enterpriseFoundations: EnterpriseKnowledgeFoundationSummary[];
  enterpriseError: string | null;
  enterpriseResuming: boolean;
};

// Monotonic token so the latest list load wins. A guarded "skip if already
// loading" would make a post-mutation reload a no-op while a tab-load/refresh is
// in flight, leaving the just-saved/removed tree missing; the token instead lets
// the newer load supersede the older, whose stale response is then dropped.
let listRequestSeq = 0;

/** Load the recent-run list and the workflow-tree registry for the tab. */
export async function loadEnterprise(
  state: EnterpriseState,
  waitFor: "all" | "runs" | "trees" = "all",
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const requestSeq = ++listRequestSeq;
  state.enterpriseLoading = true;
  state.enterpriseError = null;
  state.enterpriseListErrors = { runs: undefined, trees: undefined };
  let pending = 2;
  const finish = () => {
    pending--;
    if (requestSeq === listRequestSeq && pending === 0) {
      state.enterpriseLoading = false;
    }
  };
  const runs = Promise.resolve()
    .then(() => client.request<EnterpriseRunsListResult>("enterprise.runs.list", {}))
    .then(
      (result) => {
        if (requestSeq === listRequestSeq) {
          state.enterpriseRuns = result.runs;
          state.enterpriseListErrors = { ...state.enterpriseListErrors, runs: null };
        }
      },
      (error: unknown) => {
        if (requestSeq !== listRequestSeq) {
          return;
        }
        if (isMissingOperatorReadScopeError(error)) {
          applyError(state, error);
          return;
        }
        state.enterpriseListErrors = { ...state.enterpriseListErrors, runs: String(error) };
      },
    )
    .finally(finish);
  const trees = Promise.resolve()
    .then(() => client.request<EnterpriseTreesListResult>("enterprise.trees.list", {}))
    .then(
      (result) => {
        if (requestSeq !== listRequestSeq) {
          return;
        }
        state.enterpriseTrees = result.trees;
        state.enterpriseHistoryOnlyTreeIds = result.historyOnlyTreeIds ?? [];
        state.enterpriseListErrors = { ...state.enterpriseListErrors, trees: null };
        state.enterpriseImportErrors = result.importErrors;
        state.enterpriseStoreError = result.storeError ?? null;
      },
      (error: unknown) => {
        if (requestSeq !== listRequestSeq) {
          return;
        }
        if (isMissingOperatorReadScopeError(error)) {
          applyError(state, error);
          return;
        }
        state.enterpriseListErrors = { ...state.enterpriseListErrors, trees: String(error) };
        // These rows describe the last successful registry snapshot. They are
        // not safe mutation targets after a failed refresh.
        state.enterpriseImportErrors = [];
        state.enterpriseHistoryOnlyTreeIds = [];
        state.enterpriseStoreError = null;
      },
    )
    .finally(finish);
  // Keep the returned promise useful to refresh/save callers, while each panel
  // publishes as soon as ITS request settles instead of waiting for its sibling.
  await (waitFor === "runs" ? runs : waitFor === "trees" ? trees : Promise.all([runs, trees]));
}

// Separate token: the catalogs race independently from the run/tree loads.
let catalogRequestSeq = 0;

/** Turn a catalog rejection into the message its surface shows. */
function catalogErrorMessage(err: unknown, feature: string): string {
  return isMissingOperatorReadScopeError(err)
    ? formatMissingOperatorReadScopeMessage(feature)
    : String(err);
}

/**
 * Load the three catalogs the enterprise screens browse and bind FROM: every tool
 * the gateway exposes, every installed skill, and every registered knowledge
 * foundation. No agent id is sent, so each answers for the default agent — these
 * are deployment-wide reference lists, not an agent's effective set.
 *
 * Settled independently: one failing catalog leaves the other two usable, because
 * a step can be bound to any of the three and a dead skill probe must not take the
 * tool list down with it.
 */
export async function loadEnterpriseCatalogs(state: EnterpriseState) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const requestSeq = ++catalogRequestSeq;
  state.enterpriseCatalogPhase = "loading";
  state.enterpriseCatalogErrors = {
    tools: undefined,
    skills: undefined,
    foundations: undefined,
  };
  state.enterpriseCatalogAgentId = null;
  let pending = 3;
  let toolsAgentId: string | null = null;
  let skillsAgentId: string | null = null;
  const updateAgentId = () => {
    if (requestSeq === catalogRequestSeq) {
      state.enterpriseCatalogAgentId = toolsAgentId ?? skillsAgentId;
    }
  };
  const finish = () => {
    pending--;
    if (requestSeq === catalogRequestSeq && pending === 0) {
      state.enterpriseCatalogPhase = "ready";
    }
  };
  const tools = Promise.resolve()
    .then(() => client.request<ToolsCatalogResult>("tools.catalog", { includePlugins: true }))
    .then(
      (result) => {
        if (requestSeq !== catalogRequestSeq) {
          return;
        }
        state.enterpriseToolGroups = result.groups;
        state.enterpriseCatalogErrors = { ...state.enterpriseCatalogErrors, tools: null };
        toolsAgentId = result.agentId ?? null;
        updateAgentId();
      },
      (error: unknown) => {
        if (requestSeq !== catalogRequestSeq) {
          return;
        }
        state.enterpriseToolGroups = [];
        state.enterpriseCatalogErrors = {
          ...state.enterpriseCatalogErrors,
          tools: catalogErrorMessage(error, "the tool catalog"),
        };
      },
    )
    .finally(finish);
  const skills = Promise.resolve()
    .then(() => client.request<SkillStatusReport | undefined>("skills.status", {}))
    .then(
      (result) => {
        if (requestSeq !== catalogRequestSeq) {
          return;
        }
        state.enterpriseSkills = result?.skills ?? [];
        state.enterpriseCatalogErrors = { ...state.enterpriseCatalogErrors, skills: null };
        skillsAgentId = result?.agentId ?? null;
        updateAgentId();
      },
      (error: unknown) => {
        if (requestSeq !== catalogRequestSeq) {
          return;
        }
        state.enterpriseSkills = [];
        state.enterpriseCatalogErrors = {
          ...state.enterpriseCatalogErrors,
          skills: catalogErrorMessage(error, "installed skills"),
        };
      },
    )
    .finally(finish);
  const foundations = Promise.resolve()
    .then(() =>
      client.request<EnterpriseKnowledgeFoundationsListResult>(
        "enterprise.knowledge.foundations.list",
        {},
      ),
    )
    .then(
      (result) => {
        if (requestSeq === catalogRequestSeq) {
          state.enterpriseFoundations = result.foundations;
          state.enterpriseCatalogErrors = {
            ...state.enterpriseCatalogErrors,
            foundations: null,
          };
        }
      },
      (error: unknown) => {
        if (requestSeq !== catalogRequestSeq) {
          return;
        }
        state.enterpriseFoundations = [];
        state.enterpriseCatalogErrors = {
          ...state.enterpriseCatalogErrors,
          foundations: catalogErrorMessage(error, "knowledge foundations"),
        };
      },
    )
    .finally(finish);
  await Promise.all([tools, skills, foundations]);
}

// Monotonic token so only the latest detail request wins. The selected id alone
// can't disambiguate two in-flight requests for the SAME run (double click, or
// Refresh while a detail load is pending), and gateway responses can resolve out
// of order, so a bare id check would let an older response overwrite a newer one.
let detailRequestSeq = 0;

/**
 * Ask for an ended execution to be continued by the next run in its session.
 *
 * Deliberately not "resume now": nothing here starts an agent turn, and the
 * operator's next request in that session is what carries the work forward. That
 * is also what makes it safe — the run to continue is named rather than inferred,
 * and inference cannot separate "carry on with that" from "a new request that
 * routes the same way".
 */
export async function requestEnterpriseRunResume(state: EnterpriseState, executionId: string) {
  const run = state.enterpriseDetail;
  if (
    !state.client ||
    !state.connected ||
    state.enterpriseResuming ||
    state.enterpriseSelectedExecutionId !== executionId ||
    run?.executionId !== executionId ||
    !run.sessionId
  ) {
    return null;
  }
  state.enterpriseResuming = true;
  state.enterpriseError = null;
  try {
    const res = await state.client.request<EnterpriseRunsResumeResult>("enterprise.runs.resume", {
      executionId,
      sessionId: run.sessionId,
    });
    if (res.ok) {
      // Re-read rather than remember: the marker is one-shot and server-owned, so
      // a locally-held "queued" would survive the next run consuming it and keep
      // claiming a resume that already fired.
      //
      // Only while this run is still the selected one. loadEnterpriseRunDetail
      // also SETS the selection, so an operator who moved to another run while
      // this was in flight would be yanked back to the old one.
      if (state.enterpriseSelectedExecutionId === executionId) {
        await loadEnterpriseRunDetail(state, executionId);
      }
      return res;
    }
    // Every refusal is a state of the run, not a fault, so it reads as a reason
    // rather than a failure.
    if (state.enterpriseSelectedExecutionId === executionId) {
      state.enterpriseError = enterpriseResumeRefusalMessage(res.reason ?? "not-found");
    }
    return res;
  } catch (err) {
    if (state.enterpriseSelectedExecutionId === executionId) {
      applyError(state, err);
    }
    return null;
  } finally {
    state.enterpriseResuming = false;
  }
}

export async function loadEnterpriseRunDetail(state: EnterpriseState, executionId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++detailRequestSeq;
  state.enterpriseSelectedExecutionId = executionId;
  state.enterpriseDetail = null;
  state.enterpriseRunTree = null;
  state.enterpriseDetailLoading = true;
  state.enterpriseError = null;
  try {
    const res = await state.client.request<EnterpriseRunsGetResult>("enterprise.runs.get", {
      executionId,
    });
    // Drop the response if a newer detail request has since started.
    if (requestSeq !== detailRequestSeq) {
      return;
    }
    state.enterpriseDetail = res.run;
    // The tree picture is secondary to the run detail, so it loads alongside
    // rather than inside it: the steps and governance trace must render even if
    // the tree fetch is slow or fails.
    if (res.run?.treeId) {
      void loadEnterpriseRunTree(
        state,
        { treeId: res.run.treeId, treeHash: res.run.treeHash },
        requestSeq,
      );
    }
  } catch (err) {
    if (requestSeq !== detailRequestSeq) {
      return;
    }
    applyError(state, err);
  } finally {
    // Only the latest request owns the loading flag; an older one clearing it
    // would hide the newer request's in-flight state.
    if (requestSeq === detailRequestSeq) {
      state.enterpriseDetailLoading = false;
    }
  }
}

/**
 * Load the tree the selected run bound to. Guarded by the run-detail token: if a
 * newer run is opened while this is in flight, its response is dropped rather
 * than painting the previous run's tree under the new run.
 */
async function loadEnterpriseRunTree(
  state: EnterpriseState,
  run: { treeId: string; treeHash?: string },
  runSeq: number,
) {
  if (!state.client || !state.connected) {
    return;
  }
  // Without the run's hash (a trace written before hashes existed) we cannot
  // prove the live tree is the one it governed, so the picture is withheld.
  if (!run.treeHash) {
    state.enterpriseRunTree = null;
    return;
  }
  try {
    const res = await state.client.request<EnterpriseTreesGetResult>("enterprise.trees.get", {
      treeId: run.treeId,
    });
    if (runSeq !== detailRequestSeq) {
      return;
    }
    const live = res?.tree ?? null;
    // Identity by CONTENT, not by version or timestamps. `version` is
    // author-controlled and re-importable unchanged, and removing an imported
    // override silently reveals a different built-in — both would pass a version
    // check while the nodes on screen are branches the run never governed. The
    // plan's own step list always renders; only the tree picture is withheld.
    const trustworthy = !res.importError && !res.storeError;
    state.enterpriseRunTree = trustworthy && live && live.hash === run.treeHash ? live : null;
  } catch {
    if (runSeq === detailRequestSeq) {
      state.enterpriseRunTree = null;
    }
  }
}

// Separate token: tree-detail loads race independently from run-detail loads.
let treeRequestSeq = 0;

/** Fetch one workflow tree's full definition + ontology for the visualizer. */
export async function loadEnterpriseTreeDetail(state: EnterpriseState, treeId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  // Sidebar refreshes must not replace the visual draft with the saved tree.
  // Its original hash remains the save guard until Save or Cancel ends editing.
  if (state.enterpriseVisualEditOriginal?.id === treeId) {
    return;
  }
  // A save that imports a NEW tree opens it through this same path, so a node id
  // shared with the prior tree (e.g. "root") must not carry that selection across.
  const previousTreeId = state.enterpriseSelectedTreeId;
  const treeChanged = previousTreeId !== treeId;
  const requestSeq = ++treeRequestSeq;
  state.enterpriseSelectedTreeId = treeId;
  state.enterpriseTreeDetail = null;
  state.enterpriseTreeLoading = true;
  state.enterpriseTreeIssue = null;
  state.enterpriseTreeWarnings = null;
  // Clear any prior banner (e.g. a transient runs.get failure); a successful
  // tree load must not render beneath a stale global error.
  state.enterpriseError = null;
  // Drop the prior node selection eagerly on a tree switch — before the async
  // load can fail or be superseded. Clearing only on success would leave the old
  // selection dangling under the just-assigned tree id, where a later retry
  // (now previousTreeId === treeId) would mistake a shared node id for a
  // same-tree refresh and auto-load the wrong tree's rows.
  if (treeChanged) {
    clearEnterpriseNodeSelection(state);
  }
  try {
    const res = await state.client.request<EnterpriseTreesGetResult>("enterprise.trees.get", {
      treeId,
    });
    if (requestSeq !== treeRequestSeq) {
      return;
    }
    state.enterpriseTreeDetail = res.tree;
    // A stale built-in may be returned; surface the failed override/store read.
    state.enterpriseTreeIssue = res.storeError ?? res.importError ?? null;
    // Reconcile only a same-tree refresh that returned an authoritative tree.
    // A fallback (storeError/importError) or a missing tree means the ontology on
    // screen may not match the selection, so drop it rather than load rows.
    const authoritative = !res.storeError && !res.importError;
    state.enterpriseTreeWarnings = authoritative ? (res.warnings ?? null) : null;
    if (!treeChanged && authoritative && res.tree) {
      // Same-tree reload (Refresh / re-save): keep the node selection but re-point
      // its instance rows at the freshly loaded ontology so they cannot go stale.
      reconcileNodeSelectionAfterReload(state, res.tree);
    } else {
      dropEnterpriseNodeSelection(state);
    }
  } catch (err) {
    if (requestSeq !== treeRequestSeq) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      // Losing operator.read must clear ALL governed data (runs, trees, open
      // detail, selection), not just the tree — mirror loadEnterprise.
      applyError(state, err);
    } else {
      state.enterpriseTreeIssue = String(err);
    }
  } finally {
    if (requestSeq === treeRequestSeq) {
      state.enterpriseTreeLoading = false;
    }
  }
}

// Separate token so version-history loads race independently from detail loads.
let versionsRequestSeq = 0;

// Monotonic token guarding async editor seeding (export / history.get). A newer
// Edit / New / version-load / format-switch / reset supersedes an in-flight seed
// so a late response never writes stale content into the editor.
let editSeedSeq = 0;

/**
 * Which whole-tree WRITE currently owns `enterpriseTreeSaving`.
 *
 * Deliberately not `editSeedSeq`: that advances for intents which are not writes
 * (selecting another tree, opening Edit/New, restoring history, losing scope), so
 * using it as the lock owner would leave the flag set with nobody left to clear
 * it. Only an actual write takes a number here, so a superseded writer stays
 * silent while the current one still releases.
 */
let treeWriteSeq = 0;
let treeExportSeq = 0;
// Navigation may cancel a still-preparing visual edit. Once an existing tree's
// write is on the wire, only THAT tree is held until the request settles and a
// fresh reload starts; another tree remains navigable.
const treeWritesInFlight = new WeakMap<EnterpriseState, { treeId: string }>();

function holdTreeWriteNavigation(state: EnterpriseState, treeId: string | null): () => void {
  if (!treeId) {
    return () => {};
  }
  const write = { treeId };
  treeWritesInFlight.set(state, write);
  return () => {
    if (treeWritesInFlight.get(state) === write) {
      treeWritesInFlight.delete(state);
    }
  };
}

function clearTreeEditingState(state: EnterpriseState) {
  if (state.enterpriseVisualEditOriginal?.id === state.enterpriseTreeDetail?.id) {
    state.enterpriseTreeDetail = state.enterpriseVisualEditOriginal ?? state.enterpriseTreeDetail;
  }
  state.enterpriseVisualEditOriginal = null;
  state.enterpriseTreeEditing = false;
  state.enterpriseTreeDraft = null;
  state.enterpriseTreeEditTreeId = null;
  state.enterpriseTreeEditRevision = null;
  state.enterpriseTreeEditGuard = null;
  state.enterpriseTreeEditContent = "";
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeConfirm = null;
  // A bundle may inline private knowledge. Never leave its source bytes in UI
  // state after cancel, navigation, disconnect, permission loss, or apply.
  state.enterpriseBundleDraft = null;
  state.enterpriseBundleStatus = null;
  clearEnterpriseNodeDrafts(state);
}

/** Discard any in-progress edit + confirmation without touching the selection. */
function resetTreeEditing(state: EnterpriseState) {
  // Invalidate any in-flight seed so it cannot re-enter edit mode after this.
  editSeedSeq++;
  clearTreeEditingState(state);
}

/** Select a tree for the visualizer/editor: cancel edits, load detail + history. */
export function selectEnterpriseTree(state: EnterpriseState, treeId: string) {
  const sameTree = state.enterpriseSelectedTreeId === treeId;
  if (treeWritesInFlight.get(state)?.treeId === treeId) {
    return;
  }
  if (sameTree && state.enterpriseTreeDetail?.id === treeId) {
    // An explicit row click is also a cancel intent. Always advance the seed
    // token, even before a slow file/export/history read has opened a draft.
    resetTreeEditing(state);
    clearEnterpriseNodeSelection(state);
    return;
  }
  // Switching trees abandons an unsaved edit of the previous one.
  resetTreeEditing(state);
  // A node selection belongs to the tree it was made in; a different tree's node
  // panel would be nonsense against the new tree's ontology.
  clearEnterpriseNodeSelection(state);
  void loadEnterpriseTreeDetail(state, treeId);
  void loadEnterpriseTreeVersions(state, treeId);
}

// Separate token so a node's object load races independently from tree/detail
// loads: a fast node click while a detail refresh is in flight must not drop.
let nodeObjectsRequestSeq = 0;

// Drop the loaded instance rows and invalidate any in-flight objects request,
// without touching which node is selected. Bumping the token here is what makes
// a late reply from a superseded entity/tree load fall through its own guard.
function clearEnterpriseNodeObjects(state: EnterpriseState) {
  nodeObjectsRequestSeq++;
  state.enterpriseNodeObjectsEntity = null;
  state.enterpriseNodeObjects = [];
  state.enterpriseNodeObjectsLoading = false;
  state.enterpriseNodeObjectsError = null;
}

function clearEnterpriseNodeDrafts(state: EnterpriseState) {
  // A node-add draft belongs to the selected node in its tree; a tree switch,
  // pruned node, or scope loss (every caller of this) invalidates it, so drop it
  // rather than let a stale form reappear under a same-named node elsewhere.
  state.enterpriseNodeDraft = null;
  // Same for a tool-grant / skill draft: it is bound to one node in one tree.
  state.enterpriseBindingPicker = null;
  // The detail card names a specific entry on a specific step; the step is gone.
  state.enterpriseBindingDetail = null;
  // ...and for step behavior. Unsaved text must not survive a tree switch, a
  // pruned node, or scope loss and then reappear under a same-named node
  // elsewhere — or be silently overwritten by editing a different node.
  state.enterpriseGuidanceDraft = null;
  state.enterpriseOntologyDraft = null;
}

function hasPendingEnterpriseNodeEdit(state: EnterpriseState): boolean {
  return Boolean(
    state.enterpriseNodeDraft ||
    state.enterpriseBindingPicker ||
    state.enterpriseGuidanceDraft ||
    state.enterpriseOntologyDraft,
  );
}

/** Reconcile write-only forms with a new gateway/authentication boundary. */
export function reconcileEnterpriseEditAccess(state: EnterpriseState, canEdit: boolean) {
  // MCP forms can hold plaintext credentials and are tied to the config revision
  // and gateway identity that opened them. Every hello/access reconciliation
  // invalidates that boundary, even when the new connection is also an admin.
  state.enterpriseMcpDraft = null;
  state.enterpriseMcpRemoveConfirm = null;
  state.enterpriseBundleDraft = null;
  state.enterpriseBundleStatus = null;
  if (canEdit) {
    return;
  }
  // Once import is on the wire it cannot be recalled. Hide write-only forms but
  // keep the intent alive so its late result still refreshes or reports failure.
  if (treeWritesInFlight.has(state)) {
    clearTreeEditingState(state);
  } else {
    // Also invalidate an export/file read that has not opened a form yet. Its
    // late result must not recreate a write-only editor after access was lost.
    resetTreeEditing(state);
  }
}

function clearEnterpriseNodeSelection(state: EnterpriseState) {
  // Selection owns every visual draft. Invalidate an export already in flight
  // before dropping the draft, or its late result can still replace the tree.
  editSeedSeq++;
  dropEnterpriseNodeSelection(state);
}

function dropEnterpriseNodeSelection(state: EnterpriseState) {
  // Async detail reconciliation is housekeeping, not a newer editor intent. It
  // may discard a node that vanished without cancelling a seed started meanwhile.
  clearEnterpriseNodeObjects(state);
  state.enterpriseSelectedNodeId = null;
  clearEnterpriseNodeDrafts(state);
}

/**
 * Refresh and post-save re-import reload the *same* tree in place, so a node's
 * cached instances belong to the pre-reload ontology. Reconcile against the
 * freshly loaded tree: drop the selection if the node vanished, otherwise reload
 * rows for the still-valid entity — keeping the operator's chosen type when it
 * survives the re-import, else the node's default. Without this the inspector
 * shows stale rows until the operator manually re-toggles the node.
 */
function reconcileNodeSelectionAfterReload(state: EnterpriseState, tree: EnterpriseTreeDetail) {
  // The binding detail card describes ONE entry of the pre-reload tree, and the
  // reload may have detached it or moved it between local and inherited scope.
  // Closed rather than re-validated here: it is a read-out with nothing to lose,
  // and re-deriving "is this entry still declared, at this origin" would put a
  // second copy of the view's inheritance rules in the controller to drift from.
  // Merely hiding it in the view is not enough — the state would survive and the
  // dialog would spring back open on a later reload that restores the entry.
  state.enterpriseBindingDetail = null;
  const nodeId = state.enterpriseSelectedNodeId;
  if (!nodeId) {
    return;
  }
  if (!tree.nodes.some((node) => node.id === nodeId)) {
    dropEnterpriseNodeSelection(state);
    return;
  }
  const entities = nodeObjectEntityIds(tree, nodeId);
  const current = state.enterpriseNodeObjectsEntity;
  const entity = current && entities.includes(current) ? current : entities[0];
  if (entity) {
    void loadEnterpriseNodeObjects(state, nodeId, entity);
  } else {
    // Node survives but no longer scopes any object type: keep its ontology
    // graph up, just clear the now-meaningless rows.
    clearEnterpriseNodeObjects(state);
  }
}

/**
 * Expand (or collapse) a workflow node in the inspector. Selecting a node
 * auto-loads the first object type in its scope so the panel shows live data at
 * once; the entity list and this default derive from the same helper the view
 * renders chips from, so the highlighted chip always matches the loaded rows.
 * Returns whether the graph may commit its optimistic local selection.
 */
export function selectEnterpriseNode(state: EnterpriseState, nodeId: string | null): boolean {
  // The graph may outlive a dismissed write modal. Keep selection fixed while a
  // whole-tree request is unsettled so navigation cannot hide its failure banner.
  if (treeWritesInFlight.get(state)?.treeId === state.enterpriseSelectedTreeId) {
    return false;
  }
  if (nodeId === state.enterpriseSelectedNodeId) {
    return true;
  }
  if (!nodeId) {
    clearEnterpriseNodeSelection(state);
    return true;
  }
  clearEnterpriseNodeSelection(state);
  state.enterpriseSelectedNodeId = nodeId;
  const tree = state.enterpriseTreeDetail;
  const defaultEntity = tree ? nodeObjectEntityIds(tree, nodeId)[0] : undefined;
  if (defaultEntity) {
    void loadEnterpriseNodeObjects(state, nodeId, defaultEntity);
  }
  return true;
}

/** Switch which entity type's instances the node inspector shows. */
export function selectEnterpriseNodeEntity(state: EnterpriseState, entity: string) {
  const nodeId = state.enterpriseSelectedNodeId;
  if (!nodeId) {
    return;
  }
  void loadEnterpriseNodeObjects(state, nodeId, entity);
}

/** Load one entity type's object instances for the selected node's tree. */
async function loadEnterpriseNodeObjects(state: EnterpriseState, nodeId: string, entity: string) {
  const treeId = state.enterpriseSelectedTreeId;
  if (!state.client || !state.connected || !treeId) {
    return;
  }
  const requestSeq = ++nodeObjectsRequestSeq;
  state.enterpriseNodeObjectsEntity = entity;
  state.enterpriseNodeObjects = [];
  state.enterpriseNodeObjectsLoading = true;
  state.enterpriseNodeObjectsError = null;
  try {
    const res = await state.client.request<EnterpriseObjectsListResult>("enterprise.objects.list", {
      treeId,
      entity,
    });
    // A node re-selection or entity switch bumps the token; drop the stale reply.
    if (requestSeq !== nodeObjectsRequestSeq || state.enterpriseSelectedNodeId !== nodeId) {
      return;
    }
    state.enterpriseNodeObjects = res.objects;
  } catch (err) {
    if (requestSeq !== nodeObjectsRequestSeq) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      applyError(state, err);
    } else {
      state.enterpriseNodeObjectsError = String(err);
    }
  } finally {
    if (requestSeq === nodeObjectsRequestSeq) {
      state.enterpriseNodeObjectsLoading = false;
    }
  }
}

/** Load the saved-revision list for the history panel (bounded server-side). */
export async function loadEnterpriseTreeVersions(state: EnterpriseState, treeId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++versionsRequestSeq;
  // Drop the previous tree's revisions immediately: otherwise switching trees
  // shows the prior list until this resolves, and a click would history.get the
  // new tree with an old revision number.
  state.enterpriseTreeVersions = [];
  state.enterpriseTreeVersionsLoading = true;
  state.enterpriseTreeVersionsError = null;
  try {
    const res = await state.client.request<EnterpriseTreesHistoryListResult>(
      "enterprise.trees.history.list",
      { treeId },
    );
    if (requestSeq !== versionsRequestSeq) {
      return;
    }
    state.enterpriseTreeVersions = res.versions;
  } catch (err) {
    if (requestSeq !== versionsRequestSeq) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      // This may be the first read to observe a downgraded token — clear all
      // governed data like the other read paths, not just the history panel.
      applyError(state, err);
      return;
    }
    state.enterpriseTreeVersionsError = String(err);
  } finally {
    if (requestSeq === versionsRequestSeq) {
      state.enterpriseTreeVersionsLoading = false;
    }
  }
}

// scopeCleared marks a missing-operator.read failure already routed through
// applyError (governed data cleared, banner set) so callers skip a saveError.
type SeedResult =
  | { ok: true; content: string }
  | { ok: false; reason: string; scopeCleared?: boolean };

/** Turn a caught error into a SeedResult, clearing governed data on scope loss. */
function seedFailure(state: EnterpriseState, err: unknown): SeedResult {
  if (isMissingOperatorReadScopeError(err)) {
    applyError(state, err);
    return { ok: false, reason: "", scopeCleared: true };
  }
  return { ok: false, reason: String(err) };
}

/** Fetch a tree's current definition serialized in `format` (no state writes). */
async function fetchExportContent(
  state: EnterpriseState,
  treeId: string,
  format: EnterpriseTreeEditFormat,
): Promise<SeedResult> {
  if (!state.client || !state.connected) {
    return { ok: false, reason: "not connected" };
  }
  try {
    const res = await state.client.request<EnterpriseTreesExportResult>("enterprise.trees.export", {
      treeId,
      format,
    });
    return res.content === null
      ? { ok: false, reason: res.reason ?? "export unavailable" }
      : { ok: true, content: res.content };
  } catch (err) {
    return seedFailure(state, err);
  }
}

/** Fetch a historical revision serialized in `format` (no state writes). */
async function fetchHistoryContent(
  state: EnterpriseState,
  treeId: string,
  revision: number,
  format: EnterpriseTreeEditFormat,
): Promise<SeedResult> {
  if (!state.client || !state.connected) {
    return { ok: false, reason: "not connected" };
  }
  try {
    const res = await state.client.request<EnterpriseTreesHistoryGetResult>(
      "enterprise.trees.history.get",
      { treeId, revision, format },
    );
    return res.content === null
      ? { ok: false, reason: "that revision is no longer available" }
      : { ok: true, content: res.content };
  } catch (err) {
    return seedFailure(state, err);
  }
}

/**
 * Apply an async seed to the editor only if it is still the latest intent. The
 * content and its `format` are set together so Save never sends one format with
 * the other's text; on failure neither changes, keeping them in sync.
 */
function applyEditorSeed(
  state: EnterpriseState,
  seedSeq: number,
  format: EnterpriseTreeEditFormat,
  treeId: string | null,
  revision: number | null,
  guard: EnterpriseTreeImportGuard,
  result: SeedResult,
) {
  if (seedSeq !== editSeedSeq || !state.client || !state.connected) {
    return;
  }
  if (!result.ok) {
    // A scope loss already cleared governed data + set the global banner.
    if (!result.scopeCleared) {
      state.enterpriseTreeSaveError = result.reason;
    }
    return;
  }
  if (state.enterpriseVisualEditOriginal) {
    state.enterpriseTreeDetail = state.enterpriseVisualEditOriginal;
    state.enterpriseVisualEditOriginal = null;
  }
  state.enterpriseTreeEditFormat = format;
  state.enterpriseTreeEditTreeId = treeId;
  state.enterpriseTreeEditRevision = revision;
  state.enterpriseTreeEditGuard = guard;
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeEditContent = result.content;
  state.enterpriseTreeEditing = true;
}

/** Enter edit mode for the selected tree, seeding the editor from its export. */
export async function beginEditEnterpriseTree(state: EnterpriseState, visual = false) {
  const treeId = state.enterpriseSelectedTreeId;
  const tree = state.enterpriseTreeDetail;
  if (!treeId || tree?.id !== treeId || !tree.hash) {
    return;
  }
  const format = visual ? "json" : state.enterpriseTreeEditFormat;
  resetTreeEditing(state);
  const seedSeq = ++editSeedSeq;
  const result = await fetchExportContent(state, treeId, format);
  applyEditorSeed(state, seedSeq, format, treeId, null, { expectedHash: tree.hash }, result);
  if (visual && result.ok && seedSeq === editSeedSeq && state.enterpriseTreeEditing) {
    state.enterpriseVisualEditOriginal = tree;
  }
}

/** Open the guided form for a brand-new work-map. */
export function beginNewEnterpriseTree(state: EnterpriseState) {
  resetTreeEditing(state);
  clearEnterpriseNodeSelection(state);
  state.enterpriseTreeDraft = {
    mode: "create",
    executionModel: "",
    expectedHash: null,
    id: "",
    version: "1.0.0",
    name: "",
    description: "",
    triggers: ["user"],
    priority: "",
    rootId: "",
    rootTitle: "",
    error: null,
  };
}

/** Open the guided settings form for the selected work-map. */
export function beginEditEnterpriseTreeSettings(state: EnterpriseState) {
  const tree = state.enterpriseTreeDetail;
  if (!tree?.hash) {
    return;
  }
  resetTreeEditing(state);
  const triggers = (tree.match?.triggers ?? ["user"]).filter(
    (trigger): trigger is EnterpriseTreeTrigger =>
      trigger === "user" || trigger === "system" || trigger === "subagent",
  );
  state.enterpriseTreeDraft = {
    mode: "settings",
    expectedHash: tree.hash,
    id: tree.id,
    version: tree.version,
    name: tree.name,
    description: tree.description ?? "",
    executionModel: tree.executionModel ?? "",
    triggers: triggers.length > 0 ? triggers : ["user"],
    priority: tree.match?.priority === undefined ? "" : String(tree.match.priority),
    rootId: "",
    rootTitle: "",
    error: null,
  };
}

export function editEnterpriseTreeDraft(
  state: EnterpriseState,
  patch: Partial<Omit<EnterpriseTreeDraft, "error">>,
) {
  if (!state.enterpriseTreeDraft || state.enterpriseTreeSaving) {
    return;
  }
  state.enterpriseTreeDraft = { ...state.enterpriseTreeDraft, ...patch, error: null };
}

export function cancelEnterpriseTreeDraft(state: EnterpriseState) {
  // Cancel the export/edit stage. An import already on the wire cannot be recalled;
  // closing then only dismisses the form while its result still reconciles.
  if (!treeWritesInFlight.has(state)) {
    editSeedSeq++;
  }
  state.enterpriseTreeDraft = null;
}

/** Validate the guided fields, then reuse the existing reviewed import flow. */
export async function submitEnterpriseTreeDraft(state: EnterpriseState) {
  const draft = state.enterpriseTreeDraft;
  if (!draft || state.enterpriseTreeSaving) {
    return;
  }
  const id = draft.id.trim();
  const version = draft.version.trim();
  const name = draft.name.trim();
  const description = draft.description.trim();
  const executionModel = (draft.executionModel ?? "").trim();
  const priorityText = draft.priority.trim();
  const priority = priorityText ? Number(priorityText) : undefined;
  const rootId = draft.rootId.trim();
  const rootTitle = draft.rootTitle.trim();
  const fail = (error: EnterpriseTreeDraftError) => {
    state.enterpriseTreeDraft = { ...draft, error };
  };
  if (draft.mode === "create") {
    const idIssue = newNodeIdIssue(id, new Set(state.enterpriseTrees.map((tree) => tree.id)));
    if (idIssue) {
      fail(
        idIssue === "empty" ? "id-empty" : idIssue === "pattern" ? "id-pattern" : "id-duplicate",
      );
      return;
    }
  }
  if (!version) {
    fail("version-empty");
    return;
  }
  if (!name) {
    fail("name-empty");
    return;
  }
  if (
    executionModel &&
    (executionModel.length > 512 || !/^[^\s/@]+\/[^\s@]+$/.test(executionModel))
  ) {
    fail("execution-model-invalid");
    return;
  }
  if (draft.triggers.length === 0) {
    fail("triggers-empty");
    return;
  }
  if (priority !== undefined && !Number.isSafeInteger(priority)) {
    fail("priority-invalid");
    return;
  }
  if (draft.mode === "settings") {
    await applyEnterpriseTreeEdit(
      state,
      (definition) =>
        setTreeSettings(definition, {
          version,
          name,
          description,
          executionModel,
          triggers: draft.triggers,
          priority,
        }),
      {
        expectedHash: draft.expectedHash,
        owner: "tree",
        onSaved: () => {
          if (state.enterpriseTreeDraft === draft) {
            state.enterpriseTreeDraft = null;
          }
        },
      },
    );
    return;
  }
  const rootIdIssue = newNodeIdIssue(rootId, new Set());
  if (rootIdIssue) {
    fail(rootIdIssue === "empty" ? "root-id-empty" : "root-id-pattern");
    return;
  }
  if (!rootTitle) {
    fail("root-title-empty");
    return;
  }
  const definition = {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id,
    version,
    name,
    ...(description ? { description } : {}),
    ...(executionModel ? { executionModel } : {}),
    match: {
      triggers: draft.triggers,
      ...(priority !== undefined ? { priority } : {}),
    },
    root: { id: rootId, title: rootTitle },
  };
  editSeedSeq++;
  state.enterpriseTreeDraft = null;
  state.enterpriseTreeEditTreeId = null;
  state.enterpriseTreeEditRevision = null;
  state.enterpriseTreeEditGuard = { createOnly: true };
  state.enterpriseTreeEditFormat = "json";
  state.enterpriseTreeEditContent = `${JSON.stringify(definition, null, 2)}\n`;
  state.enterpriseTreeEditing = true;
}

function formatBundleIssues(issues: readonly EnterpriseTreeImportIssue[]): string {
  return issues.map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("; ");
}

/** Read a bundle and ask the gateway for a complete, non-mutating review. */
export async function previewEnterpriseBundleFile(
  state: EnterpriseState,
  file: Pick<File, "name" | "text">,
) {
  if (!state.client || !state.connected || state.enterpriseTreeSaving) {
    return;
  }
  resetTreeEditing(state);
  clearEnterpriseNodeSelection(state);
  const previewIntent = editSeedSeq;
  const client = state.client;
  state.enterpriseBundleStatus = null;
  try {
    const content = await file.text();
    const format: EnterpriseTreeEditFormat = file.name.toLowerCase().endsWith(".json")
      ? "json"
      : "yaml";
    if (
      previewIntent !== editSeedSeq ||
      state.client !== client ||
      !state.connected ||
      state.enterpriseTreeSaving
    ) {
      return;
    }
    const preview = await client.request<EnterpriseBundlesPreviewResult>(
      "enterprise.bundles.preview",
      { content, format },
    );
    if (previewIntent !== editSeedSeq || state.client !== client || !state.connected) {
      return;
    }
    if (!preview.ok) {
      state.enterpriseBundleStatus = {
        kind: "error",
        message: t("enterprise.bundle.previewRejected", {
          issues: formatBundleIssues(preview.issues),
        }),
      };
      return;
    }
    state.enterpriseBundleDraft = { fileName: file.name, content, format, preview };
  } catch (error) {
    if (previewIntent === editSeedSeq && state.client === client && state.connected) {
      state.enterpriseBundleStatus = { kind: "error", message: String(error) };
    }
  }
}

/** Close the review and discard its potentially sensitive inlined content. */
export function cancelEnterpriseBundlePreview(state: EnterpriseState) {
  if (state.enterpriseTreeSaving) {
    return;
  }
  editSeedSeq++;
  state.enterpriseBundleDraft = null;
}

/** Apply only the exact bytes and tree state that the open preview reviewed. */
export async function applyEnterpriseBundle(state: EnterpriseState) {
  const draft = state.enterpriseBundleDraft;
  const tree = draft?.preview.trees[0];
  if (!draft || !tree || !state.client || !state.connected || state.enterpriseTreeSaving) {
    return;
  }
  const client = state.client;
  const selectedAtWrite = state.enterpriseSelectedTreeId;
  const applyIntent = ++editSeedSeq;
  const writeToken = ++treeWriteSeq;
  const ownsScreen = () =>
    writeToken === treeWriteSeq &&
    applyIntent === editSeedSeq &&
    selectedAtWrite === state.enterpriseSelectedTreeId;
  const releaseLock = () => {
    if (writeToken === treeWriteSeq) {
      state.enterpriseTreeSaving = false;
    }
  };
  state.enterpriseTreeSaving = true;
  state.enterpriseBundleDraft = null;
  state.enterpriseBundleStatus = null;
  const releaseNavigation = holdTreeWriteNavigation(state, tree.id);
  try {
    const guard = tree.currentHash
      ? { expectedHash: tree.currentHash }
      : { createOnly: true as const };
    const result = await client.request<EnterpriseBundlesImportResult>(
      "enterprise.bundles.import",
      {
        content: draft.content,
        format: draft.format,
        reviewToken: draft.preview.reviewToken,
        ...guard,
      },
    );
    if (!result.ok) {
      if (ownsScreen()) {
        state.enterpriseBundleStatus = {
          kind: "error",
          message: t("enterprise.bundle.applyRejected", {
            issues: formatBundleIssues(result.issues),
          }),
        };
      }
      return;
    }
    if (ownsScreen()) {
      state.enterpriseBundleStatus = {
        kind: "success",
        message: t("enterprise.bundle.applied", { treeId: tree.id }),
      };
    }
    const refresh = refreshAfterTreeWrite(state, tree.id, selectedAtWrite, applyIntent);
    releaseLock();
    releaseNavigation();
    await refresh;
  } catch (error) {
    if (ownsScreen()) {
      state.enterpriseBundleStatus = {
        kind: "error",
        message: t("enterprise.bundle.applyUnknown", { message: String(error) }),
      };
    }
  } finally {
    releaseLock();
    releaseNavigation();
  }
}

/** Export one reviewed work-map bundle and surface any portability gaps. */
export async function exportEnterpriseBundle(
  state: EnterpriseState,
  treeId: string,
  format: EnterpriseTreeEditFormat,
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const exportSeq = ++treeExportSeq;
  const editIntent = editSeedSeq;
  const ownsScreen = () =>
    exportSeq === treeExportSeq &&
    editIntent === editSeedSeq &&
    state.client === client &&
    state.connected &&
    state.enterpriseSelectedTreeId === treeId;
  try {
    const result = await client.request<EnterpriseBundlesExportResult>(
      "enterprise.bundles.export",
      { treeId, format },
    );
    if (!ownsScreen()) {
      return;
    }
    if (!result.ok) {
      state.enterpriseBundleStatus = { kind: "error", message: result.reason };
      return;
    }
    triggerDownload(`${treeId}.bundle.${format}`, result.content);
    const gaps = [
      ...result.skippedFoundations.map((item) => `${item.id} (${item.reason})`),
      ...(result.impliedAllowAllKnowledge ? [t("enterprise.bundle.exportImplicitKnowledge")] : []),
    ];
    state.enterpriseBundleStatus = gaps.length
      ? {
          kind: "warning",
          message: t("enterprise.bundle.exportWarning", { warnings: gaps.join(", ") }),
        }
      : {
          kind: "success",
          message: t("enterprise.bundle.exported", { treeId }),
        };
  } catch (error) {
    if (ownsScreen()) {
      state.enterpriseBundleStatus = { kind: "error", message: String(error) };
    }
  }
}

/** Load a local YAML/JSON definition into the existing reviewed import flow. */
export async function importEnterpriseTreeFile(
  state: EnterpriseState,
  file: Pick<File, "name" | "text">,
) {
  resetTreeEditing(state);
  clearEnterpriseNodeSelection(state);
  const readIntent = editSeedSeq;
  state.enterpriseError = null;
  try {
    const content = await file.text();
    if (readIntent === editSeedSeq && state.client && state.connected) {
      state.enterpriseTreeEditTreeId = null;
      state.enterpriseTreeEditRevision = null;
      state.enterpriseTreeEditGuard = { createOnly: true };
      state.enterpriseTreeEditFormat = file.name.toLowerCase().endsWith(".json") ? "json" : "yaml";
      state.enterpriseTreeEditContent = content;
      state.enterpriseTreeEditing = true;
    }
  } catch (error) {
    if (readIntent === editSeedSeq) {
      state.enterpriseError = String(error);
    }
  }
}

export function setEnterpriseTreeEditContent(state: EnterpriseState, content: string) {
  // Typing is a newer edit intent than any in-flight async seed; advancing the
  // token drops a late format/history reseed that would clobber this text.
  editSeedSeq++;
  state.enterpriseTreeEditContent = content;
}

const NODE_ID_DRAFT_ERROR: Record<
  ReturnType<typeof newNodeIdIssue> & string,
  EnterpriseNodeDraftError
> = {
  empty: "id-empty",
  pattern: "id-pattern",
  duplicate: "id-duplicate",
};

/** Open the "add child node" form under `parentId` (the selected node). */
export function beginAddEnterpriseNode(state: EnterpriseState, parentId: string) {
  const treeId = state.enterpriseTreeDetail?.id;
  if (
    !state.enterpriseVisualEditOriginal ||
    !treeId ||
    state.enterpriseTreeSaving ||
    hasPendingEnterpriseNodeEdit(state)
  ) {
    return;
  }
  editSeedSeq++;
  state.enterpriseNodeDraft = {
    treeId,
    parentId,
    id: "",
    title: "",
    description: "",
    error: null,
  };
}

/** Update the open draft's fields; any prior error clears as the operator edits. */
export function editEnterpriseNodeDraft(
  state: EnterpriseState,
  patch: { id?: string; title?: string; description?: string },
) {
  const draft = state.enterpriseNodeDraft;
  if (!draft || state.enterpriseTreeSaving) {
    return;
  }
  editSeedSeq++;
  state.enterpriseNodeDraft = {
    ...draft,
    ...(patch.id !== undefined ? { id: patch.id } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    error: null,
  };
}

export function cancelAddEnterpriseNode(state: EnterpriseState) {
  if (state.enterpriseTreeSaving) {
    return;
  }
  editSeedSeq++;
  state.enterpriseNodeDraft = null;
}

function failNodeDraft(
  state: EnterpriseState,
  draft: EnterpriseNodeDraft,
  error: EnterpriseNodeDraftError,
) {
  state.enterpriseNodeDraft = { ...draft, error };
}

/**
 * Validate the draft, then splice the child into the canonical nested definition
 * and save through the shared export -> import path used by visual edits.
 */
export async function submitAddEnterpriseNode(state: EnterpriseState) {
  const draft = state.enterpriseNodeDraft;
  const tree = state.enterpriseTreeDetail;
  // The draft must belong to the tree on screen (both clear on a tree switch, so a
  // mismatch means a race — abort rather than splice into the wrong tree).
  if (!draft || !tree || draft.treeId !== tree.id) {
    return;
  }
  const id = draft.id.trim();
  const title = draft.title.trim();
  const description = draft.description.trim();
  // Validate client-side against the import contract so the common mistakes show
  // in the form, not as a raw-editor issue after a whole-tree-replace attempt.
  const existingIds = new Set(tree.nodes.map((node) => node.id));
  const idIssue = newNodeIdIssue(id, existingIds);
  if (idIssue) {
    failNodeDraft(state, draft, NODE_ID_DRAFT_ERROR[idIssue]);
    return;
  }
  if (title.length === 0) {
    failNodeDraft(state, draft, "title-empty");
    return;
  }
  if (!existingIds.has(draft.parentId)) {
    failNodeDraft(state, draft, "parent-missing");
    return;
  }
  await applyEnterpriseTreeEdit(
    state,
    (definition) => {
      const spliced = insertChildNode(definition, draft.parentId, {
        id,
        title,
        ...(description ? { description } : {}),
      });
      if (spliced.ok) {
        return spliced;
      }
      return {
        ok: false,
        reason: spliced.reason === "duplicate-id" ? "duplicate-entry" : "node-not-found",
      };
    },
    {
      owner: "node",
      onRefused: (reason) =>
        failNodeDraft(
          state,
          draft,
          reason === "duplicate-entry" ? "id-duplicate" : "parent-missing",
        ),
      onSaved: () => {
        if (state.enterpriseNodeDraft === draft) {
          state.enterpriseNodeDraft = null;
        }
      },
    },
  );
}

/** Open the step-binding form for `field` on `nodeId` in the selected tree. */
export function openEnterpriseBindingPicker(
  state: EnterpriseState,
  nodeId: string,
  field: NodeOntologyListField,
) {
  const treeId = state.enterpriseTreeDetail?.id;
  if (
    !state.enterpriseVisualEditOriginal ||
    !treeId ||
    state.enterpriseTreeSaving ||
    hasPendingEnterpriseNodeEdit(state)
  ) {
    return;
  }
  editSeedSeq++;
  state.enterpriseBindingPicker = {
    treeId,
    nodeId,
    field,
    query: "",
    selected: [],
    custom: "",
    phase: "idle",
    failure: null,
  };
}

/**
 * Open the read-out for one binding chip.
 *
 * Separate from the picker: the picker collects a selection to WRITE, this only
 * describes an entry that already exists. Nothing is fetched — the tool, skill,
 * MCP and foundation catalogs behind the answer are already on the screen.
 */
export function openEnterpriseBindingDetail(
  state: EnterpriseState,
  detail: Omit<EnterpriseBindingDetail, "treeId">,
) {
  const treeId = state.enterpriseTreeDetail?.id;
  if (!treeId) {
    return;
  }
  state.enterpriseBindingDetail = { treeId, ...detail };
}

export function closeEnterpriseBindingDetail(state: EnterpriseState) {
  state.enterpriseBindingDetail = null;
}

export function setEnterpriseBindingPickerQuery(state: EnterpriseState, query: string) {
  const picker = state.enterpriseBindingPicker;
  if (!picker || picker.phase !== "idle") {
    return;
  }
  state.enterpriseBindingPicker = { ...picker, query };
}

export function setEnterpriseBindingPickerCustom(state: EnterpriseState, custom: string) {
  const picker = state.enterpriseBindingPicker;
  if (!picker || picker.phase !== "idle") {
    return;
  }
  state.enterpriseBindingPicker = { ...picker, custom, failure: null };
}

/** Tick or untick one catalog entry. Order is click order, so Add stays predictable. */
export function toggleEnterpriseBindingPickerValue(state: EnterpriseState, value: string) {
  const picker = state.enterpriseBindingPicker;
  if (!picker || picker.phase !== "idle") {
    return;
  }
  const selected = picker.selected.includes(value)
    ? picker.selected.filter((entry) => entry !== value)
    : [...picker.selected, value];
  state.enterpriseBindingPicker = { ...picker, selected, failure: null };
}

export function cancelEnterpriseBindingPicker(state: EnterpriseState) {
  // Closable even mid-import. The client has no per-request timeout, so a stalled
  // server would otherwise trap the operator behind a native modal with every
  // control disabled. A late result cannot resurrect the dialog: `settle` only
  // writes back if this exact picker is still the one on screen.
  state.enterpriseBindingPicker = null;
}

/**
 * Apply the picked entries atomically to the local draft. A failed splice must
 * not leave half the selections applied; Save owns the eventual import.
 */
export async function submitEnterpriseBindingPicker(state: EnterpriseState) {
  const picker = state.enterpriseBindingPicker;
  const tree = state.enterpriseTreeDetail;
  if (
    !picker ||
    picker.phase !== "idle" ||
    !tree ||
    picker.treeId !== tree.id ||
    // Another whole-tree write holds the edit intent. Proceeding would claim it
    // away and make THAT write return without importing or reporting — the
    // operator's detach or role-prompt save would vanish silently.
    state.enterpriseTreeSaving
  ) {
    return;
  }
  if (!tree.hash) {
    state.enterpriseBindingPicker = { ...picker, failure: { kind: "export-failed" } };
    return;
  }
  const custom = picker.custom.trim();
  // Deduped: ticking an option and typing the same value is an easy thing to do,
  // and the second splice would report it as already declared and abandon a write
  // that was actually adding something new.
  const values = [...new Set([...picker.selected, ...(custom ? [custom] : [])])];
  if (values.length === 0) {
    state.enterpriseBindingPicker = { ...picker, failure: { kind: "entry-empty" } };
    return;
  }
  // A declared skill or foundation must satisfy the import contract; catching it
  // here keeps the failure in the dialog instead of surfacing as a raw schema
  // issue after the write. Tool entries are globs, so only non-blank is required.
  const invalid = values.find((value) =>
    picker.field === "skills"
      ? !isValidSkillName(value)
      : picker.field === "knowledgeFoundations"
        ? !isValidEnterpriseId(value)
        : false,
  );
  if (invalid !== undefined) {
    state.enterpriseBindingPicker = {
      ...picker,
      failure: { kind: INVALID_ENTRY_FAILURE[picker.field] ?? "entry-empty" },
    };
    return;
  }
  if (!tree.nodes.some((node) => node.id === picker.nodeId)) {
    state.enterpriseBindingPicker = { ...picker, failure: { kind: "node-missing" } };
    return;
  }
  if (!state.enterpriseVisualEditOriginal || !state.enterpriseTreeEditing) {
    return;
  }
  const definition = parseTreeDefinition(state.enterpriseTreeEditContent);
  if (!definition) {
    state.enterpriseBindingPicker = { ...picker, failure: { kind: "export-failed" } };
    return;
  }
  let spliced: EditableTreeDefinition = definition;
  for (const value of values) {
    const result = addNodeOntologyEntry(spliced, picker.nodeId, picker.field, value);
    if (!result.ok) {
      state.enterpriseBindingPicker = {
        ...picker,
        failure: { kind: result.reason === "duplicate-entry" ? "entry-duplicate" : "node-missing" },
      };
      return;
    }
    spliced = result.definition;
  }
  stageEnterpriseTreeDefinition(state, spliced);
  state.enterpriseBindingPicker = null;
}

/**
 * An open ontology form, tagged by what it declares.
 *
 * Carries its tree and node for the same reason the role-prompt draft does: ids
 * repeat across trees, so a draft that named only the entity could be applied to
 * the wrong work-map entirely.
 */
export type EnterpriseOntologyToolsMode = "all" | "selected" | "none";

export type EnterpriseOntologyDraftBody = (
  | { kind: "entity"; nodeId: string; id: string; title: string; description: string }
  | {
      kind: "property";
      nodeId: string;
      entityId: string;
      entityIndex: number;
      id: string;
      type: OntologyValueTypeName;
      primaryKey: boolean;
      required: boolean;
      description: string;
    }
  | {
      kind: "relationship";
      nodeId: string;
      id: string;
      from: string;
      to: string;
      cardinality: OntologyCardinalityName;
      inverse: string;
      description: string;
    }
  // The two AIP verbs. An action is declared bare and then given its effects and
  // parameters, the way an object type is declared and then given properties:
  // each effect has to be checked against what the step can address, so they
  // cannot be collected in one form without guessing.
  | {
      kind: "action";
      nodeId: string;
      id: string;
      title: string;
      description: string;
      toolsMode: EnterpriseOntologyToolsMode;
      tools: string[];
      preconditions: string[];
    }
  | {
      kind: "action-effect";
      nodeId: string;
      actionId: string;
      actionIndex: number;
      entity: string;
      effectKind: OntologyEffectKindName;
      description: string;
    }
  // The two effects that name something other than an object type: a TOOL the
  // action performs outside this workflow, and a RELATIONSHIP it relates two
  // objects over. Separate drafts rather than more fields on `action-effect`,
  // because each collects a different thing and the form has to ask for it.
  | {
      kind: "action-call";
      nodeId: string;
      actionId: string;
      actionIndex: number;
      tool: string;
      description: string;
    }
  | {
      kind: "action-link";
      nodeId: string;
      actionId: string;
      actionIndex: number;
      relationship: string;
      linkKind: "link" | "unlink";
      from: string;
      to: string;
      description: string;
    }
  | {
      kind: "action-parameter";
      nodeId: string;
      actionId: string;
      actionIndex: number;
      id: string;
      type: OntologyValueTypeName;
      required: boolean;
      description: string;
    }
  | {
      kind: "function";
      nodeId: string;
      id: string;
      title: string;
      entity: string;
      expression: string;
      returns: OntologyValueTypeName;
      description: string;
    }
  | { kind: "constraint"; nodeId: string; id: string; description: string }
) & { metadataUpdate?: NodeOntologyMetadataUpdate };

/**
 * What an open ontology form can be refused for: every splicer reason, plus the
 * one the controller raises before any splicer runs (a required object type the
 * step has none of). Closed, because the form renders it as
 * `enterprise.ontologyEditor.error.<reason>` and a freeform string would put a
 * raw key on screen.
 */
export type EnterpriseOntologyDraftError =
  | OntologyEditReason
  | "endpoint-missing"
  | "description-empty"
  | "selection-empty";

/** Preserve the discriminated body union; `Omit` would collapse its member fields. */
export type EnterpriseOntologyDraft = EnterpriseOntologyDraftBody & {
  treeId: string;
  expectedHash: string | null;
  error: EnterpriseOntologyDraftError | null;
};

/** Open an ontology form on the selected step, replacing any other open one. */
export function beginEnterpriseOntologyDraft(
  state: EnterpriseState,
  draft: EnterpriseOntologyDraftBody,
) {
  const tree = state.enterpriseTreeDetail;
  if (
    !state.enterpriseVisualEditOriginal ||
    !tree ||
    state.enterpriseTreeSaving ||
    hasPendingEnterpriseNodeEdit(state)
  ) {
    return;
  }
  editSeedSeq++;
  state.enterpriseOntologyDraft = {
    ...draft,
    treeId: tree.id,
    expectedHash: tree.hash ?? null,
    error: null,
  };
}

/** Patch the open form. Any prior error clears as the operator types. */
export function editEnterpriseOntologyDraft(
  state: EnterpriseState,
  patch: Partial<EnterpriseOntologyDraft>,
) {
  const draft = state.enterpriseOntologyDraft;
  if (!draft) {
    return;
  }
  state.enterpriseOntologyDraft = { ...draft, ...patch, error: null } as EnterpriseOntologyDraft;
}

export function cancelEnterpriseOntologyDraft(state: EnterpriseState) {
  state.enterpriseOntologyDraft = null;
}

function normalizedDraftList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Apply the open form.
 *
 * Validation failures stay ON the form rather than becoming a tree-wide banner:
 * the operator is mid-typing and the fix belongs next to the field they got
 * wrong. Anything else (a vanished node, a refused import) is the shared write
 * path's business and reports where it always does.
 */
export async function submitEnterpriseOntologyDraft(state: EnterpriseState) {
  const draft = state.enterpriseOntologyDraft;
  const tree = state.enterpriseTreeDetail;
  if (!draft || !tree || draft.treeId !== tree.id || state.enterpriseTreeSaving) {
    return;
  }
  // An effect names its target and a verb, not an id of its own, so the id gate
  // below would refuse every one of them.
  const idless =
    draft.kind === "action-effect" || draft.kind === "action-call" || draft.kind === "action-link";
  const id = idless ? "" : draft.id.trim().toLowerCase();
  if (!idless && !isValidEnterpriseId(id)) {
    state.enterpriseOntologyDraft = { ...draft, error: "invalid-id" };
    return;
  }
  if (draft.kind === "relationship" && (!draft.from || !draft.to)) {
    state.enterpriseOntologyDraft = { ...draft, error: "endpoint-missing" };
    return;
  }
  // Both AIP verbs hang off an object type the step can address. An empty select
  // means the step has none in scope, and submitting would report the far less
  // useful "entity-not-found" against a blank name.
  if ((draft.kind === "action-effect" || draft.kind === "function") && !draft.entity) {
    state.enterpriseOntologyDraft = { ...draft, error: "endpoint-missing" };
    return;
  }
  // The outward tool is free text (it names a tool the runtime resolves, not an
  // ontology id) and the link's relationship comes from a select that is empty
  // when the step declares none — both submit to nothing useful when blank.
  if (draft.kind === "action-call" && !draft.tool.trim()) {
    state.enterpriseOntologyDraft = { ...draft, error: "endpoint-missing" };
    return;
  }
  if (draft.kind === "action-link" && !draft.relationship) {
    state.enterpriseOntologyDraft = { ...draft, error: "endpoint-missing" };
    return;
  }
  if (
    draft.kind === "action-link" &&
    [draft.from, draft.to].some((parameterId) => parameterId && !isValidEnterpriseId(parameterId))
  ) {
    state.enterpriseOntologyDraft = { ...draft, error: "invalid-id" };
    return;
  }
  if (draft.kind === "constraint" && !draft.description.trim()) {
    state.enterpriseOntologyDraft = { ...draft, error: "description-empty" };
    return;
  }
  const actionTools =
    draft.kind === "action" && draft.toolsMode === "selected"
      ? normalizedDraftList(draft.tools)
      : [];
  if (draft.kind === "action" && draft.toolsMode === "selected" && actionTools.length === 0) {
    state.enterpriseOntologyDraft = { ...draft, error: "selection-empty" };
    return;
  }
  const saved = await applyEnterpriseTreeEdit(
    state,
    (definition) => {
      const metadata = draft.metadataUpdate;
      if (metadata) {
        if (draft.kind === "entity" && metadata.kind === "entity") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            title: draft.title,
            description: draft.description,
          });
        }
        if (draft.kind === "property" && metadata.kind === "property") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            required: draft.required,
            description: draft.description,
          });
        }
        if (draft.kind === "relationship" && metadata.kind === "relationship") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            inverse: draft.inverse,
            description: draft.description,
          });
        }
        if (draft.kind === "action" && metadata.kind === "action") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            title: draft.title,
            description: draft.description,
            tools:
              draft.toolsMode === "all" ? undefined : draft.toolsMode === "none" ? [] : actionTools,
            preconditions: normalizedDraftList(draft.preconditions),
          });
        }
        if (draft.kind === "action-effect" && metadata.kind === "object-effect") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            description: draft.description,
          });
        }
        if (draft.kind === "action-call" && metadata.kind === "call-effect") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            description: draft.description,
          });
        }
        if (draft.kind === "action-link" && metadata.kind === "link-effect") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            description: draft.description,
            from: draft.from,
            to: draft.to,
          });
        }
        if (draft.kind === "action-parameter" && metadata.kind === "parameter") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            required: draft.required,
            description: draft.description,
          });
        }
        if (draft.kind === "function" && metadata.kind === "function") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            title: draft.title,
            description: draft.description,
          });
        }
        if (draft.kind === "constraint" && metadata.kind === "constraint") {
          return updateNodeOntologyMetadata(definition, draft.nodeId, {
            ...metadata,
            description: draft.description,
          });
        }
        return { ok: false as const, reason: "entry-not-found" as const };
      }
      if (draft.kind === "entity") {
        const title = draft.title.trim();
        return addNodeOntologyEntity(definition, draft.nodeId, {
          id,
          ...(title ? { title } : {}),
          ...(draft.description.trim() ? { description: draft.description } : {}),
        });
      }
      if (draft.kind === "property") {
        return addNodeOntologyProperty(
          definition,
          draft.nodeId,
          draft.entityId,
          {
            id,
            type: draft.type,
            ...(draft.primaryKey ? { primaryKey: true } : {}),
            ...(draft.required ? { required: true } : {}),
            ...(draft.description.trim() ? { description: draft.description } : {}),
          },
          draft.entityIndex,
        );
      }
      if (draft.kind === "relationship") {
        return addNodeOntologyRelationship(definition, draft.nodeId, {
          id,
          from: draft.from,
          to: draft.to,
          cardinality: draft.cardinality,
          ...(draft.inverse.trim() ? { inverse: draft.inverse } : {}),
          ...(draft.description.trim() ? { description: draft.description } : {}),
        });
      }
      if (draft.kind === "action") {
        const title = draft.title.trim();
        return addNodeOntologyAction(definition, draft.nodeId, {
          id,
          ...(title ? { title } : {}),
          ...(draft.description.trim() ? { description: draft.description } : {}),
          tools:
            draft.toolsMode === "all" ? undefined : draft.toolsMode === "none" ? [] : actionTools,
          preconditions: normalizedDraftList(draft.preconditions),
        });
      }
      if (draft.kind === "action-effect") {
        return addNodeOntologyActionEffect(
          definition,
          draft.nodeId,
          draft.actionId,
          {
            entity: draft.entity,
            kind: draft.effectKind,
            ...(draft.description.trim() ? { description: draft.description } : {}),
          },
          draft.actionIndex,
        );
      }
      if (draft.kind === "action-call") {
        return addNodeOntologyActionEffect(
          definition,
          draft.nodeId,
          draft.actionId,
          {
            kind: "call",
            tool: draft.tool.trim(),
            ...(draft.description.trim() ? { description: draft.description } : {}),
          },
          draft.actionIndex,
        );
      }
      if (draft.kind === "action-link") {
        return addNodeOntologyActionEffect(
          definition,
          draft.nodeId,
          draft.actionId,
          {
            kind: draft.linkKind,
            relationship: draft.relationship,
            ...(draft.from.trim() ? { from: draft.from.trim() } : {}),
            ...(draft.to.trim() ? { to: draft.to.trim() } : {}),
            ...(draft.description.trim() ? { description: draft.description } : {}),
          },
          draft.actionIndex,
        );
      }
      if (draft.kind === "action-parameter") {
        return addNodeOntologyActionParameter(
          definition,
          draft.nodeId,
          draft.actionId,
          {
            id,
            type: draft.type,
            ...(draft.required ? { required: true } : {}),
            ...(draft.description.trim() ? { description: draft.description } : {}),
          },
          draft.actionIndex,
        );
      }
      if (draft.kind === "constraint") {
        return addNodeOntologyConstraint(definition, draft.nodeId, {
          id,
          description: draft.description,
        });
      }
      const functionTitle = draft.title.trim();
      return addNodeOntologyFunction(definition, draft.nodeId, {
        id,
        ...(functionTitle ? { title: functionTitle } : {}),
        entity: draft.entity,
        expression: draft.expression,
        returns: draft.returns,
        ...(draft.description.trim() ? { description: draft.description } : {}),
      });
    },
    {
      owner: "ontology",
      // Refusals belong on the form beside the field the operator can correct.
      onRefused: (reason) => {
        if (state.enterpriseOntologyDraft === draft) {
          const draftError =
            reason && (ONTOLOGY_EDIT_REASONS as readonly string[]).includes(reason)
              ? (reason as OntologyEditReason)
              : "invalid-id";
          state.enterpriseOntologyDraft = { ...draft, error: draftError };
        }
      },
      expectedHash: draft.expectedHash,
    },
  );
  // Closed only on success: a duplicate id or a vanished endpoint should leave
  // the operator's typing in front of them, not discard it.
  if (saved && state.enterpriseOntologyDraft === draft) {
    state.enterpriseOntologyDraft = null;
  }
}

/** Start or update the behavior draft for one step. */
export function editEnterpriseNodeGuidance(
  state: EnterpriseState,
  nodeId: string,
  patch: Partial<Omit<EnterpriseGuidanceDraft, "treeId" | "nodeId" | "expectedHash">>,
) {
  const tree = state.enterpriseTreeDetail;
  const node = tree?.nodes.find((candidate) => candidate.id === nodeId);
  const open = state.enterpriseGuidanceDraft;
  if (
    !state.enterpriseVisualEditOriginal ||
    state.enterpriseTreeSaving ||
    !tree ||
    !node ||
    state.enterpriseNodeDraft ||
    state.enterpriseBindingPicker ||
    state.enterpriseOntologyDraft ||
    (open && (open.treeId !== tree.id || open.nodeId !== nodeId))
  ) {
    return;
  }
  editSeedSeq++;
  const current =
    state.enterpriseGuidanceDraft?.treeId === tree.id &&
    state.enterpriseGuidanceDraft.nodeId === nodeId
      ? state.enterpriseGuidanceDraft
      : {
          treeId: tree.id,
          nodeId,
          expectedHash: tree.hash ?? null,
          title: node.title,
          parentId: node.parentId,
          position: tree.nodes
            .filter((candidate) => candidate.parentId === node.parentId)
            .findIndex((candidate) => candidate.id === node.id),
          description: node.description ?? "",
          text: node.ontology.guidance ?? "",
          contextHints: [...(node.ontology.contextHints ?? [])],
          expectedOutput: node.ontology.expectedOutput ?? "",
          audit: node.ontology.audit ?? false,
          error: null,
        };
  state.enterpriseGuidanceDraft = { ...current, ...patch, error: null };
}

/** Discard the draft, reverting the field to whatever the tree has saved. */
export function cancelEnterpriseNodeGuidance(state: EnterpriseState) {
  state.enterpriseGuidanceDraft = null;
}

/**
 * Save a step's operator-authored behavior.
 *
 * Same export→edit→import route as every other binding write, so it lands as one
 * revision the version history can restore. Blank clears the key rather than
 * writing an empty string: `guidance` is optional, and an empty one would put an
 * empty instruction line in the step digest.
 */
export async function saveEnterpriseNodeGuidance(state: EnterpriseState, nodeId: string) {
  const tree = state.enterpriseTreeDetail;
  const draft = state.enterpriseGuidanceDraft;
  if (
    !tree ||
    !draft ||
    draft.nodeId !== nodeId ||
    // The draft must belong to the tree on screen, or a same-named step in
    // another tree would receive it.
    draft.treeId !== tree.id
  ) {
    return;
  }
  const title = draft.title.trim();
  if (!title) {
    state.enterpriseGuidanceDraft = { ...draft, error: "title-empty" };
    return;
  }
  if (!Number.isSafeInteger(draft.position) || draft.position < 0) {
    state.enterpriseGuidanceDraft = { ...draft, error: "move-refused" };
    return;
  }
  const treeId = tree.id;
  const saved = await applyEnterpriseTreeEdit(
    state,
    (definition) => {
      const structured =
        draft.parentId === null
          ? { ok: true as const, definition }
          : moveTreeNode(definition, nodeId, {
              parentId: draft.parentId,
              index: draft.position,
            });
      if (!structured.ok) {
        return structured;
      }
      return setNodeBehavior(structured.definition, nodeId, {
        title,
        description: draft.description,
        guidance: draft.text,
        contextHints: draft.contextHints,
        expectedOutput: draft.expectedOutput,
        audit: draft.audit,
      });
    },
    {
      owner: "guidance",
      expectedHash: draft.expectedHash,
      onRefused: () => {
        if (state.enterpriseGuidanceDraft === draft) {
          state.enterpriseGuidanceDraft = { ...draft, error: "move-refused" };
        }
      },
    },
  );
  if (!saved) {
    return;
  }
  // Only after the reload the helper already awaited: the draft IS what the
  // textarea shows, so dropping it earlier snaps the field back to the pre-save
  // snapshot — and if that reload failed, the stale text would sit there inviting
  // an overwrite of a save that already landed. Guarded so a draft the operator
  // started elsewhere meanwhile is not discarded.
  if (state.enterpriseGuidanceDraft === draft && draft.treeId === treeId) {
    state.enterpriseGuidanceDraft = null;
  }
}

/** Remove a non-root step and its descendants through the shared guarded import. */
export async function removeEnterpriseNode(state: EnterpriseState, nodeId: string) {
  await applyEnterpriseTreeEdit(state, (definition) => removeTreeNode(definition, nodeId), {
    onRefused: () => {
      state.enterpriseTreeSaveError = t("enterprise.structureEditRefused");
    },
  });
}

/**
 * Refusals that mean this SCREEN is behind rather than the operator wrong: the
 * step or the entry vanished between the snapshot and the export. They reload
 * the work-map instead of reporting, so they never reach the error strings — and
 * that is why `enterprise.ontologyEditor.error` carries no entry for them.
 */
const STALE_EDIT_REASONS = [
  "node-not-found",
  "entry-not-found",
] as const satisfies readonly OntologyEditReason[];

export const ONTOLOGY_EDIT_REASONS_REPORTED: readonly OntologyEditReason[] =
  ONTOLOGY_EDIT_REASONS.filter(
    (reason) => !(STALE_EDIT_REASONS as readonly OntologyEditReason[]).includes(reason),
  );

type EnterpriseTreeEditReason = OntologyEditReason | TreeStructureEditReason | "title-empty";

type ApplyEnterpriseTreeEditOptions = {
  owner?: "tree" | "node" | "guidance" | "ontology";
  onRefused?: (reason: EnterpriseTreeEditReason | undefined) => void;
  onSaved?: () => void;
  expectedHash?: string | null;
};

/**
 * Apply every per-node edit to the local definition. The editor owns the single
 * guarded import after the operator confirms Save.
 */
async function applyEnterpriseTreeEdit(
  state: EnterpriseState,
  edit: (
    definition: EditableTreeDefinition,
  ) =>
    | { ok: true; definition: EditableTreeDefinition }
    | { ok: false; reason?: EnterpriseTreeEditReason },
  options: ApplyEnterpriseTreeEditOptions = {},
): Promise<boolean> {
  const tree = state.enterpriseTreeDetail;
  const conflictingDraft =
    (state.enterpriseTreeDraft && options.owner !== "tree") ||
    (state.enterpriseNodeDraft && options.owner !== "node") ||
    (state.enterpriseGuidanceDraft && options.owner !== "guidance") ||
    (state.enterpriseOntologyDraft && options.owner !== "ontology") ||
    state.enterpriseBindingPicker;
  if (!tree || state.enterpriseTreeSaving || conflictingDraft) {
    return false;
  }
  if (!state.enterpriseVisualEditOriginal && options.owner !== "tree") {
    return false;
  }
  if (!tree.hash) {
    state.enterpriseTreeSaveError = t("enterprise.treeUnavailable");
    return false;
  }
  const editIntent = ++editSeedSeq;
  const exported = state.enterpriseVisualEditOriginal
    ? { ok: true as const, content: state.enterpriseTreeEditContent }
    : await fetchExportContent(state, tree.id, "json");
  if (editIntent !== editSeedSeq || state.enterpriseSelectedTreeId !== tree.id) {
    return false;
  }
  const definition = exported.ok ? parseTreeDefinition(exported.content) : null;
  if (!definition) {
    state.enterpriseTreeSaveError = t("enterprise.entryDraft.exportFailed");
    return false;
  }
  const result = edit(definition);
  if (!result.ok) {
    if (options.onRefused) {
      options.onRefused(result.reason);
    } else {
      state.enterpriseTreeSaveError = t("enterprise.structureEditRefused");
    }
    return false;
  }
  if (!state.enterpriseVisualEditOriginal) {
    state.enterpriseTreeEditTreeId = tree.id;
    state.enterpriseTreeEditGuard = { expectedHash: options.expectedHash ?? tree.hash };
  }
  stageEnterpriseTreeDefinition(state, result.definition);
  options.onSaved?.();
  return true;
}

/** Keep all visual changes local; only the confirmed Save sends a whole-tree write. */
function stageEnterpriseTreeDefinition(state: EnterpriseState, definition: EditableTreeDefinition) {
  state.enterpriseTreeEditContent = `${JSON.stringify(definition, null, 2)}\n`;
  state.enterpriseTreeEditFormat = "json";
  state.enterpriseTreeEditing = true;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeSaveIssues = null;
  const original = state.enterpriseVisualEditOriginal;
  if (!original) {
    return;
  }
  const nodes: EnterpriseTreeDetail["nodes"] = [];
  const visit = (node: EditableTreeDefinition["root"], parentId: string | null, depth: number) => {
    nodes.push({
      id: node.id,
      title: node.title,
      description: node.description,
      parentId,
      depth,
      ontology: (node.ontology ?? {}) as EnterpriseTreeDetail["nodes"][number]["ontology"],
    });
    for (const child of node.children ?? []) {
      visit(child, node.id, depth + 1);
    }
  };
  visit(definition.root, null, 0);
  state.enterpriseTreeDetail = {
    ...original,
    executionModel:
      typeof definition.executionModel === "string" ? definition.executionModel : undefined,
    capabilityGrants: definition.capabilityGrants === "explicit" ? "explicit" : undefined,
    nodes,
  };
  if (!nodes.some((node) => node.id === state.enterpriseSelectedNodeId)) {
    clearEnterpriseNodeSelection(state);
  }
}

export async function removeEnterpriseBinding(
  state: EnterpriseState,
  params: { nodeId: string; field: NodeOntologyListField; entry: string },
) {
  // A Detach can be issued FROM the detail card, so close it first: leaving it up
  // would describe a binding the step no longer has, and offer Detach again.
  state.enterpriseBindingDetail = null;
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyEntry(definition, params.nodeId, params.field, params.entry),
  );
}

/** Opt the selected work-map into attachment-based MCP governance. */
export async function enableEnterpriseMcpGovernance(state: EnterpriseState, nodeId: string) {
  await applyEnterpriseTreeEdit(state, (definition) => enableNodeMcpGovernance(definition, nodeId));
}

/** Explicitly return an inherited work-map with no attachments to unrestricted MCP. */
export async function disableEnterpriseMcpGovernance(state: EnterpriseState) {
  await applyEnterpriseTreeEdit(state, disableTreeMcpGovernance);
}

export async function removeEnterpriseOntologyEntity(
  state: EnterpriseState,
  params: { nodeId: string; entityId: string; entityIndex?: number },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyEntity(
      definition,
      params.nodeId,
      params.entityIndex === undefined
        ? params.entityId
        : { id: params.entityId, index: params.entityIndex },
    ),
  );
}

export async function removeEnterpriseOntologyProperty(
  state: EnterpriseState,
  params: {
    nodeId: string;
    entityId: string;
    propertyId: string;
    entityIndex?: number;
    propertyIndex?: number;
  },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyProperty(
      definition,
      params.nodeId,
      params.entityId,
      params.propertyId,
      params.entityIndex !== undefined && params.propertyIndex !== undefined
        ? { entityIndex: params.entityIndex, propertyIndex: params.propertyIndex }
        : undefined,
    ),
  );
}

export async function removeEnterpriseOntologyRelationship(
  state: EnterpriseState,
  params: { nodeId: string; link: { id: string; from: string; to: string; index?: number } },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyRelationship(definition, params.nodeId, params.link),
  );
}

export async function removeEnterpriseOntologyAction(
  state: EnterpriseState,
  params: { nodeId: string; actionId: string; actionIndex?: number },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyAction(definition, params.nodeId, params.actionId, params.actionIndex),
  );
}

export async function removeEnterpriseOntologyActionEffect(
  state: EnterpriseState,
  params: {
    nodeId: string;
    actionId: string;
    actionIndex?: number;
    effectIndex?: number;
  } & (
    | { entity: string; kind: OntologyEffectKindName }
    | { kind: "call"; tool: string }
    | { kind: "link" | "unlink"; relationship: string }
  ),
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyActionEffect(
      definition,
      params.nodeId,
      params.actionId,
      "entity" in params
        ? {
            entity: params.entity,
            kind: params.kind,
            actionIndex: params.actionIndex,
            effectIndex: params.effectIndex,
          }
        : params.kind === "call"
          ? {
              kind: "call",
              tool: params.tool,
              actionIndex: params.actionIndex,
              effectIndex: params.effectIndex,
            }
          : {
              kind: params.kind,
              relationship: params.relationship,
              actionIndex: params.actionIndex,
              effectIndex: params.effectIndex,
            },
    ),
  );
}

export async function removeEnterpriseOntologyActionParameter(
  state: EnterpriseState,
  params: {
    nodeId: string;
    actionId: string;
    parameterId: string;
    actionIndex?: number;
    parameterIndex?: number;
  },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyActionParameter(
      definition,
      params.nodeId,
      params.actionId,
      params.parameterId,
      params.actionIndex !== undefined && params.parameterIndex !== undefined
        ? { actionIndex: params.actionIndex, parameterIndex: params.parameterIndex }
        : undefined,
    ),
  );
}

export async function removeEnterpriseOntologyFunction(
  state: EnterpriseState,
  params: { nodeId: string; functionId: string; functionIndex?: number },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyFunction(definition, params.nodeId, params.functionId, params.functionIndex),
  );
}

export async function removeEnterpriseOntologyConstraint(
  state: EnterpriseState,
  params: { nodeId: string; target: { index: number; id: string } },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyConstraint(definition, params.nodeId, params.target),
  );
}

/**
 * Turn the selected work-map's explicit capability grants on or off.
 *
 * Stage the flag in the same local definition as bindings and ontology edits;
 * it takes effect only when the operator confirms the whole-tree save.
 *
 * Turning it on narrows every step at once — a step that lists no tools stops
 * reaching any — so the button says which direction it goes and the write lands
 * as an ordinary revision the version history can restore.
 */
export async function toggleEnterpriseCapabilityGrants(state: EnterpriseState) {
  const tree = state.enterpriseTreeDetail;
  if (!tree) {
    return;
  }
  const next = tree.capabilityGrants === "explicit" ? undefined : "explicit";
  await applyEnterpriseTreeEdit(state, (definition) => {
    // Removed rather than set to a second value: the schema accepts one, and
    // absence IS the inherited mode. Leaving a key behind would make "off" look
    // like a mode the definition declares.
    const { capabilityGrants: _dropped, ...rest } = definition;
    return {
      ok: true,
      definition: next ? { ...rest, capabilityGrants: next } : rest,
    };
  });
}

/**
 * The same failure as one line, for the tree banner a dismissed dialog falls back
 * to. That banner takes text, not a list, and enterpriseTreeSaveIssues belongs to
 * the editor — writing issues there would surface them on a draft they do not
 * describe — so the paths are folded into the sentence.
 */
function importFailureText(outcome: Exclude<TreeImportOutcome, { status: "saved" }>): string {
  if (outcome.status === "refused") {
    return t("enterprise.entryDraft.importRefused", { message: outcome.message });
  }
  if (outcome.status === "not-sent") {
    return t("enterprise.entryDraft.importNotSent");
  }
  if (outcome.status !== "rejected") {
    return t("enterprise.entryDraft.importFailed");
  }
  const detail = outcome.issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .filter((entry) => entry.length > 0)
    .join(" · ");
  return detail
    ? t("enterprise.entryDraft.importRejectedDetail", { issues: detail })
    : t("enterprise.entryDraft.importRejected");
}

function removeFailureText(failure: TreeRequestFailure): string {
  if (failure.status === "not-sent") {
    return t("enterprise.removeNotSent");
  }
  if (failure.status === "refused") {
    return t("enterprise.removeRefused", { message: failure.message });
  }
  return t("enterprise.removeUnconfirmed");
}

/**
 * What one import did. Three of these wrote nothing and can say so: `rejected` is
 * a validation refusal with the paths to fix, `refused` is a server error frame
 * with its message, and `not-sent` never reached the socket. Only `unknown` — a
 * frame that went out and whose answer never came back — leaves the outcome open,
 * so it is the only one allowed to tell the operator the change may have applied.
 */
type TreeImportOutcome =
  | { status: "saved"; treeId?: string }
  | { status: "rejected"; issues: EnterpriseTreeImportIssue[] }
  | { status: "refused"; message: string }
  | { status: "not-sent" }
  | { status: "unknown" };

type TreeRequestFailure = Extract<
  TreeImportOutcome,
  { status: "refused" | "not-sent" | "unknown" }
>;

function classifyTreeRequestFailure(error: unknown): TreeRequestFailure {
  if (error instanceof GatewayNotConnectedError) {
    return { status: "not-sent" };
  }
  if (error instanceof GatewayRequestError) {
    return { status: "refused", message: error.message };
  }
  return { status: "unknown" };
}

async function requestTreeImport(
  client: GatewayBrowserClient,
  params: {
    content: string;
    format: EnterpriseTreeEditFormat;
    createOnly?: true;
    expectedHash?: string;
  },
): Promise<TreeImportOutcome> {
  try {
    const res = await client.request<EnterpriseTreesImportResult>(
      "enterprise.trees.import",
      params,
    );
    return res.ok
      ? { status: "saved", ...(res.treeId ? { treeId: res.treeId } : {}) }
      : { status: "rejected", issues: res.issues ?? [] };
  } catch (error) {
    // A closed socket means the frame never left; an error frame is a definite
    // refusal. Other request failures can happen after send, so their outcome is
    // unknown and the UI must keep the draft for reconciliation.
    return classifyTreeRequestFailure(error);
  }
}

/**
 * Reload the registry and the written tree after a successful import.
 *
 * Returns whether the DETAIL on screen is authoritative afterwards. A caller
 * holding unsaved state may only discard it on `true`: `false` means the whole
 * post-write screen did not reconcile, even when one independent read succeeded.
 * Keeping the draft avoids making a saved change appear to vanish and inviting a
 * retry from stale content.
 */
async function refreshAfterTreeWrite(
  state: EnterpriseState,
  treeId: string | undefined,
  /** What was selected when the write STARTED; navigation since then wins. */
  selectedAtWrite: string | null,
  editIntent = editSeedSeq,
): Promise<boolean> {
  // An import rebuilds the server's bundle knowledge registry, so the catalogs
  // this screen suggests from are stale until reloaded.
  void loadEnterpriseCatalogs(state);
  const ownsScreen =
    editIntent === editSeedSeq && state.enterpriseSelectedTreeId === selectedAtWrite;
  const preservedScreenError = ownsScreen ? null : state.enterpriseError;
  // Start the detail reload before callers release their mutation lock. This
  // synchronously removes the stale pre-write hash, so a slow response cannot
  // expose an edit/remove action that is guaranteed to lose its CAS check.
  const detailReload = ownsScreen && treeId ? loadEnterpriseTreeDetail(state, treeId) : null;
  // A new-tree detail load clears the prior node selection synchronously, which
  // advances the edit token as housekeeping rather than a newer user intent.
  const detailIntent = editSeedSeq;
  // Editing a BUILT-IN tree creates an imported override, so the registry list
  // still says `source: "builtin"` (and still shows any now-resolved import or
  // store error) until it is reloaded.
  const listReload = loadEnterprise(state, "trees");
  // loadEnterprise clears the banner synchronously. A background reconcile for
  // an older screen must not hide the newer screen's error while pending.
  if (preservedScreenError && !state.enterpriseError) {
    state.enterpriseError = preservedScreenError;
  }
  await Promise.all([listReload, ...(detailReload ? [detailReload] : [])]);
  if (
    state.enterpriseListErrors.trees ||
    state.enterpriseError ||
    !detailReload ||
    !treeId ||
    detailIntent !== editSeedSeq ||
    state.enterpriseSelectedTreeId !== treeId
  ) {
    return false;
  }
  // Only now is what the screen shows the post-write server copy.
  // `enterpriseTreeIssue` is what a failed detail load leaves behind, so a stale
  // snapshot with the right id does not pass for a fresh one.
  const reloaded = state.enterpriseTreeDetail?.id === treeId && !state.enterpriseTreeIssue;
  await loadEnterpriseTreeVersions(state, treeId);
  return reloaded && detailIntent === editSeedSeq && state.enterpriseSelectedTreeId === treeId;
}

function parseTreeDefinition(content: string): EditableTreeDefinition | null {
  try {
    const parsed: unknown = JSON.parse(content);
    // The export is a validated definition, but guard the shape the splice needs.
    if (
      parsed &&
      typeof parsed === "object" &&
      "root" in parsed &&
      typeof parsed.root === "object"
    ) {
      return parsed as EditableTreeDefinition;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Switch the editor exchange format and re-seed the content in that format —
 * the raw editor cannot reliably convert arbitrary in-progress edits. A new-tree
 * draft regenerates the template; an existing edit re-exports; a history draft
 * re-fetches the same revision so it is not silently replaced by the live tree.
 */
export async function setEnterpriseTreeEditFormat(
  state: EnterpriseState,
  format: EnterpriseTreeEditFormat,
) {
  if (state.enterpriseTreeEditFormat === format) {
    // Re-selecting the current format cancels a pending reseed to the other one
    // (the format only flips once its reseed lands, so this catches that click).
    editSeedSeq++;
    return;
  }
  if (!state.enterpriseTreeEditing) {
    // Not editing: record the preferred format for the next edit.
    state.enterpriseTreeEditFormat = format;
    return;
  }
  const editTreeId = state.enterpriseTreeEditTreeId;
  if (editTreeId === null) {
    // New-tree draft: regenerate the template + set the format atomically, and
    // drop diagnostics from the prior content that no longer applies.
    editSeedSeq++;
    state.enterpriseTreeSaveIssues = null;
    state.enterpriseTreeSaveError = null;
    state.enterpriseTreeEditFormat = format;
    state.enterpriseTreeEditContent = treeTemplate(format);
    return;
  }
  // Do NOT change the format until the reseed lands: until then the editor holds
  // the previous-format text, and Save must keep sending the matching format.
  const revision = state.enterpriseTreeEditRevision;
  const guard = state.enterpriseTreeEditGuard;
  const seedSeq = ++editSeedSeq;
  const result =
    revision === null
      ? await fetchExportContent(state, editTreeId, format)
      : await fetchHistoryContent(state, editTreeId, revision, format);
  applyEditorSeed(state, seedSeq, format, editTreeId, revision, guard, result);
}

export function cancelEditEnterpriseTree(state: EnterpriseState) {
  resetTreeEditing(state);
}

/** Load a historical revision into the editor to review or restore it. */
export async function loadEnterpriseTreeVersion(
  state: EnterpriseState,
  treeId: string,
  revision: number,
) {
  const tree = state.enterpriseTreeDetail;
  const guard: EnterpriseTreeImportGuard =
    tree?.id === treeId && tree.hash
      ? { expectedHash: tree.hash }
      : state.enterpriseSelectedTreeId === treeId &&
          state.enterpriseHistoryOnlyTreeIds.includes(treeId)
        ? { createOnly: true }
        : null;
  if (!guard) {
    return;
  }
  const format = state.enterpriseTreeEditFormat;
  const seedSeq = ++editSeedSeq;
  const result = await fetchHistoryContent(state, treeId, revision, format);
  applyEditorSeed(state, seedSeq, format, treeId, revision, guard, result);
}

/** Ask the confirmation modal before persisting the current edit. */
export function requestSaveEnterpriseTree(state: EnterpriseState) {
  if (
    !state.enterpriseTreeEditing ||
    state.enterpriseTreeSaving ||
    hasPendingEnterpriseNodeEdit(state)
  ) {
    return;
  }
  state.enterpriseTreeConfirm = { kind: "save" };
}

/** Ask the confirmation modal before removing an imported tree. */
export async function requestRemoveEnterpriseTree(state: EnterpriseState, treeId: string) {
  if (state.enterpriseTreeSaving) {
    return;
  }
  const importError = state.enterpriseImportErrors.find((issue) => issue.treeId === treeId);
  let invalidFingerprint = importError?.fingerprint;
  if (importError && !invalidFingerprint && state.client && state.connected) {
    try {
      const detail = await state.client.request<EnterpriseTreesGetResult>("enterprise.trees.get", {
        treeId,
      });
      if (detail.importError && detail.importErrorFingerprint) {
        invalidFingerprint = detail.importErrorFingerprint;
      }
    } catch {
      // Fall through to the typed refusal below. Never substitute an unguarded
      // remove when an older gateway cannot supply this additive identity.
    }
  }
  const guard: EnterpriseTreeRemoveGuard | null = importError
    ? invalidFingerprint
      ? { expectedInvalidFingerprint: invalidFingerprint }
      : null
    : state.enterpriseTreeDetail?.id === treeId &&
        state.enterpriseTreeDetail.source === "imported" &&
        state.enterpriseTreeDetail.hash
      ? { expectedHash: state.enterpriseTreeDetail.hash }
      : null;
  if (guard) {
    state.enterpriseTreeConfirm = { kind: "remove", treeId, guard };
  } else {
    const message = importError
      ? t("enterprise.removeFingerprintUnavailable", { treeId })
      : `no removable imported tree "${treeId}" is loaded`;
    if (state.enterpriseSelectedTreeId === treeId) {
      state.enterpriseTreeIssue = message;
    } else {
      state.enterpriseError = message;
    }
  }
}

export function cancelEnterpriseTreeConfirm(state: EnterpriseState) {
  state.enterpriseTreeConfirm = null;
}

/** Resolve the open confirmation: persist the edit or remove the tree. */
export async function confirmEnterpriseTreeAction(state: EnterpriseState) {
  const confirm = state.enterpriseTreeConfirm;
  if (!confirm || !state.client || !state.connected || state.enterpriseTreeSaving) {
    return;
  }
  state.enterpriseTreeConfirm = null;
  if (confirm.kind === "save") {
    await saveEnterpriseTree(state);
  } else {
    await removeEnterpriseTree(state, confirm.treeId, confirm.guard);
  }
}

async function saveEnterpriseTree(state: EnterpriseState) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  // Invalidate any in-flight format/history reseed so a late applyEditorSeed
  // cannot swap the textarea content out from under the submitted draft; the
  // resulting token is the edit intent. The tree list / New Tree controls stay
  // usable while the import is in flight, so if the operator moves on we must not
  // clobber that newer editor/selection with this older save's result.
  const editIntent = ++editSeedSeq;
  const superseded = () => editIntent !== editSeedSeq;
  const writeToken = ++treeWriteSeq;
  const releaseLock = () => {
    if (writeToken === treeWriteSeq) {
      state.enterpriseTreeSaving = false;
    }
  };
  state.enterpriseTreeSaving = true;
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  const selectedAtWrite = state.enterpriseSelectedTreeId;
  const releaseNavigation = holdTreeWriteNavigation(state, state.enterpriseTreeEditTreeId);
  try {
    const outcome = await requestTreeImport(client, {
      content: state.enterpriseTreeEditContent,
      format: state.enterpriseTreeEditFormat,
      ...state.enterpriseTreeEditGuard,
    });
    if (outcome.status === "rejected") {
      // Schema-invalid content: keep the editor open with the issues shown, but
      // only if the operator is still on the same draft.
      if (!superseded()) {
        state.enterpriseTreeSaveIssues = outcome.issues;
      }
      return;
    }
    if (outcome.status !== "saved") {
      if (!superseded()) {
        state.enterpriseTreeSaveError = importFailureText(outcome);
      }
      return;
    }
    if (superseded()) {
      // Screen ownership moved, but the shared tree/catalog registries still
      // changed. Their background reconciliation preserves the newer UI state.
      const refresh = refreshAfterTreeWrite(state, outcome.treeId, selectedAtWrite, editIntent);
      releaseLock();
      releaseNavigation();
      await refresh;
      return;
    }
    // resetTreeEditing bumps editSeedSeq; capture a fresh intent to detect the
    // operator moving on during the post-write reload below.
    resetTreeEditing(state);
    const openIntent = editSeedSeq;
    // Starting the refresh clears the pre-save detail synchronously. Unlock only
    // after that, so a second mutation can never capture its stale hash.
    const refresh = refreshAfterTreeWrite(state, outcome.treeId, selectedAtWrite, openIntent);
    releaseLock();
    releaseNavigation();
    await refresh;
  } finally {
    releaseLock();
    releaseNavigation();
  }
}

async function removeEnterpriseTree(
  state: EnterpriseState,
  treeId: string,
  guard: EnterpriseTreeRemoveGuard,
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const writeToken = ++treeWriteSeq;
  const removeIntent = ++editSeedSeq;
  const selectedAtWrite = state.enterpriseSelectedTreeId;
  const ownsScreen = () => writeToken === treeWriteSeq && removeIntent === editSeedSeq;
  const release = () => {
    if (writeToken === treeWriteSeq) {
      state.enterpriseTreeSaving = false;
    }
  };
  state.enterpriseTreeSaving = true;
  const releaseNavigation = holdTreeWriteNavigation(state, treeId);
  try {
    const res = await client.request<EnterpriseTreesRemoveResult>("enterprise.trees.remove", {
      treeId,
      ...guard,
    });
    // Recompute AFTER the await: removal can come from the import-error banner
    // for a different tree, and the operator may have selected another tree or
    // started a draft while this was in flight — only touch the editor/selection
    // when they still belong to the removed id, or newer work would be discarded.
    const ownsAtSettlement = ownsScreen();
    const affectsCurrent = ownsAtSettlement && state.enterpriseSelectedTreeId === treeId;
    if (!res.removed) {
      const reason = "reason" in res ? res.reason : "not-found";
      const message =
        reason === "tree-changed"
          ? `workflow tree "${treeId}" changed since it was loaded; reload before removing it`
          : reason === "tree-unavailable"
            ? `cannot verify workflow tree "${treeId}" is current; reload and try again`
            : `no imported tree "${treeId}" to remove`;
      if (!ownsAtSettlement) {
        return;
      }
      if (affectsCurrent) {
        state.enterpriseTreeIssue = message;
      } else {
        state.enterpriseError = message;
      }
      return;
    }
    if (affectsCurrent) {
      resetTreeEditing(state);
      state.enterpriseSelectedTreeId = null;
      state.enterpriseTreeDetail = null;
      state.enterpriseTreeIssue = null;
      state.enterpriseTreeWarnings = null;
      state.enterpriseTreeVersions = [];
    }
    // The mutation changed shared registry/catalog state even if the operator
    // navigated away. No detail reload is needed for a tree that was removed.
    const refresh = refreshAfterTreeWrite(state, undefined, selectedAtWrite, removeIntent);
    release();
    releaseNavigation();
    await refresh;
  } catch (error) {
    if (!ownsScreen()) {
      return;
    }
    const failure = classifyTreeRequestFailure(error);
    const message = removeFailureText(failure);
    if (state.enterpriseSelectedTreeId === treeId) {
      state.enterpriseTreeIssue = message;
      if (failure.status === "unknown") {
        // The delete may have committed. Drop the stale snapshot/hash so the UI
        // cannot immediately submit another mutation against an uncertain tree.
        state.enterpriseTreeDetail = null;
        state.enterpriseTreeWarnings = null;
        state.enterpriseTreeVersions = [];
      }
    } else {
      state.enterpriseError = message;
    }
  } finally {
    release();
    releaseNavigation();
  }
}

/** Export a tree in `format` and trigger a browser download of the artifact. */
export async function exportEnterpriseTree(
  state: EnterpriseState,
  treeId: string,
  format: EnterpriseTreeEditFormat,
) {
  const exportSeq = ++treeExportSeq;
  const editIntent = editSeedSeq;
  const selectedAtStart = state.enterpriseSelectedTreeId;
  const ownsStatus = () =>
    exportSeq === treeExportSeq &&
    editIntent === editSeedSeq &&
    selectedAtStart === treeId &&
    state.enterpriseSelectedTreeId === treeId;
  const result = await fetchExportContent(state, treeId, format);
  if (!result.ok) {
    if (!result.scopeCleared && ownsStatus()) {
      state.enterpriseTreeSaveError = result.reason;
    }
    return;
  }
  // A prior failed export may have left an error banner; a successful retry
  // must clear it before the download.
  if (ownsStatus()) {
    state.enterpriseTreeSaveError = null;
  }
  triggerDownload(`${treeId}.${format}`, result.content);
}

function triggerDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function treeTemplate(format: EnterpriseTreeEditFormat): string {
  // Saving makes this an IMPORTED work-map, and imported work-maps govern runs
  // — there is no inert draft state, so the placeholder name/steps are meant to
  // be replaced before saving. `triggers` is the one deterministic gate left: it
  // keeps a half-finished tree out of system and subagent runs.
  const tree = {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "acme.new-tree",
    version: "1.0.0",
    name: "New workflow tree",
    match: { triggers: ["user"] },
    root: { id: "root", title: "Root step" },
  };
  if (format === "json") {
    return `${JSON.stringify(tree, null, 2)}\n`;
  }
  return [
    "schema: clawworks.workflow-tree",
    "schemaVersion: 1",
    "id: acme.new-tree",
    "version: 1.0.0",
    "name: New workflow tree",
    "match:",
    "  triggers: [user]",
    "root:",
    "  id: root",
    "  title: Root step",
    "",
  ].join("\n");
}

/**
 * Reload the list + registry and, when open, the selected run detail and tree.
 */
export async function refreshEnterprise(state: EnterpriseState) {
  const editIntent = editSeedSeq;
  const saveError = state.enterpriseTreeSaveError;
  // Lists and inspectors are independent reads. Start the list refresh, but do
  // not make an unrelated hung endpoint block the already-selected inspector.
  const lists = loadEnterprise(state);
  const selectedRun = state.enterpriseSelectedExecutionId;
  if (selectedRun) {
    await loadEnterpriseRunDetail(state, selectedRun);
    // A failed run-detail reload set the banner; the tree reload below clears
    // enterpriseError at request start, which would hide that failure.
    if (state.enterpriseError) {
      return;
    }
  }
  const selectedTree = state.enterpriseSelectedTreeId;
  if (selectedTree) {
    await loadEnterpriseTreeDetail(state, selectedTree);
    // The detail request can lose a race to an explicit tree selection. Do not
    // start a newer history request for the tree Refresh no longer owns: it would
    // supersede the selected tree's history load and paint the wrong revisions.
    if (state.enterpriseSelectedTreeId === selectedTree) {
      await loadEnterpriseTreeVersions(state, selectedTree);
    }
  }
  await lists;
  const selectedTreeReloaded =
    !selectedTree ||
    (state.enterpriseTreeDetail?.id === selectedTree && !state.enterpriseTreeIssue);
  if (
    !state.enterpriseVisualEditOriginal &&
    editIntent === editSeedSeq &&
    state.enterpriseTreeSaveError === saveError &&
    selectedTreeReloaded &&
    state.enterpriseListErrors.trees === null &&
    !state.enterpriseStoreError &&
    !state.enterpriseError
  ) {
    state.enterpriseTreeSaveError = null;
  }
}

function applyError(state: EnterpriseState, err: unknown) {
  if (isMissingOperatorReadScopeError(err)) {
    // Advance every request token so any in-flight list/run/tree/history response
    // is dropped by its sequence guard — otherwise a load started before the
    // scope loss could resolve afterward and repopulate the data cleared here.
    listRequestSeq++;
    detailRequestSeq++;
    treeRequestSeq++;
    versionsRequestSeq++;
    // The knowledge catalog is governed by the same scope, and a load started
    // before the loss must not repopulate the lists cleared below.
    catalogRequestSeq++;
    // Also drop the node inspector: clearing bumps nodeObjectsRequestSeq so an
    // in-flight enterprise.objects.list cannot write governed rows back after
    // the scope loss, the same invariant the other tokens above enforce.
    clearEnterpriseNodeSelection(state);
    // A pending loadEnterprise owns enterpriseLoading; since its token is now
    // stale it will skip its own finally, so clear the flag here.
    state.enterpriseLoading = false;
    // A downgraded/reconnected token without operator.read must not keep prior
    // governed run/tree data on screen under the error banner.
    state.enterpriseRuns = [];
    state.enterpriseTrees = [];
    state.enterpriseHistoryOnlyTreeIds = [];
    state.enterpriseListErrors = { runs: null, trees: null };
    state.enterpriseImportErrors = [];
    state.enterpriseStoreError = null;
    state.enterpriseSelectedExecutionId = null;
    state.enterpriseDetail = null;
    state.enterpriseRunTree = null;
    state.enterpriseDetailLoading = false;
    state.enterpriseSelectedTreeId = null;
    state.enterpriseTreeDetail = null;
    state.enterpriseTreeLoading = false;
    state.enterpriseTreeIssue = null;
    state.enterpriseTreeWarnings = null;
    state.enterpriseTreeVersions = [];
    state.enterpriseTreeVersionsLoading = false;
    state.enterpriseTreeVersionsError = null;
    state.enterpriseCatalogPhase = "unloaded";
    state.enterpriseCatalogErrors = { tools: null, skills: null, foundations: null };
    state.enterpriseCatalogAgentId = null;
    state.enterpriseToolGroups = [];
    state.enterpriseSkills = [];
    state.enterpriseFoundations = [];
    resetTreeEditing(state);
    state.enterpriseError = formatMissingOperatorReadScopeMessage("enterprise runs");
    return;
  }
  state.enterpriseError = String(err);
}
