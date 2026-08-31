import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { collectPluginSchemaMetadata } from "./channel-config-metadata.ts";

function registry(plugin: Record<string, unknown>): PluginManifestRegistry {
  return {
    plugins: [{ origin: "bundled", channels: [], ...plugin }],
  } as unknown as PluginManifestRegistry;
}

describe("secret inputs promoted into plugin config hints", () => {
  it("marks a credential the schema names nothing like", () => {
    // `configContracts.secretInputs` is how a plugin says a field holds a
    // credential, and nothing promoted it — so `bearer`, which no name pattern
    // catches, reached the Control UI unmarked and rendered as plain text.
    const [plugin] = collectPluginSchemaMetadata(
      registry({
        id: "acme-rag",
        configContracts: { secretInputs: { paths: [{ path: "foundations.*.bearer" }] } },
        configSchema: {
          type: "object",
          properties: {
            foundations: {
              type: "array",
              items: { type: "object", properties: { bearer: { type: "string" } } },
            },
          },
        },
      }),
    );

    // Both spellings: the Knowledge form looks up the bracket key verbatim, and
    // the generic Settings form only wildcard-matches keys carrying `*`.
    expect(plugin?.configUiHints?.["foundations[].bearer"]?.sensitive).toBe(true);
    expect(plugin?.configUiHints?.["foundations.*.bearer"]?.sensitive).toBe(true);
  });

  it("keeps the map spelling for a wildcard over additionalProperties", () => {
    const [plugin] = collectPluginSchemaMetadata(
      registry({
        id: "acme-http",
        configContracts: { secretInputs: { paths: [{ path: "headers.*" }] } },
        configSchema: {
          type: "object",
          properties: { headers: { type: "object", additionalProperties: { type: "string" } } },
        },
      }),
    );

    expect(plugin?.configUiHints?.["headers.*"]?.sensitive).toBe(true);
  });

  it("follows a wildcard through a permissive object schema", () => {
    // A dynamic provider map is a supported shape, and `bearer` is not a name
    // the fallback matcher catches — so dropping the path here would leave a
    // declared credential unmarked and unredacted.
    const [plugin] = collectPluginSchemaMetadata(
      registry({
        id: "acme-dyn",
        configContracts: { secretInputs: { paths: [{ path: "providers.*.bearer" }] } },
        configSchema: {
          type: "object",
          properties: { providers: { type: "object", additionalProperties: true } },
        },
      }),
    );

    expect(plugin?.configUiHints?.["providers.*.bearer"]?.sensitive).toBe(true);
  });

  it("still drops a path a CLOSED schema refuses", () => {
    const [plugin] = collectPluginSchemaMetadata(
      registry({
        id: "acme-closed",
        configContracts: { secretInputs: { paths: [{ path: "providers.bearer" }] } },
        configSchema: {
          type: "object",
          properties: {
            providers: { type: "object", properties: {}, additionalProperties: false },
          },
        },
      }),
    );

    expect(Object.keys(plugin?.configUiHints ?? {})).toEqual([]);
  });

  it("leaves an authored hint alone", () => {
    // The plugin author's own call wins; this only fills a gap.
    const [plugin] = collectPluginSchemaMetadata(
      registry({
        id: "acme-rag",
        configUiHints: { token: { sensitive: false, label: "Public token" } },
        configContracts: { secretInputs: { paths: [{ path: "token" }] } },
        configSchema: { type: "object", properties: { token: { type: "string" } } },
      }),
    );

    expect(plugin?.configUiHints?.token?.sensitive).toBe(false);
  });

  it("marks a path an OPEN schema does not name, since it may still exist", () => {
    // An open object says more members may exist, so a declared secret under one
    // is a field the plugin really has. Marking it is the safe direction: a
    // spurious hint masks a value, a missing one leaks a credential.
    const [plugin] = collectPluginSchemaMetadata(
      registry({
        id: "acme-rag",
        configContracts: { secretInputs: { paths: [{ path: "extra.bearer" }] } },
        configSchema: { type: "object", properties: { token: { type: "string" } } },
      }),
    );

    expect(plugin?.configUiHints?.["extra.bearer"]?.sensitive).toBe(true);
  });
});
