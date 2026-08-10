import { afterEach, describe, expect, it } from "vitest";
import {
  enterpriseRunAdmitsHostedTool,
  enterpriseRunBoundableMcpServers,
  enterpriseRunGovernsToolNames,
  enterpriseRunGrantedSkills,
} from "./active-runs.js";
import {
  clearEnterpriseActiveRunsForTest,
  enterpriseRunTracksSteps,
  evaluateEnterpriseToolCall,
  getEnterpriseActiveRun,
  getSessionActiveRunId,
  completeEnterpriseStep,
  enterpriseRunActiveStep,
  recordEnterpriseApprovalResolution,
  recordEnterpriseRunSteer,
  reopenEnterpriseStep,
  enterpriseRunAttachedMcpServers,
  adoptEnterpriseActiveRunSessionId,
  registerEnterpriseActiveRun,
  resolveEnterpriseMcpServers,
  resolveEnterpriseMode,
  unregisterEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "./runtime.js";
import type { EnterprisePlanNode, EnterpriseRunPlan, GovernancePolicy } from "./types.js";

function makeRun(overrides: {
  runId?: string;
  sessionId?: string;
  mode?: "enforce" | "observe";
  allowedTools?: string[];
  deniedTools?: string[];
  mcpServers?: string[];
  registeredMcpServers?: string[];
  actions?: { id: string; description: string; tools?: string[] }[];
  mcpGoverned?: boolean;
  capabilityGrants?: "explicit";
  skills?: string[];
  audit?: boolean;
  policies?: GovernancePolicy[];
  sink?: EnterpriseActiveRun["sink"];
}): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId: overrides.runId ?? "run-1",
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "planner",
    requestSummary: "help",
    nodes: [
      {
        nodeId: "support",
        parentId: null,
        seq: 0,
        title: "Support",
        ontology: {
          ...(overrides.allowedTools ? { allowedTools: overrides.allowedTools } : {}),
          ...(overrides.deniedTools ? { deniedTools: overrides.deniedTools } : {}),
          ...(overrides.mcpServers ? { mcpServers: overrides.mcpServers } : {}),
          ...(overrides.skills ? { skills: overrides.skills } : {}),
          ...(overrides.actions ? { actions: overrides.actions } : {}),
          ...(overrides.audit !== undefined ? { audit: overrides.audit } : {}),
        },
      },
    ],
    activeNodeId: "support",
    // The plan carries the DEFINITION-wide facts; the node lists mirror them here
    // exactly as buildEnterpriseRunPlan does.
    ...(overrides.mcpGoverned || overrides.capabilityGrants
      ? {
          mcpGoverned: true,
          mcpAttachments: overrides.mcpServers ?? [],
          ...(overrides.deniedTools ? { mcpDeniedTools: overrides.deniedTools } : {}),
        }
      : {}),
    ...(overrides.capabilityGrants
      ? { capabilityGrants: overrides.capabilityGrants, grantedSkills: overrides.skills ?? [] }
      : {}),
    mode: overrides.mode ?? "enforce",
    createdAt: 0,
  };
  return {
    plan,
    policies: overrides.policies ?? [],
    ...((overrides.registeredMcpServers ?? overrides.mcpServers)
      ? { mcpServers: overrides.registeredMcpServers ?? overrides.mcpServers }
      : {}),
    ...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.sink ? { sink: overrides.sink } : {}),
  };
}

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
});

describe("resolveEnterpriseMode", () => {
  it("defaults to enforce, including with no config at all", () => {
    expect(resolveEnterpriseMode(undefined)).toBe("enforce");
    expect(resolveEnterpriseMode({})).toBe("enforce");
  });

  it("honors explicit config modes", () => {
    expect(resolveEnterpriseMode({ enterprise: { mode: "observe" } })).toBe("observe");
    expect(resolveEnterpriseMode({ enterprise: { mode: "off" } })).toBe("off");
  });
});

describe("evaluateEnterpriseToolCall", () => {
  it("returns undefined for unmediated runs", () => {
    expect(evaluateEnterpriseToolCall({ runId: "unknown", toolName: "exec" })).toBeUndefined();
    expect(evaluateEnterpriseToolCall({ toolName: "exec" })).toBeUndefined();
  });

  it("gates an out-of-scope tool behind approval in enforce mode and records it", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({
      runId: "run-1",
      toolName: "exec",
      toolCallId: "call-1",
    });
    // An allow-list omission asks a human rather than failing the call outright;
    // nothing runs until that approval resolves, and it fails closed if nobody
    // answers.
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.requiresApproval).toBe(true);
    expect(verdict?.decision.effect).toBe("require_approval");
    expect(verdict?.nodeId).toBe("support");
    // Approval-gated calls are recorded once the human decision resolves, so the
    // gate itself writes nothing here.
    expect(events).toHaveLength(0);
  });

  it("records but does not gate out-of-scope calls in observe mode", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        mode: "observe",
        allowedTools: ["memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.requiresApproval).toBe(false);
    expect(verdict?.decision.effect).toBe("require_approval");
    expect(events[0]).toMatchObject({ effect: "require_approval", enforced: false });
  });

  it("allows in-scope tools without tracing default allows", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["exec", "memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.decision.effect).toBe("allow");
    // Stock path: no per-tool-call trace writes for default allows.
    expect(events).toHaveLength(0);
  });

  it("traces default allows when the node opts into ontology.audit", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        audit: true,
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.decision.effect).toBe("allow");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ effect: "allow", enforced: false });
  });

  it("fails closed in enforce mode when the plan is corrupt", () => {
    const run = makeRun({});
    run.plan.activeNodeId = "missing.node";
    registerEnterpriseActiveRun(run);
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(true);
    expect(verdict?.decision.reason).toContain("enterprise governance evaluation failed");
  });

  it("fails open in observe mode when the plan is corrupt", () => {
    const run = makeRun({ mode: "observe" });
    run.plan.activeNodeId = "missing.node";
    registerEnterpriseActiveRun(run);
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
  });

  it("never throws when the sink throws", () => {
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["memory_search"],
        sink: () => {
          throw new Error("sink boom");
        },
      }),
    );
    expect(() => evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" })).not.toThrow();
  });

  it("marks require_approval verdicts for enforce mode without pre-recording", () => {
    const events: Array<Record<string, unknown>> = [];
    const approvalPolicies: GovernancePolicy[] = [
      {
        id: "approve.exec",
        effect: "require_approval",
        tools: ["exec"],
        approval: { severity: "critical" },
      },
    ];
    registerEnterpriseActiveRun(
      makeRun({
        policies: approvalPolicies,
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.requiresApproval).toBe(true);
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.decision.approval).toEqual({ severity: "critical" });
    // The gate records the decision once the human resolution settles.
    expect(events).toHaveLength(0);

    recordEnterpriseApprovalResolution({
      runId: "run-1",
      verdict: verdict!,
      toolName: "exec",
      toolCallId: "call-9",
      outcome: "approved",
      resolution: "allow-once",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      effect: "require_approval",
      approved: true,
      enforced: false,
      resolution: "allow-once",
      toolCallId: "call-9",
      policyId: "approve.exec",
    });

    recordEnterpriseApprovalResolution({
      runId: "run-1",
      verdict: verdict!,
      toolName: "exec",
      outcome: "denied",
      resolution: "deny",
    });
    expect(events[1]).toMatchObject({
      effect: "require_approval",
      approved: false,
      enforced: true,
      resolution: "deny",
    });
  });

  it("records require_approval decisions immediately in observe mode", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        mode: "observe",
        policies: [{ id: "approve.exec", effect: "require_approval", tools: ["exec"] }],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.requiresApproval).toBe(false);
    expect(verdict?.blocked).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ effect: "require_approval", enforced: false });
  });

  it("stops gating after unregistering", () => {
    registerEnterpriseActiveRun(makeRun({ allowedTools: ["memory_search"] }));
    expect(getEnterpriseActiveRun("run-1")).toBeDefined();
    unregisterEnterpriseActiveRun("run-1");
    expect(evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" })).toBeUndefined();
  });
});

