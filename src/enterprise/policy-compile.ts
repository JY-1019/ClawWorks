/**
 * Natural-language -> governance-policy compilation.
 *
 * Turns an operator's plain-language intent ("refunds over $200 need approval")
 * into ONE structured GovernancePolicy they can review and paste into config.
 * Pure and provider-free, like @openclaw/enterprise-planner: the prompt inputs
 * and the parse/validate contract live here; the model call is injected by the
 * runtime (src/agents/enterprise-policy-compile.runtime.ts).
 *
 * This is an AUTHORING aid, not a runtime path. Nothing here mutates governance —
 * the operator confirms the suggestion and adds it to config, where the
 * deterministic policy engine enforces it. A model never gets a vote at run time.
 */
import { GovernancePolicySchema } from "./schema.js";
import { stripUnsafeDisplayChars } from "./text-safety.js";
import type { GovernancePolicy } from "./types.js";

export const POLICY_COMPILE_SYSTEM_PROMPT = [
  "You translate a governance intent into ONE structured ClawWorks governance policy.",
  "",
  "Return a JSON object with these fields:",
  '- "id": a dotted lowercase id you choose (e.g. "refund.approval").',
  '- "effect": one of "allow", "deny", "require_approval", "audit".',
  '- optional "description": one short human sentence.',
  '- optional selectors, each an array of glob strings: "trees", "nodes", "tools",',
  '  "actions", "knowledge". Include ONLY the selectors the intent constrains and',
  "  omit the rest; never invent a tool, action, tree, or node the intent does not",
  "  mention. Do not pass an empty array — omit the selector instead.",
  '  A "nodes" selector scopes the rule to those workflow steps: with a tools,',
  "  actions, or knowledge selector it narrows that rule to those steps; alone it is",
  "  a run-level rule that applies when one of those nodes is the workflow root.",
  '  In a selector "*" is the ONLY wildcard (never "?", character classes, or braces).',
  "  Selectors are matched like sandbox tool policies: case-insensitive, with tool aliases",
  '  and "group:<name>" expansion, so prefer canonical ids.',
  "",
  "Selectors are globs over ids only; a policy CANNOT express a numeric threshold",
  "or value condition. If the intent implies one (for example an amount limit),",
  "capture the closest representable scope and state the limitation in the description",
  "rather than silently dropping it.",
  '- optional "approval" ONLY with effect "require_approval": { "timeoutMs"?: number,',
  '  "timeoutBehavior"?: "allow"|"deny", "severity"?: "info"|"warning"|"critical" }.',
  "",
  'A "require_approval" policy MUST carry a "tools" or "actions" selector; run-level',
  "approval is not supported. Precedence is deny > require_approval > allow > audit.",
  "Pick the narrowest selectors that capture the intent.",
  "",
  "Your ENTIRE response must be exactly one JSON object. The first character must be {",
  "and the last must be }. No preamble, no explanation, no code fence.",
].join("\n");

/** Build the user turn. The intent is inert DATA, quoted so a crafted intent cannot pose as instructions. */
export function buildPolicyCompileUserPrompt(intent: string): string {
  return `Governance intent:\n${JSON.stringify(intent)}`;
}

export type PolicyCompileResult =
  | { kind: "compiled"; policy: GovernancePolicy }
  | { kind: "failed"; reason: string };

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * Parse a compile reply into a validated GovernancePolicy.
 *
 * Trusts ONLY a reply that IS the object (optionally inside one enclosing fence):
 * digging JSON out of surrounding prose would let a crafted intent echo a policy
 * back through the model. The shape is validated against the same schema config
 * uses, so a malformed suggestion fails here with a path rather than at paste time.
 */
export function parsePolicyCompileResponse(text: string): PolicyCompileResult {
  const stripped = stripJsonFence(text);
  if (!stripped.startsWith("{") || !stripped.endsWith("}")) {
    return { kind: "failed", reason: "model did not return a single JSON object" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { kind: "failed", reason: "model returned invalid JSON" };
  }
  const result = GovernancePolicySchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first
      ? `${first.path.map(String).join(".") || "(root)"}: ${first.message}`
      : "unknown";
    return { kind: "failed", reason: `compiled policy is not a valid governance policy: ${where}` };
  }
  // A nodes-only policy is kept: policyAppliesToRun (governance.ts) treats a
  // policy with no tools/actions/knowledge selector as run-level and applies it
  // when the plan root matches its nodes, so it is not a no-op. The compiler has no
  // tree here to check that, so it cannot second-guess the canonical evaluator.
  const policy = result.data as GovernancePolicy;
  // The model-authored description is reused verbatim as the run-time governance
  // decision reason and approval-prompt text once pasted into config (governance.ts),
  // so strip any control/bidi/separator char it carries here — at the compiler
  // boundary — rather than rejecting hand-authored config that may legitimately hold
  // newlines or emoji. Selectors are already rejected outright by the schema because
  // they are matched, not displayed.
  if (policy.description === undefined) {
    return { kind: "compiled", policy };
  }
  const description = stripUnsafeDisplayChars(policy.description).replace(/\s+/g, " ").trim();
  return {
    kind: "compiled",
    policy: description ? { ...policy, description } : stripDescription(policy),
  };
}

/** Drop an empty description so the run-time reason falls back to the generated text. */
function stripDescription(policy: GovernancePolicy): GovernancePolicy {
  const { description: _description, ...rest } = policy;
  return rest;
}
