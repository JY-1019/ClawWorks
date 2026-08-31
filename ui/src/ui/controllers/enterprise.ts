// Control UI controller manages the enterprise inspection gateway state.
import type {
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
import { GatewayNotConnectedError, GatewayRequestError } from "../gateway.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { nodeObjectEntityIds } from "../views/enterprise-ontology-graph.ts";
import {
  addNodeOntologyAction,
  addNodeOntologyActionEffect,
  addNodeOntologyActionParameter,
  addNodeOntologyEntry,
  addNodeOntologyEntity,
  addNodeOntologyFunction,
  addNodeOntologyProperty,
  addNodeOntologyRelationship,
  removeNodeOntologyAction,
  removeNodeOntologyActionEffect,
  removeNodeOntologyActionParameter,
  removeNodeOntologyEntity,
  removeNodeOntologyEntry,
  removeNodeOntologyFunction,
  removeNodeOntologyProperty,
  removeNodeOntologyRelationship,
  setNodeGuidance,
  ONTOLOGY_EDIT_REASONS,
  type OntologyCardinalityName,
  type OntologyEditReason,
  type OntologyEffectKindName,
  type OntologyValueTypeName,
  isValidEnterpriseId,
  isValidSkillName,
  type EditableTreeDefinition,
  insertChildNode,
  newNodeIdIssue,
  type NodeOntologyListField,
} from "../views/enterprise-tree-edit.ts";
import { parseMcpServerImport, type McpServerImportError } from "./mcp-server-import.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

/** The pending confirmation the Save/Remove modal is asking the operator about. */
export type EnterpriseTreeConfirm = { kind: "save" } | { kind: "remove"; treeId: string };

export type EnterpriseTreeEditFormat = "yaml" | "json";

/** Why a node-add draft was rejected; the view maps each to an i18n message. */
export type EnterpriseNodeDraftError =
  | "id-empty"
  | "id-pattern"
  | "id-duplicate"
  | "title-empty"
  | "parent-missing"
  | "export-failed";

/**
 * An in-progress "add child node" form. Bound to `treeId` so a draft can never be
 * applied to a different tree that happens to share the parent node id (e.g. a
 * root named `root`); `parentId` is the node the child is added under. null when
 * no form is open. On submit the tree is re-exported, spliced, and loaded into the
 * raw editor for review + Save, so node creation reuses enterprise.trees.import.
 */
export type EnterpriseNodeDraft = {
  treeId: string;
  parentId: string;
  id: string;
  title: string;
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
  params: { name: string; server: Record<string, unknown> },
) {
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
  if (draft.editing && JSON.stringify(params.existingServer ?? null) !== draft.editingSnapshot) {
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
  // The registered entry changed under the form. Its stored header would be
  // restored from the latest config while this draft supplies the old URL.
  if (draft.editing && JSON.stringify(params.existingServer ?? null) !== draft.editingSnapshot) {
    fail("entry-changed");
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
  tools: string | null;
  skills: string | null;
  foundations: string | null;
};

export type EnterpriseState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enterpriseLoading: boolean;
  enterpriseRuns: EnterpriseRunSummary[];
  enterpriseTrees: EnterpriseTreeSummary[];
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
  enterpriseTreeEditing: boolean;
  // The id being edited, or null for a brand-new tree — distinguishes create
  // from edit so format switches reseed from the right source.
  enterpriseTreeEditTreeId: string | null;
  // The historical revision being edited, or null when editing the current
  // definition or a new tree — so format switches reseed from history.get.
  enterpriseTreeEditRevision: number | null;
  enterpriseTreeEditContent: string;
  enterpriseTreeEditFormat: EnterpriseTreeEditFormat;
  enterpriseTreeSaving: boolean;
  enterpriseTreeSaveIssues: EnterpriseTreeImportIssue[] | null;
  enterpriseTreeSaveError: string | null;
  enterpriseTreeConfirm: EnterpriseTreeConfirm | null;
  enterpriseTreeVersions: EnterpriseTreeVersionSummary[];
  enterpriseTreeVersionsLoading: boolean;
  // P5 dynamic node creation: the open "add child node" form, or null. Splices a
  // child into the tree definition and reuses the editor's import-to-save flow.
  enterpriseNodeDraft: EnterpriseNodeDraft | null;
  enterpriseBindingPicker: EnterpriseBindingPicker | null;
  /**
   * Unsaved role-prompt edit for one step. Held outside the tree detail because
   * that is a fetched snapshot the reload replaces; a draft has to survive it.
   * Carries its treeId: node ids are only unique WITHIN a tree (roots collide
   * constantly), so without it a draft from tree A would show under — and save
   * into — the same-named step of tree B.
   */
  enterpriseGuidanceDraft: { treeId: string; nodeId: string; text: string } | null;
  /**
   * The one open ontology form. A single slot rather than one per kind: only one
   * can be filled in at a time, and a slot per kind would leave half-typed forms
   * hanging around the inspector after the operator moved on.
   */
  enterpriseOntologyDraft: EnterpriseOntologyDraft | null;
  enterpriseMcpDraft: EnterpriseMcpDraft | null;
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
export async function loadEnterprise(state: EnterpriseState) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++listRequestSeq;
  state.enterpriseLoading = true;
  state.enterpriseError = null;
  try {
    const [runs, trees] = await Promise.all([
      state.client.request<EnterpriseRunsListResult>("enterprise.runs.list", {}),
      state.client.request<EnterpriseTreesListResult>("enterprise.trees.list", {}),
    ]);
    if (requestSeq !== listRequestSeq) {
      return;
    }
    state.enterpriseRuns = runs.runs;
    state.enterpriseTrees = trees.trees;
    state.enterpriseImportErrors = trees.importErrors;
    state.enterpriseStoreError = trees.storeError ?? null;
  } catch (err) {
    if (requestSeq !== listRequestSeq) {
      return;
    }
    applyError(state, err);
  } finally {
    if (requestSeq === listRequestSeq) {
      state.enterpriseLoading = false;
    }
  }
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
  const [tools, skills, foundations] = await Promise.allSettled([
    client.request<ToolsCatalogResult>("tools.catalog", { includePlugins: true }),
    client.request<SkillStatusReport | undefined>("skills.status", {}),
    client.request<EnterpriseKnowledgeFoundationsListResult>(
      "enterprise.knowledge.foundations.list",
      {},
    ),
  ]);
  // A newer load (tab switch, Refresh) supersedes this one; dropping the whole
  // result keeps the three catalogs from mixing two generations.
  if (requestSeq !== catalogRequestSeq) {
    return;
  }
  state.enterpriseToolGroups = tools.status === "fulfilled" ? tools.value.groups : [];
  state.enterpriseSkills = skills.status === "fulfilled" ? (skills.value?.skills ?? []) : [];
  // Both handlers resolve the default agent when none is sent, and both report
  // which one they answered for; keep it so the surfaces can say whose catalog
  // this is instead of implying every agent sees the same tools and skills.
  state.enterpriseCatalogAgentId =
    (tools.status === "fulfilled" ? tools.value.agentId : null) ??
    (skills.status === "fulfilled" ? (skills.value?.agentId ?? null) : null);
  state.enterpriseFoundations =
    foundations.status === "fulfilled" ? foundations.value.foundations : [];
  state.enterpriseCatalogErrors = {
    tools:
      tools.status === "rejected" ? catalogErrorMessage(tools.reason, "the tool catalog") : null,
    skills:
      skills.status === "rejected" ? catalogErrorMessage(skills.reason, "installed skills") : null,
    foundations:
      foundations.status === "rejected"
        ? catalogErrorMessage(foundations.reason, "knowledge foundations")
        : null,
  };
  state.enterpriseCatalogPhase = "ready";
}

// Monotonic token so only the latest detail request wins. The selected id alone
// can't disambiguate two in-flight requests for the SAME run (double click, or
// Refresh while a detail load is pending), and gateway responses can resolve out
// of order, so a bare id check would let an older response overwrite a newer one.
let detailRequestSeq = 0;

/** Fetch one execution's plan + governance trace for the inspector panel. */
/**
 * Static `t()` calls per reason, not one interpolated key: the extractor reads
 * literals, so a computed key ships an untranslated string to every locale.
 */
function resumeRefusalMessage(reason: EnterpriseRunsResumeResult["reason"]): string {
  switch (reason) {
    case "still-running":
      return t("enterprise.resumeRefusedRunning");
    case "no-session":
      return t("enterprise.resumeRefusedNoSession");
    case "no-steps-completed":
      return t("enterprise.resumeRefusedNoSteps");
    case "route-complete":
      return t("enterprise.resumeRefusedRouteComplete");
    case "transcript-rotated":
      return t("enterprise.resumeRefusedRotated");
    default:
      return t("enterprise.resumeRefusedNotFound");
  }
}

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
  if (!state.client || !state.connected || state.enterpriseResuming) {
    return;
  }
  state.enterpriseResuming = true;
  state.enterpriseError = null;
  try {
    const res = await state.client.request<EnterpriseRunsResumeResult>("enterprise.runs.resume", {
      executionId,
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
      return;
    }
    // Every refusal is a state of the run, not a fault, so it reads as a reason
    // rather than a failure.
    state.enterpriseError = resumeRefusalMessage(res.reason);
  } catch (err) {
    applyError(state, err);
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
    state.enterpriseRunTree = live && live.hash === run.treeHash ? live : null;
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
  // A save that imports a NEW tree opens it through this same path, so a node id
  // shared with the prior tree (e.g. "root") must not carry that selection across.
  const previousTreeId = state.enterpriseSelectedTreeId;
  const treeChanged = previousTreeId !== treeId;
  const requestSeq = ++treeRequestSeq;
  state.enterpriseSelectedTreeId = treeId;
  state.enterpriseTreeDetail = null;
  state.enterpriseTreeLoading = true;
  state.enterpriseTreeIssue = null;
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
    if (!treeChanged && authoritative && res.tree) {
      // Same-tree reload (Refresh / re-save): keep the node selection but re-point
      // its instance rows at the freshly loaded ontology so they cannot go stale.
      reconcileNodeSelectionAfterReload(state, res.tree);
    } else {
      clearEnterpriseNodeSelection(state);
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
let treeSaveSeq = 0;

/** Discard any in-progress edit + confirmation without touching the selection. */
function resetTreeEditing(state: EnterpriseState) {
  // Invalidate any in-flight seed so it cannot re-enter edit mode after this.
  editSeedSeq++;
  state.enterpriseTreeEditing = false;
  state.enterpriseTreeEditTreeId = null;
  state.enterpriseTreeEditRevision = null;
  state.enterpriseTreeEditContent = "";
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeConfirm = null;
}

/** Select a tree for the visualizer/editor: cancel edits, load detail + history. */
export function selectEnterpriseTree(state: EnterpriseState, treeId: string) {
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
}

function clearEnterpriseNodeSelection(state: EnterpriseState) {
  clearEnterpriseNodeObjects(state);
  state.enterpriseSelectedNodeId = null;
  // A node-add draft belongs to the selected node in its tree; a tree switch,
  // pruned node, or scope loss (every caller of this) invalidates it, so drop it
  // rather than let a stale form reappear under a same-named node elsewhere.
  state.enterpriseNodeDraft = null;
  // Same for a tool-grant / skill draft: it is bound to one node in one tree.
  state.enterpriseBindingPicker = null;
  // ...and for the role prompt. Unsaved text must not survive a tree switch, a
  // pruned node, or scope loss and then reappear under a same-named node
  // elsewhere — or be silently overwritten by editing a different node.
  state.enterpriseGuidanceDraft = null;
  state.enterpriseOntologyDraft = null;
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
  const nodeId = state.enterpriseSelectedNodeId;
  if (!nodeId) {
    return;
  }
  if (!tree.nodes.some((node) => node.id === nodeId)) {
    clearEnterpriseNodeSelection(state);
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
 */
export function selectEnterpriseNode(state: EnterpriseState, nodeId: string | null) {
  if (!nodeId) {
    clearEnterpriseNodeSelection(state);
    return;
  }
  clearEnterpriseNodeSelection(state);
  state.enterpriseSelectedNodeId = nodeId;
  const tree = state.enterpriseTreeDetail;
  const defaultEntity = tree ? nodeObjectEntityIds(tree, nodeId)[0] : undefined;
  if (defaultEntity) {
    void loadEnterpriseNodeObjects(state, nodeId, defaultEntity);
  }
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
      // Instance load failures are non-fatal to the inspector: leave the type
      // graph up and just show no rows rather than tearing down the panel.
      state.enterpriseNodeObjects = [];
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
    // Otherwise history is auxiliary; a load failure just empties the panel.
    state.enterpriseTreeVersions = [];
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
  result: SeedResult,
) {
  if (seedSeq !== editSeedSeq) {
    return;
  }
  if (!result.ok) {
    // A scope loss already cleared governed data + set the global banner.
    if (!result.scopeCleared) {
      state.enterpriseTreeSaveError = result.reason;
    }
    return;
  }
  state.enterpriseTreeEditFormat = format;
  state.enterpriseTreeEditTreeId = treeId;
  state.enterpriseTreeEditRevision = revision;
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeEditContent = result.content;
  state.enterpriseTreeEditing = true;
}

/** Enter edit mode for the selected tree, seeding the editor from its export. */
export async function beginEditEnterpriseTree(state: EnterpriseState) {
  const treeId = state.enterpriseSelectedTreeId;
  if (!treeId) {
    return;
  }
  const format = state.enterpriseTreeEditFormat;
  const seedSeq = ++editSeedSeq;
  const result = await fetchExportContent(state, treeId, format);
  applyEditorSeed(state, seedSeq, format, treeId, null, result);
}

/** Open the editor on a blank template to import a brand-new tree. */
export function beginNewEnterpriseTree(state: EnterpriseState) {
  // Supersede any in-flight seed so it cannot overwrite the new-tree template.
  editSeedSeq++;
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeEditTreeId = null;
  state.enterpriseTreeEditRevision = null;
  state.enterpriseTreeEditContent = treeTemplate(state.enterpriseTreeEditFormat);
  state.enterpriseTreeEditing = true;
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
  if (!treeId) {
    return;
  }
  state.enterpriseNodeDraft = { treeId, parentId, id: "", title: "", error: null };
}

/** Update the open draft's fields; any prior error clears as the operator edits. */
export function editEnterpriseNodeDraft(
  state: EnterpriseState,
  patch: { id?: string; title?: string },
) {
  const draft = state.enterpriseNodeDraft;
  if (!draft) {
    return;
  }
  state.enterpriseNodeDraft = {
    ...draft,
    ...(patch.id !== undefined ? { id: patch.id } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    error: null,
  };
}

export function cancelAddEnterpriseNode(state: EnterpriseState) {
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
 * Validate the draft, then splice a bare child into the tree's CANONICAL nested
 * definition (re-exported as JSON — the flat detail is lossy and JSON avoids
 * pulling a YAML parser into the UI) and load the result into the raw editor.
 * The operator reviews it and Saves through the existing confirm ->
 * enterprise.trees.import flow, so node creation adds no second write path.
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
  // Claim the editor seed intent: a competing Edit/New/history load started while
  // the export is in flight supersedes this add, and applyEditorSeed re-checks it.
  const seedSeq = ++editSeedSeq;
  const exported = await fetchExportContent(state, tree.id, "json");
  // Every draft mutation (edit/cancel/reopen) REPLACES the object, so an identity
  // check rejects a submit whose form changed during the export — its captured
  // id/title/parent would be stale. The seed token catches a competing editor load.
  if (seedSeq !== editSeedSeq || state.enterpriseNodeDraft !== draft) {
    return;
  }
  if (!exported.ok) {
    // A scope loss already cleared governed data + set the global banner.
    if (!exported.scopeCleared) {
      failNodeDraft(state, draft, "export-failed");
    }
    return;
  }
  const definition = parseTreeDefinition(exported.content);
  if (!definition) {
    failNodeDraft(state, draft, "export-failed");
    return;
  }
  const spliced = insertChildNode(definition, draft.parentId, { id, title });
  if (!spliced.ok) {
    // Lost a race with a concurrent change to the definition since the detail load.
    failNodeDraft(
      state,
      draft,
      spliced.reason === "duplicate-id" ? "id-duplicate" : "parent-missing",
    );
    return;
  }
  state.enterpriseNodeDraft = null;
  applyEditorSeed(state, seedSeq, "json", tree.id, null, {
    ok: true,
    content: `${JSON.stringify(spliced.definition, null, 2)}\n`,
  });
}

/** Open the step-binding form for `field` on `nodeId` in the selected tree. */
export function openEnterpriseBindingPicker(
  state: EnterpriseState,
  nodeId: string,
  field: NodeOntologyListField,
) {
  const treeId = state.enterpriseTreeDetail?.id;
  if (!treeId) {
    return;
  }
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
 * Apply the picked entries to the step and save.
 *
 * Splices every selection into ONE exported definition and imports once, so a
 * multi-entry add is a single revision rather than one per value — and a partial
 * failure cannot leave half the picks written.
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
  let pending: EnterpriseBindingPicker = { ...picker, phase: "preparing", failure: null };
  state.enterpriseBindingPicker = pending;
  // Captured BEFORE the write: the dialog is dismissable while it runs, so the
  // operator can navigate to another tree meanwhile. Reading the selection after
  // the response would record THEIR choice and then undo it.
  const selectedAtStart = state.enterpriseSelectedTreeId;
  // Claim the edit intent, the same token the editor's save path takes. An Edit,
  // history restore, or add-child seed already awaiting its own export would
  // otherwise finish holding a definition from BEFORE this binding, and saving
  // that whole-tree replacement later would silently drop it — re-widening a
  // governance allowlist in the process.
  const editIntent = ++editSeedSeq;
  const settle = (next: EnterpriseBindingPicker | null) => {
    // Only settle the picker this call started: a cancel or a newly opened picker
    // during the await owns the slot now.
    if (state.enterpriseBindingPicker === pending) {
      state.enterpriseBindingPicker = next;
    }
  };
  const exported = await fetchExportContent(state, tree.id, "json");
  if (!exported.ok) {
    settle(
      exported.scopeCleared
        ? null
        : { ...pending, phase: "idle", failure: { kind: "export-failed" } },
    );
    return;
  }
  const definition = parseTreeDefinition(exported.content);
  if (!definition) {
    settle({ ...pending, phase: "idle", failure: { kind: "export-failed" } });
    return;
  }
  // The export awaited. If this picker was dismissed (or replaced) meanwhile, or
  // a newer edit claimed the intent, stop before writing: a later edit on the
  // same tree would otherwise be overwritten by this whole-tree replace built
  // from the older export.
  if (state.enterpriseBindingPicker !== pending || editIntent !== editSeedSeq) {
    return;
  }
  let spliced: EditableTreeDefinition = definition;
  for (const value of values) {
    const result = addNodeOntologyEntry(spliced, picker.nodeId, picker.field, value);
    if (!result.ok) {
      settle({
        ...pending,
        phase: "idle",
        failure: {
          kind: result.reason === "duplicate-entry" ? "entry-duplicate" : "node-missing",
        },
      });
      return;
    }
    spliced = result.definition;
  }
  // Past this point the server has the request, so closing cannot recall it.
  const writing: EnterpriseBindingPicker = { ...pending, phase: "writing" };
  state.enterpriseBindingPicker = writing;
  pending = writing;
  const imported = await importTreeDefinition(state, spliced);
  if (imported.status !== "saved") {
    // The export already succeeded and no editor opens, so "could not load the
    // definition" would point at the wrong step; these say the write failed.
    if (state.enterpriseBindingPicker === pending) {
      settle({ ...pending, phase: "idle", failure: importFailure(imported) });
      return;
    }
    // Closing during the write leaves nothing to settle into, and the dialog said
    // the save would still land, so the failure has to reach the tree's banner.
    // That banner is shared: it hangs beside the SELECTED tree and inside whatever
    // draft the editor holds. An operator who moved on — another tree, or New Tree,
    // which keeps this selection while replacing the draft — would read it as a
    // failure of what is now in front of them, so a superseded write reports
    // nowhere rather than blaming the wrong work-map.
    if (state.enterpriseSelectedTreeId !== picker.treeId || editIntent !== editSeedSeq) {
      return;
    }
    state.enterpriseTreeSaveError = importFailureText(imported);
    return;
  }
  // Close as soon as the WRITE lands, before the reloads. Those are separate
  // requests with no client-side timeout, so keeping the dialog disabled until
  // they answer would let one slow list call hold the whole screen modal — with
  // Cancel and Escape ignored — over a binding that is already saved. Closing
  // here also lets the dialog hand focus back while its trigger still exists.
  settle(null);
  // An earlier export/seed failure left its banner beside the tree; the write
  // that just succeeded makes it stale, and leaving it up reads as this add
  // having failed.
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeSaveIssues = null;
  await refreshAfterTreeWrite(state, imported.treeId, selectedAtStart);
}

/**
 * Detach one entry from a step's binding.
 *
 * Takes the same export→edit→import route as the capability toggle rather than
 * adding a third write path: one whole-tree replace, one revision the version
 * history can restore, and the same edit-intent guard so a concurrent editor
 * save cannot be silently dropped by this one.
 *
 * No dialog. The picker needs one because it collects a selection; a removal is
 * already a specific entry on a specific step, and the revision history is the
 * undo. Widening a governance scope IS what this does, though, so it reports
 * failures on the tree banner rather than failing quietly.
 */
/**
 * An open ontology form, tagged by what it declares.
 *
 * Carries its tree and node for the same reason the role-prompt draft does: ids
 * repeat across trees, so a draft that named only the entity could be applied to
 * the wrong work-map entirely.
 */
export type EnterpriseOntologyDraftBody =
  | { kind: "entity"; nodeId: string; id: string; title: string }
  | {
      kind: "property";
      nodeId: string;
      entityId: string;
      id: string;
      type: OntologyValueTypeName;
      primaryKey: boolean;
    }
  | {
      kind: "relationship";
      nodeId: string;
      id: string;
      from: string;
      to: string;
      cardinality: OntologyCardinalityName;
    }
  // The two AIP verbs. An action is declared bare and then given its effects and
  // parameters, the way an object type is declared and then given properties:
  // each effect has to be checked against what the step can address, so they
  // cannot be collected in one form without guessing.
  | { kind: "action"; nodeId: string; id: string; title: string }
  | {
      kind: "action-effect";
      nodeId: string;
      actionId: string;
      entity: string;
      effectKind: OntologyEffectKindName;
    }
  | {
      kind: "action-parameter";
      nodeId: string;
      actionId: string;
      id: string;
      type: OntologyValueTypeName;
      required: boolean;
    }
  | {
      kind: "function";
      nodeId: string;
      id: string;
      title: string;
      entity: string;
      expression: string;
      returns: OntologyValueTypeName;
    };

/**
 * Spelled as an intersection over the body union, not `Omit<...>`: Omit on a
 * discriminated union collapses it to the keys every member shares, which would
 * lose `entityId`, `from`, and `to` from the callers' view.
 */
/**
 * What an open ontology form can be refused for: every splicer reason, plus the
 * one the controller raises before any splicer runs (a required object type the
 * step has none of). Closed, because the form renders it as
 * `enterprise.ontologyEditor.error.<reason>` and a freeform string would put a
 * raw key on screen.
 */
export type EnterpriseOntologyDraftError = OntologyEditReason | "endpoint-missing";

export type EnterpriseOntologyDraft = EnterpriseOntologyDraftBody & {
  treeId: string;
  error: EnterpriseOntologyDraftError | null;
};

/** Open an ontology form on the selected step, replacing any other open one. */
export function beginEnterpriseOntologyDraft(
  state: EnterpriseState,
  draft: EnterpriseOntologyDraftBody,
) {
  const treeId = state.enterpriseTreeDetail?.id;
  if (!treeId) {
    return;
  }
  state.enterpriseOntologyDraft = { ...draft, treeId, error: null };
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
  // An effect names an object type and a verb, not an id of its own, so the id
  // gate below would refuse every one of them.
  const id = draft.kind === "action-effect" ? "" : draft.id.trim().toLowerCase();
  if (draft.kind !== "action-effect" && !isValidEnterpriseId(id)) {
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
  const saved = await applyEnterpriseTreeEdit(
    state,
    (definition) => {
      if (draft.kind === "entity") {
        const title = draft.title.trim();
        return addNodeOntologyEntity(definition, draft.nodeId, {
          id,
          ...(title ? { title } : {}),
        });
      }
      if (draft.kind === "property") {
        return addNodeOntologyProperty(definition, draft.nodeId, draft.entityId, {
          id,
          type: draft.type,
          ...(draft.primaryKey ? { primaryKey: true } : {}),
        });
      }
      if (draft.kind === "relationship") {
        return addNodeOntologyRelationship(definition, draft.nodeId, {
          id,
          from: draft.from,
          to: draft.to,
          cardinality: draft.cardinality,
        });
      }
      if (draft.kind === "action") {
        const title = draft.title.trim();
        return addNodeOntologyAction(definition, draft.nodeId, {
          id,
          ...(title ? { title } : {}),
        });
      }
      if (draft.kind === "action-effect") {
        return addNodeOntologyActionEffect(definition, draft.nodeId, draft.actionId, {
          entity: draft.entity,
          kind: draft.effectKind,
        });
      }
      if (draft.kind === "action-parameter") {
        return addNodeOntologyActionParameter(definition, draft.nodeId, draft.actionId, {
          id,
          type: draft.type,
          ...(draft.required ? { required: true } : {}),
        });
      }
      const functionTitle = draft.title.trim();
      return addNodeOntologyFunction(definition, draft.nodeId, {
        id,
        ...(functionTitle ? { title: functionTitle } : {}),
        entity: draft.entity,
        expression: draft.expression,
        returns: draft.returns,
      });
    },
    // Refusals belong ON the form: the operator is mid-typing and the fix is the
    // field in front of them, not a banner beside the tree.
    (reason) => {
      if (state.enterpriseOntologyDraft === draft) {
        state.enterpriseOntologyDraft = { ...draft, error: reason ?? "invalid-id" };
      }
    },
  );
  // Closed only on success: a duplicate id or a vanished endpoint should leave
  // the operator's typing in front of them, not discard it.
  if (saved && state.enterpriseOntologyDraft === draft) {
    state.enterpriseOntologyDraft = null;
  }
}

/** Start or update the role-prompt draft for one step. */
export function editEnterpriseNodeGuidance(state: EnterpriseState, nodeId: string, text: string) {
  const treeId = state.enterpriseTreeDetail?.id;
  if (!treeId) {
    return;
  }
  state.enterpriseGuidanceDraft = { treeId, nodeId, text };
}

/** Discard the draft, reverting the field to whatever the tree has saved. */
export function cancelEnterpriseNodeGuidance(state: EnterpriseState) {
  state.enterpriseGuidanceDraft = null;
}

/**
 * Save a step's role prompt.
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
  const treeId = tree.id;
  const text = draft.text.trim();
  const saved = await applyEnterpriseTreeEdit(state, (definition) =>
    setNodeGuidance(definition, nodeId, text),
  );
  if (!saved) {
    return;
  }
  // Only after the reload the helper already awaited: the draft IS what the
  // textarea shows, so dropping it earlier snaps the field back to the pre-save
  // snapshot — and if that reload failed, the stale text would sit there inviting
  // an overwrite of a save that already landed. Guarded so a draft the operator
  // started elsewhere meanwhile is not discarded.
  if (
    state.enterpriseGuidanceDraft?.treeId === treeId &&
    state.enterpriseGuidanceDraft.nodeId === nodeId &&
    state.enterpriseGuidanceDraft.text.trim() === text
  ) {
    state.enterpriseGuidanceDraft = null;
  }
}

/**
 * Run one edit against the tree's canonical definition and save the result.
 *
 * Every per-node write takes this path — detach, role prompt, ontology — so the
 * export→edit→import dance, the supersession rules, and the shared write lock
 * exist once instead of once per action. Each call lands as a single whole-tree
 * revision the version history can restore.
 *
 * Returns whether the write was saved, so a caller with follow-up state (a draft
 * to clear, say) can act only on success.
 */
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

async function applyEnterpriseTreeEdit(
  state: EnterpriseState,
  edit: (
    definition: EditableTreeDefinition,
  ) =>
    | { ok: true; definition: EditableTreeDefinition }
    | { ok: false; reason?: OntologyEditReason },
  /**
   * Where a REFUSED edit reports. Without one it falls back to the tree banner,
   * which is right for a removal button but wrong for an open form.
   */
  onRefused?: (reason: OntologyEditReason | undefined) => void,
): Promise<boolean> {
  const tree = state.enterpriseTreeDetail;
  if (!tree || state.enterpriseTreeSaving) {
    return false;
  }
  const treeId = tree.id;
  const editIntent = ++editSeedSeq;
  const saveToken = ++treeSaveSeq;
  state.enterpriseTreeSaving = true;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeSaveIssues = null;
  // Released exactly once, and only while this write still owns the flag: a
  // superseded writer must not unlock the newer one, and a non-writer intent
  // must never strand it (which is why this is not keyed on editSeedSeq).
  const releaseLock = () => {
    if (saveToken === treeSaveSeq) {
      state.enterpriseTreeSaving = false;
    }
  };
  try {
    const exported = await fetchExportContent(state, treeId, "json");
    // The export awaited, so the operator may have moved on. A failure belongs to
    // the tree it was read for; writing it now would blame whatever is on screen.
    const stillOnThisTree = () =>
      editIntent === editSeedSeq && state.enterpriseSelectedTreeId === treeId;
    if (!exported.ok) {
      if (!exported.scopeCleared && stillOnThisTree()) {
        state.enterpriseTreeSaveError = t("enterprise.entryDraft.exportFailed");
      }
      return false;
    }
    const definition = parseTreeDefinition(exported.content);
    if (!definition) {
      if (stillOnThisTree()) {
        state.enterpriseTreeSaveError = t("enterprise.entryDraft.exportFailed");
      }
      return false;
    }
    // A newer edit claimed the intent while the export was in flight; writing this
    // whole-tree replace now would undo it.
    if (editIntent !== editSeedSeq) {
      return false;
    }
    const result = edit(definition);
    if (!result.ok) {
      // Two different failures wear the same shape here. A missing node or entry
      // means the screen is behind, so reload. Anything else is the edit itself
      // being refused — a duplicate id, a key already taken, a type still linked
      // — and reloading would make the button look dead.
      // `entity-not-found` counts as stale ONLY for a caller with no form to
      // report into: another editor can remove the object type between this
      // screen's snapshot and the export, so a removal button is simply behind.
      // For the ontology form it is a real refusal — an endpoint out of scope —
      // and belongs next to the field the operator chose it in.
      const stale =
        (result.reason !== undefined &&
          (STALE_EDIT_REASONS as readonly (OntologyEditReason | undefined)[]).includes(
            result.reason,
          )) ||
        (result.reason === "entity-not-found" && !onRefused);
      if (stale) {
        await refreshAfterTreeWrite(state, treeId, treeId);
        return false;
      }
      releaseLock();
      if (onRefused) {
        onRefused(result.reason);
      } else if (stillOnThisTree()) {
        state.enterpriseTreeSaveError = t(`enterprise.ontologyEditor.error.${result.reason}`);
      }
      return false;
    }
    const imported = await importTreeDefinition(state, result.definition);
    if (imported.status !== "saved") {
      // The operator navigated while this was in flight; its failure belongs to
      // the tree it was written against, not to whatever is on screen now.
      if (editIntent !== editSeedSeq || state.enterpriseSelectedTreeId !== treeId) {
        return false;
      }
      state.enterpriseTreeSaveError = importFailureText(imported);
      return false;
    }
    // The write landed. Release before the reloads: those are separate requests
    // with no client-side timeout, and holding the lock would leave every
    // per-node control disabled over a save that already succeeded.
    releaseLock();
    // The write landed; whether the RELOAD did is a separate question, and only
    // the refresh itself can answer it — the stale detail carries the same id.
    return await refreshAfterTreeWrite(state, imported.treeId ?? treeId, treeId);
  } finally {
    releaseLock();
  }
}

export async function removeEnterpriseBinding(
  state: EnterpriseState,
  params: { nodeId: string; field: NodeOntologyListField; entry: string },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyEntry(definition, params.nodeId, params.field, params.entry),
  );
}

/** Declare an ontology object type on a step. */
export async function addEnterpriseOntologyEntity(
  state: EnterpriseState,
  params: { nodeId: string; id: string; title?: string },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    addNodeOntologyEntity(definition, params.nodeId, {
      id: params.id,
      ...(params.title ? { title: params.title } : {}),
    }),
  );
}

export async function removeEnterpriseOntologyEntity(
  state: EnterpriseState,
  params: { nodeId: string; entityId: string },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyEntity(definition, params.nodeId, params.entityId),
  );
}

export async function addEnterpriseOntologyProperty(
  state: EnterpriseState,
  params: {
    nodeId: string;
    entityId: string;
    id: string;
    type: OntologyValueTypeName;
    primaryKey?: boolean;
  },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    addNodeOntologyProperty(definition, params.nodeId, params.entityId, {
      id: params.id,
      type: params.type,
      ...(params.primaryKey ? { primaryKey: true } : {}),
    }),
  );
}

export async function removeEnterpriseOntologyProperty(
  state: EnterpriseState,
  params: { nodeId: string; entityId: string; propertyId: string },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyProperty(definition, params.nodeId, params.entityId, params.propertyId),
  );
}

export async function addEnterpriseOntologyRelationship(
  state: EnterpriseState,
  params: {
    nodeId: string;
    id: string;
    from: string;
    to: string;
    cardinality?: OntologyCardinalityName;
  },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    addNodeOntologyRelationship(definition, params.nodeId, {
      id: params.id,
      from: params.from,
      to: params.to,
      ...(params.cardinality ? { cardinality: params.cardinality } : {}),
    }),
  );
}

export async function removeEnterpriseOntologyRelationship(
  state: EnterpriseState,
  params: { nodeId: string; link: { id: string; from: string; to: string } },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyRelationship(definition, params.nodeId, params.link),
  );
}

export async function removeEnterpriseOntologyAction(
  state: EnterpriseState,
  params: { nodeId: string; actionId: string },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyAction(definition, params.nodeId, params.actionId),
  );
}

export async function removeEnterpriseOntologyActionEffect(
  state: EnterpriseState,
  params: { nodeId: string; actionId: string; entity: string; kind: OntologyEffectKindName },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyActionEffect(definition, params.nodeId, params.actionId, {
      entity: params.entity,
      kind: params.kind,
    }),
  );
}