describe("session → active run index", () => {
  it("resolves the run a session is executing, and clears it on end", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-1", sessionId: "session-a" }));
    expect(getSessionActiveRunId("session-a")).toBe("run-1");
    unregisterEnterpriseActiveRun("run-1");
    expect(getSessionActiveRunId("session-a")).toBeUndefined();
  });

  it("indexes nothing for a run with no session", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-1" }));
    expect(getSessionActiveRunId("session-a")).toBeUndefined();
  });

  it("follows a transcript rotation, moving the run and its link", () => {
    // Overflow/compaction rotates the transcript mid-run. The run holds a COPY
    // of the id and publishes it on every live step event, so a stale copy makes
    // the UI reject its own run's progress.
    const run = makeRun({ runId: "run-1", sessionId: "session-a" });
    registerEnterpriseActiveRun(run);
    adoptEnterpriseActiveRunSessionId("run-1", "session-b");
    expect(run.sessionId).toBe("session-b");
    expect(getSessionActiveRunId("session-b")).toBe("run-1");
    expect(getSessionActiveRunId("session-a")).toBeUndefined();
  });

  it("leaves the old link alone when a newer run already owns it", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-1", sessionId: "session-a" }));
    registerEnterpriseActiveRun(makeRun({ runId: "run-2", sessionId: "session-a" }));
    adoptEnterpriseActiveRunSessionId("run-1", "session-b");
    expect(getSessionActiveRunId("session-a")).toBe("run-2");
    expect(getSessionActiveRunId("session-b")).toBe("run-1");
  });

  it("ignores rotation for an unknown or unchanged run", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-1", sessionId: "session-a" }));
    adoptEnterpriseActiveRunSessionId("missing", "session-b");
    adoptEnterpriseActiveRunSessionId("run-1", "session-a");
    expect(getSessionActiveRunId("session-a")).toBe("run-1");
    expect(getSessionActiveRunId("session-b")).toBeUndefined();
  });

  it("keeps the successor's link when the prior run ends out of order", () => {
    // Run end runs outside the session lane, so the next turn's run can begin (and
    // re-point the session) before the previous one ends. The stale end must not
    // clear the successor's link.
    registerEnterpriseActiveRun(makeRun({ runId: "run-1", sessionId: "session-a" }));
    registerEnterpriseActiveRun(makeRun({ runId: "run-2", sessionId: "session-a" }));
    expect(getSessionActiveRunId("session-a")).toBe("run-2");
    unregisterEnterpriseActiveRun("run-1");
    expect(getSessionActiveRunId("session-a")).toBe("run-2");
    unregisterEnterpriseActiveRun("run-2");
    expect(getSessionActiveRunId("session-a")).toBeUndefined();
  });
});

type SinkEvent = { kind: string; nodeId: string | null; payload: Record<string, unknown> };

function leaf(nodeId: string, seq: number, title: string): EnterprisePlanNode {
  return { nodeId, parentId: "support", seq, title, ontology: {} };
}

function makeGovernedRun(
  sink?: (event: SinkEvent) => void,
  opts: { rootAudit?: boolean; activeNodeId?: string } = {},
): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId: "run-steps",
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "planner",
    requestSummary: "help",
    nodes: [
      {
        nodeId: "support",
        parentId: null,
        seq: 0,
        title: "Support",
        ontology: {
          allowedTools: ["memory_search", "message"],
          ...(opts.rootAudit ? { audit: true } : {}),
        },
      },
      leaf("support.triage", 1, "Triage"),
      leaf("support.resolve", 2, "Resolve"),
    ],
    // A step-tracking plan opens ON its first step, as buildEnterpriseRunPlan
    // does; the override exercises the root cursor a policy-only run gets.
    activeNodeId: opts.activeNodeId ?? "support.triage",
    mode: "enforce",
    createdAt: 0,
  };
  return { plan, policies: [], ...(sink ? { sink } : {}) };
}

describe("enterpriseRunTracksSteps", () => {
  it("is true for governed multi-step runs and false for unknown runs", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    expect(enterpriseRunTracksSteps("run-steps")).toBe(true);
    expect(enterpriseRunTracksSteps("nope")).toBe(false);
  });

  it("is false for a guidance-free single-node run", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-1" }));
    expect(enterpriseRunTracksSteps("run-1")).toBe(false);
  });

  it("is true for a guidance-free multi-leaf run when a policy targets a node", () => {
    const run = makeGovernedRun();
    // Strip ontology guidance so only the node-scoped policy justifies tracking.
    run.plan.nodes[0].ontology = {};
    run.policies = [
      { id: "deny.leaf.exec", effect: "deny", tools: ["exec"], nodes: ["support.resolve"] },
    ];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunTracksSteps("run-steps")).toBe(true);
  });

  it("ignores node-scoped policies whose node globs match nothing here", () => {
    const run = makeGovernedRun();
    run.plan.nodes[0].ontology = {};
    // The tree matches, but the glob names a node this plan does not contain, so
    // the policy can never fire — advancing for it would buy nothing, and an
    // exporter judging relevance would disagree with this predicate.
    run.policies = [
      { id: "deny.absent.node", effect: "deny", tools: ["exec"], nodes: ["support.nowhere"] },
    ];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunTracksSteps("run-steps")).toBe(false);
  });

  it("ignores node-scoped policies whose action selector matches nothing here", () => {
    const run = makeGovernedRun();
    run.plan.nodes[0].ontology = {};
    // Same rule as the node glob above, applied to the other selector. The bundle
    // exporter judges relevance with this very predicate, so a policy counted
    // here and dropped there would silently change whether the imported work-map
    // advances through its steps at all.
    run.policies = [
      {
        id: "deny.absent.action",
        effect: "deny",
        tools: ["exec"],
        nodes: ["support.*"],
        actions: ["support.nowhere"],
      },
    ];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunTracksSteps("run-steps")).toBe(false);
  });

  it("ignores node-scoped policies whose tree selector cannot match this run", () => {
    const run = makeGovernedRun();
    run.plan.nodes[0].ontology = {};
    // Policy is pinned to a different tree, so it can never apply here; the run
    // must stay write-quiet rather than install the hook for nothing.
    run.policies = [
      {
        id: "deny.other.tree",
        effect: "deny",
        tools: ["exec"],
        nodes: ["support.resolve"],
        trees: ["finance.*"],
      },
    ];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunTracksSteps("run-steps")).toBe(false);
  });
});

