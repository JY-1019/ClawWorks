/**
 * Simple completion runtime preparation.
 *
 * Resolves agent model selection, auth, runtime policy, and missing-auth errors before simple completions run.
 */
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { completeSimple } from "../llm/stream.js";
import type {
  AssistantMessage,
  Model,
  ThinkingLevel as SimpleCompletionThinkingLevel,
} from "../llm/types.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { resolveModel, resolveModelAsync } from "./embedded-agent-runner/model.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import {
  applyLocalNoAuthHeaderOverride,
  formatMissingAuthError,
  getApiKeyForModel,
  type ResolvedProviderAuth,
} from "./model-auth.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { OPENAI_PROVIDER_ID, isOpenAIProvider } from "./openai-routing.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import { prepareModelForSimpleCompletion } from "./simple-completion-transport.js";

type SimpleCompletionAuthStorage = {
  setRuntimeApiKey: (provider: string, apiKey: string) => void;
};

type CompletionRuntimeCredential = {
  apiKey: string;
  model: Model;
};

type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];

export type SimpleCompletionModelOptions = {
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkLevel | SimpleCompletionThinkingLevel;
  signal?: AbortSignal;
};

/** Which half of preparation failed: placing the model, or resolving its credential. */
export type PreparedSimpleCompletionModelErrorStage = "model" | "auth";

export type PreparedSimpleCompletionModel =
  | {
      model: Model;
      auth: ResolvedProviderAuth;
    }
  | {
      error: string;
      stage?: PreparedSimpleCompletionModelErrorStage;
      auth?: ResolvedProviderAuth;
    };

export type AgentSimpleCompletionSelection = {
  provider: string;
  modelId: string;
  /** Provider used for auth/transport when runtime policy redirects the logical model ref. */
  runtimeProvider?: string;
  profileId?: string;
  agentDir: string;
};

export type PreparedSimpleCompletionModelForAgent =
  | {
      selection: AgentSimpleCompletionSelection;
      model: Model;
      auth: ResolvedProviderAuth;
    }
  | {
      error: string;
      /** Which half failed: the catalog placing the model, or its credential. */
      stage?: PreparedSimpleCompletionModelErrorStage;
      selection?: AgentSimpleCompletionSelection;
      auth?: ResolvedProviderAuth;
    };

export function resolveSimpleCompletionSelectionForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  /**
   * Resolve `modelRef` exactly as written: no agent aliases, and no falling back to
   * the agent's default model when it will not parse.
   *
   * For a caller whose model ref IS the statement of where a prompt may be sent —
   * the enterprise route planner, which overrides a privacy gate on the strength of
   * that statement — alias resolution and the default-model fallback are both ways
   * the prompt can end up at a provider nobody named. Refusing to resolve is the
   * safe answer there: the caller reports the router unavailable instead.
   */
  literalModelRef?: boolean;
}): AgentSimpleCompletionSelection | null {
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const modelRef =
    params.modelRef?.trim() || resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = params.literalModelRef
    ? undefined
    : buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
      });
  const resolved = split
    ? resolveModelRefFromString({
        raw: split.model,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        ...(aliasIndex ? { aliasIndex } : {}),
      })
    : null;
  if (params.literalModelRef && (!resolved?.ref.provider || !resolved.ref.model)) {
    return null;
  }
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    provider,
    modelId,
    ...resolveSimpleCompletionRuntimeProvider({
      cfg: params.cfg,
      agentId: params.agentId,
      provider,
      modelId,
    }),
    profileId: split?.profile || undefined,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
  };
}

function resolveSimpleCompletionRuntimeProvider(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
}): Pick<AgentSimpleCompletionSelection, "runtimeProvider"> {
  if (!isOpenAIProvider(params.provider)) {
    return {};
  }
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.cfg,
    agentId: params.agentId,
  });
  return policy.runtime === "codex" ? { runtimeProvider: OPENAI_PROVIDER_ID } : {};
}

async function setRuntimeApiKeyForCompletion(params: {
  authStorage: SimpleCompletionAuthStorage;
  model: Model;
  apiKey: string;
  authMode: ResolvedProviderAuth["mode"];
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  profileId?: string;
}): Promise<CompletionRuntimeCredential> {
  if (params.model.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("../plugin-sdk/provider-auth.js");
    const copilotToken = await resolveCopilotApiToken({
      githubToken: params.apiKey,
    });
    params.authStorage.setRuntimeApiKey(params.model.provider, copilotToken.token);
    return {
      apiKey: copilotToken.token,
      model: { ...params.model, baseUrl: copilotToken.baseUrl },
    };
  }
  const preparedAuth = await prepareProviderRuntimeAuth({
    provider: params.model.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      provider: params.model.provider,
      modelId: params.model.id,
      model: params.model,
      apiKey: params.apiKey,
      authMode: params.authMode,
      profileId: params.profileId,
    },
  });
  const runtimeApiKey = preparedAuth?.apiKey?.trim() || params.apiKey;
  params.authStorage.setRuntimeApiKey(params.model.provider, runtimeApiKey);
  return {
    apiKey: runtimeApiKey,
    model: applyPreparedRuntimeAuthToModel(params.model, preparedAuth),
  };
}

