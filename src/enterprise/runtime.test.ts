import { afterEach, describe, expect, it } from "vitest";
import { enterpriseRunBoundableMcpServers, enterpriseRunGrantedSkills } from "./active-runs.js";
import {
  clearEnterpriseActiveRunsForTest,
  enterpriseRunTracksSteps,
  evaluateEnterpriseToolCall,
  getEnterpriseActiveRun,
  getSessionActiveRunId,
  recordEnterpriseApprovalResolution,
  recordEnterpriseTurnExecuted,
  enterpriseRunAttachedMcpServers,
  registerEnterpriseActiveRun,
  resolveEnterpriseMcpServers,
  resolveEnterpriseMode,
  setEnterpriseStepForTurn,
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

  it("blocks denied tools in enforce mode and records the decision", () => {
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
    expect(verdict?.blocked).toBe(true);
    expect(verdict?.decision.effect).toBe("deny");
    expect(verdict?.nodeId).toBe("support");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subject: "tool_call",
      toolName: "exec",
      toolCallId: "call-1",
      effect: "deny",
      enforced: true,
    });
  });

  it("records but does not block denials in observe mode", () => {
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
    expect(verdict?.decision.effect).toBe("deny");
    expect(events[0]).toMatchObject({ effect: "deny", enforced: false });
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

type SinkEvent = { kind: string; nodeId: string; payload: Record<string, unknown> };

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
    // Runs start on the root; the step hook enters the first leaf on turn one.
    activeNodeId: opts.activeNodeId ?? "support",
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
  it("tracks executed turns: enter the first leaf, then advance as turns complete", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));

    setEnterpriseStepForTurn("run-steps");
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.triage");
    recordEnterpriseTurnExecuted("run-steps");
    setEnterpriseStepForTurn("run-steps");
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");

    expect(events.map((event) => `${event.kind}:${event.nodeId}`)).toEqual([
      "node.entered:support.triage",
      "node.completed:support.triage",
      "node.entered:support.resolve",
    ]);
    expect(events[0].payload).toMatchObject({ seq: 1, title: "Triage" });
  });

  it("redoes the same step on a preflight-failed turn's retry (never skips)", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    // Turn one enters the first leaf, then fails before a response — no executed
    // turn is recorded.
    setEnterpriseStepForTurn("run-steps");
    events.length = 0;
    // The retry's first turn must land on the same leaf, not skip to the next.
    setEnterpriseStepForTurn("run-steps");
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.triage");
    expect(events).toHaveLength(0);
  });

  it("advances a run resumed after real progress (executed turn recorded)", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    setEnterpriseStepForTurn("run-steps"); // turn one → first leaf
    recordEnterpriseTurnExecuted("run-steps"); // turn one executed
    // A fresh attempt resumes; its first turn advances to the next step.
    setEnterpriseStepForTurn("run-steps");
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");
  });

  it("saturates at the final step instead of running off the end", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    for (let turn = 0; turn < 5; turn += 1) {
      setEnterpriseStepForTurn("run-steps");
      recordEnterpriseTurnExecuted("run-steps");
    }
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");
    // Only two real transitions happen (triage, resolve); the rest clamp.
    expect(events.filter((event) => event.kind === "node.entered")).toHaveLength(2);
  });

  it("is a no-op for unknown runs", () => {
    expect(() => setEnterpriseStepForTurn("nope")).not.toThrow();
    expect(() => recordEnterpriseTurnExecuted("nope")).not.toThrow();
  });

  it("scopes the gate to the active leaf's ancestor path", () => {
    registerEnterpriseActiveRun(makeGovernedRun(undefined, { activeNodeId: "support.triage" }));
    // On the first leaf: the root allows only memory_search/message, so an
    // out-of-scope tool is denied under the leaf's inherited path.
    const verdict = evaluateEnterpriseToolCall({ runId: "run-steps", toolName: "exec" });
    expect(verdict?.nodeId).toBe("support.triage");
    expect(verdict?.blocked).toBe(true);
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
      } as never),
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