describe("enterprise step cursor", () => {
  it("advances one step per completion, tracing completed then entered", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));

    expect(enterpriseRunActiveStep("run-steps")).toMatchObject({
      nodeId: "support.triage",
      ordinal: 1,
      total: 2,
    });
    const advance = completeEnterpriseStep({ runId: "run-steps", summary: "classified" });
    expect(advance).toMatchObject({
      kind: "advanced",
      completed: { nodeId: "support.triage" },
      next: { nodeId: "support.resolve", ordinal: 2, total: 2 },
    });
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");
    expect(events.map((event) => `${event.kind}:${event.nodeId}`)).toEqual([
      "node.completed:support.triage",
      "node.entered:support.resolve",
    ]);
    // The model's account of the step is what makes the trace a record of the
    // WORK rather than only of the transition.
    expect(events[0].payload).toMatchObject({ seq: 1, title: "Triage", summary: "classified" });
  });

  it("anchors both ends of a step to the transcript so its span is explicit", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));

    // The single complete_step row closes triage AND opens resolve, so the same
    // id is the END of triage and the START of resolve. Recording it on both is
    // what turns "which node does a transcript row belong to" from a timestamp
    // guess into an exact span lookup.
    completeEnterpriseStep({ runId: "run-steps", toolCallId: "call-boundary" });
    const completed = events.find((event) => event.kind === "node.completed");
    const entered = events.find((event) => event.kind === "node.entered");
    expect(completed?.payload).toMatchObject({ toolCallId: "call-boundary" });
    expect(entered?.payload).toMatchObject({ toolCallId: "call-boundary" });
  });

  it("gives an entered-but-uncompleted step a start anchor to attribute its work", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));

    // Advance INTO resolve, then stop — the model never completes it. This is the
    // abandoned/interrupted-route shape (entered, no node.completed). Its work
    // still lives in the transcript, so it must resolve to a node: the entered
    // anchor is the only thing that can place it.
    completeEnterpriseStep({ runId: "run-steps", toolCallId: "call-into-resolve" });
    const enteredResolve = events.find(
      (event) => event.kind === "node.entered" && event.nodeId === "support.resolve",
    );
    const completedResolve = events.find(
      (event) => event.kind === "node.completed" && event.nodeId === "support.resolve",
    );
    expect(completedResolve).toBeUndefined();
    expect(enteredResolve?.payload).toMatchObject({ toolCallId: "call-into-resolve" });
  });

  it("omits the entered anchor when the advancing call carried none", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));

    // The loopback path drops its private id before it reaches here, so a step
    // entered without one carries no anchor rather than a join that matches
    // nothing — the same rule the completion anchor already follows.
    completeEnterpriseStep({ runId: "run-steps" });
    const entered = events.find((event) => event.kind === "node.entered");
    expect(entered?.payload).not.toHaveProperty("toolCallId");
  });

  it("stays on a step until it is completed, however many turns that takes", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    // Nothing but a completion moves the cursor: this is the whole point of the
    // tool-driven cursor over the turn counter it replaced.
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.triage");
    expect(enterpriseRunActiveStep("run-steps")?.nodeId).toBe("support.triage");
  });

  it("reports the route complete on the last step and leaves the cursor there", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(
      makeGovernedRun((event) => events.push(event), { activeNodeId: "support.resolve" }),
    );
    expect(completeEnterpriseStep({ runId: "run-steps" })).toMatchObject({
      kind: "route-complete",
      completed: { nodeId: "support.resolve" },
    });
    // Dropping back to the root would widen the scope the run finishes under.
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");
    expect(events.filter((event) => event.kind === "node.entered")).toHaveLength(0);
  });

  it("does not re-close a route that is already complete", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(
      makeGovernedRun((event) => events.push(event), { activeNodeId: "support.resolve" }),
    );
    completeEnterpriseStep({ runId: "run-steps" });
    events.length = 0;
    expect(completeEnterpriseStep({ runId: "run-steps" })).toMatchObject({
      kind: "already-complete",
    });
    expect(events).toHaveLength(0);
  });

  it("refuses to advance when the caller names a step the run is not on", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    const advance = completeEnterpriseStep({
      runId: "run-steps",
      expectedNodeId: "support.resolve",
    });
    expect(advance).toMatchObject({
      kind: "wrong-step",
      active: { nodeId: "support.triage", ordinal: 1 },
    });
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.triage");
  });

  it("enters the first step from a root cursor without completing the container", () => {
    const events: SinkEvent[] = [];
    // A policy-only tracking run opens on the root, which is a scope container
    // and did no work — so the first advance enters step 1 and completes nothing.
    const run = makeGovernedRun((event) => events.push(event), { activeNodeId: "support" });
    registerEnterpriseActiveRun(run);
    expect(completeEnterpriseStep({ runId: "run-steps" })).toMatchObject({
      kind: "advanced",
      completed: null,
      next: { nodeId: "support.triage" },
    });
    expect(events.map((event) => event.kind)).toEqual(["node.entered"]);
  });

  it("redacts a model-authored step summary before it reaches the trace", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    // The summary is model text that can quote a credential straight out of the
    // prompt or a tool result, and it is persisted and rendered to operators.
    completeEnterpriseStep({
      runId: "run-steps",
      summary: "used key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL to call it",
    });
    const summary = events[0]?.payload.summary;
    expect(typeof summary).toBe("string");
    expect(summary).not.toContain("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL");
  });

  it("bounds a step summary so the trace cannot become a transcript sink", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    completeEnterpriseStep({ runId: "run-steps", summary: "x".repeat(5000) });
    const summary = events[0]?.payload.summary;
    expect(typeof summary === "string" ? summary.length : -1).toBeLessThanOrEqual(300);
  });

  it("refuses runs it cannot advance instead of throwing", () => {
    expect(completeEnterpriseStep({ runId: "nope" })).toEqual({ kind: "unmediated" });
    registerEnterpriseActiveRun(makeRun({ runId: "run-1" }));
    expect(completeEnterpriseStep({ runId: "run-1" })).toEqual({ kind: "no-steps" });
    expect(enterpriseRunActiveStep("run-1")).toBeNull();
  });

  it("scopes the gate to the active leaf's ancestor path", () => {
    registerEnterpriseActiveRun(makeGovernedRun(undefined, { activeNodeId: "support.triage" }));
    // On the first leaf: the root allows only memory_search/message, so an
    // out-of-scope tool is gated under the leaf's INHERITED path — and the reason
    // names the ancestor that narrowed it, not the leaf standing on it.
    const verdict = evaluateEnterpriseToolCall({ runId: "run-steps", toolName: "exec" });
    expect(verdict?.nodeId).toBe("support.triage");
    expect(verdict?.requiresApproval).toBe(true);
    expect(verdict?.decision.reason).toContain('workflow step "support"');
  });

  it("keeps recording default allows under a leaf when the root opts into audit", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(
      makeGovernedRun((event) => events.push(event), {
        rootAudit: true,
        activeNodeId: "support.triage",
      }),
    );
    // The active leaf is audit-free, but the root audit setting is inherited
    // down the path, so default allows are still traced.
    const verdict = evaluateEnterpriseToolCall({ runId: "run-steps", toolName: "message" });
    expect(verdict?.decision.effect).toBe("allow");
    expect(verdict?.decision.source).toBe("default");
    const decisions = events.filter((event) => event.kind === "governance.decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].nodeId).toBe("support.triage");
  });
});

