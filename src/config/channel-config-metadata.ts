/**
 * Converts plugin manifest metadata into deterministic config UI metadata for docs, validation, and runtime schema.
 * When multiple plugin origins expose the same id/channel, the closest origin owns the surfaced schema.
 */
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { ChannelUiMetadata, PluginUiMetadata } from "./schema.js";

export type ChannelSchemaMetadataWithOwnership = ChannelUiMetadata & {
  schemaPluginId?: string;
  schemaPluginOrigin?: PluginOrigin;
};

type ChannelMetadataRecord = ChannelSchemaMetadataWithOwnership & {
  originRank: number;
};

type ChannelDmAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

export type ChannelDmPolicyMetadata = {
  id: string;
  dmAllowFromMode?: ChannelDmAllowFromMode;
};

type ChannelDmPolicyMetadataRecord = ChannelDmPolicyMetadata & {
  originRank: number;
};

const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  // Lower ranks are closer to the operator and should override farther bundled/global metadata.
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The hint-map spelling of one manifest secret-input path.
 *
 * `configContracts.secretInputs` writes a wildcard segment as `*` while config
 * hints spell an ARRAY segment `[]` (`foundations[].apiKey`), so the path is
 * walked against the plugin's own schema to tell an array wildcard from a map
 * one. Returns null when the schema does not carry the path, since a hint keyed
 * to something no field answers to would never be read.
 */
/**
 * The member schema of a permissive object, or null when the shape is closed.
 *
 * `additionalProperties` absent or `true` means "more members may exist" with
 * nothing said about them, so an empty node carries the walk forward; an object
 * describes them; only an explicit `false` closes the shape.
 */
function openObjectMemberSchema(node: Record<string, unknown>): Record<string, unknown> | null {
  if (node.additionalProperties === false) {
    return null;
  }
  return asRecord(node.additionalProperties) ?? {};
}

function secretInputHintPath(configSchema: unknown, path: string): string | null {
  let node: Record<string, unknown> | null = asRecord(configSchema);
  const spelled: string[] = [];
  for (const segment of path.split(".")) {
    if (!node) {
      return null;
    }
    if (segment === "*") {
      const items = asRecord(node.items);
      if (items) {
        // An array wildcard: the hint key carries the brackets on the segment
        // BEFORE it, which is already the last one spelled.
        spelled[spelled.length - 1] = `${spelled.at(-1) ?? ""}[]`;
        node = items;
        continue;
      }
      const member = openObjectMemberSchema(node);
      if (!member) {
        return null;
      }
      spelled.push("*");
      node = member;
      continue;
    }
    const properties = asRecord(node.properties);
    const next = properties ? asRecord(properties[segment]) : null;
    if (!next) {
      // A permissive object declares no member schemas, and a dynamic map is a
      // supported shape — so the rest of the declared path is spelled as written
      // rather than dropped, which would leave the credential unmarked.
      const member = openObjectMemberSchema(node);
      if (!member) {
        return null;
      }
      spelled.push(segment);
      node = member;
      continue;
    }
    spelled.push(segment);
    node = next;
  }
  return spelled.join(".");
}

/**
 * Plugin hints with every declared secret input marked sensitive.
 *
 * `configContracts.secretInputs` is the contract a plugin uses to say "this
 * field holds a credential", but nothing promoted it into the hints — so a field
 * whose NAME does not look like one (`bearer`, `pat`) reached the Control UI
 * unmarked and rendered in a plain text box on first entry, before any saved
 * value had been redacted. An authored hint still wins: this only fills a gap.
 */
function withSecretInputHints(
  record: PluginManifestRegistry["plugins"][number],
): PluginUiMetadata["configUiHints"] {
  const paths = record.configContracts?.secretInputs?.paths ?? [];
  if (paths.length === 0) {
    return record.configUiHints;
  }
  const hints = { ...record.configUiHints };
  for (const { path } of paths) {
    // Two spellings, because the two readers match differently. The Knowledge
    // registration form looks a key up verbatim as `foundations[].apiKey`, while
    // the generic Settings form's `hintForPath` drops numeric segments and
    // wildcard-matches only keys containing `*` — so a bracket key never reaches
    // an array item there, and a `*` key never reaches the other. Emitting both
    // is what makes one declared secret masked on every surface.
    const resolved = secretInputHintPath(record.configSchema, path);
    if (!resolved) {
      // A path the schema closes off cannot name a real field, so a hint for it
      // would only claim a surface the plugin does not have.
      continue;
    }
    for (const key of new Set([resolved, path])) {
      if (hints[key]?.sensitive !== undefined) {
        continue;
      }
      hints[key] = { ...hints[key], sensitive: true };
    }
  }
  return hints;
}

