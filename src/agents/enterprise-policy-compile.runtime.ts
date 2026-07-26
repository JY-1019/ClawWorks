/**
 * Model-backed governance-policy compiler: turn an operator's plain-language
 * intent into a structured GovernancePolicy for review.
 *
 * Lives in src/agents (not src/enterprise) so the enterprise core stays
 * provider-free; src/enterprise/policy-compile owns the prompt inputs and the
 * parse/validate contract. This is an AUTHORING tool an operator runs
 * deliberately, so it surfaces errors plainly (a human is waiting to read them)
 * rather than failing closed onto a default the way the route planner does.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildPolicyCompileUserPrompt,
  parsePolicyCompileResponse,
  POLICY_COMPILE_SYSTEM_PROMPT,
  type PolicyCompileResult,
} from "../enterprise/policy-compile.js";
import { redactSecrets } from "../logging/redact.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

const POLICY_COMPILE_MAX_TOKENS = 500;
// The ChatGPT/Codex Responses transport strips max_output_tokens, so the token cap is
// not enforced there. Bound the call locally instead: a deadline caps how long an
// errant reply can run, and a character cap rejects a reply too large to be one policy
// (~500 tokens is well under 8000 chars) before it is parsed or rendered.
const POLICY_COMPILE_TIMEOUT_MS = 60_000;
const POLICY_COMPILE_MAX_RESPONSE_CHARS = 8000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The ChatGPT/Codex Responses transport ("openai-chatgpt-responses") rejects a custom
// temperature, so it must be omitted for that model. Mirrors the sibling
// conversation-label-generator's isCodexSimpleCompletionModel check.
function isCodexResponsesModel(model: { api?: string }): boolean {
  return model.api === "openai-chatgpt-responses";
}

type PolicyCompileDeps = {
  prepareSimpleCompletionModelForAgent?: typeof prepareSimpleCompletionModelForAgent;
  completeWithPreparedSimpleCompletionModel?: typeof completeWithPreparedSimpleCompletionModel;
};

/** Compile a governance intent into a validated policy, or a plain failure reason. */
export async function compileGovernancePolicy(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  intent: string;
  /** Pin a model; omit to use the agent's default completion model. */
  modelRef?: string;
  /** With an explicit modelRef, allow a bundled static-catalog model (the local `model run` behavior). */
  allowStaticCatalogFallback?: boolean;
  signal?: AbortSignal;
  deps?: PolicyCompileDeps;
}): Promise<PolicyCompileResult> {
  const prepareModel =
    params.deps?.prepareSimpleCompletionModelForAgent ?? prepareSimpleCompletionModelForAgent;
  const complete =
    params.deps?.completeWithPreparedSimpleCompletionModel ??
    completeWithPreparedSimpleCompletionModel;

  // Result-only contract, like the route planner/reviewer: preparation and completion
  // can THROW (e.g. Microsoft Foundry's Entra token refresh throws on an `az` login
  // failure), so catch both and convert to a failed reason rather than letting the
  // exception escape past the compiler's terminal-sanitized failure path.
  let prepared: Awaited<ReturnType<typeof prepareModel>>;
  try {
    prepared = await prepareModel({
      cfg: params.cfg,
      agentId: params.agentId ?? "main",
      ...(params.modelRef ? { modelRef: params.modelRef } : {}),
      allowMissingApiKeyModes: ["aws-sdk"],
      ...(params.allowStaticCatalogFallback ? { allowBundledStaticCatalogFallback: true } : {}),
      skipAgentDiscovery: true,
    });
  } catch (err) {
    return { kind: "failed", reason: `could not prepare a completion model: ${errorText(err)}` };
  }
  if ("error" in prepared) {
    return { kind: "failed", reason: `no completion model available: ${prepared.error}` };
  }

  // Deadline the call so a transport that ignores the token cap cannot run unbounded;
  // combine it with any caller-supplied signal so external cancellation still works.
  const timeoutSignal = AbortSignal.timeout(POLICY_COMPILE_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  let result: Awaited<ReturnType<typeof complete>>;
  try {
    result = await complete({
      model: prepared.model,
      auth: prepared.auth,
      cfg: params.cfg,
      context: {
        systemPrompt: POLICY_COMPILE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildPolicyCompileUserPrompt(params.intent),
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens: POLICY_COMPILE_MAX_TOKENS,
        // The ChatGPT/Codex Responses transport rejects a custom temperature; every
        // other transport gets a deterministic 0 for stable, low-variance drafts.
        ...(isCodexResponsesModel(prepared.model) ? {} : { temperature: 0 }),
        signal,
      },
    });
  } catch (err) {
    return { kind: "failed", reason: `model call failed: ${errorText(err)}` };
  }

  // A provider that errored or was aborted can still return PARTIAL text with a
  // terminal stopReason (the OpenAI/Anthropic adapters preserve it). Parsing that would
  // report partial JSON as a compiled policy, or let partial prose mask the real fault.
  // Reject the terminal failure before looking at the text.
  const stopReason = (result as { stopReason?: unknown }).stopReason;
  if (stopReason === "error" || stopReason === "aborted") {
    const providerErrorMessage = (result as { errorMessage?: unknown }).errorMessage;
    const detail =
      typeof providerErrorMessage === "string" && providerErrorMessage.trim()
        ? `: ${providerErrorMessage.trim()}`
        : "";
    return {
      kind: "failed",
      reason: `model call did not complete (${String(stopReason)})${detail}`,
    };
  }
  // Only a clean "stop" is a finished reply (StopReason is stop|length|toolUse|error|
  // aborted). A "length" cut-off at the token cap can leave the JSON syntactically valid
  // but missing later selectors, so accepting it would compile a truncated policy.
  // Treat any other non-stop terminus the same. (undefined = a path that doesn't report
  // one; allow it, as the parse still validates the shape.)
  if (stopReason !== undefined && stopReason !== "stop") {
    return {
      kind: "failed",
      reason: `model reply did not finish cleanly (${String(stopReason)}); it may be truncated — retry with a shorter intent`,
    };
  }

  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  // Local size bound: one policy is small, so a reply this large means the token cap was
  // ignored (Codex transport) and the model ran away. Reject before parsing/rendering it.
  if (text.length > POLICY_COMPILE_MAX_RESPONSE_CHARS) {
    return {
      kind: "failed",
      reason: `model reply was too long (${text.length} chars); a policy is small — retry with a shorter intent`,
    };
  }
  if (!text) {
    // A provider error arrives as a result with no text blocks and an errorMessage,
    // not a throw; surface it so the operator sees an auth/quota/provider fault.
    const providerErrorMessage = (result as { errorMessage?: unknown }).errorMessage;
    const detail =
      typeof providerErrorMessage === "string" && providerErrorMessage.trim()
        ? `: ${providerErrorMessage.trim()}`
        : "";
    return { kind: "failed", reason: `model returned no text${detail}` };
  }

  const parsed = parsePolicyCompileResponse(text);
  if (parsed.kind === "failed") {
    // Bounded, redacted head of the reply so the operator can tell a wrong shape
    // from a refusal or a truncated answer.
    return {
      kind: "failed",
      reason: `${parsed.reason} (got ${text.length} chars: ${redactSecrets(text).slice(0, 200)})`,
    };
  }
  return parsed;
}