describe("enterprise step reopen", () => {
  afterEach(() => {
    clearEnterpriseActiveRunsForTest();
  });

  it("moves the cursor back onto a completed step and traces both ends", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    completeEnterpriseStep({ runId: "run-steps" });
    events.length = 0;

    const reopen = reopenEnterpriseStep({
      runId: "run-steps",
      nodeId: "support.triage",
      reason: "the operator says triage picked the wrong category",
    });

    expect(reopen).toMatchObject({
      kind: "reopened",
      from: { nodeId: "support.resolve" },
      to: { nodeId: "support.triage", ordinal: 1 },
    });
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.triage");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "node.reopened",
      nodeId: "support.triage",
      // Both ends, because "reopened triage" alone cannot say how far the run had
      // already got when the correction arrived.
      payload: { from: "support.resolve" },
    });
  });

  it("records every step from the target onward as invalidated", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    completeEnterpriseStep({ runId: "run-steps" });
    events.length = 0;
    reopenEnterpriseStep({ runId: "run-steps", nodeId: "support.triage" });

    // The suffix goes with the target: work built ON a step the operator called
    // wrong is stale too, and resume needs the completed set to stay a prefix.
    expect(events[0]?.payload.invalidated).toEqual(["support.triage", "support.resolve"]);
  });

  it("stops going back once the run has spent its reopen budget", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    // Forward advancement is bounded by the route length; going back is not, so a
    // model that keeps second-guessing would loop until the turn limit instead of
    // ever answering.
    let outcome = reopenEnterpriseStep({ runId: "run-steps", nodeId: "support.triage" });
    for (let attempt = 0; attempt < 20 && outcome.kind !== "exhausted"; attempt++) {
      completeEnterpriseStep({ runId: "run-steps" });
      outcome = reopenEnterpriseStep({ runId: "run-steps", nodeId: "support.triage" });
    }
    expect(outcome).toMatchObject({ kind: "exhausted", limit: 10 });
    // A refused reopen moves nothing: the cursor stays where the last accepted
    // move left it, so the run finishes its route rather than being stranded by
    // its own budget.
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");
  });

  it("refuses a forward jump so a step cannot claim scope without doing its work", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    expect(reopenEnterpriseStep({ runId: "run-steps", nodeId: "support.resolve" })).toMatchObject({
      kind: "not-behind",
      active: { nodeId: "support.triage", ordinal: 1 },
    });
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.triage");
  });

  it("refuses the step the run is already on while the route is still open", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    expect(reopenEnterpriseStep({ runId: "run-steps", nodeId: "support.triage" })).toMatchObject({
      kind: "not-behind",
    });
  });

  it("reopens the final step of a finished route and lets it be closed again", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    completeEnterpriseStep({ runId: "run-steps" });
    expect(completeEnterpriseStep({ runId: "run-steps" })).toMatchObject({
      kind: "route-complete",
    });

    // The cursor parks on the last step after finishing it, so reopening THAT step
    // is a backward move even though the ids match — this is the correction path
    // for a run whose final answer was wrong.
    expect(reopenEnterpriseStep({ runId: "run-steps", nodeId: "support.resolve" })).toMatchObject({
      kind: "reopened",
      to: { nodeId: "support.resolve" },
    });
    expect(getEnterpriseActiveRun("run-steps")?.routeCompleted).toBe(false);
    expect(completeEnterpriseStep({ runId: "run-steps" })).toMatchObject({
      kind: "route-complete",
    });
  });

  it("names the route's own steps back when the caller invents an id", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    completeEnterpriseStep({ runId: "run-steps" });
    expect(reopenEnterpriseStep({ runId: "run-steps", nodeId: "support.nope" })).toMatchObject({
      kind: "unknown-step",
      steps: ["support.triage", "support.resolve"],
    });
  });

  it("redacts the reason before it reaches the trace", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    completeEnterpriseStep({ runId: "run-steps" });
    events.length = 0;
    reopenEnterpriseStep({
      runId: "run-steps",
      nodeId: "support.triage",
      reason: "retry with sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL instead",
    });
    expect(events[0]?.payload.reason).not.toContain(
      "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL",
    );
  });

  it("stays silent on a run it does not govern", () => {
    expect(reopenEnterpriseStep({ runId: "nope", nodeId: "support.triage" })).toEqual({
      kind: "unmediated",
    });
  });
});

describe("recordEnterpriseRunSteer", () => {
  afterEach(() => {
    clearEnterpriseActiveRunsForTest();
  });

  it("attributes a human steer to the step the run is standing on", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    completeEnterpriseStep({ runId: "run-steps" });
    events.length = 0;

    recordEnterpriseRunSteer({
      runId: "run-steps",
      text: "actually check the refund window first",
      origin: "user",
    });

    expect(events).toEqual([
      {
        kind: "run.steered",
        nodeId: "support.resolve",
        payload: { origin: "user", summary: "actually check the refund window first" },
      },
    ]);
  });

  it("marks runtime traffic apart from an operator's instruction", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    recordEnterpriseRunSteer({ runId: "run-steps", text: "subagent finished", origin: "runtime" });
    expect(events[0]?.payload.origin).toBe("runtime");
  });

  it("records a run-scoped steer with no step when the run walks none", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-flat", sink: (event) => events.push(event) }),
    );
    recordEnterpriseRunSteer({ runId: "run-flat", text: "hold on", origin: "user" });
    expect(events[0]).toMatchObject({ kind: "run.steered", nodeId: null });
  });

  it("redacts steer text before it reaches the trace", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    // User-authored and persisted to enterprise_run_events, so it gets the same
    // treatment as every other free text on the trace.
    recordEnterpriseRunSteer({
      runId: "run-steps",
      text: "use sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL for this",
      origin: "user",
    });
    expect(events[0]?.payload.summary).not.toContain(
      "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL",
    );
  });

  it("stays silent on a run it does not govern", () => {
    expect(() =>
      recordEnterpriseRunSteer({ runId: "nope", text: "hello", origin: "user" }),
    ).not.toThrow();
  });
});

