import { describe, expect, it } from "vitest";
import {
  buildKnowledgeFoundationEntry,
  containsRedacted,
  entrySnapshot,
  foundationsBlockingRemoval,
  humanizeFieldName,
  knowledgeDraftFromEntry,
  listKnowledgeAdapterPlugins,
  omittedAdapterSchemaPluginIds,
  readConfiguredFoundations,
  REDACTED_SENTINEL,
  type KnowledgeFoundationDraft,
} from "./knowledge-registration.ts";

/** A config schema shaped like the one the gateway builds from plugin manifests. */
function schemaWithAdapter(pluginId: string, extra: Record<string, unknown> = {}) {
  return {
    properties: {
      plugins: {
        properties: {
          entries: {
            properties: {
              [pluginId]: {
                properties: {
                  config: {
                    properties: {
                      foundations: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["id", "serverUrl"],
                          properties: {
                            id: { type: "string", description: "Foundation id." },
                            serverUrl: { type: "string" },
                            ...extra,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function draftOf(
  values: Record<string, string>,
  editingIndex: number | null = null,
  editingSnapshot: string | null = null,
): KnowledgeFoundationDraft {
  return { pluginId: "lightrag", editingIndex, editingSnapshot, values, error: null };
}

describe("listKnowledgeAdapterPlugins", () => {
  it("finds any plugin whose config declares the foundations contract", () => {
    const adapters = listKnowledgeAdapterPlugins(schemaWithAdapter("acme-rag"), {
      "plugins.entries.acme-rag": { label: "Acme RAG" },
    });

    expect(adapters).toEqual([
      {
        pluginId: "acme-rag",
        label: "Acme RAG",
        fields: [
          {
            name: "id",
            description: "Foundation id.",
            options: [],
            required: true,
            sensitive: false,
          },
          { name: "serverUrl", options: [], required: true, sensitive: false },
        ],
      },
    ]);
  });

  it("carries the adapter's enum values and credential marking into the form", () => {
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("lightrag", {
        kind: { type: "string", enum: ["remote", "local"] },
        apiKey: { type: ["string", "object"] },
      }),
      { "plugins.entries.lightrag.config.foundations[].apiKey": { sensitive: true } },
    );

    expect(adapter?.fields.find((field) => field.name === "kind")?.options).toEqual([
      "remote",
      "local",
    ]);
    expect(adapter?.fields.find((field) => field.name === "apiKey")?.sensitive).toBe(true);
    // Falls back to the plugin id when no ui hint names the plugin.
    expect(adapter?.label).toBe("lightrag");
  });

  it("collects choices from anyOf/oneOf branches, not just a top-level enum", () => {
    // A schema states a choice either as one `enum` or as branches of `const`,
    // and the same traversal already decides the field renders at all. Reading
    // only the top-level enum offered a free-text box for a constrained field,
    // which stages a value the adapter's schema refuses on Save.
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("lightrag", {
        kind: {
          anyOf: [
            { type: "string", const: "remote" },
            { type: "string", const: "local" },
            // Repeated across branches, and listed once.
            { type: "string", enum: ["local", "hybrid"] },
          ],
        },
      }),
      {},
    );

    expect(adapter?.fields.find((field) => field.name === "kind")?.options).toEqual([
      "remote",
      "local",
      "hybrid",
    ]);
  });

  it("leaves a genuinely free-text field with no options", () => {
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("lightrag", { note: { type: "string" } }),
      {},
    );

    expect(adapter?.fields.find((field) => field.name === "note")?.options).toEqual([]);
  });

  it("leaves a field no text box could fill to the config editor", () => {
    // Rendering an input for an object option would write a string into a field
    // the schema rejects at save, long after the form closed.
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("acme-rag", {
        headers: { type: "object" },
        tags: { type: "array" },
        label: { type: "string" },
      }),
    );

    expect(adapter?.fields.map((field) => field.name)).toEqual(["id", "serverUrl", "label"]);
  });

  it("ignores a plugin whose config has no foundations array", () => {
    const schema = {
      properties: {
        plugins: {
          properties: {
            entries: {
              properties: {
                codex: {
                  properties: { config: { properties: { discovery: { type: "object" } } } },
                },
              },
            },
          },
        },
      },
    };

    expect(listKnowledgeAdapterPlugins(schema)).toEqual([]);
  });

  it("ignores a foundations array whose items do not name a server", () => {
    // The shape IS the contract: without id + serverUrl this form would be
    // offered for config blocks that have nothing to do with retrieval.
    const schema = schemaWithAdapter("acme-rag");
    const items = schema.properties.plugins.properties.entries.properties["acme-rag"] as never as {
      properties: { config: { properties: { foundations: { items: { properties: object } } } } };
    };
    items.properties.config.properties.foundations.items.properties = { label: { type: "string" } };

    expect(listKnowledgeAdapterPlugins(schema)).toEqual([]);
  });

  it("answers empty for a schema that has not loaded", () => {
    expect(listKnowledgeAdapterPlugins(null)).toEqual([]);
  });
});

describe("adapter string constraints", () => {
  it("carries pattern and length limits into the field", () => {
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("lightrag", {
        workspace: { type: "string", pattern: "^[a-z]+$", minLength: 2, maxLength: 8 },
      }),
      {},
    );

    expect(adapter?.fields.find((field) => field.name === "workspace")?.constraints).toEqual({
      pattern: "^[a-z]+$",
      minLength: 2,
      maxLength: 8,
    });
  });

  it("refuses a value the adapter's own schema would reject at Save", () => {
    // Save enforces these too, but by then the form has closed and the operator
    // has nothing left to correct.
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("lightrag", {
        workspace: { type: "string", pattern: "^[a-z]+$", maxLength: 4 },
      }),
      {},
    );
    const build = (workspace: string) =>
      buildKnowledgeFoundationEntry({
        draft: {
          pluginId: "lightrag",
          editingIndex: null,
          editingSnapshot: null,
          values: { id: "acme.kb", serverUrl: "http://rag.acme.dev", workspace },
          error: null,
        },
        adapter,
        existingIds: [],
      });

    expect(build("ACME").kind).toBe("field-invalid");
    expect(build("toolongvalue").kind).toBe("field-invalid");
    expect(build("kb").kind).toBe("ok");
  });

  it("does not offer a field whose format it cannot check", () => {
    // A `format` names a whole vocabulary; a text box that accepted anything
    // would stage a value Save refuses, so the field belongs in the config editor.
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("lightrag", { contact: { type: "string", format: "email" } }),
      {},
    );

    expect(adapter?.fields.some((field) => field.name === "contact")).toBe(false);
  });
});

describe("readConfiguredFoundations", () => {
  it("reads the adapter's own config block", () => {
    const config = {
      plugins: {
        entries: {
          lightrag: { config: { foundations: [{ id: "acme.kb", serverUrl: "http://a" }, "junk"] } },
        },
      },
    };

    expect(readConfiguredFoundations(config, "lightrag")).toEqual([
      { id: "acme.kb", serverUrl: "http://a" },
    ]);
  });

  it("answers empty for an adapter with no config", () => {
    expect(readConfiguredFoundations({}, "lightrag")).toEqual([]);
  });
});

describe("buildKnowledgeFoundationEntry", () => {
  const adapter = listKnowledgeAdapterPlugins(
    schemaWithAdapter("lightrag", {
      description: { type: "string" },
      kind: { type: "string", enum: ["remote", "local"] },
      mode: { type: "string", enum: ["mix", "naive"] },
    }),
  )[0];

  it("writes the reachability pair plus whatever the operator filled in", () => {
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf({
        id: "acme.support-kb",
        serverUrl: "http://localhost:9621",
        description: "Refund and shipping policy.",
        kind: "local",
        // Blank means "the adapter's default", which is not an empty string.
        mode: "  ",
      }),
      adapter,
      existingIds: [],
    });

    expect(built).toEqual({
      kind: "ok",
      entry: {
        id: "acme.support-kb",
        serverUrl: "http://localhost:9621",
        description: "Refund and shipping policy.",
        kind: "local",
      },
    });
  });

  it("refuses an id a workflow step could not name", () => {
    for (const id of ["", "Acme KB", "  "]) {
      expect(
        buildKnowledgeFoundationEntry({
          draft: draftOf({ id, serverUrl: "http://localhost:9621" }),
          adapter,
          existingIds: [],
        }),
      ).toEqual({ kind: "id-empty" });
    }
  });

  it("refuses an id that already resolves to a source", () => {
    // Retrieval resolves an id to one adapter, so the second entry would shadow
    // the first and the step naming it would query something else.
    expect(
      buildKnowledgeFoundationEntry({
        draft: draftOf({ id: "acme.kb", serverUrl: "http://localhost:9621" }),
        adapter,
        existingIds: ["acme.kb"],
      }),
    ).toEqual({ kind: "id-taken" });
  });

  it("refuses a URL nothing could dial, and a missing one", () => {
    expect(
      buildKnowledgeFoundationEntry({
        draft: draftOf({ id: "acme.kb", serverUrl: "ftp://example.com" }),
        adapter,
        existingIds: [],
      }),
    ).toEqual({ kind: "url-invalid" });
    expect(
      buildKnowledgeFoundationEntry({
        draft: draftOf({ id: "acme.kb", serverUrl: "" }),
        adapter,
        existingIds: [],
      }),
    ).toEqual({ kind: "url-empty" });
  });

  it("refuses to build without an adapter to build for", () => {
    expect(
      buildKnowledgeFoundationEntry({
        draft: draftOf({ id: "acme.kb", serverUrl: "http://localhost:9621" }),
        adapter: undefined,
        existingIds: [],
      }),
    ).toEqual({ kind: "adapter-missing" });
  });
});

describe("editing a stored source", () => {
  const adapter = listKnowledgeAdapterPlugins(
    schemaWithAdapter("lightrag", {
      description: { type: "string" },
      mode: { type: "string", enum: ["mix", "naive"] },
      apiKey: { type: ["string", "object"] },
    }),
    { "plugins.entries.lightrag.config.foundations[].apiKey": { sensitive: true } },
  )[0];

  it("seeds the form from the entry but never from a credential it cannot show", () => {
    const draft = knowledgeDraftFromEntry({
      pluginId: "lightrag",
      index: 2,
      entry: {
        id: "acme.kb",
        serverUrl: "https://rag.acme.dev",
        mode: "naive",
        apiKey: REDACTED_SENTINEL,
      },
    });

    expect(draft).toEqual({
      pluginId: "lightrag",
      editingIndex: 2,
      // The whole row, so a later change to it — not just to its id — is caught.
      editingSnapshot: entrySnapshot({
        id: "acme.kb",
        serverUrl: "https://rag.acme.dev",
        mode: "naive",
        apiKey: REDACTED_SENTINEL,
      }),
      values: { id: "acme.kb", serverUrl: "https://rag.acme.dev", mode: "naive" },
      error: null,
    });
  });

  it("keeps the stored credential when the operator leaves the field blank", () => {
    // The browser was never given the key; writing the sentinel straight back is
    // what lets the gateway swap the real value in on save.
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf(
        { id: "acme.kb", serverUrl: "https://rag.acme.dev" },
        0,
        entrySnapshot({ id: "acme.kb", serverUrl: "http://old", apiKey: REDACTED_SENTINEL }),
      ),
      adapter,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://old", apiKey: REDACTED_SENTINEL },
    });

    expect(built).toEqual({
      kind: "ok",
      entry: { id: "acme.kb", serverUrl: "https://rag.acme.dev", apiKey: REDACTED_SENTINEL },
    });
  });

  it("replaces the credential when the operator types one", () => {
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf(
        { id: "acme.kb", serverUrl: "https://rag.acme.dev", apiKey: "NEW" },
        0,
        entrySnapshot({ id: "acme.kb", serverUrl: "http://old", apiKey: REDACTED_SENTINEL }),
      ),
      adapter,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://old", apiKey: REDACTED_SENTINEL },
    });

    expect(built.kind === "ok" && built.entry.apiKey).toBe("NEW");
  });

  it("carries forward options the form cannot render", () => {
    // An adapter's object-shaped setting, or a field a newer plugin version
    // added, must survive an edit that never touched it.
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf(
        { id: "acme.kb", serverUrl: "https://rag.acme.dev" },
        0,
        entrySnapshot({ id: "acme.kb", serverUrl: "http://old", headers: { "X-Tenant": "acme" } }),
      ),
      adapter,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://old", headers: { "X-Tenant": "acme" } },
    });

    expect(built.kind === "ok" && built.entry.headers).toEqual({ "X-Tenant": "acme" });
  });

  it("clears an optional value the operator emptied", () => {
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf(
        { id: "acme.kb", serverUrl: "https://rag.acme.dev", mode: "" },
        0,
        entrySnapshot({ id: "acme.kb", serverUrl: "http://old", mode: "naive" }),
      ),
      adapter,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://old", mode: "naive" },
    });

    expect(built.kind === "ok" && "mode" in built.entry).toBe(false);
  });

  it("refuses to write at an index the list no longer has", () => {
    // Another tab saved, or the adapter changed: writing at a stale index would
    // overwrite a different foundation.
    expect(
      buildKnowledgeFoundationEntry({
        draft: draftOf(
          { id: "acme.kb", serverUrl: "https://rag.acme.dev" },
          4,
          entrySnapshot({ id: "acme.kb", serverUrl: "http://old" }),
        ),
        adapter,
        existingIds: [],
      }),
    ).toEqual({ kind: "entry-missing" });
  });
});

