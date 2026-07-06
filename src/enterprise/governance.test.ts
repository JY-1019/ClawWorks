import { describe, expect, it } from "vitest";
import { evaluateRunStartGovernance, evaluateToolCallGovernance } from "./governance.js";
import type { EnterprisePlanNode, EnterpriseRunPlan, GovernancePolicy } from "./types.js";

function planWith(node: Partial<EnterprisePlanNode>): {
  plan: EnterpriseRunPlan;
  node: EnterprisePlanNode;
} {
  const fullNode: EnterprisePlanNode = {
    nodeId: "support",
    parentId: null,
    seq: 0,
    title: "Support",
    ontology: {},
    ...node,
  };
  const plan: EnterpriseRunPlan = {
    runId: "run-1",
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "keywords",
    requestSummary: "help",
    nodes: [fullNode],
    activeNodeId: fullNode.nodeId,
    mode: "enforce",
    createdAt: 0,
  };
  return { plan, node: fullNode };
}

describe("evaluateToolCallGovernance", () => {
  it("allows by default when nothing restricts the tool", () => {
    const { plan, node } = planWith({});
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies: [] });
    expect(decision.effect).toBe("allow");
    expect(decision.source).toBe("default");
  });

  it("denies tools outside the ontology allowlist", () => {
    const { plan, node } = planWith({ ontology: { allowedTools: ["memory_search"] } });
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies: [] });
    expect(decision.effect).toBe("deny");
    expect(decision.source).toBe("ontology");
    expect(decision.reason).toContain('"exec"');
    expect(decision.reason).toContain('"support"');
  });

  it("denies ontology-denied tools even when also allowed", () => {
    const { plan, node } = planWith({
      ontology: { allowedTools: ["*"], deniedTools: ["exec"] },
    });
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies: [] });
    expect(decision.effect).toBe("deny");
  });

  it("applies deny policies scoped by tree/node/tool selectors", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "other.tree", effect: "deny", tools: ["exec"], trees: ["finance.*"] },
      { id: "this.tree", effect: "deny", tools: ["exec"], trees: ["acme.*"] },
    ];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("this.tree");
    expect(decision.source).toBe("policy");
  });

  it("lets deny win over allow regardless of declaration order", () => {
    const { plan, node } = planWith({});
    const allowFirst: GovernancePolicy[] = [
      { id: "allow.first", effect: "allow", tools: ["exec"] },
      { id: "deny.later", effect: "deny", tools: ["exec"] },
    ];
    const denyFirst = allowFirst.toReversed();
    for (const policies of [allowFirst, denyFirst]) {
      const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
      expect(decision.effect).toBe("deny");
      expect(decision.policyId).toBe("deny.later");
    }
  });

  it("lets allow beat audit when no deny matches", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "audit.exec", effect: "audit", tools: ["exec"] },
      { id: "allow.exec", effect: "allow", tools: ["exec"] },
    ];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("allow");
    expect(decision.policyId).toBe("allow.exec");
  });

  it("records audit policies without changing the outcome", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "audit.exec", effect: "audit", tools: ["exec"] }];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("audit");
    expect(decision.policyId).toBe("audit.exec");
  });

  it("falls back to a generated reason when a policy description is blank", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "deny.blank", effect: "deny", tools: ["exec"], description: "  " },
    ];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toBe('tool "exec" is denied by governance policy "deny.blank"');
  });

  it("ignores run-level policies (no tools selector) for tool calls", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "run.deny", effect: "deny", trees: ["acme.*"] }];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("allow");
  });

  it("ranks require_approval between deny and allow", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "allow.exec", effect: "allow", tools: ["exec"] },
      {
        id: "approve.exec",
        effect: "require_approval",
        tools: ["exec"],
        approval: { timeoutBehavior: "deny", severity: "critical" },
      },
    ];
    const approval = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(approval.effect).toBe("require_approval");
    expect(approval.policyId).toBe("approve.exec");
    expect(approval.approval).toEqual({ timeoutBehavior: "deny", severity: "critical" });

    const withDeny = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "exec",
      policies: [...policies, { id: "deny.exec", effect: "deny", tools: ["exec"] }],
    });
    expect(withDeny.effect).toBe("deny");
  });

  it("matches action selectors through the active node's ontology actions", () => {
    const { plan, node } = planWith({
      ontology: {
        actions: [{ id: "refund.issue", tools: ["message"] }, { id: "notes.write" }],
      },
    });
    const policies: GovernancePolicy[] = [
      { id: "approve.refunds", effect: "require_approval", actions: ["refund.*"] },
    ];
    // message is covered by refund.issue AND by the tool-less notes.write.
    expect(evaluateToolCallGovernance({ plan, node, toolName: "message", policies }).effect).toBe(
      "require_approval",
    );
    // exec is only covered by the tool-less action, which the selector misses.
    expect(evaluateToolCallGovernance({ plan, node, toolName: "exec", policies }).effect).toBe(
      "allow",
    );
    // Nodes without a matching action are unaffected.
    const bare = planWith({});
    expect(
      evaluateToolCallGovernance({
        plan: bare.plan,
        node: bare.node,
        toolName: "message",
        policies,
      }).effect,
    ).toBe("allow");
  });

  it("treats an empty action tool list as covering nothing (no match-all widening)", () => {
    // The schema rejects empty tool lists, but a programmatic policy with one
    // must not widen an action-scoped policy across the node.
    const { plan, node } = planWith({
      ontology: { actions: [{ id: "act.empty", tools: [] }] },
    });
    const policies: GovernancePolicy[] = [{ id: "deny.act", effect: "deny", actions: ["act.*"] }];
    expect(evaluateToolCallGovernance({ plan, node, toolName: "exec", policies }).effect).toBe(
      "allow",
    );
  });
});

describe("evaluateRunStartGovernance", () => {
  it("denies runs whose tree matches a run-level deny policy", () => {
    const { plan } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "run.deny", effect: "deny", trees: ["acme.*"] }];
    const decision = evaluateRunStartGovernance({ plan, policies });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("run.deny");
  });

  it("ignores tool-scoped policies at run start and allows by default", () => {
    const { plan } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "tool.deny", effect: "deny", tools: ["exec"] }];
    const decision = evaluateRunStartGovernance({ plan, policies });
    expect(decision.effect).toBe("allow");
    expect(decision.source).toBe("default");
  });

  it("honors node selectors on run-level policies", () => {
    const { plan } = planWith({});
    const missPolicies: GovernancePolicy[] = [
      { id: "run.deny.other", effect: "deny", trees: ["acme.*"], nodes: ["other.*"] },
    ];
    expect(evaluateRunStartGovernance({ plan, policies: missPolicies }).effect).toBe("allow");

    const hitPolicies: GovernancePolicy[] = [
      { id: "run.deny.support", effect: "deny", trees: ["acme.*"], nodes: ["support"] },
    ];
    const decision = evaluateRunStartGovernance({ plan, policies: hitPolicies });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("run.deny.support");
  });

  it("returns audit decisions for run-level audit policies", () => {
    const { plan } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "run.audit", effect: "audit", trees: ["acme.*"] }];
    const decision = evaluateRunStartGovernance({ plan, policies });
    expect(decision.effect).toBe("audit");
    expect(decision.policyId).toBe("run.audit");
    expect(decision.source).toBe("policy");
  });
});