describe("enterpriseRunAttachedMcpServers", () => {
  it("does not filter a work-map that never attaches a server", () => {
    // Upgrade safety: a tree written before the field existed keeps every server.
    registerEnterpriseActiveRun(makeRun({ runId: "run-mcp-legacy" }));

    expect(enterpriseRunAttachedMcpServers("run-mcp-legacy")).toBeNull();
  });

  it("keeps a server whose only denial cannot reach it", () => {
    // Losing an attached server over an unrelated `slack*` rule would make the two
    // features unusable together.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-unrelated",
        mcpGoverned: true,
        mcpServers: ["github"],
        deniedTools: ["slack*__delete_channel"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-unrelated") ?? [])]).toEqual(["github"]);
  });

  it("withholds a server for a whole-call glob with no delimiter", () => {
    // `*forbidden` matches whole call names, so it can reach inside any server —
    // and a native runtime can rewrite the name past matching it later.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-suffix",
        mcpGoverned: true,
        mcpServers: ["github"],
        deniedTools: ["*forbidden_suffix"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-suffix") ?? [])]).toEqual([]);
  });

  it("withholds a server a full-call glob reaches through the mcp__ spelling", () => {
    // `mcp__*delete_repo` matches Codex's canonical name for this server's tool,
    // so the server cannot be handed to a subprocess that would run it.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-fullglob",
        mcpGoverned: true,
        mcpServers: ["github"],
        deniedTools: ["mcp__*delete_repo"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-fullglob") ?? [])]).toEqual([]);
  });

  it("withholds a server denied by its prefixed whole-server name", () => {
    // `mcp__github` is a supported spelling of "deny this whole server".
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-whole-prefixed",
        mcpGoverned: true,
        mcpServers: ["github"],
        deniedTools: ["mcp__github"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-whole-prefixed") ?? [])]).toEqual([]);
  });

  it("withholds a server whose config key is itself a tool-group id", () => {
    // `group:web` is a valid config key AND a tool-group id; expanding it before
    // comparing would match core web tools and miss the server entirely.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-group-key",
        mcpGoverned: true,
        mcpServers: ["group:web"],
        deniedTools: ["group:web"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-group-key") ?? [])]).toEqual([]);
  });

  it("withholds a collided server without knowing the colliding party", () => {
    // The other half of the collision can be a PLUGIN server this side never sees,
    // so the suffix is accepted on its own rather than inferred from a collision.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-plugin-collision",
        mcpGoverned: true,
        mcpServers: ["my server"],
        deniedTools: ["my-server-2__delete"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-plugin-collision") ?? [])]).toEqual([]);
  });

  it("withholds a long server whose collision alias was truncated", () => {
    // Past the 30-character prefix budget the sanitizer truncates the base before
    // appending the suffix, so the alias is shorter than the raw name.
    const server = `${"a".repeat(29)}-server`;
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-truncated",
        mcpGoverned: true,
        mcpServers: [server],
        deniedTools: [`${"a".repeat(28)}-2__delete`],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-truncated") ?? [])]).toEqual([]);
  });

  it("withholds a server denied under a collision name with no operation left", () => {
    // `mcp__foo_<hash>__` is a complete Codex hook name: colliding namespace, and an
    // operation whose name trimmed away. A hookless backend has no later gate, so
    // the server is not handed over.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-empty-tool",
        mcpGoverned: true,
        mcpServers: ["foo"],
        deniedTools: ["mcp__foo_a1b2c3d4e5f6__"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-empty-tool") ?? [])]).toEqual([]);
  });

  it("withholds a server whose canonical namespace trims to nothing", () => {
    // `_` prefixes to `mcp___`, which trims to `mcp`, so Codex reports this
    // server's `delete` as `mcp__delete`. A denial copied from that name has to
    // withhold the server on a backend with no later gate.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-empty-namespace",
        mcpGoverned: true,
        mcpServers: ["_"],
        deniedTools: ["mcp__delete"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-empty-namespace") ?? [])]).toEqual([]);
  });

  it("withholds a server whose trailing underscore the hook name drops", () => {
    // `foo_` is reported as `mcp__foo__<tool>`, so a denial copied from that name
    // has to reach this server — a hookless backend has no later gate.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-trimmed-key",
        mcpGoverned: true,
        mcpServers: ["foo_"],
        deniedTools: ["mcp__foo__delete"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-trimmed-key") ?? [])]).toEqual([]);
  });

  it("withholds a server whose key contains the delimiter", () => {
    // `foo__bar` is a valid config key, and Codex's collision name puts its hash
    // between the key and the delimiter. Cutting the denial at the FIRST `__` would
    // read it as naming a server called `foo` and hand this one over.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-delimiter-key",
        mcpGoverned: true,
        mcpServers: ["foo__bar"],
        deniedTools: ["mcp__foo__bar_a1b2c3d4e5f6__delete"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-delimiter-key") ?? [])]).toEqual([]);
  });

  it("withholds a server whose key already carries the legacy prefix", () => {
    // Codex keeps a namespace that already starts with `mcp__` as-is, so the
    // denial's own prefix is part of the server name rather than Codex's.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-prefixed-key",
        mcpGoverned: true,
        mcpServers: ["mcp__probe"],
        deniedTools: ["mcp__probe_a1b2c3d4e5f6__delete"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-prefixed-key") ?? [])]).toEqual([]);
  });

  it("withholds a long server denied under a multi-digit collision suffix", () => {
    // The tenth server sharing a base is `-10`, so the materializer truncates one
    // character further than it does for `-2`. A denial copied from that real name
    // must still be recognized as this server's.
    const server = `${"a".repeat(29)}-server`;
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-truncated-10",
        mcpGoverned: true,
        mcpServers: [server],
        deniedTools: [`${"a".repeat(27)}-10__delete`],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-truncated-10") ?? [])]).toEqual([]);
  });

  it("withholds a collided server named by its materialized suffix", () => {
    // Two keys collapse to one materialized base, so the runtime disambiguates
    // with a numeric suffix from a set this side cannot reconstruct. A denial
    // written with that name still has to withhold the server.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-collision",
        mcpGoverned: true,
        mcpServers: ["my server", "my:server"],
        deniedTools: ["my-server-2__delete"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-collision") ?? [])]).toEqual([]);
  });

  it("withholds a server a governance deny policy can reach", () => {
    // A hookless CLI evaluates no policy per call, so a deny that names the tool
    // has to be honored before the subprocess is handed the server.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-policy-deny",
        mcpGoverned: true,
        mcpServers: ["github"],
        policies: [{ id: "deny.destructive", effect: "deny", tools: ["*delete_repo"] }],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-policy-deny") ?? [])]).toEqual([]);
  });

  it("ignores a policy pinned to a step this run never planned", () => {
    // It cannot block anything here, so withholding for it would take a server
    // away for no reason.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-policy-elsewhere",
        mcpGoverned: true,
        mcpServers: ["github"],
        policies: [
          { id: "deny.billing", effect: "deny", tools: ["github__*"], nodes: ["billing.refund"] },
        ],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-policy-elsewhere") ?? [])]).toEqual([
      "github",
    ]);
  });

  it("keeps a server a policy names bare, which cannot match any call", () => {
    // `tools: ["github"]` is matched against real call names by the runtime gate,
    // so it can never block `github__read`. The bare-name shorthand belongs to
    // ontology deniedTools, not to a policy selector.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-policy-bare",
        mcpGoverned: true,
        mcpServers: ["github"],
        policies: [{ id: "deny.bare", effect: "deny", tools: ["github"] }],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-policy-bare") ?? [])]).toEqual(["github"]);
  });

  it("ignores a knowledge-scoped policy", () => {
    // Selectors are conjunctive and a knowledge selector cannot match a tool call,
    // so such a policy never gates one.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-knowledge-policy",
        mcpGoverned: true,
        mcpServers: ["github"],
        policies: [
          {
            id: "deny.kb",
            effect: "deny",
            tools: ["github__*"],
            knowledge: ["acme.kb"],
          },
        ],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-knowledge-policy") ?? [])]).toEqual([
      "github",
    ]);
  });

  it("keeps a server when two globs share a head but not a tail", () => {
    // `github__*read` and `github__*delete` can never name one tool.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-glob-tails",
        mcpGoverned: true,
        mcpServers: ["github"],
        actions: [{ id: "destructive", description: "Delete", tools: ["github__*delete"] }],
        policies: [
          { id: "deny.reads", effect: "deny", tools: ["github__*read"], actions: ["destructive"] },
        ],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-glob-tails") ?? [])]).toEqual(["github"]);
  });

  it("grants a sanitized server from the names a runtime can expose", () => {
    // `my server` never appears in a tool name, so requiring it would make the
    // grant impossible to write.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-sanitized-grant",
        mcpGoverned: true,
        mcpServers: ["my server"],
        allowedTools: [
          "message",
          "my-server__*",
          "mcp__my-server__*",
          "my_server__*",
          "mcp__my_server__*",
        ],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-sanitized-grant") ?? [])]).toEqual([
      "my server",
    ]);
  });

  it("keeps a server when the policy's tool and action patterns name different tools", () => {
    // Both selectors reach `github`, but no single call satisfies both, so the
    // policy can never fire — withholding for it would take the server for nothing.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-policy-disjoint",
        mcpGoverned: true,
        mcpServers: ["github"],
        actions: [{ id: "destructive", description: "Delete", tools: ["github__delete"] }],
        policies: [
          {
            id: "deny.disjoint",
            effect: "deny",
            tools: ["github__read"],
            actions: ["destructive"],
          },
        ],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-policy-disjoint") ?? [])]).toEqual([
      "github",
    ]);
  });

  it("withholds a server when one call can satisfy both selectors", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-policy-overlap",
        mcpGoverned: true,
        mcpServers: ["github"],
        actions: [{ id: "destructive", description: "Delete", tools: ["github__delete"] }],
        policies: [
          { id: "deny.overlap", effect: "deny", tools: ["github__*"], actions: ["destructive"] },
        ],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-policy-overlap") ?? [])]).toEqual([]);
  });

  it("keeps a server when a policy's node and action matches sit on different branches", () => {
    // Governance needs every selector satisfied on ONE root→node path; a node
    // match on one branch and an action match on another can never block a call.
    const run = makeRun({
      runId: "run-mcp-cross-branch",
      mcpGoverned: true,
      mcpServers: ["github"],
      policies: [
        { id: "deny.split", effect: "deny", nodes: ["desk.triage"], actions: ["destructive"] },
      ],
    });
    run.plan.nodes = [
      { nodeId: "desk", parentId: null, seq: 0, title: "Desk", ontology: {} },
      { nodeId: "desk.triage", parentId: "desk", seq: 1, title: "Triage", ontology: {} },
      {
        nodeId: "desk.file",
        parentId: "desk",
        seq: 2,
        title: "File",
        ontology: {
          mcpServers: ["github"],
          actions: [{ id: "destructive", description: "Delete", tools: ["github__*"] }],
        },
      },
    ];
    registerEnterpriseActiveRun(run);

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-cross-branch") ?? [])]).toEqual([
      "github",
    ]);
  });

  it("keeps a server when a policy's tool and action selectors cannot both match", () => {
    // The two selectors are conjunctive in governance; treating them as
    // alternatives would withhold a server neither can name.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-policy-conjunctive",
        mcpGoverned: true,
        mcpServers: ["github"],
        actions: [{ id: "destructive", description: "Delete things", tools: ["github__*"] }],
        policies: [{ id: "deny.mixed", effect: "deny", tools: ["exec"], actions: ["destructive"] }],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-policy-conjunctive") ?? [])]).toEqual([
      "github",
    ]);
  });

  it("withholds two servers that collide only once Codex adds its prefix", () => {
    // Codex prefixes by default, so `foo` is emitted as `mcp__foo` — the same
    // namespace a server literally named `mcp__foo` gets, and both are hashed.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-prefix-collision",
        mcpGoverned: true,
        mcpServers: ["foo", "mcp__foo"],
        allowedTools: ["message", "foo__*", "mcp__foo__*"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-prefix-collision") ?? [])]).toEqual([]);
  });

  it("keeps every attached server under a universal grant", () => {
    // `*` admits every emitted spelling, truncation and hashes included.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-star-grant",
        mcpGoverned: true,
        mcpServers: ["a".repeat(50)],
        allowedTools: ["*"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-star-grant") ?? [])]).toEqual([
      "a".repeat(50),
    ]);
  });

  it("does not register a disabled server as attachable", () => {
    // Every projection skips a disabled entry, so it can neither be called nor
    // collide with the server that is.
    expect(
      resolveEnterpriseMcpServers({
        mcp: {
          servers: {
            "my server": { command: "node" },
            "my:server": { command: "node", enabled: false },
          },
        },
      }),
    ).toEqual(["my server"]);
  });

  it("ignores an inert attachment when judging collisions", () => {
    // An attachment naming a server config never registered is inert, so it
    // cannot collide with anything the backend receives.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-inert-attachment",
        mcpGoverned: true,
        mcpServers: ["my server", "my:server"],
        registeredMcpServers: ["my server"],
        allowedTools: [
          "message",
          "my-server__*",
          "mcp__my-server__*",
          "my_server__*",
          "mcp__my_server__*",
        ],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-inert-attachment") ?? [])]).toEqual([
      "my server",
    ]);
  });

  it("grants a server whose own key already starts with mcp__", () => {
    // Codex does not add a second prefix and the materializer uses the key once,
    // so requiring `mcp__mcp__…` would make the grant unwritable.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-prefixed-key",
        mcpGoverned: true,
        mcpServers: ["mcp__github"],
        allowedTools: ["message", "mcp__github__*"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-prefixed-key") ?? [])]).toEqual([
      "mcp__github",
    ]);
  });

  it("withholds a server whose namespace is long enough for Codex to truncate", () => {
    // Past that length Codex truncates the namespace and emits the hash as the
    // tool part, a spelling no operator glob can cover.
    const server = "a".repeat(50);
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-long-namespace",
        mcpGoverned: true,
        mcpServers: [server],
        allowedTools: ["message", `${server}__*`, `mcp__${server}__*`],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-long-namespace") ?? [])]).toEqual([]);
  });

  it("ignores a registered sibling the backend will not emit", () => {
    // A disabled or agent-scoped entry never reaches the runtime, so it cannot
    // collide — withholding for it would take a working server away.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-inert-sibling",
        mcpGoverned: true,
        mcpServers: ["my server"],
        registeredMcpServers: ["my server", "my:server"],
        allowedTools: [
          "message",
          "my-server__*",
          "mcp__my-server__*",
          "my_server__*",
          "mcp__my_server__*",
        ],
      }),
    );

    // Peers default to none, so only the attached server counts.
    expect([...(enterpriseRunAttachedMcpServers("run-mcp-inert-sibling") ?? [])]).toEqual([
      "my server",
    ]);
  });

  it("withholds when a peer the backend WILL emit shares the namespace", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-emitted-peer",
        mcpGoverned: true,
        mcpServers: ["my server"],
        allowedTools: [
          "message",
          "my-server__*",
          "mcp__my-server__*",
          "my_server__*",
          "mcp__my_server__*",
        ],
      }),
    );

    expect([
      ...(enterpriseRunAttachedMcpServers("run-mcp-emitted-peer", ["my:server"]) ?? []),
    ]).toEqual([]);
  });

  it("withholds both servers when a grant names the namespace they share", () => {
    // `my-server__*` is the normalized name of BOTH keys, so it cannot say which
    // one the operator meant — neither is handed to a hookless runtime.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-shared-namespace",
        mcpGoverned: true,
        mcpServers: ["my server", "my:server"],
        allowedTools: ["message", "my-server__*"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-shared-namespace") ?? [])]).toEqual([]);
  });

  it("withholds nothing on an ambiguous collision grant", () => {
    // Two attached servers materialize to the same base, so `my-server-2__*`
    // cannot say which one it granted: neither is handed over.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-ambiguous-grant",
        mcpGoverned: true,
        mcpServers: ["my server", "my:server"],
        allowedTools: ["message", "my-server-2__*"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-ambiguous-grant") ?? [])]).toEqual([]);
  });

  it("withholds a server an approval policy would gate", () => {
    // A hookless CLI has no channel to ask on, so an approval that never runs is a
    // call that was never approved.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-approval",
        mcpGoverned: true,
        mcpServers: ["github"],
        policies: [{ id: "ask.destructive", effect: "require_approval", tools: ["github__*"] }],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-approval") ?? [])]).toEqual([]);
  });

  it("withholds a server an action-scoped deny reaches through its tools", () => {
    // An action-scoped policy reaches a tool through the actions covering it.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-action-policy",
        mcpGoverned: true,
        mcpServers: ["github"],
        actions: [{ id: "destructive", description: "Delete things", tools: ["github__*"] }],
        policies: [{ id: "deny.destructive", effect: "deny", actions: ["destructive"] }],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-action-policy") ?? [])]).toEqual([]);
  });

  it("keeps a server when the policy's own tool selector cannot reach it", () => {
    // Both selectors have to hold on ONE call. An action that covers every tool
    // shares a call with `message`, but that call is `message` — never a github
    // tool — so this policy can only ever gate a non-MCP call and withholding the
    // server for it would take it away for nothing.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-action-policy-elsewhere",
        mcpGoverned: true,
        mcpServers: ["github"],
        actions: [{ id: "anything", description: "Any tool" }],
        policies: [
          {
            id: "ask.message",
            effect: "require_approval",
            tools: ["message"],
            actions: ["anything"],
          },
        ],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-action-policy-elsewhere") ?? [])]).toEqual(
      ["github"],
    );
  });

  it("withholds a server the root allow-list grants only in part", () => {
    // Nothing gates a call on a hookless CLI, so a partial grant would let the
    // tools it omits run anyway — `allowedTools` has to stay a ceiling.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-partial-allow",
        mcpGoverned: true,
        mcpServers: ["github"],
        allowedTools: ["message", "github__read_issue"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-partial-allow") ?? [])]).toEqual([]);
  });

  it("keeps a server no deny policy can reach", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-policy-other",
        mcpGoverned: true,
        mcpServers: ["github"],
        policies: [{ id: "deny.exec", effect: "deny", tools: ["exec"] }],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-policy-other") ?? [])]).toEqual([
      "github",
    ]);
  });

  it("withholds a server denied under a Codex-truncated namespace", () => {
    // Codex can truncate the namespace and move its hash into the tool part, so
    // the name an operator copies has a SHORTER server segment than the real one.
    const server = `${"a".repeat(29)}-server`;
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-truncated-ns",
        mcpGoverned: true,
        mcpServers: [server],
        deniedTools: [`mcp__${"a".repeat(29)}__delete_a1b2c3d4e5f6`],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-truncated-ns") ?? [])]).toEqual([]);
  });

  it("withholds a server denied under Codex's hash-suffixed name", () => {
    // Codex disambiguates a namespace collision with `_` + 12 hex characters; an
    // operator copying that name into deniedTools must still withhold the server.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-codex-hash",
        mcpGoverned: true,
        mcpServers: ["my server"],
        deniedTools: ["mcp__my_server_a1b2c3d4e5f6__delete"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-codex-hash") ?? [])]).toEqual([]);
  });

  it("withholds a server the root allow-list cannot admit", () => {
    // A CLI without a pre-tool hook enforces nothing per call, so this filter is
    // the only thing between `allowedTools: [message]` and every tool the server
    // has.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-allow-narrow",
        mcpGoverned: true,
        mcpServers: ["github"],
        allowedTools: ["message"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-allow-narrow") ?? [])]).toEqual([]);
  });

  it("withholds a server the allow-list names in only one spelling", () => {
    // `github__*` leaves `mcp__github__*` ungoverned, and the harness decides
    // which one it uses.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-one-spelling",
        mcpGoverned: true,
        mcpServers: ["github"],
        allowedTools: ["message", "github__*"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-one-spelling") ?? [])]).toEqual([]);
  });

  it("keeps a server the root allow-list names with a glob", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-allow-glob",
        mcpGoverned: true,
        mcpServers: ["github"],
        // EVERY spelling: a hookless runtime has no per-call ceiling and the
        // harness picks the name, so one glob is not a grant.
        allowedTools: ["message", "github__*", "mcp__github__*"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-allow-glob") ?? [])]).toEqual(["github"]);
  });

  it("keeps a server when the root declares no allow-list at all", () => {
    // An omitted list allows everything, so there is nothing to withhold for.
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-mcp-allow-open", mcpGoverned: true, mcpServers: ["github"] }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-allow-open") ?? [])]).toEqual(["github"]);
  });

  it("withholds a server denied under the embedded runtime's spelling", () => {
    // A free-form key is rewritten differently by each runtime: OpenClaw maps
    // invalid characters to `-`, Codex to `_`. An operator writes whichever they
    // saw, so a denial in either spelling has to withhold the server.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-embedded-spelling",
        mcpGoverned: true,
        mcpServers: ["my server"],
        deniedTools: ["my-server__delete"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-embedded-spelling") ?? [])]).toEqual([]);
  });

  it("keeps a server an unrelated wildcard cannot reach", () => {
    // `slack*` can match neither `github__…` nor `mcp__github__…`.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-other-glob",
        mcpGoverned: true,
        mcpServers: ["github"],
        deniedTools: ["slack*"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-other-glob") ?? [])]).toEqual(["github"]);
  });

  it("withholds a server named by its materialized collision alias", () => {
    // Two servers that sanitize alike are disambiguated as `<base>-2`, and an
    // operator copying THAT name means this server. A hookless CLI has no gate
    // afterwards, so the bare alias has to be honored here.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-alias-denial",
        mcpGoverned: true,
        mcpServers: ["my server"],
        deniedTools: ["my-server-2"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-alias-denial") ?? [])]).toEqual([]);
  });

  it("keeps a server when a delimiter-free denial cannot name it", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-plain",
        mcpGoverned: true,
        mcpServers: ["github"],
        deniedTools: ["exec"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-plain") ?? [])]).toEqual(["github"]);
  });

  it("withholds a server a wildcard denial can reach", () => {
    // Per-tool denials cannot be enforced on a native runtime, so a server that
    // carries one is not handed over at all.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-mcp-denied",
        mcpGoverned: true,
        mcpServers: ["github"],
        deniedTools: ["git*__delete_repo"],
      }),
    );

    expect([...(enterpriseRunAttachedMcpServers("run-mcp-denied") ?? [])]).toEqual([]);
  });
});