describe("foundationsBlockingRemoval", () => {
  it("names later sources whose credential removal would misplace", () => {
    // The gateway restores redacted values by array position, so a shift hands
    // one server another's key.
    expect(
      foundationsBlockingRemoval({
        foundations: [
          { id: "a", serverUrl: "http://a" },
          { id: "b", serverUrl: "http://b", apiKey: REDACTED_SENTINEL },
        ],
        index: 0,
      }),
    ).toEqual(["b"]);
  });

  it("allows a removal that shifts nothing sensitive", () => {
    expect(
      foundationsBlockingRemoval({
        foundations: [
          { id: "a", serverUrl: "http://a", apiKey: REDACTED_SENTINEL },
          { id: "b", serverUrl: "http://b" },
        ],
        index: 0,
      }),
    ).toEqual([]);
    // Removing the last one shifts nothing at all.
    expect(
      foundationsBlockingRemoval({
        foundations: [
          { id: "a", serverUrl: "http://a", apiKey: REDACTED_SENTINEL },
          { id: "b", serverUrl: "http://b", apiKey: REDACTED_SENTINEL },
        ],
        index: 1,
      }),
    ).toEqual([]);
  });
});

describe("humanizeFieldName", () => {
  it("turns an adapter's config key into a label, keeping acronyms upright", () => {
    // "apiKey (optional)" in a form reads as a leaked identifier, not a field.
    expect(humanizeFieldName("apiKey")).toBe("API key");
    expect(humanizeFieldName("description")).toBe("Description");
    expect(humanizeFieldName("mode")).toBe("Mode");
    expect(humanizeFieldName("serverUrl")).toBe("Server URL");
    expect(humanizeFieldName("tenant_id")).toBe("Tenant ID");
    expect(humanizeFieldName("sslVerify")).toBe("SSL verify");
  });

  it("leaves a name it cannot split alone", () => {
    expect(humanizeFieldName("")).toBe("");
  });
});