/** Collects plugin config UI metadata with deterministic origin precedence and output ordering. */
export function collectPluginSchemaMetadata(registry: PluginManifestRegistry): PluginUiMetadata[] {
  const deduped = new Map<
    string,
    PluginUiMetadata & {
      originRank: number;
    }
  >();

  for (const record of registry.plugins) {
    const current = deduped.get(record.id);
    const nextRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    // Prefer the closest install origin when the same plugin id appears in multiple registries.
    if (current && current.originRank <= nextRank) {
      continue;
    }
    deduped.set(record.id, {
      id: record.id,
      name: record.name,
      description: record.description,
      configUiHints: withSecretInputHints(record),
      configSchema: record.configSchema,
      originRank: nextRank,
    });
  }

  return [...deduped.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...record }) => record);
}

/** Collects per-channel config metadata with the plugin that supplied the selected schema. */
export function collectChannelSchemaMetadataWithOwnership(
  registry: PluginManifestRegistry,
): ChannelSchemaMetadataWithOwnership[] {
  const byChannelId = new Map<string, ChannelMetadataRecord>();

  for (const record of registry.plugins) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    const rootLabel = record.channelCatalogMeta?.label;
    const rootDescription = record.channelCatalogMeta?.blurb;

    for (const channelId of record.channels) {
      const current = byChannelId.get(channelId);
      // Root channel catalog metadata can fill labels/descriptions before a channel-specific
      // config block appears, but it must not overwrite a closer-origin channel entry.
      if (!current || originRank <= current.originRank) {
        byChannelId.set(channelId, {
          id: channelId,
          label: rootLabel ?? current?.label,
          description: rootDescription ?? current?.description,
          configSchema: current?.configSchema,
          configUiHints: current?.configUiHints,
          schemaPluginId: current?.schemaPluginId,
          schemaPluginOrigin: current?.schemaPluginOrigin,
          originRank,
        });
      }
    }

    for (const [channelId, channelConfig] of Object.entries(record.channelConfigs ?? {})) {
      const current = byChannelId.get(channelId);
      if (
        current &&
        current.originRank < originRank &&
        (current.configSchema !== undefined || current.configUiHints !== undefined)
      ) {
        // A closer-origin channel config owns schema/UI hints even if a farther plugin also
        // advertises the same channel id.
        continue;
      }
      byChannelId.set(channelId, {
        id: channelId,
        label: channelConfig.label ?? rootLabel ?? current?.label,
        description: channelConfig.description ?? rootDescription ?? current?.description,
        configSchema: channelConfig.schema,
        configUiHints: channelConfig.uiHints as ChannelUiMetadata["configUiHints"],
        schemaPluginId: channelConfig.schema === undefined ? undefined : record.id,
        schemaPluginOrigin: channelConfig.schema === undefined ? undefined : record.origin,
        originRank,
      });
    }
  }

  return [...byChannelId.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...entry }) => entry);
}

/** Collects public per-channel config UI metadata without internal schema ownership. */
export function collectChannelSchemaMetadata(
  registry: PluginManifestRegistry,
): ChannelUiMetadata[] {
  return collectChannelSchemaMetadataWithOwnership(registry).map(
    ({ schemaPluginId: _schemaPluginId, schemaPluginOrigin: _schemaPluginOrigin, ...entry }) =>
      entry,
  );
}

/** Collects channel DM policy metadata without importing doctor/runtime command modules. */
export function collectChannelDmPolicyMetadata(
  registry: PluginManifestRegistry,
): ChannelDmPolicyMetadata[] {
  const byChannelId = new Map<string, ChannelDmPolicyMetadataRecord>();

  const put = (
    channelId: string | undefined,
    originRank: number,
    dmAllowFromMode?: ChannelDmAllowFromMode,
  ): void => {
    const id = channelId?.trim();
    if (!id) {
      return;
    }
    const current = byChannelId.get(id);
    if (current && current.originRank < originRank) {
      return;
    }
    byChannelId.set(id, {
      id,
      ...(dmAllowFromMode ? { dmAllowFromMode } : {}),
      originRank,
    });
  };

  for (const record of registry.plugins) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    const packageChannelId = record.packageChannel?.id?.trim();
    const dmAllowFromMode = record.packageChannel?.doctorCapabilities?.dmAllowFromMode;
    for (const channelId of record.channels) {
      put(channelId, originRank, channelId === packageChannelId ? dmAllowFromMode : undefined);
    }
    put(packageChannelId, originRank, dmAllowFromMode);
    for (const channelId of Object.keys(record.channelConfigs ?? {})) {
      put(channelId, originRank, channelId === packageChannelId ? dmAllowFromMode : undefined);
    }
  }

  return [...byChannelId.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...entry }) => entry);
}