describe("enterpriseRunGrantedSkills", () => {
  it("does not narrow a work-map that grants inherited scopes", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-skills-legacy", skills: ["triage"] }));

    expect(enterpriseRunGrantedSkills("run-skills-legacy")).toBeNull();
  });

  it("returns the attached skills for a work-map that grants explicitly", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-skills-explicit",
        capabilityGrants: "explicit",
        skills: ["ticket-triage", "refund-policy"],
      }),
    );

    expect(enterpriseRunGrantedSkills("run-skills-explicit")).toEqual([
      "ticket-triage",
      "refund-policy",
    ]);
  });

  it("empties the catalog when an explicit work-map attaches no skill", () => {
    // An empty grant is a real answer, not "unrestricted": the work-map said this
    // run needs none.
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-skills-none", capabilityGrants: "explicit" }),
    );

    expect(enterpriseRunGrantedSkills("run-skills-none")).toEqual([]);
  });

  it("narrows nothing in observe mode", () => {
    // Observe records decisions without blocking; removing a skill from the
    // catalog is physical, so it belongs to enforce alone.
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-skills-observe",
        mode: "observe",
        capabilityGrants: "explicit",
        skills: ["ticket-triage"],
      }),
    );

    expect(enterpriseRunGrantedSkills("run-skills-observe")).toBeNull();
  });

  it("narrows nothing for an unmediated run", () => {
    expect(enterpriseRunGrantedSkills("run-unknown")).toBeNull();
    expect(enterpriseRunGrantedSkills()).toBeNull();
  });
});