export async function removeEnterpriseOntologyActionParameter(
  state: EnterpriseState,
  params: { nodeId: string; actionId: string; parameterId: string },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyActionParameter(
      definition,
      params.nodeId,
      params.actionId,
      params.parameterId,
    ),
  );
}

export async function removeEnterpriseOntologyFunction(
  state: EnterpriseState,
  params: { nodeId: string; functionId: string },
) {
  await applyEnterpriseTreeEdit(state, (definition) =>
    removeNodeOntologyFunction(definition, params.nodeId, params.functionId),
  );
}

/**
 * Turn the selected work-map's explicit capability grants on or off.
 *
 * The flag lives on the DEFINITION, so this takes the same export→edit→import
 * route the binding picker takes rather than adding a second write path: one
 * whole-tree replace, one revision, and the same edit-intent guard so a
 * concurrent editor save cannot be silently dropped by this one.
 *
 * Turning it on narrows every step at once — a step that lists no tools stops
 * reaching any — so the button says which direction it goes and the write lands
 * as an ordinary revision the version history can restore.
 */
export async function toggleEnterpriseCapabilityGrants(state: EnterpriseState) {
  const tree = state.enterpriseTreeDetail;
  if (!tree || state.enterpriseTreeSaving) {
    return;
  }
  const treeId = tree.id;
  const next = tree.capabilityGrants === "explicit" ? undefined : "explicit";
  const editIntent = ++editSeedSeq;
  const saveToken = ++treeSaveSeq;
  state.enterpriseTreeSaving = true;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeSaveIssues = null;
  try {
    const exported = await fetchExportContent(state, treeId, "json");
    // The export awaited, so the operator may have moved on. A failure belongs to
    // the tree it was read for; writing it now would blame whatever is on screen.
    const stillOnThisTree = () =>
      editIntent === editSeedSeq && state.enterpriseSelectedTreeId === treeId;
    if (!exported.ok) {
      if (!exported.scopeCleared && stillOnThisTree()) {
        state.enterpriseTreeSaveError = t("enterprise.entryDraft.exportFailed");
      }
      return;
    }
    const definition = parseTreeDefinition(exported.content);
    if (!definition) {
      if (stillOnThisTree()) {
        state.enterpriseTreeSaveError = t("enterprise.entryDraft.exportFailed");
      }
      return;
    }
    // A newer edit claimed the intent while the export was in flight; writing this
    // whole-tree replace now would undo it.
    if (editIntent !== editSeedSeq) {
      return;
    }
    // Removed rather than set to a second value: the schema accepts one, and
    // absence IS the inherited mode. Leaving a key behind would make "off" look
    // like a mode the definition declares.
    const { capabilityGrants: _dropped, ...rest } = definition;
    const patched: EditableTreeDefinition = next ? { ...rest, capabilityGrants: next } : rest;
    const imported = await importTreeDefinition(state, patched);
    if (imported.status !== "saved") {
      state.enterpriseTreeSaveError = importFailureText(imported);
      return;
    }
    await refreshAfterTreeWrite(state, imported.treeId ?? treeId, treeId);
  } finally {
    // Same ownership check: a superseded call must not release a newer one's lock.
    if (saveToken === treeSaveSeq) {
      state.enterpriseTreeSaving = false;
    }
  }
}

