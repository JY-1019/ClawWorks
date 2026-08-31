// Control UI controller parses pasted MCP server JSON into config entries.
import { McpServerSchema } from "../../../../src/config/zod-schema.mcp-server.js";

//
// Vendors publish MCP servers as a JSON snippet, and every ecosystem wraps the
// same server objects in a different envelope. Retyping one into the field form
// is where an operator drops an argument or an env var, so the registration form
// accepts the snippet itself and this module decides what it registers.

/** One server the snippet registers, ready to write under `mcp.servers`. */
export type ParsedMcpServerEntry = {
  name: string;
  server: Record<string, unknown>;
  /** How it launches, for the preview: the operator confirms before writing. */
  launch: string;
  /**
   * Transport this import DECIDED rather than read, or null when the snippet
   * said so itself. Surfaced in the preview because it is the one field the
   * paste did not contain.
   */
  assumedTransport: string | null;
};

export type McpServerImportError =
  | "json-empty"
  | "json-invalid"
  | "json-not-servers"
  | "json-no-servers"
  | "json-name-unsupported"
  | "json-entry-not-object"
  | "json-entry-launchless"
  | "json-entry-url-invalid"
  | "json-entry-transport-invalid"
  | "json-entry-transport-conflict"
  | "json-entry-name-blank"
  | "json-entry-name-duplicate"
  | "json-entry-alias-unknown"
  | "json-entry-field-invalid"
  | "json-entry-header-invalid"
  | "json-entry-redacted";

export type ParsedMcpServerImport =
  | { kind: "ok"; entries: ParsedMcpServerEntry[] }
  | { kind: McpServerImportError; detail?: string };

/**
 * The gateway's redaction placeholder. A snippet carrying one was copied out of
 * a redacted config, and under a NEW server name there is no stored secret to
 * match it back to — the gateway refuses the unmatched sentinel, so an import
 * that accepted it would close the form and fail at Save with nothing to fix.
 */
const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/** Does any value in this entry carry the placeholder? */
function carriesRedactionSentinel(value: unknown): boolean {
  if (typeof value === "string") {
    return value === REDACTED_SENTINEL;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => carriesRedactionSentinel(entry));
  }
  const record = asRecord(value);
  return record ? Object.values(record).some((entry) => carriesRedactionSentinel(entry)) : false;
}

/** Names the config form's path writer refuses, so an import must refuse them first. */
const UNWRITABLE_SERVER_NAMES = new Set(["__proto__", "prototype", "constructor"]);

/**
 * `type` is the field most vendor snippets carry; OpenClaw's canonical field is
 * `transport`. Mirrors CLI_MCP_TYPE_TO_OPENCLAW_TRANSPORT in
 * src/config/mcp-config-normalize.ts, which is what `openclaw mcp add` writes —
 * an import that left the alias in place would store an entry that only some
 * readers resolve.
 */
const TRANSPORT_ALIASES: Record<string, string> = {
  http: "streamable-http",
  "streamable-http": "streamable-http",
  sse: "sse",
  stdio: "stdio",
};

/**
 * What a URL-only entry means. A snippet that names neither `transport` nor
 * `type` is not ambiguous to its author — current MCP docs mean streamable
 * HTTP — but it IS ambiguous to OpenClaw: the embedded runtime resolves an
 * unset transport as SSE while Codex reads a bare URL as streamable HTTP, so
 * one entry would dial two different servers. The import decides once, and the
 * preview says it decided.
 */
const ASSUMED_HTTP_TRANSPORT = "streamable-http";

/** The transports the runtime can dial over HTTP; anything else is not a server. */
const HTTP_TRANSPORTS = new Set(["streamable-http", "sse"]);

/** MCP over HTTP means http(s); the config schema rejects anything else at save. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The map of servers inside a snippet, whatever wrapped it. Every known
 * envelope holds the same server objects, so unwrapping here keeps the entry
 * normalizer from caring which tool the operator copied from.
 */
