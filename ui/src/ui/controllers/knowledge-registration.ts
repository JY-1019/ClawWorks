// Control UI controller registers external knowledge sources from config.
//
// A knowledge foundation is not stored by the enterprise layer; an adapter
// PLUGIN registers it, reading its own `plugins.entries.<id>.config`. So this
// screen registers one the same way the Enterprise MCP screen registers a
// server: by writing the config draft the Settings screens own, then leaving
// Save/Publish to them.
//
// Which plugins can be written to is discovered from the config schema rather
// than named here: any adapter whose config declares a `foundations` array of
// `{ id, serverUrl }` objects follows the contract the bundled LightRAG plugin
// documents, so a third-party adapter gets this screen without a core change.

import type { ConfigUiHints } from "../types.ts";

/** JSON Schema node, narrowed only as far as the walk below needs. */
type SchemaNode = Record<string, unknown>;

/** A field the registration form offers, described by the adapter's own schema. */
export type KnowledgeAdapterField = {
  name: string;
  /** Author-written contract for the field, shown as help. Undefined when the schema has none. */
  description?: string;
  /** Allowed values when the adapter constrains them; empty for free text. */
  options: string[];
  /**
   * String constraints the form enforces itself, so a value the adapter's schema
   * refuses is caught here instead of at config Save with the form already gone.
   */
  constraints?: { pattern?: string; minLength?: number; maxLength?: number };
  required: boolean;
  /** Whether the value is a credential, so the form can mask it. */
  sensitive: boolean;
};

/** One plugin that can register knowledge foundations through its config. */
export type KnowledgeAdapterPlugin = {
  pluginId: string;
  /** Plugin display name from the config ui hints, falling back to the id. */
  label: string;
  /** `id` and `serverUrl` first, then whatever else the adapter declares. */
  fields: KnowledgeAdapterField[];
};

/** Fields every adapter must declare; the pair that makes a foundation reachable. */
const REQUIRED_FIELDS = ["id", "serverUrl"] as const;

function asRecord(value: unknown): SchemaNode | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SchemaNode)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Does this schema node accept a string, whether or not it also accepts other
 * types?
 *
 * Traverses `anyOf`/`oneOf`, because that is the shape OpenClaw's own
 * `buildSecretInputSchema()` produces (src/plugin-sdk/secret-input-schema.ts):
 * a union of a plain string and the SecretRef objects, with no top-level
 * `type`. Reading only `type` would drop every credential declared the standard
 * way — and skip the whole adapter when one is required.
 */
function acceptsString(node: SchemaNode): boolean {
  const type = node.type;
  if (type === "string" || (Array.isArray(type) && type.includes("string"))) {
    return true;
  }
  return schemaBranches(node).some((branch) => acceptsString(branch));
}

/**
 * Every constrained string this node accepts, across its branches.
 *
 * A schema states a choice either as one `enum` or as `anyOf`/`oneOf` branches
 * of `const` values, and OpenClaw's own generated schemas use both — the same
 * traversal `acceptsString` already walks to decide the field is renderable at
 * all. Reading only the top-level `enum` marks such a field renderable and then
 * offers a free-text box, which stages a value the adapter's schema refuses on
 * Save.
 *
 * Order-preserving and de-duplicated, so the picker lists the schema's own
 * order and a value repeated across branches appears once.
 */
function stringChoices(node: SchemaNode): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const collect = (candidate: SchemaNode): void => {
    for (const value of [...stringList(candidate.enum), ...constString(candidate.const)]) {
      if (!seen.has(value)) {
        seen.add(value);
        found.push(value);
      }
    }
    for (const branch of schemaBranches(candidate)) {
      collect(branch);
    }
  };
  collect(node);
  return found;
}

/**
 * String constraints declared on this node or on one of its branches.
 *
 * First declaration wins, matching how the choices above are collected: a schema
 * states these once, and a branch repeating them cannot mean two different
 * things about the same field.
 */