function hasMissingApiKeyAllowance(params: {
  mode: ResolvedProviderAuth["mode"];
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
}): boolean {
  return Boolean(params.allowMissingApiKeyModes?.includes(params.mode));
}

export async function prepareSimpleCompletionModel(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModel> {
  const resolved =
    params.useAsyncModelResolution || params.skipAgentDiscovery
      ? await (params.modelResolver ?? resolveModelAsync)(
          params.provider,
          params.modelId,
          params.agentDir,
          params.cfg,
          {
            ...(params.allowBundledStaticCatalogFallback !== undefined
              ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
              : {}),
            ...(params.skipAgentDiscovery ? { skipAgentDiscovery: true } : {}),
            authProfileId: params.profileId,
            preferredProfile: params.preferredProfile,
          },
        )
      : resolveModel(params.provider, params.modelId, params.agentDir, params.cfg, {
          authProfileId: params.profileId,
          preferredProfile: params.preferredProfile,
        });
  if (!resolved.model) {
    return {
      error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}`,
      // The catalog could not place the model. Distinguished from an auth failure so
      // a caller can retry against a colder, more expensive catalog without also
      // retrying a credential that is simply wrong.
      stage: "model",
    };
  }

  let auth: ResolvedProviderAuth;
  try {
    auth = await getApiKeyForModel({
      model: resolved.model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      profileId: params.profileId,
      preferredProfile: params.preferredProfile,
    });
  } catch (err) {
    return {
      error: `Auth lookup failed for provider "${resolved.model.provider}": ${formatErrorMessage(err)}`,
      stage: "auth",
    };
  }
  const rawApiKey = auth.apiKey?.trim();
  if (
    !rawApiKey &&
    !hasMissingApiKeyAllowance({
      mode: auth.mode,
      allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    })
  ) {
    return {
      error: formatMissingAuthError(auth, resolved.model.provider),
      auth,
      stage: "auth",
    };
  }

  let resolvedApiKey = rawApiKey;
  let resolvedModel = resolved.model;
  if (rawApiKey) {
    const runtimeCredential = await setRuntimeApiKeyForCompletion({
      authStorage: resolved.authStorage,
      model: resolved.model,
      apiKey: rawApiKey,
      authMode: auth.mode,
      cfg: params.cfg,
      workspaceDir: params.agentDir,
      profileId: auth.profileId,
    });
    resolvedApiKey = runtimeCredential.apiKey;
    resolvedModel = runtimeCredential.model;
  }

  const resolvedAuth: ResolvedProviderAuth = {
    ...auth,
    apiKey: resolvedApiKey,
  };

  return {
    model: applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
    auth: resolvedAuth,
  };
}

export async function prepareSimpleCompletionModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  /** See resolveSimpleCompletionSelectionForAgent: no aliases, no default fallback. */
  literalModelRef?: boolean;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModelForAgent> {
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelRef,
    ...(params.literalModelRef ? { literalModelRef: true } : {}),
  });
  if (!selection) {
    return {
      error: params.literalModelRef
        ? `Model ref "${params.modelRef ?? ""}" does not resolve to a provider/model on its own.`
        : `No model configured for agent ${params.agentId}.`,
    };
  }
  const prepared = await prepareSimpleCompletionModel({
    cfg: params.cfg,
    provider: selection.runtimeProvider ?? selection.provider,
    modelId: selection.modelId,
    agentDir: selection.agentDir,
    profileId: selection.profileId,
    preferredProfile: params.preferredProfile,
    allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    ...(params.allowBundledStaticCatalogFallback !== undefined
      ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
      : {}),
    useAsyncModelResolution: params.useAsyncModelResolution,
    skipAgentDiscovery: params.skipAgentDiscovery,
    modelResolver: params.modelResolver,
  });
  if ("error" in prepared) {
    return {
      ...prepared,
      selection,
    };
  }
  return {
    selection,
    model: prepared.model,
    auth: prepared.auth,
  };
}

export async function completeWithPreparedSimpleCompletionModel(params: {
  model: Model;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof completeSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
}): Promise<AssistantMessage> {
  const completionModel = prepareModelForSimpleCompletion({ model: params.model, cfg: params.cfg });
  const { reasoning: rawReasoning, ...options } = params.options ?? {};
  const reasoning = normalizeSimpleCompletionReasoning(rawReasoning);
  return await completeSimple(completionModel, params.context, {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
  });
}

function normalizeSimpleCompletionReasoning(
  reasoning: SimpleCompletionModelOptions["reasoning"],
): SimpleCompletionThinkingLevel | undefined {
  switch (reasoning) {
    case undefined:
    case "off":
      return undefined;
    case "adaptive":
      return "medium";
    case "max":
      return "xhigh";
    default:
      return reasoning;
  }
}
