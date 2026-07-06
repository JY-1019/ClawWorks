/**
 * Governance policy resolution and evaluation for enterprise-mode runs.
 * Slice 1 evaluates two layers per decision: the active node's ontology tool
 * scope, then config-declared policies. Matching policies compose deny-wins
 * regardless of declaration order (repo tool-policy semantics); allow beats
 * audit; audit records without changing the outcome.
 */
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  EnterprisePlanNode,
  EnterpriseRunPlan,
  GovernanceDecision,
  GovernancePolicy,
} from "./types.js";

/** Governance policies declared in config, in declaration order. */
export function resolveGovernancePolicies(config?: OpenClawConfig): GovernancePolicy[] {
  return config?.enterprise?.governance?.policies ?? [];
}

function matchesSelector(value: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) {
    return true;
  }
  // Reuse the repo tool-policy matcher for glob semantics (allow-list only).
  return isToolAllowedByPolicyName(value, { allow: [...globs] });
}

function policyAppliesToToolCall(
  policy: GovernancePolicy,
  params: { treeId: string; nodeId: string; toolName: string },
): boolean {
  if (!policy.tools || policy.tools.length === 0) {
    // Selector-less tool dimension means the policy targets runs, not calls.
    return false;
  }
  return (
    matchesSelector(params.toolName, policy.tools) &&
    matchesSelector(params.treeId, policy.trees) &&
    matchesSelector(params.nodeId, policy.nodes)
  );
}

function policyAppliesToRun(
  policy: GovernancePolicy,
  params: { treeId: string; activeNodeId: string },
): boolean {
  if (policy.tools && policy.tools.length > 0) {
    return false;
  }
  return (
    matchesSelector(params.treeId, policy.trees) &&
    matchesSelector(params.activeNodeId, policy.nodes)
  );
}

/** Evaluate governance for one tool call under the active plan node. */
export function evaluateToolCallGovernance(params: {
  plan: EnterpriseRunPlan;
  node: EnterprisePlanNode;
  toolName: string;
  policies: readonly GovernancePolicy[];
}): GovernanceDecision {
  const { ontology } = params.node;
  const ontologyScoped = Boolean(ontology.allowedTools?.length || ontology.deniedTools?.length);
  if (
    ontologyScoped &&
    !isToolAllowedByPolicyName(params.toolName, {
      ...(ontology.allowedTools ? { allow: [...ontology.allowedTools] } : {}),
      ...(ontology.deniedTools ? { deny: [...ontology.deniedTools] } : {}),
    })
  ) {
    return {
      effect: "deny",
      policyId: null,
      source: "ontology",
      reason: `tool "${params.toolName}" is outside the ontology tool scope of workflow step "${params.node.nodeId}"`,
    };
  }

  const matching = params.policies.filter((policy) =>
    policyAppliesToToolCall(policy, {
      treeId: params.plan.treeId,
      nodeId: params.node.nodeId,
      toolName: params.toolName,
    }),
  );
  const decision = resolvePolicyDecision(matching, (policy) =>
    policy.effect === "deny"
      ? `tool "${params.toolName}" is denied by governance policy "${policy.id}"`
      : `${policy.effect === "allow" ? "allowed" : "audited"} by governance policy "${policy.id}"`,
  );
  if (decision) {
    return decision;
  }
  return {
    effect: "allow",
    policyId: null,
    source: "default",
    reason: "no governance policy restricts this tool call",
  };
}

/** Compose matching policies deny-wins > allow > audit, order-independent. */
function resolvePolicyDecision(
  matching: readonly GovernancePolicy[],
  defaultReason: (policy: GovernancePolicy) => string,
): GovernanceDecision | null {
  const winner =
    matching.find((policy) => policy.effect === "deny") ??
    matching.find((policy) => policy.effect === "allow") ??
    matching.find((policy) => policy.effect === "audit");
  if (!winner) {
    return null;
  }
  // Blank descriptions fall back to the generated reason so denial messages
  // and decision traces never surface empty text.
  const description = winner.description?.trim();
  return {
    effect: winner.effect,
    policyId: winner.id,
    source: "policy",
    reason: description || defaultReason(winner),
  };
}

/** Evaluate run-level governance for the selected tree before execution starts. */
export function evaluateRunStartGovernance(params: {
  plan: EnterpriseRunPlan;
  policies: readonly GovernancePolicy[];
}): GovernanceDecision {
  const runScope = { treeId: params.plan.treeId, activeNodeId: params.plan.activeNodeId };
  const matching = params.policies.filter((policy) => policyAppliesToRun(policy, runScope));
  const decision = resolvePolicyDecision(matching, (policy) =>
    policy.effect === "deny"
      ? `workflow tree "${params.plan.treeId}" is denied by governance policy "${policy.id}"`
      : `${policy.effect === "allow" ? "allowed" : "audited"} by governance policy "${policy.id}"`,
  );
  if (decision) {
    return decision;
  }
  return {
    effect: "allow",
    policyId: null,
    source: "default",
    reason: "no governance policy restricts this workflow tree",
  };
}