describe("credential preservation independent of the schema hint", () => {
  // A plugin may declare its secret through configContracts.secretInputs, which
  // never reaches configUiHints — so the sensitive flag cannot be the only thing
  // standing between a blank field and a dropped credential.
  const unflagged = listKnowledgeAdapterPlugins(
    schemaWithAdapter("acme-rag", { token: { type: ["string", "object"] } }),
  )[0];

  it("keeps a redacted value the schema never marked sensitive", () => {
    const built = buildKnowledgeFoundationEntry({
      draft: {
        pluginId: "acme-rag",
        editingIndex: 0,
        editingSnapshot: entrySnapshot({
          id: "acme.kb",
          serverUrl: "http://old",
          token: REDACTED_SENTINEL,
        }),
        values: { serverUrl: "https://a.dev" },
        error: null,
      },
      adapter: unflagged,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://old", token: REDACTED_SENTINEL },
    });

    expect(built.kind === "ok" && built.entry.token).toBe(REDACTED_SENTINEL);
  });

  it("keeps a SecretRef the text form cannot represent", () => {
    const ref = { source: "keychain", provider: "acme", id: REDACTED_SENTINEL };
    const built = buildKnowledgeFoundationEntry({
      draft: {
        pluginId: "acme-rag",
        editingIndex: 0,
        editingSnapshot: entrySnapshot({ id: "acme.kb", serverUrl: "http://old", token: ref }),
        values: { serverUrl: "https://a.dev" },
        error: null,
      },
      adapter: unflagged,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://old", token: ref },
    });

    expect(built.kind === "ok" && built.entry.token).toEqual(ref);
  });

  it("still clears an ordinary optional value the operator emptied", () => {
    const built = buildKnowledgeFoundationEntry({
      draft: {
        pluginId: "acme-rag",
        editingIndex: 0,
        editingSnapshot: entrySnapshot({ id: "acme.kb", serverUrl: "http://old", token: "plain" }),
        values: { serverUrl: "https://a.dev" },
        error: null,
      },
      adapter: unflagged,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://old", token: "plain" },
    });

    expect(built.kind === "ok" && "token" in built.entry).toBe(false);
  });
});