function stringConstraints(node: SchemaNode): KnowledgeAdapterField["constraints"] {
  for (const candidate of [node, ...schemaBranches(node)]) {
    const pattern = typeof candidate.pattern === "string" ? candidate.pattern : undefined;
    const minLength = typeof candidate.minLength === "number" ? candidate.minLength : undefined;
    const maxLength = typeof candidate.maxLength === "number" ? candidate.maxLength : undefined;
    if (pattern !== undefined || minLength !== undefined || maxLength !== undefined) {
      return {
        ...(pattern !== undefined ? { pattern } : {}),
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Does this node declare a `format` this form cannot check?
 *
 * `format` names a whole vocabulary (email, uuid, date-time), and a text box
 * that accepted anything would stage a value the adapter's schema refuses at
 * Save. Such a field belongs in the config editor, exactly like an object-shaped
 * one — so it is treated as unrenderable rather than half-validated.
 */
function declaresUnenforceableFormat(node: SchemaNode): boolean {
  return [node, ...schemaBranches(node)].some((candidate) => typeof candidate.format === "string");
}

/** A `const` string as a one-value list; anything else contributes no choice. */
function constString(value: unknown): string[] {
  return typeof value === "string" ? [value] : [];
}

/** The `anyOf`/`oneOf` alternatives of a schema node, if it has any. */
function schemaBranches(node: SchemaNode): SchemaNode[] {
  return [node.anyOf, node.oneOf]
    .flatMap((branch) => (Array.isArray(branch) ? branch : []))
    .map((branch) => asRecord(branch))
    .filter((branch): branch is SchemaNode => branch !== null);
}

/**
 * Does this node also accept an object? Together with `acceptsString` that is
 * the SecretRef shape, which is the only first-use signal that a field is a
 * credential — see the note on `isSensitive`.
 */
function acceptsObject(node: SchemaNode): boolean {
  const type = node.type;
  if (type === "object" || (Array.isArray(type) && type.includes("object"))) {
    return true;
  }
  return schemaBranches(node).some((branch) => acceptsObject(branch));
}

function describeField(
  name: string,
  node: SchemaNode,
  required: Set<string>,
  sensitive: (name: string) => boolean,
): KnowledgeAdapterField {
  const description = typeof node.description === "string" ? node.description.trim() : "";
  return {
    name,
    ...(description ? { description } : {}),
    options: stringChoices(node),
    ...(stringConstraints(node) ? { constraints: stringConstraints(node) } : {}),
    required: required.has(name),
    sensitive: sensitive(name),
  };
}

/**
 * The foundation item schema an adapter declares, or null when it declares none.
 *
 * The shape IS the contract: an array called `foundations` whose items are
 * objects carrying a string `id` and a string `serverUrl`. Anything looser would
 * offer this form for config blocks that have nothing to do with retrieval.
 */
function foundationItemSchema(configSchema: unknown): SchemaNode | null {
  const foundations = asRecord(asRecord(configSchema)?.properties);
  const array = asRecord(foundations?.foundations);
  if (!array || array.type !== "array") {
    return null;
  }
  const items = asRecord(array.items);
  const properties = asRecord(items?.properties);
  if (!items || !properties) {
    return null;
  }
  const declaresPair = REQUIRED_FIELDS.every((field) => {
    const node = asRecord(properties[field]);
    return node !== null && acceptsString(node);
  });
  return declaresPair ? items : null;
}

/**
 * Adapters this deployment could register a foundation through.
 *
 * Reads the schema the gateway already sends for the config form, so a plugin
 * that is installed but disabled still appears — registering is how an operator
 * turns it on, and hiding it would leave the screen empty with nothing to do.
 */
/**
 * Plugins whose config schema the gateway dropped from this response.
 *
 * Over its extension-schema budget the gateway substitutes a generic object
 * carrying this sentence (buildOmittedExtensionConfigSchema in
 * src/config/schema.ts), so an installed knowledge adapter can be invisible to
 * discovery. Reporting "no adapter is installed" there would send the operator
 * looking for a plugin they already have; the screen says what actually
 * happened instead.
 */
export function omittedAdapterSchemaPluginIds(configSchema: unknown): string[] {
  const byPluginId = asRecord(
    asRecord(
      asRecord(asRecord(asRecord(asRecord(configSchema)?.properties)?.plugins)?.properties)
        ?.entries,
    )?.properties,
  );
  if (!byPluginId) {
    return [];
  }
  return Object.entries(byPluginId)
    .filter(([, entrySchema]) => {
      const config = asRecord(asRecord(asRecord(entrySchema)?.properties)?.config);
      const description = typeof config?.description === "string" ? config.description : "";
      return description.includes("exceeded the Gateway response budget");
    })
    .map(([pluginId]) => pluginId)
    .toSorted((a, b) => a.localeCompare(b));
}

export function listKnowledgeAdapterPlugins(
  configSchema: unknown,
  uiHints: ConfigUiHints = {},
  /**
   * The config each adapter already carries, per plugin id. Used only to learn
   * which fields the gateway actually redacts — see `isSensitive` below.
   */
  configured: Record<string, readonly Record<string, unknown>[]> = {},
): KnowledgeAdapterPlugin[] {
  const entries = asRecord(
    asRecord(asRecord(asRecord(asRecord(configSchema)?.properties)?.plugins)?.properties)?.entries,
  );
  const byPluginId = asRecord(asRecord(entries?.properties));
  if (!byPluginId) {
    return [];
  }
  const adapters: KnowledgeAdapterPlugin[] = [];
  for (const [pluginId, entrySchema] of Object.entries(byPluginId)) {
    const configSchemaNode = asRecord(asRecord(entrySchema)?.properties)?.config;
    const items = foundationItemSchema(configSchemaNode);
    const properties = asRecord(items?.properties);
    if (!items || !properties) {
      continue;
    }
    const required = new Set(stringList(items.required));
    // Three sources, because none alone is right. The ui-hint catches paths the
    // gateway classifies by name (`isSensitiveConfigPath`), but an adapter can
    // declare its secret through `configContracts.secretInputs`, which is never
    // promoted into hints — so a field named `bearer` or `pat` would render as
    // plain text. Observed redaction is the ground truth for those: if the
    // gateway blanked this field in any entry it sent, it is a credential — but
    // only once one has been saved, so the SecretRef shape covers first use.
    // A field a plugin declares ONLY through secretInputs, typed as a plain
    // string and never yet saved, still cannot be detected here: that contract
    // reaches neither the schema nor the hints, and closing that gap means
    // promoting it into the gateway's hints (which also governs redaction).
    const redactedFields = new Set<string>();
    for (const entry of configured[pluginId] ?? []) {
      for (const [name, value] of Object.entries(entry)) {
        if (containsRedacted(value)) {
          redactedFields.add(name);
        }
      }
    }
    const isSensitive = (field: string) => {
      if (
        uiHints[`plugins.entries.${pluginId}.config.foundations[].${field}`]?.sensitive === true
      ) {
        return true;
      }
      if (redactedFields.has(field)) {
        return true;
      }
      // Third signal, for a field whose FIRST value is being entered: nothing
      // has been redacted yet and the hint may not exist, but a field declared
      // as string-or-object is the SecretRef shape a plugin's
      // `configContracts.secretInputs` uses. See the note on this function.
      const node = asRecord(properties[field]) ?? {};
      return acceptsString(node) && acceptsObject(node);
    };
    // Only fields a text box or a select can honestly produce. An adapter that
    // declares an object or array option (headers, a nested policy block) gets
    // it from the config editor: rendering an input for it would write a string
    // into a field the schema rejects at save, long after this form closed.
    const optional = Object.keys(properties).filter(
      (name) => !REQUIRED_FIELDS.includes(name as (typeof REQUIRED_FIELDS)[number]),
    );
    const renderable = (name: string) => {
      const node = asRecord(properties[name]) ?? {};
      return acceptsString(node) && !declaresUnenforceableFormat(node);
    };
    // ...and if one of those unrenderable fields is REQUIRED, this form can
    // never produce a valid entry for the adapter at all. Offering it would let
    // an operator fill everything in and only learn at Save that the result was
    // never loadable. Such an adapter is configured in the config editor.
    if (optional.some((name) => required.has(name) && !renderable(name))) {
      continue;
    }
    const declared = optional.filter(renderable);
    adapters.push({
      pluginId,
      label: uiHints[`plugins.entries.${pluginId}`]?.label?.trim() || pluginId,
      // The reachability pair leads, in that order, because it is what the
      // operator must supply; everything else the adapter declares follows.
      fields: [...REQUIRED_FIELDS, ...declared].map((name) =>
        describeField(name, asRecord(properties[name]) ?? {}, required, isSensitive),
      ),
    });
  }
  return adapters.toSorted((left, right) => left.label.localeCompare(right.label));
}

/**
 * Tokens an adapter author writes lowercase in a config key but that read wrong
 * in a label. Small and closed on purpose: a general dictionary would start
 * "correcting" words the author meant.
 */
const LABEL_ACRONYMS: Record<string, string> = {
  api: "API",
  url: "URL",
  uri: "URI",
  id: "ID",
  ssl: "SSL",
  tls: "TLS",
};

/**
 * Own-property lookup. A JSON Schema may legally name a field `constructor` or
 * `__proto__`, and a plain index would then return an inherited function
 * instead of a string — which the caller would try to lowercase and throw on,
 * taking the whole tab down.
 */
function acronym(word: string): string | undefined {
  return Object.hasOwn(LABEL_ACRONYMS, word) ? LABEL_ACRONYMS[word] : undefined;
}

/**
 * A form label for a field only the adapter's schema names.
 *
 * Splits the camelCase config key, because "apiKey (optional)" in a form reads
 * as a leaked identifier rather than as a field name. The two contract fields
 * every adapter declares get translated labels instead and never come here.
 */
export function humanizeFieldName(name: string): string {
  const words = name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0)
    .map((word) => acronym(word.toLowerCase()) ?? word.toLowerCase());
  if (words.length === 0) {
    return name;
  }
  const [first, ...rest] = words;
  // Sentence case, so only the first word is capitalized and an acronym keeps
  // the casing the map gave it.
  const lead = acronym(first.toLowerCase()) ?? first.charAt(0).toUpperCase() + first.slice(1);
  return [lead, ...rest].join(" ");
}

/**
 * A config value as text. The foundation records come from config, so every
 * field is `unknown` until read; anything that is not already a string has no
 * useful rendering and is better shown as absent than as "[object Object]".
 */
export function foundationText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A stored id as the adapter resolves it.
 *
 * Adapters trim (LightRAG does, in extensions/lightrag/src/config.ts), and a
 * manifest schema generally permits surrounding whitespace, so `" acme.kb "` is
 * a live source under the id `acme.kb`. Comparing or validating the raw form
 * would call a working source invalid and — with the id field locked on edit —
 * make it uneditable.
 */
export function foundationId(value: unknown): string {
  return foundationText(value).trim();
}

/** Foundations an adapter's config already declares, in config order. */
export function readConfiguredFoundations(
  configObject: Record<string, unknown>,
  pluginId: string,
): Record<string, unknown>[] {
  const entry = asRecord(asRecord(asRecord(configObject.plugins)?.entries)?.[pluginId]);
  const foundations = asRecord(entry)?.config;
  const list = asRecord(foundations)?.foundations;
  return Array.isArray(list)
    ? list.map((item) => asRecord(item)).filter((item): item is SchemaNode => item !== null)
    : [];
}

export type KnowledgeFoundationDraftError =
  | "id-empty"
  | "id-taken"
  | "url-empty"
  | "url-invalid"
  | "adapter-missing"
  | "entry-missing"
  | "field-required"
  | "field-invalid";

/** The form's state: one adapter, what it is doing, and a value per declared field. */
export type KnowledgeFoundationDraft = {
  pluginId: string;
  /**
   * Position in the adapter's `foundations` list this form writes to, or null
   * when it appends a new one. An edit stays AT its index: the gateway restores
   * a stored credential by array position, so moving an entry would hand it
   * another server's key.
   */
  editingIndex: number | null;
  /**
   * The entry as it stood when this form opened, serialized.
   *
   * Neither an index nor an id is enough. A Refresh — or another admin saving —
   * can reorder the list, or leave the id in place while changing the URL and
   * rotating the credential. Either way the draft would combine ITS values with
   * the CURRENT row's redaction sentinel, and the gateway restores that
   * sentinel from the LATEST config — so the new secret would be written
   * against the old endpoint. Submit refuses unless the row is byte-identical
   * to what was opened. Comparing serialized form can only over-refuse (asking
   * the operator to reopen), never under-refuse.
   */
  editingSnapshot: string | null;
  /** Field name -> operator input. Blank values are dropped rather than written empty. */
  values: Record<string, string>;
  error: KnowledgeFoundationDraftError | null;
};

/**
 * The gateway replaces every stored credential with this before sending config
 * to the browser, and swaps the real value back in on save. The form therefore
 * never sees a key it could redisplay — it shows the field as unchanged and
 * writes the sentinel straight back unless the operator types a replacement.
 */
export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/**
 * A stored entry as an identity, for detecting that it moved or changed under an
 * open form. Key order comes from one JSON parse of the same config, so equal
 * rows serialize equally; a spurious mismatch only asks for a reopen.
 */
export function entrySnapshot(entry: Record<string, unknown> | undefined): string | null {
  return entry === undefined ? null : JSON.stringify(entry);
}

/**
 * Own-property read of an operator-entered value.
 *
 * A JSON Schema may legally name a field `constructor` or `__proto__`, and a
 * plain index into the draft's plain object would return the inherited function
 * — which the caller trims, and throws on.
 */
export function draftValue(values: Record<string, string>, name: string): string {
  return Object.hasOwn(values, name) ? values[name] : "";
}

/**
 * Own-property write. Assigning `__proto__` with `=` invokes the prototype
 * setter and silently drops the field instead of storing it.
 */
function setOwn(target: Record<string, unknown>, name: string, value: unknown) {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Is this stored value a credential the browser was never given? */
export function isRedacted(value: unknown): boolean {
  return value === REDACTED_SENTINEL;
}

/**
 * Does this value hold a redacted credential anywhere inside it?
 *
 * A SecretRef is redacted field-by-field, so a stored secret can be an OBJECT
 * whose nested `id` is the sentinel rather than the sentinel itself. A shallow
 * check would call such an entry credential-free and let it be moved.
 */
export function containsRedacted(value: unknown): boolean {
  if (isRedacted(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsRedacted);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(containsRedacted);
  }
  return false;
}

/**
 * Would clearing this field discard a value the browser never received?
 *
 * Deliberately independent of the schema's `sensitive` hint. That hint comes
 * from path patterns and `configUiHints`, while an adapter may declare its
 * secret through `configContracts.secretInputs` instead — which never reaches
 * the hints. Anything redacted, and anything the text form cannot represent
 * (a SecretRef object, a number), is preserved on a blank field regardless.
 */
export function preservesStoredValue(stored: unknown): boolean {
  return stored !== undefined && (containsRedacted(stored) || typeof stored !== "string");
}

/**
 * The id grammar a work-map step can actually name.
 *
 * Mirrors ENTERPRISE_ID_PATTERN in src/enterprise/schema.ts, which is what
 * `ontology.knowledgeFoundations` is validated against on import. A looser form
 * here would accept `acme_kb`, register it, and leave a source no governed step
 * could ever be bound to.
 */
const FOUNDATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Seed the form from a stored foundation so editing starts where it left off.
 *
 * Credentials come back blank rather than as the sentinel: a masked input full
 * of placeholder text reads as a real value the operator could edit character by
 * character, and it cannot be. Blank plus an "unchanged" note is the truth, and
 * submitting keeps the stored value.
 */
export function knowledgeDraftFromEntry(params: {
  pluginId: string;
  index: number;
  entry: Record<string, unknown>;
}): KnowledgeFoundationDraft {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(params.entry)) {
    if (typeof value === "string" && !isRedacted(value)) {
      setOwn(values, name, value);
    }
  }
  return {
    pluginId: params.pluginId,
    editingIndex: params.index,
    editingSnapshot: entrySnapshot(params.entry),
    values,
    error: null,
  };
}

/**
 * The config entry a draft describes, or why it is not one yet.
 *
 * Checked here rather than left to the config schema, for the same reason the
 * MCP form checks its URL: the schema answers at save time, long after the form
 * closed, leaving a failed Save with nothing to correct it in.
 */
/** Does this value break a constraint the adapter's schema declares? */
function violatesConstraints(value: string, field: KnowledgeAdapterField): boolean {
  if (field.options.length > 0 && !field.options.includes(value)) {
    return true;
  }
  const constraints = field.constraints;
  if (!constraints) {
    return false;
  }
  if (constraints.minLength !== undefined && value.length < constraints.minLength) {
    return true;
  }
  if (constraints.maxLength !== undefined && value.length > constraints.maxLength) {
    return true;
  }
  if (constraints.pattern === undefined) {
    return false;
  }
  try {
    return !new RegExp(constraints.pattern).test(value);
  } catch {
    // An unparsable pattern is the adapter's bug, and refusing every value over
    // it would make the source unregisterable. The config Save still enforces it.
    return false;
  }
}

export function buildKnowledgeFoundationEntry(params: {
  draft: KnowledgeFoundationDraft;
  adapter: KnowledgeAdapterPlugin | undefined;
  /** Ids already registered, whether live or only in the unsaved config draft. */
  existingIds: readonly string[];
  /** The stored entry being edited, so values this form cannot show survive. */
  original?: Record<string, unknown>;
}): { kind: "ok"; entry: Record<string, unknown> } | { kind: KnowledgeFoundationDraftError } {
  const { draft, adapter, original } = params;
  if (!adapter) {
    return { kind: "adapter-missing" };
  }
  // The row moved or changed under the form — a Refresh, or another admin
  // saving. Either would pair this draft's values with the current row's
  // credential, which the gateway restores from the latest config.
  if (draft.editingIndex !== null && entrySnapshot(original) !== draft.editingSnapshot) {
    return { kind: "entry-missing" };
  }
  // An id a work-map step already names is not this form's to change: nothing
  // migrates `ontology.knowledgeFoundations`, so a rename would leave every step
  // pointing at a source that no longer exists. Editing keeps the stored id.
  const id = original ? foundationId(original.id) : draftValue(draft.values, "id").trim();
  if (!id || !FOUNDATION_ID_PATTERN.test(id)) {
    return { kind: "id-empty" };
  }
  // The two required fields carry the adapter's constraints like any other, and
  // only the generic id/URL rules ran above — so an adapter narrowing them (an
  // enum, a pattern, a length) would refuse the staged entry at Save.
  const requiredFieldInvalid = ["id", "serverUrl"].some((name) => {
    const field = adapter.fields.find((candidate) => candidate.name === name);
    const typed = name === "id" ? id : draftValue(draft.values, name).trim();
    return Boolean(field && typed) && violatesConstraints(typed, field as KnowledgeAdapterField);
  });
  if (requiredFieldInvalid) {
    return { kind: "field-invalid" };
  }
  // A repeated id does not add a source: retrieval resolves an id to one
  // adapter, so the second entry would shadow the first and the step that names
  // it would query something the operator did not mean. An edit keeping its own
  // id is not a repeat, so the caller excludes the entry being edited.
  if (params.existingIds.includes(id)) {
    return { kind: "id-taken" };
  }
  // An adapter may mark `serverUrl` sensitive, in which case the browser was
  // given the sentinel and the form shows the field blank and unchanged. Blank
  // then means "keep the stored endpoint", exactly as it does for a credential —
  // otherwise no other field could be edited without retyping the whole URL.
  const typedUrl = draftValue(draft.values, "serverUrl").trim();
  const storedUrl =
    original !== undefined && Object.hasOwn(original, "serverUrl") ? original.serverUrl : undefined;
  const serverUrl = typedUrl || (preservesStoredValue(storedUrl) ? storedUrl : "");
  if (!serverUrl) {
    return { kind: "url-empty" };
  }
  // Only a value the operator can actually see is checked: a preserved sentinel
  // or SecretRef is not a URL this form is in a position to validate.
  if (typedUrl && !isHttpUrl(typedUrl)) {
    return { kind: "url-invalid" };
  }
  // Start from the stored entry so options this form does not render — an
  // adapter's object-shaped settings, a SecretRef, a field added by a newer
  // plugin version — are not dropped by an edit that never touched them.
  const entry: Record<string, unknown> = { ...original };
  setOwn(entry, "id", id);
  setOwn(entry, "serverUrl", serverUrl);
  for (const field of adapter.fields) {
    if (field.name === "id" || field.name === "serverUrl") {
      continue;
    }
    const value = draftValue(draft.values, field.name).trim();
    if (value) {
      // The adapter's own constraints, checked before the entry is staged: the
      // config Save enforces them too, but by then this form has closed and the
      // operator has nothing left to correct.
      if (violatesConstraints(value, field)) {
        return { kind: "field-invalid" };
      }
      setOwn(entry, field.name, value);
      continue;
    }
    const stored = Object.hasOwn(original ?? {}, field.name)
      ? (original as Record<string, unknown>)[field.name]
      : undefined;
    // Blank leaves a stored value alone whenever the browser cannot have been
    // given it. Otherwise blank means "the adapter's default", which is not the
    // same as an empty string.
    if (preservesStoredValue(stored)) {
      continue;
    }
    delete entry[field.name];
    // The adapter says this one is required, so an empty entry would only fail
    // at config Save — long after this form closed, with nothing to correct it in.
    if (field.required) {
      return { kind: "field-required" };
    }
  }
  return { kind: "ok", entry };
}

/**
 * Whether removing `index` would move a stored credential onto another server.
 *
 * The gateway restores redacted values by array position (see the note in
 * restoreRedactedValuesWithLookup, src/config/redact-snapshot.ts), so deleting
 * an entry shifts every later one into a slot whose credential is not theirs.
 * Entries after `index` that carry no redacted value are safe to shift.
 * Returns the ids that would be mismatched, empty when the removal is safe.
 */
export function foundationsBlockingRemoval(params: {
  foundations: readonly Record<string, unknown>[];
  index: number;
}): string[] {
  return params.foundations
    .slice(params.index + 1)
    .filter((entry) => containsRedacted(entry))
    .map((entry) => foundationId(entry.id) || "?");
}