function unwrapServerMap(root: Record<string, unknown>): Record<string, unknown> | null {
  // `mcpServers` (Claude Desktop and most vendor docs) and `servers` (VS Code)
  // are checked before the OpenClaw shape so a snippet carrying both — a full
  // config file — still resolves to the block an operator meant to paste.
  const mcpServers = asRecord(root.mcpServers);
  if (mcpServers) {
    return mcpServers;
  }
  const servers = asRecord(root.servers);
  if (servers) {
    return servers;
  }
  const openclawServers = asRecord(asRecord(root.mcp)?.servers);
  if (openclawServers) {
    return openclawServers;
  }
  // A bare `{ "<name>": { ... } }` map, which is what a vendor README often
  // shows once the surrounding config is trimmed off. Only accepted when every
  // value is an object, so a stray settings file is reported as "not servers"
  // rather than silently registering its top-level keys as MCP servers.
  const values = Object.values(root);
  return values.length > 0 && values.every((value) => asRecord(value) !== null) ? root : null;
}

/**
 * HTTP field-name grammar (RFC 9110 token), mirroring the typed registration
 * form. The config schema accepts any string key, but the MCP SDK builds a
 * `Headers` from this map and throws on an invalid name — so an import that
 * skipped this would save cleanly and then refuse to connect, with nothing on
 * the screen pointing at the cause.
 */
const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Header names the map cannot carry unambiguously, matching the typed form. */
function hasInvalidHeaderNames(value: unknown): boolean {
  const headers = asRecord(value);
  if (!headers) {
    return false;
  }
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    if (!HTTP_FIELD_NAME.test(name)) {
      return true;
    }
    // Case-insensitive, because `Authorization` and `authorization` are ONE
    // header in two keys: whichever survives is ambiguous, so the typed form
    // refuses the pair and an import must too.
    if (seen.has(name.toLowerCase())) {
      return true;
    }
    seen.add(name.toLowerCase());
  }
  return false;
}

/**
 * The refusal when this entry is not one `mcp.servers` accepts, or null.
 *
 * Checked against the SCHEMA the config save uses rather than a hand-listed
 * subset: an unchecked field (`enabled: "false"`, `auth: "none"`, an OAuth block
 * with unsupported keys) would close this form and then refuse to publish, and
 * the typed editor does not render those fields for the operator to repair.
 *
 * Run on the FINAL shape, after the transport has been normalized and the other
 * launch shape's fields dropped — those rewrites are what make an otherwise
 * valid vendor snippet acceptable.
 */
function schemaRefusal(
  name: string,
  server: Record<string, unknown>,
): { kind: McpServerImportError; detail: string } | null {
  return McpServerSchema.safeParse(server).success
    ? null
    : { kind: "json-entry-field-invalid", detail: name };
}

/** Scalars the config schema accepts, stringified the way the runtime does. */
function stringifyScalarRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      typeof entry === "number" || typeof entry === "boolean" ? String(entry) : entry,
    ]),
  );
}

/**
 * One snippet entry as a config server, or why it cannot be one.
 *
 * Unknown keys travel through untouched: `mcp.servers.*` accepts them, and a
 * vendor snippet's `cwd`, `headers`, `toolFilter`, or OAuth block is exactly
 * what the operator pasted it for. Only the transport is normalized.
 */