describe("enterpriseRunBoundableMcpServers", () => {
  it("admits a plugin's server when the root narrows nothing", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-plugin-open", mcpGoverned: true }));

    expect([...(enterpriseRunBoundableMcpServers("run-plugin-open", ["bundled"]) ?? [])]).toEqual([
      "bundled",
    ]);
  });

  it("withholds a plugin's server from an explicit work-map that grants no tools", () => {
    // No attachment can grant a plugin server, so the root allow-list is the only
    // grant available — and an empty one means "nothing", not "unrestricted".
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-plugin-explicit", capabilityGrants: "explicit" }),
    );

    expect([
      ...(enterpriseRunBoundableMcpServers("run-plugin-explicit", ["bundled"]) ?? []),
    ]).toEqual([]);
  });

  it("withholds a plugin's server when a reachable step narrows tools", () => {
    // The root granting it whole is no longer the whole answer: the run walks the
    // route now, and a hookless backend cannot withdraw a server once connected —
    // so a step that narrows tools away is a step the run can reach with the
    // server already in hand.
    const run = makeGovernedRun();
    run.plan.runId = "run-plugin-leaf";
    run.plan.nodes[0].ontology = { allowedTools: ["bundled__*", "mcp__bundled__*"] };
    run.plan.nodes[1].ontology = { allowedTools: ["message"] };
    registerEnterpriseActiveRun(run);

    expect([...(enterpriseRunBoundableMcpServers("run-plugin-leaf", ["bundled"]) ?? [])]).toEqual(
      [],
    );
  });

  it("admits a plugin's server an explicit root grants whole", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-plugin-granted",
        capabilityGrants: "explicit",
        allowedTools: ["bundled__*", "mcp__bundled__*"],
      }),
    );

    expect([
      ...(enterpriseRunBoundableMcpServers("run-plugin-granted", ["bundled"]) ?? []),
    ]).toEqual(["bundled"]);
  });
});

