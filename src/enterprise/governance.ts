/**
 * Governance policy resolution and evaluation for enterprise-mode runs.
 * Two layers per decision: the active node's ontology scope, then
 * config-declared policies. Matching policies compose order-independently
 * with precedence deny > require_approval > allow > audit (deny-wins matches
 * repo tool-policy semantics; audit records without changing the outcome).
 */
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  EnterprisePlanNode,
  EnterpriseRunPlan,
  GovernanceDecision,
  GovernancePolicy,
  OntologyAction,
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

function hasSubjectSelectors(policy: GovernancePolicy): boolean {
  return Boolean(policy.tools?.length || policy.actions?.length);
}

/**
 * Ontology actions on the node that cover the called tool. An omitted
 * `tools` list means the action covers every tool; an empty list (which the
 * schema rejects, but guard programmatic policies) covers nothing rather than
 * widening to match-all via the empty-globs matcher.
 */
function actionsCoveringTool(node: EnterprisePlanNode, toolName: string): OntologyAction[] {
  return (node.ontology.actions ?? []).filter((action) => {
    if (action.tools === undefined) {
      return true;
    }
    return action.tools.length > 0 && matchesSelector(toolName, action.tools);
  });
}

function policyAppliesToToolCall(
  policy: GovernancePolicy,
  params: {
    treeId: string;
    node: EnterprisePlanNode;
    toolName: string;
    coveringActions: readonly OntologyAction[];
  },
): boolean {
  const toolScoped = Boolean(policy.tools?.length);
  const actionScoped = Boolean(policy.actions?.length);
  if (!toolScoped && !actionScoped) {
    // Selector-less policies target runs, not calls.
    return false;
  }
  if (toolScoped && !matchesSelector(params.toolName, policy.tools)) {
    return false;
  }
  if (
    actionScoped &&
    !params.coveringActions.some((action) => matchesSelector(action.id, policy.actions))
  ) {
    return false;
  }
  return (
    matchesSelector(params.treeId, policy.trees) &&
    matchesSelector(params.node.nodeId, policy.nodes)
  );
}

function policyAppliesToRun(
  policy: GovernancePolicy,
  params: { treeId: string; activeNodeId: string },
): boolean {
  if (hasSubjectSelectors(policy)) {
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

  const coveringActions = actionsCoveringTool(params.node, params.toolName);
  const matching = params.policies.filter((policy) =>
    policyAppliesToToolCall(policy, {
      treeId: params.plan.treeId,
      node: params.node,
      toolName: params.toolName,
      coveringActions,
    }),
  );
  const decision = resolvePolicyDecision(matching, () => `tool "${params.toolName}"`);
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

/**
 * Compose matching policies deny > require_approval > allow > audit,
 * order-independent.
 */
function resolvePolicyDecision(
  matching: readonly GovernancePolicy[],
  describeSubject: (policy: GovernancePolicy) => string,
): GovernanceDecision | null {
  const winner =
    matching.find((policy) => policy.effect === "deny") ??
    matching.find((policy) => policy.effect === "require_approval") ??
    matching.find((policy) => policy.effect === "allow") ??
    matching.find((policy) => policy.effect === "audit");
  if (!winner) {
    return null;
  }
  // Blank descriptions fall back to a generated reason so denial messages
  // and decision traces never surface empty text.
  const description = winner.description?.trim();
  const generated =
    winner.effect === "deny"
      ? `${describeSubject(winner)} is denied by governance policy "${winner.id}"`
      : winner.effect === "require_approval"
        ? `${describeSubject(winner)} requires approval by governance policy "${winner.id}"`
        : `${winner.effect === "allow" ? "allowed" : "audited"} by governance policy "${winner.id}"`;
  return {
    effect: winner.effect,
    policyId: winner.id,
    source: "policy",
    reason: description || generated,
    ...(winner.effect === "require_approval" && winner.approval
      ? { approval: winner.approval }
      : {}),
  };
}

/** Evaluate run-level governance for the selected tree before execution starts. */
export function evaluateRunStartGovernance(params: {
  plan: EnterpriseRunPlan;
  policies: readonly GovernancePolicy[];
}): GovernanceDecision {
  const runScope = { treeId: params.plan.treeId, activeNodeId: params.plan.activeNodeId };
  const matching = params.policies.filter((policy) => policyAppliesToRun(policy, runScope));
  const decision = resolvePolicyDecision(matching, () => `workflow tree "${params.plan.treeId}"`);
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