function normalizeEntry(
  rawName: string,
  value: unknown,
): { kind: "ok"; entry: ParsedMcpServerEntry } | { kind: McpServerImportError; detail: string } {
  // Trimmed and required, matching what `openclaw mcp add` writes
  // (setConfiguredMcpServer in src/config/mcp-config.ts). An untrimmed key would
  // register a server the CLI and the Enterprise attachment schema — both of
  // which trim, and reject blanks — could never name again.
  const name = rawName.trim();
  if (!name) {
    return { kind: "json-entry-name-blank", detail: rawName };
  }
  const record = asRecord(value);
  if (!record) {
    return { kind: "json-entry-not-object", detail: name };
  }
  if (UNWRITABLE_SERVER_NAMES.has(name)) {
    return { kind: "json-name-unsupported", detail: name };
  }
  const server: Record<string, unknown> = { ...record };
  // Scalars first, so a numeric header or env value is normalized BEFORE the
  // schema sees it: both are schema-valid, and both are dropped by the Codex
  // projection's string-only normalizers (src/agents/codex-mcp-config.ts,
  // src/agents/cli-runner/bundle-mcp-adapter-shared.ts) while embedded MCP
  // stringifies them — so leaving them scalar makes one entry behave two ways.
  for (const key of ["env", "headers"] as const) {
    const normalized = stringifyScalarRecord(server[key]);
    if (normalized) {
      server[key] = normalized;
    }
  }
  if (hasInvalidHeaderNames(server.headers)) {
    return { kind: "json-entry-header-invalid", detail: name };
  }
  if (carriesRedactionSentinel(server)) {
    return { kind: "json-entry-redacted", detail: name };
  }
  const aliasRaw = trimmedString(server.type)?.toLowerCase();
  // Own-property only: a pasted `"type": "constructor"` would otherwise find an
  // inherited function, read as a valid alias, and dial a transport the snippet
  // never declared.
  const alias =
    aliasRaw && Object.hasOwn(TRANSPORT_ALIASES, aliasRaw)
      ? TRANSPORT_ALIASES[aliasRaw]
      : undefined;
  // An alias nothing maps — `websocket`, a typo — cannot be silently dropped or
  // assumed past. OpenClaw would use the assumed transport while the CLI
  // projection gives `type` precedence, so one entry would be forwarded as an
  // unsupported configuration.
  if (aliasRaw && !alias) {
    return { kind: "json-entry-alias-unknown", detail: name };
  }
  if (alias && trimmedString(server.transport) === null) {
    server.transport = alias;
  }
  if (alias || server.type !== undefined) {
    // Dropped once it has been read. Blank values go too: toCliBundleMcpServerConfig
    // treats ANY string-valued `type` as authoritative and strips `transport`
    // (src/agents/bundle-mcp-config.ts), so an empty one would leave CLI-backed
    // agents with no transport at all.
    delete server.type;
  }
  // Fields that belong to the OTHER launch shape. OpenClaw quietly picks one
  // and ignores the rest, but Codex rejects the entry outright
  // (../codex/codex-rs/config/src/mcp_types.rs), so a snippet carrying both
  // would register here and then fail to load on a Codex-backed run.
  const stdioOnly = ["args", "env", "cwd", "workingDirectory"];
  const httpOnly = ["url", "headers", "oauth"];
  // "Carries a value" — a present-but-blank string is not a launch field, it is
  // noise the snippet happens to include, and deleting it is enough.
  const carries = (key: string) => {
    const field = server[key];
    if (field === undefined || field === null) {
      return false;
    }
    return typeof field === "string" ? field.trim().length > 0 : true;
  };
  const command = trimmedString(server.command);
  if (command && httpOnly.some(carries)) {
    return { kind: "json-entry-transport-conflict", detail: name };
  }
  if (!command && stdioOnly.some(carries)) {
    return { kind: "json-entry-transport-conflict", detail: name };
  }
  if (command) {
    // A command-bearing entry is stdio however it is labelled, matching
    // resolveMcpTransportConfig in src/agents/mcp-transport-config.ts. EVERY
    // transport label goes, not just a literal `stdio`: an HTTP one left here
    // is forwarded by toCliBundleMcpServerConfig as an HTTP server with no URL.
    delete server.transport;
    delete server.type;
    // Symmetric: a blank `url` beside a real command is the same rejected pair.
    delete server.url;
    // The VALIDATED command, not the snippet's raw string. Validation, the
    // preview, and `launch` all use the trimmed form, while
    // resolveStdioMcpServerLaunchConfig spawns whatever is stored — so a snippet
    // carrying `" npx "` would preview as `npx` and then fail to spawn.
    server.command = command;
    // `workingDirectory` is an alias the EMBEDDED resolver understands
    // (src/agents/mcp-stdio.ts) and the Codex projection does not: it copies
    // `server.cwd` alone (src/agents/cli-runner/bundle-mcp-adapter-shared.ts) and
    // Codex's RawMcpServerConfig declares only `cwd`
    // (../codex/codex-rs/config/src/mcp_types.rs). Left as the alias, the same
    // imported server would start in the wrong directory on a Codex-backed step.
    const workingDirectory = trimmedString(server.workingDirectory);
    if (workingDirectory && !trimmedString(server.cwd)) {
      server.cwd = workingDirectory;
    }
    delete server.workingDirectory;
    const stdioInvalid = schemaRefusal(name, server);
    if (stdioInvalid) {
      return stdioInvalid;
    }
    return {
      kind: "ok",
      entry: { name, server, launch: command, assumedTransport: null },
    };
  }
  const url = trimmedString(server.url);
  if (!url) {
    return { kind: "json-entry-launchless", detail: name };
  }
  // A present-but-blank `command` is not a launch, but it IS copied into the
  // Codex projection alongside the URL, and Codex rejects every command-plus-URL
  // pair (../codex/codex-rs/config/src/mcp_types.rs).
  //
  // Every stdio-only field goes, not just the command: `carries` above reads a
  // blank one as absent, so a snippet with `cwd: ""` passes the conflict check
  // and would then be forwarded verbatim by applyCommonServerConfig — which
  // Codex refuses on an HTTP transport, making an entry this form called valid
  // fail to load on a Codex-backed run.
  for (const field of stdioOnly) {
    delete server[field];
  }
  delete server.command;
  // Checked here rather than left to the config schema, for the same reason the
  // typed form checks its own URL: the schema answers at save time, long after
  // this form closed, leaving a failed Save with nothing to correct it in.
  if (!isHttpUrl(url)) {
    return { kind: "json-entry-url-invalid", detail: name };
  }
  const declared = trimmedString(server.transport)?.toLowerCase();
  // A URL-only entry labelled stdio launches nothing: the runtime resolves
  // stdio from `command`, so this is a snippet the operator has to fix.
  if (declared && !HTTP_TRANSPORTS.has(declared)) {
    return { kind: "json-entry-transport-invalid", detail: name };
  }
  // Written back normalized, not just validated normalized: McpServerSchema
  // accepts the exact lowercase spellings, so `"SSE"` would pass here and fail
  // at config Save with no import form left to correct it in.
  server.transport = declared ?? ASSUMED_HTTP_TRANSPORT;
  const httpInvalid = schemaRefusal(name, server);
  if (httpInvalid) {
    return httpInvalid;
  }
  return {
    kind: "ok",
    entry: {
      name,
      server,
      launch: url,
      assumedTransport: declared ? null : ASSUMED_HTTP_TRANSPORT,
    },
  };
}