describe("containsRedacted", () => {
  it("finds a sentinel nested inside a SecretRef", () => {
    // A SecretRef is redacted field by field, so a stored secret can be an
    // object whose nested id is the sentinel rather than the sentinel itself.
    expect(containsRedacted({ source: "env", id: REDACTED_SENTINEL })).toBe(true);
    expect(containsRedacted([{ deep: { id: REDACTED_SENTINEL } }])).toBe(true);
    expect(containsRedacted({ id: "plain" })).toBe(false);
  });

  it("blocks a removal that would shift a nested credential", () => {
    expect(
      foundationsBlockingRemoval({
        foundations: [
          { id: "a", serverUrl: "http://a" },
          { id: "b", serverUrl: "http://b", apiKey: { source: "env", id: REDACTED_SENTINEL } },
        ],
        index: 0,
      }),
    ).toEqual(["b"]);
  });
});

describe("id and required-field contracts", () => {
  const adapter = listKnowledgeAdapterPlugins(
    schemaWithAdapter("acme-rag", { tenant: { type: "string" } }),
  )[0];

  it("accepts only ids a workflow step can name", () => {
    // Mirrors ENTERPRISE_ID_PATTERN in src/enterprise/schema.ts; a looser form
    // would register a source no step could ever be bound to.
    for (const id of ["acme_kb", "acme..kb", "acme.kb.", "Acme.kb", "-acme"]) {
      expect(
        buildKnowledgeFoundationEntry({
          draft: draftOf({ id, serverUrl: "https://a.dev" }),
          adapter,
          existingIds: [],
        }),
      ).toEqual({ kind: "id-empty" });
    }
    expect(
      buildKnowledgeFoundationEntry({
        draft: draftOf({ id: "acme.support-kb", serverUrl: "https://a.dev" }),
        adapter,
        existingIds: [],
      }).kind,
    ).toBe("ok");
  });

  it("keeps the stored id on an edit rather than letting it move", () => {
    // Nothing migrates ontology.knowledgeFoundations, so a rename would leave
    // every step bound to this source pointing at nothing.
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf(
        { id: "renamed.kb", serverUrl: "https://a.dev" },
        0,
        entrySnapshot({ id: "acme.kb", serverUrl: "http://old" }),
      ),
      adapter,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://old" },
    });

    expect(built.kind === "ok" && built.entry.id).toBe("acme.kb");
  });

  it("refuses to close the form on a blank required adapter field", () => {
    const required = listKnowledgeAdapterPlugins({
      properties: {
        plugins: {
          properties: {
            entries: {
              properties: {
                "acme-rag": {
                  properties: {
                    config: {
                      properties: {
                        foundations: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["id", "serverUrl", "tenant"],
                            properties: {
                              id: { type: "string" },
                              serverUrl: { type: "string" },
                              tenant: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })[0];

    expect(
      buildKnowledgeFoundationEntry({
        draft: {
          pluginId: "acme-rag",
          editingIndex: null,
          editingSnapshot: null,
          values: { id: "acme.kb", serverUrl: "https://a.dev" },
          error: null,
        },
        adapter: required,
        existingIds: [],
      }),
    ).toEqual({ kind: "field-required" });
  });
});

describe("an edit is pinned to the source it opened on", () => {
  const adapter = listKnowledgeAdapterPlugins(schemaWithAdapter("acme-rag"))[0];

  it("refuses when the slot now holds a different source", () => {
    // A Refresh, or another admin saving, can reorder the list while the form
    // is open. Writing there would overwrite that source with this draft's URL
    // while keeping ITS redacted credential.
    const opened = { id: "acme.orders-kb", serverUrl: "http://orders" };
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf({ serverUrl: "https://new.dev" }, 0, entrySnapshot(opened)),
      adapter,
      existingIds: [],
      original: { id: "acme.support-kb", serverUrl: "http://other", apiKey: REDACTED_SENTINEL },
    });

    expect(built).toEqual({ kind: "entry-missing" });
  });

  it("refuses when the same id was repointed and its secret rotated", () => {
    // The id check alone would accept this: the row keeps its name while the
    // URL and credential change, so the draft's old URL would be saved against
    // the new secret.
    const opened = { id: "acme.kb", serverUrl: "http://old", apiKey: REDACTED_SENTINEL };
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf({ serverUrl: "http://old" }, 0, entrySnapshot(opened)),
      adapter,
      existingIds: [],
      original: { id: "acme.kb", serverUrl: "http://rotated", apiKey: REDACTED_SENTINEL },
    });

    expect(built).toEqual({ kind: "entry-missing" });
  });

  it("proceeds when the row is exactly what the form opened on", () => {
    const opened = { id: "acme.kb", serverUrl: "http://old" };
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf({ serverUrl: "https://new.dev" }, 0, entrySnapshot(opened)),
      adapter,
      existingIds: [],
      original: opened,
    });

    expect(built.kind === "ok" && built.entry.serverUrl).toBe("https://new.dev");
  });
});

describe("adapter offerability", () => {
  it("masks a credential the schema never named, once the gateway redacts it", () => {
    // A secret declared via configContracts.secretInputs never reaches the ui
    // hints, so observed redaction is the only signal it is a credential.
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("acme-rag", { bearer: { type: "string" } }),
      {},
      { "acme-rag": [{ id: "a", serverUrl: "http://a", bearer: REDACTED_SENTINEL }] },
    );

    expect(adapter?.fields.find((field) => field.name === "bearer")?.sensitive).toBe(true);
  });

  it("does not offer an adapter whose required field this form cannot render", () => {
    // The operator would fill everything in and only learn at Save that the
    // result was never loadable.
    const schema = {
      properties: {
        plugins: {
          properties: {
            entries: {
              properties: {
                "acme-rag": {
                  properties: {
                    config: {
                      properties: {
                        foundations: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["id", "serverUrl", "routing"],
                            properties: {
                              id: { type: "string" },
                              serverUrl: { type: "string" },
                              routing: { type: "object" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(listKnowledgeAdapterPlugins(schema)).toEqual([]);
  });

  it("still offers one whose unrenderable field is optional", () => {
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("acme-rag", { routing: { type: "object" } }),
    );

    expect(adapter?.fields.map((field) => field.name)).toEqual(["id", "serverUrl"]);
  });
});

describe("hostile field and alias names", () => {
  it("labels a field named like an Object prototype key without throwing", () => {
    // JSON Schema may legally use these names; a plain index lookup would find
    // an inherited function and take the whole tab down when lowercased.
    expect(humanizeFieldName("constructor")).toBe("Constructor");
    expect(humanizeFieldName("__proto__")).toBe("Proto");
  });

  it("renders an adapter declaring such a field", () => {
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("acme-rag", { constructor: { type: "string" } }),
    );

    expect(adapter?.fields.map((field) => field.name)).toContain("constructor");
  });
});

describe("stored ids are read the way the adapter reads them", () => {
  const adapter = listKnowledgeAdapterPlugins(schemaWithAdapter("acme-rag"))[0];

  it("edits a source whose stored id carries surrounding whitespace", () => {
    // The adapter trims, so this is a live source under `acme.kb`. Validating
    // the raw form would call it invalid and — with the id locked — leave it
    // uneditable.
    const opened = { id: " acme.kb ", serverUrl: "http://old" };
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf({ serverUrl: "https://new.dev" }, 0, entrySnapshot(opened)),
      adapter,
      existingIds: [],
      original: opened,
    });

    expect(built).toEqual({
      kind: "ok",
      entry: { id: "acme.kb", serverUrl: "https://new.dev" },
    });
  });
});

describe("adapter fields named like Object prototype keys", () => {
  const adapter = listKnowledgeAdapterPlugins(
    schemaWithAdapter("acme-rag", { constructor: { type: "string" } }),
  )[0];

  it("submits a value for such a field instead of throwing", () => {
    // A plain read returns the inherited function, which the builder trims and
    // throws on; a plain `__proto__` write invokes the setter and drops it.
    const built = buildKnowledgeFoundationEntry({
      draft: draftOf({ id: "acme.kb", serverUrl: "https://a.dev", constructor: "x" }),
      adapter,
      existingIds: [],
    });

    expect(built.kind === "ok" && Object.hasOwn(built.entry, "constructor")).toBe(true);
    expect(built.kind === "ok" && built.entry.constructor).toBe("x");
  });
});

describe("a redacted serverUrl", () => {
  // An adapter is free to mark the endpoint itself sensitive.
  const adapter = listKnowledgeAdapterPlugins(
    schemaWithAdapter("acme-rag", { mode: { type: "string", enum: ["mix", "naive"] } }),
    { "plugins.entries.acme-rag.config.foundations[].serverUrl": { sensitive: true } },
  )[0];

  it("survives an edit to another field", () => {
    // The form shows it blank and unchanged, so requiring a retyped URL would
    // make every other field uneditable.
    const opened = { id: "acme.kb", serverUrl: REDACTED_SENTINEL, mode: "mix" };
    const built = buildKnowledgeFoundationEntry({
      draft: {
        pluginId: "acme-rag",
        editingIndex: 0,
        editingSnapshot: entrySnapshot(opened),
        values: { id: "acme.kb", mode: "naive" },
        error: null,
      },
      adapter,
      existingIds: [],
      original: opened,
    });

    expect(built).toEqual({
      kind: "ok",
      entry: { id: "acme.kb", serverUrl: REDACTED_SENTINEL, mode: "naive" },
    });
  });

  it("is still replaceable by typing a real one", () => {
    const opened = { id: "acme.kb", serverUrl: REDACTED_SENTINEL };
    const built = buildKnowledgeFoundationEntry({
      draft: {
        pluginId: "acme-rag",
        editingIndex: 0,
        editingSnapshot: entrySnapshot(opened),
        values: { id: "acme.kb", serverUrl: "https://new.dev" },
        error: null,
      },
      adapter,
      existingIds: [],
      original: opened,
    });

    expect(built.kind === "ok" && built.entry.serverUrl).toBe("https://new.dev");
  });
});

describe("standard SecretInput credential schemas", () => {
  // What buildSecretInputSchema() emits: a union of a plain string and the
  // SecretRef objects, with no top-level `type`.
  const secretInput = {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        properties: { source: { type: "string" }, id: { type: "string" } },
      },
    ],
  };

  it("keeps an optional credential declared that way in the form", () => {
    const [adapter] = listKnowledgeAdapterPlugins(
      schemaWithAdapter("acme-rag", { apiKey: secretInput }),
    );

    const field = adapter?.fields.find((entry) => entry.name === "apiKey");
    expect(field).toBeDefined();
    // The SecretRef shape is also the first-use signal that it is a credential.
    expect(field?.sensitive).toBe(true);
  });

  it("still offers an adapter that REQUIRES one", () => {
    // Reading only `type` would treat it as unrenderable and skip the adapter,
    // making the server unregisterable.
    const schema = {
      properties: {
        plugins: {
          properties: {
            entries: {
              properties: {
                "acme-rag": {
                  properties: {
                    config: {
                      properties: {
                        foundations: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["id", "serverUrl", "apiKey"],
                            properties: {
                              id: { type: "string" },
                              serverUrl: { type: "string" },
                              apiKey: secretInput,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(listKnowledgeAdapterPlugins(schema).map((entry) => entry.pluginId)).toEqual([
      "acme-rag",
    ]);
  });
});

describe("omittedAdapterSchemaPluginIds", () => {
  it("names plugins whose schema the gateway dropped over its budget", () => {
    // Otherwise the screen reports "no adapter is installed" for one that is.
    const schema = {
      properties: {
        plugins: {
          properties: {
            entries: {
              properties: {
                huge: {
                  properties: {
                    config: {
                      type: "object",
                      description:
                        "plugin config schema for huge was omitted from the full config.schema response because installed extension schemas exceeded the Gateway response budget.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(omittedAdapterSchemaPluginIds(schema)).toEqual(["huge"]);
    expect(omittedAdapterSchemaPluginIds(schemaWithAdapter("acme-rag"))).toEqual([]);
  });
});