/** Why the apply stopped, in the shape the dialog renders. */
function importFailure(
  outcome: Exclude<TreeImportOutcome, { status: "saved" }>,
): EnterpriseBindingPickerFailure {
  if (outcome.status === "rejected") {
    return { kind: "import-rejected", issues: outcome.issues };
  }
  if (outcome.status === "refused") {
    return { kind: "import-refused", message: outcome.message };
  }
  return { kind: outcome.status === "not-sent" ? "import-not-sent" : "import-failed" };
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

/**
 * Write one edited definition through enterprise.trees.import and refresh what it
 * invalidates. Shared by the binding picker so a direct apply reuses the editor's
 * write path instead of adding a second one.
 */
async function importTreeDefinition(
  state: EnterpriseState,
  definition: EditableTreeDefinition,
): Promise<TreeImportOutcome> {
  if (!state.client || !state.connected) {
    return { status: "not-sent" };
  }
  try {
    const res = await state.client.request<EnterpriseTreesImportResult>("enterprise.trees.import", {
      content: `${JSON.stringify(definition, null, 2)}\n`,
      format: "json",
    });
    if (!res.ok) {
      return { status: "rejected", issues: res.issues ?? [] };
    }
    const treeId = res.treeId ?? definition.id;
    return { status: "saved", ...(typeof treeId === "string" && treeId ? { treeId } : {}) };
  } catch (error) {
    // GatewayBrowserClient rejects before ws.send when the socket is not open,
    // and answers an error frame with GatewayRequestError. Both mean the tree was
    // not written. Anything else is a pending request flushed by a close AFTER
    // the frame went out, which the server may still have applied.
    if (error instanceof GatewayNotConnectedError) {
      return { status: "not-sent" };
    }
    if (error instanceof GatewayRequestError) {
      return { status: "refused", message: error.message };
    }
    return { status: "unknown" };
  }
}

/** Reload what a whole-tree replace invalidates. Runs after the write settles. */
/**
 * Reload the registry and the written tree after a successful import.
 *
 * Returns whether the DETAIL on screen is authoritative afterwards. A caller
 * holding unsaved state may only discard it on `true`: a failed list reload, or
 * navigation mid-flight, leaves the pre-save snapshot in place, and clearing a
 * draft against that would make the saved change appear to vanish — and invite a
 * retry from stale content.
 */
async function refreshAfterTreeWrite(
  state: EnterpriseState,
  treeId: string | undefined,
  /** What was selected when the write STARTED; navigation since then wins. */
  selectedAtWrite: string | null,
): Promise<boolean> {
  // An import rebuilds the server's bundle knowledge registry, so the catalogs
  // this screen suggests from are stale until reloaded.
  void loadEnterpriseCatalogs(state);
  // Editing a BUILT-IN tree creates an imported override, so the registry list
  // still says `source: "builtin"` (and still shows any now-resolved import or
  // store error) until it is reloaded.
  await loadEnterprise(state);
  // A failed list reload set the banner; opening the saved tree would clear
  // enterpriseError at request start and present stale lists as current.
  if (state.enterpriseError || !treeId || state.enterpriseSelectedTreeId !== selectedAtWrite) {
    return false;
  }
  await loadEnterpriseTreeDetail(state, treeId);
  // The detail load awaited, so the operator can select another tree meanwhile.
  // Its history request would win the sequence and overwrite the new selection.
  if (state.enterpriseSelectedTreeId !== treeId) {
    return false;
  }
  // Only now is what the screen shows the post-write server copy.
  // `enterpriseTreeIssue` is what a failed detail load leaves behind, so a stale
  // snapshot with the right id does not pass for a fresh one.
  const reloaded = state.enterpriseTreeDetail?.id === treeId && !state.enterpriseTreeIssue;
  await loadEnterpriseTreeVersions(state, treeId);
  return reloaded;
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
  const seedSeq = ++editSeedSeq;
  const result =
    revision === null
      ? await fetchExportContent(state, editTreeId, format)
      : await fetchHistoryContent(state, editTreeId, revision, format);
  applyEditorSeed(state, seedSeq, format, editTreeId, revision, result);
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
  const format = state.enterpriseTreeEditFormat;
  const seedSeq = ++editSeedSeq;
  const result = await fetchHistoryContent(state, treeId, revision, format);
  applyEditorSeed(state, seedSeq, format, treeId, revision, result);
}

/** Ask the confirmation modal before persisting the current edit. */
export function requestSaveEnterpriseTree(state: EnterpriseState) {
  state.enterpriseTreeConfirm = { kind: "save" };
}

/** Ask the confirmation modal before removing an imported tree. */
export function requestRemoveEnterpriseTree(state: EnterpriseState, treeId: string) {
  state.enterpriseTreeConfirm = { kind: "remove", treeId };
}

export function cancelEnterpriseTreeConfirm(state: EnterpriseState) {
  state.enterpriseTreeConfirm = null;
}

/** Resolve the open confirmation: persist the edit or remove the tree. */
export async function confirmEnterpriseTreeAction(state: EnterpriseState) {
  const confirm = state.enterpriseTreeConfirm;
  if (!confirm) {
    return;
  }
  state.enterpriseTreeConfirm = null;
  if (confirm.kind === "save") {
    await saveEnterpriseTree(state);
  } else {
    await removeEnterpriseTree(state, confirm.treeId);
  }
}

async function saveEnterpriseTree(state: EnterpriseState) {
  if (!state.client || !state.connected) {
    return;
  }
  // Invalidate any in-flight format/history reseed so a late applyEditorSeed
  // cannot swap the textarea content out from under the submitted draft; the
  // resulting token is the edit intent. The tree list / New Tree controls stay
  // usable while the import is in flight, so if the operator moves on we must not
  // clobber that newer editor/selection with this older save's result.
  const editIntent = ++editSeedSeq;
  const superseded = () => editIntent !== editSeedSeq;
  state.enterpriseTreeSaving = true;
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  try {
    const res = await state.client.request<EnterpriseTreesImportResult>("enterprise.trees.import", {
      content: state.enterpriseTreeEditContent,
      format: state.enterpriseTreeEditFormat,
    });
    if (!res.ok) {
      // Schema-invalid content: keep the editor open with the issues shown, but
      // only if the operator is still on the same draft.
      if (!superseded()) {
        state.enterpriseTreeSaveIssues = res.issues ?? [];
      }
      return;
    }
    if (superseded()) {
      // The operator started a different selection/draft; the tree is still
      // saved, so just refresh the registry list in the background.
      await loadEnterprise(state);
      void loadEnterpriseCatalogs(state);
      return;
    }
    // resetTreeEditing bumps editSeedSeq; capture a fresh intent to detect the
    // operator moving on during the awaited registry reload below.
    resetTreeEditing(state);
    const openIntent = editSeedSeq;
    // A new tree can change the registry list; reload it, then open the saved tree.
    await loadEnterprise(state);
    // An import rebuilds the server's bundle knowledge registry (a tree that drops
    // its last reference to a bundled foundation prunes it), so the foundation
    // catalog this screen suggests from is stale until reloaded. Fire-and-forget:
    // it is reference data, and its own token drops a superseded response.
    void loadEnterpriseCatalogs(state);
    // A failed list reload set the banner; opening the saved tree would clear
    // enterpriseError at request start and hide that failure with stale lists.
    if (state.enterpriseError) {
      return;
    }
    if (openIntent !== editSeedSeq) {
      // A selection/draft started during the reload must win over the saved tree.
      return;
    }
    if (res.treeId) {
      await loadEnterpriseTreeDetail(state, res.treeId);
      await loadEnterpriseTreeVersions(state, res.treeId);
    }
  } catch (err) {
    if (!superseded()) {
      state.enterpriseTreeSaveError = String(err);
    }
  } finally {
    state.enterpriseTreeSaving = false;
  }
}

async function removeEnterpriseTree(state: EnterpriseState, treeId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<EnterpriseTreesRemoveResult>("enterprise.trees.remove", {
      treeId,
    });
    // Recompute AFTER the await: removal can come from the import-error banner
    // for a different tree, and the operator may have selected another tree or
    // started a draft while this was in flight — only touch the editor/selection
    // when they still belong to the removed id, or newer work would be discarded.
    const affectsCurrent = state.enterpriseSelectedTreeId === treeId;
    if (!res.removed) {
      // Nothing was deleted (built-in or already-gone id); report it without
      // pretending it succeeded, on whichever surface triggered the removal.
      const message = `no imported tree "${treeId}" to remove`;
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
      state.enterpriseTreeVersions = [];
    }
    await loadEnterprise(state);
    // Removing a tree drops the bundle foundations it owned; reload so the
    // catalog stops offering ids nothing can retrieve anymore.
    void loadEnterpriseCatalogs(state);
  } catch (err) {
    state.enterpriseError = String(err);
  }
}

/** Export a tree in `format` and trigger a browser download of the artifact. */
export async function exportEnterpriseTree(
  state: EnterpriseState,
  treeId: string,
  format: EnterpriseTreeEditFormat,
) {
  const result = await fetchExportContent(state, treeId, format);
  if (!result.ok) {
    if (!result.scopeCleared) {
      state.enterpriseTreeSaveError = result.reason;
    }
    return;
  }
  // A prior failed export may have left an error banner; a successful retry
  // must clear it before the download.
  state.enterpriseTreeSaveError = null;
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
  await loadEnterprise(state);
  // If the list/tree refresh failed, keep its error banner; a following detail
  // reload would clear enterpriseError and hide the stale-list failure. (An auth
  // failure also clears the selection, so the guards below would skip anyway.)
  if (state.enterpriseError) {
    return;
  }
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
    await loadEnterpriseTreeVersions(state, selectedTree);
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
    state.enterpriseTreeVersions = [];
    state.enterpriseTreeVersionsLoading = false;
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