/**
 * Servers a pasted snippet registers, or the first reason it registers none.
 *
 * All-or-nothing on purpose: a snippet is one unit an operator copied, and
 * registering the half that parsed would leave them believing the rest is
 * there too.
 */
export function parseMcpServerImport(text: string): ParsedMcpServerImport {
  if (text.trim().length === 0) {
    return { kind: "json-empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "json-invalid", detail: err instanceof Error ? err.message : String(err) };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { kind: "json-not-servers" };
  }
  const serverMap = unwrapServerMap(root);
  if (!serverMap) {
    return { kind: "json-not-servers" };
  }
  const names = Object.keys(serverMap);
  if (names.length === 0) {
    return { kind: "json-no-servers" };
  }
  const entries: ParsedMcpServerEntry[] = [];
  // Names are trimmed, so two distinct JSON keys can collapse to one server.
  // Writing both would keep only the last while the preview and the
  // all-or-nothing contract promised every entry.
  const seen = new Set<string>();
  for (const name of names) {
    const normalized = normalizeEntry(name, serverMap[name]);
    if (normalized.kind !== "ok") {
      return { kind: normalized.kind, detail: normalized.detail };
    }
    if (seen.has(normalized.entry.name)) {
      return { kind: "json-entry-name-duplicate", detail: normalized.entry.name };
    }
    seen.add(normalized.entry.name);
    entries.push(normalized.entry);
  }
  return { kind: "ok", entries };
}