describe("enterpriseRunGovernsToolNames", () => {
  it("answers no for an unmediated run", () => {
    expect(enterpriseRunGovernsToolNames(undefined)).toBe(false);
    expect(enterpriseRunGovernsToolNames("run-missing")).toBe(false);
  });

  it("answers no for a work-map that scopes no tools", () => {
    // The default assist binding. A stock install must not pay for rules it has
    // none of, so this is what keeps searchable registration the common case.
    registerEnterpriseActiveRun(makeRun({ runId: "run-names-open" }));

    expect(enterpriseRunGovernsToolNames("run-names-open")).toBe(false);
  });

  it("answers yes for an allow-list, a denial, or explicit grants", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-names-allow", allowedTools: ["message"] }));
    registerEnterpriseActiveRun(makeRun({ runId: "run-names-deny", deniedTools: ["exec"] }));
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-names-explicit", capabilityGrants: "explicit" }),
    );

    expect(enterpriseRunGovernsToolNames("run-names-allow")).toBe(true);
    expect(enterpriseRunGovernsToolNames("run-names-deny")).toBe(true);
    expect(enterpriseRunGovernsToolNames("run-names-explicit")).toBe(true);
  });

  it("answers yes for a policy on this tree and no for one on another", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-names-policy",
        policies: [{ id: "p1", effect: "deny", trees: ["acme.support"], tools: ["exec"] }],
      }),
    );
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-names-other-tree",
        policies: [{ id: "p2", effect: "deny", trees: ["acme.other"], tools: ["exec"] }],
      }),
    );

    expect(enterpriseRunGovernsToolNames("run-names-policy")).toBe(true);
    expect(enterpriseRunGovernsToolNames("run-names-other-tree")).toBe(false);
  });

  it("answers yes for an observe run, whose trace is the product", () => {
    // Observe blocks nothing, but a denial recorded against a flattened name is a
    // false record of what the work-map decided.
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-names-observe", mode: "observe", allowedTools: ["message"] }),
    );

    expect(enterpriseRunGovernsToolNames("run-names-observe")).toBe(true);
  });
});

describe("enterpriseRunAdmitsHostedTool", () => {
  it("admits the tool when no governed run owns the id", () => {
    expect(enterpriseRunAdmitsHostedTool(undefined, "web_search")).toBe(true);
    expect(enterpriseRunAdmitsHostedTool("run-missing", "web_search")).toBe(true);
  });

  it("admits the tool when the work-map narrows nothing", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-hosted-open" }));

    expect(enterpriseRunAdmitsHostedTool("run-hosted-open", "web_search")).toBe(true);
  });

  it("withholds a tool any reachable step narrows away, even when the root allows it", () => {
    // The root used to be the whole answer because native runs never left it.
    // They walk the route now, while a hosted tool is granted once before the
    // thread starts and can never be withdrawn — and Codex executes it itself, so
    // no per-call gate can catch it later. A permissive root plus one restrictive
    // step must therefore withhold it for the whole run.
    const run = makeGovernedRun();
    run.plan.runId = "run-hosted-leaf";
    run.plan.nodes[0].ontology = {}; // root narrows nothing
    run.plan.nodes[1].ontology = { allowedTools: ["message"] }; // first step does
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunAdmitsHostedTool("run-hosted-leaf", "web_search")).toBe(false);
    // A tool that survives EVERY reachable path is still admitted: the ceiling is
    // conservative, not blanket.
    expect(enterpriseRunAdmitsHostedTool("run-hosted-leaf", "message")).toBe(true);
  });

  it("withholds a hosted tool a policy denies on a reachable step", () => {
    // Codex runs a hosted tool outside registry dispatch, so once the run
    // advances onto the step this policy targets there is no PreToolUse gate left
    // to honor it — the launch decision is the last chance.
    const run = makeGovernedRun();
    run.plan.runId = "run-hosted-policy";
    // Clear the ontology narrowing so the POLICY is the only thing that can
    // withhold the tool; otherwise the allow-list would decide and the test
    // would pass without exercising the policy path at all.
    for (const node of run.plan.nodes) {
      node.ontology = {};
    }
    run.policies = [
      { id: "deny.search", effect: "deny", tools: ["web_search"], nodes: ["support.resolve"] },
    ];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunAdmitsHostedTool("run-hosted-policy", "web_search")).toBe(false);
  });

  it("withholds a hosted tool an action-scoped policy reaches through its tool globs", () => {
    // An action-scoped policy is not "about actions instead of tools": an action
    // whose `tools` globs cover this tool makes the policy govern exactly this
    // call. Reading actions-only policies as irrelevant let them be bypassed by
    // the one tool class that has no later gate.
    const run = makeGovernedRun();
    run.plan.runId = "run-hosted-action-tools";
    for (const node of run.plan.nodes) {
      node.ontology = {};
    }
    run.plan.nodes[1].ontology = {
      actions: [{ id: "research", description: "Look things up", tools: ["web_search"] }],
    };
    run.policies = [{ id: "deny.research", effect: "deny", actions: ["research"] }];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunAdmitsHostedTool("run-hosted-action-tools", "web_search")).toBe(false);
  });

  it("keeps a hosted tool when the only policy is about actions, not tools", () => {
    const run = makeGovernedRun();
    run.plan.runId = "run-hosted-actions";
    for (const node of run.plan.nodes) {
      node.ontology = {};
    }
    run.policies = [{ id: "deny.refund", effect: "deny", actions: ["issue-refund"] }];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunAdmitsHostedTool("run-hosted-actions", "web_search")).toBe(true);
  });

  it("admits a tool every reachable step allows", () => {
    const run = makeGovernedRun();
    run.plan.runId = "run-hosted-all";
    run.plan.nodes[0].ontology = { allowedTools: ["web_search", "message"] };
    run.plan.nodes[1].ontology = { allowedTools: ["web_search"] };
    run.plan.nodes[2].ontology = { allowedTools: ["web_search"] };
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunAdmitsHostedTool("run-hosted-all", "web_search")).toBe(true);
  });

  it("withholds the tool from a root allow-list that omits it", () => {
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-hosted-scoped", allowedTools: ["knowledge_search", "message"] }),
    );

    expect(enterpriseRunAdmitsHostedTool("run-hosted-scoped", "web_search")).toBe(false);
    expect(enterpriseRunAdmitsHostedTool("run-hosted-scoped", "knowledge_search")).toBe(true);
  });

  it("withholds a denied tool even when the root allows it", () => {
    registerEnterpriseActiveRun(
      makeRun({
        runId: "run-hosted-denied",
        allowedTools: ["web_search"],
        deniedTools: ["web_search"],
      }),
    );

    expect(enterpriseRunAdmitsHostedTool("run-hosted-denied", "web_search")).toBe(false);
  });

  it("withholds the tool from an explicit work-map that never grants it", () => {
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-hosted-explicit", capabilityGrants: "explicit" }),
    );

    expect(enterpriseRunAdmitsHostedTool("run-hosted-explicit", "web_search")).toBe(false);
  });

  it("leaves observe mode alone; withholding is physical, not a recorded decision", () => {
    registerEnterpriseActiveRun(
      makeRun({ runId: "run-hosted-observe", mode: "observe", allowedTools: ["message"] }),
    );

    expect(enterpriseRunAdmitsHostedTool("run-hosted-observe", "web_search")).toBe(true);
  });
});
