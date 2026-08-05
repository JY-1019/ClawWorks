// Control UI module implements chat model select state behavior.
import type { AppViewState } from "./app-view-state.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./chat-model-ref.ts";
import { pushUniqueTrimmedSelectOption } from "./select-options.ts";
import type { ModelCatalogEntry } from "./types.ts";

type ChatModelSelectStateInput = Pick<
  AppViewState,
  "sessionKey" | "chatModelOverrides" | "chatModelCatalog" | "sessionsResult"
>;

export type ChatModelSelectOption = {
  value: string;
  label: string;
  /** Provider the option belongs to; the picker groups by it. */
  provider: string;
};

/**
 * The provider half of a qualified `provider/model` value.
 *
 * Split on the FIRST separator only: a model id may contain slashes of its own
 * (`groq/openai/gpt-oss-120b` is provider `groq`), so splitting anywhere else
 * would invent a provider the catalog never had. A bare value carries no
 * provider and lands in the fallback group rather than one named "".
 */
const FALLBACK_PROVIDER_GROUP = "other";

function resolveOptionProvider(value: string): string {
  const separator = value.indexOf("/");
  if (separator <= 0) {
    return FALLBACK_PROVIDER_GROUP;
  }
  return value.slice(0, separator).trim() || FALLBACK_PROVIDER_GROUP;
}

export type ChatModelSelectState = {
  currentOverride: string;
  defaultModel: string;
  defaultDisplay: string;
  defaultLabel: string;
  options: ChatModelSelectOption[];
};

function resolveActiveSessionRow(state: ChatModelSelectStateInput) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const catalog = state.chatModelCatalog ?? [];

  // Prefer the local cache — it reflects in-flight patches before sessionsResult refreshes.
  const cached = state.chatModelOverrides[state.sessionKey];
  if (cached) {
    return normalizeChatModelOverrideValue(cached, catalog);
  }
  if (cached === null) {
    return "";
  }

  const activeRow = resolveActiveSessionRow(state);
  return resolvePreferredServerChatModelValue(activeRow?.model, activeRow?.modelProvider, catalog);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  return resolvePreferredServerChatModelValue(
    state.sessionsResult?.defaults?.model,
    state.sessionsResult?.defaults?.modelProvider,
    state.chatModelCatalog ?? [],
  );
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
  currentOverride: string,
  defaultModel: string,
): ChatModelSelectOption[] {
  const seen = new Set<string>();
  // The shared helper owns trimming and dedupe and yields {value,label}; the
  // provider is attached after so both stay in sync without forking it.
  const flat: { value: string; label: string }[] = [];

  const addOption = (value: string, label?: string) => {
    pushUniqueTrimmedSelectOption(flat, seen, value, (trimmed) => label ?? trimmed);
  };

  for (const entry of catalog) {
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    addOption(option.value, option.label);
  }

  if (currentOverride) {
    addOption(
      currentOverride,
      formatCatalogChatModelDisplayFromLookup(currentOverride, displayLookup),
    );
  }
  if (defaultModel) {
    addOption(defaultModel, formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup));
  }
  return flat.map((option) => ({
    value: option.value,
    label: option.label,
    provider: resolveOptionProvider(option.value),
  }));
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const catalog = state.chatModelCatalog ?? [];
  const displayLookup = buildCatalogDisplayLookup(catalog);
  const currentOverride = resolveChatModelOverrideValue(state);
  const defaultModel = resolveDefaultModelValue(state);
  const defaultDisplay = formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);

  return {
    currentOverride,
    defaultModel,
    defaultDisplay,
    defaultLabel: defaultModel ? `Default (${defaultDisplay})` : "Default model",
    options: buildChatModelOptions(catalog, displayLookup, currentOverride, defaultModel),
  };
}
